# DSMNRU PYQ — Android App (dedicated mobile UI)

A **real, app-specific Android interface** for the DSMNRU PYQ / Syllabus
Archive — *not* a WebView wrapper around the website. The app bundles its own
mobile-first front-end in `www/` (side drawer, bottom navigation,
app-designed screens, touch-sized cards and sheets) while sharing the
website's existing backends verbatim:

```
Android app (bundled UI)
   ├── Cloudflare Worker API  https://dsmnru-pyq-api.kush210431-cloudflare.workers.dev/api/*
   │        └── same KV search index / pagination / cache the website uses
   ├── Firebase Auth (project `dsmnru-data`, same accounts as the site)
   │        └── Identity Toolkit REST for email/password + native Google sign-in
   └── gofile.io + Firestore pendingUploads (the SAME public upload pipeline
            the website uses — driven from the in-app Upload screen)
```

There is **no second backend, no second database, no duplicate PYQ storage**
and no app-specific business data. Public archive data never reads Firestore;
the only Firestore touch-points are the one-time `users/{uid}` profile-row
sync after a manual sign-in and the same `pendingUploads` / `feedback`
writes the website's own forms perform — all owner-scoped and rule-validated.
Every product feature (upload, tools, contributors, links, PDF viewing,
sign-in) is handled **inside the app**; the browser is never a fallback for
normal functionality.

## Contents

| Path | Purpose |
| --- | --- |
| `www/index.html` | App shell: app bar (+ drawer menu button), routed view, bottom nav, sheets/toasts |
| `www/css/app.css` | The app's own dark "DSMNRU academic" design system (safe-area aware, 44px+ targets, no blur/animation bloat) |
| `www/js/app.js` | Shell: view stack router, side drawer wiring, Android back button, network banner, deep-link handoff, auth gates, in-app PDF open policy |
| `www/js/drawer.js` | Android side drawer: tabs + Upload / Tools / Contributors / Links / About (never opens the website) |
| `www/js/api.js` | Worker API client: TTL cache + persisted layer + in-flight dedupe + SWR + abort/timeout |
| `www/js/auth.js` | Firebase Authentication via Identity Toolkit REST (same project) + Google credential exchange (`signInWithIdp`) |
| `www/js/authui.js` | Sign-in / sign-up / reset / email-verification sheets + native Google flow |
| `www/js/store.js` | On-device persistence: saved papers, recent views, recent searches |
| `www/js/slug.js` | Canonical-slug mirror of the Worker's allocator + deep-link URL parser |
| `www/js/uploadcore.js` | Pure upload logic: website-parity validation, throttle, gofile URL, `pendingUploads` doc shape, image→PDF assembly |
| `www/js/toolscore.js` | Pure tool logic: CGPA math, attendance stats, planner (website parity, on-device) |
| `www/js/linkdata.js` | The curated university/government portal list (same data as the site's Links page, shipped statically) |
| `www/js/views/` | home · search · browse(courses) · course · paper · saved · profile · **upload · tools · contributors · links · about** |
| `www/js/native.js` | Wrapper for the app's own Java plugin (in-app PDF viewer, Google credential chooser, share sheet, downloads, external intents, launch link) |
| `android/app/src/main/java/com/dsmnru/pyq/DsmnruAppPlugin.java` | The custom plugin: in-app PDF viewer launch, Credential-Manager Google sign-in, ACTION_VIEW / ACTION_SEND / DownloadManager / launch deep-link |
| `android/app/src/main/java/com/dsmnru/pyq/PdfViewerActivity.java` | Native in-app PDF viewer screen (PdfRenderer, pinch zoom + pan, lazy page rendering, progress/error states, temporary cache only) |
| `android/app/src/main/java/com/dsmnru/pyq/MainActivity.java` | BridgeActivity: registers the plugin, forwards warm-start deep links to the JS router, FCM bootstrap + the one-time POST_NOTIFICATIONS ask |
| `android/app/src/main/java/com/dsmnru/pyq/FcmService.java` | FCM receiver: `all_users` topic subscription (version-gated), foreground notification rendering, deep-link tap intents |
| `android/` | Generated + customized Capacitor Android project (Gradle wrapper included) |
| `docs/GOOGLE_SIGNIN_SETUP.md` | Exact console configuration for native Google sign-in |
| `docs/PUSH_NOTIFICATIONS.md` | FCM implementation notes, message contract, sender-side (Worker/admin) requirements |
| `test/` | Node unit tests + jsdom integration smoke tests of the app UI (`npm test`) |

## Screens & navigation

**Side drawer** (hamburger in the app bar at every tab root): Home · Search ·
Courses · Saved · Profile & settings — Upload Paper · Study Tools ·
Contributors · Links — About. Drawer items push the matching in-app screen;
the drawer never opens the website. Bottom tabs: **Home · Search · Courses ·
Saved · Profile** (unchanged). Paper detail, course drill-downs and all
drawer screens live on an in-app view stack (Android back pops it; at a tab
root, back goes to Home; at Home, back exits — with drawer/sheet-first
precedence).

* **Home** — brand hero + search launcher, archive stats, quick-access course
  grid, "pick up where you left off" (device history), recently added and
  trending rails, and in-app shortcuts (upload/tools/contributors/links
  screens). Fed by **one** cached `GET /api/homepage` call.
* **Search** — server-side `GET /api/pyqs/search` (title/subject/course/
  semester/session), 350 ms debounce, previous in-flight query aborted via
  `AbortController`, filter + sort chips, paged results (20/page), full
  loading/empty/error/offline states. Never downloads the archive.
* **Courses** — app-native course grid (catalog + live paper counts) →
  semester/session chips + in-course subject search → paged papers.
* **Paper** — app-designed detail: title, course, semester, session, branch,
  subject, views, date, document id; **Open PDF (in-app viewer first) /
  Server 2 / Download / Save / Share** actions; metadata table; in-app
  "Report a broken link" (same Firestore `feedback` queue as the website);
  related papers (one filtered request).
* **Upload Paper** — the website's public upload workflow, fully in-app:
  same metadata + validation rules, Android file picker for one PDF (≤10 MB)
  or photos (converted to a PDF on-device), the same gofile.io storage, the
  same `pendingUploads` review queue, the same 10-point reward promise, the
  same client throttle (5 / 6 h), and real progress / success / error states.
* **Study Tools** — CGPA calculator, attendance tracker (75 % warning line)
  and study planner as native cards + sheets. 100 % on-device (localStorage,
  same keys as the website): zero API requests. "Request a tool" → the
  maintainers' Telegram bot (genuinely external).
* **Contributors** — ONE cached `GET /api/contributors` request (24 h
  persisted, SWR) renders the whole list; the "Join them" card routes to the
  in-app Upload screen. Never a request per contributor.
* **Links** — the curated university/scholarship portal list rendered
  statically in-app (zero network); only the tapped portal itself opens
  externally.
* **About** — in-app app identity, data sources, and the audited list of
  genuinely-external destinations.
* **Saved** — on-device bookmarks with local filter, works fully offline.
* **Profile** — session state, native Google sign-in entry, email-verification
  flow, device data controls (cache refresh/clear), sign-out, about.

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
`file2`/`server2`) — the same links the website shows. **"Open PDF" first
opens the app's own native viewer screen** (`PdfViewerActivity`): the direct
host URL is streamed by Android itself (never through the Cloudflare Worker,
so no Worker bandwidth is consumed), rendered with the platform `PdfRenderer`
(lazy per-page rendering into a heap-bounded LruCache), with pinch-zoom +
pan, vertical page scrolling, a page indicator, real download progress, and
error states with Retry / "Open in another app" (the same direct URL to a
system PDF app — never the DSMNRU website). The viewer keeps the file only
in the app's **temporary cache directory** — deleted on close and stale
files purged on open, so nothing is permanently downloaded into app storage
and nothing is mirrored or re-hosted. Landing-page links (Drive/mediafire
"Server 2") genuinely cannot render in-app and open through an external
intent. "Download" (direct `.pdf` hosts only) still uses Android's
DownloadManager into the public *Downloads* folder on an explicit tap.

## Authentication

The existing Firebase project (`dsmnru-data`) with its email/password sign-in,
sign-up, reset and email-verification flows — driven through the public
Identity Toolkit REST endpoints (the same calls the website's SDK makes), so
no popup windows are needed and no new auth system exists. **Google sign-in
is native**: the device's own Google account chooser (Android Credential
Manager, `DsmnruAppPlugin.googleSignIn`) returns a Google ID token which
`auth.signInWithGoogleCredential()` exchanges with the same project via
`accounts:signInWithIdp` — the identical call the Firebase JS SDK makes — so
the user identity, privileges and `users/{uid}` sync match the website
exactly. No browser, no Chrome, no website hand-off. Builds without the
Google client-ID configuration report `GOOGLE_SIGNIN_NOT_CONFIGURED` and
explain it in-app while offering email/password (see
`docs/GOOGLE_SIGNIN_SETUP.md` for the one-time console setup). Sessions
persist `idToken/refreshToken` locally and refresh lazily (app resume /
expiry), never on a timer. The website's gate policy is mirrored in-app:
verified sign-in is required for search, filters, page 2+ and PDF actions;
metadata browsing stays public.

## Notifications (FCM — implemented)

Push notifications run on the **same Firebase project (`dsmnru-data`)** with
a deliberately tiny footprint:

* **Audience = one FCM topic.** Every opted-in install subscribes to the
  global topic `all_users` — the FCM SDK owns registration and topic state,
  so there is **no token database, no Firestore writes, no per-launch sync**
  (the subscribe is version-gated: one call per install/update, plus once on
  token rotation).
* **Real Android 13+ permission.** `POST_NOTIFICATIONS` is requested through
  the actual system dialog once per install, ~9 s into the first session,
  and never re-asked — grant or deny — and the app works identically
  either way (denied pushes are silently suppressed before every post).
  There is no in-app fake toggle.
* **Channels + branding.** The `dsmnru_general` channel ("Paper alerts") is
  created at app start; foreground messages are rendered by `FcmService`
  (`onMessageReceived`), background notification payloads are branded by the
  manifest meta-data (icon/color/channel) and auto-displayed by the tray.
* **Taps open the app, not the website.** The tap intent is an ACTION_VIEW
  data URL on `MainActivity`, riding the same deep-link pipeline as shared
  links — `data.path` like `/pyq/<slug>` lands on the in-app paper screen,
  cold or warm.
* **Sender side (admin → Worker → FCM):** the exact remaining backend steps
  (service account, `POST /api/notify` guarded by the existing admin-token
  check, the web admin panel form) are specified in
  `docs/PUSH_NOTIFICATIONS.md` §5 — documented, not invented, since the
  Worker has no push endpoint yet. Build-time config: drop the project's
  `google-services.json` into `android/app/` (the Gradle file already
  applies the Google Services plugin automatically when present; without it
  the app runs normally with push disabled).

## Deep links

Shared `https://dsmnru-pyq.netlify.app/pyq/<slug>` and `paper.html?id=…`
links (and FCM notification taps) open the app's paper screen natively:
cold start via `DsmnruAppPlugin.getLaunchUrl()`, warm start via the
`siteDeepLink` event. Unresolvable slugs stay in-app with a pre-filled
search — never a browser hand-off. The website keeps working unchanged.

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

The GitHub Actions workflow (`.github/workflows/android-apk.yml`) runs on
pushes to `android-app` **and on pull requests targeting it**: the `checks`
job runs the Worker suite and the app's `npm test` (jsdom reused from the
Worker devDependencies) first, then the `debug-apk` job builds the debug APK
in the cloud and uploads it as a workflow artifact — nothing binary is
committed, and no releases are created automatically. A
signed release APK/AAB can be added later via repository secrets
(keystore + `google-services.json` are **never** committed; `build.gradle`
already auto-applies the Google Services plugin when `android/app/google-services.json`
is present at build time).

## Deferred by design

* **Release signing** — debug builds only, see above.
* **Google sign-in console registration** — the code is complete, but each
  build environment must register its keystore SHA-1 + set the Web client ID
  once (see `docs/GOOGLE_SIGNIN_SETUP.md`). Unconfigured builds degrade to
  the in-app email/password path — never a website redirect.
* **In-app paper comments** — discussion lives on the website by design; the
  paper screen links there explicitly (the one deliberate external
  destination for a product feature) and broken-link reports are in-app.
* **View-count increments** — the app intentionally does not write
  `pyqs.views` increments (the website keeps counting); saves stay on-device.
