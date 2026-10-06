import Foundation
#if canImport(UIKit)
import UIKit
#endif

/// Hardware model identifier such as "iPhone15,2". No device identifiers are collected.
func hardwareModel() -> String? {
    var info = utsname()
    uname(&info)
    let mirror = Mirror(reflecting: info.machine)
    let id = mirror.children.reduce(into: "") { acc, el in
        if let v = el.value as? Int8, v != 0 { acc.append(Character(UnicodeScalar(UInt8(bitPattern: v)))) }
    }
    return id.isEmpty ? nil : id
}

/// Locale, language, timezone, OS version and device model, read on each event.
public func defaultContext() -> [String: Any] {
    var ctx: [String: Any] = [:]
    let locale = Locale.current
    // "ar_SA@numbers=latn" → "ar-SA"
    let base = locale.identifier.split(separator: "@").first.map(String.init) ?? ""
    let tag = base.replacingOccurrences(of: "_", with: "-")
    if !tag.isEmpty {
        ctx["locale"] = String(tag.prefix(35))
        if let lang = tag.split(separator: "-").first { ctx["language"] = String(lang) }
    }
    ctx["timezone"] = TimeZone.current.identifier
    let v = ProcessInfo.processInfo.operatingSystemVersion
    ctx["os_version"] = "\(v.majorVersion).\(v.minorVersion).\(v.patchVersion)"
    var device: [String: Any] = ["manufacturer": "Apple"]
    if let model = hardwareModel() { device["model"] = model }
    ctx["device"] = device
    return ctx
}

/// The app's CFBundleShortVersionString and CFBundleVersion.
func bundleVersions() -> (version: String?, build: String?) {
    let info = Bundle.main.infoDictionary
    return (info?["CFBundleShortVersionString"] as? String, info?["CFBundleVersion"] as? String)
}

/// Device type and screen size. UIKit must be read on the main thread, so `Analytics.initialize` reads
/// these once there and merges them into every event's context.
struct UIKitFacts {
    var deviceType: String?
    var screen: [String: Any]?

    static func read() -> UIKitFacts {
        var facts = UIKitFacts()
        #if canImport(UIKit) && !os(watchOS)
        guard Thread.isMainThread else { return facts }
        facts.deviceType = UIDevice.current.userInterfaceIdiom == .pad ? "tablet" : "phone"
        let bounds = UIScreen.main.nativeBounds
        facts.screen = ["width": Int(bounds.width), "height": Int(bounds.height), "density": Double(UIScreen.main.nativeScale)]
        #endif
        return facts
    }

    func apply(to context: [String: Any]) -> [String: Any] {
        var ctx = context
        if let screen = screen { ctx["screen"] = screen }
        if let type = deviceType {
            var device = ctx["device"] as? [String: Any] ?? [:]
            device["type"] = type
            ctx["device"] = device
        }
        return ctx
    }
}
