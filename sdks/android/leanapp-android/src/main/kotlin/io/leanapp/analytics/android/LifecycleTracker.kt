package io.leanapp.analytics.android

import android.app.Activity
import android.app.Application
import android.os.Bundle

/**
 * Detects foreground and background from activity callbacks (no AndroidX dependency).
 * A configuration change (rotation) is not treated as leaving the app.
 */
internal class LifecycleTracker(
    private val onForeground: (activity: Activity, first: Boolean) -> Unit,
    private val onBackground: () -> Unit,
) : Application.ActivityLifecycleCallbacks {
    private var started = 0
    private var changingConfiguration = false
    private var opened = false

    override fun onActivityStarted(activity: Activity) {
        started++
        if (started == 1 && !changingConfiguration) {
            val first = !opened
            opened = true
            onForeground(activity, first)
        }
        changingConfiguration = false
    }

    override fun onActivityStopped(activity: Activity) {
        if (started > 0) started--
        if (activity.isChangingConfigurations) {
            changingConfiguration = true
            return
        }
        if (started == 0) onBackground()
    }

    override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) {}
    override fun onActivityResumed(activity: Activity) {}
    override fun onActivityPaused(activity: Activity) {}
    override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) {}
    override fun onActivityDestroyed(activity: Activity) {}
}
