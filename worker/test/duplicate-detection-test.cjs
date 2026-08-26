/**
 * Duplicate-detection assistance tests.
 *
 * Part 1 loads the REAL duplicate-check.js and exercises the matcher against
 * the acceptance examples (title primary, course/semester optional, nothing
 * ever auto-excluded).
 * Part 2 loads the REAL admin.html + admin.js in jsdom and checks the review
 * queue renders the candidate list without touching submission status.
 *
 * Run: cd worker && node test/duplicate-detection-test.cjs
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');

let pass = 0;
let fail = 0;
function check(name, condition, detail = '') {
  if (condition) { pass += 1; console.log(`  ✅ ${name}`); }
  else { fail += 1; console.log(`  ❌ ${name} ${detail}`); }
}

// ── Load the real module ────────────────────────────────────────────
const sandbox = { globalThis: {} };
sandbox.window = sandbox.globalThis;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'duplicate-check.js'), 'utf8'), sandbox);
const D = sandbox.globalThis.DSMNRUDuplicates;

console.log('\n🧪 Duplicate-detection assistance\n');
console.log('1. Module + normalization');
check('duplicate-check.js exposes DSMNRUDuplicates', !!D);
check('lowercase + trim + collapse whitespace',
  D.normalizeText('  Database   Management\t System ') === 'database management system',
  JSON.stringify(D.normalizeText('  Database   Management\t System ')));
check('punctuation stripped, hyphens split words',
  D.normalizeText('Data-Structures & Algorithms!') === 'data structures and algorithms',
  JSON.stringify(D.normalizeText('Data-Structures & Algorithms!')));
check('the {session} suffix PYQ titles carry is ignored',
  D.normalizeText('B.A. 1st Sem History {2024-25}') === 'ba 1st sem history',
  JSON.stringify(D.normalizeText('B.A. 1st Sem History {2024-25}')));
check('course abbreviations keep their dots ("B.A." ≡ "BA")',
  D.courseSimilarity('B.A.', 'BA') === 1, String(D.courseSimilarity('B.A.', 'BA')));
check('abbreviation expansion puts DBMS and Database Management System together',
  D.tokenize('DBMS').join(' ') === D.tokenize('Database Management System').join(' '),
  `${D.tokenize('DBMS').join(' ')} vs ${D.tokenize('Database Management System').join(' ')}`);
check('plural/singular collapse', D.tokenize('Data Structures').join(' ') === D.tokenize('Data Structure').join(' '));

console.log('\n2. Acceptance examples');
// Example 1 — abbreviation + same course + same semester
const ex1 = D.scoreCandidate(
  { title: 'Database Management System', course: 'B.Tech CSE', semester: '4th' },
  { title: 'DBMS', course: 'B.Tech CSE', semester: '4th' }
);
check('Ex1 "Database Management System" vs "DBMS" (same course+sem) → very strong',
  ex1.titleScore === 1 && ex1.confidence >= 0.9 && ex1.course === 'match' && ex1.semester === 'match',
  JSON.stringify(ex1));
check('Ex1 is labelled "Very likely the same paper"',
  D.confidenceLabel(ex1.confidence) === 'Very likely the same paper');
check('Ex1 (title+course+semester all agree) outranks Ex2 (title only)',
  ex1.confidence > D.scoreCandidate({ title: 'Database Management System' }, { title: 'DBMS', course: 'B.Tech CSE', semester: '4th' }).confidence);

// Example 2 — optional fields missing on the NEW record: still a match
const ex2 = D.scoreCandidate(
  { title: 'Database Management System' },
  { title: 'DBMS', course: 'B.Tech CSE', semester: '4th' }
);
check('Ex2 missing course+semester on the new record → still matched on title',
  ex2.titleScore === 1 && ex2.course === 'unknown' && ex2.semester === 'unknown' && ex2.confidence === 0.9,
  JSON.stringify(ex2));
check('Ex2 still clears the display threshold on title alone',
  D.findCandidates({ title: 'Database Management System' }, [{ id: 'p', title: 'DBMS', course: 'B.Tech CSE', semester: '4th' }]).length === 1);
const ex2diff = D.scoreCandidate(
  { title: 'Database Management System', course: 'MBA', semester: '1st' },
  { title: 'DBMS', course: 'B.Tech CSE', semester: '4th' }
);
check('Ex2 a MISSING optional field costs nothing, a DIFFERENT one does',
  ex2.confidence > ex2diff.confidence && ex2.course === 'unknown' && ex2diff.course === 'different',
  `missing=${ex2.confidence.toFixed(2)} different=${ex2diff.confidence.toFixed(2)}`);
check('Ex2b even with both fields different the candidate is still shown',
  ex2diff.confidence >= 0.5, JSON.stringify(ex2diff));

// Example 3 — same title+course, different semester → lower confidence, kept
const ex3 = D.scoreCandidate(
  { title: 'DBMS', course: 'B.Tech CSE', semester: '4th' },
  { title: 'DBMS', course: 'B.Tech CSE', semester: '5th' }
);
check('Ex3 differing semester lowers confidence but keeps the candidate',
  ex3.confidence < ex1.confidence && ex3.confidence > 0.5 && ex3.semester === 'different',
  JSON.stringify(ex3));

// Example 4 — exact title, completely different course → still relevant
const ex4 = D.scoreCandidate(
  { title: 'Engineering Mathematics' },
  { title: 'Engineering Mathematics', course: 'MBA', semester: '1st' }
);
check('Ex4 exact title with no course/semester on the new record → title-only confidence',
  ex4.titleScore === 1 && ex4.confidence === 0.9, JSON.stringify(ex4));
const ex4b = D.scoreCandidate(
  { title: 'Engineering Mathematics', course: 'B.Tech', semester: '2nd' },
  { title: 'Engineering Mathematics', course: 'MBA', semester: '1st' }
);
check('Ex4b different course AND semester still leaves a strong candidate',
  ex4b.titleScore === 1 && ex4b.confidence >= 0.6 && ex4b.course === 'different',
  JSON.stringify(ex4b));

console.log('\n3. Never excluded for optional-field differences');
const mixed = [
  { id: 'p1', title: 'DBMS', course: 'B.Tech CSE', semester: '4th' },
  { id: 'p2', title: 'DBMS', course: 'MBA', semester: '1st' },
  { id: 'p3', title: 'DBMS' },
  { id: 'p4', title: 'Database Management System Lab', course: 'B.A.', semester: '7th' },
];
const found = D.findCandidates({ title: 'Database Management System', course: 'B.Tech CSE', semester: '4th' }, mixed);
check('all four title-related candidates survive (none dropped for course/semester)',
  found.length === 4, `got ${found.length}: ${found.map((f) => f.pyq.id).join(',')}`);
check('sorted by confidence: exact+matching > exact+no fields > exact+differing > near+differing',
  found.map((f) => f.pyq.id).join(',') === 'p1,p3,p2,p4',
  found.map((f) => `${f.pyq.id}:${f.confidence.toFixed(2)}`).join(' '));
check('confidence decreases monotonically',
  found.every((f, i) => i === 0 || f.confidence <= found[i - 1].confidence));

console.log('\n4. Ranking / limits / guards');
const many = Array.from({ length: 40 }, (_, i) => ({ id: `x${i}`, title: `Unrelated Subject Number ${i}` }));
many.push({ id: 'hit', title: 'Operating System' });
many.push({ id: 'near', title: 'Operating Systems Lab' });
const ranked = D.findCandidates({ title: 'Operating System' }, many);
check('unrelated titles are filtered out by the confidence floor',
  ranked.length === 2 && ranked[0].pyq.id === 'hit', JSON.stringify(ranked.map((r) => r.pyq.id)));
check('limit caps the result at 5', (() => {
  const clones = Array.from({ length: 12 }, (_, i) => ({ id: `d${i}`, title: 'DBMS' }));
  return D.findCandidates({ title: 'Database Management System' }, clones).length === 5;
})());
check('a submission without a title produces no candidates',
  D.findCandidates({ course: 'B.Tech' }, mixed).length === 0);
check('an empty PYQ list produces no candidates',
  D.findCandidates({ title: 'DBMS' }, []).length === 0);
check('typo tolerance (Levenshtein fallback)',
  D.titleSimilarity('Data Structure and Algorithm', 'Data Strcture and Algorithmm') > 0.6,
  String(D.titleSimilarity('Data Structure and Algorithm', 'Data Strcture and Algorithmm')));
check('year/session differences never lower the score',
  D.titleSimilarity('History {2024-25}', 'History {2019-20}') === 1);
check('scoreCandidate never returns a confidence outside [0,1]',
  D.scoreCandidate({ title: 'a', course: 'B.Tech', semester: '1st' }, { title: 'zzzz', course: 'MBA', semester: '9th' }).confidence >= 0);

console.log('\n5. Admin panel integration (jsdom)');
const { JSDOM } = require('jsdom');
const adminHtml = fs.readFileSync(path.join(ROOT, 'admin.html'), 'utf8');
const adminJs = fs.readFileSync(path.join(ROOT, 'admin.js'), 'utf8');
const dupJs = fs.readFileSync(path.join(ROOT, 'duplicate-check.js'), 'utf8');

(async () => {
  const store = {
    pendingUploads: {
      sub1: {
        title: 'Database Management System', course: 'B.Tech CSE', semester: '4th',
        studentName: 'Rahul', studentEmail: 'rahul@gmail.com', fileName: 'dbms.pdf',
        downloadUrl: 'https://gofile.io/d/ABC', uploadedAt: new Date(), status: 'pending',
      },
    },
    pyqs: {
      pyq1: { title: 'DBMS', course: 'B.Tech CSE', semester: '4th', file: 'https://x/1.pdf' },
      pyq2: { title: 'Operating System', course: 'MBA', semester: '1st' },
    },
  };

  const snapshot = (id, data) => ({ id, exists: !!data, data: () => (data ? { ...data } : undefined) });
  const docRef = (coll, id) => ({
    id,
    async get() { return snapshot(id, store[coll] && store[coll][id]); },
    async set(d, o) { store[coll][id] = o && o.merge ? { ...store[coll][id], ...d } : { ...d }; },
    async update(p) { store[coll][id] = { ...store[coll][id], ...p }; },
    async delete() { delete store[coll][id]; },
  });
  const query = (coll) => ({
    where() { return this; }, orderBy() { return this; }, limit() { return this; },
    async get() {
      return { docs: Object.keys(store[coll] || {}).map((id) => snapshot(id, { ...store[coll][id] })), empty: false };
    },
  });
  const db = {
    enablePersistence: () => Promise.resolve(),
    collection: (c) => Object.assign({ doc: (id) => docRef(c, id), async add(d) { const id = `a${Math.random()}`; store[c][id] = d; return { id }; } }, query(c)),
    runTransaction: (fn) => fn({ get: (r) => r.get(), set: (r, d, o) => r.set(d, o), update: (r, p) => r.update(p) }),
    batch: () => ({ set() {}, update() {}, delete() {}, commit: () => Promise.resolve() }),
  };
  db.FieldValue = { serverTimestamp: () => new Date(), increment: (n) => n };

  const authMock = {
    _l: [], currentUser: null,
    onAuthStateChanged(cb) { this._l.push(cb); return () => {}; },
    async emit(u) { this.currentUser = u; await Promise.all(this._l.map((cb) => cb(u))); },
    signOut() { return this.emit(null); },
  };

  const dom = new JSDOM(adminHtml, { url: 'http://localhost:8000/admin.html', runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  window.matchMedia = window.matchMedia || (() => ({ matches: false, addListener() {}, removeListener() {} }));
  window.scrollTo = () => {};
  window.alert = () => {}; window.confirm = () => true; window.prompt = () => '';
  window.Papa = { parse: () => ({ data: [] }), unparse: () => '' };
  // No Worker available in the test → the Firestore fallback path is used.
  window.fetch = async () => new Response('{}', { status: 500 });
  window.firebase = {
    apps: [{}], initializeApp: () => window.firebase, firestore: () => db,
    storage: () => ({ ref: () => ({}) }), auth: () => authMock,
  };
  window.firebase.firestore.FieldValue = db.FieldValue;
  window.firebase.firestore.Timestamp = { now: () => new Date() };
  window.firebase.auth.GoogleAuthProvider = function GoogleAuthProvider() {};
  class MockModal { show() {} hide() {} static getInstance() { return null; } static getOrCreateInstance() { return new MockModal(); } }
  window.bootstrap = { Modal: MockModal };

  window.eval(dupJs);
  window.eval(adminJs);
  await new Promise((r) => setTimeout(r, 40));
  check('duplicate-check.js is loaded on the admin page', !!window.DSMNRUDuplicates);

  await authMock.emit({ uid: 'admin', email: 'abc@gmail.com', emailVerified: true, reload: () => Promise.resolve() });
  await new Promise((r) => setTimeout(r, 40));
  window.loadPendingUploads();
  await new Promise((r) => setTimeout(r, 250));

  const card = window.document.querySelector('[data-submission-id="sub1"]');
  const hints = window.document.getElementById('duplicateHints-sub1');
  check('pending submission rendered in the review queue', !!card);
  check('a duplicate-hints block is rendered for pending submissions', !!hints);
  check('the matching existing PYQ is listed as a candidate',
    !!hints && /DBMS/.test(hints.textContent), hints ? hints.textContent.trim().slice(0, 90) : '(none)');
  check('candidates are shown with a confidence figure',
    !!hints && /\d+%/.test(hints.textContent));
  check('the unmatched PYQ (Operating System) is not listed',
    !!hints && !/Operating System/.test(hints.textContent));
  check('candidates link to paper.html so the admin can check manually',
    !!hints && /paper\.html\?id=pyq1/.test(hints.innerHTML));
  check('it is labelled "Possible Existing PYQs" (admin warning, not automatic)',
    !!hints && /Possible Existing PYQs/i.test(hints.textContent) && /never auto-rejected/i.test(hints.textContent));
  check('each candidate offers a [View] action',
    !!hints && /class="dup-view"[^>]*>\s*View/.test(hints.innerHTML));
  check('the approve action states the +10 reward',
    !!card && /Approve\s*<span class="btn-points">\+10<\/span>/.test(card.innerHTML));
  check('a Preview action is available for the submission file',
    !!card && /previewPendingFile\(/.test(card.innerHTML));
  check('the submission status was NOT changed by duplicate detection',
    store.pendingUploads.sub1.status === 'pending');
  check('no points were touched by duplicate detection',
    store.pendingUploads.sub1.pointsAwarded === undefined
    && Object.keys(store).indexOf('point_transactions') === -1);
  check('Approve/Reject buttons are still the only review actions',
    /approveSubmission\('sub1'\)/.test(card.innerHTML) && /rejectSubmission\('sub1'\)/.test(card.innerHTML));

  console.log('\n6. Worker API is the preferred index source');
  // Fresh module state: reload admin.js with a working paginated Worker API.
  const requested = [];
  const dom2 = new JSDOM(adminHtml, { url: 'http://localhost:8000/admin.html', runScripts: 'outside-only', pretendToBeVisual: true });
  const w2 = dom2.window;
  w2.matchMedia = w2.matchMedia || (() => ({ matches: false, addListener() {}, removeListener() {} }));
  w2.scrollTo = () => {}; w2.alert = () => {}; w2.confirm = () => true; w2.prompt = () => '';
  w2.Papa = { parse: () => ({ data: [] }), unparse: () => '' };
  w2.DSMNRU_API_URL = 'https://worker.example/api';
  let firestoreReads = 0;
  const db2 = {
    enablePersistence: () => Promise.resolve(),
    collection: (c) => ({
      doc: (id) => docRef(c, id),
      where() { return this; }, orderBy() { return this; }, limit() { return this; },
      async get() { if (c === 'pyqs') firestoreReads += 1; return query(c).get(); },
      async add(d) { store[c][`a${Math.random()}`] = d; return { id: 'x' }; },
    }),
    runTransaction: (fn) => fn({ get: (r) => r.get(), set: (r, d, o) => r.set(d, o), update: (r, p) => r.update(p) }),
    batch: () => ({ set() {}, update() {}, delete() {}, commit: () => Promise.resolve() }),
  };
  db2.FieldValue = db.FieldValue;
  const auth2 = { _l: [], currentUser: null, onAuthStateChanged(cb) { this._l.push(cb); return () => {}; }, async emit(u) { this.currentUser = u; await Promise.all(this._l.map((cb) => cb(u))); } };
  w2.fetch = async (url) => {
    requested.push(String(url));
    const u = new URL(String(url));
    if (!u.pathname.startsWith('/api/pyqs')) return new Response('{}', { status: 404 });
    const page = parseInt(u.searchParams.get('page') || '1', 10);
    const all = [
      { id: 'w1', title: 'DBMS', course: 'B.Tech CSE', semester: '4th' },
      { id: 'w2', title: 'Operating System', course: 'MBA', semester: '1st' },
      { id: 'w3', title: 'Database Management System Lab', course: 'B.Tech CSE', semester: '4th' },
    ];
    return new Response(JSON.stringify({ items: page === 1 ? all : [], total: all.length, page, limit: 100, totalPages: 1 }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  };
  w2.firebase = { apps: [{}], initializeApp: () => w2.firebase, firestore: () => db2, storage: () => ({ ref: () => ({}) }), auth: () => auth2 };
  w2.firebase.firestore.FieldValue = db.FieldValue;
  w2.firebase.auth.GoogleAuthProvider = function GoogleAuthProvider() {};
  w2.bootstrap = { Modal: MockModal };
  w2.eval(dupJs);
  w2.eval(adminJs);
  await new Promise((r) => setTimeout(r, 40));
  await auth2.emit({ uid: 'admin', email: 'abc@gmail.com', emailVerified: true, reload: () => Promise.resolve() });
  await new Promise((r) => setTimeout(r, 40));
  w2.loadPendingUploads();
  await new Promise((r) => setTimeout(r, 300));

  const hints2 = w2.document.getElementById('duplicateHints-sub1');
  check('the Worker API was used for the PYQ index',
    requested.some((href) => href.includes('/api/pyqs?limit=100&page=1')), requested.join(' | '));
  check('no direct `pyqs` Firestore read was needed', firestoreReads === 0, `pyqs reads=${firestoreReads}`);
  check('API-sourced candidates are rendered',
    !!hints2 && /DBMS/.test(hints2.textContent) && /paper\.html\?id=w1/.test(hints2.innerHTML));
  check('up to 5 candidates, sorted by confidence',
    !!hints2 && (hints2.innerHTML.match(/dup-confidence /g) || []).length <= 5);
  check('a second queue render reuses the cached index (still one API call)',
    requested.filter((href) => href.includes('/api/pyqs')).length === 1, String(requested.filter((h) => h.includes('/api/pyqs')).length));

  console.log('\n7. Rendered hint block (for eyeballing)');
  if (hints2) console.log(hints2.innerHTML.replace(/\s+/g, ' ').slice(0, 700));

  console.log(`\nResults: ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})().catch((err) => { console.error('💥 crashed:', err); process.exit(1); });
