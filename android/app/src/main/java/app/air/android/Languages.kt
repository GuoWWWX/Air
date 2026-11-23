package app.air.android

import android.content.Context
import android.util.AtomicFile
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.security.MessageDigest

internal object Languages {
    private val tag = Regex("[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8})*")
    private fun bundledCodes(context: Context) = context.assets.list("languages").orEmpty()
        .filter { it.endsWith(".json") }.map { it.removeSuffix(".json") }.sorted()
    private fun directory(context: Context) = File(configDirectory(context), "languages").apply { check(isDirectory || mkdirs() || isDirectory) }
    private fun selection(context: Context): File {
        val file = File(configDirectory(context), "language.txt")
        if (!file.exists()) {
            val previous = preferences(context).getString("selected", "system") ?: "system"
            writeAtomic(AtomicFile(file), previous.toByteArray(Charsets.UTF_8))
        }
        return file
    }

    fun preferences(context: Context) = context.getSharedPreferences("languages", Context.MODE_PRIVATE)
    private fun digest(bytes: ByteArray) = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
    private fun pack(text: String): JSONObject {
        val obj = JSONObject(text.removePrefix("\uFEFF"))
        val code = obj.getString("code")
        require(code.length <= 63 && code != "system" && code.matches(tag) && obj.getString("name").isNotBlank())
        val messages = obj.getJSONObject("messages")
        require(messages.keys().asSequence().all { messages.get(it) is String })
        return obj
    }

    private var installedPacks: Map<String, JSONObject>? = null

    private fun discover(context: Context): Map<String, JSONObject> {
        val dir = directory(context)
        val settings = preferences(context)
        if (!settings.getBoolean("configDirectoryMigrated", false)) {
            for (root in listOfNotNull(context.getExternalFilesDir(null), context.filesDir)) {
                for (old in File(root, "languages").listFiles().orEmpty()) {
                    val target = File(dir, old.name)
                    if (old.isFile && old.extension == "json" && old.length() <= 2097152 && !target.exists()) {
                        writeAtomic(AtomicFile(target), old.readBytes())
                    }
                }
            }
            check(settings.edit().putBoolean("configDirectoryMigrated", true).commit())
        }
        val installed = linkedMapOf<String, JSONObject>()
        for (code in bundledCodes(context)) {
            val bytes = context.assets.open("languages/$code.json").use { it.readBytes() }
            val file = File(dir, "$code.json")
            val previous = settings.getString("seed.$code", null)
            val next = digest(bytes)
            if (!file.exists() || (next != previous && file.length() <= 2097152 && digest(file.readBytes()) == previous)) {
                writeAtomic(AtomicFile(file), bytes)
                settings.edit().putString("seed.$code", next).apply()
            }
            installed[code] = pack(String(bytes, Charsets.UTF_8))
        }
        for (file in dir.listFiles().orEmpty().sortedBy { it.name }) {
            if (!file.isFile || file.extension != "json" || file.length() > 2097152) continue
            val item = runCatching { pack(file.readText()) }.getOrNull() ?: continue
            val code = item.getString("code")
            if (code != file.nameWithoutExtension) continue
            val builtin = installed[code]
            if (builtin == null) installed[code] = item else {
                val override = item.getJSONObject("messages")
                for (key in override.keys()) builtin.getJSONObject("messages").put(key, override.getString(key))
                builtin.put("name",item.getString("name"))
            }
        }
        return installed
    }

    @Synchronized fun read(context: Context): JSONObject {
        val installed = installedPacks ?: discover(context).also { installedPacks = it }
        val preference = selection(context).readText().takeIf { it in installed } ?: "system"
        return resolve(context, installed, preference)
    }

    private fun resolve(context: Context, installed: Map<String, JSONObject>, preference: String): JSONObject {
        val requested = if (preference == "system") {
            context.resources.configuration.locales[0]?.toLanguageTag().orEmpty()
        } else preference
        val code = matchLanguage(requested, installed.keys)
        val messages = JSONObject(installed.getValue("en").getJSONObject("messages").toString())
        val selected = installed.getValue(code).getJSONObject("messages")
        for (key in selected.keys()) messages.put(key, selected.getString(key))
        val options = JSONArray(installed.map { (key, value) -> JSONObject().put("code",key).put("name",value.getString("name")) })
        return JSONObject().put("code",code).put("preference",preference).put("options",options)
            .put("directory",directory(context).absolutePath).put("messages",messages)
    }

    internal fun matchLanguage(requested: String, codes: Set<String>): String {
        var tag = requested
        while (true) {
            codes.firstOrNull { it.equals(tag, true) }?.let { return it }
            if ('-' !in tag) break
            tag = tag.substringBeforeLast('-')
        }
        if (tag.equals("zh", true)) return "zh-CN"
        return codes.singleOrNull { it.substringBefore('-').equals(tag, true) } ?: "en"
    }

    @Synchronized fun choose(context: Context, code: String): JSONObject {
        val installed = installedPacks ?: discover(context).also { installedPacks = it }
        require(code == "system" || code in installed)
        writeAtomic(AtomicFile(selection(context)), code.toByteArray(Charsets.UTF_8))
        // Notify the foreground VPN service after publishing the selection.
        preferences(context).edit().putString("selected", code).apply()
        return resolve(context, installed, code)
    }

    @Synchronized fun importPack(context: Context, text: String) {
        val bytes = text.toByteArray()
        require(bytes.size <= 2097152)
        val code = pack(text).getString("code")
        require(bundledCodes(context).none { it.equals(code, true) } && code.lowercase() !in setOf("system", "con", "prn", "aux", "nul"))
        writeAtomic(AtomicFile(File(directory(context), "$code.json")),bytes)
    }
}

