package app.air.android

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.ConnectivityManager
import android.net.InetAddresses
import android.net.IpPrefix
import android.net.VpnService
import android.os.Build
import io.github.oviron.libmihomo.Clash
import io.github.oviron.libmihomo.InvokeInterface
import org.json.JSONObject
import java.net.InetSocketAddress
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

class AirVpnService : VpnService() {
    private var ownsTunnel = false

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            STOP -> {
                state = State("stopping")
                Core.worker.execute {
                    closeTunnel()
                    state = State("idle")
                    stopSelfResult(startId)
                }
            }
            CONNECT -> {
                val plan = pending.getAndSet(null)
                if (plan == null) {
                    if (!ownsTunnel) stopSelfResult(startId)
                    return START_NOT_STICKY
                }
                try {
                    val note = notification()
                    if (Build.VERSION.SDK_INT >= 34) {
                        startForeground(NOTIFICATION, note, ServiceInfo.FOREGROUND_SERVICE_TYPE_SYSTEM_EXEMPTED)
                    } else {
                        startForeground(NOTIFICATION, note)
                    }
                } catch (error: Exception) {
                    state = State("error", error.message ?: "无法启动 VPN 前台服务")
                    stopSelfResult(startId)
                    return START_NOT_STICKY
                }
                Core.worker.execute {
                    try {
                        Core.apply(this, plan)
                        establishTunnel(plan)
                        Core.action("resetTraffic")
                        val port = plan.getJSONObject("config").optInt("mixed-port", 0).takeIf { it > 0 }
                        state = State("running", startedAt = System.currentTimeMillis(), port = port)
                    } catch (error: Exception) {
                        closeTunnel()
                        state = State("error", error.message ?: "无法启动虚拟网卡")
                        stopSelfResult(startId)
                    }
                }
            }
            else -> stopSelfResult(startId)
        }
        return START_NOT_STICKY
    }

    private fun establishTunnel(plan: JSONObject) {
        val ipv6 = plan.optBoolean("ipv6", true)
        val tune = plan.optJSONObject("tunnel") ?: JSONObject()
        val mtu = tune.optInt("mtu", 1400)
        val stack = tune.optString("stack", "gvisor")
        val dnsHijack = tune.optBoolean("dnsHijack", true)
        require(mtu in 1280..9000 && stack in setOf("gvisor", "system", "mixed")) { "虚拟网卡配置无效" }
        val builder = Builder().setSession("Air")
            .setMtu(mtu)
            .addAddress(ADDRESS, 30)
            .addRoute("0.0.0.0", 0)
            .addDisallowedApplication(packageName)
        if (dnsHijack) builder.addDnsServer(DNS).addRoute(DNS, 32)
        if (Build.VERSION.SDK_INT >= 29) builder.setMetered(false)
        if (ipv6) builder.addAddress(IPV6, 126).addRoute("::", 0)
        val exclusions = tune.optJSONArray("exclusions")
        if (Build.VERSION.SDK_INT >= 33 && exclusions != null) {
            for (index in 0 until exclusions.length()) {
                val cidr = exclusions.getString(index)
                val address = InetAddresses.parseNumericAddress(cidr.substringBeforeLast('/'))
                if (ipv6 || address.address.size == 4) {
                    builder.excludeRoute(IpPrefix(address, cidr.substringAfterLast('/').toInt()))
                }
            }
            if (dnsHijack) builder.addRoute(DNS, 32)
        } else if (exclusions != null && exclusions.length() > 0) {
            error("绕过网段需要 Android 13 或更新版本")
        }
        val ready = CompletableFuture<String?>()
        Clash.setEventListener { raw ->
            val payload = runCatching {
                JSONObject(raw ?: "").optJSONObject("data")?.optJSONObject("data")?.optString("Payload").orEmpty()
            }.getOrDefault("")
            when {
                payload.contains("TUN started: device=Air-TUN") -> ready.complete(null)
                payload.contains("TUN start failed:") -> ready.complete("Mihomo 无法启动虚拟网卡")
            }
        }
        try {
            Core.action("startLog")
            val descriptor = builder.establish() ?: error("Android 未授权建立 VPN")
            val addresses = if (ipv6) "$ADDRESS/30,$IPV6/126" else "$ADDRESS/30"
            ownsTunnel = true
            Clash.startTUN(descriptor.detachFd(), { fd -> protect(fd) }, ::processName,
                "Air-TUN", stack, addresses, if (dnsHijack) DNS else "", mtu)
            val error = try {
                ready.get(5, TimeUnit.SECONDS)
            } catch (_: java.util.concurrent.TimeoutException) {
                "等待 Mihomo 确认虚拟网卡超时"
            }
            check(error == null) { error ?: "" }
        } finally {
            runCatching { Core.action("stopLog") }
            Clash.setEventListener(null as InvokeInterface?)
        }
    }

    private fun processName(protocol: Int, from: String, to: String, uid: Int): String {
        fun ownerName(owner: Int) = if (owner >= 0) "$owner\n" + packageManager.getNameForUid(owner).orEmpty() else ""
        if (uid >= 0) return ownerName(uid)
        if (Build.VERSION.SDK_INT < 29) return ""
        fun address(value: String): InetSocketAddress {
            val host = value.substringBeforeLast(':').removeSurrounding("[", "]")
            return InetSocketAddress(host, value.substringAfterLast(':').toInt())
        }
        return runCatching {
            val owner = getSystemService(ConnectivityManager::class.java)
                .getConnectionOwnerUid(protocol, address(from), address(to))
            ownerName(owner)
        }.getOrDefault("")
    }

    private fun closeTunnel() {
        if (ownsTunnel) {
            runCatching { Clash.stopTun() }
            ownsTunnel = false
        }
        Core.stopListening()
    }

    override fun onRevoke() {
        Core.worker.execute {
            closeTunnel()
            state = State("idle")
            stopSelf()
        }
    }

    override fun onDestroy() {
        Core.worker.execute {
            if (ownsTunnel) {
                closeTunnel()
                state = State("idle")
            }
        }
        super.onDestroy()
    }

    private fun notification(): Notification {
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(NotificationChannel(CHANNEL, "Air VPN", NotificationManager.IMPORTANCE_LOW))
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
        val stop = PendingIntent.getService(this, 1, Intent(this, AirVpnService::class.java).setAction(STOP), PendingIntent.FLAG_IMMUTABLE)
        return Notification.Builder(this, CHANNEL)
            .setSmallIcon(R.mipmap.ic_air)
            .setContentTitle("Air VPN")
            .setContentText("正在接管此设备的网络")
            .setContentIntent(open)
            .setOngoing(true)
            .addAction(Notification.Action.Builder(null, "停止代理", stop).build())
            .build()
    }

    private data class State(val phase: String, val error: String? = null, val startedAt: Long = 0, val port: Int? = null)

    companion object {
        private const val CONNECT = "app.air.android.CONNECT"
        private const val STOP = "app.air.android.STOP"
        private const val CHANNEL = "air-vpn"
        private const val NOTIFICATION = 7
        private const val ADDRESS = "198.19.64.1"
        private const val DNS = "198.19.64.2"
        private const val IPV6 = "fdfe:dcba:9876::1"
        private val pending = AtomicReference<JSONObject?>()
        @Volatile private var state = State("idle")

        internal fun connect(context: Context, plan: JSONObject) {
            require(state.phase in setOf("idle", "error")) { "VPN 正在切换，请稍后重试" }
            state = State("starting")
            pending.set(plan)
            try {
                context.startForegroundService(Intent(context, AirVpnService::class.java).setAction(CONNECT))
            } catch (error: Exception) {
                pending.set(null)
                state = State("error", error.message)
                throw error
            }
        }

        internal fun disconnect(context: Context) {
            if (state.phase in setOf("running", "starting")) {
                context.startService(Intent(context, AirVpnService::class.java).setAction(STOP))
            }
        }

        internal fun running() = state.phase == "running"

        internal fun snapshot(): JSONObject {
            val now = state
            return JSONObject().put("phase", now.phase).put("error", now.error).put("port", now.port)
                .put("startedAt", now.startedAt).put("traffic", if (now.phase == "running") Core.traffic() else JSONObject())
                .put("totals", if (now.phase == "running") Core.totals() else JSONObject.NULL)
        }
    }
}
