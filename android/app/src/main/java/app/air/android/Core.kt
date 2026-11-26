package app.air.android

import android.content.Context
import android.os.Build
import android.util.AtomicFile
import io.github.oviron.libmihomo.Clash
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.util.UUID
import java.util.concurrent.CompletableFuture
import java.util.concurrent.Executors
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference

internal object Core {
    val worker = Executors.newSingleThreadExecutor()
    private val probeGeneration = AtomicLong(0)
    private val activeProbeQueue = AtomicReference<LinkedBlockingQueue<Pair<String, Int>>?>(null)
    private data class Profile(val plan: JSONObject, val config: JSONObject) {
        val mode = config.getString("mode")
        val selected = plan.optJSONObject("select") ?: JSONObject()
    }
    private var profile: Profile? = null
    private var stoppedProfile: Profile? = null

    fun prepare(context: Context, plan: JSONObject) {
        if (profile != null) return
        val next = Profile(plan, configFor(plan))
        if (stoppedProfile?.let { sameConfig(it, next) } == true) return
        stoppedProfile = null
        configure(context, next, startListeners = false)
        stoppedProfile = next
    }

    fun apply(context: Context, plan: JSONObject) {
        if (profile?.plan?.toString() == plan.toString()) return
        val previous = profile
        val next = Profile(plan, configFor(plan))
        val stopped = stoppedProfile
        stoppedProfile = null
        if (context is AirVpnService && stopped != null && sameConfig(stopped, next)) {
            val resumed = runCatching {
                updateOutbound(stopped, next)
                configureMixedListener(next.config.getInt("mixed-port"), next.config.getBoolean("allow-lan"))
                check(action("startListener") == true)
            }
            if (resumed.isSuccess) {
                profile = next
                return
            }
        }
        applyFull(context, next, previous)
    }

    private fun applyFull(context: Context, next: Profile, previous: Profile?) {
        try {
            configure(context, next)
            profile = next
        } catch (error: Exception) {
            if (previous == null || runCatching { configure(context, previous) }.isFailure) {
                profile = null
                stopListening()
            }
            throw error
        }
    }

    fun hasActiveProfile() = profile != null

    fun activePlan(): JSONObject? = profile?.plan?.let { JSONObject(it.toString()) }

    fun applyNetwork(context: Context, plan: JSONObject) {
        val previous = checkNotNull(profile) { "Mihomo 尚未启动" }
        val next = Profile(plan, configFor(plan))
        val modeChanged = previous.mode != next.mode
        val outboundChanged = previous.selected.optString("GLOBAL") != next.selected.optString("GLOBAL")
        if (sameConfig(previous, next)) {
            updateOutbound(previous, next)
            profile = next
            if (modeChanged) {
                runCatching { action("closeAllConnections") }
            } else if (outboundChanged) {
                closeProxiedConnections()
            }
            return
        }
        applyFull(context, next, previous)
        if (modeChanged) {
            runCatching { action("closeAllConnections") }
        } else if (outboundChanged) {
            closeProxiedConnections()
        }
    }

    fun applyLive(context: Context, plan: JSONObject) {
        val previous = checkNotNull(profile) { "Mihomo 尚未启动" }
        val activeConfig = previous.plan.getJSONObject("config")
        val config = plan.getJSONObject("config")
        for (key in listOf("ipv6", "dns", "tcp-concurrent", "mixed-port", "allow-lan", "bind-address")) {
            if (activeConfig.has(key)) config.put(key, activeConfig.get(key)) else config.remove(key)
        }
        // Network preferences apply on restart. The new outbound's subscription records apply now.
        plan.put("localHosts", previous.plan.optJSONObject("localHosts") ?: activeConfig.optJSONObject("hosts") ?: JSONObject())
        for (key in listOf("ipv6", "tunnel")) {
            if (previous.plan.has(key)) plan.put(key, previous.plan.get(key)) else plan.remove(key)
        }
        val next = Profile(plan, configFor(plan))
        val modeChanged = previous.mode != next.mode
        val outboundChanged = previous.selected.optString("GLOBAL") != next.selected.optString("GLOBAL")
        if (sameConfig(previous, next) && runCatching { updateOutbound(previous, next) }.isSuccess) {
            profile = next
            if (modeChanged) {
                runCatching { action("closeAllConnections") }
            } else if (outboundChanged) {
                closeProxiedConnections()
            }
            return
        }
        applyFull(context, next, previous)
        if (modeChanged) {
            runCatching { action("closeAllConnections") }
        } else if (outboundChanged) {
            closeProxiedConnections()
        }
    }

    fun connectionRows(): JSONArray {
        val data = when (val raw = action("getConnections")) {
            is JSONObject -> raw
            is String -> JSONObject(raw)
            else -> JSONObject()
        }
        return data.optJSONArray("connections") ?: JSONArray()
    }

    private fun closeProxiedConnections() {
        runCatching {
            val connections = connectionRows()
            for (index in 0 until connections.length()) {
                val conn = connections.optJSONObject(index) ?: continue
                if (conn.optJSONObject("metadata")?.optString("type").equals("inner", ignoreCase = true)) continue
                val leaf = conn.optJSONArray("chains")?.optString(0).orEmpty()
                if (!leaf.equals("DIRECT", ignoreCase = true)) {
                    val id = conn.optString("id")
                    if (id.isNotEmpty()) runCatching { action("closeConnection", id) }
                }
            }
        }
    }

    // Effective hosts are part of this comparison. Another subscription can use
    // the same server name with different addresses and needs a real reload.
    private fun sameConfig(previous: Profile, next: Profile): Boolean =
        previous.config.length() == next.config.length() &&
            previous.config.keys().asSequence().all { key ->
                key == "mode" || previous.config.opt(key)?.toString() == next.config.opt(key)?.toString()
            } &&
            previous.selected.keys().asSequence().toSet() == next.selected.keys().asSequence().toSet()

    private fun updateOutbound(previous: Profile, next: Profile) {
        for (group in next.selected.keys()) {
            val target = next.selected.getString(group)
            if (target == previous.selected.getString(group)) continue
            val change = JSONObject().put("group-name", group).put("proxy-name", target)
            action("changeProxy", change.toString())
        }
        if (previous.mode != next.mode) {
            val result = action("updateConfig", JSONObject().put("mode", next.mode).toString()).toString()
            check(result.isEmpty()) { result }
        }
    }

    fun validate(context: Context, plan: JSONObject) {
        load(context)
        val file = File.createTempFile("air-config-", ".yaml", context.cacheDir)
        try {
            file.writeText(encode(configFor(plan)))
            val problem = action("validateConfig", file.absolutePath).toString()
            check(problem.isBlank()) { "Mihomo 配置校验失败：${problem.take(260)}" }
        } finally {
            file.delete()
        }
    }

    private fun configure(context: Context, next: Profile, startListeners: Boolean = true) {
        val directory = if (context is AirVpnService || context is MainActivity) "mihomo" else "monitor-mihomo"
        val home = File(context.noBackupFilesDir, directory).apply { mkdirs() }
        seedGeodata(context, home)
        load(context)
        // Mihomo applies its own listeners while loading a file, even before startListener.
        val config = if (startListeners) next.config else JSONObject(next.config.toString())
            .put("mixed-port", 0).put("allow-lan", false)
        val yaml = encode(config)
        writeAtomic(AtomicFile(File(home, "config.yaml")), yaml.toByteArray(Charsets.UTF_8))
        val init = JSONObject().put("home-dir", home.absolutePath).put("version", Build.VERSION.SDK_INT)
        val setup = JSONObject().put("selected-map", next.selected)
        if (!startListeners) {
            // quickSetup enables listeners. Prepare the same configuration with them closed.
            check(action("stopListener") == true) { "无法关闭 Mihomo 监听" }
            check(action("initClash", init.toString()) == true) { "无法初始化 Mihomo" }
            val problem = action("setupConfig", setup.toString()).toString()
            check(problem.isBlank()) { "Mihomo 配置失败：${problem.take(260)}" }
            return
        }
        val ready = CompletableFuture<String?>()
        Clash.quickSetup(init.toString(), setup.toString()) { ready.complete(it) }
        val message = ready.get(20, TimeUnit.SECONDS)
        check(message.isNullOrBlank()) { "Mihomo 配置失败：${message?.take(260)}" }
    }

    private fun seedGeodata(context: Context, home: File) {
        for (name in listOf("GeoSite.dat", "geoip.metadb")) {
            val file = File(home, name)
            if (file.isFile && file.length() > 0) continue
            context.assets.open("geodata/$name").use { input ->
                writeAtomic(AtomicFile(file)) { output -> input.copyTo(output) }
            }
            check(file.isFile && file.length() > 0) { "无法准备 Mihomo 的 $name 数据库" }
        }
    }

    private fun load(context: Context) {
        Clash.load(context.applicationInfo.nativeLibraryDir)
        Clash.assertReady()
    }

    fun activeConfig(): JSONObject? {
        val current = profile ?: return null
        val config = JSONObject(current.config.toString())
        val groups = config.optJSONArray("proxy-groups") ?: return config
        for (index in 0 until groups.length()) {
            val group = groups.getJSONObject(index)
            val selected = current.selected.optString(group.getString("name"))
            if (selected.isEmpty()) continue
            val members = group.getJSONArray("proxies")
            val ordered = JSONArray().put(selected)
            for (member in 0 until members.length()) {
                if (members.getString(member) != selected) ordered.put(members.getString(member))
            }
            group.put("proxies", ordered)
        }
        return config
    }

    private fun configFor(plan: JSONObject): JSONObject {
        val config = JSONObject(plan.getJSONObject("config").toString())
        val local = plan.optJSONObject("localHosts")
        if (local != null) {
            val scopes = plan.optJSONObject("hostScopes")
            val table = scopes?.getJSONArray("tables")?.getJSONObject(scopes.getInt("active"))
            val hosts = JSONObject(table?.getJSONObject("hosts")?.toString() ?: "{}")
            table?.optJSONArray("conflicts")?.let { names ->
                for (i in 0 until names.length()) {
                    val domain = names.getString(i)
                    require(local.has(domain)) { "当前出站使用的订阅为 $domain 指定了不同的 hosts 地址" }
                }
            }
            for (domain in local.keys()) hosts.put(domain, local.get(domain))
            if (hosts.length() > 0) {
                config.put("hosts", hosts)
                config.getJSONObject("dns").put("use-hosts", true)
            } else {
                config.remove("hosts")
                config.getJSONObject("dns").remove("use-hosts")
            }
        }
        // Strip listeners that Air does not manage.
        for (field in listOf("tun", "listeners", "port", "socks-port", "redir-port", "tproxy-port",
            "external-controller", "external-controller-unix", "external-controller-tls",
            "external-controller-pipe", "external-ui", "external-ui-url")) {
            config.remove(field)
        }
        val port = config.optInt("mixed-port", 0)
        val allowLan = config.optBoolean("allow-lan") && port != 0
        require(port in 0..65535) { "混合端口无效" }
        return config.put("mixed-port", port).put("allow-lan", allowLan)
            .put("geodata-mode", false).put("geo-auto-update", false)
            .put("bind-address", if (allowLan) "*" else "127.0.0.1").put("log-level", "info")
    }

    // Android escapes solidi when serializing JSON; the Mihomo YAML parser rejects that escape.
    private fun encode(config: JSONObject) =
        config.toString().replace(Regex("""(?<!\\)((?:\\\\)*)\\/""")) { it.groupValues[1] + "/" }

    fun action(method: String, data: Any = JSONObject.NULL): Any {
        val result = response(method, data).get(12, TimeUnit.SECONDS)
        check(result.optInt("code") == 0) { result.optString("data", "Mihomo 操作失败").take(260) }
        return result.opt("data") ?: JSONObject.NULL
    }

    private fun response(method: String, data: Any): CompletableFuture<JSONObject> {
        val result = CompletableFuture<JSONObject>()
        val request = JSONObject().put("id", UUID.randomUUID().toString()).put("method", method).put("data", data)
        Clash.invokeAction(request.toString()) { raw ->
            runCatching { JSONObject(raw ?: "") }.fold(result::complete, result::completeExceptionally)
        }
        return result
    }

    fun currentProbeGeneration() = probeGeneration.get()

    private fun probeCancelled(generation: Long?) =
        generation != null && generation != currentProbeGeneration()

    fun cancelProbe() {
        probeGeneration.incrementAndGet()
        activeProbeQueue.get()?.offer(PROBE_CANCEL_SENTINEL to -1)
    }

    fun probe(
        context: Context, plan: JSONObject, aliases: JSONArray, url: String, expected: Int,
        generation: Long? = null, background: Boolean = false, highSpeed: Boolean = false,
        onResult: (String, Int) -> Unit = { _, _ -> },
    ): JSONObject {
        require(aliases.length() in 1..72)
        require(url.startsWith("https://") || url.startsWith("http://")) { "测速地址需使用 HTTP 或 HTTPS" }
        require(expected in 100..599) { "测速状态码无效" }
        val byProxy = plan.optJSONObject("hostScopes")?.optJSONObject("byProxy")
        val delays = JSONObject()
        var offset = 0
        while (offset < aliases.length()) {
            if (probeCancelled(generation)) break
            val scope = byProxy?.optInt(aliases.getString(offset), 0) ?: 0
            val names = mutableListOf<String>()
            do {
                names.add(aliases.getString(offset++))
            } while (offset < aliases.length() && (byProxy?.optInt(aliases.getString(offset), 0) ?: 0) == scope)
            val testPlan = JSONObject(plan.toString())
            testPlan.optJSONObject("hostScopes")?.put("active", scope)
            val sourceTargets = plan.optJSONObject("probeTargets")
            val targets = names.associateWith { name ->
                val source = sourceTargets?.optJSONObject(name)
                val sourceUrl = if (source != null && source.has("url")) source.getString("url") else null
                val sourceStatus = if (source != null && source.has("expected")) source.getString("expected") else null
                ProbeTarget.select(url, expected, sourceUrl, sourceStatus)
            }
            for ((name, delay) in probeBatch(context, testPlan, targets, url, expected, generation, background, highSpeed, onResult)) {
                delays.put(name, delay)
            }
        }
        return delays
    }

    private fun probeBatch(
        context: Context,
        testPlan: JSONObject,
        targets: Map<String, ProbeTarget>,
        url: String,
        expected: Int,
        generation: Long?,
        background: Boolean,
        highSpeed: Boolean,
        onResult: (String, Int) -> Unit,
    ): Map<String, Int> {
        if (probeCancelled(generation)) return emptyMap()
        val config = testPlan.getJSONObject("config")
            .put("mode", "rule")
            .put("mixed-port", 0)
            .put("allow-lan", false)
            .put("unified-delay", true)
            .put("find-process-mode", "off")
            .put("rules", JSONArray().put("MATCH,DIRECT"))
        config.remove("rule-providers")
        config.remove("sniffer")
        val dns = config.optJSONObject("dns") ?: JSONObject().also { config.put("dns", it) }
        dns.put("enable", true).put("respect-rules", false).put("enhanced-mode", "redir-host")
        if ((dns.optJSONArray("default-nameserver")?.length() ?: 0) == 0) {
            dns.put("default-nameserver", JSONArray(listOf("223.5.5.5", "119.29.29.29", "1.1.1.1")))
        }
        testPlan.put("select", JSONObject())
        testPlan.remove("outboundLabel")

        val sourceTargets = testPlan.optJSONObject("probeTargets")
        val diagnosticGroups = JSONArray()
        val groupMap = mutableMapOf<Pair<String, String>, String>()
        fun ensureGroupsFor(proxyName: String) {
            val source = sourceTargets?.optJSONObject(proxyName)
            val sourceUrl = if (source != null && source.has("url")) source.getString("url") else null
            val sourceStatus = if (source != null && source.has("expected")) source.getString("expected") else null
            val target = ProbeTarget.select(url, expected, sourceUrl, sourceStatus)
            val urls = listOfNotNull(target.url, target.alternate)
            urls.forEachIndexed { idx, probeUrl ->
                if (groupMap.containsKey(proxyName to probeUrl)) return@forEachIndexed
                val groupName = "Air-Diag-$proxyName-$idx"
                groupMap[proxyName to probeUrl] = groupName
                diagnosticGroups.put(
                    JSONObject()
                        .put("name", groupName)
                        .put("type", "select")
                        .put("proxies", JSONArray().put(proxyName))
                        .put("url", probeUrl)
                        .put("expected-status", target.expected),
                )
            }
        }
        val servers = mutableMapOf<String, String>()
        val proxies = config.optJSONArray("proxies")
        if (proxies != null) {
            for (index in 0 until proxies.length()) {
                val proxy = proxies.getJSONObject(index)
                val proxyName = proxy.optString("name")
                if (proxyName.isNotEmpty()) {
                    ensureGroupsFor(proxyName)
                    val server = proxy.optString("server")
                    if (server.isNotBlank()) servers[proxyName] = probeServerKey(server)
                }
            }
        }
        for (alias in targets.keys) {
            ensureGroupsFor(alias)
        }
        config.put("proxy-groups", diagnosticGroups)

        apply(context, testPlan)
        if (probeCancelled(generation)) return emptyMap()
        val queue = LinkedBlockingQueue<Pair<String, Int>>()
        if (generation != null) activeProbeQueue.set(queue)
        return try {
            measureDelays(
                targets = targets,
                servers = servers,
                background = background,
                highSpeed = highSpeed,
                cancelled = { probeCancelled(generation) },
                completed = queue,
                onResult = onResult,
            ) { name, probeUrl, timeout ->
                if (probeCancelled(generation)) {
                    CompletableFuture.completedFuture(-1)
                } else {
                    val group = groupMap.getValue(name to probeUrl)
                    val params = JSONObject()
                        .put("group-names", JSONArray().put(group))
                        .put("test-url", probeUrl)
                        .put("timeout", timeout)
                    response("testGroups", params.toString()).thenApply { reply ->
                        val rows = JSONArray(reply.getString("data"))
                        (0 until rows.length()).map { rows.getJSONObject(it) }
                            .firstOrNull { it.optString("name") == name }
                            ?.optInt("value", -1) ?: -1
                    }
                }
            }
        } finally {
            activeProbeQueue.compareAndSet(queue, null)
            // Finish cancellation on this worker before another plan starts using the core.
            if (probeCancelled(generation)) runCatching { action("closeAllConnections") }
        }
    }

    fun <T> withProfile(context: Context, plan: JSONObject, run: () -> T): T {
        val previous = profile
        apply(context, plan)
        try {
            return run()
        } finally {
            if (previous == null) stopListening() else apply(context, previous.plan)
        }
    }

    fun traffic(): JSONObject = if (Clash.isLoaded()) JSONObject(Clash.getTraffic()) else JSONObject()
    fun totals(): JSONObject = if (Clash.isLoaded()) JSONObject(Clash.getTotalTraffic()) else JSONObject()

    private fun configureMixedListener(port: Int, allowLan: Boolean) {
        val update = JSONObject().put("mixed-port", port).put("allow-lan", allowLan)
        val problem = action("updateConfig", update.toString()).toString()
        check(problem.isBlank()) { problem }
    }

    fun closeMixedListener() {
        if ((profile?.config?.optInt("mixed-port") ?: 0) > 0) {
            runCatching { configureMixedListener(0, false) }
        }
    }

    fun stopListening() {
        stoppedProfile = null
        if (Clash.isLoaded()) {
            runCatching { action("closeAllConnections") }
            if (runCatching { action("stopListener") == true }.getOrDefault(false)) {
                stoppedProfile = profile
            }
        }
        profile = null
    }
}

internal fun writeAtomic(file: AtomicFile, bytes: ByteArray) = writeAtomic(file) { it.write(bytes) }

private fun writeAtomic(file: AtomicFile, write: (FileOutputStream) -> Unit) {
    val stream = file.startWrite()
    try {
        write(stream)
        file.finishWrite(stream)
    } catch (error: Exception) {
        file.failWrite(stream)
        throw error
    }
}
