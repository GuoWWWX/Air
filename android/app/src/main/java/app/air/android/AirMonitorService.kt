package app.air.android

import android.app.job.JobInfo
import android.app.job.JobParameters
import android.app.job.JobScheduler
import android.app.job.JobService
import android.content.ComponentName
import android.content.Context
import android.util.AtomicFile
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

internal object AirLibrary {
    private fun library(context: Context) = File(context.noBackupFilesDir, "library.json")
    private fun results(context: Context) = File(context.noBackupFilesDir, "monitor-results.json")

    fun read(context: Context): JSONObject = readJson(library(context))
    fun monitorResults(context: Context): JSONObject = readJson(results(context))

    fun save(context: Context, value: JSONObject) {
        val target = AtomicFile(library(context))
        val previous = read(context)
        writeAtomic(target, value.toString().toByteArray(Charsets.UTF_8))
        try {
            schedule(context, value.optJSONObject("monitorPlan"))
            SubscriptionUpdates.schedule(context, value)
        } catch (error: Exception) {
            writeAtomic(target, previous.toString().toByteArray(Charsets.UTF_8))
            throw error
        }
    }

    fun writeResults(context: Context, value: JSONObject) {
        writeAtomic(AtomicFile(results(context)), value.toString().toByteArray(Charsets.UTF_8))
    }

    // The other process only reads the current file. AtomicFile replaces it after writing.
    private fun readJson(file: File): JSONObject =
        if (file.exists()) JSONObject(file.readText()) else JSONObject()

    private fun schedule(context: Context, request: JSONObject?) {
        val scheduler = context.getSystemService(JobScheduler::class.java)
        if ((request?.optJSONObject("targets")?.length() ?: 0) == 0) {
            scheduler.cancel(MONITOR_JOB)
            return
        }
        val minutes = request!!.getInt("interval")
        require(minutes in 15..1440) { "后台测速间隔无效" }
        val interval = minutes * 60_000L
        if (scheduler.getPendingJob(MONITOR_JOB)?.intervalMillis == interval) return
        val job = JobInfo.Builder(MONITOR_JOB, ComponentName(context, AirMonitorService::class.java))
            .setPeriodic(interval)
            .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
            .setRequiresBatteryNotLow(true)
            .setPersisted(true)
            .build()
        check(scheduler.schedule(job) == JobScheduler.RESULT_SUCCESS) { "Android 未能安排后台测速任务" }
    }

    private const val MONITOR_JOB = 7621
}

class AirMonitorService : JobService() {
    @Volatile private var active: JobParameters? = null

    override fun onStartJob(params: JobParameters): Boolean {
        active = params
        Core.worker.execute {
            val request = runCatching { AirLibrary.read(this).optJSONObject("monitorPlan") }.getOrNull()
            try {
                if (request != null) runProbe(params, request)
            } catch (error: Exception) {
                if (active === params) {
                    runCatching {
                        val saved = AirLibrary.monitorResults(this)
                        AirLibrary.writeResults(this, saved.put("at", System.currentTimeMillis())
                            .put("error", error.message?.take(180)).put("available", 0).put("checked", 0))
                    }
                }
            } finally {
                if (active === params) {
                    active = null
                    jobFinished(params, false)
                }
            }
        }
        return true
    }

    override fun onStopJob(params: JobParameters): Boolean {
        if (active === params) active = null
        return true
    }

    private fun runProbe(params: JobParameters, request: JSONObject) {
        val targets = request.getJSONObject("targets")
        val ids = targets.keys().asSequence().toList()
        if (ids.isEmpty()) return
        val previous = AirLibrary.monitorResults(this)
        val cursor = previous.optInt("cursor").coerceAtLeast(0) % ids.size
        val count = minOf(24, ids.size)
        val batch = List(count) { ids[(cursor + it) % ids.size] }
        val plan = request.getJSONObject("plan")
        val url = request.getString("url")
        val status = request.getInt("expected")
        val at = System.currentTimeMillis()
        val cutoff = at - 86_400_000L
        val samples = JSONObject()
        val oldSamples = previous.optJSONObject("samples") ?: JSONObject()
        for (id in ids) {
            val old = oldSamples.optJSONArray(id) ?: continue
            val retained = JSONArray()
            for (index in 0 until old.length()) {
                val sample = old.getJSONObject(index)
                if (sample.optLong("at") >= cutoff) retained.put(sample)
            }
            if (retained.length() > 0) samples.put(id, retained)
        }
        var available = 0
        for (chunk in batch.chunked(6)) {
            if (active !== params) return
            val aliases = JSONArray(chunk.map { targets.getString(it) })
            val measured = Core.probe(this, plan, aliases, url, status)
            for (id in chunk) {
                val delay = measured.optInt(targets.getString(id), -1)
                if (delay > 0) available++
                val previousRows = samples.optJSONArray(id) ?: JSONArray()
                val keep = JSONArray()
                for (index in maxOf(0, previousRows.length() - 95) until previousRows.length()) {
                    keep.put(previousRows.getJSONObject(index))
                }
                samples.put(id, keep.put(JSONObject().put("at", at).put("delay", delay)))
            }
        }
        if (active === params && AirLibrary.read(this).optJSONObject("monitorPlan")?.toString() == request.toString()) {
            AirLibrary.writeResults(this, JSONObject().put("cursor", (cursor + count) % ids.size)
                .put("at", at).put("checked", count).put("available", available).put("samples", samples))
        }
    }
}
