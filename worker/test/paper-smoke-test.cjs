/**
 * paper.js smoke test: loads paper.html + script.js + paper.js in jsdom,
 * mocks the Worker API, and verifies the paper detail page renders.
 */
const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');

const ROOT = require('path').join(__dirname, '..', '..');
const html = fs.readFileSync(path.join(ROOT, 'paper.html'), 'utf8');
const script = fs.readFileSync(path.join(ROOT, 'script.js'), 'utf8');
const paper = fs.readFileSync(path.join(ROOT, 'paper.js'), 'utf8');

const dom = new JSDOM(html, {
  url: 'http://localhost:8000/paper.html?id=pyq_42',
  runScripts: 'outside-only',
  pretendToBeVisual: true,
});
const { window } = dom;
window.DSMNRU_API_URL = 'https://dsmnru-pyq-api.kush210431-cloudflare.workers.dev';
window.matchMedia = window.matchMedia || (() => ({ matches: true, addListener() {}, removeListener() {} }));
window.scrollTo = () => {};
window.confirm = () => true;

const paperDoc = {
  id: 'pyq_42',
  title: 'B.Tech 3rd Sem DBMS {2024-25}',
  file: 'https://archive.org/download/test/paper_42.pdf',
  file2: 'https://catbox.moe/paper_42.pdf',
  course: 'B.Tech',
  semester: '3rd',
  session: '2024-25',
  branch: '',
  subject: 'DBMS',
  views: 123,
  createdAt: '2025-01-15T00:00:00Z',
};

const related = [];
for (let i = 0; i < 8; i++) {
  related.push({ id: `pyq_${i}`, title: `B.Tech 3rd Sem Subject ${i} {2024-25}`, course: 'B.Tech', semester: '3rd', session: '2024-25', views: i * 5 });
}

window.fetch = async (url) => {
  const u = new URL(url, 'http://localhost:8000');
  if (u.pathname === '/api/pyqs/pyq_42') {
    return new Response(JSON.stringify(paperDoc), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  if (u.pathname === '/api/pyqs/search') {
    return new Response(JSON.stringify({ items: related, total: related.length, page: 1, limit: 12, totalPages: 1 }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  return new Response(JSON.stringify({ error: 'not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
};

window.firebase = {
  initializeApp() {},
  firestore() {
    return {
      enablePersistence() { return Promise.resolve(); },
      collection(name) {
        return {
          doc(id) {
            return {
              get() { return Promise.resolve({ exists: false }); },
              set() { return Promise.resolve(); },
              collection() { return { orderBy() { return { limit() { return { get() { return Promise.resolve({ empty: true, docs: [] }); } }; } }; }, limit() { return { get() { return Promise.resolve({ empty: true, docs: [] }); } }; }, add() { return Promise.resolve(); } }; },
            };
          },
          where() { return this; },
          orderBy() { return this; },
          limit() { return { get() { return Promise.resolve({ empty: true, docs: [] }); } }; },
          add() { return Promise.resolve(); },
          get() { return Promise.resolve({ docs: [], empty: true }); },
        };
      },
      runTransaction() { return Promise.resolve(false); },
    };
  },
  auth() {
    return { onAuthStateChanged() {}, currentUser: null };
  },
  apps: [],
};
window.firebase.firestore.FieldValue = { serverTimestamp: () => new Date(), increment: (n) => n };

window.bootstrap = {
  Modal: class { constructor() { this._isShown = false; } show() { this._isShown = true; } hide() { this._isShown = false; } getOrCreateInstance() { return new window.bootstrap.Modal(); } static getInstance() { return null; } },
  getOrCreateInstance() { return new window.bootstrap.Modal(); },
};
window.Swal = { fire: () => Promise.resolve({ isConfirmed: true }) };
window.navigator.share = undefined;

let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name} ${detail}`); }
}

(async () => {
  console.log('\n🧪 paper.js smoke test\n');
  try {
    window.eval(script);
    window.eval(paper);
    check('script.js + paper.js execute without throwing', true);
  } catch (err) {
    check('script.js + paper.js execute without throwing', false, err.message);
    console.log(err.stack);
  }

  await new Promise((r) => setTimeout(r, 500));

  const title = window.document.getElementById('paperTitle');
  check('paper title rendered', title && title.textContent.includes('DBMS'), title && title.textContent);
  const content = window.document.getElementById('paperContent');
  check('paper content visible', content && content.style.display === 'block');
  const relatedCards = window.document.querySelectorAll('#relatedGrid .related-card');
  check('related papers rendered', relatedCards.length > 0, `found ${relatedCards.length}`);
  const pills = window.document.querySelectorAll('#paperMetaRow .meta-pill');
  check('meta pills rendered', pills.length >= 3, `found ${pills.length}`);

  console.log(`\nResults: ${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})();
