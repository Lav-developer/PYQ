package com.dsmnru.pyq;

import java.net.URL;
import java.util.Locale;

/**
 * DSMNRU PYQ — pure-JDK security policy for the in-app updater's
 * download/install phase.
 *
 * Deliberately contains NO android.* imports so the class (and its JUnit
 * test) runs on the plain JVM under `gradlew :app:testDebugUnitTest`
 * without an emulator. DsmnruAppPlugin.downloadAndInstall consults this
 * class for EVERY security-relevant decision:
 *
 *  • which initial URLs may be downloaded (the Worker-supplied GitHub
 *    release asset URL — same allowlist as update.js);
 *  • which redirect hops may be followed (GitHub's own HTTPS asset CDN);
 *  • what a safe APK cache-file name looks like (always ends in .apk);
 *  • what a sane APK size is before the file is handed to the installer.
 */
final class UpdateUrlPolicy {

    private UpdateUrlPolicy() {}

    /** Hosts a release asset may ORIGINATE from (mirrors update.js regex). */
    static final String INITIAL_HOST_GITHUB = "github.com";
    static final String INITIAL_HOST_OBJECTS = "objects.githubusercontent.com";

    /**
     * Redirects are followed BY HAND (setInstanceFollowRedirects(false)) so
     * every hop can be re-validated — HttpURLConnection's silent default
     * would go anywhere the Location header says. GitHub release downloads
     * redirect from github.com to its asset CDN subdomains (objects. and
     * release-assets.) of githubusercontent.com: HTTPS, GitHub-owned,
     * never an arbitrary host, never a scheme downgrade.
     */
    static final String REDIRECT_HOST_SUFFIX = ".githubusercontent.com";

    /** Upper bound on hand-followed redirects (GitHub needs exactly one). */
    static final int MAX_REDIRECTS = 5;

    /**
     * Plausibility bounds for this app's release APK (the real v1.4.2 asset
     * is ~5.7 MB). Catches HTML error pages, truncated downloads and
     * runaway writes BEFORE anything is handed to the package installer.
     */
    static final long MIN_APK_BYTES = 64 * 1024;
    static final long MAX_APK_BYTES = 512L * 1024 * 1024;

    /**
     * True when {@code url} is an HTTPS URL on a host the app downloads
     * updates FROM (the exact release-asset allowlist; credentials embedded
     * in the URL are rejected).
     */
    static boolean isTrustedUpdateUrl(String url) {
        return isHttpsOnTrustedHost(url, false);
    }

    /**
     * True when a redirect Location may be followed: HTTPS on github.com or
     * any githubusercontent.com subdomain (GitHub-owned asset CDN).
     */
    static boolean isTrustedRedirectTarget(String url) {
        return isHttpsOnTrustedHost(url, true);
    }

    private static boolean isHttpsOnTrustedHost(String url, boolean allowGithubusercontentCdn) {
        if (url == null || url.isEmpty()) return false;
        try {
            URL parsed = new URL(url);
            if (!"https".equalsIgnoreCase(parsed.getProtocol())) return false;
            if (parsed.getUserInfo() != null) return false; // never user:pass@host
            String host = parsed.getHost() == null ? "" : parsed.getHost().toLowerCase(Locale.ROOT);
            if (host.isEmpty()) return false;
            if (INITIAL_HOST_GITHUB.equals(host) || INITIAL_HOST_OBJECTS.equals(host)) return true;
            return allowGithubusercontentCdn
                    && host.length() > REDIRECT_HOST_SUFFIX.length()
                    && host.endsWith(REDIRECT_HOST_SUFFIX);
        } catch (Exception malformed) {
            return false;
        }
    }

    /**
     * Flatten a JS-supplied file name to a safe cache file that ALWAYS ends
     * in .apk — the package installer path in the FileProvider URI. Path
     * separators and other unsafe characters are replaced, the name is
     * length-capped (keeping the tail so an extension survives) and any
     * non-.apk extension is replaced with .apk.
     */
    static String sanitizeApkFileName(String raw, String fallback) {
        String name = raw == null ? "" : raw.trim();
        if (name.isEmpty()) {
            name = (fallback == null || fallback.trim().isEmpty()) ? "dsmnru-update.apk" : fallback.trim();
        }
        name = name.replaceAll("[^A-Za-z0-9 ._\\-]", "_");
        if (name.length() > 96) name = name.substring(name.length() - 96);
        if (!name.toLowerCase(Locale.ROOT).endsWith(".apk")) {
            int dot = name.lastIndexOf('.');
            if (dot > 0) name = name.substring(0, dot); // replace wrong extension
            name = name + ".apk";
        }
        return name;
    }

    /**
     * True when {@code bytes} is a sane size for this app's release APK:
     * within the floor/ceiling, and — when the server sent a length — the
     * EXACT length (a truncated download must never reach the installer).
     * {@code contentLength <= 0} means "unknown" and skips the exact match.
     */
    static boolean isPlausibleApkSize(long bytes, long contentLength) {
        if (bytes < MIN_APK_BYTES || bytes > MAX_APK_BYTES) return false;
        return contentLength <= 0 || bytes == contentLength;
    }

    /** ZIP local-file-header magic — the fastest "is this even an APK" sniff. */
    static boolean looksLikeZip(byte[] header, int length) {
        return length >= 4 && header[0] == 'P' && header[1] == 'K' && header[2] == 0x03 && header[3] == 0x04;
    }
}
