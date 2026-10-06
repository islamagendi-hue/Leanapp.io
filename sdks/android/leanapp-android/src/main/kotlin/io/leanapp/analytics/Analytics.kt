package io.leanapp.analytics

import android.app.Application
import android.content.Context
import io.leanapp.analytics.android.AndroidLogger
import io.leanapp.analytics.android.DeviceInfo
import io.leanapp.analytics.android.InstallReferrerFetcher
import io.leanapp.analytics.android.LifecycleTracker
import io.leanapp.analytics.android.ReferrerResult
import java.io.File

/** Options for [Analytics.initialize]. Defaults match docs/sdk.md. */
class AnalyticsOptions @JvmOverloads constructor(
    val endpoint: String = LeanAppConfig.DEFAULT_ENDPOINT,
    val flushAt: Int = 20,
    val flushIntervalMs: Long = 10_000,
    val maxBatchSize: Int = 100,
    val maxQueueSize: Int = 1_000,
    val eventTtlMs: Long = 7L * 86_400_000,
    val sessionTimeoutMs: Long = 30L * 60_000,
    /** Extra context merged into every event. */
    val context: Map<String, Any?> = emptyMap(),
    val optedOut: Boolean = false,
    val debug: Boolean = false,
    /** app_installed / app_updated on launch and app_opened when the app comes to the foreground. */
    val trackLifecycleEvents: Boolean = true,
    /** Reads the Google Play Install Referrer once per install and sends it as context.campaign. */
    val collectInstallReferrer: Boolean = true,
    /** Captures utm_* and click ids from the Intent data of the activity that opens the app. */
    val captureDeepLinks: Boolean = true,
)

/**
 * LeanApp for Android. Initialize once in Application.onCreate():
 *
 *     Analytics.initialize(this, "la_pk_live_…")
 *     Analytics.track("order_completed", mapOf("order_id" to "o1", "revenue" to 45.0, "currency" to "SAR"))
 *
 * Every call is safe before initialize() (it is ignored with one warning) and never throws afterwards.
 */
object Analytics {
    @Volatile private var instance: LeanAppClient? = null
    @Volatile private var warned = false

    private fun client(): LeanAppClient? {
        val c = instance
        if (c == null && !warned) {
            warned = true
            android.util.Log.w("LeanApp", "Analytics.initialize() has not been called; events are ignored.")
        }
        return c
    }

    /** Starts the SDK. Calling it again returns the first client. Throws only for an invalid or secret key. */
    @JvmStatic
    @JvmOverloads
    @Synchronized
    fun initialize(context: Context, apiKey: String, options: AnalyticsOptions = AnalyticsOptions()): LeanAppClient {
        instance?.let { return it }
        val app = context.applicationContext
        val launchAt = System.currentTimeMillis()
        val info = DeviceInfo.app(app)
        val client = LeanAppClient(
            LeanAppConfig(
                apiKey = apiKey,
                endpoint = options.endpoint,
                platform = "android",
                appVersion = info.versionName,
                appBuild = info.versionCode,
                flushAt = options.flushAt,
                flushIntervalMs = options.flushIntervalMs,
                maxBatchSize = options.maxBatchSize,
                maxQueueSize = options.maxQueueSize,
                eventTtlMs = options.eventTtlMs,
                sessionTimeoutMs = options.sessionTimeoutMs,
                context = options.context,
                optedOut = options.optedOut,
                debug = options.debug,
            ),
            store = FileStore(File(app.filesDir, "leanapp")),
            transport = UrlConnectionTransport(),
            contextProvider = DeviceInfo.provider(app),
            logger = AndroidLogger,
            sdkName = "leanapp-android",
            sdkVersion = SDK_VERSION,
        )
        instance = client

        client.checkInstallReferrerPending { pending ->
            if (pending && options.collectInstallReferrer) {
                // app_installed waits for the referrer (up to 10 s) so it carries context.campaign.
                InstallReferrerFetcher.fetch(app, 10_000) { result ->
                    when (result) {
                        is ReferrerResult.Found -> client.setInstallReferrer(result.referrer)
                        ReferrerResult.Unavailable -> client.setInstallReferrer(null)
                        ReferrerResult.TryLater -> Unit
                    }
                    if (options.trackLifecycleEvents) client.trackInstallOrUpdate(info.versionName, info.versionCode, launchAt)
                }
            } else if (options.trackLifecycleEvents) {
                client.trackInstallOrUpdate(info.versionName, info.versionCode, launchAt)
            }
        }

        if (app is Application) {
            app.registerActivityLifecycleCallbacks(
                LifecycleTracker(
                    onForeground = { activity, first ->
                        if (options.captureDeepLinks) {
                            activity.intent?.dataString?.let { client.captureAttribution(it) }
                        }
                        if (options.trackLifecycleEvents) client.track("app_opened", mapOf("from_background" to !first))
                    },
                    // Send what is queued while the process is still alive.
                    onBackground = { client.flush() },
                ),
            )
        }
        return client
    }

    @JvmStatic
    @JvmOverloads
    fun track(eventName: String, properties: Map<String, Any?> = emptyMap(), eventId: String? = null, timestampMs: Long? = null) {
        client()?.track(eventName, properties, eventId, timestampMs)
    }

    @JvmStatic
    @JvmOverloads
    fun screen(screenName: String, properties: Map<String, Any?> = emptyMap()) {
        client()?.screen(screenName, properties)
    }

    @JvmStatic
    @JvmOverloads
    fun identify(userId: String?, traits: Map<String, Any?> = emptyMap()) {
        client()?.identify(userId, traits)
    }

    @JvmStatic
    fun setUserProperties(traits: Map<String, Any?>) {
        client()?.setUserProperties(traits)
    }

    @JvmStatic
    @JvmOverloads
    fun alias(newUserId: String, previousId: String? = null) {
        client()?.alias(newUserId, previousId)
    }

    /** Pass the FCM token from FirebaseMessaging; permission is granted, denied, provisional or unknown. */
    @JvmStatic
    @JvmOverloads
    fun registerPushToken(token: String, provider: String = "fcm", permission: String = "unknown") {
        client()?.registerPushToken(token, provider, permission)
    }

    /** For deep links that arrive while the app is open (onNewIntent). Launch links are captured automatically. */
    @JvmStatic
    fun captureAttribution(url: String): Map<String, String>? = client()?.captureAttribution(url)

    @JvmStatic
    fun getAttribution(): Pair<Map<String, String>, Map<String, String>>? = client()?.getAttribution()

    @JvmStatic
    fun getAnonymousId(): String? = client()?.getAnonymousId()

    @JvmStatic
    fun getUserId(): String? = client()?.getUserId()

    @JvmStatic
    fun reset() {
        client()?.reset()
    }

    @JvmStatic
    fun optOut() {
        client()?.optOut()
    }

    @JvmStatic
    fun optIn() {
        client()?.optIn()
    }

    @JvmStatic
    @JvmOverloads
    fun flush(callback: ((FlushResult) -> Unit)? = null) {
        val c = client()
        if (c == null) callback?.invoke(FlushResult.Empty) else c.flush(callback)
    }
}
