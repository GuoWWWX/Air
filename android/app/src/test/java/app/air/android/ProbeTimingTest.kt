package app.air.android

import java.util.concurrent.CompletableFuture
import org.junit.Assert.assertEquals
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
        val results = measureDelays(targets) { alias, url, timeout ->
            if (url == google) {
                assertEquals(8_000, timeout)
                when (alias) {
                    "slow" -> slow
                    "primaryRecovered" -> recovered
                    else -> CompletableFuture.completedFuture(if (alias == "fast") 106 else -1)
                }
            } else {
                alternates.add(alias)
                assertTrue(timeout in 1..6_000)
                if (alias == "primaryRecovered") recovered.complete(150)
                CompletableFuture.completedFuture(if (alias == "slow") 127 else -1)
            }
        }
        assertEquals(setOf("slow", "bothFailed", "primaryRecovered"), alternates)
        assertEquals(mapOf("fast" to 106, "slow" to 127, "bothFailed" to -1, "primaryRecovered" to 150), results)
        slow.complete(480)
        assertEquals(127, results["slow"])
    }
}
