package com.dsmnru.pyq;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.app.DownloadManager;
import android.os.Environment;
import android.webkit.MimeTypeMap;
import android.webkit.URLUtil;

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
