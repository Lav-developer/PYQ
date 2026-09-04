/**
 * DSMNRU PYQ — centralized Android APK release configuration.
 *
 * This is the ONLY place the website points at the Android release artifact.
 * The APK itself is built and published from the `android-app` branch; never
 * commit an APK binary here.
 *
 * ── HOW TO UPDATE (Android release flow) ─────────────────────────────
 *
 * 1. A new Android build is released on the `android-app` branch and its
 *    signed `dsmnru-pyq.apk` is published as a GitHub Release asset (see
 *    docs/android-notification-integration.md § APK release flow).
 * 2. Set `releaseUrl` below to that release asset's direct download URL,
 *    e.g.:
 *      https://github.com/Lav-developer/PYQ/releases/download/v1.4.0/dsmnru-pyq.apk
 * 3. Update `versionName` / `versionCode` / `fileSize` / `releasedAt`
 *    to match the new release.
 * 4. Deploy the site. Netlify serves this file with
 *    `Cache-Control: max-age=0, must-revalidate` (see netlify.toml), so the
 *    new link is picked up immediately on the next page load.
 *
 * ── CURRENT STATE ────────────────────────────────────────────────────
 *
 * The android-app GitHub Actions workflow currently uploads the release
 * APK as a workflow *artifact* only (it does NOT create a GitHub
 * Release). Until that workflow change is made on the android-app branch,
 * there is intentionally NO stable public release URL. The download page
 * therefore stays functional but disables the CTA until `releaseUrl` is
 * set — it never invents or points at a fake link.
 */
window.DSMNRU_APK = {
    // Direct URL of the GitHub Release asset `dsmnru-pyq.apk`.
    releaseUrl: 'https://github.com/Lav-developer/PYQ/releases/download/v1.4.0/dsmnru-pyq.apk',

    // Version metadata currently known from the android-app branch
    // (android-app/android/app/build.gradle). Update on each release.
    versionName: '1.4.0',
    versionCode: 11,

    // Minimum Android version from the Android project
    // (android-app/android/variables.gradle → minSdkVersion = 24).
    minAndroid: 'Android 7.0 (API 24) or newer',

    // Fill these in once the first GitHub Release asset exists.
    fileSize: '5 MB',      // e.g. '18 MB' — only when known reliably
    releasedAt: '2026-09-04',    // e.g. '2026-09-04' — only when known
    releaseNotesUrl: ''  // e.g. the GitHub Release page URL
};
