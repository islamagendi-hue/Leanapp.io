package io.leanapp.analytics

import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import java.io.IOException
import java.util.concurrent.TimeUnit

private const val KEY = "la_pk_dev_abcdefghijklmnopqrstuvwx"

@Suppress("UNCHECKED_CAST")
class LeanAppClientTest {
    private lateinit var server: MockWebServer
    private val clients = ArrayList<LeanAppClient>()
    private var t = 1_791_194_400_000L // 2026-10-05T10:00:00Z
    private var id = 0

    @Before fun start() {
        server = MockWebServer()
        server.start()
    }

    @After fun stop() {
        clients.forEach { it.shutdown() }
        server.shutdown()
    }

    private fun ok(n: Int? = null) = MockResponse().setResponseCode(200).setBody(
        if (n == null) """{"accepted":0,"duplicates":0,"rejected":[]}""" else """{"accepted":$n,"duplicates":0,"rejected":[]}""",
    )

    private fun make(
        store: KeyValueStore = InMemoryStore(),
        transport: HttpTransport = UrlConnectionTransport(),
        endpoint: String = server.url("/").toString(),
        flushAt: Int = 1000,
        maxBatchSize: Int = 100,
        maxQueueSize: Int = 1000,
        eventTtlMs: Long = 7L * 86_400_000,
        optedOut: Boolean = false,
        timers: Boolean = false,
    ): LeanAppClient {
        val c = LeanAppClient(
            LeanAppConfig(
                apiKey = KEY, endpoint = endpoint, platform = "android", appVersion = "2.3.0",
                flushAt = flushAt, flushIntervalMs = 60_000, maxBatchSize = maxBatchSize, maxQueueSize = maxQueueSize,
                eventTtlMs = eventTtlMs, optedOut = optedOut,
            ),
            store = store,
            transport = transport,
            contextProvider = { mapOf("locale" to "ar-SA", "os_version" to "14") },
            clock = { t },
            uuid = { "id-${++id}" },
            random = { 0.5 },
            timersEnabled = timers,
        )
        clients.add(c)
        return c
    }

    private fun body(): Map<String, Any?> = Json.parse(server.takeRequest(5, TimeUnit.SECONDS)!!.body.readUtf8()) as Map<String, Any?>
    private fun batchOf(b: Map<String, Any?>) = b["batch"] as List<Map<String, Any?>>

    // ── configuration ──

    @Test fun rejectsKeysThatAreNotLeanAppKeys() {
        try {
            LeanAppClient(LeanAppConfig(apiKey = "sk_live_123"))
            fail()
        } catch (e: IllegalArgumentException) {
            assertTrue(e.message!!.contains("la_pk_"))
        }
    }

    @Test fun refusesSecretKeyOutsideServer() {
        try {
            LeanAppClient(LeanAppConfig(apiKey = "la_sk_dev_" + "x".repeat(40)))
            fail()
        } catch (e: IllegalArgumentException) {
            assertTrue(e.message!!.contains("servers only"))
        }
        LeanAppClient(LeanAppConfig(apiKey = "la_sk_dev_" + "x".repeat(40), platform = "backend")).shutdown()
    }

    @Test fun storageNamespaceIsKindAndEnvironment() {
        assertEquals("leanapp:la_pk_live:", storagePrefix("la_pk_live_" + "a".repeat(24)))
        assertEquals("leanapp:la_pk_dev:", storagePrefix(KEY))
    }

    @Test fun defaultsToTheLeanAppApi() {
        var url = ""
        val transport = object : HttpTransport {
            override fun post(url: String, headers: Map<String, String>, body: String): HttpResponse {
                captured(url)
                return HttpResponse(200, emptyMap(), "{}")
            }
            fun captured(u: String) { url = u }
        }
        val c = make(transport = transport, endpoint = LeanAppConfig.DEFAULT_ENDPOINT)
        c.track("app_opened")
        c.flushBlocking()
        assertEquals("https://api.leanapp.io/v1/events/batch", url)
    }

    // ── events ──

    @Test fun sendsBatchedEventsWithIdentitySessionAndContext() {
        server.enqueue(ok(4))
        val c = make(endpoint = server.url("/").toString() + "/")
        c.track("product_viewed", mapOf("product_id" to "p1"))
        c.screen("Home")
        c.identify("u-42", mapOf("city" to "Riyadh"))
        c.track("order_completed", mapOf("order_id" to "o1", "revenue" to 45.0, "currency" to "SAR"), eventId = "order-o1")
        assertEquals(FlushResult.Sent(4, 0, 0), c.flushBlocking())

        val req = server.takeRequest(5, TimeUnit.SECONDS)!!
        assertEquals("/v1/events/batch", req.path)
        assertEquals("POST", req.method)
        assertEquals("Bearer $KEY", req.getHeader("Authorization"))
        assertEquals("application/json", req.getHeader("Content-Type"))
        assertEquals("id-2:4", req.getHeader("Idempotency-Key")) // first event id : batch size
        val b = Json.parse(req.body.readUtf8()) as Map<String, Any?>
        assertNotNull(b["sent_at"])
        val (view, screen, identify, order) = batchOf(b)
        assertEquals("track", view["type"])
        assertEquals("product_viewed", view["event_name"])
        assertEquals(mapOf("product_id" to "p1"), view["properties"])
        assertEquals("id-1", view["anonymous_id"])
        assertFalse(view.containsKey("user_id"))
        assertEquals("2026-10-05T10:00:00.000Z", view["timestamp"])
        val ctx = view["context"] as Map<String, Any?>
        assertEquals("android", ctx["platform"])
        assertEquals("2.3.0", ctx["app_version"])
        assertEquals("ar-SA", ctx["locale"])
        assertEquals(mapOf("name" to "leanapp-android", "version" to SDK_VERSION), ctx["sdk"])
        assertEquals("screen", screen["type"])
        assertEquals("Home", screen["event_name"])
        assertEquals(mapOf("screen_name" to "Home"), screen["properties"])
        assertEquals("identify", identify["type"])
        assertEquals("u-42", identify["user_id"])
        assertEquals(mapOf("city" to "Riyadh"), identify["user_properties"])
        assertEquals("order-o1", order["event_id"])
        assertEquals("u-42", order["user_id"])
        assertEquals(45L, (order["properties"] as Map<String, Any?>)["revenue"])
        assertEquals(1, batchOf(b).map { it["session_id"] }.toSet().size)
        assertEquals(0, c.queueLength)
    }

    @Test fun ignoresSecondEventWithSameIdWhileQueued() {
        val c = make()
        c.track("order_completed", mapOf("order_id" to "o1"), eventId = "order-o1")
        c.track("order_completed", mapOf("order_id" to "o1"), eventId = "order-o1")
        assertEquals(1, c.queueLength)
    }

    @Test fun startsNewSessionAfterThirtyMinutes() {
        server.enqueue(ok())
        val c = make()
        c.track("a")
        c.queueLength
        t += 29 * 60_000
        c.track("b")
        c.queueLength
        t += 31 * 60_000
        c.track("c")
        c.flushBlocking()
        val (a, b, cc) = batchOf(body())
        assertEquals(a["session_id"], b["session_id"])
        assertNotEquals(b["session_id"], cc["session_id"])
    }

    @Test fun splitsLargeQueuesIntoBatches() {
        repeat(3) { server.enqueue(ok()) }
        val c = make(maxBatchSize = 2)
        for (i in 0 until 5) c.track("e$i")
        c.flushBlocking()
        assertEquals(listOf(2, 2, 1), (0 until 3).map { batchOf(body()).size })
    }

    @Test fun resetForgetsUserAndStartsNewAnonymousId() {
        server.enqueue(ok())
        val c = make()
        c.identify("u-1")
        c.reset()
        c.track("app_opened")
        c.flushBlocking()
        val batch = batchOf(body())
        assertFalse(batch.last().containsKey("user_id"))
        assertNotEquals(batch.first()["anonymous_id"], batch.last()["anonymous_id"])
        assertNull(c.getUserId())
    }

    @Test fun registersPushTokensAndAliases() {
        server.enqueue(ok())
        val c = make()
        c.registerPushToken("fcm-token-1234567890", "fcm", "granted")
        c.alias("u-9", "guest-1")
        c.flushBlocking()
        val (push, alias) = batchOf(body())
        assertEquals("push_token", push["type"])
        assertEquals(mapOf("token" to "fcm-token-1234567890", "provider" to "fcm", "permission" to "granted"), push["push_token"])
        assertEquals("alias", alias["type"])
        assertEquals("guest-1", alias["previous_id"])
        assertEquals("u-9", alias["user_id"])
    }

    // ── delivery ──

    @Test fun keepsEventsOfflineRetriesWithBackoffAndSurvivesRestart() {
        val store = InMemoryStore()
        var online = false
        val calls = ArrayList<Pair<Map<String, String>, Map<String, Any?>>>()
        val transport = object : HttpTransport {
            override fun post(url: String, headers: Map<String, String>, body: String): HttpResponse {
                calls.add(headers to (Json.parse(body) as Map<String, Any?>))
                if (!online) throw IOException("Network request failed")
                return HttpResponse(200, emptyMap(), """{"accepted":2,"duplicates":0,"rejected":[]}""")
            }
        }
        val first = make(store = store, transport = transport)
        first.track("app_opened")
        first.track("product_viewed")
        assertEquals(FlushResult.Retry(750, "Network request failed"), first.flushBlocking()) // 1s base, jittered to 75%
        assertEquals(1500L, (first.flushBlocking() as FlushResult.Retry).retryInMs)
        assertEquals(2, first.queueLength)
        first.shutdown()

        online = true
        val second = make(store = store, transport = transport)
        assertEquals(FlushResult.Sent(2, 0, 0), second.flushBlocking())
        val sent = batchOf(calls.last().second)
        assertEquals(listOf("app_opened", "product_viewed"), sent.map { it["event_name"] })
        // Same ids as the failed attempts, so the server de-duplicates if one of them actually landed.
        assertEquals(batchOf(calls[0].second).map { it["event_id"] }, sent.map { it["event_id"] })
        assertEquals(calls[0].first["Idempotency-Key"], calls.last().first["Idempotency-Key"])
        assertEquals(first.getAnonymousId(), second.getAnonymousId())
    }

    @Test fun honoursRetryAfterOn429() {
        server.enqueue(MockResponse().setResponseCode(429).setHeader("Retry-After", "7").setBody("""{"error":"rate_limited"}"""))
        val c = make()
        c.track("a")
        assertEquals(FlushResult.Retry(7000, "HTTP 429"), c.flushBlocking())
        assertEquals(1, c.queueLength)
    }

    @Test fun backsOffOnServerErrors() {
        server.enqueue(MockResponse().setResponseCode(503))
        val c = make()
        c.track("a")
        assertEquals(FlushResult.Retry(750, "HTTP 503"), c.flushBlocking())
        assertEquals(1, c.queueLength)
    }

    @Test fun stopsSendingButKeepsEventsWhenKeyIsRevoked() {
        server.enqueue(MockResponse().setResponseCode(401).setBody("""{"error":"invalid_api_key"}"""))
        val c = make()
        c.track("a")
        assertEquals(FlushResult.Unauthorized, c.flushBlocking())
        assertEquals(FlushResult.Unauthorized, c.flushBlocking())
        assertEquals(1, server.requestCount)
        assertEquals(1, c.queueLength)
    }

    @Test fun halvesTheBatchOn413() {
        server.enqueue(MockResponse().setResponseCode(413))
        server.enqueue(ok())
        server.enqueue(ok())
        val c = make(maxBatchSize = 4)
        for (i in 0 until 4) c.track("e$i")
        val r = c.flushBlocking()
        assertEquals(FlushResult.Retry(0, "payload too large; splitting batch"), r)
        assertEquals(4, batchOf(body()).size)
        c.flushBlocking()
        assertEquals(2, batchOf(body()).size)
        assertEquals(2, batchOf(body()).size)
        assertEquals(0, c.queueLength)
    }

    @Test fun dropsMalformedBatchInsteadOfRetryingForever() {
        server.enqueue(MockResponse().setResponseCode(400).setBody("""{"error":"invalid_batch"}"""))
        val c = make()
        c.track("a")
        c.flushBlocking()
        assertEquals(0, c.queueLength)
    }

    @Test fun removesIndividuallyRejectedEventsWithAcceptedOnes() {
        server.enqueue(MockResponse().setResponseCode(200).setBody("""{"accepted":1,"duplicates":0,"rejected":[{"index":0,"errors":[{"field":"timestamp","message":"too old"}]}]}"""))
        val c = make()
        c.track("a")
        c.track("b")
        assertEquals(FlushResult.Sent(1, 0, 1), c.flushBlocking())
        assertEquals(0, c.queueLength)
    }

    @Test fun capsTheQueueAndExpiresOldEvents() {
        server.enqueue(ok())
        val c = make(maxQueueSize = 10, eventTtlMs = 60_000)
        for (i in 0 until 15) c.track("e$i")
        assertEquals(10, c.queueLength)
        t += 61_000
        c.track("fresh")
        c.flushBlocking()
        assertEquals(listOf("fresh"), batchOf(body()).map { it["event_name"] })
    }

    @Test fun doesNotSendWhileOptedOut() {
        val c = make(optedOut = true)
        c.track("a")
        assertEquals(FlushResult.Paused, c.flushBlocking())
        assertEquals(0, server.requestCount)
    }

    @Test fun flushesAutomaticallyOnceFlushAtEventsAreQueued() {
        server.enqueue(ok())
        val c = make(flushAt = 3, timers = true)
        c.track("a")
        c.track("b")
        assertNull(server.takeRequest(300, TimeUnit.MILLISECONDS))
        c.track("c")
        assertEquals(3, batchOf(body()).size)
    }

    @Test fun persistsTheQueueOnDisk() {
        val dir = createTempDir()
        try {
            val first = make(store = FileStore(dir))
            first.track("offline_event")
            first.queueLength
            first.shutdown()
            server.enqueue(ok())
            val second = make(store = FileStore(dir))
            second.flushBlocking()
            assertEquals(listOf("offline_event"), batchOf(body()).map { it["event_name"] })
        } finally {
            dir.deleteRecursively()
        }
    }

    // ── attribution, install referrer, lifecycle ──

    @Test fun parsesCampaignParametersAndClickIds() {
        assertEquals(
            mapOf("utm_source" to "tiktok", "utm_campaign" to "ramadan sale", "ttclid" to "abc"),
            parseAttribution("myapp://open?utm_source=tiktok&utm_campaign=ramadan%20sale&ttclid=abc&foo=1"),
        )
        assertEquals(mapOf("ScCid" to "snap1"), parseAttribution("https://x.test/?sccid=snap1"))
        assertNull(parseAttribution("https://x.test/home"))
        assertEquals(mapOf("utm_source" to "google-play", "gclid" to "g1"), parseAttribution("utm_source=google-play&gclid=g1"))
    }

    @Test fun keepsFirstTouchAndAttachesLatestWithDeepLink() {
        server.enqueue(ok())
        val c = make()
        c.captureAttribution("https://leanapp.io/l?utm_source=snapchat&ScCid=s1")
        c.captureAttribution("myapp://p?utm_source=tiktok&ttclid=t1")
        c.track("app_opened")
        c.flushBlocking()
        val latest = mapOf("utm_source" to "tiktok", "ttclid" to "t1", "deep_link_url" to "myapp://p?utm_source=tiktok&ttclid=t1")
        assertEquals(mapOf("utm_source" to "snapchat", "ScCid" to "s1", "deep_link_url" to "https://leanapp.io/l?utm_source=snapchat&ScCid=s1"), c.getAttribution()!!.first)
        assertEquals(latest, c.getAttribution()!!.second)
        assertEquals(latest, (batchOf(body())[0]["context"] as Map<String, Any?>)["attribution"])
    }

    @Test fun sendsInstallReferrerAsCampaignContext() {
        server.enqueue(ok())
        val c = make()
        var pending: Boolean? = null
        c.checkInstallReferrerPending { pending = it }
        c.setInstallReferrer(InstallReferrer("utm_source=google&click_id=lac_123&gclid=g1", 1_700_000_000, 1_700_000_100, false))
        c.trackInstallOrUpdate("2.3.0", "230")
        c.flushBlocking()
        assertEquals(true, pending)
        val e = batchOf(body())[0]
        assertEquals("app_installed", e["event_name"])
        val ctx = e["context"] as Map<String, Any?>
        assertEquals(
            mapOf(
                "install_referrer" to "utm_source=google&click_id=lac_123&gclid=g1",
                "referrer_click_timestamp_seconds" to 1_700_000_000L,
                "install_begin_timestamp_seconds" to 1_700_000_100L,
                "google_play_instant" to false,
            ),
            ctx["campaign"],
        )
        assertEquals(mapOf("utm_source" to "google", "gclid" to "g1", "click_id" to "lac_123"), ctx["attribution"])
        c.checkInstallReferrerPending { pending = it }
        c.queueLength
        assertEquals(false, pending)
    }

    @Test fun tracksInstallOnceThenUpdatesOnVersionChange() {
        repeat(2) { server.enqueue(ok()) }
        val store = InMemoryStore()
        val first = make(store = store)
        first.trackInstallOrUpdate("1.0", "10")
        first.trackInstallOrUpdate("1.0", "10")
        first.flushBlocking()
        assertEquals(listOf("app_installed"), batchOf(body()).map { it["event_name"] })
        first.shutdown()
        val second = make(store = store)
        second.trackInstallOrUpdate("1.1", "11")
        second.flushBlocking()
        val e = batchOf(body()).single()
        assertEquals("app_updated", e["event_name"])
        assertEquals(mapOf("version" to "1.1", "build" to "11", "previous_version" to "1.0", "previous_build" to "10"), e["properties"])
    }

    @Test fun neverThrowsAfterShutdown() {
        val c = make()
        c.shutdown()
        c.track("late")
        c.flush()
        assertEquals(FlushResult.Paused, c.flushBlocking())
    }

    @Suppress("DEPRECATION")
    private fun createTempDir() = kotlin.io.createTempDir("leanapp")
}
