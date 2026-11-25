package app.air.android

import org.json.JSONObject
import java.util.Locale

data class CidrRoute(val address: String, val prefixLength: Int)

data class TunnelRoutePlan(
    val includeIpv4: List<CidrRoute>,
    val includeIpv6: List<CidrRoute>,
    val excludeCidrs: List<String>,
)

data class TunnelSignature(
    val ipv6: Boolean,
    val stack: String,
    val mtu: Int,
    val dnsHijack: Boolean,
    val bypassLan: Boolean,
    val exclusions: List<String>,
)

internal val LOCAL_IPV4_EXCLUDES = listOf("224.0.0.0/4", "255.255.255.255/32", "169.254.0.0/16")
internal val LOCAL_IPV6_EXCLUDES = listOf("fe80::/10", "ff00::/8")
internal val PRIVATE_IPV4_EXCLUDES = listOf("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "169.254.0.0/16")
internal val PRIVATE_IPV6_EXCLUDES = listOf("fc00::/7", "fe80::/10")
// RFC 6052 well-known NAT64 prefix sits outside 2000::/3 and must still be routed when bypassing LAN on API < 33.
internal val LEGACY_GLOBAL_IPV6_INCLUDES = listOf(CidrRoute("2000::", 3), CidrRoute("64:ff9b::", 96))
internal val LEGACY_NON_GLOBAL_IPV4_EXCLUDES = listOf(
    "0.0.0.0/8",
    "10.0.0.0/8",
    "127.0.0.0/8",
    "169.254.0.0/16",
    "172.16.0.0/12",
    "192.168.0.0/16",
    "224.0.0.0/4",
    "240.0.0.0/4",
)

internal fun parseIpv4Range(cidr: String): LongRange {
    val parts = cidr.trim().split('/')
    require(parts.size == 2) { "无效 IPv4 网段: $cidr" }
    val prefix = parts[1].toIntOrNull()?.takeIf { it in 0..32 } ?: error("无效 IPv4 前缀: $cidr")
    val octets = parts[0].split('.')
    require(octets.size == 4) { "无效 IPv4 地址: $cidr" }
    var addr = 0L
    for (piece in octets) {
        val octet = piece.toIntOrNull()?.takeIf { it in 0..255 } ?: error("无效 IPv4 地址: $cidr")
        addr = (addr shl 8) or octet.toLong()
    }
    val mask = if (prefix == 0) 0L else (0xFFFFFFFFL shl (32 - prefix)) and 0xFFFFFFFFL
    val start = addr and mask
    val end = start + (1L shl (32 - prefix)) - 1L
    return start..end
}

internal fun formatIpv4(address: Long): String =
    "${(address ushr 24) and 0xFF}.${(address ushr 16) and 0xFF}.${(address ushr 8) and 0xFF}.${address and 0xFF}"

internal fun computeIpv4IncludeRoutes(excludedCidrs: List<String>): List<CidrRoute> {
    val ranges = excludedCidrs.map(::parseIpv4Range).sortedWith(compareBy<LongRange> { it.first }.thenBy { it.last })
    val merged = mutableListOf<LongRange>()
    for (range in ranges) {
        val last = merged.lastOrNull()
        if (last == null || range.first > last.last + 1L) {
            merged += range
        } else if (range.last > last.last) {
            merged[merged.lastIndex] = last.first..range.last
        }
    }
    val allowed = mutableListOf<LongRange>()
    var cursor = 0L
    for (range in merged) {
        if (cursor < range.first) {
            allowed += cursor..(range.first - 1L)
        }
        cursor = maxOf(cursor, range.last + 1L)
        if (cursor > 0xFFFFFFFFL) break
    }
    if (cursor <= 0xFFFFFFFFL) {
        allowed += cursor..0xFFFFFFFFL
    }
    val routes = mutableListOf<CidrRoute>()
    for (interval in allowed) {
        var start = interval.first
        val end = interval.last
        while (start <= end) {
            var chosenPrefix = 32
            var chosenSize = 1L
            for (prefix in 0..32) {
                val blockSize = 1L shl (32 - prefix)
                if ((start and (blockSize - 1L)) == 0L && start + blockSize - 1L <= end) {
                    chosenPrefix = prefix
                    chosenSize = blockSize
                    break
                }
            }
            routes += CidrRoute(formatIpv4(start), chosenPrefix)
            start += chosenSize
        }
    }
    return routes
}

internal fun buildTunnelRoutePlan(
    sdkInt: Int,
    ipv6: Boolean,
    bypassLan: Boolean,
    customExclusions: List<String>,
): TunnelRoutePlan {
    val rawCustom = customExclusions.map { it.trim() }.filter { it.isNotEmpty() }
    if (sdkInt < 33) {
        require(rawCustom.isEmpty()) { "绕过网段需要 Android 13 或更新版本" }
        val includeIpv4 = if (bypassLan) {
            computeIpv4IncludeRoutes(LEGACY_NON_GLOBAL_IPV4_EXCLUDES)
        } else {
            listOf(CidrRoute("0.0.0.0", 0))
        }
        val includeIpv6 = when {
            !ipv6 -> emptyList()
            bypassLan -> LEGACY_GLOBAL_IPV6_INCLUDES
            else -> listOf(CidrRoute("::", 0))
        }
        return TunnelRoutePlan(includeIpv4, includeIpv6, emptyList())
    }
    val seen = LinkedHashSet<String>()
    val excludeCidrs = mutableListOf<String>()
    fun addExclude(cidr: String) {
        if (seen.add(cidr.lowercase(Locale.ROOT))) {
            excludeCidrs += cidr
        }
    }
    LOCAL_IPV4_EXCLUDES.forEach(::addExclude)
    if (bypassLan) {
        PRIVATE_IPV4_EXCLUDES.forEach(::addExclude)
    }
    if (ipv6) {
        LOCAL_IPV6_EXCLUDES.forEach(::addExclude)
        if (bypassLan) {
            PRIVATE_IPV6_EXCLUDES.forEach(::addExclude)
        }
    }
    rawCustom.filter { ipv6 || !it.contains(':') }.forEach(::addExclude)
    return TunnelRoutePlan(
        includeIpv4 = listOf(CidrRoute("0.0.0.0", 0)),
        includeIpv6 = if (ipv6) listOf(CidrRoute("::", 0)) else emptyList(),
        excludeCidrs = excludeCidrs,
    )
}

internal fun parseTunnelSignature(plan: JSONObject): TunnelSignature {
    val ipv6 = plan.optBoolean("ipv6", false)
    val tune = plan.optJSONObject("tunnel")
    val stack = tune?.optString("stack", "gvisor").orEmpty().ifEmpty { "gvisor" }
    val mtu = tune?.optInt("mtu", 9000) ?: 9000
    val dnsHijack = tune?.optBoolean("dnsHijack", true) ?: true
    val bypassLan = tune?.optBoolean("bypassLan", true) ?: true
    val exclusionsArray = tune?.optJSONArray("exclusions")
    val exclusions = if (exclusionsArray == null) {
        emptyList()
    } else {
        (0 until exclusionsArray.length()).map { exclusionsArray.getString(it) }
    }
    return TunnelSignature(ipv6, stack, mtu, dnsHijack, bypassLan, exclusions)
}
