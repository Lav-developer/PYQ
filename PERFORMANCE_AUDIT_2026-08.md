# PYQ — Frontend Performance Audit (READ-ONLY)

**Date:** 2026-08-28
**Branch audited:** `main` (commit `bb00bd0`)
**Scope:** `index.html`, `paper.html`, `admin.html`, `contributors.html`, `tools.html`, `links.html`, `script.js` (3,766 lines / 157 KB), `paper.js` (985 lines / 52 KB), `admin.js` (2,607 lines / 106 KB), `points.js`, `duplicate-check.js`, `styles.css` (4,472 lines / 107 KB), `sw.js`, `manifest.json`, `netlify.toml`, Worker API contract (`worker/src/*`).
**Method:** Static analysis of every critical-rendering-path file, call-graph review of the list/search/pagination/auth code paths, CSS cost analysis, network/CDN strategy review, and payload accounting from known vendor sizes.

> **Tooling note:** This sandbox has no Chromium/Firefox binary and no outbound network access, so live Lighthouse, Performance traces, Coverage data and a network waterfall against `dsmnru-pyq.netlify.app` could not be captured here. All findings below are derived from the source code itself (exact file + line references are given). The numeric estimates are based on the vendor bundles' published sizes (Firebase 9.22.1 compat, Bootstrap 5.3.0, Font Awesome 6.4.0, Google Fonts Manrope) plus the local file sizes. Re-running Lighthouse/DevTools after each fix will give the before/after lab numbers; the code-level causes identified here are the root cause of the reported freeze/lag regardless of lab scores.

---

## TL;DR — Why the UI freezes

The reported "temporary freeze", especially after **Load More** and on **search/filter** on low-end mobile devices, is caused by one dominant pattern plus a cluster of smaller main-thread costs:

1. **Every PYQ list item is `opacity: 0` and plays a staggered `fadeIn`+translateY animation with an inline `animation-delay` that grows with its index** (`script.js` `renderPYQs()` → `style="animation-delay: ${0.1 + (startIndex + index) * 0.05}s"`, styles.css `.pyq-item { animation: fadeIn .6s …; opacity: 0 }`). Items rendered by "Load More" get delays of **~1.1 s to 6+ seconds**, so they sit invisible for seconds, and every click of Load More launches up to 20 simultaneous entrance animations + composited layers → dropped frames and perceived freeze. **This is the #1 real-world UI-freeze cause.**
2. **The entire list is rebuilt as one giant HTML string on every search render and every Load More** (one `insertAdjacentHTML` of all new cards). String building, HTML parsing and style/layout for ~20–100+ cards happens in **one synchronous task on the main thread**.
3. **paper.html loads the full Firebase Firestore + Auth + app SDKs eagerly (render path) and runs Firestore network work for anonymous visitors** (`<script defer …firebase-firestore-compat.js…>` in `<head>`, `firebase.firestore()` at IIFE start, view-increment write + comment query on every legacy paper page view) — ~300 KB+ of vendor JS parsed/compiled on a page whose public data comes from the Worker API.
4. **~900 KB–1.1 MB of third-party CSS/JS (Bootstrap, Font Awesome, Firebase, Manrope) from 4 different CDN origins with no `preconnect`**, all on the critical path of every page.
5. **`backdrop-filter: blur()` on `.modal-content`, `.card`, dropdowns, lock overlays** forces GPU readback/re-compositing — particularly expensive on mobile GPUs when modals animate in.

A **1.22 MB dead asset (`img/Logo.png`, 1024×1024, referenced by zero files)** exists in the deploy.

Ranked findings follow.

---

## Findings ranked by expected real-world impact

### F1 — CRITICAL — Staggered entrance animation on PYQ items: invisible-after-Load-More + per-click animation storm
- **File:** `script.js` — `renderPYQs()` (~lines 2,470–2,560); `styles.css` lines **865–882** and **2,527–2,567**.
- **Code:**
  ```js
  pyqList.insertAdjacentHTML('beforeend', pyqsToRender.map((pyq, index) => `
    <li class="pyq-item" style="animation-delay: ${0.1 + (startIndex + index) * 0.05}s"> …
  `).join(''));
  ```
  ```css
  .pyq-item, .syllabus-item { animation: fadeIn 0.6s var(--ease-standard) forwards; opacity: 0; }
  ```
  (`fadeIn` = `opacity 0 + translateY(space-10)` → `opacity 1 + translateY(0)`.)
- **Why it is expensive:**
  - Every card starts **`opacity: 0`** and is only revealed when its animation begins. The delay is computed from the item's global index: page 1 → 0.1–1.05 s; after Load More (startIndex 20) → 1.1–2.05 s; after 5 Load More clicks (100 items) → items 100–119 get delays of **5.1–6.05 s**. The user clicks "Load More", new cards are inserted, and **nothing appears for up to ~6 seconds**. This is almost certainly the "UI freezes / display temporarily lags" symptom.
  - Each animation animates `opacity` + `transform` (compositor-friendly individually), but **20 animations start together**, each card being a composited layer that repaints over a dark/gradient background; on low-end Android this is a burst of long tasks and layer churn. It also re-triggers on every **search/filter render** (the whole list is rebuilt and animates again).
- **Main-thread/UI effect:** Long animations block visual readiness (Speed Index / "visible" LCP element delay), layer explosion → dropped frames during the burst, and a perceived hang after every Load More/search.
- **Estimated impact:** Eliminates the dominant "freeze" on list pages; Largest Contentful Paint visually completes ~1–6 s sooner after each pagination action; massive reduction in jank frames. Affects **both**, worse on **mobile** (slower compositor).
- **Recommended fix:**
  - Remove the per-item inline `animation-delay` math and remove `opacity: 0` initial state on appended items (or cap the stagger to the *visible first page only*, and only animate page 1).
  - Simplest safe change: delete the inline `style="animation-delay: …"` and change CSS so the entrance animation runs **only on the first 8–10 items of the initial page load** (e.g. `.pyq-item { animation: fadeIn .35s ease-out; }` with no stagger, or apply a `staggered` class only on first render). Load-More/search-inserted items should render immediately at `opacity: 1`.
- **Risk:** Very low. Pure presentation change; no data/logic dependency.
- **Platforms:** Both; severity mobile > desktop.

---

### F2 — CRITICAL — Synchronous giant-string list rendering on every search / filter / Load More
- **File:** `script.js` — `renderPYQs()` (~line 2,510: single `insertAdjacentHTML('beforeend', htmlString.join(''))`), `showLoading()` (innerHTML skeleton), `renderCompactPyqList()`, `renderCourseCardsFromCounts()`; same pattern in `paper.js` `loadRelated()` and admin renderers.
- **Why it is expensive:**
  - All new cards are concatenated into one string and parsed/inserted in a **single synchronous task**: template string build (dozens of regex `escapeHtml`/`normalizeForCompare` calls per item) → HTML tokenization → DOM node creation → style recalc → layout → paint, for 20 cards at once (up to 100+ accumulated nodes across Load More).
  - Each card contains ~3 Font Awesome icons, pills, buttons, inline styles — node count per card ≈ 20–30 elements → **~400–600 new DOM nodes per page**, never removed (DOM grows unboundedly with Load More; after 10 Load More clicks ≈ **6,000+ nodes** from the list alone, plus ~15 always-present hidden Bootstrap modals).
  - `renderPYQs()` ignores its argument and re-slices from global `filteredPyqs`; combined with `pyqList.innerHTML=''` on page 1, search does full teardown + rebuild each keystroke-debounced run.
- **Main-thread/UI effect:** One long task per render (parse+layout); grows with content already on the page because layout is over the whole `#pyqList`. Main thread is unresponsive during this window — the freeze users feel.
- **Estimated impact:** Each render is typically a 50–250 ms long task on mobile at 20 items, scaling up with accumulated DOM; doing this inside `requestAnimationFrame` chunks or using `<template>` + batched `DocumentFragment` cuts it to frame-budgeted slices.
- **Recommended fix:**
  - Append Load-More results via `DocumentFragment` built from a cloned `<template>` (no string re-parse), in **chunks of ~6–8 items per `requestAnimationFrame`** (or `scheduler.yield()` when available) so each frame stays < 16 ms.
  - For search/filter (replace semantics), render into a detached container and swap once; reuse existing nodes where possible.
  - Longer term: cap rendered items (windowing) — e.g. only ever render the most recent ~60 cards, or implement IntersectionObserver-based incremental insert.
- **Risk:** Medium (touches the main render path), but behavior-preserving if the same markup/classes are emitted.
- **Platforms:** Both.

---

### F3 — HIGH — paper.html eagerly loads + executes Firebase Firestore on the public paper page; Firestore network work for anonymous users
- **File:** `paper.html` lines **30–32** (three Firebase compat `<script defer>` tags including `firebase-firestore-compat.js`); `paper.js` line **17** `const db = firebase.firestore();` at IIFE top-level; `loadPaper()` → `incrementViews()` (~line 410) and `loadComments()` (~line 710).
- **Code/contract details:**
  - `firebase-app-compat` + `firebase-firestore-compat` + `firebase-auth-compat` are ~**180 KB + ~260–320 KB + ~90 KB raw** (~150–220 KB gzipped combined). On `index.html` the team already lazy-loads Firestore via `ensureFirestore()` (script.js lines ~33–47) — **but paper.html defeats that by hard-loading it in `<head>`**, even though all public paper data comes from the Worker API (`_paperApi.fetchPyqById`).
  - `const db = firebase.firestore()` runs immediately; Firestore then opens a gRPC/long-poll channel.
  - For legacy `paper.html?id=…` visits, `incrementViews()` fires a **Firestore write per page view** for *every* visitor (including logged-out — rules permitting), and `loadComments()` runs a top-level `comments` query, and on emptiness a **sub-collection query**, plus catch-block fallbacks that issue **up to 3–4 Firestore queries** per cold paper view — all before/around hydration.
- **Why it is expensive:** Download + parse + compile of ~0.5 MB vendor JS before the page is interactive; Firestore SDK also does background auth/ID-token + channel setup work on the main thread. The pretty `/pyq/<slug>` Worker-rendered route is better (comments are deferred via `deferPrettyRouteComments` and view counting is skipped), but **legacy `paper.html` links still trigger the full eager path**.
- **Main-thread/UI effect:** Delayed TTI/INP on the paper page; background Firestore traffic competes with the Worker fetch and the inline iframe/preview.
- **Estimated impact:** Removing eager Firestore from paper.html saves ~250–300 KB of JS parse/compile on every paper visit for anonymous users; deferred init moves the cost behind a user action (login/comment).
- **Recommended fix:**
  - Mirror the `index.html` pattern: in `paper.html` load **only** `firebase-app-compat` + `firebase-auth-compat` deferred; lazy-inject `firebase-firestore-compat.js` via the existing `ensureFirestore()` (already defined in `script.js`, which paper.html also loads) before any `db.` call (comments, view increment, report).
  - Move view counting to the **Worker API** (a small authenticated/public `POST /api/pyqs/:id/view`) instead of a client Firestore write — removes Firestore write traffic entirely for anonymous reads and matches the KV/Worker architecture already in place.
  - Keep comment reads deferred (the pretty-route deferral already exists; extend the same deferral to legacy `paper.html` for anonymous users — activate on sign-in or first interaction with the discussion section).
- **Risk:** Medium — must ensure every `db` usage in paper.js is preceded by `await ensureFirestore()`; comments/report flows need a quick regression pass.
- **Platforms:** Both; mobile parse cost dominates.

---

### F4 — HIGH — ~1 MB third-party critical-path payload across 4 CDN origins with no resource hints
- **File:** every page `<head>` (`index.html` lines 14–27; identical in paper.html/contributors/tools/links/admin).
- **What loads on the homepage cold load:**
  | Resource | Origin | Raw size (≈) | Gz (≈) |
  |---|---|---|---|
  | normalize.css | cdnjs | 2 KB | 1 KB |
  | Bootstrap 5.3.0 CSS | jsdelivr | 230 KB | 33 KB |
  | Font Awesome 6.4.0 `fontawesome.min.css` + `solid.min.css` | cdnjs | ~80 KB CSS + **fa-solid-900 woff2 ≈ 180–220 KB** (the *entire* solid icon set; only ~60–80 distinct icons are used) | ~120 KB |
  | Google Fonts Manrope CSS + woff2 (5 weights) | fonts.googleapis/fonts.gstatic | ~90 KB | ~50 KB |
  | Firebase app + auth compat (index) | gstatic | ~270 KB | ~95 KB |
  | Bootstrap bundle JS (Popper included) | jsdelivr | 80 KB | 23 KB |
  | styles.css (local, unminified) | same origin | **107 KB** | ~20 KB |
  | script.js (local, unminified) | same origin | **157 KB** | ~40 KB |
  | points.js | same origin | 3.5 KB | 1.5 KB |
  - **No `<link rel="preconnect">` / `dns-prefetch`** for `cdnjs.cloudflare.com`, `cdn.jsdelivr.net`, `www.gstatic.com`, `fonts.googleapis.com`/`fonts.gstatic.com` → each origin pays a full DNS + TCP + TLS round trip serially (mobile RTT 150–400 ms each).
  - All CSS is render-blocking; the two Firebase tags and Bootstrap JS are `defer` (good), but CSS from 4 origins blocks first paint.
- **Main-thread/UI effect:** Delayed FCP/LCP; main-thread parse of ~0.5 MB JS (Firebase + Bootstrap bundle + 157 KB script.js) during page load.
- **Estimated impact:** Preconnect alone typically saves 200–700 ms on cold mobile loads. Reducing FA to an SVG/inline subset or self-hosting only used glyphs saves ~150 KB. Dropping to Manrope 3 weights saves one font file. Minifying `styles.css` + `script.js` (served unminified today; `netlify.toml` caches them for 7 days but never compresses them) saves ~60–70 KB gz.
- **Recommended fix (ordered, all low-risk):**
  1. Add to every page `<head>`:
     ```html
     <link rel="preconnect" href="https://fonts.googleapis.com">
     <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
     <link rel="preconnect" href="https://cdnjs.cloudflare.com">
     <link rel="preconnect" href="https://cdn.jsdelivr.net" crossorigin>
     <link rel="preconnect" href="https://www.gstatic.com" crossorigin>
     ```
  2. Replace Font Awesome full CSS+font with either (a) a FA Kit subset / `@fortawesome` tree-shaken build of the ~60 used icons, or (b) inline SVGs. At minimum self-host the woff2 so it is SW-cacheable (the SW cannot cache cross-origin responses today).
  3. Reduce Manrope to weights 400;600;700;800 (audit shows 500 rarely needed) and add `&display=swap` (already present).
  4. Serve minified `styles.css`/`script.js` (or add a build step / Netlify plugin); enable `Content-Encoding: br/gzip` verification for same-origin assets.
  5. Consider dropping Bootstrap **JS bundle** on index.html if only modals are used (Bootstrap modals can be driven without Popper; Popper is only needed for tooltips/popovers/dropdown positioning) — verify usage first.
- **Risk:** Low (hints, font weight trim), Medium (FA replacement), Medium (minification pipeline).
- **Platforms:** Both; mobile cold load benefits most.

---

### F5 — HIGH — `backdrop-filter: blur()` on modals/cards/overlays + `transition: all` overuse
- **File:** `styles.css` lines **2,733, 2,950, 2,979, 3,699, 3,714, 3,757, 3,892**; plus inline styles in `paper.js`/`script.js` overlay builders (`backdrop-filter:blur(8–14px)` on `paper-lock-overlay`, verification blocks).
- **Notably:**
  - `.modal-content { … backdrop-filter: blur(14px); }` (line ~3,887–3,893) — **every** Bootstrap modal on the site blurs everything behind it while animating.
  - `.card.section-card`, `.contributor-more`, dropdowns, pill nav, lock overlays also blur.
- **Why it is expensive:** `backdrop-filter` forces the browser to re-rasterize the content behind the element every frame while anything animates or scrolls; on mid/low-end mobile GPUs this is one of the most common sources of modal-open jank and scroll jank (each frame: capture backdrop → Gaussian blur → composite). Stacking two blurred layers (modal + lock overlay, both used by the verification flow) compounds it.
  - `transition: all var(--duration-normal)` appears **~20+ times** — non-composited properties (width/height/box-shadow/background) animate on hover for many elements, triggering paint/layout on interaction.
- **Main-thread/UI effect:** Frame drops when opening modals/search-gate/login/signup/paper-lock; hover jank on cards/buttons.
- **Estimated impact:** Noticeable smoothness improvement on mobile for modal interactions; lower paint cost during scroll.
- **Recommended fix:**
  - Remove `backdrop-filter` from `.modal-content` (use a solid/semi-opaque background). Keep blur only on small fixed overlays where it is truly wanted, or wrap it in `@media (min-width: 992px)` / disable under `(prefers-reduced-motion)`.
  - Replace `transition: all` with explicit property lists (`transition: background-color .2s, transform .2s, box-shadow .2s`).
- **Risk:** Low (visual only; tune opacity to compensate).
- **Platforms:** Mobile primarily.

---

### F6 — HIGH — Admin: full-collection Firestore reads + entire table re-rendered via innerHTML on every keystroke
- **File:** `admin.js` — `loadPyqsOnDemand()` (~1,859): `db.collection('pyqs').get()` loads **all** PYQ docs; `renderPyqs()` (~901) builds one `innerHTML` string of **all** `.resource-card`s; `setupAdminPyqSearch()` (~2,193) calls `renderPyqsFiltered(filtered)` on **every `input` event with no debounce**; same pattern for users/contributors/feedback; `duplicate-check.js` Levenshtein runs against the full PYQ title index per pending submission (`renderDuplicateHints`).
- **Why it is expensive:** Once the collection grows to hundreds/thousands of docs: (a) the initial open downloads/parses every document; (b) each keystroke rebuilds the whole list as an HTML string (hundreds of cards → multi-hundred-ms task, 10k+ DOM nodes); (c) duplicate scoring runs token-set + Levenshtein over every title for every pending submission.
- **Main-thread/UI effect:** Admin page freezes while typing in search and when opening the PYQ section; high memory.
- **Estimated impact:** Becomes painful past ~200–300 papers (the site is heading there); fixes are local to admin-only code.
- **Recommended fix:**
  - Debounce admin search (~200–300 ms) and cap rendered rows (render first 100 matches + "narrow your search"); virtualize or paginate the list.
  - Render with `<template>`/DocumentFragment rather than one giant innerHTML.
  - Duplicate check: pre-tokenize the index once (it already caches the index) and short-circuit Levenshtein when token overlap is 0; cap candidates before the char-similarity step (it already returns top 5 — verify scoring is applied to all then sorted; pre-filter by course/token overlap first).
- **Risk:** Medium (admin-only; admin audience is small but it is where content is managed daily).
- **Platforms:** Both.

---

### F7 — MEDIUM — Firebase Auth + Firestore SDK cost on every public page for visitors who never log in
- **File:** `index.html` lines 28–29; `contributors.html`, `tools.html`, `links.html` lines 18–19; `script.js` lines 1–18.
- **Details:**
  - Every public page loads `firebase-app-compat` + `firebase-auth-compat` (~270 KB raw / ~95 KB gz) and immediately calls `firebase.initializeApp()` + `firebase.auth()` + registers `onAuthStateChanged`. Auth session restore is inherently async and cheap *after* parse, but the parse/compile cost is paid by 100% of anonymous visitors.
  - On **sign-in**, the auth listener does a chain of Firestore work (`user.reload()` → `ensureUserDocumentSynced()` → user doc `get()`+`set()` → `loadUserProfile()` → `checkAndShowProfileCompletionReminder()` another user doc `get()` → points card: reward_account `get()` + point_transactions query) — several sequential round trips (request waterfall) but only for logged-in users; acceptable, though the user doc is read 2–3 times.
  - `tools.html` / `links.html` / `contributors.html` include `script.js` (157 KB) whose vast majority (upload pipeline, pyq list, modals) is dead code on those pages.
- **Recommended fix:**
  - Lazy-load Firebase Auth too: defer the two Firebase scripts until first interaction with the profile/login control (or load `requestIdleCallback`-gated). The Worker serves all public data; auth is only needed when a user opens the login dropdown.
  - Split `script.js` so tools/links/contributors load a small shared shell instead of the whole app bundle (or at minimum confirm those pages don't pay for upload/PYQ-list code — currently they do).
  - Collapse the signed-in user-doc reads: `ensureUserDocumentSynced` already reads+writes the doc; reuse its returned data for `loadUserProfile`/completion check instead of re-reading.
- **Risk:** Medium (gating auth changes must preserve the "returning user stays signed in" UX — load auth on idle and on click; show a neutral state until ready).
- **Platforms:** Both.

---

### F8 — MEDIUM — Unthrottled non-passive scroll listener + global click handler doing needless work
- **File:** `script.js` lines **2,940–2,949** (scroll), **2,961–2,972** (global analytics click), **491–501** (outside-click profile).
- **Code:**
  ```js
  window.addEventListener('scroll', function() {
      const scrollButton = document.getElementById('scrollToTop');   // element does not exist anywhere in the HTML
      if (window.pageYOffset > 300) { if (scrollButton) scrollButton.style.display='block'; } …
  });   // no {passive:true}, no rAF throttle
  document.addEventListener('click', function(event) {
      if (event.target.classList.contains('btn-download')) { … event.target.closest('.pyq-item, .syllabus-item').querySelector('h5') … }
      else if (… 'btn-share'/'btn-preview') { ….querySelector('h5').textContent }
  });
  ```
- **Issues:**
  - Scroll handler runs on **every scroll event** (up to ~60+/s), does a `getElementById` lookup each time, and toggles a button that **does not exist** in any shipped HTML (`#scrollToTop` is absent) — pure wasted work, and because it is not marked passive and reads `pageYOffset` + writes style, it can block scroll compositing.
  - Global click handler: `.btn-preview` matches the real "View Details" links (`class="btn btn-action btn-preview"`), then `.closest('.pyq-item,…').querySelector('h5')` — but list cards use `<h3 class="pyq-title">`, so this evaluates to `null.textContent` → **TypeError thrown on every card/action click** (silently, but it is exception work and kills the handler mid-way; also `gtag` is never loaded so the whole tracking block is dead).
  - The outside-profile click listener (`querySelector('.user-profile-section')` + `contains`) runs on every document click — cheap individually but constant.
- **Recommended fix:** Remove the dead scroll handler (or restore the button + throttle with rAF and `{passive:true}`); fix/guard the analytics click handler (select `.pyq-title` and null-check) or delete it entirely since `gtag` isn't installed; profile outside-click can be delegated once.
- **Risk:** Low.
- **Platforms:** Both.

---

### F9 — MEDIUM — Service worker: cache-first for same-origin assets with `must-revalidate` mismatch; cross-origin CDN never cached; version churn
- **File:** `sw.js` (v9) + `netlify.toml` headers.
- **Findings:**
  - SW serves same-origin `.css/.js/.png/.svg/.woff2` **cache-first with no max-age/version check**; meanwhile `netlify.toml` sends `Cache-Control: public, max-age=604800, must-revalidate` for those files. Cache-first means after a deploy, returning users can keep stale `styles.css`/`script.js` **until the SW byte-version changes** (it is only bumped manually; it went v8→v9 for points UI). `skipWaiting`+`clients.claim` mitigates new installs but not users whose SW doesn't re-evaluate. This is a correctness/stale-content risk more than a perf issue, and it also means any perf fix shipped may not reach repeat users without a cache-bust bump.
  - The runtime caching regex **only matches same-origin** files — the ~800 KB of CDN CSS/JS/fonts (Bootstrap, FA, Firebase, Manrope) is **never cached by the SW**, so repeat visits revalidate over the network (HTTP cache still applies, but fonts/CSS on CDNs have their own TTLs).
  - Navigations use network-first with offline fallback — fine.
- **Recommended fix:** Adopt stale-while-revalidate with an asset version hash in the cache name (bump automatically per deploy), and add a runtime-cache rule for the specific CDN hosts (or self-host vendors). At minimum, bump SW version on every deploy as part of the build.
- **Risk:** Medium (SW bugs can wedge caching; test update flow).
- **Platforms:** Both (return visitors).

---

### F10 — MEDIUM — Service Worker registration + Notification permission request on first load
- **File:** `script.js` lines **3,481** (`Notification.requestPermission()` inside the planner IIFE's DOMContentLoaded), **3,761** (SW register on window load — fine).
- **Detail:** The study-planner module calls `Notification.requestPermission()` on **every page load** for anonymous visitors who never opened the planner. The browser prompt (or a blocked/denied state) is an unnecessary permission prompt tied to a feature most visitors never use; the planner/attendance IIFEs also parse/run on all pages even though their UI exists only on tools.html.
- **Recommended fix:** Request notification permission only when the user creates a reminder inside the planner; gate the planner/attendance modules to pages that have their trigger buttons.
- **Risk:** Low.
- **Platforms:** Both (mobile prompt especially intrusive).

---

### F11 — MEDIUM — Duplicate/wasted network requests on initial page load
- **File:** `script.js`.
  - **Two separate `courses.json` fetches on the homepage cold path** (verified): (1) top-level `fetchCoursesJson()` at script init (line ~257, default cache), and (2) `fetchCourseCatalog()` inside `loadHomepageSections()` (line ~2232, forced `cache: 'no-store'`). The second fetch exists only to populate `#courseCards/#recentlyAddedList/#trendingList`, which **do not exist in `index.html`** — but `loadHomepageSections()` is still called from `bootstrapContent()` before `renderPYQs`, so the first course-list fetch fires on every homepage load regardless.
  - `fetchCoursesJson()` (top-level) runs on **every page that loads script.js** — including `tools.html`, `links.html`, `contributors.html` — even though only the homepage filter `<select id="filterCourse">` consumes it; the populate helper early-returns, but the network request already happened.
  - `loadAggregatedStats()` calls `/api/stats` and **discards the result** (`await fetchStats();` with no render) — fires on contributors page load.
- **Recommended fix:** Consolidate to a single cached `courses.json` loader shared by filter + homepage sections; gate `fetchCoursesJson()` on `document.getElementById('filterCourse')` existing; delete the no-op `loadAggregatedStats()`/`fetchStats()` call or actually render the stats.
- **Risk:** Low.
- **Platforms:** Both (minor; a handful of small requests).

---

### F12 — LOW-MEDIUM — 1.22 MB dead image asset shipped in the deploy
- **File:** `img/Logo.png` — 1024×1024, **1,220,215 bytes**. Grep across all HTML/JS/CSS/manifests: **zero references**. It is also not in the SW app shell and not referenced by PWA icons. It ships in the Netlify publish directory and could be served if anyone hits the URL, and it bloats the deploy. (Actual raster needs are the icon set, which is reasonably sized: 32 KB / 161 KB / 114 KB / 97 KB.)
- **Recommended fix:** Delete the file (or move to an out-of-deploy assets folder). If a logo is needed, serve a compressed WebP/SVG under ~20 KB.
- **Risk:** None (unreferenced).
- **Platforms:** N/A to runtime.

---

### F13 — LOW-MEDIUM — DOM weight: ~15 always-present hidden modals + duplicate modal markup per page
- **File:** `index.html` (~860 lines, 12 modal blocks + chat widget + full upload form), `paper.html` (~560 lines, duplicates login/signup/profile/settings/verification/profile-completion/report/request modals that `script.js` also manages), admin inline `<style>` block (~1,400 lines of CSS inside admin.html).
- **Why it matters:** Hidden modals still cost HTML parsing, style matching, and Bootstrap's data-API initialization (`data-bs-dismiss`, backdrop stacking) on load; `new bootstrap.Modal(…)` is constructed for pdfModal/shareModal in DOMContentLoaded even though they're rarely used. Duplicated IDs/markup across index/paper increase parse cost and maintenance.
- **Recommended fix:** Construct modals lazily from templates on first open (the codebase already does this for tool-info/planner/attendance modals — same pattern for auth modals); move admin's inline `<style>` into styles.css or an admin.css.
- **Risk:** Medium (Bootstrap modal lifecycle must be preserved), defer.
- **Platforms:** Both.

---

### F14 — LOW — Memory growth patterns
- **`allData.pyqs` + `filteredPyqs` accumulate across Load More** and are re-mapped (`[...allData.pyqs]`, `applyPyqSorting` copies) on each sort/filter; `incrementPyqViews` maps both arrays on each view action. Small arrays today (~20–100 items) — negligible now, O(n) growth with content; the DOM accumulation in F2 is the larger half.
- Planner `setTimeout` reminders are tracked and cleared (`_plannerTimeouts`) — good. No `setInterval` anywhere (verified). No `onSnapshot` listeners (all one-shot `.get()`) — good, no realtime-listener leaks.
- `API_SESSION_CACHE` is capped at 50 entries — good.
- **Recommended fix:** When windowing (F2) lands, slice the data arrays too; nothing urgent.
- **Risk:** N/A.

---

### F15 — LOW — Miscellaneous
- `document.execCommand('copy')` deprecated (clipboard API is already used elsewhere) — harmless.
- `extractYearFromTitle`, `escapeHtml`, `getPyqTimestampValue`, `getRecentSortValue`, `populateCourseFilter` are **defined twice** (top-level + inside DOMContentLoaded closure) — confusing, ~2–3 KB duplicate parse; unify.
- Search debounce is **1000 ms** (`setupEventListeners`) — feels sluggish; once rendering is chunked (F2) this can drop to 250–350 ms with the existing AbortController cancellation.
- Inline `style="…"` strings everywhere in rendered cards (forces per-element style recalc and bypasses CSS sharing) — move to classes.
- `paper.js refreshPreviewForViewport()` re-binds fallback buttons' click listeners each time the media query flips — adds duplicate listeners per resize-crossing (minor leak).
- Admin `renderPendingUploads` calls `renderDuplicateHints` which issues the full-index comparison each time the review view renders (index is cached; scoring still runs per submission per render).
- Admin loads PapaParse eagerly (`papaparse.min.js`) even when CSV import isn't used — defer to the import action.

---

## Issue-by-issue severity matrix

| ID | Severity | File(s) | Function/location | Thread impact | Desktop | Mobile | Fix risk |
|----|----------|---------|--------------------|---------------|---------|--------|----------|
| F1 | Critical | script.js, styles.css | `renderPYQs()` inline animation-delay; `.pyq-item fadeIn` | Post-Load-More blank seconds + animation long tasks | X | **X worse** | Very low |
| F2 | Critical | script.js (+paper.js/admin.js) | `renderPYQs` insertAdjacentHTML giant string | 50–250 ms+ synchronous parse/layout tasks; DOM grows unbounded | X | **X worse** | Medium |
| F3 | High | paper.html, paper.js | head Firestore tags; `firebase.firestore()`; incrementViews; loadComments | ~300 KB vendor parse + Firestore traffic for anonymous | X | **X worse** | Medium |
| F4 | High | all HTML heads | CSS/JS from 4 CDNs, no preconnect; FA full font; unminified assets | FCP/LCP delay; parse cost | X | **X worse** | Low–Med |
| F5 | High | styles.css | `.modal-content` etc. `backdrop-filter: blur` | GPU blur per frame during modal animation/scroll | slight | **X** | Low |
| F6 | High | admin.js, duplicate-check.js | `renderPyqs` innerHTML; search per keystroke; full collection `.get()` | Admin long tasks scaling with data | X | X | Medium (admin-only) |
| F7 | Medium | index/contrib/tools/links .html, script.js | eager Firebase Auth; 157 KB script.js on all pages | Parse/compile for anonymous users | X | X | Medium |
| F8 | Medium | script.js | scroll listener; global click TypeError | Per-scroll work; exception per card click | X | X | Low |
| F9 | Medium | sw.js, netlify.toml | cache-first same-origin; CDNs not cached | Stale-asset risk; repeat-visit revalidation | X | X | Medium |
| F10 | Medium | script.js planner IIFE | `Notification.requestPermission()` on load | Feature permission prompt; module runs on all pages | X | X | Low |
| F11 | Medium | script.js | duplicate courses.json; discarded `/api/stats` | Wasted requests | X | X | Low |
| F12 | Low-Med | img/Logo.png | unreferenced 1.22 MB asset | Deploy bloat | – | – | None |
| F13 | Low-Med | index.html, paper.html, admin.html | ~15 hidden modals; duplicated markup; inline CSS | Parse/style cost | X | X | Medium |
| F14 | Low | script.js | arrays accumulate with Load More | O(n) growth, minor | X | X | Low |
| F15 | Low | several | dup helpers, execCommand, debounce 1000ms, inline styles, PapaParse eager | Mixed small | X | X | Low |

---

## Page-by-page expectations (qualitative, to confirm with lab tooling)

- **Desktop homepage:** FCP/LCP mostly network-bound on 4 CDN origins (F4) + Bootstrap/FA CSS; list render (F1/F2) is brief on desktop CPU but Load More staggers still delay new cards ~1–2 s.
- **Mobile homepage:** Same network costs compounded; F1's stagger after Load More (multi-second blank), F2 parse/layout tasks, F5 blurs are the freeze sources. Firebase app+auth ~95 KB gz parse on load (F7).
- **Search:** Debounced 1 s then full list teardown/rebuild (F2) + full re-stagger (F1) — the list "flashes and crawls in". AbortController cancellation is correctly implemented (good).
- **Filter:** Same path as search; course/semester/session changes each trigger a server round trip + full re-render.
- **Load More:** Worst-case path — invisible items for up to ~6 s on deep pages (F1), one synchronous render chunk (F2), DOM/node growth (F2/F14).
- **Paper page (`paper.html?id=`):** Eager Firestore SDK (F3), up to 3–4 comment queries + a view write for anonymous users (F3), lock/verification overlays stack blur layers (F5), related-papers render is small (6 cards — fine).
- **Paper page (`/pyq/<slug>`):** Worker SSR HTML shows content fast; comments correctly deferred; still pays the eager SDK parse (F3).
- **Admin page:** Fine at small data size; PYQ section open and admin search keystrokes will freeze once the collection grows (F6); ~4 Firebase SDKs + PapaParse eager (acceptable for admin, but PapaParse can defer).

---

## TOP 5 PERFORMANCE FIXES (recommended implementation order)

### Fix 1 — Remove the per-item animation stagger; make appended items appear instantly (F1)
- **Exact change:**
  - `script.js → renderPYQs()`: delete the inline `style="animation-delay: ${0.1 + (startIndex + index) * 0.05}s"` from the `<li>` template.
  - `styles.css`: change `.pyq-item, .syllabus-item { animation: fadeIn 0.6s …; opacity: 0; }` to a fast, non-blocking entrance that only applies on the **initial** page render — e.g. add a class `is-first-render` to the list for the first page only, and scope:
    ```css
    #pyqList.is-first-render .pyq-item { animation: fadeIn 0.35s ease-out both; }
    /* no opacity:0 baseline on .pyq-item itself; keep nth-child stagger only inside .is-first-render, capped at ~8 items */
    ```
    Remove the class after first render; Load-More/search inserts render at `opacity:1` immediately.
- **Expected benefit:** New cards appear **instantly** on Load More/search instead of 1.1–6 s later; removes a 20-element animation burst per click. This alone should eliminate the "temporary freeze" report.
- **Complexity:** Low (a few lines in two files).
- **Breakage risk:** **Very low** — presentation only.
- **Platforms:** Both; mobile biggest win.

### Fix 2 — Chunk/fragment the list rendering instead of one giant `insertAdjacentHTML` (F2)
- **Exact change:** Build each card from a single shared `<template>` element (clone + fill text via `textContent` for safety), append into a `DocumentFragment` in batches of **6 items per `requestAnimationFrame`**; for Load More keep appending; for search/filter, build the new list detached and swap `#pyqList` content once after the first batch (or progressively). Keep `escapeHtml` semantics identical.
- **Expected benefit:** Cuts each render from one 50–250 ms+ long task into <16 ms frame slices; keeps INP/TBT healthy; frame budget preserved while DOM grows.
- **Complexity:** Medium (render helper rewrite; all call sites already funnel through `renderPYQs`).
- **Breakage risk:** Medium — must reproduce exact classes/structure and event bindings (events currently rely on inline onclick / document delegation, which survives template rendering).
- **Platforms:** Both.

### Fix 3 — Lazy-load Firebase on paper.html; move view counting to the Worker (F3)
- **Exact change:**
  - `paper.html`: remove the `firebase-firestore-compat.js` defer tag; keep app+auth (or lazy-load them too behind the login control per F7).
  - `paper.js`: replace top-level `const db = firebase.firestore();` with lazy `await ensureFirestore()` (the function already exists in script.js) before comment post/load and report submission; make `loadComments` for **anonymous** users defer until interaction (same pattern already used for `/pyq/<slug>`).
  - View counts: call a Worker endpoint (e.g. `POST /api/pyqs/:id/view`, rate-limited via the existing rate limiter) instead of the client Firestore write; remove Firestore write path from the client.
- **Expected benefit:** ~250–300 KB less JS parsed on the most-shared page type; zero Firestore network work for anonymous readers; paper TTI improves on mobile.
- **Complexity:** Medium–High (touches auth gating + requires a small Worker route; Firestore rules may currently allow the view write — the Worker can do it with admin credentials).
- **Breakage risk:** Medium — regression-test login gating, comment posting, report flow, view counts.
- **Platforms:** Both; mobile biggest.

### Fix 4 — Add CDN resource hints + trim Font Awesome/fonts + minify local assets (F4)
- **Exact change:**
  - Add the five `preconnect` lines listed in F4 to the `<head>` of all six HTML pages.
  - Replace Font Awesome full `solid.min.css` + webfont with a subset of the ~60 used icons (FA Kit subset, self-hosted woff2, or inline SVG sprites).
  - Reduce Manrope to 400/600/700/800.
  - Minify `styles.css` and `script.js`/`paper.js`/`admin.js` (Netlify plugin or simple build step) and confirm Brotli/gzip delivery.
- **Expected benefit:** Cold mobile FCP/LCP typically 200–700 ms faster from preconnect; ~150 KB saved on FA; ~60–80 KB gz from minification; repeat visits cacheable via SW once self-hosted.
- **Complexity:** Low for hints/fonts; Medium for FA subsetting/build pipeline.
- **Breakage risk:** Low for hints/weight trim; Low–Medium for FA (verify every icon still renders).
- **Platforms:** Both.

### Fix 5 — Remove GPU blur from modals/overlays + dead scroll/click handlers (F5 + F8)
- **Exact change:**
  - `styles.css`: remove `backdrop-filter: blur(14px)` from the `.contributor-more, .card.section-card, .modal-content` rule and from dropdown/pill rules; replace blur overlays' blur with a solid translucent background on mobile (media-query gate blur to `min-width: 992px`).
  - Replace `transition: all …` with explicit property transitions across the ~20 rules.
  - Delete the dead `#scrollToTop` scroll listener (or restore the button, rAF-throttled + `{passive:true}`).
  - Fix/delete the analytics click handler that throws on `.btn-preview` clicks (target `.pyq-title`, null-guards) — `gtag` is not loaded anyway.
- **Expected benefit:** Modal open/close and scroll stay smooth on low-end mobile; removes per-scroll overhead and per-click exceptions.
- **Complexity:** Low.
- **Breakage risk:** Low (visual tuning only; behavior unchanged).
- **Platforms:** Mobile primarily, desktop slight.

---

## What is already done well (don't regress these)

- Firestore and SweetAlert2 are **lazy-loaded** on the homepage (`ensureFirestore`, `ensureSweetAlert`) — F3 is about extending that proven pattern to paper.html.
- Public data goes through the **Worker/KV-cached API** with server-side pagination (20 items), server-side search index, and request **AbortController** cancellation for stale searches.
- No `setInterval` polling, no Firestore `onSnapshot` realtime listeners on public pages, session API cache capped at 50 entries.
- Admin sections are **lazy-loaded on accordion expand** (not at login).
- `prefers-reduced-motion` is globally respected (disables the F1 animations for users who opt out — which also corroborates F1 as the jank source).
- Mobile iframe injection is deliberately prevented for PDF previews (security + perf conscious).

---

## Recommended verification after each fix (when run in an environment with a browser)

1. DevTools Performance trace on mobile throttling (4× CPU, Slow 4G) for: homepage load, typing in search, applying each filter, 5× Load More, opening a paper page (`?id=` and `/pyq/<slug>`), admin PYQ section + admin search typing.
2. Track: FCP, LCP, TBT, INP, long-task count, JS execution time (scripting), DOM nodes, transferred bytes / resource count.
3. After Fix 1 specifically: confirm new Load-More cards are painted within the same frame as the click response.
4. After Fix 3: confirm Network panel shows **no** `googleapis.com/gstatic` Firestore traffic for anonymous paper views.
