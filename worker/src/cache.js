/**
 * Multi-layer cache for the Cloudflare Worker:
 * 1. Cloudflare Cache API (edge cache) — whole API responses
 * 2. Cloudflare KV — structured data (search index, contributors, courses)
 */

const DEFAULT_KV_TTL = 300;
const LONG_KV_TTL = 3600;

const CACHE_NAMESPACE = 'pyq';

export const KV_KEYS = {
  SEARCH_INDEX: `${CACHE_NAMESPACE}:search:index`,
  CONTRIBUTORS: `${CACHE_NAMESPACE}:contributors:list`,
  COURSES: `${CACHE_NAMESPACE}:courses:list`,
  HOMEPAGE: `${CACHE_NAMESPACE}:homepage:summary`,
  PYQ_ITEM: (id) => `${CACHE_NAMESPACE}:pyqs:item:${id}`,
  STATS: `${CACHE_NAMESPACE}:stats`,
  INVALIDATION: `${CACHE_NAMESPACE}:invalidation:timestamp`,
};

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

export async function getFromKV(key) {
  if (typeof PYQ_CACHE === 'undefined') return null;
  try {
    const value = await PYQ_CACHE.get(key, 'text');
    if (!value) return null;
    return JSON.parse(value);
  } catch (err) {
    console.warn(`KV read failed for ${key}:`, err.message);
    return null;
  }
}

export async function setKV(key, data, ttlSeconds = DEFAULT_KV_TTL) {
  if (typeof PYQ_CACHE === 'undefined') return;
  try {
    const value = JSON.stringify(data);
    await PYQ_CACHE.put(key, value, { expirationTtl: ttlSeconds });
  } catch (err) {
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

export async function invalidateAll() {
  const timestamp = Date.now().toString();

  if (typeof PYQ_CACHE !== 'undefined') {
    await PYQ_CACHE.put(KV_KEYS.INVALIDATION, timestamp);
  }

  const keysToClear = [
    KV_KEYS.SEARCH_INDEX,
    KV_KEYS.CONTRIBUTORS,
    KV_KEYS.COURSES,
    KV_KEYS.HOMEPAGE,
    KV_KEYS.STATS,
  ];

  for (const key of keysToClear) {
    await deleteKV(key);
  }

  console.log(`Cache invalidated at ${timestamp}`);
}

export { DEFAULT_KV_TTL, LONG_KV_TTL };
