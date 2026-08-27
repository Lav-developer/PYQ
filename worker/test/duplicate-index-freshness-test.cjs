/**
 * REGRESSION: an exactly-matching published PYQ must reach the duplicate
 * matcher and rank #1 at maximum confidence.
 *
 * Reported case:
 *   pending submission title : "B.Tech 1st Sem Sign Language 2024-25"
 *                              course: (empty)   semester: (empty)
 *   pyqs collection already  : "B.Tech 1st Sem Sign Language 2024-25"  (exact)
 *   Review Queue showed      : 2025-26 / 2nd Sem / Big Data / Web Technology /
 *                              Python Programming — but NOT the exact record.
 *
 * The Worker's /api/pyqs list is served from a KV search index that is
 * refreshed asynchronously after Firebase-token admin invalidation (or by the
 * 7-day hard TTL safety fallback). A newly published PYQ can therefore be
 * absent during the intentional stale-while-revalidate window, and because the
 * API answers 200 OK the duplicate matcher must still be able to fall back to
 * Firestore.
 *
 * Run: cd worker && node test/duplicate-index-freshness-test.cjs
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..', '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

let pass = 0;
let fail = 0;
function check(name, condition, detail = '') {
  if (condition) { pass += 1; console.log(`  ✅ ${name}`); }
  else { fail += 1; console.log(`  ❌ ${name} ${detail}`); }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ── the exact data from the bug report ───────────────────────────────
const EXACT_TITLE = 'B.Tech 1st Sem Sign Language 2024-25';
const DECOYS = [
  'B.Tech 1st Sem Sign Language 2025-26',
  'B.Tech 2nd Sem Sign Language 2025-26',
  'B.Tech 6th Sem Big Data 2024-25',
  'B.Tech 1st Sem Web Technology 2024-25',
  'B.Tech 1st Sem Python Programming 2024-25',
];

console.log('\n🧪 Duplicate index freshness + exact-title match\n');

// ── 1. matcher unit level: identical title, no course/semester ───────
console.log('1. Matcher: identical title with empty course/semester');
const sandbox = { globalThis: {} };
sandbox.window = sandbox.globalThis;
vm.createContext(sandbox);
vm.runInContext(read('duplicate-check.js'), sandbox);
const D = sandbox.globalThis.DSMNRUDuplicates;

const submission = { title: EXACT_TITLE, course: '', semester: '' };
const exactRecord = { id: 'exact1', title: EXACT_TITLE, course: 'B.Tech', semester: '1st' };
const score = D.scoreCandidate(submission, exactRecord);
check('identical normalized titles score 1.0', score.titleScore === 1, String(score.titleScore));
check('missing course/semester are not treated as mismatches',
  score.course === 'unknown' && score.semester === 'unknown', JSON.stringify(score));
check('an exact title match reaches maximum (100%) confidence',
  score.confidence === 1, `confidence=${score.confidence}`);

const ranked = D.findCandidates(
  submission,
  [{ id: 'exact1', title: EXACT_TITLE, course: 'B.Tech', semester: '1st' }]
    .concat(DECOYS.map((t, i) => ({ id: 'd' + i, title: t, course: 'B.Tech', semester: '1st' }))),
  { limit: 5 }
);
check('the exact record is candidate #1', ranked.length && ranked[0].pyq.id === 'exact1',
  ranked.map((r) => r.pyq.id).join(','));
check('the exact record outranks every near-miss',
  ranked.length > 1 && ranked[0].confidence > ranked[1].confidence,
  ranked.map((r) => `${r.pyq.id}:${r.confidence.toFixed(2)}`).join(' '));
check('near-misses still appear below it (nothing is hidden)',
  ranked.length === 5 && ranked.slice(1).some((r) => /2025-26/.test(r.pyq.title)));

// ── 2. admin integration with a STALE Worker API ─────────────────────
(async () => {
  console.log('\n2. Admin integration: stale /api/pyqs must not hide the record');

  const ts = (d = new Date()) => ({ toDate: () => d, toMillis: () => d.getTime() });
  const store = {
    pendingUploads: {
      sub1: {
        title: EXACT_TITLE, course: '', semester: '',
        studentName: 'Rahul', studentEmail: 'rahul@gmail.com', fileName: 'sl.pdf',
        downloadUrl: 'https://gofile.io/d/XYZ', uploadedAt: ts(), status: 'pending',
      },
    },
    // Firestore is the source of truth and DOES contain the exact record.
    pyqs: Object.assign(
      { exact1: { title: EXACT_TITLE, course: 'B.Tech', semester: '1st', session: '2024-25' } },
      ...DECOYS.map((t, i) => ({ ['d' + i]: { title: t, course: 'B.Tech', semester: '1st' } }))
    ),
  };
  const reads = {};
  const bump = (c) => { reads[c] = (reads[c] || 0) + 1; };

  const snap = (id, data) => ({ id, exists: !!data, data: () => (data ? { ...data } : undefined) });
  const docRef = (c, id) => ({
    id,
    async get() { bump(c); return snap(id, store[c] && store[c][id]); },
    async set(d, o) { store[c][id] = o && o.merge ? { ...store[c][id], ...d } : { ...d }; },
    async update(p) { store[c][id] = { ...store[c][id], ...p }; },
    async delete() { delete store[c][id]; },
  });
  const queryApi = (c, filters, limitN) => ({
    where(f, op, v) { return queryApi(c, [...filters, { f, op, v }], limitN); },
    orderBy() { return this; },
    limit(n) { return queryApi(c, filters, n); },
    async get() {
      bump(c);
      let ids = Object.keys(store[c] || {});
      filters.forEach((flt) => { ids = ids.filter((id) => store[c][id][flt.f] === flt.v); });
      if (limitN) ids = ids.slice(0, limitN);
      return { docs: ids.map((id) => snap(id, { ...store[c][id] })), empty: ids.length === 0 };
    },
  });
  const db = {
    enablePersistence: () => Promise.resolve(),
    collection: (c) => Object.assign({
      doc: (id) => docRef(c, id),
      async add(d) { const id = 'a' + Math.random().toString(36).slice(2, 8); store[c] = store[c] || {}; store[c][id] = d; return { id }; },
    }, queryApi(c, [], null)),
    async runTransaction(fn) {
      return fn({ get: (r) => r.get(), set: (r, d, o) => r.set(d, o), update: (r, p) => r.update(p), delete: (r) => r.delete() });
    },
    batch: () => ({ set() {}, update() {}, delete() {}, commit: () => Promise.resolve() }),
  };
  db.FieldValue = { serverTimestamp: () => ts(), increment: (n) => n };

  // The Worker answers 200 OK with a STALE list that omits the exact record —
  // exactly what happens when its KV index predates the publish.
  const apiCalls = [];
  const staleApiItems = DECOYS.map((t, i) => ({ id: 'd' + i, title: t, course: 'B.Tech', semester: '1st' }));

  const authMock = {
    _l: [], currentUser: null,
    onAuthStateChanged(cb) { this._l.push(cb); return () => {}; },
    async emit(u) { this.currentUser = u; await Promise.all(this._l.map((cb) => cb(u))); },
    signOut() { return this.emit(null); },
  };

  const dom = new JSDOM(read('admin.html'), { url: 'http://localhost:8000/admin.html', runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  window.matchMedia = window.matchMedia || (() => ({ matches: false, addListener() {}, removeListener() {} }));
  window.scrollTo = () => {};
  window.alert = () => {}; window.confirm = () => true; window.prompt = () => '';
  window.Papa = { parse: () => ({ data: [] }), unparse: () => '' };
  window.DSMNRU_API_URL = 'https://worker.example/api';
  window.fetch = async (url) => {
    const href = String(url);
    apiCalls.push(href);
    const u = new URL(href);
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    if (u.pathname === '/api/pyqs') {
      return json({ items: staleApiItems, total: staleApiItems.length, page: 1, limit: 100, totalPages: 1 });
    }
    if (u.pathname === '/api/homepage') return json({ recent: [], trending: [], courseCounts: [], stats: { totalPyqs: staleApiItems.length } });
    return json({ error: 'not found' }, 404);
  };
  window.firebase = { apps: [{}], initializeApp: () => window.firebase, firestore: () => db, storage: () => ({ ref: () => ({}) }), auth: () => authMock };
  window.firebase.firestore.FieldValue = db.FieldValue;
  window.firebase.firestore.Timestamp = { now: () => new Date() };
  window.firebase.auth.GoogleAuthProvider = function GoogleAuthProvider() {};
  class MockModal { show() {} hide() {} static getInstance() { return null; } static getOrCreateInstance() { return new MockModal(); } }
  window.bootstrap = { Modal: MockModal, Collapse: function Collapse() { this.hide = () => {}; } };
  window.bootstrap.Collapse.getOrCreateInstance = () => new window.bootstrap.Collapse();

  window.eval(read('points.js'));
  window.eval(read('duplicate-check.js'));
  window.eval(read('admin.js'));
  await wait(60);

  await authMock.emit({ uid: 'admin', email: 'admin@dsmnru.test', emailVerified: true, reload: () => Promise.resolve() });
  await wait(80);
  window.showAdminView('review');
  await wait(400);

  const hints = window.document.getElementById('duplicateHints-sub1');
  const html = hints ? hints.innerHTML : '';
  const text = hints ? hints.textContent : '';
  const items = Array.from(hints ? hints.querySelectorAll('.dup-item') : []);
  const firstTitle = items.length ? (items[0].querySelector('.dup-item-head a') || {}).textContent : '';
  const firstConfidence = items.length ? (items[0].querySelector('.dup-confidence') || {}).textContent : '';

  console.log('   candidate list rendered:');
  items.forEach((el, i) => {
    const c = (el.querySelector('.dup-confidence') || {}).textContent || '?';
    const t = (el.querySelector('.dup-item-head a') || {}).textContent || '?';
    console.log(`     ${i + 1}. ${c.padStart(5)}  ${t}`);
  });

  check('the stale API list was not trusted for duplicate matching',
    reads.pyqs >= 1, `pyqs reads=${reads.pyqs || 0}, api calls=${apiCalls.filter((h) => h.includes('/api/pyqs')).length}`);
  check('the EXACT existing PYQ appears in "Possible Existing PYQs"',
    text.includes(EXACT_TITLE), text.replace(/\s+/g, ' ').slice(0, 160));
  check('it is ranked #1', firstTitle === EXACT_TITLE, `first="${firstTitle}"`);
  check('it shows maximum (100%) confidence', firstConfidence === '100%', `confidence="${firstConfidence}"`);
  check('empty course/semester did not suppress the match',
    /course not compared/i.test(html) && /semester not compared/i.test(html));
  check('the near-miss papers are still listed below it',
    items.length >= 2 && /2025-26/.test(items.slice(1).map((el) => el.textContent).join(' ')));

  // publishing a new PYQ must invalidate the session index
  console.log('\n3. Publishing a PYQ invalidates the cached index');
  store.pyqs.brandNew = { title: 'B.Tech 3rd Sem Compiler Design 2024-25', course: 'B.Tech', semester: '3rd' };
  if (typeof window.invalidateDuplicateIndex === 'function') window.invalidateDuplicateIndex();
  store.pendingUploads.sub2 = {
    title: 'B.Tech 3rd Sem Compiler Design 2024-25', course: '', semester: '',
    studentName: 'Meera', studentEmail: 'meera@gmail.com', fileName: 'cd.pdf',
    downloadUrl: 'https://gofile.io/d/NEW', uploadedAt: ts(), status: 'pending',
  };
  window.loadPendingUploads();
  await wait(400);
  const hints2 = window.document.getElementById('duplicateHints-sub2');
  check('a PYQ published during the session is matched immediately',
    !!hints2 && /Compiler Design/.test(hints2.textContent),
    hints2 ? hints2.textContent.replace(/\s+/g, ' ').slice(0, 120) : '(no hints)');

  console.log(`\nResults: ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})().catch((err) => { console.error('💥 crashed:', err); process.exit(1); });
