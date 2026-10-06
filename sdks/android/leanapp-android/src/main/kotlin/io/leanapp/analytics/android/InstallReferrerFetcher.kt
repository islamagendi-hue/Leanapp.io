package io.leanapp.analytics.android

import android.content.Context
import android.os.Handler
import android.os.Looper
import com.android.installreferrer.api.InstallReferrerClient
import com.android.installreferrer.api.InstallReferrerStateListener
import io.leanapp.analytics.InstallReferrer
import java.util.concurrent.atomic.AtomicBoolean

/** Outcome of one Play Install Referrer lookup. */
internal sealed class ReferrerResult {
    class Found(val referrer: InstallReferrer) : ReferrerResult()

    /** Play cannot provide a referrer on this device (no Play Store, not installed from Play). Do not ask again. */
    object Unavailable : ReferrerResult()

    /** Temporary failure (Play service busy or timeout). Ask again on the next launch. */
    object TryLater : ReferrerResult()
}

/** Reads the referrer with the com.android.installreferrer library. [done] is called exactly once. */
internal object InstallReferrerFetcher {
    fun fetch(context: Context, timeoutMs: Long, done: (ReferrerResult) -> Unit) {
        val main = Handler(Looper.getMainLooper())
        val finished = AtomicBoolean(false)
        main.post {
            val built: InstallReferrerClient? = try {
                InstallReferrerClient.newBuilder(context.applicationContext).build()
            } catch (e: Throwable) {
                null
            }
            if (built == null) {
                if (finished.compareAndSet(false, true)) done(ReferrerResult.Unavailable)
                return@post
            }
            val client: InstallReferrerClient = built
            fun finish(r: ReferrerResult) {
                if (!finished.compareAndSet(false, true)) return
                try {
                    client.endConnection()
                } catch (e: Throwable) {
                    // already closed
                }
                done(r)
            }
            main.postDelayed({ finish(ReferrerResult.TryLater) }, timeoutMs)
            try {
                client.startConnection(object : InstallReferrerStateListener {
                    override fun onInstallReferrerSetupFinished(responseCode: Int) {
                        when (responseCode) {
                            InstallReferrerClient.InstallReferrerResponse.OK -> {
                                val result = try {
                                    val d = client.installReferrer
                                    ReferrerResult.Found(
                                        InstallReferrer(
                                            referrer = d.installReferrer ?: "",
                                            referrerClickTimestampSeconds = d.referrerClickTimestampSeconds,
                                            installBeginTimestampSeconds = d.installBeginTimestampSeconds,
                                            googlePlayInstant = d.googlePlayInstantParam,
                                        ),
                                    )
                                } catch (e: Throwable) {
                                    ReferrerResult.TryLater
                                }
                                finish(result)
                            }
                            InstallReferrerClient.InstallReferrerResponse.FEATURE_NOT_SUPPORTED,
                            InstallReferrerClient.InstallReferrerResponse.DEVELOPER_ERROR,
                            -> finish(ReferrerResult.Unavailable)
                            else -> finish(ReferrerResult.TryLater)
                        }
                    }

                    override fun onInstallReferrerServiceDisconnected() {
                        finish(ReferrerResult.TryLater)
                    }
                })
            } catch (e: Throwable) {
                finish(ReferrerResult.TryLater)
            }
        }
    }
}
