package io.leanapp.analytics

import java.io.File
import java.io.IOException

/** Where the SDK keeps its identity and queue. All calls happen on the SDK's own thread. */
interface KeyValueStore {
    fun get(key: String): String?
    fun set(key: String, value: String)
    fun remove(key: String)
}

/** Keeps nothing across restarts. For tests and short-lived processes. */
class InMemoryStore : KeyValueStore {
    private val map = HashMap<String, String>()
    @Synchronized override fun get(key: String): String? = map[key]
    @Synchronized override fun set(key: String, value: String) { map[key] = value }
    @Synchronized override fun remove(key: String) { map.remove(key) }
}

/**
 * One file per key in [directory]. Writes go to a temporary file that is renamed over the old one,
 * so a crash mid-write leaves the previous version intact.
 */
class FileStore(private val directory: File) : KeyValueStore {
    private fun fileFor(key: String): File {
        val safe = key.map { if (it.isLetterOrDigit() || it == '_' || it == '-' || it == '.') it else '_' }.joinToString("")
        return File(directory, "$safe.json")
    }

    @Synchronized
    override fun get(key: String): String? {
        val f = fileFor(key)
        return try {
            if (f.exists()) f.readText(Charsets.UTF_8) else null
        } catch (e: IOException) {
            null
        }
    }

    @Synchronized
    override fun set(key: String, value: String) {
        if (!directory.exists() && !directory.mkdirs() && !directory.exists()) throw IOException("cannot create $directory")
        val target = fileFor(key)
        val tmp = File(directory, target.name + ".tmp")
        tmp.writeText(value, Charsets.UTF_8)
        if (!tmp.renameTo(target)) {
            // Some file systems refuse to rename over an existing file.
            target.delete()
            if (!tmp.renameTo(target)) throw IOException("cannot write $target")
        }
    }

    @Synchronized
    override fun remove(key: String) {
        fileFor(key).delete()
    }
}
