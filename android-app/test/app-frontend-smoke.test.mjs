/**
 * DSMNRU PYQ Android — jsdom integration smoke test for the dedicated app UI.
 *
 * Loads the REAL app shell (www/index.html + www/js/app.js) inside jsdom,
 * stubs the Worker/Firebase network, and walks the user-visible flows:
 * boot → home sections → gated course browse (anonymous) → sign-in sheet →
 * search executes → paper detail opens → actions (external open, save) →
 * Saved tab → offline-safe re-render.
 *
 * Skips gracefully when jsdom is unavailable (it is provided by
 * worker/node_modules or CI `npm i jsdom`; see the android-apk workflow).
 * Run: npm test  (from android-app/)
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
    test('app frontend smoke (skipped: jsdom not installed)', { skip: true }, () => {});
  }
}

const HOME = {
  recent: [{ id: 'p1', title: 'Data Structures {2023}', course: 'B.Tech', semester: '4th', session: '2023-24', branch: '', subject: 'DS', year: 2023, views: 12, slug: 'data-structures-2023' }],
  trending: [{ id: 'p2', title: 'DBMS {2022}', course: 'B.Tech', semester: '3rd', session: '2022-23', views: 99, slug: 'dbms-2022' }],
  courseCounts: [{ course: 'B.Tech', count: 5 }],
  stats: { totalPyqs: 5, totalCourses: 1 },
};
const PAPER = {
  id: 'p1', title: 'Data Structures {2023}', course: 'B.Tech', semester: '4th',
  session: '2023-24', branch: 'CSE', subject: 'DS', views: 13, year: 2023,
  file: 'https://files.catbox.moe/abcd12.pdf', file2: 'https://drive.google.com/x',
  seoSlug: 'data-structures-2023', createdAt: '2023-06-01T10:00:00Z',
};
const SEARCH = {
  items: [
    { id: 'p1', title: 'Data Structures {2023}', course: 'B.Tech', semester: '4th', session: '2023-24', views: 12, slug: 'data-structures-2023' },
    { id: 'p2', title: 'DBMS {2022}', course: 'B.Tech', semester: '3rd', session: '2022-23', views: 99, slug: 'dbms-2022' },
  ],
  total: 2, page: 1, limit: 20, totalPages: 1,
};
const CONTRIBUTORS = [
  { id: 'c1', name: 'Aarav Sharma', avatar: '', role: '12 papers' },
  { id: 'c2', name: 'Meera N.', avatar: '', role: '5 papers' },
];

function jwt(exp) {
  const b64u = (s) => Buffer.from(s).toString('base64url');
  return b64u('{"alg":"none"}') + '.' + b64u(JSON.stringify({
    exp, user_id: 'uid-9', sub: 'uid-9', email: 'stud@dsmnru.in', name: 'Test Student',
    email_verified: true, firebase: { sign_in_provider: 'password' },
  })) + '.s';
}

function setupDom() {
  const html = readFileSync(join(WWW, 'index.html'), 'utf8');
  const dom = new JSDOM(html, { url: 'https://localhost/' });
  const { window } = dom;
  window.Element.prototype.scrollTo = () => {};
  window.requestAnimationFrame = (fn) => setTimeout(() => fn(performance.now()), 0);
  window.cancelAnimationFrame = (id) => clearTimeout(id);
  const opened = [];
  window.open = (u) => { opened.push(String(u)); return null; };

  for (const key of ['window', 'document', 'navigator', 'location', 'localStorage', 'HTMLElement', 'Element', 'Node', 'Event', 'CustomEvent', 'MouseEvent', 'requestAnimationFrame', 'cancelAnimationFrame']) {
    try {
      Object.defineProperty(globalThis, key, { value: window[key], configurable: true, writable: true });
    } catch { /* node-owned globals (navigator) may resist — code paths guard with typeof */ }
  }

  const calls = [];
  const nowSec = Math.floor(Date.now() / 1000);
  const fetchImpl = async (url, opts = {}) => {
    calls.push({ url: String(url), opts });
    if (opts.signal?.aborted) { const e = new Error('AbortError'); e.name = 'AbortError'; throw e; }
    const u = String(url);
    const ok = (data) => ({ ok: true, status: 200, json: async () => data });
    if (u.includes('/api/homepage')) return ok(HOME);
    if (u.includes('/api/courses')) return ok(['B.Tech', 'B.Com']);
    if (u.includes('/api/pyqs/search')) return ok(SEARCH);
    if (u.includes('/api/pyqs/p1')) return ok(PAPER);
    if (u.includes('/api/pyqs?')) return ok(SEARCH);
    if (u.includes('/api/contributors')) return ok(CONTRIBUTORS);
    if (u.includes('api.gofile.io/servers')) return ok({ status: 'ok', data: { servers: [{ name: 'store1' }] } });
    if (u.includes('/pendingUploads')) return ok({});
    if (u.includes('signInWithPassword')) return ok({
      idToken: jwt(nowSec + 3600), refreshToken: 'RT', expiresIn: '3600', email: 'stud@dsmnru.in',
    });
    if (u.includes('accounts:signInWithIdp')) return ok({
      idToken: jwt(nowSec + 3600), refreshToken: 'RT-G', expiresIn: '3600',
      federatedId: '1089', providerId: 'google.com',
    });
    if (u.includes('accounts:update')) return ok({ displayName: 'Test Student' });
    if (u.includes('/documents')) return { ok: true, status: 200, json: async () => ({ fields: {} }) };
    return { ok: false, status: 404, json: async () => ({ error: 'mock: not mocked ' + u }) };
  };
  globalThis.fetch = fetchImpl;
  return { dom, window, calls, opened };
}

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

if (JSDOM) {
  test('dedicated app UI boots, gates, authenticates, searches and opens papers', async (t) => {
    const { window, calls, opened } = setupDom();
    t.after(() => { try { window.close(); } catch { /* already gone */ } });

    // Fresh device state
    window.localStorage.clear();

    await import(pathToFileURL(join(WWW, 'js/app.js')).href);
    assert.ok(await waitFor(() => document.getElementById('view').querySelector('.paper-card-title')), 'home data rendered');

    const view = () => document.getElementById('view');

    // ── Home ────────────────────────────────────────────────────────────
    assert.ok(view().querySelector('.hero'), 'brand hero present');
    assert.match(text(view().querySelector('#home-stats')), /5\s*papers/, 'stats from ONE homepage call');
    assert.match(text(view().querySelector('.paper-card-title')), /Data Structures/, 'recent paper card rendered');
    const homeCalls = calls.filter((c) => c.url.includes('/api/homepage')).length;
    assert.equal(homeCalls, 1, 'exactly one /api/homepage request for home');

    // ── Bottom nav → Courses (anonymous course pick is gated like the site) ─
    document.querySelector('.tab[data-tab="browse"]').click();
    assert.ok(await waitFor(() => view().querySelector('[data-course]')), 'course grid rendered');
    view().querySelector('[data-course]').click();
    assert.ok(await waitFor(() => document.querySelector('.sheet-root')), 'auth gate sheet opens for anonymous course browse');
    assert.match(text(document.querySelector('.sheet-root')), /Sign in|Course browsing/, 'gate explains itself');

    // ── Sign in through the sheet (email/password → same Firebase project) ──
    const sheet = document.querySelector('.sheet-root');
    sheet.querySelector('#auth-email').value = 'stud@dsmnru.in';
    sheet.querySelector('#auth-pass').value = 'hunter22';
    sheet.querySelector('form[data-form="login"] button[type="submit"]').click();
    assert.ok(await waitFor(() => !document.querySelector('.sheet-root')), 'sheet closes on sign-in');
    assert.ok(calls.some((c) => c.url.includes('signInWithPassword')), 'Identity Toolkit sign-in called');
    assert.ok(calls.some((c) => c.url.includes('/documents/users/uid-9')), 'user doc synced once (owner-scoped)');
    const firestoreDocCalls = calls.filter((c) => c.url.includes('/documents/')).length;
    assert.ok(firestoreDocCalls <= 2, 'no Firestore chatter beyond the one-time profile sync');

    // ── Search tab now executes through the Worker search endpoint ──────
    document.querySelector('.tab[data-tab="search"]').click();
    await waitFor(() => view().querySelector('#sq'), 'search view');
    const input = view().querySelector('#sq');
    input.value = 'data structures';
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
    assert.ok(await waitFor(() => view().querySelectorAll('[data-paper-id]').length >= 2), 'results rendered after debounce');
    const searchCalls = calls.filter((c) => c.url.includes('/api/pyqs/search'));
    assert.ok(searchCalls.length >= 1, 'search hit the Worker endpoint');
    assert.match(searchCalls[0].url, /q=data\+structures/, 'query carried to the API');

    // ── Open paper detail from a result card ───────────────────────────
    view().querySelector('[data-paper-id="p1"]').click();
    assert.ok(await waitFor(() => view().querySelector('.paper-hero')), 'paper hero rendered');
    assert.match(text(view().querySelector('.paper-hero')), /Data Structures/, 'title shown');
    assert.match(text(view()), /CSE/, 'branch shown');
    assert.match(text(view().querySelector('.meta-grid')), /2023-24/, 'session in meta table');
    const detailCalls = calls.filter((c) => /\/api\/pyqs\/p1(\?|$)/.test(c.url)).length;
    assert.equal(detailCalls, 1, 'one detail fetch');

    // ── PDF open → handed to the system (no in-app viewer, no storage copy) ─
    const viewBtn = view().querySelector('[data-act="view"]');
    assert.ok(viewBtn, 'Open PDF button present');
    viewBtn.click();
    assert.ok(await waitFor(() => opened.includes(PAPER.file)), 'external intent received the file URL');

    // ── Save → device store → Saved tab ────────────────────────────────
    view().querySelector('[data-act="save"]').click();
    document.querySelector('.tab[data-tab="saved"]').click();
    assert.ok(await waitFor(() => /1/.test(text(view().querySelector('#sv-meta')))), 'saved tab shows the bookmark');

    // ── Back navigation stack: Saved tab is root, opening a paper pushes ──
    view().querySelector('[data-paper-id="p1"]').click();
    await waitFor(() => view().querySelector('.paper-hero'), 'paper re-opened');
    document.getElementById('appbar-back').click();
    assert.ok(await waitFor(() => view().querySelector('#sv-list') !== null), 'back returns to Saved');

    // ── Deep-link fallback: /pyq/<slug> resolves via the slug route, else search ─
    const { fallbackMatchForSlug } = await import(pathToFileURL(join(WWW, 'js/slug.js')).href);
    assert.equal(fallbackMatchForSlug('data-structures-2023', SEARCH.items).id, 'p1');

    // ── Cache discipline: re-visiting Home immediately issues NO new homepage fetch ─
    const before = calls.length;
    document.querySelector('.tab[data-tab="home"]').click();
    await waitFor(() => view().querySelector('.hero'));
    const after = calls.filter((c) => c.url.includes('/api/homepage')).length;
    assert.equal(after, homeCalls, 'homepage cache prevented a refetch on revisit');
    assert.ok(calls.length - before <= 1, 'no request storm on navigation');

    // ════════════════════════════════════════════════════════════════════
    // v1.2 — self-contained-app features (drawer + new screens)
    // ════════════════════════════════════════════════════════════════════

    // Drawer opens from the app-bar menu (visible at every tab root).
    const openDrawer = async () => {
      assert.ok(await waitFor(() => !document.getElementById('appbar-menu').hidden), 'menu button visible at tab root');
      document.getElementById('appbar-menu').click();
      assert.ok(await waitFor(() => !document.getElementById('drawer-root').hidden), 'drawer opens');
    };

    // ── Drawer: opens from the app bar, contains the in-app destinations ─
    const menuBtn = document.getElementById('appbar-menu');
    assert.ok(menuBtn, 'app bar has a menu (drawer) button');
    await openDrawer();
    const drawerText = text(document.getElementById('drawer-root'));
    for (const item of ['Upload paper', 'Study tools', 'Contributors', 'Links', 'About this app']) {
      assert.ok(drawerText.includes(item), `drawer contains “${item}”`);
    }
    const openedBeforeDrawer = opened.length;

    // ── Drawer → Upload Paper: an IN-APP screen, not the website ─────────
    document.querySelector('#drawer-root [data-view="upload"]').click();
    assert.ok(await waitFor(() => view().querySelector('#up-form')), 'upload screen rendered from drawer');
    assert.equal(document.getElementById('drawer-root').classList.contains('is-open'), false, 'drawer closed after navigation');
    assert.equal(opened.length, openedBeforeDrawer, 'opening Upload never opens a browser');
    assert.match(text(view()), /10\s*points/, 'reward explanation rendered');

    // Validation errors render inside the app (no navigation, no fetches).
    const uploadCallsBefore = calls.length;
    view().querySelector('#up-submit').click();
    assert.ok(await waitFor(() => !view().querySelector('[data-err]').hidden), 'validation error shown');
    assert.match(text(view().querySelector('[data-err]')), /enter your name/i);
    assert.equal(calls.length, uploadCallsBefore, 'validation costs zero network');

    // Happy path: one PDF → gofile (mocked fetch + XHR) → one metadata insert.
    globalThis.XMLHttpRequest = class {
      constructor() {
        this.upload = { addEventListener() {} };
        this.listeners = {};
        this.status = 200;
        this.response = { status: 'ok', data: { downloadPage: 'https://store1.gofile.io/download/web/x/paper.pdf' } };
      }
      open() {}
      addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
      send() { setTimeout(() => { (this.listeners.load || []).forEach((fn) => fn()); }, 0); }
    };
    view().querySelector('#up-title').value = 'B.Tech DSA {2023}';
    view().querySelector('#up-name').value = 'Aarav Sharma';
    view().querySelector('#up-email').value = 'Aarav@Test.dev';
    const fileInput = view().querySelector('#up-file');
    Object.defineProperty(fileInput, 'files', {
      value: [new window.File(['%PDF-1.4 fake'], 'paper.pdf', { type: 'application/pdf' })],
      configurable: true,
    });
    fileInput.dispatchEvent(new window.Event('change', { bubbles: true }));
    assert.match(text(view().querySelector('#up-drop-text')), /paper\.pdf/, 'selected file shown in the picker card');
    view().querySelector('#up-submit').click();
    assert.ok(await waitFor(() => text(view()).includes('Submission received')), 'in-app success state');
    assert.match(text(view()), /pending review/i, 'moderation queue explained in-app');
    assert.ok(calls.some((c) => c.url.includes('/pendingUploads')), 'metadata written to the SAME Firestore queue');
    const uploads = calls.filter((c) => c.url.includes('/pendingUploads'));
    assert.equal(uploads.length, 1, 'exactly one metadata insert');
    assert.ok(window.localStorage.getItem('dsmnruUploadThrottle'), 'website-parity throttle recorded');

    // ── Drawer → Study Tools: fully on-device (no API traffic at all) ────
    document.querySelector('.tab[data-tab="home"]').click();
    await waitFor(() => view().querySelector('.hero'));
    await openDrawer();
    document.querySelector('#drawer-root [data-view="tools"]').click();
    assert.ok(await waitFor(() => view().querySelector('.tool-card')), 'tools screen rendered');
    const toolsCallsBefore = calls.length;
    const toolText = text(view());
    for (const t of ['CGPA calculator', 'Attendance tracker', 'Study planner']) {
      assert.ok(toolText.includes(t), `tools screen contains “${t}”`);
    }
    view().querySelectorAll('.tool-card button')[0].click(); // Open calculator
    assert.ok(await waitFor(() => document.querySelector('.sheet-root #cg-calc')), 'CGPA sheet opens in-app');
    document.querySelector('.sheet-root #cg-calc').click();
    assert.ok(await waitFor(() => document.querySelector('.sheet-root .tool-result-gpa')), 'SGPA computed on-device');
    assert.match(text(document.querySelector('.sheet-root .tool-result-gpa')), /10\.00/, 'O grade × 4 credits = 10.00');
    document.querySelector('.sheet-root [data-dismiss]').click();
    assert.equal(calls.length, toolsCallsBefore, 'study tools make ZERO network requests');

    // ── Drawer → Contributors: ONE cached Worker request ────────────────
    document.querySelector('.tab[data-tab="home"]').click();
    await waitFor(() => view().querySelector('.hero'));
    await openDrawer();
    document.querySelector('#drawer-root [data-view="contributors"]').click();
    assert.ok(await waitFor(() => view().querySelector('.contrib-card')), 'contributors rendered');
    assert.match(text(view()), /Aarav Sharma/, 'contributor name from /api/contributors');
    assert.match(text(view()), /Join them!/, 'join card routes to in-app upload');
    const contribCalls = calls.filter((c) => c.url.includes('/api/contributors')).length;
    assert.equal(contribCalls, 1, 'exactly one /api/contributors request');
    view().querySelector('.contrib-join').click();
    assert.ok(await waitFor(() => view().querySelector('#up-form')), 'join card opens the IN-APP upload screen');

    // Re-open contributors → still exactly one request (cache/SWR).
    document.querySelector('.tab[data-tab="home"]').click();
    await waitFor(() => view().querySelector('.hero'));
    await openDrawer();
    document.querySelector('#drawer-root [data-view="contributors"]').click();
    await waitFor(() => view().querySelector('.contrib-card'));
    assert.equal(calls.filter((c) => c.url.includes('/api/contributors')).length, 1, 'revisit costs zero traffic');

    // ── Drawer → Links: static in-app list; only the tapped portal is external ──
    document.querySelector('.tab[data-tab="home"]').click();
    await waitFor(() => view().querySelector('.hero'));
    await openDrawer();
    document.querySelector('#drawer-root [data-view="links"]').click();
    assert.ok(await waitFor(() => view().querySelector('.link-item')), 'links rendered in-app');
    assert.equal(view().querySelectorAll('.link-cat-head').length, 4, 'same four categories as the website');
    const openedBeforeLinks = opened.length;
    view().querySelector('.link-item[data-link-url]').click();
    assert.equal(opened.length, openedBeforeLinks + 1, 'tapping a portal opens exactly one external intent');
    assert.match(opened.at(-1), /^https:\/\/(dsmru|dsmnru|scholarship)/, 'external destination is the university portal itself');
    assert.ok(!opened.some((u) => u.includes('dsmnru-pyq.netlify.app')), 'links screen never opens the PYQ website');

    // ── Drawer → About: in-app screen with the external-destination audit ──
    document.querySelector('.tab[data-tab="home"]').click();
    await waitFor(() => view().querySelector('.hero'));
    await openDrawer();
    document.querySelector('#drawer-root [data-view="about"]').click();
    assert.ok(await waitFor(() => view().querySelector('.about-hero')), 'about screen rendered in-app');
    assert.match(text(view()), /Fully inside this app/, 'about lists what stays in-app');

    // ── Home shortcuts are in-app navigations now (no browser hand-off) ──
    document.querySelector('.tab[data-tab="home"]').click();
    await waitFor(() => view().querySelector('.hero'));
    const openedBeforeShortcuts = opened.length;
    assert.ok(await waitFor(() => view().querySelector('.shortcut[data-i="0"]')), 'in-app shortcuts rendered');
    view().querySelector('.shortcut[data-i="0"]').click(); // Upload a paper
    assert.ok(await waitFor(() => view().querySelector('#up-form')), 'home shortcut opens the in-app upload screen');
    assert.equal(opened.length, openedBeforeShortcuts, 'shortcuts never open the browser');

    // ── Google button without a native layer → in-app explainer, no website ──
    document.querySelector('.tab[data-tab="profile"]').click();
    await waitFor(() => view().querySelector('.profile-card'));
    const signOut = view().querySelector('[data-act="signout"]');
    if (signOut) {
      signOut.click();
      await waitFor(() => document.querySelector('.sheet-root [data-confirm]'));
      document.querySelector('.sheet-root [data-confirm]').click();
      await waitFor(() => view().querySelector('[data-act="google"]'));
    }
    view().querySelector('[data-act="google"]').click();
    assert.ok(await waitFor(() => {
      const sheet = document.querySelector('.sheet-root');
      return sheet && /Google sign-in/.test(text(sheet)) && /email/.test(text(sheet));
    }), 'google fallback sheet opens in-app');
    assert.ok(!/Open website to use Google/.test(text(document.querySelector('.sheet-root'))), 'NO website hand-off for Google');
  });
}
