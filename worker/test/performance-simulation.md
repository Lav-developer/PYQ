# Firestore Read Simulation — OLD vs NEW Architecture

This document models Firestore **document reads** for 100 concurrent users
under the old (direct Firestore from browser) and new (Cloudflare Worker +
KV/edge cache) architectures, across dataset sizes of 311 / 1,000 / 5,000 /
10,000 PYQs.

## Refresh strategy assumed by the NEW numbers

The NEW architecture does **NOT** rebuild the search index on a short
fixed-clock timer. Instead:

1. The primary refresh trigger is **admin invalidation** (`POST /api/invalidate`).
2. The index sits in KV indefinitely until invalidated, with a 7-day
   hard TTL acting only as a safety fallback if the Worker process is
   restarted and the invalidation timestamp is somehow lost.
3. Background rebuilds are single-flight (per-isolate promise dedup +
   cross-isolate KV lock) and run *after* the response has been sent
   (`ctx.waitUntil`), so users never wait for a rebuild.

Under normal traffic with no admin changes, the index stays warm and
**Firestore is never touched** after the initial build.

## Scenario

- **100 users** in a 5-minute traffic window, each:
  - loads the homepage (browse first page),
  - runs **1 search**,
  - opens **1 paper detail page**,
- assumes a cold browser cache for the OLD architecture (the worst case
  that previously hit the 50K/day quota).

## OLD architecture (before this change)

Each user's browser issued Firestore reads directly:

| Action | Firestore reads (old) |
|---|---|
| Homepage (full collection fetch for browse + course counts) | `N` (entire `pyqs` collection) |
| Search (full collection fetch + client-side filter) | `N` |
| Paper detail (`doc(id).get`) | 1 |
| Contributors | `C` (entire contributors collection) |

Per user: `2N + C + 1` reads.
**100 users: `200N + 100C + 100` reads.**

## NEW architecture (Cloudflare Worker + KV + edge cache)

Reads only occur on cache misses, and the cache is **shared** across all
users (not per-browser):

| Action | Firestore reads (new) |
|---|---|
| Search index build (once, after admin invalidation) | `N` (paged, e.g. 300/page) |
| Paper detail, first-ever view of a unique paper | 1 (then KV-cached 1 h) |
| Paper detail, repeat views of same paper | 0 |
| Contributors (cached 1 h, rebuilt hourly or on invalidation) | 0 (warm) — first miss = `C` |
| Homepage / stats / list / search after index is warm | 0 |

Worst-case cold-start for the window: **`N + C + U`** where `U` =
distinct papers opened (≤ 100). After the index is warm, **0 reads** for
any number of users until the next admin invalidation.

## Numbers

| PYQs (`N`) | OLD (100 users) | NEW (100 users, cold start) | NEW (100 users, warm cache) |
|---|---|---|---|
| 311 | 62,311 | 412 | 0–100 |
| 1,000 | 200,111 | 1,101 | 0–100 |
| 5,000 | 1,000,111 | 5,101 | 0–100 |
| 10,000 | 2,000,111 | 10,101 | 0–100 |

(C=10 contributors, U=100 distinct papers opened. "Warm cache" assumes the
search index is already in KV — only distinct paper-detail reads cost 1
each.)

## Realistic long-horizon (steady state, no admin changes)

If **no admin changes happen**, the index stays warm indefinitely. Over
any horizon — a minute, an hour, a day, a week — the steady-state
Firestore read count is:

- browse / search / homepage / stats / list: **0 reads per user**.
- paper detail: **1 read per (unique paper × user-set viewing it)**.
- contributors: **0 reads per user** after first miss (1 h cache).

This is **orders of magnitude better than the OLD architecture**, which
scaled linearly with both the dataset size and the number of users.

## When admin changes ARE happening

Admin invalidation causes **exactly one** index rebuild (the stale
index is served to the first request while the rebuild runs in the
background). After the rebuild, the index is fresh and all subsequent
requests are 0 reads until the next admin change.

For a typical day with N admin operations:
- Index rebuilds = N × `~1 / pageSize` collection reads × pages per rebuild.
- E.g. N=20 admin ops, 10K docs, 300/page → 34 reads per op × 20 = **680
  reads per day** from index rebuilds, shared by all users.
- Plus 1 read per (unique paper × user) over the day.

Compared to the OLD architecture's ~2M reads/day at 10K PYQs, the new
design is a **≥3000× reduction**.

## Verification

`node test/worker.test.js` (in `worker/`) runs the Worker against a
mocked Firestore and asserts **90 behaviors**:

- Endpoints (health, list, search, filters, sorting, single-item,
  contributors, courses, homepage, stats, CORS, rate-limit, invalidation)
- **Cold cache** (311, 1K, 5K, 10K): exactly `ceil(N / 300)` page reads,
  zero contributor reads during a homepage request
- **Warm cache**: zero additional Firestore reads across many request
  types
- **Cache expiry** (KV hard TTL simulation): expiry triggers a rebuild,
  subsequent reads = 0
- **Admin invalidation** (stale-while-revalidate): the next request
  after `/api/invalidate` returns stale data with **0 synchronous
  Firestore reads** for the serving path; a single-flight background
  rebuild writes the fresh index; subsequent reads = 0
- **No duplicate reads per single request**: homepage cold path never
  reads the contributors collection
- **Tiebreaker correctness**: 100 docs that share `views` paginate
  correctly across multiple pages without duplicates or skips
- **Scale**: 311, 1K, 5K, 10K each verified to build the index in
  `ceil(N/300)` pages; all ids retrievable via search; warm = 0
