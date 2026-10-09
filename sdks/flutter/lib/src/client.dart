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

/// A consent purpose's state: the user's answer, or the configured default where they haven't answered.
enum ConsentStatus { granted, pending, denied }

/// What the user can agree to; each purpose is decided separately. Same purposes as the JavaScript SDK.
/// analytics governs track/screen/identify/alias; push governs registerPushToken; attribution governs
/// captureAttribution, the install referrer, the attribution and campaign context on events and the
/// deferred deep link request; marketing is recorded with the others for your own use.
const List<String> consentPurposes = ['analytics', 'marketing', 'push', 'attribution'];

/// LeanApp's answer from POST /v1/deep-links/deferred.
class DeferredDeepLink {
  const DeferredDeepLink({
    required this.matchType,
    this.reason,
    this.matchKey,
    this.linkCode,
    this.linkName,
    this.deepLinkPath,
    this.deepLinkUrl,
    this.deepLinkParams = const {},
    this.campaign = const {},
    this.clickId,
  });

  /// deterministic, probabilistic or none.
  final String matchType;

  /// Why nothing matched: no_click, already_checked, disabled.
  final String? reason;
  final String? matchKey;
  final String? linkCode;
  final String? linkName;

  /// The in-app path to open, e.g. /product/42, or null when the link has none.
  final String? deepLinkPath;

  /// The path with its parameters.
  final String? deepLinkUrl;
  final Map<String, String> deepLinkParams;
  final Map<String, String?> campaign;
  final String? clickId;

  bool get matched => matchType != 'none';

  /// Parses the endpoint's JSON body.
  static DeferredDeepLink? fromJson(Object? v) {
    if (v is! Map || v['match_type'] is! String) return null;
    final link = v['link'];
    final dl = v['deep_link'];
    final Map params = dl is Map && dl['params'] is Map ? dl['params'] as Map : const {};
    final Map campaign = v['campaign'] is Map ? v['campaign'] as Map : const {};
    return DeferredDeepLink(
      matchType: v['match_type'] as String,
      reason: v['reason'] as String?,
      matchKey: v['match_key'] as String?,
      linkCode: link is Map ? link['code'] as String? : null,
      linkName: link is Map ? link['name'] as String? : null,
      deepLinkPath: dl is Map ? dl['path'] as String? : null,
      deepLinkUrl: dl is Map ? dl['url'] as String? : null,
      deepLinkParams: {
        for (final e in params.entries)
          if (e.key is String && e.value is String) e.key as String: e.value as String,
      },
      campaign: {
        for (final e in campaign.entries)
          if (e.key is String) e.key as String: e.value is String ? e.value as String : null,
      },
      clickId: v['click_id'] as String?,
    );
  }
}

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
    this.consentDefault = ConsentStatus.granted,
    this.consentDefaults = const {},
    this.deferredDeepLinks = true,
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

  /// Consent assumed for every purpose until setConsent() records the user's answer. granted (default, the
  /// behaviour before consent existed): track normally. pending: events wait in memory only (not stored, not
  /// sent) until consent is granted, and are discarded if it is denied or the app closes first. denied:
  /// events are dropped.
  final ConsentStatus consentDefault;

  /// Per-purpose overrides of [consentDefault], keyed by purpose name (analytics, marketing, push, attribution).
  final Map<String, ConsentStatus> consentDefaults;

  /// On the first launch of a new install, ask LeanApp once for the deferred deep link (needs attribution consent).
  final bool deferredDeepLinks;
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
  _QueuedEvent(this.e, this.queuedAt, [this.attr]);
  final Map<String, Object?> e;
  final int queuedAt;

  /// Memory only, on events held for consent: the attribution context to add if attribution consent is granted by then.
  final Map<String, Object?>? attr;

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

  /// The user's explicit answers (setConsent). Purposes not here follow the configured default.
  Map<String, bool> consent = {};

  /// false: a new install that still has to ask for its deferred deep link; null: an install from before they existed.
  bool? deferredChecked;

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
        if (consent.isNotEmpty) 'consent': consent,
        if (deferredChecked != null) 'deferredChecked': deferredChecked,
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
      ..appBuild = v['appBuild'] as String?
      ..deferredChecked = v['deferredChecked'] is bool ? v['deferredChecked'] as bool : null;
    final c = v['consent'];
    if (c is Map) {
      s.consent = {
        for (final e in c.entries)
          if (e.key is String && e.value is bool) e.key as String: e.value as bool,
      };
    }
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

  /// Events waiting for consent: memory only, never persisted or sent until consent is granted.
  List<_QueuedEvent> _held = [];

  /// Attribution captured while attribution consent is pending: memory only.
  Map<String, String>? _heldFirst;
  Map<String, String>? _heldLatest;

  /// The deferred deep link request waiting for attribution consent.
  Completer<DeferredDeepLink?>? _deferredWaiting;
  String? _deferredOs;
  String? _deferredOsVersion;
  bool _deferredInFlight = false;
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
    var changed = false;
    _enqueue(() {
      if (userId != null && userId.isNotEmpty) {
        changed = _state.userId != userId;
        _state.userId = userId;
        _persistState();
      }
      return {'type': 'identify', 'user_properties': t};
    });
    // Consent given on this device follows the user who signs in on it.
    _whenLoaded(() {
      if (changed) _resendConsent();
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
    _whenLoaded(_resendConsent);
  }

  /// provider: 'fcm' or 'apns'; permission: granted, denied, provisional or unknown.
  void registerPushToken(String token, String provider, [String permission = 'unknown']) {
    if (provider != 'fcm' && provider != 'apns') return _warn('registerPushToken() provider must be fcm or apns');
    _enqueue(
        () => {
              'type': 'push_token',
              'push_token': {'token': token, 'provider': provider, 'permission': permission},
            },
        purpose: 'push');
  }

  /// Captures campaign parameters from a deep link. The first touch is kept; the latest is attached to every
  /// following event as context.attribution, with the URL as deep_link_url. Governed by attribution
  /// consent: ignored when denied, kept in memory only while pending.
  Map<String, String>? captureAttribution(String url) {
    final parsed = parseAttribution(url);
    if (parsed == null) return null;
    final touch = {...parsed, 'deep_link_url': url.length > 1000 ? url.substring(0, 1000) : url};
    _whenLoaded(() => _recordTouch(touch, firstOnly: false));
    return touch;
  }

  /// Records the user's consent answers (purpose -> granted), e.g. from your consent screen. Purposes left out
  /// keep their state. The answers are stored on the device and sent to LeanApp whatever they are, so the
  /// platform can honour them. Granting analytics releases events waiting in memory; denying it discards
  /// them and clears the unsent queue.
  void setConsent(Map<String, bool> consent) {
    final changes = <String, bool>{
      for (final p in consentPurposes)
        if (consent[p] != null) p: consent[p]!,
    };
    if (changes.isEmpty) return _warn('setConsent() needs at least one of analytics, marketing, push, attribution');
    final at = _now();
    _whenLoaded(() {
      _state.consent = {..._state.consent, ...changes};
      _persistState();
      // The change goes first, then whatever it releases.
      _pushConsent(changes, at);
      _applyConsent();
    });
  }

  /// Current consent per purpose: the user's answer, or the configured default where they haven't answered.
  Map<String, ConsentStatus> getConsent() => {for (final p in consentPurposes) p: _consentFor(p)};

  /// Asks LeanApp once per new install (POST /v1/deep-links/deferred) for the deep link of the link click the
  /// install came from. Waits for attribution consent. Completes with the answer, or null when the request
  /// failed, attribution consent was denied, deferred deep links are off or this install already asked.
  Future<DeferredDeepLink?> requestDeferredDeepLink({String? os, String? osVersion}) async {
    await _ready;
    if (!_o.deferredDeepLinks || _state.deferredChecked != false || _deferredWaiting != null || _deferredInFlight) return null;
    final waiting = Completer<DeferredDeepLink?>();
    _deferredWaiting = waiting;
    _deferredOs = os;
    _deferredOsVersion = osVersion;
    _maybeFetchDeferred();
    return waiting.future;
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
        ..appBuild = old.appBuild
        ..consent = old.consent
        ..deferredChecked = old.deferredChecked;
      _heldFirst = null;
      _heldLatest = null;
      _persistState();
      _resendConsent();
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
        // Kept on the device so it is not asked again; sent (context.campaign) only with attribution consent.
        _state.installReferrer = referrer;
        final parsed = parseAttribution(referrer.referrer);
        if (parsed != null) _recordTouch(parsed, firstOnly: true);
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
      final loaded = rawState != null ? _State.fromJson(jsonDecode(rawState)) : null;
      // A new install still has to ask for its deferred deep link (false until answered); installs from
      // before deferred deep links existed are not new and never ask.
      _state = loaded ?? (_State(_uuid())..deferredChecked = false);
      _state.deferredChecked ??= true;
      final q = rawQueue != null ? jsonDecode(rawQueue) : null;
      _queue = q is List ? q.map(_QueuedEvent.fromJson).whereType<_QueuedEvent>().toList() : [];
    } catch (err) {
      _warn('could not read persisted state; starting fresh', err);
      _state = _State(_uuid())..deferredChecked = true;
      _queue = [];
    }
    // Unsent events from before a denial (e.g. the app closed mid-way) are not sent.
    _queue = _queue.where((q) => q.e['type'] == 'consent' || _consentFor(_purposeOf(q)) != ConsentStatus.denied).toList();
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

  void _enqueue(Map<String, Object?> Function() build, {String? eventId, DateTime? timestamp, String purpose = 'analytics'}) {
    // Timestamp is taken at call time, not when storage finishes loading.
    final at = timestamp?.millisecondsSinceEpoch ?? _now();
    _whenLoaded(() {
      try {
        _enqueueNow(build(), eventId, at, purpose);
      } catch (err) {
        _warn('failed to queue event', err);
      }
    });
  }

  void _enqueueNow(Map<String, Object?> partial, String? eventId, int at, [String purpose = 'analytics']) {
    final status = _consentFor(purpose);
    if (status == ConsentStatus.denied) return _log('dropped (consent denied): ${partial['type']} ${partial['event_name'] ?? ''}');
    final id = eventId ?? _uuid();
    if (_queue.any((q) => q.eventId == id) || _held.any((q) => q.eventId == id)) return; // duplicate call with the same event id
    final ctx = _context();
    final attr = _attributionContext();
    final attrStatus = _consentFor('attribution');
    if (attrStatus == ConsentStatus.granted) ctx.addAll(attr);
    final e = <String, Object?>{
      ...partial,
      'event_id': id,
      'timestamp': isoString(at),
      'anonymous_id': _state.anonymousId,
      'session_id': _touchSession(at),
      'context': ctx,
    };
    if (_state.userId != null) e['user_id'] = _state.userId;
    if (status == ConsentStatus.pending) {
      // Waiting for consent: memory only, bounded like the queue. The attribution context waits too, in case
      // attribution consent is granted by the time the event is released.
      _held.add(_QueuedEvent(_jsonSafe(e) as Map<String, Object?>, _now(), attrStatus == ConsentStatus.pending && attr.isNotEmpty ? attr : null));
      if (_held.length > _o.maxQueueSize) _held.removeRange(0, _held.length - _o.maxQueueSize);
      return _log('held until consent: ${e['type']} ${e['event_name'] ?? ''}');
    }
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
    // The user's explicit answers only: a default is not consent the user gave.
    if (_state.consent.isNotEmpty) ctx['consent'] = Map<String, bool>.from(_state.consent);
    return ctx;
  }

  /// context.attribution (latest touch) and context.campaign (install referrer), before consent is applied.
  Map<String, Object?> _attributionContext() {
    final latest = _state.attributionLatest ?? _heldLatest;
    return {
      if (latest != null) 'attribution': Map<String, String>.from(latest),
      if (_state.installReferrer != null) 'campaign': _state.installReferrer!.toContext(),
    };
  }

  String _purposeOf(_QueuedEvent q) => q.e['type'] == 'push_token' ? 'push' : 'analytics';

  ConsentStatus _consentFor(String purpose) {
    final v = _state.consent[purpose];
    if (v == true) return ConsentStatus.granted;
    if (v == false) return ConsentStatus.denied;
    return _o.consentDefaults[purpose] ?? _o.consentDefault;
  }

  /// Stores a touch under attribution consent: the first is kept, the latest replaced (or only filled when [firstOnly]).
  void _recordTouch(Map<String, String> touch, {required bool firstOnly}) {
    final status = _consentFor('attribution');
    if (status == ConsentStatus.denied) return;
    if (status == ConsentStatus.pending) {
      // Kept in memory until the user decides; stored only once attribution consent is granted.
      _heldFirst ??= _state.attributionFirst ?? touch;
      if (!firstOnly || _heldLatest == null) _heldLatest = touch;
      return;
    }
    if (firstOnly && _state.attributionFirst != null) return;
    _state.attributionFirst ??= touch;
    if (!firstOnly || _state.attributionLatest == null) _state.attributionLatest = touch;
    _persistState();
  }

  /// Moves or discards what was waiting for consent after the user's answer changed.
  void _applyConsent() {
    final attribution = _consentFor('attribution');
    final release = _held.where((q) => _consentFor(_purposeOf(q)) == ConsentStatus.granted).toList();
    _held = _held.where((q) => _consentFor(_purposeOf(q)) == ConsentStatus.pending).toList();
    final before = _queue.length;
    // Denied: unsent events of that purpose are discarded. Consent changes always stay.
    _queue = _queue.where((q) => q.e['type'] == 'consent' || _consentFor(_purposeOf(q)) != ConsentStatus.denied).toList();
    if (before != _queue.length) _log('consent denied: discarded ${before - _queue.length} unsent event(s)');
    for (final q in release) {
      final attr = q.attr;
      if (attr != null && attribution == ConsentStatus.granted) {
        // Attribution that waited with the event goes only if attribution consent is granted now.
        final ctx = Map<String, Object?>.from(q.e['context'] as Map? ?? const {})..addAll(_jsonSafe(attr) as Map<String, Object?>);
        _queue.add(_QueuedEvent({...q.e, 'context': ctx}, q.queuedAt));
      } else {
        _queue.add(_QueuedEvent(q.e, q.queuedAt));
      }
    }
    if (_queue.length > _o.maxQueueSize) _queue.removeRange(0, _queue.length - _o.maxQueueSize);
    if (attribution == ConsentStatus.granted && (_heldFirst != null || _heldLatest != null)) {
      _state.attributionFirst ??= _heldFirst ?? _heldLatest;
      if (_heldLatest != null) _state.attributionLatest = _heldLatest;
      _state.attributionLatest ??= _state.attributionFirst;
      _persistState();
    }
    if (attribution != ConsentStatus.pending) {
      _heldFirst = null;
      _heldLatest = null;
    }
    if (attribution == ConsentStatus.denied && (_state.attributionFirst != null || _state.attributionLatest != null)) {
      _state.attributionFirst = null;
      _state.attributionLatest = null;
      _persistState();
    }
    if (before != _queue.length || release.isNotEmpty) _persistQueue();
    if (_queue.isNotEmpty) _schedule(_queue.length >= _o.flushAt ? 0 : _o.flushInterval.inMilliseconds);
    _maybeFetchDeferred();
  }

  /// Queues a consent change for LeanApp, whatever the answer, with only the ids and minimal context.
  void _pushConsent(Map<String, bool> consent, int at) {
    final e = <String, Object?>{
      'type': 'consent',
      'consent': Map<String, bool>.from(consent),
      'event_id': _uuid(),
      'timestamp': isoString(at),
      'anonymous_id': _state.anonymousId,
      'context': {
        'platform': _o.platform,
        'sdk': {'name': sdkName, 'version': sdkVersion},
        if (_o.appVersion != null) 'app_version': _o.appVersion,
      },
    };
    if (_state.userId != null) e['user_id'] = _state.userId;
    _queue.add(_QueuedEvent(e, at));
    if (_queue.length > _o.maxQueueSize) {
      // Never drop a consent change to make room: drop the oldest other event instead.
      final i = _queue.indexWhere((q) => q.e['type'] != 'consent');
      _queue.removeAt(i >= 0 ? i : 0);
    }
    _log('queued consent $consent');
    _persistQueue();
    _schedule(0);
  }

  /// Records the device's explicit answers again for a new identity (sign-in, alias, reset).
  void _resendConsent() {
    if (_state.consent.isNotEmpty) _pushConsent(Map<String, bool>.from(_state.consent), _now());
  }

  void _maybeFetchDeferred() {
    final waiting = _deferredWaiting;
    if (waiting == null || _deferredInFlight) return;
    final status = _consentFor('attribution');
    if (status == ConsentStatus.pending) return; // asked once attribution consent is granted
    _deferredWaiting = null;
    if (status == ConsentStatus.denied) {
      waiting.complete(null);
      return;
    }
    _deferredInFlight = true;
    waiting.complete(_fetchDeferred(_deferredOs, _deferredOsVersion).whenComplete(() => _deferredInFlight = false));
  }

  Future<DeferredDeepLink?> _fetchDeferred(String? os, String? osVersion) async {
    final clickId = _state.attributionLatest?['click_id'];
    final body = <String, Object?>{
      'anonymous_id': _state.anonymousId,
      'platform': _o.platform,
      if (os != null) 'os': os,
      if (osVersion != null) 'os_version': osVersion.length > 40 ? osVersion.substring(0, 40) : osVersion,
      if (_state.installReferrer != null) 'install_referrer': _cut(_state.installReferrer!.referrer, 2000),
      if (clickId != null) 'click_id': _cut(clickId, 100),
    };
    try {
      final res = await _http.post(
        Uri.parse('${_o.endpoint}/v1/deep-links/deferred'),
        headers: {'Content-Type': 'application/json', 'Authorization': 'Bearer ${_o.apiKey}'},
        body: jsonEncode(body),
      );
      if (res.statusCode >= 200 && res.statusCode < 300) {
        _state.deferredChecked = true;
        _persistState();
        return DeferredDeepLink.fromJson(jsonDecode(res.body));
      }
      _warn('deferred deep link request failed with ${res.statusCode}');
      // Asked again on the next launch, unless the request itself was refused as invalid.
      if (res.statusCode == 400 || res.statusCode == 422) {
        _state.deferredChecked = true;
        _persistState();
      }
    } catch (err) {
      _warn('deferred deep link request failed', err);
    }
    return null;
  }

  static String _cut(String s, int max) => s.length > max ? s.substring(0, max) : s;

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
