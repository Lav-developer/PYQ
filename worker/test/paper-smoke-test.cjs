/**
 * paper.js smoke test: loads paper.html + script.js + paper.js in jsdom,
 * mocks the Worker API, and verifies the paper detail page renders.
 */
const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');

const ROOT = require('path').join(__dirname, '..', '..');
const html = fs.readFileSync(path.join(ROOT, 'paper.html'), 'utf8');
const script = fs.readFileSync(path.join(ROOT, 'assets/js/script.js'), 'utf8');
const paper = fs.readFileSync(path.join(ROOT, 'assets/js/paper.js'), 'utf8');

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
  seoSlug: 'b-tech-3rd-sem-dbms-2024-25',
  createdAt: '2025-01-15T00:00:00Z',
};

const related = [];
let directFirestoreWrites = 0;
let directCommentQueries = 0;
for (let i = 0; i < 8; i++) {
  related.push({
    id: `pyq_${i}`,
    title: `B.Tech 3rd Sem Subject ${i} {2024-25}`,
    course: 'B.Tech', semester: '3rd', session: '2024-25', views: i * 5,
    // Keep one old-index item slugless to verify the legacy URL fallback.
    slug: i === 7 ? '' : `b-tech-3rd-sem-subject-${i}-2024-25`,
  });
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
              set() { directFirestoreWrites++; return Promise.resolve(); },
              collection() { return { orderBy() { return { limit() { return { get() { return Promise.resolve({ empty: true, docs: [] }); } }; } }; }, limit() { return { get() { return Promise.resolve({ empty: true, docs: [] }); } }; }, add() { return Promise.resolve(); } }; },
            };
          },
          where() { if (name === 'comments') directCommentQueries++; return this; },
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
  check('legacy paper URL hydrates a pretty canonical URL when API adds seoSlug',
    window.document.getElementById('canonicalLink').href.endsWith('/pyq/b-tech-3rd-sem-dbms-2024-25'));
  const legacyRelatedHrefs = Array.from(window.document.querySelectorAll('#relatedGrid .related-card')).map((el) => el.getAttribute('href'));
  check('related cards prefer pretty URLs but retain paper.html?id fallback for old index data',
    legacyRelatedHrefs.some((href) => href === '/pyq/b-tech-3rd-sem-subject-6-2024-25')
      && legacyRelatedHrefs.some((href) => href === '/paper.html?id=pyq_7'));

  // Emulate only the public markup the Worker inserts at /pyq/<slug>. The
  // detail API intentionally resolves after a gate so we can prove server
  // content remains visible until normal paper.js hydration finishes.
  const serverMarkup = `
    <section id="seoPaperContent" class="paper-detail-card" data-server-rendered="true" aria-labelledby="seoPaperTitle">
      <h1 id="seoPaperTitle">${paperDoc.title}</h1>
      <p>Course: B.Tech · Semester: 3rd · Subject: DBMS</p>
    </section>
    <section id="seoRelatedSection"><a href="/pyq/b-tech-3rd-sem-subject-0-2024-25">Related server link</a></section>`;
  const prettyHtml = html.replace(/<section id="seoPaperContent" hidden><\/section>/, serverMarkup);
  const prettyDom = new JSDOM(prettyHtml, {
    url: 'http://localhost:8000/pyq/b-tech-3rd-sem-dbms-2024-25',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const prettyWindow = prettyDom.window;
  prettyWindow.DSMNRU_API_URL = 'https://dsmnru-pyq-api.kush210431-cloudflare.workers.dev';
  prettyWindow.DSMNRU_PYQ_ID = paperDoc.id;
  prettyWindow.DSMNRU_PYQ_SLUG = paperDoc.seoSlug;
  prettyWindow.DSMNRU_PYQ_SEO_META = {
    title: paperDoc.title,
    course: paperDoc.course,
    semester: paperDoc.semester,
    session: paperDoc.session,
    subject: paperDoc.subject,
    branch: paperDoc.branch,
    views: paperDoc.views,
    seoVariant: 2,
  };
  // Match the Worker-rendered JSON-LD rather than the legacy paper.html
  // fallback, then prove paper.js does not replace it during hydration.
  const richServerJsonLd = JSON.stringify({
    '@context': 'https://schema.org',
    '@graph': [{ '@type': 'LearningResource' }, { '@type': 'BreadcrumbList' }],
  });
  prettyWindow.document.getElementById('paperJsonLd').textContent = richServerJsonLd;
  prettyWindow.matchMedia = () => ({ matches: true, addListener() {}, removeListener() {} });
  prettyWindow.scrollTo = () => {};
  prettyWindow.confirm = () => true;
  prettyWindow.firebase = window.firebase;
  prettyWindow.bootstrap = window.bootstrap;
  prettyWindow.Swal = window.Swal;
  prettyWindow.navigator.share = undefined;

  let resolveDetail;
  let detailFetchStarted = false;
  const detailGate = new Promise((resolve) => { resolveDetail = resolve; });
  const writesBeforePrettyHydration = directFirestoreWrites;
  const commentQueriesBeforePrettyHydration = directCommentQueries;
  const prettyRequestedUrls = [];
  prettyWindow.fetch = async (url) => {
    const u = new URL(url, prettyWindow.location.origin);
    prettyRequestedUrls.push(u.pathname);
    if (u.pathname === '/api/pyqs/pyq_42') {
      detailFetchStarted = true;
      return detailGate;
    }
    if (u.pathname === '/api/pyqs/search') {
      return new Response(JSON.stringify({ items: related, total: related.length, page: 1, limit: 12, totalPages: 1 }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ error: 'not found' }), {
      status: 404, headers: { 'Content-Type': 'application/json' },
    });
  };

  try {
    prettyWindow.eval(script);
    prettyWindow.eval(paper);
    await new Promise((resolve) => setTimeout(resolve, 80));
    const serverContent = prettyWindow.document.getElementById('seoPaperContent');
    check('pretty route accepts Worker-injected ID instead of requiring ?id=', detailFetchStarted);
    check('server-rendered public content remains visible while hydration is pending',
      serverContent && !serverContent.hidden && serverContent.textContent.includes('DBMS'));
    resolveDetail(new Response(JSON.stringify(paperDoc), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    }));
    await new Promise((resolve) => setTimeout(resolve, 500));

    check('pretty route hydrates the existing interactive paper UI',
      prettyWindow.document.getElementById('paperContent').style.display === 'block');
    check('pretty route hides duplicate server markup only after hydration',
      prettyWindow.document.getElementById('seoPaperContent').hidden
        && prettyWindow.document.getElementById('seoRelatedSection').hidden);
    check('pretty route preserves its canonical URL during client hydration',
      prettyWindow.document.getElementById('canonicalLink').href.endsWith('/pyq/b-tech-3rd-sem-dbms-2024-25'));
    check('a hydrated duplicate retains the Worker-provided unique SEO title',
      prettyWindow.document.title.includes('Archive copy 2')
        && prettyWindow.document.getElementById('ogTitle').getAttribute('content').includes('Archive copy 2'));
    check('pretty route preserves Worker LearningResource and breadcrumb JSON-LD during hydration',
      prettyWindow.document.getElementById('paperJsonLd').textContent === richServerJsonLd);
    const prettyRelatedHrefs = Array.from(prettyWindow.document.querySelectorAll('#relatedGrid .related-card')).map((el) => el.getAttribute('href'));
    check('hydrated related cards use Worker-provided pretty slugs',
      prettyRelatedHrefs.some((href) => href === '/pyq/b-tech-3rd-sem-subject-6-2024-25'));
    check('route-sensitive courses fetch is root-relative from /pyq/<slug>',
      prettyRequestedUrls.includes('/courses.json'));
    check('pretty route avoids automatic direct Firestore view and comment reads during hydration',
      directFirestoreWrites === writesBeforePrettyHydration
        && directCommentQueries === commentQueriesBeforePrettyHydration);

    prettyWindow.document.getElementById('commentsSection').dispatchEvent(
      new prettyWindow.MouseEvent('pointerdown', { bubbles: true }),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    check('pretty route loads discussion after intentional interaction',
      directCommentQueries > commentQueriesBeforePrettyHydration);
  } catch (err) {
    check('pretty route hydration executes without throwing', false, err.stack || err.message);
  }

  console.log(`\nResults: ${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})();
