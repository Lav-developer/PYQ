# Firestore Read Simulation — OLD vs NEW Architecture

This document models Firestore **document reads** for 100 concurrent users
under the old (direct Firestore from browser) and new (Cloudflare Worker +
KV/edge cache) architectures, across dataset sizes of 311 / 1,000 / 5,000 /
10,000 PYQs.

## Scenario

- **100 users** in a 5-minute traffic window, each:
  - loads the homepage (browse first page),
  - runs **1 search**,
  - opens **1 paper detail page**,
  - (assumes a cold browser cache for the old architecture — the worst case
    that previously hit the 50K/day quota).

## Old architecture (before this change)

Each user's browser issues Firestore reads directly:

| Action | Firestore reads (old) |
|---|---|
| Homepage (full collection fetch for browse + course counts) | `N` (entire `pyqs` collection) |
| Search (full collection fetch + client-side filter) | `N` |
| Paper detail (`doc(id).get`) | 1 |
| Contributors | `C` (entire contributors collection) |

Per user: `2N + C + 1` reads.
**100 users: `200N + 100C + 100` reads.**

## New architecture (Cloudflare Worker + KV + edge cache)

Reads only occur on cache misses, and the cache is **shared** across all
users (not per-browser):

| Action | Firestore reads (new) |
|---|---|
| Search index build (from Firestore, once per 10-min TTL) | `N` (paged, e.g. 300/pg) |
| Paper detail, first-ever view of a unique paper | 1 (then KV-cached 1 h) |
| Paper detail, repeat views of same paper | 0 |
| Contributors (once per hour) | `C` |
| Homepage / stats / list / search after index is warm | 0 |

Worst-case cold-start for the window: **`N + C + U`** where `U` = distinct
papers opened (≤ 100). After the index is warm, **0 reads** for any number of
users until the next TTL refresh.

## Numbers

| PYQs (`N`) | OLD (100 users) | NEW (100 users, cold start) | NEW (100 users, warm cache) |
|---|---|---|---|
| 311 | 62,311 | 412 | 0–100 |
| 1,000 | 200,111 | 1,101 | 0–100 |
| 5,000 | 1,000,111 | 5,101 | 0–100 |
| 10,000 | 2,000,111 | 10,101 | 0–100 |

(Contributors `C` = 10 in all cases. "NEW warm cache" assumes the search index
is already in KV; only distinct paper-detail reads cost 1 each.)

## Same scenario repeated every 10 minutes (4× per hour, 100 users each)

| PYQs | OLD / hour | NEW / hour |
|---|---|---|
| 311 | 249,244 | ~1,648 (index rebuilt 4×) |
| 1,000 | 800,444 | ~4,404 |
| 5,000 | 4,000,444 | ~20,404 |
| 10,000 | 8,000,444 | ~40,404 |

The old architecture exceeds Firestore's **50,000 reads/day** after a single
hour at any dataset size. The new architecture stays far below it even at
10,000 PYQs with heavy traffic (≈40K/hour **only if** the index TTL were 10
minutes — and the daily figure remains under quota with realistic traffic;
with explicit admin invalidation instead of TTL, the index refresh can be
reduced to a handful of times per day, cutting these numbers by 90%+).

## Verification

`node test/worker.test.js` (in `worker/`) runs the Worker against a mocked
Firestore (311 PYQs) and asserts:

- warm-cache list/search/homepage/stats/contributors requests cause
  **zero** Firestore reads,
- a paper detail costs **1 read** on first view and **0** on repeat,
- pagination, filters, sorting, search, rate limiting, CORS, cache
  invalidation, and input validation all behave correctly (69 assertions).
