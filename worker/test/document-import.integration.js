/** Real admin CSV/form code → real authenticated Worker invalidation → KV SWR
 * → mocked Firestore REST → public search, canonical HTML and legacy detail.
 * Network/storage only are mocked by the existing Worker harness.
 */
import { JSDOM } from 'jsdom';
import Papa from 'papaparse';
import { readFileSync } from 'node:fs';
import { readDocumentType, validateDocumentType, DOCUMENT_TYPES } from '../src/document-types.js';
import { getSearchIndex, buildIndexItem, assignCanonicalSlugs, searchIndex, runBackgroundRebuild, getInIsolateRebuildPromise } from '../src/search.js';

import { KV_KEYS, acquireRebuildLock, releaseRebuildLock, getFromKV, setKV } from '../src/cache.js';

const read = name => readFileSync(new URL('../../' + name, import.meta.url), 'utf8');
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

export async function testDocumentImport({ check, request, reset, setDocuments, documents, adminToken, reads }) {
  console.log('\n20. Document types + real Admin CSV/Worker regression');
  reset();
  setDocuments([{ id: 'existing', title: 'DBMS', course: 'B.Tech', semester: '3rd', file: 'https://example.org/dbms.pdf', slug: 'dbms' }]);
  const dom = new JSDOM(read('admin.html'), { url: 'https://admin.example/admin.html', runScripts: 'outside-only' });
  const { window: w } = dom;
  let clientNumber = 1;
  let invalidations = 0, writes = 0, serial = 0, failWriteAt = 0, failInvalidation = false;
  const events = [], alerts = [];
  const snapshot = doc => ({ id: doc?.id, exists: !!doc, data: () => ({ ...doc }) });
  const db = {
    collection(name) {
      const docs = () => name === 'pyqs' ? documents() : [];
      const save = (id, data) => {
        if (failWriteAt && writes + 1 === failWriteAt) throw new Error('Injected Firestore failure');
        writes++; events.push('write');
        const existing = docs().find(doc => doc.id === id);
        if (existing) Object.assign(existing, data);
        else docs().push({ ...data, id });
      };
      return {
        async get() { return { docs: docs().map(snapshot) }; },
        where() { return { async get() { return { empty: true, docs: [] }; } }; },
        doc(id) { return {
          async get() { return snapshot(docs().find(doc => doc.id === id)); },
          async set(data) { save(id, data); },
          async delete() { const index = docs().findIndex(doc => doc.id === id); if (index >= 0) docs().splice(index, 1); events.push('delete'); },
        }; },
        async add(data) { const id = 'import-' + (++serial); save(id, data); return { id }; },
      };
    },
  };
  const auth = { currentUser: { getIdToken: async () => adminToken }, onAuthStateChanged() {} };
  w.firebase = { initializeApp() {}, auth: () => auth, firestore: () => db, storage: () => ({}) };
  w.firebase.firestore.FieldValue = { serverTimestamp: () => new Date().toISOString() };
  w.alert = text => alerts.push(text); w.confirm = () => true; w.scrollTo = () => {};
  w.bootstrap = { Modal: class { show() {} hide() {} static getInstance() { return new this(); } } };
  w.Papa = Papa;
  w.fetch = async (url, init) => {
    if (String(url).endsWith('/invalidate')) {
      invalidations++; events.push('invalidate');
      if (failInvalidation) return new Response('Injected KV failure', { status: 503 });
      return request('/api/invalidate', { method: 'POST', headers: { ...init.headers, 'CF-Connecting-IP': '192.0.2.' + clientNumber } });
    }
    return new Response(JSON.stringify({ courses: ['B.Tech'] }));
  };
  w.eval(read('document-types.js'));
  w.eval(read('points.js'));
  w.eval(read('duplicate-check.js'));
  w.eval(read('admin.js'));
  await tick();

  const parse = text => Papa.parse(text, { header: true, skipEmptyLines: true }).data;
  const importRows = rows => w.importCsvRows(rows, 'pyqs');
  const resetCounts = () => { clientNumber++; invalidations = 0; writes = 0; events.length = 0; };
  const search = async q => (await request('/api/pyqs/search?' + new URLSearchParams(q))).json();
  const refresh = async () => {
    const pending = [];
    await request('/api/pyqs', { ctx: { waitUntil: p => pending.push(p) } });
    await Promise.all(pending);
  };

  check('all six shared types validate and round-trip through compact ty', DOCUMENT_TYPES.every(type =>
    validateDocumentType(type) === type && buildIndexItem({ id: type, type, title: type }).ty === type));
  check('missing type and empty legacy CSV field default to pyq', readDocumentType() === 'pyq' && validateDocumentType('') === 'pyq');
  check('invalid stored type displays as Other rather than inventing a category', readDocumentType('wrong') === 'other');
  let rejected = false; try { validateDocumentType('wrong'); } catch { rejected = true; }
  check('invalid write type is rejected', rejected);

  // Exact production failure: warm index, real form/Papa/FileReader import,
  // Firestore success, ONE invalidation, stale read, background rebuild.
  check('existing PYQ is searchable before import', (await search({ q: 'DBMS' })).items[0]?.type === 'pyq');
  const csv = 'collection,id,title,type,slug,description,Server 1,Server 2,course,semester,session,subject,branch\n'
    + 'pyqs,,Scholarship Docs,scholarship,scholarship-docs,Scholarship related documents for DSMNRU,https://example.org/docs.pdf,https://example.org/docs2.pdf,,,,,\n';
  const input = w.document.getElementById('csvImportFile');
  Object.defineProperty(input, 'files', { value: [new w.File([csv], 'documents.csv', { type: 'text/csv' })], configurable: true });
  w.document.getElementById('csvImportCollection').value = 'pyqs';
  // Let the warm index timestamp precede the explicit mutation.
  await tick();
  w.document.getElementById('csvImportForm').dispatchEvent(new w.Event('submit', { cancelable: true }));
  for (let i = 0; i < 100 && !alerts.some(text => text.startsWith('CSV import complete')); i++) await tick();
  const imported = documents().find(doc => doc.title === 'Scholarship Docs');
  check('real CSV submit writes the scholarship document without fake metadata', !!imported && imported.type === 'scholarship'
    && ['course', 'subject', 'branch', 'session', 'semester'].every(key => !imported[key]));
  check('bulk import invalidates exactly once, after writes complete', invalidations === 1 && writes === 1 && events.join() === 'write,invalidate');
  const stale = await getSearchIndex();
  check('existing KV index is retained and marked stale-invalidated', stale.reason === 'stale-invalidated'
    && !stale.index.items.some(item => item.id === imported?.id));
  check('old failure mode reproduced: pre-refresh search cannot find import', (await search({ q: 'Scholarship Docs' })).total === 0);
  await refresh();
  const found = await search({ q: 'Scholarship Docs' });
  check('background refresh makes imported scholarship searchable', found.items[0]?.id === imported?.id && found.items[0]?.type === 'scholarship');
  check('refreshed search returns canonical non-PYQ slug', found.items[0]?.slug === 'scholarship-docs');
  const page = await request('/pyq/scholarship-docs');
  const html = await page.text();
  check('pretty URL resolves the correct scholarship with description and type', page.status === 200
    && html.includes('Scholarship Docs') && html.includes('<strong>Scholarship</strong>')
    && html.includes('Scholarship related documents for DSMNRU') && !html.includes('<strong>Not specified</strong>'));
  const detail = await (await request('/api/pyqs/' + imported.id)).json();
  check('legacy ID detail retains both file fields, description, type and ID', detail.id === imported.id
    && detail.file === imported.file && detail.file2 === imported.file2 && detail.type === 'scholarship' && detail.seoSlug === 'scholarship-docs');
  const readsBefore = reads();
  await search({ q: 'Scholarship' }); await search({ type: 'scholarship' }); await request('/pyq/scholarship-docs');
  check('warm search/filter/slug perform no additional Firestore reads', reads() === readsBefore);
  check('existing PYQ slug remains working', (await request('/pyq/dbms')).status === 200);

  resetCounts();
  const old = await importRows(parse('title,Server 1,course,semester,subject,session\nData Structures,https://example.org/ds.pdf,B.Tech,3rd,DS,2025-26'));
  check('old CSV without type creates a PYQ and invalidates once', old.addedCount === 1 && invalidations === 1
    && documents().find(doc => doc.title === 'Data Structures').type === 'pyq');
  resetCounts();
  const mixed = await importRows(parse('id,title,type,Server 1\nexisting,DBMS revised,pyq,https://example.org/new.pdf\n,Hostel Form,form,https://example.org/form.pdf\n,Notice,notice,https://example.org/notice.pdf\n,Syllabus,syllabus,https://example.org/syllabus.pdf\n,Other Academic Document,other,https://example.org/other.pdf'));
  check('mixed CSV bulk add/update has one invalidation and preserves IDs', mixed.addedCount === 4 && mixed.updatedCount === 1 && invalidations === 1 && writes === 5);
  check('CSV title update keeps a persisted PYQ slug stable with library unloaded', documents().find(doc => doc.id === 'existing').slug === 'dbms');
  await refresh();
  for (const [type, query] of [['pyq', 'DBMS'], ['form', 'Hostel Form'], ['scholarship', 'Scholarship'], ['notice', 'Notice'], ['syllabus', 'Syllabus'], ['other', 'Other Academic']]) {
    const result = await search({ q: query, type });
    check(`${type} search and type filter return correct documents`, result.total > 0 && result.items.every(doc => doc.type === type));
  }
  check('list endpoint supports additive type filter', (await (await request('/api/pyqs?type=form')).json()).items.every(doc => doc.type === 'form'));
  check('invalid search/list type returns 400 instead of broadening results', (await request('/api/pyqs?type=wrong')).status === 400
    && (await request('/api/pyqs/search?type=wrong')).status === 400);

  resetCounts();
  const bad = await importRows([{}, { title: 'Missing file', type: 'notice' }, { title: 'Bad', type: 'bad', file: 'https://example.org/f.pdf' }]);
  check('empty, malformed and invalid-type rows never write or invalidate', bad.skippedCount === 3 && writes === 0 && invalidations === 0 && bad.warnings.length === 2);
  resetCounts();
  const dup = await importRows([{ id: 'existing', title: 'First', type: 'pyq' }, { id: 'existing', title: 'Last', type: 'pyq', slug: 'must-not-replace' }]);
  check('duplicate IDs update sequentially (last valid row wins), once invalidated', dup.updatedCount === 2 && invalidations === 1
    && documents().find(doc => doc.id === 'existing').title === 'Last' && documents().find(doc => doc.id === 'existing').slug === 'dbms');
  resetCounts();
  const batch = await importRows(Array.from({ length: 100 }, (_, i) => ({ title: 'Bulk ' + i, type: 'form', file: 'https://example.org/f.pdf' })));
  check('100 successful CSV rows mean 100 writes and exactly ONE invalidation', batch.addedCount === 100 && writes === 100 && invalidations === 1 && events.at(-1) === 'invalidate');
  resetCounts(); failInvalidation = true;
  const warning = await importRows([{ title: 'Saved despite KV failure', type: 'notice', file: 'https://example.org/f.pdf' }]);
  check('invalidation failure reports saved Firestore data and delayed public search', warning.addedCount === 1 && !warning.error
    && warning.warnings.some(text => /public search\/index refresh may be delayed/.test(text)) && invalidations === 1);
  failInvalidation = false;
  resetCounts(); failWriteAt = 2;
  const partial = await importRows([{ title: 'Partial saved', file: 'https://example.org/f.pdf' }, { title: 'Fails', file: 'https://example.org/f.pdf' }]);
  check('partial import invalidates successful writes once and reports real write failure', partial.addedCount === 1 && !!partial.error && invalidations === 1);
  failWriteAt = 0;

  // Each non-PYQ admin form works with all academic inputs empty.
  for (const type of DOCUMENT_TYPES.filter(type => type !== 'pyq')) {
    resetCounts();
    const set = (id, value) => { w.document.getElementById(id).value = value; };
    set('pyqDocumentType', type); w.updateDocumentTypeFields('pyq');
    set('pyqTitle', 'Admin ' + type); set('pyqDescription', 'Description'); set('pyqFile', 'https://example.org/a.pdf');
    check(`${type} creation has no subject/branch/session/semester requirement`, ['Subject', 'Branch', 'Session', 'Semester'].every(field =>
      !w.document.getElementById('pyq' + field).required) && w.document.getElementById('addPyqForm').checkValidity());
    w.document.getElementById('addPyqForm').dispatchEvent(new w.Event('submit', { cancelable: true }));
    await tick();
    check(`${type} admin creation writes its type and invalidates once`, documents().some(doc => doc.title === 'Admin ' + type && doc.type === type) && invalidations === 1);
  }
  check('PYQ creation still requires its original academic fields after reset', ['Course', 'Semester', 'Subject', 'Session'].every(field =>
    w.document.getElementById('pyq' + field).required));

  resetCounts();
  const editable = documents().find(doc => doc.title === 'Admin scholarship');
  const stableSlug = editable.slug;
  w.editPyqById(editable.id);
  check('edit modal loads existing document type and description', w.document.getElementById('editDocumentType').value === 'scholarship'
    && w.document.getElementById('editDescription').value === 'Description');
  w.document.getElementById('editTitle').value = 'Revised scholarship';
  w.document.getElementById('editDescription').value = 'Updated description';
  w.document.getElementById('editForm').dispatchEvent(new w.Event('submit', { cancelable: true }));
  await tick();
  check('non-PYQ edit preserves slug and invalidates once without academic metadata', editable.title === 'Revised scholarship'
    && editable.description === 'Updated description' && editable.slug === stableSlug && invalidations === 1);
  resetCounts();
  w.deletePyqById(editable.id); await tick();
  check('admin delete invalidates once and removes document', invalidations === 1 && !documents().some(doc => doc.id === editable.id));

  resetCounts();
  const restored = await w.importCsvRows([{ collection: 'pyqs', id: 'restored-id', title: 'Restored syllabus', type: 'syllabus', file: 'https://example.org/s.pdf' }], 'users');
  check('mixed-collection restore detects pyqs even when another collection is selected', restored.updatedCount === 1 && invalidations === 1
    && documents().some(doc => doc.id === 'restored-id' && doc.slug === 'restored-syllabus'));
  const backup = w.buildCsvBackupRow('pyqs', { id: 'private-backup', title: 'Restricted restore', type: 'form', file: 'https://example.org/f.pdf',
    isPublic: false, isPublished: false, accessLevel: 'restricted', visibility: 'private' });
  const roundtrip = Papa.parse(w.buildCsvContent([backup], Object.keys(backup)), { header: true }).data;
  resetCounts();
  await importRows(roundtrip);
  const protectedDoc = documents().find(doc => doc.id === 'private-backup');
  check('CSV backup/restore preserves type and camelCase public restrictions', protectedDoc.type === 'form'
    && protectedDoc.isPublic === 'false' && protectedDoc.isPublished === 'false' && protectedDoc.accessLevel === 'restricted'
    && protectedDoc.visibility === 'private' && invalidations === 1);
  const existingNoSlug = { id: 'legacy-noslug', title: 'Original title', file: 'https://example.org/f.pdf' };
  documents().push(existingNoSlug);
  resetCounts();
  await importRows([{ id: existingNoSlug.id, title: 'Changed title' }]);
  check('legacy title edit captures old slug even when admin library has not loaded it', existingNoSlug.slug === 'original-title');

  resetCounts();
  alerts.length = 0;
  Object.defineProperty(input, 'files', { value: [new w.File(['title,type,Server 1\n"unterminated,form,https://example.org/f.pdf'], 'bad.csv')], configurable: true });
  w.document.getElementById('csvImportCollection').value = 'pyqs';
  w.document.getElementById('csvImportForm').dispatchEvent(new w.Event('submit', { cancelable: true }));
  for (let i = 0; i < 100 && alerts.length === 0; i++) await tick();
  check('malformed CSV parser errors stop before writes and invalidation', writes === 0 && invalidations === 0 && alerts.some(text => text.startsWith('Error importing CSV:')));

  // A skipped cross-isolate rebuild must release local single-flight state,
  // otherwise subsequent invalidations can never refresh this isolate.
  await acquireRebuildLock();
  const beforeLockedRead = reads();
  await runBackgroundRebuild();
  check('another isolate lock skips rebuild without leaving a stuck local promise', reads() === beforeLockedRead && getInIsolateRebuildPromise() === null);
  await releaseRebuildLock();
  await runBackgroundRebuild();
  check('a later request can rebuild after another isolate releases its lock', reads() > beforeLockedRead);
  const rebuilt = await getFromKV(KV_KEYS.SEARCH_INDEX);
  await globalThis.PYQ_CACHE.put(KV_KEYS.INVALIDATION, String(rebuilt._cachedAt));
  check('same-millisecond invalidation is not lost', (await getSearchIndex()).reason === 'stale-invalidated');
  await globalThis.PYQ_CACHE.put(KV_KEYS.INVALIDATION, String(rebuilt._cachedAt + 1));
  check('invalidation during/after a sweep stays stale until a later rebuild', (await getSearchIndex()).needsBackgroundRebuild);
  const typedIndex = await getFromKV(KV_KEYS.SEARCH_INDEX);
  delete typedIndex.typeVersion;
  typedIndex.items.forEach(item => { delete item.ty; });
  await setKV(KV_KEYS.SEARCH_INDEX, typedIndex);
  check('pre-type KV schema schedules one normal background upgrade', (await getSearchIndex()).reason === 'stale-schema');
  await refresh();
  check('schema rebuild repopulates compact type fields', (await getFromKV(KV_KEYS.SEARCH_INDEX)).items.every(item => !!item.ty));

  const collision = assignCanonicalSlugs({ items: [buildIndexItem({ id: 'a', title: 'Scholarship Docs', type: 'scholarship' }),
    buildIndexItem({ id: 'b', title: 'Scholarship Docs', type: 'form' })] });
  check('non-PYQ duplicate titles reuse canonical collision allocator', collision.items[0].sl === 'scholarship-docs'
    && collision.items[1].sl.startsWith('scholarship-docs--') && collision.items[0].sl !== collision.items[1].sl);
  check('legacy compact items without ty still match PYQ filters', searchIndex({ items: [{ id: 'old', t: 'DBMS', p: true }] },
    { type: 'pyq', page: 1, limit: 20 }).total === 1);

  reset();
  setDocuments(['draft', 'pending', 'private', 'rejected', 'deleted', 'archived', 'hidden', 'restricted'].map(status => ({
    id: status, title: 'Secret ' + status, type: 'scholarship', status, file: 'https://example.org/private.pdf'
  })).concat([{ id: 'public', title: 'Public Form', type: 'form', file: 'https://example.org/public.pdf' }]));
  const visible = await search({});
  check('public search excludes every explicitly non-public status', visible.total === 1 && visible.items[0].id === 'public');
  for (const status of ['draft', 'pending', 'private', 'rejected', 'deleted', 'archived', 'hidden', 'restricted']) {
    check(`${status} document has no public detail or slug`, (await request('/api/pyqs/' + status)).status === 404
      && (await request('/pyq/secret-' + status)).status === 404);
  }
  const sitemap = await (await request('/sitemap.xml')).text();
  const homepage = await (await request('/api/homepage')).json();
  check('homepage keeps additive type and does not invent courses for Forms', homepage.recent[0]?.type === 'form' && homepage.courseCounts.length === 0);
  check('sitemap includes public non-PYQ but no restricted records', sitemap.includes('/pyq/public-form') && !sitemap.includes('/pyq/secret-'));
  dom.window.close();
}
