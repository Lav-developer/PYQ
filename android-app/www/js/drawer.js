/**
 * DSMNRU PYQ Android — app side drawer (navigation menu).
 *
 * A standard Android navigation drawer: slides in from the start edge over a
 * scrim, closes on scrim tap / item pick / Escape / hardware back, and shows
 * the sign-in state in its footer. It is the app's hub for the in-app
 * feature screens (Upload Paper, Study Tools, Contributors, Links) plus the
 * existing bottom tabs and About — it NEVER opens the website.
 *
 * Pure UI: navigation intents are handed to the `onNavigate({ kind, view, params })`
 * callback provided by app.js, so routing/back-stack ownership stays in one place.
 */

import * as ui from './ui.js';

const TABS = [
  { view: 'home', icon: 'home', label: 'Home' },
  { view: 'search', icon: 'search', label: 'Search' },
  { view: 'browse', icon: 'courses', label: 'Courses' },
  { view: 'saved', icon: 'bookmark', label: 'Saved' },
  { view: 'profile', icon: 'user', label: 'Profile & settings' },
];

const FEATURES = [
  { view: 'upload', icon: 'upload', label: 'Upload paper', sub: 'Contribute a PYQ — works fully in-app' },
  { view: 'tools', icon: 'tools', label: 'Study tools', sub: 'CGPA · attendance · planner — run on-device' },
  { view: 'contributors', icon: 'users', label: 'Contributors', sub: 'The students behind the archive' },
  { view: 'links', icon: 'link', label: 'Links', sub: 'University & scholarship portals' },
];

export function createDrawer({ onNavigate, onAbout }) {
  const root = document.createElement('div');
  root.id = 'drawer-root';
  root.className = 'drawer-root';
  root.hidden = true;
  root.innerHTML = `
    <div class="drawer-scrim" data-drawer-dismiss="1"></div>
    <aside class="drawer" role="dialog" aria-modal="true" aria-label="Menu">
      <div class="drawer-head">
        <div class="drawer-logo" aria-hidden="true"></div>
        <div class="grow" style="min-width:0">
          <div class="drawer-title">DSMNRU PYQ</div>
          <div class="drawer-sub">PYQ archive · Android app</div>
        </div>
        <button class="icon-btn drawer-x" type="button" aria-label="Close menu">${ui.icon('x')}</button>
      </div>
      <div class="drawer-user" data-drawer-user></div>
      <nav class="drawer-nav" aria-label="Menu">
        ${TABS.map((t) => `
          <button class="drawer-item" type="button" data-kind="tab" data-view="${t.view}">
            <span class="di-ic">${ui.icon(t.icon)}</span><span>${ui.esc(t.label)}</span>
          </button>`).join('')}
        <div class="drawer-sep" role="separator"></div>
        ${FEATURES.map((t) => `
          <button class="drawer-item" type="button" data-kind="go" data-view="${t.view}">
            <span class="di-ic">${ui.icon(t.icon)}</span>
            <span>${ui.esc(t.label)}<small>${ui.esc(t.sub)}</small></span>
          </button>`).join('')}
        <div class="drawer-sep" role="separator"></div>
        <button class="drawer-item" type="button" data-kind="about" data-view="about">
          <span class="di-ic">${ui.icon('info')}</span><span>About this app</span>
        </button>
      </nav>
      <div class="drawer-foot" data-drawer-foot></div>
    </aside>`;

  let open = false;

  function setOpen(next) {
    if (next === open) return;
    open = next;
    if (open) {
      root.hidden = false;
      paintUser();
      requestAnimationFrame(() => root.classList.add('is-open'));
    } else {
      root.classList.remove('is-open');
      setTimeout(() => { if (!open) root.hidden = true; }, 200);
    }
  }

  function paintUser() {
    // Painted on open so the drawer always reflects current auth state.
    const userEl = root.querySelector('[data-drawer-user]');
    const footEl = root.querySelector('[data-drawer-foot]');
    if (!userEl || !paintUser.state) return;
    const { userName, email, signedIn } = paintUser.state;
    if (signedIn) {
      const initials = String(userName || '?').split(/\s+/).filter(Boolean).slice(0, 2)
        .map((w) => w[0]).join('').toUpperCase();
      userEl.innerHTML = `
        <div class="drawer-avatar">${ui.esc(initials)}</div>
        <div style="min-width:0">
          <div class="drawer-user-name">${ui.esc(userName || 'Student')}</div>
          <div class="drawer-user-mail">${ui.esc(email || '')}</div>
        </div>`;
      footEl.innerHTML = 'Signed in — same Firebase account as the website';
    } else {
      userEl.innerHTML = `
        <div class="drawer-avatar drawer-avatar--ghost">${ui.icon('user')}</div>
        <div style="min-width:0">
          <div class="drawer-user-name">Browsing as guest</div>
          <div class="drawer-user-mail">Sign in from the Profile tab</div>
        </div>`;
      footEl.innerHTML = 'Sign-in, saves and uploads stay inside the app';
    }
  }

  /** app.js refreshes this snapshot whenever auth changes or drawer opens. */
  paintUser.state = { signedIn: false, userName: '', email: '' };

  root.addEventListener('click', (e) => {
    if (e.target.closest('[data-drawer-dismiss]') || e.target.closest('.drawer-x')) {
      setOpen(false);
      return;
    }
    const item = e.target.closest('.drawer-item');
    if (!item) return;
    setOpen(false);
    if (item.dataset.kind === 'about') {
      if (onAbout) onAbout();
      return;
    }
    if (onNavigate) {
      onNavigate({ kind: item.dataset.kind, view: item.dataset.view, params: {} });
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && open) setOpen(false);
  });

  return {
    el: root,
    open: () => setOpen(true),
    close: () => setOpen(false),
    /** Consume a hardware-back press: true when the drawer was open and got closed. */
    closeIfOpen() {
      if (!open) return false;
      setOpen(false);
      return true;
    },
    isOpen() { return open; },
    setAuthState(state) { paintUser.state = state || paintUser.state; if (open) paintUser(); },
  };
}
