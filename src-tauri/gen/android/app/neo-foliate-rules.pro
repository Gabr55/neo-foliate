# Methods called from JavaScript must survive minification
-keepclassmembers class io.github.neofoliate.NeoFoliate.NeoBridge {
    @android.webkit.JavascriptInterface <methods>;
}
-keepattributes JavascriptInterface
