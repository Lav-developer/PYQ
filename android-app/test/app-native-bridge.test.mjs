/**
 * DSMNRU PYQ Android — jsdom integration test with a FAKE Capacitor bridge.
 *
 * Runs in its own node:test process, so the native.js module registry is
 * fresh and `window.Capacitor.Plugins.DsmnruApp` can be installed BEFORE the
 * app boots — exercising the real native code paths:
 *
 *  - "Open PDF"  → DsmnruApp.pdfView (in-app viewer screen) with the direct
 *                  host URL — no external intent, no Worker traffic;
 *  - PDF viewer failure → falls back to the SAME direct URL via the system
 *                  (openExternal), never the DSMNRU website;
 *  - Google sign-in → DsmnruApp.googleSignIn (device account chooser) →
 *                  Firebase accounts:signInWithIdp with the same nonce the
 *                  plugin saw → signed-in session flagged as a Google account;
 *  - GOOGLE_SIGNIN_NOT_CONFIGURED builds → in-app explainer with the
 *                  email/password path — NO website hand-off;
 *  - non-PDF "Server 2" (Drive landing page) → genuinely external intent.
 *
 * Skips gracefully when jsdom is unavailable (provided by worker/node_modules
 * in CI). Run: npm test  (from android-app/)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const WWW = join(here, '../www');

let JSDOM;
try {
  ({ JSDOM } = await import(pathToFileURL(join(here, '../../worker/node_modules/jsdom/lib/api.js')).href));
} catch {
  try {
    ({ JSDOM } = await import('jsdom'));
  } catch {
    test('native bridge smoke (skipped: jsdom not installed)', { skip: true }, () => {});
  }
}

const HOME = {
  recent: [], trending: [], courseCounts: [],
  stats: { totalPyqs: 1, totalCourses: 1 },
};
const PAPER = {
  id: 'p1', title: 'Data Structures {2023}', course: 'B.Tech', semester: '4th',
  session: '2023-24', branch: 'CSE', subject: 'DS', views: 13, year: 2023,
  file: 'https://files.catbox.moe/abcd12.pdf', file2: 'https://drive.google.com/x',
  seoSlug: 'data-structures-2023', createdAt: '2023-06-01T10:00:00Z',
};

function jwt(exp, provider) {
  const b64u = (s) => Buffer.from(s).toString('base64url');
  return b64u('{"alg":"none"}') + '.' + b64u(JSON.stringify({
    exp, user_id: 'g-uid-1', sub: 'g-uid-1', email: 'student@gmail.com', name: 'Google Student',
    email_verified: true, firebase: { sign_in_provider: provider },
  })) + '.s';
}

if (JSDOM) {
  test('native paths: in-app PDF viewer, Google credential sign-in, typed fallbacks', async (t) => {
    const html = readFileSync(join(WWW, 'index.html'), 'utf8');
    const dom = new JSDOM(html, { url: 'https://localhost/' });
    const { window } = dom;
    t.after(() => { try { window.close(); } catch { /* already gone */ } });
    window.Element.prototype.scrollTo = () => {};
    window.requestAnimationFrame = (fn) => setTimeout(() => fn(performance.now()), 0);
    window.cancelAnimationFrame = (id) => clearTimeout(id);
    const opened = [];
    window.open = (u) => { opened.push(String(u)); return null; };

    for (const key of ['window', 'document', 'navigator', 'location', 'localStorage', 'HTMLElement', 'Element', 'Node', 'Event', 'CustomEvent', 'MouseEvent', 'requestAnimationFrame', 'cancelAnimationFrame']) {
      try {
        Object.defineProperty(globalThis, key, { value: window[key], configurable: true, writable: true });
      } catch { /* node-owned globals resist — code guards with typeof */ }
    }
    window.localStorage.clear();

    // ── the fake native plugin (installed BEFORE app.js boots) ──────────
    const bridgeCalls = [];
    let googleResult = { idToken: 'GOOGLE_ID_TOKEN' };
    let pdfResult = { ok: true };
    const DsmnruApp = {
      async pdfView(opts) {
        bridgeCalls.push({ kind: 'pdfView', url: opts.url, title: opts.title });
        if (pdfResult && pdfResult.reject) throw new Error(pdfResult.reject);
        return pdfResult || {};
      },
      async googleSignIn(opts) {
        bridgeCalls.push({ kind: 'googleSignIn', nonce: opts && opts.nonce });
        if (googleResult && googleResult.err) throw new Error(googleResult.err);
        return googleResult || {};
      },
      async openExternal(opts) {
        bridgeCalls.push({ kind: 'openExternal', url: opts.url });
        return {};
      },
      async share() { return {}; },
      async download() { return {}; },
      async getLaunchUrl() { return { url: '' }; },
    };
    globalThis.Capacitor = { Plugins: { DsmnruApp } };

    const calls = [];
    const nowSec = Math.floor(Date.now() / 1000);
    const ok = (data) => ({ ok: true, status: 200, json: async () => data });
    const idpBodies = [];
    globalThis.fetch = async (url, opts = {}) => {
      calls.push({ url: String(url), opts });
      if (opts.signal?.aborted) { const e = new Error('AbortError'); e.name = 'AbortError'; throw e; }
      const u = String(url);
      if (u.includes('/api/homepage')) return ok(HOME);
      if (u.includes('/api/courses')) return ok(['B.Tech']);
      if (u.includes('/api/pyqs/p1')) return ok(PAPER);
      if (u.includes('/api/pyqs/search')) return ok({ items: [{ id: 'p1', title: PAPER.title, course: 'B.Tech', views: 12, slug: PAPER.seoSlug }], total: 1, page: 1, totalPages: 1 });
      if (u.includes('accounts:signInWithIdp')) {
        idpBodies.push(JSON.parse(opts.body));
        return ok({ idToken: jwt(nowSec + 3600, 'google.com'), refreshToken: 'RT-G', expiresIn: '3600', providerId: 'google.com' });
      }
      if (u.includes('/documents')) return { ok: true, status: 200, json: async () => ({ fields: {} }) };
      return { ok: false, status: 404, json: async () => ({ error: 'mock: not mocked ' + u }) };
    };

    await import(pathToFileURL(join(WWW, 'js/app.js')).href);
    const view = () => document.getElementById('view');
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    async function waitFor(fn, ms = 2500) {
      const t0 = Date.now();
      for (;;) {
        if (fn()) return true;
        if (Date.now() - t0 > ms) return false;
        await sleep(15);
      }
    }
    const text = (el) => (el ? el.textContent : '');

    assert.ok(await waitFor(() => view().querySelector('.hero')), 'app booted with the native bridge');

    // ── PDF gate mirrors the website policy for signed-out users ─────────
    document.querySelector('.tab[data-tab="search"]').click();
    await waitFor(() => view().querySelector('#sq'));
    const input = view().querySelector('#sq');
    input.value = 'data structures';
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
    assert.ok(await waitFor(() => view().querySelector('[data-paper-id="p1"]')), 'search result rendered');
    view().querySelector('[data-paper-id="p1"]').click();
    assert.ok(await waitFor(() => view().querySelector('.paper-hero')), 'paper screen rendered');

    const externalBefore = bridgeCalls.filter((c) => c.kind === 'openExternal').length;
    view().querySelector('[data-act="view"]').click();
    assert.ok(await waitFor(() => document.querySelector('.sheet-root #auth-email')), 'verified-sign-in gate opens the in-app auth sheet first');

    // ── Google: not configured → in-app explainer, no website hand-off ────
    googleResult = { err: 'GOOGLE_SIGNIN_NOT_CONFIGURED: no client id in this build' };
    document.querySelector('.sheet-root [data-act="google"]').click();
    assert.ok(await waitFor(() => {
      const sheet = document.querySelector('.sheet-root');
      return sheet && /Google sign-in/.test(text(sheet)) && /configured/.test(text(sheet));
    }), 'not-configured explainer shown');
    assert.ok(!/Open website/.test(text(document.querySelector('.sheet-root'))), 'never sends the user to the website');
    document.querySelector('.sheet-root [data-act="email"]').click();
    assert.ok(await waitFor(() => document.querySelector('.sheet-root #auth-email')), 'email/password path offered in-app');

    // ── Google sign-in: device chooser → Firebase → Google session ─────────
    googleResult = { idToken: 'GOOGLE_ID_TOKEN' };
    document.querySelector('.sheet-root [data-act="google"]').click();
    assert.ok(await waitFor(() => idpBodies.length === 1), 'Identity Toolkit signInWithIdp called');
    const seenNonce = bridgeCalls.filter((c) => c.kind === 'googleSignIn').at(-1).nonce;
    assert.ok(seenNonce && seenNonce.length >= 16, 'JS generated a nonce for the chooser');
    assert.match(idpBodies[0].postBody, new RegExp(`nonce=${seenNonce}`), 'the same nonce is replayed to Firebase');
    assert.match(idpBodies[0].postBody, /id_token=GOOGLE_ID_TOKEN/);
    assert.match(idpBodies[0].postBody, /providerId=google\.com/);

    // ── Signed in → Open PDF goes to the IN-APP viewer (pdfView bridge call) ──
    assert.ok(await waitFor(() => view().querySelector('.paper-hero [data-act="view"]')), 'paper re-rendered for the verified session');
    view().querySelector('[data-act="view"]').click();
    assert.ok(await waitFor(() => bridgeCalls.some((c) => c.kind === 'pdfView')), 'native viewer took over');
    const pdfCall = bridgeCalls.find((c) => c.kind === 'pdfView');
    assert.equal(pdfCall.url, PAPER.file, 'viewer got the DIRECT host URL (file field)');
    assert.match(pdfCall.title, /Data Structures/, 'viewer got the paper title');
    assert.equal(bridgeCalls.filter((c) => c.kind === 'openExternal').length, externalBefore, 'no external intent when the in-app viewer opens');
    assert.ok(!opened.length, 'no browser window either');

    // ── Viewer failure → same direct URL to the system, NEVER the website ──
    pdfResult = { ok: false, reject: 'PDF render failed' };
    view().querySelector('[data-act="server1"]').click();
    assert.ok(await waitFor(() => bridgeCalls.filter((c) => c.kind === 'openExternal').length === externalBefore + 1), 'fallback used the system viewer');
    const fallback = bridgeCalls.filter((c) => c.kind === 'openExternal').at(-1);
    assert.equal(fallback.url, PAPER.file, 'fallback keeps the same direct URL');

    // ── Non-PDF Server 2 (Drive landing page) → genuinely external intent ──
    view().querySelector('[data-act="server2"]').click();
    assert.ok(await waitFor(() => bridgeCalls.some((c) => c.kind === 'openExternal' && c.url === PAPER.file2)), 'Drive landing page opens externally (unavoidable destination)');

    // ── Profile reflects the SAME Firebase identity, flagged as Google ──────
    document.querySelector('.tab[data-tab="profile"]').click();
    assert.ok(await waitFor(() => {
      const card = view().querySelector('.profile-card');
      return card && /Google Student/.test(text(card)) && /Google account/.test(text(card));
    }), 'profile shows the same Firebase identity flagged as a Google account');
    assert.ok(calls.some((c) => c.url.includes('/documents/users/g-uid-1')), 'one-time users/{uid} sync ran');
    const firestoreCalls = calls.filter((c) => c.url.includes('firestore.googleapis.com')).length;
    assert.ok(firestoreCalls <= 2, 'no Firestore chatter beyond the profile sync');
  });
}
