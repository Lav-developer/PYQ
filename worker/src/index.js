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
 *
 * Cache refresh strategy:
 *  - Each handler that needs the search index calls `ensureFreshIndex(ctx)`.
 *    On a hit, return the cached index. On a miss OR on a stale entry
 *    (strictly marked by an admin invalidation timestamp), the handler
 *    returns the stale data immediately and `ctx.waitUntil`-schedules a
 *    single-flight background rebuild. The response itself never waits for
 *    the rebuild — the next request sees fresh data.
 *  - There is NO short fixed-clock full-rebuild under normal traffic.
 *    The previous "every 10 minutes rebuild the entire PYQ collection" was
 *    removed. A 7-day hard TTL in cache.js acts as a safety fallback only.
 *  - Within a single request, endpoints do NOT perform duplicate Firestore
 *    collection reads. `/api/homepage` derives everything from the search
 *    index and contributors are read only by `/api/contributors`.
 */

import { getDocument, getAllDocuments } from './firestore.js';
import {
  KV_KEYS, getFromKV, setKV,
  getFromEdgeCache, setEdgeCache,
  shouldBypassCache, invalidateAll,
  VERY_LONG_KV_TTL,
} from './cache.js';
import {
  getSearchIndex, searchIndex,
  getRecentItems, getTrendingItems, getCourseCounts,
  runBackgroundRebuild,
} from './search.js';
import { checkRateLimit, getClientIP, normalizeEndpoint } from './rateLimit.js';
import {
  sanitizeSearchQuery, parsePagination, validateSort,
  validateFilters, isValidDocId,
} from './validation.js';
import { handleOptions, withCors } from './cors.js';

// ─── Request Handler ─────────────────────────────────────────────

async function handleRequest(request, ctx) {
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
      response = await handlePyqsList(url, ctx);
    } else if (path === '/api/pyqs/search' && method === 'GET') {
      response = await handlePyqsSearch(url, ctx);
    } else if (path.match(/^\/api\/pyqs\/([^\/]+)$/) && method === 'GET') {
      const id = decodeURIComponent(path.match(/^\/api\/pyqs\/([^\/]+)$/)[1]);
      response = await handlePyqsSingle(id);
    } else if (path === '/api/contributors' && method === 'GET') {
      response = await handleContributors();
    } else if (path === '/api/courses' && method === 'GET') {
      response = await handleCourses();
    } else if (path === '/api/homepage' && method === 'GET') {
      response = await handleHomepage(ctx);
    } else if (path === '/api/stats' && method === 'GET') {
      response = await handleStats(ctx);
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

// ─── Helpers shared by list/search/homepage/stats handlers ─────────

/**
 * Return a search index and (non-blocking) trigger a rebuild if the
 * stored index is stale. The caller immediately services the response;
 * the rebuild happens via `ctx.waitUntil` after the response is sent.
 *
 * Only ONE rebuild is ever in-flight per Worker isolate (deduped by
 * `runBackgroundRebuild`) and across isolates (KV lock in cache.js).
 */
async function ensureFreshIndex(ctx) {
  const result = await getSearchIndex();
  if (result.needsBackgroundRebuild && ctx && typeof ctx.waitUntil === 'function') {
    ctx.waitUntil(runBackgroundRebuild());
  }
  return result.index;
}

// ─── Route Handlers ──────────────────────────────────────────────

async function handlePyqsList(url, ctx) {
  const { page, limit } = parsePagination(url.searchParams);
  const sort = validateSort(url.searchParams.get('sort'));
  const filters = validateFilters(url.searchParams);

  const index = await ensureFreshIndex(ctx);
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

async function handlePyqsSearch(url, ctx) {
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

  const index = await ensureFreshIndex(ctx);
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

async function handleContributors() {
  const cached = await getFromKV(KV_KEYS.CONTRIBUTORS);
  if (cached && cached.items) {
    console.log(`KV cache HIT for contributors: ${cached.items.length} items`);
    return jsonResponse(cached.items, 200);
  }

  console.log('KV cache MISS for contributors — fetching from Firestore');
  const docs = await getAllDocuments('contributors', {
    orderBy: [{ field: 'name', direction: 'ASCENDING' }],
    pageSize: 300,
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
 *
 * IMPORTANT: this handler reads ONLY the search index. It does NOT
 * trigger a contributors Firestore collection read, so there is no
 * duplicate read in the same request when both `/api/homepage` and
 * `/api/contributors` are called.
 */
async function handleHomepage(ctx) {
  const cached = await getFromKV(KV_KEYS.HOMEPAGE);
  if (cached && cached.recent) {
    console.log('KV cache HIT for homepage');
    return jsonResponse(cached, 200);
  }

  const index = await ensureFreshIndex(ctx);
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

async function handleStats(ctx) {
  const cached = await getFromKV(KV_KEYS.STATS);
  if (cached && cached.totalPyqs !== undefined) {
    return jsonResponse(cached, 200);
  }

  const index = await ensureFreshIndex(ctx);
  if (index && index.items) {
    const courseCounts = getCourseCounts(index);
    const stats = {
      totalPyqs: index.count || 0,
      totalCourses: courseCounts.length,
      _cachedAt: Date.now(),
    };
    await setKV(KV_KEYS.STATS, stats, 600);
    return jsonResponse(stats, 200);
  }

  return jsonResponse({ totalPyqs: 0, totalCourses: 0 }, 200);
}

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
      return await handleRequest(request, ctx);
    } catch (err) {
      console.error('Unhandled error:', err.message, err.stack);
      return jsonResponse({ error: 'Internal server error' }, 500);
    }
  },
};
