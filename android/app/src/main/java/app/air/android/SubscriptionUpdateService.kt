package app.air.android

import android.app.job.JobInfo
import android.app.job.JobParameters
import android.app.job.JobScheduler
import android.app.job.JobService
import android.content.ComponentName
import android.content.Context
import android.util.AtomicFile
import org.json.JSONObject
import java.io.File
import java.security.MessageDigest
import java.util.concurrent.Executors

internal object SubscriptionUpdates {
    private const val JOB = 7622
    private const val RETRY = 900_000L
    private fun directory(context: Context) = File(context.cacheDir, "subscription-updates")
    private fun file(context: Context, id: String): File {
        val hash = MessageDigest.getInstance("SHA-256").digest(id.toByteArray()).joinToString("") { "%02x".format(it) }
        return File(directory(context), hash)
    }

    private fun enabledSources(library: JSONObject): List<JSONObject> {
        val sources = library.optJSONArray("sources") ?: return emptyList()
        val edits = library.optJSONObject("edits")?.keys()?.asSequence()?.toList().orEmpty()
        val hidden = library.optJSONArray("hiddenNodes")
        val changed = edits + (0 until (hidden?.length() ?: 0)).map { hidden!!.getString(it) }
        return (0 until sources.length()).map { sources.getJSONObject(it) }.filter { source ->
            val legacy = !source.optBoolean("edited") && changed.none { it.startsWith(source.getString("id") + "/") }
            !source.isNull("url") && source.optBoolean("autoUpdate", legacy)
        }
    }

    fun schedule(context: Context, library: JSONObject) {
        val enabled = enabledSources(library)
        val keep = enabled.map { file(context, it.getString("id")).name }.toSet()
        directory(context).listFiles()?.filter { it.name.matches(Regex("[a-f0-9]{64}")) && it.name !in keep }?.forEach { it.delete() }
        val scheduler = context.getSystemService(JobScheduler::class.java)
        if (enabled.isEmpty()) { scheduler.cancel(JOB); return }
        if (scheduler.getPendingJob(JOB) == null) {
            val info = JobInfo.Builder(JOB, ComponentName(context, SubscriptionUpdateService::class.java))
                .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY).setPeriodic(RETRY).setPersisted(true).build()
            scheduler.schedule(info)
        }
    }

    fun staged(context: Context, source: JSONObject, consume: Boolean = false): JSONObject? {
        val target = file(context, source.getString("id"))
        if (!target.exists()) return null
        val entry = runCatching { JSONObject(target.readText()) }.getOrNull() ?: return null
        if (source.optString("url") != entry.optString("url") || source.optLong("updated") != entry.optLong("updated")) return null
        if (consume) target.delete()
        return entry.optJSONObject("response")
    }

    fun fetchDue(context: Context, active: () -> Boolean) {
        for (source in enabledSources(AirLibrary.read(context))) {
            if (!active()) return
            val now = System.currentTimeMillis()
            val hours = source.optInt("customHours", source.optInt("intervalHours", 24)).coerceIn(1,720)
            if (now < source.optLong("updated") + hours * 3_600_000L || now < source.optLong("attempted") + RETRY) continue
            val target = file(context, source.getString("id"))
            if (staged(context, source) != null && target.lastModified() >= now - hours * 3_600_000L) continue
            val url = source.getString("url")
            val reply = runCatching { fetchSubscription(url) }.getOrNull() ?: continue
            if (!active()) return
            val latest = enabledSources(AirLibrary.read(context)).any {
                it.optString("id") == source.optString("id") && it.optString("url") == url && it.optLong("updated") == source.optLong("updated")
            }
            if (latest) {
                directory(context).mkdirs()
                val entry = JSONObject().put("url", url).put("updated", source.getLong("updated")).put("response", reply)
                writeAtomic(AtomicFile(target), entry.toString().toByteArray(Charsets.UTF_8))
            }
        }
    }
}

class SubscriptionUpdateService : JobService() {
    private val worker = Executors.newSingleThreadExecutor()
    @Volatile private var active: JobParameters? = null
    override fun onStartJob(params: JobParameters): Boolean {
        active = params
        worker.execute {
            try { SubscriptionUpdates.fetchDue(this) { active === params } }
            finally { if (active === params) { active = null; jobFinished(params, false) } }
        }
        return true
    }
    override fun onStopJob(params: JobParameters): Boolean { active = null; return true }
    override fun onDestroy() { active = null; worker.shutdownNow(); super.onDestroy() }
}
