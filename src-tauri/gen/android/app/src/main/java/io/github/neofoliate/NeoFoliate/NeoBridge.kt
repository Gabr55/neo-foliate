package io.github.neofoliate.NeoFoliate

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.OpenableColumns
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.util.Locale
import java.util.concurrent.Executors

/**
 * Native features for the web UI, exposed to JavaScript as `NeoAndroid`
 * (see app/android.js). Results and events go back through
 * `window.__neoAndroid`.
 */
class NeoBridge(private val activity: Activity, private val webView: WebView) {
    private val main = Handler(Looper.getMainLooper())
    private val io = Executors.newSingleThreadExecutor()
    private val pendingUris = mutableListOf<Uri>()

    @Volatile
    var volumeKeys = false
        private set

    private var insets = JSONObject().put("top", 0).put("right", 0).put("bottom", 0).put("left", 0)

    init {
        ViewCompat.setOnApplyWindowInsetsListener(webView) { _, windowInsets ->
            // Ignore visibility so the layout does not jump in immersive mode
            val types = WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
            val i = windowInsets.getInsetsIgnoringVisibility(types)
            val density = activity.resources.displayMetrics.density
            insets = JSONObject()
                .put("top", i.top / density)
                .put("right", i.right / density)
                .put("bottom", i.bottom / density)
                .put("left", i.left / density)
            emit("insets", insets)
            windowInsets
        }
    }

    // --- Plumbing ---

    private fun js(code: String) = main.post { webView.evaluateJavascript(code, null) }

    private fun resolve(id: Int, value: Any?) {
        val json = when (value) {
            null -> "null"
            is String -> JSONObject.quote(value)
            else -> value.toString()
        }
        js("window.__neoAndroid&&__neoAndroid.resolve($id,$json)")
    }

    private fun reject(id: Int, error: Throwable) =
        js("window.__neoAndroid&&__neoAndroid.reject($id,${JSONObject.quote(error.message ?: error.toString())})")

    fun emit(type: String, detail: Any? = null) {
        val json = when (detail) {
            null -> "null"
            is String -> JSONObject.quote(detail)
            else -> detail.toString()
        }
        js("window.__neoAndroid&&__neoAndroid.emit(${JSONObject.quote(type)},$json)")
    }

    // --- Files ---

    private fun displayName(uri: Uri): String {
        var name: String? = null
        if (uri.scheme == "content") {
            activity.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use {
                if (it.moveToFirst()) name = it.getString(0)
            }
        }
        if (name.isNullOrBlank()) name = uri.lastPathSegment?.substringAfterLast('/')
        if (name.isNullOrBlank()) name = "book"
        return name!!.replace(Regex("[\\\\/:*?\"<>|\\u0000-\\u001f]"), "_")
    }

    private fun sizeOf(uri: Uri): Long {
        if (uri.scheme != "content") return -1
        activity.contentResolver.query(uri, arrayOf(OpenableColumns.SIZE), null, null, null)?.use {
            if (it.moveToFirst() && !it.isNull(0)) return it.getLong(0)
        }
        return -1
    }

    // Copy a picked or shared file into the app's library folder
    private fun copy(uri: Uri, dir: String): String {
        val folder = File(dir).apply { mkdirs() }
        val name = displayName(uri)
        val size = sizeOf(uri)
        var dest = File(folder, name)
        // The same book imported again replaces its copy; another file with
        // the same name gets a numbered one
        if (dest.exists() && (size < 0 || dest.length() != size)) {
            val base = name.substringBeforeLast('.', name)
            val ext = if (name.contains('.')) "." + name.substringAfterLast('.') else ""
            var n = 2
            while (dest.exists()) dest = File(folder, "$base ($n)$ext").also { n++ }
        }
        if (dest.exists()) return dest.absolutePath // the same book again
        val input = activity.contentResolver.openInputStream(uri)
            ?: throw IllegalStateException("Cannot open $uri")
        // copy under a unique temporary name, then rename: an interrupted
        // copy never leaves a broken book behind
        val tmp = File(folder, ".${dest.name}.${System.nanoTime()}.part")
        try {
            input.use { src -> FileOutputStream(tmp).use { src.copyTo(it, 1 shl 16) } }
            if (!tmp.renameTo(dest)) throw IllegalStateException("Cannot save ${dest.name}")
        } finally {
            tmp.delete()
        }
        return dest.absolutePath
    }

    @JavascriptInterface
    fun copyToLibrary(id: Int, uri: String, dir: String) = io.execute {
        try {
            resolve(id, copy(Uri.parse(uri), dir))
        } catch (e: Throwable) {
            reject(id, e)
        }
    }

    @JavascriptInterface
    fun writeText(id: Int, uri: String, text: String) = io.execute {
        try {
            val out = activity.contentResolver.openOutputStream(Uri.parse(uri), "wt")
                ?: throw IllegalStateException("Cannot write $uri")
            out.use { it.write(text.toByteArray(Charsets.UTF_8)) }
            resolve(id, true)
        } catch (e: Throwable) {
            reject(id, e)
        }
    }

    // Files opened with ("Open with…") or shared to the app
    fun handleIntent(intent: Intent?) {
        intent ?: return
        val uris = mutableListOf<Uri>()
        when (intent.action) {
            Intent.ACTION_VIEW -> intent.data?.let { uris.add(it) }
            Intent.ACTION_SEND -> intentStream(intent)?.let { uris.add(it) }
            Intent.ACTION_SEND_MULTIPLE -> uris.addAll(intentStreams(intent))
        }
        if (uris.isEmpty()) return
        synchronized(pendingUris) { pendingUris.addAll(uris) }
        emit("pending-files")
    }

    @Suppress("DEPRECATION")
    private fun intentStream(intent: Intent): Uri? =
        if (Build.VERSION.SDK_INT >= 33) intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
        else intent.getParcelableExtra(Intent.EXTRA_STREAM)

    @Suppress("DEPRECATION")
    private fun intentStreams(intent: Intent): List<Uri> =
        (if (Build.VERSION.SDK_INT >= 33) intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri::class.java)
        else intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM)) ?: emptyList()

    @JavascriptInterface
    fun takePendingFiles(id: Int, dir: String) = io.execute {
        val uris = synchronized(pendingUris) { pendingUris.toList().also { pendingUris.clear() } }
        val paths = JSONArray()
        for (uri in uris) {
            try {
                paths.put(copy(uri, dir))
            } catch (e: Throwable) {
                android.util.Log.e("NeoFoliate", "Cannot import $uri", e)
            }
        }
        resolve(id, paths)
    }

    // --- Window ---

    @JavascriptInterface
    fun getInsets(): String = insets.toString()

    @JavascriptInterface
    fun setKeepScreenOn(on: Boolean) = main.post {
        if (on) activity.window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        else activity.window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    }

    @JavascriptInterface
    fun setImmersive(on: Boolean) = main.post {
        val controller = WindowCompat.getInsetsController(activity.window, activity.window.decorView)
        controller.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        if (on) controller.hide(WindowInsetsCompat.Type.systemBars())
        else controller.show(WindowInsetsCompat.Type.systemBars())
    }

    @JavascriptInterface
    fun setSystemBars(lightBackground: Boolean) = main.post {
        val controller = WindowCompat.getInsetsController(activity.window, activity.window.decorView)
        controller.isAppearanceLightStatusBars = lightBackground
        controller.isAppearanceLightNavigationBars = lightBackground
    }

    // Screen brightness for this window, 0–1; a negative value follows the system
    @JavascriptInterface
    fun setBrightness(value: Double) = main.post {
        val params = activity.window.attributes
        params.screenBrightness = if (value < 0) WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_NONE
            else value.toFloat().coerceIn(0.01f, 1f)
        activity.window.attributes = params
    }

    @JavascriptInterface
    fun setVolumeKeys(on: Boolean) {
        volumeKeys = on
    }

    // --- Text to speech ---

    private var tts: TextToSpeech? = null
    @Volatile private var ttsReady = false
    private var queued: (() -> Unit)? = null
    // utterance chunk id -> (utterance id, offset in the utterance, last chunk?)
    private val chunks = mutableMapOf<String, Triple<String, Int, Boolean>>()

    private fun initTts() {
        if (tts != null) return
        tts = TextToSpeech(activity) { status ->
            ttsReady = status == TextToSpeech.SUCCESS
            if (!ttsReady) return@TextToSpeech
            tts?.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
                // The voice really started: the page marks the first word then
                override fun onStart(chunkId: String) {
                    val (id, offset) = synchronized(chunks) { chunks[chunkId] } ?: return
                    if (offset == 0) emit("tts", JSONObject().put("id", id).put("type", "start"))
                }

                override fun onRangeStart(chunkId: String, start: Int, end: Int, frame: Int) {
                    val (id, offset) = synchronized(chunks) { chunks[chunkId] } ?: return
                    emit("tts", JSONObject().put("id", id).put("type", "range").put("start", offset + start))
                }

                override fun onDone(chunkId: String) {
                    val (id, _, last) = synchronized(chunks) { chunks.remove(chunkId) } ?: return
                    if (last) emit("tts", JSONObject().put("id", id).put("type", "done"))
                }

                @Deprecated("Deprecated in Java")
                override fun onError(chunkId: String) = onError(chunkId, -1)

                override fun onError(chunkId: String, errorCode: Int) {
                    val (id, _, _) = synchronized(chunks) { chunks.remove(chunkId) } ?: return
                    emit("tts", JSONObject().put("id", id).put("type", "error").put("error", "synthesis-failed"))
                }

                override fun onStop(chunkId: String, interrupted: Boolean) {
                    synchronized(chunks) { chunks.remove(chunkId) }
                }
            })
            emit("tts", JSONObject().put("type", "voices"))
            queued?.invoke()
            queued = null
        }
    }

    @JavascriptInterface
    fun ttsVoices(): String {
        initTts()
        val engine = tts ?: return "[]"
        if (!ttsReady) return "[]"
        val list = JSONArray()
        try {
            engine.voices
                ?.filter { !it.features.contains(TextToSpeech.Engine.KEY_FEATURE_NOT_INSTALLED) }
                ?.sortedBy { it.name }
                ?.forEach { list.put(JSONObject().put("name", it.name).put("lang", it.locale.toLanguageTag())) }
        } catch (e: Throwable) {
            android.util.Log.w("NeoFoliate", "Cannot list voices", e)
        }
        return list.toString()
    }

    // Split long text at sentence or word boundaries to fit the engine limit
    private fun split(text: String, max: Int): List<Pair<Int, String>> {
        val parts = mutableListOf<Pair<Int, String>>()
        var start = 0
        while (start < text.length) {
            var end = minOf(text.length, start + max)
            if (end < text.length) {
                val window = text.substring(start, end)
                val cut = maxOf(window.lastIndexOf(". "), window.lastIndexOf("! "), window.lastIndexOf("? "))
                end = if (cut > max / 3) start + cut + 2
                else window.lastIndexOf(' ').let { if (it > 0) start + it + 1 else end }
            }
            parts.add(start to text.substring(start, end))
            start = end
        }
        return parts
    }

    @JavascriptInterface
    fun ttsSpeak(id: String, text: String, lang: String, rate: Double, voice: String, flush: Boolean) {
        initTts()
        val speak = speak@{
            val engine = tts ?: return@speak
            val chosen = if (voice.isNotEmpty()) engine.voices?.find { it.name == voice } else null
            if (chosen != null) {
                engine.voice = chosen
            } else if (lang.isNotEmpty()) {
                val result = engine.setLanguage(Locale.forLanguageTag(lang))
                if (result == TextToSpeech.LANG_MISSING_DATA || result == TextToSpeech.LANG_NOT_SUPPORTED) {
                    emit("tts", JSONObject().put("id", id).put("type", "error").put("error", "language-unavailable"))
                    return@speak
                }
            }
            engine.setSpeechRate(rate.toFloat())
            val parts = split(text, TextToSpeech.getMaxSpeechInputLength() - 1)
            parts.forEachIndexed { i, (offset, part) ->
                val chunkId = "$id:$i"
                synchronized(chunks) { chunks[chunkId] = Triple(id, offset, i == parts.lastIndex) }
                // the first chunk replaces what is playing unless the page queues it
                val mode = if (i == 0 && flush) TextToSpeech.QUEUE_FLUSH else TextToSpeech.QUEUE_ADD
                engine.speak(part, mode, null, chunkId)
            }
        }
        if (ttsReady) speak() else {
            // several sentences may arrive before the engine is ready
            val previous = queued
            queued = if (flush || previous == null) speak else ({ previous(); speak() })
        }
    }

    // System text-to-speech settings, to install voices
    @JavascriptInterface
    fun openTtsSettings() = main.post {
        try {
            activity.startActivity(Intent("com.android.settings.TTS_SETTINGS").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        } catch (e: Throwable) {
            activity.startActivity(Intent(android.provider.Settings.ACTION_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        }
    }

    @JavascriptInterface
    fun ttsStop() {
        queued = null
        synchronized(chunks) { chunks.clear() }
        tts?.stop()
    }

    fun destroy() {
        tts?.shutdown()
        tts = null
        io.shutdown()
    }
}
