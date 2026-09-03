/**
 * DSMNRU PYQ Android — slug + deep-link helpers (pure, DOM-free, unit-tested).
 *
 * `createSlug` mirrors the Worker's `worker/src/slug.js` implementation
 * exactly so the app can resolve a shared `/pyq/<slug>` URL even when the
 * additive `/api/pyqs/slug/:slug` endpoint is not (yet) deployed: it derives
 * the title from the slug's words, asks the existing search API for it, then
 * re-computes each candidate's canonical slug and keeps the exact match.
 */

/** Port of the Worker's createSlug — keep byte-for-byte in sync. */
export function createSlug(title) {
  return String(title || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 180);
}

/** Port of the Worker's isSafePyqSlug. */
export function isSafePyqSlug(slug) {
  return typeof slug === 'string'
    && slug.length > 0
    && slug.length <= 2200
    && /^[a-z0-9][a-z0-9_-]*$/i.test(slug);
}

/** Port of the Worker search index's normalizeForCompare (query matching). */
export function normalizeForCompare(str) {
  if (!str) return '';
  return String(str)
    .toLowerCase()
    .trim()
    .replace(/[\s\-_&(),.]+/g, '')
    .replace(/[^a-z0-9]/g, '');
}

const SITE_HOSTS = ['dsmnru-pyq.netlify.app', 'dsmnru-pyq.email'];

export function isSiteHost(host) {
  if (!host) return false;
  const lower = String(host).toLowerCase();
  return SITE_HOSTS.some((h) => lower === h || lower === 'www.' + h);
}

/**
 * Parse a deep-link URL opened from outside the app into an internal route.
 * Supported shapes (all produced by the live website):
 *   https://host/pyq/<slug>            → { view: 'paper', slug }
 *   https://host/paper.html?id=<id>    → { view: 'paper', id }
 *   https://host/#/search?q=...        → { view: 'search', q }
 *   https://host/                      → { view: 'home' }
 * Anything else (or a foreign host) returns null → callers keep the link external.
 */
export function parseSiteUrl(href) {
  let url;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || !isSiteHost(url.hostname)) return null;

  const path = url.pathname || '/';

  const pyqMatch = path.match(/^\/pyq\/([^/]+)\/?$/);
  if (pyqMatch) {
    let slug = pyqMatch[1];
    try { slug = decodeURIComponent(slug); } catch { /* keep raw */ }
    if (!isSafePyqSlug(slug)) return null;
    return { view: 'paper', slug, id: '', q: '' };
  }

  if (path === '/paper.html' || path === '/paper') {
    const id = (url.searchParams.get('id') || '').trim();
    if (!id) return { view: 'home', slug: '', id: '', q: '' };
    return { view: 'paper', id, slug: '', q: '' };
  }

  const searchMatch = (url.hash || '').match(/^[#/]*search\?(.*)$/);
  if (searchMatch) {
    const params = new URLSearchParams(searchMatch[1]);
    const q = (params.get('q') || '').trim();
    return { view: q ? 'search' : 'home', q, slug: '', id: '' };
  }

  if (path === '/' || path === '/index.html') {
    return { view: 'home', slug: '', id: '', q: '' };
  }

  // Unknown site path: don't guess inside the app — caller opens it in a browser.
  return null;
}

/**
 * Best-effort client-side fallback for slug → paper matching when the Worker
 * does not yet serve GET /api/pyqs/slug/:slug. `items` are search/list
 * responses ({ id, title, slug? }). Prefers the index item whose canonical
 * slug already equals the target, then re-derives a slug from the title.
 */
export function fallbackMatchForSlug(slug, items) {
  const target = String(slug || '').toLowerCase();
  if (!target) return null;
  const list = Array.isArray(items) ? items : [];

  for (const item of list) {
    if (item && item.slug && String(item.slug).toLowerCase() === target) return item;
  }
  // The index allocator appends "-<base64url(id)>" only on title collisions;
  // the base slug is always createSlug(title), so a re-derivation match is exact
  // whenever the base matches and no suffix was assigned to another document.
  for (const item of list) {
    if (item && createSlug(item.title || '') === target) return item;
  }
  return null;
}

/**
 * Turn a paper slug into the loosest useful search query: strip the numeric
 * collision suffix, split on '-', drop noise tokens, and keep the longest
 * words so the Worker's substring matching still works with a short query.
 */
export function slugToQuery(slug) {
  let base = String(slug || '').toLowerCase();
  // Strip ONLY a collision suffix: the final dash-separated segment is the
  // base64url id (>= 16 chars, no dash inside it). Everything else is title
  // words and must stay in the query.
  const lastDash = base.lastIndexOf('-');
  if (lastDash > 0 && base.length - lastDash - 1 >= 16 && !base.slice(lastDash + 1).includes('-')) {
    base = base.slice(0, lastDash);
  }
  const words = base.split('-').filter((w) => /^[a-z0-9]+$/.test(w) && w.length > 2);
  if (!words.length) return '';
  return words.slice(-6).join(' ').slice(0, 200);
}
