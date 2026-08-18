# DSMNRU PYQ — Scalable Data-Access Architecture (Cloudflare Workers)

This document describes the migration from browser-direct Firestore reads to a
zero-cost Cloudflare Worker API with edge caching, KV-cached indexes, and
Firestore as the source of truth.

```
User
  ↓
Netlify Frontend (index.html / paper.html / contributors.html)
  ↓  fetch('/api/...')
Cloudflare Worker API (worker/src/index.js)
  ↓
Cloudflare Cache API (edge) → Cloudflare KV (search index, items, contributors)
  ↓ cache miss
Firestore REST API (source of truth, service-account auth)

PDFs: unchanged — Archive.org / Catbox URLs stored in Firestore metadata
```

**PDF storage is untouched. Firestore remains the source of truth. No data is
migrated anywhere.**

---

## 1. What changed (files)

| File | Change |
|---|---|
| `worker/**` | **New** — Cloudflare Worker (API, Firestore REST client, cache, search index, rate limiting) |
| `script.js` | Public PYQ/contributor/homepage reads now call the Worker API (`fetch('/api/...')`). Auth, profile, comments, feedback, uploads and view-increments still use the Firebase SDK directly (user-scoped reads/writes only). |
| `paper.js` | Paper detail + related papers now come from the Worker API. Comments and view increments unchanged. |
| `admin.js` | Unchanged logic (writes to Firestore as before) + best-effort cache invalidation (`invalidateApiCache()`) after PYQ/contributor changes. |
| `firestore.rules` | `pyqs` and `contributors` public reads removed — the Worker (service account) is the only public read path. Admin + view-increment rules preserved. |
| `sw.js` | v6 — never serves stale cache for `/api/*` requests. |
| `_redirects` | Netlify → Worker proxy for `/api/*` (optional; see §3). |
| `index.html`, `paper.html`, `contributors.html` | Added `window.DSMNRU_API_URL` config block. |

## 2. Frontend behavior preserved

- Browse / Load More / search / filters / sorting / recently added / trending /
  course cards / contributors / paper detail / PDF preview & download / auth /
  profiles / comments / uploads / feedback — **all unchanged in the UI**.
- Search & filters still require login + verified email (existing gate kept).
- The browser no longer performs any full-collection Firestore read.

## 3. Deployment (Cloudflare Worker)

### Prerequisites

1. A Cloudflare account (free plan).
2. A Firebase **service account** JSON:
   Firebase Console → Project settings → Service accounts →
   **Generate new private key** → save the JSON (e.g. `dsmnru-data-adminsdk.json`).
3. IAM: the service account needs the **Cloud Datastore User** role on the
   project (Firebase Console → IAM → grant the service account email the role).
   Service accounts bypass Firestore security rules, so the Worker can read
   everything even with the tightened rules.

### Steps

```bash
cd worker
npm install

# 1. Create the KV namespace and copy its id into wrangler.toml
npx wrangler kv:namespace create PYQ_CACHE

# 2. Set secrets (never commit these)
npx wrangler secret put FIREBASE_SERVICE_ACCOUNT_JSON   # paste full JSON file contents
npx wrangler secret put ADMIN_API_KEY                   # any long random string

# 3. Edit wrangler.toml:
#    - [[kv_namespaces]] id = "<id from step 1>"
#    - [vars] ALLOWED_ORIGINS (defaults include the Netlify site)

# 4. Deploy
npx wrangler deploy
```

Deploy output prints the Worker URL, e.g.
`https://dsmnru-pyq-api.<your-subdomain>.workers.dev`.

### Wire the frontend to the Worker (choose one)

**Option A — Netlify proxy (zero code change):** in `_redirects` replace the
placeholder target with your Worker URL and uncomment the rule:

```
/api/*  https://dsmnru-pyq-api.<your-subdomain>.workers.dev/api/:splat  200
```

**Option B — direct URL (recommended for rate limiting):** in
`index.html`, `paper.html`, `contributors.html` uncomment and set:

```html
<script>window.DSMNRU_API_URL = "https://dsmnru-pyq-api.<your-subdomain>.workers.dev";</script>
```

Option B keeps the user's real IP visible to the Worker's rate limiter
(`CF-Connecting-IP`); with Option A all traffic arrives via Netlify's IPs.

### Apply the tightened Firestore rules (after the Worker is live)

```bash
firebase deploy --only firestore:rules
```

> ⚠️ Apply **after** the Worker is deployed and verified, otherwise the site
> has no public read path. Rollback: restore the previous rules file.

## 4. Environment / secrets reference

| Binding | Type | Description |
|---|---|---|
| `PYQ_CACHE` | KV namespace | Cache: search index, per-item docs, contributors, courses, homepage, stats, rate-limit counters |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | secret | Full Firebase service-account JSON (used for Firestore REST auth) |
| `ADMIN_API_KEY` | secret | Shared key for `POST /api/invalidate` (set the same value in `admin.js` → `API_INVALIDATE_KEY`) |
| `FIREBASE_PROJECT_ID` | var | e.g. `dsmnru-data` |
| `ALLOWED_ORIGINS` | var | Comma-separated CORS allow-list |

## 5. API reference

Base URL: `<worker>/api` (or same-origin `/api` via the proxy).

| Method | Path | Description |
|---|---|---|
| GET | `/health` | Health check |
| GET | `/pyqs?page=1&limit=20&sort=newest&course=..&semester=..&session=..` | Paginated list (filters optional) |
| GET | `/pyqs/search?q=..&course=..&semester=..&session=..&sort=..&page=1&limit=20` | Server-side search |
| GET | `/pyqs/:id` | Full document incl. `file`/`file2` URLs |
| GET | `/contributors` | Contributor list |
| GET | `/courses` | Course catalog |
| GET | `/homepage` | `{ recent, trending, courseCounts, stats }` |
| GET | `/stats` | `{ totalPyqs, totalCourses }` |
| POST | `/invalidate` | Purge caches — header `X-Api-Key` |

**Query validation:** `page` 1–100, `limit` 1–100 (server-enforced), `sort` ∈
`newest|popular|az|za|oldest`, `semester` ∈ `1st..8th`, search `q` ≥ 2 chars,
max 200 chars, HTML stripped. Unknown params ignored.

**Responses** are JSON. List/search return `{ items, total, page, limit,
totalPages }`. Errors return `{ error }` with appropriate status (400/401/404/
405/429/500).

## 6. Cache strategy & invalidation

**Edge (Cloudflare Cache API):** full GET responses, TTL 60 s (search) … 1 h
(courses), with `stale-while-revalidate`.

**KV:**
- `pyq:search:index` — compact metadata for all PYQs (id, title, course,
  semester, session, branch, subject, year, views, recency) — **10-min TTL**
- `pyq:pyqs:item:<id>` — full doc incl. file URLs — **1-h TTL**
- `pyq:contributors:list` — **1-h TTL**
- `pyq:courses:list` — **24-h TTL**
- `pyq:homepage:summary`, `pyq:stats` — **5/10-min TTL**

**Invalidation:**
- Admin content changes → `POST /api/invalidate` with the API key clears the
  KV keys above and stamps an invalidation timestamp. `admin.js` calls this
  automatically after PYQ/contributor add/edit/delete (set
  `API_INVALIDATE_KEY` to match the Worker secret).
- If the key is not set, admin changes appear after the TTL (safe fallback —
  **no aggressive full-database refresh**, the old every-few-minutes refresh
  is removed).

## 7. Failure handling

- Firestore down + KV warm → stale cached data served (by design; academic
  archive tolerates slight staleness).
- Firestore down + KV cold → API returns `500 { error }`; frontend shows a
  graceful empty/error state (existing `showEmptyState` paths) and never fully
  breaks.
- No aggressive retries: index rebuilds happen only on TTL expiry or explicit
  invalidation.

## 8. Migration steps (production)

1. Deploy the Worker (§3), point the frontend at it (Option A or B).
2. Smoke-test: homepage, browse, Load More, search, filters, sorting,
   contributors, paper detail, PDF open.
3. Deploy `firestore.rules` (tightened public reads).
4. Set `API_INVALIDATE_KEY` in `admin.js`, redeploy Netlify.
5. Watch `wrangler tail` for cache-hit vs cache-miss logs for a day.

## 9. Rollback

- **Frontend:** revert `script.js`, `paper.js`, `admin.js`, `sw.js`,
  `_redirects` (or unset `DSMNRU_API_URL`) and redeploy Netlify. The old
  browser-direct Firestore code returns.
- **Rules:** restore the previous `firestore.rules` (`allow read: if true` on
  `pyqs`/`contributors`) and `firebase deploy --only firestore:rules`.
- **Worker:** `npx wrangler delete` (or keep it — harmless with no frontend
  calling it).
- No data migration exists to roll back: Firestore and PDF URLs are untouched.

## 10. Firestore read budget (normal traffic)

See `worker/test/performance-simulation.md` for the full table. Summary:

- 100 users, cold cache: **~N + C + U** reads (N = PYQ count, U = distinct
  papers opened), vs **~200N** before.
- 100 users, warm cache: **0 reads** for browse/search/homepage/contributors;
  **1 read per distinct paper** opened.
- 311 PYQs → ~412 reads cold / ~0 warm (old: ~62K).
- 10,000 PYQs → ~10,101 cold / ~0 warm (old: ~2M).

The system no longer requires a full 10,000-document Firestore read for every
user; the index rebuild (10-min TTL, or only on admin invalidation) is the
only collection-scale read, and it is shared by all users.

## 11. Testing

`cd worker && node test/worker.test.js` — 69 assertions against a mocked
Firestore (311 PYQs, 5 contributors):

health, list pagination (incl. limit/page capping), filters, search (incl.
short-query 400, HTML stripping, year search), sorting, single-item
(200/404/400), contributors, courses, homepage, stats, **cache-hit = 0
Firestore reads**, KV item caching, rate limiting (429), invalid routes,
method not allowed, cache invalidation (200 with key / 401 without), CORS.
