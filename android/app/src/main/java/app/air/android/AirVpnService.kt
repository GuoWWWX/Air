package app.air.android

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.SharedPreferences
import android.content.pm.ServiceInfo
import android.net.ConnectivityManager
import android.net.InetAddresses
import android.net.IpPrefix
import android.net.LinkProperties
import android.net.Network
import android.net.NetworkCapabilities
import android.net.VpnService
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.os.SystemClock
import androidx.core.content.ContextCompat
import io.github.oviron.libmihomo.Clash
import io.github.oviron.libmihomo.InvokeInterface
import org.json.JSONObject
import java.net.Inet6Address
import java.net.InetAddress
import java.net.InetSocketAddress
import java.util.Locale
import java.util.concurrent.CompletableFuture
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

class AirVpnService : VpnService() {
    @Volatile private var ownsTunnel = false

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            STOP -> {
                state = State("stopping")
                foregroundNotification = false
                stopTrafficTicker()
                Core.worker.execute {
                    closeTunnel()
                    state = State("idle")
                    stopSelfResult(startId)
                }
            }
            CONNECT -> {
                val request = pending.getAndSet(null)
                if (request == null) {
                    if (!ownsTunnel) stopSelfResult(startId)
                    return START_NOT_STICKY
                }
                val plan = request.plan
                stopTrafficTicker()
                activeOutbound = outboundSummary(plan)
                lastSignature = null
                try {
                    val (note, signature) = buildNotification(showSpeed = false)
                    lastSignature = signature
                    if (Build.VERSION.SDK_INT >= 34) {
                        startForeground(NOTIFICATION, note, ServiceInfo.FOREGROUND_SERVICE_TYPE_SYSTEM_EXEMPTED)
                    } else {
                        startForeground(NOTIFICATION, note)
                    }
                    foregroundNotification = true
                } catch (error: Exception) {
                    state = State("error", error.message ?: "无法启动 VPN 前台服务")
                    request.complete(snapshot())
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
                        mainHandler.post {
                            if (foregroundNotification && ownsTunnel && state.phase == "running") {
                                postNotification(force = true)
                                startTrafficTicker()
                            }
                        }
                    } catch (error: Exception) {
                        closeTunnel()
                        state = State("error", error.message ?: "无法启动虚拟网卡")
                        stopSelfResult(startId)
                    } finally {
                        request.complete(snapshot())
                    }
                }
            }
            else -> stopSelfResult(startId)
        }
        return START_NOT_STICKY
    }

    @Volatile private var foregroundNotification = false
    @Volatile private var activeUnderlyingNetwork: Network? = null
    @Volatile private var lastSystemDns: String? = null
    private val networkLock = Any()
    private val availableNetworks = LinkedHashMap<Network, LinkProperties?>()
    private val networkCallback = AtomicReference<ConnectivityManager.NetworkCallback?>(null)
    private val connectionSamplePending = AtomicBoolean()
    private val connectionSamples = ConnectionSamples()
    private val connectionReader = Executors.newSingleThreadExecutor()
    private var tickerActive = false
    private var screenInteractive = true
    private var screenReceiverRegistered = false
    private var lastSignature: String? = null
    private lateinit var cachedStrings: NotificationStrings
    private val mainHandler = Handler(Looper.getMainLooper())

    private val trafficTick = object : Runnable {
        override fun run() {
            if (!tickerActive || !foregroundNotification || !ownsTunnel || state.phase != "running" || !screenInteractive) {
                tickerActive = false
                return
            }
            sampleConnections()
            postNotification(force = false)
            if (tickerActive) {
                mainHandler.postDelayed(this, TRAFFIC_INTERVAL_MS)
            }
        }
    }

    private val screenReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            when (intent?.action) {
                Intent.ACTION_SCREEN_OFF -> {
                    screenInteractive = false
                    stopTrafficTicker()
                }
                Intent.ACTION_SCREEN_ON, Intent.ACTION_USER_PRESENT -> {
                    screenInteractive = true
                    if (foregroundNotification && ownsTunnel && state.phase == "running") {
                        postNotification(force = true)
                        startTrafficTicker()
                    }
                }
            }
        }
    }

    private val onLanguageChanged = SharedPreferences.OnSharedPreferenceChangeListener { _, key ->
        if (key == "selected") {
            mainHandler.post {
                cachedStrings = loadNotificationStrings()
                ensureNotificationChannel()
                if (foregroundNotification) {
                    postNotification(force = true)
                }
            }
        }
    }

    override fun onCreate() {
        super.onCreate()
        activeService = this
        ensureNotificationChannel()
        cachedStrings = loadNotificationStrings()
        screenInteractive = getSystemService(PowerManager::class.java)?.isInteractive != false
        val filter = IntentFilter().apply {
            addAction(Intent.ACTION_SCREEN_ON)
            addAction(Intent.ACTION_SCREEN_OFF)
            addAction(Intent.ACTION_USER_PRESENT)
        }
        ContextCompat.registerReceiver(this, screenReceiver, filter, ContextCompat.RECEIVER_NOT_EXPORTED)
        screenReceiverRegistered = true
        Languages.preferences(this).registerOnSharedPreferenceChangeListener(onLanguageChanged)
    }

    private fun establishTunnel(plan: JSONObject) {
        val sig = parseTunnelSignature(plan)
        require(sig.mtu in 1280..9000 && sig.stack in setOf("gvisor", "system", "mixed")) { "虚拟网卡配置无效" }
        val routes = buildTunnelRoutePlan(Build.VERSION.SDK_INT, sig.ipv6, sig.bypassLan, sig.exclusions)
        val connectivity = getSystemService(ConnectivityManager::class.java)
        seedAvailableNetworks(connectivity)
        refreshUnderlyingNetwork(connectivity, resetOnSwitch = false)
        val builder = Builder().setSession(getString(R.string.app_name))
            .setMtu(sig.mtu)
            .addAddress(ADDRESS, 30)
            .addDisallowedApplication(packageName)
        if (Build.VERSION.SDK_INT >= 29) {
            builder.setMetered(false)
        }
        if (sig.ipv6) {
            builder.addAddress(IPV6, 126)
        }
        for (route in routes.includeIpv4) {
            builder.addRoute(route.address, route.prefixLength)
        }
        for (route in routes.includeIpv6) {
            builder.addRoute(route.address, route.prefixLength)
        }
        if (Build.VERSION.SDK_INT >= 33) {
            for (cidr in routes.excludeCidrs) {
                val address = InetAddresses.parseNumericAddress(cidr.substringBeforeLast('/'))
                builder.excludeRoute(IpPrefix(address, cidr.substringAfterLast('/').toInt()))
            }
        }
        if (sig.dnsHijack) {
            builder.addDnsServer(DNS).addRoute(DNS, 32)
            if (sig.ipv6) {
                builder.addDnsServer(DNS_IPV6).addRoute(DNS_IPV6, 128)
            }
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
            val addresses = if (sig.ipv6) "$ADDRESS/30,$IPV6/126" else "$ADDRESS/30"
            ownsTunnel = true
            Clash.startTUN(descriptor.detachFd(), { fd -> protect(fd) }, ::processName,
                "Air-TUN", sig.stack, addresses, if (sig.dnsHijack) DNS_HIJACK_ANY else "", sig.mtu)
            val error = try {
                ready.get(5, TimeUnit.SECONDS)
            } catch (_: java.util.concurrent.TimeoutException) {
                "等待 Mihomo 确认虚拟网卡超时"
            }
            check(error == null) { error ?: "" }
            registerNetworkCallback()
        } finally {
            runCatching { Core.action("stopLog") }
            Clash.setEventListener(null as InvokeInterface?)
        }
    }

    private fun isPhysicalInternetNetwork(connectivity: ConnectivityManager, network: Network): Boolean {
        val caps = connectivity.getNetworkCapabilities(network) ?: return false
        return caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) &&
            caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_RESTRICTED) &&
            !caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN)
    }

    @Suppress("DEPRECATION")
    private fun seedAvailableNetworks(connectivity: ConnectivityManager?) {
        if (connectivity == null) return
        val candidates = LinkedHashMap<Network, LinkProperties?>()
        for (net in connectivity.allNetworks) {
            if (isPhysicalInternetNetwork(connectivity, net)) {
                candidates[net] = connectivity.getLinkProperties(net)
            }
        }
        connectivity.activeNetwork?.takeIf { isPhysicalInternetNetwork(connectivity, it) }?.let { active ->
            candidates.putIfAbsent(active, connectivity.getLinkProperties(active))
        }
        synchronized(networkLock) {
            availableNetworks.clear()
            availableNetworks.putAll(candidates)
        }
    }

    private fun selectBestPhysicalNetworkLocked(connectivity: ConnectivityManager): Pair<Network, LinkProperties?>? {
        // Core sockets use Android's default network. Use the same link for system DNS.
        connectivity.activeNetwork?.takeIf { isPhysicalInternetNetwork(connectivity, it) }?.let { active ->
            return active to (availableNetworks[active] ?: connectivity.getLinkProperties(active))
        }
        var bestEntry: Pair<Network, LinkProperties?>? = null
        var bestScore = Int.MIN_VALUE
        val iterator = availableNetworks.entries.iterator()
        while (iterator.hasNext()) {
            val (net, props) = iterator.next()
            val caps = connectivity.getNetworkCapabilities(net)
            if (caps == null || !caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) ||
                !caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_RESTRICTED) ||
                caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN)) {
                iterator.remove()
                continue
            }
            var score = 0
            if (caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)) score += 100
            score += when {
                caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> 40
                caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> 30
                caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> 20
                else -> 10
            }
            if (caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED)) score += 5
            if (score > bestScore) {
                bestScore = score
                bestEntry = net to props
            }
        }
        return bestEntry
    }

    private fun refreshUnderlyingNetwork(connectivity: ConnectivityManager?, resetOnSwitch: Boolean = true) {
        if (connectivity == null || (resetOnSwitch && !ownsTunnel)) return
        val previous: Network?
        val best: Pair<Network, LinkProperties?>?
        synchronized(networkLock) {
            previous = activeUnderlyingNetwork
            best = selectBestPhysicalNetworkLocked(connectivity)
            activeUnderlyingNetwork = best?.first
        }
        val selected = best?.first
        // Leave the VPN's underlying-network declaration at Android's default. The core
        // protects its sockets from the VPN but does not bind them to a particular Network.
        val props = best?.second ?: selected?.let { connectivity.getLinkProperties(it) }
        val dnsList = props?.dnsServers
            ?.filterNot { it.isLoopbackAddress || it.isAnyLocalAddress || it in tunnelDnsAddresses }
            ?.mapNotNull { address ->
                address.hostAddress?.let { host -> if (address is Inet6Address) "[$host]:53" else "$host:53" }
            }
            ?.distinct()
            .orEmpty()
        if (dnsList.isNotEmpty() && Clash.isLoaded()) {
            val dnsCsv = dnsList.joinToString(",")
            if (dnsCsv != lastSystemDns) {
                runCatching { Clash.updateDNS(dnsCsv) }.onSuccess { lastSystemDns = dnsCsv }
            }
        }
        if (resetOnSwitch && previous != null && selected != null && previous != selected) {
            Core.worker.execute {
                if (ownsTunnel && Clash.isLoaded()) {
                    runCatching { Core.action("closeAllConnections") }
                }
            }
        }
    }

    private fun registerNetworkCallback() {
        unregisterNetworkCallback(clearTracked = false)
        val connectivity = getSystemService(ConnectivityManager::class.java) ?: return
        val callback = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                if (!ownsTunnel || !isPhysicalInternetNetwork(connectivity, network)) return
                val props = connectivity.getLinkProperties(network)
                synchronized(networkLock) { availableNetworks[network] = props }
                refreshUnderlyingNetwork(connectivity)
            }

            override fun onCapabilitiesChanged(network: Network, networkCapabilities: NetworkCapabilities) {
                if (!ownsTunnel) return
                val valid = networkCapabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) &&
                    networkCapabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_RESTRICTED) &&
                    !networkCapabilities.hasTransport(NetworkCapabilities.TRANSPORT_VPN)
                synchronized(networkLock) {
                    if (valid) {
                        availableNetworks.putIfAbsent(network, connectivity.getLinkProperties(network))
                    } else {
                        availableNetworks.remove(network)
                    }
                }
                refreshUnderlyingNetwork(connectivity)
            }

            override fun onLinkPropertiesChanged(network: Network, linkProperties: LinkProperties) {
                if (!ownsTunnel || !isPhysicalInternetNetwork(connectivity, network)) return
                synchronized(networkLock) { availableNetworks[network] = linkProperties }
                refreshUnderlyingNetwork(connectivity)
            }

            override fun onLost(network: Network) {
                if (!ownsTunnel) return
                synchronized(networkLock) { availableNetworks.remove(network) }
                refreshUnderlyingNetwork(connectivity)
            }
        }
        runCatching {
            connectivity.registerDefaultNetworkCallback(callback)
            if (!networkCallback.compareAndSet(null, callback)) {
                connectivity.unregisterNetworkCallback(callback)
            }
        }
    }

    private fun unregisterNetworkCallback(clearTracked: Boolean = true) {
        val callback = networkCallback.getAndSet(null)
        if (clearTracked) {
            synchronized(networkLock) {
                availableNetworks.clear()
                activeUnderlyingNetwork = null
            }
            lastSystemDns = null
        }
        if (callback != null) {
            runCatching {
                getSystemService(ConnectivityManager::class.java)?.unregisterNetworkCallback(callback)
            }
        }
    }

    private fun processName(protocol: Int, from: String, to: String, uid: Int): String {
        fun ownerName(owner: Int) = if (owner >= 0) {
            "$owner\n" + (packageManager.getPackagesForUid(owner)?.firstOrNull()
                ?: packageManager.getNameForUid(owner).orEmpty())
        } else ""
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
        mainHandler.post { stopTrafficTicker() }
        unregisterNetworkCallback()
        // The native stop closes its TUN and disables listener updates.
        Core.closeMixedListener()
        if (ownsTunnel) {
            runCatching { Clash.stopTun() }
            ownsTunnel = false
        }
        connectionSamples.clear()
        Core.stopListening()
    }

    override fun onRevoke() {
        foregroundNotification = false
        stopTrafficTicker()
        Core.worker.execute {
            closeTunnel()
            state = State("idle")
            stopSelf()
        }
    }

    override fun onDestroy() {
        foregroundNotification = false
        stopTrafficTicker()
        connectionReader.shutdownNow()
        unregisterNetworkCallback()
        mainHandler.removeCallbacksAndMessages(null)
        if (activeService === this) activeService = null
        if (screenReceiverRegistered) {
            runCatching { unregisterReceiver(screenReceiver) }
            screenReceiverRegistered = false
        }
        Languages.preferences(this).unregisterOnSharedPreferenceChangeListener(onLanguageChanged)
        Core.worker.execute {
            if (ownsTunnel) {
                closeTunnel()
                state = State("idle")
            }
        }
        super.onDestroy()
    }

    private fun ensureNotificationChannel() {
        val manager = getSystemService(NotificationManager::class.java) ?: return
        val channel = NotificationChannel(CHANNEL, getString(R.string.app_name), NotificationManager.IMPORTANCE_LOW).apply {
            setShowBadge(false)
        }
        manager.createNotificationChannel(channel)
    }

    private fun loadNotificationStrings(): NotificationStrings {
        val messages = Languages.read(this).optJSONObject("messages")
        return NotificationStrings(
            rule = messages?.optString("规则", "规则").orEmpty().ifEmpty { "规则" },
            global = messages?.optString("全局", "全局").orEmpty().ifEmpty { "全局" },
            direct = messages?.optString("直连", "直连").orEmpty().ifEmpty { "直连" },
            directMode = messages?.optString("直连模式", "直连模式").orEmpty().ifEmpty { "直连模式" },
            starting = messages?.optString("正在启动", "正在启动").orEmpty().ifEmpty { "正在启动" },
            stop = messages?.optString("停止代理", "停止代理").orEmpty().ifEmpty { "停止代理" },
        )
    }

    private fun startTrafficTicker() {
        if (!foregroundNotification || !ownsTunnel || state.phase != "running") return
        screenInteractive = getSystemService(PowerManager::class.java)?.isInteractive != false
        if (!screenInteractive) return
        mainHandler.removeCallbacks(trafficTick)
        tickerActive = true
        mainHandler.postDelayed(trafficTick, TRAFFIC_INTERVAL_MS)
    }

    private fun stopTrafficTicker() {
        tickerActive = false
        mainHandler.removeCallbacks(trafficTick)
    }

    private fun postNotification(force: Boolean) {
        if (!foregroundNotification) return
        val running = state.phase == "running" && ownsTunnel
        val traffic = if (running) runCatching { Core.traffic() }.getOrNull() else null
        val up = traffic?.optLong("up", 0L) ?: 0L
        val down = traffic?.optLong("down", 0L) ?: 0L
        val (note, signature) = buildNotification(upBytes = up, downBytes = down, showSpeed = running)
        if (!force && signature == lastSignature) return
        lastSignature = signature
        getSystemService(NotificationManager::class.java)?.notify(NOTIFICATION, note)
    }

    private fun sampleConnections() {
        if (!connectionSamplePending.compareAndSet(false, true)) return
        val startedAt = state.startedAt
        connectionReader.execute {
            try {
                val rows = runCatching { Core.connectionRows() }.getOrNull() ?: return@execute
                if (activeService === this && ownsTunnel && state.phase == "running" && state.startedAt == startedAt) {
                    connectionSamples.record(rows, SystemClock.elapsedRealtime())
                }
            } finally {
                connectionSamplePending.set(false)
            }
        }
    }

    private fun buildNotification(upBytes: Long = 0L, downBytes: Long = 0L, showSpeed: Boolean = false): Pair<Notification, String> {
        val strings = if (::cachedStrings.isInitialized) cachedStrings else loadNotificationStrings().also { cachedStrings = it }
        val appName = getString(R.string.app_name)
        val outbound = activeOutbound
        val modeLabel = when (outbound.mode) {
            "global" -> strings.global
            "direct" -> strings.direct
            else -> strings.rule
        }
        val title = when {
            outbound.mode == "direct" -> strings.directMode
            outbound.label.isNotEmpty() -> outbound.label
            else -> appName
        }
        val body = if (showSpeed) {
            "↑ ${formatSpeed(upBytes)} · ↓ ${formatSpeed(downBytes)}"
        } else {
            strings.starting
        }
        val signature = "$title|$modeLabel|$body|${strings.stop}"
        val openIntent = Intent(this, MainActivity::class.java).apply {
            addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        }
        val open = PendingIntent.getActivity(this, 0, openIntent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val stopIntent = Intent(this, AirVpnService::class.java).setAction(STOP)
        val stop = PendingIntent.getService(this, 1, stopIntent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val builder = Notification.Builder(this, CHANNEL)
            .setSmallIcon(R.mipmap.ic_air)
            .setContentTitle(title)
            .setContentText(body)
            .setSubText(modeLabel)
            .setContentIntent(open)
            .setOnlyAlertOnce(true)
            .setOngoing(true)
            .setShowWhen(false)
            .setCategory(Notification.CATEGORY_SERVICE)
            .addAction(Notification.Action.Builder(null, strings.stop, stop).build())
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            builder.setForegroundServiceBehavior(Notification.FOREGROUND_SERVICE_IMMEDIATE)
        }
        return builder.build() to signature
    }

    private fun formatSpeed(bytesPerSecond: Long): String {
        val value = bytesPerSecond.coerceAtLeast(0L).toDouble()
        return when {
            value < 1024.0 -> "${value.toLong()} B/s"
            value < 1024.0 * 1024.0 -> String.format(Locale.US, "%.1f KB/s", value / 1024.0)
            value < 1024.0 * 1024.0 * 1024.0 -> String.format(Locale.US, "%.1f MB/s", value / (1024.0 * 1024.0))
            else -> String.format(Locale.US, "%.2f GB/s", value / (1024.0 * 1024.0 * 1024.0))
        }
    }

    private data class NotificationStrings(
        val rule: String,
        val global: String,
        val direct: String,
        val directMode: String,
        val starting: String,
        val stop: String,
    )

    private data class OutboundSummary(
        val mode: String = "rule",
        val label: String = "",
    )

    private data class State(val phase: String, val error: String? = null, val startedAt: Long = 0, val port: Int? = null)
    private data class StartRequest(val plan: JSONObject, val complete: (JSONObject) -> Unit)

    companion object {
        private const val CONNECT = "app.air.android.CONNECT"
        private const val STOP = "app.air.android.STOP"
        private const val CHANNEL = "air-vpn"
        private const val NOTIFICATION = 7
        private const val TRAFFIC_INTERVAL_MS = 1000L
        private const val ADDRESS = "198.19.64.1"
        private const val DNS = "198.19.64.2"
        private const val IPV6 = "fdfe:dcba:9876::1"
        private const val DNS_IPV6 = "fdfe:dcba:9876::2"
        private val tunnelDnsAddresses = setOf(InetAddress.getByName(DNS), InetAddress.getByName(DNS_IPV6))
        // The native TUN treats an unspecified address as a wildcard for port 53.
        private const val DNS_HIJACK_ANY = "0.0.0.0"
        private val pending = AtomicReference<StartRequest?>()
        @Volatile private var state = State("idle")
        @Volatile private var activeOutbound = OutboundSummary()
        @Volatile private var activeService: AirVpnService? = null

        fun connections(since: Long): JSONObject {
            val service = activeService ?: return JSONObject()
            if (!running()) return JSONObject()
            val now = SystemClock.elapsedRealtime()
            return service.connectionSamples.read(now, since, Core::connectionRows)
        }

        fun clearConnectionLogs() {
            activeService?.connectionSamples?.clearClosed()
        }

        private fun outboundSummary(plan: JSONObject): OutboundSummary {
            val mode = plan.optJSONObject("config")?.optString("mode", "rule")?.takeIf { it.isNotBlank() } ?: "rule"
            if (mode == "direct") return OutboundSummary(mode = "direct", label = "")
            val explicitLabel = plan.optString("outboundLabel", "").trim()
            val fallback = plan.optJSONObject("select")?.optString("GLOBAL", "")?.trim()
                ?.takeUnless { it.equals("DIRECT", ignoreCase = true) }
                .orEmpty()
            return OutboundSummary(mode = mode, label = explicitLabel.ifEmpty { fallback })
        }

        fun updateOutbound(plan: JSONObject) {
            activeOutbound = outboundSummary(plan)
            refreshNotification()
        }

        fun refreshNotification() {
            val service = activeService ?: return
            service.mainHandler.post {
                service.postNotification(force = true)
                if (service.ownsTunnel && state.phase == "running") {
                    service.startTrafficTicker()
                }
            }
        }

        internal fun connect(context: Context, plan: JSONObject, complete: (JSONObject) -> Unit) {
            require(state.phase in setOf("idle", "error")) { "VPN 正在切换，请稍后重试" }
            state = State("starting")
            pending.set(StartRequest(plan, complete))
            try {
                context.startForegroundService(Intent(context, AirVpnService::class.java).setAction(CONNECT))
            } catch (error: Exception) {
                pending.set(null)
                state = State("error", error.message)
                throw error
            }
        }

        internal fun reconfigure(context: Context, plan: JSONObject) {
            val service = activeService
            check(running() && service != null) { "VPN 未连接" }
            val previousPlan = Core.activePlan()
            val nextSig = parseTunnelSignature(plan)
            require(nextSig.mtu in 1280..9000 && nextSig.stack in setOf("gvisor", "system", "mixed")) { "虚拟网卡配置无效" }
            buildTunnelRoutePlan(Build.VERSION.SDK_INT, nextSig.ipv6, nextSig.bypassLan, nextSig.exclusions)
            val tunnelChanged = previousPlan == null || parseTunnelSignature(previousPlan) != nextSig
            if (!tunnelChanged) {
                try {
                    Core.applyNetwork(context, plan)
                    val port = plan.getJSONObject("config").optInt("mixed-port", 0).takeIf { it > 0 }
                    state = state.copy(port = port)
                    updateOutbound(plan)
                } catch (error: Exception) {
                    if (!Core.hasActiveProfile()) runCatching { disconnect(context) }
                    throw error
                }
                return
            }
            service.unregisterNetworkCallback(clearTracked = false)
            if (service.ownsTunnel) {
                runCatching { Clash.stopTun() }
                service.ownsTunnel = false
            }
            runCatching { Core.action("closeAllConnections") }
            try {
                Core.applyNetwork(service, plan)
                service.establishTunnel(plan)
                val port = plan.getJSONObject("config").optInt("mixed-port", 0).takeIf { it > 0 }
                state = state.copy(port = port)
                updateOutbound(plan)
            } catch (error: Exception) {
                if (service.ownsTunnel) {
                    runCatching { Clash.stopTun() }
                    service.ownsTunnel = false
                }
                val rollback = previousPlan?.let { prev ->
                    runCatching {
                        Core.applyNetwork(service, prev)
                        service.establishTunnel(prev)
                        updateOutbound(prev)
                    }
                }
                if (rollback == null || rollback.isFailure) {
                    service.closeTunnel()
                    state = State("error", error.message ?: "无法更新虚拟网卡配置")
                    service.stopSelf()
                }
                throw error
            }
        }

        internal fun disconnect(context: Context) {
            if (state.phase in setOf("running", "starting")) {
                context.startService(Intent(context, AirVpnService::class.java).setAction(STOP))
            }
        }

        internal fun running() = state.phase == "running"

        internal fun isIdle() = state.phase == "idle"

        internal fun snapshot(): JSONObject {
            val now = state
            return JSONObject().put("phase", now.phase).put("error", now.error).put("port", now.port)
                .put("startedAt", now.startedAt).put("traffic", if (now.phase == "running") Core.traffic() else JSONObject())
                .put("totals", if (now.phase == "running") Core.totals() else JSONObject.NULL)
        }
    }
}
