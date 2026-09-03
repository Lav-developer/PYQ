/**
 * DSMNRU PYQ Android — Worker API client.
 *
 * THE ONLY WAY the app talks about public archive data. Everything flows
 * through the existing Cloudflare Worker (same endpoints the website uses):
 *
 *   GET /api/homepage        → recents, trending, course counts, stats
 *   GET /api/courses         → course catalog
 *   GET /api/pyqs            → paginated browse list (course/semester/session filters, sort)
 *   GET /api/pyqs/search     → server-side search (never client-side archive scans)
 *   GET /api/pyqs/:id        → full paper document (PDF links included)
 *   GET /api/pyqs/slug/:s    → deep-link slug → index item (additive Worker route)
 *   GET /api/contributors    → contributor list (KV-cached server-side)
 *
 * Traffic discipline (Cloudflare free-tier friendly):
 *  - Every GET is deduplicated by request key: concurrent identical calls
 *    share one in-flight request.
 *  - Memory cache with per-kind TTL + a small persisted layer for data that
 *    barely changes (courses, homepage, opened papers).
 *  - Stale-while-revalidate for list-like screens: a cached payload renders
 *    instantly while a background refresh updates it — unless the payload is
 *    still within its fresh TTL, in which case NOTHING is fetched.
 *  - On network failure the last cache entry (even expired) is served with a
 *    `stale` marker, so offline still shows content instead of an error.
 *  - Search requests carry an AbortController owned by the caller: typing
 *    cancels the previous query, so a stale response can never be rendered.
 *  - Hard timeout per request; no polling, no background refetch timers.
 *
 * The module is DOM-free and takes `fetchImpl`/`storage`/`now` injection for
 * unit tests (see android-app/test/app.test.mjs).
 */

import { fallbackMatchForSlug, slugToQuery } from './slug.js';

export const WORKER_ORIGIN = 'https://dsmnru-pyq-api.kush210431-cloudflare.workers.dev';
export const SITE_ORIGIN = 'https://dsmnru-pyq.netlify.app';
const API_BASE = WORKER_ORIGIN + '/api';

const TTL_MS = {
  homepage: 10 * 60 * 1000,
  courses: 24 * 60 * 60 * 1000,
  listPage: 5 * 60 * 1000,
  search: 3 * 60 * 1000,
  detail: 30 * 60 * 1000,
  slug: 10 * 60 * 1000,
  contributors: 24 * 60 * 60 * 1000,
};

const PERSIST_PREFIX = 'dsm.cache.v1.';
const PERSIST_MAX_DETAIL = 24; // LRU cap for persisted paper documents

function keyFor(name, params) {
  if (!params || Object.keys(params).length === 0) return name;
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') usp.set(k, String(v));
  }
  const q = usp.toString();
  return q ? name + '?' + q : name;
}

/** Build the query string for /api/pyqs (browse) — mirrors the Worker's params. */
export function buildListParams({ page, limit, sort, course, semester, session, year } = {}) {
  const params = { page: String(page || 1), limit: String(limit || 20), sort: sort || 'newest' };
  if (course) params.course = String(course).trim();
  if (semester) params.semester = String(semester).trim().toLowerCase();
  if (session) params.session = String(session).trim();
  if (year) params.year = String(year).trim();
  return params;
}

/** Build the query string for /api/pyqs/search — mirrors the website's builder. */
export function buildSearchParams({ q, page, limit, sort, course, semester, session } = {}) {
  const params = { page: String(page || 1), limit: String(limit || 20), sort: sort || 'newest' };
  const query = String(q || '').trim();
  if (query) params.q = query.slice(0, 200);
  if (course) params.course = String(course).trim();
  if (semester) params.semester = String(semester).trim().toLowerCase();
  if (session) params.session = String(session).trim();
  return params;
}

export function createApi(options = {}) {
  const fetchImpl = options.fetchImpl || ((...args) => fetch(...args));
  const storage = options.storage || null; // localStorage-compatible or null
  const now = options.now || (() => Date.now());
  const timeoutMs = options.timeoutMs || 20000;

  const memory = new Map();      // key -> { value, at }
  const inflight = new Map();    // key -> Promise
  const detailLru = [];          // keys of persisted detail entries (recency)

  // ---- persistence helpers (safe under quota errors / missing storage) ----
  function persist(key, value) {
    if (!storage) return;
    try {
      storage.setItem(PERSIST_PREFIX + key, JSON.stringify({ at: now(), value }));
    } catch { /* quota or privacy mode — memory cache still applies */ }
  }
  function restore(key) {
    if (!storage) return null;
    try {
      const raw = storage.getItem(PERSIST_PREFIX + key);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || !('value' in parsed)) return null;
      return parsed;
    } catch { return null; }
  }
  function touchDetailLru(key) {
    const idx = detailLru.indexOf(key);
    if (idx !== -1) detailLru.splice(idx, 1);
    detailLru.push(key);
    while (detailLru.length > PERSIST_MAX_DETAIL && storage) {
      const evict = detailLru.shift();
      try { storage.removeItem(PERSIST_PREFIX + evict); } catch { /* ignore */ }
    }
  }

  function cacheGet(key, ttl) {
    let entry = memory.get(key);
    if (!entry) {
      const persisted = restore(key);
      if (persisted) {
        entry = persisted;
        memory.set(key, entry);
      }
    }
    if (!entry) return null;
    const fresh = now() - entry.at < ttl;
    return { value: entry.value, fresh, ageMs: now() - entry.at };
  }

  async function request(name, params, { signal } = {}) {
    const key = keyFor(name, params);
    const url = API_BASE + key;

    if (inflight.has(key)) return inflight.get(key);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
    const onOuterAbort = () => controller.abort(new Error('cancelled'));
    if (signal) {
      if (signal.aborted) { controller.abort(new Error('cancelled')); }
      else signal.addEventListener('abort', onOuterAbort, { once: true });
    }

    const p = (async () => {
      try {
        const res = await fetchImpl(url, {
          headers: { Accept: 'application/json' },
          signal: controller.signal,
        });
        if (!res.ok) {
          let detail = '';
          try {
            const body = await res.json();
            if (body && body.error) detail = body.error;
          } catch { /* non-JSON error body */ }
          const err = new Error(detail || 'API error ' + res.status);
          err.status = res.status;
          throw err;
        }
        return await res.json();
      } finally {
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onOuterAbort);
        inflight.delete(key);
      }
    })();

    inflight.set(key, p);
    return p;
  }

  /**
   * Core fetch with the app's cache policy.
   * mode 'swr': return the cached payload immediately (even expired) and
   * refresh in the background only when it is older than `ttl` — screens that
   * re-mount constantly (home, courses) never re-hit the network needlessly.
   * mode 'fresh': force a network fetch, skipping the cache read.
   */
  async function withCache(name, params, { ttl, persist: keep = false, allowStaleOnNetworkError = true, signal = null, force = false } = {}) {
    const key = keyFor(name, params);
    const effectiveTtl = ttl || TTL_MS[name] || TTL_MS.search;
    const cached = cacheGet(key, effectiveTtl);

    if (cached && cached.fresh && !force) {
      return { data: cached.value, stale: false, fromCache: true };
    }

    if (cached && !force) {
      // Serve now, refresh once in the background (deduped by inflight map).
      const bg = request(name, params, {}).then((data) => {
        memory.set(key, { value: data, at: now() });
        if (keep) { persist(key, data); if (name.startsWith('/pyqs/')) touchDetailLru(key); }
        return data;
      }).catch(() => null);
      return { data: cached.value, stale: true, fromCache: true, revalidating: bg };
    }

    try {
      const data = await request(name, params, { signal });
      memory.set(key, { value: data, at: now() });
      if (keep) { persist(key, data); if (name.startsWith('/pyqs/')) touchDetailLru(key); }
      return { data, stale: false, fromCache: false };
    } catch (err) {
      if (err && (err.name === 'AbortError' || /cancel/i.test(err.message || ''))) throw err;
      if (cached && allowStaleOnNetworkError) {
        return { data: cached.value, stale: true, fromCache: true };
      }
      if (keep) {
        const persisted = restore(key);
        if (persisted) return { data: persisted.value, stale: true, fromCache: true };
      }
      throw err;
    }
  }

  const api = {
    /** Homepage bundle: recent, trending, courseCounts, stats. Persisted, SWR. */
    homepage(opts = {}) {
      return withCache('/homepage', null, { ttl: TTL_MS.homepage, persist: true, force: !!opts.force });
    },

    /** Course catalog. Rarely changes — persisted with a 24h fresh window. */
    courses(opts = {}) {
      return withCache('/courses', null, { ttl: TTL_MS.courses, persist: true, force: !!opts.force });
    },

    /**
     * Contributor list — ONE Worker request for the whole screen (the Worker
     * serves it from KV; it never fans out per contributor). Persisted with a
     * 24h fresh window so re-opening the screen is free, SWR afterwards.
     */
    contributors(opts = {}) {
      return withCache('/contributors', null, { ttl: TTL_MS.contributors, persist: true, force: !!opts.force });
    },

    /** Paginated browse list. Cached per page/filters; never prefetched ahead. */
    list(params, opts = {}) {
      return withCache('/pyqs', buildListParams(params), {
        ttl: TTL_MS.listPage,
        signal: opts.signal,
        force: !!opts.force,
      });
    },

    /** Server-side search. Caller owns the AbortSignal so stale queries die. */
    search(params, opts = {}) {
      return withCache('/pyqs/search', buildSearchParams(params), {
        ttl: TTL_MS.search,
        signal: opts.signal,
        force: !!opts.force,
        // A cancelled/stale search must never fall back to "stale cache".
        allowStaleOnNetworkError: false,
      });
    },

    /** Full paper document (metadata + both file links). Persisted per id. */
    detail(id, opts = {}) {
      if (!id || typeof id !== 'string') throw new Error('Paper id required');
      return withCache('/pyqs/' + encodeURIComponent(id), null, {
        ttl: TTL_MS.detail,
        persist: true,
        force: !!opts.force,
      });
    },

    /**
     * Resolve a shared /pyq/<slug> URL to the paper.
     * 1) Prefer the additive Worker route (exact, KV-cached).
     * 2) If it is unavailable (404/400 from an older deploy), fall back to a
     *    single title-derived search and re-derive canonical slugs locally.
     * Resolves to a mapped index item { id, title, course, ... } or null.
     */
    async resolveSlug(slug, opts = {}) {
      const target = String(slug || '').trim();
      if (!target) return null;
      try {
        const res = await withCache('/pyqs/slug/' + encodeURIComponent(target), null, {
          ttl: TTL_MS.slug,
          signal: opts.signal,
          allowStaleOnNetworkError: false,
        });
        const item = res && res.data;
        if (item && item.id) return item;
      } catch (err) {
        const networkDown = !(err && (err.status === 404 || err.status === 400));
        if (networkDown) {
          // Still try the offline cache of this exact lookup before search fallback.
          const cached = cacheGet(keyFor('/pyqs/slug/' + encodeURIComponent(target), null), TTL_MS.slug * 40);
          if (cached && cached.value && cached.value.id) return cached.value;
        }
      }
      try {
        const q = slugToQuery(target);
        if (!q) return null;
        const res = await api.search({ q, page: 1, limit: 50 }, { signal: opts.signal });
        const items = (res && res.data && res.data.items) || [];
        return fallbackMatchForSlug(target, items);
      } catch {
        return null;
      }
    },

    /**
     * Related papers — mirrors the website's paper.html rail: one
     * course-filtered popular search, self excluded client-side, same
     * semester prioritised. (Empty course → most popular overall, like the
     * site's fallback.) Cached; no extra request per card.
     */
    related(item, opts = {}) {
      const params = buildSearchParams({
        course: item.course || '',
        page: 1,
        limit: 12,
        sort: 'popular',
      });
      return withCache('/pyqs/search', params, { ttl: TTL_MS.search, signal: opts.signal })
        .then((res) => {
          let items = ((res && res.data && res.data.items) || []).filter((x) => x && x.id !== item.id);
          if (item.semester) {
            const sem = String(item.semester).toLowerCase();
            items = [...items].sort((a, b) => {
              const aSem = String(a.semester || '').toLowerCase() === sem ? 0 : 1;
              const bSem = String(b.semester || '').toLowerCase() === sem ? 0 : 1;
              return aSem - bSem || (b.views || 0) - (a.views || 0);
            });
          }
          return { data: items.slice(0, 6), stale: res.stale };
        });
    },

    /** Clear all cached API data (Profile → settings action). */
    clearCache() {
      memory.clear();
      if (storage) {
        const doomed = [];
        for (let i = 0; i < storage.length; i++) {
          const k = storage.key(i);
          if (k && k.startsWith(PERSIST_PREFIX)) doomed.push(k);
        }
        for (const k of doomed) {
          try { storage.removeItem(k); } catch { /* ignore */ }
        }
      }
    },
  };

  return api;
}
