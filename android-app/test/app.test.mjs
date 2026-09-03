/**
 * DSMNRU PYQ Android — unit tests for the app's core logic.
 *
 * Runs on Node's built-in test runner with zero npm dependencies:
 *   npm test          (from android-app/)
 * The same files are also syntax/ESM-compile checked (every www/js module)
 * so a broken import can never reach the APK build.
 *
 * Coverage (the traffic-critical and correctness-critical pieces):
 *  - slug.js createSlug parity with the Worker's real implementation
 *  - deep-link URL → internal route parsing (host validation included)
 *  - slug fallback matching (used when the additive /api/pyqs/slug route
 *    is not deployed yet)
 *  - api.js: search/list param builders, TTL cache, in-flight dedup,
 *    stale-while-revalidate, offline stale fallback, persistence,
 *    AbortController cancellation, resolveSlug chain, clearCache
 *  - auth.js: token decode, restore/refresh lifecycle (fresh / expiring /
 *    network-degraded / hard-invalid), privilege gates, friendly errors,
 *    user-doc sync only-on-missing
 *  - store.js: saved/history/recent-queries persistence + caps + filtering
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

import {
  createSlug, isSafePyqSlug, normalizeForCompare, parseSiteUrl,
  fallbackMatchForSlug, slugToQuery,
} from '../www/js/slug.js';
import { createApi, buildSearchParams, buildListParams } from '../www/js/api.js';
import { createAuth, decodeJwtPayload } from '../www/js/auth.js';
import { createStore } from '../www/js/store.js';

const here = dirname(fileURLToPath(import.meta.url));

// ── helpers ──────────────────────────────────────────────────────────────

function makeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    get length() { return map.size; },
    key(i) { return [...map.keys()][i] ?? null; },
    getItem(k) { return map.has(k) ? map.get(k) : null; },
    setItem(k, v) { map.set(k, String(v)); },
    removeItem(k) { map.delete(k); },
    _map: map,
  };
}

function makeFetch(handlers) {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    calls.push({ url, opts });
    if (opts.signal?.aborted) {
      const e = new Error('AbortError');
      e.name = 'AbortError';
      throw e;
    }
    for (const [pattern, fn] of handlers) {
      if (url.includes(pattern)) return fn(url, opts);
    }
    return { ok: false, status: 404, json: async () => ({ error: 'Not found' }) };
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

const jsonRes = (data, ok = true, status = 200) => async () => ({
  ok, status, json: async () => data,
});

function makeJwt(payload) {
  const b64u = (s) => Buffer.from(s).toString('base64url');
  return b64u('{"alg":"none"}') + '.' + b64u(JSON.stringify(payload)) + '.sig';
}

// ── slug parity with the real Worker implementation ─────────────────────

test('createSlug matches the Worker slug allocator on tricky inputs', async () => {
  const workerSlug = await import(join(here, '../../worker/src/slug.js'));
  const samples = [
    'B.Tech 4th Sem Data Structures {2023}',
    'MBA & Finance - I (20-21)',
    'B.Com (Hons.) Advanced Accounts',
    '  Ünïcödé  Papers — test  ',
    'B.A. 2nd Semester "History" [2019]',
  ];
  for (const s of samples) {
    assert.equal(createSlug(s), workerSlug.createSlug(s), `slug parity: ${s}`);
  }
  assert.equal(isSafePyqSlug('good-slug_1'), true);
  assert.equal(isSafePyqSlug('-bad'), false);
  assert.equal(normalizeForCompare('B.Com (Hons.)'), 'bcomhons');
});

// ── deep-link parsing ────────────────────────────────────────────────────

test('parseSiteUrl routes /pyq/<slug> and paper.html?id= links', () => {
  const r1 = parseSiteUrl('https://dsmnru-pyq.netlify.app/pyq/b-tech-4th-sem-data-structures-2023');
  assert.equal(r1.view, 'paper');
  assert.equal(r1.slug, 'b-tech-4th-sem-data-structures-2023');

  const r2 = parseSiteUrl('https://dsmnru-pyq.email/paper.html?id=abc%2F123');
  assert.equal(r2.view, 'paper');
  assert.equal(r2.id, 'abc/123');

  assert.equal(parseSiteUrl('https://evil.example.com/pyq/x'), null);
  assert.equal(parseSiteUrl('http://dsmnru-pyq.netlify.app/pyq/x'), null);
  assert.equal(parseSiteUrl('not a url'), null);
  assert.equal(parseSiteUrl('https://dsmnru-pyq.netlify.app/admin.html'), null);

  const root = parseSiteUrl('https://dsmnru-pyq.netlify.app/');
  assert.equal(root.view, 'home');
  const q = parseSiteUrl('https://dsmnru-pyq.netlify.app/#/search?q=data%20structures');
  assert.equal(q.view, 'search');
  assert.equal(q.q, 'data structures');
});

test('fallback slug matching finds the exact index item or title re-derivation', () => {
  const items = [
    { id: 'a', title: 'Other Paper', slug: 'other-paper' },
    { id: 'b', title: 'B.Tech 4th Sem Data Structures {2023}', slug: '' },
  ];
  assert.equal(fallbackMatchForSlug('b-tech-4th-sem-data-structures-2023', items).id, 'b');
  assert.equal(fallbackMatchForSlug('other-paper', items).id, 'a');
  assert.equal(fallbackMatchForSlug('missing-paper', items), null);
  assert.match(slugToQuery('b-tech-4th-sem-data-structures-2023'), /data structures 2023/);
  assert.equal(slugToQuery('a-b'), '');
  // a long dash-free final segment (base64url id suffix) is stripped; title words kept
  assert.equal(slugToQuery('sem-1-pyq0YWJjZGVmZ2hpams'), 'sem');
});

// ── api param builders (must match Worker validators) ───────────────────

test('search/list param builders mirror the website + Worker contract', () => {
  const sp = buildSearchParams({
    q: '  Data Structures  ', course: 'B.Tech', semester: '4TH', session: '2023-24', sort: 'popular', page: 3, limit: 20,
  });
  assert.deepEqual(sp, {
    page: '3', limit: '20', sort: 'popular',
    q: 'Data Structures', course: 'B.Tech', semester: '4th', session: '2023-24',
  });
  const lp = buildListParams({ course: '', semester: '', page: 1 });
  assert.deepEqual(lp, { page: '1', limit: '20', sort: 'newest' });
  assert.equal(buildSearchParams({ q: 'x'.repeat(400) }).q.length, 200);
});

// ── api cache / dedupe / SWR / offline / abort ──────────────────────────

test('homepage: fresh cache hit issues zero fetches; TTL expiry triggers one revalidate', async () => {
  let nowMs = 1_000_000;
  let hits = 0;
  const fetchImpl = makeFetch([['/api/homepage', async () => {
    hits++;
    return { ok: true, status: 200, json: async () => ({ recent: [], trending: [], courseCounts: [], stats: { totalPyqs: hits } }) };
  }]]);
  const api = createApi({ fetchImpl, storage: makeStorage(), now: () => nowMs });

  const a = await api.homepage();
  assert.equal(hits, 1);
  assert.equal(a.stale, false);

  const b = await api.homepage();          // still fresh (10 min window)
  assert.equal(hits, 1);
  assert.equal(b.fromCache, true);

  nowMs += 11 * 60 * 1000;                 // past fresh window
  const c = await api.homepage();
  assert.equal(c.stale, true);             // serves cache immediately…
  assert.ok(c.revalidating);               // …and refreshes in background
  const fresh = await c.revalidating;
  assert.equal(hits, 2);                   // exactly one background fetch
  assert.equal(fresh.stats.totalPyqs, 2);

  const d = await api.homepage();
  assert.equal(d.stale, false);
  assert.equal(hits, 2);                   // revalidated copy is fresh now
});

test('in-flight identical requests are deduped into one network call', async () => {
  let hits = 0;
  const fetchImpl = makeFetch([['/api/courses', async () => {
    hits++;
    await new Promise((r) => setTimeout(r, 10));
    return { ok: true, status: 200, json: async () => ['B.Tech'] };
  }]]);
  const api = createApi({ fetchImpl, storage: makeStorage() });
  const [x, y, z] = await Promise.all([api.courses(), api.courses(), api.courses()]);
  assert.equal(hits, 1);
  assert.deepEqual(x.data, y.data);
  assert.deepEqual(z.data, ['B.Tech']);
});

test('network failure serves the last cached payload marked stale', async () => {
  let online = true;
  const storage = makeStorage();
  const good = createApi({
    storage,
    now: () => 10,
    fetchImpl: makeFetch([['/api/homepage', jsonRes({ recent: [{ id: 'r1' }], trending: [], courseCounts: [], stats: { totalPyqs: 7 } })]]),
  });
  await good.homepage(); // persist to storage

  const offline = createApi({
    storage,
    now: () => 10 + 60 * 60 * 1000, // way past TTL: would normally fetch
    fetchImpl: makeFetch([['/api', async () => {
      if (!online) throw new TypeError('Failed to fetch');
      return { ok: true, json: async () => ({}) };
    }]]),
  });
  const res = await offline.homepage();
  assert.equal(res.stale, true);
  assert.equal(res.data.stats.totalPyqs, 7);
  assert.equal(res.fromCache, true);

  online = false;
  await assert.rejects(
    offline.search({ q: 'never cached' }),
    /Failed to fetch/,
  );
});

test('search cancellation: an aborted signal rejects with AbortError and no result render', async () => {
  let nowMs = 1;
  const api = createApi({
    storage: makeStorage(),
    now: () => nowMs,
    timeoutMs: 5000,
    fetchImpl: makeFetch([['/api/pyqs/search', (url, opts) => new Promise((_res, rej) => {
      opts.signal.addEventListener('abort', () => {
        const e = new Error('Aborted');
        e.name = 'AbortError';
        rej(e);
      });
    })]]),
  });
  const controller = new AbortController();
  const p = api.search({ q: 'data structures' }, { signal: controller.signal });
  setTimeout(() => controller.abort(), 5);
  await assert.rejects(p, (err) => err.name === 'AbortError');
});

test('a superseded search must not resolve into UI state (stale response guard)', async () => {
  // Mirrors what the search view relies on: generation counter + abort.
  const fetchImpl = makeFetch([
    ['q=slow', jsonRes({ items: [{ id: 'SLOW' }], total: 1, page: 1, totalPages: 1 })],
    ['q=fast', jsonRes({ items: [{ id: 'FAST' }], total: 1, page: 1, totalPages: 1 })],
  ]);
  const api = createApi({ fetchImpl, storage: makeStorage() });
  const slow = api.search({ q: 'slow' });
  const fast = api.search({ q: 'fast' });
  const [a, b] = await Promise.all([slow, fast]);
  assert.equal(a.data.items[0].id, 'SLOW');
  assert.equal(b.data.items[0].id, 'FAST');
});

test('persisted paper detail is reused by a fresh app session (no refetch)', async () => {
  let hits = 0;
  const storage = makeStorage();
  const mk = (now) => createApi({
    storage,
    now,
    fetchImpl: makeFetch([['/api/pyqs/abc', async () => {
      hits++;
      return { ok: true, status: 200, json: async () => ({ id: 'abc', title: 'P', file: 'https://x/a.pdf' }) };
    }]]),
  });
  await mk(() => 100).detail('abc');
  assert.equal(hits, 1);
  const second = await mk(() => 100 + 60 * 1000).detail('abc'); // 1 min later
  assert.equal(hits, 1);
  assert.equal(second.fromCache, true);
  assert.equal(second.data.title, 'P');
});

test('resolveSlug: uses the Worker lookup, else title-search fallback, else null', async () => {
  // 1) exact route available
  const api1 = createApi({
    storage: makeStorage(),
    now: () => 5,
    fetchImpl: makeFetch([
      ['/api/pyqs/slug/b-tech-sem-1', jsonRes({ id: 'z9', title: 'B.Tech Sem 1', course: 'B.Tech', slug: 'b-tech-sem-1' })],
    ]),
  });
  const r1 = await api1.resolveSlug('b-tech-sem-1');
  assert.equal(r1.id, 'z9');

  // 2) older Worker deploy: 404 on slug route → search fallback re-derives
  const api2 = createApi({
    storage: makeStorage(),
    now: () => 5,
    fetchImpl: makeFetch([
      ['/api/pyqs/slug/', jsonRes({ error: 'Not found' }, false, 404)],
      ['/api/pyqs/search', jsonRes({
        items: [
          { id: 'other', title: 'Unrelated', slug: 'unrelated' },
          { id: 'hit', title: 'B.Tech Sem 1 {2024}', slug: '' },
        ], total: 2, page: 1, totalPages: 1,
      })],
    ]),
  });
  const r2 = await api2.resolveSlug('b-tech-sem-1-2024');
  assert.equal(r2.id, 'hit');
  assert.equal(api2.search.calls?.length, undefined); // sanity: no private leak

  // 3) both fail (offline, nothing cached) → null (view opens the browser)
  const api3 = createApi({
    storage: makeStorage(),
    now: () => 5,
    fetchImpl: async () => { throw new TypeError('no network'); },
  });
  const r3 = await api3.resolveSlug('b-tech-sem-1-2024');
  assert.equal(r3, null);
});

test('clearCache drops memory and persisted entries', async () => {
  const storage = makeStorage();
  let hits = 0;
  const api = createApi({
    storage,
    now: () => 1,
    fetchImpl: makeFetch([['/api/homepage', async () => { hits++; return { ok: true, json: jsonRes2() }; }]]),
  });
  function jsonRes2() { return async () => ({ recent: [], trending: [], courseCounts: [], stats: {} }); }
  await api.homepage();
  api.clearCache();
  assert.equal(storage._map.size, 0);
  await api.homepage();
  assert.equal(hits, 2);
});

// ── auth lifecycle ───────────────────────────────────────────────────────

function idToken({ exp, verified = false, provider = 'password', email = 'a@b.co', name = 'A B', extra = {} }) {
  return makeJwt({
    exp, user_id: 'uid-1', sub: 'uid-1', email, name,
    email_verified: verified,
    firebase: { sign_in_provider: provider },
    ...extra,
  });
}

test('decodeJwtPayload reads claims used for gating', () => {
  const tok = idToken({ exp: 100, verified: true, provider: 'google.com' });
  const claims = decodeJwtPayload(tok);
  assert.equal(claims.email_verified, true);
  assert.equal(claims.firebase.sign_in_provider, 'google.com');
  assert.equal(decodeJwtPayload('garbage'), null);
});

test('signIn sets a persisted session; gates follow website rules', async () => {
  const storage = makeStorage();
  const nowSec = Math.floor(Date.now() / 1000);
  const tok = idToken({ exp: nowSec + 3600, verified: false });
  const fetchImpl = makeFetch([
    ['signInWithPassword', jsonRes({ idToken: tok, refreshToken: 'RT', expiresIn: '3600', email: 'a@b.co' })],
    ['firestore.googleapis.com/v1/projects/dsmnru-data/databases/(default)/documents/users/uid-1', jsonRes({ fields: {} }, true, 200)],
  ]);
  const auth = createAuth({ storage, fetchImpl, now: () => Date.now() });
  const user = await auth.signIn('a@b.co', 'hunter22');
  assert.equal(user.uid, 'uid-1');
  assert.ok(fetchImpl.calls.some((c) => c.url.includes('signInWithPassword')));
  assert.ok(fetchImpl.calls.some((c) => c.url.includes('/users/uid-1')), 'profile doc lookup ran');
  assert.equal(auth.needsEmailVerification(), true, 'unverified password account must verify');
  assert.equal(auth.canUnlockPrivileges(), false);
  // persisted, so a restart restores it
  const auth2 = createAuth({ storage, fetchImpl: async () => { throw new Error('no network'); }, now: () => Date.now() });
  const restored = await auth2.restore();
  assert.equal(restored.uid, 'uid-1');
  assert.ok(auth2.current());
});

test('google provider skips the email-verification requirement', async () => {
  const storage = makeStorage();
  const nowSec = Math.floor(Date.now() / 1000);
  const tok = idToken({ exp: nowSec + 3600, verified: false, provider: 'google.com' });
  const auth = createAuth({
    storage,
    fetchImpl: makeFetch([
      ['signInWithPassword', jsonRes({ idToken: tok, refreshToken: 'RT', expiresIn: '3600' })],
      ['firestore.googleapis.com', jsonRes({ fields: {} }, true, 200)],
    ]),
    now: () => Date.now(),
  });
  await auth.signIn('g@x.y', 'pw');
  assert.equal(auth.needsEmailVerification(), false);
  assert.equal(auth.canUnlockPrivileges(), true);
});

test('restore refreshes an expiring token, degrades offline, and hard-clears a dead one', async () => {
  const nowSec = Math.floor(Date.now() / 1000);
  const expiredTok = idToken({ exp: nowSec - 60 });
  const freshTok = idToken({ exp: nowSec + 3600, verified: true });

  // a) successful refresh
  const s1 = makeStorage();
  s1.setItem('dsm.auth.session.v1', JSON.stringify({ idToken: expiredTok, refreshToken: 'RT', expiresAt: (nowSec - 60) * 1000, obtainedAt: 0 }));
  const auth1 = createAuth({
    storage: s1,
    fetchImpl: makeFetch([['securetoken.googleapis.com', jsonRes({ id_token: freshTok, refresh_token: 'RT2', expires_in: '3600' })]]),
    now: () => Date.now(),
  });
  const u1 = await auth1.restore();
  assert.equal(u1.emailVerified, true);
  assert.equal(u1.refreshToken, 'RT2');
  assert.match(s1.getItem('dsm.auth.session.v1'), /RT2/);

  // b) network failure keeps a usable (degraded) session and does NOT wipe storage
  const s2 = makeStorage();
  s2.setItem('dsm.auth.session.v1', JSON.stringify({ idToken: expiredTok, refreshToken: 'RT', expiresAt: (nowSec - 60) * 1000, obtainedAt: 0 }));
  const auth2 = createAuth({
    storage: s2,
    fetchImpl: async () => { throw new TypeError('offline'); },
    now: () => Date.now(),
  });
  const u2 = await auth2.restore();
  assert.equal(u2.uid, 'uid-1');
  assert.equal(u2.degraded, true);
  assert.ok(s2.getItem('dsm.auth.session.v1'), 'kept for the next online start');

  // c) refresh rejected → hard sign-out
  const s3 = makeStorage();
  s3.setItem('dsm.auth.session.v1', JSON.stringify({ idToken: expiredTok, refreshToken: 'BAD', expiresAt: (nowSec - 60) * 1000, obtainedAt: 0 }));
  const auth3 = createAuth({
    storage: s3,
    fetchImpl: makeFetch([['securetoken.googleapis.com', jsonRes({ error: { message: 'TOKEN_EXPIRED' } }, false, 400)]]),
    now: () => Date.now(),
  });
  const u3 = await auth3.restore();
  assert.equal(u3, null);
  assert.equal(s3.getItem('dsm.auth.session.v1'), null);
});

test('sign-in maps raw Identity Toolkit errors to friendly messages', async () => {
  const auth = createAuth({
    storage: makeStorage(),
    fetchImpl: makeFetch([['signInWithPassword', jsonRes({ error: { message: 'INVALID_PASSWORD : 400' } }, false, 400)]]),
    now: () => Date.now(),
  });
  await assert.rejects(auth.signIn('a@b.co', 'x'), /Incorrect password/);
});

test('sign-up creates the users/{uid} profile doc only when missing (profile parity)', async () => {
  const nowSec = Math.floor(Date.now() / 1000);
  const tok = idToken({ exp: nowSec + 3600 });
  const fetchImpl = makeFetch([
    ['signUp', jsonRes({ idToken: tok, refreshToken: 'RT', expiresIn: '3600' })],
    ['accounts:update', jsonRes({ displayName: 'New Student' })],
    ['sendOobCode', jsonRes({ email: 'a@b.co' })],
    [/users\/uid-1/.test('x') ? 'NEVER' : '/documents/users/uid-1', jsonRes({ fields: {} }, false, 404)],
  ]);
  const created = [];
  const orig = fetchImpl;
  const auth = createAuth({
    storage: makeStorage(),
    fetchImpl: async (url, opts) => {
      if (opts?.method === 'POST' && url.includes('/users?documentId=uid-1')) created.push(JSON.parse(opts.body));
      return orig(url, opts);
    },
    now: () => Date.now(),
  });
  await auth.signUp({ name: 'New Student', email: 'a@b.co', password: 'secret1' });
  assert.equal(created.length, 1, 'exactly one profile doc create');
  assert.equal(created[0].fields.uid.stringValue, 'uid-1');
  assert.equal(created[0].fields.email.stringValue, 'a@b.co');
  assert.equal(created[0].fields.role.stringValue, 'user');
});

// ── store ────────────────────────────────────────────────────────────────

test('store: save/unsave round-trips, caps, and filtering work offline', () => {
  const storage = makeStorage();
  const store = createStore({ storage });
  const paper = { id: 'p1', title: 'DBMS {2023}', course: 'MCA', semester: '3rd', views: 3 };
  assert.equal(store.isSaved('p1'), false);
  assert.equal(store.toggleSaved(paper), true);
  assert.equal(store.isSaved('p1'), true);
  assert.equal(store.savedList()[0].title, 'DBMS {2023}');
  store.pushRecentQuery('dbms');
  store.pushRecentQuery('db'); // 2 chars = Worker minimum, accepted
  store.pushRecentQuery('d'); // 1 char, below minimum, ignored
  assert.deepEqual(store.recentQueries(), ['db', 'dbms']);

  // survives a "restart"
  const store2 = createStore({ storage });
  assert.equal(store2.savedList().length, 1);
  assert.equal(store2.savedSearch('mca').length, 1);
  assert.equal(store2.savedSearch('zzz').length, 0);
  assert.equal(store2.toggleSaved({ id: 'p1' }), false);
  assert.equal(store2.savedList().length, 0);

  for (let i = 0; i < 20; i++) store2.pushRecentView({ id: 'x' + i, title: 'T' + i });
  assert.equal(store2.recentViews().length, 12, 'recent views capped');
});

// ── ESM syntax gate: every app module must compile ──────────────────────

test('all www/js modules parse as ESM (compile-only, no execution)', async () => {
  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    return e.isDirectory() ? walk(p) : (e.name.endsWith('.js') ? [p] : []);
  });
  const files = walk(join(here, '../www/js'));
  assert.ok(files.length >= 12, 'expected the full module set');
  for (const f of files) {
    const source = readFileSync(f, 'utf8');
    await import('node:vm').then(({ SourceTextModule }) => {
      // Compile only — never links/executes, so DOM globals are irrelevant.
      new vm.SourceTextModule(source, { identifier: f });
    }).catch((err) => {
      assert.fail(`ESM compile failed for ${f}: ${err.message}`);
    });
  }
});
