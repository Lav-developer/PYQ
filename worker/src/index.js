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
 *   POST /api/invalidate     — Invalidate cache (Firebase admin-token only)
 *   POST /api/notify         — Send FCM push to Android `all_users` topic
 *                             (Firebase admin-token only, validated body)
 *   GET /pyq/:slug           — Server-rendered, crawlable public PYQ page
 *   GET /sitemap.xml         — Dynamic sitemap from the KV search index
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
  KV_KEYS, getFromKV, setKV, getInvalidationTimestamp,
  invalidateAll,
  VERY_LONG_KV_TTL,
} from './cache.js';
import {
  getSearchIndex, searchIndex,
  getRecentItems, getTrendingItems, getCourseCounts,
  getItemById, getItemBySlug, assignCanonicalSlugs, isPublicIndexItem,
  isPublicPyq, runBackgroundRebuild,
} from './search.js';
import { checkRateLimit, getClientIP, normalizeEndpoint } from './rateLimit.js';
import {
  sanitizeSearchQuery, parsePagination, validateSort,
  validateFilters, isValidDocId, parseJSONBody,
} from './validation.js';
import {
  NOTIFICATION_TOPIC, validateNotificationPayload, sendTopicNotification,
} from './fcm.js';
import { handleOptions, withCors } from './cors.js';
import { isSafePyqSlug } from './slug.js';
import {
  PUBLIC_SITE_ORIGIN,
  createSeoPaper,
  getRelatedIndexItems,
  renderSeoPaperHtml,
  renderPyqNotFoundPage,
  renderPyqUnavailablePage,
  renderSitemapXml,
} from './seo.js';
import { jwtVerify, createRemoteJWKSet } from 'jose';
// ─── Firebase ID Token Verification ───────────────────────────────

const FIREBASE_PROJECT_ID = 'dsmnru-data';

// The interactive shell remains authored in paper.html. The Worker fetches
// that one static shell and fills its explicit SEO markers; no paper-specific
// files are generated or stored. This small isolate-local cache avoids a
// static-origin request for every crawl without writing another KV key.
const PAPER_TEMPLATE_URL = `${PUBLIC_SITE_ORIGIN}/paper.html`;
const PAPER_TEMPLATE_TTL_MS = 5 * 60 * 1000;
let paperTemplate = '';
let paperTemplateCachedAt = 0;
let paperTemplatePromise = null;

async function getPaperTemplate() {
  const isFresh = paperTemplate && (Date.now() - paperTemplateCachedAt < PAPER_TEMPLATE_TTL_MS);
  if (isFresh) return paperTemplate;
  if (paperTemplatePromise) return paperTemplatePromise;

  paperTemplatePromise = (async () => {
    const response = await fetch(PAPER_TEMPLATE_URL, {
      headers: { Accept: 'text/html' },
    });
    if (!response.ok) {
      throw new Error(`Unable to load paper template: ${response.status}`);
    }

    const template = await response.text();
    // Fail closed rather than accidentally returning an unpersonalized,
    // generic page if the static template and Worker deploy are out of sync.
    if (!template.includes('id="seoPaperContent"') || !template.includes('id="paperSeoBootstrap"')) {
      throw new Error('Paper template is missing SEO markers');
    }

    paperTemplate = template;
    paperTemplateCachedAt = Date.now();
    return paperTemplate;
  })();

  try {
    return await paperTemplatePromise;
  } finally {
    paperTemplatePromise = null;
  }
}

const FIREBASE_JWKS = createRemoteJWKSet(
  new URL(
    'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com'
  )
);

async function verifyFirebaseAdminToken(request) {
  const authHeader = request.headers.get('Authorization');

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null;
  }

  const token = authHeader.slice(7).trim();

  if (!token) {
    return null;
  }

  try {
    const { payload } = await jwtVerify(token, FIREBASE_JWKS, {
      issuer: `https://securetoken.google.com/${FIREBASE_PROJECT_ID}`,
      audience: FIREBASE_PROJECT_ID,
    });

    // Firebase user must have a valid UID.
    if (!payload.sub || typeof payload.sub !== 'string') {
      return null;
    }

    // Only Firebase users with admin:true may invalidate cache.
    if (payload.admin !== true) {
      return null;
    }

    return payload;
  } catch (error) {
    console.warn(
      'Firebase admin token verification failed:',
      error.message
    );
    return null;
  }
}

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

  // Netlify rewrites public /pyq/* and /sitemap.xml requests to this Worker.
  // Do not run these crawl routes through the KV rate limiter: Netlify's
  // external rewrite does not reliably preserve an individual crawler IP, and
  // a limiter write per rendered page would be needless KV traffic. These
  // routes expose only public index metadata and remain KV-first.
  if (method === 'GET' && path === '/sitemap.xml') {
    try {
      return await handleSitemap(ctx);
    } catch (err) {
      console.error('Error handling dynamic sitemap:', err.message);
      return sitemapUnavailableResponse();
    }
  }

  if (method === 'GET' && path.startsWith('/pyq/')) {
    try {
      return await handlePyqPage(path, ctx);
    } catch (err) {
      console.error(`Error handling SEO page ${path}:`, err.message);
      return renderPyqUnavailablePage();
    }
  }

  // POST-only admin routes. Everything else on the API is GET.
  const WRITABLE_ROUTES = new Set(['/api/invalidate', '/api/notify']);
  if (method !== 'GET' && !WRITABLE_ROUTES.has(path)) {
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
    } else if (path === '/api/notify' && method === 'POST') {
      response = await handleNotify(request);
    } else {
      response = jsonResponse({ error: 'Not found' }, 404);
    }
  } catch (err) {
    console.error(`Error handling ${path}:`, err.message);
    response = jsonResponse({ error: 'Internal server error', message: err.message }, 500);
  }

  // Wrap with CORS headers
  response = withCors(request, response);


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
  // A pre-SEO compact index is still usable for existing API browse/search
  // responses, but has no explicit public bit. Its SEO surface fails closed
  // while getSearchIndex schedules the normal background schema rebuild.
  assignCanonicalSlugs(result.index);
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

const PYQ_ITEM_CACHE_VERSION = 1;

function unpackPyqItemCache(value) {
  // Raw documents are the legacy KV representation. They remain readable
  // until the next admin invalidation, when they are safely revalidated.
  if (value && value._pyqItemCacheVersion === PYQ_ITEM_CACHE_VERSION
    && value.document && typeof value.document === 'object') {
    return {
      document: value.document,
      cachedAt: Number(value.cachedAt) || 0,
    };
  }
  return { document: value, cachedAt: 0 };
}

/**
 * Read one full PYQ with the existing KV-first policy. Both the JSON detail
 * endpoint and the server-rendered page use this helper, so a warm item cache
 * never causes a Firestore request. A global admin invalidation intentionally
 * makes older per-item entries stale: this prevents a warm pre-change document
 * from being SSR-rendered as public after it was made private.
 */
async function getPyqItem(id) {
  const kvKey = KV_KEYS.PYQ_ITEM(id);
  const cached = unpackPyqItemCache(await getFromKV(kvKey));
  if (cached.document) {
    const invalidatedAt = await getInvalidationTimestamp();
    if (!invalidatedAt || cached.cachedAt > invalidatedAt) {
      console.log(`KV cache HIT for item: ${id}`);
      return cached.document;
    }
    console.log(`KV cache STALE after invalidation for item: ${id}`);
  }

  console.log(`KV cache MISS for item: ${id} — fetching from Firestore`);
  const doc = await getDocument('pyqs', id);
  if (!doc) return null;

  await setKV(kvKey, {
    _pyqItemCacheVersion: PYQ_ITEM_CACHE_VERSION,
    cachedAt: Date.now(),
    document: doc,
  }, 3600);
  return doc;
}

/**
 * A legacy paper.html URL can receive a correct canonical tag after client
 * hydration without forcing an index rebuild. This is a KV read only; when
 * the index is cold or predates explicit public-state fields, we leave the
 * legacy page's existing noindex fallback.
 */
async function getCachedSeoSlugForId(id) {
  const index = await getFromKV(KV_KEYS.SEARCH_INDEX);
  if (!index || !Array.isArray(index.items)) return '';

  assignCanonicalSlugs(index);
  const item = getItemById(index, id);
  return item && isPublicIndexItem(item) && isSafePyqSlug(item.sl) ? item.sl : '';
}

async function handlePyqsSingle(id) {
  if (!isValidDocId(id)) {
    return jsonResponse({ error: 'Invalid document ID' }, 400);
  }

  const doc = await getPyqItem(id);
  if (!doc) {
    return jsonResponse({ error: 'PYQ not found' }, 404);
  }

  // Never attach a crawlable canonical slug to an explicitly non-public
  // document, even if a stale compact index still has its old public state.
  const seoSlug = isPublicPyq(doc) ? await getCachedSeoSlugForId(id) : '';
  // Additive field only; existing clients still receive the full document.
  return jsonResponse(seoSlug ? { ...doc, seoSlug } : doc, 200);
}

function stableStringCompare(a, b) {
  const left = String(a);
  const right = String(b);
  return left < right ? -1 : left > right ? 1 : 0;
}

// The URL allocator groups persisted slug bases; SEO uniqueness is instead
// based on the currently displayed title, so two records with the same title
// still receive distinct social/document titles even if their historical bases
// differ after an edit.
function getSeoTitleVariant(index, currentItem) {
  const title = String(currentItem && currentItem.t || '').trim();
  if (!title) return 0;

  const matching = ((index && index.items) || [])
    .filter((item) => isPublicIndexItem(item) && String(item.t || '').trim() === title)
    .sort((a, b) => {
      const aTimestamp = Number(a.ts) > 0 ? Number(a.ts) : Number.MAX_SAFE_INTEGER;
      const bTimestamp = Number(b.ts) > 0 ? Number(b.ts) : Number.MAX_SAFE_INTEGER;
      return aTimestamp - bTimestamp || stableStringCompare(a.id, b.id);
    });
  const position = matching.findIndex((item) => item.id === currentItem.id);
  return position > 0 ? position + 1 : 0;
}

function slugFromPyqPath(path) {
  const match = path.match(/^\/pyq\/([^/]+)$/);
  if (!match) return '';
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return '';
  }
}

async function handlePyqPage(path, ctx) {
  const slug = slugFromPyqPath(path);
  if (!isSafePyqSlug(slug)) {
    return renderPyqNotFoundPage();
  }

  // 1) Resolve the public slug from the compact KV search index.
  const index = await ensureFreshIndex(ctx);
  const indexItem = getItemBySlug(index, slug);
  if (!indexItem || !isValidDocId(indexItem.id)) {
    return renderPyqNotFoundPage();
  }

  // 2) Retrieve the individual document from its existing KV item cache.
  // Firestore is used only if that particular item genuinely is not cached.
  const document = await getPyqItem(indexItem.id);
  if (!document || !isPublicPyq(document)) {
    // A stale index can briefly reference a just-deleted or newly-private
    // document. Never render a fresh document that explicitly opts out of
    // public visibility, even before the scheduled index rebuild finishes.
    return renderPyqNotFoundPage();
  }

  const paper = createSeoPaper(indexItem, document, {
    seoVariant: getSeoTitleVariant(index, indexItem),
  });
  if (!paper.id || !paper.title) {
    return renderPyqNotFoundPage();
  }

  const related = getRelatedIndexItems(index, indexItem, 6);
  const template = await getPaperTemplate();
  const html = renderSeoPaperHtml(template, paper, slug, related);
  return htmlResponse(html, 200);
}

async function handleSitemap(ctx) {
  const index = await ensureFreshIndex(ctx);
  return new Response(renderSitemapXml(index), {
    status: 200,
    headers: {
      'Content-Type': 'application/xml; charset=UTF-8',
      // The sitemap is always generated from the index currently available to
      // this request; do not add a second response-cache layer around it.
      'Cache-Control': 'public, max-age=0, must-revalidate',
      'X-Content-Type-Options': 'nosniff',
    },
  });
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
  const admin = await verifyFirebaseAdminToken(request);

  if (!admin) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  await invalidateAll();

  return jsonResponse({
    status: 'ok',
    message: 'Cache invalidated'
  }, 200);
}

// ─── Admin push notifications (FCM topic → Android app) ─────────────
//
// The Android app subscribes every install to the single `all_users`
// topic; there is intentionally NO per-device token database on either
// branch. The Worker sends one HTTP v1 message to that topic after
// verifying a Firebase ID token with the admin claim.

/** Accidental-repeat guard: one successful send per admin per window. */
const NOTIFY_COOLDOWN_SECONDS = 30;

async function handleNotify(request) {
  const admin = await verifyFirebaseAdminToken(request);
  if (!admin) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  const body = await parseJSONBody(request);
  const validated = validateNotificationPayload(body);
  if (!validated.ok) {
    return jsonResponse({ error: validated.error }, 400);
  }

  // Secondary guard against double-clicks / duplicate sends, independent of
  // the IP rate limiter (an admin token can be used from multiple admins).
  const cooldownKey = `notify:cooldown:${admin.sub || 'unknown'}`;
  if (typeof PYQ_CACHE !== 'undefined') {
    const waiting = await PYQ_CACHE.get(cooldownKey, 'text');
    if (waiting) {
      return jsonResponse({
        error: 'A notification was just sent from this admin account. Please wait a moment before sending another.',
        retryAfter: NOTIFY_COOLDOWN_SECONDS,
      }, 429, {
        'Retry-After': String(NOTIFY_COOLDOWN_SECONDS),
      });
    }
  }

  try {
    const result = await sendTopicNotification({
      title: validated.title,
      body: validated.body,
      path: validated.path,
    });

    if (typeof PYQ_CACHE !== 'undefined') {
      await PYQ_CACHE.put(cooldownKey, '1', { expirationTtl: NOTIFY_COOLDOWN_SECONDS });
    }

    return jsonResponse({
      status: 'ok',
      sent: true,
      topic: NOTIFICATION_TOPIC,
      messageId: result.messageId,
      note: 'FCM accepted the notification for the all_users topic. FCM does not report subscriber counts, so if no Android install has the app yet, it will simply not reach any device.',
    }, 200);
  } catch (error) {
    console.error('Notification send failed:', error.message);
    if (error.status === 401 || error.status === 403) {
      return jsonResponse({
        error: 'Notification service credentials are not configured or are not authorized for this project.',
      }, 502);
    }
    return jsonResponse({
      error: 'Notification service is temporarily unavailable. No notification was sent.',
    }, 502);
  }
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
    slug: item.sl || '',
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

function sitemapUnavailableResponse() {
  return new Response(
    '<?xml version="1.0" encoding="UTF-8"?><error>Temporarily unavailable</error>',
    {
      status: 503,
      headers: {
        'Content-Type': 'application/xml; charset=UTF-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'X-Robots-Tag': 'noindex, follow',
      },
    }
  );
}

function htmlResponse(html, status = 200) {
  return new Response(html, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=UTF-8',
      // The index and item KV caches already protect Firestore. Avoid a
      // separate response-edge cache so admin invalidations take effect as
      // soon as the index rebuild completes.
      'Cache-Control': 'public, max-age=0, must-revalidate',
      'X-Content-Type-Options': 'nosniff',
      'X-Robots-Tag': 'index, follow',
    },
  });
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
