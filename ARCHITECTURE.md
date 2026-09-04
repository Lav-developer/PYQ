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
| `paper.js` | Paper detail + related papers come from the Worker API. Legacy view/comment behavior remains; a server-rendered `/pyq/` route defers direct comment reads and skips its automatic view write until an authenticated or intentional user interaction, keeping crawler hydration KV-first. |
| `admin.js` | Existing Firebase-admin writes preserved; new PYQs store a stable slug base and cache invalidation continues via the admin's Firebase ID token. |
| `firestore.rules` | `pyqs` and `contributors` public reads removed — the Worker (service account) is the only public read path. Admin + view-increment rules preserved. |
| `sw.js` | v6 — never serves stale cache for `/api/*` requests. |
| `netlify.toml` | Forced external Worker rewrites for dynamic `/pyq/*` pages and `/sitemap.xml`; no SPA catch-all. |
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
# /api/invalidate and /api/notify intentionally use a Firebase ID token with
# admin:true (verified server-side); do not configure browser-visible static
# keys. /api/notify reuses the same service account for FCM v1; notification
# credentials are never exposed to the frontend or committed.

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
| POST | `/invalidate` | Stamp cache invalidation — `Authorization: Bearer <Firebase ID token>` with verified `admin: true` |

**Query validation:** `page` 1–100, `limit` 1–100 (server-enforced), `sort` ∈
`newest|popular|az|za|oldest`, `semester` ∈ `1st..8th`, search `q` ≥ 2 chars,
max 200 chars, HTML stripped. Unknown params ignored.

**API responses** are JSON. List/search return `{ items, total, page, limit,
totalPages }`; `slug` is additive on compact items and `seoSlug` is additive on
a warm public single-item response. Errors return `{ error }` with appropriate
status (400/401/404/405/429/500). `GET /pyq/:slug` returns HTML and
`GET /sitemap.xml` returns XML.

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
- `pyq:pyqs:item:<id>` — **1 h** (per-item cache; SEO fields come from the
  compact index, and a missing/deleted item is never rendered as a success).
  A global admin invalidation makes pre-invalidation item entries logically
  stale, so the first affected detail/SEO request revalidates that one document
  before it can be rendered.
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

## 7. Public SEO routes, sitemap, and slug safety

Netlify keeps the canonical public hostname and performs forced **200 external
rewrites** to the Worker:

```toml
[[redirects]]
from = "/pyq/*"
to = "https://dsmnru-pyq-api.kush210431-cloudflare.workers.dev/pyq/:splat"
status = 200
force = true

[[redirects]]
from = "/sitemap.xml"
to = "https://dsmnru-pyq-api.kush210431-cloudflare.workers.dev/sitemap.xml"
status = 200
force = true
```

Those rules live in `netlify.toml`; update both target URLs if the deployed
Worker hostname changes. `force = true` is required so the dynamic sitemap
wins over the checked-in legacy `sitemap.xml` file.

The Worker serves `GET /pyq/:slug` before its API rate limiter. It resolves an
exact safe slug through the existing compact `pyq:search:index` KV value, then
reads `pyq:pyqs:item:<id>`. A warm current-schema index plus a current warm
item cache performs no Firestore read. A genuine item-cache miss — including an
entry intentionally made stale by an admin invalidation — performs one document
read; this prevents a pre-change cached document from leaking after it becomes
private. A pre-SEO compact index has no explicit public bit, so its SEO surface
fails closed while the existing background-rebuild path upgrades it. A cold
index follows the pre-existing one-time index-build path. The server fills the
single `paper.html` shell in memory, so no per-paper HTML files are generated.

The response includes an index/follow robots directive, unique title and
description, canonical/Open Graph/Twitter tags, public H1, visible breadcrumbs
and course/semester/session/subject/branch details, related public links, and
`LearningResource` plus breadcrumb JSON-LD. It deliberately never injects PDF
links, comments, user data, credentials, or any document fields outside this
public compact metadata. Explicitly private/draft records are omitted from both
this route and the dynamic sitemap. `robots.txt` allows the public route and
points at the sitemap.

### Stable URLs, title changes, and duplicates

The admin writes a simple title-derived `slug` **base** when it creates a PYQ.
For an older record that has no base yet, its first normal edit saves the
current base before applying the new title. Future title changes keep that base,
which avoids changing the normal published URL without a full historical-slug
database or crawler-triggered writes. The legacy `paper.html?id=<id>` URL stays
functional in all cases; once a warm public index knows the item, client
hydration sets its canonical tag to the pretty URL rather than redirecting an
ambiguous old link.

The Worker assigns the final canonical slug across the whole public index. If
bases collide, the oldest creation timestamp (then document ID) keeps the
readable base and every later document normally receives
`--<base64url-document-id>`. If that exact suffix is a different title's readable
base, the Worker inserts a deterministic numeric discriminator before the same
reversible ID suffix. The result remains unambiguous for duplicate titles. For
exactly matching displayed titles, later records also receive a stable
`Archive copy N` qualifier in their document/social title, description, and
JSON-LD so metadata remains unique while the visible H1 stays the real paper
title. The index owns this final collision logic so Firestore remains write-free
during crawler traffic.

## 8. Failure handling

- Firestore down + KV warm → stale cached data served (by design; academic
  archive tolerates slight staleness).
- Firestore down + KV cold → API returns `500 { error }`; frontend shows a
  graceful empty/error state (existing `showEmptyState` paths) and never fully
  breaks.
- No aggressive retries: index rebuilds happen only on TTL expiry or explicit
  invalidation.

## 9. Migration steps (production)

1. Deploy the Worker (§3) first. Its pretty route fails closed until the
   static shell markers are available.
2. Deploy the matching Netlify `paper.html` and `netlify.toml` rewrite rules in
   the same release window; this activates canonical `/pyq/*` and
   `/sitemap.xml` traffic without generating per-paper files.
3. Smoke-test: homepage, browse, Load More, search, filters, sorting,
   contributors, legacy paper detail, a pretty URL, sitemap, and PDF open.
4. Deploy `firestore.rules` (tightened public reads).
5. Confirm the Firebase administrator used by `admin.html` has the `admin: true`
   custom claim; the Worker verifies it for every invalidation request.
6. Watch `wrangler tail` for cache-hit vs cache-miss logs for a day.

## 10. Rollback

- **Frontend:** revert `script.js`, `paper.js`, `admin.js`, `sw.js`, and the
  `/pyq/*` plus `/sitemap.xml` rewrites in `netlify.toml` (or unset
  `DSMNRU_API_URL`) and redeploy Netlify. The old browser-direct Firestore code
  returns.
- **Rules:** restore the previous `firestore.rules` (`allow read: if true` on
  `pyqs`/`contributors`) and `firebase deploy --only firestore:rules`.
- **Worker:** `npx wrangler delete` (or keep it — harmless with no frontend
  calling it).
- No data migration exists to roll back: Firestore and PDF URLs are untouched.

## 11. Firestore read budget (normal traffic)

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

## 12. Testing

`cd worker && node test/worker.test.js` — **153 assertions** against a
mocked Firestore, exercising the full refresh-strategy and public-SEO contract
(plus `node test/admin-ia-test.cjs` for the admin panel and
`node test/static-pages-test.cjs` for the public pages):

**Endpoints & behavior:** health, list (incl. limit/page capping,
defaults, capping), filters (course, semester, session, combined),
search (incl. short-query 400, HTML stripping, year search), sorting
(az/za/popular, invalid sort fallback), single-item (200/404/400),
contributors, courses, homepage, stats, CORS, invalid routes and
methods, rate-limit 429, admin push notifications
(`POST /api/notify`: auth 401s, payload validation, exact FCM topic
payload, duplicate-send cooldown, safe downstream errors).

**Cache accounting (the critical new coverage):**
- **Cold cache** — first request triggers exactly one index sweep (311
  PYQs = 2 pages; 10,000 PYQs = 34 pages); zero contributor reads during
  a homepage request
- **Warm cache** — zero additional Firestore reads across browse, search,
  homepage, stats, contributors for the lifetime of the cache
- **Cache expiry (safety fallback)** — expiring the KV entry triggers a
  rebuild on next read, subsequent reads are 0
- **Admin invalidation** (stale-while-revalidate) — list/search requests
  after `/api/invalidate` are served immediately with **zero synchronous
  Firestore reads** for the serving path while the rebuild runs in the
  background. A detail/SEO request whose per-item cache predates that
  invalidation deliberately revalidates just that one document first.
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

**Public SEO routes:**
- canonical and duplicate-suffix slug assignment, persistent bases after title edits,
  contradictory public/private access-state filtering, no-PDF/no-private-field SSR
  output, visible metadata, JSON-LD, related links, valid/malformed/unknown URLs,
  a KV-only warm page, and post-invalidation item-cache privacy revalidation
- dynamic sitemap inclusion/exclusion and no per-item Firestore reads
- new-publication discovery through the existing invalidation → background rebuild flow

**Other:**
- Rate-limiting 429 under burst (crawl routes deliberately bypass it)
- Cache invalidation auth and CORS preflight (200 with a verified Firebase
  `admin: true` ID token, 401 otherwise)
- Invalid route + POST-on-GET 405

**Frontend smoke:** `node test/frontend-smoke-test.cjs` jsdom test that
`index.html` + `script.js` render the API-driven PYQ list and canonical pretty links.
`node test/paper-smoke-test.cjs` covers legacy `paper.html?id=` hydration and
Worker-bootstrapped `/pyq/<slug>` hydration without hiding SSR content early or
performing automatic direct-Firestore view/comment work for a crawler.
