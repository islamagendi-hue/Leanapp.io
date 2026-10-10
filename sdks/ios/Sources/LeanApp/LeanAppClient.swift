import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

public let leanAppSDKVersion = "0.1.0"
public let leanAppDefaultEndpoint = "https://api.leanapp.io"

/// Client options. Defaults match the JavaScript SDK (docs/sdk.md).
public struct LeanAppConfig {
    /// Public SDK key (la_pk_…). Secret keys (la_sk_…) are refused in apps.
    public var apiKey: String
    public var endpoint: String = leanAppDefaultEndpoint
    /// ios, android, react_native, flutter, web or backend.
    public var platform: String = "ios"
    public var appVersion: String?
    public var appBuild: String?
    /// Send when this many events are queued.
    public var flushAt: Int = 20
    /// Send at least this often while events are queued (seconds).
    public var flushInterval: TimeInterval = 10
    /// Events per request (server maximum 500).
    public var maxBatchSize: Int = 100
    /// Oldest events are dropped beyond this.
    public var maxQueueSize: Int = 1_000
    /// Queued events older than this are dropped (seconds; the server rejects events older than 31 days).
    public var eventTTL: TimeInterval = 7 * 86_400
    /// Inactivity after which a new session starts (seconds).
    public var sessionTimeout: TimeInterval = 30 * 60
    /// Extra context merged into every event.
    public var context: [String: Any] = [:]
    /// Stop sending (events still queue) until optIn().
    public var optedOut: Bool = false
    public var debug: Bool = false
    /// Consent assumed for every purpose until setConsent() records the user's answer. .granted (default,
    /// the behaviour before consent existed): track normally. .pending: events wait in memory only (not
    /// stored, not sent) until consent is granted, and are discarded if it is denied or the app closes
    /// first. .denied: events are dropped.
    public var consentDefault: ConsentStatus = .granted
    /// Per-purpose overrides of `consentDefault`.
    public var consentDefaults: [ConsentPurpose: ConsentStatus] = [:]
    /// On the first launch of a new install, ask LeanApp once for the deferred deep link (needs attribution consent).
    public var deferredDeepLinks: Bool = true

    public init(apiKey: String) {
        self.apiKey = apiKey
    }
}

/// Result of one flush, same shape as the JavaScript SDK's FlushResult.
public enum FlushResult: Equatable {
    case empty
    case paused
    case busy
    case unauthorized
    case sent(accepted: Int, duplicates: Int, rejected: Int)
    case retry(retryInMs: Int, reason: String)
}

public enum LeanAppError: Error, CustomStringConvertible {
    case invalidKey
    case secretKeyInApp

    public var description: String {
        switch self {
        case .invalidKey: return "LeanApp: apiKey must be a LeanApp key (la_pk_… for apps). Find it under Developers → SDK & API keys."
        case .secretKeyInApp: return "LeanApp: secret keys (la_sk_…) are for servers only. Use the public SDK key (la_pk_…) in apps."
        }
    }
}

private let baseBackoffMs = 1_000
private let maxBackoffMs = 5 * 60_000

/// Parses la_(pk|sk)_(dev|stg|live)_<20+ chars>. Returns (kind, environment).
func parseKey(_ key: String) -> (String, String)? {
    let parts = key.split(separator: "_", maxSplits: 3, omittingEmptySubsequences: false)
    guard parts.count == 4, parts[0] == "la", parts[1] == "pk" || parts[1] == "sk",
          parts[2] == "dev" || parts[2] == "stg" || parts[2] == "live" else { return nil }
    let rest = parts[3]
    guard rest.count >= 20, rest.unicodeScalars.allSatisfy({ CharacterSet.alphanumerics.contains($0) && $0.isASCII || $0 == "_" || $0 == "-" }) else { return nil }
    return (String(parts[1]), String(parts[2]))
}

/// Storage namespace: key kind and environment (leanapp:la_pk_live:), shared with the other LeanApp SDKs.
public func storagePrefix(_ apiKey: String) -> String? {
    guard let parsed = parseKey(apiKey) else { return nil }
    return "leanapp:la_\(parsed.0)_\(parsed.1):"
}

private let isoFormatter: DateFormatter = {
    let f = DateFormatter()
    f.locale = Locale(identifier: "en_US_POSIX")
    f.timeZone = TimeZone(identifier: "UTC")
    f.dateFormat = "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'"
    return f
}()

/// ISO 8601 UTC with milliseconds, like JavaScript's Date.toISOString().
func isoString(_ ms: Int64) -> String {
    isoFormatter.string(from: Date(timeIntervalSince1970: Double(ms) / 1000))
}

/// Makes any value safe for JSONSerialization.
func jsonSafe(_ value: Any?) -> Any {
    guard let value = value else { return NSNull() }
    switch value {
    case is NSNull: return value
    case let v as String: return v
    // Swift Bool, Int and Double bridge to NSNumber; JSONSerialization keeps booleans as true/false.
    case let v as NSNumber: return v.doubleValue.isFinite ? v : NSNull()
    case let v as Date: return isoString(Int64(v.timeIntervalSince1970 * 1000))
    case let v as URL: return v.absoluteString
    case let v as [String: Any?]: return v.mapValues { jsonSafe($0) }
    case let v as [String: Any]: return v.mapValues { jsonSafe($0) }
    case let v as [Any?]: return v.map { jsonSafe($0) }
    case let v as [Any]: return v.map { jsonSafe($0) }
    default:
        let mirror = Mirror(reflecting: value)
        if mirror.displayStyle == .optional {
            if let child = mirror.children.first { return jsonSafe(child.value) }
            return NSNull()
        }
        return String(describing: value)
    }
}

/// FNV-1a (32-bit) of the UTF-8 bytes of the event ids joined by "\n", as 8 hex digits.
/// Same value as eventIdsHash in the JavaScript SDK.
public func eventIdsHash(_ ids: [String]) -> String {
    var h: UInt32 = 0x811c9dc5
    for b in ids.joined(separator: "\n").utf8 {
        h = (h ^ UInt32(b)) &* 0x01000193
    }
    let hex = String(h, radix: 16)
    return String(repeating: "0", count: 8 - hex.count) + hex
}

/// `<batch size>:<hash of every event id>:<first event id>`: the same events give the same key on every
/// retry, and a batch whose events changed before a retry gets a different key, so the server never
/// answers it with the response of a batch it did not send. The first id goes last so the server's
/// 200-character limit can only truncate it, never the hash.
public func idempotencyKey(_ ids: [String]) -> String {
    return "\(ids.count):\(eventIdsHash(ids)):\(ids.first ?? "")"
}

/// The LeanApp client: a Swift port of sdks/javascript/src/client.ts with the same wire format and rules.
///
/// Every call returns immediately and never throws after init. State lives on one serial queue, so
/// calls are applied in order; storage is loaded on that queue before anything else runs.
public final class LeanAppClient {
    private let o: LeanAppConfig
    private let store: KeyValueStore
    private let transport: HTTPTransport
    private let contextProvider: () -> [String: Any]
    private let clock: () -> Int64
    private let uuid: () -> String
    private let random: () -> Double
    private let sdkName: String
    private let timersEnabled: Bool
    private let prefix: String
    private let queue = DispatchQueue(label: "io.leanapp.analytics")
    private let queueKey = DispatchSpecificKey<Bool>()

    // Only touched on `queue`.
    private var state = State(anonymousId: "")
    private var events: [QueuedEvent] = []
    private var sending = false
    private var paused = false
    private var optedOut: Bool
    private var failures = 0
    private var retryAt: Int64 = 0
    /// Set after a 409 idempotency_key_reused: the next request goes without a key (event ids still de-duplicate).
    private var skipIdempotencyKey = false
    private var maxBatchSize: Int
    private var timer: DispatchWorkItem?
    /// Events waiting for consent: memory only, never persisted or sent until consent is granted.
    private var held: [QueuedEvent] = []
    /// Attribution captured while attribution consent is pending: memory only.
    private var heldFirst: [String: String]?
    private var heldLatest: [String: String]?
    /// The deferred deep link request waiting for attribution consent.
    private var deferredRequest: (os: String?, osVersion: String?, completion: ((DeferredDeepLink?) -> Void)?)?
    private var deferredInFlight = false

    public init(
        config: LeanAppConfig,
        store: KeyValueStore = InMemoryStore(),
        transport: HTTPTransport = URLSessionTransport(),
        contextProvider: @escaping () -> [String: Any] = defaultContext,
        clock: @escaping () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) },
        uuid: @escaping () -> String = { UUID().uuidString.lowercased() },
        random: @escaping () -> Double = { Double.random(in: 0..<1) },
        sdkName: String = "leanapp-ios",
        timersEnabled: Bool = true
    ) throws {
        guard let prefix = storagePrefix(config.apiKey) else { throw LeanAppError.invalidKey }
        if config.apiKey.hasPrefix("la_sk_") && config.platform != "backend" { throw LeanAppError.secretKeyInApp }
        var c = config
        while c.endpoint.hasSuffix("/") { c.endpoint.removeLast() }
        c.flushAt = max(1, c.flushAt)
        c.flushInterval = max(1, c.flushInterval)
        c.maxBatchSize = min(500, max(1, c.maxBatchSize))
        c.maxQueueSize = max(10, c.maxQueueSize)
        self.o = c
        self.prefix = prefix
        self.store = store
        self.transport = transport
        self.contextProvider = contextProvider
        self.clock = clock
        self.uuid = uuid
        self.random = random
        self.sdkName = sdkName
        self.timersEnabled = timersEnabled
        self.optedOut = c.optedOut
        self.maxBatchSize = c.maxBatchSize
        queue.setSpecific(key: queueKey, value: true)
        queue.async { self.load() }
    }

    // MARK: Public API

    public func track(_ eventName: String, properties: [String: Any] = [:], eventId: String? = nil, timestamp: Date? = nil) {
        let name = eventName.trimmingCharacters(in: .whitespacesAndNewlines)
        if name.isEmpty { return warn("track() needs an event name") }
        enqueue(eventId: eventId, timestamp: timestamp) {
            ["type": "track", "event_name": name, "properties": properties]
        }
    }

    public func screen(_ screenName: String, properties: [String: Any] = [:]) {
        if screenName.isEmpty { return warn("screen() needs a screen name") }
        var merged = properties
        merged["screen_name"] = screenName
        let props = merged
        enqueue { ["type": "screen", "event_name": screenName, "properties": props] }
    }

    /// Links this device to your user id. Traits are facts about the person (plan, city), not actions.
    public func identify(_ userId: String?, traits: [String: Any] = [:]) {
        var changed = false
        enqueue { [self] in
            if let userId = userId, !userId.isEmpty {
                changed = state.userId != userId
                state.userId = userId
                persistState()
            }
            return ["type": "identify", "user_properties": traits]
        }
        // Consent given on this device follows the user who signs in on it.
        queue.async { [self] in if changed { resendConsent() } }
    }

    public func setUserProperties(_ traits: [String: Any]) {
        identify(nil, traits: traits)
    }

    /// Merges a previous user id into the current one (e.g. a guest account that signed up).
    public func alias(_ newUserId: String, previousId: String? = nil) {
        enqueue { [self] in
            let prev = previousId ?? state.userId ?? state.anonymousId
            state.userId = newUserId
            persistState()
            return ["type": "alias", "previous_id": prev]
        }
        queue.async { [self] in resendConsent() }
    }

    /// provider: "apns" or "fcm"; permission: granted, denied, provisional or unknown. Governed by push consent.
    public func registerPushToken(_ token: String, provider: String = "apns", permission: String = "unknown") {
        guard provider == "apns" || provider == "fcm" else { return warn("registerPushToken() provider must be apns or fcm") }
        enqueue(purpose: .push) { ["type": "push_token", "push_token": ["token": token, "provider": provider, "permission": permission]] }
    }

    /// Captures campaign parameters from a deep link or universal link. The first touch is kept; the latest
    /// is attached to every following event as context.attribution, with the URL as deep_link_url.
    /// Governed by attribution consent: ignored when denied, kept in memory only while pending.
    @discardableResult
    public func captureAttribution(_ url: String) -> [String: String]? {
        guard var touch = parseAttribution(url) else { return nil }
        touch["deep_link_url"] = String(url.prefix(1000))
        let t = touch
        queue.async { [self] in recordTouch(t) }
        return touch
    }

    /// Records the user's consent answers, e.g. from your consent screen. Purposes left out keep their
    /// state. The answers are stored on the device and sent to LeanApp whatever they are, so the platform
    /// can honour them. Granting analytics releases events waiting in memory; denying it discards them
    /// and clears the unsent queue.
    public func setConsent(_ consent: [ConsentPurpose: Bool]) {
        if consent.isEmpty { return warn("setConsent() needs at least one of analytics, marketing, push, attribution") }
        let at = clock()
        queue.async { [self] in
            for (p, v) in consent { state.consent[p.rawValue] = v }
            persistState()
            // The change goes first, then whatever it releases.
            pushConsent(consent, at: at)
            applyConsent()
        }
    }

    /// Current consent per purpose: the user's answer, or the configured default where they haven't answered.
    public func getConsent() -> [ConsentPurpose: ConsentStatus] {
        sync { () -> [ConsentPurpose: ConsentStatus] in
            var out: [ConsentPurpose: ConsentStatus] = [:]
            for p in ConsentPurpose.allCases { out[p] = consentFor(p) }
            return out
        }
    }

    /// Asks LeanApp once per new install (POST /v1/deep-links/deferred) for the deep link of the link click
    /// the install came from. Waits for attribution consent; `completion` (on the SDK queue) gets the
    /// answer, or nil when the request failed, attribution consent was denied, deferred deep links are off
    /// or this install already asked.
    public func requestDeferredDeepLink(os: String? = "ios", osVersion: String? = nil, completion: ((DeferredDeepLink?) -> Void)? = nil) {
        queue.async { [self] in
            if !o.deferredDeepLinks || state.deferredChecked != false || deferredRequest != nil || deferredInFlight {
                completion?(nil)
                return
            }
            deferredRequest = (os, osVersion, completion)
            maybeFetchDeferred()
        }
    }

    /// First and latest touch captured on this device, or nil.
    public func getAttribution() -> (first: [String: String], latest: [String: String])? {
        sync { () -> (first: [String: String], latest: [String: String])? in
            guard let f = state.attributionFirst, let l = state.attributionLatest else { return nil }
            return (f, l)
        }
    }

    public func getAnonymousId() -> String { sync { state.anonymousId } }

    public func getUserId() -> String? { sync { state.userId } }

    public var queueLength: Int { sync { events.count } }

    /// Call on logout: forgets the user and attribution and starts a new anonymous id and session. Queued events
    /// keep their ids. Consent belongs to the device and is kept (and recorded for the new id).
    public func reset() {
        queue.async { [self] in
            var s = State(anonymousId: uuid())
            s.appVersion = state.appVersion
            s.appBuild = state.appBuild
            s.consent = state.consent
            s.deferredChecked = state.deferredChecked
            state = s
            heldFirst = nil
            heldLatest = nil
            persistState()
            resendConsent()
        }
    }

    public func optOut() {
        queue.async { [self] in optedOut = true }
    }

    public func optIn() {
        queue.async { [self] in
            optedOut = false
            schedule(0)
        }
    }

    /// Sends everything queued now, batch after batch; `completion` gets the last result (on the SDK queue).
    public func flush(completion: ((FlushResult) -> Void)? = nil) {
        queue.async { [self] in
            flushLoop(last: .empty, round: 0) { completion?($0) }
        }
    }

    /// Sends app_installed on the first launch with the SDK and app_updated when the version or build changed.
    /// `attributionToken` is called (on the SDK queue) only for app_installed, and only when attribution
    /// consent is not denied: pass `AppleAttribution.adServicesToken` to send Apple's AdServices token once,
    /// as context.attribution.adservices_token (Analytics.initialize does).
    public func trackInstallOrUpdate(appVersion: String?, appBuild: String?, timestamp: Date = Date(), attributionToken: (() -> String?)? = nil) {
        let at = Int64(timestamp.timeIntervalSince1970 * 1000)
        queue.async { [self] in
            let version = appVersion ?? ""
            let build = appBuild ?? ""
            if state.appVersion == nil && state.appBuild == nil {
                var extra: [String: String] = [:]
                if consentFor(.attribution) != .denied, let token = attributionToken?(), !token.isEmpty {
                    extra["adservices_token"] = String(token.prefix(4096))
                }
                enqueueNow(eventId: nil, at: at, partial: ["type": "track", "event_name": "app_installed", "properties": ["version": version, "build": build]], extraAttribution: extra)
            } else if (state.appVersion ?? "") != version || (state.appBuild ?? "") != build {
                enqueueNow(eventId: nil, at: at, partial: [
                    "type": "track", "event_name": "app_updated",
                    "properties": ["version": version, "build": build, "previous_version": state.appVersion ?? "", "previous_build": state.appBuild ?? ""],
                ])
            }
            state.appVersion = version
            state.appBuild = build
            persistState()
        }
    }

    /// Cancels timers. Queued events stay on disk and are sent by the next client.
    public func shutdown() {
        sync {
            timer?.cancel()
            timer = nil
        }
    }

    // MARK: Internals

    private func sync<T>(_ fn: () -> T) -> T {
        if DispatchQueue.getSpecific(key: queueKey) == true { return fn() }
        return queue.sync(execute: fn)
    }

    private func load() {
        var loadedState: State?
        if let raw = store.get(prefix + "state"), let obj = parseJSON(raw) as? [String: Any] {
            loadedState = State(json: obj)
        }
        if let s = loadedState, !s.anonymousId.isEmpty {
            state = s
            // Installs from before deferred deep links existed are not new installs: they never ask.
            if state.deferredChecked == nil { state.deferredChecked = true }
        } else {
            // A new install still has to ask for its deferred deep link (false until answered).
            state = State(anonymousId: uuid())
            state.deferredChecked = false
        }
        events = []
        if let raw = store.get(prefix + "queue"), let arr = parseJSON(raw) as? [Any] {
            events = arr.compactMap { QueuedEvent(json: $0) }
        }
        // Unsent events from before a denial (e.g. the app closed mid-way) are not sent.
        events.removeAll { $0.e["type"] as? String != "consent" && consentFor(purposeOf($0)) == .denied }
        persistState()
        persistQueue()
        if !events.isEmpty { schedule(0) }
    }

    private func enqueue(eventId: String? = nil, timestamp: Date? = nil, purpose: ConsentPurpose = .analytics, _ build: @escaping () -> [String: Any]) {
        // Timestamp is taken at call time, not when the SDK queue gets to it.
        let at = timestamp.map { Int64($0.timeIntervalSince1970 * 1000) } ?? clock()
        queue.async { [self] in
            enqueueNow(eventId: eventId, at: at, partial: build(), purpose: purpose)
        }
    }

    private func enqueueNow(eventId: String?, at: Int64, partial: [String: Any], purpose: ConsentPurpose = .analytics, extraAttribution: [String: String] = [:]) {
        let status = consentFor(purpose)
        if status == .denied { return log("dropped (consent denied): \(partial["type"] ?? "") \(partial["event_name"] ?? "")") }
        var e = partial
        let id = eventId ?? uuid()
        if events.contains(where: { $0.eventId == id }) || held.contains(where: { $0.eventId == id }) { return } // duplicate call with the same event id
        e["event_id"] = id
        e["timestamp"] = isoString(at)
        e["anonymous_id"] = state.anonymousId
        e["session_id"] = touchSession(at)
        var ctx = context()
        var attr = state.attributionLatest ?? heldLatest ?? [:]
        for (k, v) in extraAttribution { attr[k] = v }
        let attrStatus = consentFor(.attribution)
        if attrStatus == .granted && !attr.isEmpty { ctx["attribution"] = attr }
        e["context"] = ctx
        if let u = state.userId { e["user_id"] = u }
        guard let safe = jsonSafe(e) as? [String: Any] else { return }
        if status == .pending {
            // Waiting for consent: memory only, bounded like the queue. The attribution waits too, in case
            // attribution consent is granted by the time the event is released.
            held.append(QueuedEvent(e: safe, queuedAt: clock(), attr: attrStatus == .pending && !attr.isEmpty ? attr : nil))
            if held.count > o.maxQueueSize { held.removeFirst(held.count - o.maxQueueSize) }
            return log("held until consent: \(e["type"] ?? "") \(e["event_name"] ?? "")")
        }
        events.append(QueuedEvent(e: safe, queuedAt: clock()))
        if events.count > o.maxQueueSize {
            let dropped = events.count - o.maxQueueSize
            events.removeFirst(dropped)
            warn("queue full: dropped \(dropped) oldest event(s)")
        }
        log("queued \(e["type"] ?? "") \(e["event_name"] ?? "")")
        persistQueue()
        schedule(events.count >= o.flushAt ? 0 : Int64(o.flushInterval * 1000))
    }

    private func touchSession(_ at: Int64) -> String {
        if state.sessionId == nil || state.lastActivity == nil || Double(at - state.lastActivity!) > o.sessionTimeout * 1000 {
            state.sessionId = uuid()
        }
        state.lastActivity = max(at, state.lastActivity ?? 0)
        persistState()
        return state.sessionId!
    }

    private func context() -> [String: Any] {
        var ctx = contextProvider()
        for (k, v) in o.context { ctx[k] = v }
        ctx["platform"] = o.platform
        ctx["sdk"] = ["name": sdkName, "version": leanAppSDKVersion]
        if let v = o.appVersion { ctx["app_version"] = v }
        if let b = o.appBuild { ctx["app_build"] = b }
        // The user's explicit answers only: a default is not consent the user gave.
        if !state.consent.isEmpty { ctx["consent"] = state.consent }
        return ctx
    }

    private func purposeOf(_ q: QueuedEvent) -> ConsentPurpose {
        q.e["type"] as? String == "push_token" ? .push : .analytics
    }

    private func consentFor(_ purpose: ConsentPurpose) -> ConsentStatus {
        switch state.consent[purpose.rawValue] {
        case .some(true): return .granted
        case .some(false): return .denied
        case .none: return o.consentDefaults[purpose] ?? o.consentDefault
        }
    }

    /// Stores a touch under attribution consent: the first is kept, the latest replaced.
    private func recordTouch(_ touch: [String: String]) {
        switch consentFor(.attribution) {
        case .denied:
            return
        case .pending:
            // Kept in memory until the user decides; stored only once attribution consent is granted.
            if heldFirst == nil { heldFirst = state.attributionFirst ?? touch }
            heldLatest = touch
        case .granted:
            state.attributionFirst = state.attributionFirst ?? touch
            state.attributionLatest = touch
            persistState()
        }
    }

    /// Moves or discards what was waiting for consent after the user's answer changed.
    private func applyConsent() {
        let attribution = consentFor(.attribution)
        let release = held.filter { consentFor(purposeOf($0)) == .granted }
        held.removeAll { consentFor(purposeOf($0)) != .pending }
        let before = events.count
        // Denied: unsent events of that purpose are discarded. Consent changes always stay.
        events.removeAll { $0.e["type"] as? String != "consent" && consentFor(purposeOf($0)) == .denied }
        if before != events.count { log("consent denied: discarded \(before - events.count) unsent event(s)") }
        for q in release {
            var e = q.e
            // Attribution that waited with the event goes only if attribution consent is granted now.
            if let attr = q.attr, attribution == .granted {
                var ctx = e["context"] as? [String: Any] ?? [:]
                ctx["attribution"] = attr
                e["context"] = ctx
            }
            events.append(QueuedEvent(e: e, queuedAt: q.queuedAt))
        }
        if events.count > o.maxQueueSize { events.removeFirst(events.count - o.maxQueueSize) }
        if attribution == .granted && (heldFirst != nil || heldLatest != nil) {
            state.attributionFirst = state.attributionFirst ?? heldFirst ?? heldLatest
            if let l = heldLatest { state.attributionLatest = l }
            if state.attributionLatest == nil { state.attributionLatest = state.attributionFirst }
            persistState()
        }
        if attribution != .pending {
            heldFirst = nil
            heldLatest = nil
        }
        if attribution == .denied && (state.attributionFirst != nil || state.attributionLatest != nil) {
            state.attributionFirst = nil
            state.attributionLatest = nil
            persistState()
        }
        if before != events.count || !release.isEmpty { persistQueue() }
        if !events.isEmpty { schedule(events.count >= o.flushAt ? 0 : Int64(o.flushInterval * 1000)) }
        maybeFetchDeferred()
    }

    /// Queues a consent change for LeanApp, whatever the answer, with only the ids and minimal context.
    private func pushConsent(_ consent: [ConsentPurpose: Bool], at: Int64) {
        var ctx: [String: Any] = ["platform": o.platform, "sdk": ["name": sdkName, "version": leanAppSDKVersion]]
        if let v = o.appVersion { ctx["app_version"] = v }
        var answers: [String: Bool] = [:]
        for (p, v) in consent { answers[p.rawValue] = v }
        var e: [String: Any] = [
            "type": "consent",
            "consent": answers,
            "event_id": uuid(),
            "timestamp": isoString(at),
            "anonymous_id": state.anonymousId,
            "context": ctx,
        ]
        if let u = state.userId { e["user_id"] = u }
        guard let safe = jsonSafe(e) as? [String: Any] else { return }
        events.append(QueuedEvent(e: safe, queuedAt: at))
        if events.count > o.maxQueueSize {
            // Never drop a consent change to make room: drop the oldest other event instead.
            let i = events.firstIndex { $0.e["type"] as? String != "consent" } ?? 0
            events.remove(at: i)
        }
        log("queued consent \(answers)")
        persistQueue()
        schedule(0)
    }

    /// Records the device's explicit answers again for a new identity (sign-in, alias, reset).
    private func resendConsent() {
        var answers: [ConsentPurpose: Bool] = [:]
        for (k, v) in state.consent { if let p = ConsentPurpose(rawValue: k) { answers[p] = v } }
        if !answers.isEmpty { pushConsent(answers, at: clock()) }
    }

    private func maybeFetchDeferred() {
        guard let req = deferredRequest else { return }
        switch consentFor(.attribution) {
        case .pending:
            return // asked once attribution consent is granted
        case .denied:
            deferredRequest = nil
            req.completion?(nil)
            return
        case .granted:
            break
        }
        deferredRequest = nil
        deferredInFlight = true
        var body: [String: Any] = ["anonymous_id": state.anonymousId, "platform": o.platform]
        if let os = req.os { body["os"] = os }
        if let v = req.osVersion { body["os_version"] = String(v.prefix(40)) }
        if let clickId = state.attributionLatest?["click_id"] { body["click_id"] = String(clickId.prefix(100)) }
        guard let url = URL(string: o.endpoint + "/v1/deep-links/deferred"),
              let data = try? JSONSerialization.data(withJSONObject: body) else {
            deferredInFlight = false
            req.completion?(nil)
            return
        }
        let headers = ["Content-Type": "application/json", "Authorization": "Bearer \(o.apiKey)"]
        transport.post(url: url, headers: headers, body: data) { [self] result in
            queue.async { [self] in
                deferredInFlight = false
                var answer: DeferredDeepLink?
                switch result {
                case .failure(let err):
                    warn("deferred deep link request failed: \(err.localizedDescription)")
                case .success(let res):
                    if res.ok {
                        answer = (try? JSONSerialization.jsonObject(with: res.body)).flatMap { DeferredDeepLink(json: $0) }
                        state.deferredChecked = true
                        persistState()
                    } else {
                        warn("deferred deep link request failed with \(res.status)")
                        // Asked again on the next launch, unless the request itself was refused as invalid.
                        if res.status == 400 || res.status == 422 {
                            state.deferredChecked = true
                            persistState()
                        }
                    }
                }
                req.completion?(answer)
            }
        }
    }

    private func schedule(_ delayMs: Int64) {
        if paused || !timersEnabled { return }
        let wait = max(delayMs, retryAt - clock(), 0)
        if let t = timer, !t.isCancelled {
            if wait > 0 { return } // a send is already scheduled
            t.cancel()
        }
        let item = DispatchWorkItem { [weak self] in
            guard let self = self else { return }
            self.timer = nil
            self.sendBatch(manual: false) { r in
                if case .sent = r, !self.events.isEmpty {
                    self.schedule(self.events.count >= self.o.flushAt ? 0 : Int64(self.o.flushInterval * 1000))
                }
            }
        }
        timer = item
        queue.asyncAfter(deadline: .now() + .milliseconds(Int(wait)), execute: item)
    }

    private func flushLoop(last: FlushResult, round: Int, completion: @escaping (FlushResult) -> Void) {
        // Bounded: each round either removes events or stops.
        if round >= 1000 { return completion(last) }
        sendBatch(manual: true) { [self] r in
            if case .sent = r {
                if !events.isEmpty { return flushLoop(last: r, round: round + 1, completion: completion) }
                return completion(r)
            }
            if r == .empty, case .sent = last { return completion(last) }
            completion(r)
        }
    }

    /// Runs on `queue`; `completion` is called on `queue`.
    private func sendBatch(manual: Bool, completion: @escaping (FlushResult) -> Void) {
        if paused { return completion(.unauthorized) }
        if optedOut { return completion(.paused) }
        if sending { return completion(.busy) }
        let now = clock()
        if !manual && now < retryAt {
            schedule(retryAt - now)
            return completion(.retry(retryInMs: Int(retryAt - now), reason: "backoff"))
        }
        let before = events.count
        events.removeAll { now - $0.queuedAt > Int64(o.eventTTL * 1000) }
        if events.count != before {
            warn("dropped \(before - events.count) expired event(s)")
            persistQueue()
        }
        if events.isEmpty { return completion(.empty) }

        let batch = Array(events.prefix(maxBatchSize))
        let payload: [String: Any] = ["batch": batch.map { $0.e }, "sent_at": isoString(clock())]
        guard let url = URL(string: o.endpoint + "/v1/events/batch"),
              let body = try? JSONSerialization.data(withJSONObject: payload) else {
            warn("could not encode batch; dropping \(batch.count) event(s)")
            remove(batch)
            return completion(.sent(accepted: 0, duplicates: 0, rejected: batch.count))
        }
        var headers = [
            "Content-Type": "application/json",
            "Authorization": "Bearer \(o.apiKey)",
        ]
        // Same events → same key, so a retried request is answered from the server's idempotency store.
        if !skipIdempotencyKey { headers["Idempotency-Key"] = idempotencyKey(batch.map { $0.eventId }) }
        skipIdempotencyKey = false
        sending = true
        transport.post(url: url, headers: headers, body: body) { [self] result in
            queue.async { [self] in
                sending = false
                completion(handle(result, batch: batch))
            }
        }
    }

    private func handle(_ result: Result<HTTPResponse, Error>, batch: [QueuedEvent]) -> FlushResult {
        let res: HTTPResponse
        switch result {
        case .failure(let err): return backoff(nil, err.localizedDescription)
        case .success(let r): res = r
        }
        if res.ok {
            let parsed = (try? JSONSerialization.jsonObject(with: res.body)) as? [String: Any] ?? [:]
            let rejected = parsed["rejected"] as? [[String: Any]] ?? []
            for r in rejected {
                if let i = r["index"] as? Int, i >= 0, i < batch.count {
                    warn("event rejected by server: \(batch[i].e["event_name"] ?? batch[i].e["type"] ?? "") \(r["errors"] ?? "")")
                }
            }
            remove(batch)
            failures = 0
            retryAt = 0
            return .sent(accepted: parsed["accepted"] as? Int ?? 0, duplicates: parsed["duplicates"] as? Int ?? 0, rejected: rejected.count)
        }
        if res.status == 401 || res.status == 403 {
            // Revoked or wrong key: keep events, stop sending until the app restarts with a valid key.
            paused = true
            warn("API key rejected (revoked, expired or wrong environment). Events are kept but not sent.")
            return .unauthorized
        }
        if res.status == 409 {
            // idempotency_key_reused: nothing was stored. Keep the events and resend them without a key;
            // their event ids still make the resend safe.
            skipIdempotencyKey = true
            return backoff(0, "idempotency key already used for other events; resending without it")
        }
        if res.status == 413 && batch.count > 1 {
            maxBatchSize = max(1, batch.count / 2)
            return backoff(0, "payload too large; splitting batch")
        }
        if res.status == 400 || res.status == 413 || res.status == 422 {
            // The batch itself is malformed: retrying cannot succeed.
            warn("server refused batch (\(res.status)); dropping \(batch.count) event(s)")
            remove(batch)
            return .sent(accepted: 0, duplicates: 0, rejected: batch.count)
        }
        let retryAfter = res.header("Retry-After").flatMap { Double($0.trimmingCharacters(in: .whitespaces)) }
        return backoff(retryAfter.flatMap { $0 > 0 ? Int64($0 * 1000) : nil }, "HTTP \(res.status)")
    }

    private func backoff(_ explicitMs: Int64?, _ reason: String) -> FlushResult {
        failures += 1
        let exp = min(maxBackoffMs, baseBackoffMs * (1 << min(failures - 1, 16)))
        let wait = explicitMs ?? Int64((Double(exp) / 2 + random() * (Double(exp) / 2)).rounded()) // jittered
        retryAt = clock() + wait
        log("send failed (\(reason)); retrying in \(wait)ms")
        schedule(wait)
        return .retry(retryInMs: Int(wait), reason: reason)
    }

    private func remove(_ sent: [QueuedEvent]) {
        let ids = Set(sent.map { $0.eventId })
        events.removeAll { ids.contains($0.eventId) }
        persistQueue()
    }

    private func persistQueue() {
        write(prefix + "queue", events.map { $0.json })
    }

    private func persistState() {
        write(prefix + "state", state.json)
    }

    private func write(_ key: String, _ value: Any) {
        do {
            let data = try JSONSerialization.data(withJSONObject: value)
            try store.set(key, String(decoding: data, as: UTF8.self))
        } catch {
            warn("storage write failed: \(error)")
        }
    }

    private func parseJSON(_ text: String) -> Any? {
        try? JSONSerialization.jsonObject(with: Data(text.utf8))
    }

    private func log(_ msg: String) {
        if o.debug { print("[LeanApp] \(msg)") }
    }

    private func warn(_ msg: String) {
        if o.debug { print("[LeanApp] \(msg)") }
    }
}

struct QueuedEvent {
    let e: [String: Any]
    let queuedAt: Int64
    /// Memory only, on events held for consent: the attribution to attach if attribution consent is granted by then.
    var attr: [String: String]?

    var eventId: String { e["event_id"] as? String ?? "" }
    var json: [String: Any] { ["e": e, "queuedAt": queuedAt] }

    init(e: [String: Any], queuedAt: Int64, attr: [String: String]? = nil) {
        self.e = e
        self.queuedAt = queuedAt
        self.attr = attr
    }

    init?(json: Any) {
        guard let m = json as? [String: Any], let e = m["e"] as? [String: Any], e["event_id"] is String else { return nil }
        self.e = e
        self.queuedAt = (m["queuedAt"] as? NSNumber)?.int64Value ?? 0
    }
}

/// Persisted identity. Field names match the JavaScript SDK's state, plus native-only fields.
struct State {
    var anonymousId: String
    var userId: String?
    var sessionId: String?
    var lastActivity: Int64?
    var attributionFirst: [String: String]?
    var attributionLatest: [String: String]?
    var appVersion: String?
    var appBuild: String?
    /// The user's explicit answers (setConsent). Purposes not here follow the configured default.
    var consent: [String: Bool] = [:]
    /// false: a new install that still has to ask for its deferred deep link; nil: an install from before they existed.
    var deferredChecked: Bool?

    init(anonymousId: String) {
        self.anonymousId = anonymousId
    }

    init(json m: [String: Any]) {
        anonymousId = m["anonymousId"] as? String ?? ""
        userId = m["userId"] as? String
        sessionId = m["sessionId"] as? String
        lastActivity = (m["lastActivity"] as? NSNumber)?.int64Value
        if let a = m["attribution"] as? [String: Any] {
            attributionFirst = a["first"] as? [String: String]
            attributionLatest = a["latest"] as? [String: String]
        }
        appVersion = m["appVersion"] as? String
        appBuild = m["appBuild"] as? String
        consent = m["consent"] as? [String: Bool] ?? [:]
        deferredChecked = m["deferredChecked"] as? Bool
    }

    var json: [String: Any] {
        var m: [String: Any] = ["anonymousId": anonymousId]
        if let v = userId { m["userId"] = v }
        if let v = sessionId { m["sessionId"] = v }
        if let v = lastActivity { m["lastActivity"] = v }
        if let f = attributionFirst, let l = attributionLatest { m["attribution"] = ["first": f, "latest": l] }
        if let v = appVersion { m["appVersion"] = v }
        if let v = appBuild { m["appBuild"] = v }
        if !consent.isEmpty { m["consent"] = consent }
        if let v = deferredChecked { m["deferredChecked"] = v }
        return m
    }
}
