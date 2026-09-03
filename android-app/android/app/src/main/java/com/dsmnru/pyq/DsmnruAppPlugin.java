package com.dsmnru.pyq;

import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.app.DownloadManager;
import android.os.Environment;
import android.webkit.MimeTypeMap;
import android.webkit.URLUtil;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * DSMNRU PYQ — the app's own tiny native layer (no npm plugin, no third-party
 * dependency). These are the operations a mobile web page simply cannot do
 * inside a WebView; everything else stays in the app's own JS front-end.
 *
 *  • openExternal  → hand a file/host link to the best Android handler
 *                    (browser, Drive, PDF viewer…). Reuses the existing PDF
 *                    hosts; the app never mirrors PDFs into its own storage.
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
