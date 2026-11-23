package app.air.android

import android.content.Context
import android.util.AtomicFile
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileNotFoundException
import java.io.RandomAccessFile
import java.security.MessageDigest

internal fun configDirectory(context: Context) =
    File(context.noBackupFilesDir, "config").apply { check(isDirectory || mkdirs() || isDirectory) }

/** Only the atomic index publishes a new set of immutable subscription files. */
internal class ConfigFiles(private val directory: File, private val legacy: File) {
    private val index = File(directory, "library.json")
    private val sources = File(directory, "subscriptions")
    private val filename = Regex("[0-9a-f]{64}\\.json")

    private fun <T> locked(block: () -> T): T = synchronized(processLock) {
        RandomAccessFile(File(directory, "library.lock"), "rw").use { handle ->
            handle.channel.lock().use { block() }
        }
    }

    fun read(): JSONObject = locked { load() }

    fun saveOutbound(mode: String, choice: JSONObject?) = locked {
        // The subscriptions and the background probe targets remain valid.
        val value = checkNotNull(readObject(index))
        value.put("mode", mode).put("choice", choice)
        writeAtomic(AtomicFile(index), value.toString().toByteArray(Charsets.UTF_8))
    }

    fun save(value: JSONObject, schedule: (JSONObject) -> Unit) = locked {
        val previous = load()
        val stored = store(value)
        try {
            schedule(value)
        } catch (error: Exception) {
            store(previous)
            throw error
        }
        prune(stored)
    }

    private fun load(): JSONObject {
        val value = readObject(index)
        if (value == null) {
            val migrated = readObject(legacy) ?: JSONObject()
            store(migrated)
            return migrated
        }
        val refs = value.getJSONArray("subscriptionFiles")
        val records = JSONArray()
        for (i in 0 until refs.length()) {
            val name = refs.getString(i)
            require(filename.matches(name))
            records.put(JSONObject(File(sources, name).readText()))
        }
        value.remove("subscriptionFiles")
        return value.put("sources", records)
    }

    private fun readObject(file: File): JSONObject? = try {
        AtomicFile(file).openRead().bufferedReader(Charsets.UTF_8).use { JSONObject(it.readText()) }
    } catch (e: FileNotFoundException) {
        if (file.exists()) throw e else null
    }

    private fun store(value: JSONObject): Set<String> {
        check(sources.isDirectory || sources.mkdirs())
        val refs = JSONArray()
        val live = mutableSetOf<String>()
        val records = value.optJSONArray("sources") ?: JSONArray()
        for (i in 0 until records.length()) {
            val bytes = records.getJSONObject(i).toString().toByteArray(Charsets.UTF_8)
            val hash = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
            val name = "$hash.json"
            val file = File(sources, name)
            if (!file.isFile) writeAtomic(AtomicFile(file), bytes)
            refs.put(name)
            live.add(name)
        }
        val header = JSONObject()
        value.keys().forEach { if (it != "sources") header.put(it, value.get(it)) }
        header.put("subscriptionFiles", refs)
        writeAtomic(AtomicFile(index), header.toString().toByteArray(Charsets.UTF_8))
        return live
    }

    private fun prune(live: Set<String>) {
        sources.listFiles()?.forEach { if (filename.matches(it.name) && it.name !in live) it.delete() }
    }

    private companion object { val processLock = Any() }
}
