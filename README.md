<div align="center">
  <img src="img/Logo.png" alt="DSMNRU Archive Logo" width="120" />
  <h1>🎓 DSMNRU Academic Archive</h1>
  <p><strong>The Complete Resource Hub for DSMNRU Students — PYQs, Notes, Syllabus & Tools</strong></p>
  <p><i>Browse 500+ Previous Year Question Papers with instant preview, locked downloads, and verified contributions. Built for speed, SEO, and offline-first.</i></p>

  <p>
    <a href="https://dsmnru-pyq.netlify.app/"><strong>🚀 Live Demo</strong></a> •
    <a href="https://dsmnru-pyq.netlify.app/paper.html?id=demo">Paper Detail Demo</a> •
      <a href="https://dsmnru-pyq.netlify.app/admin.html">Admin</a>
  </p>

  <p>
    <img src="https://img.shields.io/badge/HTML5-E34F26?style=for-the-badge&logo=html5&logoColor=white" alt="HTML5" />
    <img src="https://img.shields.io/badge/CSS3-1572B6?style=for-the-badge&logo=css3&logoColor=white" alt="CSS3" />
    <img src="https://img.shields.io/badge/JavaScript-F7DF1E?style=for-the-badge&logo=javascript&logoColor=black" alt="JavaScript" />
    <img src="https://img.shields.io/badge/Firebase-FFCA28?style=for-the-badge&logo=firebase&logoColor=black" alt="Firebase" />
    <img src="https://img.shields.io/badge/PWA-Ready-5A0FC8?style=for-the-badge&logo=pwa&logoColor=white" alt="PWA" />
  </p>

  <p>
    <img src="https://img.shields.io/github/stars/Lav-developer/PYQ?style=social" alt="Stars" />
    <img src="https://img.shields.io/github/forks/Lav-developer/PYQ?style=social" alt="Forks" />
    <img src="https://img.shields.io/github/last-commit/Lav-developer/PYQ?style=flat-square" alt="Last Commit" />
    <img src="https://img.shields.io/badge/License-MIT-green?style=flat-square" alt="License" />
    <img src="https://img.shields.io/badge/PRs-Welcome-brightgreen?style=flat-square" alt="PRs" />
  </p>
</div>

---

> **DSMNRU PYQs only. Not affiliated with DSMNRU University.** Papers are contributed by students for educational use.

---

<details>
<summary>📖 <strong>Table of Contents</strong> — Click to expand</summary>

- [✨ Why DSMNRU Archive?](#-why-dsmnru-archive)
- [🌟 Features](#-features)
- [🆕 What's New](#-whats-new)
- [🛠️ Tech Stack](#%EF%B8%8F-tech-stack)
- [📂 Project Structure](#-project-structure)
- [🚀 Quick Start](#-quick-start)
- [☁️ Cloudflare Worker API (new architecture)](#%EF%B8%8F-cloudflare-worker-api-new-architecture)
- [🔧 Environment & Firebase Setup](#-environment--firebase-setup)
- [📡 Data Model & Collections](#-data-model--collections)
- [🔐 Firestore Security Rules](#-firestore-security-rules)
- [📤 Student Upload Flow](#-student-upload-flow)
- [👨‍💼 Admin Guide](#-admin-guide)
- [🎨 Styling & Theme](#-styling--theme)
- [📱 PWA & Offline](#-pwa--offline)
- [🔍 SEO & Performance](#-seo--performance)
- [⚡ Caching & Quota Saving (50K Reads)](#-caching--quota-saving-50k-reads)
- [🛡️ Auth & Verification](#%EF%B8%8F-auth--verification)
- [🧪 Development Workflow](#-development-workflow)
- [🚨 Common Issues](#-common-issues)
- [🎯 Roadmap](#-roadmap)
- [🤝 Contributing](#-contributing)
- [👥 Contributors](#-contributors)
- [📞 Support](#-support)
- [📄 License](#-license)

</details>

---

## ✨ Why DSMNRU Archive?

| Before (Modal-only) | After (Resource Hub) |
|---|---|
| PYQs in a list, preview in modal, no SEO | **1 crawlable URL = 1 public paper** (`/pyq/<slug>`) — server HTML, breadcrumb, JSON-LD; legacy `paper.html?id=xxx` still works |
| Search loads all docs every keystroke → hits 50K quota | **Session + 15m cache** → 0 reads on refresh/search, 12 reads for homepage vs N |
| Anon can scrape all PDFs | **Login gate** for Search / Filters / Load More / Preview — drives sign-ups, saves quota |
| Uploads via temporary hosts | **gofile.io** + admin review queue, image→PDF auto-merge (≤10 MB) |
| No feedback loop | **Report Broken Link / Request PYQ** → admin Feedback inbox |

---

## 🌟 Features

### For Students 🎒
- 🔐 **Auth** — Email/Password + Google, email verification **enforced** (blocking overlay, no bypass)
- 👤 **Profiles** — Name, course, phone, avatar
- 📚 **Browse PYQs** — 20 free on load, **View Details** → canonical `/pyq/<slug>` when available (legacy `paper.html?id=` fallback preserved; locked preview + inline same-site viewer for `archive.org`/`catbox.moe`, never jumps out)
- 🔍 **Search & Filters** — Course / Semester / Session + Sort (Newest, Most Viewed, A-Z) — gated, 0 reads when cached
- 📖 **Paper Detail Page** — Breadcrumb, pills (course/sem/session/branch/views), inline preview, **Server 1/2** same-site, **Report**, **Related** (6, cache-first), **Discussion** (comments)
- 📤 **Upload** — Single PDF or multiple images → auto-merged PDF (jsPDF, 6 quality attempts) → `pendingUploads` (no sign-in required)
- 🏆 **PYQ Points** — **Earn 10 points for every approved PYQ.** Points are collected against your email (works before you sign up) and show up in your profile with a reward history. *Points are currently being collected. Redemption will be available in a future rewards update.*
- 🧰 **Student Tools** — SGPA Calculator, Study Planner (reminders), Attendance Tracker (per-date)
- 📝 **Feedback** — Report Broken Link / Request PYQ → `feedback` collection
- 🌗 **PWA** — Installable, offline cache (`sw.js v5`), works on `localhost` + HTTPS
- 💬 **Live Chat** — Floating chat widget → `realtime-agent`

### For Admins 🛡️
- 🔑 **Secure Login** — Admin check via `pendingUploads` read permission (no email exposed)
- ➕ **Quick Create** — Course / Sem / Session / Subject / Branch → auto `title` → `pyqs` with `file`/`file2`
- 📥 **Bulk CSV Import** — `pyqs` / `contributors` ( `id` → update, else create )
- 📚 **Content Library** — Card list, local **0-read search** (`#adminPyqSearch`), Copy Server 1/2, Edit/Delete by **doc id** (fixes filtered delete bug)
- ⏳ **Review Queue** — every `pendingUploads` submission → filters `Pending / Approved / Rejected / All`, Download / Copy URL / **Approve (+10 points)** / **Reject (0 points)** / Delete
- 👥 **Contributors** — Add/edit/delete (`PYQs Provider` etc.)
- 👤 **Users** — Registered profiles, edit role/course/phone, delete
- 🚩 **Feedback Inbox** — **NEW** `Broken Reports & PYQ Requests` → filters `All / Broken / Requests / New`, `Mark Resolved` / `Delete` / `Clear resolved`, realtime `new` pulse, counts in hero
- 🔔 **Notifications** — compose + preview a push for all installed Android devices → `POST /api/notify` (admin token) → FCM topic `all_users` (30 s duplicate-send cooldown)
- 📊 **Lazy Admin** — **0 reads on login** — each section fetches only when expanded (saves 50K quota), hero note: *"Expand any card to fetch"*
- 🧹 **No Analytics** — Intentionally removed (non-mandate) to save reads

---

## 🆕 What's New (PR #2 — `c6591ea` → `22002f9` → `451dd05` → `50347a8` → `5a1fb44`)
- **`paper.html?id=xxx`** — breadcrumb, view count, same-site preview (no `archive.org` jump), related, comments, share, report, JSON-LD
- **`firestore.rules`** — `isVerified()` for `views` increment + `comments`/`feedback`/`pendingUploads` writes; `pyqs` read public, write admin-only
- **Cache** — `sessionStorage` + `localStorage TTL 15m` + Firestore persistence → homepage 12 reads vs N, search 0 reads when cached (signed-in only)
- **Gates** — Search/Filters/Load More/paper preview now require **login + verified email** (blocking overlay, `static` modal, re-show if dismissed)
- **Admin** — Feedback inbox, lazy 0-read, local search, id-based delete/edit fix
- **Homepage** — Simplified to **single View Details button** → paper page (no Open/Backup/Share/Bookmark clutter), Trending/Recently/Bookmarks tab removed

---

## 🛠️ Tech Stack

| Layer | Tech |
|---|---|
| Frontend | HTML5, CSS3 (Manrope, glassmorphism), vanilla JS, Bootstrap 5.3, Font Awesome 6, SweetAlert2 |
| Backend (public data) | **Cloudflare Worker API** (`worker/`) — Firestore REST via service account, Cloudflare Cache API + KV, rate limiting |
| Backend (user-scoped) | Firebase Auth (compat 9.22.1), Firestore, Storage (compat), `enablePersistence({synchronizeTabs:true})` |
| PWA | `sw.js` (cache-first, API bypass), `manifest.json`, `sitemap.xml`, `robots.txt` |
| Tools | jsPDF 2.5.1 (image→PDF), PapaParse 5.4.1 (CSV), Normalize.css |
| Hosting | Netlify (`dsmnru-pyq.netlify.app`) + Cloudflare Workers (free) + Firebase |
| PDF storage | Archive.org / Catbox (unchanged) |

---

## 📂 Project Structure

```
.
├── index.html          # Homepage — search, filters, 20 free PYQs → View Details
├── paper.html          # Shared interactive paper shell; Worker fills it for /pyq/<slug>, legacy ?id= remains
├── paper.js            # Paper logic — cache-first related, verification block, same-site preview
├── script.js           # Main — auth, cache (session+15m), gated search, upload, tools, feedback
├── points.js           # Shared contribution-points helpers (email normalize + reward account key)
├── duplicate-check.js  # Shared duplicate-matching helpers (title-led, admin assistance only)
├── admin.html          # Admin — lazy sections, Feedback inbox, local search
├── admin.js            # Admin — CRUD, persistent PYQ slug bases, Firebase-token cache invalidation
├── styles.css          # Dark glass theme, design tokens, responsive
├── sw.js               # Service Worker v5 — caches /, /index.html, /paper.html, /styles.css, /script.js, /paper.js
├── manifest.json       # PWA manifest (standalone, theme #0f172a)
├── sitemap.xml         # Legacy static fallback; Netlify force-rewrites canonical requests to Worker-generated XML
├── firestore.rules     # NEW — isVerified() + isAdminByEmail() + pendingUploads/comments/feedback rules
├── cors.json           # CORS for local + Netlify
├── courses.json        # Course catalog for filters
├── tools.html          # SGPA / Attendance / Planner
├── links.html          # University portals
├── contributors.html   # Contributors grid
├── _redirects          # Netlify → Worker /api/* proxy (optional)
├── ARCHITECTURE.md     # New Worker architecture, API docs, migration/rollback
├── worker/             # Cloudflare Worker API (free tier)
│   ├── wrangler.toml   # Worker config (KV binding, vars)
│   ├── src/            # index.js (routes), seo.js (public SSR), slug.js,
│   │                   # firestore.js, cache.js, search.js, auth.js, rateLimit.js,
│   │                   # validation.js, cors.js
│   └── test/           # worker.test.js + frontend smoke tests + read simulation
└── img/Logo.png
```

---

## 🚀 Quick Start

```bash
# 1. Clone
git clone https://github.com/Lav-developer/PYQ.git
cd PYQ

# 2. Run (no build needed)
python -m http.server 8000
# or
npx serve .
# Visit http://localhost:8000
# Admin: http://localhost:8000/admin.html
```

> **PWA install** needs HTTPS — works on `localhost` and Netlify, not on `file://`.

---

## ☁️ Cloudflare Worker API (new architecture)

> **Public data no longer flows directly from Firestore to the browser.** All
> public reads (PYQ list, search, filters, paper detail, contributors,
> homepage, stats) go through a **Cloudflare Worker** that serves from the
> **Cloudflare Cache API** and **Cloudflare KV**, with **Firestore as the
> source of truth**. This keeps Firestore reads near zero under traffic.

```
Netlify Frontend → Cloudflare Worker → Edge Cache / KV → Firestore (only on cache miss)
```

- Worker code: [`worker/`](worker/) (`wrangler.toml`, `src/*`, tests)
- Deployment & secrets: [`worker/README.md`](worker/README.md)
- Full design, API reference, migration & rollback: [`ARCHITECTURE.md`](ARCHITECTURE.md)
- Firestore read simulation (OLD vs NEW): [`worker/test/performance-simulation.md`](worker/test/performance-simulation.md)
- The browser still uses the Firebase SDK **only** for user-scoped data
  (auth, profile, comments, feedback, uploads, view increments) and admin
  writes. PDFs remain on Archive.org / Catbox — untouched.

Run the Worker test suite:

```bash
cd worker
npm install
node test/worker.test.js        # 132 assertions, mocked Firestore
```

Frontend smoke tests (need `jsdom`):

```bash
cd worker
npm install --no-save jsdom
node test/frontend-smoke-test.cjs
node test/paper-smoke-test.cjs
node test/contribution-points-test.cjs   # 65 assertions — upload → pending → approve/reject → points
node test/duplicate-detection-test.cjs   # 45 assertions — title-led matching + admin hint UI
node test/admin-ia-test.cjs              # 68 assertions — sidebar IA, lazy loading, rewards
node test/duplicate-index-freshness-test.cjs  # 13 — exact-title regression (stale index)
```

## 🔧 Environment & Firebase Setup

**1. Create Firebase project** → Enable **Auth** (Email/Password + Google) → **Firestore** (test mode then apply rules below).

**2. Copy config** into `script.js`, `admin.js`, `paper.js`, `admin.html`:
```js
const firebaseConfig = {
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_AUTH_DOMAIN",
  projectId: "YOUR_PROJECT_ID",
  storageBucket: "YOUR_STORAGE_BUCKET",
  messagingSenderId: "YOUR_SENDER_ID",
  appId: "YOUR_APP_ID",
  measurementId: "YOUR_MEASUREMENT_ID"
};
```

**3. Create collections:** `pyqs`, `users`, `contributors`, `pendingUploads`, `feedback`, `comments`, `meta` (optional).

**4. Create admin user** in Auth, then in Firestore `users/{uid}` set `role: "admin"` and in Rules replace `abc@gmail.com` with your admin email.

**5. Deploy rules:**
```bash
firebase deploy --only firestore:rules
# or paste firestore.rules in Console → Firestore → Rules → Publish
```

---

## 📡 Data Model & Collections

**`pyqs`** — `title` (auto-generated `Course Branch Sem Subject {Session}`), `file` (Server1), `file2` (Server2), `course`, `semester`, `session`, `subject`, `branch`, `description`, `views` (int), `createdAt` (timestamp)

**`users`** — `uid`, `email`/`signupEmail`, `name`/`signupName`, `course`/`signupCourse`, `phone`, `role`, `emailVerified`, `createdAt`, `makeSubscriberSynced` etc.

**`contributors`** — `name`, `avatar` (initials), `role` (`PYQs Provider`)

**`pendingUploads`** (PYQ submissions / review queue) — `title`, `course`, `semester`, `studentName`, `studentCourse`, `studentEmail` (**normalized** — the reward identity), `email` (same value, alias), `userId`, `fileName`, `downloadUrl` (gofile), `fileSize`, `uploadedAt`, `status: 'pending' | 'approved' | 'rejected'`, `reviewedAt`, `reviewedBy`, `reviewedByUid`, `rejectionReason`, `pointsAwarded`, `pointsTransactionId`, `pointsAmount`

**`reward_accounts`** — doc id = normalized email with non-alphanumerics replaced by `_` (`rahul@gmail.com` → `rahul_gmail_com`). Fields: `email`, `points`, `uid` (linked when the contributor signs up), `createdAt`, `updatedAt`

**`point_transactions`** — one document **per rewarded submission** (doc id = submission id): `email`, `amount: 10`, `type: 'PYQ_UPLOAD_REWARD'`, `submissionId`, `rewardAccountKey`, `uid`, `createdBy`, `createdAt`. Because the doc id is the submission id, a submission can never be rewarded twice.

**`feedback`** — `type` (`broken_link` | `pyq_request`), `status: 'new'|'resolved'`, `title`/`course`/`details` or `course`/`subject`/`semester`/`session`, `email`, `userId`, `userEmail`, `createdAt`

**`comments`** — `paperId`, `text` (3-600), `userId`, `userName`, `userEmail`, `createdAt` (also supports `pyqs/{id}/comments` subcollection fallback)

**Local Storage:** `dsmnruStudyPlanner`, `dsmnruAttendance`, `dsmnruCgpaLast`, `profileCompletionDismissed`, `dsmnru_pyqs_full_v1` + `dsmnru_pyqs_full_time_v1` (cache), `dsmnru_pyqs_session_v1`

---

## 🔐 Firestore Security Rules

See `firestore.rules` — key ideas:

```js
function isAdminByEmail() { return auth.token.email == "YOUR_ADMIN@gmail.com"; }
function isVerified() { return auth.token.email_verified == true; }

// pyqs: public read, admin full write, verified can +1 views only
match /pyqs/{doc} {
  allow read: if true;
  allow create, delete: if isAdminByEmail();
  allow update: if isAdminByEmail() || (isVerified() && diff.hasOnly(['views']) && views+1);
}

// comments/feedback: create requires isVerified()
match /comments/{id} { allow read: true; allow create: if isVerified() && text 3-600 && userId==auth.uid; }
match /feedback/{id} { allow read: if isAdminByEmail(); allow create: if isVerified() && type in [...] && status=='new'; }

// pendingUploads (submissions): public create of a PENDING doc only — no sign-in,
// and a client can never write points / review state
match /pendingUploads/{doc} { allow read/update/delete: if isAdminByEmail(); allow create: if isValidPendingSubmission(); }

// points: admin-only writes; a student can read (and uid-link) their own reward data
match /reward_accounts/{key}  { allow read: if isAdminByEmail() || ownsRewardEmail(resource.data); allow create, delete: if isAdminByEmail(); allow update: if isAdminByEmail() || (uid-only self link); }
match /point_transactions/{id}{ allow read: if isAdminByEmail() || ownsRewardEmail(resource.data); allow create, update, delete: if isAdminByEmail(); }
```

> ⚠️ Set the real admin email in `isAdminByEmail()` before deploying.

**Deploy after editing `abc@gmail.com` → your email.**

---

## 📤 Student Upload Flow

1. Fill **Help us grow** → Your Name, **Your Email (required)**, Title, Course/Sem, **1 PDF or N images** (≤10 MB final). **No sign-in needed.**
2. Images → `jsPDF` 6 attempts (2000px→900px, 0.9→0.58 quality) → single PDF
3. PDF → `https://api.gofile.io/servers` → `https://{server}.gofile.io/uploadFile` → `downloadPage` URL *(unchanged)*
4. Metadata → `pendingUploads` (`status: pending`, email normalized to lowercase) → *"Submission received — 10 points will be credited if approved"*
5. Admin → *Review Queue* → Download → verify → **Approve (+10 points, idempotent)** or **Reject (0 points)**
6. Publishing stays manual: *Quick Create* → `pyqs` (approval never publishes)

---

## 🏆 PYQ Contribution Points

**Earn 10 points for every approved PYQ.** Points are currently being
collected; redemption will be available in a future rewards update (they have
no monetary value today).

```
Student uploads PDF + email   →   gofile temporary file (unchanged)
        ↓
pendingUploads doc  status = "pending"     ← public create, no sign-in
        ↓
Admin → Review Queue → Preview/Download (existing gofile link)
        ↓
Approve → status "approved" + reviewedAt/reviewedBy + 1 ledger entry + points += 10
Reject  → status "rejected" + reviewedAt/reviewedBy (+ optional reason) + 0 points
        ↓
Student profile → 🏆 PYQ Points + reward history
```

**Email is the reward identity.** Every email is normalized (`trim` +
`lowercase`) by `points.js` — the single shared module loaded by both the
public pages and the admin panel — so `Rahul@gmail.com`, `rahul@gmail.com` and
`RAHUL@GMAIL.COM` all land on `reward_accounts/rahul_gmail_com`.

**Works before an account exists.** Points are stored on the email-based
reward account, so a contributor who signs up later (email/password or Google)
with the same email immediately sees every point already earned. On first
profile load the account is linked to their `uid` — the rules allow a client to
change **only** `uid`, never `points`.

**Idempotent by design.** The ledger document id **is** the submission id, and
approval runs inside a single Firestore transaction that re-reads the ledger
entry and the `pointsAwarded` flag. A second approval therefore adds `+0` —
there is no way for one submission to be rewarded twice, even with two admins
clicking at once.

**Rejected submissions never earn points**, and an already-rewarded submission
cannot be downgraded to `rejected` from the admin panel.

**Security:** only the admin (rules `isAdminByEmail()`) can read the review
queue, change a status or write a balance. A public create is limited to a
`status: 'pending'` document with a valid email and gofile URL, and may not
contain any points or review field. Points are never sent from, or trusted on,
the client.

**Manual steps for this feature:** deploy the updated `firestore.rules`
(`firebase deploy --only firestore:rules`) after setting your real admin email
in `isAdminByEmail()`. No collection has to be created by hand — Firestore
creates `reward_accounts` / `point_transactions` on the first write. No data
migration is required: submissions created before this feature have no `status`
field and are treated as `pending`.

---

## 👨‍💼 Admin Guide

**Login:** `admin.html` → admin email → Dashboard. Non-admin auto sign-out. Authorization is unchanged: `isAdminUser()` probes an admin-only read and the Firestore rules (`isAdminByEmail()`) enforce every write.

### Information architecture

A **persistent sidebar** replaces the old wall of dashboard cards. Each destination is a focused workspace; only the open view is rendered, and each one fetches its data the first time it is opened (lazy loading preserved — **0 reads on login**).

```
Sidebar
  Dashboard                 KPIs + recent activity + shortcuts
  PYQ Management
    ├─ All PYQs             library, 0-read local search, edit/delete
    ├─ Add PYQ              the Quick Create form
    └─ Bulk Import          the CSV import form
  Review Queue              student submissions → Preview / Download / Approve +10 / Reject
  Contributors              contributor CRUD
  Users                     registered profiles + roles
  Feedback                  broken-link reports + PYQ requests
  Rewards                   points issued, ledger, balances (read-only)
  Settings                  session, Worker cache invalidation, CSV backup
```

Desktop keeps the sidebar pinned; below 992px it becomes a drawer behind a hamburger (`.admin-nav-toggle`) with a dismiss backdrop. Views are deep-linkable via the URL hash (`admin.html#review`) and the browser back button works.

**Dashboard** is an overview only — no management forms live there. It shows the 5 KPI cards, the submissions waiting for review, the most recently added PYQs, and `[Add PYQ] [Bulk Import] [Review Pending]` shortcuts. It performs exactly two reads: the bounded `pendingUploads` query (the action-critical one) and a cached `GET /api/homepage` for the PYQ total + recent papers (**zero Firestore reads**). User / contributor / feedback counts show `—` until their `Load count` action (or their section) fetches them.

**All PYQs:** local **0-read search** → `Edit` (id-based) / `Delete` (id-based) / `Copy Server 1/2`.

**Add PYQ:** Course / Sem / Session / Subject / Branch → auto-title → Server 1 (+ Server 2) → `Add PYQ`.

**Bulk Import:** target `pyqs` / `contributors` → `.csv` (`collection,id,title,Server 1,Server 2,course,semester,session`) → `Import` (id → update, else add).

**Review Queue:** filters `Pending / Approved / Rejected / All`; each card shows title, uploader email, course, semester, time and status with `[Approve +10] [Reject 0] [Preview] [Download] [Copy URL] [Delete]`. Preview opens the temporary gofile page in a new tab.

**⚠ Possible Existing PYQs:** each *pending* card lists up to **5** similar published papers sorted by confidence, each with a `[View]` link. Matching is title-led (`duplicate-check.js`: normalized token overlap + a Levenshtein fallback — no AI, embeddings or external APIs); `course` and `semester` only raise or lower confidence **when both records have them**, a missing field is never a mismatch, and nothing is ever auto-excluded or auto-rejected. An **identical normalized title always scores 100% and ranks #1**, whatever the optional fields contain.

The candidate list is read from **Firestore, the source of truth** — it reuses the in-memory library when *All PYQs* is already open, otherwise it does one bounded `pyqs` read. The Worker's `/api/pyqs` is only a last-resort fallback (its KV index is rebuilt on invalidation or after a 7-day TTL, so it can silently omit a recently published paper); when the fallback is used the card says so. The index is dropped on every PYQ add/edit/delete/import, and **Re-check duplicates** re-reads on demand. The admin decides: same paper → Reject (0 points), different paper → Approve (+10 points).

**Points:** `Approve` runs one Firestore transaction — status → `approved`, `reviewedAt` / `reviewedBy`, a `point_transactions` ledger entry (id = submission id) and `reward_accounts/{email}` `points += 10`. Approving twice adds **0** the second time. `Reject` stores an optional reason and awards nothing. Approval **never** publishes the PYQ and never touches the temporary gofile file.

**Rewards:** read-only view over the points system — total points issued, contributors rewarded, how many balances are linked to a Firebase account, the 25 newest ledger entries and every balance sorted by points. No redemption, payout or withdrawal exists.

**Contributors:** Add (name → auto avatar) / Edit / Delete.

**Users:** `Edit` (name/course/phone/role) / `Delete`.

**Feedback:** filters `All / Broken / Requests / New`, `Mark Resolved` / `Delete` / `Clear resolved` + `Refresh`.

**Settings:** signed-in identity, Worker cache invalidation using the signed-in Firebase admin token, and `database-backup.csv` — **all collections** (`pyqs`, `contributors`, `users`, `pendingUploads`, `feedback`, `comments`) with every field, fresh from Firestore. The floating `file-csv` shortcut still works too.

---

## 🎨 Styling & Theme

Glassmorphism dark theme (`styles.css` tokens: `--color-primary` teal, `--color-background` charcoal, `--color-surface` card). All pages share `Manrope` + `FKGroteskNeue`, `backdrop-filter: blur(14px)`, `border-radius: 18-24px`. Edit tokens in `:root` for theming.

---

## 📱 Android App & APK Download

The repository has two deployables:

- **`main`** — the website (this branch) + its Cloudflare Worker API.
- **`android-app`** — a dedicated Capacitor Android app (`com.dsmnru.pyq`, currently 1.4.0 / build 11, min Android 7.0) with its own UI, in-app PDF viewer, uploads and FCM push.

The website serves **`/download.html`**, which reads the current APK link from the centralized **`/apk-config.js`** — the only place the site points at a release asset. APK binaries are never committed to `main`.

**Notification chain:** admin panel → `POST /api/notify` (Cloudflare Worker, admin Firebase ID token verified server-side) → FCM topic `all_users` → Android app. The Android app subscribes to that topic itself — no FCM token database is used.

See **`docs/android-notification-integration.md`** for the full contract, secret setup and release flow.

## 📱 PWA & Offline

- `sw.js v5` caches `/`, `/index.html`, `/paper.html`, `/styles.css`, `/script.js`, `/paper.js`, `courses.json`, `manifest.json`
- `manifest.json` → `standalone`, `theme #0f172a`, emoji icons
- Install via Chrome address bar → offline after first load (Firestore persistence + Cache API)

---

## 🔍 SEO & Performance

- **Server-rendered public URL per paper** (`/pyq/<slug>`) with unique `title`/description, index/follow, canonical, Open Graph, Twitter, public H1, breadcrumbs, related links, and `LearningResource` + breadcrumb JSON-LD
- Dynamic `sitemap.xml` from the public KV search index, plus `robots.txt` (allows `/pyq/`, disallows the admin/API surfaces)
- Legacy `paper.html?id=xxx` links remain functional and hydrate a pretty canonical URL when the warm public index supplies it; crawler hydration on `/pyq/` does not trigger automatic direct-Firestore view/comment work
- Lighthouse: inline skeletons, `content-visibility` ready, `loading="lazy"` on iframes

---

## ⚡ Caching & Quota Saving (50K Reads)

**Problem (OLD):** `pyqs.get()` from the browser on every search = `N reads ×
searches` → hits 50K/day.

**Fix (NEW):** the browser calls the Cloudflare Worker API instead of reading
Firestore. The Worker serves public data from the **Cloudflare Cache API**
(edge, whole responses) and **KV** (compact search index, per-item docs,
contributors, courses, homepage) with Firestore only touched on cache miss.

- **Browse/Search/Filters:** served from the Worker's KV search index — **0
  Firestore reads** for every user once the index is warm. The index is
  refreshed by **admin invalidation** (`POST /api/invalidate`) — a 7-day
  hard-TTL acts only as a safety fallback. There is **no aggressive
  short-cycle rebuild**.
- **Paper detail:** KV-cached per item (1 h); **1 read** only on a genuine
  first-item miss, then 0 for everyone else. After an admin invalidation, an
  older item entry is intentionally revalidated once before reuse so a newly
  private paper cannot be served from a pre-change cache.
- **Contributors:** KV-cached (1 h); 1 read per hour
- **Homepage (recent/trending/course counts/stats):** KV-cached (5 min)
- **Admin invalidation:** `POST /api/invalidate` carries the signed-in
  Firebase ID token. The Worker verifies its signature, Firebase issuer/audience,
  and `admin: true` custom claim; there is no browser-visible static key. The next
  request serves the stale index while a single-flight background rebuild
  (`ctx.waitUntil`) runs via the Worker.
- **View increments / comments / feedback / uploads / auth:** still direct
  Firestore (user-scoped writes or ≤30-doc scoped reads — not full collections)

Pagination correctness uses a composite cursor (`[primaryFieldValue,
__name__]`) so duplicate primary orderBy values (e.g. `views`) never
skip or duplicate rows across pages.

See [`worker/test/performance-simulation.md`](worker/test/performance-simulation.md)
for the read-count table (311 → 10,000 PYQs, 100 users).

---

## 🛡️ Auth & Verification

- `isGoogleUser()` → Google considered verified
- `requiresEmailVerification(user) = !isGoogleUser && !emailVerified`
- **Enforced:** Search/Filters/Load More/paper preview/comment/upload/report all check `isVerifiedOrPrompt()` → shows **blocking overlay + static modal** (`backdrop:'static', keyboard:false`, re-shows if dismissed) with `Resend` / `I verified — Check` / `Use different email` (deletes unverified account)
- Server: `isVerified()` in `firestore.rules` for all writes

---

## 🧪 Development Workflow

```bash
# Add feature
# 1. UI → index.html / paper.html / admin.html
# 2. Logic → script.js / paper.js / admin.js (keep id-based, not index)
# 3. Style → styles.css (tokens)
# 4. Test locally + check Firestore rules
# 5. Bump sw.js CACHE_NAME if caching changed
```

---

## 🚨 Common Issues

- **Admin can't delete** → `permission-denied` → check `firestore.rules` admin email + ensure logged in as admin (pendingUploads read test)
- **Verification bypassed** → ensure `firestore.rules` published and hard-refresh (old rules cached)
- **Homepage blank** → was bookmark tab `null` error → fixed in `5b38bd3` (guarded), hard-refresh
- **Comment prompt always visible** → was `d-flex !important` + duplicate `style` → fixed in `50347a8`
- **Paper jumps to archive.org** → fixed in `d7d63be` → Server 1/2 now load **inline** on same site
- **Counts 0 in admin** → intentional lazy — expand a section to fetch

---

## 🎯 Roadmap

- [x] Paper Detail SEO + same-site preview
- [x] Feedback inbox
- [x] Cache + gates
- [x] Lazy admin
- [ ] Rating & reviews
- [ ] Solution uploads
- [ ] Discussion forum
- [ ] Mobile app (TWA)
- [ ] i18n

---

## 🤝 Contributing

PRs welcome! For large features, open an issue first.

```bash
git checkout -b feat/my-feature
# ... make changes, test locally
git commit -m "feat: my feature"
git push origin feat/my-feature
# Open PR to main
```

Please keep **id-based** edits/deletes and **0-read** local searches.

---

## 👥 Contributors

See `/contributors.html` and the `contributors` collection. Thank you to all student contributors! Add yourself via *Help us grow* → admin will credit you.

---

## 📞 Support

- 💬 **Live Chat** — floating chat button → `realtime-agent`
- 📝 **Report / Request** — `Request PYQ` / `Report broken link` modals (card after PYQs + paper page) → admin Feedback
- 📧 **Email** — via profile / feedback `email` field

---

## 📄 License

MIT — for DSMNRU students and contributors.

<div align="center">
  <strong>Built with ❤️ for DSMNRU Students</strong> 🎓<br/>
  <sub>DSMNRU PYQs only • Not affiliated with DSMNRU University</sub>
</div>
