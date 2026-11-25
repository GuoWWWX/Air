package app.air.android

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.Settings
import androidx.core.content.FileProvider
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.RandomAccessFile
import java.net.HttpURLConnection
import java.net.InetSocketAddress
import java.net.Proxy
import java.net.URI
import java.net.URL
import java.security.MessageDigest
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.Future
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference

private const val GITHUB_REPOSITORY = "GuoWWWX/Air-Proxy"
internal const val RELEASE_PAGE_PREFIX = "https://github.com/$GITHUB_REPOSITORY/releases/"
private const val ANDROID_UPDATE_CHUNK = 1024 * 1024L
private const val MIN_REUSE_ENTRY_BYTES = 65_536L
private const val MAX_HEADER_PROBES = 64

internal data class ZipEntryMeta(
    val name: String,
    val method: Int,
    val crc32: Long,
    val compSize: Long,
    val uncompSize: Long,
    val localHeaderOffset: Long,
)

internal data class LocalApkSpan(
    val dataOffset: Long,
    val compSize: Long,
    val head32: ByteArray,
)

internal data class ZipEntryKey(
    val name: String,
    val method: Int,
    val crc32: Long,
    val compSize: Long,
    val uncompSize: Long,
)

internal data class ReusedSpan(
    val remoteOffset: Long,
    val localOffset: Long,
    val length: Long,
)

internal data class DownloadSpan(
    val offset: Long,
    val length: Long,
    @Volatile var done: Long = 0L,
)

internal data class IncrementalPlan(
    val apkSize: Long,
    val reused: List<ReusedSpan>,
    val download: List<DownloadSpan>,
    val reusedBytes: Long,
)

internal object ZipIncrementalPlanner {
    private fun u16(buf: ByteArray, off: Int): Int =
        (buf[off].toInt() and 0xff) or ((buf[off + 1].toInt() and 0xff) shl 8)

    private fun u32(buf: ByteArray, off: Int): Long =
        (buf[off].toLong() and 0xff) or
            ((buf[off + 1].toLong() and 0xff) shl 8) or
            ((buf[off + 2].toLong() and 0xff) shl 16) or
            ((buf[off + 3].toLong() and 0xff) shl 24)

    fun parseSha256Sums(text: String): Map<String, String> {
        val result = LinkedHashMap<String, String>()
        val linePattern = Regex("""^([0-9a-fA-F]{64})\s+\*?(.+?)\s*$""")
        for (rawLine in text.lineSequence()) {
            val match = linePattern.matchEntire(rawLine.trim()) ?: continue
            val digest = match.groupValues[1].lowercase()
            val name = match.groupValues[2].substringAfterLast('/')
            result[name] = digest
        }
        return result
    }

    fun findEocdOffset(tail: ByteArray): Int {
        if (tail.size < 22) return -1
        val minPos = maxOf(0, tail.size - 65_557)
        for (pos in (tail.size - 22) downTo minPos) {
            if (u32(tail, pos) == 0x06054b50L) {
                val commentLen = u16(tail, pos + 20)
                if (pos + 22 + commentLen == tail.size) return pos
            }
        }
        return -1
    }

    fun parseCentralDirectory(cdBytes: ByteArray): List<ZipEntryMeta> {
        val entries = ArrayList<ZipEntryMeta>()
        var off = 0
        while (off + 46 <= cdBytes.size) {
            if (u32(cdBytes, off) != 0x02014b50L) break
            val method = u16(cdBytes, off + 10)
            val crc = u32(cdBytes, off + 16)
            val compSize = u32(cdBytes, off + 20)
            val uncompSize = u32(cdBytes, off + 24)
            val nameLen = u16(cdBytes, off + 28)
            val extraLen = u16(cdBytes, off + 30)
            val commentLen = u16(cdBytes, off + 32)
            val localOffset = u32(cdBytes, off + 42)
            if (off + 46 + nameLen + extraLen + commentLen > cdBytes.size) break
            val name = String(cdBytes, off + 46, nameLen, Charsets.UTF_8)
            entries.add(
                ZipEntryMeta(
                    name = name,
                    method = method,
                    crc32 = crc,
                    compSize = compSize,
                    uncompSize = uncompSize,
                    localHeaderOffset = localOffset,
                )
            )
            off += 46 + nameLen + extraLen + commentLen
        }
        return entries
    }

    fun parseZipCentralDirectory(
        totalSize: Long,
        fetchRange: (Long, Long) -> ByteArray,
    ): List<ZipEntryMeta> {
        if (totalSize < 22L) return emptyList()
        val tailStart = maxOf(0L, totalSize - 131_072L)
        val tail = fetchRange(tailStart, totalSize - 1L)
        val eocdPos = findEocdOffset(tail)
        if (eocdPos < 0) return emptyList()
        val cdSize = u32(tail, eocdPos + 12)
        val cdOffset = u32(tail, eocdPos + 16)
        if (cdSize <= 0L || cdSize > 8L * 1024L * 1024L || cdOffset < 0L || cdOffset + cdSize > totalSize) {
            return emptyList()
        }
        val cdBytes = if (cdOffset >= tailStart && (cdOffset - tailStart) + cdSize <= tail.size) {
            val rel = (cdOffset - tailStart).toInt()
            tail.copyOfRange(rel, rel + cdSize.toInt())
        } else {
            fetchRange(cdOffset, cdOffset + cdSize - 1L)
        }
        return parseCentralDirectory(cdBytes)
    }

    fun indexLocalApk(localApk: File): Map<ZipEntryKey, LocalApkSpan> {
        if (!localApk.isFile) return emptyMap()
        val total = localApk.length()
        if (total < 22L) return emptyMap()
        val map = HashMap<ZipEntryKey, LocalApkSpan>()
        RandomAccessFile(localApk, "r").use { raf ->
            val entries = parseZipCentralDirectory(total) { start, end ->
                val len = (end - start + 1L).toInt()
                val buf = ByteArray(len)
                raf.seek(start)
                raf.readFully(buf)
                buf
            }
            val header = ByteArray(30)
            for (entry in entries) {
                if (entry.compSize < MIN_REUSE_ENTRY_BYTES) continue
                if (entry.localHeaderOffset < 0L || entry.localHeaderOffset + 30L > total) continue
                raf.seek(entry.localHeaderOffset)
                raf.readFully(header)
                if (u32(header, 0) != 0x04034b50L) continue
                val fnameLen = u16(header, 26)
                val extraLen = u16(header, 28)
                val dataStart = entry.localHeaderOffset + 30L + fnameLen + extraLen
                if (dataStart + entry.compSize > total) continue
                val head32 = ByteArray(32)
                raf.seek(dataStart)
                raf.readFully(head32)
                map[ZipEntryKey(entry.name, entry.method, entry.crc32, entry.compSize, entry.uncompSize)] =
                    LocalApkSpan(dataStart, entry.compSize, head32)
            }
        }
        return map
    }

    fun buildIncrementalPlan(
        apkSize: Long,
        localIndex: Map<ZipEntryKey, LocalApkSpan>,
        remoteEntries: List<ZipEntryMeta>,
        fetchRange: (Long, Long) -> ByteArray,
    ): IncrementalPlan {
        if (apkSize <= 0L) return IncrementalPlan(0L, emptyList(), emptyList(), 0L)
        val matched = ArrayList<ReusedSpan>()
        val candidates = remoteEntries
            .asSequence()
            .filter { it.compSize >= MIN_REUSE_ENTRY_BYTES && it.localHeaderOffset >= 0L }
            .sortedByDescending { it.compSize }
            .take(MAX_HEADER_PROBES)
            .toList()

        for (entry in candidates) {
            val local = localIndex[ZipEntryKey(entry.name, entry.method, entry.crc32, entry.compSize, entry.uncompSize)]
                ?: continue
            val probeEnd = minOf(apkSize - 1L, entry.localHeaderOffset + 511L)
            if (probeEnd - entry.localHeaderOffset + 1L < 30L) continue
            var hdr = fetchRange(entry.localHeaderOffset, probeEnd)
            if (u32(hdr, 0) != 0x04034b50L) continue
            val fnameLen = u16(hdr, 26)
            val extraLen = u16(hdr, 28)
            val relData = 30 + fnameLen + extraLen
            val dataStart = entry.localHeaderOffset + relData.toLong()
            if (dataStart + entry.compSize > apkSize) continue
            if (relData + 32 > hdr.size) {
                val exactEnd = minOf(apkSize - 1L, dataStart + 31L)
                hdr = fetchRange(entry.localHeaderOffset, exactEnd)
                if (relData + 32 > hdr.size) continue
            }
            val remoteHead = hdr.copyOfRange(relData, relData + 32)
            if (!remoteHead.contentEquals(local.head32)) continue
            matched.add(ReusedSpan(dataStart, local.dataOffset, entry.compSize))
        }

        matched.sortBy { it.remoteOffset }
        val nonOverlapping = ArrayList<ReusedSpan>(matched.size)
        var lastEnd = 0L
        for (span in matched) {
            if (span.remoteOffset >= lastEnd) {
                nonOverlapping.add(span)
                lastEnd = span.remoteOffset + span.length
            }
        }

        val downloads = ArrayList<DownloadSpan>()
        var cursor = 0L
        var reusedBytes = 0L
        for (span in nonOverlapping) {
            if (span.remoteOffset > cursor) {
                addChunked(downloads, cursor, span.remoteOffset - cursor)
            }
            reusedBytes += span.length
            cursor = span.remoteOffset + span.length
        }
        if (cursor < apkSize) {
            addChunked(downloads, cursor, apkSize - cursor)
        }
        return IncrementalPlan(apkSize, nonOverlapping, downloads, reusedBytes)
    }

    fun fullDownloadSpans(apkSize: Long): List<DownloadSpan> {
        val list = ArrayList<DownloadSpan>()
        addChunked(list, 0L, apkSize)
        return list
    }

    private fun addChunked(dest: MutableList<DownloadSpan>, start: Long, length: Long) {
        var off = start
        var rem = length
        while (rem > 0L) {
            val part = minOf(rem, ANDROID_UPDATE_CHUNK)
            dest.add(DownloadSpan(off, part, 0L))
            off += part
            rem -= part
        }
    }
}

internal object AndroidUpdater {
    enum class Control { RUNNING, PAUSE, CANCEL }

    private class ControlInterrupted(val reason: Control) : RuntimeException()

    private data class ResolvedRemote(
        val finalUrl: String,
        val apkSize: Long,
        val acceptRanges: Boolean,
    )

    private data class SavedPlan(
        val version: String,
        val apkSize: Long,
        val expectedSha256: String?,
        val reusedBytes: Long,
        val spans: MutableList<DownloadSpan>,
    ) {
        fun totalBytes(): Long = spans.sumOf { it.length }
        fun receivedBytes(): Long = spans.sumOf { it.done }

        fun encode(): String = buildString {
            append(version).append('\t').append(apkSize).append('\t')
                .append(expectedSha256.orEmpty()).append('\t').append(reusedBytes).append('\n')
            for (span in spans) {
                append(span.offset).append(':').append(span.length).append(':').append(span.done).append('\n')
            }
        }

        companion object {
            fun decode(raw: String): SavedPlan? = runCatching {
                val lines = raw.lineSequence().filter { it.isNotEmpty() }.toList()
                if (lines.isEmpty()) return null
                val header = lines[0].split('\t')
                if (header.size < 4) return null
                val version = header[0]
                val apkSize = header[1].toLong()
                val sha = header[2].takeIf { it.length == 64 }
                val reused = header[3].toLong()
                val list = ArrayList<DownloadSpan>(lines.size - 1)
                for (i in 1 until lines.size) {
                    val parts = lines[i].split(':')
                    if (parts.size != 3) return null
                    val offset = parts[0].toLong()
                    val length = parts[1].toLong()
                    val done = parts[2].toLong().coerceIn(0L, length)
                    list.add(DownloadSpan(offset, length, done))
                }
                SavedPlan(version, apkSize, sha, reused, list)
            }.getOrNull()
        }
    }

    private val stateLock = Any()
    private val coordinator = Executors.newSingleThreadExecutor()
    private val controlWorker = Executors.newSingleThreadExecutor()
    private val workerBusy = AtomicBoolean(false)
    private val control = AtomicReference(Control.RUNNING)
    private val activeConnections = ConcurrentHashMap.newKeySet<HttpURLConnection>()

    private var currentVersion: String = "1.0.0"
    private var phase: String = "idle"
    private var availableVersion: String? = null
    private var notes: String? = null
    private var releaseUrl: String? = null
    private var downloadUrl: String? = null
    private var sha256SumsUrl: String? = null
    private var assetName: String? = null
    private var assetSize: Long = 0L
    private var message: String? = null
    private var ignored: Boolean = false
    private var received: Long = 0L
    private var total: Long = 0L
    private var speed: Long = 0L
    private var reused: Long = 0L
    private var apkSize: Long = 0L
    private var awaitingInstallPermission: Boolean = false
    private var pendingInstallVersion: String? = null

    internal fun allowedUrl(url: String): Boolean {
        val parsed = runCatching { URI(url) }.getOrNull() ?: return false
        val host = parsed.host?.lowercase() ?: return false
        val loopback = host == "127.0.0.1" || host == "::1" || host == "[::1]"
        return (parsed.scheme == "https" || (loopback && parsed.scheme == "http")) && parsed.userInfo == null
    }

    private fun updateRoot(cacheDir: File): File = File(cacheDir, "updates")
    private fun persistentRoot(filesDir: File): File = File(filesDir, "updates")
    private fun ignoredFile(filesDir: File): File = File(persistentRoot(filesDir), "ignored.txt")
    private fun versionCache(cacheDir: File, version: String): File = File(updateRoot(cacheDir), version)
    private fun readyApkFile(cacheDir: File, version: String): File =
        File(versionCache(cacheDir, version), "Air-Proxy-$version.apk")
    private fun partialApkFile(cacheDir: File, version: String): File =
        File(versionCache(cacheDir, version), "target.apk.part")
    private fun planFile(cacheDir: File, version: String): File =
        File(versionCache(cacheDir, version), "plan.txt")

    private fun isIgnored(context: Context, version: String?): Boolean {
        if (version.isNullOrBlank()) return false
        val file = ignoredFile(context.filesDir)
        return file.isFile && runCatching { file.readText().trim() == version }.getOrDefault(false)
    }

    private fun snapshotJson(): JSONObject = synchronized(stateLock) {
        JSONObject()
            .put("current", currentVersion)
            .put("phase", phase)
            .put("version", availableVersion ?: JSONObject.NULL)
            .put("notes", notes ?: JSONObject.NULL)
            .put("releaseUrl", releaseUrl ?: JSONObject.NULL)
            .put("url", releaseUrl ?: JSONObject.NULL)
            .put("downloadUrl", downloadUrl ?: JSONObject.NULL)
            .put("assetName", assetName ?: JSONObject.NULL)
            .put("message", message ?: JSONObject.NULL)
            .put("ignored", ignored)
            .put(
                "progress",
                JSONObject()
                    .put("received", received)
                    .put("total", total)
                    .put("speed", speed)
                    .put("reused", reused)
                    .put("apkSize", apkSize)
            )
    }

    fun snapshot(context: Context, current: String): JSONObject {
        synchronized(stateLock) {
            currentVersion = current
            if (availableVersion != null && current == availableVersion) {
                resetReleaseLocked()
                phase = "current"
            } else if (availableVersion != null) {
                ignored = isIgnored(context, availableVersion)
            }
        }
        return snapshotJson()
    }

    private fun resetReleaseLocked() {
        availableVersion = null
        notes = null
        releaseUrl = null
        downloadUrl = null
        sha256SumsUrl = null
        assetName = null
        assetSize = 0L
        message = null
        ignored = false
        received = 0L
        total = 0L
        speed = 0L
        reused = 0L
        apkSize = 0L
        awaitingInstallPermission = false
        pendingInstallVersion = null
    }

    private fun cleanupOtherVersions(cacheDir: File, keepVersion: String?) {
        val root = updateRoot(cacheDir)
        if (!root.isDirectory) return
        root.listFiles()?.forEach { dir ->
            if (dir.isDirectory && dir.name != keepVersion) {
                dir.deleteRecursively()
            }
        }
    }

    fun check(
        context: Context,
        current: String,
        proxyPort: Int,
        emit: (JSONObject) -> Unit,
    ): JSONObject {
        synchronized(stateLock) {
            currentVersion = current
            if (workerBusy.get() || phase == "installing") {
                return snapshotJson()
            }
            phase = "checking"
            message = null
        }
        emit(snapshotJson())

        return try {
            val releases = fetchReleasesJson(current, proxyPort)
            val picked = selectLatestRelease(current, releases)
            if (picked == null) {
                synchronized(stateLock) {
                    resetReleaseLocked()
                    phase = "current"
                }
                cleanupOtherVersions(context.cacheDir, null)
            } else {
                val ver = picked.getString("version")
                cleanupOtherVersions(context.cacheDir, ver)
                val readyFile = readyApkFile(context.cacheDir, ver)
                val savedPlanFile = planFile(context.cacheDir, ver)
                val partFile = partialApkFile(context.cacheDir, ver)
                val savedPlan = if (savedPlanFile.isFile && partFile.isFile) {
                    runCatching { SavedPlan.decode(savedPlanFile.readText()) }.getOrNull()
                } else null
                val verIgnored = isIgnored(context, ver)

                synchronized(stateLock) {
                    availableVersion = ver
                    releaseUrl = picked.optString("releaseUrl").ifBlank { null }
                    downloadUrl = picked.optString("downloadUrl").ifBlank { null }
                    sha256SumsUrl = picked.optString("sha256SumsUrl").ifBlank { null }
                    assetName = picked.optString("assetName").ifBlank { null }
                    assetSize = picked.optLong("assetSize", 0L)
                    notes = picked.optString("notes").ifBlank { null }
                    ignored = verIgnored
                    message = null
                    speed = 0L
                    if (readyFile.isFile && readyFile.length() > 0L && (assetSize == 0L || readyFile.length() == assetSize)) {
                        phase = "ready"
                        apkSize = readyFile.length()
                        total = readyFile.length()
                        received = readyFile.length()
                        reused = 0L
                    } else if (savedPlan != null && savedPlan.version == ver && partFile.length() == savedPlan.apkSize) {
                        phase = "paused"
                        apkSize = savedPlan.apkSize
                        reused = savedPlan.reusedBytes
                        total = savedPlan.totalBytes()
                        received = savedPlan.receivedBytes()
                    } else {
                        phase = "available"
                        apkSize = assetSize
                        total = 0L
                        received = 0L
                        reused = 0L
                    }
                }
            }
            snapshotJson().also(emit)
        } catch (error: Exception) {
            synchronized(stateLock) {
                phase = "interrupted"
                message = error.message ?: "无法检查更新"
                speed = 0L
            }
            snapshotJson().also(emit)
        }
    }

    fun start(
        activity: Activity,
        current: String,
        proxyPort: Int,
        emit: (JSONObject) -> Unit,
    ): JSONObject {
        val url: String
        val version: String
        synchronized(stateLock) {
            currentVersion = current
            version = availableVersion ?: error("没有可更新的版本")
            url = downloadUrl ?: error("当前版本没有可用的 APK 下载地址")
            if (ignored) {
                runCatching { ignoredFile(activity.filesDir).delete() }
                ignored = false
            }
            val readyFile = readyApkFile(activity.cacheDir, version)
            if (readyFile.isFile && readyFile.length() > 0L && (assetSize == 0L || readyFile.length() == assetSize)) {
                phase = "ready"
                apkSize = readyFile.length()
                total = readyFile.length()
                received = readyFile.length()
                speed = 0L
                message = null
                return install(activity, emit)
            }
            if (workerBusy.getAndSet(true)) {
                return snapshotJson()
            }
            control.set(Control.RUNNING)
            phase = "preparing"
            message = null
            speed = 0L
        }
        val initialSnapshot = snapshotJson()
        emit(initialSnapshot)

        val cacheDir = activity.applicationContext.cacheDir
        val activityRef = java.lang.ref.WeakReference(activity)
        val localApkPath = activity.applicationContext.applicationInfo?.sourceDir?.let(::File)

        coordinator.execute {
            try {
                downloadAndVerify(
                    cacheDir = cacheDir,
                    version = version,
                    originUrl = url,
                    sha256SumsUrl = synchronized(stateLock) { sha256SumsUrl },
                    assetName = synchronized(stateLock) { assetName },
                    knownAssetSize = synchronized(stateLock) { assetSize },
                    localApk = localApkPath,
                    proxyPort = proxyPort,
                    onEvent = { emit(snapshotJson()) },
                )
                val readyNow = synchronized(stateLock) { phase == "ready" }
                if (readyNow) {
                    activityRef.get()?.let { act ->
                        if (!act.isDestroyed && !act.isFinishing) {
                            act.runOnUiThread {
                                runCatching { install(act, emit) }
                            }
                        }
                    }
                }
            } finally {
                activeConnections.clear()
                workerBusy.set(false)
            }
        }
        return initialSnapshot
    }

    fun pause(emit: (JSONObject) -> Unit): JSONObject {
        requestPause()
        return snapshotJson().also(emit)
    }

    internal fun requestPause() {
        if (!workerBusy.get()) return
        control.set(Control.PAUSE)
        controlWorker.execute { abortOpenConnections() }
        synchronized(stateLock) {
            if (phase == "preparing" || phase == "downloading") {
                speed = 0L
            }
        }
    }

    fun cancel(context: Context, emit: (JSONObject) -> Unit): JSONObject {
        cancelInDir(context.cacheDir)
        return snapshotJson().also(emit)
    }

    internal fun cancelInDir(cacheDir: File) {
        val hadWorker = workerBusy.get()
        if (hadWorker) {
            control.set(Control.CANCEL)
            controlWorker.execute { abortOpenConnections() }
        }
        val ver = synchronized(stateLock) { availableVersion }
        if (!hadWorker && ver != null) {
            versionCache(cacheDir, ver).deleteRecursively()
        }
        synchronized(stateLock) {
            if (phase == "installing") return
            if (!hadWorker) {
                phase = if (availableVersion != null) "available" else "idle"
                received = 0L
                total = 0L
                speed = 0L
                reused = 0L
                apkSize = assetSize
                message = null
                awaitingInstallPermission = false
                pendingInstallVersion = null
            }
        }
    }

    fun ignore(context: Context, targetVersion: String?, emit: (JSONObject) -> Unit): JSONObject {
        val ver = targetVersion?.takeIf { it.isNotBlank() } ?: synchronized(stateLock) { availableVersion }
            ?: error("没有可忽略的更新")
        val hadWorker = workerBusy.get()
        if (hadWorker) {
            control.set(Control.CANCEL)
            controlWorker.execute { abortOpenConnections() }
        } else {
            versionCache(context.cacheDir, ver).deleteRecursively()
        }
        val file = ignoredFile(context.filesDir)
        file.parentFile?.mkdirs()
        file.writeText(ver, Charsets.UTF_8)
        synchronized(stateLock) {
            if (availableVersion == ver) {
                ignored = true
                phase = "available"
                received = 0L
                total = 0L
                speed = 0L
                reused = 0L
                message = null
                awaitingInstallPermission = false
                pendingInstallVersion = null
            }
        }
        return snapshotJson().also(emit)
    }

    fun install(activity: Activity, emit: (JSONObject) -> Unit): JSONObject {
        val version = synchronized(stateLock) { availableVersion } ?: error("没有可安装的更新")
        val apkFile = readyApkFile(activity.cacheDir, version)
        check(apkFile.isFile && apkFile.length() > 0L) { "安装包尚未准备完成" }

        if (!activity.packageManager.canRequestPackageInstalls()) {
            synchronized(stateLock) {
                awaitingInstallPermission = true
                pendingInstallVersion = version
                phase = "ready"
                message = "请在系统设置中允许安装应用，返回后将自动继续"
            }
            emit(snapshotJson())
            val intent = Intent(
                Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                Uri.parse("package:${activity.packageName}"),
            )
            @Suppress("DEPRECATION")
            activity.startActivityForResult(intent, MainActivity.INSTALL_PERMISSION_REQUEST)
            return snapshotJson()
        }

        val uri = FileProvider.getUriForFile(activity, "${activity.packageName}.updates", apkFile)
        val installIntent = Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(uri, "application/vnd.android.package-archive")
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        activity.startActivity(installIntent)
        synchronized(stateLock) {
            awaitingInstallPermission = false
            pendingInstallVersion = version
            phase = "installing"
            message = null
        }
        return snapshotJson().also(emit)
    }

    fun onActivityResumed(activity: Activity, emit: (JSONObject) -> Unit) {
        val shouldInstall: Boolean
        val resetToReady: Boolean
        synchronized(stateLock) {
            val ver = pendingInstallVersion ?: availableVersion
            val hasApk = ver != null && readyApkFile(activity.cacheDir, ver).isFile
            shouldInstall = awaitingInstallPermission && hasApk && activity.packageManager.canRequestPackageInstalls()
            resetToReady = !shouldInstall && phase == "installing"
            if (resetToReady) {
                phase = if (hasApk) "ready" else "available"
            }
        }
        if (shouldInstall) {
            runCatching { install(activity, emit) }
        } else if (resetToReady) {
            emit(snapshotJson())
        }
    }

    private fun abortOpenConnections() {
        for (conn in activeConnections) {
            runCatching { conn.disconnect() }
        }
        activeConnections.clear()
    }

    internal data class TestOutcome(
        val phase: String,
        val reused: Long,
        val received: Long,
        val total: Long,
        val message: String?,
    )

    internal fun runDownloadForTest(
        cacheDir: File,
        version: String,
        originUrl: String,
        sha256SumsUrl: String?,
        assetName: String?,
        knownAssetSize: Long,
        localApk: File?,
        proxyPort: Int,
        onEvent: ((String) -> Unit)? = null,
    ): TestOutcome {
        synchronized(stateLock) {
            currentVersion = "1.0.0"
            availableVersion = version
            downloadUrl = originUrl
            this.sha256SumsUrl = sha256SumsUrl
            this.assetName = assetName
            assetSize = knownAssetSize
            phase = "preparing"
            message = null
        }
        control.set(Control.RUNNING)
        workerBusy.set(true)
        return try {
            downloadAndVerify(
                cacheDir = cacheDir,
                version = version,
                originUrl = originUrl,
                sha256SumsUrl = sha256SumsUrl,
                assetName = assetName,
                knownAssetSize = knownAssetSize,
                localApk = localApk,
                proxyPort = proxyPort,
                onEvent = { onEvent?.invoke(synchronized(stateLock) { phase }) },
            )
            synchronized(stateLock) {
                TestOutcome(phase, reused, received, total, message)
            }
        } finally {
            activeConnections.clear()
            workerBusy.set(false)
        }
    }

    private fun downloadAndVerify(
        cacheDir: File,
        version: String,
        originUrl: String,
        sha256SumsUrl: String?,
        assetName: String?,
        knownAssetSize: Long,
        localApk: File?,
        proxyPort: Int,
        onEvent: () -> Unit,
    ) {
        val dir = versionCache(cacheDir, version).apply { mkdirs() }
        val partFile = partialApkFile(cacheDir, version)
        val savedPlanFile = planFile(cacheDir, version)
        val readyFile = readyApkFile(cacheDir, version)
        var forceFullApk = false

        for (cycle in 0..1) {
            try {
                checkControl()
                val expectedSha = if (!sha256SumsUrl.isNullOrBlank() && !assetName.isNullOrBlank()) {
                    runCatching {
                        val raw = fetchSmallText(sha256SumsUrl, proxyPort, 256 * 1024)
                        ZipIncrementalPlanner.parseSha256Sums(raw)[assetName]
                    }.getOrNull()
                } else null

                var usingProxy = proxyPort > 0
                fun activeProxy() = if (usingProxy && proxyPort > 0) {
                    Proxy(Proxy.Type.HTTP, InetSocketAddress("127.0.0.1", proxyPort))
                } else null

                var resolved = runCatching { resolveRemote(originUrl, knownAssetSize, activeProxy()) }
                    .getOrElse { err ->
                        if (err is ControlInterrupted) throw err
                        if (usingProxy) {
                            usingProxy = false
                            resolveRemote(originUrl, knownAssetSize, null)
                        } else throw err
                    }

                val existingPlan = if (!forceFullApk && savedPlanFile.isFile && partFile.isFile) {
                    SavedPlan.decode(savedPlanFile.readText())?.takeIf {
                        it.version == version && it.apkSize == resolved.apkSize && partFile.length() == it.apkSize
                    }
                } else null

                val plan = if (existingPlan != null) {
                    existingPlan
                } else {
                    val newPlan = buildPlanAndMaterializeReuse(
                        version = version,
                        resolved = resolved,
                        expectedSha256 = expectedSha,
                        localApk = if (forceFullApk) null else localApk,
                        partFile = partFile,
                        proxy = activeProxy(),
                    )
                    savePlanAtomic(savedPlanFile, newPlan)
                    newPlan
                }

                val totalBytes = plan.totalBytes()
                val alreadyReceived = AtomicLong(plan.receivedBytes())
                synchronized(stateLock) {
                    phase = "downloading"
                    apkSize = plan.apkSize
                    reused = plan.reusedBytes
                    total = totalBytes
                    received = alreadyReceived.get()
                    speed = 0L
                    message = null
                }
                onEvent()

                val tracker = Any()
                var lastEmitAt = System.currentTimeMillis()
                var lastEmitBytes = alreadyReceived.get()

                fun onBytes(delta: Long) {
                    val cur = alreadyReceived.addAndGet(delta)
                    val now = System.currentTimeMillis()
                    synchronized(tracker) {
                        val elapsed = now - lastEmitAt
                        if (elapsed >= 150L || cur >= totalBytes) {
                            val d = (cur - lastEmitBytes).coerceAtLeast(0L)
                            val bps = if (elapsed > 0) d * 1000L / elapsed else 0L
                            lastEmitAt = now
                            lastEmitBytes = cur
                            synchronized(stateLock) {
                                received = cur
                                total = totalBytes
                                speed = bps
                            }
                            onEvent()
                        }
                    }
                }

                var downloadErr: Exception? = null
                for (attempt in 0..2) {
                    checkControl()
                    if (attempt > 0) {
                        resolved = runCatching { resolveRemote(originUrl, knownAssetSize, activeProxy()) }
                            .getOrElse { if (usingProxy) { usingProxy = false; resolveRemote(originUrl, knownAssetSize, null) } else resolved }
                    }
                    val pending = plan.spans.filter { it.done < it.length }
                    if (pending.isEmpty()) {
                        downloadErr = null
                        break
                    }
                    val err = executeConcurrentSpans(
                        finalUrl = resolved.finalUrl,
                        apkSize = plan.apkSize,
                        acceptRanges = resolved.acceptRanges,
                        spans = pending,
                        partFile = partFile,
                        savedPlanFile = savedPlanFile,
                        plan = plan,
                        proxy = activeProxy(),
                        onBytes = ::onBytes,
                    )
                    if (err == null) {
                        downloadErr = null
                        break
                    }
                    if (err is ControlInterrupted) throw err
                    downloadErr = err
                    if (usingProxy) usingProxy = false
                }
                if (downloadErr != null) throw downloadErr

                // All spans downloaded — verify SHA-256
                if (expectedSha != null) {
                    val actualSha = sha256File(partFile)
                    if (actualSha != expectedSha) {
                        savedPlanFile.delete()
                        partFile.delete()
                        if (!forceFullApk && plan.reusedBytes > 0L) {
                            forceFullApk = true
                            continue
                        }
                        error("安装包 SHA-256 校验失败，请重试")
                    }
                }

                checkControl()
                if (readyFile.exists()) readyFile.delete()
                check(partFile.renameTo(readyFile)) { "无法保存已下载的安装包" }
                savedPlanFile.delete()
                synchronized(stateLock) {
                    phase = "ready"
                    received = totalBytes
                    total = totalBytes
                    apkSize = readyFile.length()
                    speed = 0L
                    message = null
                }
                onEvent()
                return
            } catch (stopped: ControlInterrupted) {
                if (stopped.reason == Control.PAUSE) {
                    synchronized(stateLock) {
                        phase = "paused"
                        speed = 0L
                        message = null
                    }
                    onEvent()
                } else {
                    dir.deleteRecursively()
                    synchronized(stateLock) {
                        phase = "available"
                        received = 0L
                        total = 0L
                        speed = 0L
                        reused = 0L
                        apkSize = knownAssetSize
                        message = null
                    }
                    onEvent()
                }
                return
            } catch (error: Exception) {
                synchronized(stateLock) {
                    phase = "interrupted"
                    speed = 0L
                    message = error.message ?: "更新下载失败"
                }
                onEvent()
                return
            }
        }
    }

    private fun checkControl() {
        when (control.get()) {
            Control.RUNNING -> {}
            Control.PAUSE -> throw ControlInterrupted(Control.PAUSE)
            Control.CANCEL -> throw ControlInterrupted(Control.CANCEL)
        }
    }

    private fun openHttp(url: String, proxy: Proxy?, timeoutMs: Int = 15_000): HttpURLConnection {
        require(allowedUrl(url)) { "无效的更新下载地址" }
        return ((proxy?.let { URL(url).openConnection(it) } ?: URL(url).openConnection()) as HttpURLConnection).apply {
            instanceFollowRedirects = false
            connectTimeout = timeoutMs
            readTimeout = timeoutMs
            setRequestProperty("User-Agent", "Air-Proxy-Android/$currentVersion")
        }
    }

    private fun resolveRemote(originUrl: String, knownAssetSize: Long, proxy: Proxy?): ResolvedRemote {
        var current = originUrl
        repeat(6) {
            checkControl()
            val conn = openHttp(current, proxy)
            activeConnections.add(conn)
            try {
                conn.setRequestProperty("Range", "bytes=0-0")
                conn.setRequestProperty("Accept-Encoding", "identity")
                val code = conn.responseCode
                when (code) {
                    301, 302, 303, 307, 308 -> {
                        val location = conn.getHeaderField("Location") ?: error("更新重定向缺少目标地址")
                        val next = URI(current).resolve(location).toString()
                        require(allowedUrl(next)) { "无效的更新重定向地址" }
                        require(!(current.startsWith("https://", true) && next.startsWith("http://", true))) {
                            "拒绝非加密更新跳转"
                        }
                        current = next
                    }
                    206 -> {
                        val contentRange = conn.getHeaderField("Content-Range").orEmpty()
                        val totalLen = contentRange.substringAfterLast('/', "").toLongOrNull() ?: knownAssetSize
                        check(totalLen > 0L) { "无法获取安装包大小" }
                        return ResolvedRemote(current, totalLen, acceptRanges = true)
                    }
                    200 -> {
                        val len = conn.contentLengthLong.takeIf { it > 0L } ?: knownAssetSize
                        check(len > 0L) { "无法获取安装包大小" }
                        return ResolvedRemote(current, len, acceptRanges = false)
                    }
                    else -> error("更新服务器返回 HTTP $code")
                }
            } finally {
                activeConnections.remove(conn)
                runCatching { conn.disconnect() }
            }
        }
        error("更新重定向次数过多")
    }

    private fun buildPlanAndMaterializeReuse(
        version: String,
        resolved: ResolvedRemote,
        expectedSha256: String?,
        localApk: File?,
        partFile: File,
        proxy: Proxy?,
    ): SavedPlan {
        val incremental = if (resolved.acceptRanges && localApk != null && localApk.isFile) {
            runCatching {
                val localIndex = ZipIncrementalPlanner.indexLocalApk(localApk)
                if (localIndex.isEmpty()) null else {
                    val fetchRange = { start: Long, end: Long ->
                        fetchExactRange(resolved.finalUrl, start, end, proxy)
                    }
                    val remoteEntries = ZipIncrementalPlanner.parseZipCentralDirectory(resolved.apkSize, fetchRange)
                    if (remoteEntries.isEmpty()) null else {
                        ZipIncrementalPlanner.buildIncrementalPlan(resolved.apkSize, localIndex, remoteEntries, fetchRange)
                    }
                }
            }.getOrNull()
        } else null

        RandomAccessFile(partFile, "rw").use { raf ->
            raf.setLength(resolved.apkSize)
            if (incremental != null && incremental.reused.isNotEmpty() && localApk != null) {
                RandomAccessFile(localApk, "r").use { src ->
                    val buf = ByteArray(64 * 1024)
                    for (span in incremental.reused) {
                        checkControl()
                        src.seek(span.localOffset)
                        raf.seek(span.remoteOffset)
                        var rem = span.length
                        while (rem > 0L) {
                            val take = minOf(rem, buf.size.toLong()).toInt()
                            src.readFully(buf, 0, take)
                            raf.write(buf, 0, take)
                            rem -= take.toLong()
                        }
                    }
                }
                return SavedPlan(
                    version = version,
                    apkSize = resolved.apkSize,
                    expectedSha256 = expectedSha256,
                    reusedBytes = incremental.reusedBytes,
                    spans = incremental.download.toMutableList(),
                )
            }
        }

        val spans = if (resolved.acceptRanges) {
            ZipIncrementalPlanner.fullDownloadSpans(resolved.apkSize).toMutableList()
        } else {
            mutableListOf(DownloadSpan(0L, resolved.apkSize, 0L))
        }
        return SavedPlan(version, resolved.apkSize, expectedSha256, 0L, spans)
    }

    private fun fetchExactRange(url: String, start: Long, end: Long, proxy: Proxy?): ByteArray {
        checkControl()
        val conn = openHttp(url, proxy)
        activeConnections.add(conn)
        return try {
            conn.setRequestProperty("Range", "bytes=$start-$end")
            conn.setRequestProperty("Accept-Encoding", "identity")
            val code = conn.responseCode
            check(code == 206) { "Range HTTP $code" }
            val expectedLen = (end - start + 1L).toInt()
            val out = ByteArrayOutputStream(expectedLen)
            val buf = ByteArray(8192)
            conn.inputStream.use { input ->
                while (out.size() < expectedLen) {
                    checkControl()
                    val n = input.read(buf, 0, minOf(buf.size, expectedLen - out.size()))
                    if (n < 0) break
                    out.write(buf, 0, n)
                }
            }
            check(out.size() == expectedLen) { "Range 返回长度不足" }
            out.toByteArray()
        } finally {
            activeConnections.remove(conn)
            runCatching { conn.disconnect() }
        }
    }

    private fun executeConcurrentSpans(
        finalUrl: String,
        apkSize: Long,
        acceptRanges: Boolean,
        spans: List<DownloadSpan>,
        partFile: File,
        savedPlanFile: File,
        plan: SavedPlan,
        proxy: Proxy?,
        onBytes: (Long) -> Unit,
    ): Exception? {
        if (!acceptRanges || spans.size == 1) {
            return runCatching {
                fetchSpanIntoFile(finalUrl, apkSize, acceptRanges, spans[0], partFile, proxy, onBytes)
                savePlanAtomic(savedPlanFile, plan)
            }.exceptionOrNull() as? Exception
        }

        val pool = Executors.newFixedThreadPool(4)
        val firstError = AtomicReference<Exception?>(null)
        val planPersistLock = Any()
        val futures = ArrayList<Future<*>>(spans.size)
        try {
            for (span in spans) {
                futures.add(pool.submit {
                    if (firstError.get() != null) return@submit
                    try {
                        checkControl()
                        fetchSpanIntoFile(finalUrl, apkSize, true, span, partFile, proxy, onBytes)
                        synchronized(planPersistLock) {
                            savePlanAtomic(savedPlanFile, plan)
                        }
                    } catch (e: ControlInterrupted) {
                        firstError.compareAndSet(null, e)
                        abortOpenConnections()
                    } catch (e: Exception) {
                        firstError.compareAndSet(null, e)
                    }
                })
            }
            for (f in futures) {
                runCatching { f.get() }
            }
        } finally {
            synchronized(planPersistLock) {
                runCatching { savePlanAtomic(savedPlanFile, plan) }
            }
            pool.shutdownNow()
        }
        return firstError.get()
    }

    private fun fetchSpanIntoFile(
        finalUrl: String,
        apkSize: Long,
        acceptRanges: Boolean,
        span: DownloadSpan,
        partFile: File,
        proxy: Proxy?,
        onBytes: (Long) -> Unit,
    ) {
        checkControl()
        if (span.done >= span.length) return
        val start = span.offset + span.done
        val end = span.offset + span.length - 1L
        val conn = openHttp(finalUrl, proxy, timeoutMs = 25_000)
        activeConnections.add(conn)
        try {
            conn.setRequestProperty("Accept-Encoding", "identity")
            if (acceptRanges) {
                conn.setRequestProperty("Range", "bytes=$start-$end")
            }
            val code = conn.responseCode
            val writeOffset: Long
            if (acceptRanges) {
                check(code == 206) { "下载服务器返回 HTTP $code" }
                val expectedRange = "bytes $start-$end/$apkSize"
                val actualRange = conn.getHeaderField("Content-Range")
                check(actualRange == expectedRange) { "下载范围不匹配" }
                writeOffset = start
            } else {
                check(code == 200) { "下载服务器返回 HTTP $code" }
                span.done = 0L
                writeOffset = 0L
            }

            RandomAccessFile(partFile, "rw").use { raf ->
                raf.seek(writeOffset)
                val buf = ByteArray(16 * 1024)
                var remaining = if (acceptRanges) end - start + 1L else apkSize
                conn.inputStream.use { input ->
                    while (remaining > 0L) {
                        checkControl()
                        val toRead = minOf(buf.size.toLong(), remaining).toInt()
                        val read = input.read(buf, 0, toRead)
                        if (read < 0) break
                        raf.write(buf, 0, read)
                        span.done += read.toLong()
                        remaining -= read.toLong()
                        onBytes(read.toLong())
                    }
                }
                check(remaining == 0L) { "下载连接提前中断，已保留进度" }
            }
        } finally {
            activeConnections.remove(conn)
            runCatching { conn.disconnect() }
        }
    }

    private fun savePlanAtomic(planFile: File, plan: SavedPlan) {
        val text = plan.encode()
        val temp = File(planFile.parentFile, "${planFile.name}.tmp")
        temp.writeText(text, Charsets.UTF_8)
        if (!temp.renameTo(planFile)) {
            planFile.writeText(text, Charsets.UTF_8)
            temp.delete()
        }
    }

    private fun sha256File(file: File): String {
        val digest = MessageDigest.getInstance("SHA-256")
        val buf = ByteArray(64 * 1024)
        file.inputStream().use { input ->
            while (true) {
                val n = input.read(buf)
                if (n < 0) break
                digest.update(buf, 0, n)
            }
        }
        return digest.digest().joinToString("") { "%02x".format(it) }
    }

    private fun fetchSmallText(url: String, proxyPort: Int, maxBytes: Int): String {
        var current = url
        repeat(6) {
            val proxy = if (proxyPort > 0) Proxy(Proxy.Type.HTTP, InetSocketAddress("127.0.0.1", proxyPort)) else null
            val conn = openHttp(current, proxy, timeoutMs = 10_000)
            try {
                when (val code = conn.responseCode) {
                    301, 302, 303, 307, 308 -> {
                        val loc = conn.getHeaderField("Location") ?: error("重定向缺少目标")
                        val next = URI(current).resolve(loc).toString()
                        require(allowedUrl(next)) { "无效的重定向链接" }
                        current = next
                    }
                    200 -> {
                        val out = ByteArrayOutputStream()
                        val buf = ByteArray(4096)
                        conn.inputStream.use { input ->
                            while (true) {
                                val n = input.read(buf)
                                if (n < 0) break
                                require(out.size() + n <= maxBytes) { "校验文件过大" }
                                out.write(buf, 0, n)
                            }
                        }
                        return out.toString(Charsets.UTF_8.name())
                    }
                    else -> error("HTTP $code")
                }
            } finally {
                runCatching { conn.disconnect() }
            }
        }
        error("重定向次数过多")
    }

    private fun fetchReleasesJson(current: String, proxyPort: Int): JSONArray {
        val api = URI("https://api.github.com/repos/$GITHUB_REPOSITORY/releases?per_page=20")
        fun fetch(proxy: Proxy?): JSONArray {
            val connection = (proxy?.let { api.toURL().openConnection(it) } ?: api.toURL().openConnection()) as HttpURLConnection
            connection.connectTimeout = 8500
            connection.readTimeout = 8500
            connection.setRequestProperty("User-Agent", "Air-Proxy-Android/$current")
            connection.setRequestProperty("Accept", "application/vnd.github+json")
            return try {
                check(connection.responseCode == 200) { "无法检查 GitHub 版本 · HTTP ${connection.responseCode}" }
                val out = ByteArrayOutputStream()
                val buf = ByteArray(8192)
                connection.inputStream.use { input ->
                    while (true) {
                        val n = input.read(buf)
                        if (n < 0) break
                        require(out.size() + n <= 2 * 1024 * 1024) { "版本清单超过大小限制" }
                        out.write(buf, 0, n)
                    }
                }
                JSONArray(out.toString(Charsets.UTF_8.name()))
            } finally {
                connection.disconnect()
            }
        }
        return if (proxyPort > 0) {
            runCatching { fetch(Proxy(Proxy.Type.HTTP, InetSocketAddress("127.0.0.1", proxyPort))) }
                .getOrElse { fetch(null) }
        } else {
            fetch(null)
        }
    }

    private fun selectLatestRelease(current: String, releases: JSONArray): JSONObject? {
        val versionRegex = Regex("""^v?(\d+)\.(\d+)\.(\d+)$""")
        fun parseVer(value: String): List<Int>? =
            versionRegex.matchEntire(value)?.groupValues?.drop(1)?.map { it.toIntOrNull() ?: return null }
        fun isNewer(left: List<Int>, right: List<Int>): Boolean {
            val diff = left.indices.firstOrNull { left[it] != right[it] } ?: return false
            return left[diff] > right[diff]
        }

        var latest = parseVer(current) ?: listOf(0, 0, 0)
        var chosen: JSONObject? = null
        val preferredAbis = android.os.Build.SUPPORTED_ABIS ?: emptyArray()
        val preferredAbi = preferredAbis.firstOrNull { it == "arm64-v8a" || it == "armeabi-v7a" || it == "x86_64" }

        for (index in 0 until releases.length()) {
            val release = releases.getJSONObject(index)
            if (release.optBoolean("draft") || release.optBoolean("prerelease")) continue
            val tag = release.optString("tag_name")
            val candidate = parseVer(tag) ?: continue
            if (!isNewer(candidate, latest)) continue
            val page = release.optString("html_url")
            if (!page.startsWith(RELEASE_PAGE_PREFIX)) continue
            val assets = release.optJSONArray("assets") ?: continue
            val downloadPrefix = "${RELEASE_PAGE_PREFIX}download/"
            val allAssets = (0 until assets.length()).map { assets.getJSONObject(it) }
            val validApks = allAssets.filter {
                it.optString("name").endsWith(".apk", true) &&
                    it.optString("browser_download_url").startsWith(downloadPrefix)
            }
            if (validApks.isEmpty()) continue
            val bestApk = (preferredAbi?.let { abi ->
                validApks.firstOrNull { it.optString("name").contains(abi, ignoreCase = true) }
            } ?: validApks.firstOrNull {
                it.optString("name").contains("universal", ignoreCase = true)
            } ?: validApks.firstOrNull()) ?: continue

            val sumsAsset = allAssets.firstOrNull {
                it.optString("name").equals("SHA256SUMS.txt", true) &&
                    it.optString("browser_download_url").startsWith(downloadPrefix)
            }

            latest = candidate
            chosen = JSONObject()
                .put("version", tag.removePrefix("v"))
                .put("releaseUrl", page)
                .put("downloadUrl", bestApk.optString("browser_download_url"))
                .put("assetName", bestApk.optString("name"))
                .put("assetSize", bestApk.optLong("size", 0L))
                .put("notes", release.optString("body").trim().take(16_000))
            if (sumsAsset != null) {
                chosen.put("sha256SumsUrl", sumsAsset.optString("browser_download_url"))
            }
        }
        return chosen
    }
}
