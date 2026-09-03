/**
 * DSMNRU PYQ Android — unit tests for the v1.2 self-contained-app features:
 *
 *  - api.contributors(): ONE cached Worker request, SWR + persistence
 *  - auth.signInWithGoogleCredential(): Identity Toolkit accounts:signInWithIdp
 *    mapping (same Firebase project, google.com provider, nonce replay)
 *  - uploadcore.js: website-parity validation, reward-email normalization,
 *    client throttle, gofile URL, pendingUploads Firestore doc shape, JPEG
 *    dimension parsing, minimal-PDF assembly (xref correctness)
 *  - toolscore.js: CGPA/attendance/planner logic (website parity)
 *  - linkdata.js: every link is a genuinely-external https portal — none
 *    points at the DSMNRU PYQ website
 *  - WEBSITE-REDIRECT AUDIT: no navigation-to-website for normal app
 *    features (static analysis over every www/js module with a strict
 *    allowlist), per the self-containment requirement
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { createApi } from '../www/js/api.js';
import { createAuth, decodeJwtPayload } from '../www/js/auth.js';
import {
  normalizeRewardEmail, isValidRewardEmail, classifyFiles, validateUploadAttempt,
  readThrottleLog, getUploadThrottleState, recordUploadThrottle,
  UPLOAD_THROTTLE_MAX_PER_WINDOW, UPLOAD_THROTTLE_MIN_GAP_MS,
  fetchGofileUploadUrl, buildPendingUploadDoc, pendingUploadsUrl,
  jpegDimensions, assemblePdfFromJpegs, IMAGE_ENCODE_ATTEMPTS, MAX_FINAL_PDF_SIZE,
} from '../www/js/uploadcore.js';
import {
  GRADE_POINTS, computeGpa, gradeLabel,
  attendancePercent, attendanceMonthStats, attendanceSummary,
  plannerStats, sortPlannerTasks,
  loadPlannerTasks, savePlannerTasks, loadAttendance, saveAttendance,
} from '../www/js/toolscore.js';
import { LINK_CATEGORIES } from '../www/js/linkdata.js';

const here = dirname(fileURLToPath(import.meta.url));

function makeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    get length() { return map.size; },
    key(i) { return [...map.keys()][i] ?? null; },
    getItem(k) { return map.has(k) ? map.get(k) : null; },
    setItem(k, v) { map.set(k, String(v)); },
    removeItem(k) { map.delete(k); },
    _map: map,
  };
}

function makeFetch(handlers) {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    calls.push({ url: String(url), opts });
    if (opts.signal?.aborted) {
      const e = new Error('AbortError');
      e.name = 'AbortError';
      throw e;
    }
    for (const [pattern, fn] of handlers) {
      if (url.includes(pattern)) return fn(url, opts);
    }
    return { ok: false, status: 404, json: async () => ({ error: 'Not found' }) };
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

const jsonRes = (data, ok = true, status = 200) => async () => ({ ok, status, json: async () => data });

function makeJwt(payload) {
  const b64u = (s) => Buffer.from(s).toString('base64url');
  return b64u('{"alg":"none"}') + '.' + b64u(JSON.stringify(payload)) + '.sig';
}

// ── contributors: one request, cached + SWR ─────────────────────────────

test('contributors: one Worker request, 24h cache, offline-stale fallback', async () => {
  let hits = 0;
  let nowMs = 1_000_000;
  const storage = makeStorage();
  const fetchImpl = makeFetch([['/api/contributors', async () => {
    hits++;
    return { ok: true, status: 200, json: async () => [{ id: 'c1', name: 'Aarav', role: '10 papers' }] };
  }]]);
  const api = createApi({ fetchImpl, storage, now: () => nowMs });

  const first = await api.contributors();
  assert.equal(hits, 1);
  assert.deepEqual(first.data[0].name, 'Aarav');

  // Instant re-open (drawer → screen → back → screen) costs ZERO traffic.
  const second = await api.contributors();
  assert.equal(hits, 1);
  assert.equal(second.fromCache, true);

  // Past the fresh window → serve cache + exactly one background revalidate.
  nowMs += 25 * 60 * 60 * 1000;
  const third = await api.contributors();
  assert.equal(third.stale, true);
  await third.revalidating;
  assert.equal(hits, 2);

  // A brand-new client instance (app restart) restores the persisted list
  // instead of hitting the network when offline (still inside its TTL here).
  const offlineApi = createApi({
    fetchImpl: async () => { throw new TypeError('offline'); },
    storage, now: () => nowMs + 60_000,
  });
  const fourth = await offlineApi.contributors();
  assert.equal(fourth.fromCache, true, 'served from the persisted cache');
  assert.equal(fourth.stale, false, 'zero traffic while the payload is fresh — even offline');
  assert.equal(fourth.data.length, 1);

  // Same restart but past the TTL with the network down → stale, not an error.
  const offlineApi2 = createApi({
    fetchImpl: async () => { throw new TypeError('offline'); },
    storage, now: () => nowMs + 30 * 60 * 60 * 1000,
  });
  const fifth = await offlineApi2.contributors();
  assert.equal(fifth.fromCache, true);
  assert.equal(fifth.stale, true);
  assert.equal(fifth.data.length, 1);
});

// ── Google sign-in (native credential → same Firebase project) ──────────

test('signInWithGoogleCredential exchanges the Google ID token with accounts:signInWithIdp', async () => {
  const nowSec = Math.floor(Date.now() / 1000);
  const fbToken = makeJwt({
    exp: nowSec + 3600, user_id: 'g-uid-1', sub: 'g-uid-1',
    email: 'student@gmail.com', name: 'Google Student', email_verified: true,
    firebase: { sign_in_provider: 'google.com', identities: {} },
  });
  const bodies = [];
  const fetchImpl = makeFetch([
    ['accounts:signInWithIdp', async (url, opts) => {
      bodies.push(JSON.parse(opts.body));
      return { ok: true, status: 200, json: async () => ({
        idToken: fbToken, refreshToken: 'RT-G', expiresIn: '3600',
        federatedId: '1089', providerId: 'google.com',
      }) };
    }],
    ['firestore.googleapis.com', jsonRes({ fields: {} }, true, 200)],
  ]);
  const auth = createAuth({ storage: makeStorage(), fetchImpl, now: () => Date.now() });

  const user = await auth.signInWithGoogleCredential({ idToken: 'GOOGLE_ID_TOKEN', nonce: 'raw-nonce' });

  assert.equal(user.uid, 'g-uid-1');
  assert.equal(user.providerId, 'google.com');
  assert.equal(auth.isGoogle(), true, 'recognised as a Google account');
  assert.equal(auth.needsEmailVerification(), false, 'google.com skips the verification gate like the website');
  assert.equal(auth.canUnlockPrivileges(), true);

  assert.equal(bodies.length, 1, 'exactly one Identity Toolkit call');
  assert.match(bodies[0].postBody, /id_token=GOOGLE_ID_TOKEN/);
  assert.match(bodies[0].postBody, /providerId=google\.com/);
  assert.match(bodies[0].postBody, /nonce=raw-nonce/, 'raw nonce replayed for verification');
  assert.equal(bodies[0].requestUri, 'http://localhost');
  assert.equal(bodies[0].returnSecureToken, true);
  // Same user-doc sync as every other sign-in (1 owner-scoped lookup here).
  assert.ok(fetchImpl.calls.some((c) => c.url.includes('/documents/users/g-uid-1')));
});

test('signInWithGoogleCredential rejects without a credential and maps errors', async () => {
  const auth = createAuth({
    storage: makeStorage(),
    fetchImpl: makeFetch([
      ['accounts:signInWithIdp', jsonRes({ error: { message: 'INVALID_IDP_ID_TOKEN : 400' } }, false, 400)],
    ]),
    now: () => Date.now(),
  });
  await assert.rejects(auth.signInWithGoogleCredential({}), /credential/i);
  await assert.rejects(auth.signInWithGoogleCredential({ idToken: 'x' }), /Invalid|credential|request/i);
});

// ── uploadcore: validation / throttle / gofile / metadata ───────────────

const pdfFile = (sizeMB = 1) => ({ name: 'paper.pdf', type: 'application/pdf', size: sizeMB * 1024 * 1024 });
const imgFile = (name = 'photo.jpg') => ({ name, type: 'image/jpeg', size: 500_000 });

test('reward email normalization matches points.js (trim + lowercase)', () => {
  assert.equal(normalizeRewardEmail('  Rahul@GMAIL.Com '), 'rahul@gmail.com');
  assert.equal(isValidRewardEmail('rahul@gmail.com'), true);
  assert.equal(isValidRewardEmail('not-an-email'), false);
  assert.equal(isValidRewardEmail('a@b'), false);
  assert.equal(isValidRewardEmail('x'.repeat(161) + '@mail.com'), false, '160 char cap');
  assert.equal(isValidRewardEmail('x'.repeat(150) + '@mail.com'), true, '159 chars still valid');
});

test('classifyFiles buckets pdfs, images and unsupported files', () => {
  const { pdfs, images, unsupported } = classifyFiles([
    pdfFile(), imgFile(), imgFile('two.png'), { name: 'notes.txt', type: 'text/plain', size: 10 },
  ]);
  assert.equal(pdfs.length, 1);
  assert.equal(images.length, 2);
  assert.equal(unsupported.length, 1);
});

test('validateUploadAttempt mirrors the website validation messages exactly', () => {
  const base = { title: 'B.Tech DSA {2023}', studentName: 'Aarav', rawEmail: 'aarav@t.co' };
  ok(validateUploadAttempt({ ...base, files: [pdfFile()] }));
  ok(validateUploadAttempt({ ...base, files: [imgFile(), imgFile('b.jpg')] }));

  fails(validateUploadAttempt({ ...base, studentName: '', files: [pdfFile()] }), /enter your name/i);
  fails(validateUploadAttempt({ ...base, title: 'ab', files: [pdfFile()] }), /between 3 and 200/i);
  fails(validateUploadAttempt({ ...base, rawEmail: '', files: [pdfFile()] }), /credit your contribution points/i);
  fails(validateUploadAttempt({ ...base, rawEmail: 'bad@mail', files: [pdfFile()] }), /valid email/i);
  fails(validateUploadAttempt({ ...base, files: [] }), /select a PDF or images/i);
  fails(validateUploadAttempt({ ...base, files: [{ name: 'a.txt', type: 'text/plain', size: 5 }] }), /Only PDF or image files/i);
  fails(validateUploadAttempt({ ...base, files: [pdfFile(), pdfFile()] }), /only one PDF/i);
  fails(validateUploadAttempt({ ...base, files: [pdfFile(), imgFile()] }), /not both together/i);
  fails(validateUploadAttempt({ ...base, files: [pdfFile(11)] }), /10MB/i);

  const throttled = { allowed: false, message: 'Upload limit reached (5 per 6 hours). Try again in about 320 minutes.' };
  fails(validateUploadAttempt({ ...base, files: [pdfFile()], throttleState: throttled }), /Upload limit reached/i);

  function ok(r) { assert.equal(r.ok, true, JSON.stringify(r)); }
  function fails(r, re) { assert.equal(r.ok, false); assert.match(r.message, re); }
});

test('upload throttle: 45s gap and max 5 per 6h window (website parity)', () => {
  const storage = makeStorage();
  let now = 10_000_000;
  assert.equal(getUploadThrottleState(storage, now).allowed, true);

  for (let i = 0; i < UPLOAD_THROTTLE_MAX_PER_WINDOW; i++) {
    recordUploadThrottle(storage, now);
    now += UPLOAD_THROTTLE_MIN_GAP_MS + 1000;
  }
  const state = getUploadThrottleState(storage, now);
  assert.equal(state.allowed, false);
  assert.match(state.message, /limit reached/i);

  // Gap enforcement below the cap
  const s2 = makeStorage();
  recordUploadThrottle(s2, now);
  assert.equal(getUploadThrottleState(s2, now + UPLOAD_THROTTLE_MIN_GAP_MS - 1).allowed, false);
  assert.match(getUploadThrottleState(s2, now + UPLOAD_THROTTLE_MIN_GAP_MS - 1).message, /wait/i);
  assert.equal(getUploadThrottleState(s2, now + UPLOAD_THROTTLE_MIN_GAP_MS + 1).allowed, true);

  // Old entries age out of the window
  now += 7 * 60 * 60 * 1000;
  assert.equal(getUploadThrottleState(storage, now).allowed, true);
  assert.equal(readThrottleLog(storage, now).length, 0);
});

test('fetchGofileUploadUrl picks the first server (same service as the website)', async () => {
  const fetchImpl = makeFetch([['api.gofile.io/servers', jsonRes({
    status: 'ok', data: { servers: [{ name: 'store1' }, { name: 'store2' }] },
  })]]);
  assert.equal(await fetchGofileUploadUrl(fetchImpl), 'https://store1.gofile.io/uploadFile');

  await assert.rejects(
    fetchGofileUploadUrl(makeFetch([['api.gofile.io/servers', jsonRes({ status: 'error' })]])),
    /No upload servers available/,
  );
  await assert.rejects(
    fetchGofileUploadUrl(async () => ({ ok: false, status: 503, json: async () => ({}) })),
    /Failed to get upload server/,
  );
});

test('buildPendingUploadDoc matches the Firestore rules shape exactly', () => {
  const doc = buildPendingUploadDoc({
    title: 'B.Com Accounts {2022}',
    course: 'B.Com',
    semester: '3rd',
    studentName: 'Aarav',
    studentCourse: 'B.Com',
    studentEmail: 'aarav@t.co',
    userId: 'uid-1',
    fileName: 'paper.pdf',
    downloadUrl: 'https://store1.gofile.io/download/web/abc/paper.pdf',
    fileSize: 1234567,
    createdAtIso: '2026-09-03T00:00:00.000Z',
  });
  const f = doc.fields;
  assert.equal(f.title.stringValue, 'B.Com Accounts {2022}');
  assert.equal(f.studentEmail.stringValue, 'aarav@t.co');
  assert.equal(f.email.stringValue, 'aarav@t.co', 'email alias included like the website');
  assert.equal(f.userId.stringValue, 'uid-1');
  assert.equal(f.downloadUrl.stringValue, 'https://store1.gofile.io/download/web/abc/paper.pdf');
  assert.equal(f.fileSize.integerValue, '1234567');
  assert.equal(f.status.stringValue, 'pending');
  assert.equal(f.uploadedAt.timestampValue, '2026-09-03T00:00:00.000Z');
  // Review/points fields must NEVER be client-written (Firestore rules reject them).
  for (const banned of ['pointsAwarded', 'pointsTransactionId', 'pointsAmount', 'reviewedAt', 'reviewedBy', 'rejectionReason']) {
    assert.equal(banned in f, false, `${banned} must be absent`);
  }
  assert.match(pendingUploadsUrl(), /firestore\.googleapis\.com\/v1\/projects\/dsmnru-data\/databases\/\(default\)\/documents\/pendingUploads$/);
  assert.equal(MAX_FINAL_PDF_SIZE, 10 * 1024 * 1024);
  assert.equal(IMAGE_ENCODE_ATTEMPTS.length, 6, 'same quality ladder as the website');
});

// ── uploadcore: JPEG parsing + minimal PDF assembly ─────────────────────

function craftJpeg(width, height) {
  // SOF0 segment carrying the dimensions, wrapped in SOI/EOI.
  return new Uint8Array([
    0xFF, 0xD8,
    0xFF, 0xC0, 0x00, 0x11, 0x08,
    (height >> 8) & 0xFF, height & 0xFF,
    (width >> 8) & 0xFF, width & 0xFF,
    0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
    0xFF, 0xD9,
  ]);
}

test('jpegDimensions reads SOF0 dimensions', () => {
  const dims = jpegDimensions(craftJpeg(640, 480));
  assert.deepEqual(dims, { width: 640, height: 480 });
  assert.equal(jpegDimensions(new Uint8Array([1, 2, 3])), null);
  assert.equal(jpegDimensions(null), null);
});

test('assemblePdfFromJpegs writes a structurally valid PDF with correct xref offsets', () => {
  const pages = [
    { jpeg: craftJpeg(640, 480), width: 640, height: 480 },
    { jpeg: craftJpeg(800, 600), width: 800, height: 600 },
  ];
  const pdf = assemblePdfFromJpegs(pages);
  assert.equal(pdf[0], 0x25); // %
  assert.equal(pdf[1], 0x50); // P
  assert.equal(pdf[2], 0x44); // D
  assert.equal(pdf[3], 0x46); // F

  const text = Buffer.from(pdf).toString('latin1');
  assert.ok(text.includes('/Filter /DCTDecode'), 'jpegs embedded without re-encoding');
  assert.ok(text.includes('/Count 2'));
  assert.ok(text.includes('/MediaBox [0 0 595.28 841.89]'), 'A4 pages');
  assert.ok(text.trimEnd().endsWith('%%EOF'));

  // xref correctness: every offset must point at its object header.
  const startxref = Number(text.match(/startxref\n(\d+)\n%%EOF$/)[1]);
  assert.equal(text.slice(startxref, startxref + 4), 'xref', 'startxref points at the table');
  const offsets = [...text.matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
  assert.equal(offsets.length, 2 + pages.length * 3, 'catalog + pages-tree + (page/content/image) per page');
  for (const off of offsets) {
    const at = text.slice(off, off + 8);
    assert.match(at, /^\d+ 0 obj/, `offset ${off} lands on an object header, got: ${at}`);
  }
  assert.throws(() => assemblePdfFromJpegs([]), /No pages/);
});

// ── toolscore: CGPA / attendance / planner (website parity) ────────────

test('CGPA calculator: same grade map and credit-weighted math as the website', () => {
  assert.deepEqual(GRADE_POINTS, { O: 10, 'A+': 9, A: 8, 'B+': 7, B: 6, C: 5, D: 4, F: 0 });
  // Website example: grade points × credits / total credits
  const { totalCredits, totalPoints, gpa } = computeGpa([
    { grade: 'O', credits: 4 }, { grade: 'A', credits: 3 }, { grade: 'B+', credits: 3 },
  ]);
  assert.equal(totalCredits, 10);
  assert.equal(totalPoints, 10 * 4 + 8 * 3 + 7 * 3);
  assert.equal(gpa, 85 / 10);
  assert.equal(computeGpa([]).gpa, 0);
  assert.equal(computeGpa([{ grade: 'Z', credits: 3 }]).totalPoints, 0, 'unknown grade counts 0 like the site');
  assert.equal(computeGpa([{ grade: 'O', credits: 0 }]).totalCredits, 0, 'zero credits cannot divide');
  assert.equal(gradeLabel(9.4), 'Outstanding');
  assert.equal(gradeLabel(0), '—');
});

test('attendance math: month stats, overall percent and 75% warnings', () => {
  const records = { '2026-09-01': 'P', '2026-09-02': 'P', '2026-09-03': 'A', '2026-08-30': 'P' };
  assert.deepEqual(attendanceMonthStats(records, '2026-09'), { present: 2, total: 3, pct: 67 });
  assert.equal(attendancePercent(records), 75);
  assert.equal(attendanceMonthStats({}, '2026-09').total, 0);

  // Deterministic September-only records: first `present` days are P, rest A.
  const mk = (present, total) => {
    const r = {};
    for (let i = 0; i < total; i++) {
      r[`2026-09-${String(i + 1).padStart(2, '0')}`] = i < present ? 'P' : 'A';
    }
    return r;
  };
  const subjects = [
    { subject: 'DSA', records: mk(20, 20) },   // 100%
    { subject: 'OS', records: mk(9, 10) },     // 90%
    { subject: 'Maths', records: mk(7, 10) },  // 70% → low AND near (>= 70)
    { subject: 'DBMS', records: mk(21, 30) },  // 70% → low AND near
  ];
  const summary = attendanceSummary(subjects, { now: new Date('2026-09-15T10:00:00Z') });
  assert.equal(summary.subjects, 4);
  assert.equal(summary.low, 2);
  assert.equal(summary.near, 2);
});

test('planner stats and sorting: incomplete first, then by due date', () => {
  const tasks = [
    { id: 3, title: 'done later', due: '2026-10-01T10:00', completed: true },
    { id: 1, title: 'due sooner', due: '2026-09-20T09:00', completed: false },
    { id: 2, title: 'due later', due: '2026-09-25T09:00', completed: false },
    { id: 4, title: 'no date', due: null, completed: false },
  ];
  assert.deepEqual(plannerStats(tasks), { total: 4, completed: 1, pct: 25 });
  const order = sortPlannerTasks(tasks).map((t) => t.title);
  assert.deepEqual(order, ['due sooner', 'due later', 'no date', 'done later']);
  assert.deepEqual(plannerStats([]), { total: 0, completed: 0, pct: 0 });
});

test('tools persistence round-trips on the same storage keys as the website', () => {
  const storage = makeStorage();
  savePlannerTasks(storage, [{ id: 1, title: 'Revise', due: null, completed: false }]);
  saveAttendance(storage, [{ id: 2, subject: 'DSA', records: { '2026-09-01': 'P' } }]);
  assert.equal(loadPlannerTasks(storage)[0].title, 'Revise');
  assert.equal(loadAttendance(storage)[0].subject, 'DSA');
  assert.deepEqual(loadPlannerTasks(null), []);
});

// ── linkdata: static portals are genuinely external, never the PYQ site ─

test('links dataset: https-only university/government portals, zero PYQ-website URLs', () => {
  assert.equal(LINK_CATEGORIES.length, 4, 'same four categories as the website Links page');
  let total = 0;
  for (const cat of LINK_CATEGORIES) {
    assert.ok(cat.title && cat.icon);
    for (const link of cat.links) {
      total++;
      assert.ok(link.url.startsWith('https://'), `${link.url} must be https`);
      assert.ok(!/dsmnru-pyq\.(netlify\.app|email)/.test(link.url), `${link.url} must NOT be the PYQ website`);
      assert.ok(link.title && link.description);
    }
  }
  assert.equal(total, 14, 'same 14 destinations as links.html');
});

// ── Native Google sign-in wiring (Credential Manager → Firebase) ────────

test('native Google sign-in: serverClientId is the WEB OAuth client, never the Android client', () => {
  const jsDir = join(here, '../www/js');
  const plugin = readFileSync(
    join(here, '../android/app/src/main/java/com/dsmnru/pyq/DsmnruAppPlugin.java'), 'utf8');

  // The GENERATED default_web_client_id (written by the Google Services
  // plugin from google-services.json's client_type:3 entry) is preferred.
  assert.match(plugin, /getIdentifier\(\s*"default_web_client_id", "string"/,
    'uses the generated default_web_client_id resource (the WEB client from google-services.json)');
  // Manual google_web_client_id remains only as a fallback.
  assert.match(plugin, /R\.string\.google_web_client_id/,
    'manual google_web_client_id kept as fallback');
  const genIdx = plugin.indexOf('default_web_client_id');
  const fbIdx = plugin.indexOf('R.string.google_web_client_id');
  assert.ok(genIdx !== -1 && fbIdx > genIdx, 'generated web client is resolved BEFORE the fallback');
  // No Android OAuth client is ever wired as serverClientId.
  assert.ok(!/serverClientId\([^)]*android_client/i.test(plugin), 'Android client never used as serverClientId');
  // Flow shape intact: Credential Manager → Google ID token → Firebase IdP.
  assert.match(plugin, /GetGoogleIdOption\.Builder\(\)/, 'Credential Manager option built');
  assert.match(plugin, /GoogleIdTokenCredential\.createFrom/, 'Google ID token extracted');
  const authjs = readFileSync(join(jsDir, 'auth.js'), 'utf8');
  assert.match(authjs, /signInWithIdp/, 'token exchanged with Firebase Identity Toolkit');
  assert.match(authjs, /providerId=google\.com/, 'google.com provider asserted to Firebase');
  // No website hand-off anywhere in the native google path.
  const authui = readFileSync(join(jsDir, 'authui.js'), 'utf8');
  assert.ok(!authui.includes('netlify'), 'Google sign-in never mentions or opens the website');
  // Existing Google users + brand-new Google users both go through the same
  // Identity Toolkit IdP exchange (sign-in and sign-up are the same call).
  assert.match(authjs, /returnSecureToken: true/, 'session tokens requested (new users get accounts automatically)');
  // Profile schema reused: users/{uid} sync after Google authentication.
  assert.match(authjs, /users\/\$\{encodeURIComponent\(user\.uid\)\}|users\/\$\{user\.uid\}/,
    'profile sync targets the SAME users/{uid} doc as the website');
});

// ── v1.3.1: no technical endpoints in the UI; hidden semantics; signup ──

test('audit: no API/worker/Firebase endpoints are rendered anywhere in the UI', () => {
  const jsDir = join(here, '../www/js');
  // Views + shared UI are the ONLY layers that render user-facing text.
  // Endpoint strings live exclusively in logic modules (api.js, auth.js,
  // uploadcore.js) and are never placed into the DOM.
  const uiFiles = [
    join(jsDir, 'ui.js'),
    join(jsDir, 'drawer.js'),
    ...readdirSync(join(jsDir, 'views')).map((f) => join(jsDir, 'views', f)),
  ];
  const banned = [
    'dsmnru-pyq-api', '.workers.dev', 'firestore.googleapis',
    'identitytoolkit', 'securetoken', 'gofile.io', '/api/',
  ];
  const stripComments = (s) => s
    .replace(/\/\*[\s\S]*?\*\//g, '')   // block comments
    .split('\n')
    .filter((line) => !/^\s*(\*|\/\/)/.test(line)) // comment-only lines
    .join('\n');
  for (const file of uiFiles) {
    const src = stripComments(readFileSync(file, 'utf8'));
    for (const markerString of banned) {
      assert.ok(!src.includes(markerString),
        `${file} renders or embeds the technical endpoint "${markerString}" — the UI must stay human-only`);
    }
  }
  // Firebase error text must never leak raw backend messages (URL scrubbing).
  const auth = readFileSync(join(jsDir, 'auth.js'), 'utf8');
  assert.match(auth, /replace\(\/https\?:\\\/\\\/\\S\+\/g/, 'friendly() scrubs URLs from error text');
  assert.match(auth, /fetchRewardSummary/, 'lazy reward summary exists (same email-keyed reward data)');
});

test('v1.3.1 polish: [hidden] wins over component CSS; signup errors are per-form; version is 1.3.1', () => {
  const css = readFileSync(join(here, '../www/css/app.css'), 'utf8');
  assert.match(css, /\[hidden\]\s*{\s*display:\s*none\s*!important;/,
    'global [hidden] rule — the app-bar back arrow and every toggled element obey hidden');

  const authui = readFileSync(join(here, '../www/js/authui.js'), 'utf8');
  const signupForm = authui.match(/<form data-form="signup"[\s\S]*?<\/form>/);
  assert.ok(signupForm, 'signup form present');
  assert.match(signupForm[0], /data-err/, 'signup form owns its error target (no silent failures)');
  assert.match(authui, /Creating account…/, 'signup busy state present');
  assert.ok(!authui.includes('Create account on website'), 'no website account-creation hand-off');
  assert.ok(!authui.includes('GOOGLE_SIGNIN_SETUP.md'), 'no technical paths in user-facing Google fallback');

  const profile = readFileSync(join(here, '../www/js/views/profile.js'), 'utf8');
  assert.match(profile, /1\.3\.2/, 'app version visible on Profile');
  assert.match(profile, /avatar-img/, 'profile photo rendered where Firebase/Google provides one');
  assert.match(profile, /updateDisplayName/, 'name editing wired to the SAME user profile');
  assert.match(profile, /reward points/, 'upload/reward points visible in Profile');
  assert.ok(!profile.includes('Delete account'), 'no fake delete button without an existing secure flow');

  const home = readFileSync(join(here, '../www/js/views/home.js'), 'utf8');
  assert.match(home, /host\.classList\.add\('hidden'\)/, 'empty home rails hide instead of showing filler text');
});

// ── WEBSITE-REDIRECT AUDIT (self-containment guarantee) ────────────────

test('audit: no website navigation for normal app features (strict allowlist)', () => {
  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    return e.isDirectory() ? walk(p) : (e.name.endsWith('.js') ? [p] : []);
  });
  const jsDir = join(here, '../www/js');
  const files = walk(jsDir);

  // 1) In-window navigation is only permitted inside native.js's last-resort
  //    fallback (which only runs OUTSIDE the app, in a plain browser).
  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    const navHits = [
      /window\.location/, /location\.href/, /location\.assign\(/, /location\.replace\(/,
      /document\.location/,
    ].map((re) => re.test(src));
    if (navHits.some(Boolean) && !file.endsWith('native.js')) {
      assert.fail(`${file} navigates the window — app features must not use the browser`);
    }
  }

  // 2) The site origin may only be referenced by these files, for these
  //    documented purposes: deep-link hand-off, explicit "open website"
  //    choices, share links and the Firebase verification continue-url.
  const SITE_ORIGIN_ALLOWED = new Set([
    'api.js', 'app.js', 'slug.js', 'auth.js',
    join('views', 'paper.js'), join('views', 'profile.js'), join('views', 'about.js'),
  ]);
  for (const file of files) {
    const rel = file.slice(jsDir.length + 1);
    const src = readFileSync(file, 'utf8');
    if (src.includes('dsmnru-pyq.netlify.app') || src.includes('SITE_ORIGIN')) {
      assert.ok(
        SITE_ORIGIN_ALLOWED.has(rel),
        `${rel} references the website — normal features must stay in-app`,
      );
    }
  }

  // 3) The previously-existing website hand-offs are gone:
  const home = readFileSync(join(jsDir, 'views', 'home.js'), 'utf8');
  assert.ok(!home.includes('openExternal'), 'home shortcuts must navigate in-app');
  const authui = readFileSync(join(jsDir, 'authui.js'), 'utf8');
  assert.ok(!authui.includes('Open website to use Google'), 'Google flow must not hand off to the website');
  assert.ok(!authui.includes('openExternal'), 'auth sheets must not open the browser at all');
  const profile = readFileSync(join(jsDir, 'views', 'profile.js'), 'utf8');
  assert.ok(!profile.includes("act: 'web'") && !profile.includes('Open DSMNRU website'),
    'profile must not offer a generic "open the website" item (admin panel excepted)');
  const appSrc = readFileSync(join(jsDir, 'app.js'), 'utf8');
  assert.ok(!/openExternal\(`\$\{SITE_ORIGIN\}\/pyq\//.test(appSrc),
    'unresolvable deep-link slugs must stay in-app (search fallback, not the browser)');

  // 4) Feature screens exist and are wired into the router + drawer.
  const appjs = readFileSync(join(jsDir, 'app.js'), 'utf8');
  for (const view of ['upload', 'tools', 'contributors', 'links', 'about']) {
    assert.match(appjs, new RegExp(`${view}:\\s*render`), `router registers ${view}`);
  }
  const drawer = readFileSync(join(jsDir, 'drawer.js'), 'utf8');
  for (const view of ['upload', 'tools', 'contributors', 'links', 'about']) {
    const exposed = drawer.includes(`view: '${view}'`) || drawer.includes(`data-view="${view}"`);
    assert.ok(exposed, `drawer exposes ${view}`);
  }
  const paper = readFileSync(join(jsDir, 'views', 'paper.js'), 'utf8');
  assert.match(paper, /ctx\.openPdf\(/, 'Open PDF goes through the in-app viewer first');
  assert.match(paper, /submitBrokenLinkReport/, 'report broken link submits in-app (endpoint lives in the feedback module)');
  const feedback = readFileSync(join(jsDir, 'feedback.js'), 'utf8');
  assert.match(feedback, /documents\/feedback/, 'reports land in the SAME Firestore queue the website uses');
});
