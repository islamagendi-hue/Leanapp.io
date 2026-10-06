# LeanApp Android SDK (Kotlin)

Events, identity, sessions, attribution (including the Google Play Install Referrer) and an offline queue for Android apps. Kotlin port of the JavaScript SDK: same wire format, same rules ([docs/sdk.md](../../docs/sdk.md)).

| Module | What it is |
| --- | --- |
| `leanapp-core` | Pure Kotlin/JVM: client, file queue, `HttpURLConnection` transport, JSON. No dependencies. |
| `leanapp-android` | Android library (minSdk 21): `Analytics` singleton, device context, lifecycle, install referrer. Depends only on `com.android.installreferrer:installreferrer:2.2`. |

## Install

Not yet published to Maven Central (publishing needs the owner's Sonatype account and signing key). Until then, include the modules from this repository:

```kotlin
// settings.gradle.kts
includeBuild("path/to/leanapp/sdks/android")
// app/build.gradle.kts
dependencies { implementation("io.leanapp:leanapp-android:0.1.0") }
```

The SDK build includes its Android module only when it finds an Android SDK: set `ANDROID_HOME`, or put `sdk.dir=…` in `sdks/android/local.properties`.

## Quickstart

```kotlin
class App : Application() {
    override fun onCreate() {
        super.onCreate()
        Analytics.initialize(this, "la_pk_live_…") // Developers → SDK & API keys
    }
}

Analytics.screen("Home")
Analytics.track("product_viewed", mapOf("product_id" to "123", "price" to 299, "currency" to "SAR"))
Analytics.identify("user_123", mapOf("city" to "Riyadh", "plan" to "plus"))
Analytics.track("order_completed", mapOf("order_id" to "o1", "revenue" to 45.0, "currency" to "SAR"), eventId = "order-o1")

FirebaseMessaging.getInstance().token.addOnSuccessListener { Analytics.registerPushToken(it, "fcm", "granted") }
override fun onNewIntent(intent: Intent) { super.onNewIntent(intent); intent.dataString?.let { Analytics.captureAttribution(it) } }
Analytics.reset() // on logout
```

`AnalyticsOptions` (third argument) sets `endpoint`, `flushAt`, `flushIntervalMs`, `maxBatchSize`, `maxQueueSize`, `eventTtlMs`, `sessionTimeoutMs`, `context`, `optedOut`, `debug`, and turns off `trackLifecycleEvents`, `collectInstallReferrer` or `captureDeepLinks`.

## What it does automatically

- **Queue**: events are written to `filesDir/leanapp` (atomic file writes) and sent in batches of up to 100, every 10 s or at 20 queued events, and when the app goes to the background.
- **Retries**: network errors and 5xx back off exponentially with jitter (1 s → 5 min); `429` honours `Retry-After`; `413` halves the batch; `400/422` drops the batch; `401/403` stops sending and keeps the events. Each request carries an `Idempotency-Key`; retries reuse event ids so nothing is double counted.
- **Sessions**: a new `session_id` after 30 minutes of inactivity.
- **Context**: `platform: android`, `os_version`, `device.model`/`manufacturer`/`type`, `screen`, `locale`, `language`, `timezone`, `app_version`/`app_build` (from the package), `sdk {name: leanapp-android}`. No device identifiers (no Android ID, no advertising ID).
- **Lifecycle**: `app_installed` (first launch), `app_updated` (version or build changed), `app_opened` (`from_background`).
- **Deep links**: utm_* and click ids in the launching activity's Intent data become `context.attribution` (latest touch, with `deep_link_url`).
- **Install referrer**: read once per install with the Play Install Referrer library and sent on every event as `context.campaign = { install_referrer, referrer_click_timestamp_seconds, install_begin_timestamp_seconds, google_play_instant }`; utm_* / `click_id` in it become the first touch. `app_installed` waits up to 10 s for it.

## Develop

```bash
cd sdks/android
gradle :leanapp-core:test                 # any JVM, no Android SDK needed
gradle :leanapp-android:assembleRelease   # needs ANDROID_HOME (CI job "Android SDK")
```

The Android module is only included when an Android SDK is found (`ANDROID_HOME`, `ANDROID_SDK_ROOT` or `local.properties`).
