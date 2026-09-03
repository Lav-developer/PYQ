/**
 * DSMNRU PYQ Android — paper detail screen.
 *
 * Metadata comes from the existing public endpoint (GET /api/pyqs/:id — the
 * full document with file URLs, KV-cached, never from Firestore on the client).
 * PDF handling:
 *   • links stored as `file`/`server1` (primary) and `file2`/`server2` —
 *     the same URLs the website shows, never mirrored
 *   • "Open PDF" FIRST opens the in-app viewer screen (native PdfRenderer,
 *     zoom/scroll, progress/error states, back navigation); the viewer reads
 *     the original host directly — no Worker bandwidth, no permanent copies.
 *     Only when the native layer is absent (plain browser preview) does the
 *     direct URL go to the system viewer — never to the DSMNRU website.
 *   • landing-page links (Drive/mediafire "Server 2") open externally — that
 *     host genuinely cannot render in-app
 *   • download uses Android's DownloadManager (explicit user tap only)
 *   • "Report a broken link" is an in-app form writing to the SAME Firestore
 *     `feedback` collection the website uses (verified sign-in required —
 *     identical rule)
 *   • preview/download require the same verified sign-in the website enforces
 */

import { SITE_ORIGIN } from '../api.js';

function normalizeLink(v) {
  const t = String(v || '').trim();
  if (!t || t.toLowerCase() === 'null') return '';
  return t;
}
function getPrimaryLink(doc) { return normalizeLink(doc.file || doc.server1 || ''); }
function getSecondaryLink(doc) { return normalizeLink(doc.file2 || doc.server2 || ''); }
function isDirectPdfUrl(u) {
  try { return u.split('#')[0].split('?')[0].toLowerCase().endsWith('.pdf'); } catch { return false; }
}
function hostLabel(u) {
  try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return 'external host'; }
}
function paperDate(doc) {
  const raw = doc.createdAt || doc.uploadedAt || doc.addedAt || doc.createdAtServer || null;
  if (!raw) return '';
  try {
    const d = typeof raw.toDate === 'function' ? raw.toDate() : new Date(raw);
    return Number.isNaN(d.getTime()) ? '' : d;
  } catch { return ''; }
}

export default async function renderPaper(root, ctx, params = {}) {
  const { ui, api, store, native, auth } = ctx;
  const id = String(params.id || '');
  if (!id) throw new Error('Missing paper id');

  ctx.setHeader({ title: 'Paper', brand: false });

  root.innerHTML = `<div class="stack">${ui.skeletonRows(3)}</div>`;

  let doc = null;
  let res = null;
  try {
    res = await api.detail(id);
    doc = res.data || null;
  } catch (err) {
    root.innerHTML = '';
    root.appendChild(ui.stateBlock({
      iconName: 'alert', tone: 'error',
      title: 'Paper unavailable',
      text: ctx.state.online ? String(err.message || err) : 'Offline and this paper was never opened on this device.',
      actionLabel: 'Retry',
      onAction: () => ctx.router.replace('paper', params),
    }));
    return;
  }
  if (!doc || doc.error) {
    root.innerHTML = '';
    root.appendChild(ui.stateBlock({
      iconName: 'alert', title: 'This paper is no longer in the archive',
      text: 'It may have been removed or renamed by a moderator.',
      actionLabel: 'Go back', onAction: () => ctx.router.back(),
    }));
    return;
  }

  const title = doc.title || `${doc.course || 'General'} ${doc.semester || ''} Paper`.trim();
  const course = doc.course || doc.category || '';
  const semester = doc.semester || doc.sem || '';
  const session = doc.session || '';
  const branch = doc.branch || '';
  const subject = doc.subject || '';
  const views = Number.isFinite(Number(doc.views)) ? Number(doc.views) : 0;
  const added = paperDate(doc);
  const slug = doc.seoSlug || params.slug || '';
  const primary = getPrimaryLink(doc);
  const secondary = getSecondaryLink(doc);
  const siteUrl = slug
    ? `${SITE_ORIGIN}/pyq/${encodeURIComponent(slug)}`
    : `${SITE_ORIGIN}/paper.html?id=${encodeURIComponent(id)}`;

  // Local "recently viewed" memory (device only — feeds Home + Search idle).
  store.pushRecentView({
    id, title, course, semester, session,
    branch, subject, views,
    slug: slug || '',
    year: doc.year || '',
  });

  const itemLite = { id, title, course, semester, session, branch, subject, views, slug };

  root.innerHTML = '';
  const stack = document.createElement('div');
  stack.className = 'stack';

  // Hero
  const hero = document.createElement('section');
  hero.className = 'paper-hero';
  const metaBits = [
    course && `Course: ${course}`,
    semester && semester,
    session && `Session ${session}`,
    branch && `Branch: ${branch}`,
    doc.year && `Year ${doc.year}`,
  ].filter(Boolean);
  hero.innerHTML = `
    <span class="eyebrow">${ui.esc(subject || 'PYQ Paper')}</span>
    <h1>${ui.esc(title)}</h1>
    <div class="paper-meta">
      ${metaBits.map((m) => `<span class="pm-chip">${ui.esc(m)}</span>`).join('')}
      <span class="pm-right">
        <span class="pm-views">${ui.icon('eye')} ${views}</span>
        ${added ? `<span class="pm-date">${ui.esc(ui.fmtDate(added))}</span>` : ''}
      </span>
    </div>
    ${res && res.stale ? `<p class="server-note" style="text-align:left;margin-top:10px">${ui.stalePill('Shown from cache')}</p>` : ''}`;
  stack.appendChild(hero);

  // File actions
  const actions = document.createElement('section');
  actions.className = 'card card-pad';
  const isSaved = store.isSaved(id);
  actions.innerHTML = `
    <div class="action-grid" id="paper-actions">
      ${primary ? `<button class="btn btn--primary btn--wide" data-act="view" type="button">${ui.icon('pdf')} ${isDirectPdfUrl(primary) ? 'Open PDF' : 'Open file'}</button>` : ''}
      ${primary && isDirectPdfUrl(primary) ? `<button class="btn btn--gold" data-act="download" type="button">${ui.icon('download')} Download</button>` : ''}
      ${secondary ? `<button class="btn ${primary && isDirectPdfUrl(primary) ? 'btn--ghost' : 'btn--primary'}" data-act="server2" type="button">${ui.icon('open')} Server 2</button>` : ''}
      ${primary && secondary ? `<button class="btn btn--ghost" data-act="server1" type="button">${ui.icon('open')} Server 1</button>` : ''}
      <button class="btn btn--ghost" data-act="save" type="button">${ui.icon(isSaved ? 'bookmarkFilled' : 'bookmark')} ${isSaved ? 'Saved' : 'Save'}</button>
      <button class="btn btn--ghost" data-act="share" type="button">${ui.icon('share')} Share</button>
    </div>
    ${primary ? `<p class="server-note">Primary host: ${ui.esc(hostLabel(primary))}${secondary ? ` · Secondary: ${ui.esc(hostLabel(secondary))}` : ''}</p>` : `<p class="server-note">No file links on this record yet.</p>`}
    ${!auth.canUnlockPrivileges() ? `<p class="server-note">${auth.current() ? 'Verify your email to open/download (same rule as the website)' : 'Sign in to open or download this paper'}</p>` : ''}`;
  stack.appendChild(actions);

  const locked = () => auth.canUnlockPrivileges();

  /**
   * PDF open policy: the in-app viewer screen first. It fetches the SAME
   * direct host URL itself (never through the Cloudflare Worker) and keeps
   * the file only in the system cache until closed. Fallback when the native
   * viewer is unavailable = the direct URL to the system viewer — the DSMNRU
   * website is never part of the chain.
   */
  async function openInAppViewer(url, label) {
    ui.toast(`Opening ${label || 'PDF'} in the app…`);
    await ctx.openPdf(url, title);
  }

  async function performPdfAction(act) {
    if (act === 'view' && primary) {
      if (isDirectPdfUrl(primary)) await openInAppViewer(primary, 'PDF');
      else native.openExternal(primary); // landing page → genuinely external
      return;
    }
    if (act === 'server1' && primary) {
      if (isDirectPdfUrl(primary)) await openInAppViewer(primary, 'PDF (server 1)');
      else native.openExternal(primary);
      return;
    }
    if (act === 'server2' && secondary) {
      if (isDirectPdfUrl(secondary)) await openInAppViewer(secondary, 'PDF (server 2)');
      else native.openExternal(secondary); // Drive/mediafire landing → external
      return;
    }
    if (act === 'download' && primary) {
      const fileBase = (title || 'dsmnru-paper').replace(/[^\w\d .-]+/g, '_').slice(0, 70);
      const ok = await native.download(primary, `${fileBase}.pdf`);
      ui.toast(ok ? 'Download started — see your system notification' : 'Download failed — opening instead', ok ? 'ok' : 'err');
      if (!ok) native.openExternal(primary);
    }
  }

  actions.querySelector('#paper-actions').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const act = b.dataset.act;
    if (act === 'save') {
      const nowSaved = store.toggleSaved({ ...itemLite, savedAt: Date.now() });
      b.innerHTML = ui.icon(nowSaved ? 'bookmarkFilled' : 'bookmark') + ' ' + (nowSaved ? 'Saved' : 'Save');
      ui.toast(nowSaved ? 'Saved — find it in the Saved tab' : 'Removed from saved');
      return;
    }
    if (act === 'share') {
      const ok = await native.share(title, siteUrl);
      if (ok) ui.toast('Share sheet opened'); else ui.toast('Nothing to share', 'err');
      return;
    }
    // PDF open/download follow the website's verified-account gate.
    if (!locked()) {
      ctx.requireAuth(() => performPdfAction(act), 'PDF access follows the website rule: a verified DSMNRU account.');
      return;
    }
    await performPdfAction(act);
  });

  // Metadata table (mirrors fields the website's info list shows)
  const meta = document.createElement('section');
  meta.className = 'meta-grid';
  const cells = [
    ['Course', course || '—'],
    ['Subject', subject || '—'],
    ['Semester', semester || '—'],
    ['Session', session || '—'],
    ['Branch', branch || '—'],
    ['Views', String(views)],
    ['Added', added ? ui.fmtDate(added) : '—'],
    ['Document ID', id.length > 34 ? id.slice(0, 18) + '…' + id.slice(-10) : id],
  ];
  meta.innerHTML = cells.map(([k, v]) => `<div class="meta-cell"><span>${k}</span><b>${ui.esc(v)}</b></div>`).join('');
  stack.appendChild(meta);

  // More actions row — report stays IN-APP (same Firestore `feedback`
  // collection the website writes); only the discussion page (comments,
  // which exist only on the website) remains an explicit external choice.
  const more = document.createElement('section');
  more.className = 'card card-pad';
  more.innerHTML = `
    <div class="sheet-list" id="paper-more">
      <button class="sheet-item" data-act="report" type="button">${ui.icon('flag')}<span>Report a broken link<small>Reviewed by moderators — right from the app</small></span><span class="tail">${ui.icon('chevron')}</span></button>
      <button class="sheet-item" data-act="web" type="button">${ui.icon('globe')}<span>Discussion & full page on website<small>Comments live only on the website — opens externally</small></span><span class="tail">${ui.icon('chevron')}</span></button>
    </div>`;
  more.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    if (b.dataset.act === 'report') openReportSheet();
    if (b.dataset.act === 'web') native.openExternal(siteUrl);
  });
  stack.appendChild(more);

  /**
   * In-app "Report a broken link" — writes to the SAME `feedback` collection
   * with the SAME fields the website's report modal uses
   * (type='broken_link', status='new'), via one Firestore REST insert with
   * the user's own ID token. Gate = verified sign-in (the Firestore rule).
   */
  function openReportSheet() {
    const start = () => {
      const node = document.createElement('div');
      node.innerHTML = `
        <p class="sheet-text">Reporting: <b>${ui.esc(title)}</b>${course ? ` · ${ui.esc(course)}` : ''}</p>
        <div class="field" style="margin-top:12px">
          <label for="rep-details">What's wrong?</label>
          <textarea class="input" id="rep-details" rows="3" maxlength="600" placeholder="e.g., Primary link opens an error page…"></textarea>
        </div>
        <div data-err class="form-error" hidden></div>
        <div class="sheet-actions">
          <button class="btn btn--ghost" data-dismiss="1" type="button">Cancel</button>
          <button class="btn btn--primary" id="rep-send" type="button">Send report</button>
        </div>`;
      const s = ui.sheet({ title: 'Report a broken link', content: node });
      node.querySelector('#rep-send').addEventListener('click', async (e2) => {
        const btn = e2.currentTarget;
        const details = node.querySelector('#rep-details').value.trim();
        const errEl = node.querySelector('[data-err]');
        if (details.length < 3) {
          errEl.textContent = 'Please describe the problem (a few words is enough).';
          errEl.hidden = false;
          return;
        }
        btn.disabled = true;
        btn.textContent = 'Sending…';
        try {
          const user = auth.current();
          const fields = {
            type: { stringValue: 'broken_link' },
            title: { stringValue: title },
            course: { stringValue: course || '' },
            details: { stringValue: details },
            email: { stringValue: user && user.email || '' },
            userId: { stringValue: user ? user.uid : '' },
            userEmail: { stringValue: user && user.email || '' },
            createdAt: { timestampValue: new Date().toISOString() },
            status: { stringValue: 'new' },
          };
          const headers = { 'Content-Type': 'application/json' };
          if (user && user.idToken) headers.Authorization = 'Bearer ' + user.idToken;
          const res = await fetch(
            `https://firestore.googleapis.com/v1/projects/dsmnru-data/databases/(default)/documents/feedback`,
            { method: 'POST', headers, body: JSON.stringify({ fields }) },
          );
          if (!res.ok) {
            const body = await res.json().catch(() => null);
            throw new Error((body && body.error && body.error.message) || 'Could not send the report.');
          }
          ui.closeSheet();
          ui.toast('Report sent — thank you!');
        } catch (err) {
          errEl.textContent = String(err.message || err);
          errEl.hidden = false;
          btn.disabled = false;
          btn.textContent = 'Send report';
        }
      });
    };
    // The Firestore rule only allows verified users to create feedback docs.
    ctx.requireAuth(start, 'Reporting needs a verified account (same rule as the website).');
  }

  // Related papers — one filtered request like the website's related rail.
  const relHost = document.createElement('section');
  relHost.id = 'paper-related';
  stack.appendChild(relHost);
  root.appendChild(stack);

  api.related({ id, title, course, semester, subject }).then((r) => {
    const items = (r.data || []).filter((x) => x && x.id !== id);
    if (!items.length) { relHost.remove(); return; }
    relHost.innerHTML = '';
    relHost.appendChild(ui.sectionHead('Related papers', { iconName: 'layers' }));
    const list = document.createElement('div');
    list.style.marginTop = '10px';
    ui.paperList(list, ctx, items.slice(0, 5));
    relHost.appendChild(list);
  }).catch(() => relHost.remove());
}
