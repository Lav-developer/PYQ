/**
 * DSMNRU PYQ Android — Profile & app settings.
 *
 * Auth = the existing Firebase project (email/password verified in-app via
 * the Identity Toolkit REST endpoints — same accounts, same rules). Public
 * archive data never touches Firestore, so this screen loads with zero
 * database reads; the optional profile-row sync only ever happens right
 * after a manual sign-in (see auth.js).
 */

const APP_VERSION = '1.3.0';

export default async function renderProfile(root, ctx) {
  const { ui, auth, store, api, native } = ctx;
  ctx.setHeader({ title: 'Profile', brand: false });

  const user = auth.current();
  const privileged = auth.canUnlockPrivileges();
  const initials = (user && user.name ? user.name : '?')
    .split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();

  root.innerHTML = '';
  const stack = document.createElement('div');
  stack.className = 'stack';

  // ── identity card ────────────────────────────────────────────────────
  const idCard = document.createElement('section');
  idCard.className = 'card card-pad';
  if (user) {
    idCard.innerHTML = `
      <div class="profile-card">
        <div class="avatar">${ui.esc(initials)}</div>
        <div class="grow">
          <div class="profile-name">${ui.esc(user.name || 'Student')}
            ${privileged
              ? `<span class="badge badge--ok">${ui.icon('check')}verified</span>`
              : `<span class="badge badge--warn">${ui.icon('mail')}verify email</span>`}
            ${user.admin ? '<span class="badge badge--ok">admin</span>' : ''}
          </div>
          <div class="profile-mail">${ui.esc(user.email || '')}${user.providerId === 'google.com' ? ' · Google account' : ' · DSMNRU Firebase account'}</div>
          ${user.degraded ? '<div class="profile-mail" style="color:var(--gold)">Session refresh pending — online reconnect will renew it</div>' : ''}
        </div>
      </div>`;
  } else {
    idCard.innerHTML = `
      <div class="profile-card">
        <div class="avatar avatar--ghost">${ui.icon('user')}</div>
        <div class="grow">
          <div class="profile-name">Not signed in</div>
          <div class="profile-mail">Browsing works; sign in unlocks search, more pages and PDF actions — exactly like the website.</div>
        </div>
      </div>
      <div class="sheet-actions">
        <button class="btn btn--primary" data-act="login" type="button">Sign in</button>
        <button class="btn btn--ghost" data-act="signup" type="button">Create account</button>
      </div>`;
  }
  stack.appendChild(idCard);

  if (user && !privileged) {
    const note = document.createElement('section');
    note.className = 'notice';
    note.innerHTML = `${ui.icon('mail')}<div><b>Verify ${ui.esc(user.email || 'your email')}.</b> The website enforces verified accounts for search, pagination and downloads — the app keeps that rule.</div>
      <div style="flex:0 0 auto"></div>`;
    const btn = document.createElement('div');
    btn.className = 'notice-actions';
    btn.innerHTML = `
      <button class="btn btn--ghost" data-act="resend" type="button">Resend link</button>
      <button class="btn btn--primary" data-act="checked" type="button">I've verified</button>`;
    const wrap = document.createElement('section');
    wrap.className = 'notice';
    wrap.style.flexDirection = 'column';
    wrap.innerHTML = note.innerHTML;
    wrap.appendChild(btn);
    wrap.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-act]');
      if (!b) return;
      if (b.dataset.act === 'resend') {
        try { await auth.resendVerification(); ui.toast('Verification email sent'); }
        catch (err) { ui.toast(String(err.message || err), 'err'); }
      } else {
        await auth.reloadProfile();
        ui.toast('Checked');
      }
    });
    stack.appendChild(wrap);
  }

  // ── device data ──────────────────────────────────────────────────────
  const dataCard = document.createElement('section');
  dataCard.className = 'card card-pad';
  const savedCount = store.savedList().length;
  const recentCount = store.recentViews().length;
  dataCard.innerHTML = `
    <div style="display:flex;gap:18px;margin-bottom:6px">
      <div><div class="hero-title" style="font-size:1.15rem">${savedCount}</div><div class="h-sub">saved papers</div></div>
      <div><div class="hero-title" style="font-size:1.15rem">${recentCount}</div><div class="h-sub">recently viewed</div></div>
      <div class="grow"></div>
    </div>
    <div class="sheet-list" id="prof-data">
      <button class="sheet-item" data-act="cache" type="button">${ui.icon('refresh')}<span>Refresh archive cache<small>Homepage & catalog data kept on this device for instant, low-traffic starts</small></span><span class="tail">${ui.icon('chevron')}</span></button>
      <button class="sheet-item" data-act="clearq" type="button">${ui.icon('trash')}<span>Clear recent searches<small>Stored only on this device</small></span><span class="tail">${ui.icon('chevron')}</span></button>
    </div>`;
  dataCard.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    if (b.dataset.act === 'cache') {
      ui.toast('Refreshing homepage + catalog…');
      try {
        await Promise.all([api.homepage({ force: true }), api.courses({ force: true })]);
        ui.toast('Cache refreshed');
      } catch { ui.toast('Offline — kept existing cache', 'err'); }
    }
    if (b.dataset.act === 'clearq') {
      store.clearRecentQueries();
      ui.toast('Recent searches cleared');
    }
  });
  stack.appendChild(dataCard);

  // ── account actions / about ──────────────────────────────────────────
  const more = document.createElement('section');
  more.className = 'card card-pad';
  const items = [];
  if (user) {
    items.push({ act: 'signout', icon: 'logout', label: 'Sign out', sub: 'Keeps your saved papers on this device' });
  } else {
    items.push({ act: 'google', icon: 'google', label: 'Sign in with Google', sub: 'Native account chooser — same Firebase account as the website' });
  }
  if (user && user.admin) {
    items.push({ act: 'admin', icon: 'tools', label: 'Open admin panel', sub: 'Administration stays on the website — there is no second panel' });
  }
  items.push({ act: 'about', icon: 'info', label: `About this app · v${APP_VERSION}`, sub: 'Same backend as the website — dedicated Android interface' });
  more.innerHTML = `<div class="sheet-list">${items.map((it) => `
    <button class="sheet-item" data-act="${it.act}" type="button">${ui.icon(it.icon)}<span>${ui.esc(it.label)}<small>${ui.esc(it.sub)}</small></span><span class="tail">${ui.icon('chevron')}</span></button>`).join('')}</div>`;
  more.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    switch (b.dataset.act) {
      case 'signout':
        ui.confirmSheet({
          title: 'Sign out?',
          text: 'Your saved papers and browsing history stay on this device. The app keeps working in guest mode.',
          confirmLabel: 'Sign out',
          onConfirm: () => { auth.signOut(); ui.toast('Signed out'); },
        });
        break;
      case 'google': {
        import('../authui.js').then(({ startGoogleSignIn }) => startGoogleSignIn({}));
        break;
      }
      case 'admin':
        native.openExternal('https://dsmnru-pyq.netlify.app/admin.html');
        break;
      case 'about':
        ui.sheet({
          title: `DSMNRU PYQ v${APP_VERSION}`,
          content: `<p class="sheet-text">A dedicated Android interface for the DSMNRU PYQ / Syllabus
            archive — built for this app, not a copy of the website.<br><br>
            · Public data (papers, search, courses, homepage) is served by the existing
            Cloudflare Worker over Cloudflare KV. The app never reads the archive from Firestore.<br>
            · Sign-in uses the same Firebase Authentication project as the website.<br>
            · Saved papers and history are stored only on this device.<br>
            · PDFs open from their original hosts — nothing is mirrored into app storage.</p>
            <p class="form-note">© DSMNRU Academic Archive · dsmnru-pyq.netlify.app</p>`,
        });
        break;
    }
  });
  stack.appendChild(more);

  root.appendChild(stack);

  if (!user) {
    const act = idCard.querySelector('.sheet-actions');
    act.addEventListener('click', (e) => {
      const b = e.target.closest('[data-act]');
      if (!b) return;
      import('../authui.js').then(({ openAuthSheet }) => openAuthSheet({
        mode: b.dataset.act === 'signup' ? 'signup' : 'login',
        reason: b.dataset.act === 'signup'
          ? 'Create your DSMNRU account (works on the website too).'
          : '',
      }));
    });
  } else {
    const wrapBtn = idCard.querySelector('[data-act="verify"]');
    if (wrapBtn) wrapBtn.addEventListener('click', () => auth.reloadProfile());
  }

  ctx.setRefresh(() => renderProfile(root, ctx, {}));
}
