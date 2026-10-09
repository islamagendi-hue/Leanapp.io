import XCTest
import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
@testable import LeanApp

private let key = "la_pk_dev_abcdefghijklmnopqrstuvwx"
private let match = """
{"match_type":"deterministic","match_key":"click_id","link":{"code":"abcd1234","name":"Ramadan"},\
"deep_link":{"path":"/product/42","params":{"ref":"ad"},"url":"/product/42?ref=ad"},\
"campaign":{"source":"apple","medium":"cpc","campaign":"ramadan"},"click_id":"lac_abcdefgh12","is_deferred":true}
"""

final class ConsentAndDeferredTests: XCTestCase {
    private var nextId = 0

    override func setUp() {
        super.setUp()
        StubProtocol.reset()
        nextId = 0
        StubProtocol.responder = { call in
            if call.request.url?.path.hasSuffix("/v1/deep-links/deferred") == true { return .status(200, [:], match) }
            return .status(200, [:], "{\"accepted\":\(call.batch.count),\"duplicates\":0,\"rejected\":[]}")
        }
    }

    private func make(store: KeyValueStore = InMemoryStore(), consentDefault: ConsentStatus = .granted, consentDefaults: [ConsentPurpose: ConsentStatus] = [:]) -> LeanAppClient {
        var c = LeanAppConfig(apiKey: key)
        c.endpoint = "https://api.example.test"
        c.appVersion = "2.3.0"
        c.flushAt = 1000
        c.flushInterval = 60
        c.consentDefault = consentDefault
        c.consentDefaults = consentDefaults
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [StubProtocol.self]
        return try! LeanAppClient(
            config: c,
            store: store,
            transport: URLSessionTransport(session: URLSession(configuration: config)),
            contextProvider: { ["locale": "ar-SA"] },
            clock: { 1_791_194_400_000 },
            uuid: { [unowned self] in self.nextId += 1; return "id-\(self.nextId)" },
            random: { 0.5 },
            timersEnabled: false
        )
    }

    private func flush(_ c: LeanAppClient) {
        let exp = expectation(description: "flush")
        c.flush { _ in exp.fulfill() }
        wait(for: [exp], timeout: 10)
    }

    private var sent: [[String: Any]] {
        StubProtocol.calls.filter { $0.request.url?.path.hasSuffix("/v1/events/batch") == true }.flatMap { $0.batch }
    }

    private var deferredCalls: [StubProtocol.Call] {
        StubProtocol.calls.filter { $0.request.url?.path.hasSuffix("/v1/deep-links/deferred") == true }
    }

    private func names() -> [String] {
        sent.compactMap { e in (e["type"] as? String) == "track" ? e["event_name"] as? String : e["type"] as? String }
    }

    private func deferred(_ c: LeanAppClient) -> DeferredDeepLink? {
        let exp = expectation(description: "deferred")
        var result: DeferredDeepLink?
        c.requestDeferredDeepLink(os: "ios", osVersion: "17.4") { r in
            result = r
            exp.fulfill()
        }
        wait(for: [exp], timeout: 10)
        return result
    }

    // MARK: consent

    func testDefaultsToGrantedSoAppsThatNeverAskBehaveAsBefore() {
        let c = make()
        XCTAssertEqual(c.getConsent()[.analytics], .granted)
        c.track("a")
        flush(c)
        XCTAssertEqual(names(), ["a"])
    }

    func testPendingHoldsEventsInMemoryThenSendsThemOnceAnalyticsIsGranted() {
        let store = InMemoryStore()
        let c = make(store: store, consentDefault: .pending)
        c.track("a")
        XCTAssertEqual(c.queueLength, 0)
        XCTAssertFalse((store.get("leanapp:la_pk_dev:queue") ?? "").contains("\"a\""))
        c.setConsent([.analytics: true])
        flush(c)
        XCTAssertEqual(names(), ["consent", "a"])
        XCTAssertEqual(sent[0]["consent"] as? [String: Bool], ["analytics": true])
        c.track("b")
        flush(c)
        XCTAssertEqual((sent.last?["context"] as? [String: Any])?["consent"] as? [String: Bool], ["analytics": true])
        XCTAssertEqual(c.getConsent()[.marketing], .pending)
    }

    func testDeniedDiscardsHeldEventsButStillSendsTheConsentChange() {
        let c = make(consentDefaults: [.analytics: .pending])
        c.track("held")
        c.registerPushToken(String(repeating: "t", count: 20))
        c.setConsent([.analytics: false])
        c.track("after")
        flush(c)
        XCTAssertEqual(names(), ["push_token", "consent"])
    }

    func testAttributionIsASeparatePurposeAndWaitsWithHeldEvents() {
        let c = make(consentDefault: .pending)
        c.captureAttribution("myapp://p?utm_source=tiktok&ttclid=t1")
        c.track("a")
        XCTAssertNil(c.getAttribution())
        c.setConsent([.analytics: true, .attribution: true])
        flush(c)
        let a = sent.first { $0["event_name"] as? String == "a" }
        XCTAssertEqual(((a?["context"] as? [String: Any])?["attribution"] as? [String: String])?["utm_source"], "tiktok")
        XCTAssertEqual(c.getAttribution()?.first["utm_source"], "tiktok")
    }

    func testSendsTheAdServicesTokenOnceWithAppInstalledOnlyWithAttributionConsent() {
        let c = make()
        var asked = 0
        c.trackInstallOrUpdate(appVersion: "1.0", appBuild: "1", attributionToken: { asked += 1; return "token-abc" })
        c.trackInstallOrUpdate(appVersion: "1.0", appBuild: "1", attributionToken: { asked += 1; return "token-abc" })
        c.track("next")
        flush(c)
        XCTAssertEqual(asked, 1)
        let install = sent.first { $0["event_name"] as? String == "app_installed" }
        XCTAssertEqual(((install?["context"] as? [String: Any])?["attribution"] as? [String: String])?["adservices_token"], "token-abc")
        let next = sent.first { $0["event_name"] as? String == "next" }
        XCTAssertNil((next?["context"] as? [String: Any])?["attribution"])

        let denied = make(consentDefaults: [.attribution: .denied])
        var deniedAsked = 0
        denied.trackInstallOrUpdate(appVersion: "1.0", appBuild: "1", attributionToken: { deniedAsked += 1; return "token" })
        _ = denied.queueLength
        XCTAssertEqual(deniedAsked, 0)
    }

    func testRecordsTheDevicesConsentForAUserWhoSignsInAndAfterReset() {
        let c = make()
        c.setConsent([.marketing: false])
        c.identify("u-1")
        c.identify("u-1")
        c.reset()
        flush(c)
        let consents = sent.filter { $0["type"] as? String == "consent" }
        XCTAssertEqual(consents.count, 3)
        XCTAssertEqual(consents[1]["user_id"] as? String, "u-1")
        XCTAssertNil(consents[2]["user_id"])
    }

    // MARK: deferred deep links

    func testAsksOncePerNewInstall() {
        let store = InMemoryStore()
        let c = make(store: store)
        let r = deferred(c)
        XCTAssertEqual(r?.matchType, "deterministic")
        XCTAssertEqual(r?.deepLinkPath, "/product/42")
        XCTAssertEqual(r?.deepLinkParams, ["ref": "ad"])
        XCTAssertEqual(r?.clickId, "lac_abcdefgh12")
        XCTAssertEqual(deferredCalls.count, 1)
        XCTAssertEqual(deferredCalls[0].body["platform"] as? String, "ios")
        XCTAssertEqual(deferredCalls[0].body["os"] as? String, "ios")
        XCTAssertEqual(deferredCalls[0].body["anonymous_id"] as? String, c.getAnonymousId())
        XCTAssertNil(deferred(c))
        c.shutdown()
        XCTAssertNil(deferred(make(store: store)))
        XCTAssertEqual(deferredCalls.count, 1)
    }

    func testNeverAsksForInstallsFromBeforeDeferredDeepLinks() {
        let store = InMemoryStore()
        try? store.set("leanapp:la_pk_dev:state", "{\"anonymousId\":\"existing\"}")
        XCTAssertNil(deferred(make(store: store)))
        XCTAssertEqual(deferredCalls.count, 0)
    }

    func testAnswersNilWhenAttributionIsDenied() {
        XCTAssertNil(deferred(make(consentDefaults: [.attribution: .denied])))
        XCTAssertEqual(deferredCalls.count, 0)
    }

    // MARK: parsing and Apple helpers

    func testReadsCampaignIdsOnlyNextToASource() {
        XCTAssertEqual(parseAttribution("myapp://p?utm_source=meta&utm_id=120&campaign_id=c1"), ["utm_source": "meta", "utm_id": "120", "campaign_id": "c1"])
        XCTAssertNil(parseAttribution("myapp://listing?ad_id=99"))
    }

    func testConversionValueOutOfRangeIsRefused() {
        let exp = expectation(description: "cv")
        AppleAttribution.updateConversionValue(64) { result in
            if case .failure(let err) = result { XCTAssertTrue(err is AppleAttribution.ConversionValueError) } else { XCTFail("expected failure") }
            exp.fulfill()
        }
        wait(for: [exp], timeout: 2)
    }
}
