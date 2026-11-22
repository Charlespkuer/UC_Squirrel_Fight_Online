package com.ssdz.online

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.content.res.Configuration
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.Rect
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.util.Log
import android.view.PixelCopy
import android.view.View
import android.webkit.JavascriptInterface
import android.webkit.WebSettings
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.content.FileProvider
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import java.io.File
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.zip.ZipFile
import org.json.JSONObject

class MainActivity : TauriActivity() {
    private var gameWebView: WebView? = null
    @Volatile private var backgroundRun = false
    /* 画面兼容模式：个别 Android 16 + Adreno 机型（荣耀 MagicPad3 Pro / MagicOS 10 实测）
     * 的 WebView 合成层会整块丢栅格，屏幕上只剩一块纯绿。硬件合成路径修不了，只能让 WebView
     * 退回软件图层自己画；打开后所有绘制走 CPU，帧率会降，所以默认关闭、由设置页开关或
     * 页面自己的修复流程按需打开。 */
    @Volatile private var compatRender = false
    private val ui = Handler(Looper.getMainLooper())
    private var lifecycleSeq = 0
    private var frozen = false
    private val apkLock = Any()
    @Volatile private var apkStatus = "idle"
    @Volatile private var apkProgress = 0
    @Volatile private var apkVersion = ""
    @Volatile private var apkError = ""
    private val installationIdLock = Any()
    @Volatile private var installationIdCache: String? = null

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

    /* 绿屏自愈：荣耀 MagicPad3 Pro（Android 16 / MagicOS 10）上 WebView 的合成层会整块丢栅格，
     * 屏幕只剩一块纯绿 —— 那不是任何一个界面色（界面里最绿的草皮是 94,180,49），是那层没内容。
     * 每 2 秒抓 WebView 中心 96×96 取色：连续两拍接近纯绿先让页面重挂栅格，还不恢复就切软件图层。
     * 阈值要求红通道 ≈ 0，草绿/深绿页面不会误判。 */
    private var greenStrikes = 0
    private var lastSurfaceRepair = 0L
    @Volatile private var screenProbeOn = false
    private val screenProbe = object : Runnable {
        override fun run() {
            if (!screenProbeOn) return
            try { probeScreen() } catch (_: Exception) {}
            ui.postDelayed(this, 2000L)
        }
    }

    private fun startScreenProbe() {
        screenProbeOn = true
        ui.removeCallbacks(screenProbe)
        ui.postDelayed(screenProbe, 3000L)
    }

    private fun stopScreenProbe() {
        screenProbeOn = false
        ui.removeCallbacks(screenProbe)
        greenStrikes = 0
    }

    private fun probeScreen() {
        if (compatRender) return
        val view = gameWebView ?: return
        if (view.width <= 0 || view.height <= 0 || !view.isShown) return
        val loc = IntArray(2)
        view.getLocationInWindow(loc)
        val size = 96
        val left = (loc[0] + view.width / 2 - size / 2).coerceAtLeast(0)
        val top = (loc[1] + view.height / 2 - size / 2).coerceAtLeast(0)
        val bitmap = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
        try {
            PixelCopy.request(window, Rect(left, top, left + size, top + size), bitmap, { result ->
                try {
                    if (result == PixelCopy.SUCCESS && isPureGreen(bitmap)) onGreenFrame() else greenStrikes = 0
                } finally {
                    bitmap.recycle()
                }
            }, ui)
        } catch (e: Exception) {
            try { bitmap.recycle() } catch (_: Exception) {}
        }
    }

    // 纯绿：红 ≈ 0、绿亮、蓝低于满值。游戏调色板里最绿的草皮是 (94,180,49)、页签 (130,201,72)，
    // 红通道都远大于 40，不会误判。
    private fun isPureGreen(bmp: Bitmap): Boolean {
        var green = 0
        for (y in 0 until bmp.height) {
            for (x in 0 until bmp.width) {
                val c = bmp.getPixel(x, y)
                val r = (c shr 16) and 0xff
                val g = (c shr 8) and 0xff
                val b = c and 0xff
                if (r < 40 && g > 130 && b < 212 && g - r > 90 && g - b > 25) green++
            }
        }
        return green * 100 >= bmp.width * bmp.height * 92
    }

    private fun onGreenFrame() {
        greenStrikes++
        if (greenStrikes < 2) return
        val now = android.os.SystemClock.uptimeMillis()
        if (now - lastSurfaceRepair > 12000L) {
            // 第一拍先便宜地修：整窗重画 + 页面重挂栅格，很多机型到这一步就回来了。
            lastSurfaceRepair = now
            gameWebView?.invalidate()
            gameWebView?.requestLayout()
            gameWebView?.evaluateJavascript(
                "window.__ssdzRepairSurface && window.__ssdzRepairSurface()", null
            )
            return
        }
        if (!compatRender) {
            greenStrikes = 0
            enableCompatRender("screen still pure green")
        }
    }

    private fun enableCompatRender(reason: String) {
        if (compatRender) return
        compatRender = true
        try {
            gameWebView?.setLayerType(View.LAYER_TYPE_SOFTWARE, null)
            gameWebView?.invalidate()
        } catch (e: Exception) {
            Log.e("SSDZOnline", "compat render failed", e)
        }
        Log.w("SSDZOnline", "compat render enabled: $reason")
        // 页面据此把设置页开关和提示同步到「开」，并弹一次说明。
        gameWebView?.evaluateJavascript(
            "window.__ssdzRenderCompatAuto && window.__ssdzRenderCompatAuto()", null
        )
    }


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

        // 少量 ROM 会返回空值、全零或全服共享的 9774d56d682e549c，不能因此让整台设备无法注册：
        // 退回本安装随机 ID（provider=installation），服务端仍按设备/网络配额限制多开。
        private fun usableAndroidId(raw: String?): Boolean {
            if (raw.isNullOrEmpty() || !raw.matches(Regex("[0-9a-f]{16,64}"))) return false
            if (raw.all { it == '0' }) return false
            return raw != "9774d56d682e549c"
        }

        private fun digestAndroid(raw: String): String {
            val source = "com.ssdz.online\u0000android\u0000" + raw
            return MessageDigest.getInstance("SHA-256").digest(source.toByteArray(Charsets.UTF_8))
                .joinToString("") { byte -> "%02x".format(byte.toInt() and 0xff) }
        }

        private fun installationId(): String {
            installationIdCache?.let { return it }
            synchronized(installationIdLock) {
                installationIdCache?.let { return it }
                val prefs = getSharedPreferences("ssdz_device_identity", Context.MODE_PRIVATE)
                val saved = prefs.getString("installation_id", "") ?: ""
                if (saved.matches(Regex("[0-9a-f]{64}"))) {
                    installationIdCache = saved
                    return saved
                }
                val bytes = ByteArray(32)
                SecureRandom().nextBytes(bytes)
                val id = bytes.joinToString("") { byte -> "%02x".format(byte.toInt() and 0xff) }
                prefs.edit().putString("installation_id", id).commit()
                installationIdCache = id
                return id
            }
        }

        @JavascriptInterface
        fun deviceIdentity(): String {
            return try {
                val raw = Settings.Secure.getString(contentResolver, Settings.Secure.ANDROID_ID)
                    ?.trim()?.lowercase()
                if (usableAndroidId(raw)) {
                    JSONObject().put("id", digestAndroid(raw.orEmpty()))
                        .put("platform", "android").put("provider", "android-id").toString()
                } else {
                    JSONObject().put("id", installationId())
                        .put("platform", "android").put("provider", "installation").toString()
                }
            } catch (_: Exception) {
                JSONObject().put("error", "DEVICE_UNAVAILABLE").toString()
            }
        }

        @JavascriptInterface
        fun abi(): String = Build.SUPPORTED_ABIS.joinToString(",")

        /** 画面兼容模式开关：`compat` 让 WebView 走软件图层（整块丢栅格时的兜底），
         *  `auto` 恢复默认硬件合成。返回值里带实际生效的模式，页面据此回写开关。 */
        @JavascriptInterface
        fun setRenderMode(mode: String): String {
            val compat = mode.trim().equals("compat", ignoreCase = true)
            compatRender = compat
            ui.post {
                try {
                    gameWebView?.setLayerType(
                        if (compat) View.LAYER_TYPE_SOFTWARE else View.LAYER_TYPE_NONE, null
                    )
                    gameWebView?.invalidate()
                    gameWebView?.requestLayout()
                } catch (e: Exception) {
                    Log.e("SSDZOnline", "setRenderMode failed", e)
                }
            }
            return JSONObject().put("ok", true)
                .put("mode", if (compat) "compat" else "auto").toString()
        }

        @JavascriptInterface
        fun renderMode(): String =
            JSONObject().put("ok", true)
                .put("mode", if (compatRender) "compat" else "auto").toString()

        /** 强制整窗重画。页面切换 / 回前台 / 图形层可疑时由 JS 主动叫一次，
         *  不走软件图层也常能把丢掉的那层栅格补回来。 */
        @JavascriptInterface
        fun redraw(): String {
            ui.post {
                try {
                    gameWebView?.invalidate()
                    gameWebView?.requestLayout()
                } catch (_: Exception) {}
            }
            return "{\"ok\":true}"
        }

        @JavascriptInterface
        fun apkUpdateStatus(): String = synchronized(apkLock) {
            JSONObject().put("status", apkStatus)
                .put("progress", apkProgress)
                .put("version", apkVersion)
                .put("error", apkError)
                .toString()
        }

        @JavascriptInterface
        fun startApkUpdate(rawUrl: String, rawVersion: String): String {
            val url = rawUrl.trim()
            val version = rawVersion.trim()
            val parsed = try { Uri.parse(url) } catch (_: Exception) { null }
            val scheme = parsed?.scheme?.lowercase() ?: ""
            val path = parsed?.path ?: ""
            if ((scheme != "http" && scheme != "https") || url.length > 2048 ||
                url.any { it.isWhitespace() } || !path.startsWith("/download/") ||
                !path.lowercase().endsWith(".apk")) {
                return failJson("更新地址不合法")
            }
            if (!version.matches(Regex("[0-9A-Za-z._-]{1,32}"))) return failJson("版本号格式不正确")
            synchronized(apkLock) {
                if (apkStatus == "downloading") return failJson("安装包正在下载，请稍候")
                apkStatus = "downloading"
                apkProgress = 0
                apkVersion = version
                apkError = ""
            }
            // 先要安装权限再下载，避免用户等完 40+ MB 才被系统拦下。
            if (Build.VERSION.SDK_INT >= 26 && !packageManager.canRequestPackageInstalls()) {
                synchronized(apkLock) { apkStatus = "permission"; apkProgress = 0 }
                openUnknownSourcesSettings()
                return JSONObject().put("ok", true).toString()
            }
            Thread {
                try {
                    downloadAndInstallApk(url, version)
                } catch (e: Exception) {
                    Log.e("SSDZOnline", "apk update failed", e)
                    synchronized(apkLock) {
                        apkStatus = "error"
                        apkError = e.message ?: e.javaClass.simpleName
                    }
                }
            }.apply { isDaemon = true; start() }
            return JSONObject().put("ok", true).toString()
        }
    }

    private fun openUnknownSourcesSettings() {
        try {
            val intent = Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:$packageName"))
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            startActivity(intent)
        } catch (_: Exception) {
            // 个别 ROM 没有这个设置页；JS 会提示用户手动允许安装未知应用。
        }
    }

    private fun apkNativeAbis(file: File): Set<String> {
        val out = HashSet<String>()
        try {
            ZipFile(file).use { zip ->
                val entries = zip.entries()
                while (entries.hasMoreElements()) {
                    val name = entries.nextElement().name
                    if (!name.startsWith("lib/")) continue
                    val abi = name.removePrefix("lib/").substringBefore('/')
                    if (abi.isNotEmpty()) out.add(abi)
                }
            }
        } catch (_: Exception) {
            // 解析失败交给系统安装器给最终错误，不在这里吞掉更新流程。
        }
        return out
    }

    private fun downloadAndInstallApk(url: String, version: String) {
        val dir = File(cacheDir, "updates").apply { mkdirs() }
        val target = File(dir, "squirrel_fight_online-$version.apk")
        val part = File(dir, "squirrel_fight_online-$version.apk.part")
        part.delete()
        target.delete()
        var conn: HttpURLConnection? = null
        try {
            conn = (URL(url).openConnection() as HttpURLConnection).apply {
                connectTimeout = 20000
                readTimeout = 60000
                instanceFollowRedirects = true
                setRequestProperty("User-Agent", "SSDZOnline-Android")
            }
            val code = conn.responseCode
            if (code != HttpURLConnection.HTTP_OK) throw IOException("下载失败（HTTP $code）")
            val total = conn.contentLengthLong
            if (total in 1L..999_999L) throw IOException("安装包体积异常")
            var read = 0L
            conn.inputStream.use { input ->
                part.outputStream().use { output ->
                    val buf = ByteArray(64 * 1024)
                    while (true) {
                        val n = input.read(buf)
                        if (n < 0) break
                        output.write(buf, 0, n)
                        read += n
                        if (total > 0) {
                            val pct = ((read * 100) / total).toInt().coerceIn(0, 100)
                            synchronized(apkLock) { apkProgress = pct }
                        }
                    }
                }
            }
            if (read < 1_000_000) throw IOException("安装包体积异常")
            val head = ByteArray(2)
            part.inputStream().use { it.read(head) }
            if (head.size < 2 || head[0] != 0x50.toByte() || head[1] != 0x4B.toByte()) {
                throw IOException("下载文件不是 APK")
            }
            val archive = packageManager.getPackageArchiveInfo(part.absolutePath, 0)
            if (archive == null || archive.packageName != packageName) throw IOException("安装包不属于本应用")
            // 系统安装器对 ABI 不匹配只会弹「CPU 不兼容」，这里先按包内 lib/<abi>/ 判掉，
            // 避免玩家下载完才被系统拒绝；JS 选包也会按主 ABI 修正，双层兜底。
            val apkAbis = apkNativeAbis(part)
            if (apkAbis.isNotEmpty() && !apkAbis.any { Build.SUPPORTED_ABIS.contains(it) }) {
                part.delete()
                throw IOException("安装包与当前 CPU 不兼容（包内 " + apkAbis.joinToString("/") + "）")
            }
            if (!part.renameTo(target)) {
                target.delete()
                if (!part.renameTo(target)) throw IOException("保存安装包失败")
            }
            if (Build.VERSION.SDK_INT >= 26 && !packageManager.canRequestPackageInstalls()) {
                synchronized(apkLock) { apkStatus = "permission" }
                openUnknownSourcesSettings()
                return
            }
            val uri = FileProvider.getUriForFile(this, "$packageName.fileprovider", target)
            val install = Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(uri, "application/vnd.android.package-archive")
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            startActivity(install)
            synchronized(apkLock) {
                apkStatus = "ready"
                apkProgress = 100
            }
        } finally {
            try { conn?.disconnect() } catch (_: Exception) {}
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
        /* 底色必须是不透明黑：页面还没画到的地方宁可黑，也不要露出未初始化的合成层。
         * 绿色不是本应用的任何颜色，出现纯绿就是这一层没内容。 */
        webView.setBackgroundColor(Color.BLACK)
        if (compatRender) webView.setLayerType(View.LAYER_TYPE_SOFTWARE, null)
        /* 游戏只有浅色界面：系统深色模式下 WebView 的自动深色会把米色/金色压成暗褐/墨绿
         * （Android 13+ / WebView 133 实测）。这里显式关掉，不能只靠主题的 Light 父类。 */
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            webView.settings.isAlgorithmicDarkeningAllowed = false
        } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            @Suppress("DEPRECATION")
            webView.settings.forceDark = WebSettings.FORCE_DARK_OFF
        }
        // Online has no file bridge or local account backup.
        webView.settings.allowFileAccess = false
        webView.settings.allowContentAccess = false
        webView.addJavascriptInterface(DeviceBridge(), "SSDZAndroid")
    }

    override fun onPause() {
        lifecycleSeq++
        stopScreenProbe()
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
        startScreenProbe()
        gameWebView?.resumeTimers()
        gameWebView?.onResume()
        frozen = false
        // 回前台先补一次整窗重画，再让页面自己重排；丢栅格的机型只靠 JS 重排补不回来。
        gameWebView?.invalidate()
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
        screenProbeOn = false
        ui.removeCallbacksAndMessages(null)
        // pauseTimers is process-wide: a replacement Activity must never inherit it.
        gameWebView?.resumeTimers()
        gameWebView?.removeJavascriptInterface("SSDZAndroid")
        gameWebView = null
        super.onDestroy()
    }
}
