package com.dsmnru.pyq;

import android.Manifest;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;

import androidx.core.app.ActivityCompat;

import com.getcapacitor.BridgeActivity;


/**
 * DSMNRU PYQ — host activity for the DEDICATED Android app interface.
 *
 * The app UI is bundled in the APK (android/app assets → capacitor www/) and
 * talks directly to the shared production backends (Cloudflare Worker API +
 * Firebase Auth) — it does not render the website. This activity therefore
 * only owns the few things a Capacitor shell must do natively:
 *
 *  1. Register the app's own tiny native plugin ({@link DsmnruAppPlugin})
 *     for the share sheet, in-app PDF viewer, Google sign-in, system
 *     downloads and external link hand-off.
 *  2. Android back navigation is driven by the JS router through the built-in
 *     @capacitor/app 'backButton' event (pop the in-app stack, then exit) —
 *     no WebView history walking is needed because the app is not a browser.
 *  3. https deep links for the site hosts (a shared /pyq/&lt;slug&gt; link —
 *     or the tap action of an FCM notification) are forwarded to the app
 *     router instead of loading the website:
 *       • cold start  → DsmnruAppPlugin.getLaunchUrl()
 *       • warm start  → onNewIntent() triggers the 'siteDeepLink' event
 *     Unverified intent filters: tapping such a link shows the standard
 *     Android chooser; the website itself is completely unaffected.
 *  4. FCM bootstrap ({@link FcmService}): create the notification channel,
 *     version-gated single 'all_users' topic subscribe, and — Android 13+,
 *     once per install, only when Firebase is actually configured — the REAL
 *     system POST_NOTIFICATIONS permission dialog, scheduled a few seconds
 *     into the first session so the user sees the app before being asked.
 *     The user's grant/deny decision is never re-litigated on later launches.
 */
public class MainActivity extends BridgeActivity {

    private static final int REQ_POST_NOTIFICATIONS = 4101;
    private static final String PREFS_FCM = "dsmnru_fcm";
    private static final String KEY_NOTIF_ASKED = "notif_permission_asked";
    /** First meaningful session: let the user land in the app before asking. */
    private static final long PERMISSION_ASK_DELAY_MS = 9000L;

    private final Handler mainHandler = new Handler(Looper.getMainLooper());

    private final Runnable permissionAsk = () -> {
        if (Build.VERSION.SDK_INT < 33) return;
        if (FcmService.notificationsGranted(this)) return; // already granted — nothing to ask
        SharedPreferences prefs = getSharedPreferences(PREFS_FCM, MODE_PRIVATE);
        if (prefs.getBoolean(KEY_NOTIF_ASKED, false)) return; // asked once — respect the decision
        prefs.edit().putBoolean(KEY_NOTIF_ASKED, true).apply();
        ActivityCompat.requestPermissions(this,
                new String[]{ Manifest.permission.POST_NOTIFICATIONS }, REQ_POST_NOTIFICATIONS);
    };

    @Override
    public void onCreate(android.os.Bundle savedInstanceState) {
        // Custom in-app plugin must be known before the bridge initializes so
        // the bundled JS can call it through window.Capacitor.Plugins.DsmnruApp.
        registerPlugin(DsmnruAppPlugin.class);
        super.onCreate(savedInstanceState);

        // FCM bootstrap: channel is idempotent; the topic subscribe is
        // version-gated (one FCM call per install/update, NOT per launch).
        // Both are safe no-ops until google-services.json is baked into a build.
        FcmService.ensureChannel(this);
        FcmService.subscribeAllUsers(this, false);
    }

    @Override
    protected void onResume() {
        super.onResume();
        scheduleNotificationPermissionAsk();
    }

    @Override
    protected void onPause() {
        mainHandler.removeCallbacks(permissionAsk);
        super.onPause();
    }

    /**
     * Ask for POST_NOTIFICATIONS exactly once per install (Android 13+),
     * a few seconds into a session so the dialog is not the first thing a
     * new user sees. Never shown again afterwards — granted or denied — and
     * the app works identically either way (push simply stays silent when
     * denied). On Android < 13 no runtime dialog exists or is needed.
     */
    private void scheduleNotificationPermissionAsk() {
        if (Build.VERSION.SDK_INT < 33) return;
        if (FcmService.notificationsGranted(this)) return;
        SharedPreferences prefs = getSharedPreferences(PREFS_FCM, MODE_PRIVATE);
        if (prefs.getBoolean(KEY_NOTIF_ASKED, false)) return;
        // Pointless to ask when the build carries no Firebase configuration.
        if (!FcmService.isFirebaseAvailable(this)) return;
        mainHandler.postDelayed(permissionAsk, PERMISSION_ASK_DELAY_MS);
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
