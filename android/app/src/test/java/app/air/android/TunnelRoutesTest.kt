package app.air.android

import java.net.InetAddress
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class TunnelRoutesTest {
    private fun ipv4(value: String): Long {
        val parts = value.split('.')
        assertEquals(4, parts.size)
        return parts.fold(0L) { acc, piece -> (acc shl 8) or piece.toLong() }
    }

    private fun routeRange(route: CidrRoute): LongRange {
        val size = 1L shl (32 - route.prefixLength)
        val start = ipv4(route.address)
        assertEquals("Route $route must be CIDR-aligned", 0L, start and (size - 1L))
        return start..(start + size - 1L)
    }

    private fun containsIp(routes: List<CidrRoute>, address: String): Boolean {
        val ip = ipv4(address)
        return routes.any { ip in routeRange(it) }
    }

    private fun containsIpv6(routes: List<CidrRoute>, address: String): Boolean {
        val target = InetAddress.getByName(address).address
        return routes.any { route ->
            val network = InetAddress.getByName(route.address).address
            val fullBytes = route.prefixLength / 8
            val remBits = route.prefixLength % 8
            val fullMatch = (0 until fullBytes).all { network[it] == target[it] }
            if (!fullMatch) return@any false
            if (remBits == 0) return@any true
            val mask = (0xff shl (8 - remBits)) and 0xff
            (network[fullBytes].toInt() and mask) == (target[fullBytes].toInt() and mask)
        }
    }

    @Test
    fun legacyIpv4IncludeRoutesPartitionAll32BitAddressesWithPrivateRangesExcluded() {
        val routes = computeIpv4IncludeRoutes(LEGACY_NON_GLOBAL_IPV4_EXCLUDES)
        val excluded = LEGACY_NON_GLOBAL_IPV4_EXCLUDES.map(::parseIpv4Range)
        val includeRanges = routes.map(::routeRange)
        val combined = (excluded + includeRanges).sortedBy { it.first }

        assertEquals(0L, combined.first().first)
        assertEquals(0xFFFFFFFFL, combined.last().last)
        var totalAddresses = 0L
        var expectedNext = 0L
        for (range in combined) {
            assertEquals("Gap or overlap before $range", expectedNext, range.first)
            totalAddresses += range.last - range.first + 1L
            expectedNext = range.last + 1L
        }
        assertEquals(1L shl 32, totalAddresses)

        for (privateOrLocal in listOf(
            "0.0.0.1",
            "10.0.0.1",
            "10.255.255.254",
            "127.0.0.1",
            "169.254.1.1",
            "172.16.0.1",
            "172.31.255.254",
            "192.168.101.11",
            "192.168.200.1",
            "224.0.0.251",
            "255.255.255.255",
        )) {
            assertFalse("$privateOrLocal should bypass TUN", containsIp(routes, privateOrLocal))
        }

        for (publicOrTunnel in listOf(
            "1.1.1.1",
            "8.8.8.8",
            "100.64.0.1",
            "172.15.255.255",
            "172.32.0.1",
            "192.167.255.255",
            "192.169.0.1",
            "198.18.0.1",
            "198.19.64.1",
            "198.19.64.2",
        )) {
            assertTrue("$publicOrTunnel should route through TUN", containsIp(routes, publicOrTunnel))
        }
    }

    @Test
    fun buildTunnelRoutePlanHandlesSdk33AndLegacyModes() {
        val sdk33Default = buildTunnelRoutePlan(
            sdkInt = 34,
            ipv6 = true,
            bypassLan = true,
            customExclusions = listOf("203.0.113.0/24", "192.168.0.0/16", "2001:db8::/32"),
        )
        assertEquals(listOf(CidrRoute("0.0.0.0", 0)), sdk33Default.includeIpv4)
        assertEquals(listOf(CidrRoute("::", 0)), sdk33Default.includeIpv6)
        assertEquals(
            listOf(
                "224.0.0.0/4",
                "255.255.255.255/32",
                "169.254.0.0/16",
                "10.0.0.0/8",
                "172.16.0.0/12",
                "192.168.0.0/16",
                "fe80::/10",
                "ff00::/8",
                "fc00::/7",
                "203.0.113.0/24",
                "2001:db8::/32",
            ),
            sdk33Default.excludeCidrs,
        )

        val sdk33NoBypass = buildTunnelRoutePlan(
            sdkInt = 33,
            ipv6 = false,
            bypassLan = false,
            customExclusions = listOf("203.0.113.0/24", "2001:db8::/32"),
        )
        assertEquals(emptyList<CidrRoute>(), sdk33NoBypass.includeIpv6)
        assertEquals(
            listOf("224.0.0.0/4", "255.255.255.255/32", "169.254.0.0/16", "203.0.113.0/24"),
            sdk33NoBypass.excludeCidrs,
        )

        val sdk32Bypass = buildTunnelRoutePlan(
            sdkInt = 32,
            ipv6 = true,
            bypassLan = true,
            customExclusions = emptyList(),
        )
        assertFalse(sdk32Bypass.includeIpv4.contains(CidrRoute("0.0.0.0", 0)))
        assertEquals(listOf(CidrRoute("2000::", 3), CidrRoute("64:ff9b::", 96)), sdk32Bypass.includeIpv6)
        assertTrue(sdk32Bypass.excludeCidrs.isEmpty())

        val sdk32Full = buildTunnelRoutePlan(
            sdkInt = 31,
            ipv6 = true,
            bypassLan = false,
            customExclusions = emptyList(),
        )
        assertEquals(listOf(CidrRoute("0.0.0.0", 0)), sdk32Full.includeIpv4)
        assertEquals(listOf(CidrRoute("::", 0)), sdk32Full.includeIpv6)
    }

    @Test(expected = IllegalArgumentException::class)
    fun sdk32RejectsCustomExclusions() {
        buildTunnelRoutePlan(
            sdkInt = 32,
            ipv6 = false,
            bypassLan = true,
            customExclusions = listOf("203.0.113.0/24"),
        )
    }

    @Test
    fun tunnelSignatureDetectsChangesInBypassOrExclusions() {
        val base = TunnelSignature(
            ipv6 = false,
            stack = "gvisor",
            mtu = 9000,
            dnsHijack = true,
            bypassLan = true,
            exclusions = emptyList(),
        )
        assertNotEquals(base, base.copy(bypassLan = false))
        assertNotEquals(base, base.copy(exclusions = listOf("203.0.113.0/24")))
    }

    @Test
    fun legacyIpv6IncludeRoutesCoverGlobalAndNat64WhileBypassingLocalRanges() {
        val plan = buildTunnelRoutePlan(
            sdkInt = 26,
            ipv6 = true,
            bypassLan = true,
            customExclusions = emptyList(),
        )
        assertEquals(LEGACY_GLOBAL_IPV6_INCLUDES, plan.includeIpv6)
        assertTrue(containsIpv6(plan.includeIpv6, "2606:4700:4700::1111"))
        assertTrue(containsIpv6(plan.includeIpv6, "64:ff9b::198.51.100.1"))
        assertFalse(containsIpv6(plan.includeIpv6, "::1"))
        assertFalse(containsIpv6(plan.includeIpv6, "fc00::1"))
        assertFalse(containsIpv6(plan.includeIpv6, "fd12:3456::1"))
        assertFalse(containsIpv6(plan.includeIpv6, "fe80::1"))
        assertFalse(containsIpv6(plan.includeIpv6, "ff02::1"))
        assertFalse(containsIpv6(plan.includeIpv6, "64:ff9b:1::1"))
    }
}
