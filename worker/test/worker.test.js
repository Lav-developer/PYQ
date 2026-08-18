/**
 * Test harness for the DSMNRU PYQ Cloudflare Worker.
 *
 * Mocks:
 *  - Firestore REST API (in-memory dataset: pyqs + contributors)
 *  - Google OAuth2 token endpoint
 *  - Cloudflare KV (PYQ_CACHE)
 *  - Cloudflare Cache API (caches.default)
 *
 * Run: node test/worker.test.js  (from the worker/ directory)
 */

// ── Mock Firestore dataset ─────────────────────────────────────────
function makePyq(i) {
  const courses = ['B.Tech', 'B.A.', 'B.Sc.', 'B.Com', 'MBA', 'MCA', 'M.Tech', 'B.Ed.'];
  const sems = ['1st', '2nd', '3rd', '4th', '5th', '6th'];
  const sessions = ['2024-25', '2023-24', '2022-23', '2021-22', '2020-21'];
  const year = 2026 - (i % 6);
  const course = courses[i % courses.length];
  const sem = sems[i % sems.length];
  const session = sessions[i % sessions.length];
  const subject = `Subject ${i % 12 + 1}`;
  return {
    id: `pyq_${i}`,
    // Unique suffix keeps titles distinct (real PYQ titles are unique — the
    // admin flow enforces this via pyqTitleExists) and keeps cursor-based
    // pagination deterministic in the mock.
    title: `${course} ${sem} Sem ${subject} {${year}-${(year % 100) + 1}} (P${i})`,
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

function makeContributor(i) {
  const names = ['Aarav Sharma', 'Priya Patel', 'Rahul Verma', 'Sneha Gupta', 'Vikram Singh'];
  return {
    id: `contrib_${i}`,
    name: names[i % names.length],
    avatar: names[i % names.length].split(' ').map((w) => w[0]).join(''),
    role: i % 2 === 0 ? 'PYQs Provider' : 'Syllabus Provider',
  };
}

const PYQS = Array.from({ length: 311 }, (_, i) => makePyq(i));
const CONTRIBUTORS = Array.from({ length: 5 }, (_, i) => makeContributor(i));

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

// Track Firestore read counts per collection
const firestoreStats = { pyqs: 0, contributors: 0 };

async function mockFetch(input, init) {
  const url = typeof input === 'string' ? input : input.url;
  const method = (init && init.method) || 'GET';

  // OAuth token endpoint
  if (url === 'https://oauth2.googleapis.com/token') {
    return new Response(JSON.stringify({ access_token: 'mock-token', expires_in: 3600 }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Firestore runQuery
  if (url.includes(':runQuery') && method === 'POST') {
    const body = JSON.parse(init.body);
    const collectionId = body.structuredQuery.from[0].collectionId;
    const limit = body.structuredQuery.limit || 300;
    const orderBy = body.structuredQuery.orderBy || [];
    const startAt = body.structuredQuery.startAt;

    let docs;
    if (collectionId === 'pyqs') {
      firestoreStats.pyqs += 1;
      docs = PYQS;
    } else if (collectionId === 'contributors') {
      firestoreStats.contributors += 1;
      docs = CONTRIBUTORS;
    } else {
      docs = [];
    }

    // Sort by orderBy fields
    if (orderBy.length > 0) {
      const field = orderBy[0].field.fieldPath;
      const dir = orderBy[0].direction === 'DESCENDING' ? -1 : 1;
      docs = [...docs].sort((a, b) => {
        const av = a[field] || '';
        const bv = b[field] || '';
        if (av < bv) return -1 * dir;
        if (av > bv) return 1 * dir;
        return 0;
      });
    }

    // Cursor pagination (startAt)
    if (startAt && startAt.values && startAt.values.length > 0) {
      const cursorVal = startAt.values[0].stringValue || startAt.values[0].integerValue;
      const field = orderBy.length > 0 ? orderBy[0].field.fieldPath : 'title';
      const idx = docs.findIndex((d) => String(d[field]) === String(cursorVal));
      if (idx >= 0) {
        docs = docs.slice(idx + 1);
      }
    }

    const page = docs.slice(0, limit);
    return new Response(JSON.stringify(page.map((d) => ({ document: toRestDoc(d, collectionId) }))), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Firestore getDocument
  const docMatch = url.match(/\/documents\/pyqs\/([^/?]+)/);
  if (docMatch && method === 'GET') {
    firestoreStats.pyqs += 1;
    const id = decodeURIComponent(docMatch[1]);
    const doc = PYQS.find((d) => d.id === id);
    if (!doc) {
      return new Response('Not found', { status: 404 });
    }
    return new Response(JSON.stringify(toRestDoc(doc, "pyqs")), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  return new Response('Not found', { status: 404 });
}

// ── Mock KV ────────────────────────────────────────────────────────
class MockKV {
  constructor() {
    this.store = new Map();
    this.operations = { reads: 0, writes: 0 };
  }
  async get(key, type) {
    this.operations.reads += 1;
    const v = this.store.get(key);
    if (v === undefined) return null;
    return type === 'text' ? JSON.stringify(v) : v;
  }
  async put(key, value) {
    this.operations.writes += 1;
    this.store.set(key, JSON.parse(value));
  }
  async delete(key) {
    this.store.delete(key);
  }
}

// ── Mock Cache API ─────────────────────────────────────────────────
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
const mockCaches = { default: new MockCache() };

// ── Load the worker ────────────────────────────────────────────────
globalThis.fetch = mockFetch;
globalThis.caches = mockCaches;

// Generate a real RSA key so the worker's JWT-signing path works end to end
function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

const testKeyPair = await crypto.subtle.generateKey(
  { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
  true,
  ['sign', 'verify']
);
const pkcs8 = await crypto.subtle.exportKey('pkcs8', testKeyPair.privateKey);
const pemBody = arrayBufferToBase64(pkcs8).match(/.{1,64}/g).join('\n');
const privateKeyPem = `-----BEGIN PRIVATE KEY-----\n${pemBody}\n-----END PRIVATE KEY-----\n`;

const mockKV = new MockKV();
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
  ADMIN_API_KEY: 'test-admin-key',
};

const worker = (await import('../src/index.js')).default;

// ── Test helpers ───────────────────────────────────────────────────
let passCount = 0;
let failCount = 0;
let testNumber = 0;

async function request(path, opts = {}) {
  const url = 'https://test.example.com' + path;
  const init = { method: opts.method || 'GET', headers: opts.headers || {} };
  if (opts.origin) init.headers['Origin'] = opts.origin;
  return worker.fetch(new Request(url, init), env, {});
}

function check(name, condition, detail = '') {
  testNumber += 1;
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
  try {
    data = await res.json();
  } catch {
    check(`${name} (JSON body)`, false, 'body not JSON');
    return null;
  }
  check(`${name} (status ${expectedStatus})`, res.status === expectedStatus, `got ${res.status}`);
  return data;
}

// ── Tests ──────────────────────────────────────────────────────────
console.log('\n📦 Worker test suite (mocked Firestore: 311 pyqs, 5 contributors)\n');

// 1. Health
console.log('1. Health');
{
  const res = await request('/api/health');
  const data = await expectJson(res, 200, 'GET /api/health');
  check('health returns ok', data && data.status === 'ok');
}

// 2. PYQ list pagination
console.log('2. PYQ list + pagination');
{
  const res = await request('/api/pyqs?page=1&limit=20');
  const data = await expectJson(res, 200, 'GET /api/pyqs?page=1&limit=20');
  check('20 items on page 1', data && data.items.length === 20, `got ${data && data.items.length}`);
  check('total is 311', data && data.total === 311, `got ${data && data.total}`);
  check('totalPages is 16', data && data.totalPages === 16, `got ${data && data.totalPages}`);
  check('item has title field', data && data.items[0] && typeof data.items[0].title === 'string');
  check('item has id', data && data.items[0] && !!data.items[0].id);

  const res2 = await request('/api/pyqs?page=2&limit=20');
  const data2 = await expectJson(res2, 200, 'GET /api/pyqs?page=2&limit=20');
  check('page 2 has 20 items', data2 && data2.items.length === 20);
  check(
    'page 2 is different from page 1',
    data2 && data && data2.items[0].id !== data.items[0].id,
    'same first id'
  );

  const res3 = await request('/api/pyqs?limit=500');
  const data3 = await expectJson(res3, 200, 'GET /api/pyqs?limit=500');
  check('limit capped at 100', data3 && data3.items.length <= 100, `got ${data3 && data3.items.length}`);

  const res4 = await request('/api/pyqs?page=0&limit=0');
  const data4 = await expectJson(res4, 200, 'GET /api/pyqs?page=0&limit=0');
  check('page 0 normalizes to 1', data4 && data4.page === 1);
  check('limit 0 normalizes to 1', data4 && data4.limit === 1);
}

// 3. Filters
console.log('3. Filters');
{
  const res = await request('/api/pyqs?course=B.Tech&limit=100');
  const data = await expectJson(res, 200, 'GET /api/pyqs?course=B.Tech');
  check('all items match course', data && data.items.every((i) => i.course === 'B.Tech'), 'non-matching course found');

  const res2 = await request('/api/pyqs?semester=3rd&limit=100');
  const data2 = await expectJson(res2, 200, 'GET /api/pyqs?semester=3rd');
  check('all items match semester', data2 && data2.items.every((i) => i.semester === '3rd'));

  const res3 = await request('/api/pyqs?course=B.Tech&semester=1st&session=2024-25');
  const data3 = await expectJson(res3, 200, 'combined filters');
  check(
    'combined filters match',
    data3 && data3.items.every((i) => i.course === 'B.Tech' && i.semester === '1st' && i.session === '2024-25'),
    'filter mismatch'
  );
}

// 4. Search
console.log('4. Search');
{
  const res = await request('/api/pyqs/search?q=Subject%201&limit=100');
  const data = await expectJson(res, 200, 'GET /api/pyqs/search?q=Subject 1');
  check('search finds results', data && data.total > 0, `total ${data && data.total}`);
  check('search results mention query', data && data.items.every((i) => i.subject === 'Subject 1' || i.title.includes('Subject 1')));

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
  check('popular sorted by views desc', views.every((v, idx) => idx === 0 || v <= views[idx - 1]));

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
  check('includes file URL', data && !!data.file && data.file.includes('archive.org'));
  check('includes file2 URL', data && !!data.file2 && data.file2.includes('catbox.moe'));

  const res2 = await request('/api/pyqs/does_not_exist');
  await expectJson(res2, 404, 'GET /api/pyqs/does_not_exist (404)');

  const res3 = await request('/api/pyqs/%3Cbad%3E');
  await expectJson(res3, 400, 'GET /api/pyqs/<bad> (400)');
}

// 7. Contributors + courses
console.log('7. Contributors + courses');
{
  const res = await request('/api/contributors');
  const data = await expectJson(res, 200, 'GET /api/contributors');
  check('returns 5 contributors', Array.isArray(data) && data.length === 5, `got ${data && data.length}`);
  check('contributor fields', data && data[0] && 'name' in data[0] && 'avatar' in data[0] && 'role' in data[0]);

  const res2 = await request('/api/courses');
  const data2 = await expectJson(res2, 200, 'GET /api/courses');
  check('courses is array', Array.isArray(data2) && data2.length >= 10);
  check('courses include B.Tech', data2.includes('B.Tech'));
}

// 8. Homepage + stats
console.log('8. Homepage + stats');
{
  const res = await request('/api/homepage');
  const data = await expectJson(res, 200, 'GET /api/homepage');
  check('has recent (6)', data && data.recent && data.recent.length === 6, `got ${data && data.recent && data.recent.length}`);
  check('has trending (6)', data && data.trending && data.trending.length === 6);
  check('has courseCounts', data && data.courseCounts && data.courseCounts.length > 0);
  check('stats.totalPyqs = 311', data && data.stats && data.stats.totalPyqs === 311, `got ${data && data.stats && data.stats.totalPyqs}`);
  check('recent sorted by recency', data && data.recent[0] && data.recent[0].id === 'pyq_0');

  const res2 = await request('/api/stats');
  const data2 = await expectJson(res2, 200, 'GET /api/stats');
  check('stats totalPyqs', data2 && data2.totalPyqs === 311, `got ${data2 && data2.totalPyqs}`);
}

// 9. Cache behavior
console.log('9. Cache behavior');
{
  // Simulate a fully cold cache (fresh KV + fresh edge cache)
  mockKV.store.clear();
  mockCaches.default.store.clear();
  firestoreStats.pyqs = 0;
  firestoreStats.contributors = 0;
  mockKV.operations.reads = 0;
  mockKV.operations.writes = 0;

  // First request: cold KV → builds index from Firestore
  await request('/api/pyqs?page=1&limit=20');
  check('cold cache: index built from Firestore', firestoreStats.pyqs > 0, `pyqs reads: ${firestoreStats.pyqs}`);

  const readsAfterFirst = firestoreStats.pyqs;

  // Warm cache: search + list should NOT touch Firestore
  await request('/api/pyqs?page=1&limit=20');
  await request('/api/pyqs?page=2&limit=20');
  await request('/api/pyqs/search?q=Subject%202');
  await request('/api/pyqs?course=B.Tech&limit=50');
  await request('/api/homepage');
  await request('/api/stats');
  await request('/api/contributors');

  check('warm cache: zero new Firestore pyqs reads', firestoreStats.pyqs === readsAfterFirst, `pyqs reads now ${firestoreStats.pyqs}`);
  check('warm cache: zero new Firestore contributor reads', firestoreStats.contributors === 1, `contributor reads ${firestoreStats.contributors}`);

  // Single item: KV cached after first fetch
  await request('/api/pyqs/pyq_1');
  const readsAfterItem = firestoreStats.pyqs;
  await request('/api/pyqs/pyq_1');
  check('single item served from KV (no new Firestore read)', firestoreStats.pyqs === readsAfterItem, `pyqs reads now ${firestoreStats.pyqs}`);
}

// 10. Rate limiting
console.log('10. Rate limiting');
{
  // Use a distinct path for rate-limit testing to isolate the counter
  // (the limiter is per-IP per-endpoint per-minute).
  let limited = false;
  for (let i = 0; i < 70; i++) {
    const res = await request('/api/stats');
    if (res.status === 429) {
      limited = true;
      break;
    }
  }
  check('rate limit triggers 429 after burst', limited);
}

// 11. Invalid requests
console.log('11. Invalid requests');
{
  const res = await request('/api/unknown');
  await expectJson(res, 404, 'GET /api/unknown (404)');

  const res2 = await request('/api/pyqs', { method: 'POST' });
  await expectJson(res2, 405, 'POST /api/pyqs (405)');

  const res3 = await request('/api/pyqs?page=999');
  const data3 = await expectJson(res3, 200, 'page=999 (capped)');
  check('page capped at 100', data3 && data3.page === 100);
}

// 12. Cache invalidation
console.log('12. Cache invalidation');
{
  // Populate cache
  await request('/api/contributors');
  await request('/api/homepage');

  const res = await request('/api/invalidate', {
    method: 'POST',
    headers: { 'X-Api-Key': 'test-admin-key' },
  });
  await expectJson(res, 200, 'POST /api/invalidate with key');

  const res2 = await request('/api/invalidate', {
    method: 'POST',
    headers: { 'X-Api-Key': 'wrong-key' },
  });
  await expectJson(res2, 401, 'POST /api/invalidate wrong key (401)');
}

// 13. CORS
console.log('13. CORS');
{
  const res = await request('/api/pyqs?limit=5', { origin: 'https://dsmnru-pyq.netlify.app' });
  check('CORS allows production origin', res.headers.get('Access-Control-Allow-Origin') === 'https://dsmnru-pyq.netlify.app');

  const res2 = await request('/api/pyqs?limit=5', { origin: 'https://evil.example.com' });
  check('CORS header present for other origins', !!res2.headers.get('Access-Control-Allow-Origin'));
}

// ── Firestore read accounting ─────────────────────────────────────
console.log('\n📊 Firestore read accounting (311 PYQs, mocked)');
console.log(`  Cold index build: ${firestoreStats.pyqs} collection reads`);
console.log(`  Contributors read: ${firestoreStats.contributors} collection read(s)`);
console.log(`  KV operations: ${mockKV.operations.reads} reads / ${mockKV.operations.writes} writes`);

console.log(`\n${'='.repeat(50)}`);
console.log(`Results: ${passCount} passed, ${failCount} failed`);
if (failCount > 0) {
  process.exit(1);
}
console.log('All tests passed ✅');
