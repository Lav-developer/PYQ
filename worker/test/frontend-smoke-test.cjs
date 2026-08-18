/**
 * Frontend smoke test: loads index.html + script.js in jsdom with mocked
 * Firebase, fetch, and bootstrap, then verifies the page initializes and the
 * API client functions are callable without throwing.
 */
const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');

const ROOT = require('path').join(__dirname, '..', '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const script = fs.readFileSync(path.join(ROOT, 'script.js'), 'utf8');

const dom = new JSDOM(html, {
  url: 'http://localhost:8000/index.html',
  runScripts: 'outside-only',
  pretendToBeVisual: true,
});

const { window } = dom;

// Minimal browser stubs
window.matchMedia = window.matchMedia || (() => ({ matches: false, addListener() {}, removeListener() {} }));
window.scrollTo = () => {};

// Mock fetch: route /api/* to an in-memory API
const mockPyqs = [];
for (let i = 0; i < 311; i++) {
  mockPyqs.push({
    id: `pyq_${i}`,
    title: `B.Tech 3rd Sem Subject ${i % 10} {2024-25}`,
    course: 'B.Tech',
    semester: '3rd',
    session: '2024-25',
    branch: '',
    subject: `Subject ${i % 10}`,
    year: 2024,
    views: i,
  });
}
const mockContributors = [{ id: 'c1', name: 'Aarav Sharma', avatar: 'AS', role: 'PYQs Provider' }];

window.fetch = async (url, init) => {
  const u = new URL(url, 'http://localhost:8000');
  if (u.pathname === '/api/pyqs' || u.pathname === '/api/pyqs/search') {
    const limit = parseInt(u.searchParams.get('limit') || '20', 10);
    const page = parseInt(u.searchParams.get('page') || '1', 10);
    const q = (u.searchParams.get('q') || '').toLowerCase();
    let items = mockPyqs;
    if (q) items = items.filter((p) => p.title.toLowerCase().includes(q) || p.subject.toLowerCase().includes(q));
    const start = (page - 1) * limit;
    return new Response(JSON.stringify({
      items: items.slice(start, start + limit),
      total: items.length,
      page,
      limit,
      totalPages: Math.ceil(items.length / limit),
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

// Mock Firebase (compat SDK surface used by script.js)
window.firebase = {
  initializeApp() {},
  firestore() {
    return {
      enablePersistence() { return Promise.resolve(); },
      collection(name) {
        const handlers = {};
        return {
          doc(id) {
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
  auth() {
    return {
      onAuthStateChanged() {},
      signInWithEmailAndPassword() { return Promise.reject(new Error('no-op')); },
      currentUser: null,
    };
  },
  apps: [],
  firestore_FieldValue: undefined,
};
window.firebase.firestore.FieldValue = {
  serverTimestamp: () => new Date(),
  increment: (n) => n,
};

// Bootstrap mock
window.bootstrap = {
  Modal: class { constructor() {} show() {} hide() {} getOrCreateInstance() { return new window.bootstrap.Modal(); } static getInstance() { return null; } },
  getOrCreateInstance() { return new window.bootstrap.Modal(); },
};

// SweetAlert stub
window.Swal = { fire: () => Promise.resolve({ isConfirmed: true }) };

let pass = 0;
let fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name} ${detail}`); }
}

(async () => {
  console.log('\n🧪 Frontend smoke test (jsdom + mocked Firebase/fetch)\n');

  // Execute script.js in the window context
  try {
    window.eval(script);
    check('script.js executes without throwing', true);
  } catch (err) {
    check('script.js executes without throwing', false, err.message);
    console.log('ERROR:', err.stack);
  }

  // Let DOMContentLoaded handlers run
  await new Promise((r) => setTimeout(r, 300));

  check('apiGet defined', typeof window.apiGet === 'function');
  check('searchPyqs defined', typeof window.searchPyqs === 'function');
  check('fetchPyqsPage defined', typeof window.fetchPyqsPage === 'function');
  check('performSearch defined', typeof window.performSearch === 'function');

  // Bridge: expose top-level const helpers for testing
  window.eval('window.__api = { apiGet, searchPyqs, fetchPyqsPage, fetchPyqsPageCached };');

  // Test fetchPyqsPage via the mocked fetch
  const data = await window.__api.fetchPyqsPage(1, 20, "newest");
  check('fetchPyqsPage returns 20 items', data && data.items.length === 20, `got ${data && data.items.length}`);
  check('fetchPyqsPage total=311', data && data.total === 311);

  // Test searchPyqs
  const searchRes = await window.__api.searchPyqs({ q: 'Subject 1', page: '1', limit: '20' });
  check('searchPyqs finds matches', searchRes && searchRes.total > 0, `total ${searchRes && searchRes.total}`);

  // Test the pyq list was rendered
  const pyqItems = window.document.querySelectorAll('#pyqList .pyq-item');
  check('PYQ list rendered', pyqItems.length > 0, `found ${pyqItems.length}`);

  console.log(`\nResults: ${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})();
