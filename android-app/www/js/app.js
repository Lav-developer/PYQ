/**
 * DSMNRU PYQ Android — app shell & router.
 *
 * Owns: bottom navigation, the single app bar, the view stack + Android back
 * button, network banner, auth gate orchestration and deep-link hand-off.
 * Screens (home/search/browse/saved/profile/paper) live in ./views/*.
 */

import { createApi, SITE_ORIGIN } from './api.js';
import { createAuth } from './auth.js';
import { createStore } from './store.js';
import { native } from './native.js';
import { parseSiteUrl } from './slug.js';
import * as ui from './ui.js';
import { openAuthSheet, verificationPromptSheet, googleInfoSheet, initAuthUI } from './authui.js';

import renderHome from './views/home.js';
import renderSearch from './views/search.js';
import renderBrowse from './views/browse.js';
import renderCourse from './views/course.js';
import renderSaved from './views/saved.js';
import renderProfile from './views/profile.js';
import renderPaper from './views/paper.js';

const VIEWS = {
  home: renderHome,
  search: renderSearch,
  browse: renderBrowse,
  course: renderCourse,
  saved: renderSaved,
  profile: renderProfile,
  paper: renderPaper,
};
const TAB_VIEWS = new Set(['home', 'search', 'browse', 'saved', 'profile']);

const storage = (typeof localStorage !== 'undefined') ? localStorage : null;
const api = createApi({ storage });
const auth = createAuth({ storage });
const store = createStore({ storage });
initAuthUI(auth);

const els = {
  appbar: document.getElementById('appbar'),
  back: document.getElementById('appbar-back'),
  title: document.getElementById('appbar-title'),
  actions: document.getElementById('appbar-actions'),
  view: document.getElementById('view'),
  tabbar: document.getElementById('tabbar'),
  net: document.getElementById('net-banner'),
};

const state = {
  online: navigator.onLine !== false,
};

// ── router ─────────────────────────────────────────────────────────────
const stack = [{ view: 'home', params: {} }];
let currentRefresh = null;   // view-provided silent refresh handler
let renderToken = 0;

function current() { return stack[stack.length - 1]; }

async function renderView() {
  const entry = current();
  const token = ++renderToken;
  currentRefresh = null;
  els.view.innerHTML = '';
  els.view.classList.remove('is-anim');
  void els.view.offsetWidth; // restart the entry animation without layout thrash later
  els.view.classList.add('is-anim');
  const ctx = buildContext(entry);
  try {
    await VIEWS[entry.view](els.view, ctx, entry.params || {});
  } catch (err) {
    if (err && err.name === 'AbortError') return;
    console.warn('view render failed:', err);
    if (token !== renderToken) return;
    els.view.innerHTML = '';
    els.view.appendChild(ui.stateBlock({
      iconName: 'alert',
      tone: 'error',
      title: 'This screen hit a snag',
      text: String(err && err.message || err),
      actionLabel: 'Try again',
      onAction: () => renderView(),
    }));
  }
  updateHeader(entry);
  updateTabbar();
}

function updateHeader(entry) {
  const meta = entry.header || { title: 'DSMNRU PYQ' };
  const isRoot = TAB_VIEWS.has(entry.view) && stack.length === 1;
  els.back.hidden = isRoot && !meta.back;
  els.back.innerHTML = ui.icon('back');
  els.title.innerHTML = (isRoot || meta.brand)
    ? `<span class="brand-logo" aria-hidden="true"></span><span>DSMNRU PYQ<small>PYQ archive · Android</small></span>`
    : `<span>${ui.esc(meta.title || '')}${meta.sub ? `<small>${ui.esc(meta.sub)}</small>` : ''}</span>`;
  els.actions.innerHTML = '';
  (meta.actions || []).forEach((a) => {
    const b = document.createElement('button');
    b.className = 'icon-btn';
    b.type = 'button';
    b.setAttribute('aria-label', a.label);
    b.innerHTML = ui.icon(a.icon);
    b.addEventListener('click', a.onTap);
    els.actions.appendChild(b);
  });
}

function updateTabbar() {
  // While a pushed screen (paper / course drill-down) is open, keep the
  // nearest parent tab highlighted — standard Android bottom-nav behavior.
  let active = 'home';
  for (let i = stack.length - 1; i >= 0; i--) {
    if (TAB_VIEWS.has(stack[i].view)) { active = stack[i].view; break; }
  }
  els.tabbar.querySelectorAll('.tab').forEach((t) => {
    t.classList.toggle('is-active', t.dataset.tab === active);
  });
}

els.back.innerHTML = ui.icon('back');
els.back.addEventListener('click', () => routerBack());
els.tabbar.querySelectorAll('.tab').forEach((t) => {
  t.querySelector('.tab-ic').innerHTML = ui.icon({
    home: 'home', search: 'search', browse: 'courses', saved: 'bookmark', profile: 'user',
  }[t.dataset.tab]);
  t.addEventListener('click', () => {
    const name = t.dataset.tab;
    if (current().view === name && stack.length === 1) {
      // Re-tap the active tab: scroll to top + silent refresh (Android idiom).
      if (els.view.scrollTop > 8) els.view.scrollTo({ top: 0, behavior: 'smooth' });
      else if (currentRefresh) currentRefresh();
    } else {
      router.tab(name);
    }
  });
});

const router = {
  tab(view, params = {}) {
    stack.length = 0;
    stack.push({ view, params });
    renderView();
  },
  go(view, params = {}) {
    const entry = current();
    if (entry) entry.scrollTop = els.view.scrollTop;
    stack.push({ view, params });
    renderView();
  },
  replace(view, params = {}) {
    stack[stack.length - 1] = { view, params };
    renderView();
  },
  back() {
    if (stack.length <= 1) return false;
    stack.pop();
    renderView().then(() => {
      els.view.scrollTop = current().scrollTop || 0;
    });
    return true;
  },
  /** Views declare the app-bar identity + a silent refresh handler. */
  setHeader(entry2, header) { entry2.header = header; },
  setRefresh(fn) { currentRefresh = fn; },
};

function routerBack() {
  ui.closeSheet();
  if (stack.length > 1) { router.back(); return true; }
  if (current().view !== 'home') { router.tab('home'); return true; }
  return false;
}

function buildContext(entry) {
  return {
    api, auth, store, native, ui, SITE_ORIGIN,
    state,
    entry,
    router,
    /** true → privilege-gated action is allowed; otherwise opens the right sheet. */
    requireAuth(onPass, reason) {
      if (auth.current() && !auth.needsEmailVerification()) { onPass(); return true; }
      if (!auth.current()) {
        openAuthSheet({
          reason: reason || 'Sign in to unlock full search, browsing beyond page 1 and PDF actions.',
          onAuthenticated: () => onPass(),
        });
      } else {
        verificationPromptSheet({
          afterVerified: () => onPass(),
        });
      }
      return false;
    },
    openGoogleInfo() { googleInfoSheet(); },
    openPaper(params) { openPaperTarget(params); },
    setHeader(header) {
      entry.header = header;
      updateHeader(entry);
    },
    setRefresh(fn) { router.setRefresh(fn); },
  };
}

/**
 * Open a paper from id and/or slug. A slug without an id (shared deep link)
 * is resolved with one exact Worker lookup — with a local fallback — so the
 * app never has to render the website. Unresolvable slugs hand off to the
 * browser instead of dead-ending.
 */
async function openPaperTarget(params) {
  const target = { ...(params || {}) };
  if (target.id || !target.slug) {
    router.go('paper', target);
    return;
  }
  ui.toast('Resolving paper…');
  const item = await api.resolveSlug(target.slug).catch(() => null);
  if (item && item.id) {
    router.go('paper', { id: item.id, slug: target.slug });
  } else {
    ui.toast('Opening on the website instead');
    native.openExternal(`${SITE_ORIGIN}/pyq/${encodeURIComponent(target.slug)}`);
  }
}

// ── deep links ─────────────────────────────────────────────────────────
let lastHandledLink = '';

async function handleDeepLinkUrl(href, { fromLaunch = false } = {}) {
  if (!href || href === lastHandledLink) return;
  lastHandledLink = href;
  const route = parseSiteUrl(href);
  if (!route) {
    if (!fromLaunch && href) native.openExternal(href);
    return;
  }
  if (route.view === 'paper') {
    await openPaperTarget({ id: route.id, slug: route.slug });
  } else if (route.view === 'search') {
    router.tab('search', { q: route.q || '' });
  } else {
    router.tab('home');
  }
}

// ── network awareness (no polling — event driven only) ────────────────
function paintNetworkBanner() {
  if (state.online) {
    els.net.hidden = true;
    return;
  }
  els.net.hidden = false;
  els.net.className = 'net-banner';
  els.net.innerHTML = `${ui.icon('wifiOff')}<span>Offline — showing cached archive data where available</span>`;
}
window.addEventListener('online', () => { state.online = true; paintNetworkBanner(); });
window.addEventListener('offline', () => { state.online = false; paintNetworkBanner(); });

// ── Android integration ────────────────────────────────────────────────
function capacitorApp() {
  try {
    const cap = globalThis.Capacitor;
    if (cap && typeof cap.registerPlugin === 'function') return cap.registerPlugin('App');
  } catch { /* browser preview */ }
  return null;
}

function wireAndroid() {
  const App = capacitorApp();
  if (!App) return;
  try {
    App.addListener('backButton', () => {
      if (!routerBack()) App.exitApp();
    });
    App.addListener('resume', () => {
      state.online = navigator.onLine !== false;
      paintNetworkBanner();
      auth.refreshIfNeeded();
      checkLaunchLink();
    });
  } catch { /* older core without listeners — WebView defaults apply */ }
}

/**
 * Belt-and-braces deep-link delivery: MainActivity also pushes a
 * 'siteDeepLink' event (native.js onLink), but on some warm starts the push
 * can race listener attach, so the launch intent is re-checked whenever the
 * app becomes visible. lastHandledLink makes both paths idempotent.
 */
async function checkLaunchLink() {
  try {
    const url = await native.getLaunchUrl();
    if (url) await handleDeepLinkUrl(url, { fromLaunch: true });
  } catch { /* ignore */ }
}
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) checkLaunchLink();
});

// ── boot ───────────────────────────────────────────────────────────────
async function boot() {
  wireAndroid();
  paintNetworkBanner();

  // Restore a persisted Firebase session (zero requests when the token is
  // still fresh; one refresh call only when close to expiry).
  await auth.restore().catch(() => {});
  auth.onChange(() => { renderView(); });

  // Deep link handoff (cold start intent from a /pyq/<slug> share link).
  const launchUrl = await native.getLaunchUrl().catch(() => '');
  if (launchUrl) {
    await handleDeepLinkUrl(launchUrl, { fromLaunch: true });
  } else {
    router.tab('home');
  }

  // Warm-start links forwarded by MainActivity.
  native.onLink((url) => handleDeepLinkUrl(url));
}

boot();
