import 'dart:convert';
import 'dart:io' show SocketException;

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:leanapp_analytics/leanapp_analytics.dart';

const key = 'la_pk_dev_abcdefghijklmnopqrstuvwx';

class Call {
  Call(this.request) : body = jsonDecode(request.body) as Map<String, dynamic>;
  final http.Request request;
  final Map<String, dynamic> body;
  List<Map<String, dynamic>> get batch => (body['batch'] as List).cast<Map<String, dynamic>>();
}

class Server {
  Server([http.Response Function(Call call, int n)? responder])
      : responder = responder ?? ((c, _) => ok(c.batch.length));
  final List<Call> calls = [];
  http.Response Function(Call call, int n) responder;
  late final MockClient client = MockClient((req) async {
    final call = Call(req);
    calls.add(call);
    return responder(call, calls.length);
  });

  static http.Response ok(int n) => http.Response(jsonEncode({'accepted': n, 'duplicates': 0, 'rejected': []}), 200);
}

class Harness {
  Harness(this.client, this.clock);
  final LeanAppClient client;
  final Clock clock;
}

class Clock {
  int t = DateTime.parse('2026-10-05T10:00:00Z').millisecondsSinceEpoch;
  int now() => t;
  void advance(int ms) => t += ms;
}

Harness make(
  Server server, {
  KeyValueStore? store,
  String endpoint = 'https://api.example.test/',
  int maxBatchSize = 100,
  int maxQueueSize = 1000,
  Duration eventTtl = const Duration(days: 7),
  bool optedOut = false,
  int flushAt = 1000,
  bool timers = false,
}) {
  final clock = Clock();
  var id = 0;
  final client = LeanAppClient(
    LeanAppOptions(
      apiKey: key,
      endpoint: endpoint,
      appVersion: '2.3.0',
      flushAt: flushAt,
      flushInterval: const Duration(seconds: 60),
      maxBatchSize: maxBatchSize,
      maxQueueSize: maxQueueSize,
      eventTtl: eventTtl,
      optedOut: optedOut,
    ),
    store: store ?? MemoryStore(),
    httpClient: server.client,
    contextProvider: () => {'locale': 'ar-SA', 'os_version': '14'},
    now: clock.now,
    uuid: () => 'id-${++id}',
    random: () => 0.5,
    timersEnabled: timers,
  );
  return Harness(client, clock);
}

void main() {
  group('configuration', () {
    test('rejects keys that are not LeanApp keys', () {
      expect(() => LeanAppClient(LeanAppOptions(apiKey: 'sk_live_123')), throwsA(isA<ArgumentError>()));
    });

    test('refuses a secret key outside a server', () {
      final secret = 'la_sk_dev_${'x' * 40}';
      expect(() => LeanAppClient(LeanAppOptions(apiKey: secret)), throwsA(isA<ArgumentError>()));
      expect(() => LeanAppClient(LeanAppOptions(apiKey: secret, platform: 'backend')), returnsNormally);
    });

    test('namespaces storage by key kind and environment', () {
      expect(storagePrefix(key), 'leanapp:la_pk_dev:');
      expect(storagePrefix('la_pk_live_${'a' * 24}'), 'leanapp:la_pk_live:');
    });

    test('defaults to the LeanApp API', () async {
      final s = Server();
      final h = make(s, endpoint: defaultEndpoint);
      h.client.track('app_opened');
      await h.client.flush();
      expect(s.calls[0].request.url.toString(), 'https://api.leanapp.io/v1/events/batch');
    });
  });

  group('events', () {
    test('sends batched events with identity, session and context', () async {
      final s = Server();
      final h = make(s);
      final c = h.client;
      c.track('product_viewed', {'product_id': 'p1'});
      c.screen('Home');
      c.identify('u-42', {'city': 'Riyadh'});
      c.track('order_completed', {'order_id': 'o1', 'revenue': 45, 'currency': 'SAR', 'at': DateTime.utc(2026, 10, 5)}, 'order-o1');
      expect(await c.flush(), const FlushResult.sent(4, 0, 0));
      expect(s.calls, hasLength(1));
      final call = s.calls[0];
      expect(call.request.url.toString(), 'https://api.example.test/v1/events/batch');
      expect(call.request.headers['Authorization'], 'Bearer $key');
      expect(call.body['sent_at'], isA<String>());
      final b = call.batch;
      // batch size : hash of every event id : first event id
      expect(call.request.headers['Idempotency-Key'], '4:${eventIdsHash(b.map((e) => e['event_id'] as String).toList())}:id-2');
      expect(b[0]['type'], 'track');
      expect(b[0]['event_name'], 'product_viewed');
      expect(b[0]['properties'], {'product_id': 'p1'});
      expect(b[0]['anonymous_id'], 'id-1');
      expect(b[0].containsKey('user_id'), isFalse);
      expect(b[0]['timestamp'], '2026-10-05T10:00:00.000Z');
      final ctx = b[0]['context'] as Map;
      expect(ctx['platform'], 'flutter');
      expect(ctx['app_version'], '2.3.0');
      expect(ctx['locale'], 'ar-SA');
      expect(ctx['sdk'], {'name': 'leanapp-flutter', 'version': sdkVersion});
      expect(b[1]['type'], 'screen');
      expect(b[1]['properties'], {'screen_name': 'Home'});
      expect(b[2]['type'], 'identify');
      expect(b[2]['user_id'], 'u-42');
      expect(b[2]['user_properties'], {'city': 'Riyadh'});
      expect(b[3]['event_id'], 'order-o1');
      expect(b[3]['user_id'], 'u-42');
      expect((b[3]['properties'] as Map)['at'], '2026-10-05T00:00:00.000Z');
      expect(b.map((e) => e['session_id']).toSet(), hasLength(1));
      expect(c.queueLength, 0);
    });

    test('ignores a second event with the same event id while it is queued', () async {
      final h = make(Server());
      h.client.track('order_completed', {'order_id': 'o1'}, 'order-o1');
      h.client.track('order_completed', {'order_id': 'o1'}, 'order-o1');
      await h.client.whenReady();
      expect(h.client.queueLength, 1);
    });

    test('starts a new session after 30 minutes of inactivity', () async {
      final s = Server();
      final h = make(s);
      await h.client.whenReady();
      h.client.track('a');
      h.clock.advance(29 * 60000);
      h.client.track('b');
      h.clock.advance(31 * 60000);
      h.client.track('c');
      await h.client.flush();
      final b = s.calls[0].batch;
      expect(b[0]['session_id'], b[1]['session_id']);
      expect(b[2]['session_id'], isNot(b[1]['session_id']));
    });

    test('splits large queues into batches', () async {
      final s = Server();
      final h = make(s, maxBatchSize: 2);
      for (var i = 0; i < 5; i++) {
        h.client.track('e$i');
      }
      await h.client.flush();
      expect(s.calls.map((c) => c.batch.length).toList(), [2, 2, 1]);
    });

    test('reset() forgets the user and starts a new anonymous id', () async {
      final s = Server();
      final h = make(s);
      h.client.identify('u-1');
      h.client.reset();
      h.client.track('app_opened');
      await h.client.flush();
      final b = s.calls[0].batch;
      expect(b.last.containsKey('user_id'), isFalse);
      expect(b.last['anonymous_id'], isNot(b.first['anonymous_id']));
      expect(h.client.userId, isNull);
    });

    test('registers push tokens and aliases', () async {
      final s = Server();
      final h = make(s);
      h.client.registerPushToken('fcm-token-1234567890', 'fcm', 'granted');
      h.client.alias('u-9', 'guest-1');
      await h.client.flush();
      final b = s.calls[0].batch;
      expect(b[0]['type'], 'push_token');
      expect(b[0]['push_token'], {'token': 'fcm-token-1234567890', 'provider': 'fcm', 'permission': 'granted'});
      expect(b[1]['type'], 'alias');
      expect(b[1]['previous_id'], 'guest-1');
      expect(b[1]['user_id'], 'u-9');
    });
  });

  group('delivery', () {
    test('keeps events offline, retries with backoff and survives a restart', () async {
      final store = MemoryStore();
      var online = false;
      final s = Server((c, _) {
        if (!online) throw const SocketException('Network request failed');
        return Server.ok(c.batch.length);
      });
      final first = make(s, store: store);
      first.client.track('app_opened');
      first.client.track('product_viewed');
      final r1 = await first.client.flush();
      expect(r1.status, 'retry');
      expect(r1.retryInMs, 750); // 1s base, jittered to 75% with random 0.5
      expect((await first.client.flush()).retryInMs, 1500);
      expect(first.client.queueLength, 2);
      final anon = first.client.anonymousId;
      await first.client.shutdown();

      online = true;
      final second = make(s, store: store);
      expect(await second.client.flush(), const FlushResult.sent(2, 0, 0));
      final sent = s.calls.last.batch;
      expect(sent.map((e) => e['event_name']).toList(), ['app_opened', 'product_viewed']);
      // Same ids as the failed attempts, so the server de-duplicates if one of them actually landed.
      expect(sent.map((e) => e['event_id']).toList(), s.calls[0].batch.map((e) => e['event_id']).toList());
      expect(s.calls.last.request.headers['Idempotency-Key'], s.calls[0].request.headers['Idempotency-Key']);
      expect(second.client.anonymousId, anon);
    });

    test('derives the Idempotency-Key from every event id in the batch', () {
      // FNV-1a 32-bit over the UTF-8 ids joined by "\n"; same vectors as the JavaScript SDK.
      expect(eventIdsHash(['a']), 'e40c292c');
      expect(eventIdsHash(['a', 'b']), '28e4c710');
      expect(eventIdsHash(['\u00e9\u{1F600}']), '039d63cc');
      expect(idempotencyKey(['id-2', 'id-3']), '2:408dab4a:id-2');
      // Same first id and size but different events (the queue changed before a retry): different key.
      expect(idempotencyKey(['A', 'B']), isNot(idempotencyKey(['A', 'C'])));
      expect(idempotencyKey(['A', 'B']), isNot(idempotencyKey(['B', 'A'])));
    });

    test('resends without the Idempotency-Key when the server says the key was used for other events', () async {
      final s = Server((c, n) => n == 1 ? http.Response('{"error":"idempotency_key_reused"}', 409) : Server.ok(c.batch.length));
      final h = make(s);
      h.client.track('a');
      h.client.track('b');
      expect(await h.client.flush(), const FlushResult.retry(0, 'idempotency key already used for other events; resending without it'));
      expect(h.client.queueLength, 2); // never dropped
      expect(await h.client.flush(), const FlushResult.sent(2, 0, 0));
      expect(s.calls[0].request.headers['Idempotency-Key'], isNotNull);
      expect(s.calls[1].request.headers.containsKey('Idempotency-Key'), isFalse);
      expect(h.client.queueLength, 0);
    });

    test('honours Retry-After on 429', () async {
      final s = Server((_, __) => http.Response('{"error":"rate_limited"}', 429, headers: {'retry-after': '7'}));
      final h = make(s);
      h.client.track('a');
      expect(await h.client.flush(), const FlushResult.retry(7000, 'HTTP 429'));
      expect(h.client.queueLength, 1);
    });

    test('stops sending but keeps events when the key is revoked', () async {
      final s = Server((_, __) => http.Response('{"error":"invalid_api_key"}', 401));
      final h = make(s);
      h.client.track('a');
      expect(await h.client.flush(), const FlushResult.unauthorized());
      expect(await h.client.flush(), const FlushResult.unauthorized());
      expect(s.calls, hasLength(1));
      expect(h.client.queueLength, 1);
    });

    test('halves the batch on 413', () async {
      final s = Server((c, n) => n == 1 ? http.Response('', 413) : Server.ok(c.batch.length));
      final h = make(s, maxBatchSize: 4);
      for (var i = 0; i < 4; i++) {
        h.client.track('e$i');
      }
      expect(await h.client.flush(), const FlushResult.retry(0, 'payload too large; splitting batch'));
      await h.client.flush();
      expect(s.calls.map((c) => c.batch.length).toList(), [4, 2, 2]);
      expect(h.client.queueLength, 0);
    });

    test('drops a batch the server says is malformed instead of retrying forever', () async {
      final h = make(Server((_, __) => http.Response('{"error":"invalid_batch"}', 400)));
      h.client.track('a');
      await h.client.flush();
      expect(h.client.queueLength, 0);
    });

    test('removes events the server rejected individually along with the accepted ones', () async {
      final s = Server((_, __) => http.Response(
            jsonEncode({
              'accepted': 1,
              'duplicates': 0,
              'rejected': [
                {'index': 0, 'errors': []},
              ],
            }),
            200,
          ));
      final h = make(s);
      h.client.track('a');
      h.client.track('b');
      expect(await h.client.flush(), const FlushResult.sent(1, 0, 1));
      expect(h.client.queueLength, 0);
    });

    test('caps the queue and expires old events', () async {
      final s = Server();
      final h = make(s, maxQueueSize: 10, eventTtl: const Duration(seconds: 60));
      for (var i = 0; i < 15; i++) {
        h.client.track('e$i');
      }
      await h.client.whenReady();
      expect(h.client.queueLength, 10);
      h.clock.advance(61000);
      h.client.track('fresh');
      await h.client.flush();
      expect(s.calls[0].batch.map((e) => e['event_name']).toList(), ['fresh']);
    });

    test('does not send while opted out', () async {
      final s = Server();
      final h = make(s, optedOut: true);
      h.client.track('a');
      expect(await h.client.flush(), const FlushResult.paused());
      expect(s.calls, isEmpty);
    });

    test('flushes automatically once flushAt events are queued', () async {
      final s = Server();
      final h = make(s, flushAt: 3, timers: true);
      await h.client.whenReady();
      h.client.track('a');
      h.client.track('b');
      await Future<void>.delayed(const Duration(milliseconds: 20));
      expect(s.calls, isEmpty);
      h.client.track('c');
      await Future<void>.delayed(const Duration(milliseconds: 20));
      expect(s.calls, hasLength(1));
      expect(s.calls[0].batch, hasLength(3));
      await h.client.shutdown();
    });
  });

  group('attribution and lifecycle', () {
    test('parses campaign parameters and click ids', () {
      expect(parseAttribution('myapp://open?utm_source=tiktok&utm_campaign=ramadan%20sale&ttclid=abc&foo=1'),
          {'utm_source': 'tiktok', 'utm_campaign': 'ramadan sale', 'ttclid': 'abc'});
      expect(parseAttribution('https://x.test/?sccid=snap1'), {'ScCid': 'snap1'});
      expect(parseAttribution('https://x.test/home'), isNull);
    });

    test('keeps the first touch and attaches the latest with the deep link', () async {
      final s = Server();
      final h = make(s);
      h.client.captureAttribution('https://leanapp.io/l?utm_source=snapchat&ScCid=s1');
      h.client.captureAttribution('myapp://p?utm_source=tiktok&ttclid=t1');
      h.client.track('app_opened');
      await h.client.flush();
      const latest = {'utm_source': 'tiktok', 'ttclid': 't1', 'deep_link_url': 'myapp://p?utm_source=tiktok&ttclid=t1'};
      expect(h.client.getAttribution()!.first['ScCid'], 's1');
      expect(h.client.getAttribution()!.latest, latest);
      expect((s.calls[0].batch[0]['context'] as Map)['attribution'], latest);
    });

    test('sends the install referrer as context.campaign', () async {
      final s = Server();
      final h = make(s);
      expect(await h.client.installReferrerPending(), isTrue);
      h.client.setInstallReferrer(const InstallReferrer('utm_source=google&click_id=lac_123', referrerClickTimestampSeconds: 1700000000));
      h.client.trackInstallOrUpdate('2.3.0', '230');
      await h.client.flush();
      final e = s.calls[0].batch[0];
      expect(e['event_name'], 'app_installed');
      final ctx = e['context'] as Map;
      expect(ctx['campaign'], {
        'install_referrer': 'utm_source=google&click_id=lac_123',
        'referrer_click_timestamp_seconds': 1700000000,
        'install_begin_timestamp_seconds': 0,
        'google_play_instant': false,
      });
      expect(ctx['attribution'], {'utm_source': 'google', 'click_id': 'lac_123'});
      expect(await h.client.installReferrerPending(), isFalse);
    });

    test('tracks install once, then app_updated on a version change', () async {
      final s = Server();
      final store = MemoryStore();
      final first = make(s, store: store);
      first.client.trackInstallOrUpdate('1.0', '10');
      first.client.trackInstallOrUpdate('1.0', '10');
      await first.client.flush();
      expect(s.calls[0].batch.map((e) => e['event_name']).toList(), ['app_installed']);
      await first.client.shutdown();
      final second = make(s, store: store);
      second.client.trackInstallOrUpdate('1.1', '11');
      await second.client.flush();
      final e = s.calls[1].batch.single;
      expect(e['event_name'], 'app_updated');
      expect(e['properties'], {'version': '1.1', 'build': '11', 'previous_version': '1.0', 'previous_build': '10'});
    });
  });

  group('singleton', () {
    TestWidgetsFlutterBinding.ensureInitialized();

    tearDown(Analytics.resetForTesting);

    test('is safe to call before initialize and initializes once', () async {
      expect(() => Analytics.track('ignored'), returnsNormally);
      final a = await Analytics.initialize(apiKey: key, store: MemoryStore(), trackLifecycleEvents: false, flushAt: 1000);
      expect(await Analytics.initialize(apiKey: key), same(a));
      Analytics.track('app_opened');
      await a.whenReady();
      expect(a.queueLength, 1);
    });

    test('collects context from the Flutter engine', () {
      final ctx = flutterContext();
      expect(ctx['locale'], isA<String>());
      expect(ctx['os_version'], isA<String>());
    });
  });
}
