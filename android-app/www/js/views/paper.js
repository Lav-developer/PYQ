/**
 * DSMNRU PYQ Android — paper detail screen.
 *
 * Metadata comes from the existing public endpoint (GET /api/pyqs/:id — the
 * full document with file URLs, KV-cached, never from Firestore on the client).
 * PDF handling mirrors the website's business rules:
 *   • links stored as `file`/`server1` (primary) and `file2`/`server2`
 *   • direct .pdf links can be previewed/started in a native viewer or
 *     downloaded via Android's DownloadManager; drive/mediafire/landing
 *     links open in the browser/app that can handle them
 *   • preview/download require the same verified sign-in the website enforces
 * The app never stores PDFs itself and never re-downloads the archive.
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

  async function performPdfAction(act) {
    if (act === 'view' && primary) { native.openExternal(primary); return; }
    if (act === 'server1' && primary) { native.openExternal(primary); return; }
    if (act === 'server2' && secondary) { native.openExternal(secondary); return; }
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

  // More actions row
  const more = document.createElement('section');
  more.className = 'card card-pad';
  more.innerHTML = `
    <div class="sheet-list" id="paper-more">
      <button class="sheet-item" data-act="web" type="button">${ui.icon('globe')}<span>Open on website<small>Full page with discussion & report tools</small></span><span class="tail">${ui.icon('chevron')}</span></button>
      <button class="sheet-item" data-act="report" type="button">${ui.icon('flag')}<span>Report a broken link<small>Goes to moderators on the website</small></span><span class="tail">${ui.icon('chevron')}</span></button>
    </div>`;
  more.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    if (b.dataset.act === 'web') native.openExternal(siteUrl);
    if (b.dataset.act === 'report') native.openExternal(siteUrl);
  });
  stack.appendChild(more);

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
