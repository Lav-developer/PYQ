/**
 * DSMNRU PYQ Android — Profile, account management & rewards.
 *
 * Auth = the existing Firebase project (same accounts as the website). The
 * profile row is the SAME users/{uid} document the website creates; name
 * edits update the Firebase Auth display name plus that row (owner-writable
 * per the existing rules). Reward/contribution data is the SAME email-keyed
 * reward_accounts + point_transactions data the website's points card reads,
 * fetched lazily (two reads, on this screen only — never at startup, never
 * for signed-out users). No endpoint URLs or project identifiers are ever
 * rendered — everything user-facing is human text.
 */

const APP_VERSION = '1.3.2';

function esc(s) { return String(s == null ? '' : s); }

function initialsOf(name) {
  return String(name || '?').split(/\s+/).filter(Boolean).slice(0, 2)
    .map((w) => w[0]).join('').toUpperCase() || '?';
}

function dateLabel(iso) {
  try {
    return new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
  } catch { return ''; }
}

export default async function renderProfile(root, ctx) {
  const { ui, auth, store, api, native, router } = ctx;
  ctx.setHeader({ title: 'Profile', brand: false });

  const user = auth.current();
  const privileged = auth.canUnlockPrivileges();

  root.innerHTML = '';
  const stack = document.createElement('div');
  stack.className = 'stack';

  // ── identity card ────────────────────────────────────────────────────
  const idCard = document.createElement('section');
  idCard.className = 'card card-pad';
  if (user) {
    const picture = user.picture && /^https:\/\//.test(user.picture) ? user.picture : '';
    idCard.innerHTML = `
      <div class="profile-card">
        <div class="avatar">${picture
          ? `<img class="avatar-img" src="${ui.esc(picture)}" alt="" referrerpolicy="no-referrer">`
          : ui.esc(initialsOf(user.name))}</div>
        <div class="grow">
          <div class="profile-name">${ui.esc(user.name || 'Student')}
            ${privileged
              ? `<span class="badge badge--ok">${ui.icon('check')}verified</span>`
              : `<span class="badge badge--warn">${ui.icon('mail')}verify email</span>`}
            ${user.admin ? '<span class="badge badge--ok">admin</span>' : ''}
          </div>
          <div class="profile-mail">${ui.esc(user.email || '')}</div>
          <div class="profile-mail">${user.providerId === 'google.com' ? 'Google account' : 'DSMNRU account'}</div>
          ${user.degraded ? '<div class="profile-mail" style="color:var(--gold)">Session refresh pending — it renews when you are back online</div>' : ''}
        </div>
      </div>
      <div class="sheet-list" style="margin-top:10px">
        <button class="sheet-item" data-act="editname" type="button">${ui.icon('user')}<span>Edit name<small>Shown with your contributions</small></span><span class="tail">${ui.icon('chevron')}</span></button>
      </div>
      <p class="form-note" style="margin-top:12px">Version ${APP_VERSION}</p>`;
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
    const wrap = document.createElement('section');
    wrap.className = 'notice';
    wrap.style.flexDirection = 'column';
    wrap.innerHTML = `${ui.icon('mail')}<div><b>Verify ${ui.esc(user.email || 'your email')}.</b> Verified accounts unlock search, pagination and downloads — the same rule as the website.</div>
      <div class="notice-actions">
        <button class="btn btn--ghost" data-act="resend" type="button">Resend link</button>
        <button class="btn btn--primary" data-act="checked" type="button">I've verified</button>
      </div>`;
    wrap.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-act]');
      if (!b) return;
      if (b.dataset.act === 'resend') {
        b.disabled = true;
        try { await auth.resendVerification(); ui.toast('Verification email sent'); }
        catch (err) { ui.toast(String(err.message || err), 'err'); }
        finally { b.disabled = false; }
      } else {
        b.disabled = true;
        await auth.reloadProfile();
        ui.toast('Checked');
        renderProfile(root, ctx);
      }
    });
    stack.appendChild(wrap);
  }

  // ── rewards / contributions (signed-in, lazy, cached per session) ────
  if (user) {
    const rewardsCard = document.createElement('section');
    rewardsCard.className = 'card card-pad';
    rewardsCard.innerHTML = `
      <div class="section-head">${ui.icon('star')}<h2>Your contributions</h2></div>
      <div id="pf-rewards">${ui.skeletonRows(2)}</div>`;
    stack.appendChild(rewardsCard);
    paintRewards(rewardsCard.querySelector('#pf-rewards'), ctx, { email: user.email });
  }

  // ── device data ──────────────────────────────────────────────────────
  const dataCard = document.createElement('section');
  dataCard.className = 'card card-pad';
  const savedCount = store.savedList().length;
  const recentCount = store.recentViews().length;
  dataCard.innerHTML = `
    <div class="section-head">${ui.icon('bookmark')}<h2>On this device</h2></div>
    <div style="display:flex;gap:20px;margin:12px 0 2px">
      <div><div class="hero-title" style="font-size:1.15rem">${savedCount}</div><div class="h-sub">saved papers</div></div>
      <div><div class="hero-title" style="font-size:1.15rem">${recentCount}</div><div class="h-sub">recently viewed</div></div>
      <div class="grow"></div>
    </div>
    <div class="sheet-list">
      <button class="sheet-item" data-act="cache" type="button">${ui.icon('refresh')}<span>Refresh archive cache<small>Instant, low-traffic starts on this device</small></span><span class="tail">${ui.icon('chevron')}</span></button>
      <button class="sheet-item" data-act="clearq" type="button">${ui.icon('trash')}<span>Clear recent searches<small>Stored only on this device</small></span><span class="tail">${ui.icon('chevron')}</span></button>
    </div>`;
  dataCard.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    if (b.dataset.act === 'cache') {
      b.disabled = true;
      ui.toast('Refreshing archive…');
      try {
        await Promise.all([api.homepage({ force: true }), api.courses({ force: true })]);
        ui.toast('Archive up to date');
      } catch { ui.toast("Couldn't refresh — you appear to be offline", 'err'); }
      finally { b.disabled = false; }
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
    items.push({ act: 'google', icon: 'google', label: 'Sign in with Google', sub: 'Your Google account, right on this device' });
  }
  if (user && user.admin) {
    items.push({ act: 'admin', icon: 'tools', label: 'Open admin panel', sub: 'Administration stays on the website — there is no second panel' });
  }
  items.push({ act: 'about', icon: 'info', label: 'About this app', sub: `Version ${APP_VERSION}` });
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
          title: `DSMNRU PYQ · Version ${APP_VERSION}`,
          content: `<p class="sheet-text">A dedicated Android app for the DSMNRU previous-year
            question-paper archive — same data and accounts as the website, in a
            native interface.<br><br>
            · Papers, search and courses come from the shared archive service.<br>
            · Sign-in uses the same account system as the website — nothing new is created.<br>
            · Saved papers and history stay only on this device.<br>
            · PDFs open from their original hosts — nothing is copied into app storage.</p>
            <p class="form-note">© DSMNRU Academic Archive</p>`,
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
        reason: b.dataset.act === 'signup' ? 'Create your DSMNRU account — it works right here in the app.' : '',
      }));
    });
  } else {
    idCard.addEventListener('click', (e) => {
      const b = e.target.closest('[data-act="editname"]');
      if (!b) return;
      openEditNameSheet(ctx, () => renderProfile(root, ctx));
    });
  }

  ctx.setRefresh(() => renderProfile(root, ctx, {}));
}

// ── edit display name ──────────────────────────────────────────────────

function openEditNameSheet(ctx, onSaved) {
  const { ui, auth } = ctx;
  const user = auth.current();
  if (!user) return;
  const node = document.createElement('div');
  node.innerHTML = `
    <div data-err class="form-error" hidden role="alert"></div>
    <div class="field">
      <label for="pf-name">Display name</label>
      <input class="input" id="pf-name" type="text" maxlength="80" value="${ui.esc(user.name || '')}" enterkeyhint="done">
      <p class="field-hint">2–80 characters. The same profile is shown on the website.</p>
    </div>
    <div class="sheet-actions">
      <button class="btn btn--ghost" data-dismiss="1" type="button">Cancel</button>
      <button class="btn btn--primary" id="pf-save" type="button">Save</button>
    </div>`;
  const s = ui.sheet({ title: 'Edit name', content: node });
  const saveBtn = node.querySelector('#pf-save');
  const errEl = node.querySelector('[data-err]');
  const input = node.querySelector('#pf-name');
  saveBtn.addEventListener('click', async () => {
    if (saveBtn.disabled) return;
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving…';
    errEl.hidden = true;
    try {
      await auth.updateDisplayName(input.value);
      s.close();
      ui.toast('Profile updated');
      if (onSaved) onSaved();
    } catch (err) {
      errEl.textContent = String(err && err.message || err);
      errEl.hidden = false;
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save';
    }
  });
}

// ── rewards / contributions ────────────────────────────────────────────

async function paintRewards(host, ctx, { email }) {
  const { ui, auth, router } = ctx;
  try {
    const summary = await auth.fetchRewardSummary();
    if (!host.isConnected) return; // navigated away meanwhile
    if (!summary) {
      host.innerHTML = `<p class="h-sub">Sign in with the email you used to contribute to see your points.</p>`;
      return;
    }
    const contributions = summary.transactions.length;
    const head = `
      <div style="display:flex;gap:22px;align-items:baseline;margin:10px 0 2px">
        <div><div class="hero-title" style="font-size:1.5rem">${summary.points}</div><div class="h-sub">reward points</div></div>
        <div><div class="hero-title" style="font-size:1.5rem">${contributions}</div><div class="h-sub">rewards credited</div></div>
      </div>`;
    if (!summary.points && !contributions) {
      host.innerHTML = `${head}<p class="h-sub">No contributions yet — every approved upload earns 10 points.</p>
        <div class="sheet-actions"><button class="btn btn--primary btn--sm" id="pf-upload" type="button">Upload a paper</button></div>`;
      const btn = host.querySelector('#pf-upload');
      if (btn) btn.addEventListener('click', () => router.go('upload'));
      return;
    }
    const rows = summary.transactions.slice(0, 3).map((t) => `
      <div class="pf-txn"><span class="pf-txn-amt">+${t.amount}</span><span class="grow">${t.type === 'PYQ_UPLOAD' ? 'PYQ contribution' : ui.esc(t.type || 'Reward')}</span><span class="pf-txn-date">${ui.esc(dateLabel(t.date))}</span></div>`).join('');
    host.innerHTML = `${head}${rows ? `<div style="margin-top:10px">${rows}</div>` : ''}
      ${contributions > 3 ? `<p class="field-hint" style="margin-top:8px">Latest ${contributions} rewards tracked by the moderators</p>` : ''}`;
  } catch (err) {
    if (!host.isConnected) return;
    host.innerHTML = `<p class="h-sub" style="color:var(--gold)">Couldn't load your points right now. Check your connection and try again.</p>
      <div class="sheet-actions"><button class="btn btn--ghost btn--sm" id="pf-retry" type="button">Retry</button></div>`;
    const retry = host.querySelector('#pf-retry');
    if (retry) retry.addEventListener('click', () => {
      host.innerHTML = ui.skeletonRows(2);
      paintRewards(host, ctx, { email });
    });
    console.warn('reward summary failed:', err); // dev log only — never rendered
  }
}
