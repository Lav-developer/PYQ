/**
 * Tiered rate limiting for the Cloudflare Worker API.
 *
 * ── Why this replaced the KV counter ────────────────────────────────
 * The previous limiter performed `PYQ_CACHE.get()` + `PYQ_CACHE.put()` for
 * EVERY API request, including cheap public reads whose data was already in
 * the KV/HTTP cache. That unconditional PUT was by far the largest consumer of
 * the Workers KV free-tier daily PUT allowance (≈700–1000 PUTs/day, one per
 * request), so ordinary traffic could exhaust the quota and Cloudflare then
 * rejected further KV writes with HTTP 429.
 *
 * ── Tiers ───────────────────────────────────────────────────────────
 * Tier 1 — public read endpoints (`/api/pyqs`, `/api/pyqs/search`,
 *   `/api/pyqs/:id`, `/api/homepage`, `/api/stats`, `/api/contributors`,
 *   `/api/courses`, unknown paths):
 *   `checkRateLimit()` uses an isolate-local counter (a plain Map) and performs
 *   ZERO KV operations. 60 requests/minute per IP + endpoint is the same hard
 *   ceiling the old KV limiter enforced (`BURST_MAX`), so the maximum a single
 *   IP could consume is unchanged — only the accounting moved out of KV.
 *   The trade-off is deliberate: an isolate-local counter is approximate
 *   (each isolate keeps its own window), but the traffic it protects is served
 *   from cache, so abuse cannot amplify into Firestore reads. Nothing in this
 *   tier depends on KV write availability.
 *
 * Tier 2 — sensitive / expensive operations (`/api/notify`,
 *   `/api/invalidate`): `enforceDistributedRateLimit()` keeps the original
 *   KV-backed, cross-isolate counter with the original small ceilings. It is
 *   called *after* the Firebase admin token has been verified, so this tier
 *   only ever writes KV for authenticated admin traffic (a handful of writes
 *   per day) and unauthenticated floods cannot burn the PUT quota.
 *
 * ── Behavior when KV is unavailable / PUT quota exhausted ───────────
 *  - Tier 1 public traffic is unaffected (it never touches KV), and a flooded
 *    IP is still capped by the isolate-local ceiling — fail closed at that
 *    ceiling, never blanket fail-open.
 *  - Tier 2 falls back to the isolate-local counter with the SAME small
 *    ceiling and reports `degraded: true`, so `notify`/`invalidate` keep
 *    meaningful protection instead of silently allowing everything. Firebase
 *    admin-token verification and the 30 s per-admin notify cooldown are
 *    independent of KV and still apply.
 */

const WINDOW_MS = 60 * 1000;

/**
 * Tier-1 ceiling: requests per IP + endpoint per 60 s window, per isolate.
 * Equal to the previous limiter's hard burst ceiling (`BURST_MAX = 60`).
 */
export const PUBLIC_LIMIT = 60;

/**
 * Requests from one IP to a sensitive endpoint are also capped *before* auth
 * with the isolate-local counter (zero KV ops), so an unauthenticated flood
 * cannot cause a single KV write.
 */
export const SENSITIVE_LOCAL_LIMIT = 30;

/**
 * Tier-2 ceilings, KV-backed and shared across isolates. Unchanged from the
 * previous implementation (`NOTIFY` was 6/min; invalidate is admin-only and
 * triggers a full search-index rebuild, so it keeps a small ceiling too).
 * The two email review endpoints are admin-only (verified token) and each
 * call triggers real Resend sends, so they get a generous-but-bounded
 * ceiling that still allows bulk reviews. The PUBLIC email endpoint
 * (`/api/email/submission-received`) deliberately stays OUT of this map:
 * like public reads it is guarded only by the isolate-local Tier-1 counter,
 * because a KV write per unauthenticated request would hand floods the very
 * PUT-quota exhaustion this design removed.
 */
export const SENSITIVE_LIMITS = {
  notify: 6,
  invalidate: 10,
  emailapproved: 30,
  emailrejected: 30,
};

const KV_KEY_PREFIX = 'ratelimit:';
const KV_COUNTER_TTL_SECONDS = 120;

// Isolate-local counters. Bounded so a hostile IP spray cannot grow the map
// without limit; entries are keyed by window and expired ones are pruned.
const MAX_LOCAL_BUCKETS = 5000;
const localCounters = new Map();

function pruneLocalCounters(currentWindow) {
  if (localCounters.size <= MAX_LOCAL_BUCKETS) return;
  for (const [key, bucket] of localCounters) {
    if (bucket.window < currentWindow) localCounters.delete(key);
  }
  // Map iteration is insertion ordered: drop the oldest buckets first if the
  // store is still over budget (burst of many distinct IPs in one window).
  for (const key of localCounters.keys()) {
    if (localCounters.size <= MAX_LOCAL_BUCKETS) break;
    localCounters.delete(key);
  }
}

function bumpLocal(ip, endpoint, now = Date.now()) {
  const windowKey = Math.floor(now / WINDOW_MS);
  pruneLocalCounters(windowKey);

  const key = `${ip}|${endpoint}|${windowKey}`;
  let bucket = localCounters.get(key);
  if (!bucket) {
    bucket = { window: windowKey, count: 0 };
    localCounters.set(key, bucket);
  }
  bucket.count += 1;
  return { bucket, windowKey };
}

function verdict(bucket, max, windowKey, tier, degraded = false) {
  return {
    allowed: bucket.count <= max,
    remaining: Math.max(0, max - bucket.count),
    reset: (windowKey + 1) * WINDOW_MS,
    limit: max,
    tier,
    degraded,
  };
}

/**
 * Tier-1 guard. Always called once per request before routing.
 * NEVER performs a KV operation.
 */
export async function checkRateLimit(ip, endpoint) {
  const max = distributedLimitForEndpoint(endpoint) ? SENSITIVE_LOCAL_LIMIT : PUBLIC_LIMIT;
  const { bucket, windowKey } = bumpLocal(ip, endpoint);
  return verdict(bucket, max, windowKey, 'isolate');
}

/**
 * Tier-2 distributed limiter for sensitive/expensive endpoints.
 * Call this only after the caller has been authorized.
 */
export async function enforceDistributedRateLimit(ip, endpoint) {
  const max = distributedLimitForEndpoint(endpoint) || SENSITIVE_LOCAL_LIMIT;
  // Separate local namespace: the pre-auth guard above counts the same
  // requests under `endpoint`, so sharing a bucket would double-count them.
  const { bucket, windowKey } = bumpLocal(ip, `${endpoint}:distributed`);

  const remote = await bumpKVCounter(ip, endpoint, max, windowKey);
  if (!remote.ok) {
    // KV read failed or the PUT was rejected (daily quota exhausted). Keep
    // enforcing the same ceiling with the isolate-local counter rather than
    // failing open, and surface that the verdict is degraded.
    return verdict(bucket, max, windowKey, 'distributed', true);
  }

  return {
    allowed: remote.allowed,
    remaining: remote.remaining,
    reset: (windowKey + 1) * WINDOW_MS,
    limit: max,
    tier: 'distributed',
    degraded: false,
  };
}

async function bumpKVCounter(ip, endpoint, max, windowKey) {
  if (typeof PYQ_CACHE === 'undefined') return { ok: false };

  const key = `${KV_KEY_PREFIX}${ip}:${endpoint}:${windowKey}`;
  try {
    const current = await PYQ_CACHE.get(key, 'text');
    let count = current ? parseInt(current, 10) : 0;
    if (!Number.isFinite(count) || count < 0) count = 0;

    if (count >= max) {
      return { ok: true, allowed: false, remaining: 0 };
    }

    count += 1;
    await PYQ_CACHE.put(key, String(count), { expirationTtl: KV_COUNTER_TTL_SECONDS });
    return { ok: true, allowed: true, remaining: Math.max(0, max - count) };
  } catch (err) {
    console.warn(`Distributed rate limiter unavailable for ${endpoint}:`, err.message);
    return { ok: false };
  }
}

/**
 * Drop all isolate-local counters. Used by tests (and safe to call at any
 * time — the counters are cheap, self-expiring approximations).
 */
export function resetLocalRateLimitState() {
  localCounters.clear();
}

/**
 * KV-backed ceiling for an endpoint, or null when the endpoint is not in the
 * sensitive tier. Uses an explicit own-property check so an unexpected string
 * can never resolve to an inherited Object property.
 */
export function distributedLimitForEndpoint(endpoint) {
  return Object.prototype.hasOwnProperty.call(SENSITIVE_LIMITS, endpoint)
    ? SENSITIVE_LIMITS[endpoint]
    : null;
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
  if (path.startsWith('/api/notify')) return 'notify';
  if (path.startsWith('/api/invalidate')) return 'invalidate';
  if (path.startsWith('/api/email/submission-received')) return 'emailsubmission';
  if (path.startsWith('/api/email/approved')) return 'emailapproved';
  if (path.startsWith('/api/email/rejected')) return 'emailrejected';
  return 'other';
}
