package app.air.android

import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.net.InetSocketAddress
import java.net.Proxy
import java.net.URL
import javax.net.ssl.HttpsURLConnection

internal fun exitCountryCode(value: String?): String? {
    val trimmed = value?.trim() ?: return null
    return trimmed.takeIf { it.length == 2 && it.all { ch -> ch in 'A'..'Z' } }
}

internal fun exitKind(usageType: String?): String? = when (usageType?.trim()) {
    "IDC" -> "datacenter"
    "DYN" -> "residential"
    "MOB" -> "mobile"
    "GTW" -> "gateway"
    else -> null
}

internal fun exitQuality(riskLevel: String?): String? = when (riskLevel?.trim()) {
    "none" -> "noEvidence"
    "low" -> "lowRisk"
    "medium" -> "mediumRisk"
    "high" -> "highRisk"
    else -> null
}

internal fun mergeExitMetadata(base: JSONObject, metadata: JSONObject): JSONObject {
    val expectedIp = base.optString("ip").trim()
    if (expectedIp.isEmpty() || metadata.optString("ip").trim() != expectedIp) return base
    val geo = metadata.optJSONObject("geo")
    exitCountryCode(geo?.optString("country"))?.let { base.put("country", it) }
    geo?.optString("region")?.trim()?.takeIf { it.isNotEmpty() }?.let { base.put("region", it) }
    geo?.optString("city")?.trim()?.takeIf { it.isNotEmpty() }?.let { base.put("city", it) }
    exitKind(metadata.optJSONObject("network")?.optString("usage_type"))?.let { base.put("kind", it) }
    exitQuality(metadata.optJSONObject("risk")?.optString("level"))?.let { base.put("quality", it) }
    return base
}

internal fun fetchExitMetadata(ip: String, proxyPort: Int): JSONObject? {
    val target = ip.trim()
    if (target.isEmpty() || target.contains('/') || target.contains('?') || target.contains('#')) return null
    val url = URL("https://ip99.com/v1/ip/$target")
    val candidates = if (proxyPort > 0) {
        listOf(Proxy(Proxy.Type.HTTP, InetSocketAddress("127.0.0.1", proxyPort)), null)
    } else {
        listOf(null)
    }
    for (proxy in candidates) {
        val parsed = runCatching {
            val connection = (if (proxy != null) url.openConnection(proxy) else url.openConnection()) as HttpsURLConnection
            try {
                connection.connectTimeout = 5_000
                connection.readTimeout = 5_000
                connection.instanceFollowRedirects = false
                connection.requestMethod = "GET"
                if (connection.responseCode !in 200..299) return@runCatching null
                val buffer = ByteArray(4096)
                val out = ByteArrayOutputStream()
                var total = 0
                connection.inputStream.use { stream ->
                    while (total < 64 * 1024) {
                        val read = stream.read(buffer, 0, minOf(buffer.size, 64 * 1024 - total))
                        if (read <= 0) break
                        out.write(buffer, 0, read)
                        total += read
                    }
                }
                JSONObject(out.toString(Charsets.UTF_8.name()))
            } finally {
                connection.disconnect()
            }
        }.getOrNull()
        if (parsed != null) return parsed
    }
    return null
}
