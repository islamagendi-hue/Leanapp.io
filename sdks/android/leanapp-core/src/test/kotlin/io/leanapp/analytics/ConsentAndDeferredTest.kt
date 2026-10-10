package io.leanapp.analytics

import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

private const val KEY = "la_pk_dev_abcdefghijklmnopqrstuvwx"

@Suppress("UNCHECKED_CAST")
class ConsentAndDeferredTest {
    private lateinit var server: MockWebServer
    private val clients = ArrayList<LeanAppClient>()
    private val batches = CopyOnWriteArrayList<List<Map<String, Any?>>>()
    private val deferredBodies = CopyOnWriteArrayList<Map<String, Any?>>()
    private var deferredResponses = ArrayList<MockResponse>()
    private var id = 0

    private val match = """{"match_type":"deterministic","match_key":"install_referrer","link":{"code":"abcd1234","name":"Ramadan"},""" +
        """"deep_link":{"path":"/product/42","params":{"ref":"ad"},"url":"/product/42?ref=ad"},""" +
        """"campaign":{"source":"google","medium":"cpc","campaign":"ramadan","ad_group":null,"creative":null},"click_id":"lac_abcdefgh12","is_deferred":true}"""

    @Before fun start() {
        server = MockWebServer()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val body = Json.parse(request.body.readUtf8()) as Map<String, Any?>
                return if (request.path!!.endsWith("/v1/deep-links/deferred")) {
                    deferredBodies.add(body)
                    synchronized(deferredResponses) { if (deferredResponses.isEmpty()) MockResponse().setBody(match) else deferredResponses.removeAt(0) }
                } else {
                    val batch = body["batch"] as List<Map<String, Any?>>
                    batches.add(batch)
                    MockResponse().setBody("""{"accepted":${batch.size},"duplicates":0,"rejected":[]}""")
                }
            }
        }
        server.start()
    }

    @After fun stop() {
        clients.forEach { it.shutdown() }
        server.shutdown()
    }

    private fun make(
        store: KeyValueStore = InMemoryStore(),
        consentDefault: ConsentStatus = ConsentStatus.GRANTED,
        consentDefaults: Map<String, ConsentStatus> = emptyMap(),
        deferred: Boolean = true,
    ): LeanAppClient {
        val c = LeanAppClient(
            LeanAppConfig(
                apiKey = KEY, endpoint = server.url("/").toString(), platform = "android", appVersion = "2.3.0",
                flushAt = 1000, flushIntervalMs = 60_000, consentDefault = consentDefault, consentDefaults = consentDefaults,
                deferredDeepLinks = deferred,
            ),
            store = store,
            contextProvider = { mapOf("locale" to "ar-SA") },
            clock = { 1_791_194_400_000L },
            uuid = { "id-${++id}" },
            random = { 0.5 },
            timersEnabled = false,
        )
        clients.add(c)
        return c
    }

    private fun sent(): List<Map<String, Any?>> = batches.flatten()
    private fun names(): List<Any?> = sent().map { if (it["type"] == "track") it["event_name"] else it["type"] }
    private fun ctx(e: Map<String, Any?>) = e["context"] as Map<String, Any?>

    private fun deferred(c: LeanAppClient, os: String? = "android"): DeferredDeepLink? {
        val latch = CountDownLatch(1)
        var result: DeferredDeepLink? = null
        c.requestDeferredDeepLink(os, "14") { result = it; latch.countDown() }
        assertTrue(latch.await(5, TimeUnit.SECONDS))
        return result
    }

    // ── consent ──

    @Test fun defaultsToGrantedSoAppsThatNeverAskBehaveAsBefore() {
        val c = make()
        assertEquals(ConsentPurpose.ALL.associateWith { ConsentStatus.GRANTED }, c.getConsent())
        c.track("a")
        c.flushBlocking()
        assertEquals(listOf("a"), names())
        assertNull(ctx(sent()[0])["consent"])
    }

    @Test fun pendingHoldsEventsInMemoryThenSendsThemOnceAnalyticsIsGranted() {
        val store = InMemoryStore()
        val c = make(store = store, consentDefault = ConsentStatus.PENDING)
        c.track("a")
        c.screen("Home")
        assertEquals(0, c.queueLength)
        assertEquals(FlushResult.Empty, c.flushBlocking())
        // Nothing waiting for consent is written to the device.
        assertFalse(store.get("leanapp:la_pk_dev:queue")!!.contains("\"a\""))
        c.setConsent(mapOf("analytics" to true))
        c.flushBlocking()
        assertEquals(listOf("consent", "a", "screen"), names())
        assertEquals(mapOf("analytics" to true), sent()[0]["consent"])
        assertNull(ctx(sent()[1])["consent"]) // queued before the answer
        c.track("b")
        c.flushBlocking()
        assertEquals(mapOf("analytics" to true), ctx(sent().last())["consent"])
        assertEquals(ConsentStatus.GRANTED, c.getConsent()["analytics"])
        assertEquals(ConsentStatus.PENDING, c.getConsent()["marketing"])
    }

    @Test fun deniedDiscardsHeldAndQueuedEventsButStillSendsTheConsentChange() {
        val c = make(consentDefaults = mapOf("analytics" to ConsentStatus.PENDING))
        c.track("held")
        c.registerPushToken("t".repeat(20), "fcm") // push is granted: queued
        c.setConsent(mapOf("analytics" to false))
        c.track("after")
        c.flushBlocking()
        assertEquals(listOf("push_token", "consent"), names())
    }

    @Test fun persistsTheAnswerAndPurgesUnsentEventsOnLoadAfterADenial() {
        val store = InMemoryStore()
        val first = make(store = store)
        first.track("queued_before")
        first.queueLength
        // Simulate a denial recorded on disk while the event was still queued (the app closed mid-way).
        val state = Json.parse(store.get("leanapp:la_pk_dev:state")!!) as Map<String, Any?>
        first.shutdown()
        store.set("leanapp:la_pk_dev:state", Json.encode(LinkedHashMap(state).also { it["consent"] = mapOf("analytics" to false) }))
        val second = make(store = store)
        assertEquals(ConsentStatus.DENIED, second.getConsent()["analytics"])
        assertEquals(0, second.queueLength)
    }

    @Test fun attributionIsASeparatePurposeAndWaitsWithHeldEvents() {
        val c = make(consentDefault = ConsentStatus.PENDING)
        c.captureAttribution("myapp://p?utm_source=tiktok&ttclid=t1")
        c.track("a")
        assertNull(c.getAttribution())
        c.setConsent(mapOf("analytics" to true, "attribution" to true))
        c.track("b")
        c.flushBlocking()
        val (a, b) = sent().filter { it["type"] == "track" }
        assertEquals("tiktok", (ctx(a)["attribution"] as Map<String, Any?>)["utm_source"])
        assertEquals("tiktok", (ctx(b)["attribution"] as Map<String, Any?>)["utm_source"])
        assertEquals("tiktok", c.getAttribution()!!.first["utm_source"])
    }

    @Test fun analyticsWithoutAttributionSendsEventsWithoutAttributionOrCampaign() {
        val c = make(consentDefaults = mapOf("attribution" to ConsentStatus.PENDING))
        c.setInstallReferrer(InstallReferrer("utm_source=google&gclid=g1"))
        c.captureAttribution("myapp://p?utm_source=tiktok")
        c.track("a")
        c.flushBlocking()
        val a = sent().single { it["event_name"] == "a" }
        assertNull(ctx(a)["attribution"])
        assertNull(ctx(a)["campaign"])
        c.setConsent(mapOf("attribution" to false))
        c.track("b")
        c.flushBlocking()
        assertNull(ctx(sent().single { it["event_name"] == "b" })["attribution"])
        assertNull(c.getAttribution())
    }

    @Test fun recordsTheDevicesConsentForAUserWhoSignsInAndAfterReset() {
        val c = make()
        c.setConsent(mapOf("marketing" to false))
        c.identify("u-1")
        c.identify("u-1") // same user: not resent
        c.reset()
        c.flushBlocking()
        val consents = sent().filter { it["type"] == "consent" }
        assertEquals(3, consents.size)
        assertNull(consents[0]["user_id"])
        assertEquals("u-1", consents[1]["user_id"])
        assertNull(consents[2]["user_id"])
        assertTrue(consents[2]["anonymous_id"] != consents[0]["anonymous_id"])
        assertEquals(ConsentStatus.DENIED, c.getConsent()["marketing"])
    }

    @Test fun pushTokensFollowPushConsent() {
        val c = make(consentDefaults = mapOf("push" to ConsentStatus.DENIED))
        c.registerPushToken("t".repeat(20), "fcm")
        c.track("a")
        c.flushBlocking()
        assertEquals(listOf("a"), names())
    }

    @Test fun ignoresSetConsentWithoutAKnownPurpose() {
        val c = make()
        c.setConsent(mapOf("ads" to true))
        c.flushBlocking()
        assertTrue(names().isEmpty())
    }

    // ── deferred deep links ──

    @Test fun asksOncePerNewInstallWithTheInstallReferrer() {
        val store = InMemoryStore()
        val c = make(store = store)
        c.setInstallReferrer(InstallReferrer("utm_source=google&click_id=lac_abcdefgh12"))
        val r = deferred(c)!!
        assertEquals("deterministic", r.matchType)
        assertTrue(r.matched)
        assertEquals("/product/42", r.deepLinkPath)
        assertEquals(mapOf("ref" to "ad"), r.deepLinkParams)
        assertEquals("abcd1234", r.linkCode)
        assertEquals("lac_abcdefgh12", r.clickId)
        assertEquals("google", r.campaign["source"])
        assertEquals(1, deferredBodies.size)
        val body = deferredBodies[0]
        assertEquals(c.getAnonymousId(), body["anonymous_id"])
        assertEquals("android", body["platform"])
        assertEquals("android", body["os"])
        assertEquals("14", body["os_version"])
        assertEquals("utm_source=google&click_id=lac_abcdefgh12", body["install_referrer"])
        assertEquals("lac_abcdefgh12", body["click_id"])
        // Same install, later calls and later launches: never asked again.
        assertNull(deferred(c))
        c.shutdown()
        assertNull(deferred(make(store = store)))
        assertEquals(1, deferredBodies.size)
    }

    @Test fun neverAsksForInstallsFromBeforeDeferredDeepLinks() {
        val store = InMemoryStore()
        store.set("leanapp:la_pk_dev:state", """{"anonymousId":"existing"}""")
        assertNull(deferred(make(store = store)))
        assertTrue(deferredBodies.isEmpty())
    }

    @Test fun waitsForAttributionConsentAndRetriesNextLaunchAfterAFailure() {
        synchronized(deferredResponses) { deferredResponses.add(MockResponse().setResponseCode(503)) }
        val store = InMemoryStore()
        val c = make(store = store, consentDefaults = mapOf("attribution" to ConsentStatus.PENDING))
        val latch = CountDownLatch(1)
        var result: DeferredDeepLink? = DeferredDeepLink("unset")
        c.requestDeferredDeepLink("android", "14") { result = it; latch.countDown() }
        c.queueLength // let the SDK thread run
        assertTrue(deferredBodies.isEmpty())
        c.setConsent(mapOf("attribution" to true))
        assertTrue(latch.await(5, TimeUnit.SECONDS))
        assertNull(result) // 503
        assertEquals(1, deferredBodies.size)
        c.shutdown()
        assertEquals("deterministic", deferred(make(store = store))!!.matchType)
        assertEquals(2, deferredBodies.size)
    }

    @Test fun answersNullWhenAttributionIsDeniedOrTheFeatureIsOff() {
        assertNull(deferred(make(consentDefaults = mapOf("attribution" to ConsentStatus.DENIED))))
        assertNull(deferred(make(deferred = false)))
        assertTrue(deferredBodies.isEmpty())
    }

    // ── parsing ──

    @Test fun readsUtmIdAndCampaignIdsOnlyNextToASource() {
        assertEquals(
            mapOf("utm_source" to "meta", "utm_id" to "120", "campaign_id" to "c1", "adset_id" to "s1", "ad_id" to "a1"),
            parseAttribution("myapp://p?utm_source=meta&utm_id=120&campaign_id=c1&adset_id=s1&ad_id=a1"),
        )
        assertNull(parseAttribution("myapp://listing?ad_id=99"))
    }
}
