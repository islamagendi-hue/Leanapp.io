package io.leanapp.analytics

/** A consent purpose's state: the user's answer, or the configured default where they haven't answered. */
enum class ConsentStatus { GRANTED, PENDING, DENIED }

/**
 * What the user can agree to; each purpose is decided separately. Same purposes as the JavaScript SDK.
 * analytics governs track/screen/identify/alias; push governs registerPushToken; attribution governs
 * captureAttribution, the install referrer, the attribution and campaign context on events and the
 * deferred deep link request; marketing is recorded with the others for your own use.
 */
object ConsentPurpose {
    const val ANALYTICS = "analytics"
    const val MARKETING = "marketing"
    const val PUSH = "push"
    const val ATTRIBUTION = "attribution"
    val ALL: List<String> = listOf(ANALYTICS, MARKETING, PUSH, ATTRIBUTION)
}

/** LeanApp's answer from POST /v1/deep-links/deferred. */
data class DeferredDeepLink(
    /** deterministic, probabilistic or none. */
    val matchType: String,
    /** Why nothing matched: no_click, already_checked, disabled. */
    val reason: String? = null,
    val matchKey: String? = null,
    val linkCode: String? = null,
    val linkName: String? = null,
    /** The in-app path to open, e.g. /product/42, or null when the link has none. */
    val deepLinkPath: String? = null,
    /** The path with its parameters. */
    val deepLinkUrl: String? = null,
    val deepLinkParams: Map<String, String> = emptyMap(),
    val campaign: Map<String, String?> = emptyMap(),
    val clickId: String? = null,
) {
    val matched: Boolean get() = matchType != "none"

    companion object {
        /** Parses the endpoint's JSON body (as parsed by [Json]). */
        fun fromJson(v: Any?): DeferredDeepLink? {
            val m = v as? Map<*, *> ?: return null
            val type = m["match_type"] as? String ?: return null
            val link = m["link"] as? Map<*, *>
            val dl = m["deep_link"] as? Map<*, *>
            val params = LinkedHashMap<String, String>()
            (dl?.get("params") as? Map<*, *>)?.forEach { (k, x) -> if (k is String && x is String) params[k] = x }
            val campaign = LinkedHashMap<String, String?>()
            (m["campaign"] as? Map<*, *>)?.forEach { (k, x) -> if (k is String) campaign[k] = x as? String }
            return DeferredDeepLink(
                matchType = type,
                reason = m["reason"] as? String,
                matchKey = m["match_key"] as? String,
                linkCode = link?.get("code") as? String,
                linkName = link?.get("name") as? String,
                deepLinkPath = dl?.get("path") as? String,
                deepLinkUrl = dl?.get("url") as? String,
                deepLinkParams = params,
                campaign = campaign,
                clickId = m["click_id"] as? String,
            )
        }
    }
}
