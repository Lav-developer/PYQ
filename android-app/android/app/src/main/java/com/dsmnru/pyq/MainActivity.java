package com.dsmnru.pyq;

import android.content.Intent;
import android.net.Uri;

import com.getcapacitor.BridgeActivity;


/**
 * DSMNRU PYQ — host activity for the DEDICATED Android app interface.
 *
 * The app UI is bundled in the APK (android/app assets → capacitor www/) and
 * talks directly to the shared production backends (Cloudflare Worker API +
 * Firebase Auth) — it does not render the website. This activity therefore
 * only owns the three things a Capacitor shell must do natively:
 *
 *  1. Register the app's own tiny native plugin ({@link DsmnruAppPlugin})
 *     for the share sheet, system downloads, and external link hand-off.
 *  2. Android back navigation is driven by the JS router through the built-in
 *     @capacitor/app 'backButton' event (pop the in-app stack, then exit) —
 *     no WebView history walking is needed because the app is not a browser.
 *  3. https deep links for the site hosts (a shared /pyq/&lt;slug&gt; link) are
 *     forwarded to the app router instead of loading the website:
 *       • cold start  → DsmnruAppPlugin.getLaunchUrl()
 *       • warm start  → onNewIntent() triggers the 'siteDeepLink' event
 *     Unverified intent filters: tapping such a link shows the standard
 *     Android chooser; the website itself is completely unaffected.
 */
public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(android.os.Bundle savedInstanceState) {
        // Custom in-app plugin must be known before the bridge initializes so
        // the bundled JS can call it through window.Capacitor.Plugins.DsmnruApp.
        registerPlugin(DsmnruAppPlugin.class);
        super.onCreate(savedInstanceState);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent); // getLaunchUrl() must observe warm-start links too

        if (intent == null || !Intent.ACTION_VIEW.equals(intent.getAction())) {
            return;
        }
        Uri data = intent.getData();
        if (data == null || !isSupportedScheme(data)) {
            return;
        }
        forwardToAppRouter(data.toString());
    }

    private boolean isSupportedScheme(Uri data) {
        return "https".equals(data.getScheme()) && data.getHost() != null;
    }

    /**
     * Pushes the incoming link into the running app; the JS router validates
     * the host/path (see www/js/slug.js#parseSiteUrl) and either opens the
     * matching screen or forwards the URL to the system browser.
     */
    private void forwardToAppRouter(String url) {
        runOnUiThread(() -> {
            if (getBridge() == null) {
                return;
            }
            try {
                com.getcapacitor.PluginHandle handle = getBridge().getPlugin("DsmnruApp");
                if (handle != null && handle.getInstance() instanceof DsmnruAppPlugin) {
                    ((DsmnruAppPlugin) handle.getInstance()).emitSiteLink(url);
                }
            } catch (Exception ignored) {
                // The JS side also re-reads the launch intent on every resume,
                // so a failed push can never strand an incoming link.
            }
        });
    }
}
