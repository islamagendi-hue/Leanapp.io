# LeanApp iOS SDK (Swift)

Events, identity, sessions, attribution and an offline queue for iOS 13+ (also macOS 10.15+ and tvOS 13+). Swift port of the JavaScript SDK: same wire format, same rules ([docs/sdk.md](../../docs/sdk.md)). No dependencies: `URLSession`, a file-backed queue and UIKit lifecycle notifications.

## Install

Not yet published as a tagged Swift package or on CocoaPods (needs the owner's release repository / CocoaPods trunk account). Until then, add it as a local package in Xcode (File → Add Package Dependencies → Add Local… → `sdks/ios`) or:

```swift
.package(path: "../leanapp/sdks/ios")
// target dependency: .product(name: "LeanApp", package: "LeanApp")
```

## Quickstart

```swift
import LeanApp

// application(_:didFinishLaunchingWithOptions:), on the main thread
Analytics.initialize(apiKey: "la_pk_live_…") // Developers → SDK & API keys

Analytics.screen("Home")
Analytics.track("product_viewed", properties: ["product_id": "123", "price": 299, "currency": "SAR"])
Analytics.identify("user_123", traits: ["city": "Riyadh", "plan": "plus"])
Analytics.track("order_completed", properties: ["order_id": "o1", "revenue": 45.0, "currency": "SAR"], eventId: "order-o1")

// Push: APNs device token
func application(_ app: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken token: Data) {
    Analytics.registerPushToken(deviceToken: token, permission: "granted")
}
// Deep links and universal links
func scene(_ scene: UIScene, openURLContexts contexts: Set<UIOpenURLContext>) {
    contexts.forEach { Analytics.captureAttribution($0.url) }
}
Analytics.reset() // on logout
```

`AnalyticsOptions` sets `endpoint`, `flushAt`, `flushInterval`, `maxBatchSize`, `maxQueueSize`, `eventTTL`, `sessionTimeout`, `context`, `optedOut`, `debug` and `trackLifecycleEvents`.

## What it does automatically

- **Queue** in Application Support/leanapp (atomic writes, excluded from backup), batches of up to 100 every 10 s or at 20 events, and a flush in a background task when the app enters the background.
- **Retries** with exponential backoff and jitter (1 s → 5 min), `Retry-After` on 429, batch halving on 413, drop on 400/422, pause on 401/403, `Idempotency-Key` per batch.
- **Sessions**: new `session_id` after 30 minutes of inactivity.
- **Context**: `platform: ios`, `os_version`, `device.model` (e.g. `iPhone15,2`), `device.type`, `screen`, `locale`, `language`, `timezone`, `app_version`/`app_build` from the bundle, `sdk {name: leanapp-ios}`. No IDFA/IDFV.
- **Lifecycle**: `app_installed`, `app_updated`, `app_opened` (`from_background`).

Not built yet: SKAdNetwork / AdAttributionKit conversion values (see [roadmap](../../docs/roadmap.md)).

## Develop

```bash
cd sdks/ios
swift test   # macOS (CI job "iOS SDK") or Linux with Swift 5.9+
```
