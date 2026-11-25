package app.air.android

import org.json.JSONArray
import org.json.JSONObject

// Sampled rows and their nested metadata are immutable after capture.
internal fun JSONObject.copyFields() = JSONObject().also { copy ->
    for (key in keys()) copy.put(key, get(key))
}

internal class ConnectionSamples {
    private class Seen(val row: JSONObject, val at: Long) {
        var closed: JSONObject? = null
            private set
        var revision = 0L
            private set

        fun close(wallTime: Long, revision: Long) {
            closed = row.copyFields().put("closed", true).put("closedAt", wallTime)
            this.revision = revision
        }
    }

    private val recent = LinkedHashMap<String, Seen>()
    private var active: JSONArray? = null
    private var sampledAt = 0L
    private var revision = 0L

    @Synchronized
    fun record(rows: JSONArray, now: Long) {
        active = rows
        sampledAt = now
        for (index in 0 until rows.length()) {
            val row = rows.optJSONObject(index) ?: continue
            val id = row.optString("id")
            if (id.isEmpty() || row.optJSONObject("metadata")?.optString("type").equals("inner", true)) continue
            recent.remove(id)
            recent[id] = Seen(row, now)
            if (recent.size > HISTORY_LIMIT) recent.remove(recent.keys.first())
        }
        recent.entries.removeAll { now - it.value.at > HISTORY_MILLIS }
    }

    fun read(now: Long, since: Long, live: () -> JSONArray): JSONObject {
        synchronized(this) {
            active?.takeIf { now - sampledAt <= CACHE_MILLIS }?.let { return withClosed(it, now, since) }
        }
        val rows = live()
        return synchronized(this) { withClosed(if (sampledAt > now) active ?: rows else rows, now, since) }
    }

    private fun withClosed(rows: JSONArray, now: Long, since: Long): JSONObject {
        val result = JSONArray()
        val ids = HashSet<String>()
        for (index in 0 until rows.length()) {
            val row = rows.optJSONObject(index) ?: continue
            ids.add(row.optString("id"))
            result.put(row)
        }
        val cursor = if (since in 0..revision) since else 0L
        val wall = System.currentTimeMillis()
        for ((id, seen) in recent) {
            val age = (now - seen.at).coerceAtLeast(0)
            if (id !in ids && age <= HISTORY_MILLIS) {
                if (seen.closed == null) seen.close(wall - age, ++revision)
                if (seen.revision > cursor) result.put(seen.closed)
            }
        }
        return JSONObject().put("connections", result).put("revision", revision)
    }

    @Synchronized
    fun clearClosed() {
        val ids = HashSet<String>()
        active?.let { rows ->
            for (i in 0 until rows.length()) rows.optJSONObject(i)?.optString("id")?.let(ids::add)
        }
        recent.entries.removeAll { it.value.closed != null || it.key !in ids }
    }

    @Synchronized
    fun clear() {
        active = null
        sampledAt = 0L
        recent.clear()
    }

    private companion object {
        const val CACHE_MILLIS = 2_500L
        const val HISTORY_MILLIS = 30_000L
        const val HISTORY_LIMIT = 200
    }
}
