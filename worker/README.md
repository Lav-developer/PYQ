# DSMNRU PYQ — Cloudflare Worker API

Zero-cost API layer between the Netlify frontend and Firestore.

```
Netlify Frontend
      ↓
Cloudflare Worker (this)
      ↓
Cloudflare Cache API / KV
      ↓ (cache miss)
Firestore (source of truth)
```

**Goal:** public traffic terminates at Cloudflare cache/KV. Firestore is only
queried on cache misses or explicit invalidation, so Firestore document reads
stay extremely low even as the PYQ collection grows from 311 → 10,000+.

---

## Endpoints

| Method | Path | Description |
|---|---|---|
| GET | `/api/health` | Health check |
| GET | `/api/pyqs?page=1&limit=20&sort=newest&course=..&semester=..&session=..` | Paginated PYQ list with filters |
| GET | `/api/pyqs/search?q=..&course=..&semester=..&session=..&sort=..&page=1&limit=20` | Search PYQs |
| GET | `/api/pyqs/:id` | Single PYQ detail (full doc incl. file URLs) |
| GET | `/api/contributors` | Contributors list |
| GET | `/api/courses` | Course catalog |
| GET | `/api/homepage` | Homepage summary (recent, trending, course counts, stats) |
| GET | `/api/stats` | Aggregated stats |
| POST | `/api/invalidate` | Stamp cache invalidation (verified Firebase ID token with `admin: true`) |
| POST | `/api/notify` | Send a push notification to all Android devices via FCM topic `all_users` (same admin-token rule; body `{ title, body, path }`; 30 s per-admin cooldown) |
| GET | `/pyq/:slug` | Server-rendered public, indexable PYQ page (served through Netlify rewrite) |
| GET | `/sitemap.xml` | Dynamic public-PYQ sitemap (served through Netlify rewrite) |

### Query params

- `page` — 1-based, default 1, max 100
- `limit` — default 20, max 100 (enforced server-side)
- `sort` — `newest` (default), `popular`, `az`, `za`, `oldest`
- `q` — search text (min 2 chars), matches title / course / session / subject / year
- `course`, `semester` (1st–8th), `session`, `year` — filters

### Response shapes

`/api/pyqs` and `/api/pyqs/search` return paginated compact items:

```json
{
  "items": [{ "id": "...", "title": "...", "course": "...", "semester": "...", "session": "...", "branch": "...", "subject": "...", "year": 2024, "views": 120, "slug": "..." }],
  "total": 311,
  "page": 1,
  "limit": 20,
  "totalPages": 16
}
```

`/api/pyqs/:id` returns the full Firestore document (including `file`/`file2`) and,
when a warm public index knows it, an additive `seoSlug` field. Existing clients can
ignore this field safely.

### Public SEO pages

`/pyq/:slug` is intentionally separate from the authenticated paper viewer. Netlify
rewrites it to the Worker while retaining `https://dsmnru-pyq.netlify.app` as the
visible URL. The Worker resolves the slug from the compact KV search index, then
reads `pyq:pyqs:item:<id>`; Firestore is used only if that individual item is
absent or was intentionally made stale by an admin invalidation. That one-document
revalidation prevents a warm pre-change cache from rendering a paper after it has
become private. A pre-SEO compact index has no explicit public bit, so its SEO
surface fails closed while the normal background rebuild upgrades it. The initial
HTML contains only public title and
course/semester/session/subject/branch metadata, breadcrumbs, related public links,
canonical social tags, and JSON-LD. It
never includes PDF URLs, comments, user data, or credentials.

The sitemap is generated from those same public index entries. `robots.txt` permits
`/pyq/` and names the canonical sitemap.

---

## Local Development

```bash
cd worker
npm install
npx wrangler dev
```

### One-time setup

1. Create the KV namespace:

```bash
npx wrangler kv:namespace create PYQ_CACHE
```

Copy the returned `id` into `wrangler.toml` (`[[kv_namespaces]] → id`).

2. Create the Firebase service account:

   - Firebase Console → Project Settings → Service accounts → **Generate new private key**
   - Save the downloaded JSON (e.g. `dsmnru-data-firebase-adminsdk-xxxx.json`)
   - Grant the account the **Firebase Cloud Messaging API Admin** role if you
     will send push notifications (`POST /api/notify`), or another role that
     permits FCM HTTP v1 sends. Firestore access keeps working with the
     existing Cloud Datastore User role.

3. Set secrets (never commit these):

```bash
npx wrangler secret put FIREBASE_SERVICE_ACCOUNT_JSON   # paste the JSON file contents
```

4. Set vars in `wrangler.toml`:

```toml
[vars]
FIREBASE_PROJECT_ID = "dsmnru-data"
ALLOWED_ORIGINS = "https://dsmnru-pyq.netlify.app"
```

5. Deploy:

```bash
npx wrangler deploy
```

6. Copy the Worker URL (e.g. `https://dsmnru-pyq-api.<your-subdomain>.workers.dev`)
   and set `API_BASE_URL` in the frontend (`script.js` / `paper.js`).

---

## Cache & Invalidation

- **HTTP caching:** successful API responses are sent with
  `Cache-Control: public, s-maxage=60, max-age=60` (see `getCacheTTL` /
  `jsonResponse`). There is deliberately **no** second response-cache layer
  inside the Worker, so an admin invalidation takes effect as soon as the
  index rebuild completes. (`cache.js` still exports Cache API helpers, but
  they are not wired into the request path.)
- **KV:** stores the search index (all compact PYQ metadata; refreshed
  via admin invalidation — **no short fixed-clock rebuild**, a 7-day
  hard TTL is the safety fallback only), per-item full docs (1 h),
  contributors (1 h), homepage (5 min). A per-item value that
  predates an admin invalidation is revalidated once before it is reused.
  `/api/courses` serves a compile-time constant catalog and intentionally
  performs **no** KV write (a KV value is still read and honoured if one is
  seeded out-of-band).
- **Invalidation (primary refresh trigger):** `POST /api/invalidate`
  with `Authorization: Bearer <Firebase ID token>` stamps an invalidation
  timestamp only when the token has a verified `admin: true` custom claim,
  then clears derived caches (homepage / stats / contributors / courses).
  There is no static API-key fallback.
  The next request serves the stale search index to the response and
  triggers a **single-flight background rebuild** via `ctx.waitUntil`.
  After that one rebuild, the index is fresh and the system stays warm
  for any number of users until the next invalidation.
- **Fallback:** if Firestore is down, stale KV data is served when
  available; otherwise the API returns a 5xx JSON error and the
  frontend shows a graceful empty/error state (it never fully breaks).

## Rate limiting

Two tiers, both returning `429` with `Retry-After` (`no-store`):

1. **Public read endpoints** (`/api/pyqs`, `/api/pyqs/search`, `/api/pyqs/:id`,
   `/api/homepage`, `/api/stats`, `/api/contributors`, `/api/courses`, unknown
   paths): 60 requests/min per IP per endpoint, counted **in the isolate**
   (a plain `Map`). This performs **zero KV operations** — the previous
   KV-backed counter wrote one KV PUT for every request, which is what
   exhausted the free-tier daily PUT allowance (≈1,000/day).
2. **Sensitive / expensive admin operations** (`/api/notify`,
   `/api/invalidate`): the original KV-backed, cross-isolate counter with the
   original small ceilings (notify 6/min). It runs **after** the Firebase
   admin token has been verified, so unauthenticated floods cannot consume KV
   writes. A per-admin 30 s cooldown still guards accidental duplicate
   notifications.

Public `/pyq/*` and `/sitemap.xml` deliberately bypass the limiter entirely,
because Netlify external rewrites do not reliably preserve a crawler's
individual IP. `/api/health` is answered before the limiter.

### KV failure behavior

- Public reads never depend on KV, so a KV read/write outage or an exhausted
  daily PUT quota does not degrade them; a flooding IP is still capped at the
  isolate ceiling (fail closed at that ceiling, never blanket fail-open).
- If the distributed tier cannot read or write its KV counter, it falls back to
  the isolate-local counter with the *same* small ceiling (`degraded: true`) —
  `notify`/`invalidate` keep meaningful protection, and authorization plus the
  notify cooldown are unaffected.
- If KV cannot store a rebuilt search index (expired entry + rejected PUTs),
  the isolate reuses its last build for at most 60 s instead of sweeping the
  whole Firestore collection on every request (`INDEX_MEMORY_TTL_MS`).

## Slug stability and duplicates

The normal admin create flow writes a simple title-derived `slug` **base** alongside
the PYQ. On the first edit of an older record without this field, the admin UI saves
its current base before changing the title. Future title edits therefore retain the
published base without a crawler-side write or a historical-slug database.

The index, not Firestore, owns the final URL. If multiple public records share a
base, the oldest timestamp (then document ID) keeps the readable URL and every later
record normally gets `--<base64url-document-id>`. If that exact suffix is itself
a different title's readable base, a deterministic numeric discriminator is inserted
before the same reversible ID suffix. Exact duplicate display titles also receive an
`Archive copy N` qualifier in document/social metadata and JSON-LD while retaining
the real paper title as the visible H1. A legacy `/paper.html?id=<id>` link is never
removed: it continues to hydrate normally and gets a pretty canonical URL whenever
the warm public index supplies `seoSlug`.
