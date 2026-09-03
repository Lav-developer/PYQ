# DSMNRU PYQ — Android App (dedicated mobile UI)

A **real, app-specific Android interface** for the DSMNRU PYQ / Syllabus
Archive — *not* a WebView wrapper around the website. The app bundles its own
mobile-first front-end in `www/` (bottom navigation, app-designed screens,
touch-sized cards and sheets) while sharing the website's existing backends
verbatim:

```
Android app (bundled UI)
   ├── Cloudflare Worker API  https://dsmnru-pyq-api.kush210431-cloudflare.workers.dev/api/*
   │        └── same KV search index / pagination / cache the website uses
   └── Firebase Auth (project `dsmnru-data`, same accounts as the site)
            └── Identity Toolkit REST for in-app email/password sign-in
```

There is **no second backend, no second database, no duplicate PYQ storage**
and no app-specific business data. Public archive data never reads Firestore;
the only Firestore touch-point in the entire app is the one-time
`users/{uid}` profile-row sync immediately after a manual sign-in (the same
record the website's `ensureUserDocumentSynced` creates).

## Contents

| Path | Purpose |
| --- | --- |
| `www/index.html` | App shell: app bar, routed view, bottom nav, sheets/toasts |
| `www/css/app.css` | The app's own dark "DSMNRU academic" design system (safe-area aware, 44px+ targets, no blur/animation bloat) |
| `www/js/app.js` | Shell: view stack router, Android back button, network banner, deep-link handoff, auth gates |
| `www/js/api.js` | Worker API client: TTL cache + persisted layer + in-flight dedupe + SWR + abort/timeout |
| `www/js/auth.js` | Firebase Authentication via Identity Toolkit REST (same project as the website) |
| `www/js/authui.js` | Sign-in / sign-up / reset / email-verification sheets |
| `www/js/store.js` | On-device persistence: saved papers, recent views, recent searches |
| `www/js/slug.js` | Canonical-slug mirror of the Worker's allocator + deep-link URL parser |
| `www/js/views/` | home · search · browse(courses) · course drill-down · paper · saved · profile |
| `www/js/native.js` | Wrapper for the app's own Java plugin (share sheet, downloads, external intents, launch link) |
| `android/app/src/main/java/com/dsmnru/pyq/DsmnruAppPlugin.java` | The custom plugin: ACTION_VIEW / ACTION_SEND / DownloadManager / launch deep-link |
| `android/app/src/main/java/com/dsmnru/pyq/MainActivity.java` | BridgeActivity: registers the plugin, forwards warm-start deep links to the JS router |
| `android/` | Generated + customized Capacitor Android project (Gradle wrapper included) |
| `test/` | Node unit tests + jsdom integration smoke test of the app UI (`npm test`) |

## Screens & navigation

Bottom tabs: **Home · Search · Courses · Saved · Profile**. Paper detail and
course drill-downs are pushed onto an in-app view stack (Android back pops it;
at a tab root, back goes to Home; at Home, back exits — standard behavior).

* **Home** — brand hero + search launcher, archive stats, quick-access course
  grid, "pick up where you left off" (device history), recently added and
  trending rails, and shortcuts (upload/tools/contributors open the live site
  externally). Fed by **one** cached `GET /api/homepage` call.
* **Search** — server-side `GET /api/pyqs/search` (title/subject/course/
  semester/session), 350 ms debounce, previous in-flight query aborted via
  `AbortController`, filter + sort chips, paged results (20/page), full
  loading/empty/error/offline states. Never downloads the archive.
* **Courses** — app-native course grid (catalog + live paper counts) →
  semester/session chips + in-course subject search → paged papers.
* **Paper** — app-designed detail: title, course, semester, session, branch,
  subject, views, date, document id; **Open PDF / Server 2 / Download / Save /
  Share** actions; metadata table; related papers (one filtered request);
  "Open on website" for comments/report flows.
* **Saved** — on-device bookmarks with local filter, works fully offline.
* **Profile** — session state, email-verification flow, device data controls
  (cache refresh/clear), sign-out, about.

## API-request discipline (Cloudflare free tier)

* Every public screen reads the **existing paginated Worker endpoints** with
  the exact same params the website uses — behavior/pagination unchanged.
* `api.js` adds: per-kind TTL memory cache + small persisted layer
  (homepage 10 min, catalog 24 h, opened papers 30 min LRU-24 entries,
  browse pages 5 min, search 3 min), **in-flight dedupe**, and
  **stale-while-revalidate** so tab switches and back-navigation issue zero
  network traffic while a payload is fresh.
* Network failure falls back to the last cached payload (marked "stale" in
  the UI); nothing on the error path re-fires automatically — retry is a
  user tap.
* No polling, no prefetch of unseen pages, no request-per-card, no Firestore
  reads for public data, and no anonymous-startup Firebase traffic at all.
* The `GET /api/pyqs/slug/:slug` lookup used for deep links is an *additive*
  read-only Worker route (same KV index, zero Firestore). Before it is
  deployed, the app transparently falls back to a single title-search request,
  and finally opens the link in the browser.

## PDFs

PDF URLs come from the paper documents themselves (`file`/`server1`,
`file2`/`server2`) — the same links the website shows. "Open" hands the URL to
the system (Chrome/Drive/PDF viewer); "Download" (direct `.pdf` hosts only)
uses Android's DownloadManager into the public *Downloads* folder. Nothing is
mirrored, cached in app storage, or re-hosted.

## Authentication

The existing Firebase project (`dsmnru-data`) with its email/password sign-in,
sign-up, reset and email-verification flows — driven through the public
Identity Toolkit REST endpoints (the same calls the website's SDK makes), so
no popup windows are needed and no new auth system exists. Sessions persist
`idToken/refreshToken` locally and refresh lazily (app resume / expiry), never
on a timer. The website's gate policy is mirrored in-app: verified sign-in is
required for search, filters, page 2+ and PDF actions; metadata browsing stays
public. **Google sign-in cannot run inside embedded WebViews (Google's own
policy — identical to the notice on the website):** the app explains this
explicitly and offers email/password or a one-tap hand-off to the site.

## Deep links

`https://dsmnru-pyq.netlify.app/pyq/<slug>` (and `paper.html?id=…`) shared
links can open the app via the existing unverified intent filters
(cold start reads the launch intent; warm start receives a `siteDeepLink`
event). The JS router validates host + path, resolves the slug to the paper,
and opens the app's own Paper screen; the website's URL behavior is untouched.
Verified App Links (`/.well-known/assetlinks.json`) remain deferred until a
release keystore exists.

## Branding

The app reuses the existing DSMNRU identity: `img/icon-512.png` (site emblem)
is the source for the launcher icon, adaptive icon (foreground at the 66%
safe zone on brand slate `#0F172A`), round icon, and the Android 12 splash
icon; `www/img/emblem.png` is the in-app mark. Colors (slate navy base,
teal→mint gradient, amber accent) and typography hierarchy follow the
website's dark theme — the layout itself is app-only. No third-party icons.

## Building

No Android Studio required:

```bash
npm ci
npx cap sync android
npm test                     # app logic + jsdom UI smoke tests (no Android SDK needed)
cd android && ./gradlew assembleDebug
# APK: android/app/build/outputs/apk/debug/app-debug.apk
```

The GitHub Actions workflow (`.github/workflows/android-apk.yml`) runs the
test job + builds the debug APK in the cloud and uploads it as an artifact —
nothing binary is committed, and no releases are created automatically. A
signed release APK/AAB can be added later via repository secrets
(keystore + `google-services.json` are **never** committed; `build.gradle`
already auto-applies the Google Services plugin when `android/app/google-services.json`
is present at build time).

## Deferred by design

* **FCM notifications** — not implemented yet. Prepared: single-activity
  `MainActivity` already routes link-shaped intents (notification taps can
  reuse `siteDeepLink`), and the Google Services plugin auto-applies when a
  build-time `google-services.json` exists. Admin sends keep using the
  existing web admin panel (no second panel).
* **Release signing** — debug builds only, see above.
* **In-app Google sign-in** — needs a native Google credential flow; until
  then the app shows the documented fallback (see Authentication).
* **View-count increments** — the app intentionally does not write
  `pyqs.views` increments (the website keeps counting); saves stay on-device.
