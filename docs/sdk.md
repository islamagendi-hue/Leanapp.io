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

## In-app messages

Automations can queue in-app messages for a user (see [automation](automation.md)). The SDKs don't show them yet, so apps can use these two endpoints directly with the **public** key until SDK support lands. `sdks/javascript` doesn't call them yet.

**Fetch pending messages:** `GET /v1/in-app?user_id=…&anonymous_id=…`, with `Authorization: Bearer la_pk_…`.

- Pass the current `user_id`, the `anonymous_id`, or both.
- The response holds at most 10 messages, newest first, that haven't been clicked, dismissed or expired:

```json
{ "messages": [ { "id": "uuid", "title": "…", "body": "…", "button_text": "Open", "deep_link": "myapp://cart",
  "data": {}, "created_at": "…", "expires_at": "…" } ] }
```

**Report what happened:** `POST /v1/in-app/{id}/events` with `{ "action": "impression" | "click" | "dismiss", "user_id"?: "…", "anonymous_id"?: "…" }`.

- The response is `{ "status": "displayed" | "clicked" | "dismissed" }`.
- `click` and `dismiss` are final: the message stops being returned.
- An impression keeps the message pending, so the app can show it again until the user acts. Apps should de-duplicate by `id`.

Behaviour of both endpoints:

- They work only within the key's environment.
- A message that belongs to another user or environment returns `404`.
- CORS is open, no cookies are used, and responses aren't cached.
- They share a per-environment rate limit (`429` with `Retry-After`).
- A suggested polling interval is when the app opens or comes to the foreground, and at most once a minute.

**Security caveat:** a public key ships inside the app, so it can't prove who the end user is. Anyone with the key and a user's id can read that user's pending in-app messages. Don't put secrets or sensitive personal data in in-app messages.

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
