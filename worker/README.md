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
| POST | `/api/invalidate` | Invalidate all caches (needs `X-Api-Key`) |

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
  "items": [{ "id": "...", "title": "...", "course": "...", "semester": "...", "session": "...", "branch": "...", "subject": "...", "year": 2024, "views": 120 }],
  "total": 311,
  "page": 1,
  "limit": 20,
  "totalPages": 16
}
```

`/api/pyqs/:id` returns the full Firestore document (including `file`/`file2`).

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

3. Set secrets (never commit these):

```bash
npx wrangler secret put FIREBASE_SERVICE_ACCOUNT_JSON   # paste the JSON file contents
npx wrangler secret put ADMIN_API_KEY                   # any long random string
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

- **Edge cache (Cloudflare Cache API):** caches whole GET responses.
  TTLs: list/search 60–120s, item 120s, contributors 600s, courses 1h.
- **KV:** stores the search index (all compact PYQ metadata; refreshed
  via admin invalidation — **no short fixed-clock rebuild**, a 7-day
  hard TTL is the safety fallback only), per-item full docs (1 h),
  contributors (1 h), courses (24 h), homepage (5 min).
- **Invalidation (primary refresh trigger):** `POST /api/invalidate`
  with `X-Api-Key: <ADMIN_API_KEY>` stamps an invalidation timestamp
  and clears derived caches (homepage / stats / contributors / courses).
  The next request serves the stale search index to the response and
  triggers a **single-flight background rebuild** via `ctx.waitUntil`.
  After that one rebuild, the index is fresh and the system stays warm
  for any number of users until the next invalidation.
- **Fallback:** if Firestore is down, stale KV data is served when
  available; otherwise the API returns a 5xx JSON error and the
  frontend shows a graceful empty/error state (it never fully breaks).

## Rate limiting

KV-backed limiter: 30 requests/min per IP per endpoint, with a 60/min burst.
Returns `429` with `Retry-After`. Applied to all public endpoints.
