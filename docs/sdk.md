# SDKs

| SDK | Package | Status |
| --- | --- | --- |
| JavaScript / TypeScript / React Native | `@leanapp/analytics` (`sdks/javascript`) | **Built**, 63 unit tests (20 of them for web auto-capture, Meta browser ids and deferred deep links), verified against a live server before the attribution work (consent API verified by unit and server integration tests; auto-capture and the deferred call only by unit tests with a mocked `fetch`). Not yet published to npm. |
| Android (Kotlin) | `io.leanapp:leanapp-android` (`sdks/android`) | **Built**, 45 JVM unit tests (`leanapp-core`) against a local HTTP server, 14 of them for consent and the deferred deep link. The Android module (`leanapp-android`) is built in CI; its consent / deferred wiring has not been compiled yet. Not yet on Maven Central. |
| iOS (Swift) | `LeanApp` Swift package (`sdks/ios`) | **Built**, 37 XCTest tests (URLProtocol stubs), run on macOS in CI. The 11 consent / deferred tests, the AdServices token and the conversion value helper were written without a Swift toolchain and have not been compiled or run yet. Not yet tagged as a public Swift package or on CocoaPods. |
| Flutter (Dart) | `leanapp_analytics` (`sdks/flutter`) | **Built**, 37 tests with a mock HTTP client. The 10 consent / deferred tests were written without a Dart toolchain and have not been run or analyzed yet. Not yet on pub.dev. |
| Server | REST API with a secret key ([API](api.md)) | **Built** |

What each SDK does **not** do yet (the dashboard's SDK & API keys page shows a list from `apps/platform/src/modules/implementation/sdks.ts`; it still lists consent per purpose, SKAdNetwork and the deferred call as missing and needs the same update):

| SDK | Not built yet |
| --- | --- |
| JavaScript / React Native | Play install referrer on React Native (needs a native module), `deep_link_url` on opens, in-app message display, resolve deep link calls |
| Android | in-app message display, resolve deep link calls, `getVariant` for experiments |
| iOS | in-app message display, resolve deep link calls, `getVariant` for experiments |
| Flutter | install referrer without a plugin, in-app message display, resolve deep link calls, `getVariant` for experiments |

The dashboard's snippets (SDK & API keys, and the per-event snippets on the tracking plan) use only calls that exist in these SDKs; `sdks.test.ts` checks every call against the SDK sources, so a renamed method fails the unit tests.

The SDKs are built but not yet published to a package registry, so apps add them from this repository (see each SDK's README). Publishing needs the owner's Sonatype/Maven Central account and signing key, a public Git tag for Swift Package Manager (and optionally a CocoaPods trunk account), and a pub.dev verified publisher.

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
import { AppState } from "react-native";

Analytics.initialize({
  apiKey: "la_pk_live_…",          // from Developers → SDK & API keys
  appVersion: "2.4.0",
  storage: asyncStorageAdapter(AsyncStorage), // browsers default to localStorage
  appState: AppState,              // React Native: send the queue when the app goes to the background
});

Analytics.captureAttribution(initialDeepLinkUrl); // React Native: utm_* and click ids (gclid, fbclid, ttclid, ScCid, …). Browsers capture the landing page by themselves
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
| `captureAttribution(url, { referrer? })` / `getAttribution()` | browsers: `track` (`landing_viewed`) | First touch kept, latest touch replaced. React Native: latest touch on every event. Browsers: see [Web attribution](#web-attribution) |
| `getDeferredDeepLink()` | | React Native: the deferred deep link answer for this install, or `null`; see [Deferred deep links](#deferred-deep-links) |
| `setConsent({ analytics?, marketing?, push?, attribution? })` | `consent` | The user's answers; see [Consent](#consent) |
| `getConsent()` | | `{ analytics, marketing, push, attribution }`, each `"granted" \| "pending" \| "denied"` |
| `getVariant(experimentKey, { expose? })` | `track` (`experiment_exposure`, once) | Variant key of a running experiment or `null`; see [Experiments](#experiments) |
| `flush()`, `optOut()`, `optIn()`, `reset()`, `getAnonymousId()`, `getUserId()` | | |

### Behaviour

| Concern | Behaviour | Default |
| --- | --- | --- |
| Batching | Send when `flushAt` events are queued or every `flushIntervalMs` | 20 events / 10s, ≤100 per request |
| Queue | Persisted after every change; namespaced per key kind and environment (`leanapp:la_pk_live:`) so dev and production never mix and rotating a key keeps the anonymous id and queue. Data under the 0.1.0 key-specific namespace is moved once on start | max 1,000, oldest dropped |
| Background / close | Browsers: on `visibilitychange` → hidden and `pagehide`, one `fetch` with `keepalive` sends as much of the queue as fits the browser's 64 KiB keepalive budget; the rest stays queued for the next visit. `sendBeacon` is not used because it cannot send the `Authorization` header. React Native: pass `appState: AppState` and the queue is flushed on `background` (the SDK does not import `react-native`). Turn the browser behaviour off with `flushOnHide: false` | on in browsers |
| TTL | Older queued events are dropped before sending | 7 days (server rejects > 31 days) |
| Retry | Network errors and 5xx: exponential backoff with jitter (1s → 5min); `429` honours `Retry-After` | |
| Idempotency | `Idempotency-Key` = `<batch size>:<hash of every event id>:<first event id>` (FNV-1a 32-bit over the UTF-8 ids joined by `\n`, identical in every SDK): same on every retry of the same events, different as soon as the batch's events change, so a retry is never answered with the response of another batch. `409 idempotency_key_reused` (should not happen with this key) keeps the events and resends them once without a key; `event_id` still de-duplicates | |
| 413 | Halves batch size and retries | |
| 400 | Drops the batch (cannot succeed) | |
| 401/403 | Stops sending, keeps events (revoked key or wrong environment) | |
| Sessions | New `session_id` after inactivity | 30 min |
| Context | `platform`, `sdk`, `app_version`, `locale`, `language`, `timezone`, screen size, attribution, `consent` (explicit answers only); browsers add `user_agent` (≤512 characters); extra via `context` option | |
| Early calls | Calls made before storage loads are buffered in order | |
| Consent | Per purpose; events wait in memory while pending, are dropped when denied. See below | `consentDefault: "granted"` |

### Consent

```ts
Analytics.initialize({ apiKey: "la_pk_live_…", consentDefault: "pending" }); // or { analytics: "pending", marketing: "denied" }
// … from your consent screen:
Analytics.setConsent({ analytics: true, marketing: false, push: true, attribution: true });
Analytics.getConsent(); // { analytics: "granted", marketing: "denied", push: "granted", attribution: "granted" }
```

| Purpose | Governs in the SDK | On the platform |
| --- | --- | --- |
| `analytics` | `track`, `screen`, `identify`, `alias` | Events from a user/install whose latest decision is denied are not stored (`consent_denied` in the debugger) |
| `push` | `registerPushToken` | Denied → automatic `push` suppression |
| `attribution` | `captureAttribution`, `context.attribution` / `context.campaign` on events, the `landing_viewed` event's touch, the deferred deep link request, the iOS AdServices token | Denied → `context.attribution` removed at ingestion |
| `marketing` | browsers: Meta's `fbp` / `fbc` in `context.attribution` (sent only when granted) | Denied → automatic `marketing` suppression; automation checks it before sending |

- **Default.** `consentDefault` applies until `setConsent` records an answer, for all purposes (`"granted"`, `"pending"`, `"denied"`) or per purpose. It defaults to `"granted"`, so apps that don't use consent behave as before.
- **Pending.** Events are kept in memory only: not written to storage, not sent. Granting sends them (with their original timestamps); denying or closing the app first discards them. The in-memory buffer is capped at `maxQueueSize`.
- **Denied.** New events of that purpose are dropped, and unsent ones already in the queue are discarded (also on the next start if the app closed before sending). Captured attribution is deleted from the device when attribution is denied.
- **The answer itself** is stored on the device (survives restarts) and sent as a `consent` event with only `anonymous_id`, `user_id`, platform, SDK and app version: no session, properties or attribution. It is sent whatever the answer, because the platform needs the record to enforce it, and is never dropped to make room in a full queue. Purposes left out of `setConsent` keep their state.
- **Identity.** Consent belongs to the device: it is kept by `reset()`, and the SDK records it again for the new anonymous id, and for the user on `identify` (new user id) and `alias`, so consent given before login follows the user. On the platform a decision under the user id and one under the install are compared and the most recent wins.
- **On events** `context.consent` carries the purposes the user has answered (`{ "analytics": true, "attribution": false }`), never the defaults.
- **Native SDKs** have the same API and rules: Android `Analytics.setConsent(mapOf(ConsentPurpose.ANALYTICS to true))` / `getConsent()` with `consentDefault` / `consentDefaults` in `AnalyticsOptions`; iOS `Analytics.setConsent([.analytics: true])` / `getConsent()` with `consentDefault` / `consentDefaults` in `AnalyticsOptions`; Flutter `Analytics.setConsent({'analytics': true})` / `getConsent()` with `consentDefault` / `consentDefaults` on `initialize`. `optOut()` / `optIn()` still work and stop everything.
- **Why a `consent` event and not a separate endpoint:** it rides the same offline queue, retries, idempotency (`event_id`) and keys as every other call, works from public keys, and the server applies it before the rest of the same batch. Servers send the same event with a secret key.

### Web attribution

In browsers (`platform: "web"`) the SDK captures the page it starts on by itself (`autoCapture`, on by default; `autoCapture: false` turns it off). For single-page apps that change the URL without reloading, call `Analytics.captureAttribution(location.href, { referrer })` after a navigation that came from a campaign.

- **What counts as a touch:** a landing URL with any `utm_*` or ad click id (`gclid`, `gbraid`, `wbraid`, `fbclid`, `ttclid`, `ScCid`, `twclid`, `li_fat_id`, `msclkid`, LeanApp `click_id`; `sccid` is accepted too), or an **external** referrer. Referrers from the same host, its subdomains and `internalDomains` (e.g. your payment provider's checkout domain) are not touches. `utm_id`, `campaign_id`, `adset_id`, `ad_id` are kept next to a source, never on their own.
- **On a touch** the SDK stores it (first touch kept, latest replaced) and sends one `landing_viewed` event with `properties.landing_url` / `referrer` and `context.attribution` = the touch plus `landing_url`, `referrer` and `touch: "first" | "latest"`. Its `event_id` is derived from the session, the landing URL and the referrer, so capturing the same page twice sends one event.
- **`landing_url`** keeps only the origin, the path and the attribution parameters (no other query parameters, no fragment); `referrer` keeps origin and path.
- **Direct visits** (no campaign parameters, no external referrer) are not a touch: nothing is stored or overwritten, no `landing_viewed` is sent, and the session's first event carries only `context.attribution.landing_url`. A later direct session never carries an earlier paid source; the server's attribution engine decides credit from the touches it received.
- **Other events:** the first event of the session that had the touch carries the same `context.attribution`; later events and sessions don't repeat it.
- **Meta browser ids:** with `marketing` consent granted, events carry `context.attribution.fbp` / `fbc` read from Meta Pixel's `_fbp` / `_fbc` first-party cookies. When there is no `_fbc` cookie but the landing URL had an `fbclid`, the SDK sends `fbc` in Meta's documented `fb.1.<milliseconds>.<fbclid>` format. The SDK only reads these cookies, never sets any cookie. `metaBrowserIds: false` turns it off.
- **Microsoft Clarity bridge (opt-in):** with `clarity: { enabled: true }`, `analytics` consent granted and Clarity's tag on the page (`window.clarity`), the SDK calls `clarity("identify", userId ?? anonymousId)` and `clarity("set", "leanapp_anonymous_id", anonymousId)` once per identity (start, `identify`, `alias`, `reset`, consent granted). It never loads Clarity and never sends Clarity's own consent signal (Clarity Consent API), which sites must send for EEA, UK and Swiss visitors. See [clarity-integration.md](clarity-integration.md).
- **Consent:** with `attribution` denied nothing is captured and no `landing_viewed` is sent. While it is pending the touch is held in memory only and `landing_viewed` waits with the other events; granting attribution stores the touch and sends the event with it, while granting analytics alone sends the events without any attribution.
- **`user_agent`:** browsers add `context.user_agent` (`navigator.userAgent`) to every event; Meta's Conversions API needs it for website events.

### Deferred deep links

On React Native (`deferredDeepLinks`, on by default there; off in browsers) the SDK calls `POST /v1/deep-links/deferred` once per new install, after `attribution` consent is granted, with `anonymous_id`, `platform`, `os` / `os_version` (from the `context` option, when set) and a captured LeanApp `click_id`. The answer goes to `onDeferredDeepLink(result)` and `getDeferredDeepLink()` (`null` when not asked). `result.deep_link.path` / `params` is where to route when `match_type` is not `"none"`.

- Installs from before this SDK version never ask (they are not new).
- A network error or a 5xx/429 asks again on the next launch; a 2xx, 400 or 422 is final.
- Android, iOS and Flutter do the same on their first launch; see [Native SDKs](#native-sdks-android-ios-flutter).

## Experiments

Variants of running [experiments](experiments.md) come from `GET` or `POST /v1/experiments/assignments` with the **public** key, for a `user_id`, an `anonymous_id` or both. The same person always gets the same variant; `variant: null` means show your default.

```ts
const variant = await Analytics.getVariant("checkout_button"); // "control", "treatment" … or null
if (variant === "treatment") showPriceOnButton();
```

- `getVariant` fetches every assignment in one request, reuses it for `experimentsCacheMs` (default 5 minutes) and asks again when the user changes. It never throws: on a network error it returns `null`.
- The first time it returns a variant for a user it queues an `experiment_exposure` event (`properties: { experiment, experiment_id, variant }`, a stable `event_id`), so results count only people who reached the code that shows the variant. Pass `{ expose: false }` and call `trackExposure(key, experimentId, variant)` where the variant is actually shown if you fetch earlier.
- The exposure is a normal event: it waits for analytics consent and is dropped when consent is denied.
- Call it after `identify()` for experiments on signed-in users: the variant follows the user id.
- Android, iOS and Flutter don't have `getVariant` yet. Call the endpoint and send the same `experiment_exposure` event with `track()` when you show the variant.

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

## Attribution context

What every SDK must send so the [attribution engine](attribution.md) can match installs deterministically. All of it goes in the event's `context`. `context.attribution` is a string map with the well-known keys below (typed in `apps/platform/src/modules/ingestion/attribution-context.ts`) and any other string keys for backward compatibility: keys 1–60 characters, ≤ 64 keys, values ≤ 1,000 characters except `adservices_token` (≤ 4,096). `context.campaign` is a map of strings, numbers and booleans (keys ≤ 60, values ≤ 1,000). See [events](events.md#contextattribution).

| Field | Where | When | Used for |
| --- | --- | --- | --- |
| `app_installed` event | event name | first launch after install, once per install (`anonymous_id`) | the install itself; no `app_installed`, no install attribution |
| `context.device.id` | context | always, when the platform allows a stable install-independent id | reinstall detection |
| `context.campaign.install_referrer` | Android | on `app_installed` (hold it until the Play Install Referrer API answers, ~10 s max) | LeanApp links put `click_id=lac_…&utm_source=…&utm_campaign=…&deep_link=…` in the Play referrer: exact match |
| `context.campaign.referrer_click_timestamp_seconds`, `install_begin_timestamp_seconds`, `google_play_instant` | Android | with the referrer | lookback check on the store click |
| `context.attribution.deep_link_url` | Android, iOS, Flutter | on the app open caused by a deep / universal link (the JS SDK does not set it) | `click_id` and `utm_*` in the URL |
| `context.attribution.click_id` | all | when the app was opened from a URL with `click_id` | exact match (install) and re-engagement (later opens) |
| `context.attribution.gclid` / `gbraid` / `wbraid` / `fbclid` / `ttclid` / `ScCid` / `twclid` / `msclkid` / `li_fat_id` | all | when present in the opening URL or referrer | deterministic when a LeanApp link recorded the same click id on the click, else `reported` (only the install says so); network postbacks |
| `context.attribution.utm_source` … `utm_content`, `utm_id` | all | when present | campaign labels; on their own a `reported` match, never deterministic |
| `context.attribution.campaign_id` / `adset_id` / `ad_id` | all | next to a source, never alone | joining to ad network spend |
| `context.attribution.landing_url` / `referrer` / `touch` | web | on `landing_viewed` and the session's first event | web touches (`touch` is `first` or `latest`; anything else is dropped with a warning, as are non-http(s) URLs) |
| `context.attribution.fbp` / `fbc` | web | every event, with `marketing` consent | Meta Conversions API matching |
| `context.attribution.adservices_token` | iOS 14.3+ | once, on `app_installed`, unless attribution consent is denied | Apple Search Ads attribution lookup on the server |
| `context.user_agent` | web | every event | Meta Conversions API website events |
| `context.platform` + `context.os_version` | all | always | probabilistic matching (Android only, opt-in) needs `android` and the OS version |

The JS SDK's `captureAttribution(url)` fills `utm_*`, the ad-network click ids, campaign ids and `click_id`; in browsers it also adds `landing_url`, `referrer` and Meta's ids (see [Web attribution](#web-attribution)). It does not set `deep_link_url` or read the Play referrer (React Native needs a native module for that). The native SDKs (Android, iOS, Flutter) send `context.campaign` from the Play Install Referrer API as listed above.

The server adds an IP hash (`context._server.ip_hash`) to `app_installed` events sent with a public SDK key; anything a client sends under `_server` is dropped.

## Native SDKs: Android, iOS, Flutter

Each is a port of `sdks/javascript/src/client.ts`: same method names, wire format (`POST /v1/events/batch`, the schema in `apps/platform/src/modules/ingestion/schema.ts`), defaults and delivery rules from the table above (batching, persistent queue with cap and TTL, backoff with jitter, `Retry-After`, `413` halving, `400/422` drop, `401/403` pause, `Idempotency-Key` = batch size + hash of every event id + first event id, `409` resend without the key, 30-minute sessions). Storage uses the same namespace as the JavaScript SDK (`leanapp:la_pk_live:`). Native additions:

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
| Consent | `setConsent(map)` / `getConsent()`, `consentDefault` / `consentDefaults` | same | same |
| Deferred deep link | Once per new install, after the Play referrer answered (≤10 s), with `install_referrer` and its `click_id`; answer on the main thread to `onDeferredDeepLink` | Once per new install, with `os_version` as `major.minor`; answer on the main queue to `onDeferredDeepLink` | Once per new install (on Android waits ≤10 s for `setInstallReferrer`); `onDeferredDeepLink` on `initialize`, or `client.requestDeferredDeepLink()` |
| Apple attribution | n/a | AdServices token on `app_installed` (`collectAdServicesToken`, default on); `Analytics.updateConversionValue(fine, coarse:, lock:)` | n/a (call Apple's APIs from Swift) |

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

**Deferred deep links (native).** On by default (`deferredDeepLinks`), needs `attribution` consent (asked once it is granted). Installs from before this version never ask. A 2xx, 400 or 422 is final; other failures ask again on the next launch. The server records at most one match per `anonymous_id`.

**Apple AdServices token (iOS).** On the install's `app_installed` event the SDK sends `context.attribution.adservices_token` from `AAAttribution.attributionToken()` (iOS 14.3+, AdServices framework, no ATT prompt needed), unless attribution consent is denied. The SDK never calls Apple's attribution API itself; the server-side lookup belongs to the Apple Search Ads integration.

**SKAdNetwork / AdAttributionKit conversion values (iOS).** `Analytics.updateConversionValue(fine, coarse:, lock:)` (fine value 0–63) calls AdAttributionKit's `Postback.updateConversionValue` on iOS 17.4+, otherwise SKAdNetwork's `updatePostbackConversionValue` (16.1+ with coarse value and lock, 15.4+) or `updateConversionValue` (14.0+). The app decides which value means what (the conversion schema); postbacks go from Apple to the ad networks and LeanApp's postback endpoint, aggregate and never joined to users.

Not built yet: automatic screen tracking, Flutter install referrer without a plugin.

```kotlin
Analytics.initialize(context, "la_pk_live_…", AnalyticsOptions(
  consentDefault = ConsentStatus.PENDING,
  onDeferredDeepLink = { link -> link.deepLinkPath?.let { router.open(it, link.deepLinkParams) } },
))
Analytics.setConsent(mapOf(ConsentPurpose.ANALYTICS to true, ConsentPurpose.ATTRIBUTION to true))
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
