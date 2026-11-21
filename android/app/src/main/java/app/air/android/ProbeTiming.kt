package app.air.android

import java.util.concurrent.CompletableFuture
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

internal data class ProbeTarget(val url: String, val expected: String, val alternate: String?) {
    companion object {
        private const val DEFAULT = "https://www.gstatic.com/generate_204"
        private const val CLOUDFLARE = "https://cp.cloudflare.com/generate_204"

        fun select(url: String, status: Int, sourceUrl: String?, sourceStatus: String?): ProbeTarget {
            if (url != DEFAULT || status != 204) return ProbeTarget(url, status.toString(), null)
            val primary = sourceUrl ?: DEFAULT
            val expected = sourceStatus ?: "204"
            val alternate = if (expected == "204" && primary.endsWith("/generate_204")) {
                if (primary == CLOUDFLARE) DEFAULT else CLOUDFLARE
            } else null
            return ProbeTarget(primary, expected, alternate)
        }
    }
}

// Each node keeps its first successful kernel measurement. Other nodes in the batch
// can still be waiting for their primary or the delayed alternative.
internal fun measureDelays(
    targets: Map<String, ProbeTarget>,
    start: (name: String, url: String, timeoutMs: Int) -> CompletableFuture<Int>,
): Map<String, Int> {
    val completed = LinkedBlockingQueue<Pair<String, Int>>()
    fun launch(name: String, url: String, timeoutMs: Int) {
        start(name, url, timeoutMs).whenComplete { delay, _ -> completed.offer(name to (delay ?: -1)) }
    }
    val results = mutableMapOf<String, Int>()
    val remaining = targets.mapValues { if (it.value.alternate == null) 1 else 2 }.toMutableMap()
    val started = System.nanoTime()
    val deadline = started + TimeUnit.SECONDS.toNanos(8)
    val backupAt = started + TimeUnit.SECONDS.toNanos(2)
    var backupsPending = targets.values.any { it.alternate != null }
    for ((name, target) in targets) launch(name, target.url, 8_000)
    while (results.size < targets.size) {
        val next = if (backupsPending) backupAt else deadline
        val sample = completed.poll((next - System.nanoTime()).coerceAtLeast(0), TimeUnit.NANOSECONDS)
        if (sample != null) {
            val (name, delay) = sample
            if (name in results) continue
            val left = remaining.getValue(name) - 1
            remaining[name] = left
            if (delay > 0 || left == 0) results[name] = delay
        } else {
            if (!backupsPending) break
            backupsPending = false
            val budget = TimeUnit.NANOSECONDS.toMillis(deadline - System.nanoTime()).toInt()
            if (budget <= 0) break
            for ((name, target) in targets) {
                if (name !in results && target.alternate != null) launch(name, target.alternate, budget)
            }
        }
    }
    return targets.mapValues { results[it.key] ?: -1 }
}
