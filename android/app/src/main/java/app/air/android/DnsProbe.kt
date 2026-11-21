package app.air.android

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.DataOutputStream
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.IDN
import java.net.InetAddress
import java.net.InetSocketAddress
import java.nio.ByteBuffer
import java.security.SecureRandom

internal object DnsProbe {
    private val loopback = InetAddress.getByAddress(byteArrayOf(127, 0, 0, 1))

    fun resolve(context: Context, probe: JSONObject): JSONObject {
        val domain = IDN.toASCII(probe.getString("domain").trim().removeSuffix("."), IDN.USE_STD3_ASCII_RULES)
        require(domain.isNotEmpty() && domain.length <= 253) { "请输入有效的域名" }
        val plan = JSONObject(probe.getJSONObject("plan").toString())
        val config = plan.getJSONObject("config").put("mode", "direct").put("mixed-port", 0).put("allow-lan", false)
        val dns = config.getJSONObject("dns")
        // A diagnostic lookup should display real answers and must not depend on an active VPN.
        dns.put("enhanced-mode", "redir-host").put("respect-rules", false)
        val server = probe.optString("server").trim()
        if (server.isNotEmpty()) {
            dns.put("nameserver", JSONArray().put(server))
            for (key in listOf("nameserver-policy", "fallback", "fallback-filter", "direct-nameserver")) dns.remove(key)
        }
        val port = DatagramSocket(InetSocketAddress(loopback, 0)).use { it.localPort }
        dns.put("listen", "127.0.0.1:$port")
        return Core.withProfile(context, plan) {
            val start = System.nanoTime()
            val addresses = query(domain, port, 1).toMutableSet()
            if (dns.optBoolean("ipv6")) addresses += runCatching { query(domain, port, 28) }.getOrDefault(emptyList())
            check(addresses.isNotEmpty()) { "DNS 未返回 A 或 AAAA 地址" }
            JSONObject().put("addresses", JSONArray(addresses)).put("elapsedMs", (System.nanoTime() - start) / 1_000_000)
        }
    }

    private fun query(domain: String, port: Int, type: Int): List<String> {
        val transaction = SecureRandom().nextInt(65536)
        val payload = ByteArrayOutputStream().also { bytes ->
            DataOutputStream(bytes).use { out ->
                out.writeShort(transaction)
                out.writeShort(0x0100)
                out.writeShort(1)
                repeat(3) { out.writeShort(0) }
                for (label in domain.split('.')) {
                    val encoded = label.toByteArray(Charsets.US_ASCII)
                    require(encoded.size in 1..63) { "域名标签无效" }
                    out.writeByte(encoded.size)
                    out.write(encoded)
                }
                out.writeByte(0)
                out.writeShort(type)
                out.writeShort(1)
            }
        }.toByteArray()
        val received = ByteArray(4096)
        val reply = DatagramPacket(received, received.size)
        DatagramSocket().use { socket ->
            socket.soTimeout = 5_000
            socket.connect(loopback, port)
            socket.send(DatagramPacket(payload, payload.size))
            socket.receive(reply)
        }
        val packet = ByteBuffer.wrap(received, 0, reply.length)
        fun word() = packet.short.toInt() and 0xffff
        fun skipName() {
            while (true) {
                val length = packet.get().toInt() and 0xff
                if (length == 0) return
                if (length and 0xc0 == 0xc0) {
                    packet.get()
                    return
                }
                require(length <= 63) { "DNS 返回格式无效" }
                packet.position(packet.position() + length)
            }
        }
        require(word() == transaction) { "DNS 返回的查询编号不匹配" }
        val flags = word()
        require(flags and 0x8000 != 0) { "DNS 未返回响应" }
        val questions = word()
        val answers = word()
        word()
        word()
        if (flags and 0x000f != 0) return emptyList()
        repeat(questions) { skipName(); word(); word() }
        val results = mutableListOf<String>()
        repeat(answers) {
            skipName()
            val record = word()
            val klass = word()
            packet.int
            val size = word()
            if (klass == 1 && (record == 1 && size == 4 || record == 28 && size == 16)) {
                val address = ByteArray(size).also { packet.get(it) }
                results += InetAddress.getByAddress(address).hostAddress.orEmpty()
            } else {
                packet.position(packet.position() + size)
            }
        }
        return results
    }
}
