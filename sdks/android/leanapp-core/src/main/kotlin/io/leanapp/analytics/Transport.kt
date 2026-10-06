package io.leanapp.analytics

import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URI

class HttpResponse(val status: Int, private val headers: Map<String, String>, val body: String) {
    /** Case-insensitive header lookup. */
    fun header(name: String): String? = headers.entries.firstOrNull { it.key.equals(name, ignoreCase = true) }?.value
    val ok: Boolean get() = status in 200..299
}

/** Sends one HTTP POST. Throws IOException on network failure; returns any HTTP status as a response. */
interface HttpTransport {
    @Throws(IOException::class)
    fun post(url: String, headers: Map<String, String>, body: String): HttpResponse
}

/** HttpURLConnection transport: no third-party HTTP client needed. */
class UrlConnectionTransport(
    private val connectTimeoutMs: Int = 15_000,
    private val readTimeoutMs: Int = 20_000,
) : HttpTransport {
    override fun post(url: String, headers: Map<String, String>, body: String): HttpResponse {
        val conn = URI(url).toURL().openConnection() as HttpURLConnection
        try {
            conn.requestMethod = "POST"
            conn.connectTimeout = connectTimeoutMs
            conn.readTimeout = readTimeoutMs
            conn.doOutput = true
            conn.useCaches = false
            val bytes = body.toByteArray(Charsets.UTF_8)
            conn.setFixedLengthStreamingMode(bytes.size)
            for ((k, v) in headers) conn.setRequestProperty(k, v)
            conn.outputStream.use { it.write(bytes) }
            val status = conn.responseCode
            val stream: InputStream? = if (status >= 400) conn.errorStream else conn.inputStream
            val text = stream?.use { readAll(it) } ?: ""
            val h = HashMap<String, String>()
            for ((k, v) in conn.headerFields) if (k != null && v != null && v.isNotEmpty()) h[k] = v[0]
            return HttpResponse(status, h, text)
        } finally {
            conn.disconnect()
        }
    }

    private fun readAll(input: InputStream): String {
        val out = ByteArrayOutputStream()
        val buf = ByteArray(8192)
        while (true) {
            val n = input.read(buf)
            if (n < 0) break
            out.write(buf, 0, n)
        }
        return String(out.toByteArray(), Charsets.UTF_8)
    }
}
