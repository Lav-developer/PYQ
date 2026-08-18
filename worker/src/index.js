/**
 * DSMNRU PYQ Archive — Cloudflare Worker API
 *
 * Routes:
 *   GET /api/health          — Health check
 *   GET /api/pyqs            — List PYQs (pagination, sorting, filters)
 *   GET /api/pyqs/search     — Search PYQs
 *   GET /api/pyqs/:id        — Single PYQ detail (full doc with file URLs)
 *   GET /api/contributors    — Contributors list
 *   GET /api/courses         — Course catalog
 *   GET /api/homepage        — Homepage summary (recent, trending, course counts)
 *   GET /api/stats           — Aggregated stats
 *   POST /api/invalidate     — Invalidate cache (admin only, API key protected)
 */

import { getDocument } from './firestore.js';
import {
  KV_KEYS, getFromKV, setKV,
  getFromEdgeCache, setEdgeCache,
  shouldBypassCache, invalidateAll,
} from './cache.js';
import {
  getSearchIndex, searchIndex,
  getRecentItems, getTrendingItems, getCourseCounts,
} from './search.js';
import { checkRateLimit, getClientIP, normalizeEndpoint } from './rateLimit.js';
import {
  sanitizeSearchQuery, parsePagination, validateSort,
  validateFilters, isValidDocId,
} from './validation.js';
import { handleOptions, withCors } from './cors.js';

// ─── Request Handler ─────────────────────────────────────────────

async function handleRequest(request) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  if (method === 'OPTIONS') {
    return handleOptions(request);
  }

  if (path === '/api/health' && method === 'GET') {
    return jsonResponse({ status: 'ok', timestamp: new Date().toISOString() });
  }

  if (method !== 'GET' && path !== '/api/invalidate') {
    return jsonResponse({ error: 'Method not allowed' }, 405);
  }

  // Rate limiting
  const ip = getClientIP(request);
  const endpoint = normalizeEndpoint(url);
  const rateCheck = await checkRateLimit(ip, endpoint);
  if (!rateCheck.allowed) {
    console.log(`Rate limit exceeded for ${ip} on ${endpoint}`);
    return jsonResponse({
      error: 'Too many requests. Please slow down.',
      retryAfter: Math.ceil((rateCheck.reset - Date.now()) / 1000),
    }, 429, {
      'Retry-After': String(Math.ceil((rateCheck.reset - Date.now()) / 1000)),
    });
  }

  // Edge cache for GET requests
  const bypassCache = shouldBypassCache(request);
  if (method === 'GET' && !bypassCache) {
    const cached = await getFromEdgeCache(request);
    if (cached) {
      console.log(`Edge cache HIT: ${path}${url.search}`);
      return cached;
    }
  }

  // Route
  let response;
  try {
    if (path === '/api/pyqs' && method === 'GET') {
      response = await handlePyqsList(url);
    } else if (path === '/api/pyqs/search' && method === 'GET') {
      response = await handlePyqsSearch(url);
    } else if (path.match(/^\/api\/pyqs\/([^\/]+)$/) && method === 'GET') {
      const id = decodeURIComponent(path.match(/^\/api\/pyqs\/([^\/]+)$/)[1]);
      response = await handlePyqsSingle(id);
    } else if (path === '/api/contributors' && method === 'GET') {
      response = await handleContributors();
    } else if (path === '/api/courses' && method === 'GET') {
      response = await handleCourses();
    } else if (path === '/api/homepage' && method === 'GET') {
      response = await handleHomepage();
    } else if (path === '/api/stats' && method === 'GET') {
      response = await handleStats();
    } else if (path === '/api/invalidate' && method === 'POST') {
      response = await handleInvalidate(request);
    } else {
      response = jsonResponse({ error: 'Not found' }, 404);
    }
  } catch (err) {
    console.error(`Error handling ${path}:`, err.message);
    response = jsonResponse({ error: 'Internal server error', message: err.message }, 500);
  }

  // Wrap with CORS headers
  response = withCors(request, response);

  // Store in edge cache for GET
  if (method === 'GET' && response.status < 500) {
    const ttl = getCacheTTL(path);
    await setEdgeCache(request, response.clone(), ttl);
  }

  return response;
}

// ─── Route Handlers ──────────────────────────────────────────────

/**
 * GET /api/pyqs?page=1&limit=20&sort=newest&course=...&semester=...&session=...
 * Serves from the KV-cached search index — zero Firestore reads on cache hit.
 */
async function handlePyqsList(url) {
  const { page, limit } = parsePagination(url.searchParams);
  const sort = validateSort(url.searchParams.get('sort'));
  const filters = validateFilters(url.searchParams);

  const index = await getSearchIndex();
  if (!index || !index.items || index.items.length === 0) {
    return jsonResponse({ items: [], total: 0, page, limit, totalPages: 0 }, 200);
  }

  const result = searchIndex(index, {
    query: '',
    course: filters.course,
    semester: filters.semester,
    session: filters.session,
    year: filters.year,
    sort,
    page,
    limit,
  });

  return jsonResponse({
    items: mapIndexItems(result.items),
    total: result.total,
    page: result.page,
    limit: result.limit,
    totalPages: result.totalPages,
  }, 200);
}

/**
 * GET /api/pyqs/search?q=...&course=...&semester=...&session=...&sort=...&page=1&limit=20
 * Serves from the KV-cached search index — zero Firestore reads on cache hit.
 */
async function handlePyqsSearch(url) {
  const query = sanitizeSearchQuery(url.searchParams.get('q') || '');
  const course = url.searchParams.get('course') || '';
  const semester = url.searchParams.get('semester') || '';
  const session = url.searchParams.get('session') || '';
  const year = url.searchParams.get('year') || '';
  const sort = validateSort(url.searchParams.get('sort'));
  const { page, limit } = parsePagination(url.searchParams);

  if (query && query.length < 2) {
    return jsonResponse({ error: 'Search query must be at least 2 characters' }, 400);
  }

  const index = await getSearchIndex();
  if (!index || !index.items || index.items.length === 0) {
    return jsonResponse({ items: [], total: 0, page, limit, totalPages: 0 }, 200);
  }

  const result = searchIndex(index, {
    query,
    course,
    semester,
    session,
    year,
    sort,
    page,
    limit,
  });

  return jsonResponse({
    items: mapIndexItems(result.items),
    total: result.total,
    page: result.page,
    limit: result.limit,
    totalPages: result.totalPages,
  }, 200);
}

/**
 * GET /api/pyqs/:id — Full document including file URLs.
 * KV-cached for 1 hour; 1 Firestore read on miss.
 */
async function handlePyqsSingle(id) {
  if (!isValidDocId(id)) {
    return jsonResponse({ error: 'Invalid document ID' }, 400);
  }

  const kvKey = KV_KEYS.PYQ_ITEM(id);
  const cached = await getFromKV(kvKey);
  if (cached) {
    console.log(`KV cache HIT for item: ${id}`);
    return jsonResponse(cached, 200);
  }

  console.log(`KV cache MISS for item: ${id} — fetching from Firestore`);
  const doc = await getDocument('pyqs', id);
  if (!doc) {
    return jsonResponse({ error: 'PYQ not found' }, 404);
  }

  await setKV(kvKey, doc, 3600);

  return jsonResponse(doc, 200);
}

/**
 * GET /api/contributors — KV-cached, 1 Firestore read per hour on miss.
 */
async function handleContributors() {
  const cached = await getFromKV(KV_KEYS.CONTRIBUTORS);
  if (cached && cached.items) {
    console.log(`KV cache HIT for contributors: ${cached.items.length} items`);
    return jsonResponse(cached.items, 200);
  }

  console.log('KV cache MISS for contributors — fetching from Firestore');
  const { getAllDocuments } = await import('./firestore.js');
  const docs = await getAllDocuments('contributors', {
    orderBy: [{ field: 'name', direction: 'ASCENDING' }],
  });

  const items = docs.map((d) => ({
    id: d.id,
    name: d.name || '',
    avatar: d.avatar || '',
    role: d.role || '',
  }));

  await setKV(KV_KEYS.CONTRIBUTORS, { items, _cachedAt: Date.now() }, 3600);

  return jsonResponse(items, 200);
}

/**
 * GET /api/courses — course catalog, KV-cached (very static).
 */
async function handleCourses() {
  const cached = await getFromKV(KV_KEYS.COURSES);
  if (cached && cached.courses) {
    console.log('KV cache HIT for courses');
    return jsonResponse(cached.courses, 200);
  }

  const defaultCourses = [
    'B.A.', 'B.Com', 'B.Tech', 'B.Ed.', 'B.Tech (Hons.)',
    'B.V.A.', 'BPO', 'D.Pharm', 'MBA', 'MCA', 'M.Tech',
  ];

  await setKV(KV_KEYS.COURSES, { courses: defaultCourses, _cachedAt: Date.now() }, 86400);

  return jsonResponse(defaultCourses, 200);
}

/**
 * GET /api/homepage — recent, trending, course counts, stats.
 * Built from the search index (KV), cached separately.
 */
async function handleHomepage() {
  const cached = await getFromKV(KV_KEYS.HOMEPAGE);
  if (cached && cached.recent) {
    console.log('KV cache HIT for homepage');
    return jsonResponse(cached, 200);
  }

  const index = await getSearchIndex();
  if (!index || !index.items) {
    return jsonResponse({ recent: [], trending: [], courseCounts: [], stats: {} }, 200);
  }

  const recent = mapIndexItems(getRecentItems(index, 6));
  const trending = mapIndexItems(getTrendingItems(index, 6));
  const courseCounts = getCourseCounts(index);

  const homepageData = {
    recent,
    trending,
    courseCounts,
    stats: {
      totalPyqs: index.count || 0,
      totalCourses: courseCounts.length,
    },
    _cachedAt: Date.now(),
  };

  await setKV(KV_KEYS.HOMEPAGE, homepageData, 300);

  return jsonResponse(homepageData, 200);
}

/**
 * GET /api/stats — total PYQs and course count, KV-cached.
 */
async function handleStats() {
  const cached = await getFromKV(KV_KEYS.STATS);
  if (cached) {
    return jsonResponse(cached, 200);
  }

  const index = await getSearchIndex();
  const courseCounts = getCourseCounts(index || { items: [] });

  const stats = {
    totalPyqs: (index && index.count) || 0,
    totalCourses: courseCounts.length,
    _cachedAt: Date.now(),
  };

  await setKV(KV_KEYS.STATS, stats, 600);

  return jsonResponse(stats, 200);
}

/**
 * POST /api/invalidate — invalidate all caches.
 * Requires X-Api-Key matching ADMIN_API_KEY.
 */
async function handleInvalidate(request) {
  const apiKey = request.headers.get('X-Api-Key') || request.headers.get('x-api-key');
  const adminKey = typeof ADMIN_API_KEY !== 'undefined' ? ADMIN_API_KEY : null;
  if (!apiKey || !adminKey || apiKey !== adminKey) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  await invalidateAll();
  return jsonResponse({ status: 'ok', message: 'Cache invalidated' }, 200);
}

// ─── Helpers ─────────────────────────────────────────────────────

/**
 * Map compact index items to the public API shape.
 */
function mapIndexItems(items) {
  if (!items || !items.length) return [];
  return items.map((item) => ({
    id: item.id,
    title: item.t,
    course: item.c,
    semester: item.s,
    session: item.se,
    branch: item.b,
    subject: item.su,
    year: item.y,
    views: item.v,
  }));
}

/**
 * Determine edge cache TTL based on the endpoint path.
 */
function getCacheTTL(path) {
  if (path === '/api/contributors') return 600;
  if (path === '/api/courses') return 3600;
  if (path === '/api/homepage') return 120;
  if (path === '/api/stats') return 600;
  if (path.match(/^\/api\/pyqs\/search/)) return 60;
  if (path.match(/^\/api\/pyqs\//)) return 120;
  if (path === '/api/pyqs') return 120;
  return 60;
}

/**
 * Create a JSON response.
 */
function jsonResponse(data, status = 200, extraHeaders = {}) {
  const body = JSON.stringify(data);
  const headers = {
    'Content-Type': 'application/json',
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders,
  };

  headers['Cache-Control'] = status >= 400 ? 'no-store' : 'public, s-maxage=60, max-age=60';

  return new Response(body, { status, headers });
}

// ─── Worker Entry Point ──────────────────────────────────────────

export default {
  async fetch(request, env, ctx) {
    // Expose env bindings (KV namespace, secrets, vars) as globals so the
    // module code can reference them directly (PYQ_CACHE, FIREBASE_*, etc.)
    for (const [key, value] of Object.entries(env || {})) {
      if (!(key in globalThis)) {
        globalThis[key] = value;
      }
    }

    try {
      return await handleRequest(request);
    } catch (err) {
      console.error('Unhandled error:', err.message, err.stack);
      return jsonResponse({ error: 'Internal server error' }, 500);
    }
  },
};
