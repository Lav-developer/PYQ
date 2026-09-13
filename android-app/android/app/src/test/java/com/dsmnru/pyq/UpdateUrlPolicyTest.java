package com.dsmnru.pyq;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/**
 * Plain-JVM behaviour tests for the in-app updater's download security
 * policy ({@link UpdateUrlPolicy} — pure JDK, no Android APIs, so this runs
 * under `gradlew :app:testDebugUnitTest` without an emulator).
 *
 * Covers the updater-fix requirements: trusted GitHub URLs, rejected
 * untrusted/HTTP URLs, redirect-hop validation, .apk file-name sanitizing,
 * APK size plausibility (including the real v1.4.2 asset size) and ZIP
 * magic detection.
 */
public class UpdateUrlPolicyTest {

    // ── trusted INITIAL download URLs ───────────────────────────────────

    @Test
    public void acceptsTrustedGithubReleaseUrls() {
        assertTrue(UpdateUrlPolicy.isTrustedUpdateUrl(
                "https://github.com/Lav-developer/PYQ/releases/download/v1.4.2/dsmnru-pyq.apk"));
        assertTrue(UpdateUrlPolicy.isTrustedUpdateUrl(
                "https://objects.githubusercontent.com/github-production-release-asset-2e65be/977278444/a?X-Amz-Signature=abc"));
    }

    @Test
    public void rejectsNullEmptyAndMalformedUrls() {
        assertFalse(UpdateUrlPolicy.isTrustedUpdateUrl(null));
        assertFalse(UpdateUrlPolicy.isTrustedUpdateUrl(""));
        assertFalse(UpdateUrlPolicy.isTrustedUpdateUrl("not a url"));
    }

    @Test
    public void rejectsUntrustedSchemesAndHosts() {
        // plain HTTP is never allowed
        assertFalse(UpdateUrlPolicy.isTrustedUpdateUrl(
                "http://github.com/Lav-developer/PYQ/releases/download/v1.4.2/dsmnru-pyq.apk"));
        assertFalse(UpdateUrlPolicy.isTrustedUpdateUrl("http://objects.githubusercontent.com/x.apk"));
        // arbitrary domains and look-alike hosts
        assertFalse(UpdateUrlPolicy.isTrustedUpdateUrl("https://evil.example.com/dsmnru-pyq.apk"));
        assertFalse(UpdateUrlPolicy.isTrustedUpdateUrl("https://github.com.evil.example.com/dsmnru-pyq.apk"));
        assertFalse(UpdateUrlPolicy.isTrustedUpdateUrl("https://githubusercontent.com/x.apk"));
        // embedded credentials
        assertFalse(UpdateUrlPolicy.isTrustedUpdateUrl("https://user:pass@github.com/x.apk"));
        // non-http(s) schemes
        assertFalse(UpdateUrlPolicy.isTrustedUpdateUrl("file:///data/local/tmp/malicious.apk"));
        // CDN subdomains are redirect targets only, never initial sources
        assertFalse(UpdateUrlPolicy.isTrustedUpdateUrl(
                "https://raw.githubusercontent.com/Lav-developer/PYQ/main/x.apk"));
    }

    // ── redirect hops (followed by hand, re-validated per hop) ──────────

    @Test
    public void acceptsGithubOwnedRedirectTargets() {
        assertTrue(UpdateUrlPolicy.isTrustedRedirectTarget(
                "https://objects.githubusercontent.com/github-production-release-asset-2e65be/977278444/a?sig=1"));
        assertTrue(UpdateUrlPolicy.isTrustedRedirectTarget(
                "https://release-assets.githubusercontent.com/github-production-release-asset/a?sig=1"));
        assertTrue(UpdateUrlPolicy.isTrustedRedirectTarget(
                "https://github.com/Lav-developer/PYQ/releases/download/v1.4.2/dsmnru-pyq.apk"));
    }

    @Test
    public void rejectsUntrustedRedirectTargets() {
        assertFalse(UpdateUrlPolicy.isTrustedRedirectTarget("http://objects.githubusercontent.com/x")); // downgrade
        assertFalse(UpdateUrlPolicy.isTrustedRedirectTarget("https://objects.githubusercontent.com.evil.com/x"));
        assertFalse(UpdateUrlPolicy.isTrustedRedirectTarget("https://evil.com/?u=https://github.com"));
        assertFalse(UpdateUrlPolicy.isTrustedRedirectTarget(null));
    }

    // ── APK cache-file names always end in .apk ─────────────────────────

    @Test
    public void apkFileNamesAreSanitizedAndAlwaysEndInApk() {
        assertEquals("dsmnru-pyq-1.4.2.apk",
                UpdateUrlPolicy.sanitizeApkFileName("dsmnru-pyq-1.4.2.apk", "dsmnru-update.apk"));
        assertEquals("dsmnru-update.apk", UpdateUrlPolicy.sanitizeApkFileName("", "dsmnru-update.apk"));
        assertEquals("dsmnru-update.apk", UpdateUrlPolicy.sanitizeApkFileName(null, null));
        assertEquals("weird name_.apk", UpdateUrlPolicy.sanitizeApkFileName("weird name?.apk", "dsmnru-update.apk"));
        assertEquals(".._.._etc_passwd.apk", UpdateUrlPolicy.sanitizeApkFileName("../../etc/passwd.apk", "dsmnru-update.apk"));
        // a wrong extension is REPLACED, and a missing one is appended
        assertEquals("update.apk", UpdateUrlPolicy.sanitizeApkFileName("update.pdf", "dsmnru-update.apk"));
        assertEquals("update.apk", UpdateUrlPolicy.sanitizeApkFileName("update", "dsmnru-update.apk"));
    }

    // ── APK size plausibility ───────────────────────────────────────────

    @Test
    public void plausibleApkSizes() {
        assertTrue(UpdateUrlPolicy.isPlausibleApkSize(5704283L, 5704283L)); // the REAL v1.4.2 asset
        assertTrue(UpdateUrlPolicy.isPlausibleApkSize(5704283L, -1L));      // unknown length → skip exact match
        assertFalse(UpdateUrlPolicy.isPlausibleApkSize(0L, -1L));           // empty file
        assertFalse(UpdateUrlPolicy.isPlausibleApkSize(1024L, -1L));        // below floor (HTML error page)
        assertFalse(UpdateUrlPolicy.isPlausibleApkSize(5704282L, 5704283L)); // truncated by one byte
        assertFalse(UpdateUrlPolicy.isPlausibleApkSize(Long.MAX_VALUE, -1L)); // runaway write
    }

    // ── ZIP magic (fast "is this even an APK" sniff) ────────────────────

    @Test
    public void zipMagicDetection() {
        assertTrue(UpdateUrlPolicy.looksLikeZip(new byte[]{'P', 'K', 3, 4, 0, 0}, 6));
        assertFalse(UpdateUrlPolicy.looksLikeZip(new byte[]{'<', 'h', 't', 'm', 'l'}, 5)); // an error page is not an APK
        assertFalse(UpdateUrlPolicy.looksLikeZip(new byte[]{'P', 'K'}, 2));
    }

    // ── redirect budget ─────────────────────────────────────────────────

    @Test
    public void redirectBudgetIsBoundedAndSufficient() {
        assertTrue(UpdateUrlPolicy.MAX_REDIRECTS > 0);
        assertTrue(UpdateUrlPolicy.MAX_REDIRECTS <= 10); // bounded; GitHub needs exactly one
    }
}
