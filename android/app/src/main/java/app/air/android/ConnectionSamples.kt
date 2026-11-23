package app.air.android

import org.json.JSONArray
import org.json.JSONObject

internal class ConnectionSamples {
    private data class Seen(val row: JSONObject, val at: Long)

    private val recent = LinkedHashMap<String, Seen>()
    private var active: JSONArray? = null
    private var sampledAt = 0L

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

    fun read(now: Long, live: () -> JSONArray): JSONArray {
        synchronized(this) {
            active?.takeIf { now - sampledAt <= CACHE_MILLIS }?.let { return withClosed(it, now) }
        }
        val rows = live()
        return synchronized(this) { withClosed(if (sampledAt > now) active ?: rows else rows, now) }
    }

    private fun withClosed(rows: JSONArray, now: Long): JSONArray {
        val result = JSONArray()
        val ids = HashSet<String>()
        for (index in 0 until rows.length()) {
            val row = rows.optJSONObject(index) ?: continue
            ids.add(row.optString("id"))
            result.put(row)
        }
        val wall = System.currentTimeMillis()
        for ((id, seen) in recent) {
            val age = (now - seen.at).coerceAtLeast(0)
            if (id !in ids && age <= HISTORY_MILLIS) {
                result.put(JSONObject(seen.row.toString()).put("closed", true).put("closedAt", wall - age))
            }
        }
        return result
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
