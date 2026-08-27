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
import { createSlug, encodeSlugId, isSafePyqSlug } from './slug.js';

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

// Bump this only when the canonical-slug representation changes.
const SLUG_INDEX_VERSION = 2;

const NON_PUBLIC_PYQ_STATUSES = new Set([
  'draft', 'pending', 'private', 'unpublished', 'rejected', 'deleted', 'archived', 'inactive',
  'hidden', 'internal', 'restricted', 'protected', 'authenticated', 'auth-only', 'auth_only',
  'requires-authentication', 'login', 'login-required', 'login_required', 'signed-in',
  'members', 'members-only', 'members_only', 'registered', 'registered-users', 'user-only',
  'users-only', 'staff', 'admin', 'administrators', 'unlisted',
]);

function isExplicitlyFalse(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  return value === false || value === 0 || normalized === 'false' || normalized === '0';
}

function isExplicitlyTrue(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  return value === true || value === 1 || normalized === 'true' || normalized === '1';
}

/**
 * The public API still exposes its existing `pyqs` collection behavior. This
 * predicate is deliberately scoped to the new crawlable routes and sitemap so
 * a draft/private record can never be published through the SEO surface.
 */
export function isPublicPyq(pyq) {
  if (!pyq || typeof pyq !== 'object') return false;
  if (isExplicitlyFalse(pyq.published) || isExplicitlyFalse(pyq.isPublished)) return false;
  if (isExplicitlyFalse(pyq.public) || isExplicitlyFalse(pyq.isPublic)) return false;
  if (isExplicitlyTrue(pyq.draft) || isExplicitlyTrue(pyq.private)
    || isExplicitlyTrue(pyq.unpublished) || isExplicitlyTrue(pyq.archived)
    || isExplicitlyTrue(pyq.deleted)) return false;

  // Do not use `visibility || access || accessLevel` here: a public value in
  // one legacy field must never mask an explicitly private value in another.
  // Numeric/boolean false-like access states are also deliberately private.
  const accessStates = [pyq.status, pyq.visibility, pyq.access, pyq.accessLevel];
  return !accessStates.some((value) => {
    const state = String(value ?? '').trim().toLowerCase();
    return isExplicitlyFalse(value) || NON_PUBLIC_PYQ_STATUSES.has(state);
  });
}

function storedSlugBase(value) {
  const candidate = String(value || '').trim().toLowerCase();
  // Stored slugs are intentionally simple title slugs. Collision suffixes are
  // assigned from the complete current index, never trusted from Firestore.
  return candidate && candidate === createSlug(candidate) ? candidate : '';
}

/**
 * Build the compact item held in KV. `sb` preserves an optional stable slug
 * base written by the admin UI; it lets a title edit retain its existing SEO
 * URL without any Worker-side write or historical-slug database.
 */
export function buildIndexItem(pyq) {
  const title = String(pyq.title || '');
  return {
    id: pyq.id,
    t: title,
    c: String(pyq.course || pyq.category || ''),
    s: String(pyq.semester || pyq.sem || ''),
    se: String(pyq.session || ''),
    b: String(pyq.branch || ''),
    su: String(pyq.subject || ''),
    y: extractYearFromTitle(title),
    v: Number.isFinite(Number(pyq.views)) ? Math.floor(Number(pyq.views)) : 0,
    ts: extractSortTimestamp(pyq),
    // `p` is compact public-visibility state for /pyq and /sitemap.xml only.
    p: isPublicPyq(pyq),
    sb: storedSlugBase(pyq.slug) || createSlug(title) || 'pyq',
  };
}

export function isPublicIndexItem(item) {
  // SEO must fail closed for an older compact index that predates the explicit
  // public bit. API browse/search still retain their existing records, but a
  // pretty URL, sitemap entry, or server-related link is emitted only after a
  // normal rebuild has positively classified the item as public.
  return !!item && item.p === true;
}

function stableStringCompare(a, b) {
  const left = String(a);
  const right = String(b);
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalOwnerSort(a, b) {
  const aTimestamp = Number(a.ts) > 0 ? Number(a.ts) : Number.MAX_SAFE_INTEGER;
  const bTimestamp = Number(b.ts) > 0 ? Number(b.ts) : Number.MAX_SAFE_INTEGER;
  return aTimestamp - bTimestamp || stableStringCompare(a.id, b.id);
}

function canonicalSlugBase(item) {
  const title = String(item && item.t || '').trim();
  if (!title) return '';
  // Older compact indexes did not persist `sb`; reconstruct their base using
  // the same safe non-Latin fallback that fresh admin/index writes use.
  return String(item.sb || createSlug(title) || 'pyq').trim();
}

function hasValidAssignedCanonicalSlugs(index, items) {
  if (!index || index.slugVersion !== SLUG_INDEX_VERSION) return false;

  const assigned = new Set();
  for (const item of items) {
    if (!item || typeof item.sl !== 'string') return false;

    const base = canonicalSlugBase(item);
    const shouldHaveSlug = isPublicIndexItem(item)
      && !!item.id
      && !!base
      && isSafePyqSlug(base);

    if (!shouldHaveSlug) {
      if (item.sl !== '') return false;
      continue;
    }

    // `encodeSlugId()` is base64url and intentionally case-sensitive, so do
    // not normalize `sl` here; just require a safe, globally unique segment.
    if (!isSafePyqSlug(item.sl) || assigned.has(item.sl)) {
      return false;
    }
    assigned.add(item.sl);
  }
  return true;
}

/**
 * Assign a canonical `sl` to every public, titled index item.
 *
 * Duplicate title bases are never silently resolved to an arbitrary document:
 * the oldest stable record keeps the readable base and every other record gets
 * `--<base64url(document-id)>`. A rare collision between that suffix and a
 * different readable title base receives a numeric discriminator before the
 * same ID suffix. URLs remain deterministic and unambiguous. Non-public
 * records do not occupy a public slug namespace.
 *
 * A pre-feature index without an explicit public bit fails closed for SEO and
 * is refreshed through the normal background rebuild. New rebuilds persist
 * `sl` in the normal index value.
 */
export function assignCanonicalSlugs(index) {
  const items = (index && Array.isArray(index.items)) ? index.items : [];
  // Trust a version marker only when every assignment is present, safe, and
  // unique. This repairs partial/restored/corrupt KV values rather than
  // allowing two public records to resolve from the same pretty URL.
  if (hasValidAssignedCanonicalSlugs(index, items)) {
    return index;
  }

  const groups = new Map();

  for (const item of items) {
    item.sl = '';
    const base = canonicalSlugBase(item);
    if (!isPublicIndexItem(item) || !item.id || !base || !isSafePyqSlug(base)) continue;

    if (!groups.has(base)) groups.set(base, []);
    groups.get(base).push(item);
  }

  // Reserve every readable base before allocating duplicate suffixes. Without
  // this, a base such as `paper--w78` could (for a Unicode document ID) clash
  // with another title group's `paper--<base64url-id>` suffix.
  const allocated = new Set(groups.keys());
  const sortedGroups = [...groups.entries()].sort(([a], [b]) => stableStringCompare(a, b));

  for (const [base, group] of sortedGroups) {
    group.sort(canonicalOwnerSort);
    group.forEach((item, position) => {
      if (position === 0) {
        item.sl = base;
        return;
      }

      const idSuffix = encodeSlugId(item.id);
      let candidate = `${base}--${idSuffix}`;
      let discriminator = 2;
      // The normal duplicate URL is exactly `base--base64url(id)`. The rare
      // cross-base namespace collision receives a deterministic numeric
      // discriminator while retaining the reversible document-ID suffix.
      while (allocated.has(candidate)) {
        candidate = `${base}--${discriminator}--${idSuffix}`;
        discriminator += 1;
      }

      if (isSafePyqSlug(candidate)) {
        item.sl = candidate;
        allocated.add(candidate);
      }
    });
  }

  if (index) index.slugVersion = SLUG_INDEX_VERSION;
  return index;
}

export function getItemBySlug(index, slug) {
  if (!isSafePyqSlug(slug)) return null;
  assignCanonicalSlugs(index);
  return ((index && index.items) || []).find((item) => (
    isPublicIndexItem(item) && item.sl === slug
  )) || null;
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
  assignCanonicalSlugs(cacheData);
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

  // Older index values predate compact public-state and canonical-slug fields.
  // Continue serving their existing API browse/search data, but schedule the
  // normal single-flight rebuild so SEO routes can fail closed meanwhile.
  const needsSchemaRebuild = cached.slugVersion !== SLUG_INDEX_VERSION
    || cached.items.some((item) => !item || typeof item.p !== 'boolean')
    || !hasValidAssignedCanonicalSlugs(cached, cached.items);
  if (needsSchemaRebuild) {
    console.log('Search index stale: compact SEO schema upgrade required');
    return {
      index: cached,
      fresh: false,
      needsBackgroundRebuild: true,
      reason: 'stale-schema',
    };
  }

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
      return arr.sort((a, b) => stableStringCompare(a.t || '', b.t || ''));
    case 'za':
      return arr.sort((a, b) => stableStringCompare(b.t || '', a.t || ''));
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
