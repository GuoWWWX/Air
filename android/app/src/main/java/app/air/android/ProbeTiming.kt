package app.air.android

import java.util.concurrent.CompletableFuture
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

internal const val DEFAULT_PROBE_TIMEOUT_MS = 4_500
internal const val DEFAULT_PROBE_BACKUP_DELAY_MS = 1_500L
internal const val BASE_PROBE_CONCURRENCY = 24
internal fun foregroundProbeConcurrency(processors: Int): Int = processors.coerceIn(6, 12) * 4
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

internal fun probeServerKey(server: String): String {
    val host = server.trim().trimEnd('.').removeSurrounding("[", "]").lowercase()
    return if (':' in host) runCatching { java.net.InetAddress.getByName(host).hostAddress }.getOrNull() ?: host else host
}

private class PendingProbe(val target: ProbeTarget, val deadline: Long, var backupAt: Long?, val queue: ArrayDeque<String>) {
    var remaining = if (backupAt == null) 1 else 2
}

// A node takes a slot until it succeeds, fails, or reaches its own deadline.
internal fun measureDelays(
    targets: Map<String, ProbeTarget>,
    servers: Map<String, String> = emptyMap(),
    timeoutMs: Int = DEFAULT_PROBE_TIMEOUT_MS,
    backupDelayMs: Long = DEFAULT_PROBE_BACKUP_DELAY_MS,
    background: Boolean = false,
    highSpeed: Boolean = false,
    concurrency: Int = if (highSpeed && !background) foregroundProbeConcurrency(Runtime.getRuntime().availableProcessors()) else BASE_PROBE_CONCURRENCY,
    cancelled: () -> Boolean = { false },
    completed: LinkedBlockingQueue<Pair<String, Int>> = LinkedBlockingQueue(),
    onResult: (name: String, delay: Int) -> Unit = { _, _ -> },
    start: (name: String, url: String, timeoutMs: Int) -> CompletableFuture<Int>,
): Map<String, Int> {
    fun launch(name: String, url: String, timeout: Int) {
        start(name, url, timeout).whenComplete { delay, _ -> completed.offer(name to (delay ?: -1)) }
    }
    val results = mutableMapOf<String, Int>()
    val queues = if (background) targets.keys.groupBy { servers[it] ?: it }.values else targets.keys.map { listOf(it) }
    val ready = ArrayDeque(queues.map { ArrayDeque(it) })
    val serverCounts = servers.values.groupingBy { it }.eachCount()
    val active = mutableMapOf<String, PendingProbe>()
    val limit = concurrency.coerceAtLeast(1)
    val effectiveTimeout = timeoutMs.coerceAtLeast(1)
    val duration = TimeUnit.MILLISECONDS.toNanos(effectiveTimeout.toLong())
    val backupDelay = TimeUnit.MILLISECONDS.toNanos(backupDelayMs.coerceIn(0L, effectiveTimeout.toLong()))
    fun record(name: String, job: PendingProbe, delay: Int) {
        results[name] = delay
        if (job.queue.isNotEmpty()) ready.addLast(job.queue)
        onResult(name, delay)
    }

    while (!cancelled()) {
        while (active.size < limit && ready.isNotEmpty() && !cancelled()) {
            val queue = ready.removeFirst()
            val name = queue.removeFirst()
            val target = targets.getValue(name)
            val started = System.nanoTime()
            val shared = (serverCounts[servers[name]] ?: 0) > 1 && target.alternate != null
            val backupAt = target.alternate?.let { started + if (shared) duration else backupDelay }
            active[name] = PendingProbe(target, started + duration, backupAt, queue)
            // Each node on a shared entrance reserves time for its own fallback.
            val primaryBudget = if (shared) (effectiveTimeout - TimeUnit.NANOSECONDS.toMillis(backupDelay).toInt()).coerceAtLeast(1) else effectiveTimeout
            launch(name, target.url, primaryBudget)
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
                    record(name, job, delay)
                } else if (job.backupAt != null) {
                    job.backupAt = System.nanoTime()
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
                record(name, job, -1)
            } else if (job.backupAt?.let { now >= it } == true && job.target.alternate != null) {
                job.backupAt = null
                val budget = TimeUnit.NANOSECONDS.toMillis(job.deadline - now).toInt()
                if (budget > 0) launch(name, job.target.alternate, budget)
            }
        }
    }
    return results
}
