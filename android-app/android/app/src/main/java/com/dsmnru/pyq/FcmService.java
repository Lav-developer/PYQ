package com.dsmnru.pyq;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;

import androidx.annotation.NonNull;

import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;

import com.google.firebase.FirebaseApp;
import com.google.firebase.messaging.FirebaseMessaging;
import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;

/**
 * DSMNRU PYQ — Firebase Cloud Messaging receiver (the ONLY push component).
 *
 * Architecture (no second backend, no token database):
 *
 *  • AUDIENCE      — every opted-in install is a member of ONE global FCM
 *                    topic, {@link #TOPIC_ALL_USERS}. The existing web admin
 *                    panel (via the Worker) can send to that topic and every
 *                    subscribed install receives it. Topic subscriptions are
 *                    managed BY the FCM SDK — no Firestore tokens, no
 *                    per-user documents, no per-launch synchronization.
 *  • REGISTRATION  — the Firebase SDK registers the token with Google Play
 *                    services by itself. We only react to
 *                    {@link #onNewToken} (rotation): stash the token
 *                    device-locally for diagnostics and (re-)assert the
 *                    topic membership. That is the only network call we
 *                    make, and only when the token actually changed.
 *  • FOREGROUND    — notification messages do NOT auto-display while the
 *                    app is open, so {@link #onMessageReceived} renders them
 *                    on the app's notification channel (with the deep-link
 *                    tap action).
 *  • BACKGROUND    — the system tray auto-displays notification payloads
 *                    (onMessageReceived is not called); the manifest
 *                    meta-data (channel id / icon / color) makes those
 *                    match the brand, and the tray tap opens the
 *                    launch intent → the same deep-link routing.
 *  • TAP HANDLING  — the content intent carries the paper link as an
 *                    ACTION_VIEW data Uri on MainActivity, so BOTH cold and
 *                    warm notification taps ride the exact deep-link
 *                    pipeline share links use (cold → getLaunchUrl, warm →
 *                    onNewIntent → 'siteDeepLink' → in-app paper screen —
 *                    never the website).
 *  • QUOTA         — zero polling, zero listeners, zero Worker calls, zero
 *                    Firestore writes. FCM itself does the delivery work.
 */
public class FcmService extends FirebaseMessagingService {

    /** The single global topic every opted-in install subscribes to. */
    public static final String TOPIC_ALL_USERS = "all_users";

    /** The app's notification channel (created at app start + lazily here). */
    public static final String CHANNEL_ID = "dsmnru_general";

    /** Fallback link target when a message carries no path. */
    public static final String SITE_ORIGIN = "https://dsmnru-pyq.netlify.app";

    private static final String PREFS = "dsmnru_fcm";
    private static final String KEY_TOPIC_VERSION = "topic_version";
    /**
     * Bump to re-assert topic membership for every existing install once
     * (e.g. when a NEW topic name ships). Never re-subscribes on every launch.
     */
    private static final int TOPIC_VERSION = 1;

    // ── token lifecycle ────────────────────────────────────────────────

    /**
     * Token created/rotated (first launch, app update, security event).
     * Fires a handful of times per device lifetime — the ONLY moment we do
     * any token-related work. Nothing is written to Firestore.
     */
    @Override
    public void onNewToken(@NonNull String token) {
        getSharedPreferences(PREFS, MODE_PRIVATE).edit().putString("token", token).apply();
        subscribeAllUsers(this, true);
    }

    // ── message handling ───────────────────────────────────────────────

    @Override
    public void onMessageReceived(@NonNull RemoteMessage message) {
        String title = null;
        String body = null;
        if (message.getNotification() != null) {
            title = message.getNotification().getTitle();
            body = message.getNotification().getBody();
        }
        java.util.Map<String, String> data = message.getData();
        if (title == null || title.isEmpty()) title = data.get("title");
        if (title == null || title.isEmpty()) title = "DSMNRU PYQ";
        if (body == null || body.isEmpty()) body = data.get("body");
        if (body == null || body.isEmpty()) body = "New update from the PYQ archive.";
        showFcmNotification(this, title, body, data.get("path"));
    }

    /**
     * Render a foreground message on the app channel. Silently does nothing
     * when the user has not granted POST_NOTIFICATIONS (Android 13+) — the
     * system decision is always respected.
     */
    private static void showFcmNotification(Context context, String title, String body, String path) {
        if (Build.VERSION.SDK_INT >= 33
                && ContextCompat.checkSelfPermission(context, android.Manifest.permission.POST_NOTIFICATIONS)
                        != PackageManager.PERMISSION_GRANTED) {
            return;
        }
        ensureChannel(context);
        NotificationCompat.Builder builder = new NotificationCompat.Builder(context, CHANNEL_ID)
                .setSmallIcon(R.drawable.ic_stat_dsmnru)
                .setColor(ContextCompat.getColor(context, R.color.dsmnru_teal))
                .setContentTitle(title)
                .setContentText(body)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
                .setPriority(NotificationCompat.PRIORITY_DEFAULT)
                .setCategory(NotificationCompat.CATEGORY_SOCIAL)
                .setAutoCancel(true)
                .setContentIntent(tapIntent(context, path));
        try {
            NotificationManagerCompat.from(context)
                    .notify((int) (System.currentTimeMillis() & 0x7fffffffL), builder.build());
        } catch (Exception securityIfNoListener) {
            // API 33- race between the check above and a revoked permission.
        }
    }

    /**
     * The tap action: an ACTION_VIEW data intent on MainActivity so a cold
     * start lands in getLaunchUrl() and a warm start in onNewIntent() — the
     * SAME routing as a shared /pyq/&lt;slug&gt; link, resolving to the in-app
     * paper screen.
     */
    private static PendingIntent tapIntent(Context context, String path) {
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= 23) flags |= PendingIntent.FLAG_IMMUTABLE;
        Intent open = new Intent(Intent.ACTION_VIEW, deepLinkUri(path), context, MainActivity.class);
        open.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        return PendingIntent.getActivity(context, (int) (deepLinkUri(path).hashCode() & 0x7fffffffL), open, flags);
    }

    /**
     * Build the absolute site URL for a payload path ("/pyq/&lt;slug&gt;",
     * "/paper.html?id=…") — the exact URL format MainActivity's deep-link
     * pipeline (and slug.js#parseSiteUrl) already understands.
     */
    private static Uri deepLinkUri(String path) {
        String p = path == null ? "" : path.trim();
        if (p.isEmpty()) return Uri.parse(SITE_ORIGIN + "/");
        if (p.startsWith("http://") || p.startsWith("https://")) return Uri.parse(p);
        return Uri.parse(SITE_ORIGIN + (p.startsWith("/") ? p : "/" + p));
    }

    // ── channel ────────────────────────────────────────────────────────

    /** Idempotent channel creation (API 26+; no-op below). */
    public static void ensureChannel(Context context) {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null || nm.getNotificationChannel(CHANNEL_ID) != null) return;
        NotificationChannel channel = new NotificationChannel(CHANNEL_ID,
                "Paper alerts", NotificationManager.IMPORTANCE_DEFAULT);
        channel.setDescription("New papers, results dates and archive announcements");
        channel.enableLights(true);
        channel.setLightColor(0xFF14B8A6);
        channel.enableVibration(true);
        nm.createNotificationChannel(channel);
    }

    // ── topic subscription (the global audience) ────────────────────────

    /**
     * Version-gated subscribe — runs the FCM topic call ONCE per install (and
     * once per {@link #TOPIC_VERSION} bump / token rotation when forced), so
     * ordinary launches cost nothing. {@code force} is used from
     * onNewToken: a rotated token must re-assert its topic membership.
     */
    public static void subscribeAllUsers(Context context, boolean force) {
        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        if (!force && prefs.getInt(KEY_TOPIC_VERSION, 0) >= TOPIC_VERSION) return;
        prefs.edit().putInt(KEY_TOPIC_VERSION, TOPIC_VERSION).apply();
        try {
            FirebaseMessaging.getInstance()
                    .subscribeToTopic(TOPIC_ALL_USERS)
                    .addOnCompleteListener(task -> {
                        if (!task.isSuccessful()) {
                            // Network hiccup — clear the gate so the next cold
                            // start retries. Lazy retry, never a loop.
                            prefs.edit().putInt(KEY_TOPIC_VERSION, 0).apply();
                        }
                    });
        } catch (Exception notConfiguredOrNoPlayServices) {
            prefs.edit().putInt(KEY_TOPIC_VERSION, 0).apply();
        }
    }

    // ── capability checks (used by MainActivity) ────────────────────────

    /** True when google-services.json was baked in and Firebase initialized. */
    public static boolean isFirebaseAvailable(Context context) {
        try {
            return !FirebaseApp.getApps(context).isEmpty();
        } catch (Exception e) {
            return false;
        }
    }

    /**
     * Static signal that the Google Services plugin processed a
     * google-services.json at build time (it always generates the
     * google_app_id resource). Independent of runtime init order.
     */
    public static boolean hasFirebaseConfigResources(Context context) {
        try {
            return context.getResources().getIdentifier(
                    "google_app_id", "string", context.getPackageName()) != 0;
        } catch (Exception e) {
            return false;
        }
    }

    /** True when notifications may be posted (API < 33: implicitly true). */
    public static boolean notificationsGranted(Context context) {
        if (Build.VERSION.SDK_INT < 33) return true;
        return ContextCompat.checkSelfPermission(context, android.Manifest.permission.POST_NOTIFICATIONS)
                == PackageManager.PERMISSION_GRANTED;
    }
}
