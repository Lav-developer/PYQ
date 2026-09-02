package com.dsmnru.pyq;

import android.content.Intent;
import android.net.Uri;
import android.webkit.WebView;

import androidx.activity.OnBackPressedCallback;

import com.getcapacitor.BridgeActivity;

/**
 * DSMNRU PYQ — Android shell around the existing production website
 * (https://dsmnru-pyq.netlify.app, alias https://dsmnru-pyq.email).
 *
 * The shell deliberately contains no business logic: browsing, search,
 * filters, papers, auth and PDFs all stay on the live frontend. This activity
 * only wires up the two things a remote-URL Capacitor app must own natively:
 *
 *  1. Android back navigation — walk the WebView history first, and only
 *     finish the activity when the history is exhausted (Capacitor's JS-side
 *     backButton event is not relied upon, because the page is remote).
 *  2. https deep links for the site hosts — the manifest registers
 *     unverified VIEW intent filters; tapping a dsmnru-pyq link can open the
 *     app and this routes the URL into the WebView (cold start and warm).
 */
public class MainActivity extends BridgeActivity {

    private static final String[] SITE_HOSTS = new String[] {
        "dsmnru-pyq.netlify.app",
        "dsmnru-pyq.email"
    };

    @Override
    public void onCreate(android.os.Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // Android back button: go back in web history, otherwise exit the app
        // (standard Android behavior at the top of the history stack). This
        // callback is registered after super.onCreate(), so it takes priority
        // over the @capacitor/app plugin's default handler, which would
        // swallow the press at the root page.
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                WebView webView = getWebViewOrNull();
                if (webView != null && webView.canGoBack()) {
                    webView.goBack();
                } else {
                    // History exhausted: leave the app (default Android behavior).
                    finish();
                }
            }
        });
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        loadSiteDeepLink(intent);
    }

    private WebView getWebViewOrNull() {
        if (bridge == null) {
            return null;
        }
        return bridge.getWebView();
    }

    /**
     * Loads ACTION_VIEW https intents for the site hosts into the WebView.
     * Everything else (external PDF hosts, share links, mailto, …) keeps
     * Capacitor's default behavior of being handed to the system.
     */
    private void loadSiteDeepLink(Intent intent) {
        if (intent == null || !Intent.ACTION_VIEW.equals(intent.getAction())) {
            return;
        }
        Uri data = intent.getData();
        if (data == null || !"https".equals(data.getScheme())) {
            return;
        }
        String host = data.getHost();
        if (host == null || !isSiteHost(host)) {
            return;
        }
        WebView webView = getWebViewOrNull();
        if (webView != null) {
            webView.loadUrl(data.toString());
        }
    }

    private boolean isSiteHost(String host) {
        for (String siteHost : SITE_HOSTS) {
            if (siteHost.equalsIgnoreCase(host)) {
                return true;
            }
        }
        return false;
    }
}
