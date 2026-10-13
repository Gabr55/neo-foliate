package io.github.neofoliate.NeoFoliate

import android.annotation.SuppressLint
import android.content.Intent
import android.os.Bundle
import android.view.KeyEvent
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge

class MainActivity : TauriActivity() {
  private var bridge: NeoBridge? = null
  private var pendingIntent: Intent? = null

  // Let the system back button go back in the web view: it closes open
  // sheets and panels, then returns from a book to the library
  override val handleBackNavigation: Boolean = true

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    pendingIntent = intent
  }

  @SuppressLint("JavascriptInterface")
  override fun onWebViewCreate(webView: WebView) {
    // Let the window background show until the page paints (no white flash)
    webView.setBackgroundColor(android.graphics.Color.TRANSPARENT)
    val bridge = NeoBridge(this, webView)
    this.bridge = bridge
    webView.addJavascriptInterface(bridge, "NeoAndroid")
    bridge.handleIntent(pendingIntent)
    pendingIntent = null
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    val bridge = bridge
    if (bridge != null) bridge.handleIntent(intent) else pendingIntent = intent
  }

  // Volume keys turn pages while reading (when enabled by the reader page)
  override fun dispatchKeyEvent(event: KeyEvent): Boolean {
    val bridge = bridge
    if (bridge != null && bridge.volumeKeys &&
      (event.keyCode == KeyEvent.KEYCODE_VOLUME_UP || event.keyCode == KeyEvent.KEYCODE_VOLUME_DOWN)) {
      if (event.action == KeyEvent.ACTION_DOWN) {
        bridge.emit("volume", if (event.keyCode == KeyEvent.KEYCODE_VOLUME_DOWN) "down" else "up")
      }
      return true
    }
    return super.dispatchKeyEvent(event)
  }

  override fun onDestroy() {
    bridge?.destroy()
    bridge = null
    super.onDestroy()
  }
}
