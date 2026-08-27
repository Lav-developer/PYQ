/**
 * Frontend smoke test: loads index.html + script.js in jsdom with mocked
 * Firebase, fetch, and bootstrap, then verifies the page initializes and the
 * API client functions are callable without throwing.
 *
 * Also verifies the production DSMNRU_API_URL contract: Worker origin + /api/...
 * and that search/filter leave the loading skeleton on every outcome.
 */
const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');

const ROOT = require('path').join(__dirname, '..', '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const script = fs.readFileSync(path.join(ROOT, 'script.js'), 'utf8');

const WORKER_ORIGIN = 'https://dsmnru-pyq-api.kush210431-cloudflare.workers.dev';

const dom = new JSDOM(html, {
  url: 'http://localhost:8000/index.html',
  runScripts: 'outside-only',
  pretendToBeVisual: true,
});

const { window } = dom;

// Production config (inline script is not run under outside-only)
window.DSMNRU_API_URL = WORKER_ORIGIN;

// Minimal browser stubs
window.matchMedia = window.matchMedia || (() => ({ matches: false, addListener() {}, removeListener() {} }));
window.scrollTo = () => {};

if (typeof window.AbortController === 'undefined') {
  window.AbortController = AbortController;
}
if (typeof window.URLSearchParams === 'undefined') {
  window.URLSearchParams = URLSearchParams;
}

const mockPyqs = [];
for (let i = 0; i < 311; i++) {
  mockPyqs.push({
    id: `pyq_${i}`,
    title: `B.Tech 3rd Sem Subject ${i % 10} {2024-25}`,
    course: i % 7 === 0 ? 'B.Com' : 'B.Tech',
    semester: '3rd',
    session: '2024-25',
    branch: '',
    subject: i % 11 === 0 ? 'Java' : `Subject ${i % 10}`,
    year: 2024,
    views: i,
    slug: `b-tech-3rd-sem-subject-${i}-2024-25--pyq-${i}`,
  });
}
const mockContributors = [{ id: 'c1', name: 'Aarav Sharma', avatar: 'AS', role: 'PYQs Provider' }];

const requestedUrls = [];
let forceSearchError = false;

function normalizeCompare(str) {
  return String(str || '').toLowerCase().trim().replace(/[\s\-_&(),.]+/g, '').replace(/[^a-z0-9]/g, '');
}

function filterMock(u) {
  const q = (u.searchParams.get('q') || '').toLowerCase();
  const course = u.searchParams.get('course') || '';
  const semester = u.searchParams.get('semester') || '';
  const session = u.searchParams.get('session') || '';
  let items = mockPyqs.slice();
  if (q) {
    const qn = normalizeCompare(q);
    items = items.filter((p) =>
      normalizeCompare(p.title).includes(qn) ||
      normalizeCompare(p.subject).includes(qn) ||
      normalizeCompare(p.course).includes(qn)
    );
  }
  if (course) {
    const cn = normalizeCompare(course);
    items = items.filter((p) => normalizeCompare(p.course).includes(cn) || normalizeCompare(p.title).includes(cn));
  }
  if (semester) {
    items = items.filter((p) => String(p.semester).toLowerCase() === semester.toLowerCase());
  }
  if (session) {
    items = items.filter((p) => String(p.session).toLowerCase().includes(session.toLowerCase()));
  }
  return items;
}

window.fetch = async (url) => {
  const u = new URL(url, 'http://localhost:8000');
  requestedUrls.push(u.href);
  const isWorkerApi = u.origin === WORKER_ORIGIN && u.pathname.startsWith('/api/');
  const isLocalApi = u.origin === 'http://localhost:8000' && u.pathname.startsWith('/api/');
  if (!isWorkerApi && !isLocalApi) {
    return new Response(JSON.stringify({ error: 'not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
  }
  if (u.pathname === '/api/pyqs' || u.pathname === '/api/pyqs/search') {
    if (forceSearchError && u.pathname === '/api/pyqs/search') {
      return new Response(JSON.stringify({ error: 'Internal server error' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }
    const q = u.searchParams.get('q') || '';
    if (u.pathname === '/api/pyqs/search' && q && q.length < 2) {
      return new Response(JSON.stringify({ error: 'Search query must be at least 2 characters' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }
    const limit = parseInt(u.searchParams.get('limit') || '20', 10);
    const page = parseInt(u.searchParams.get('page') || '1', 10);
    const items = filterMock(u);
    const start = (page - 1) * limit;
    return new Response(JSON.stringify({
      items: items.slice(start, start + limit),
      total: items.length,
      page,
      limit,
      totalPages: Math.max(1, Math.ceil(items.length / limit)),
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  if (u.pathname === '/api/contributors') {
    return new Response(JSON.stringify(mockContributors), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  if (u.pathname === '/api/homepage') {
    return new Response(JSON.stringify({
      recent: mockPyqs.slice(0, 6),
      trending: mockPyqs.slice(0, 6),
      courseCounts: [{ course: 'B.Tech', count: 311 }],
      stats: { totalPyqs: 311, totalCourses: 1 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  if (u.pathname === '/api/stats') {
    return new Response(JSON.stringify({ totalPyqs: 311, totalCourses: 1 }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  return new Response(JSON.stringify({ error: 'not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
};

window.firebase = {
  initializeApp() {},
  firestore() {
    return {
      enablePersistence() { return Promise.resolve(); },
      collection() {
        return {
          doc() {
            return {
              get() { return Promise.resolve({ exists: true, data: () => ({ name: 'Test' }) }); },
              set() { return Promise.resolve(); },
              delete() { return Promise.resolve(); },
            };
          },
          add() { return Promise.resolve({ id: 'x' }); },
          get() { return Promise.resolve({ docs: [], empty: true }); },
          where() { return this; },
          orderBy() { return this; },
          limit() { return this; },
          startAfter() { return this; },
        };
      },
      runTransaction() { return Promise.resolve(false); },
      batch() { return { delete() {}, commit() { return Promise.resolve(); } }; },
    };
  },
  _auth: null,
  auth() {
    if (!this._auth) {
      const self = this;
      this._auth = {
        onAuthStateChanged(cb) {
          window.__authListener = cb;
        },
        signInWithEmailAndPassword() { return Promise.reject(new Error('no-op')); },
        get currentUser() { return self._signedIn || null; },
      };
    }
    return this._auth;
  },
  apps: [],
  firestore_FieldValue: undefined,
};
window.firebase.firestore.FieldValue = {
  serverTimestamp: () => new Date(),
  increment: (n) => n,
};

class MockModal {
  constructor() { this._isShown = false; }
  show() { this._isShown = true; }
  hide() { this._isShown = false; }
}
MockModal.getOrCreateInstance = function() { return new MockModal(); };
MockModal.getInstance = function() { return null; };
window.bootstrap = {
  Modal: MockModal,
  getOrCreateInstance() { return new MockModal(); },
};

window.Swal = { fire: () => Promise.resolve({ isConfirmed: true }) };

let pass = 0;
let fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name} ${detail}`); }
}

function skeletonVisible() {
  return !!window.document.querySelector('#pyqList .loading-skeleton');
}

function renderedTitles() {
  return Array.from(window.document.querySelectorAll('#pyqList .pyq-item .pyq-title')).map((el) => el.textContent.trim());
}

(async () => {
  console.log('\n🧪 Frontend smoke test (jsdom + mocked Firebase/fetch)\n');

  try {
    window.eval(script);
    check('script.js executes without throwing', true);
  } catch (err) {
    check('script.js executes without throwing', false, err.message);
    console.log('ERROR:', err.stack);
  }

  await new Promise((r) => setTimeout(r, 300));

  check('apiGet defined', typeof window.apiGet === 'function');
  check('searchPyqs defined', typeof window.searchPyqs === 'function');
  check('fetchPyqsPage defined', typeof window.fetchPyqsPage === 'function');
  check('performSearch defined', typeof window.performSearch === 'function');

  window.eval('window.__api = { apiGet, searchPyqs, fetchPyqsPage, fetchPyqsPageCached };');

  check(
    'API_BASE_URL includes /api when DSMNRU_API_URL is the Worker origin',
    window.DSMNRU_RESOLVED_API_BASE === WORKER_ORIGIN + '/api',
    window.DSMNRU_RESOLVED_API_BASE
  );
  check('resolveApiBaseUrl empty → /api', window.resolveApiBaseUrl('') === '/api');
  check('resolveApiBaseUrl origin → origin/api', window.resolveApiBaseUrl(WORKER_ORIGIN) === WORKER_ORIGIN + '/api');
  check('resolveApiBaseUrl already /api is not doubled', window.resolveApiBaseUrl(WORKER_ORIGIN + '/api') === WORKER_ORIGIN + '/api');

  requestedUrls.length = 0;
  const data = await window.__api.fetchPyqsPage(1, 20, 'newest');
  check('fetchPyqsPage returns 20 items', data && data.items.length === 20, `got ${data && data.items.length}`);
  check('fetchPyqsPage total=311', data && data.total === 311);
  check(
    'fetchPyqsPage hits Worker /api/pyqs',
    requestedUrls.some((u) => u.startsWith(WORKER_ORIGIN + '/api/pyqs?')),
    requestedUrls.join(' | ')
  );
  check(
    'fetchPyqsPage does not hit /pyqs without /api',
    !requestedUrls.some((u) => u.includes('workers.dev/pyqs?') || u.endsWith('workers.dev/pyqs')),
    requestedUrls.join(' | ')
  );

  requestedUrls.length = 0;
  const searchRes = await window.__api.searchPyqs({ q: 'Subject 1', page: '1', limit: '20' });
  check('searchPyqs finds matches', searchRes && searchRes.total > 0, `total ${searchRes && searchRes.total}`);
  check(
    'searchPyqs hits Worker /api/pyqs/search',
    requestedUrls.some((u) => u.startsWith(WORKER_ORIGIN + '/api/pyqs/search?')),
    requestedUrls.join(' | ')
  );
  check(
    'searchPyqs does not hit /pyqs/search without /api',
    !requestedUrls.some((u) => u.includes('/pyqs/search') && !u.includes('/api/pyqs/search')),
    requestedUrls.join(' | ')
  );

  const pyqItems = window.document.querySelectorAll('#pyqList .pyq-item');
  check('PYQ list rendered', pyqItems.length > 0, `found ${pyqItems.length}`);
  check('list cards use additive canonical /pyq/<slug> links when supplied by the API',
    Array.from(window.document.querySelectorAll('#pyqList .pyq-title a, #pyqList .btn-preview'))
      .some((link) => /^\/pyq\/[a-z0-9_-]+$/i.test(link.getAttribute('href') || '')));
  check('detail link helper retains legacy paper.html?id fallback for an old index item',
    window.eval("getPyqDetailsUrl({ id: 'legacy_item', slug: '' })") === '/paper.html?id=legacy_item');
  check('initial load has no leftover skeleton', !skeletonVisible());

  const signedInUser = {
    uid: 'test-user',
    email: 'student@example.com',
    emailVerified: true,
    displayName: 'Test Student',
    providerData: [{ providerId: 'google.com' }],
    reload() { return Promise.resolve(); },
  };
  window.firebase._signedIn = signedInUser;
  check('auth listener captured', typeof window.__authListener === 'function');
  if (typeof window.__authListener === 'function') {
    window.__authListener(signedInUser);
  }
  await new Promise((r) => setTimeout(r, 50));

  async function runSearch(term, extra) {
    const input = window.document.getElementById('searchInput');
    input.value = term;
    if (extra && extra.course !== undefined) window.document.getElementById('filterCourse').value = extra.course;
    if (extra && extra.semester !== undefined) window.document.getElementById('filterYear').value = extra.semester;
    if (extra && extra.session !== undefined) window.document.getElementById('filterSession').value = extra.session;
    if (extra && extra.sort !== undefined) window.document.getElementById('sortBy').value = extra.sort;
    requestedUrls.length = 0;
    await window.performSearch();
    await new Promise((r) => setTimeout(r, 0));
  }

  await runSearch('B.Com');
  check('search B.Com: no skeleton', !skeletonVisible());
  check('search B.Com: results rendered', renderedTitles().length > 0, `got ${renderedTitles().length}`);
  check(
    'search B.Com: request used /api/pyqs/search',
    requestedUrls.some((u) => u.includes('/api/pyqs/search?')),
    requestedUrls.join(' | ')
  );

  await runSearch('Java');
  check('search Java: no skeleton', !skeletonVisible());
  check('search Java: results rendered', renderedTitles().length > 0, `got ${renderedTitles().length}`);

  await runSearch('zzzz-no-such-paper');
  check('empty search: no skeleton', !skeletonVisible());
  check('empty search: empty state shown', !!window.document.querySelector('#pyqList .empty-state'));

  await runSearch('', { course: 'B.Tech' });
  check('course filter: no skeleton', !skeletonVisible());
  check('course filter: results rendered', renderedTitles().length > 0, `got ${renderedTitles().length}`);

  await runSearch('', { course: '', semester: '3rd' });
  check('semester filter: no skeleton', !skeletonVisible());
  check('semester filter: results rendered', renderedTitles().length > 0, `got ${renderedTitles().length}`);

  await runSearch('', { semester: '', session: '2024-25' });
  check('session filter: no skeleton', !skeletonVisible());
  check('session filter: results rendered', renderedTitles().length > 0, `got ${renderedTitles().length}`);

  await runSearch('Java', { sort: 'popular' });
  check('sort popular + search: no skeleton', !skeletonVisible());

  await runSearch('Java', { sort: 'az' });
  check('sort A-Z + search: no skeleton', !skeletonVisible());

  await runSearch('Java', { sort: 'za' });
  check('sort Z-A + search: no skeleton', !skeletonVisible());

  await runSearch('Java', { sort: 'newest' });
  check('sort newest + search: no skeleton', !skeletonVisible());

  window.document.getElementById('filterCourse').value = '';
  window.document.getElementById('filterYear').value = '';
  window.document.getElementById('filterSession').value = '';
  window.document.getElementById('searchInput').value = '';
  window.document.getElementById('sortBy').value = 'newest';
  await window.performSearch();
  check('clear filters: no skeleton', !skeletonVisible());
  check('clear filters: browse results shown', renderedTitles().length > 0, `got ${renderedTitles().length}`);

  await runSearch('Java');
  await runSearch('B.Com');
  check('successive searches: no skeleton', !skeletonVisible());
  check('successive searches: latest query rendered', renderedTitles().length > 0, `got ${renderedTitles().length}`);

  forceSearchError = true;
  await runSearch('Java');
  forceSearchError = false;
  check('API error: no skeleton', !skeletonVisible());
  check('API error: empty/error state shown', !!window.document.querySelector('#pyqList .empty-state'));

  console.log(`\nResults: ${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})();
