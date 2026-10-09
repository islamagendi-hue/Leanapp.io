import Foundation

/// A consent purpose's state: the user's answer, or the configured default where they haven't answered.
public enum ConsentStatus: String {
    case granted
    case pending
    case denied
}

/// What the user can agree to; each purpose is decided separately. Same purposes as the JavaScript SDK.
/// analytics governs track/screen/identify/alias; push governs registerPushToken; attribution governs
/// captureAttribution, the attribution context on events, the AdServices token and the deferred deep
/// link request; marketing is recorded with the others for your own use.
public enum ConsentPurpose: String, CaseIterable {
    case analytics
    case marketing
    case push
    case attribution
}

/// LeanApp's answer from POST /v1/deep-links/deferred.
public struct DeferredDeepLink: Equatable {
    /// deterministic, probabilistic or none.
    public let matchType: String
    /// Why nothing matched: no_click, already_checked, disabled.
    public let reason: String?
    public let matchKey: String?
    public let linkCode: String?
    public let linkName: String?
    /// The in-app path to open, e.g. /product/42, or nil when the link has none.
    public let deepLinkPath: String?
    /// The path with its parameters.
    public let deepLinkURL: String?
    public let deepLinkParams: [String: String]
    public let campaign: [String: String]
    public let clickId: String?

    public var matched: Bool { matchType != "none" }

    /// Parses the endpoint's JSON body.
    public init?(json: Any) {
        guard let m = json as? [String: Any], let type = m["match_type"] as? String else { return nil }
        let link = m["link"] as? [String: Any]
        let dl = m["deep_link"] as? [String: Any]
        matchType = type
        reason = m["reason"] as? String
        matchKey = m["match_key"] as? String
        linkCode = link?["code"] as? String
        linkName = link?["name"] as? String
        deepLinkPath = dl?["path"] as? String
        deepLinkURL = dl?["url"] as? String
        deepLinkParams = (dl?["params"] as? [String: Any] ?? [:]).compactMapValues { $0 as? String }
        campaign = (m["campaign"] as? [String: Any] ?? [:]).compactMapValues { $0 as? String }
        clickId = m["click_id"] as? String
    }
}
