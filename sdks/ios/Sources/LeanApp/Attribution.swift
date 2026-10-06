import Foundation

/// Campaign parameters and ad-network click ids captured from deep links and landing URLs.
public let attributionParams: [String] = [
    "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
    "gclid", "gbraid", "wbraid", "fbclid", "ttclid", "ScCid", "twclid", "li_fat_id", "msclkid", "click_id",
]

/// Extracts attribution parameters from a URL or query string; nil when there are none.
/// Same rules as the JavaScript SDK: case-insensitive names, values capped at 1,000 characters.
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
    return out.isEmpty ? nil : out
}
