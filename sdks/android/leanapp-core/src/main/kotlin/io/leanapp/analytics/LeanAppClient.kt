package io.leanapp.analytics

import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.Future
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit

const val SDK_VERSION = "0.1.0"

private val KEY_PATTERN = Regex("^la_(pk|sk)_(dev|stg|live)_[A-Za-z0-9_-]{20,}$")
private const val BASE_BACKOFF_MS = 1_000L
private const val MAX_BACKOFF_MS = 5L * 60_000

/**
 * Storage namespace for a key: its kind and environment (leanapp:la_pk_live:), never the random part,
 * so rotating a key keeps the anonymous id and queue while dev and production stay apart.
 * Same namespace as the JavaScript SDK.
 */
fun storagePrefix(apiKey: String): String {
    val m = KEY_PATTERN.matchEntire(apiKey) ?: throw IllegalArgumentException("not a LeanApp key")
    return "leanapp:la_${m.groupValues[1]}_${m.groupValues[2]}:"
}

/**
 * FNV-1a (32-bit) of the UTF-8 bytes of the event ids joined by "\n", as 8 hex digits.
 * Same value as eventIdsHash in the JavaScript SDK.
 */
fun eventIdsHash(ids: List<String>): String {
    var h = 0x811c9dc5.toInt()
    for (b in ids.joinToString("\n").toByteArray(Charsets.UTF_8)) {
        h = (h xor (b.toInt() and 0xff)) * 0x01000193
    }
    return Integer.toHexString(h).padStart(8, '0')
}

/**
 * `<batch size>:<hash of every event id>:<first event id>`: the same events give the same key on every
 * retry, and a batch whose events changed before a retry gets a different key, so the server never
 * answers it with the response of a batch it did not send. The first id goes last so the server's
 * 200-character limit can only truncate it, never the hash.
 */
fun idempotencyKey(ids: List<String>): String = "${ids.size}:${eventIdsHash(ids)}:${ids.firstOrNull() ?: ""}"

/**
 * The LeanApp client: a Kotlin port of sdks/javascript/src/client.ts with the same wire format and rules.
 *
 * Every public call returns immediately and never throws after construction. All state lives on one
 * background thread, so calls are applied in order; storage is read on that thread before anything
 * else runs, which buffers early calls the way the JavaScript SDK does.
 */
class LeanAppClient @JvmOverloads constructor(
    config: LeanAppConfig,
    private val store: KeyValueStore = InMemoryStore(),
    private val transport: HttpTransport = UrlConnectionTransport(),
    /** Device and locale context added to every event (the Android module supplies device facts). */
    private val contextProvider: () -> Map<String, Any?> = ::defaultContext,
    private val logger: LeanAppLogger = StderrLogger,
    private val clock: () -> Long = System::currentTimeMillis,
    private val uuid: () -> String = { UUID.randomUUID().toString() },
    private val random: () -> Double = Math::random,
    private val sdkName: String = "leanapp-android",
    private val sdkVersion: String = SDK_VERSION,
    /** Tests turn timers off to drive sending with flush() only. */
    private val timersEnabled: Boolean = true,
) {
    private val o: LeanAppConfig = config
    private val prefix: String
    private val executor: ScheduledExecutorService

    // State below is only touched on the executor thread.
    private var state = State(anonymousId = "")
    private val queue = ArrayList<QueuedEvent>()
    /** Events waiting for consent: memory only, never persisted or sent until consent is granted. */
    private val held = ArrayList<QueuedEvent>()
    /** Attribution captured while attribution consent is pending: memory only. */
    private var heldFirst: Map<String, String>? = null
    private var heldLatest: Map<String, String>? = null
    private val consentDefaults: Map<String, ConsentStatus> =
        ConsentPurpose.ALL.associateWith { config.consentDefaults[it] ?: config.consentDefault }
    /** The deferred deep link request waiting for attribution consent (or running). */
    private var deferredRequest: DeferredRequest? = null
    private var paused = false
    @Volatile private var optedOut: Boolean = config.optedOut
    private var failures = 0
    private var retryAt = 0L
    /** Set after a 409 idempotency_key_reused: the next request goes without a key (event ids still de-duplicate). */
    private var skipIdempotencyKey = false
    private var maxBatchSize = config.maxBatchSize
    private var timer: ScheduledFuture<*>? = null
    private val loaded = CountDownLatch(1)
    @Volatile private var executorThread: Thread? = null

    // Snapshots readable from any thread.
    @Volatile private var anonymousIdSnapshot = ""
    @Volatile private var userIdSnapshot: String? = null
    @Volatile private var attributionSnapshot: Pair<Map<String, String>, Map<String, String>>? = null
    @Volatile private var queueLengthSnapshot = 0
    @Volatile private var consentSnapshot: Map<String, ConsentStatus> = consentDefaults

    init {
        if (!KEY_PATTERN.matches(config.apiKey)) {
            throw IllegalArgumentException("LeanApp: apiKey must be a LeanApp key (la_pk_… for apps). Find it under Developers → SDK & API keys.")
        }
        if (config.apiKey.startsWith("la_sk_") && config.platform != "backend") {
            throw IllegalArgumentException("LeanApp: secret keys (la_sk_…) are for servers only. Use the public SDK key (la_pk_…) in apps.")
        }
        prefix = storagePrefix(config.apiKey)
        executor = Executors.newSingleThreadScheduledExecutor { r ->
            Thread(r, "leanapp-analytics").also {
                it.isDaemon = true
                executorThread = it
            }
        }
        post { load() }
    }

    // ── Public API ──────────────────────────────────────────────────────────

    @JvmOverloads
    fun track(eventName: String, properties: Map<String, Any?> = emptyMap(), eventId: String? = null, timestampMs: Long? = null) {
        val name = eventName.trim()
        if (name.isEmpty()) return warn("track() needs an event name")
        val props = LinkedHashMap(properties)
        enqueue(eventId, timestampMs) { linkedMapOf("type" to "track", "event_name" to name, "properties" to props) }
    }

    @JvmOverloads
    fun screen(screenName: String, properties: Map<String, Any?> = emptyMap()) {
        if (screenName.isEmpty()) return warn("screen() needs a screen name")
        val props = LinkedHashMap(properties)
        props["screen_name"] = screenName
        enqueue { linkedMapOf("type" to "screen", "event_name" to screenName, "properties" to props) }
    }

    /** Links this device to your user id. Traits are facts about the person (plan, city), not actions. */
    @JvmOverloads
    fun identify(userId: String?, traits: Map<String, Any?> = emptyMap()) {
        val t = LinkedHashMap(traits)
        var changed = false
        enqueue {
            if (!userId.isNullOrEmpty()) {
                changed = state.userId != userId
                state.userId = userId
                userIdSnapshot = userId
                persistState()
            }
            linkedMapOf("type" to "identify", "user_properties" to t)
        }
        // Consent given on this device follows the user who signs in on it.
        post { if (changed) resendConsent() }
    }

    fun setUserProperties(traits: Map<String, Any?>) = identify(null, traits)

    /** Merges a previous user id into the current one (e.g. a guest account that signed up). */
    @JvmOverloads
    fun alias(newUserId: String, previousId: String? = null) {
        enqueue {
            val prev = previousId ?: state.userId ?: state.anonymousId
            state.userId = newUserId
            userIdSnapshot = newUserId
            persistState()
            linkedMapOf("type" to "alias", "previous_id" to prev)
        }
        post { resendConsent() }
    }

    /** provider: "fcm" or "apns"; permission: granted, denied, provisional or unknown. Governed by push consent. */
    @JvmOverloads
    fun registerPushToken(token: String, provider: String = "fcm", permission: String = "unknown") {
        if (provider != "fcm" && provider != "apns") return warn("registerPushToken() provider must be fcm or apns")
        enqueue(purpose = ConsentPurpose.PUSH) { linkedMapOf("type" to "push_token", "push_token" to linkedMapOf("token" to token, "provider" to provider, "permission" to permission)) }
    }

    /**
     * Captures campaign parameters from a deep link or landing URL. The first touch is kept; the latest
     * touch is attached to every following event as context.attribution, with the opening URL as
     * deep_link_url so re-engagement can be matched. Governed by attribution consent: ignored when
     * denied, kept in memory only while pending.
     */
    fun captureAttribution(url: String): Map<String, String>? {
        val parsed = parseAttribution(url) ?: return null
        val touch = LinkedHashMap(parsed)
        touch["deep_link_url"] = url.take(1000)
        post { recordTouch(touch, firstOnly = false) }
        return touch
    }

    /**
     * Records the user's consent answers (purpose name → granted), e.g. from your consent screen. Purposes
     * left out keep their state. The answers are stored on the device and sent to LeanApp whatever they
     * are, so the platform can honour them. Granting analytics releases events waiting in memory; denying
     * it discards them and clears the unsent queue.
     */
    fun setConsent(consent: Map<String, Boolean>) {
        val changes = LinkedHashMap<String, Boolean>()
        for (p in ConsentPurpose.ALL) consent[p]?.let { changes[p] = it }
        if (changes.isEmpty()) return warn("setConsent() needs at least one of analytics, marketing, push, attribution")
        val at = clock()
        post {
            state.consent = LinkedHashMap(state.consent).also { it.putAll(changes) }
            persistState()
            // The change goes first, then whatever it releases.
            pushConsent(changes, at)
            applyConsent()
            publish()
        }
    }

    /** Current consent per purpose: the user's answer, or the configured default where they haven't answered. */
    fun getConsent(): Map<String, ConsentStatus> {
        awaitIdle()
        return consentSnapshot
    }

    /**
     * Asks LeanApp once per new install (POST /v1/deep-links/deferred) for the deep link of the ad or link
     * click the install came from. Waits for attribution consent; [callback] (on the SDK thread) gets the
     * answer, or null when the request failed, attribution consent was denied, deferred deep links are off
     * or this install already asked. Call it after the install referrer was read (the Android module does).
     */
    @JvmOverloads
    fun requestDeferredDeepLink(os: String? = null, osVersion: String? = null, callback: ((DeferredDeepLink?) -> Unit)? = null) {
        post {
            if (!o.deferredDeepLinks || state.deferredChecked != false || deferredRequest != null) {
                callback?.invoke(null)
                return@post
            }
            deferredRequest = DeferredRequest(os, osVersion, callback)
            maybeFetchDeferred()
        }
    }

    /** First and latest touch captured on this device, or null. */
    fun getAttribution(): Pair<Map<String, String>, Map<String, String>>? {
        awaitLoaded()
        return attributionSnapshot
    }

    fun getAnonymousId(): String {
        awaitLoaded()
        return anonymousIdSnapshot
    }

    fun getUserId(): String? {
        awaitLoaded()
        return userIdSnapshot
    }

    /**
     * Call on logout: forgets the user and attribution and starts a new anonymous identity and session.
     * Queued events keep their ids. Consent belongs to the device and is kept (and recorded for the new id).
     */
    fun reset() {
        post {
            state = State(
                anonymousId = uuid(),
                installReferrer = state.installReferrer,
                installReferrerChecked = state.installReferrerChecked,
                appVersion = state.appVersion,
                appBuild = state.appBuild,
                consent = state.consent,
                deferredChecked = state.deferredChecked,
            )
            heldFirst = null
            heldLatest = null
            publish()
            persistState()
            resendConsent()
        }
    }

    fun optOut() {
        optedOut = true
    }

    fun optIn() {
        optedOut = false
        post { schedule(0) }
    }

    /** Sends everything queued now, batch after batch, and calls [callback] (on the SDK thread) with the last result. */
    @JvmOverloads
    fun flush(callback: ((FlushResult) -> Unit)? = null) {
        post {
            val r = flushNow()
            callback?.invoke(r)
        }
    }

    /** Like flush() but waits for the result. Never call it on the main thread. */
    @JvmOverloads
    fun flushBlocking(timeoutMs: Long = 60_000): FlushResult {
        val f: Future<FlushResult> = try {
            executor.submit<FlushResult> { flushNow() }
        } catch (e: RejectedExecutionException) {
            return FlushResult.Paused
        }
        return f.get(timeoutMs, TimeUnit.MILLISECONDS)
    }

    /** Number of queued events (approximate when read while calls are in flight). */
    val queueLength: Int
        get() {
            awaitIdle()
            return queueLengthSnapshot
        }

    /**
     * Install referrer from Google Play (Android). Stored once per install, attached to every event as
     * context.campaign, and its utm_* / click ids become the first touch when none was captured.
     * Pass null when the referrer is unavailable so the SDK stops asking.
     */
    fun setInstallReferrer(referrer: InstallReferrer?) {
        post {
            state.installReferrerChecked = true
            if (referrer != null && referrer.referrer.isNotEmpty()) {
                // Kept on the device so it is not asked again; sent (context.campaign) only with attribution consent.
                state.installReferrer = referrer
                parseAttribution(referrer.referrer)?.let { recordTouch(it, firstOnly = true) }
            }
            persistState()
        }
    }

    /** Calls [callback] on the SDK thread with true when this install has not looked up its install referrer yet. */
    fun checkInstallReferrerPending(callback: (Boolean) -> Unit) {
        post { callback(!state.installReferrerChecked) }
    }

    /**
     * Sends app_installed on the first launch with the SDK and app_updated when the app version or build
     * changed since the last launch. [timestampMs] should be the launch time.
     */
    @JvmOverloads
    fun trackInstallOrUpdate(appVersion: String?, appBuild: String?, timestampMs: Long = clock()) {
        post {
            val version = appVersion ?: ""
            val build = appBuild ?: ""
            val known = state.appVersion != null || state.appBuild != null
            if (!known) {
                enqueueNow(null, timestampMs, linkedMapOf("type" to "track", "event_name" to "app_installed", "properties" to linkedMapOf<String, Any?>("version" to appVersion, "build" to appBuild)))
            } else if ((state.appVersion ?: "") != version || (state.appBuild ?: "") != build) {
                enqueueNow(
                    null, timestampMs,
                    linkedMapOf(
                        "type" to "track", "event_name" to "app_updated",
                        "properties" to linkedMapOf<String, Any?>("version" to appVersion, "build" to appBuild, "previous_version" to state.appVersion, "previous_build" to state.appBuild),
                    ),
                )
            }
            state.appVersion = version
            state.appBuild = build
            persistState()
        }
    }

    /** Stops timers and the SDK thread. Queued events stay persisted and are sent by the next client. */
    @JvmOverloads
    fun shutdown(timeoutMs: Long = 5_000) {
        try {
            executor.submit { timer?.cancel(false); timer = null }.get(timeoutMs, TimeUnit.MILLISECONDS)
        } catch (e: Exception) {
            // already stopped
        }
        executor.shutdown()
        executor.awaitTermination(timeoutMs, TimeUnit.MILLISECONDS)
    }

    // ── Internals ───────────────────────────────────────────────────────────

    private fun post(fn: () -> Unit) {
        try {
            executor.execute {
                try {
                    fn()
                } catch (e: Throwable) {
                    warn("internal error", e)
                }
            }
        } catch (e: RejectedExecutionException) {
            warn("client was shut down; call ignored")
        }
    }

    private fun awaitLoaded() {
        if (Thread.currentThread() === executorThread) return
        loaded.await(2, TimeUnit.SECONDS)
    }

    /** Waits until calls made so far are applied (for accurate reads off the SDK thread). */
    private fun awaitIdle() {
        if (Thread.currentThread() === executorThread) return
        try {
            executor.submit { }.get(2, TimeUnit.SECONDS)
        } catch (e: Exception) {
            // shut down or slow: return the last snapshot
        }
    }

    private fun load() {
        try {
            val rawState = store.get(prefix + "state")
            val rawQueue = store.get(prefix + "queue")
            val s = rawState?.let { State.fromJson(Json.parse(it)) }
            // A new install still has to ask for its deferred deep link (false until answered); installs
            // from before deferred deep links existed are not new and never ask.
            state = if (s != null && s.anonymousId.isNotEmpty()) s else State(anonymousId = uuid(), deferredChecked = false)
            if (state.deferredChecked == null) state.deferredChecked = true
            queue.clear()
            val q = rawQueue?.let { Json.parse(it) }
            if (q is List<*>) {
                for (item in q) QueuedEvent.fromJson(item)?.let { queue.add(it) }
            }
        } catch (e: Exception) {
            warn("could not read persisted state; starting fresh", e)
            state = State(anonymousId = uuid(), deferredChecked = true)
            queue.clear()
        }
        // Unsent events from before a denial (e.g. the app closed mid-way) are not sent.
        queue.removeAll { it.e["type"] != "consent" && consentFor(purposeOf(it)) == ConsentStatus.DENIED }
        publish()
        persistState()
        persistQueue()
        loaded.countDown()
        if (queue.isNotEmpty()) schedule(0)
    }

    private fun publish() {
        anonymousIdSnapshot = state.anonymousId
        userIdSnapshot = state.userId
        val first = state.attributionFirst
        val latest = state.attributionLatest
        attributionSnapshot = if (first != null && latest != null) Pair(first, latest) else null
        queueLengthSnapshot = queue.size
        consentSnapshot = ConsentPurpose.ALL.associateWith { consentFor(it) }
    }

    private fun enqueue(eventId: String? = null, timestampMs: Long? = null, purpose: String = ConsentPurpose.ANALYTICS, build: () -> MutableMap<String, Any?>) {
        // Timestamp is taken at call time, not when the SDK thread gets to it.
        val at = timestampMs ?: clock()
        post { enqueueNow(eventId, at, build(), purpose) }
    }

    private fun enqueueNow(eventId: String?, at: Long, partial: MutableMap<String, Any?>, purpose: String = ConsentPurpose.ANALYTICS) {
        try {
            val status = consentFor(purpose)
            if (status == ConsentStatus.DENIED) return log("dropped (consent denied): ${partial["type"]} ${partial["event_name"] ?: ""}")
            val id = eventId ?: uuid()
            if (queue.any { it.e["event_id"] == id } || held.any { it.e["event_id"] == id }) return // duplicate call with the same event id
            val e = LinkedHashMap<String, Any?>(partial)
            e["event_id"] = id
            e["timestamp"] = Iso8601.format(at)
            e["anonymous_id"] = state.anonymousId
            e["session_id"] = touchSession(at)
            val ctx = context()
            val attr = attributionContext()
            val attrStatus = consentFor(ConsentPurpose.ATTRIBUTION)
            if (attrStatus == ConsentStatus.GRANTED) ctx.putAll(attr)
            e["context"] = ctx
            state.userId?.let { e["user_id"] = it }
            if (status == ConsentStatus.PENDING) {
                // Waiting for consent: memory only, bounded like the queue. The attribution context waits
                // too, in case attribution consent is granted by the time the event is released.
                held.add(QueuedEvent(e, clock(), if (attrStatus == ConsentStatus.PENDING && attr.isNotEmpty()) attr else null))
                if (held.size > o.maxQueueSize) held.subList(0, held.size - o.maxQueueSize).clear()
                return log("held until consent: ${e["type"]} ${e["event_name"] ?: ""}")
            }
            queue.add(QueuedEvent(e, clock()))
            if (queue.size > o.maxQueueSize) {
                val dropped = queue.size - o.maxQueueSize
                queue.subList(0, dropped).clear()
                warn("queue full: dropped $dropped oldest event(s)")
            }
            log("queued ${e["type"]} ${e["event_name"] ?: ""}")
            persistQueue()
            schedule(if (queue.size >= o.flushAt) 0 else o.flushIntervalMs)
        } catch (err: Exception) {
            warn("failed to queue event", err)
        }
    }

    private fun touchSession(at: Long): String {
        val s = state
        val last = s.lastActivity
        if (s.sessionId == null || last == null || at - last > o.sessionTimeoutMs) s.sessionId = uuid()
        s.lastActivity = maxOf(at, last ?: 0)
        persistState()
        return s.sessionId!!
    }

    private fun context(): MutableMap<String, Any?> {
        val ctx = LinkedHashMap<String, Any?>()
        try {
            ctx.putAll(contextProvider())
        } catch (e: Exception) {
            warn("context provider failed", e)
        }
        ctx.putAll(o.context)
        ctx["platform"] = o.platform
        ctx["sdk"] = linkedMapOf("name" to sdkName, "version" to sdkVersion)
        o.appVersion?.let { ctx["app_version"] = it }
        o.appBuild?.let { ctx["app_build"] = it }
        // The user's explicit answers only: a default is not consent the user gave.
        if (state.consent.isNotEmpty()) ctx["consent"] = LinkedHashMap(state.consent)
        return ctx
    }

    /** context.attribution (latest touch) and context.campaign (install referrer), before consent is applied. */
    private fun attributionContext(): Map<String, Any?> {
        val out = LinkedHashMap<String, Any?>()
        (state.attributionLatest ?: heldLatest)?.let { out["attribution"] = LinkedHashMap(it) }
        state.installReferrer?.let { out["campaign"] = it.toContext() }
        return out
    }

    private fun purposeOf(q: QueuedEvent): String = if (q.e["type"] == "push_token") ConsentPurpose.PUSH else ConsentPurpose.ANALYTICS

    private fun consentFor(purpose: String): ConsentStatus = when (state.consent[purpose]) {
        true -> ConsentStatus.GRANTED
        false -> ConsentStatus.DENIED
        null -> consentDefaults[purpose] ?: ConsentStatus.GRANTED
    }

    /** Stores a touch under attribution consent: the first is kept, the latest replaced (or only filled when [firstOnly]). */
    private fun recordTouch(touch: Map<String, String>, firstOnly: Boolean) {
        when (consentFor(ConsentPurpose.ATTRIBUTION)) {
            ConsentStatus.DENIED -> return
            ConsentStatus.PENDING -> {
                // Kept in memory until the user decides; stored only once attribution consent is granted.
                if (heldFirst == null) heldFirst = state.attributionFirst ?: touch
                if (!firstOnly || heldLatest == null) heldLatest = touch
            }
            ConsentStatus.GRANTED -> {
                if (firstOnly && state.attributionFirst != null) return
                state.attributionFirst = state.attributionFirst ?: touch
                if (!firstOnly || state.attributionLatest == null) state.attributionLatest = touch
                publish()
                persistState()
            }
        }
    }

    /** Moves or discards what was waiting for consent after the user's answer changed. */
    private fun applyConsent() {
        val attribution = consentFor(ConsentPurpose.ATTRIBUTION)
        val release = held.filter { consentFor(purposeOf(it)) == ConsentStatus.GRANTED }
        held.removeAll { consentFor(purposeOf(it)) != ConsentStatus.PENDING }
        val before = queue.size
        // Denied: unsent events of that purpose are discarded. Consent changes always stay.
        queue.removeAll { it.e["type"] != "consent" && consentFor(purposeOf(it)) == ConsentStatus.DENIED }
        if (before != queue.size) log("consent denied: discarded ${before - queue.size} unsent event(s)")
        for (q in release) {
            val attr = q.attr
            // Attribution that waited with the event goes only if attribution consent is granted now.
            val e = if (attr != null && attribution == ConsentStatus.GRANTED) {
                val ctx = LinkedHashMap(q.e["context"] as? Map<String, Any?> ?: emptyMap())
                ctx.putAll(attr)
                LinkedHashMap(q.e).also { it["context"] = ctx }
            } else {
                q.e
            }
            queue.add(QueuedEvent(e, q.queuedAt))
        }
        if (queue.size > o.maxQueueSize) queue.subList(0, queue.size - o.maxQueueSize).clear()
        if (attribution == ConsentStatus.GRANTED && (heldFirst != null || heldLatest != null)) {
            state.attributionFirst = state.attributionFirst ?: heldFirst ?: heldLatest
            heldLatest?.let { state.attributionLatest = it }
            if (state.attributionLatest == null) state.attributionLatest = state.attributionFirst
            persistState()
        }
        if (attribution != ConsentStatus.PENDING) {
            heldFirst = null
            heldLatest = null
        }
        if (attribution == ConsentStatus.DENIED && (state.attributionFirst != null || state.attributionLatest != null)) {
            state.attributionFirst = null
            state.attributionLatest = null
            persistState()
        }
        if (before != queue.size || release.isNotEmpty()) persistQueue()
        if (queue.isNotEmpty()) schedule(if (queue.size >= o.flushAt) 0 else o.flushIntervalMs)
        maybeFetchDeferred()
    }

    /** Queues a consent change for LeanApp, whatever the answer, with only the ids and minimal context. */
    private fun pushConsent(consent: Map<String, Boolean>, at: Long) {
        val ctx = linkedMapOf<String, Any?>("platform" to o.platform, "sdk" to linkedMapOf("name" to sdkName, "version" to sdkVersion))
        o.appVersion?.let { ctx["app_version"] = it }
        val e = linkedMapOf<String, Any?>(
            "type" to "consent",
            "consent" to LinkedHashMap(consent),
            "event_id" to uuid(),
            "timestamp" to Iso8601.format(at),
            "anonymous_id" to state.anonymousId,
            "context" to ctx,
        )
        state.userId?.let { e["user_id"] = it }
        queue.add(QueuedEvent(e, at))
        if (queue.size > o.maxQueueSize) {
            // Never drop a consent change to make room: drop the oldest other event instead.
            val i = queue.indexOfFirst { it.e["type"] != "consent" }
            queue.removeAt(if (i >= 0) i else 0)
        }
        log("queued consent $consent")
        persistQueue()
        schedule(0)
    }

    /** Records the device's explicit answers again for a new identity (sign-in, alias, reset). */
    private fun resendConsent() {
        if (state.consent.isNotEmpty()) pushConsent(LinkedHashMap(state.consent), clock())
    }

    private fun maybeFetchDeferred() {
        val req = deferredRequest ?: return
        if (req.running) return
        when (consentFor(ConsentPurpose.ATTRIBUTION)) {
            ConsentStatus.PENDING -> return // asked once attribution consent is granted
            ConsentStatus.DENIED -> {
                deferredRequest = null
                req.callback?.invoke(null)
                return
            }
            ConsentStatus.GRANTED -> Unit
        }
        req.running = true
        val body = linkedMapOf<String, Any?>("anonymous_id" to state.anonymousId, "platform" to o.platform)
        req.os?.let { body["os"] = it }
        req.osVersion?.let { body["os_version"] = it.take(40) }
        state.installReferrer?.let { body["install_referrer"] = it.referrer.take(2000) }
        state.attributionLatest?.get("click_id")?.let { body["click_id"] = it.take(100) }
        var result: DeferredDeepLink? = null
        try {
            val res = transport.post(
                "${o.endpoint}/v1/deep-links/deferred",
                linkedMapOf("Content-Type" to "application/json", "Authorization" to "Bearer ${o.apiKey}"),
                Json.encode(body),
            )
            if (res.ok) {
                result = DeferredDeepLink.fromJson(Json.parse(res.body))
                state.deferredChecked = true
                persistState()
            } else {
                warn("deferred deep link request failed with ${res.status}")
                // Asked again on the next launch, unless the request itself was refused as invalid.
                if (res.status == 400 || res.status == 422) {
                    state.deferredChecked = true
                    persistState()
                }
            }
        } catch (err: Exception) {
            warn("deferred deep link request failed", err)
        }
        deferredRequest = null
        try {
            req.callback?.invoke(result)
        } catch (err: Throwable) {
            warn("deferred deep link callback threw", err)
        }
    }

    private class DeferredRequest(val os: String?, val osVersion: String?, val callback: ((DeferredDeepLink?) -> Unit)?) {
        var running = false
    }

    private fun schedule(delayMs: Long) {
        if (paused || !timersEnabled) return
        val wait = maxOf(delayMs, retryAt - clock(), 0L)
        val t = timer
        if (t != null && !t.isDone) {
            if (wait > 0) return // a send is already scheduled
            t.cancel(false)
        }
        timer = try {
            executor.schedule({
                timer = null
                try {
                    val r = sendBatch(false)
                    if (r is FlushResult.Sent && queue.isNotEmpty()) schedule(if (queue.size >= o.flushAt) 0 else o.flushIntervalMs)
                } catch (e: Throwable) {
                    warn("send failed", e)
                }
            }, wait, TimeUnit.MILLISECONDS)
        } catch (e: RejectedExecutionException) {
            null
        }
    }

    private fun flushNow(): FlushResult {
        var last: FlushResult = FlushResult.Empty
        // Bounded: each round either removes events or stops.
        for (i in 0 until 1000) {
            val r = sendBatch(true)
            if (r is FlushResult.Sent) {
                last = r
                if (queue.isNotEmpty()) continue
                return r
            }
            return if (r == FlushResult.Empty && last is FlushResult.Sent) last else r
        }
        return last
    }

    private fun sendBatch(manual: Boolean): FlushResult {
        if (paused) return FlushResult.Unauthorized
        if (optedOut) return FlushResult.Paused
        val now = clock()
        if (!manual && now < retryAt) {
            schedule(retryAt - now)
            return FlushResult.Retry(retryAt - now, "backoff")
        }
        val before = queue.size
        queue.removeAll { now - it.queuedAt > o.eventTtlMs }
        if (queue.size != before) {
            warn("dropped ${before - queue.size} expired event(s)")
            persistQueue()
        }
        if (queue.isEmpty()) return FlushResult.Empty

        val batch = ArrayList(queue.subList(0, minOf(maxBatchSize, queue.size)))
        val body = Json.encode(linkedMapOf("batch" to batch.map { it.e }, "sent_at" to Iso8601.format(clock())))
        val headers = linkedMapOf(
            "Content-Type" to "application/json",
            "Authorization" to "Bearer ${o.apiKey}",
        )
        // Same events → same key, so a retried request is answered from the server's idempotency store.
        if (!skipIdempotencyKey) headers["Idempotency-Key"] = idempotencyKey(batch.map { it.e["event_id"].toString() })
        skipIdempotencyKey = false
        val res: HttpResponse = try {
            transport.post("${o.endpoint}/v1/events/batch", headers, body)
        } catch (err: Exception) {
            return backoff(null, err.message ?: "network error")
        }

        if (res.ok) {
            val parsed = try { Json.parse(res.body) as? Map<*, *> } catch (e: Exception) { null } ?: emptyMap<String, Any?>()
            val rejected = parsed["rejected"] as? List<*> ?: emptyList<Any?>()
            for (r in rejected) {
                val rm = r as? Map<*, *> ?: continue
                val idx = (rm["index"] as? Number)?.toInt() ?: continue
                val ev = batch.getOrNull(idx)?.e
                warn("event rejected by server: ${ev?.get("event_name") ?: ev?.get("type")} ${rm["errors"]}")
            }
            remove(batch)
            failures = 0
            retryAt = 0
            return FlushResult.Sent(
                accepted = (parsed["accepted"] as? Number)?.toInt() ?: 0,
                duplicates = (parsed["duplicates"] as? Number)?.toInt() ?: 0,
                rejected = rejected.size,
            )
        }
        if (res.status == 401 || res.status == 403) {
            // Revoked or wrong key: keep events, stop sending until the app restarts with a valid key.
            paused = true
            warn("API key rejected (revoked, expired or wrong environment). Events are kept but not sent.")
            return FlushResult.Unauthorized
        }
        if (res.status == 409) {
            // idempotency_key_reused: nothing was stored. Keep the events and resend them without a key;
            // their event ids still make the resend safe.
            skipIdempotencyKey = true
            return backoff(0, "idempotency key already used for other events; resending without it")
        }
        if (res.status == 413 && batch.size > 1) {
            maxBatchSize = maxOf(1, batch.size / 2)
            return backoff(0, "payload too large; splitting batch")
        }
        if (res.status == 400 || res.status == 413 || res.status == 422) {
            // The batch itself is malformed: retrying cannot succeed.
            warn("server refused batch (${res.status}); dropping ${batch.size} event(s): ${res.body.take(500)}")
            remove(batch)
            return FlushResult.Sent(0, 0, batch.size)
        }
        val retryAfter = res.header("Retry-After")?.trim()?.toDoubleOrNull()
        return backoff(if (retryAfter != null && retryAfter > 0) (retryAfter * 1000).toLong() else null, "HTTP ${res.status}")
    }

    private fun backoff(explicitMs: Long?, reason: String): FlushResult {
        failures++
        val exp = minOf(MAX_BACKOFF_MS, BASE_BACKOFF_MS * (1L shl minOf(failures - 1, 16)))
        val wait = explicitMs ?: Math.round(exp / 2.0 + random() * (exp / 2.0)) // jittered
        retryAt = clock() + wait
        log("send failed ($reason); retrying in ${wait}ms")
        schedule(wait)
        return FlushResult.Retry(wait, reason)
    }

    private fun remove(sent: List<QueuedEvent>) {
        val ids = sent.map { it.e["event_id"] }.toHashSet()
        queue.removeAll { it.e["event_id"] in ids }
        persistQueue()
    }

    private fun persistQueue() {
        queueLengthSnapshot = queue.size
        try {
            store.set(prefix + "queue", Json.encode(queue.map { it.toJson() }))
        } catch (e: Exception) {
            warn("storage write failed", e)
        }
    }

    private fun persistState() {
        try {
            store.set(prefix + "state", Json.encode(state.toJson()))
        } catch (e: Exception) {
            warn("storage write failed", e)
        }
    }

    private fun log(msg: String) {
        if (o.debug) logger.log(msg)
    }

    private fun warn(msg: String, err: Throwable? = null) {
        if (o.debug) logger.warn(msg, err)
    }

    /** [attr]: memory only, on events held for consent: the attribution context to add if attribution consent is granted by then. */
    internal class QueuedEvent(val e: Map<String, Any?>, val queuedAt: Long, val attr: Map<String, Any?>? = null) {
        fun toJson(): Map<String, Any?> = linkedMapOf("e" to e, "queuedAt" to queuedAt)

        companion object {
            @Suppress("UNCHECKED_CAST")
            fun fromJson(v: Any?): QueuedEvent? {
                val m = v as? Map<String, Any?> ?: return null
                val e = m["e"] as? Map<String, Any?> ?: return null
                if (e["event_id"] !is String) return null
                return QueuedEvent(e, (m["queuedAt"] as? Number)?.toLong() ?: 0L)
            }
        }
    }

    /** Persisted identity. Field names match the JavaScript SDK's state, plus native-only fields. */
    internal class State(
        var anonymousId: String,
        var userId: String? = null,
        var sessionId: String? = null,
        var lastActivity: Long? = null,
        var attributionFirst: Map<String, String>? = null,
        var attributionLatest: Map<String, String>? = null,
        var installReferrer: InstallReferrer? = null,
        var installReferrerChecked: Boolean = false,
        var appVersion: String? = null,
        var appBuild: String? = null,
        /** The user's explicit answers (setConsent). Purposes not here follow the configured default. */
        var consent: Map<String, Boolean> = emptyMap(),
        /** false: a new install that still has to ask for its deferred deep link; null: an install from before they existed. */
        var deferredChecked: Boolean? = null,
    ) {
        fun toJson(): Map<String, Any?> {
            val m = linkedMapOf<String, Any?>("anonymousId" to anonymousId)
            userId?.let { m["userId"] = it }
            sessionId?.let { m["sessionId"] = it }
            lastActivity?.let { m["lastActivity"] = it }
            if (attributionFirst != null && attributionLatest != null) m["attribution"] = linkedMapOf("first" to attributionFirst, "latest" to attributionLatest)
            installReferrer?.let {
                m["installReferrer"] = linkedMapOf(
                    "referrer" to it.referrer,
                    "clickTs" to it.referrerClickTimestampSeconds,
                    "installTs" to it.installBeginTimestampSeconds,
                    "instant" to it.googlePlayInstant,
                )
            }
            if (installReferrerChecked) m["installReferrerChecked"] = true
            appVersion?.let { m["appVersion"] = it }
            appBuild?.let { m["appBuild"] = it }
            if (consent.isNotEmpty()) m["consent"] = LinkedHashMap(consent)
            deferredChecked?.let { m["deferredChecked"] = it }
            return m
        }

        companion object {
            @Suppress("UNCHECKED_CAST")
            fun fromJson(v: Any?): State? {
                val m = v as? Map<String, Any?> ?: return null
                val anon = m["anonymousId"] as? String ?: return null
                val attr = m["attribution"] as? Map<String, Any?>
                val ir = m["installReferrer"] as? Map<String, Any?>
                return State(
                    anonymousId = anon,
                    userId = m["userId"] as? String,
                    sessionId = m["sessionId"] as? String,
                    lastActivity = (m["lastActivity"] as? Number)?.toLong(),
                    attributionFirst = strings(attr?.get("first")),
                    attributionLatest = strings(attr?.get("latest")),
                    installReferrer = ir?.let {
                        InstallReferrer(
                            referrer = it["referrer"] as? String ?: "",
                            referrerClickTimestampSeconds = (it["clickTs"] as? Number)?.toLong() ?: 0,
                            installBeginTimestampSeconds = (it["installTs"] as? Number)?.toLong() ?: 0,
                            googlePlayInstant = it["instant"] as? Boolean ?: false,
                        )
                    },
                    installReferrerChecked = m["installReferrerChecked"] as? Boolean ?: false,
                    appVersion = m["appVersion"] as? String,
                    appBuild = m["appBuild"] as? String,
                    consent = (m["consent"] as? Map<*, *>)
                        ?.entries?.filter { it.key is String && it.value is Boolean }
                        ?.associate { it.key as String to it.value as Boolean } ?: emptyMap(),
                    deferredChecked = m["deferredChecked"] as? Boolean,
                )
            }

            private fun strings(v: Any?): Map<String, String>? {
                val m = v as? Map<*, *> ?: return null
                val out = LinkedHashMap<String, String>()
                for ((k, x) in m) if (k is String && x is String) out[k] = x
                return out
            }
        }
    }
}

/** Locale, language, timezone and OS from the JVM. The Android module adds device and screen. */
fun defaultContext(): Map<String, Any?> {
    val ctx = LinkedHashMap<String, Any?>()
    val locale = java.util.Locale.getDefault()
    val tag = if (locale.country.isNullOrEmpty()) locale.language else "${locale.language}-${locale.country}"
    if (tag.isNotEmpty()) {
        ctx["locale"] = tag
        ctx["language"] = locale.language
    }
    ctx["timezone"] = java.util.TimeZone.getDefault().id
    return ctx
}
