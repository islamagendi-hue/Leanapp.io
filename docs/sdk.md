# SDKs

| SDK | Package | Status |
| --- | --- | --- |
| JavaScript / TypeScript / React Native | `@leanapp/analytics` (`sdks/javascript`) | **Built**, 21 unit tests, verified against a live server. Not yet published to npm. |
| Android (Kotlin) | `io.leanapp:analytics` | Planned. API below is the contract. |
| iOS (Swift) | `LeanApp` (SPM) | Planned |
| Flutter (Dart) | `leanapp_analytics` | Planned |
| Server | REST API with a secret key ([API](api.md)) | **Built** |

Until the native SDKs ship, native apps can send events with the REST API from the app (public key) or from their backend (secret key). The dashboard labels native snippets as "target API".

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

## Attribution context

What every SDK must send so the [attribution engine](attribution.md) can match installs deterministically. All of it goes in the event's `context`; the server accepts it today (`context.attribution` is a string map, `context.campaign` a map of strings, numbers and booleans, keys ≤ 60 characters, values ≤ 1,000).

| Field | Where | When | Used for |
| --- | --- | --- | --- |
| `app_installed` event | event name | first launch after install, once per install (`anonymous_id`) | the install itself; no `app_installed`, no install attribution |
| `context.device.id` | context | always, when the platform allows a stable install-independent id | reinstall detection |
| `context.campaign.install_referrer` | Android | on `app_installed` (hold it until the Play Install Referrer API answers, ~10 s max) | LeanApp links put `click_id=lac_…&utm_source=…&utm_campaign=…&deep_link=…` in the Play referrer: exact match |
| `context.campaign.referrer_click_timestamp_seconds`, `install_begin_timestamp_seconds`, `google_play_instant` | Android | with the referrer | lookback check on the store click |
| `context.attribution.deep_link_url` | all | on the app open caused by a deep / universal link, and on `app_installed` when a deferred deep link is known | `click_id` and `utm_*` in the URL |
| `context.attribution.click_id` | all | when the app was opened from a URL with `click_id` | exact match (install) and re-engagement (later opens) |
| `context.attribution.gclid` / `gbraid` / `wbraid` / `fbclid` / `ttclid` / `ScCid` / `twclid` / `msclkid` | all | when present in the opening URL or referrer | ad-network deterministic match and network postbacks |
| `context.attribution.utm_source` … `utm_content` | all | when present | campaign labels |
| `context.platform` + `context.os_version` | all | always | probabilistic matching (Android only, opt-in) needs `android` and the OS version |

The JS SDK's `captureAttribution(url)` already fills `utm_*`, the ad-network click ids and `click_id`. It does not yet set `deep_link_url` or read the Play referrer (React Native needs a native module for that). The native SDKs (Android, iOS, Flutter) send `context.campaign` from the Play Install Referrer API as listed above.

The server adds an IP hash (`context._server.ip_hash`) to `app_installed` events sent with a public SDK key; anything a client sends under `_server` is dropped.

## Native SDK contract (planned)

Same method names and semantics. Additionally: automatic `app_installed` / `app_opened` / `app_updated`, install referrer (Android), SKAdNetwork / AdAttributionKit conversion values (iOS), background flush on app pause, and storage in SQLite/Room/Core Data.

```kotlin
Analytics.initialize(context, apiKey = "la_pk_live_…")
Analytics.track("order_completed", mapOf("order_id" to "o1", "revenue" to 45.0, "currency" to "SAR"))
```

```swift
Analytics.initialize(apiKey: "la_pk_live_…")
Analytics.track("order_completed", properties: ["order_id": "o1", "revenue": 45.0, "currency": "SAR"])
```

## Revenue events belong on the server

Payments, refunds, renewals and anything confirmed by a payment provider should be sent from your backend with a secret key and the transaction id as `event_id`. The tracking plan marks these events with source `backend`, and the Implementation Score has a backend component.
