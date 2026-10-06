import Foundation
#if canImport(UIKit)
import UIKit
#endif

/// Options for `Analytics.initialize`. Defaults match docs/sdk.md.
public struct AnalyticsOptions {
    public var endpoint: String = leanAppDefaultEndpoint
    public var flushAt: Int = 20
    public var flushInterval: TimeInterval = 10
    public var maxBatchSize: Int = 100
    public var maxQueueSize: Int = 1_000
    public var eventTTL: TimeInterval = 7 * 86_400
    public var sessionTimeout: TimeInterval = 30 * 60
    /// Extra context merged into every event.
    public var context: [String: Any] = [:]
    public var optedOut: Bool = false
    public var debug: Bool = false
    /// app_installed / app_updated on launch and app_opened on launch and on return to the foreground.
    public var trackLifecycleEvents: Bool = true

    public init() {}
}

/// LeanApp for iOS. Initialize once at launch:
///
///     Analytics.initialize(apiKey: "la_pk_live_…")
///     Analytics.track("order_completed", properties: ["order_id": "o1", "revenue": 45.0, "currency": "SAR"])
///
/// Calls before initialize are ignored with one warning; nothing throws after initialize.
public enum Analytics {
    private static let lock = NSLock()
    private static var instance: LeanAppClient?
    private static var warned = false
    private static var observers: [NSObjectProtocol] = []

    private static func client() -> LeanAppClient? {
        lock.lock(); defer { lock.unlock() }
        if instance == nil && !warned {
            warned = true
            print("[LeanApp] Analytics.initialize() has not been called; events are ignored.")
        }
        return instance
    }

    /// Starts the SDK (call it on the main thread, e.g. in application(_:didFinishLaunchingWithOptions:)) and returns the client, or nil (with a printed reason) for an invalid or secret key.
    @discardableResult
    public static func initialize(apiKey: String, options: AnalyticsOptions = AnalyticsOptions()) -> LeanAppClient? {
        lock.lock()
        if let existing = instance {
            lock.unlock()
            return existing
        }
        let versions = bundleVersions()
        var config = LeanAppConfig(apiKey: apiKey)
        config.endpoint = options.endpoint
        config.platform = "ios"
        config.appVersion = versions.version
        config.appBuild = versions.build
        config.flushAt = options.flushAt
        config.flushInterval = options.flushInterval
        config.maxBatchSize = options.maxBatchSize
        config.maxQueueSize = options.maxQueueSize
        config.eventTTL = options.eventTTL
        config.sessionTimeout = options.sessionTimeout
        config.context = options.context
        config.optedOut = options.optedOut
        config.debug = options.debug
        let facts = UIKitFacts.read()
        let created: LeanAppClient
        do {
            created = try LeanAppClient(
                config: config,
                store: FileStore(directory: FileStore.defaultDirectory()),
                contextProvider: { facts.apply(to: defaultContext()) }
            )
        } catch {
            lock.unlock()
            print("[LeanApp] \(error)")
            return nil
        }
        instance = created
        lock.unlock()

        if options.trackLifecycleEvents {
            created.trackInstallOrUpdate(appVersion: versions.version, appBuild: versions.build)
            created.track("app_opened", properties: ["from_background": false])
        }
        observeLifecycle(created, trackOpens: options.trackLifecycleEvents)
        return created
    }

    private static func observeLifecycle(_ client: LeanAppClient, trackOpens: Bool) {
        #if canImport(UIKit) && !os(watchOS)
        let center = NotificationCenter.default
        let background = center.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { _ in
            // Ask iOS for time to send the queue before the app is suspended.
            let app = UIApplication.shared
            let box = BackgroundTaskBox()
            box.id = app.beginBackgroundTask(withName: "LeanApp flush") {
                box.end(app)
            }
            client.flush { _ in
                DispatchQueue.main.async { box.end(app) }
            }
        }
        let foreground = center.addObserver(forName: UIApplication.willEnterForegroundNotification, object: nil, queue: .main) { _ in
            if trackOpens { client.track("app_opened", properties: ["from_background": true]) }
        }
        lock.lock()
        observers.append(contentsOf: [background, foreground])
        lock.unlock()
        #endif
    }

    #if canImport(UIKit) && !os(watchOS)
    private final class BackgroundTaskBox {
        var id: UIBackgroundTaskIdentifier = .invalid

        func end(_ app: UIApplication) {
            if id != .invalid {
                app.endBackgroundTask(id)
                id = .invalid
            }
        }
    }
    #endif

    public static func track(_ eventName: String, properties: [String: Any] = [:], eventId: String? = nil, timestamp: Date? = nil) {
        client()?.track(eventName, properties: properties, eventId: eventId, timestamp: timestamp)
    }

    public static func screen(_ screenName: String, properties: [String: Any] = [:]) {
        client()?.screen(screenName, properties: properties)
    }

    public static func identify(_ userId: String?, traits: [String: Any] = [:]) {
        client()?.identify(userId, traits: traits)
    }

    public static func setUserProperties(_ traits: [String: Any]) {
        client()?.setUserProperties(traits)
    }

    public static func alias(_ newUserId: String, previousId: String? = nil) {
        client()?.alias(newUserId, previousId: previousId)
    }

    /// Pass the APNs device token as hex, or an FCM token with provider "fcm".
    public static func registerPushToken(_ token: String, provider: String = "apns", permission: String = "unknown") {
        client()?.registerPushToken(token, provider: provider, permission: permission)
    }

    /// APNs device token Data → hex string, then registered.
    public static func registerPushToken(deviceToken: Data, permission: String = "unknown") {
        let hex = deviceToken.map { String(format: "%02x", $0) }.joined()
        registerPushToken(hex, provider: "apns", permission: permission)
    }

    /// Call with the URL from scene(_:openURLContexts:), scene(_:continue:) or application(_:open:options:).
    @discardableResult
    public static func captureAttribution(_ url: URL) -> [String: String]? {
        client()?.captureAttribution(url.absoluteString)
    }

    public static func getAttribution() -> (first: [String: String], latest: [String: String])? {
        client()?.getAttribution()
    }

    public static func getAnonymousId() -> String? { client()?.getAnonymousId() }

    public static func getUserId() -> String? { client()?.getUserId() }

    public static func reset() { client()?.reset() }

    public static func optOut() { client()?.optOut() }

    public static func optIn() { client()?.optIn() }

    public static func flush(completion: ((FlushResult) -> Void)? = nil) {
        if let c = client() {
            c.flush(completion: completion)
        } else {
            completion?(.empty)
        }
    }
}
