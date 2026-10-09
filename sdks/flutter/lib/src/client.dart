import 'dart:async';
import 'dart:convert';
import 'dart:math';

import 'package:http/http.dart' as http;

import 'attribution.dart';
import 'storage.dart';

const String sdkName = 'leanapp-flutter';
const String sdkVersion = '0.1.0';
const String defaultEndpoint = 'https://api.leanapp.io';

final RegExp _keyPattern = RegExp(r'^la_(pk|sk)_(dev|stg|live)_[A-Za-z0-9_-]{20,}$');
const int _baseBackoffMs = 1000;
const int _maxBackoffMs = 5 * 60000;

/// Storage namespace for a key: its kind and environment (leanapp:la_pk_live:), never the random part,
/// so rotating a key keeps the anonymous id and queue while dev and production stay apart.
String storagePrefix(String apiKey) {
  final m = _keyPattern.firstMatch(apiKey);
  if (m == null) throw ArgumentError('not a LeanApp key');
  return 'leanapp:la_${m.group(1)}_${m.group(2)}:';
}

/// FNV-1a (32-bit) of the UTF-8 bytes of the event ids joined by "\n", as 8 hex digits.
/// Same value as eventIdsHash in the JavaScript SDK. Multiplication is split so every
/// intermediate stays exact on the web, where ints are doubles.
String eventIdsHash(List<String> ids) {
  var h = 0x811c9dc5;
  for (final b in utf8.encode(ids.join('\n'))) {
    h = (h ^ b) & 0xffffffff;
    // h * 0x01000193 mod 2^32 == (h * 0x193 + (h & 0xff) * 2^24) mod 2^32
    h = (h * 0x193 + (h & 0xff) * 0x1000000) % 0x100000000;
  }
  return h.toRadixString(16).padLeft(8, '0');
}

/// `<batch size>:<hash of every event id>:<first event id>`: the same events give the same key on every
/// retry, and a batch whose events changed before a retry gets a different key, so the server never
/// answers it with the response of a batch it did not send. The first id goes last so the server's
/// 200-character limit can only truncate it, never the hash.
String idempotencyKey(List<String> ids) => '${ids.length}:${eventIdsHash(ids)}:${ids.isEmpty ? '' : ids.first}';

/// Client options. Defaults match the JavaScript SDK (docs/sdk.md).
class LeanAppOptions {
  LeanAppOptions({
    required this.apiKey,
    String endpoint = defaultEndpoint,
    this.platform = 'flutter',
    this.appVersion,
    this.appBuild,
    int flushAt = 20,
    Duration flushInterval = const Duration(seconds: 10),
    int maxBatchSize = 100,
    int maxQueueSize = 1000,
    this.eventTtl = const Duration(days: 7),
    this.sessionTimeout = const Duration(minutes: 30),
    this.context = const {},
    this.optedOut = false,
    this.debug = false,
  })  : endpoint = endpoint.replaceAll(RegExp(r'/+$'), ''),
        flushAt = max(1, flushAt),
        flushInterval = flushInterval < const Duration(seconds: 1) ? const Duration(seconds: 1) : flushInterval,
        maxBatchSize = min(500, max(1, maxBatchSize)),
        maxQueueSize = max(10, maxQueueSize);

  /// Public SDK key (la_pk_…). Secret keys (la_sk_…) are refused in apps.
  final String apiKey;
  final String endpoint;

  /// flutter, android, ios, react_native, web or backend.
  final String platform;
  final String? appVersion;
  final String? appBuild;

  /// Send when this many events are queued.
  final int flushAt;

  /// Send at least this often while events are queued.
  final Duration flushInterval;

  /// Events per request (server maximum 500).
  final int maxBatchSize;

  /// Oldest events are dropped beyond this.
  final int maxQueueSize;

  /// Queued events older than this are dropped (the server rejects events older than 31 days).
  final Duration eventTtl;

  /// Inactivity after which a new session starts.
  final Duration sessionTimeout;

  /// Extra context merged into every event (device model, timezone, …).
  final Map<String, Object?> context;

  /// Stop sending (events still queue) until optIn().
  final bool optedOut;
  final bool debug;
}

/// Result of one flush, same shape as the JavaScript SDK's FlushResult.
class FlushResult {
  const FlushResult._(this.status, {this.accepted = 0, this.duplicates = 0, this.rejected = 0, this.retryInMs = 0, this.reason = ''});

  const FlushResult.empty() : this._('empty');
  const FlushResult.paused() : this._('paused');
  const FlushResult.busy() : this._('busy');
  const FlushResult.unauthorized() : this._('unauthorized');
  const FlushResult.sent(int accepted, int duplicates, int rejected)
      : this._('sent', accepted: accepted, duplicates: duplicates, rejected: rejected);
  const FlushResult.retry(int retryInMs, String reason) : this._('retry', retryInMs: retryInMs, reason: reason);

  /// empty, paused, busy, unauthorized, sent or retry.
  final String status;
  final int accepted;
  final int duplicates;
  final int rejected;
  final int retryInMs;
  final String reason;

  @override
  bool operator ==(Object other) =>
      other is FlushResult &&
      other.status == status &&
      other.accepted == accepted &&
      other.duplicates == duplicates &&
      other.rejected == rejected &&
      other.retryInMs == retryInMs &&
      other.reason == reason;

  @override
  int get hashCode => Object.hash(status, accepted, duplicates, rejected, retryInMs, reason);

  @override
  String toString() => 'FlushResult($status, accepted: $accepted, rejected: $rejected, retryInMs: $retryInMs, $reason)';
}

class _QueuedEvent {
  _QueuedEvent(this.e, this.queuedAt);
  final Map<String, Object?> e;
  final int queuedAt;

  String get eventId => e['event_id'] as String;
  Map<String, Object?> toJson() => {'e': e, 'queuedAt': queuedAt};

  static _QueuedEvent? fromJson(Object? v) {
    if (v is! Map) return null;
    final e = v['e'];
    if (e is! Map || e['event_id'] is! String) return null;
    return _QueuedEvent(Map<String, Object?>.from(e), (v['queuedAt'] as num?)?.toInt() ?? 0);
  }
}

/// Persisted identity. Field names match the JavaScript SDK's state, plus native-only fields.
class _State {
  _State(this.anonymousId);

  String anonymousId;
  String? userId;
  String? sessionId;
  int? lastActivity;
  Map<String, String>? attributionFirst;
  Map<String, String>? attributionLatest;
  InstallReferrer? installReferrer;
  bool installReferrerChecked = false;
  String? appVersion;
  String? appBuild;

  Map<String, Object?> toJson() => {
        'anonymousId': anonymousId,
        if (userId != null) 'userId': userId,
        if (sessionId != null) 'sessionId': sessionId,
        if (lastActivity != null) 'lastActivity': lastActivity,
        if (attributionFirst != null && attributionLatest != null) 'attribution': {'first': attributionFirst, 'latest': attributionLatest},
        if (installReferrer != null) 'installReferrer': installReferrer!.toJson(),
        if (installReferrerChecked) 'installReferrerChecked': true,
        if (appVersion != null) 'appVersion': appVersion,
        if (appBuild != null) 'appBuild': appBuild,
      };

  static Map<String, String>? _strings(Object? v) {
    if (v is! Map) return null;
    return {
      for (final e in v.entries)
        if (e.key is String && e.value is String) e.key as String: e.value as String,
    };
  }

  static _State? fromJson(Object? v) {
    if (v is! Map) return null;
    final anon = v['anonymousId'];
    if (anon is! String || anon.isEmpty) return null;
    final s = _State(anon)
      ..userId = v['userId'] as String?
      ..sessionId = v['sessionId'] as String?
      ..lastActivity = (v['lastActivity'] as num?)?.toInt()
      ..installReferrer = InstallReferrer.fromJson(v['installReferrer'])
      ..installReferrerChecked = v['installReferrerChecked'] == true
      ..appVersion = v['appVersion'] as String?
      ..appBuild = v['appBuild'] as String?;
    final a = v['attribution'];
    if (a is Map) {
      s.attributionFirst = _strings(a['first']);
      s.attributionLatest = _strings(a['latest']);
    }
    return s;
  }
}

String _uuidV4(Random r) {
  final b = List<int>.generate(16, (_) => r.nextInt(256));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  final h = b.map((x) => x.toRadixString(16).padLeft(2, '0')).join();
  return '${h.substring(0, 8)}-${h.substring(8, 12)}-${h.substring(12, 16)}-${h.substring(16, 20)}-${h.substring(20)}';
}

/// Makes a value JSON-safe: DateTime → ISO string, non-finite numbers → null, unknown objects → toString().
Object? _jsonSafe(Object? v) {
  if (v == null || v is String || v is bool || v is int) return v;
  if (v is double) return v.isFinite ? v : null;
  if (v is DateTime) return v.toUtc().toIso8601String();
  if (v is Uri) return v.toString();
  if (v is Map) return {for (final e in v.entries) e.key.toString(): _jsonSafe(e.value)};
  if (v is Iterable) return v.map(_jsonSafe).toList();
  return v.toString();
}

/// ISO 8601 UTC with milliseconds, like JavaScript's Date.toISOString().
String isoString(int ms) {
  final d = DateTime.fromMillisecondsSinceEpoch(ms, isUtc: true);
  String two(int n) => n.toString().padLeft(2, '0');
  return '${d.year.toString().padLeft(4, '0')}-${two(d.month)}-${two(d.day)}T${two(d.hour)}:${two(d.minute)}:${two(d.second)}.'
      '${d.millisecond.toString().padLeft(3, '0')}Z';
}

/// The LeanApp client: a Dart port of sdks/javascript/src/client.ts with the same wire format and rules.
/// Every call is synchronous and never throws after construction; events go to a persistent queue and
/// are sent in batches with retries.
class LeanAppClient {
  LeanAppClient(
    LeanAppOptions options, {
    KeyValueStore? store,
    http.Client? httpClient,
    Map<String, Object?> Function()? contextProvider,
    int Function()? now,
    String Function()? uuid,
    double Function()? random,
    bool timersEnabled = true,
  })  : _o = options,
        _store = store ?? MemoryStore(),
        _http = httpClient ?? http.Client(),
        _contextProvider = contextProvider ?? (() => const {}),
        _now = now ?? (() => DateTime.now().millisecondsSinceEpoch),
        _uuid = uuid ?? (() => _uuidV4(Random.secure())),
        _random = random ?? Random().nextDouble,
        _timersEnabled = timersEnabled,
        _optedOut = options.optedOut,
        _maxBatchSize = options.maxBatchSize {
    if (!_keyPattern.hasMatch(options.apiKey)) {
      throw ArgumentError('LeanApp: apiKey must be a LeanApp key (la_pk_… for apps). Find it under Developers → SDK & API keys.');
    }
    if (options.apiKey.startsWith('la_sk_') && options.platform != 'backend') {
      throw ArgumentError('LeanApp: secret keys (la_sk_…) are for servers only. Use the public SDK key (la_pk_…) in apps.');
    }
    _prefix = storagePrefix(options.apiKey);
    _ready = _load();
  }

  final LeanAppOptions _o;
  final KeyValueStore _store;
  final http.Client _http;
  final Map<String, Object?> Function() _contextProvider;
  final int Function() _now;
  final String Function() _uuid;
  final double Function() _random;
  final bool _timersEnabled;
  late final String _prefix;
  late final Future<void> _ready;

  _State _state = _State('');
  List<_QueuedEvent> _queue = [];
  final List<void Function()> _pending = [];
  bool _loaded = false;
  bool _sending = false;
  bool _paused = false;
  bool _optedOut;
  int _failures = 0;
  int _retryAt = 0;
  /// Set after a 409 idempotency_key_reused: the next request goes without a key (event ids still de-duplicate).
  bool _skipIdempotencyKey = false;
  int _maxBatchSize;
  Timer? _timer;
  Future<void> _persistChain = Future<void>.value();

  /// Completes once persisted identity and queue are loaded. Calls made earlier are buffered, not lost.
  Future<void> whenReady() => _ready;

  // ── Public API ────────────────────────────────────────────────────────────

  void track(String eventName, [Map<String, Object?> properties = const {}, String? eventId, DateTime? timestamp]) {
    final name = eventName.trim();
    if (name.isEmpty) return _warn('track() needs an event name');
    final props = Map<String, Object?>.from(properties);
    _enqueue(() => {'type': 'track', 'event_name': name, 'properties': props}, eventId: eventId, timestamp: timestamp);
  }

  void screen(String screenName, [Map<String, Object?> properties = const {}]) {
    if (screenName.isEmpty) return _warn('screen() needs a screen name');
    final props = {...properties, 'screen_name': screenName};
    _enqueue(() => {'type': 'screen', 'event_name': screenName, 'properties': props});
  }

  /// Links this device to your user id. Traits are facts about the person (plan, city), not actions.
  void identify(String? userId, [Map<String, Object?> traits = const {}]) {
    final t = Map<String, Object?>.from(traits);
    _enqueue(() {
      if (userId != null && userId.isNotEmpty) {
        _state.userId = userId;
        _persistState();
      }
      return {'type': 'identify', 'user_properties': t};
    });
  }

  void setUserProperties(Map<String, Object?> traits) => identify(null, traits);

  /// Merges a previous user id into the current one (e.g. a guest account that signed up).
  void alias(String newUserId, [String? previousId]) {
    _enqueue(() {
      final prev = previousId ?? _state.userId ?? _state.anonymousId;
      _state.userId = newUserId;
      _persistState();
      return {'type': 'alias', 'previous_id': prev};
    });
  }

  /// provider: 'fcm' or 'apns'; permission: granted, denied, provisional or unknown.
  void registerPushToken(String token, String provider, [String permission = 'unknown']) {
    if (provider != 'fcm' && provider != 'apns') return _warn('registerPushToken() provider must be fcm or apns');
    _enqueue(() => {
          'type': 'push_token',
          'push_token': {'token': token, 'provider': provider, 'permission': permission},
        });
  }

  /// Captures campaign parameters from a deep link. The first touch is kept; the latest is attached to every
  /// following event as context.attribution, with the URL as deep_link_url.
  Map<String, String>? captureAttribution(String url) {
    final parsed = parseAttribution(url);
    if (parsed == null) return null;
    final touch = {...parsed, 'deep_link_url': url.length > 1000 ? url.substring(0, 1000) : url};
    _whenLoaded(() {
      _state.attributionFirst ??= touch;
      _state.attributionLatest = touch;
      _persistState();
    });
    return touch;
  }

  /// First and latest touch captured on this device, or null.
  ({Map<String, String> first, Map<String, String> latest})? getAttribution() {
    final f = _state.attributionFirst;
    final l = _state.attributionLatest;
    if (f == null || l == null) return null;
    return (first: f, latest: l);
  }

  String get anonymousId => _state.anonymousId;
  String? get userId => _state.userId;
  int get queueLength => _queue.length;

  /// Call on logout: forgets the user and attribution and starts a new anonymous id and session. Queued events keep their ids.
  void reset() {
    _whenLoaded(() {
      final old = _state;
      _state = _State(_uuid())
        ..installReferrer = old.installReferrer
        ..installReferrerChecked = old.installReferrerChecked
        ..appVersion = old.appVersion
        ..appBuild = old.appBuild;
      _persistState();
    });
  }

  void optOut() => _optedOut = true;

  void optIn() {
    _optedOut = false;
    _schedule(0);
  }

  /// Google Play Install Referrer (Android). Stored once per install, sent as context.campaign on every event,
  /// and its utm_* / click ids become the first touch when none was captured. Pass null when unavailable.
  void setInstallReferrer(InstallReferrer? referrer) {
    _whenLoaded(() {
      _state.installReferrerChecked = true;
      if (referrer != null && referrer.referrer.isNotEmpty) {
        _state.installReferrer = referrer;
        final parsed = parseAttribution(referrer.referrer);
        if (parsed != null && _state.attributionFirst == null) {
          _state.attributionFirst = parsed;
          _state.attributionLatest ??= parsed;
        }
      }
      _persistState();
    });
  }

  /// True when this install has not recorded its install referrer yet.
  Future<bool> installReferrerPending() async {
    await _ready;
    return !_state.installReferrerChecked;
  }

  /// Sends app_installed on the first launch with the SDK and app_updated when the version or build changed.
  void trackInstallOrUpdate(String? appVersion, String? appBuild, {DateTime? timestamp}) {
    final at = timestamp?.millisecondsSinceEpoch ?? _now();
    _whenLoaded(() {
      final version = appVersion ?? '';
      final build = appBuild ?? '';
      if (_state.appVersion == null && _state.appBuild == null) {
        _enqueueNow({'type': 'track', 'event_name': 'app_installed', 'properties': {'version': version, 'build': build}}, null, at);
      } else if ((_state.appVersion ?? '') != version || (_state.appBuild ?? '') != build) {
        _enqueueNow({
          'type': 'track',
          'event_name': 'app_updated',
          'properties': {'version': version, 'build': build, 'previous_version': _state.appVersion ?? '', 'previous_build': _state.appBuild ?? ''},
        }, null, at);
      }
      _state.appVersion = version;
      _state.appBuild = build;
      _persistState();
    });
  }

  /// Sends everything queued now, batch after batch, and completes with the last result.
  Future<FlushResult> flush() async {
    await _ready;
    FlushResult last = const FlushResult.empty();
    // Bounded: each round either removes events or stops.
    for (var i = 0; i < 1000; i++) {
      final r = await _sendBatch(true);
      if (r.status == 'sent') {
        last = r;
        if (_queue.isNotEmpty) continue;
        return r;
      }
      return r.status == 'empty' && last.status == 'sent' ? last : r;
    }
    return last;
  }

  /// Stops timers. Queued events stay persisted and are sent by the next client.
  Future<void> shutdown() async {
    _timer?.cancel();
    _timer = null;
    await _persistChain;
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  Future<void> _load() async {
    try {
      final rawState = await _store.get('${_prefix}state');
      final rawQueue = await _store.get('${_prefix}queue');
      _state = (rawState != null ? _State.fromJson(jsonDecode(rawState)) : null) ?? _State(_uuid());
      final q = rawQueue != null ? jsonDecode(rawQueue) : null;
      _queue = q is List ? q.map(_QueuedEvent.fromJson).whereType<_QueuedEvent>().toList() : [];
    } catch (err) {
      _warn('could not read persisted state; starting fresh', err);
      _state = _State(_uuid());
      _queue = [];
    }
    _persistState();
    _loaded = true;
    final fns = List<void Function()>.from(_pending);
    _pending.clear();
    for (final fn in fns) {
      fn();
    }
    _persistQueue();
    if (_queue.isNotEmpty) _schedule(0);
  }

  void _whenLoaded(void Function() fn) {
    if (_loaded) {
      fn();
    } else {
      _pending.add(fn);
    }
  }

  void _enqueue(Map<String, Object?> Function() build, {String? eventId, DateTime? timestamp}) {
    // Timestamp is taken at call time, not when storage finishes loading.
    final at = timestamp?.millisecondsSinceEpoch ?? _now();
    _whenLoaded(() {
      try {
        _enqueueNow(build(), eventId, at);
      } catch (err) {
        _warn('failed to queue event', err);
      }
    });
  }

  void _enqueueNow(Map<String, Object?> partial, String? eventId, int at) {
    final e = <String, Object?>{
      ...partial,
      'event_id': eventId ?? _uuid(),
      'timestamp': isoString(at),
      'anonymous_id': _state.anonymousId,
      'session_id': _touchSession(at),
      'context': _context(),
    };
    if (_state.userId != null) e['user_id'] = _state.userId;
    if (_queue.any((q) => q.eventId == e['event_id'])) return; // duplicate call with the same event id
    _queue.add(_QueuedEvent(_jsonSafe(e) as Map<String, Object?>, _now()));
    if (_queue.length > _o.maxQueueSize) {
      final dropped = _queue.length - _o.maxQueueSize;
      _queue.removeRange(0, dropped);
      _warn('queue full: dropped $dropped oldest event(s)');
    }
    _log('queued ${e['type']} ${e['event_name'] ?? ''}');
    _persistQueue();
    _schedule(_queue.length >= _o.flushAt ? 0 : _o.flushInterval.inMilliseconds);
  }

  String _touchSession(int at) {
    final s = _state;
    final last = s.lastActivity;
    if (s.sessionId == null || last == null || at - last > _o.sessionTimeout.inMilliseconds) s.sessionId = _uuid();
    s.lastActivity = max(at, last ?? 0);
    _persistState();
    return s.sessionId!;
  }

  Map<String, Object?> _context() {
    final ctx = <String, Object?>{};
    try {
      ctx.addAll(_contextProvider());
    } catch (err) {
      _warn('context provider failed', err);
    }
    ctx.addAll(_o.context);
    ctx['platform'] = _o.platform;
    ctx['sdk'] = {'name': sdkName, 'version': sdkVersion};
    if (_o.appVersion != null) ctx['app_version'] = _o.appVersion;
    if (_o.appBuild != null) ctx['app_build'] = _o.appBuild;
    if (_state.attributionLatest != null) ctx['attribution'] = Map<String, String>.from(_state.attributionLatest!);
    if (_state.installReferrer != null) ctx['campaign'] = _state.installReferrer!.toContext();
    return ctx;
  }

  void _schedule(int delayMs) {
    if (_paused || !_timersEnabled) return;
    final wait = max(max(delayMs, _retryAt - _now()), 0);
    if (_timer != null) {
      if (wait > 0) return; // a send is already scheduled
      _timer!.cancel();
    }
    _timer = Timer(Duration(milliseconds: wait), () {
      _timer = null;
      _sendBatch(false).then((r) {
        if (r.status == 'sent' && _queue.isNotEmpty) _schedule(_queue.length >= _o.flushAt ? 0 : _o.flushInterval.inMilliseconds);
      });
    });
  }

  Future<FlushResult> _sendBatch(bool manual) async {
    if (_paused) return const FlushResult.unauthorized();
    if (_optedOut) return const FlushResult.paused();
    if (_sending) return const FlushResult.busy();
    final now = _now();
    if (!manual && now < _retryAt) {
      _schedule(_retryAt - now);
      return FlushResult.retry(_retryAt - now, 'backoff');
    }
    final before = _queue.length;
    _queue = _queue.where((q) => now - q.queuedAt <= _o.eventTtl.inMilliseconds).toList();
    if (_queue.length != before) {
      _warn('dropped ${before - _queue.length} expired event(s)');
      _persistQueue();
    }
    if (_queue.isEmpty) return const FlushResult.empty();

    final batch = _queue.sublist(0, min(_maxBatchSize, _queue.length));
    _sending = true;
    final withKey = !_skipIdempotencyKey;
    _skipIdempotencyKey = false;
    try {
      final res = await _http.post(
        Uri.parse('${_o.endpoint}/v1/events/batch'),
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ${_o.apiKey}',
          // Same events → same key, so a retried request is answered from the server's idempotency store.
          if (withKey) 'Idempotency-Key': idempotencyKey(batch.map((q) => q.eventId).toList()),
        },
        body: jsonEncode({'batch': batch.map((q) => q.e).toList(), 'sent_at': isoString(_now())}),
      );

      if (res.statusCode >= 200 && res.statusCode < 300) {
        Map<String, Object?> body = const {};
        try {
          final decoded = jsonDecode(res.body);
          if (decoded is Map<String, Object?>) body = decoded;
        } catch (_) {
          // empty or non-JSON body
        }
        final rejected = body['rejected'] is List ? body['rejected'] as List : const [];
        for (final r in rejected) {
          if (r is Map && r['index'] is int && (r['index'] as int) < batch.length) {
            final e = batch[r['index'] as int].e;
            _warn('event rejected by server: ${e['event_name'] ?? e['type']}', r['errors']);
          }
        }
        _remove(batch);
        _failures = 0;
        _retryAt = 0;
        return FlushResult.sent((body['accepted'] as num?)?.toInt() ?? 0, (body['duplicates'] as num?)?.toInt() ?? 0, rejected.length);
      }
      if (res.statusCode == 401 || res.statusCode == 403) {
        // Revoked or wrong key: keep events, stop sending until the app restarts with a valid key.
        _paused = true;
        _warn('API key rejected (revoked, expired or wrong environment). Events are kept but not sent.');
        return const FlushResult.unauthorized();
      }
      if (res.statusCode == 409) {
        // idempotency_key_reused: nothing was stored. Keep the events and resend them without a key;
        // their event ids still make the resend safe.
        _skipIdempotencyKey = true;
        return _backoff(0, 'idempotency key already used for other events; resending without it');
      }
      if (res.statusCode == 413 && batch.length > 1) {
        _maxBatchSize = max(1, batch.length ~/ 2);
        return _backoff(0, 'payload too large; splitting batch');
      }
      if (res.statusCode == 400 || res.statusCode == 413 || res.statusCode == 422) {
        // The batch itself is malformed: retrying cannot succeed.
        _warn('server refused batch (${res.statusCode}); dropping ${batch.length} event(s)', res.body);
        _remove(batch);
        return FlushResult.sent(0, 0, batch.length);
      }
      final retryAfter = double.tryParse(res.headers['retry-after']?.trim() ?? '');
      return _backoff(retryAfter != null && retryAfter > 0 ? (retryAfter * 1000).round() : null, 'HTTP ${res.statusCode}');
    } catch (err) {
      return _backoff(null, err.toString());
    } finally {
      _sending = false;
    }
  }

  FlushResult _backoff(int? explicitMs, String reason) {
    _failures++;
    final exp = min(_maxBackoffMs, _baseBackoffMs * (1 << min(_failures - 1, 16)));
    final wait = explicitMs ?? (exp / 2 + _random() * (exp / 2)).round(); // jittered
    _retryAt = _now() + wait;
    _log('send failed ($reason); retrying in ${wait}ms');
    _schedule(wait);
    return FlushResult.retry(wait, reason);
  }

  void _remove(List<_QueuedEvent> sent) {
    final ids = sent.map((q) => q.eventId).toSet();
    _queue = _queue.where((q) => !ids.contains(q.eventId)).toList();
    _persistQueue();
  }

  void _persistQueue() {
    final snapshot = jsonEncode(_queue.map((q) => q.toJson()).toList());
    _persist(() => _store.set('${_prefix}queue', snapshot));
  }

  void _persistState() {
    final snapshot = jsonEncode(_state.toJson());
    _persist(() => _store.set('${_prefix}state', snapshot));
  }

  // Writes are serialized so an older snapshot never overwrites a newer one.
  void _persist(Future<void> Function() write) {
    _persistChain = _persistChain.then((_) => write()).catchError((Object err) => _warn('storage write failed', err));
  }

  void _log(String msg) {
    if (_o.debug) print('[LeanApp] $msg');
  }

  void _warn(String msg, [Object? detail]) {
    if (_o.debug) print('[LeanApp] $msg ${detail ?? ''}');
  }
}
