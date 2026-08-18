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

### Hard rule: no aggressive short-cycle rebuilds

The previous "every N minutes rebuild the entire PYQ collection from
Firestore" architecture is **gone**. Under normal traffic the cache stays
warm and **does not perform any rebuild**. Rebuilds happen only when
explicitly triggered.

### Refresh order of precedence

1. **Admin invalidation** (`POST /api/invalidate` from `admin.js`).
   Stamps an invalidation timestamp in KV; the next request detects
   `lastInvalidatedAt > lastBuiltAt`, **serves the stale index** to the
   response, and triggers a **single-flight, non-blocking background
   rebuild** via `ctx.waitUntil`. Derived caches (`homepage`, `stats`,
   `contributors`) are also cleared at this point so they recompute from
   the fresh index on the next read.

2. **Per-isolate dedup** of the background rebuild via a module-level
   promise (`inIsolateRebuildPromise`) — at most one rebuild in flight per
   Cloudflare isolate even on thundering-herd invalidation.

3. **Cross-isolate dedup** via a KV `REBUILD_LOCK` (60 s TTL safety) — at
   most one rebuild across all isolates.

4. **Hard-TTL safety fallback ONLY** — `INDEX_HARD_TTL` in `cache.js`
   defaults to **7 days**. This is the worst-case safety net for a
   scenario where the Worker process is restarted and the invalidation
   timestamp is somehow lost. It is **never** the primary refresh
   mechanism.

5. If the KV cache is genuinely empty (cold start, fresh deploy, or
   explicit purge), the very first request performs a **synchronous**
   rebuild — but again, only once per isolate lifetime, and restricted by
   the KV lock across isolates.

### Edge cache TTLs

| Endpoint | TTL |
|---|---|
| `/api/pyqs` (list) | 120 s |
| `/api/pyqs/:id` (detail) | 120 s |
| `/api/pyqs/search` | 60 s |
| `/api/homepage` | 120 s |
| `/api/stats` | 600 s |
| `/api/contributors` | 600 s |
| `/api/courses` | 3600 s |

### KV TTLs

- `pyq:search:index` — **7 days** (hard safety fallback; index is normally
  refreshed by admin invalidation, not by TTL)
- `pyq:pyqs:item:<id>` — **1 h** (per-item cache; deletions propagate after
  TTL or admin invalidation)
- `pyq:contributors:list` — **1 h**
- `pyq:courses:list` — **24 h**
- `pyq:homepage:summary`, `pyq:stats` — **5 / 10 min**

### Robust pagination cursor

Firestore REST pagination uses a composite cursor `[primaryValue, __name__]`.
The `__name__` tiebreaker (the full document path string) guarantees
stable pagination even when the primary `orderBy` field is non-unique
(e.g. `views` where many docs share a value, or duplicate creation
timestamps). Cursor values preserve their original Firestore type
(`timestampValue` stays `timestampValue`, not `stringValue`) so timestamps
order correctly across pages.

### "No duplicate reads per request" guarantee

In a single request — even a cold-cache homepage request —
**only one** collection sweep happens (the search-index build). The
homepage endpoint derives `recent`, `trending`, `courseCounts`, and
`stats` from that index. It never reads the `contributors` collection.
The contributors endpoint only reads its own collection when its KV
cache misses. There is no cross-collection Firestore read inside any
single request.

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

- 100 users, cold cache: **~N + C + U** reads (N = PYQ count, C = contributors,
  U = distinct papers opened), vs **~200N** before.
- 100 users, warm cache: **0 reads** for browse/search/homepage; **1 read per
  distinct paper** opened; **0 reads** for `contributors` after the first
  cache miss.
- 311 PYQs → ~412 reads cold / ~0 warm (old: ~62K).
- 10,000 PYQs → ~10,101 cold / ~0 warm (old: ~2M).

The system no longer requires a full 10,000-document Firestore read for
every user; the index rebuild is **driven by admin invalidation only**
(no short-cycle rebuild), and a single rebuild is shared by all users
via the stale-while-revalidate pattern.

## 11. Testing

`cd worker && node test/worker.test.js` — **90 assertions** against a
mocked Firestore, exercising the full refresh-strategy contract:

**Endpoints & behavior:** health, list (incl. limit/page capping,
defaults, capping), filters (course, semester, session, combined),
search (incl. short-query 400, HTML stripping, year search), sorting
(az/za/popular, invalid sort fallback), single-item (200/404/400),
contributors, courses, homepage, stats, CORS, invalid routes and
methods, rate-limit 429.

**Cache accounting (the critical new coverage):**
- **Cold cache** — first request triggers exactly one index sweep (311
  PYQs = 2 pages; 10,000 PYQs = 34 pages); zero contributor reads during
  a homepage request
- **Warm cache** — zero additional Firestore reads across browse, search,
  homepage, stats, contributors for the lifetime of the cache
- **Cache expiry (safety fallback)** — expiring the KV entry triggers a
  rebuild on next read, subsequent reads are 0
- **Admin invalidation** (stale-while-revalidate) — the next request
  after `/api/invalidate` is served immediately with **zero synchronous
  Firestore reads** for the serving path; the rebuild happens in the
  background and writes the fresh index; subsequent requests are 0
- **No duplicate reads per request** — homepage cold path never reads
  the contributors collection; the Worker reads each collection at most
  once per request

**Pagination correctness:**
- **Tiebreaker** — verified with 100 docs that share the same
  `views` value: paginating through all 100 with `sort=popular` and
  `limit=25` covers every id exactly once (validates the
  `[primaryValue, __name__]` composite cursor)
- **Timestamp typing** — `toFieldValue` detects ISO-8601 strings and
  emits `timestampValue` so cursors round-trip correctly for timestamp
  orderBy fields
- **Scale** — 311, 1,000, 5,000 and 10,000 simulated PYQs each verified
  to build the index in `ceil(N/300)` pages with all ids retrievable
  via search

**Other:**
- Rate-limiting 429 under burst
- Cache invalidation auth (200 with key, 401 without)
- Invalid route + POST-on-GET 405

**Frontend smoke:** `node test/frontend-smoke-test.cjs` jsdom test that
`index.html` + `script.js` render the API-driven PYQ list (9 assertions).
`node test/paper-smoke-test.cjs` for `paper.html` + `paper.js` (5
assertions).
