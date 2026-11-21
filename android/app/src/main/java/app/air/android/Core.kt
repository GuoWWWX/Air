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
import java.util.concurrent.TimeUnit

internal object Core {
    val worker = Executors.newSingleThreadExecutor()
    private var profile: JSONObject? = null

    fun apply(context: Context, plan: JSONObject) {
        if (profile?.toString() == plan.toString()) return
        val previous = profile
        try {
            configure(context, plan)
            profile = plan
        } catch (error: Exception) {
            if (previous != null) {
                runCatching { configure(context, previous) }
            } else {
                stopListening()
            }
            throw error
        }
    }

    fun applyLive(context: Context, plan: JSONObject) {
        val previous = checkNotNull(profile) { "Mihomo 尚未启动" }
        val next = JSONObject(plan.toString())
        val activeConfig = previous.getJSONObject("config")
        val config = next.getJSONObject("config")
        for (key in listOf("ipv6", "dns", "tcp-concurrent", "mixed-port", "allow-lan", "bind-address")) {
            if (activeConfig.has(key)) config.put(key, activeConfig.get(key)) else config.remove(key)
        }
        // Network preferences apply on restart. The new outbound's subscription records apply now.
        next.put("localHosts", previous.optJSONObject("localHosts") ?: activeConfig.optJSONObject("hosts") ?: JSONObject())
        for (key in listOf("ipv6", "tunnel")) {
            if (previous.has(key)) next.put(key, previous.get(key)) else next.remove(key)
        }
        apply(context, next)
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

    private fun configure(context: Context, plan: JSONObject) {
        val directory = if (context is AirVpnService || context is MainActivity) "mihomo" else "monitor-mihomo"
        val home = File(context.noBackupFilesDir, directory).apply { mkdirs() }
        seedGeodata(context, home)
        load(context)
        val yaml = encode(configFor(plan))
        writeAtomic(AtomicFile(File(home, "config.yaml")), yaml.toByteArray(Charsets.UTF_8))
        val init = JSONObject().put("home-dir", home.absolutePath).put("version", Build.VERSION.SDK_INT)
        val setup = JSONObject().put("selected-map", plan.optJSONObject("select") ?: JSONObject())
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

    fun activeConfig(): JSONObject? = profile?.let { configFor(it) }

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

    fun probe(context: Context, plan: JSONObject, aliases: JSONArray, url: String, expected: Int): JSONObject {
        require(aliases.length() in 1..6)
        require(url.startsWith("https://") || url.startsWith("http://")) { "测速地址需使用 HTTP 或 HTTPS" }
        require(expected in 100..599) { "测速状态码无效" }
        val byProxy = plan.optJSONObject("hostScopes")?.getJSONObject("byProxy")
        val batches = (0 until aliases.length()).map { aliases.getString(it) }.groupBy { byProxy?.optInt(it, 0) ?: 0 }
        val delays = JSONObject()
        for ((scope, names) in batches) {
            val testPlan = JSONObject(plan.toString())
            testPlan.optJSONObject("hostScopes")?.put("active", scope)
            val sourceTargets = plan.optJSONObject("probeTargets")
            val targets = names.associateWith { name ->
                val source = sourceTargets?.optJSONObject(name)
                ProbeTarget.select(url, expected, source?.getString("url"), source?.getString("expected"))
            }
            for ((name, delay) in probeBatch(context, testPlan, targets)) delays.put(name, delay)
        }
        return delays
    }

    private fun probeBatch(context: Context, testPlan: JSONObject, targets: Map<String, ProbeTarget>): Map<String, Int> {
        val config = testPlan.getJSONObject("config").put("mixed-port", 0).put("allow-lan", false).put("unified-delay", true)
        val groups = config.optJSONArray("proxy-groups") ?: JSONArray().also { config.put("proxy-groups", it) }
        val groupNames = mutableMapOf<Pair<String, String>, String>()
        for ((name, target) in targets) {
            for (url in listOfNotNull(target.url, target.alternate)) {
                val group = "Air-Diagnostic-${groupNames.size}"
                groupNames[name to url] = group
                groups.put(JSONObject().put("name", group).put("type", "select").put("proxies", JSONArray().put(name))
                    .put("url", url).put("expected-status", target.expected))
            }
        }
        return withProfile(context, testPlan) {
            measureDelays(targets) { name, url, timeout ->
                val group = groupNames.getValue(name to url)
                val params = JSONObject().put("group-names", JSONArray().put(group)).put("test-url", url).put("timeout", timeout)
                response("testGroups", params.toString()).thenApply { reply ->
                    val rows = JSONArray(reply.getString("data"))
                    (0 until rows.length()).map { rows.getJSONObject(it) }.firstOrNull { it.optString("name") == name }
                        ?.optInt("value", -1) ?: -1
                }
            }
        }
    }

    fun <T> withProfile(context: Context, plan: JSONObject, run: () -> T): T {
        val previous = profile
        apply(context, plan)
        try {
            return run()
        } finally {
            if (previous == null) stopListening() else apply(context, previous)
        }
    }

    fun traffic(): JSONObject = if (Clash.isLoaded()) JSONObject(Clash.getTraffic()) else JSONObject()
    fun totals(): JSONObject = if (Clash.isLoaded()) JSONObject(Clash.getTotalTraffic()) else JSONObject()

    fun stopListening() {
        if (Clash.isLoaded()) {
            runCatching { action("closeAllConnections") }
            runCatching { action("stopListener") }
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
