/// LeanApp analytics for Flutter: one SDK for attribution, product analytics and automation events.
///
/// ```dart
/// await Analytics.initialize(apiKey: 'la_pk_live_…', appVersion: '2.4.0');
/// Analytics.track('order_completed', {'order_id': 'o1', 'revenue': 45, 'currency': 'SAR'});
/// ```
library leanapp_analytics;

import 'dart:async';
import 'dart:io' show Platform;

import 'package:flutter/widgets.dart';

import 'src/attribution.dart';
import 'src/client.dart';
import 'src/device_context.dart';
import 'src/storage.dart';

export 'src/attribution.dart'
    show InstallReferrer, attributionParams, campaignIdParams, clickIdParams, hasSourceParams, parseAttribution, utmParams;
export 'src/client.dart'
    show ConsentStatus, DeferredDeepLink, FlushResult, LeanAppClient, LeanAppOptions, consentPurposes, defaultEndpoint, eventIdsHash, idempotencyKey, sdkName, sdkVersion, storagePrefix;
export 'src/device_context.dart' show flutterContext;
export 'src/storage.dart' show KeyValueStore, MemoryStore, SharedPreferencesStore;

/// Flushes the queue when the app goes to the background and tracks app_opened when it returns.
class LeanAppLifecycleObserver with WidgetsBindingObserver {
  LeanAppLifecycleObserver(this._client, {required this.trackOpens});

  final LeanAppClient _client;
  final bool trackOpens;
  bool _inBackground = false;

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    switch (state) {
      case AppLifecycleState.paused:
      case AppLifecycleState.hidden:
      case AppLifecycleState.detached:
        if (!_inBackground) {
          _inBackground = true;
          _client.flush();
        }
      case AppLifecycleState.resumed:
        if (_inBackground) {
          _inBackground = false;
          if (trackOpens) _client.track('app_opened', {'from_background': true});
        }
      case AppLifecycleState.inactive:
        break;
    }
  }
}

/// Process-wide singleton. Calls before [initialize] are ignored with one warning.
class Analytics {
  Analytics._();

  static LeanAppClient? _instance;
  static bool _warned = false;
  static LeanAppLifecycleObserver? _observer;

  /// Android: completes when the app passed the install referrer (or null), so the deferred deep link request carries it.
  static Completer<void>? _referrerSet;

  static LeanAppClient? _client() {
    if (_instance == null && !_warned) {
      _warned = true;
      debugPrint('[LeanApp] Analytics.initialize() has not been called; events are ignored.');
    }
    return _instance;
  }

  /// Starts the SDK. Call after `WidgetsFlutterBinding.ensureInitialized()`. Throws only for an invalid or secret key.
  static Future<LeanAppClient> initialize({
    required String apiKey,
    String endpoint = defaultEndpoint,
    String? appVersion,
    String? appBuild,
    int flushAt = 20,
    Duration flushInterval = const Duration(seconds: 10),
    int maxBatchSize = 100,
    int maxQueueSize = 1000,
    Duration eventTtl = const Duration(days: 7),
    Duration sessionTimeout = const Duration(minutes: 30),
    Map<String, Object?> context = const {},
    bool optedOut = false,
    bool debug = false,
    bool trackLifecycleEvents = true,
    KeyValueStore? store,
    ConsentStatus consentDefault = ConsentStatus.granted,
    Map<String, ConsentStatus> consentDefaults = const {},
    bool deferredDeepLinks = true,
    void Function(DeferredDeepLink result)? onDeferredDeepLink,
  }) async {
    final existing = _instance;
    if (existing != null) return existing;
    final client = LeanAppClient(
      LeanAppOptions(
        apiKey: apiKey,
        endpoint: endpoint,
        appVersion: appVersion,
        appBuild: appBuild,
        flushAt: flushAt,
        flushInterval: flushInterval,
        maxBatchSize: maxBatchSize,
        maxQueueSize: maxQueueSize,
        eventTtl: eventTtl,
        sessionTimeout: sessionTimeout,
        context: context,
        optedOut: optedOut,
        debug: debug,
        consentDefault: consentDefault,
        consentDefaults: consentDefaults,
        deferredDeepLinks: deferredDeepLinks,
      ),
      store: store ?? SharedPreferencesStore(),
      contextProvider: flutterContext,
    );
    _instance = client;
    if (trackLifecycleEvents) {
      client.trackInstallOrUpdate(appVersion, appBuild);
      client.track('app_opened', {'from_background': false});
    }
    final observer = LeanAppLifecycleObserver(client, trackOpens: trackLifecycleEvents);
    _observer = observer;
    WidgetsBinding.instance.addObserver(observer);
    await client.whenReady();
    if (deferredDeepLinks) unawaited(_askDeferred(client, onDeferredDeepLink));
    return client;
  }

  /// Once per new install (the client keeps track). On Android it waits up to 10 s for setInstallReferrer so the
  /// request can carry LeanApp's click id from the Play referrer.
  static Future<void> _askDeferred(LeanAppClient client, void Function(DeferredDeepLink result)? callback) async {
    String? os;
    String? osVersion;
    try {
      if (Platform.isAndroid || Platform.isIOS) {
        os = Platform.isAndroid ? 'android' : 'ios';
        osVersion = Platform.operatingSystemVersion;
      }
    } catch (_) {
      // dart:io is not available (web)
    }
    if (os == 'android' && await client.installReferrerPending()) {
      final waiting = _referrerSet = Completer<void>();
      await waiting.future.timeout(const Duration(seconds: 10), onTimeout: () {});
    }
    final result = await client.requestDeferredDeepLink(os: os, osVersion: osVersion);
    if (result != null && callback != null) callback(result);
  }

  static void track(String eventName, [Map<String, Object?> properties = const {}, String? eventId, DateTime? timestamp]) =>
      _client()?.track(eventName, properties, eventId, timestamp);

  static void screen(String screenName, [Map<String, Object?> properties = const {}]) => _client()?.screen(screenName, properties);

  static void identify(String? userId, [Map<String, Object?> traits = const {}]) => _client()?.identify(userId, traits);

  static void setUserProperties(Map<String, Object?> traits) => _client()?.setUserProperties(traits);

  static void alias(String newUserId, [String? previousId]) => _client()?.alias(newUserId, previousId);

  /// provider: 'fcm' (Firebase Messaging token) or 'apns'.
  static void registerPushToken(String token, String provider, [String permission = 'unknown']) =>
      _client()?.registerPushToken(token, provider, permission);

  /// Pass deep links from app_links / uni_links (initial link and stream).
  static Map<String, String>? captureAttribution(String url) => _client()?.captureAttribution(url);

  static ({Map<String, String> first, Map<String, String> latest})? getAttribution() => _client()?.getAttribution();

  /// Android: the Play Install Referrer from a plugin such as play_install_referrer, once per install.
  static void setInstallReferrer(InstallReferrer? referrer) {
    _client()?.setInstallReferrer(referrer);
    final waiting = _referrerSet;
    if (waiting != null && !waiting.isCompleted) waiting.complete();
  }

  /// Records the user's consent answers from your consent screen, e.g. {'analytics': true, 'attribution': false}.
  /// Purposes: analytics, marketing, push, attribution. Purposes left out keep their state.
  static void setConsent(Map<String, bool> consent) => _client()?.setConsent(consent);

  /// Current consent per purpose, or null before initialize.
  static Map<String, ConsentStatus>? getConsent() => _client()?.getConsent();

  static Future<bool> installReferrerPending() async => await _client()?.installReferrerPending() ?? false;

  static String? get anonymousId => _client()?.anonymousId;

  static String? get userId => _client()?.userId;

  static void reset() => _client()?.reset();

  static void optOut() => _client()?.optOut();

  static void optIn() => _client()?.optIn();

  static Future<FlushResult> flush() => _client()?.flush() ?? Future.value(const FlushResult.empty());

  /// For tests: drops the singleton.
  @visibleForTesting
  static Future<void> resetForTesting() async {
    final observer = _observer;
    if (observer != null) WidgetsBinding.instance.removeObserver(observer);
    _observer = null;
    await _instance?.shutdown();
    _instance = null;
    _warned = false;
  }
}
