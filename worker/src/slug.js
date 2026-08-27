/**
 * Deterministic URL helpers for public PYQ pages.
 *
 * `createSlug` deliberately contains no document-specific information. The
 * search index applies an ID suffix only when two public papers share the same
 * base slug; see `assignCanonicalSlugs` in search.js.
 */
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

/**
 * Encode an opaque Firestore document ID into a URL-segment-safe suffix.
 * Base64url is reversible and collision-free for a given ID, unlike trimming
 * or normalizing an ID into words. It is used only for duplicate base slugs.
 */
export function encodeSlugId(id) {
  const bytes = new TextEncoder().encode(String(id || ''));
  let binary = '';

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

/**
 * Public PYQ slugs are one URL path segment. This is intentionally broader
 * than `createSlug` because collision suffixes use base64url characters.
 */
export function isSafePyqSlug(slug) {
  return typeof slug === 'string'
    && slug.length > 0
    && slug.length <= 2200
    && /^[a-z0-9][a-z0-9_-]*$/i.test(slug);
}
