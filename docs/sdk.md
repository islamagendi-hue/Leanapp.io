# SDKs

| SDK | Package | Status |
| --- | --- | --- |
| JavaScript / TypeScript / React Native | `@leanapp/analytics` (`sdks/javascript`) | **Built**, 21 unit tests, verified against a live server. Not yet published to npm. |
| Android (Kotlin) | `io.leanapp:leanapp-android` (`sdks/android`) | **Built**, 29 JVM unit tests against a local HTTP server. Android module built in CI. Not yet on Maven Central. |
| iOS (Swift) | `LeanApp` Swift package (`sdks/ios`) | **Built**, 24 XCTest tests (URLProtocol stubs), run on macOS in CI. Not yet tagged as a public Swift package or on CocoaPods. |
| Flutter (Dart) | `leanapp_analytics` (`sdks/flutter`) | **Built**, 25 tests with a mock HTTP client, `flutter analyze` clean. Not yet on pub.dev. |
| Server | REST API with a secret key ([API](api.md)) | **Built** |

The native SDKs are built but not yet published to a package registry, so apps add them from this repository (see each SDK's README). Publishing needs the owner's Sonatype/Maven Central account and signing key, a public Git tag for Swift Package Manager (and optionally a CocoaPods trunk account), and a pub.dev verified publisher.

## Design principles

1. **Never crash or block the app.** Calls are synchronous, return nothing and never throw after initialization; work happens off the call path.
2. **Never lose events silently.** Persistent queue, retries with backoff, explicit drop rules (queue cap, TTL, malformed batch) that log in debug mode.
3. **Never double count.** Every event gets an `event_id` at call time; retries reuse it and the server de-duplicates. Pass your own id (`order_id`) for revenue events.
4. **No secrets.** Apps get public keys only; the SDK refuses a secret key outside `platform: "backend"`.
5. **Small and dependency-free.**

## JavaScript / React Native

```ts
import { Analytics, asyncStorageAdapter } from "@leanapp/analytics";
import AsyncStorage from "@react-native-async-storage/async-storage";

Analytics.initialize({
  apiKey: "la_pk_live_…",          // from Developers → SDK & API keys
  appVersion: "2.4.0",
  storage: asyncStorageAdapter(AsyncStorage), // browsers default to localStorage
});

Analytics.captureAttribution(initialDeepLinkUrl); // utm_* and click ids (gclid, fbclid, ttclid, ScCid, …)
Analytics.screen("Home");
Analytics.track("product_viewed", { product_id: "123", price: 299, currency: "SAR" });
Analytics.identify("user_123", { city: "Riyadh", plan: "plus" });
Analytics.registerPushToken(fcmToken, "fcm", "granted");
Analytics.reset(); // on logout
```

| Method | Wire `type` | Notes |
| --- | --- | --- |
| `track(name, props?, { eventId?, timestamp? })` | `track` | |
| `screen(name, props?)` | `screen` | Stored as `screen_viewed` with `screen_name` |
| `identify(userId?, traits?)` | `identify` | Links the anonymous id to the user; following events carry `user_id` |
| `setUserProperties(traits)` | `identify` | Without changing the user id |
| `alias(newId, previousId?)` | `alias` | Merge a guest id into a real user |
| `registerPushToken(token, "fcm" \| "apns", permission?)` | `push_token` | |
| `captureAttribution(url)` / `getAttribution()` | | First touch kept, latest touch attached to every event as `context.attribution` |
| `flush()`, `optOut()`, `optIn()`, `reset()`, `getAnonymousId()`, `getUserId()` | | |

### Behaviour

| Concern | Behaviour | Default |
| --- | --- | --- |
| Batching | Send when `flushAt` events are queued or every `flushIntervalMs` | 20 events / 10s, ≤100 per request |
| Queue | Persisted after every change; namespaced per key so dev and production never mix | max 1,000, oldest dropped |
| TTL | Older queued events are dropped before sending | 7 days (server rejects > 31 days) |
| Retry | Network errors and 5xx: exponential backoff with jitter (1s → 5min); `429` honours `Retry-After` | |
| Idempotency | `Idempotency-Key` derived from the batch's events, same on every retry | |
| 413 | Halves batch size and retries | |
| 400 | Drops the batch (cannot succeed) | |
| 401/403 | Stops sending, keeps events (revoked key or wrong environment) | |
| Sessions | New `session_id` after inactivity | 30 min |
| Context | `platform`, `sdk`, `app_version`, `locale`, `language`, `timezone`, screen size, attribution; extra via `context` option | |
| Early calls | Calls made before storage loads are buffered in order | |

## Native SDKs: Android, iOS, Flutter

Each is a port of `sdks/javascript/src/client.ts`: same method names, wire format (`POST /v1/events/batch`, the schema in `apps/platform/src/modules/ingestion/schema.ts`), defaults and delivery rules from the table above (batching, persistent queue with cap and TTL, backoff with jitter, `Retry-After`, `413` halving, `400/422` drop, `401/403` pause, `Idempotency-Key` = first event id + batch size, 30-minute sessions). Storage uses the same namespace as the JavaScript SDK (`leanapp:la_pk_live:`). Native additions:

| | Android (`sdks/android`) | iOS (`sdks/ios`) | Flutter (`sdks/flutter`) |
| --- | --- | --- | --- |
| Queue storage | Files in `filesDir/leanapp`, atomic writes | Files in Application Support, atomic writes | SharedPreferences |
| Threading | One background thread, calls applied in order | One serial dispatch queue | Dart event loop |
| Background flush | Last activity stopped | `didEnterBackground` with a background task | `AppLifecycleState.paused/hidden` |
| Lifecycle events | `app_installed`, `app_updated`, `app_opened` | same | same (`appVersion`/`appBuild` from options) |
| Deep links | Launch Intent data captured automatically; `captureAttribution(url)` for `onNewIntent` | `Analytics.captureAttribution(url)` from scene / app delegate | `captureAttribution(url)` from app_links |
| Install referrer | Play Install Referrer library, once per install | n/a | `setInstallReferrer(...)` with a plugin |
| Context | `os_version`, `device.model/manufacturer/type`, `screen`, `locale`, `language`, `timezone`, app version/build | same (`device.model` like `iPhone15,2`) | `os`, `os_version`, `locale`, `language`, `screen`; model/timezone via `context` |
| Push | `registerPushToken(token, "fcm", permission)` | `registerPushToken(deviceToken:)` (APNs hex) | `registerPushToken(token, 'fcm' \| 'apns')` |

No SDK collects advertising ids, Android ID or IDFV.

**Deep link attribution.** Native `captureAttribution(url)` stores the parsed utm_* / click ids plus `deep_link_url` (the opening URL, ≤1,000 characters) as the latest touch, so re-engagement clicks can be matched. The JavaScript SDK does not add `deep_link_url` yet.

**Install referrer (Android).** Sent on every event as:

```json
"context": {
  "campaign": {
    "install_referrer": "utm_source=google-play&utm_medium=cpc&click_id=lac_…",
    "referrer_click_timestamp_seconds": 1791194300,
    "install_begin_timestamp_seconds": 1791194350,
    "google_play_instant": false
  }
}
```

utm_* and click ids found in the referrer also become the first touch in `context.attribution` when nothing was captured before. `app_installed` waits up to 10 seconds for the referrer so it carries `context.campaign`; a temporary Play error is retried on the next launch.

Not built yet: SKAdNetwork / AdAttributionKit conversion values on iOS, automatic screen tracking, Flutter install referrer without a plugin.

```kotlin
Analytics.initialize(context, "la_pk_live_…")
Analytics.track("order_completed", mapOf("order_id" to "o1", "revenue" to 45.0, "currency" to "SAR"))
```

```swift
Analytics.initialize(apiKey: "la_pk_live_…")
Analytics.track("order_completed", properties: ["order_id": "o1", "revenue": 45.0, "currency": "SAR"])
```

```dart
await Analytics.initialize(apiKey: 'la_pk_live_…');
Analytics.track('order_completed', {'order_id': 'o1', 'revenue': 45.0, 'currency': 'SAR'});
```

## Revenue events belong on the server

Payments, refunds, renewals and anything confirmed by a payment provider should be sent from your backend with a secret key and the transaction id as `event_id`. The tracking plan marks these events with source `backend`, and the Implementation Score has a backend component.
