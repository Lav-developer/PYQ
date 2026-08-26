/**
 * PYQ Contribution + Points smoke test (jsdom + mocked Firebase).
 *
 * Loads the REAL files that ship to production — points.js, script.js with
 * index.html, and admin.js with admin.html — against one shared in-memory
 * Firestore, then drives the actual exported functions:
 *
 *   public page : userUploadForm submit → pendingUploads (status: pending)
 *   admin page  : loadPendingUploads / approveSubmission / rejectSubmission
 *   public page : loadUserProfile → profile points + reward history
 *
 * Covers the acceptance list:
 *   1 anonymous upload → pending            6  unregistered email → later signup
 *   2 approve → +10                         7  email capitalization variants
 *   3 reject → 0                            8  non-admin cannot approve
 *   4 approve twice → only +10              9  client cannot write points
 *   5 registered user email → profile      10  existing workflow still works
 *
 * Run: cd worker && node test/contribution-points-test.cjs
 */
const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

const indexHtml = read('index.html');
const adminHtml = read('admin.html');
const scriptJs = read('script.js');
const adminJs = read('admin.js');
const pointsJs = read('points.js');
const rulesText = read('firestore.rules');

// ── Shared in-memory Firestore ────────────────────────────────────────
const store = {
  pendingUploads: {},
  reward_accounts: {},
  point_transactions: {},
  users: {},
};

const stats = { reads: 0, writes: 0, transactions: 0 };

function materialize(data) {
  const out = {};
  Object.keys(data || {}).forEach((key) => {
    const value = data[key];
    if (value && value.__serverTimestamp) {
      const date = new Date();
      out[key] = { toDate: () => date, toMillis: () => date.getTime() };
    } else {
      out[key] = value;
    }
  });
  return out;
}

function snapshot(docId, data) {
  return {
    id: docId,
    exists: !!data,
    ref: null,
    data: () => (data ? { ...data } : undefined),
  };
}

function querySnapshot(docs) {
  return {
    docs,
    empty: docs.length === 0,
    size: docs.length,
    forEach: (cb) => docs.forEach(cb),
  };
}

function createFirestoreMock() {
  const FieldValue = {
    serverTimestamp: () => ({ __serverTimestamp: true }),
    increment: (n) => ({ __increment: n }),
  };

  function docRef(collection, docId) {
    return {
      id: docId,
      path: `${collection}/${docId}`,
      async get() {
        stats.reads += 1;
        const data = store[collection] && store[collection][docId];
        return snapshot(docId, data ? { ...data } : null);
      },
      async set(data, options) {
        stats.writes += 1;
        store[collection] = store[collection] || {};
        const existing = store[collection][docId] || {};
        store[collection][docId] = materialize(
          options && options.merge ? { ...existing, ...data } : { ...data }
        );
        return snapshot(docId, store[collection][docId]);
      },
      async update(patch) {
        stats.writes += 1;
        const existing = store[collection] && store[collection][docId];
        if (!existing) throw new Error(`No document to update: ${collection}/${docId}`);
        store[collection][docId] = materialize({ ...existing, ...patch });
        return snapshot(docId, store[collection][docId]);
      },
      async delete() {
        stats.writes += 1;
        if (store[collection]) delete store[collection][docId];
      },
    };
  }

  function query(collection, filters, limitN) {
    const api = {
      where(field, op, value) {
        return query(collection, [...filters, { field, op, value }], limitN);
      },
      orderBy() { return api; },
      limit(n) { return query(collection, filters, n); },
      async get() {
        stats.reads += 1;
        const docs = Object.keys(store[collection] || {})
          .filter((id) => filters.every((filter) => {
            const value = store[collection][id][filter.field];
            if (filter.op === '==') return value === filter.value;
            if (filter.op === '!=') return value !== filter.value;
            return true;
          }))
          .map((id) => snapshot(id, { ...store[collection][id] }));
        return querySnapshot(typeof limitN === 'number' ? docs.slice(0, limitN) : docs);
      },
    };
    return api;
  }

  function collectionRef(collection) {
    store[collection] = store[collection] || {};
    const queryApi = query(collection, [], null);
    return {
      doc: (docId) => docRef(collection, docId),
      async add(data) {
        stats.writes += 1;
        const id = `auto_${Math.random().toString(36).slice(2, 10)}${Object.keys(store[collection]).length}`;
        store[collection][id] = materialize(data);
        return { id };
      },
      where: queryApi.where,
      orderBy: queryApi.orderBy,
      limit: queryApi.limit,
      get: queryApi.get,
    };
  }

  const db = {
    enablePersistence: () => Promise.resolve(),
    settings: () => {},
    collection: collectionRef,
    async runTransaction(updateFunction) {
      stats.transactions += 1;
      const tx = {
        get: (ref) => ref.get(),
        set: (ref, data, options) => ref.set(data, options),
        update: (ref, patch) => ref.update(patch),
        delete: (ref) => ref.delete(),
      };
      return updateFunction(tx);
    },
    batch() {
      const ops = [];
      return {
        set: (ref, data, options) => ops.push(() => ref.set(data, options)),
        update: (ref, patch) => ops.push(() => ref.update(patch)),
        delete: (ref) => ops.push(() => ref.delete()),
        async commit() { await Promise.all(ops.map((op) => op())); },
      };
    },
  };

  db.firestore = () => db;
  db.FieldValue = FieldValue;
  return db;
}

function createFirebaseMock(authState) {
  const dbInstance = createFirestoreMock();
  const firebaseMock = {
    apps: [{}],
    initializeApp: () => firebaseMock,
    firestore: () => dbInstance,
    storage: () => ({ ref: () => ({ put: () => Promise.resolve() }) }),
    auth: () => authState,
  };
  firebaseMock.firestore.FieldValue = dbInstance.FieldValue;
  firebaseMock.firestore.Timestamp = { now: () => new Date() };
  firebaseMock.auth.GoogleAuthProvider = function GoogleAuthProvider() {};
  return { firebase: firebaseMock, db: dbInstance };
}

function createAuthMock(signedInUser) {
  return {
    _listeners: [],
    currentUser: signedInUser || null,
    onAuthStateChanged(cb) {
      this._listeners.push(cb);
      return () => {};
    },
    async emit(user) {
      this.currentUser = user;
      await Promise.all(this._listeners.map((cb) => cb(user)));
    },
    async signOut() { await this.emit(null); },
    signInWithEmailAndPassword: () => Promise.reject(new Error('mock')),
    signInWithPopup: () => Promise.reject(new Error('mock')),
    sendPasswordResetEmail: () => Promise.resolve(),
    setPersistence: () => Promise.resolve(),
  };
}

function makeUser(uid, email, extra = {}) {
  return {
    uid,
    email,
    displayName: email.split('@')[0],
    emailVerified: true,
    providerData: [{ providerId: 'password' }],
    metadata: { creationTime: new Date().toISOString() },
    reload: () => Promise.resolve(),
    updateProfile: () => Promise.resolve(),
    getIdToken: () => Promise.resolve('token'),
    ...extra,
  };
}

// ── Assertions ────────────────────────────────────────────────────────
let pass = 0;
let fail = 0;
function check(name, condition, detail = '') {
  if (condition) { pass += 1; console.log(`  ✅ ${name}`); }
  else { fail += 1; console.log(`  ❌ ${name} ${detail}`); }
}
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(predicate, timeout = 3000, step = 25) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    let ok = false;
    try { ok = !!predicate(); } catch (err) { ok = false; }
    if (ok) return true;
    await wait(step);
  }
  return false;
}

// ── Environment A: admin panel ────────────────────────────────────────
async function bootAdmin() {
  const authMock = createAuthMock(null);
  const { firebase } = createFirebaseMock(authMock);
  const dom = new JSDOM(adminHtml, {
    url: 'http://localhost:8000/admin.html',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const { window } = dom;
  window.matchMedia = window.matchMedia || (() => ({ matches: false, addListener() {}, removeListener() {} }));
  window.scrollTo = () => {};
  window.firebase = firebase;
  window.Papa = { parse: () => ({ data: [] }), unparse: () => '' };
  class MockModal {
    show() {} hide() {}
    static getInstance() { return null; }
    static getOrCreateInstance() { return new MockModal(); }
  }
  window.bootstrap = { Modal: MockModal };
  window.alert = () => {};
  window.confirm = () => true;
  window.prompt = () => '';
  window.fetch = async () => new Response(JSON.stringify([]), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
  window.eval(pointsJs);
  window.eval(adminJs);
  await wait(30);
  return { window, auth: authMock };
}

// ── Environment B: public site (index.html) ───────────────────────────
async function bootPublic() {
  const requestedUrls = [];
  const authMock = createAuthMock(null);
  const { firebase } = createFirebaseMock(authMock);
  const dom = new JSDOM(indexHtml, {
    url: 'http://localhost:8000/index.html',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const { window } = dom;
  window.matchMedia = window.matchMedia || (() => ({ matches: false, addListener() {}, removeListener() {} }));
  window.scrollTo = () => {};
  window.AbortController = window.AbortController || AbortController;
  window.DSMNRU_API_URL = 'http://localhost:8000';
  window.firebase = firebase;
  window.Swal = { fire: () => Promise.resolve({ isConfirmed: true }) };
  class MockModal {
    show() {} hide() {}
    static getInstance() { return null; }
    static getOrCreateInstance() { return new MockModal(); }
  }
  window.bootstrap = { Modal: MockModal };
  window.alert = () => {};
  window.fetch = async (url) => {
    const href = String(url);
    requestedUrls.push(href);
    const json = (body, status = 200) => new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
    if (href.includes('api.gofile.io/servers')) {
      return json({ status: 'ok', data: { servers: [{ name: 'store1' }] } });
    }
    if (href.includes('.gofile.io/uploadFile')) {
      return json({ status: 'ok', data: { downloadPage: 'https://gofile.io/d/TESTPAGE' } });
    }
    if (href.startsWith('http://localhost:8000/api/')) {
      return json({ items: [], total: 0, page: 1, limit: 20, totalPages: 0 });
    }
    return json({ error: 'not found' }, 404);
  };
  window.eval(pointsJs);
  window.eval(scriptJs);
  await wait(50);
  return { window, auth: authMock, requestedUrls };
}

function fillUploadForm(window, { name, email, title = 'B.A. 1st Sem History {2024-25}' }, resetThrottle = true) {
  const setValue = (id, value) => {
    const el = window.document.getElementById(id);
    if (el) el.value = value;
  };
  setValue('uploadTitle', title);
  setValue('uploadName', name);
  setValue('uploadEmail', email);
  setValue('uploadCourse', 'B.A.');
  setValue('uploadSemester', '1st');

  const file = new window.File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], 'history-2024.pdf', {
    type: 'application/pdf',
  });
  Object.defineProperty(file, 'size', { value: 1024 });
  const input = window.document.getElementById('uploadFile');
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  if (resetThrottle) window.localStorage.removeItem('dsmnruUploadThrottle');
  window.document.getElementById('userUploadForm')
    .dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
}

(async () => {
  console.log('\n🧪 PYQ Contribution + Points smoke test (real files, mocked Firebase)\n');

  const admin = await bootAdmin();
  const publicSite = await bootPublic();
  const aw = admin.window;
  const pw = publicSite.window;

  // ── 0. Files load ───────────────────────────────────────────────────
  console.log('1. Modules load');
  check('points.js defines DSMNRUPoints on the public page', !!pw.DSMNRUPoints);
  check('points.js defines DSMNRUPoints on the admin page', !!aw.DSMNRUPoints);
  check('admin.js exposes approve/reject/filter on window',
    typeof aw.approveSubmission === 'function'
    && typeof aw.rejectSubmission === 'function'
    && typeof aw.filterSubmissions === 'function');

  // ── 1. Email normalization (single source of truth) ─────────────────
  console.log('\n2. Email normalization');
  const P = pw.DSMNRUPoints;
  const variants = ['Rahul@gmail.com', 'rahul@gmail.com', ' RAHUL@GMAIL.COM '];
  const normalized = variants.map((v) => P.normalizeRewardEmail(v));
  check('trim + lowercase for all three variants',
    normalized.every((email) => email === 'rahul@gmail.com'), JSON.stringify(normalized));
  check('all variants map to ONE reward account key',
    new Set(variants.map((v) => P.rewardAccountKey(v))).size === 1
    && P.rewardAccountKey(variants[0]) === 'rahul_gmail_com');
  check('invalid emails rejected', P.isValidRewardEmail('rahul@') === false && P.isValidRewardEmail('nope') === false);
  check('reward amount is 10 and the type is PYQ_UPLOAD_REWARD',
    P.PYQ_UPLOAD_REWARD_POINTS === 10 && P.PYQ_UPLOAD_REWARD_TYPE === 'PYQ_UPLOAD_REWARD');

  // ── 2. Anonymous upload → pending ───────────────────────────────────
  console.log('\n3. Anonymous upload (no sign-in)');
  fillUploadForm(pw, { name: 'Rahul Kumar', email: 'Rahul@gmail.com' });
  const createdFirst = await waitFor(() => Object.keys(store.pendingUploads).length === 1);
  check('a submission document was created without authentication', createdFirst);
  const firstId = Object.keys(store.pendingUploads)[0];
  const firstDoc = store.pendingUploads[firstId] || {};
  check('status is pending', firstDoc.status === 'pending', `status=${firstDoc.status}`);
  check('email stored normalized (rahul@gmail.com)', firstDoc.studentEmail === 'rahul@gmail.com', `email=${firstDoc.studentEmail}`);
  check('gofile download url stored (file flow untouched)',
    firstDoc.downloadUrl === 'https://gofile.io/d/TESTPAGE');
  check('no points fields written by the client',
    firstDoc.pointsAwarded === undefined && firstDoc.pointsTransactionId === undefined);
  check('success message says "Submission received" and 10 points are not yet earned',
    /Submission received/.test(pw.document.getElementById('uploadStatusMessage').innerHTML)
    && /will be credited/.test(pw.document.getElementById('uploadStatusMessage').innerHTML));

  // ── 3. Email is required ────────────────────────────────────────────
  console.log('\n4. Validation');
  fillUploadForm(pw, { name: 'No Email', email: '   ' });
  await wait(120);
  check('upload without an email is rejected', Object.keys(store.pendingUploads).length === 1);

  // ── 4. Non-admin cannot approve ─────────────────────────────────────
  console.log('\n5. Authorization');
  const beforeUnauthorized = JSON.stringify(store);
  await aw.approveSubmission(firstId);
  check('anonymous visitor cannot approve a submission',
    JSON.stringify(store) === beforeUnauthorized
    && store.pendingUploads[firstId].status === 'pending');
  await aw.rejectSubmission(firstId);
  check('anonymous visitor cannot reject a submission',
    store.pendingUploads[firstId].status === 'pending');

  // Sign the admin in (rules-based admin check runs against the mock store).
  await admin.auth.emit(makeUser('admin-uid', 'abc@gmail.com'));
  await wait(60);

  // ── 5. Admin loads the review queue ─────────────────────────────────
  console.log('\n6. Admin review queue');
  aw.loadPendingUploads();
  await waitFor(() => aw.document.querySelector('[data-submission-id]'));
  const queueHtml = aw.document.getElementById('pendingUploadsList').innerHTML;
  check('submission rendered in the existing review queue', /Rahul Kumar/.test(queueHtml));
  check('uploader email shown to the admin', /rahul@gmail\.com/.test(queueHtml));
  check('pending status badge rendered', /submission-status-pending/.test(queueHtml));
  check('Approve + Reject buttons present for pending submissions',
    /approveSubmission\(/.test(queueHtml) && /rejectSubmission\(/.test(queueHtml));
  check('existing Download/Copy URL/Delete actions preserved',
    /downloadPendingFile\(/.test(queueHtml) && /copyToClipboard\(/.test(queueHtml) && /deletePendingUpload\(/.test(queueHtml));
  check('review queue counts rendered', aw.document.getElementById('submissionPendingCount').textContent === '1');

  // ── 6. Approve → +10 ────────────────────────────────────────────────
  console.log('\n7. Approve → +10 points');
  await aw.approveSubmission(firstId);
  await waitFor(() => store.pendingUploads[firstId] && store.pendingUploads[firstId].status === 'approved');
  const approved = store.pendingUploads[firstId] || {};
  check('submission status approved', approved.status === 'approved');
  check('reviewedAt recorded', !!approved.reviewedAt);
  check('reviewedBy recorded as the admin email', approved.reviewedBy === 'abc@gmail.com', `reviewedBy=${approved.reviewedBy}`);
  check('reward account created for the normalized email',
    !!store.reward_accounts.rahul_gmail_com && store.reward_accounts.rahul_gmail_com.points === 10,
    JSON.stringify(store.reward_accounts));
  check('reward account stores the normalized email', store.reward_accounts.rahul_gmail_com.email === 'rahul@gmail.com');
  check('pointsAwarded + pointsTransactionId set on the submission',
    approved.pointsAwarded === true && approved.pointsTransactionId === firstId);
  check('ledger entry created (type/amount/submissionId)',
    !!store.point_transactions[firstId]
    && store.point_transactions[firstId].type === 'PYQ_UPLOAD_REWARD'
    && store.point_transactions[firstId].amount === 10
    && store.point_transactions[firstId].submissionId === firstId);

  // ── 7. Duplicate approval → still +10 ───────────────────────────────
  console.log('\n8. Duplicate approval protection');
  await aw.approveSubmission(firstId);
  await aw.approveSubmission(firstId);
  await wait(80);
  check('second + third approval add 0 points', store.reward_accounts.rahul_gmail_com.points === 10,
    `points=${store.reward_accounts.rahul_gmail_com.points}`);
  check('exactly ONE ledger entry exists for the submission',
    Object.keys(store.point_transactions).filter((id) => store.point_transactions[id].submissionId === firstId).length === 1);
  check('status stays approved', store.pendingUploads[firstId].status === 'approved');

  // ── 8. Reject → 0 points ────────────────────────────────────────────
  console.log('\n9. Reject → 0 points');
  fillUploadForm(pw, { name: 'Rahul Kumar', email: 'rahul@gmail.com', title: 'B.A. 2nd Sem Polity {2023-24}' });
  await waitFor(() => Object.keys(store.pendingUploads).length === 2);
  const rejectedId = Object.keys(store.pendingUploads).find((id) => id !== firstId);
  aw.loadPendingUploads();
  await waitFor(() => aw.document.querySelectorAll('[data-submission-id]').length === 2);
  aw.prompt = () => 'Wrong course';
  await aw.rejectSubmission(rejectedId);
  await waitFor(() => store.pendingUploads[rejectedId] && store.pendingUploads[rejectedId].status === 'rejected');
  const rejected = store.pendingUploads[rejectedId];
  check('status rejected', rejected.status === 'rejected');
  check('reviewedAt + reviewedBy recorded', !!rejected.reviewedAt && rejected.reviewedBy === 'abc@gmail.com');
  check('rejection reason stored', rejected.rejectionReason === 'Wrong course', `reason=${rejected.rejectionReason}`);
  check('no points awarded for a rejected submission',
    store.reward_accounts.rahul_gmail_com.points === 10 && !store.point_transactions[rejectedId]);
  await aw.rejectSubmission(firstId);
  check('an already-rewarded submission cannot be downgraded to rejected',
    store.pendingUploads[firstId].status === 'approved' && store.reward_accounts.rahul_gmail_com.points === 10);

  // ── 9. Multiple submissions + capitalization variants ───────────────
  console.log('\n10. Multiple approvals + email case variants');
  const extraEmails = ['RAHUL@GMAIL.COM', ' rahul@Gmail.com '];
  const extraIds = [];
  for (const email of extraEmails) {
    fillUploadForm(pw, { name: 'Rahul Kumar', email, title: `B.A. ${extraIds.length + 3}rd Sem Paper` });
    const ok = await waitFor(() => Object.keys(store.pendingUploads).length === 3 + extraIds.length);
    if (!ok) break;
    extraIds.push(Object.keys(store.pendingUploads).filter((id) => !extraIds.includes(id) && id !== firstId && id !== rejectedId)[0]);
  }
  check('two more submissions created with mixed-case emails', extraIds.length === 2 && extraIds.every(Boolean));
  aw.loadPendingUploads();
  await waitFor(() => aw.document.querySelectorAll('[data-submission-id]').length >= 3);
  for (const id of extraIds) {
    await aw.approveSubmission(id);
    await waitFor(() => store.pendingUploads[id] && store.pendingUploads[id].status === 'approved');
  }
  check('3 approved submissions → 30 points total', store.reward_accounts.rahul_gmail_com.points === 30,
    `points=${store.reward_accounts.rahul_gmail_com.points}`);
  check('still exactly ONE reward account for the email (no duplicate bucket)',
    Object.keys(store.reward_accounts).length === 1, Object.keys(store.reward_accounts).join(','));
  check('3 ledger entries, one per submission', Object.keys(store.point_transactions).length === 3);
  check('ledger entries all carry the same normalized email',
    Object.keys(store.point_transactions).every((id) => store.point_transactions[id].email === 'rahul@gmail.com'));

  // ── 10. Existing registered user ────────────────────────────────────
  console.log('\n11. Existing registered user');
  store.users['uid-meera'] = { uid: 'uid-meera', email: 'meera@gmail.com', name: 'Meera', role: 'user' };
  fillUploadForm(pw, { name: 'Meera', email: 'Meera@gmail.com', title: 'B.Sc 1st Sem Maths {2024-25}' });
  await waitFor(() => Object.keys(store.pendingUploads).length === 5);
  const meeraId = Object.keys(store.pendingUploads).find((id) => store.pendingUploads[id].studentEmail === 'meera@gmail.com');
  aw.loadPendingUploads();
  await waitFor(() => aw.document.querySelectorAll('[data-submission-id]').length >= 4);
  await aw.approveSubmission(meeraId);
  await waitFor(() => store.reward_accounts.meera_gmail_com && store.reward_accounts.meera_gmail_com.points === 10);
  check('registered user gets a reward account keyed by their email',
    !!store.reward_accounts.meera_gmail_com);
  check('reward account linked to the existing Firebase uid',
    store.reward_accounts.meera_gmail_com.uid === 'uid-meera',
    `uid=${store.reward_accounts.meera_gmail_com.uid}`);
  check('ledger entry carries the uid', store.point_transactions[meeraId].uid === 'uid-meera');

  // ── 11. Unregistered contributor → later sign-up ────────────────────
  console.log('\n12. Unregistered contributor → later sign-up');
  check('unclaimed reward account has no uid',
    store.reward_accounts.rahul_gmail_com.uid === null
    || store.reward_accounts.rahul_gmail_com.uid === undefined,
    `uid=${store.reward_accounts.rahul_gmail_com.uid}`);
  await publicSite.auth.emit(makeUser('uid-rahul', 'Rahul@gmail.com'));
  const profileLoaded = await waitFor(() => {
    const el = pw.document.getElementById('profilePointsValue');
    return el && el.textContent === '30';
  });
  check('signing in with the same email shows the 30 pre-existing points', profileLoaded,
    `value=${pw.document.getElementById('profilePointsValue').textContent}`);
  check('reward history lists the contributions',
    pw.document.querySelectorAll('#profilePointsHistory .pyq-points-entry').length === 3);
  check('history shows +10 PYQ Contribution rows',
    /\+10/.test(pw.document.getElementById('profilePointsHistory').innerHTML)
    && /PYQ Contribution/.test(pw.document.getElementById('profilePointsHistory').innerHTML));
  await waitFor(() => store.reward_accounts.rahul_gmail_com.uid === 'uid-rahul');
  check('reward account is linked to the new uid (no points lost or reset)',
    store.reward_accounts.rahul_gmail_com.uid === 'uid-rahul'
    && store.reward_accounts.rahul_gmail_com.points === 30);

  // ── 12. Points cannot be written by the client ──────────────────────
  console.log('\n13. Client-side protection (rules)');
  check('reward_accounts writes are admin-only except a uid-only self link',
    /match \/reward_accounts\/\{accountKey\}/.test(rulesText)
    && /allow create, delete: if isAdminByEmail\(\);/.test(rulesText)
    && /affectedKeys\(\)\.hasOnly\(\['uid'\]\)/.test(rulesText));
  check('point_transactions are admin-write / owner-read',
    /match \/point_transactions\/\{transactionId\}/.test(rulesText)
    && /allow create, update, delete: if isAdminByEmail\(\);/.test(rulesText));
  check('public submission create cannot set points or review fields',
    /!\('pointsAwarded' in request\.resource\.data\)/.test(rulesText)
    && /!\('pointsTransactionId' in request\.resource\.data\)/.test(rulesText)
    && /!\('reviewedBy' in request\.resource\.data\)/.test(rulesText));
  check('public submission create is locked to status pending',
    /request\.resource\.data\.status == 'pending'/.test(rulesText));
  check('reward emails are compared normalized (trim + lowercase)',
    /function normalizedEmail\(value\) \{\s*return value\.trim\(\)\.lower\(\);/.test(rulesText));
  check('published PYQ publishing rules are untouched',
    /match \/pyqs\/\{doc\} \{[\s\S]*allow create, delete: if isAdminByEmail\(\);/.test(rulesText));

  // The Firestore rules engine needs a JVM (not available in this sandbox), so
  // the rules are lint-checked here instead of compiled: the two things that
  // actually break a deploy are unbalanced braces and an undeclared function.
  const bracesBalanced = (() => {
    let depth = 0;
    for (const ch of rulesText) {
      if (ch === '{') depth += 1;
      if (ch === '}') depth -= 1;
      if (depth < 0) return false;
    }
    return depth === 0;
  })();
  check('firestore.rules braces are balanced', bracesBalanced);
  // Free functions are called bare; methods are called after a '.'.
  const stripped = rulesText
    .replace(/\/\/[^\n]*/g, '')
    .replace(/'[^']*'/g, "''")
    .replace(/"[^"]*"/g, '""');
  const declared = new Set([...stripped.matchAll(/function\s+([a-zA-Z0-9_]+)\s*\(/g)].map((m) => m[1]));
  const called = new Set([...stripped.matchAll(/(^|[^.\w])([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/g)].map((m) => m[2]));
  const builtins = new Set(['match', 'service', 'allow', 'read', 'write', 'create', 'update', 'delete', 'get', 'list', 'function']);
  const missing = [...called].filter((name) => !declared.has(name) && !builtins.has(name));
  check('every rule function called is declared', missing.length === 0, missing.join(', '));
  check('new reward collections are matched before the deny-all catch-all',
    rulesText.indexOf('match /reward_accounts/') < rulesText.indexOf('match /{document=**}')
    && rulesText.indexOf('match /point_transactions/') < rulesText.indexOf('match /{document=**}'));
  check('rules still carry the admin-email TODO placeholder note',
    /replace with your real admin email/.test(rulesText));

  // ── 13. Existing behaviour still works ──────────────────────────────
  console.log('\n14. Existing workflow intact');
  check('upload form still has the original fields',
    ['uploadTitle', 'uploadName', 'uploadCourse', 'uploadSemester', 'uploadFile']
      .every((id) => !!pw.document.getElementById(id)));
  check('admin sections still present (pyqs/users/contributors/feedback)',
    ['pyqsList', 'pendingUploadsList', 'contributorsList', 'feedbackList']
      .every((id) => !!aw.document.getElementById(id)));
  check('public PYQ browse still reads through the Worker API',
    publicSite.requestedUrls.some((href) => /\/api\/(pyqs|homepage)/.test(href)),
    publicSite.requestedUrls.join(' | ').slice(0, 120));
  check('admin status filter switches the queue (approved view has no Approve button)', (() => {
    aw.filterSubmissions('approved');
    const html = aw.document.getElementById('pendingUploadsList').innerHTML;
    return /submission-status-approved/.test(html) && !/approveSubmission\(/.test(html);
  })());
  const beforeThrottle = Object.keys(store.pendingUploads).length;
  fillUploadForm(pw, { name: 'Spam Bot', email: 'spam@gmail.com', title: 'Spam paper' }, false);
  await wait(200);
  check('upload throttling blocks an immediate second submission',
    Object.keys(store.pendingUploads).length === beforeThrottle,
    `docs=${Object.keys(store.pendingUploads).length} before=${beforeThrottle}`);

  console.log(`\nResults: ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})().catch((err) => {
  console.error('\n💥 Test crashed:', err);
  process.exit(1);
});
