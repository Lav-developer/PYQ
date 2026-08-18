/**
 * Lightweight rate limiter using Cloudflare KV.
 * Tracks request counts per IP per endpoint per minute window.
 */

const WINDOW_MS = 60 * 1000;
const MAX_REQUESTS_PER_WINDOW = 30;
const BURST_MAX = 60;

export async function checkRateLimit(ip, endpoint) {
  if (typeof PYQ_CACHE === 'undefined') {
    return { allowed: true, remaining: 999, reset: 0 };
  }

  const now = Date.now();
  const windowKey = Math.floor(now / WINDOW_MS);
  const key = `ratelimit:${ip}:${endpoint}:${windowKey}`;

  try {
    const current = await PYQ_CACHE.get(key, 'text');
    let count = current ? parseInt(current, 10) : 0;

    if (count >= MAX_REQUESTS_PER_WINDOW) {
      if (count < BURST_MAX) {
        count += 1;
        await PYQ_CACHE.put(key, String(count), { expirationTtl: 120 });
        return {
          allowed: true,
          remaining: Math.max(0, MAX_REQUESTS_PER_WINDOW - count),
          reset: (windowKey + 1) * WINDOW_MS,
        };
      }
      return {
        allowed: false,
        remaining: 0,
        reset: (windowKey + 1) * WINDOW_MS,
      };
    }

    count += 1;
    await PYQ_CACHE.put(key, String(count), { expirationTtl: 120 });

    return {
      allowed: true,
      remaining: Math.max(0, MAX_REQUESTS_PER_WINDOW - count),
      reset: (windowKey + 1) * WINDOW_MS,
    };
  } catch (err) {
    console.warn('Rate limiter error:', err.message);
    return { allowed: true, remaining: 1, reset: 0 };
  }
}

export function getClientIP(request) {
  const cfIP = request.headers.get('CF-Connecting-IP');
  if (cfIP) return cfIP;

  const xForwardedFor = request.headers.get('X-Forwarded-For');
  if (xForwardedFor) {
    return xForwardedFor.split(',')[0].trim();
  }

  return 'unknown';
}

export function normalizeEndpoint(url) {
  const path = new URL(url).pathname;
  if (path.startsWith('/api/pyqs/search')) return 'search';
  if (path.startsWith('/api/pyqs')) return 'pyqs';
  if (path.startsWith('/api/contributors')) return 'contributors';
  if (path.startsWith('/api/courses')) return 'courses';
  if (path.startsWith('/api/homepage')) return 'homepage';
  if (path.startsWith('/api/stats')) return 'stats';
  return 'other';
}
