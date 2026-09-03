/**
 * DSMNRU PYQ Android — shared UI toolkit for the app's own interface.
 *
 * Everything here renders the app's mobile-first components (cards, sheets,
 * state blocks, toasts). No website markup is reused — only the brand's
 * visual language (dark slate + teal/mint accents, the DSMNRU emblem,
 * rounded 18px cards, 44px+ touch targets).
 */

export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// ── inline icon set (stroke-based, inherits currentColor) ──────────────
const ICONS = {
  home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/><path d="M9.5 21v-6h5v6"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  courses: '<path d="M12 3 2 8l10 5 10-5-10-5z"/><path d="M6 10.5V16c0 1.7 2.7 3 6 3s6-1.3 6-3v-5.5"/><path d="M22 8v6"/>',
  bookmark: '<path d="M6 3h12a1 1 0 0 1 1 1v17l-7-4.5L5 21V4a1 1 0 0 1 1-1z"/>',
  bookmarkFilled: '<path d="M6 3h12a1 1 0 0 1 1 1v17l-7-4.5L5 21V4a1 1 0 0 1 1-1z" fill="currentColor" stroke="none"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-6 8-6s8 2 8 6"/>',
  back: '<path d="m14 6-6 6 6 6"/>',
  chevron: '<path d="m9.5 6 6 6-6 6"/>',
  share: '<circle cx="6" cy="12" r="2.5"/><circle cx="17" cy="5.5" r="2.5"/><circle cx="17" cy="18.5" r="2.5"/><path d="m8.3 10.8 6.4-4M8.3 13.2l6.4 4"/>',
  download: '<path d="M12 3v11"/><path d="m7 10 5 5 5-5"/><path d="M4 20h16"/>',
  open: '<path d="M14 4h6v6"/><path d="M20 4 10 14"/><path d="M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5"/>',
  pdf: '<path d="M7 3h8l4 4v14H7z"/><path d="M15 3v4h4"/><path d="M10 12h4M10 15.5h4"/>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.6"/>',
  flame: '<path d="M12 3c1 3-3.5 4.5-3.5 8.5a3.5 3.5 0 0 0 7 0c0-1.5-.8-2.5-1.3-3.2.2 2.5-3 2.7-2.4 5.2"/><path d="M12 21a7.5 7.5 0 0 0 7.5-7.5c0-5.5-4.5-7.5-5-13a9.8 9.8 0 0 1 1 4.6c-1.8-1.9-3.6-2.4-5.6-4.6.4 3-4.4 5.5-4.4 13A7.5 7.5 0 0 0 12 21z"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  calendar: '<rect x="4" y="5.5" width="16" height="15" rx="2"/><path d="M4 10h16M8.5 3.5v4M15.5 3.5v4"/>',
  layers: '<path d="m12 4 8 4-8 4-8-4 8-4z"/><path d="m4 12.5 8 4 8-4"/><path d="m4 17 8 4 8-4"/>',
  branch: '<circle cx="6.5" cy="5.5" r="2.5"/><circle cx="6.5" cy="18.5" r="2.5"/><circle cx="17.5" cy="8.5" r="2.5"/><path d="M6.5 8v8"/><path d="M17.5 11c0 4-4 4.2-7 6"/>',
  refresh: '<path d="M20 11a8 8 0 1 0-2 6.3"/><path d="M20 4v7h-7"/>',
  alert: '<path d="M12 3 2.5 20h19L12 3z"/><path d="M12 9.5v5"/><circle cx="12" cy="17.6" r=".6" fill="currentColor"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v6"/><circle cx="12" cy="7.6" r=".7" fill="currentColor"/>',
  check: '<path d="m5 13 4.5 4.5L19 7"/>',
  x: '<path d="m6 6 12 12M18 6 6 18"/>',
  upload: '<path d="M12 20V9"/><path d="m7 13 5-5 5 5"/><path d="M4 4h16"/>',
  tools: '<path d="M14.5 6.5a4 4 0 0 0-5.3 5L4 16.7V20h3.3l5.2-5.2a4 4 0 0 0 5-5.3L15 12l-3-3 2.5-2.5z"/>',
  users: '<circle cx="9" cy="8" r="3.2"/><path d="M3.5 20c0-3.3 2.4-5.2 5.5-5.2s5.5 1.9 5.5 5.2"/><path d="M15.5 5.5a3.2 3.2 0 0 1 0 6.4M17.5 14.9c2.2.6 3.5 2.3 3.5 5.1"/>',
  flag: '<path d="M5.5 21V4"/><path d="M5.5 4.5h11l-2 3.5 2 3.5h-11"/>',
  logout: '<path d="M15 4h-9v16h9"/><path d="M11.5 12H21"/><path d="m18 8.5 3.5 3.5L18 15.5"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  link: '<path d="M10 14a4.5 4.5 0 0 0 6.4.4l2.8-2.8a4.5 4.5 0 0 0-6.4-6.4L11.4 6.6"/><path d="M14 10a4.5 4.5 0 0 0-6.4-.4l-2.8 2.8a4.5 4.5 0 0 0 6.4 6.4l1.4-1.4"/>',
  calc: '<rect x="5" y="3" width="14" height="18" rx="2.5"/><path d="M8.5 7.5h7"/><path d="M8.5 12h.01M12 12h.01M15.5 12h.01M8.5 15.5h.01M12 15.5h.01M15.5 15.5h.01M8.5 19h.01M12 19h.01M15.5 19h.01"/>',
  calcheck: '<rect x="4" y="5.5" width="16" height="15" rx="2"/><path d="M4 10h16M8.5 3.5v4M15.5 3.5v4"/><path d="m9 15 2.2 2.2L15.5 13"/>',
  tasks: '<path d="M4 6.5h9M4 12h9M4 17.5h9"/><path d="m16 5.5 2 2 3.5-3.5M16 11l2 2 3.5-3.5M16 16.5l2 2 3.5-3.5"/>',
  send: '<path d="M21 3 10.5 13.5"/><path d="M21 3 14 21l-3.5-7.5L3 10z"/>',
  rupee: '<path d="M7 4h10M7 8.5h10"/><path d="M7 4c6 0 6 8.5 0 8.5H13l5 7.5"/>',
  bank: '<path d="m3 9 9-5.5L21 9"/><path d="M4.5 9.5v8M9.5 9.5v8M14.5 9.5v8M19.5 9.5v8M3 20.5h18"/>',
  shield: '<path d="M12 3 5 5.5v5.6c0 4.4 3 7.4 7 9.9 4-2.5 7-5.5 7-9.9V5.5z"/><path d="m9 11.5 2.2 2.2L15.5 9.5"/>',
  briefcase: '<rect x="3" y="8" width="18" height="12" rx="1.5"/><path d="M9 8V5.5A1.5 1.5 0 0 1 10.5 4h3A1.5 1.5 0 0 1 15 5.5V8"/><path d="M3 13h18"/>',
  mail: '<rect x="3" y="5.5" width="18" height="13" rx="2"/><path d="m3.5 7 8.5 6.5L20.5 7"/>',
  google: '<path d="M21 12.2c0 5-3.6 8.3-8.9 8.3A9 9 0 1 1 12 3a8.7 8.7 0 0 1 6.2 2.5"/><path d="M12 8.5v7.2M8.4 12.1h7.2"/>',
  filter: '<path d="M4 6h16M7 12h10M10 18h4"/>',
  star: '<path d="m12 4 2.4 4.9 5.4.8-3.9 3.8.9 5.4-4.8-2.5-4.8 2.5.9-5.4L4.2 9.7l5.4-.8L12 4z"/>',
  globe: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.5 2.3 3.7 5.1 3.7 8.5S14.5 18.2 12 20.5c-2.5-2.3-3.7-5.1-3.7-8.5S9.5 5.8 12 3.5z"/>',
  wifiOff: '<path d="m3 3 18 18"/><path d="M8.4 15.4a5 5 0 0 1 7.2 0"/><path d="M5 12a9.7 9.7 0 0 1 3.3-2.2M19 12a9.7 9.7 0 0 0-6.9-2.9"/><path d="M2.6 8.6A14.5 14.5 0 0 1 7 6.1M21.4 8.6A14.5 14.5 0 0 0 13 4.6"/><circle cx="12" cy="19" r="1" fill="currentColor"/>',
  trash: '<path d="M5 7h14M9.5 7V4.8h5V7M7 7l1 13h8l1-13"/>',
  bookOpen: '<path d="M12 6C10 4 6.5 3.5 3.5 4v14c3-.5 6.5 0 8.5 2 2-2 5.5-2.5 8.5-2V4c-3-.5-6.5 0-8.5 2z"/><path d="M12 6v14"/>',
};

export function icon(name, cls = '') {
  const body = ICONS[name] || ICONS.info;
  return `<svg class="ic ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
}

// ── dates ──────────────────────────────────────────────────────────────
export function fmtDate(value) {
  if (!value) return '';
  try {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleDateString('en-IN', { year: 'numeric', month: 'short', day: 'numeric' });
  } catch { return ''; }
}

export function timeAgo(value) {
  if (!value) return '';
  const t = new Date(value).getTime();
  if (Number.isNaN(t)) return '';
  const days = Math.floor((Date.now() - t) / 86400000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 30) return `${days} days ago`;
  if (days < 365) return `${Math.floor(days / 30)} mo ago`;
  return `${Math.floor(days / 365)} yr ago`;
}

// ── toast ──────────────────────────────────────────────────────────────
let toastTimer = null;
export function toast(message, kind = 'ok') {
  const root = document.getElementById('toasts');
  if (!root) return;
  root.innerHTML = `<div class="toast toast--${kind}">${kind === 'ok' ? icon('check') : icon('alert')}<span>${esc(message)}</span></div>`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { root.innerHTML = ''; }, 2600);
}

// ── bottom sheet ───────────────────────────────────────────────────────
let openSheetEl = null;

/**
 * Close the open bottom sheet, if any.
 * @returns true when a sheet was actually open (so callers can treat the
 * event — e.g. the Android back button — as consumed).
 */
export function closeSheet() {
  if (openSheetEl) {
    const el = openSheetEl;
    openSheetEl = null;
    el.classList.remove('is-open');
    setTimeout(() => el.remove(), 180);
    return true;
  }
  return false;
}

/** true while a bottom sheet is showing (back-button precedence checks). */
export function sheetIsOpen() {
  return !!openSheetEl;
}

/**
 * Open a bottom sheet. `content` is an HTMLElement (or HTML string).
 * Returns { el, close }. Escape/backdrop closes it.
 */
export function sheet({ title, subtitle = '', content, className = '' }) {
  closeSheet();
  const root = document.createElement('div');
  root.className = 'sheet-root';
  root.innerHTML = `
    <div class="sheet-backdrop" data-dismiss="1"></div>
    <div class="sheet ${className}" role="dialog" aria-modal="true" aria-label="${esc(title || 'Options')}">
      <div class="sheet-grabber"></div>
      ${title ? `<div class="sheet-head"><h3>${esc(title)}</h3>${subtitle ? `<p>${esc(subtitle)}</p>` : ''}<button class="sheet-x" type="button" aria-label="Close">${icon('x')}</button></div>` : ''}
      <div class="sheet-body"></div>
    </div>`;
  const body = root.querySelector('.sheet-body');
  if (typeof content === 'string') body.innerHTML = content;
  else if (content) body.appendChild(content);
  document.body.appendChild(root);
  requestAnimationFrame(() => root.classList.add('is-open'));
  root.addEventListener('click', (e) => {
    if (e.target.closest('[data-dismiss]') || e.target.closest('.sheet-x')) closeSheet();
  });
  openSheetEl = root;
  return {
    el: root,
    close: closeSheet,
  };
}

export function confirmSheet({ title, text, confirmLabel, onConfirm, danger = false }) {
  const node = document.createElement('div');
  node.innerHTML = `
    <p class="sheet-text">${esc(text)}</p>
    <div class="sheet-actions">
      <button class="btn btn--ghost" data-dismiss="1" type="button">Cancel</button>
      <button class="btn ${danger ? 'btn--danger' : 'btn--primary'}" data-confirm="1" type="button">${esc(confirmLabel)}</button>
    </div>`;
  const s = sheet({ title, content: node });
  node.querySelector('[data-confirm]').addEventListener('click', () => {
    s.close();
    onConfirm();
  });
  return s;
}

// ── list/cards ─────────────────────────────────────────────────────────
export function metaLineHtml(item, { withViews = true, withDate = false } = {}) {
  const parts = [];
  if (item.course) parts.push(item.course);
  if (item.semester) parts.push(item.semester);
  if (item.session) parts.push(item.session);
  if (item.branch) parts.push(item.branch);
  const bits = parts.map((p) => `<span class="pm-chip">${esc(p)}</span>`).join('');
  const right = [];
  if (withViews) right.push(`<span class="pm-views">${icon('eye')} ${Number(item.views) || 0}</span>`);
  if (withDate && item.createdAt) right.push(`<span class="pm-date">${esc(timeAgo(item.createdAt))}</span>`);
  return `<div class="paper-meta">${bits || '<span class="pm-chip pm-chip--soft">General</span>'}<span class="pm-right">${right.join('')}</span></div>`;
}

export function paperCardHtml(item, { saved = false, showSaved = false } = {}) {
  return `
    <button class="paper-card" type="button" data-paper-id="${esc(item.id || '')}" data-slug="${esc(item.slug || '')}">
      <span class="paper-card-icon">${icon('pdf')}</span>
      <span class="paper-card-main">
        <span class="paper-card-title">${esc(item.title || 'Untitled paper')}</span>
        ${metaLineHtml(item)}
      </span>
      ${showSaved ? `<span class="paper-card-save ${saved ? 'is-saved' : ''}" aria-hidden="true">${icon(saved ? 'bookmarkFilled' : 'bookmark')}</span>` : `<span class="paper-card-go" aria-hidden="true">${icon('chevron')}</span>`}
    </button>`;
}

export function bindPaperList(root, onOpen) {
  root.addEventListener('click', (e) => {
    const card = e.target.closest('[data-paper-id]');
    if (!card || !root.contains(card)) return;
    onOpen({ id: card.dataset.paperId, slug: card.dataset.slug || '' });
  });
}

export function skeletonRows(n = 4) {
  let html = '<div class="skel-list" aria-hidden="true">';
  for (let i = 0; i < n; i++) {
    html += `<div class="skel-row"><div class="skel skel-icon"></div><div class="skel-lines"><div class="skel skel-line w70"></div><div class="skel skel-line w45"></div></div></div>`;
  }
  return html + '</div>';
}

export function stateBlock({ iconName = 'info', title, text = '', actionLabel = '', onAction = null, tone = '' }) {
  const node = document.createElement('div');
  node.className = `state-block ${tone ? 'state-block--' + tone : ''}`;
  node.innerHTML = `
    <div class="state-icon">${icon(iconName)}</div>
    <h4>${esc(title)}</h4>
    ${text ? `<p>${esc(text)}</p>` : ''}
    ${actionLabel ? `<button class="btn btn--primary" type="button">${esc(actionLabel)}</button>` : ''}`;
  if (actionLabel && onAction) {
    node.querySelector('button').addEventListener('click', onAction);
  }
  return node;
}

export function sectionHead(title, opts = {}) {
  const { iconName = '', actionLabel = '', onAction = null, note = '' } = opts;
  const el = document.createElement('div');
  el.className = 'section-head';
  el.innerHTML = `
    <h2>${iconName ? icon(iconName) : ''}<span>${esc(title)}</span></h2>
    ${note ? `<p class="section-note">${esc(note)}</p>` : ''}
    ${actionLabel ? '<button class="link-btn" type="button">' + esc(actionLabel) + icon('chevron') + '</button>' : ''}`;
  if (actionLabel && onAction) {
    el.querySelector('.link-btn').addEventListener('click', onAction);
  }
  return el;
}

export function chipRow(chips, { active, onPick, id = '' }) {
  const el = document.createElement('div');
  el.className = 'chip-row';
  if (id) el.id = id;
  el.innerHTML = chips.map((c) => {
    const value = typeof c === 'string' ? c : c.value;
    const label = typeof c === 'string' ? c : c.label;
    return `<button class="chip ${String(active || '') === String(value) ? 'is-active' : ''}" type="button" data-chip="${esc(value)}">${esc(label)}</button>`;
  }).join('');
  el.addEventListener('click', (e) => {
    const b = e.target.closest('[data-chip]');
    if (!b) return;
    onPick(b.dataset.chip);
  });
  return el;
}

export function updateChipRow(el, active) {
  if (!el) return;
  el.querySelectorAll('[data-chip]').forEach((b) => {
    b.classList.toggle('is-active', String(b.dataset.chip || '') === String(active || ''));
  });
}

// ── paper lists (shared by search / browse / saved / home sections) ────
/**
 * Render a list of paper cards into `container` and wire interaction:
 *  - tap card      → ctx.openPaper({ id, slug })
 *  - tap bookmark  → toggle on-device saved state, no API traffic
 */
export function paperList(container, ctx, items, { showSaved = false } = {}) {
  container.innerHTML = '';
  if (!Array.isArray(items) || !items.length) return;
  const wrap = document.createElement('div');
  wrap.innerHTML = items.map((item) => paperCardHtml(item, {
    saved: ctx.store.isSaved(item.id),
    showSaved,
  })).join('');
  container.appendChild(wrap);

  wrap.addEventListener('click', (e) => {
    const card = e.target.closest('[data-paper-id]');
    if (!card) return;
    const id = card.dataset.paperId;
    const item = items.find((x) => String(x.id) === String(id)) || { id, slug: card.dataset.slug };
    ctx.openPaper({ ...item, slug: card.dataset.slug || item.slug || '' });
  });

  if (showSaved) {
    wrap.querySelectorAll('.paper-card').forEach((card) => {
      const btn = card.querySelector('.paper-card-save');
      if (!btn) return;
      btn.style.cursor = 'pointer';
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = card.dataset.paperId;
        const item = items.find((x) => String(x.id) === id);
        if (!item) return;
        const nowSaved = ctx.store.toggleSaved(item);
        btn.classList.toggle('is-saved', nowSaved);
        btn.innerHTML = icon(nowSaved ? 'bookmarkFilled' : 'bookmark');
        toast(nowSaved ? 'Saved on this device' : 'Removed from saved');
      });
    });
  }
}

/** Small "stale data" pill shown when offline cache served the screen. */
export function stalePill(text = 'Showing cached copy') {
  return `<span class="stale-note">${icon('alert')}${esc(text)}</span>`;
}
