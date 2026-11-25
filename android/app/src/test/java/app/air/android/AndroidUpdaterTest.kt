package app.air.android

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.Closeable
import java.io.File
import java.net.InetAddress
import java.net.ServerSocket
import java.security.MessageDigest
import java.util.Random
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream

class AndroidUpdaterTest {
    private fun createMockApk(file: File, payloadSo: ByteArray, appJs: ByteArray) {
        ZipOutputStream(file.outputStream().buffered()).use { zos ->
            zos.putNextEntry(ZipEntry("lib/arm64-v8a/libclash.so"))
            zos.write(payloadSo)
            zos.closeEntry()

            zos.putNextEntry(ZipEntry("assets/web/app.js"))
            zos.write(appJs)
            zos.closeEntry()

            zos.putNextEntry(ZipEntry("classes.dex"))
            zos.write(ByteArray(4096) { (it * 31).toByte() })
            zos.closeEntry()
        }
    }

    private fun sha256(bytes: ByteArray): String =
        MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }

    private class LocalRangeServer(
        private val apkBytes: ByteArray,
        sumsText: String,
        private val pauseAtBytes: Long = Long.MAX_VALUE,
        private val pauseArmed: AtomicBoolean = AtomicBoolean(false),
        private val onPauseTrigger: (() -> Unit)? = null,
    ) : Closeable {
        private val server = ServerSocket(0, 16, InetAddress.getByName("127.0.0.1"))
        private val pool = Executors.newCachedThreadPool()
        private val triggered = AtomicBoolean(false)
        @Volatile private var running = true
        private val sumsBytes = sumsText.toByteArray(Charsets.UTF_8)

        val port: Int get() = server.localPort

        init {
            Thread {
                while (running) {
                    val socket = runCatching { server.accept() }.getOrNull() ?: break
                    pool.execute {
                        socket.use { sock ->
                            val reader = sock.getInputStream().bufferedReader(Charsets.US_ASCII)
                            val requestLine = reader.readLine() ?: return@use
                            val path = requestLine.split(' ').getOrNull(1) ?: "/"
                            var rangeHeader: String? = null
                            while (true) {
                                val line = reader.readLine() ?: break
                                if (line.isEmpty()) break
                                if (line.startsWith("Range:", ignoreCase = true)) {
                                    rangeHeader = line.substringAfter(':').trim()
                                }
                            }
                            val out = sock.getOutputStream()
                            if (path == "/SHA256SUMS.txt") {
                                val head = "HTTP/1.1 200 OK\r\nContent-Length: ${sumsBytes.size}\r\nConnection: close\r\n\r\n"
                                out.write(head.toByteArray(Charsets.US_ASCII))
                                out.write(sumsBytes)
                                out.flush()
                                return@use
                            }
                            if (rangeHeader != null && rangeHeader.startsWith("bytes=")) {
                                val (s, e) = rangeHeader.removePrefix("bytes=").split('-')
                                val start = s.toInt()
                                val end = e.toInt()
                                val slice = apkBytes.copyOfRange(start, end + 1)
                                val head = "HTTP/1.1 206 Partial Content\r\nContent-Range: bytes $start-$end/${apkBytes.size}\r\nContent-Length: ${slice.size}\r\nConnection: close\r\n\r\n"
                                out.write(head.toByteArray(Charsets.US_ASCII))
                                var off = 0
                                while (off < slice.size && running) {
                                    val step = minOf(4096, slice.size - off)
                                    out.write(slice, off, step)
                                    out.flush()
                                    off += step
                                    if (pauseArmed.get() && off >= pauseAtBytes && triggered.compareAndSet(false, true)) {
                                        onPauseTrigger?.invoke()
                                        Thread.sleep(250)
                                        break
                                    }
                                }
                            } else {
                                val head = "HTTP/1.1 200 OK\r\nContent-Length: ${apkBytes.size}\r\nConnection: close\r\n\r\n"
                                out.write(head.toByteArray(Charsets.US_ASCII))
                                out.write(apkBytes)
                                out.flush()
                            }
                        }
                    }
                }
            }.apply { isDaemon = true; start() }
        }

        override fun close() {
            running = false
            runCatching { server.close() }
            pool.shutdownNow()
        }
    }

    @Test
    fun parsesSha256SumsAndBuildsExactZipIncrementalPlan() {
        val sums = """
            abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789  Air-Proxy-1.1.3-android-arm64-v8a.apk
            0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef  air-windows-x64.json
        """.trimIndent()
        val parsed = ZipIncrementalPlanner.parseSha256Sums(sums)
        assertEquals(
            "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
            parsed["Air-Proxy-1.1.3-android-arm64-v8a.apk"],
        )

        val dir = kotlin.io.path.createTempDirectory("air-zip-plan").toFile()
        try {
            val sharedSo = ByteArray(140_000).also { Random(42L).nextBytes(it) }
            val oldApk = File(dir, "old.apk")
            val newApk = File(dir, "new.apk")
            createMockApk(oldApk, sharedSo, "console.log('old');".repeat(400).toByteArray())
            createMockApk(newApk, sharedSo, "console.log('new_version_v1.1.3');".repeat(450).toByteArray())

            val newBytes = newApk.readBytes()
            val localIndex = ZipIncrementalPlanner.indexLocalApk(oldApk)
            val fetchRange = { start: Long, end: Long ->
                newBytes.copyOfRange(start.toInt(), end.toInt() + 1)
            }
            val remoteCd = ZipIncrementalPlanner.parseZipCentralDirectory(newBytes.size.toLong(), fetchRange)
            val plan = ZipIncrementalPlanner.buildIncrementalPlan(
                apkSize = newBytes.size.toLong(),
                localIndex = localIndex,
                remoteEntries = remoteCd,
                fetchRange = fetchRange,
            )

            assertTrue("Expected shared .so entry to be reused", plan.reusedBytes >= 130_000L)
            assertTrue("Expected net download smaller than full APK", plan.download.sumOf { it.length } < newBytes.size / 4)

            val rebuilt = ByteArray(newBytes.size)
            oldApk.inputStream().use { src ->
                val rawOld = src.readBytes()
                for (span in plan.reused) {
                    System.arraycopy(rawOld, span.localOffset.toInt(), rebuilt, span.remoteOffset.toInt(), span.length.toInt())
                }
            }
            for (span in plan.download) {
                System.arraycopy(newBytes, span.offset.toInt(), rebuilt, span.offset.toInt(), span.length.toInt())
            }
            assertArrayEquals(newBytes, rebuilt)
        } finally {
            dir.deleteRecursively()
        }
    }

    @Test
    fun incrementalDownloadSupportsPauseResumeCancelAndCorruptFallback() {
        val dir = kotlin.io.path.createTempDirectory("air-updater-http").toFile()
        try {
            val sharedSo = ByteArray(160_000).also { Random(99L).nextBytes(it) }
            val oldApk = File(dir, "old.apk")
            val newApk = File(dir, "new.apk")
            createMockApk(oldApk, sharedSo, "old_bundle".repeat(500).toByteArray())
            val newBundle = ByteArray(24_000).also { Random(77L).nextBytes(it) }
            createMockApk(newApk, sharedSo, newBundle)
            val newBytes = newApk.readBytes()
            val newSha = sha256(newBytes)
            val sums = "$newSha  Air-Proxy-1.1.3-android-arm64-v8a.apk\n"
            val cacheDir = File(dir, "cache").apply { mkdirs() }
            val events = mutableListOf<String>()

            // 1) Pause mid-download and then resume to completion
            val pauseLatch = CountDownLatch(1)
            val pauseArmed = AtomicBoolean(false)
            LocalRangeServer(newBytes, sums, pauseAtBytes = 1024L, pauseArmed = pauseArmed) {
                AndroidUpdater.requestPause()
                pauseLatch.countDown()
            }.use { server ->
                val base = "http://127.0.0.1:${server.port}"
                val pausedState = AndroidUpdater.runDownloadForTest(
                    cacheDir = cacheDir,
                    version = "1.1.3",
                    originUrl = "$base/app.apk",
                    sha256SumsUrl = "$base/SHA256SUMS.txt",
                    assetName = "Air-Proxy-1.1.3-android-arm64-v8a.apk",
                    knownAssetSize = newBytes.size.toLong(),
                    localApk = oldApk,
                    proxyPort = 0,
                ) { phase ->
                    events.add(phase)
                    if (phase == "downloading") pauseArmed.set(true)
                }
                assertTrue(pauseLatch.await(5, TimeUnit.SECONDS))
                assertEquals("paused", pausedState.phase)
                assertTrue(pausedState.reused >= 150_000L)
            }

            // Resume against clean server without delay
            LocalRangeServer(newBytes, sums).use { server ->
                val base = "http://127.0.0.1:${server.port}"
                val readyState = AndroidUpdater.runDownloadForTest(
                    cacheDir = cacheDir,
                    version = "1.1.3",
                    originUrl = "$base/app.apk",
                    sha256SumsUrl = "$base/SHA256SUMS.txt",
                    assetName = "Air-Proxy-1.1.3-android-arm64-v8a.apk",
                    knownAssetSize = newBytes.size.toLong(),
                    localApk = oldApk,
                    proxyPort = 0,
                ) { events.add(it) }
                assertEquals("ready", readyState.phase)
                val finalApk = File(cacheDir, "updates/1.1.3/Air-Proxy-1.1.3.apk")
                assertTrue(finalApk.isFile)
                assertEquals(newSha, sha256(finalApk.readBytes()))

                // Cancel cleans up directory
                AndroidUpdater.cancelInDir(cacheDir)
                assertTrue(!finalApk.exists())
            }

            // 2) Corrupted incremental reuse automatically falls back to full APK download and succeeds
            val spoofedOldApk = File(dir, "spoofed-old.apk")
            spoofedOldApk.writeBytes(oldApk.readBytes().let { bytes ->
                val idx = bytes.size / 4
                bytes.copyOf().also { it[idx] = (it[idx].toInt() xor 0xFF).toByte() }
            })
            LocalRangeServer(newBytes, sums).use { server ->
                val base = "http://127.0.0.1:${server.port}"
                val fallbackState = AndroidUpdater.runDownloadForTest(
                    cacheDir = cacheDir,
                    version = "1.1.3",
                    originUrl = "$base/app.apk",
                    sha256SumsUrl = "$base/SHA256SUMS.txt",
                    assetName = "Air-Proxy-1.1.3-android-arm64-v8a.apk",
                    knownAssetSize = newBytes.size.toLong(),
                    localApk = spoofedOldApk,
                    proxyPort = 0,
                )
                assertEquals("ready", fallbackState.phase)
                assertEquals(0L, fallbackState.reused)
                val finalApk = File(cacheDir, "updates/1.1.3/Air-Proxy-1.1.3.apk")
                assertEquals(newSha, sha256(finalApk.readBytes()))
            }
        } finally {
            dir.deleteRecursively()
        }
    }
}
