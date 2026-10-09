import XCTest
import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
@testable import LeanApp

private let key = "la_pk_dev_abcdefghijklmnopqrstuvwx"

/// Answers every request from `StubProtocol.responder` and records it.
final class StubProtocol: URLProtocol {
    struct Call {
        let request: URLRequest
        let body: [String: Any]
        var batch: [[String: Any]] { body["batch"] as? [[String: Any]] ?? [] }
        func header(_ name: String) -> String? { request.value(forHTTPHeaderField: name) }
    }

    enum Reply {
        case status(Int, [String: String], String)
        case networkError
    }

    static var calls: [Call] = []
    static var responder: (Call) -> Reply = { call in .status(200, [:], "{\"accepted\":\(call.batch.count),\"duplicates\":0,\"rejected\":[]}") }
    private static let lock = NSLock()

    static func reset() {
        lock.lock(); defer { lock.unlock() }
        calls = []
        responder = { call in .status(200, [:], "{\"accepted\":\(call.batch.count),\"duplicates\":0,\"rejected\":[]}") }
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        // URLProtocol sees the body as a stream, not httpBody.
        var data = request.httpBody ?? Data()
        if data.isEmpty, let stream = request.httpBodyStream {
            stream.open()
            var buf = [UInt8](repeating: 0, count: 4096)
            while stream.hasBytesAvailable {
                let n = stream.read(&buf, maxLength: buf.count)
                if n <= 0 { break }
                data.append(buf, count: n)
            }
            stream.close()
        }
        let body = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
        let call = Call(request: request, body: body)
        StubProtocol.lock.lock()
        StubProtocol.calls.append(call)
        let reply = StubProtocol.responder(call)
        StubProtocol.lock.unlock()
        switch reply {
        case .networkError:
            client?.urlProtocol(self, didFailWithError: URLError(.notConnectedToInternet))
        case let .status(code, headers, text):
            let res = HTTPURLResponse(url: request.url!, statusCode: code, httpVersion: "HTTP/1.1", headerFields: headers)!
            client?.urlProtocol(self, didReceive: res, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: Data(text.utf8))
            client?.urlProtocolDidFinishLoading(self)
        }
    }

    override func stopLoading() {}
}

final class LeanAppClientTests: XCTestCase {
    private var now: Int64 = 1_791_194_400_000 // 2026-10-05T10:00:00Z
    private var nextId = 0

    override func setUp() {
        super.setUp()
        StubProtocol.reset()
        now = 1_791_194_400_000
        nextId = 0
    }

    private func transport() -> URLSessionTransport {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [StubProtocol.self]
        return URLSessionTransport(session: URLSession(configuration: config))
    }

    private func make(
        store: KeyValueStore = InMemoryStore(),
        endpoint: String = "https://api.example.test/",
        maxBatchSize: Int = 100,
        maxQueueSize: Int = 1000,
        eventTTL: TimeInterval = 7 * 86_400,
        optedOut: Bool = false,
        flushAt: Int = 1000,
        timers: Bool = false
    ) -> LeanAppClient {
        var c = LeanAppConfig(apiKey: key)
        c.endpoint = endpoint
        c.appVersion = "2.3.0"
        c.flushAt = flushAt
        c.flushInterval = 60
        c.maxBatchSize = maxBatchSize
        c.maxQueueSize = maxQueueSize
        c.eventTTL = eventTTL
        c.optedOut = optedOut
        return try! LeanAppClient(
            config: c,
            store: store,
            transport: transport(),
            contextProvider: { ["locale": "ar-SA", "os_version": "17.0"] },
            clock: { [unowned self] in self.now },
            uuid: { [unowned self] in self.nextId += 1; return "id-\(self.nextId)" },
            random: { 0.5 },
            timersEnabled: timers
        )
    }

    private func flush(_ c: LeanAppClient) -> FlushResult {
        let exp = expectation(description: "flush")
        var result: FlushResult = .empty
        c.flush { r in
            result = r
            exp.fulfill()
        }
        wait(for: [exp], timeout: 10)
        return result
    }

    // MARK: configuration

    func testRejectsKeysThatAreNotLeanAppKeys() {
        XCTAssertThrowsError(try LeanAppClient(config: LeanAppConfig(apiKey: "sk_live_123")))
    }

    func testRefusesSecretKeyOutsideServer() {
        XCTAssertThrowsError(try LeanAppClient(config: LeanAppConfig(apiKey: "la_sk_dev_" + String(repeating: "x", count: 40))))
        var backend = LeanAppConfig(apiKey: "la_sk_dev_" + String(repeating: "x", count: 40))
        backend.platform = "backend"
        XCTAssertNoThrow(try LeanAppClient(config: backend))
    }

    func testStorageNamespaceIsKindAndEnvironment() {
        XCTAssertEqual(storagePrefix(key), "leanapp:la_pk_dev:")
        XCTAssertEqual(storagePrefix("la_pk_live_" + String(repeating: "a", count: 24)), "leanapp:la_pk_live:")
        XCTAssertNil(storagePrefix("la_pk_live_short"))
    }

    func testDefaultsToTheLeanAppAPI() {
        let c = make(endpoint: leanAppDefaultEndpoint)
        c.track("app_opened")
        _ = flush(c)
        XCTAssertEqual(StubProtocol.calls.first?.request.url?.absoluteString, "https://api.leanapp.io/v1/events/batch")
    }

    // MARK: events

    func testSendsBatchedEventsWithIdentitySessionAndContext() {
        let c = make()
        c.track("product_viewed", properties: ["product_id": "p1"])
        c.screen("Home")
        c.identify("u-42", traits: ["city": "Riyadh"])
        c.track("order_completed", properties: ["order_id": "o1", "revenue": 45.0, "currency": "SAR", "first": true], eventId: "order-o1")
        XCTAssertEqual(flush(c), .sent(accepted: 4, duplicates: 0, rejected: 0))
        XCTAssertEqual(StubProtocol.calls.count, 1)
        let call = StubProtocol.calls[0]
        XCTAssertEqual(call.request.url?.absoluteString, "https://api.example.test/v1/events/batch")
        XCTAssertEqual(call.request.httpMethod, "POST")
        XCTAssertEqual(call.header("Authorization"), "Bearer \(key)")
        XCTAssertNotNil(call.body["sent_at"] as? String)
        let b = call.batch
        // batch size : hash of every event id : first event id
        XCTAssertEqual(call.header("Idempotency-Key"), "4:\(eventIdsHash(b.map { $0["event_id"] as? String ?? "" })):id-2")
        XCTAssertEqual(b[0]["type"] as? String, "track")
        XCTAssertEqual(b[0]["event_name"] as? String, "product_viewed")
        XCTAssertEqual(b[0]["properties"] as? [String: String], ["product_id": "p1"])
        XCTAssertEqual(b[0]["anonymous_id"] as? String, "id-1")
        XCTAssertNil(b[0]["user_id"])
        XCTAssertEqual(b[0]["timestamp"] as? String, "2026-10-05T10:00:00.000Z")
        let ctx = b[0]["context"] as? [String: Any] ?? [:]
        XCTAssertEqual(ctx["platform"] as? String, "ios")
        XCTAssertEqual(ctx["app_version"] as? String, "2.3.0")
        XCTAssertEqual(ctx["locale"] as? String, "ar-SA")
        XCTAssertEqual(ctx["sdk"] as? [String: String], ["name": "leanapp-ios", "version": leanAppSDKVersion])
        XCTAssertEqual(b[1]["type"] as? String, "screen")
        XCTAssertEqual(b[1]["properties"] as? [String: String], ["screen_name": "Home"])
        XCTAssertEqual(b[2]["type"] as? String, "identify")
        XCTAssertEqual(b[2]["user_id"] as? String, "u-42")
        XCTAssertEqual(b[2]["user_properties"] as? [String: String], ["city": "Riyadh"])
        XCTAssertEqual(b[3]["event_id"] as? String, "order-o1")
        XCTAssertEqual(b[3]["user_id"] as? String, "u-42")
        let props = b[3]["properties"] as? [String: Any] ?? [:]
        XCTAssertEqual(props["revenue"] as? Double, 45)
        XCTAssertEqual(props["first"] as? Bool, true)
        XCTAssertEqual(Set(b.compactMap { $0["session_id"] as? String }).count, 1)
        XCTAssertEqual(c.queueLength, 0)
    }

    func testIgnoresSecondEventWithSameIdWhileQueued() {
        let c = make()
        c.track("order_completed", properties: ["order_id": "o1"], eventId: "order-o1")
        c.track("order_completed", properties: ["order_id": "o1"], eventId: "order-o1")
        XCTAssertEqual(c.queueLength, 1)
    }

    func testStartsNewSessionAfterThirtyMinutes() {
        let c = make()
        c.track("a")
        _ = c.queueLength
        now += 29 * 60_000
        c.track("b")
        _ = c.queueLength
        now += 31 * 60_000
        c.track("c")
        _ = flush(c)
        let b = StubProtocol.calls[0].batch
        XCTAssertEqual(b[0]["session_id"] as? String, b[1]["session_id"] as? String)
        XCTAssertNotEqual(b[1]["session_id"] as? String, b[2]["session_id"] as? String)
    }

    func testSplitsLargeQueuesIntoBatches() {
        let c = make(maxBatchSize: 2)
        for i in 0..<5 { c.track("e\(i)") }
        _ = flush(c)
        XCTAssertEqual(StubProtocol.calls.map { $0.batch.count }, [2, 2, 1])
    }

    func testResetForgetsUserAndStartsNewAnonymousId() {
        let c = make()
        c.identify("u-1")
        c.reset()
        c.track("app_opened")
        _ = flush(c)
        let b = StubProtocol.calls[0].batch
        XCTAssertNil(b.last?["user_id"])
        XCTAssertNotEqual(b.first?["anonymous_id"] as? String, b.last?["anonymous_id"] as? String)
        XCTAssertNil(c.getUserId())
    }

    func testRegistersPushTokensAndAliases() {
        let c = make()
        c.registerPushToken("apns-token-1234567890", provider: "apns", permission: "granted")
        c.alias("u-9", previousId: "guest-1")
        _ = flush(c)
        let b = StubProtocol.calls[0].batch
        XCTAssertEqual(b[0]["type"] as? String, "push_token")
        XCTAssertEqual(b[0]["push_token"] as? [String: String], ["token": "apns-token-1234567890", "provider": "apns", "permission": "granted"])
        XCTAssertEqual(b[1]["type"] as? String, "alias")
        XCTAssertEqual(b[1]["previous_id"] as? String, "guest-1")
        XCTAssertEqual(b[1]["user_id"] as? String, "u-9")
    }

    // MARK: delivery

    func testKeepsEventsOfflineRetriesWithBackoffAndSurvivesRestart() {
        let store = InMemoryStore()
        StubProtocol.responder = { _ in .networkError }
        let first = make(store: store)
        first.track("app_opened")
        first.track("product_viewed")
        guard case let .retry(wait1, _) = flush(first) else { return XCTFail("expected retry") }
        XCTAssertEqual(wait1, 750) // 1s base, jittered to 75% with random 0.5
        guard case let .retry(wait2, _) = flush(first) else { return XCTFail("expected retry") }
        XCTAssertEqual(wait2, 1500)
        XCTAssertEqual(first.queueLength, 2)
        let anon = first.getAnonymousId()
        first.shutdown()

        StubProtocol.responder = { call in .status(200, [:], "{\"accepted\":\(call.batch.count),\"duplicates\":0,\"rejected\":[]}") }
        let second = make(store: store)
        XCTAssertEqual(flush(second), .sent(accepted: 2, duplicates: 0, rejected: 0))
        let sent = StubProtocol.calls.last!.batch
        XCTAssertEqual(sent.compactMap { $0["event_name"] as? String }, ["app_opened", "product_viewed"])
        // Same ids as the failed attempts, so the server de-duplicates if one of them actually landed.
        XCTAssertEqual(sent.compactMap { $0["event_id"] as? String }, StubProtocol.calls[0].batch.compactMap { $0["event_id"] as? String })
        XCTAssertEqual(StubProtocol.calls.last!.header("Idempotency-Key"), StubProtocol.calls[0].header("Idempotency-Key"))
        XCTAssertEqual(second.getAnonymousId(), anon)
    }

    func testDerivesIdempotencyKeyFromEveryEventId() {
        // FNV-1a 32-bit over the UTF-8 ids joined by "\n"; same vectors as the JavaScript SDK.
        XCTAssertEqual(eventIdsHash(["a"]), "e40c292c")
        XCTAssertEqual(eventIdsHash(["a", "b"]), "28e4c710")
        XCTAssertEqual(eventIdsHash(["\u{e9}\u{1F600}"]), "039d63cc")
        XCTAssertEqual(idempotencyKey(["id-2", "id-3"]), "2:408dab4a:id-2")
        // Same first id and size but different events (the queue changed before a retry): different key.
        XCTAssertNotEqual(idempotencyKey(["A", "B"]), idempotencyKey(["A", "C"]))
        XCTAssertNotEqual(idempotencyKey(["A", "B"]), idempotencyKey(["B", "A"]))
    }

    func testResendsWithoutIdempotencyKeyAfterKeyReused() {
        var n = 0
        StubProtocol.responder = { call in
            n += 1
            return n == 1 ? .status(409, [:], "{\"error\":\"idempotency_key_reused\"}") : .status(200, [:], "{\"accepted\":\(call.batch.count),\"duplicates\":0,\"rejected\":[]}")
        }
        let c = make()
        c.track("a")
        c.track("b")
        XCTAssertEqual(flush(c), .retry(retryInMs: 0, reason: "idempotency key already used for other events; resending without it"))
        XCTAssertEqual(c.queueLength, 2) // never dropped
        XCTAssertEqual(flush(c), .sent(accepted: 2, duplicates: 0, rejected: 0))
        XCTAssertNotNil(StubProtocol.calls[0].header("Idempotency-Key"))
        XCTAssertNil(StubProtocol.calls[1].header("Idempotency-Key"))
        XCTAssertEqual(c.queueLength, 0)
    }

    func testHonoursRetryAfterOn429() {
        StubProtocol.responder = { _ in .status(429, ["Retry-After": "7"], "{\"error\":\"rate_limited\"}") }
        let c = make()
        c.track("a")
        XCTAssertEqual(flush(c), .retry(retryInMs: 7000, reason: "HTTP 429"))
        XCTAssertEqual(c.queueLength, 1)
    }

    func testStopsSendingButKeepsEventsWhenKeyIsRevoked() {
        StubProtocol.responder = { _ in .status(401, [:], "{\"error\":\"invalid_api_key\"}") }
        let c = make()
        c.track("a")
        XCTAssertEqual(flush(c), .unauthorized)
        XCTAssertEqual(flush(c), .unauthorized)
        XCTAssertEqual(StubProtocol.calls.count, 1)
        XCTAssertEqual(c.queueLength, 1)
    }

    func testHalvesTheBatchOn413() {
        var n = 0
        StubProtocol.responder = { call in
            n += 1
            return n == 1 ? .status(413, [:], "") : .status(200, [:], "{\"accepted\":\(call.batch.count),\"duplicates\":0,\"rejected\":[]}")
        }
        let c = make(maxBatchSize: 4)
        for i in 0..<4 { c.track("e\(i)") }
        XCTAssertEqual(flush(c), .retry(retryInMs: 0, reason: "payload too large; splitting batch"))
        _ = flush(c)
        XCTAssertEqual(StubProtocol.calls.map { $0.batch.count }, [4, 2, 2])
        XCTAssertEqual(c.queueLength, 0)
    }

    func testDropsMalformedBatchInsteadOfRetryingForever() {
        StubProtocol.responder = { _ in .status(400, [:], "{\"error\":\"invalid_batch\"}") }
        let c = make()
        c.track("a")
        _ = flush(c)
        XCTAssertEqual(c.queueLength, 0)
    }

    func testRemovesIndividuallyRejectedEventsWithAcceptedOnes() {
        StubProtocol.responder = { _ in .status(200, [:], "{\"accepted\":1,\"duplicates\":0,\"rejected\":[{\"index\":0,\"errors\":[]}]}") }
        let c = make()
        c.track("a")
        c.track("b")
        XCTAssertEqual(flush(c), .sent(accepted: 1, duplicates: 0, rejected: 1))
        XCTAssertEqual(c.queueLength, 0)
    }

    func testCapsTheQueueAndExpiresOldEvents() {
        let c = make(maxQueueSize: 10, eventTTL: 60)
        for i in 0..<15 { c.track("e\(i)") }
        XCTAssertEqual(c.queueLength, 10)
        now += 61_000
        c.track("fresh")
        _ = flush(c)
        XCTAssertEqual(StubProtocol.calls[0].batch.compactMap { $0["event_name"] as? String }, ["fresh"])
    }

    func testDoesNotSendWhileOptedOut() {
        let c = make(optedOut: true)
        c.track("a")
        XCTAssertEqual(flush(c), .paused)
        XCTAssertEqual(StubProtocol.calls.count, 0)
    }

    func testFlushesAutomaticallyOnceFlushAtEventsAreQueued() {
        let c = make(flushAt: 3, timers: true)
        c.track("a")
        c.track("b")
        _ = c.queueLength
        XCTAssertEqual(StubProtocol.calls.count, 0)
        c.track("c")
        let deadline = Date().addingTimeInterval(5)
        while StubProtocol.calls.isEmpty && Date() < deadline { RunLoop.current.run(until: Date().addingTimeInterval(0.05)) }
        XCTAssertEqual(StubProtocol.calls.first?.batch.count, 3)
        c.shutdown()
    }

    func testPersistsTheQueueOnDisk() throws {
        let dir = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("leanapp-test-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: dir) }
        let first = make(store: FileStore(directory: dir))
        first.track("offline_event")
        _ = first.queueLength
        first.shutdown()
        let second = make(store: FileStore(directory: dir))
        _ = flush(second)
        XCTAssertEqual(StubProtocol.calls[0].batch.compactMap { $0["event_name"] as? String }, ["offline_event"])
    }

    // MARK: attribution and lifecycle

    func testParsesCampaignParametersAndClickIds() {
        XCTAssertEqual(parseAttribution("myapp://open?utm_source=tiktok&utm_campaign=ramadan%20sale&ttclid=abc&foo=1"),
                       ["utm_source": "tiktok", "utm_campaign": "ramadan sale", "ttclid": "abc"])
        XCTAssertEqual(parseAttribution("https://x.test/?sccid=snap1"), ["ScCid": "snap1"])
        XCTAssertNil(parseAttribution("https://x.test/home"))
    }

    func testKeepsFirstTouchAndAttachesLatestWithDeepLink() {
        let c = make()
        c.captureAttribution("https://leanapp.io/l?utm_source=snapchat&ScCid=s1")
        c.captureAttribution("myapp://p?utm_source=tiktok&ttclid=t1")
        c.track("app_opened")
        _ = flush(c)
        let latest = ["utm_source": "tiktok", "ttclid": "t1", "deep_link_url": "myapp://p?utm_source=tiktok&ttclid=t1"]
        XCTAssertEqual(c.getAttribution()?.first["ScCid"], "s1")
        XCTAssertEqual(c.getAttribution()?.latest, latest)
        let ctx = StubProtocol.calls[0].batch[0]["context"] as? [String: Any]
        XCTAssertEqual(ctx?["attribution"] as? [String: String], latest)
    }

    func testTracksInstallOnceThenUpdatesOnVersionChange() {
        let store = InMemoryStore()
        let first = make(store: store)
        first.trackInstallOrUpdate(appVersion: "1.0", appBuild: "10")
        first.trackInstallOrUpdate(appVersion: "1.0", appBuild: "10")
        _ = flush(first)
        XCTAssertEqual(StubProtocol.calls[0].batch.compactMap { $0["event_name"] as? String }, ["app_installed"])
        first.shutdown()
        let second = make(store: store)
        second.trackInstallOrUpdate(appVersion: "1.1", appBuild: "11")
        _ = flush(second)
        let e = StubProtocol.calls[1].batch[0]
        XCTAssertEqual(e["event_name"] as? String, "app_updated")
        XCTAssertEqual(e["properties"] as? [String: String], ["version": "1.1", "build": "11", "previous_version": "1.0", "previous_build": "10"])
    }

    func testDefaultContextHasOsAndLocale() {
        let ctx = defaultContext()
        XCTAssertNotNil(ctx["os_version"] as? String)
        XCTAssertNotNil(ctx["timezone"] as? String)
        XCTAssertEqual((ctx["device"] as? [String: Any])?["manufacturer"] as? String, "Apple")
    }
}
