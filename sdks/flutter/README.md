# LeanApp Flutter SDK (Dart)

Events, identity, sessions, attribution and an offline queue for Flutter apps on Android and iOS. Dart port of the JavaScript SDK: same wire format, same rules ([docs/sdk.md](../../docs/sdk.md)). Depends on `http` and `shared_preferences` only.

## Install

Not yet published on pub.dev (needs the owner's verified publisher). Until then:

```yaml
dependencies:
  leanapp_analytics:
    path: ../leanapp/sdks/flutter   # or a git dependency with path: sdks/flutter
```

## Quickstart

```dart
import 'package:leanapp_analytics/leanapp_analytics.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await Analytics.initialize(
    apiKey: 'la_pk_live_…',          // Developers → SDK & API keys
    appVersion: '2.4.0', appBuild: '240',
    context: {'timezone': 'Asia/Riyadh'}, // optional: device_info_plus / flutter_timezone values
  );
  runApp(const MyApp());
}

Analytics.screen('Home');
Analytics.track('product_viewed', {'product_id': '123', 'price': 299, 'currency': 'SAR'});
Analytics.identify('user_123', {'city': 'Riyadh', 'plan': 'plus'});
Analytics.track('order_completed', {'order_id': 'o1', 'revenue': 45, 'currency': 'SAR'}, 'order-o1');
Analytics.registerPushToken(fcmToken, 'fcm', 'granted');
Analytics.captureAttribution(deepLink.toString()); // from app_links
Analytics.reset(); // on logout
```

Android install referrer: read it with a plugin such as `play_install_referrer` and pass it once:

```dart
if (await Analytics.installReferrerPending()) {
  final d = await PlayInstallReferrer.installReferrer;
  Analytics.setInstallReferrer(InstallReferrer(d.installReferrer ?? '',
      referrerClickTimestampSeconds: d.referrerClickTimestampSeconds ?? 0,
      installBeginTimestampSeconds: d.installBeginTimestampSeconds ?? 0));
}
```

## What it does automatically

- **Queue** in SharedPreferences, batches of up to 100 every 10 s or at 20 events, flushed when the app is paused (`WidgetsBindingObserver`).
- **Retries** with exponential backoff and jitter (1 s → 5 min), `Retry-After` on 429, batch halving on 413, drop on 400/422, pause on 401/403, `Idempotency-Key` per batch derived from every event id (resent without it on `409`).
- **Sessions**: new `session_id` after 30 minutes of inactivity.
- **Context**: `platform: flutter`, `os`, `os_version`, `locale`, `language`, `screen`, `sdk {name: leanapp-flutter}`, plus your `context`. Device model and IANA timezone need plugins, so pass them in `context`.
- **Lifecycle**: `app_installed`, `app_updated` (from `appVersion`/`appBuild`), `app_opened` (`from_background`).

## Experiments

This SDK has no `getVariant` yet. Ask `GET /v1/experiments/assignments?user_id=…&anonymous_id=…` with the public key (the JavaScript SDK's `getVariant` does the same), then, when you show the variant, send the exposure once:

```dart
Analytics.track('experiment_exposure', {'experiment': 'checkout_button', 'experiment_id': experimentId, 'variant': variant});
```

See [docs/experiments.md](../../docs/experiments.md).

## Develop

```bash
cd sdks/flutter
flutter pub get && flutter analyze && flutter test
```
