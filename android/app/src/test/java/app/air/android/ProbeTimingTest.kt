package app.air.android

import java.util.concurrent.CompletableFuture
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.atomic.AtomicBoolean
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ProbeTimingTest {
    private val google = "https://www.gstatic.com/generate_204"
    private val cloudflare = "https://cp.cloudflare.com/generate_204"

    @Test fun sourceTargetAndStatusOnlyApplyOnDefaultSettings() {
        assertEquals(ProbeTarget(cloudflare, "204", google), ProbeTarget.select(google, 204, cloudflare, "204"))
        assertEquals(ProbeTarget(google, "204", cloudflare), ProbeTarget.select(google, 204, null, null))
        val source = "https://example.org/health"
        assertEquals(ProbeTarget(source, "200-299", null), ProbeTarget.select(google, 204, source, "200-299"))
        assertEquals(ProbeTarget(google, "201", null), ProbeTarget.select(google, 201, source, "204"))
        assertNull(ProbeTarget.select(cloudflare, 204, source, "204").alternate)
    }

    @Test fun alternateOnlyTestsOutstandingNodesAndSharesTheirDeadline() {
        val target = ProbeTarget.select(google, 204, null, null)
        val targets = listOf("fast", "slow", "bothFailed", "primaryRecovered").associateWith { target }
        val slow = CompletableFuture<Int>()
        val recovered = CompletableFuture<Int>()
        val alternates = mutableSetOf<String>()
        val backupBudgetMax = DEFAULT_PROBE_TIMEOUT_MS - DEFAULT_PROBE_BACKUP_DELAY_MS.toInt()
        val results = measureDelays(targets) { alias, url, timeout ->
            if (url == google) {
                assertEquals(DEFAULT_PROBE_TIMEOUT_MS, timeout)
                when (alias) {
                    "slow" -> slow
                    "primaryRecovered" -> recovered
                    else -> CompletableFuture.completedFuture(if (alias == "fast") 106 else -1)
                }
            } else {
                alternates.add(alias)
                if (alias == "bothFailed") {
                    assertTrue("fast failure should start the alternate immediately", timeout > backupBudgetMax)
                } else {
                    assertTrue(timeout in 1..backupBudgetMax)
                }
                if (alias == "primaryRecovered") recovered.complete(150)
                CompletableFuture.completedFuture(if (alias == "slow") 127 else -1)
            }
        }
        assertEquals(setOf("slow", "bothFailed", "primaryRecovered"), alternates)
        assertEquals(mapOf("fast" to 106, "slow" to 127, "bothFailed" to -1, "primaryRecovered" to 150), results)
        slow.complete(480)
        assertEquals(127, results["slow"])
    }

    @Test fun cancellationStopsWaitingImmediatelyWithoutMarkingPendingNodesFailed() {
        val target = ProbeTarget.select(google, 204, null, null)
        val targets = listOf("fast", "stalled").associateWith { target }
        val cancelled = AtomicBoolean(false)
        val completed = LinkedBlockingQueue<Pair<String, Int>>()
        val startedAt = System.nanoTime()
        val results = measureDelays(
            targets = targets,
            timeoutMs = 4_500,
            backupDelayMs = 1_500,
            cancelled = { cancelled.get() },
            completed = completed,
        ) { alias, _, _ ->
            if (alias == "fast") {
                cancelled.set(true)
                completed.offer(PROBE_CANCEL_SENTINEL to -1)
                CompletableFuture.completedFuture(88)
            } else {
                CompletableFuture()
            }
        }
        val elapsedMs = (System.nanoTime() - startedAt) / 1_000_000L
        assertTrue("Expected fast cancellation exit, took ${elapsedMs}ms", elapsedMs < 1_000L)
        assertFalse(results.containsKey("stalled"))
    }

    @Test fun foregroundScalesWithAvailableProcessors() {
        assertEquals(listOf(24, 24, 24, 32, 48, 48), listOf(0, 2, 6, 8, 12, 64).map(::foregroundProbeConcurrency))
    }

    @Test fun foregroundFillsAllSlotsInPageOrderEvenWithOneEntranceAndASlowNode() {
        checkForegroundSlots(false, 24)
        checkForegroundSlots(true, foregroundProbeConcurrency(Runtime.getRuntime().availableProcessors()))
    }

    private fun checkForegroundSlots(highSpeed: Boolean, limit: Int) {
        val target = ProbeTarget(google, "204", null)
        val targets = (0 until 72).reversed().associate { it.toString() to target }
        val servers = targets.keys.associateWith { "pool.test" }
        val pending = linkedMapOf<String, CompletableFuture<Int>>()
        val started = mutableListOf<String>()
        var peak = 0
        var completed = 0
        val delays = measureDelays(targets, servers, highSpeed = highSpeed, onResult = { _, _ -> completed++ }) { name, _, _ ->
            started.add(name)
            val result = CompletableFuture<Int>()
            pending[name] = result
            peak = maxOf(peak, pending.size)
            if (pending.size == limit) {
                val next = pending.keys.first { it != "71" }
                pending.remove(next)!!.complete(110)
            }
            if (name == "0") {
                assertTrue(pending.containsKey("71"))
                pending.values.forEach { it.complete(110) }
                pending.clear()
            }
            result
        }
        assertEquals(limit, peak)
        assertEquals(targets.keys.toList(), started)
        assertEquals(72, completed)
        assertEquals(targets.mapValues { 110 }, delays)
    }

    @Test fun aQueuedNodeGetsItsOwnTimeoutBudget() {
        val target = ProbeTarget(google, "204", null)
        val targets = listOf("stalled", "queued").associateWith { target }
        val delays = measureDelays(targets, concurrency = 1, timeoutMs = 50) { name, _, timeout ->
            assertEquals(50, timeout)
            if (name == "stalled") CompletableFuture() else CompletableFuture.completedFuture(20)
        }
        assertEquals(mapOf("stalled" to -1, "queued" to 20), delays)
    }

    @Test fun backgroundSharedEntranceRunsSeriallyWhileAnotherServerCanFinish() {
        val target = ProbeTarget.select(google, 204, null, null)
        val targets = listOf("443", "8443", "other").associateWith { target }
        val servers = mapOf("443" to probeServerKey("POOL.test."), "8443" to probeServerKey("pool.test"),
            "other" to probeServerKey("other.test"))
        val first = CompletableFuture<Int>()
        val calls = mutableListOf<Pair<String, String>>()
        val results = measureDelays(targets, servers, concurrency = 2, background = true) { name, url, timeout ->
            calls.add(name to url)
            when {
                name == "443" && url == google -> {
                    assertEquals(DEFAULT_PROBE_TIMEOUT_MS - DEFAULT_PROBE_BACKUP_DELAY_MS.toInt(), timeout)
                    first
                }
                name == "other" -> {
                    assertEquals(listOf("443" to google, "other" to google), calls)
                    first.complete(-1)
                    CompletableFuture.completedFuture(30)
                }
                else -> CompletableFuture.completedFuture(100)
            }
        }
        assertEquals(listOf("443" to google, "other" to google, "443" to cloudflare, "8443" to google), calls)
        assertEquals(mapOf("443" to 100, "8443" to 100, "other" to 30), results)
        assertEquals(probeServerKey("[2001:db8:0:0::1]"), probeServerKey("2001:db8::1"))
    }
}
