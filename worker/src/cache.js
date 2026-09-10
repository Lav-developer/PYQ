/**
 * Multi-layer cache for the Cloudflare Worker:
 *
 * 1. Cloudflare Cache API (edge cache) — whole API responses
 * 2. Cloudflare KV — structured data (search index, contributors, courses)
 *
 * Refresh strategy:
 *  - Cached entries store `_cachedAt` to track when they were built.
 *  - Admin calls `POST /api/invalidate`, which stamps `INVALIDATION` in KV
 *    with the current timestamp.
 *  - The search index compares `_cachedAt` vs the invalidation timestamp on
 *    each request. If `lastInvalidatedAt > _cachedAt`, the cache is stale:
 *    we serve the stale data immediately and trigger a background rebuild
 *    (single-flight, non-blocking via `ctx.waitUntil`).
 *  - A very long hard TTL (INDEX_HARD_TTL, default 7 days) acts as a SAFETY
 *    FALLBACK only, in case the Worker process is restarted and the
 *    invalidation timestamp is somehow lost. Under normal traffic, no
 *    full-collection rebuild happens on a short timer — only on admin
 *    invalidation. This directly addresses the previous "aggressive 10-min
 *    full-database refresh" pattern.
 */

const CACHE_NAMESPACE = 'pyq';

export const KV_KEYS = {
  SEARCH_INDEX: `${CACHE_NAMESPACE}:search:index`,
  CONTRIBUTORS: `${CACHE_NAMESPACE}:contributors:list`,
  COURSES: `${CACHE_NAMESPACE}:courses:list`,
  HOMEPAGE: `${CACHE_NAMESPACE}:homepage:summary`,
  PYQ_ITEM: (id) => `${CACHE_NAMESPACE}:pyqs:item:${id}`,
  STATS: `${CACHE_NAMESPACE}:stats`,
  INVALIDATION: `${CACHE_NAMESPACE}:invalidation:timestamp`,
  // KV-based rebuild lock — prevents thundering-herd rebuilds across
  // Worker isolates after an invalidation.
  REBUILD_LOCK: `${CACHE_NAMESPACE}:rebuild:lock`,
};

export const DEFAULT_KV_TTL = 300;      // 5 minutes for derived KV documents
export const LONG_KV_TTL = 3600;        // 1 hour for moderately static data
export const VERY_LONG_KV_TTL = 86400;  // 24 hours — homepage, contributors
// SAFETY FALLBACK ONLY. The search index normally lives for as long as the
// admin wants (invalidated manually). This 7-day hard TTL is the last-resort
// refresh trigger — it must NOT be the primary mechanism.
export const INDEX_HARD_TTL = 7 * 24 * 60 * 60;

export function getCacheKey(request) {
  return new Request(request.url, request);
}

export function shouldBypassCache(request) {
  const url = new URL(request.url);
  return url.searchParams.has('refresh') || url.searchParams.has('purge');
}

export function setCacheHeaders(response, ttlSeconds = 60) {
  const headers = new Headers(response.headers);
  headers.set(
    'Cache-Control',
    `public, s-maxage=${ttlSeconds}, max-age=${ttlSeconds}, stale-while-revalidate=${ttlSeconds * 2}`
  );
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export async function getFromEdgeCache(request) {
  try {
    const cache = caches.default;
    const cacheKey = getCacheKey(request);
    const cached = await cache.match(cacheKey);
    return cached || null;
  } catch (err) {
    console.warn('Edge cache read failed:', err.message);
    return null;
  }
}

export async function setEdgeCache(request, response, ttlSeconds = 60) {
  try {
    const cache = caches.default;
    const cacheKey = getCacheKey(request);
    const cachedResponse = setCacheHeaders(response.clone(), ttlSeconds);
    await cache.put(cacheKey, cachedResponse);
  } catch (err) {
    console.warn('Edge cache write failed:', err.message);
  }
}

// ── KV storage availability ────────────────────────────────────────
// KV reads/writes can fail independently of application logic (most commonly
// because the free-tier daily PUT quota is exhausted and Cloudflare answers
// with HTTP 429). These flags are observations only — they never change a
// response by themselves. `search.js` uses them to decide whether it may reuse
// its short-lived isolate copy of the search index instead of re-sweeping
// Firestore on every request while KV cannot store the rebuilt index.
const KV_FAILURE_MEMORY_MS = 5 * 60 * 1000;
let kvWriteUnavailable = false;
let kvReadFailedAt = 0;

/**
 * True when the last KV write was rejected, or a KV read failed within the
 * recent past. Used as a fallback hint, never as an authorization signal.
 */
export function isKVStorageUnavailable() {
  return kvWriteUnavailable
    || (kvReadFailedAt > 0 && (Date.now() - kvReadFailedAt) < KV_FAILURE_MEMORY_MS);
}

/** Forget observed KV failures (used by tests; harmless anywhere else). */
export function resetKVAvailabilityState() {
  kvWriteUnavailable = false;
  kvReadFailedAt = 0;
}

export async function getFromKV(key) {
  if (typeof PYQ_CACHE === 'undefined') return null;
  try {
    const value = await PYQ_CACHE.get(key, 'text');
    if (!value) return null;
    return JSON.parse(value);
  } catch (err) {
    kvReadFailedAt = Date.now();
    console.warn(`KV read failed for ${key}:`, err.message);
    return null;
  }
}

export async function setKV(key, data, ttlSeconds = DEFAULT_KV_TTL) {
  if (typeof PYQ_CACHE === 'undefined') return;
  try {
    const value = JSON.stringify(data);
    await PYQ_CACHE.put(key, value, { expirationTtl: ttlSeconds });
    kvWriteUnavailable = false;
  } catch (err) {
    kvWriteUnavailable = true;
    console.warn(`KV write failed for ${key}:`, err.message);
  }
}

export async function deleteKV(key) {
  if (typeof PYQ_CACHE === 'undefined') return;
  try {
    await PYQ_CACHE.delete(key);
  } catch (err) {
    console.warn(`KV delete failed for ${key}:`, err.message);
  }
}

/**
 * Return the most recent global invalidation timestamp as a number
 * (ms since epoch). Returns 0 if no invalidation has happened.
 */
export async function getInvalidationTimestamp() {
  if (typeof PYQ_CACHE === 'undefined') return 0;
  try {
    const ts = await PYQ_CACHE.get(KV_KEYS.INVALIDATION, 'text');
    const n = ts ? parseInt(ts, 10) : 0;
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

/**
 * Acquire (or wait for) a cross-isolate rebuild lock. Returns true if this
 * caller should run the rebuild, false if another isolate is already running
 * it. The lock auto-expires after a safe duration to prevent wedged locks.
 */
export async function acquireRebuildLock(ttlSeconds = 60) {
  if (typeof PYQ_CACHE === 'undefined') return true;
  try {
    const existing = await PYQ_CACHE.get(KV_KEYS.REBUILD_LOCK, 'text');
    if (existing && Number(existing) > Date.now() - ttlSeconds * 1000) {
      return false;
    }
    await PYQ_CACHE.put(
      KV_KEYS.REBUILD_LOCK,
      String(Date.now()),
      { expirationTtl: ttlSeconds }
    );
    return true;
  } catch (err) {
    console.warn('Rebuild lock error:', err.message);
    return true; // Fail open: if we can't lock, allow the rebuild
  }
}

export async function releaseRebuildLock() {
  await deleteKV(KV_KEYS.REBUILD_LOCK);
}

/**
 * Inform the cache that a bulk refresh should happen on next read.
 *
 * IMPORTANT: this does NOT delete the SEARCH_INDEX. The Worker serves the
 * stale index to the very next request (stale-while-revalidate) and triggers
 * a single-flight background rebuild via `runBackgroundRebuild`. This avoids:
 *  - Cold-cache latency spikes on the first request after invalidation
 *    (which previously had to do a full Firestore sweep synchronously)
 *  - Multiple cold rebuilds racing each other across concurrent requests
 *
 * Derived/aggregated caches (homepage summary, contributors, stats, courses)
 * ARE cleared because they will be recomputed from the rebuilt index on next
 * read.
 */
export async function invalidateAll() {
  const timestamp = Date.now().toString();

  if (typeof PYQ_CACHE !== 'undefined') {
    await PYQ_CACHE.put(KV_KEYS.INVALIDATION, timestamp);
  }

  const derivedKeysToClear = [
    KV_KEYS.CONTRIBUTORS,
    KV_KEYS.COURSES,
    KV_KEYS.HOMEPAGE,
    KV_KEYS.STATS,
  ];

  for (const key of derivedKeysToClear) {
    await deleteKV(key);
  }

  console.log(`Cache invalidated at ${timestamp} (stale-while-revalidate)`);
}

export { KV_KEYS as KEYS };
