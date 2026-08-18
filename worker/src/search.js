/**
 * Lightweight search index for PYQ metadata.
 *
 * The index is built from Firestore once per TTL and cached in KV.
 * Search/filter/sort operations run against the KV-cached index,
 * so no Firestore reads are needed for the vast majority of searches.
 */

import { getAllDocuments } from './firestore.js';
import { KV_KEYS, getFromKV, setKV } from './cache.js';

const INDEX_TTL = 600; // 10 minutes

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
  if (pyq._sortTimestamp) return pyq._sortTimestamp;
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

export async function buildSearchIndex() {
  console.log('Building search index from Firestore...');
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
  await setKV(KV_KEYS.SEARCH_INDEX, cacheData, INDEX_TTL);
  console.log(`Search index built: ${index.length} items, cached in KV`);

  return cacheData;
}

export async function getSearchIndex({ forceRefresh = false } = {}) {
  if (!forceRefresh) {
    const cached = await getFromKV(KV_KEYS.SEARCH_INDEX);
    if (cached && cached.items && cached.items.length > 0) {
      console.log(`Search index cache HIT: ${cached.items.length} items`);
      return cached;
    }
  }

  console.log('Search index cache MISS — building from Firestore');
  return await buildSearchIndex();
}

export function searchIndex(index, { query, course, semester, session, year, sort, page, limit }) {
  let items = index.items || [];

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
  const items = [...(index.items || [])];
  return items.sort((a, b) => (b.ts || 0) - (a.ts || 0)).slice(0, count);
}

export function getTrendingItems(index, count = 6) {
  const items = [...(index.items || [])];
  return items
    .sort((a, b) => (b.v || 0) - (a.v || 0) || (b.ts || 0) - (a.ts || 0))
    .slice(0, count);
}

export function getCourseCounts(index) {
  const counts = {};
  for (const item of index.items || []) {
    const course = item.c || 'General';
    counts[course] = (counts[course] || 0) + 1;
  }

  return Object.entries(counts)
    .map(([course, count]) => ({ course, count }))
    .sort((a, b) => b.count - a.count);
}

export function getItemById(index, id) {
  return (index.items || []).find((item) => item.id === id) || null;
}
