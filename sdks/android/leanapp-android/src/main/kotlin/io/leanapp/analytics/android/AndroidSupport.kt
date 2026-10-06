package io.leanapp.analytics.android

import android.content.Context
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.os.Build
import android.util.Log
import io.leanapp.analytics.LeanAppLogger
import io.leanapp.analytics.defaultContext

internal object AndroidLogger : LeanAppLogger {
    private const val TAG = "LeanApp"
    override fun log(message: String) {
        Log.d(TAG, message)
    }

    override fun warn(message: String, error: Throwable?) {
        if (error != null) Log.w(TAG, message, error) else Log.w(TAG, message)
    }
}

internal class AppInfo(val versionName: String?, val versionCode: String?)

internal object DeviceInfo {
    fun app(context: Context): AppInfo = try {
        val info = context.packageManager.getPackageInfo(context.packageName, 0)
        val code = if (Build.VERSION.SDK_INT >= 28) {
            info.longVersionCode.toString()
        } else {
            @Suppress("DEPRECATION")
            info.versionCode.toString()
        }
        AppInfo(info.versionName, code)
    } catch (e: PackageManager.NameNotFoundException) {
        AppInfo(null, null)
    }

    /** Facts that do not change while the process runs. No device identifiers are collected. */
    fun static(context: Context): Map<String, Any?> {
        val res = context.resources
        val metrics = res.displayMetrics
        val isTablet = (res.configuration.screenLayout and Configuration.SCREENLAYOUT_SIZE_MASK) >= Configuration.SCREENLAYOUT_SIZE_LARGE
        return linkedMapOf(
            "os_version" to Build.VERSION.RELEASE,
            "device" to linkedMapOf(
                "model" to Build.MODEL,
                "manufacturer" to Build.MANUFACTURER,
                "type" to if (isTablet) "tablet" else "phone",
            ),
            "screen" to linkedMapOf(
                "width" to metrics.widthPixels,
                "height" to metrics.heightPixels,
                "density" to metrics.density.toDouble(),
            ),
        )
    }

    /** Static facts plus locale and timezone, which the user can change while the app runs. */
    fun provider(context: Context): () -> Map<String, Any?> {
        val fixed = static(context.applicationContext)
        return {
            val ctx = LinkedHashMap<String, Any?>(fixed)
            ctx.putAll(defaultContext())
            ctx
        }
    }
}
