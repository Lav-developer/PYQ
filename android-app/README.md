# DSMNRU PYQ — Android App (Capacitor)

A lightweight native Android shell around the **existing production DSMNRU PYQ
website** (<https://dsmnru-pyq.netlify.app>, alias <https://dsmnru-pyq.email>).

The app does **not** bundle or fork the frontend. It loads the live website in
a Capacitor WebView, so Home, PYQ browsing, search, filters, course/semester
navigation, paper pages (`/pyq/<slug>` and `/paper.html?id=…`), Firebase
authentication, admin uploads and PDF links behave exactly like the mobile
website — updated the moment the site is updated. There is no second backend,
no second database and no copy of the site logic in this folder.

## Contents

| Path | Purpose |
| --- | --- |
| `package.json` | Capacitor toolchain + the two official plugins used (`@capacitor/app`, `@capacitor/splash-screen`) |
| `capacitor.config.json` | App id/name, remote server URL, allow-navigation list, splash & system-bar config |
| `www/index.html` | Local fallback page (normally unreachable; relaunches the site) |
| `www/offline.html` | Branded offline/error page (`server.errorPath`) shown if the site cannot be reached and no service-worker cache exists |
| `android/` | Generated + customized Capacitor Android project (Gradle wrapper included) |

## How it works

- **UI**: `server.url` points the WebView at `https://dsmnru-pyq.netlify.app`.
  Because `/pyq/*` and `/sitemap.xml` are Netlify rewrites to the Cloudflare
  Worker, the pretty paper routes work in-app with zero changes; the Worker and
  Firebase/Firestore remain the only backend.
- **External links & PDFs**: taps on PDF hosts (Google Drive, catbox,
  MediaFire, archive.org, WhatsApp/Telegram shares, …) leave the WebView and
  are handled by the browser/PDF viewer — identical to the mobile site's
  `window.open(..., '_blank')` behaviour. Nothing is duplicated into app
  storage. Inline PDF preview stays desktop-only (`min-width: 992px`), exactly
  as on the website.
- **Back navigation**: handled natively in `MainActivity` — Android back walks
  the WebView history and exits the app only when the history is exhausted.
- **System bars**: dark brand bars (`#0F172A`). On Android 15+ (enforced
  edge-to-edge) Capacitor's built-in `SystemBars` plugin pads the WebView by
  the system-bar insets because the site does not use `viewport-fit=cover`;
  icon style is forced light via config (`style: DARK`).
- **Offline**: the website's own service worker keeps previously visited pages
  available offline inside the app. On a cold start with no network and no
  cached copy, Capacitor redirects to `www/offline.html`.
- **Deep links**: unverified `https` intent filters for both site hosts, so a
  `dsmnru-pyq.netlify.app/pyq/…` link can be opened with the app
  (`MainActivity` routes it into the WebView). Verified Android App Links
  (`assetlinks.json`) are intentionally deferred until a release keystore
  exists. The website is unaffected either way.
- **App detection**: Capacitor appends `DSMNRU-PYQ-Android` to the user agent;
  `script.js` uses it only to show a friendly notice for Google sign-in
  (Google blocks OAuth popups in embedded WebViews). Email/password auth works
  normally.

## Building

No Android Studio required. From `android-app/`:

```bash
npm ci
npx cap sync android
cd android && ./gradlew assembleDebug
# APK: android/app/build/outputs/apk/debug/app-debug.apk
```

Requirements: Node.js ≥ 20, JDK 21, Android SDK (compileSdk 36 is installed
automatically by Android Studio, or via `sdkmanager "platforms;android-36"`).

The easiest way to get an APK is the GitHub Actions workflow
(`.github/workflows/android-apk.yml`): run **Actions → Android APK → Run
workflow** (or push to the `android-app` branch with changes under
`android-app/`), then download the `dsmnru-pyq-debug-apk` artifact from the
run page. Nothing is committed or released automatically.

## Branding

Launcher icon, adaptive icon (`mipmap-anydpi-v26` + density foregrounds,
`#0F172A` background) and the splash are derived from the site's existing PWA
icons (`img/icon-512.png`, `img/icon-maskable-512.png`), so the app, the
installed PWA and the website share one identity. Splash uses the modern
Android 12 splash API via `androidx.core:core-splashscreen` +
`@capacitor/splash-screen` (short 1.2 s hand-off with a 250 ms fade, dark
background in both light and dark mode; the legacy pre-12 launch theme uses a
`layer-list` with the same emblem).

## Future work (intentionally not done now)

- **FCM notifications** — deliberately not implemented. The project is ready:
  `android/app/build.gradle` already auto-applies the Google Services plugin
  when `android-app/android/app/google-services.json` exists (keep it out of
  git), and `@capacitor/app` is present for notification-open routing. The plan
  is to extend the *existing* web admin panel to send FCM messages; no extra
  admin UI will be added here.
- **Google sign-in in-app** — requires a native Google auth plugin or OAuth
  redirect flow; the app currently directs users to email/password.
- **Verified App Links** — needs `/.well-known/assetlinks.json` on the site
  host signed with the release certificate fingerprint.
- **Release signing** — debug builds only for now; no keystores are committed.
