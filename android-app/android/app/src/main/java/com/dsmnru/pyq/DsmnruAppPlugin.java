package com.dsmnru.pyq;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.app.DownloadManager;
import android.os.Environment;
import android.provider.Settings;
import android.webkit.MimeTypeMap;
import android.webkit.URLUtil;
import androidx.core.content.ContextCompat;
import androidx.core.content.FileProvider;
import android.os.Build;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.RandomAccessFile;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

import androidx.credentials.CredentialManager;
import androidx.credentials.CredentialManagerCallback;
import androidx.credentials.CustomCredential;
import androidx.credentials.GetCredentialRequest;
import androidx.credentials.GetCredentialResponse;
import androidx.credentials.CredentialOption;
import androidx.credentials.exceptions.GetCredentialException;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import com.google.android.libraries.identity.googleid.GetGoogleIdOption;
import com.google.android.libraries.identity.googleid.GoogleIdTokenCredential;

import java.lang.reflect.Constructor;
import java.lang.reflect.Method;
import java.security.MessageDigest;
import java.util.concurrent.Executors;

/**
 * DSMNRU PYQ — the app's own tiny native layer (no npm plugin beyond the
 * Credential Manager libraries). These are the operations a mobile web page
 * simply cannot do inside a WebView; everything else stays in the app's own
 * JS front-end.
 *
 *  • pdfView       → open a PDF INSIDE the app (PdfViewerActivity: native
 *                    PdfRenderer, zoom/scroll, progress/error states). The
 *                    original host URL is fetched directly — no Worker
 *                    bandwidth, no permanent copy (temporary cache only).
 *  • googleSignIn  → Android-native Google sign-in via the Credential
 *                    Manager: the device's own Google account chooser returns
 *                    a Google ID token which auth.js exchanges with the SAME
 *                    Firebase project (accounts:signInWithIdp). No browser,
 *                    no Chrome, no website hand-off, no second auth system.
 *  • openExternal  → hand a genuinely-external link (university portals,
 *                    Drive landing pages, the explicitly-chosen website) to
 *                    the best Android handler.
 *  • download      → explicit user taps on a direct .pdf save to the public
 *                    Downloads folder through the system DownloadManager
 *                    (resume + notification handled by Android, permission-free).
 *  • share         → the real Android share sheet (WebView has no
 *                    navigator.share), used for sharing a paper link.
 *  • getLaunchUrl  → the /pyq/&lt;slug&gt; URL that started the activity, so the
 *                    app can deep-link into its own paper screen.
 *  • downloadAndInstall → the in-app updater: downloads the official GitHub
 *                    release APK (URL/redirect policy in UpdateUrlPolicy),
 *                    verifies it, and hands it to the system package
 *                    installer; progress streams to JS via
 *                    `updateDownloadProgress` and the plugin call is always
 *                    answered exactly once.
 */
@CapacitorPlugin(name = "DsmnruApp")
public class DsmnruAppPlugin extends Plugin {

    // ── in-app PDF viewer ──────────────────────────────────────────────

    @PluginMethod
    public void pdfView(PluginCall call) {
        String url = call.getString("url", "");
        String title = call.getString("title", "Paper");
        if (!isHttpUrl(url)) {
            call.reject("Only http(s) PDF links can be opened in the viewer");
            return;
        }
        try {
            Intent intent = new Intent(getContext(), PdfViewerActivity.class);
            intent.putExtra(PdfViewerActivity.EXTRA_URL, url);
            intent.putExtra(PdfViewerActivity.EXTRA_TITLE, title == null ? "Paper" : title);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            call.resolve();
        } catch (Exception e) {
            call.reject("Could not open the PDF viewer: " + e.getMessage());
        }
    }

    // ── Android-native Google sign-in (Credential Manager) ─────────────

    @PluginMethod
    public void googleSignIn(PluginCall call) {
        Activity activity = getActivity();
        if (activity == null) {
            call.reject("GOOGLE_SIGNIN_UNAVAILABLE: app activity is not running");
            return;
        }
        // serverClientId MUST be the WEB OAuth client (audience of the Google
        // ID token that Firebase's accounts:signInWithIdp accepts). With
        // google-services.json present, the Google Services plugin generates
        // `default_web_client_id` from the file's client_type: 3 entry — the
        // authoritative web client. The manual `google_web_client_id` string
        // stays as a fallback for builds generated without the file. The
        // ANDROID OAuth client (client_type: 1/2) is never used here — it is
        // identified by package + SHA-1 at the OS level, not by client id.
        String clientId = "";
        try {
            int resId = getContext().getResources().getIdentifier(
                    "default_web_client_id", "string", getContext().getPackageName());
            if (resId != 0) {
                clientId = getContext().getString(resId);
            }
        } catch (Exception generatedResourceMissing) {
            clientId = "";
        }
        if (clientId == null || clientId.trim().isEmpty() || clientId.contains("REPLACE_WITH")) {
            try {
                clientId = getContext().getString(R.string.google_web_client_id);
            } catch (Exception e) {
                clientId = "";
            }
        }
        if (clientId == null || clientId.trim().isEmpty() || clientId.contains("REPLACE_WITH")) {
            call.reject("GOOGLE_SIGNIN_NOT_CONFIGURED: this build has no Google Web client ID — "
                + "add google-services.json (or set google_web_client_id) and register the signing SHA-1 "
                + "(see android-app/docs/GOOGLE_SIGNIN_SETUP.md)");
            return;
        }

        // Bind the returned token to this exact attempt (anti-replay): the
        // hashed nonce goes to Google, the raw nonce stays in JS and is
        // replayed to Identity Toolkit by auth.signInWithGoogleCredential.
        String nonceHash = sha256Hex(call.getString("nonce", ""));

        try {
            // androidx.credentials 1.3.0 renamed the companion factory
            // getClient(context) → create(context) (@JvmStatic — direct call).
            CredentialManager credentialManager = CredentialManager.create(activity);
            GetGoogleIdOption googleOption = new GetGoogleIdOption.Builder()
                    .setServerClientId(clientId)
                    // false → show ALL device Google accounts (fresh chooser),
                    // not only previously-authorized ones.
                    .setFilterByAuthorizedAccounts(false)
                    .setAutoSelectEnabled(false)
                    .setNonce(nonceHash.isEmpty() ? null : nonceHash)
                    .build();
            GetCredentialRequest request = buildCredentialRequest(googleOption);

            Method async = findGetCredentialAsync();
            if (async == null) {
                call.reject("GOOGLE_SIGNIN_UNAVAILABLE: Credential Manager async API missing");
                return;
            }
            async.invoke(credentialManager, activity, request, null, Executors.newSingleThreadExecutor(),
                    new CredentialManagerCallback<GetCredentialResponse, GetCredentialException>() {
                        @Override
                        public void onResult(GetCredentialResponse result) {
                            try {
                                androidx.credentials.Credential credential = result.getCredential();
                                if (credential instanceof CustomCredential
                                        && GoogleIdTokenCredential.TYPE_GOOGLE_ID_TOKEN_CREDENTIAL
                                                .equals(credential.getType())) {
                                    GoogleIdTokenCredential googleCredential =
                                            GoogleIdTokenCredential.createFrom(((CustomCredential) credential).getData());
                                    JSObject ret = new JSObject();
                                    ret.put("idToken", googleCredential.getIdToken());
                                    ret.put("nonce", call.getString("nonce", ""));
                                    call.resolve(ret);
                                } else {
                                    call.reject("GOOGLE_SIGNIN_UNAVAILABLE: unexpected credential type");
                                }
                            } catch (Exception e) {
                                call.reject("GOOGLE_SIGNIN_UNAVAILABLE: " + e.getMessage());
                            }
                        }

                        @Override
                        public void onError(GetCredentialException e) {
                            String type = e.getType() == null ? "" : e.getType();
                            if (type.contains("CANCELED") || type.contains("CANCELLED") || type.contains("USER_CANCELED")) {
                                call.reject("GOOGLE_SIGNIN_CANCELLED: user closed the account chooser");
                            } else if (type.contains("NO_CREDENTIAL")) {
                                call.reject("GOOGLE_SIGNIN_NO_ACCOUNT: no Google account is set up on this device");
                            } else {
                                call.reject("GOOGLE_SIGNIN_UNAVAILABLE: " + type + (e.getMessage() != null ? " — " + e.getMessage() : ""));
                            }
                        }
                    });
        } catch (Exception e) {
            call.reject("GOOGLE_SIGNIN_UNAVAILABLE: " + e.getMessage());
        } catch (Throwable t) {
            call.reject("GOOGLE_SIGNIN_UNAVAILABLE: " + t.getClass().getSimpleName());
        }
    }

    /**
     * GetCredentialRequest.Builder construction via reflection: the Java
     * builder surface of androidx.credentials changed between releases
     * (Builder(CredentialOption) vs Builder()+addCredentialOption); both
     * shapes are supported here so either library version compiles/runs.
     */
    private GetCredentialRequest buildCredentialRequest(CredentialOption option) throws Exception {
        Class<?> builderClass = GetCredentialRequest.Builder.class;
        for (Constructor<?> ctor : builderClass.getConstructors()) {
            if (ctor.getParameterCount() == 1
                    && ctor.getParameterTypes()[0].isAssignableFrom(option.getClass())) {
                Object builder = ctor.newInstance(option);
                return (GetCredentialRequest) builderClass.getMethod("build").invoke(builder);
            }
        }
        Object builder = builderClass.getConstructor().newInstance();
        builderClass.getMethod("addCredentialOption", CredentialOption.class).invoke(builder, option);
        return (GetCredentialRequest) builderClass.getMethod("build").invoke(builder);
    }

    /**
     * Locate CredentialManager#getCredentialAsync(Context, request,
     * cancellationToken, executor, callback) — the Java interop entry point —
     * without hard-coding the CancellationToken parameter type (nullable and
     * version-dependent; we always pass null).
     */
    private Method findGetCredentialAsync() {
        for (Method m : CredentialManager.class.getMethods()) {
            if (!"getCredentialAsync".equals(m.getName())) continue;
            Class<?>[] params = m.getParameterTypes();
            if (params.length == 5
                    && android.content.Context.class.isAssignableFrom(params[0])
                    && params[1].isAssignableFrom(GetCredentialRequest.class)
                    && params[3] == java.util.concurrent.Executor.class
                    && params[4].isInterface()) {
                return m;
            }
        }
        return null;
    }

    private static String sha256Hex(String value) {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            byte[] digest = md.digest((value == null ? "" : value).getBytes("UTF-8"));
            StringBuilder sb = new StringBuilder();
            for (byte b : digest) sb.append(String.format("%02x", b));
            return sb.toString();
        } catch (Exception e) {
            return "";
        }
    }

    // ── genuinely-external hand-off (unchanged behaviour) ──────────────

    @PluginMethod
    public void openExternal(PluginCall call) {
        String url = call.getString("url", "");
        if (!isHttpUrl(url)) {
            call.reject("Only http(s) links can be opened");
            return;
        }
        try {
            Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
            intent.addCategory(Intent.CATEGORY_BROWSABLE);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            call.resolve();
        } catch (ActivityNotFoundException e) {
            call.reject("No app on this device can open that link");
        } catch (Exception e) {
            call.reject("Could not open link: " + e.getMessage());
        }
    }

    @PluginMethod
    public void download(PluginCall call) {
        String url = call.getString("url", "");
        if (!isHttpUrl(url)) {
            call.reject("Only http(s) downloads are allowed");
            return;
        }
        String fileName = sanitizeName(call.getString("fileName", ""));
        try {
            DownloadManager dm = (DownloadManager) getContext().getSystemService(Context.DOWNLOAD_SERVICE);
            if (dm == null) {
                call.reject("DownloadManager is unavailable");
                return;
            }
            DownloadManager.Request request = new DownloadManager.Request(Uri.parse(url));
            request.setTitle(fileName);
            request.setNotificationVisibility(
                DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            String extension = MimeTypeMap.getFileExtensionFromUrl(Uri.parse(url).toString());
            String mime = extension == null || extension.isEmpty()
                ? "application/pdf"
                : MimeTypeMap.getSingleton().getMimeTypeFromExtension(extension.toLowerCase());
            request.setMimeType(mime == null || mime.isEmpty() ? "application/pdf" : mime);
            request.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, fileName);
            long id = dm.enqueue(request);
            JSObject ret = new JSObject();
            ret.put("downloadId", id);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("Download failed: " + e.getMessage());
        }
    }

    @PluginMethod
    public void share(PluginCall call) {
        String title = call.getString("title", "");
        String text = call.getString("text", "");
        String url = call.getString("url", "");

        StringBuilder body = new StringBuilder();
        if (text != null && !text.isEmpty()) {
            body.append(text);
        } else if (title != null && !title.isEmpty()) {
            body.append(title);
        }
        if (url != null && !url.isEmpty() && body.indexOf(url) == -1) {
            if (body.length() > 0) body.append('\n');
            body.append(url);
        }
        if (body.length() == 0) {
            call.reject("Nothing to share");
            return;
        }

        Intent send = new Intent(Intent.ACTION_SEND);
        send.setType("text/plain");
        if (title != null && !title.isEmpty()) send.putExtra(Intent.EXTRA_SUBJECT, title);
        send.putExtra(Intent.EXTRA_TEXT, body.toString());
        Intent chooser = Intent.createChooser(
            send,
            (title == null || title.isEmpty()) ? "Share via" : title);
        chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            getContext().startActivity(chooser);
            call.resolve();
        } catch (Exception e) {
            call.reject("Share sheet unavailable");
        }
    }

    @PluginMethod
    public void getLaunchUrl(PluginCall call) {
        String url = "";
        Intent intent = getActivity() != null ? getActivity().getIntent() : null;
        if (intent != null && Intent.ACTION_VIEW.equals(intent.getAction()) && intent.getData() != null) {
            url = intent.getData().toString();
        }
        JSObject ret = new JSObject();
        ret.put("url", url);
        call.resolve(ret);
    }

    /**
     * Push a warm-start deep link into the running app (called by MainActivity
     * from onNewIntent). Retained until the JS listener attaches, so a link
     * that arrives during a cold start is delivered, not dropped.
     */
    public void emitSiteLink(String url) {
        JSObject payload = new JSObject();
        payload.put("url", url);
        notifyListeners("siteDeepLink", payload, true);
    }

    @PluginMethod
    public void getAppVersion(PluginCall call) {
        try {
            android.content.pm.PackageInfo info = getContext().getPackageManager().getPackageInfo(getContext().getPackageName(), 0);
            JSObject result = new JSObject();
            result.put("versionName", info.versionName == null ? "" : info.versionName);
            result.put("versionCode", android.os.Build.VERSION.SDK_INT >= 28 ? info.getLongVersionCode() : info.versionCode);
            call.resolve(result);
        } catch (Exception e) { call.reject("Unable to read installed app version"); }
    }

    // ── in-app updater: GitHub release APK → verify → package installer ──

    // One download/install at a time: a second tap (or a watchdog retry that
    // races a slow first attempt) must never corrupt the in-flight download.
    private final AtomicBoolean updaterBusy = new AtomicBoolean(false);

    private static final int CONNECT_TIMEOUT_MS = 15000;
    private static final int READ_TIMEOUT_MS = 30000;
    /** Progress event cadence during the download phase (~12 ticks for a 5.7 MB APK). */
    private static final long PROGRESS_EVERY_BYTES = 512 * 1024;
    private static final String DOWNLOAD_USER_AGENT = "DSMNRU-PYQ-android-updater";

    /**
     * In-app update: download the GitHub release APK into the app cache,
     * VERIFY it, then hand it to the Android package installer.
     *
     * The phases are streamed to JS through `updateDownloadProgress` events
     * (phase: download → verify → install) so the updater UI follows REAL
     * bytes, and EVERY terminal path resolves or rejects the plugin call
     * EXACTLY ONCE — including Throwables that are not Exceptions. The JS
     * layer must never be left sitting on "Downloading…" forever.
     *
     * Security (see UpdateUrlPolicy): HTTPS GitHub release URLs only — the
     * initial URL must be github.com or objects.githubusercontent.com, and
     * redirects are followed by hand so every hop is re-validated against
     * GitHub's own asset CDN (never a scheme downgrade, never another host).
     * JS may pass `expectedVersionCode`; the downloaded archive is parsed
     * with PackageManager and rejected unless it IS that exact release.
     */
    @PluginMethod
    public void downloadAndInstall(PluginCall call) {
        String source = call.getString("url", "");
        String fileName = UpdateUrlPolicy.sanitizeApkFileName(call.getString("fileName", ""), "dsmnru-update.apk");
        int expectedVersionCode = 0;
        Object rawExpected = call.getData() == null ? null : call.getData().get("expectedVersionCode");
        if (rawExpected instanceof Number) expectedVersionCode = ((Number) rawExpected).intValue();

        if (!UpdateUrlPolicy.isTrustedUpdateUrl(source)) {
            call.reject("UPDATE_URL_UNTRUSTED: only official GitHub release downloads can be installed");
            return;
        }
        if (!updaterBusy.compareAndSet(false, true)) {
            call.reject("UPDATE_BUSY: an update is already downloading — try again in a moment");
            return;
        }

        final Context appContext = getContext().getApplicationContext();
        final File apkFile = new File(appContext.getCacheDir(), fileName);
        final File partFile = new File(appContext.getCacheDir(), fileName + ".part");
        final int expected = expectedVersionCode;
        // A plugin call is answered exactly once, even if an unexpected
        // Throwable (not an Exception) escapes somewhere below.
        final AtomicBoolean answered = new AtomicBoolean(false);

        Executors.newSingleThreadExecutor().execute(() -> {
            try {
                // ── phase 1: DOWNLOAD (or reuse a fully-verified APK from a
                // previous attempt — e.g. the user just granted the
                // "Install unknown apps" permission and tapped retry) ──────
                long contentLength = -1;
                if (apkFile.isFile()) {
                    try {
                        verifyApk(appContext, apkFile, -1, expected);
                        contentLength = apkFile.length();
                        emitProgress("download", contentLength, contentLength);
                    } catch (IOException notReusable) {
                        apkFile.delete(); // stale/corrupt leftover — download fresh
                    }
                }
                if (!apkFile.isFile()) {
                    partFile.delete(); // never resume into a stale partial file
                    contentLength = downloadTo(source, partFile);
                }

                // ── phase 2: VERIFY, then atomically promote .part → .apk ──
                if (partFile.exists()) {
                    emitProgress("verify", partFile.length(), contentLength);
                    verifyApk(appContext, partFile, contentLength, expected);
                    if (!partFile.renameTo(apkFile)) {
                        partFile.delete();
                        throw new IOException("UPDATE_INVALID_APK: could not finalize the downloaded update");
                    }
                }

                // ── phase 3: INSTALL — launch the system installer on the
                // main thread, and wait for its real outcome ───────────────
                emitProgress("install", apkFile.length(), apkFile.length());
                final AtomicReference<String> launchError = new AtomicReference<>(null);
                final CountDownLatch launched = new CountDownLatch(1);
                ContextCompat.getMainExecutor(appContext).execute(() -> {
                    try {
                        launchError.set(startPackageInstaller(appContext, apkFile));
                    } catch (Throwable t) {
                        launchError.set("UPDATE_INSTALL_FAILED: " + safeMessage(t));
                    } finally {
                        launched.countDown();
                    }
                });
                if (!launched.await(15, TimeUnit.SECONDS)) {
                    throw new IOException("UPDATE_INSTALL_FAILED: the installer did not respond");
                }
                String error = launchError.get();
                if (error != null) throw new IOException(error);

                JSObject done = new JSObject();
                done.put("ok", true);
                done.put("installerOpened", true);
                resolveOnce(answered, call, done);
            } catch (Throwable t) {
                // ANY failure — network, verification, or installer — must
                // reach JS as a rejection. A partially downloaded or invalid
                // file is deleted; a VERIFIED apk is kept so an immediate
                // retry (e.g. after granting the install permission) can
                // skip straight to the installer.
                partFile.delete();
                rejectOnce(answered, call, safeMessage(t));
            } finally {
                updaterBusy.set(false);
            }
        });
    }

    /**
     * Stream the release APK to {@code part}, following redirects BY HAND so
     * every hop is re-validated (GitHub release downloads redirect from
     * github.com to its *.githubusercontent.com asset CDN). Returns the
     * server's Content-Length (-1 when absent).
     */
    private long downloadTo(String source, File part) throws IOException {
        String current = source;
        for (int hop = 0; hop <= UpdateUrlPolicy.MAX_REDIRECTS; hop++) {
            if (!UpdateUrlPolicy.isTrustedRedirectTarget(current)) {
                throw new IOException("UPDATE_DOWNLOAD_FAILED: untrusted download URL");
            }
            HttpURLConnection connection = (HttpURLConnection) new URL(current).openConnection();
            try {
                connection.setConnectTimeout(CONNECT_TIMEOUT_MS);
                connection.setReadTimeout(READ_TIMEOUT_MS);
                // Manual redirect handling — the silent default would follow
                // ANY Location header without re-validation.
                connection.setInstanceFollowRedirects(false);
                connection.setRequestProperty("User-Agent", DOWNLOAD_USER_AGENT);
                int status = connection.getResponseCode();
                if (status >= 300 && status < 400) {
                    String location = connection.getHeaderField("Location");
                    if (location == null || location.isEmpty()) {
                        throw new IOException("UPDATE_DOWNLOAD_FAILED: HTTP " + status + " redirect without a target");
                    }
                    current = new URL(new URL(current), location).toString(); // resolve relative Location too
                    continue;
                }
                if (status < 200 || status >= 300) {
                    throw new IOException("UPDATE_DOWNLOAD_FAILED: HTTP " + status);
                }
                long total = connection.getContentLengthLong();
                long written = 0;
                long nextTick = 0;
                emitProgress("download", 0, total);
                try (InputStream in = connection.getInputStream();
                     FileOutputStream out = new FileOutputStream(part)) {
                    byte[] buffer = new byte[16384];
                    int read;
                    while ((read = in.read(buffer)) >= 0) {
                        out.write(buffer, 0, read);
                        written += read;
                        if (written > UpdateUrlPolicy.MAX_APK_BYTES) {
                            throw new IOException("UPDATE_DOWNLOAD_FAILED: download exceeds any possible release APK");
                        }
                        if (written >= nextTick) {
                            nextTick = written + PROGRESS_EVERY_BYTES;
                            emitProgress("download", written, total);
                        }
                    }
                    out.flush();
                } // streams closed HERE — reaching 100% is not "done" until this ran
                emitProgress("download", written, total); // the real 100% tick
                if (!UpdateUrlPolicy.isPlausibleApkSize(written, total)) {
                    throw new IOException(total > 0
                            ? "UPDATE_DOWNLOAD_FAILED: incomplete download (" + written + " of " + total + " bytes)"
                            : "UPDATE_DOWNLOAD_FAILED: downloaded file is implausibly small");
                }
                return total;
            } finally {
                connection.disconnect();
            }
        }
        throw new IOException("UPDATE_DOWNLOAD_FAILED: too many redirects");
    }

    /**
     * Prove the file is really the expected, installable APK BEFORE any
     * installer intent exists: exists → plausible size → ZIP magic → full
     * PackageManager parse (and, when JS supplied one, the exact expected
     * versionCode). A single cheap parse for a ~5.7 MB asset; on failure the
     * caller deletes the file and JS receives UPDATE_INVALID_APK.
     */
    private void verifyApk(Context context, File apk, long contentLength, int expectedVersionCode) throws IOException {
        if (!apk.isFile()) throw new IOException("UPDATE_INVALID_APK: downloaded update file is missing");
        long size = apk.length();
        if (!UpdateUrlPolicy.isPlausibleApkSize(size, contentLength)) {
            throw new IOException("UPDATE_INVALID_APK: unexpected file size (" + size + " bytes)");
        }
        try (RandomAccessFile raf = new RandomAccessFile(apk, "r")) {
            byte[] magic = new byte[4];
            if (raf.read(magic) < 4 || !UpdateUrlPolicy.looksLikeZip(magic, 4)) {
                throw new IOException("UPDATE_INVALID_APK: file is not an Android package");
            }
        }
        PackageManager pm = context.getPackageManager();
        PackageInfo info = pm.getPackageArchiveInfo(apk.getAbsolutePath(), 0);
        if (info == null || info.packageName == null || info.packageName.isEmpty()) {
            throw new IOException("UPDATE_INVALID_APK: Android could not parse the package");
        }
        if (expectedVersionCode > 0) {
            long code = Build.VERSION.SDK_INT >= 28 ? info.getLongVersionCode() : info.versionCode;
            if (code != expectedVersionCode) {
                throw new IOException("UPDATE_INVALID_APK: package is version code " + code + ", expected " + expectedVersionCode);
            }
        }
    }

    /**
     * Hand a VERIFIED apk to the system package installer. Runs on the MAIN
     * thread. Returns null when the installer activity was launched, or a
     * machine-readable "CODE: human message" the JS layer can act on.
     */
    private String startPackageInstaller(Context context, File apk) {
        Uri uri;
        try {
            uri = FileProvider.getUriForFile(context, context.getPackageName() + ".fileprovider", apk);
        } catch (IllegalArgumentException e) {
            return "UPDATE_INSTALL_FAILED: downloaded update could not be shared with the installer";
        }
        // Android 8+ refuses sideloaded installs until the user allows THIS
        // app to "install unknown apps". Detect it and open the EXACT
        // settings screen instead of failing opaquely — after granting, the
        // retry skips straight to the installer (the verified apk is kept).
        if (Build.VERSION.SDK_INT >= 26) {
            boolean canInstall = false;
            try {
                canInstall = context.getPackageManager().canRequestPackageInstalls();
            } catch (Exception e) {
                canInstall = false;
            }
            if (!canInstall) {
                try {
                    Intent settings = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                            Uri.parse("package:" + context.getPackageName()));
                    settings.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    context.startActivity(settings);
                    return "UPDATE_INSTALL_PERMISSION_REQUIRED: allow \"Install unknown apps\" for DSMNRU PYQ, then tap Try again";
                } catch (Throwable settingsUnavailable) {
                    return "UPDATE_INSTALL_PERMISSION_REQUIRED: enable \"Install unknown apps\" for DSMNRU PYQ in system settings, then tap Try again";
                }
            }
        }
        Intent install = new Intent(Intent.ACTION_VIEW);
        install.setDataAndType(uri, "application/vnd.android.package-archive");
        install.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            context.startActivity(install);
            return null;
        } catch (ActivityNotFoundException noInstaller) {
            return "UPDATE_INSTALL_FAILED: no package installer is available on this device";
        } catch (Exception e) {
            return "UPDATE_INSTALL_FAILED: " + safeMessage(e);
        }
    }

    /** Real progress for the JS updater UI (never faked; total may be -1). */
    private void emitProgress(String phase, long bytes, long total) {
        JSObject data = new JSObject();
        data.put("phase", phase);
        data.put("bytes", bytes);
        data.put("total", total);
        notifyListeners("updateDownloadProgress", data);
    }

    /** A plugin call is answered EXACTLY once — never twice, never never. */
    private static void resolveOnce(AtomicBoolean answered, PluginCall call, JSObject data) {
        if (answered.compareAndSet(false, true)) call.resolve(data);
    }

    private static void rejectOnce(AtomicBoolean answered, PluginCall call, String message) {
        if (answered.compareAndSet(false, true)) call.reject(message);
    }

    private static String safeMessage(Throwable t) {
        if (t == null) return "unknown error";
        String message = t.getMessage();
        return (message == null || message.isEmpty()) ? t.getClass().getSimpleName() : message;
    }

    private boolean isHttpUrl(String url) {
        return url != null
            && (url.startsWith("https://") || url.startsWith("http://"))
            && URLUtil.isValidUrl(url);
    }

    /** Keep share/download file names safe for the public Downloads dir. */
    private String sanitizeName(String raw) {
        String name = raw == null ? "" : raw.trim();
        if (name.isEmpty()) name = "dsmnru-paper.pdf";
        name = name.replaceAll("[^A-Za-z0-9 ._\\-]", "_");
        if (name.length() > 96) name = name.substring(0, 96);
        if (!name.matches(".*\\.[A-Za-z0-9]{1,5}$")) name = name + ".pdf";
        return name;
    }
}
