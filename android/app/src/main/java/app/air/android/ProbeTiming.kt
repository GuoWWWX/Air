package app.air.android

import java.util.concurrent.CompletableFuture
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

internal const val DEFAULT_PROBE_TIMEOUT_MS = 4_500
internal const val DEFAULT_PROBE_BACKUP_DELAY_MS = 1_500L
internal const val PROBE_CONCURRENCY = 24
internal const val PROBE_CANCEL_SENTINEL = "\u0000cancel"

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

private class PendingProbe(val target: ProbeTarget, val deadline: Long, var backupAt: Long?) {
    var remaining = if (backupAt == null) 1 else 2
}

// A node takes a slot until it succeeds, fails, or reaches its own deadline.
internal fun measureDelays(
    targets: Map<String, ProbeTarget>,
    timeoutMs: Int = DEFAULT_PROBE_TIMEOUT_MS,
    backupDelayMs: Long = DEFAULT_PROBE_BACKUP_DELAY_MS,
    concurrency: Int = PROBE_CONCURRENCY,
    cancelled: () -> Boolean = { false },
    completed: LinkedBlockingQueue<Pair<String, Int>> = LinkedBlockingQueue(),
    onResult: (name: String, delay: Int) -> Unit = { _, _ -> },
    start: (name: String, url: String, timeoutMs: Int) -> CompletableFuture<Int>,
): Map<String, Int> {
    fun launch(name: String, url: String, timeout: Int) {
        start(name, url, timeout).whenComplete { delay, _ -> completed.offer(name to (delay ?: -1)) }
    }
    val results = mutableMapOf<String, Int>()
    val queued = targets.iterator()
    val active = mutableMapOf<String, PendingProbe>()
    val limit = concurrency.coerceAtLeast(1)
    val effectiveTimeout = timeoutMs.coerceAtLeast(1)
    val duration = TimeUnit.MILLISECONDS.toNanos(effectiveTimeout.toLong())
    val backupDelay = TimeUnit.MILLISECONDS.toNanos(backupDelayMs.coerceIn(0L, effectiveTimeout.toLong()))
    fun record(name: String, delay: Int) {
        results[name] = delay
        onResult(name, delay)
    }

    while (!cancelled()) {
        while (active.size < limit && queued.hasNext() && !cancelled()) {
            val (name, target) = queued.next()
            val started = System.nanoTime()
            active[name] = PendingProbe(target, started + duration, target.alternate?.let { started + backupDelay })
            launch(name, target.url, effectiveTimeout)
        }
        if (active.isEmpty() || cancelled()) break
        val next = active.values.minOf { it.backupAt ?: it.deadline }
        var sample = completed.poll((next - System.nanoTime()).coerceAtLeast(0), TimeUnit.NANOSECONDS)
        while (sample != null && !cancelled()) {
            val (name, delay) = sample
            if (name == PROBE_CANCEL_SENTINEL) return results
            val job = active[name]
            if (job != null) {
                job.remaining--
                if (delay > 0 || job.remaining == 0) {
                    active.remove(name)
                    record(name, delay)
                }
            }
            sample = completed.poll()
        }
        val jobs = active.entries.iterator()
        while (jobs.hasNext() && !cancelled()) {
            val (name, job) = jobs.next()
            val now = System.nanoTime()
            if (now >= job.deadline) {
                jobs.remove()
                record(name, -1)
            } else if (job.backupAt?.let { now >= it } == true && job.target.alternate != null) {
                job.backupAt = null
                val budget = TimeUnit.NANOSECONDS.toMillis(job.deadline - now).toInt()
                if (budget > 0) launch(name, job.target.alternate, budget)
            }
        }
    }
    return results
}
