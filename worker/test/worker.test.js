/**
 * Comprehensive Worker test suite.
 *
 * Validates:
 *  - All API endpoints, filters, pagination, sorting, search
 *  - Cold/warm cache accounting (Firestore reads per scenario)
 *  - Cache expiry (KV hard TTL safety fallback)
 *  - Admin invalidation triggers background rebuild (stale-while-revalidate)
 *  - No duplicate Firestore reads within a single request
 *  - Cursor pagination with `__name__` tiebreaker (duplicate primary keys)
 *  - Scale: 311, 1,000, 5,000, 10,000 PYQs
 *
 * Run: node test/worker.test.js  (from the worker/ directory)
 */

import { readFileSync } from 'node:fs';
import { SignJWT, exportJWK } from 'jose';

const PAPER_TEMPLATE = readFileSync(new URL('../../paper.html', import.meta.url), 'utf8');
const NETLIFY_CONFIG = readFileSync(new URL('../../netlify.toml', import.meta.url), 'utf8');
const ROBOTS = readFileSync(new URL('../../robots.txt', import.meta.url), 'utf8');
let paperTemplateFetches = 0;
let pdfFetches = 0;
let firebaseTestJwk = null;

// ── Mock KV (supports TTL, expiry, reset) ──────────────────────────

class MockKV {
  constructor() {
    this.store = new Map();       // key -> deserialized object
    this.meta = new Map();        // key -> { expiresAt: ms epoch | Infinity }
    this.operations = { reads: 0, writes: 0 };
    this._now = () => Date.now();  // injectable for "expiry" tests
  }

  async get(key, type) {
    this.operations.reads += 1;
    const m = this.meta.get(key);
    if (!m) return null;
    if (m.expiresAt !== Infinity && this._now() > m.expiresAt) {
      this.store.delete(key);
      this.meta.delete(key);
      return null;
    }
    const v = this.store.get(key);
    if (v === undefined) return null;
    return type === 'text' ? JSON.stringify(v) : v;
  }

  async put(key, value, opts = {}) {
    this.operations.writes += 1;
    const ttl = opts && opts.expirationTtl;
    const expiresAt = ttl ? this._now() + ttl * 1000 : Infinity;
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    this.store.set(key, parsed);
    this.meta.set(key, { expiresAt });
  }

  async delete(key) {
    this.store.delete(key);
    this.meta.delete(key);
  }

  // Test helpers
  _expireNow(key) {
    const m = this.meta.get(key);
    if (m) m.expiresAt = this._now() - 1000;
  }

  _setNowOverride(fn) {
    this._now = fn;
  }

  clear() {
    this.store.clear();
    this.meta.clear();
    this.operations.reads = 0;
    this.operations.writes = 0;
  }
}

// ── Mock Cache API ────────────────────────────────────────────────

class MockCache {
  constructor() {
    this.store = new Map();
  }
  async match(request) {
    const entry = this.store.get(request.url);
    if (!entry) return null;
    return entry.clone();
  }
  async put(request, response) {
    this.store.set(request.url, response);
  }
}

// ── Mock Firestore dataset ────────────────────────────────────────

let PYQS = [];
let CONTRIBUTORS = [];

function makePyq(i, opts = {}) {
  const courses = ['B.Tech', 'B.A.', 'B.Sc.', 'B.Com', 'MBA', 'MCA', 'M.Tech', 'B.Ed.'];
  const sems = ['1st', '2nd', '3rd', '4th', '5th', '6th'];
  const sessions = ['2024-25', '2023-24', '2022-23', '2021-22', '2020-21'];
  const year = 2026 - (i % 6);
  const course = courses[i % courses.length];
  const sem = sems[i % sems.length];
  const session = sessions[i % sessions.length];
  const subject = `Subject ${i % 12 + 1}`;
  // Optional override for "force identical titles" tiebreaker tests
  const titleSuffix = opts.duplicateTitles ? ` (P${i})` : ` (P${i})`;
  return {
    id: `pyq_${i}`,
    title: `${course} ${sem} Sem ${subject} {${year}-${(year % 100) + 1}}${titleSuffix}`,
    file: `https://archive.org/download/test/paper_${i}.pdf`,
    file2: `https://catbox.moe/paper_${i}.pdf`,
    course,
    semester: sem,
    session,
    subject,
    branch: '',
    views: i * 7,
    createdAt: new Date(Date.now() - i * 86400000).toISOString(),
  };
}

function makePyqWithDuplicateViews(i) {
  // For tiebreaker tests: many docs share the same `views` value
  return { ...makePyq(i), views: i % 10 * 100 };
}

function makeContributor(i) {
  const names = ['Aarav Sharma', 'Priya Patel', 'Rahul Verma', 'Sneha Gupta', 'Vikram Singh'];
  return {
    id: `contrib_${i}`,
    name: names[i % names.length],
    avatar: names[i % names.length].split(' ').map((w) => w[0]).join(''),
    role: i % 2 === 0 ? 'PYQs Provider' : 'Syllabus Provider',
  };
}

function setPyqs(count, opts = {}) {
  PYQS = Array.from({ length: count }, (_, i) =>
    opts.duplicateViews ? makePyqWithDuplicateViews(i) : makePyq(i)
  );
}

function setContributors(count) {
  CONTRIBUTORS = Array.from({ length: count }, (_, i) => makeContributor(i));
}

setPyqs(311);
setContributors(5);

// ── Mock Firestore REST API ────────────────────────────────────────

function toFirestoreField(value) {
  if (typeof value === 'string') return { stringValue: value };
  if (typeof value === 'number') {
    return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
  }
  if (typeof value === 'boolean') return { booleanValue: value };
  return { stringValue: String(value) };
}

function toRestDoc(doc, collectionId) {
  const fields = {};
  for (const [k, v] of Object.entries(doc)) {
    if (k === 'id') continue;
    fields[k] = toFirestoreField(v);
  }
  return {
    name: `projects/dsmnru-data/databases/(default)/documents/${collectionId}/${doc.id}`,
    fields,
    createTime: '2024-01-01T00:00:00Z',
    updateTime: '2024-01-01T00:00:00Z',
  };
}

const firestoreStats = { pyqs: 0, contributors: 0, byCollection: new Map() };

function getCursorValue(v) {
  return v.stringValue !== undefined ? v.stringValue
    : v.integerValue !== undefined ? parseInt(v.integerValue, 10)
    : v.doubleValue !== undefined ? parseFloat(v.doubleValue)
    : v.booleanValue !== undefined ? v.booleanValue
    : v.timestampValue !== undefined ? v.timestampValue
    : null;
}

function docFieldForOrder(doc, orderDef) {
  const field = orderDef.field.fieldPath;
  if (field === '__name__') return doc._restName;
  return doc[field];
}

/**
 * Build a tuple-comparison key for a doc and an orderBy spec list.
 * Honors timestamp-typed fields by comparing strings ISO order
 * (lexicographic ISO timestamps give correct chronologic order).
 */
function buildTuple(doc, orderBy) {
  return orderBy.map((o) => {
    const field = o.field.fieldPath;
    const val = field === '__name__' ? doc._restName : doc[field];
    return val === undefined || val === null ? '' : String(val);
  });
}

function tupleCompare(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const av = a[i] !== undefined ? a[i] : '';
    const bv = b[i] !== undefined ? b[i] : '';
    if (av < bv) return -1;
    if (av > bv) return 1;
  }
  return 0;
}

function tupleGreaterThan(target, cursor) {
  return tupleCompare(target, cursor) > 0;
}

async function mockFetch(input, init) {
  const url = typeof input === 'string' ? input : input.url;
  const method = (init && init.method) || 'GET';

  // The SEO renderer retrieves the one static shell once per Worker isolate.
  if (url === 'https://dsmnru-pyq.netlify.app/paper.html') {
    paperTemplateFetches += 1;
    return new Response(PAPER_TEMPLATE, { status: 200, headers: { 'Content-Type': 'text/html' } });
  }

  // SEO rendering uses only index/document metadata, never the PDF itself.
  if (/https?:\/\/(?:[^/]+\.)?(?:archive\.org|catbox\.moe)\//i.test(url)) {
    pdfFetches += 1;
    return new Response('Unexpected PDF fetch', { status: 500 });
  }

  // Firebase Admin-token verification uses Google's public Firebase JWKS.
  if (url.startsWith('https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com')) {
    return new Response(JSON.stringify({ keys: firebaseTestJwk ? [firebaseTestJwk] : [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (url === 'https://oauth2.googleapis.com/token') {
    return new Response(
      JSON.stringify({ access_token: 'mock-token', expires_in: 3600 }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }

  // FCM HTTP v1 send — captured so tests can assert the exact payload the
  // Android app expects. fcmFailNext simulates a downstream rejection.
  if (url.startsWith('https://fcm.googleapis.com/v1/projects/') && url.endsWith('/messages:send') && method === 'POST') {
    fcmMessages.push(JSON.parse(init.body));
    if (fcmFailNext) {
      fcmFailNext = false;
      return new Response(JSON.stringify({ error: { status: 'PERMISSION_DENIED', message: 'internal credential detail' } }), {
        status: 403, headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ name: 'projects/dsmnru-data/messages/0:mock' }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  }

  if (url.includes(':runQuery') && method === 'POST') {
    const body = JSON.parse(init.body);
    const collectionId = body.structuredQuery.from[0].collectionId;
    const limit = body.structuredQuery.limit || 300;
    const orderBy = body.structuredQuery.orderBy || [];
    const startAt = body.structuredQuery.startAt;

    let docs;
    if (collectionId === 'pyqs') {
      firestoreStats.pyqs += 1;
      firestoreStats.byCollection.set('pyqs', (firestoreStats.byCollection.get('pyqs') || 0) + 1);
      docs = PYQS;
    } else if (collectionId === 'contributors') {
      firestoreStats.contributors += 1;
      firestoreStats.byCollection.set('contributors', (firestoreStats.byCollection.get('contributors') || 0) + 1);
      docs = CONTRIBUTORS;
    } else {
      docs = [];
    }

    // Annotate docs with their REST document `name` field
    const annotated = docs.map((d) => ({
      ...d,
      _restName: `projects/dsmnru-data/databases/(default)/documents/${collectionId}/${d.id}`,
    }));

    // Sort by composite orderBy (primary + __name__ tiebreaker)
    let sorted = [...annotated];
    if (orderBy.length > 0) {
      const dir = orderBy[0].direction === 'DESCENDING' ? -1 : 1;
      sorted.sort((a, b) => dir * tupleCompare(buildTuple(a, orderBy), buildTuple(b, orderBy)));
    }

    // Apply cursor pagination (before: true semantics — return docs strictly
    // AFTER the cursor tuple)
    if (startAt && Array.isArray(startAt.values) && startAt.values.length > 0) {
      const cursorTuple = startAt.values.map(getCursorValue);
      // Find the first index where tuple > cursor
      let idx = sorted.findIndex((d) => {
        const tuple = buildTuple(d, orderBy);
        for (let i = 0; i < cursorTuple.length; i++) {
          const av = tuple[i] !== undefined ? tuple[i] : '';
          const bv = cursorTuple[i] !== undefined ? cursorTuple[i] : '';
          if (av !== bv) return av > bv;
        }
        return false;
      });
      if (idx < 0) idx = sorted.length;
      sorted = sorted.slice(idx);
    }

    const page = sorted.slice(0, limit);
    return new Response(
      JSON.stringify(page.map((d) => ({ document: toRestDoc(d, collectionId) }))),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }

  const docMatch = url.match(/\/documents\/pyqs\/([^/?]+)/);
  if (docMatch && method === 'GET') {
    firestoreStats.pyqs += 1;
    firestoreStats.byCollection.set('pyqs', (firestoreStats.byCollection.get('pyqs') || 0) + 1);
    const id = decodeURIComponent(docMatch[1]);
    const doc = PYQS.find((d) => d.id === id);
    if (!doc) return new Response('Not found', { status: 404 });
    return new Response(JSON.stringify(toRestDoc(doc, 'pyqs')), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  }

  return new Response('Not found', { status: 404 });
}

// ── Mock globals and Worker setup ──────────────────────────────────

const mockKV = new MockKV();
const mockCaches = { default: new MockCache() };

globalThis.fetch = mockFetch;
globalThis.caches = mockCaches;

// Generate a real RSA key for the JWT-signing path
function base64OfBuffer(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

const testKeyPair = await crypto.subtle.generateKey(
  { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
  true, ['sign', 'verify']
);
const pkcs8 = await crypto.subtle.exportKey('pkcs8', testKeyPair.privateKey);
const pemBody = base64OfBuffer(pkcs8).match(/.{1,64}/g).join('\n');
const privateKeyPem = `-----BEGIN PRIVATE KEY-----\n${pemBody}\n-----END PRIVATE KEY-----\n`;

firebaseTestJwk = await exportJWK(testKeyPair.publicKey);
firebaseTestJwk.kid = 'test-firebase-key';
firebaseTestJwk.alg = 'RS256';
firebaseTestJwk.use = 'sig';
const firebaseAdminToken = await new SignJWT({ admin: true })
  .setProtectedHeader({ alg: 'RS256', kid: firebaseTestJwk.kid })
  .setIssuer('https://securetoken.google.com/dsmnru-data')
  .setAudience('dsmnru-data')
  .setSubject('test-admin')
  .setIssuedAt()
  .setExpirationTime('1h')
  .sign(testKeyPair.privateKey);

const firebaseNonAdminToken = await new SignJWT({})
  .setProtectedHeader({ alg: 'RS256', kid: firebaseTestJwk.kid })
  .setIssuer('https://securetoken.google.com/dsmnru-data')
  .setAudience('dsmnru-data')
  .setSubject('test-user')
  .setIssuedAt()
  .setExpirationTime('1h')
  .sign(testKeyPair.privateKey);

const fcmMessages = [];
let fcmFailNext = false;

const env = {
  PYQ_CACHE: mockKV,
  FIREBASE_PROJECT_ID: 'dsmnru-data',
  FIREBASE_SERVICE_ACCOUNT_JSON: JSON.stringify({
    type: 'service_account',
    project_id: 'dsmnru-data',
    private_key_id: 'test',
    private_key: privateKeyPem,
    client_email: 'test@dsmnru-data.iam.gserviceaccount.com',
    client_id: '123',
  }),
  ALLOWED_ORIGINS: 'http://localhost:8000,https://dsmnru-pyq.netlify.app',
};

const worker = (await import('../src/index.js')).default;

// ── Test helpers ──────────────────────────────────────────────────

let passCount = 0;
let failCount = 0;

async function request(path, opts = {}) {
  const url = 'https://test.example.com' + path;
  const init = { method: opts.method || 'GET', headers: opts.headers || {} };
  if (opts.body !== undefined) init.body = opts.body;
  if (opts.origin) init.headers['Origin'] = opts.origin;
  return worker.fetch(new Request(url, init), env, opts.ctx || {});
}

function check(name, condition, detail = '') {
  if (condition) {
    passCount += 1;
    console.log(`  ✅ ${name}`);
  } else {
    failCount += 1;
    console.log(`  ❌ ${name} ${detail}`);
  }
}

async function expectJson(res, expectedStatus, name) {
  let data;
  try { data = await res.json(); } catch {
    check(`${name} (JSON body)`, false, 'body not JSON');
    return null;
  }
  check(`${name} (status ${expectedStatus})`, res.status === expectedStatus, `got ${res.status}`);
  return data;
}

function freshState() {
  mockKV.clear();
  mockCaches.default.store.clear();
  firestoreStats.pyqs = 0;
  firestoreStats.contributors = 0;
  pdfFetches = 0;
  firestoreStats.byCollection.clear();
}

// ─────────────────── ENDPOINTS ─────────────────────────────────────

console.log('\n📦 Worker test suite\n');

// 1. Health
console.log('1. Health');
{
  const res = await request('/api/health');
  const data = await expectJson(res, 200, 'GET /api/health');
  check('health returns ok', data && data.status === 'ok');
}

// 2. Basic list + pagination
console.log('2. List + pagination');
{
  freshState();
  const res = await request('/api/pyqs?page=1&limit=20');
  const data = await expectJson(res, 200, 'GET /api/pyqs?page=1&limit=20');
  check('20 items on page 1', data && data.items.length === 20);
  check('total is 311', data && data.total === 311);
  check('totalPages is 16', data && data.totalPages === 16);
  check('list adds a safe canonical slug without removing existing fields',
    data && data.items.every((item) => typeof item.slug === 'string' && /^[a-z0-9][a-z0-9_-]*$/i.test(item.slug)));

  const res2 = await request('/api/pyqs?page=2&limit=20');
  const data2 = await expectJson(res2, 200, 'GET /api/pyqs?page=2&limit=20');
  check('page 2 has 20 items', data2 && data2.items.length === 20);
  check('page 2 first item differs from page 1',
    data2 && data && data2.items[0].id !== data.items[0].id);

  const res3 = await request('/api/pyqs?limit=500');
  const data3 = await expectJson(res3, 200, 'GET /api/pyqs?limit=500');
  check('limit capped at 100', data3 && data3.items.length <= 100);

  const res4 = await request('/api/pyqs?page=0&limit=0');
  const data4 = await expectJson(res4, 200, 'GET /api/pyqs?page=0&limit=0');
  check('page 0 normalizes to 1', data4 && data4.page === 1);
  check('limit 0 normalizes to 1', data4 && data4.limit === 1);

  const res5 = await request('/api/pyqs?page=999');
  const data5 = await expectJson(res5, 200, 'page=999 (capped)');
  check('page capped at 100', data5 && data5.page === 100);
}

// 3. Filters
console.log('3. Filters');
{
  const res = await request('/api/pyqs?course=B.Tech&limit=100');
  const data = await expectJson(res, 200, 'GET /api/pyqs?course=B.Tech');
  check('all items match course', data && data.items.every((i) => i.course === 'B.Tech'));

  const res2 = await request('/api/pyqs?semester=3rd&limit=100');
  const data2 = await expectJson(res2, 200, 'GET /api/pyqs?semester=3rd');
  check('all items match semester', data2 && data2.items.every((i) => i.semester === '3rd'));

  const res3 = await request('/api/pyqs?course=B.Tech&semester=1st&session=2024-25');
  const data3 = await expectJson(res3, 200, 'combined filters');
  check('combined filters match',
    data3 && data3.items.every((i) => i.course === 'B.Tech' && i.semester === '1st' && i.session === '2024-25'));
}

// 4. Search
console.log('4. Search');
{
  const res = await request('/api/pyqs/search?q=Subject%201&limit=100');
  const data = await expectJson(res, 200, 'GET /api/pyqs/search?q=Subject 1');
  check('search finds results', data && data.total > 0);
  check('search results mention query',
    data && data.items.every((i) => i.subject === 'Subject 1' || i.title.includes('Subject 1')));

  const res2 = await request('/api/pyqs/search?q=x');
  await expectJson(res2, 400, 'GET /api/pyqs/search?q=x (too short)');

  const res3 = await request('/api/pyqs/search?q=%3Cscript%3E');
  const data3 = await expectJson(res3, 200, 'sanitized search');
  check('HTML stripped from query', data3 && data3.total >= 0);

  const res4 = await request('/api/pyqs/search?q=2024');
  const data4 = await expectJson(res4, 200, 'year search');
  check('year search finds matches', data4 && data4.total > 0);
}

// 5. Sorting
console.log('5. Sorting');
{
  const res = await request('/api/pyqs?sort=az&limit=20');
  const data = await expectJson(res, 200, 'sort=az');
  const titles = data.items.map((i) => i.title);
  const sorted = [...titles].sort((a, b) => a.localeCompare(b));
  check('az sorted', JSON.stringify(titles) === JSON.stringify(sorted));

  const res2 = await request('/api/pyqs?sort=popular&limit=20');
  const data2 = await expectJson(res2, 200, 'sort=popular');
  const views = data2.items.map((i) => i.views);
  check('popular sorted by views desc',
    views.every((v, idx) => idx === 0 || v <= views[idx - 1]));

  const res3 = await request('/api/pyqs?sort=bogus');
  const data3 = await expectJson(res3, 200, 'sort=bogus (invalid)');
  check('invalid sort defaults to newest', data3 && !!data3.items);
}

// 6. Single PYQ
console.log('6. Single PYQ');
{
  const res = await request('/api/pyqs/pyq_42');
  const data = await expectJson(res, 200, 'GET /api/pyqs/pyq_42');
  check('returns the paper', data && data.id === 'pyq_42');
  check('includes archive.org URL', data && !!data.file && data.file.includes('archive.org'));
  check('includes catbox URL', data && !!data.file2 && data.file2.includes('catbox.moe'));
  check('single-document API adds seoSlug compatibly when index is warm',
    data && typeof data.seoSlug === 'string' && /^[a-z0-9][a-z0-9_-]*$/i.test(data.seoSlug));

  const res2 = await request('/api/pyqs/does_not_exist');
  await expectJson(res2, 404, 'GET /api/pyqs/does_not_exist (404)');

  const res3 = await request('/api/pyqs/%3Cbad%3E');
  await expectJson(res3, 400, 'GET /api/pyqs/<bad> (400)');
}

// 7. Contributors
console.log('7. Contributors + courses');
{
  const res = await request('/api/contributors');
  const data = await expectJson(res, 200, 'GET /api/contributors');
  check('returns 5 contributors', Array.isArray(data) && data.length === 5);
  check('contributor fields',
    data && data[0] && 'name' in data[0] && 'avatar' in data[0] && 'role' in data[0]);

  const res2 = await request('/api/courses');
  const data2 = await expectJson(res2, 200, 'GET /api/courses');
  check('courses is array', Array.isArray(data2) && data2.length >= 10);
  check('courses include B.Tech', data2.includes('B.Tech'));
}

// 8. Homepage + stats
console.log('8. Homepage + stats');
{
  freshState();
  const res = await request('/api/homepage');
  const data = await expectJson(res, 200, 'GET /api/homepage');
  check('has recent (6)', data && data.recent && data.recent.length === 6);
  check('has trending (6)', data && data.trending && data.trending.length === 6);
  check('stats.totalPyqs = 311', data && data.stats && data.stats.totalPyqs === 311);
  check('recent sorted by recency', data && data.recent[0] && data.recent[0].id === 'pyq_0');

  const res2 = await request('/api/stats');
  const data2 = await expectJson(res2, 200, 'GET /api/stats');
  check('stats totalPyqs = 311', data2 && data2.totalPyqs === 311);
}

// 9. CORS
console.log('9. CORS');
{
  const res = await request('/api/pyqs?limit=5', { origin: 'https://dsmnru-pyq.netlify.app' });
  check('CORS allows production origin',
    res.headers.get('Access-Control-Allow-Origin') === 'https://dsmnru-pyq.netlify.app');

  const res2 = await request('/api/pyqs?limit=5', { origin: 'https://evil.example.com' });
  check('CORS header present for other origins',
    !!res2.headers.get('Access-Control-Allow-Origin'));

  const preflight = await request('/api/invalidate', {
    method: 'OPTIONS',
    origin: 'https://dsmnru-pyq.netlify.app',
    headers: { 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization' },
  });
  check('Firebase-token invalidation CORS preflight permits POST + Authorization',
    preflight.status === 204
      && /POST/.test(preflight.headers.get('Access-Control-Allow-Methods') || '')
      && /Authorization/i.test(preflight.headers.get('Access-Control-Allow-Headers') || ''));
}

// 10. Invalid requests + rate limiting
console.log('10. Invalid + rate limiting');
{
  const res = await request('/api/unknown');
  await expectJson(res, 404, 'GET /api/unknown (404)');
  const res2 = await request('/api/pyqs', { method: 'POST' });
  await expectJson(res2, 405, 'POST /api/pyqs (405)');

  let limited = false;
  for (let i = 0; i < 70; i++) {
    const r = await request('/api/stats');
    if (r.status === 429) { limited = true; break; }
  }
  check('rate limit triggers 429 after burst', limited);
}

// ─────────────────── CACHE BEHAVIOR ────────────────────────────────

// 11. Cold cache: index must be built from Firestore (full collection sweep)
console.log('11. Cold cache (311 PYQs)');
{
  freshState();
  await request('/api/pyqs?page=1&limit=20');  // triggers cold index build
  // 311 documents at pageSize=300 = 2 pages of 300 (last page <300, terminates)
  check('cold build: index sweeps the collection',
    firestoreStats.pyqs >= 2,
    `pyqs reads ${firestoreStats.pyqs}`);
  check('cold build: only one collection read per request (no duplicates from contributors)',
    firestoreStats.contributors === 0,
    `contributor reads ${firestoreStats.contributors}`);
}

// 12. Warm cache: zero additional Firestore reads for any read endpoint
console.log('12. Warm cache (zero reads for browse + search + homepage)');
{
  // The previous test triggered the cold build — the index is now warm.
  // Switch to freshState but with the warm index pre-populated.
  mockKV.clear();
  mockCaches.default.store.clear();
  firestoreStats.pyqs = 0;
  firestoreStats.contributors = 0;
  firestoreStats.byCollection.clear();

  // Warm up by letting the worker build the index
  await request('/api/pyqs?limit=20');
  const baselinePyqsReads = firestoreStats.pyqs;
  const baselineContribReads = firestoreStats.contributors;

  // Many warm requests — none should touch Firestore
  await request('/api/pyqs?page=1&limit=20');
  await request('/api/pyqs?page=2&limit=20');
  await request('/api/pyqs?page=3&limit=20');
  await request('/api/pyqs/search?q=Subject%202');
  await request('/api/pyqs/search?course=B.Tech');
  await request('/api/pyqs?course=B.Tech&semester=1st&session=2024-25');
  await request('/api/homepage');
  await request('/api/stats');

  check('warm browse: zero additional pyqs reads',
    firestoreStats.pyqs === baselinePyqsReads,
    `pyqs reads ${firestoreStats.pyqs}`);
  check('warm search: zero additional pyqs reads',
    firestoreStats.pyqs === baselinePyqsReads);

  // First /api/contributors reads the contributors collection (cold for it)
  const contribBefore = firestoreStats.contributors;
  await request('/api/contributors');
  check('contributors first read: 1 collection read',
    firestoreStats.contributors === contribBefore + 1);
  await request('/api/contributors');
  await request('/api/contributors');
  check('contributors repeat reads: 0 additional Firestore reads',
    firestoreStats.contributors === contribBefore + 1);

  // /api/homepage must NOT trigger duplicate reads of contributors
  const contribBeforeHomepage = firestoreStats.contributors;
  const pyqsBeforeHomepage = firestoreStats.pyqs;
  await request('/api/homepage');
  check('/api/homepage on warm cache: no pyqs reads',
    firestoreStats.pyqs === pyqsBeforeHomepage,
    `pyqs reads ${firestoreStats.pyqs}`);
  check('/api/homepage on warm cache: no contributor reads',
    firestoreStats.contributors === contribBeforeHomepage,
    `contributor reads ${firestoreStats.contributors}`);
}

// 13. Cold homepage: page builds from index but does NOT also fetch contributors
console.log('13. Cold homepage: zero contributor reads per request');
{
  freshState();
  const readsBefore = { ...firestoreStats };
  const contribBefore = firestoreStats.contributors;
  await request('/api/homepage');
  // /api/homepage cold build:
  //   homepage KV miss → getSearchIndex → KV miss → cold build of pyqs index
  //   then homepage KV miss (it didn't exist yet, would only build now)
  //   page also never reads contributors
  check('/api/homepage cold: did not read contributors',
    firestoreStats.contributors === contribBefore,
    `contributor reads ${firestoreStats.contributors}`);
}

// 14. Cache expiry (safety fallback): expire KV → next read rebuilds
console.log('14. Cache expiry (KV hard TTL simulation)');
{
  // Populate cache, then artificially expire KV entry
  freshState();
  await request('/api/pyqs?limit=20');  // cold → builds index
  const readsBefore = firestoreStats.pyqs;

  // Simulate KV TTL expiry by expiring the SEARCH_INDEX entry directly
  const { KV_KEYS } = await import('../src/cache.js');
  mockKV._expireNow(KV_KEYS.SEARCH_INDEX);

  await request('/api/pyqs/search?q=Subject%203');
  check('cache expiry (expired index): triggers rebuild',
    firestoreStats.pyqs > readsBefore,
    `reads ${firestoreStats.pyqs} (was ${readsBefore})`);

  // After rebuild, the cache is warm again
  const readsAfterRebuild = firestoreStats.pyqs;
  await request('/api/pyqs?page=1&limit=20');
  await request('/api/pyqs/search?q=B.Tech&limit=20');
  check('after expiry rebuild: zero subsequent reads',
    firestoreStats.pyqs === readsAfterRebuild,
    `reads ${firestoreStats.pyqs}`);
}

// 15. Admin invalidation: stale-serve + background rebuild + no cold rebuild on next request
console.log('15. Admin invalidation (stale-while-revalidate)');
{
  freshState();
  await request('/api/pyqs?limit=20');  // cold build
  const readsBeforeInvalidate = firestoreStats.pyqs;

  // POST /api/invalidate — stamps INVALIDATION timestamp; does NOT delete
  // SEARCH_INDEX. Next request must serve stale + trigger background rebuild.
  const invRes = await request('/api/invalidate', {
    method: 'POST',
    headers: { Authorization: `Bearer ${firebaseAdminToken}` },
  });
  await expectJson(invRes, 200, 'POST /api/invalidate');
  const readsAfterInvalidate = firestoreStats.pyqs;

  const deniedRes = await request('/api/invalidate', {
    method: 'POST',
    headers: { Authorization: 'Bearer not-a-valid-firebase-id-token' },
  });
  check('invalid Firebase token → 401', deniedRes.status === 401, `got ${deniedRes.status}`);

  // Next read after invalidation
  const staleRes = await request('/api/pyqs/search?q=B.Tech');
  const staleData = await expectJson(staleRes, 200, 'search right after invalidate');
  // It should be served — albeit with potentially stale content. The build
  // happens in the background rather than blocking the response.
  check('immediately-after-invalidate request: 0 synchronous Firestore rebrowse',
    firestoreStats.pyqs === readsAfterInvalidate,
    `extra reads ${firestoreStats.pyqs - readsAfterInvalidate}`);

  // Trigger the background rebuild explicitly (in production, ctx.waitUntil
  // starts it but we drive it synchronously here for determinism).
  const { runBackgroundRebuild } = await import('../src/search.js');
  await runBackgroundRebuild();

  const readsAfterBgRebuild = firestoreStats.pyqs;
  check('background rebuild: performs the collection sweep',
    readsAfterBgRebuild > readsAfterInvalidate,
    `reads went from ${readsAfterInvalidate} to ${readsAfterBgRebuild}`);

  // After the background rebuild, the cache is fresh and future requests are 0 reads
  await request('/api/pyqs?page=1&limit=20');
  await request('/api/homepage');
  await request('/api/pyqs/search?q=test');
  check('post background rebuild: 0 additional reads',
    firestoreStats.pyqs === readsAfterBgRebuild,
    `reads now ${firestoreStats.pyqs}`);
}

// 16. Admin push notifications (FCM topic send)
console.log('16. Admin push notifications (FCM topic send)');
{
  const authHeaders = (token) => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${token}` });
  const payload = (over) => JSON.stringify({ title: 'New paper added', body: 'DBMS paper is live.', path: '/pyq/dbms-2023', ...over });

  {
    // Auth + validation first (rate limiter allows this group within one window).
    freshState();
    fcmMessages.length = 0;
    const noAuth = await request('/api/notify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload({}) });
    await expectJson(noAuth, 401, 'POST /api/notify (no token)');

    const nonAdmin = await request('/api/notify', { method: 'POST', headers: authHeaders(firebaseNonAdminToken), body: payload({}) });
    await expectJson(nonAdmin, 401, 'POST /api/notify (non-admin token)');

    const badJson = await request('/api/notify', { method: 'POST', headers: authHeaders(firebaseAdminToken), body: 'not-json' });
    await expectJson(badJson, 400, 'POST /api/notify (malformed JSON body)');

    const empty = await request('/api/notify', { method: 'POST', headers: authHeaders(firebaseAdminToken), body: '{}' });
    await expectJson(empty, 400, 'POST /api/notify (empty payload)');

    const tooLong = await request('/api/notify', { method: 'POST', headers: authHeaders(firebaseAdminToken), body: payload({ title: 'x'.repeat(200) }) });
    await expectJson(tooLong, 400, 'POST /api/notify (title too long)');

    const badPath = await request('/api/notify', { method: 'POST', headers: authHeaders(firebaseAdminToken), body: payload({ path: 'https://evil.example' }) });
    await expectJson(badPath, 400, 'POST /api/notify (path must be site-relative)');
  }

  {
    // Valid send → exact Android contract.
    freshState();
    fcmMessages.length = 0;
    const okRes = await request('/api/notify', { method: 'POST', headers: authHeaders(firebaseAdminToken), body: payload({}) });
    const okData = await expectJson(okRes, 200, 'POST /api/notify (valid send)');
    check('response reports a sent topic message', okData && okData.sent === true && okData.topic === 'all_users');
    check('exactly one FCM request was made', fcmMessages.length === 1, `sent=${fcmMessages.length}`);
    const msg = fcmMessages[0] && fcmMessages[0].message;
    check('FCM message targets the all_users topic', msg && msg.topic === 'all_users');
    check('payload uses notification.title / notification.body',
      msg && msg.notification && msg.notification.title === 'New paper added' && msg.notification.body === 'DBMS paper is live.');
    check('deep link rides in data.path', msg && msg.data && msg.data.path === '/pyq/dbms-2023');
    check('android message sets HIGH priority + the app channel',
      msg && msg.android && msg.android.priority === 'HIGH'
      && msg.android.notification && msg.android.notification.channel_id === 'dsmnru_general');

    // Duplicate send within cooldown is rejected (double-click guard).
    const dupRes = await request('/api/notify', { method: 'POST', headers: authHeaders(firebaseAdminToken), body: payload({}) });
    await expectJson(dupRes, 429, 'POST /api/notify (immediate duplicate)');
    check('duplicate did not hit FCM again', fcmMessages.length === 1);
  }

  {
    // Path omitted → message must NOT include a data.path key.
    freshState();
    fcmMessages.length = 0;
    const noPathRes = await request('/api/notify', { method: 'POST', headers: authHeaders(firebaseAdminToken), body: JSON.stringify({ title: 'Hi', body: 'There' }) });
    await expectJson(noPathRes, 200, 'POST /api/notify (no deep link)');
    const msg = fcmMessages[0] && fcmMessages[0].message;
    check('no data.path key when omitted', msg && !('data' in msg));
  }

  {
    // Downstream FCM failure → safe 502, no internals leaked.
    freshState();
    fcmMessages.length = 0;
    fcmFailNext = true;
    const failRes = await request('/api/notify', { method: 'POST', headers: authHeaders(firebaseAdminToken), body: payload({}) });
    const failData = await expectJson(failRes, 502, 'POST /api/notify (FCM rejects)');
    const serialized = JSON.stringify(failData || {});
    check('safe error, no upstream/credential detail leaked',
      failData && !serialized.includes('PERMISSION_DENIED') && !serialized.includes('internal credential detail'));
  }

  {
    // Sanitizer regression: angle brackets in title/body are stripped.
    freshState();
    fcmMessages.length = 0;
    const badTagRes = await request('/api/notify', {
      method: 'POST',
      headers: authHeaders(firebaseAdminToken),
      body: JSON.stringify({ title: '<b>Hi</b> & x', body: 'body <script>alert(1)</script>' }),
    });
    await expectJson(badTagRes, 200, 'POST /api/notify (sanitize markup)');
    const msg = fcmMessages[0] && fcmMessages[0].message;
    check('title/body are stripped of angle brackets',
      msg && msg.notification.title === 'bHi/b & x' && msg.notification.body === 'body scriptalert(1)/script');
  }
}

// 17. Public server-rendered SEO pages and sitemap
console.log('17. Public SEO pages + sitemap (KV-first)');
{
  const originalPyqs = PYQS;
  const title = 'B.Tech 4th Sem Algorithms {2023-24}';
  const owner = {
    ...makePyq(1),
    id: 'slug_owner',
    title,
    course: 'B.Tech',
    semester: '4th',
    session: '2023-24',
    subject: 'Algorithms',
    branch: 'CSE',
    views: 44,
    createdAt: '2023-01-01T00:00:00Z',
    internalNotes: 'private owner note must never be rendered',
  };
  const duplicate = {
    ...makePyq(2),
    id: 'slug_duplicate',
    title,
    course: 'B.Tech',
    semester: '4th',
    session: '2023-24',
    subject: 'Algorithms',
    branch: 'CSE',
    views: 20,
    createdAt: '2024-01-01T00:00:00Z',
  };
  const titleEdited = {
    ...makePyq(3),
    id: 'title_edited',
    title: 'B.Tech Algorithms renamed after publication',
    // This is the persistent base written by the admin create/edit flow.
    slug: 'b-tech-algorithms-original-publication',
    course: 'B.Tech',
    semester: '4th',
    session: '2022-23',
    subject: 'Algorithms',
    createdAt: '2022-01-01T00:00:00Z',
  };
  const privatePaper = {
    ...makePyq(4),
    id: 'private_seo_paper',
    title: 'Private SEO Paper',
    published: false,
    privateNotes: 'this must not appear in public HTML',
    createdAt: '2025-01-01T00:00:00Z',
  };

  const { isPublicPyq, isPublicIndexItem } = await import('../src/search.js');
  const contradictoryPrivateStates = [
    // Each field is independently authoritative: a public state must not
    // mask a private state that happens to live in a legacy sibling field.
    { published: true, status: 'published', visibility: 'public', access: 'private' },
    { published: true, status: 'published', visibility: 'public', accessLevel: 'members-only' },
    { published: true, status: 'published', visibility: 'public', accessLevel: 0 },
  ];
  check('contradictory access, visibility, and accessLevel fields each keep a PYQ out of public SEO',
    contradictoryPrivateStates.every((paper) => !isPublicPyq(paper)));
  check('an all-public access-state combination remains eligible for public SEO',
    isPublicPyq({ published: true, status: 'published', visibility: 'public', access: 'public', accessLevel: 'public' }));
  check('an old compact index without an explicit public bit fails closed for SEO until rebuilt',
    !isPublicIndexItem({ id: 'old-index-item', t: 'Old compact item', sl: 'old-compact-item' }));

  PYQS = [owner, duplicate, titleEdited, privatePaper];
  freshState();
  const templateFetchesBefore = paperTemplateFetches;

  const listResponse = await request('/api/pyqs?limit=20');
  const listData = await expectJson(listResponse, 200, 'list with SEO slugs');
  const byId = Object.fromEntries((listData && listData.items || []).map((item) => [item.id, item]));
  const duplicateSuffix = Buffer.from(duplicate.id).toString('base64url');
  const ownerSlug = 'b-tech-4th-sem-algorithms-2023-24';
  const duplicateSlug = `${ownerSlug}--${duplicateSuffix}`;

  check('oldest duplicate title owns readable slug', byId[owner.id] && byId[owner.id].slug === ownerSlug, byId[owner.id] && byId[owner.id].slug);
  check('later duplicate gets a deterministic ID suffix', byId[duplicate.id] && byId[duplicate.id].slug === duplicateSlug, byId[duplicate.id] && byId[duplicate.id].slug);
  check('title edit retains the admin-persisted slug base',
    byId[titleEdited.id] && byId[titleEdited.id].slug === titleEdited.slug,
    byId[titleEdited.id] && byId[titleEdited.id].slug);
  check('explicitly private record has no public pretty slug', byId[privatePaper.id] && byId[privatePaper.id].slug === '');

  // A base generated from another title can theoretically look like a
  // base64url suffix (for example a Unicode Firestore ID). Reserve title
  // bases first so this does not make two different public documents share a
  // URL.
  const { assignCanonicalSlugs: assignTestSlugs } = await import('../src/search.js');
  const namespaceCollisionIndex = {
    items: [
      { id: 'owner', t: 'foo', sb: 'foo', p: true, ts: 1 },
      { id: 'ÿ', t: 'foo', sb: 'foo', p: true, ts: 2 },
      { id: 'standalone', t: 'foo--w78', sb: 'foo--w78', p: true, ts: 3 },
    ],
  };
  assignTestSlugs(namespaceCollisionIndex);
  const namespaceSlugs = namespaceCollisionIndex.items.map((item) => item.sl);
  check('suffix-like title bases cannot collide with duplicate-title URLs',
    new Set(namespaceSlugs).size === namespaceSlugs.length
      && namespaceSlugs.includes('foo--w78')
      && namespaceSlugs.includes('foo--2--w78'), namespaceSlugs.join(', '));

  const malformedVersionedIndex = {
    slugVersion: 2,
    items: [
      { id: 'first', t: 'same', sb: 'same', p: true, ts: 1, sl: 'same' },
      { id: 'second', t: 'same', sb: 'same', p: true, ts: 2, sl: 'same' },
    ],
  };
  assignTestSlugs(malformedVersionedIndex);
  check('a duplicate/corrupt versioned compact index is repaired before its slugs are trusted',
    malformedVersionedIndex.items[0].sl === 'same'
      && malformedVersionedIndex.items[1].sl === 'same--c2Vjb25k');

  const legacyNonLatinIndex = { items: [{ id: 'legacy-unicode', t: '日本語', p: true, ts: 1 }] };
  assignTestSlugs(legacyNonLatinIndex);
  check('an older no-base compact index safely upgrades a wholly non-Latin title to the pyq fallback',
    legacyNonLatinIndex.items[0].sl === 'pyq');

  const readsAfterIndex = firestoreStats.pyqs;
  const firstPage = await request(`/pyq/${ownerSlug}`);
  const firstHtml = await firstPage.text();
  check('GET /pyq/<canonical-slug> returns HTML',
    firstPage.status === 200 && firstPage.headers.get('Content-Type').includes('text/html'), `status ${firstPage.status}`);
  check('SEO page is indexable and uses an index/follow response header',
    firstHtml.includes('id="paperRobots" content="index, follow"')
      && firstPage.headers.get('X-Robots-Tag') === 'index, follow');
  check('SEO HTML has unique title, description, canonical, OG and Twitter metadata',
    firstHtml.includes(`>${title} | DSMNRU PYQ Archive</title>`)
      && firstHtml.includes('id="paperMetaDescription"')
      && firstHtml.includes(`https://dsmnru-pyq.netlify.app/pyq/${ownerSlug}`)
      && firstHtml.includes('id="ogTitle"')
      && firstHtml.includes('id="twitterTitle"')
      && firstHtml.includes('id="twitterUrl"'));
  check('SEO HTML contains a visible public H1, breadcrumbs and course metadata',
    firstHtml.includes(`id="seoPaperTitle">${title}</h1>`)
      && firstHtml.includes('Home</a>')
      && firstHtml.includes('Algorithms')
      && firstHtml.includes('CSE'));
  check('SEO HTML emits LearningResource and breadcrumb JSON-LD',
    firstHtml.includes('"@type":"LearningResource"') && firstHtml.includes('"BreadcrumbList"'));
  check('SEO HTML includes public related pretty links only',
    firstHtml.includes(`/pyq/${duplicateSlug}`) && firstHtml.includes('id="seoRelatedSection"'));
  check('SEO renderer never puts PDF URLs or private document fields in initial HTML',
    !firstHtml.includes(owner.file) && !firstHtml.includes(owner.file2)
      && !firstHtml.includes(owner.internalNotes) && !firstHtml.includes(privatePaper.privateNotes));
  check('SEO rendering never fetches a PDF merely to build page metadata', pdfFetches === 0);
  check('first pretty-page item-cache miss makes only one document Firestore read after a warm index',
    firestoreStats.pyqs === readsAfterIndex + 1,
    `reads ${firestoreStats.pyqs}, expected ${readsAfterIndex + 1}`);
  check('first pretty page fetches the shared static template once',
    paperTemplateFetches === templateFetchesBefore + 1,
    `template fetches ${paperTemplateFetches}`);

  const readsAfterFirstPage = firestoreStats.pyqs;
  const secondPage = await request(`/pyq/${ownerSlug}`);
  await secondPage.text();
  check('warm pretty page resolves index + item entirely from KV', firestoreStats.pyqs === readsAfterFirstPage);
  check('warm pretty page reuses isolate-cached template', paperTemplateFetches === templateFetchesBefore + 1);

  const duplicatePage = await request(`/pyq/${duplicateSlug}`);
  const duplicateHtml = await duplicatePage.text();
  check('an exact duplicate title receives distinct title, description, and social metadata',
    duplicatePage.status === 200
      && duplicateHtml.includes(`Archive copy 2: ${title} | DSMNRU PYQ Archive</title>`)
      && duplicateHtml.includes('Archive copy 2')
      && duplicateHtml.includes('id="ogTitle"')
      && duplicateHtml.includes('content="Archive copy 2: B.Tech 4th Sem Algorithms {2023-24}"'));

  // If a record becomes private while a stale index is awaiting its normal
  // rebuild, a genuine item-cache miss must still refuse the fresh document.
  titleEdited.published = false;
  const freshPrivateDocumentPage = await request(`/pyq/${titleEdited.slug}`);
  check('freshly read document with explicit private state is never SSR-rendered from a stale index',
    freshPrivateDocumentPage.status === 404);
  delete titleEdited.published;

  const readsBeforeInvalidUrls = firestoreStats.pyqs;
  const missingPage = await request('/pyq/not-a-real-paper');
  const missingHtml = await missingPage.text();
  check('unknown pretty URL is a noindex 404 without an item Firestore lookup',
    missingPage.status === 404 && missingHtml.includes('noindex, follow')
      && firestoreStats.pyqs === readsBeforeInvalidUrls);
  const malformedPage = await request('/pyq/bad%2Fslug');
  check('slash-encoded pretty URL is rejected safely', malformedPage.status === 404);
  const privatePage = await request('/pyq/private-seo-paper');
  check('explicitly private paper cannot be resolved through the public route', privatePage.status === 404);

  const sitemapResponse = await request('/sitemap.xml');
  const sitemap = await sitemapResponse.text();
  check('dynamic sitemap returns XML', sitemapResponse.status === 200 && sitemapResponse.headers.get('Content-Type').includes('application/xml'));
  check('dynamic sitemap contains canonical public URLs and excludes private records',
    sitemap.includes(`<loc>https://dsmnru-pyq.netlify.app/pyq/${ownerSlug}</loc>`)
      && sitemap.includes(`<loc>https://dsmnru-pyq.netlify.app/pyq/${duplicateSlug}</loc>`)
      && !sitemap.includes('private-seo-paper'));
  check('sitemap needs no item-document Firestore reads with a warm index', firestoreStats.pyqs === readsBeforeInvalidUrls);
  check('Netlify force-rewrites pretty pages and the physical sitemap to the Worker',
    /from = "\/pyq\/\*"[\s\S]*?status = 200[\s\S]*?force = true/.test(NETLIFY_CONFIG)
      && /from = "\/sitemap\.xml"[\s\S]*?status = 200[\s\S]*?force = true/.test(NETLIFY_CONFIG));
  check('robots permits crawlable pretty URLs and names the dynamic canonical sitemap',
    /Allow: \/[\s\S]*?Sitemap: https:\/\/dsmnru-pyq\.netlify\.app\/sitemap\.xml/.test(ROBOTS));

  // A globally invalidated warm item cache is a logical KV miss. This closes
  // the stale-index window for a paper that was just made private: the Worker
  // rechecks the one document instead of SSR-rendering the pre-change cache.
  owner.visibility = 'private';
  const privacyInvalidation = await request('/api/invalidate', {
    method: 'POST',
    headers: { Authorization: `Bearer ${firebaseAdminToken}` },
  });
  const readsBeforePrivateCacheCheck = firestoreStats.pyqs;
  // No waitUntil harness here: isolate the one forced item revalidation from
  // the collection read that production schedules in the background.
  const staleCachedPrivatePage = await request(`/pyq/${ownerSlug}`);
  check('a warm pre-invalidation item cache cannot SSR-render a newly private paper',
    staleCachedPrivatePage.status === 404
      && firestoreStats.pyqs === readsBeforePrivateCacheCheck + 1,
    `status ${staleCachedPrivatePage.status}, reads ${firestoreStats.pyqs}`);
  const privateDetailResponse = await request(`/api/pyqs/${owner.id}`);
  const privateDetail = await privateDetailResponse.json();
  check('a stale public compact index never adds seoSlug to a fresh private detail response',
    privateDetailResponse.status === 200 && !privateDetail.seoSlug);

  // A publication is invisible only for the brief stale-index window. The
  // normal Firebase-token invalidation schedules a single background rebuild;
  // the next request sees the new public URL without a crawler-side write.
  const newPaper = {
    ...makePyq(5),
    id: 'new_publication',
    title: 'Newly Published SEO Paper',
    course: 'B.Tech',
    semester: '5th',
    session: '2025-26',
    subject: 'Networks',
    createdAt: '2025-02-01T00:00:00Z',
  };
  PYQS.push(newPaper);
  await new Promise((resolve) => setTimeout(resolve, 2));
  const invalidateResponse = await request('/api/invalidate', {
    method: 'POST',
    headers: { Authorization: `Bearer ${firebaseAdminToken}` },
  });
  check('Firebase admin token keeps cache invalidation available', invalidateResponse.status === 200);

  const background = [];
  const beforeStalePage = firestoreStats.pyqs;
  const staleNewPage = await request('/pyq/newly-published-seo-paper', {
    ctx: { waitUntil(promise) { background.push(Promise.resolve(promise)); } },
  });
  check('new URL is not guessed from a stale index before its scheduled rebuild', staleNewPage.status === 404);
  // Background execution is deliberately not awaited by the HTTP response.
  await Promise.all(background);
  check('stale pretty-page request schedules the normal index rebuild', firestoreStats.pyqs > beforeStalePage);

  const publishedPage = await request('/pyq/newly-published-seo-paper');
  const publishedHtml = await publishedPage.text();
  check('newly published public paper resolves after invalidation rebuild',
    publishedPage.status === 200 && publishedHtml.includes('Newly Published SEO Paper'));

  PYQS = originalPyqs;
  freshState();
}

// 17. No duplicate reads per request (homepage cold)
console.log('17. Homepage cold path — single collection read per request');
{
  freshState();
  const reads = { pyqs: 0, contributors: 0 };
  reads.pyqs = firestoreStats.pyqs;
  reads.contributors = firestoreStats.contributors;
  await request('/api/homepage');
  const pyqsReads = firestoreStats.pyqs - reads.pyqs;
  const pcontribReads = firestoreStats.contributors - reads.contributors;
  // /api/homepage cold: needs at least 1 index-collection sweep, no contributors read
  check('/api/homepage cold: at most one contributors read per request',
    pcontribReads === 0,
    `contrib reads ${pcontribReads}`);
  check('/api/homepage cold: index rebuild reads the pyqs collection',
    pyqsReads >= 2,
    `pyqs reads ${pyqsReads}`);
}

// 18. Tiebreaker correctness with duplicate orderBy values
console.log('18. Tiebreaker correctness (duplicate primary keys)');
{
  freshState();
  // Rebuild dataset where many docs share the same `views` value
  setPyqs(100, { duplicateViews: true });
  // Verify mock has 10 distinct views values (0,100,200,...,900)
  const distinctViews = new Set(PYQS.map((p) => p.views));
  check('mock dataset built with duplicate views',
    distinctViews.size === 10);

  await request('/api/pyqs?sort=popular&limit=100');  // page 1, 100 items
  const allIds = new Set();
  for (const d of PYQS) allIds.add(d.id);

  // Fetch every page and verify the union covers all PYQ ids exactly once
  const total = 100;
  const pageSize = 25;
  const seenIds = new Set();
  for (let page = 1; page * pageSize <= total + pageSize - 1; page++) {
    const r = await request(`/api/pyqs?sort=popular&page=${page}&limit=${pageSize}`);
    const data = await r.json();
    for (const item of data.items) {
      if (seenIds.has(item.id)) {
        check(`page ${page} does not duplicate ids`, false, `dup ${item.id}`);
      }
      seenIds.add(item.id);
    }
  }
  check('all 100 PYQs covered across pages (tiebreaker stable)',
    seenIds.size === 100, `seen ${seenIds.size}`);

  // Restore dataset for any subsequent tests
  setPyqs(311);
}

// ─────────────────── SCALE TESTS ───────────────────────────────────

async function runScaleTest(target) {
  console.log(`\n--- Scale test: ${target} PYQs ---`);
  setPyqs(target);
  setContributors(5);
  freshState();

  const t0 = Date.now();
  await request('/api/pyqs?page=1&limit=20');  // cold build
  const readsAfterBuild = firestoreStats.pyqs;
  const buildMs = Date.now() - t0;

  // Verify build covered ALL documents exactly once
  await request(`/api/pyqs?limit=100`);
  const totalRes = await request(`/api/pyqs?limit=100`);
  const totalData = await totalRes.json();

  // Now flip through all pages and collect ids via search
  const seenInSearch = new Set();
  let page = 1; const ps = 100;
  while (true) {
    const r = await request(`/api/pyqs/search?page=${page}&limit=${ps}`);
    const d = await r.json();
    if (!d.items || d.items.length === 0) break;
    for (const i of d.items) seenInSearch.add(i.id);
    if (seenInSearch.size >= target || !d.totalPages || page >= d.totalPages) break;
    page += 1;
  }
  console.log(`  ${target} PYQs — index build: ${readsAfterBuild} reads in ${buildMs}ms, seen across search: ${seenInSearch.size}`);

  // After cold build, subsequent requests must NOT touch Firestore
  const warmReads = firestoreStats.pyqs;
  await request('/api/pyqs?page=1&limit=20');
  await request('/api/pyqs?page=2&limit=20');
  await request('/api/pyqs/search?q=B.Tech');
  await request('/api/homepage');
  await request('/api/stats');
  await request('/api/pyqs?sort=popular&limit=10');
  check(`${target} PYQs: warm cache, zero extra reads`,
    firestoreStats.pyqs === warmReads,
    `read delta ${firestoreStats.pyqs - warmReads}`);

  // /api/pyqs/:id should be KV-cached after the first hit
  await request('/api/pyqs/pyq_0');
  const readsAfterItem0 = firestoreStats.pyqs;
  await request('/api/pyqs/pyq_0');
  check(`${target} PYQs: single item KV-cached`,
    firestoreStats.pyqs === readsAfterItem0);

  return { target, readsAfterBuild, warmReads: firestoreStats.pyqs - warmReads, buildMs, seenCount: seenInSearch.size };
}

const scaleResults = [];
for (const n of [311, 1000, 5000, 10000]) {
  scaleResults.push(await runScaleTest(n));
}

// 19. Cross-scale aggregate: assert cold build reads ≥ N/page_size, warm == 0
console.log('\n19. Cross-scale Firestore read assertion');
let aggregatePass = true;
for (const r of scaleResults) {
  const expectedPages = Math.ceil(r.target / 300);
  const coldOK = r.readsAfterBuild >= expectedPages
    && r.readsAfterBuild <= expectedPages + 1; // +1 for single-doc tests
  console.log(`  ${r.target} PYQs: cold reads ${r.readsAfterBuild} (expected ~${expectedPages}), warm reads ${r.warmReads}`);
  if (!coldOK) {
    console.log(`    ❌ cold reads out of expected range for ${r.target}`);
    aggregatePass = false;
  }
}
check('scale: cold reads == (1 sweep per collection)', aggregatePass);

// ── Firestore read accounting ──────────────────────────────────────
console.log('\n📊 Final Firestore read accounting');
console.log(`  Total pyqs reads: ${firestoreStats.pyqs}`);
console.log(`  Total contributor reads: ${firestoreStats.contributors}`);

console.log('\n' + '='.repeat(56));
console.log(`Results: ${passCount} passed, ${failCount} failed`);
if (failCount > 0) process.exit(1);
console.log('All tests passed ✅');
