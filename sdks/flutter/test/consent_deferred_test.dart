import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:leanapp_analytics/leanapp_analytics.dart';

const key = 'la_pk_dev_abcdefghijklmnopqrstuvwx';
const match = {
  'match_type': 'deterministic',
  'match_key': 'install_referrer',
  'link': {'code': 'abcd1234', 'name': 'Ramadan'},
  'deep_link': {'path': '/product/42', 'params': {'ref': 'ad'}, 'url': '/product/42?ref=ad'},
  'campaign': {'source': 'google', 'medium': 'cpc', 'campaign': 'ramadan'},
  'click_id': 'lac_abcdefgh12',
  'is_deferred': true,
};

/// Answers /v1/events/batch and /v1/deep-links/deferred; records both.
class Backend {
  final List<Map<String, dynamic>> events = [];
  final List<Map<String, dynamic>> deferredBodies = [];
  final List<int> deferredStatuses = [];

  late final MockClient client = MockClient((req) async {
    final body = jsonDecode(req.body) as Map<String, dynamic>;
    if (req.url.path.endsWith('/v1/deep-links/deferred')) {
      deferredBodies.add(body);
      final status = deferredStatuses.isEmpty ? 200 : deferredStatuses.removeAt(0);
      return http.Response(status == 200 ? jsonEncode(match) : '{}', status);
    }
    final batch = (body['batch'] as List).cast<Map<String, dynamic>>();
    events.addAll(batch);
    return http.Response(jsonEncode({'accepted': batch.length, 'duplicates': 0, 'rejected': []}), 200);
  });

  List<Object?> names() => events.map((e) => e['type'] == 'track' ? e['event_name'] : e['type']).toList();
}

LeanAppClient make(
  Backend b, {
  KeyValueStore? store,
  ConsentStatus consentDefault = ConsentStatus.granted,
  Map<String, ConsentStatus> consentDefaults = const {},
  bool deferred = true,
}) {
  var id = 0;
  return LeanAppClient(
    LeanAppOptions(
      apiKey: key,
      endpoint: 'https://api.example.test',
      platform: 'flutter',
      flushAt: 1000,
      consentDefault: consentDefault,
      consentDefaults: consentDefaults,
      deferredDeepLinks: deferred,
    ),
    store: store ?? MemoryStore(),
    httpClient: b.client,
    contextProvider: () => {'locale': 'ar-SA'},
    now: () => DateTime.parse('2026-10-05T10:00:00Z').millisecondsSinceEpoch,
    uuid: () => 'id-${++id}',
    random: () => 0.5,
    timersEnabled: false,
  );
}

Map<String, dynamic> ctx(Map<String, dynamic> e) => e['context'] as Map<String, dynamic>;

void main() {
  group('consent', () {
    test('defaults to granted, so apps that never ask behave as before', () async {
      final b = Backend();
      final c = make(b);
      expect(c.getConsent()['analytics'], ConsentStatus.granted);
      c.track('a');
      await c.flush();
      expect(b.names(), ['a']);
    });

    test('pending holds events in memory, then sends them once analytics is granted', () async {
      final b = Backend();
      final store = MemoryStore();
      final c = make(b, store: store, consentDefault: ConsentStatus.pending);
      c.track('a');
      await c.whenReady();
      expect(c.queueLength, 0);
      await c.shutdown();
      expect((await store.get('leanapp:la_pk_dev:queue')) ?? '', isNot(contains('"a"')));
      c.setConsent({'analytics': true});
      await c.flush();
      expect(b.names(), ['consent', 'a']);
      expect(b.events[0]['consent'], {'analytics': true});
      c.track('b');
      await c.flush();
      expect(ctx(b.events.last)['consent'], {'analytics': true});
      expect(c.getConsent()['marketing'], ConsentStatus.pending);
    });

    test('denied discards held events but still sends the consent change', () async {
      final b = Backend();
      final c = make(b, consentDefaults: {'analytics': ConsentStatus.pending});
      c.track('held');
      c.registerPushToken('t' * 20, 'fcm');
      c.setConsent({'analytics': false});
      c.track('after');
      await c.flush();
      expect(b.names(), ['push_token', 'consent']);
    });

    test('attribution is a separate purpose; the install referrer is sent only with it', () async {
      final b = Backend();
      final c = make(b, consentDefaults: {'attribution': ConsentStatus.pending});
      c.setInstallReferrer(const InstallReferrer('utm_source=google&gclid=g1'));
      c.captureAttribution('myapp://p?utm_source=tiktok');
      c.track('a');
      await c.flush();
      expect(ctx(b.events.single).containsKey('attribution'), isFalse);
      expect(ctx(b.events.single).containsKey('campaign'), isFalse);
      c.setConsent({'attribution': true});
      c.track('b');
      await c.flush();
      expect((ctx(b.events.last)['attribution'] as Map)['utm_source'], 'tiktok');
      expect(c.getAttribution()!.first['utm_source'], 'google');
    });

    test("records the device's consent for a user who signs in and after reset", () async {
      final b = Backend();
      final c = make(b);
      c.setConsent({'marketing': false});
      c.identify('u-1');
      c.identify('u-1');
      c.reset();
      await c.flush();
      final consents = b.events.where((e) => e['type'] == 'consent').toList();
      expect(consents, hasLength(3));
      expect(consents[1]['user_id'], 'u-1');
      expect(consents[2].containsKey('user_id'), isFalse);
    });
  });

  group('deferred deep links', () {
    test('asks once per new install, with the install referrer', () async {
      final b = Backend();
      final store = MemoryStore();
      final c = make(b, store: store);
      c.setInstallReferrer(const InstallReferrer('utm_source=google&click_id=lac_abcdefgh12'));
      final r = await c.requestDeferredDeepLink(os: 'android', osVersion: '14');
      expect(r!.matchType, 'deterministic');
      expect(r.deepLinkPath, '/product/42');
      expect(r.deepLinkParams, {'ref': 'ad'});
      expect(r.clickId, 'lac_abcdefgh12');
      expect(b.deferredBodies.single, {
        'anonymous_id': c.anonymousId,
        'platform': 'flutter',
        'os': 'android',
        'os_version': '14',
        'install_referrer': 'utm_source=google&click_id=lac_abcdefgh12',
        'click_id': 'lac_abcdefgh12',
      });
      expect(await c.requestDeferredDeepLink(), isNull);
      await c.shutdown();
      expect(await make(b, store: store).requestDeferredDeepLink(), isNull);
      expect(b.deferredBodies, hasLength(1));
    });

    test('never asks for installs from before deferred deep links', () async {
      final b = Backend();
      final store = MemoryStore();
      await store.set('leanapp:la_pk_dev:state', '{"anonymousId":"existing"}');
      expect(await make(b, store: store).requestDeferredDeepLink(), isNull);
      expect(b.deferredBodies, isEmpty);
    });

    test('waits for attribution consent and asks again on the next launch after a failure', () async {
      final b = Backend()..deferredStatuses.add(503);
      final store = MemoryStore();
      final c = make(b, store: store, consentDefaults: {'attribution': ConsentStatus.pending});
      final pending = c.requestDeferredDeepLink(os: 'ios');
      await c.whenReady();
      expect(b.deferredBodies, isEmpty);
      c.setConsent({'attribution': true});
      expect(await pending, isNull);
      expect(b.deferredBodies, hasLength(1));
      await c.shutdown();
      expect((await make(b, store: store).requestDeferredDeepLink(os: 'ios'))!.matched, isTrue);
      expect(b.deferredBodies, hasLength(2));
    });

    test('answers null when attribution is denied or the feature is off', () async {
      final b = Backend();
      expect(await make(b, consentDefaults: {'attribution': ConsentStatus.denied}).requestDeferredDeepLink(), isNull);
      expect(await make(b, deferred: false).requestDeferredDeepLink(), isNull);
      expect(b.deferredBodies, isEmpty);
    });
  });

  test('reads campaign ids only next to a source', () {
    expect(parseAttribution('myapp://p?utm_source=meta&utm_id=120&campaign_id=c1'), {'utm_source': 'meta', 'utm_id': '120', 'campaign_id': 'c1'});
    expect(parseAttribution('myapp://listing?ad_id=99'), isNull);
  });
}
