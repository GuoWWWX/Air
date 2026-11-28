import groovy.json.JsonSlurper
import java.net.URI
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.security.MessageDigest

plugins {
    id("com.android.application") version "8.13.2"
    id("org.jetbrains.kotlin.android") version "2.2.21"
}

fun download(url: String, destination: File) {
    val connection = URI(url).toURL().openConnection().apply {
        connectTimeout = 20_000
        readTimeout = 45_000
    }
    connection.getInputStream().use { input ->
        destination.outputStream().use { output -> input.copyTo(output) }
    }
}

fun sha256(file: File): String = MessageDigest.getInstance("SHA-256").digest(file.readBytes())
    .joinToString("") { "%02x".format(it) }

val coreVersion = "v0.3.14"
val coreArchive = "libmihomo-android-$coreVersion.aar"
val coreDigest = "7c3a68a4ef9afcb5018e167dc70fba7485652d0a0e29ba006703cf00fed9e230"
val coreOverride = providers.environmentVariable("AIR_ANDROID_CORE")
val coreAar = layout.buildDirectory.file("dependencies/$coreArchive")
val prepareCore by tasks.registering {
    inputs.property("sha256", coreDigest)
    inputs.property("sourceFile", coreOverride.orElse(""))
    outputs.file(coreAar)
    doLast {
        val output = coreAar.get().asFile
        output.parentFile.mkdirs()
        val partial = output.resolveSibling("$coreArchive.partial")
        try {
            val supplied = coreOverride.orNull?.let(::file)
            if (supplied != null) {
                supplied.copyTo(partial, overwrite = true)
            } else {
                download("https://github.com/oviron/libmihomo-android/releases/download/$coreVersion/$coreArchive", partial)
            }
            check(sha256(partial) == coreDigest) { "Mihomo Android archive SHA-256 mismatch" }
            partial.copyTo(output, overwrite = true)
        } finally {
            partial.delete()
        }
    }
}

val webAssets = layout.buildDirectory.dir("generated/webAssets")
val projectRoot = rootProject.projectDir.parentFile
val geodataAssets = layout.buildDirectory.dir("generated/geodataAssets")
val geodataManifest = projectRoot.resolve("scripts/mihomo-data.json")
val geodataCache = projectRoot.resolve(".cache/air/mihomo-data")
val prepareGeodata by tasks.registering {
    inputs.file(geodataManifest)
    inputs.files(project.fileTree(geodataCache) { include("geosite.dat", "geoip.metadb") })
    outputs.dir(geodataAssets)
    doLast {
        val directory = geodataAssets.get().dir("geodata").asFile.apply { mkdirs() }
        val manifest = JsonSlurper().parse(geodataManifest) as Map<*, *>
        val geodataRevision = manifest["revision"] as String
        val digests = manifest["sha256"] as Map<*, *>
        for ((key, digest) in digests) {
            val name = key as String
            val cached = geodataCache.resolve(name)
            val target = directory.resolve(if (name == "geosite.dat") "GeoSite.dat" else name)
            if (target.isFile && sha256(target) == digest) continue
            if (cached.isFile && sha256(cached) == digest) {
                cached.copyTo(target, overwrite = true)
            } else {
                val partial = temporaryDir.resolve(name)
                try {
                    download("https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/$geodataRevision/$name", partial)
                    check(sha256(partial) == digest) { "Mihomo geodata SHA-256 mismatch for $name" }
                    partial.copyTo(target, overwrite = true)
                } finally {
                    partial.delete()
                }
            }
        }
    }
}

val appIcon = projectRoot.resolve("src/assets/air.ico")
val iconResources = layout.buildDirectory.dir("generated/iconResources")
val prepareAppIcon by tasks.registering {
    inputs.file(appIcon)
    outputs.dir(iconResources)
    doLast {
        val bytes = appIcon.readBytes()
        val ico = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN)
        check(bytes.size >= 6 && ico.getInt(0) == 0x00010000) { "Invalid Air desktop icon" }
        val count = ico.getShort(4).toInt() and 0xffff
        val tableEnd = 6 + 16 * count
        check(bytes.size >= tableEnd) { "Incomplete Air desktop icon directory" }
        // ICO stores 256 as zero in the one-byte width and height fields.
        val entry = (0 until count).map { 6 + 16 * it }
            .firstOrNull { bytes[it].toInt() == 0 && bytes[it + 1].toInt() == 0 }
            ?: error("Air desktop icon is missing its 256 px image")
        val size = ico.getInt(entry + 8)
        val offset = ico.getInt(entry + 12)
        val pngSignature = byteArrayOf(-119, 80, 78, 71, 13, 10, 26, 10)
        check(size >= pngSignature.size && offset >= tableEnd && offset <= bytes.size - size
            && bytes.copyOfRange(offset, offset + pngSignature.size).contentEquals(pngSignature)) {
            "Air desktop icon does not contain a valid 256 px PNG"
        }
        val output = iconResources.get().file("mipmap-nodpi/ic_air.png").asFile
        output.parentFile.mkdirs()
        output.writeBytes(bytes.copyOfRange(offset, offset + size))
    }
}

val buildWeb by tasks.registering(Exec::class) {
    workingDir(projectRoot)
    inputs.dir(rootProject.file("web"))
    inputs.dir(projectRoot.resolve("src/shared"))
    inputs.dir(projectRoot.resolve("resources/languages"))
    inputs.dir(projectRoot.resolve("src/assets"))
    inputs.file(projectRoot.resolve("package.json"))
    inputs.file(projectRoot.resolve("pnpm-lock.yaml"))
    outputs.dir(webAssets)
    val buildArgs = listOf("pnpm", "exec", "vite", "build", "--config", "android/web/vite.config.ts")
    commandLine(if (System.getProperty("os.name").startsWith("Windows")) listOf("cmd", "/d", "/c") + buildArgs else buildArgs)
}

val supportedAbis = listOf("arm64-v8a", "armeabi-v7a", "x86_64")
val splitApks = providers.gradleProperty("airSplitApks").map(String::toBoolean).getOrElse(false)

android {
    namespace = "app.air.android"
    compileSdk = 36
    defaultConfig {
        applicationId = "app.air.android"
        minSdk = 26
        targetSdk = 36
        versionCode = 10
        versionName = "1.1.6"
        if (!splitApks) {
            ndk { abiFilters += supportedAbis }
        }
    }
    if (splitApks) {
        splits {
            abi {
                isEnable = true
                reset()
                include(*supportedAbis.toTypedArray())
                isUniversalApk = true
            }
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    sourceSets["main"].assets.srcDir(webAssets)
    sourceSets["main"].assets.srcDir(projectRoot.resolve("resources"))
    sourceSets["main"].assets.srcDir(geodataAssets)
    sourceSets["main"].res.srcDir(iconResources)
    packaging {
        jniLibs.useLegacyPackaging = true
    }
}

kotlin.compilerOptions.jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)

tasks.named("preBuild") { dependsOn(prepareAppIcon, prepareGeodata, buildWeb) }

dependencies {
    testImplementation("junit:junit:4.13.2")
    implementation("androidx.activity:activity:1.12.4")
    implementation("androidx.core:core:1.17.0")
    implementation("androidx.webkit:webkit:1.15.0")
    implementation(files(coreAar).builtBy(prepareCore))
}
