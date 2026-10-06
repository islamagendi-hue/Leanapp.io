package io.leanapp.analytics

import java.net.URLDecoder

/** Campaign parameters and ad-network click ids captured from deep links, landing URLs and the Play install referrer. */
val ATTRIBUTION_PARAMS: List<String> = listOf(
    "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
    "gclid", "gbraid", "wbraid", "fbclid", "ttclid", "ScCid", "twclid", "li_fat_id", "msclkid", "click_id",
)

/**
 * Extracts attribution parameters from a URL or query string; returns null when there are none.
 * Same rules as the JavaScript SDK: case-insensitive names, values capped at 1,000 characters.
 */
fun parseAttribution(url: String): Map<String, String>? {
    var search = url
    val q = url.indexOf('?')
    if (q >= 0) search = url.substring(q + 1)
    val hash = search.indexOf('#')
    if (hash >= 0) search = search.substring(0, hash)
    val out = LinkedHashMap<String, String>()
    for (pair in search.split('&')) {
        if (pair.isEmpty()) continue
        val eq = pair.indexOf('=')
        val rawK = if (eq >= 0) pair.substring(0, eq) else pair
        val rawV = if (eq >= 0) pair.substring(eq + 1).substringBefore('=') else ""
        val k: String
        val v: String
        try {
            k = URLDecoder.decode(rawK, "UTF-8")
            v = URLDecoder.decode(rawV, "UTF-8")
        } catch (e: Exception) {
            continue
        }
        val match = ATTRIBUTION_PARAMS.firstOrNull { it.equals(k, ignoreCase = true) }
        if (match != null && v.isNotEmpty()) out[match] = v.take(1000)
    }
    return if (out.isEmpty()) null else out
}

/** Google Play Install Referrer details, as returned by the Play Install Referrer library. */
data class InstallReferrer(
    /** The raw referrer string, e.g. "utm_source=google-play&utm_medium=organic" or one carrying gclid. */
    val referrer: String,
    val referrerClickTimestampSeconds: Long = 0,
    val installBeginTimestampSeconds: Long = 0,
    val googlePlayInstant: Boolean = false,
) {
    /** Sent as context.campaign on every event. */
    fun toContext(): Map<String, Any?> = linkedMapOf(
        "install_referrer" to referrer.take(1000),
        "referrer_click_timestamp_seconds" to referrerClickTimestampSeconds,
        "install_begin_timestamp_seconds" to installBeginTimestampSeconds,
        "google_play_instant" to googlePlayInstant,
    )
}
