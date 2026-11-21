package app.air.android

import android.Manifest
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Intent
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.graphics.Color
import android.graphics.Bitmap
import android.graphics.Canvas
import android.net.Uri
import android.net.VpnService
import android.os.Build
import android.os.Bundle
import android.util.Base64
import android.util.LruCache
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONObject
import org.json.JSONArray
import java.io.File
import java.io.ByteArrayOutputStream
import java.net.URI
import java.util.concurrent.Executors
import javax.net.ssl.HttpsURLConnection

class MainActivity : ComponentActivity() {
    private lateinit var web: WebView
    private lateinit var container: FrameLayout
    private val requests = Executors.newSingleThreadExecutor()
    private val applications = LruCache<String, JSONObject>(64)
    private var pendingVpn: Pair<Message, JSONObject>? = null
    private var pendingExport: Pair<Message, String>? = null
    private var pendingFile: Pair<Message, Boolean>? = null
    private var pendingCamera: PermissionRequest? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        container = FrameLayout(this)
        setContentView(container)
        ViewCompat.setOnApplyWindowInsetsListener(container) { view, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            val keyboard = insets.getInsets(WindowInsetsCompat.Type.ime())
            view.setPadding(bars.left, bars.top, bars.right, maxOf(bars.bottom, keyboard.bottom))
            insets
        }
        // 初始化仅同步系统栏图标明暗，保留 windowBackground 展示冷启动 Logo
        val systemDark = (resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES
        WindowCompat.getInsetsController(window, container).apply {
            isAppearanceLightStatusBars = !systemDark
            isAppearanceLightNavigationBars = !systemDark
        }
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (!::web.isInitialized) {
                    finish()
                    return
                }
                web.evaluateJavascript("window.dispatchEvent(new Event('air-back', {cancelable:true}))") {
                    if (it == "true") moveTaskToBack(true)
                }
            }
        })
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            container.addView(TextView(this).apply {
                text = "请更新 Android System WebView 后重新打开 Air。"
                setPadding(32, 48, 32, 32)
            })
            return
        }
        val loader = WebViewAssetLoader.Builder().addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this)).build()
        web = WebView(this).apply {
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.allowFileAccess = false
            settings.allowContentAccess = false
            settings.setSupportMultipleWindows(false)
            overScrollMode = WebView.OVER_SCROLL_NEVER
            setBackgroundColor(Color.TRANSPARENT)
            webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean =
                    !request.url.toString().startsWith("$ORIGIN/assets/web/")

                override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse =
                    loader.shouldInterceptRequest(request.url) ?: WebResourceResponse(
                        "text/plain", "UTF-8", 403, "Forbidden", emptyMap(), null
                    )
            }
            webChromeClient = object : WebChromeClient() {
                override fun onPermissionRequest(request: PermissionRequest) = requestVideo(request)
                override fun onPermissionRequestCanceled(request: PermissionRequest) {
                    if (pendingCamera === request) pendingCamera = null
                }
            }
        }
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            WebViewCompat.addWebMessageListener(web, "airAndroid", setOf(ORIGIN)) { _, message, origin, main, reply ->
                val raw = message.data
                if (main && origin.toString() == ORIGIN && raw != null && raw.length <= MAX_MESSAGE) {
                    receive(raw, reply)
                }
            }
        }
        container.addView(web, FrameLayout.LayoutParams(-1, -1))
        web.loadUrl("$ORIGIN/assets/web/index.html")
    }

    private fun receive(raw: String, reply: JavaScriptReplyProxy) {
        val request = runCatching { JSONObject(raw) }.getOrNull() ?: return
        val message = Message(request.optString("id"), reply)
        val data = request.optJSONObject("data") ?: JSONObject()
        try {
            when (request.optString("action")) {
                "load" -> work(message, requests) { AirLibrary.read(this).apply {
                    SubscriptionUpdates.schedule(this@MainActivity, this)
                    val stored = remove("monitorPlan") as? JSONObject
                    if (stored != null && stored.optJSONObject("plan")?.has("probeTargets") != true) put("upgradeMonitorPlan", true)
                } }
                "save" -> work(message, requests) {
                    AirLibrary.save(this, data)
                    true
                }
                "kernelInfo" -> message.send(JSONObject().put("version", "1.19.34").put("appVersion", appVersion())
                    .put("sdk", Build.VERSION.SDK_INT).put("abi", Build.SUPPORTED_ABIS.firstOrNull().orEmpty()))
                "monitorResults" -> work(message, requests) { AirLibrary.monitorResults(this) }
                "validatePlan", "testDns", "probe" -> work(message, requests) {
                    AirDiagnostics.run(this, request.getString("action"), data)
                }
                "checkUpdate" -> work(message, requests) { checkForAndroidUpdate(appVersion()) }
                "openLink" -> {
                    val url = data.getString("url")
                    require(url == "https://github.com/GuoWWWX" || url.startsWith(RELEASE_PAGE_PREFIX)) {
                        "无效的 Air 链接"
                    }
                    startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
                    message.send()
                }
                "fetch" -> work(message, requests) { fetchSubscription(data.getString("url")) }
                "paste" -> {
                    val clip = getSystemService(ClipboardManager::class.java).primaryClip
                    message.send(clip?.takeIf { it.itemCount > 0 }?.getItemAt(0)?.coerceToText(this)?.toString().orEmpty())
                }
                "copy" -> {
                    getSystemService(ClipboardManager::class.java).setPrimaryClip(ClipData.newPlainText("Air", data.getString("text")))
                    message.send()
                }
                "stagedSubscription" -> work(message, requests) {
                    SubscriptionUpdates.staged(this, data, consume = true) ?: JSONObject.NULL
                }
                "export" -> {
                    check(pendingExport == null) { "请先完成当前导出" }
                    val intent = Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE)
                        .setType("application/yaml").putExtra(Intent.EXTRA_TITLE, data.getString("name"))
                    pendingExport = message to data.getString("text")
                    try { startActivityForResult(intent, EXPORT_REQUEST) }
                    catch (error: Exception) { pendingExport = null; throw error }
                }
                "file" -> pickFile(message, data.optString("type") == "qr")
                "start" -> startVpn(message, data)
                "stop" -> {
                    AirVpnService.disconnect(this)
                    message.send()
                }
                "apply" -> work(message, Core.worker) {
                    check(AirVpnService.running()) { "VPN 未连接" }
                    Core.applyLive(this, data)
                    true
                }
                "runtimeConfig" -> work(message, Core.worker) {
                    if (AirVpnService.running()) Core.activeConfig() ?: JSONObject.NULL else JSONObject.NULL
                }
                "status" -> message.send(AirVpnService.snapshot())
                "connections" -> work(message, requests) {
                    if (AirVpnService.running()) withApplicationIcons(jsonResult(Core.action("getConnections"))) else JSONObject()
                }
                "closeConnection" -> work(message, Core.worker) {
                    if (AirVpnService.running()) Core.action("closeConnection", data.getString("id"))
                    true
                }
                "exit" -> work(message, requests) {
                    check(AirVpnService.running()) { "启动代理后可以检测出口" }
                    val result = jsonResult(Core.action("probeCurrentProxyIp", data.optString("mode")))
                    check(result.has("ip")) { "无法验证当前出口 IP" }
                    result
                }
                "theme" -> {
                    setThemeColors(data.optBoolean("dark"))
                    message.send()
                }
                else -> message.fail("此版本不支持该操作")
            }
        } catch (error: Exception) {
            message.fail(error.message ?: "操作失败")
        }
    }

    @Suppress("DEPRECATION")
    private fun appVersion() = packageManager.getPackageInfo(packageName, 0).versionName ?: "1.0.0"

    @Suppress("DEPRECATION")
    private fun withApplicationIcons(data: JSONObject): JSONObject {
        val connections = data.optJSONArray("connections") ?: return data
        val visible = JSONArray()
        val apps = JSONObject()
        val visited = mutableSetOf<String>()
        for (index in 0 until connections.length()) {
            val connection = connections.getJSONObject(index)
            val meta = connection.optJSONObject("metadata") ?: continue
            if (meta.optString("type").equals("inner", true)) continue
            visible.put(connection)
            val pkg = meta.optString("process")
            if (pkg.isBlank() || visited.size >= 64 || !visited.add(pkg)) continue
            val info = applications.get(pkg) ?: runCatching {
                val item = packageManager.getApplicationInfo(pkg, 0)
                val name = packageManager.getApplicationLabel(item).toString()
                val icon = packageManager.getApplicationIcon(item)
                val bitmap = Bitmap.createBitmap(48, 48, Bitmap.Config.ARGB_8888)
                try {
                    icon.setBounds(0, 0, bitmap.width, bitmap.height)
                    icon.draw(Canvas(bitmap))
                    val png = ByteArrayOutputStream().use { stream ->
                        bitmap.compress(Bitmap.CompressFormat.PNG, 100, stream)
                        Base64.encodeToString(stream.toByteArray(), Base64.NO_WRAP)
                    }
                    JSONObject().put("name", name).put("icon", "data:image/png;base64,$png")
                } finally { bitmap.recycle() }
            }.getOrDefault(JSONObject()).also { applications.put(pkg, it) }
            if (info.has("name")) apps.put(pkg, info)
        }
        return data.put("connections", visible).put("applications", apps)
    }

    private fun jsonResult(value: Any): JSONObject = when (value) {
        is JSONObject -> value
        is String -> if (value.isBlank()) JSONObject() else JSONObject(value)
        else -> JSONObject()
    }

    private fun work(message: Message, executor: java.util.concurrent.Executor, action: () -> Any) {
        executor.execute {
            runCatching(action).fold(message::send) { message.fail(it.message ?: "操作失败") }
        }
    }

    private inner class Message(private val id: String, private val reply: JavaScriptReplyProxy) {
        fun send(value: Any = true) = deliver(JSONObject().put("id", id).put("value", value))
        fun fail(reason: String) = deliver(JSONObject().put("id", id).put("error", reason.take(400)))
        private fun deliver(data: JSONObject) {
            runOnUiThread {
                if (!isDestroyed && WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
                    runCatching { reply.postMessage(data.toString()) }
                }
            }
        }
    }

    private fun startVpn(message: Message, plan: JSONObject) {
        check(pendingVpn == null) { "请先完成 Android VPN 授权" }
        val permission = VpnService.prepare(this)
        if (permission == null) {
            AirVpnService.connect(this, plan)
            message.send()
        } else {
            pendingVpn = message to plan
            startActivityForResult(permission, VPN_REQUEST)
        }
    }

    private fun pickFile(message: Message, image: Boolean) {
        check(pendingFile == null) { "文件选择器已经打开" }
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE)
            .setType(if (image) "image/*" else "*/*")
        pendingFile = message to image
        try {
            startActivityForResult(intent, FILE_REQUEST)
        } catch (error: Exception) {
            pendingFile = null
            throw error
        }
    }

    @Deprecated("Uses platform activity results for VPN consent and document picking")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        when (requestCode) {
            VPN_REQUEST -> pendingVpn?.also { (message, plan) ->
                pendingVpn = null
                if (resultCode == RESULT_OK) {
                    runCatching { AirVpnService.connect(this, plan) }.fold(
                        { message.send() }, { message.fail(it.message ?: "VPN 启动失败") }
                    )
                } else message.fail("未授予 Android VPN 权限")
            }
            EXPORT_REQUEST -> pendingExport?.also { (message, text) ->
                pendingExport = null
                val uri = data?.data
                if (resultCode != RESULT_OK || uri == null) message.send(false)
                else work(message, requests) {
                    val stream = contentResolver.openOutputStream(uri, "wt") ?: error("无法写入文件")
                    stream.use { it.write(text.toByteArray(Charsets.UTF_8)) }
                    true
                }
            }
            FILE_REQUEST -> pendingFile?.also { (message, image) ->
                pendingFile = null
                val uri = data?.data
                if (resultCode != RESULT_OK || uri == null) {
                    message.send(JSONObject.NULL)
                } else work(message, requests) { readDocument(uri, image) }
            }
        }
    }

    private fun readDocument(uri: Uri, image: Boolean): JSONObject {
        val bytes = contentResolver.openInputStream(uri)?.use { readBounded(it, MAX_SUBSCRIPTION) }
            ?: error("无法读取选中的文件")
        val name = contentResolver.query(uri, arrayOf("_display_name"), null, null, null)
            ?.use { if (it.moveToFirst()) it.getString(0) else null }.orEmpty()
        val result = JSONObject().put("name", name)
        if (image) {
            val mime = contentResolver.getType(uri).orEmpty()
            require(mime.startsWith("image/")) { "请选择二维码图片" }
            result.put("image", "data:$mime;base64," + Base64.encodeToString(bytes, Base64.NO_WRAP))
        } else result.put("text", bytes.toString(Charsets.UTF_8))
        return result
    }

    private fun requestVideo(request: PermissionRequest) {
        runOnUiThread {
            if (isDestroyed || request.origin.toString() != ORIGIN ||
                !request.resources.contains(PermissionRequest.RESOURCE_VIDEO_CAPTURE)) {
                request.deny()
            } else if (checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
                request.grant(arrayOf(PermissionRequest.RESOURCE_VIDEO_CAPTURE))
            } else {
                pendingCamera?.deny()
                pendingCamera = request
                requestPermissions(arrayOf(Manifest.permission.CAMERA), CAMERA_REQUEST)
            }
        }
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == CAMERA_REQUEST) {
            val request = pendingCamera
            pendingCamera = null
            if (grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED) {
                request?.grant(arrayOf(PermissionRequest.RESOURCE_VIDEO_CAPTURE))
            } else request?.deny()
        }
    }

    private fun setThemeColors(dark: Boolean) {
        container.setBackgroundColor(if (dark) Color.rgb(17, 24, 39) else Color.WHITE)
        WindowCompat.getInsetsController(window, container).apply {
            isAppearanceLightStatusBars = !dark
            isAppearanceLightNavigationBars = !dark
        }
    }

    override fun onDestroy() {
        pendingCamera?.deny()
        requests.shutdownNow()
        if (::web.isInitialized) {
            if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
                WebViewCompat.removeWebMessageListener(web, "airAndroid")
            }
            container.removeView(web)
            web.destroy()
        }
        super.onDestroy()
    }

    companion object {
        private const val ORIGIN = "https://appassets.androidplatform.net"
        private const val MAX_MESSAGE = 24 * 1024 * 1024
        private const val VPN_REQUEST = 20
        private const val EXPORT_REQUEST = 24
        private const val FILE_REQUEST = 21
        private const val CAMERA_REQUEST = 22
    }
}

private const val MAX_SUBSCRIPTION = 8 * 1024 * 1024
private const val GITHUB_REPOSITORY = "GuoWWWX/Air-Proxy"
private const val RELEASE_PAGE_PREFIX = "https://github.com/$GITHUB_REPOSITORY/releases/"

private fun checkForAndroidUpdate(current: String): JSONObject {
    val api = URI("https://api.github.com/repos/$GITHUB_REPOSITORY/releases?per_page=20")
    val connection = api.toURL().openConnection() as HttpsURLConnection
    connection.connectTimeout = 8500
    connection.readTimeout = 8500
    connection.setRequestProperty("User-Agent", "Air-Android/$current")
    connection.setRequestProperty("Accept", "application/vnd.github+json")
    val releases = try {
        check(connection.responseCode == 200) { "无法检查 GitHub 版本 · HTTP ${connection.responseCode}" }
        connection.inputStream.use { JSONArray(readBounded(it, 2 * 1024 * 1024).toString(Charsets.UTF_8)) }
    } finally { connection.disconnect() }
    val version = Regex("""^v?(\d+)\.(\d+)\.(\d+)$""")
    fun number(value: String): List<Int>? = version.matchEntire(value)?.groupValues?.drop(1)?.map {
        it.toIntOrNull() ?: return null
    }
    fun newer(left: List<Int>, right: List<Int>): Boolean {
        val change = left.indices.firstOrNull { left[it] != right[it] } ?: return false
        return left[change] > right[change]
    }
    val result = JSONObject().put("current", current)
    var latest = number(current) ?: listOf(0, 0, 0)
    for (index in 0 until releases.length()) {
        val release = releases.getJSONObject(index)
        if (release.optBoolean("draft") || release.optBoolean("prerelease")) continue
        val tag = release.optString("tag_name")
        val candidate = number(tag) ?: continue
        if (!newer(candidate, latest)) continue
        val assets = release.optJSONArray("assets") ?: continue
        if ((0 until assets.length()).none { assets.getJSONObject(it).optString("name").endsWith(".apk", true) }) continue
        val page = release.optString("html_url")
        if (!page.startsWith(RELEASE_PAGE_PREFIX)) continue
        latest = candidate
        result.put("version", tag.removePrefix("v")).put("url", page)
    }
    return result
}

private fun readBounded(stream: java.io.InputStream, limit: Int): ByteArray {
    val output = java.io.ByteArrayOutputStream()
    val buffer = ByteArray(8192)
    while (true) {
        val count = stream.read(buffer)
        if (count < 0) return output.toByteArray()
        require(output.size() + count <= limit) { "文件超过 8 MB" }
        output.write(buffer, 0, count)
    }
}

internal fun subscriptionTitle(header: String?): String? {
    val raw = header?.trim() ?: return null
    val value = if (raw.startsWith("base64:", ignoreCase = true)) {
        runCatching {
            java.util.Base64.getDecoder().decode(raw.substring(7).trim()).decodeToString(throwOnInvalidSequence = true)
        }.getOrNull() ?: return null
    } else if (raw.any { it.code >= 128 } && raw.all { it.code <= 255 }) {
        // Some HTTP stacks expose the original UTF-8 bytes as Latin-1 characters.
        runCatching { raw.toByteArray(Charsets.ISO_8859_1).decodeToString(throwOnInvalidSequence = true) }.getOrDefault(raw)
    } else raw
    return value.trim().takeIf { it.isNotEmpty() && it.codePointCount(0, it.length) <= 256 && it.none(Char::isISOControl) }
}

internal fun fetchSubscription(address: String): JSONObject {
    var uri = URI(address.trim())
    repeat(5) {
        require(uri.scheme == "https" && uri.host != null && uri.userInfo == null) { "请输入有效的 HTTPS 订阅链接" }
        val connection = uri.toURL().openConnection() as HttpsURLConnection
        try {
            connection.instanceFollowRedirects = false
            connection.connectTimeout = 12_000
            connection.readTimeout = 18_000
            connection.setRequestProperty("User-Agent", "Clash.Meta Air/1.0.0")
            when (val code = connection.responseCode) {
                301, 302, 303, 307, 308 -> {
                    val location = connection.getHeaderField("Location") ?: error("订阅重定向缺少地址")
                    uri = uri.resolve(location)
                }
                200 -> {
                    val bytes = connection.inputStream.use { readBounded(it, MAX_SUBSCRIPTION) }
                    return JSONObject().put("text", bytes.toString(Charsets.UTF_8))
                        .put("profileTitle", subscriptionTitle(connection.getHeaderField("Profile-Title")))
                        .put("usage", connection.getHeaderField("subscription-userinfo"))
                        .put("intervalHours", connection.getHeaderField("profile-update-interval")?.trim()?.toIntOrNull()?.takeIf { it in 1..720 })
                }
                else -> error("订阅服务器返回 HTTP $code")
            }
        } finally {
            connection.disconnect()
        }
    }
    error("订阅重定向次数过多")
}
