import Foundation

/// UTM parameters.
public let utmParams: [String] = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "utm_id"]

/// Ad-network click ids (Snapchat's is ScCid; sccid is read too).
public let clickIdParams: [String] = ["gclid", "gbraid", "wbraid", "fbclid", "ttclid", "ScCid", "twclid", "li_fat_id", "msclkid", "click_id"]

/// Campaign / ad set / ad ids from ad-network URL macros. Kept only next to a UTM or click id.
public let campaignIdParams: [String] = ["campaign_id", "adset_id", "ad_id"]

/// Campaign parameters and ad-network click ids captured from deep links and landing URLs.
public let attributionParams: [String] = utmParams + clickIdParams + campaignIdParams

/// True when the map has a UTM or a click id: evidence of where the user came from.
public func hasSourceParams(_ a: [String: String]?) -> Bool {
    guard let a = a else { return false }
    return (utmParams + clickIdParams).contains { !(a[$0] ?? "").isEmpty }
}

/// Extracts attribution parameters from a URL or query string; nil when there are none.
/// Same rules as the JavaScript SDK: case-insensitive names, values capped at 1,000 characters, and
/// campaign / ad set / ad ids alone (often an app's own parameters) are not attribution.
public func parseAttribution(_ url: String) -> [String: String]? {
    var search = Substring(url)
    if let q = search.firstIndex(of: "?") { search = search[search.index(after: q)...] }
    if let h = search.firstIndex(of: "#") { search = search[..<h] }
    var out: [String: String] = [:]
    for pair in search.split(separator: "&", omittingEmptySubsequences: true) {
        let parts = pair.split(separator: "=", maxSplits: 2, omittingEmptySubsequences: false)
        let rawK = String(parts[0]).replacingOccurrences(of: "+", with: " ")
        let rawV = parts.count > 1 ? String(parts[1]).replacingOccurrences(of: "+", with: " ") : ""
        guard let k = rawK.removingPercentEncoding, let v = rawV.removingPercentEncoding else { continue }
        if let match = attributionParams.first(where: { $0.lowercased() == k.lowercased() }), !v.isEmpty {
            out[match] = String(v.prefix(1000))
        }
    }
    return hasSourceParams(out) ? out : nil
}
