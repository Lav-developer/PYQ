/**
 * Lightweight search index for PYQ metadata.
 *
 * Refresh strategy (safe under traffic — no aggressive full-database refresh):
 *  - Primary refresh trigger: admin `POST /api/invalidate`. The Worker
 *    records the timestamp in KV; subsequent reads detect staleness and
 *    serve the old data while a background rebuild updates the index.
 *  - Safety fallback only: a very long hard TTL (7 days, configured in
 *    cache.js) plus staleness comparison against `_cachedAt` ensures the
 *    index eventually refreshes even if invalidation is missed.
 *  - During normal traffic the cache stays warm and NEVER triggers a full
 *    Firestore collection rebuild. This directly replaces the previous
 *    "10-minute full-rebuild on TTL expiry" architecture.
 */

import { getAllDocuments } from './firestore.js';
import { KV_KEYS, getFromKV, setKV, DEFAULT_KV_TTL } from './cache.js';
import { getInvalidationTimestamp, INDEX_HARD_TTL } from './cache.js';

function normalize(str) {
  if (!str) return '';
  return String(str).toLowerCase().trim().replace(/\s+/g, ' ');
}

function normalizeForCompare(str) {
  if (!str) return '';
  return String(str)
    .toLowerCase()
    .trim()
    .replace(/[\s\-_&(),.]+/g, '')
    .replace(/[^a-z0-9]/g, '');
}

function extractYearFromTitle(title) {
  const match = String(title || '').match(/\{(\d{4})\}/);
  return match ? parseInt(match[1], 10) : 0;
}

function extractSortTimestamp(pyq) {
  for (const field of ['createdAt', 'uploadedAt', 'addedAt']) {
    const val = pyq[field];
    if (!val) continue;
    if (typeof val === 'string') {
      const ts = new Date(val).getTime();
      if (Number.isFinite(ts) && ts > 0) return ts;
    }
    if (typeof val === 'number' && val > 0) return val;
  }
  return 0;
}

function buildIndexItem(pyq) {
  return {
    id: pyq.id,
    t: String(pyq.title || ''),
    c: String(pyq.course || pyq.category || ''),
    s: String(pyq.semester || pyq.sem || ''),
    se: String(pyq.session || ''),
    b: String(pyq.branch || ''),
    su: String(pyq.subject || ''),
    y: extractYearFromTitle(pyq.title),
    v: Number.isFinite(Number(pyq.views)) ? Math.floor(Number(pyq.views)) : 0,
    ts: extractSortTimestamp(pyq),
  };
}

/**
 * Build a fresh index by reading the entire PYQS collection from Firestore
 * (using cursor pagination with `__name__` tiebreaker). Stores in KV.
 */
export async function buildSearchIndex() {
  console.log('Building search index from Firestore...');
  // Order by title for deterministic pagination; the `__name__` tiebreaker
  // (added by getAllDocuments) prevents duplicates when titles collide.
  const docs = await getAllDocuments('pyqs', {
    orderBy: [{ field: 'title', direction: 'ASCENDING' }],
  });
  console.log(`Fetched ${docs.length} PYQs from Firestore`);

  const index = docs.map((doc) => buildIndexItem(doc));

  const cacheData = {
    items: index,
    count: index.length,
    _cachedAt: Date.now(),
  };
  // Use a very long hard TTL — the index should be invalidated explicitly
  // by the admin, not by a short clock-driven refresh.
  await setKV(KV_KEYS.SEARCH_INDEX, cacheData, INDEX_HARD_TTL);
  console.log(`Search index built: ${index.length} items, cached in KV`);

  return cacheData;
}

/**
 * Get the current search index. Decides whether to return cached fresh,
 * serve stale + signal a background rebuild, or force a synchronous rebuild
 * (only when nothing is cached at all — first deploy).
 *
 * Returns:
 *   {
 *     index: <cached|fresh object>,
 *     fresh: <boolean>,              // true if cache is up to date
 *     needsBackgroundRebuild: <boolean>,
 *     reason: 'cold'|'fresh'|'stale-invalidated'|'stale-aged'
 *   }
 */
export async function getSearchIndex({ forceRebuild = false } = {}) {
  const cached = await getFromKV(KV_KEYS.SEARCH_INDEX);
  const invalidationTs = await getInvalidationTimestamp();

  if (forceRebuild) {
    const fresh = await buildSearchIndex();
    return { index: fresh, fresh: true, needsBackgroundRebuild: false, reason: 'forced' };
  }

  // First-ever deploy / never built: build synchronously (nothing to serve stale)
  if (!cached || !cached.items || cached.items.length === 0) {
    console.log('Search index cold: building from Firestore (first deploy)');
    const fresh = await buildSearchIndex();
    return { index: fresh, fresh: true, needsBackgroundRebuild: false, reason: 'cold' };
  }

  const lastBuiltAt = cached._cachedAt || 0;

  // Stale due to admin invalidation since last build
  if (invalidationTs > lastBuiltAt) {
    console.log(`Search index stale: invalidated at ${invalidationTs}, built at ${lastBuiltAt}`);
    return {
      index: cached,
      fresh: false,
      needsBackgroundRebuild: true,
      reason: 'stale-invalidated',
    };
  }

  // Safety fallback: the hard TTL has elapsed. Real hard TTL is enforced
  // by KV storage, but on KV-restore from another isolate we re-check by
  // timestamp defensively.
  const ageMs = Date.now() - lastBuiltAt;
  if (ageMs > INDEX_HARD_TTL * 1000) {
    console.log(`Search index stale by age (${ageMs}ms > ${INDEX_HARD_TTL * 1000}ms)`);
    return {
      index: cached,
      fresh: false,
      needsBackgroundRebuild: true,
      reason: 'stale-aged',
    };
  }

  // Fresh: serve without triggering any rebuild
  return { index: cached, fresh: true, needsBackgroundRebuild: false, reason: 'fresh' };
}

/**
 * Run a background rebuild (intended to be passed to `ctx.waitUntil`).
 * Uses an in-isolate promise dedup plus a KV lock for cross-isolate dedup
 * to guarantee a single rebuild even when many concurrent requests arrive
 * after an invalidation.
 */
let inIsolateRebuildPromise = null;

export function getInIsolateRebuildPromise() {
  return inIsolateRebuildPromise;
}

export async function runBackgroundRebuild() {
  // Per-isolate dedup — multiple concurrent reads in the same isolate share
  // the same Promise. Different isolates coordinate via the KV lock.
  if (inIsolateRebuildPromise) {
    return inIsolateRebuildPromise;
  }
  inIsolateRebuildPromise = (async () => {
    const { acquireRebuildLock, releaseRebuildLock } = await import('./cache.js');
    const gotLock = await acquireRebuildLock();
    if (!gotLock) {
      console.log('Background rebuild: another isolate already holds the lock — skipping');
      return;
    }
    try {
      await buildSearchIndex();
    } catch (err) {
      console.error('Background rebuild failed:', err.message);
    } finally {
      await releaseRebuildLock();
      inIsolateRebuildPromise = null;
    }
  })();
  return inIsolateRebuildPromise;
}

// ── Search/filter/sort operations on a (possibly stale) index ──────

export function searchIndex(index, { query, course, semester, session, year, sort, page, limit }) {
  let items = (index && index.items) || [];

  if (query) {
    const qNorm = normalizeForCompare(query);
    items = items.filter((item) => {
      const titleNorm = normalizeForCompare(item.t);
      const courseNorm = normalizeForCompare(item.c);
      const sessionNorm = normalizeForCompare(item.se);
      const subjectNorm = normalizeForCompare(item.su);
      const yearStr = String(item.y);

      return (
        titleNorm.includes(qNorm) ||
        courseNorm.includes(qNorm) ||
        sessionNorm.includes(qNorm) ||
        subjectNorm.includes(qNorm) ||
        yearStr.includes(qNorm)
      );
    });
  }

  if (course) {
    const courseNorm = normalizeForCompare(course);
    items = items.filter((item) => {
      const c = normalizeForCompare(item.c);
      const t = normalizeForCompare(item.t);
      return c.includes(courseNorm) || t.includes(courseNorm);
    });
  }

  if (semester) {
    const semNorm = normalize(semester);
    items = items.filter((item) => normalize(item.s) === semNorm);
  }

  if (session) {
    const sessNorm = normalize(session);
    items = items.filter((item) => normalize(item.se).includes(sessNorm));
  }

  if (year) {
    const yearNum = parseInt(year, 10);
    if (!isNaN(yearNum)) {
      items = items.filter((item) => item.y === yearNum);
    }
  }

  const totalCount = items.length;
  items = sortItems(items, sort);

  const startIndex = (page - 1) * limit;
  const paginatedItems = items.slice(startIndex, startIndex + limit);

  return {
    items: paginatedItems,
    total: totalCount,
    page,
    limit,
    totalPages: Math.max(1, Math.ceil(totalCount / limit)),
  };
}

function sortItems(items, sort) {
  const arr = [...items];
  switch (sort) {
    case 'popular':
      return arr.sort((a, b) => (b.v || 0) - (a.v || 0) || (b.y || 0) - (a.y || 0));
    case 'az':
      return arr.sort((a, b) => String(a.t || '').localeCompare(String(b.t || '')));
    case 'za':
      return arr.sort((a, b) => String(b.t || '').localeCompare(String(a.t || '')));
    case 'oldest':
      return arr.sort((a, b) => (a.y || 0) - (b.y || 0));
    case 'newest':
    default:
      return arr.sort((a, b) => (b.y || 0) - (a.y || 0) || (b.ts || 0) - (a.ts || 0));
  }
}

export function getRecentItems(index, count = 6) {
  const items = [...((index && index.items) || [])];
  return items.sort((a, b) => (b.ts || 0) - (a.ts || 0)).slice(0, count);
}

export function getTrendingItems(index, count = 6) {
  const items = [...((index && index.items) || [])];
  return items
    .sort((a, b) => (b.v || 0) - (a.v || 0) || (b.ts || 0) - (a.ts || 0))
    .slice(0, count);
}

export function getCourseCounts(index) {
  const counts = {};
  for (const item of (index && index.items) || []) {
    const course = item.c || 'General';
    counts[course] = (counts[course] || 0) + 1;
  }

  return Object.entries(counts)
    .map(([course, count]) => ({ course, count }))
    .sort((a, b) => b.count - a.count);
}

export function getItemById(index, id) {
  return ((index && index.items) || []).find((item) => item.id === id) || null;
}

// Keep a reference to the default TTL for any callers that imported it
export { DEFAULT_KV_TTL };
