package io.leanapp.analytics

/** Client options. Defaults match the JavaScript SDK (docs/sdk.md). */
class LeanAppConfig(
    /** Public SDK key (la_pk_…) for apps. A secret key (la_sk_…) is accepted only with platform "backend". */
    val apiKey: String,
    endpoint: String = DEFAULT_ENDPOINT,
    /** android, ios, react_native, flutter, web or backend. */
    val platform: String = "android",
    val appVersion: String? = null,
    val appBuild: String? = null,
    /** Send when this many events are queued. */
    flushAt: Int = 20,
    /** Send at least this often while events are queued. */
    flushIntervalMs: Long = 10_000,
    /** Events per request (server maximum 500). */
    maxBatchSize: Int = 100,
    /** Oldest events are dropped beyond this. */
    maxQueueSize: Int = 1_000,
    /** Queued events older than this are dropped (the server rejects events older than 31 days). */
    val eventTtlMs: Long = 7L * 86_400_000,
    /** Inactivity after which a new session starts. */
    val sessionTimeoutMs: Long = 30L * 60_000,
    /** Extra context merged into every event. */
    val context: Map<String, Any?> = emptyMap(),
    /** Stop sending (events still queue) until optIn(). */
    val optedOut: Boolean = false,
    val debug: Boolean = false,
    /**
     * Consent assumed for every purpose until setConsent() records the user's answer. GRANTED (default,
     * the behaviour before consent existed): track normally. PENDING: events wait in memory only (not
     * stored, not sent) until consent is granted, and are discarded if it is denied or the app closes
     * first. DENIED: events are dropped. See [ConsentPurpose] for what each purpose governs.
     */
    val consentDefault: ConsentStatus = ConsentStatus.GRANTED,
    /** Per-purpose overrides of [consentDefault], keyed by [ConsentPurpose] names (analytics, marketing, push, attribution). */
    val consentDefaults: Map<String, ConsentStatus> = emptyMap(),
    /** On the first launch of a new install, ask LeanApp once for the deferred deep link (needs attribution consent). */
    val deferredDeepLinks: Boolean = true,
) {
    val endpoint: String = endpoint.trimEnd('/')
    val flushAt: Int = maxOf(1, flushAt)
    val flushIntervalMs: Long = maxOf(1_000L, flushIntervalMs)
    val maxBatchSize: Int = minOf(500, maxOf(1, maxBatchSize))
    val maxQueueSize: Int = maxOf(10, maxQueueSize)

    companion object {
        const val DEFAULT_ENDPOINT = "https://api.leanapp.io"
    }
}

/** Result of one flush, same shape as the JavaScript SDK's FlushResult. */
sealed class FlushResult {
    object Empty : FlushResult() { override fun toString() = "Empty" }
    object Paused : FlushResult() { override fun toString() = "Paused" }
    object Busy : FlushResult() { override fun toString() = "Busy" }
    object Unauthorized : FlushResult() { override fun toString() = "Unauthorized" }
    data class Sent(val accepted: Int, val duplicates: Int, val rejected: Int) : FlushResult()
    data class Retry(val retryInMs: Long, val reason: String) : FlushResult()
}

/** Debug output. The Android module routes this to android.util.Log. */
interface LeanAppLogger {
    fun log(message: String)
    fun warn(message: String, error: Throwable? = null)
}

internal object StderrLogger : LeanAppLogger {
    override fun log(message: String) = System.err.println("[LeanApp] $message")
    override fun warn(message: String, error: Throwable?) =
        System.err.println("[LeanApp] $message" + (error?.let { " ($it)" } ?: ""))
}
