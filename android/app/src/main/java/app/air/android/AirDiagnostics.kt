package app.air.android

import android.content.ContentProvider
import android.content.ContentValues
import android.content.Context
import android.database.Cursor
import android.net.Uri
import android.os.Binder
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.Message
import android.os.Messenger
import android.os.ParcelFileDescriptor
import android.os.Process
import org.json.JSONObject
import java.io.File
import java.util.concurrent.TimeUnit

internal object AirDiagnostics {
    private val endpoint = Uri.parse("content://app.air.android.diagnostics")

    fun run(context: Context, method: String, input: JSONObject, onProgress: ((completed: Int, alias: String?, delay: Int?) -> Unit)? = null): JSONObject {
        val file = File.createTempFile("air-diagnostic-", ".json", context.cacheDir)
        try {
            file.writeText(input.toString())
            val progress = onProgress?.let { report ->
                Messenger(Handler(Looper.getMainLooper()) { message ->
                    val data = message.peekData()
                    val alias = data?.getString("alias")
                    val delay = if (data != null && data.containsKey("delay")) data.getInt("delay") else null
                    report(message.arg1, alias, delay)
                    true
                })
            }
            val outcome = ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY).use { descriptor ->
                context.contentResolver.call(endpoint, method, null, Bundle().apply {
                    putParcelable("input", descriptor)
                    if (progress != null) putParcelable("progress", progress)
                })
            } ?: error("诊断内核未响应")
            outcome.getString("error")?.let { error(it) }
            return JSONObject(outcome.getString("value") ?: "{}")
        } finally {
            file.delete()
        }
    }
}

class AirDiagnosticProvider : ContentProvider() {
    override fun onCreate() = true

    @Suppress("DEPRECATION")
    override fun call(method: String, arg: String?, extras: Bundle?): Bundle {
        check(Binder.getCallingUid() == Process.myUid()) { "诊断仅供 Air 使用" }
        if (method == "cancelProbe") {
            Core.cancelProbe()
            return Bundle().apply { putString("value", "{}") }
        }
        val generation = Core.currentProbeGeneration()
        val owner = checkNotNull(context)
        val file: ParcelFileDescriptor = extras?.getParcelable("input") ?: error("缺少诊断配置")
        val input = ParcelFileDescriptor.AutoCloseInputStream(file).bufferedReader().use { JSONObject(it.readText()) }
        val progress: Messenger? = extras.getParcelable("progress")
        val result = runCatching {
            Core.worker.submit<JSONObject> {
                when (method) {
                    "probe" -> {
                        var completed = 0
                        Core.probe(owner, input.getJSONObject("plan"), input.getJSONArray("aliases"),
                            input.getString("url"), input.optInt("expected", 204), generation) { alias, delay ->
                            completed++
                            if (progress != null) {
                                runCatching {
                                    progress.send(Message.obtain(null, 0, completed, 0).apply {
                                        data = Bundle().apply {
                                            putString("alias", alias)
                                            putInt("delay", delay)
                                        }
                                    })
                                }
                            }
                        }
                    }
                    "testDns" -> DnsProbe.resolve(owner, input)
                    "validatePlan" -> {
                        Core.validate(owner, input.getJSONObject("plan"))
                        JSONObject().put("valid", true)
                    }
                    else -> error("Air 不支持该诊断操作")
                }
            }.get(45, TimeUnit.SECONDS)
        }
        return Bundle().apply {
            result.fold(
                onSuccess = { putString("value", it.toString()) },
                onFailure = { putString("error", (it.cause?.message ?: it.message ?: "诊断超时").take(300)) },
            )
        }
    }

    override fun query(uri: Uri, projection: Array<out String>?, selection: String?, selectionArgs: Array<out String>?, sortOrder: String?): Cursor? = null
    override fun getType(uri: Uri): String? = null
    override fun insert(uri: Uri, values: ContentValues?): Uri? = null
    override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?): Int = 0
    override fun update(uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<out String>?): Int = 0
}
