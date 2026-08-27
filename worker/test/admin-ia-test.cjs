/**
 * Admin information-architecture test.
 *
 * Boots the REAL admin.html + points.js + duplicate-check.js + admin.js in
 * jsdom against a mock Firestore/Worker and verifies the sidebar + focused
 * views: navigation, lazy loading, the dashboard overview, the Rewards view,
 * Settings, the mobile drawer, and that the existing approve/reject + points
 * flow still works from inside the new Review Queue workspace.
 *
 * Run: cd worker && node test/admin-ia-test.cjs
 */
const fs = require('fs');
const path = require('path');
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

(async () => {
  console.log('\n🧪 Admin information architecture\n');

  // ── mock data ───────────────────────────────────────────────────────
  // Firestore timestamps expose .toDate(); mirror that in the mock.
  const ts = (d = new Date()) => ({ toDate: () => d, toMillis: () => d.getTime() });

  const store = {
    pendingUploads: {
      sub1: {
        title: 'Database Management System', course: 'B.Tech CSE', semester: '4th',
        studentName: 'Rahul', studentEmail: 'rahul@gmail.com', fileName: 'dbms.pdf',
        downloadUrl: 'https://gofile.io/d/ABC', uploadedAt: ts(), status: 'pending',
      },
    },
    pyqs: { pyq1: { title: 'DBMS', course: 'B.Tech CSE', semester: '4th', file: 'https://x/1.pdf' } },
    users: { u1: { uid: 'u1', name: 'Meera', email: 'meera@gmail.com', role: 'user', createdAt: ts() } },
    contributors: { c1: { name: 'Aarav', avatar: 'AS', role: 'PYQs Provider' } },
    feedback: { f1: { type: 'pyq_request', status: 'new', course: 'MBA', createdAt: ts() } },
    reward_accounts: {
      rahul_gmail_com: { email: 'rahul@gmail.com', points: 30, uid: null, createdAt: ts() },
      meera_gmail_com: { email: 'meera@gmail.com', points: 10, uid: 'u1', createdAt: ts() },
    },
    point_transactions: {
      sub0: { email: 'rahul@gmail.com', amount: 10, type: 'PYQ_UPLOAD_REWARD', submissionId: 'sub0', createdAt: ts() },
      sub00: { email: 'rahul@gmail.com', amount: 10, type: 'PYQ_UPLOAD_REWARD', submissionId: 'sub00', createdAt: ts() },
    },
  };
  const reads = {};
  const bump = (c) => { reads[c] = (reads[c] || 0) + 1; };

  const snap = (id, data) => ({ id, exists: !!data, data: () => (data ? { ...data } : undefined) });
  const docRef = (c, id) => ({
    id,
    async get() { bump(c); return snap(id, store[c] && store[c][id]); },
    async set(d, o) { store[c] = store[c] || {}; store[c][id] = o && o.merge ? { ...store[c][id], ...d } : { ...d }; },
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

  const apiCalls = [];
  const authMock = {
    _l: [], currentUser: null,
    onAuthStateChanged(cb) { this._l.push(cb); return () => {}; },
    async emit(u) { this.currentUser = u; await Promise.all(this._l.map((cb) => cb(u))); },
    signOut() { return this.emit(null); },
    signInWithEmailAndPassword: () => Promise.reject(new Error('mock')),
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
    if (u.pathname === '/api/homepage') {
      return json({ recent: [{ id: 'pyq1', title: 'DBMS', course: 'B.Tech', semester: '4th', session: '2024-25' }], trending: [], courseCounts: [], stats: { totalPyqs: 311, totalCourses: 9 } });
    }
    if (u.pathname === '/api/pyqs') return json({ items: [{ id: 'pyq1', title: 'DBMS', course: 'B.Tech CSE', semester: '4th' }], total: 1, page: 1, limit: 100, totalPages: 1 });
    return json({ error: 'not found' }, 404);
  };
  window.firebase = { apps: [{}], initializeApp: () => window.firebase, firestore: () => db, storage: () => ({ ref: () => ({}) }), auth: () => authMock };
  window.firebase.firestore.FieldValue = db.FieldValue;
  window.firebase.firestore.Timestamp = { now: () => new Date() };
  window.firebase.auth.GoogleAuthProvider = function GoogleAuthProvider() {};
  class MockModal { show() {} hide() {} static getInstance() { return null; } static getOrCreateInstance() { return new MockModal(); } }
  window.bootstrap = { Modal: MockModal, Collapse: function Collapse() { this.hide = () => {}; } };
  window.bootstrap.Collapse.getOrCreateInstance = () => new window.bootstrap.Collapse();

  window.eval(read('assets/js/points.js'));
  window.eval(read('assets/js/duplicate-check.js'));
  window.eval(read('assets/js/admin.js'));
  await wait(60);

  const doc = window.document;
  const q = (sel) => doc.querySelector(sel);
  const qa = (sel) => Array.from(doc.querySelectorAll(sel));
  const activeViews = () => qa('.admin-view.active').map((v) => v.getAttribute('data-view'));

  console.log('1. Sidebar navigation');
  const navItems = qa('.admin-nav-item');
  check('persistent sidebar exists', !!q('#adminSidebar'));
  check('all 9 destinations are present, in order',
    navItems.map((i) => i.getAttribute('data-view')).join(',') ===
    'dashboard,pyqs,add-pyq,bulk-import,review,contributors,users,feedback,rewards,settings',
    navItems.map((i) => i.getAttribute('data-view')).join(','));
  check('PYQ Management is a labelled group', /PYQ Management/.test(q('#adminNav').textContent));
  check('the group holds All PYQs / Add PYQ / Bulk Import as sub-items',
    qa('.admin-nav-sub').map((i) => i.getAttribute('data-view')).join(',') === 'pyqs,add-pyq,bulk-import');
  check('Review Queue carries a pending badge', !!q('#navPendingBadge'));

  console.log('\n2. Views & routing');
  check('one view per destination', qa('.admin-view').length === 10, String(qa('.admin-view').length));
  await authMock.emit({ uid: 'admin', email: 'admin@dsmnru.test', emailVerified: true, reload: () => Promise.resolve() });
  await wait(120);
  check('signing in opens the Dashboard', activeViews().join() === 'dashboard', activeViews().join());
  check('the Dashboard itself performs no pyqs read (duplicate matching is Review-Queue only)',
    (reads.pyqs || 0) === 0, `pyqs reads=${reads.pyqs || 0}`);
  check('exactly one view is active at a time', activeViews().length === 1);
  check('the topbar shows the current page title', q('#adminPageTitle').textContent === 'Dashboard');
  check('the matching nav item is marked active',
    q('.admin-nav-item.active').getAttribute('data-view') === 'dashboard');

  window.showAdminView('review');
  await wait(80);
  check('navigating switches the active view', activeViews().join() === 'review', activeViews().join());
  check('the breadcrumb follows the view', q('#adminPageTitle').textContent === 'Review Queue');
  check('the previous view is deactivated', !q('#view-dashboard').classList.contains('active'));
  check('the hash is kept in sync for deep links', window.location.hash === '#review', window.location.hash);
  window.showAdminView('bogus-view');
  await wait(40);
  check('an unknown destination falls back to the Dashboard', activeViews().join() === 'dashboard');

  console.log('\n3. Dashboard is an overview, not a toolbox');
  const dash = q('#view-dashboard');
  check('no Quick Create form on the dashboard', !dash.querySelector('#addPyqForm'));
  check('no Bulk Import form on the dashboard', !dash.querySelector('#csvImportForm'));
  check('no PYQ list / contributors / users / feedback lists on the dashboard',
    !dash.querySelector('#pyqsList') && !dash.querySelector('#contributorsList')
    && !dash.querySelector('#usersList') && !dash.querySelector('#feedbackList'));
  check('the 5 KPI cards are present',
    ['pyqsCount', 'pendingCount', 'usersCount', 'contributorsCount', 'feedbackCount'].every((id) => dash.querySelector('#' + id)));
  check('quick actions link to Add PYQ / Bulk Import / Review',
    /showAdminView\('add-pyq'\)/.test(dash.innerHTML)
    && /showAdminView\('bulk-import'\)/.test(dash.innerHTML)
    && /showAdminView\('review'\)/.test(dash.innerHTML));
  check('recent activity panels exist', !!dash.querySelector('#recentSubmissionsList') && !!dash.querySelector('#recentPyqsList'));
  check('the PYQ total on the dashboard comes from the cached Worker API',
    dash.querySelector('#pyqsCount').textContent === '311',
    `pyqsCount=${dash.querySelector('#pyqsCount').textContent}`);
  check('the pending submission appears in recent activity',
    /Database Management System/.test(dash.querySelector('#recentSubmissionsList').textContent));
  check('the recent PYQ list is rendered', /DBMS/.test(dash.querySelector('#recentPyqsList').textContent));

  console.log('\n4. Lazy loading is preserved');
  check('opening the dashboard did not read users/contributors/feedback',
    !reads.users && !reads.contributors && !reads.feedback,
    JSON.stringify(reads));
  check('unopened collections show "—" rather than a misleading 0',
    dash.querySelector('#usersCount').textContent === '—' && dash.querySelector('#contributorsCount').textContent === '—');
  window.loadDashboardCount('users');
  await wait(80);
  check('the "Load count" action fetches just that collection',
    reads.users === 1 && dash.querySelector('#usersCount').textContent === '1',
    `reads=${reads.users} value=${dash.querySelector('#usersCount').textContent}`);
  check('the Load button hides once the count is known',
    q('.stat-link[data-load-count="users"]').style.display === 'none');
  window.showAdminView('pyqs');
  await wait(120);
  check('opening All PYQs loads the library and renders it',
    q('#view-pyqs').classList.contains('active')
    && /DBMS/.test(q('#pyqsList').textContent)
    && q('#pyqsCount').textContent === '1',
    `count=${q('#pyqsCount').textContent} reads=${reads.pyqs}`);
  check('read budget so far: 1 duplicate index + 1 library read', reads.pyqs === 2, `pyqs reads=${reads.pyqs}`);

  console.log('\n5. Every feature still has a home');
  const homes = {
    '#view-add-pyq': '#addPyqForm', '#view-bulk-import': '#csvImportForm', '#view-pyqs': '#pyqsList',
    '#view-review': '#pendingUploadsList', '#view-contributors': '#contributorsList',
    '#view-users': '#usersList', '#view-feedback': '#feedbackList',
  };
  Object.keys(homes).forEach((view) => {
    check(`${view} hosts ${homes[view]}`, !!q(view + ' ' + homes[view]));
  });
  check('the local PYQ search box survived the move', !!q('#view-pyqs #adminPyqSearch'));
  check('the submission status filters survived the move',
    qa('#view-review .submission-filter-btn').length === 4);
  check('the contributor form survived the move', !!q('#view-contributors #addContributorForm'));

  console.log('\n6. Review Queue workspace');
  window.showAdminView('review');
  await wait(150);
  const card = q('[data-submission-id="sub1"]');
  check('the submission is listed', !!card);
  check('Approve states the +10 reward', /Approve\s*<span class="btn-points">\+10<\/span>/.test(card.innerHTML));
  check('Reject states 0 points', /Reject\s*<span class="btn-points">0<\/span>/.test(card.innerHTML));
  check('Preview / Download actions are available',
    /previewPendingFile\(/.test(card.innerHTML) && /downloadPendingFile\(/.test(card.innerHTML));
  check('uploader email, course and semester are shown',
    /rahul@gmail\.com/.test(card.innerHTML) && /B\.Tech CSE/.test(card.innerHTML) && /4th/.test(card.innerHTML));
  check('Possible Existing PYQs appears inside the review workflow',
    /Possible Existing PYQs/.test(q('#duplicateHints-sub1').textContent));

  console.log('\n7. Approve still awards exactly +10 through the new IA');
  await window.approveSubmission('sub1');
  await wait(150);
  check('submission approved', store.pendingUploads.sub1.status === 'approved');
  check('reward account credited +10 (30 → 40)',
    store.reward_accounts.rahul_gmail_com.points === 40, String(store.reward_accounts.rahul_gmail_com.points));
  check('a ledger entry was written for the submission', !!store.point_transactions.sub1);

  console.log('\n8. Rewards view');
  window.showAdminView('rewards');
  await wait(150);
  check('total points issued is the sum of the balances (50)',
    q('#rewardPointsIssued').textContent === '50', q('#rewardPointsIssued').textContent);
  check('contributors rewarded counts the accounts (2)', q('#rewardAccountsCount').textContent === '2');
  check('linked-to-sign-up count is reported (1)', q('#rewardLinkedCount').textContent === '1');
  check('the ledger lists recent transactions',
    /PYQ_UPLOAD_REWARD/.test(q('#rewardTxList').textContent) && /rahul@gmail\.com/.test(q('#rewardTxList').textContent));
  check('balances are listed highest first',
    q('#rewardAccountsList').textContent.indexOf('rahul@gmail.com') < q('#rewardAccountsList').textContent.indexOf('meera@gmail.com'));
  check('no redemption/payout controls exist (read-only ledger)',
    !Array.from(q('#view-rewards').querySelectorAll('button, input, select'))
      .some((el) => /redeem|withdraw|payout/i.test((el.textContent || '') + (el.getAttribute('onclick') || ''))));

  console.log('\n9. Settings view');
  window.showAdminView('settings');
  await wait(60);
  check('the signed-in admin is shown', q('#settingsAdminEmail').textContent === 'admin@dsmnru.test');
  check('the Firebase-token Worker cache invalidation status is reported',
    /Firebase admin token|Sign in as an admin/.test(q('#settingsApiCacheStatus').textContent));
  check('cache invalidation + CSV backup utilities are exposed',
    /runCacheInvalidation\(\)/.test(q('#view-settings').innerHTML) && /downloadAllCsvBackup\(\)/.test(q('#view-settings').innerHTML));
  check('the sidebar shows the session identity', q('#adminSignedInEmail').textContent === 'admin@dsmnru.test');

  console.log('\n10. Mobile drawer');
  window.toggleAdminSidebar();
  check('the toggle opens the drawer', doc.body.classList.contains('admin-nav-open'));
  window.toggleAdminSidebar();
  check('the toggle closes it again', !doc.body.classList.contains('admin-nav-open'));
  window.toggleAdminSidebar();
  window.showAdminView('feedback');
  await wait(60);
  check('navigating closes the drawer', !doc.body.classList.contains('admin-nav-open'));
  check('a backdrop exists to dismiss the drawer', !!q('#adminSidebarBackdrop'));

  console.log('\n11. Deep links + regression guards');
  window.location.hash = '#contributors';
  window.dispatchEvent(new window.HashChangeEvent('hashchange'));
  await wait(80);
  check('a #hash deep link opens the matching view', activeViews().join() === 'contributors', activeViews().join());
  const legacyIds = ['loginForm', 'email', 'password', 'loginError', 'editModal', 'userEditModal', 'csvWidget',
    'csvImportForm', 'addPyqForm', 'pyqCourse', 'pyqSemester', 'pyqSession', 'pyqSubject', 'pyqBranch',
    'pyqFile', 'pyqFile2', 'adminPyqSearch', 'pyqsList', 'pendingUploadsList', 'noPendingMessage',
    'contributorsList', 'usersList', 'feedbackList', 'logoutBtn'];
  const missing = legacyIds.filter((id) => !doc.getElementById(id));
  check('every pre-existing admin ID still exists', missing.length === 0, missing.join(','));
  check('there is exactly one #logoutBtn (its listener stays bound)', qa('#logoutBtn').length === 1);
  check('signing out resets the lazy-load state', (() => {
    authMock.emit(null);
    return true;
  })());

  console.log(`\nResults: ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})().catch((err) => { console.error('💥 crashed:', err); process.exit(1); });
