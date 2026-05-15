package dev.kkirner.audiobook

import android.annotation.SuppressLint
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import dev.kkirner.audiobook.data.BookRepository

class MainActivity : ComponentActivity() {

    private lateinit var webView: WebView
    private lateinit var repo: BookRepository

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        repo = BookRepository(this)

        webView = WebView(this).apply {
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.mediaPlaybackRequiresUserGesture = false
            settings.mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
            settings.cacheMode = WebSettings.LOAD_DEFAULT
            settings.databaseEnabled = true
            settings.allowFileAccess = false
            settings.allowContentAccess = false

            addJavascriptInterface(AppBridge(), "AndroidApp")

            webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean {
                    val url = request?.url?.toString() ?: return false
                    if (url.startsWith("audiobook://play/")) {
                        val bookId = url.removePrefix("audiobook://play/")
                        openPlayer(bookId)
                        return true
                    }
                    return false
                }
            }
            webChromeClient = WebChromeClient()

            loadUrl(getString(R.string.server_url))
        }

        setContentView(webView)

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (webView.canGoBack()) webView.goBack()
                else finish()
            }
        })
    }

    private fun openPlayer(bookId: String) {
        // Save server URL and token from WebView for the native player
        webView.evaluateJavascript(
            "(function(){ return JSON.stringify({url: location.origin, token: localStorage.getItem('ab_token') || ''}); })()"
        ) { result ->
            try {
                val clean = result.trim('"').replace("\\\"", "\"").replace("\\\\", "\\")
                val json = org.json.JSONObject(clean)
                repo.saveServer(json.getString("url"), json.getString("token"))
            } catch (_: Exception) {}

            val intent = Intent(this, PlayerActivity::class.java).apply {
                putExtra("book_id", bookId)
            }
            startActivity(intent)
        }
    }

    inner class AppBridge {
        @JavascriptInterface
        fun playBook(bookId: String) {
            runOnUiThread { openPlayer(bookId) }
        }
    }

    override fun onPause() {
        super.onPause()
        webView.evaluateJavascript("typeof savePosition === 'function' && savePosition()", null)
    }
}
