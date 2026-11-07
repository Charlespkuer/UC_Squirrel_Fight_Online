package com.ssdz.online

import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.res.Configuration
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.util.Log
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import java.security.MessageDigest
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.json.JSONObject

class MainActivity : TauriActivity() {
    private var gameWebView: WebView? = null
    @Volatile private var backgroundRun = false
    private val ui = Handler(Looper.getMainLooper())
    private var lifecycleSeq = 0
    private var frozen = false

    /** 合并连续的系统配置变化：新机（Android 16 / 折叠屏 / 分屏）一次转屏或系统栏动画
     *  会在几帧内连发多次 `onConfigurationChanged`。每次立即 evaluate 会让页面反复
     *  fitCanvas，表现就是「界面缩放不停切换」。这里只保留最后一拍，80ms 后通知一次。 */
    private val relayoutRunnable = Runnable {
        try {
            gameWebView?.evaluateJavascript(
                "window.__ssdzRelayout && window.__ssdzRelayout()", null
            )
        } catch (_: Exception) {
            // 页面还没建好；启动 / 回前台还会再补一次。
        }
    }

    private fun failJson(msg: String): String =
        JSONObject().put("ok", false).put("msg", msg).toString()

    // App/signing-key + Android user/device scoped on Android 8+, no dangerous
    // permissions. The JS side never receives the underlying ANDROID_ID.
    private inner class DeviceBridge {
        @JavascriptInterface
        fun setBackgroundRun(enabled: String) { backgroundRun = enabled == "1" }

        /** 「支持作者」等外链：由 Activity 自己发 ACTION_VIEW。
         *
         *  与单机版同一套（第四百一十三批）：Rust 的 `am start` 是以本应用 uid 跑的
         *  shell 命令入口，ActivityManager 会以 uid 不匹配拒绝；而 `Command::spawn`
         *  只代表进程起来，页面会把「其实没打开」当成成功，玩家看到的是「点了没反应」。 */
        @JavascriptInterface
        fun openExternal(rawUrl: String): String {
            val url = rawUrl.trim()
            val http = url.startsWith("https://", ignoreCase = true) ||
                url.startsWith("http://", ignoreCase = true)
            if (!http || url.length > 2048 || url.any { it.isWhitespace() }) {
                return failJson("链接不合法（只允许 http(s) 网址）")
            }
            var result: String? = null
            val latch = CountDownLatch(1)
            val open = Runnable {
                result = try {
                    startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
                    JSONObject().put("ok", true).toString()
                } catch (_: ActivityNotFoundException) {
                    failJson("这台设备上没有能打开网页的浏览器")
                } catch (e: Exception) {
                    Log.e("SSDZOnline", "open external failed: $url", e)
                    failJson("打开浏览器失败：" + (e.message ?: e.javaClass.simpleName))
                } finally {
                    latch.countDown()
                }
            }
            if (Looper.myLooper() == Looper.getMainLooper()) {
                open.run()                 // 已经在主线程，别 post 成自己等自己
            } else {
                runOnUiThread(open)
                latch.await(2, TimeUnit.SECONDS)   // 最多 2 秒，超时按失败处理
            }
            return result ?: failJson("打开浏览器超时，请稍后再试")
        }

        /** 系统页「状态栏」开关：隐藏时连底部/侧边导航栏一起收。
         *
         *  与单机版同一套口径（iQOO Z5 实测）：Android 15 起 `enableEdgeToEdge()`
         *  让 WebView 铺满整块窗口，只藏状态栏时三键导航会盖住游戏底部按钮；
         *  沉浸式 sticky 下从屏幕边缘滑动仍可临时唤出导航栏。 */
        @JavascriptInterface
        fun setSystemBarsHidden(hidden: String): String {
            val hide = hidden == "1" || hidden.equals("true", ignoreCase = true)
            try {
                val window = this@MainActivity.window
                val controller = WindowCompat.getInsetsController(window, window.decorView)
                val bars = WindowInsetsCompat.Type.statusBars() or WindowInsetsCompat.Type.navigationBars()
                if (hide) {
                    controller.hide(bars)
                    controller.systemBarsBehavior =
                        WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
                } else {
                    // 只恢复状态栏；导航栏始终沉浸，否则三键导航会重新盖住游戏底部。
                    controller.show(WindowInsetsCompat.Type.statusBars())
                    controller.hide(WindowInsetsCompat.Type.navigationBars())
                    controller.systemBarsBehavior =
                        WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
                }
            } catch (_: Exception) {
                // 个别 ROM 的 insets controller 可能抛异常；不影响游戏本体。
            }
            return JSONObject().put("ok", true).put("hidden", hide).toString()
        }

        @JavascriptInterface
        fun deviceIdentity(): String {
            return try {
                val raw = Settings.Secure.getString(contentResolver, Settings.Secure.ANDROID_ID)
                    ?.trim()?.lowercase() ?: throw IllegalStateException()
                if (!raw.matches(Regex("[0-9a-f]{1,16}")) || raw.all { it == '0' } || raw == "9774d56d682e549c")
                    throw IllegalStateException()
                val source = "com.ssdz.online\u0000android\u0000" + raw
                val hash = MessageDigest.getInstance("SHA-256").digest(source.toByteArray(Charsets.UTF_8))
                    .joinToString("") { byte -> "%02x".format(byte.toInt() and 0xff) }
                JSONObject().put("id", hash).put("platform", "android").put("provider", "android-id").toString()
            } catch (_: Exception) {
                JSONObject().put("error", "DEVICE_UNAVAILABLE").toString()
            }
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
    }

    override fun onWebViewCreate(webView: WebView) {
        super.onWebViewCreate(webView)
        gameWebView = webView
        webView.resumeTimers()
        // Online has no file bridge or local account backup.
        webView.settings.allowFileAccess = false
        webView.settings.allowContentAccess = false
        webView.addJavascriptInterface(DeviceBridge(), "SSDZAndroid")
    }

    override fun onPause() {
        lifecycleSeq++
        gameWebView?.evaluateJavascript(
            "window.__ssdzEnterBackground && window.__ssdzEnterBackground();", null
        )
        super.onPause()
        /* Android 16（API 36，含 HyperOS 3 / 澎湃 3）**不再冻结 WebView**：
         * 实测 WebView 133 上 `onPause()` + `pauseTimers()` 之后回到前台，页面会永远停在
         * 冻结前的最后一帧（DOM 还在、JS 还能跑，但画面不再更新 = 黑屏 / 旧画面）。
         * 计时器继续跑与设置里的「后台运行：开」相同；音乐仍由页面停。 */
        if (Build.VERSION.SDK_INT >= 36) return
        if (!backgroundRun) {
            val seq = lifecycleSeq
            val view = gameWebView
            ui.postDelayed({
                if (seq == lifecycleSeq && !backgroundRun && !frozen && view != null) {
                    view.onPause()
                    view.pauseTimers()
                    frozen = true
                }
            }, 250L)
        }
    }

    override fun onResume() {
        super.onResume()
        lifecycleSeq++
        ui.removeCallbacks(relayoutRunnable)
        gameWebView?.resumeTimers()
        gameWebView?.onResume()
        frozen = false
        gameWebView?.evaluateJavascript(
            "window.__ssdzRelayout && window.__ssdzRelayout();" +
                "window.__ssdzEnterForeground && window.__ssdzEnterForeground();", null
        )
    }

    /** 转屏 / 分屏 / 系统栏变化时 WebView 不一定会发 JS resize（iQOO 等 ROM 实测），
     *  Activity 声明了 configChanges 不会重建，必须主动通知页面重新量一次。 */
    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        /* 多拍合并：系统栏 / 转屏 / 分屏会连续发配置变化，单拍立即重排会让页面在两个
         * 尺寸之间来回缩放。只留最后一拍，等 80ms 稳定后再量。 */
        ui.removeCallbacks(relayoutRunnable)
        ui.postDelayed(relayoutRunnable, 80L)
    }

    override fun onDestroy() {
        lifecycleSeq++
        ui.removeCallbacksAndMessages(null)
        // pauseTimers is process-wide: a replacement Activity must never inherit it.
        gameWebView?.resumeTimers()
        gameWebView?.removeJavascriptInterface("SSDZAndroid")
        gameWebView = null
        super.onDestroy()
    }
}
