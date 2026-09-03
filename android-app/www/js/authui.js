/**
 * DSMNRU PYQ Android — authentication sheet flows (login / sign-up / reset /
 * email verification), built on the same Firebase project the website uses
 * (see ./auth.js). These sheets are also what the archive "gates" open,
 * mirroring the website's login-modal policy for search, pagination and PDFs.
 */

import * as ui from './ui.js';
import { native } from './native.js';

let busy = false;
let auth = null;

/** app.js injects the shared auth singleton (same session across all screens). */
export function initAuthUI(authInstance) {
  auth = authInstance;
}

function field(id, label, type, placeholder, autocomplete) {
  return `
    <div class="field">
      <label for="${id}">${label}</label>
      <input class="input" id="${id}" type="${type}" placeholder="${placeholder}" autocomplete="${autocomplete}" ${type === 'email' ? 'inputmode="email" enterkeyhint="next"' : 'enterkeyhint="done"'}>
    </div>`;
}

function wireSubmit(formEl, onSubmit) {
  formEl.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (busy) return;
    busy = true;
    const btn = formEl.querySelector('button[type=submit]');
    const errEl = formEl.querySelector('[data-err]');
    if (errEl) { errEl.hidden = true; }
    const original = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = 'Please wait…'; }
    try {
      await onSubmit(formEl);
    } catch (err) {
      if (errEl) { errEl.textContent = String(err && err.message || err); errEl.hidden = false; }
    } finally {
      busy = false;
      if (btn) { btn.disabled = false; btn.textContent = original; }
    }
  });
}

/** Login/sign-up/reset sheet. `onAuthenticated` runs after a successful sign-in. */
export function openAuthSheet({ reason = '', onAuthenticated, mode = 'login' } = {}) {
  let sheetRef = null;

  const node = document.createElement('div');
  node.innerHTML = `
    ${reason ? `<p class="sheet-text" style="margin-bottom:14px">${ui.esc(reason)}</p>` : ''}
    <div class="chip-row" id="auth-mode" style="margin-bottom:14px">
      <button class="chip ${mode === 'login' ? 'is-active' : ''}" data-chip="login" type="button">Sign in</button>
      <button class="chip ${mode === 'signup' ? 'is-active' : ''}" data-chip="signup" type="button">Create account</button>
    </div>
    <div data-err class="form-error" hidden></div>

    <form data-form="login" ${mode === 'signup' ? 'class="hidden"' : ''}>
      ${field('auth-email', 'Email', 'email', 'you@student.edu', 'email')}
      ${field('auth-pass', 'Password', 'password', '••••••••', 'current-password')}
      <button class="btn btn--primary btn--block" type="submit">Sign in</button>
      <div style="display:flex;justify-content:space-between;gap:8px;margin-top:10px">
        <button class="link-btn" type="button" data-act="forgot">Forgot password?</button>
        <button class="link-btn" type="button" data-act="google">Use Google ↗</button>
      </div>
    </form>

    <form data-form="signup" ${mode === 'signup' ? '' : 'class="hidden"'}>
      ${field('auth-name', 'Full name', 'text', 'e.g. Ananya Sharma', 'name')}
      ${field('auth-s-email', 'Email', 'email', 'you@student.edu', 'email')}
      ${field('auth-s-pass', 'Password (6+ characters)', 'password', 'Choose a strong password', 'new-password')}
      <button class="btn btn--primary btn--block" type="submit">Create account</button>
    </form>

    <form data-form="reset" class="hidden">
      ${field('auth-r-email', 'Account email', 'email', 'you@student.edu', 'email')}
      <button class="btn btn--gold btn--block" type="submit">Send reset link</button>
      <p class="form-note">Firebase emails a reset link (opens on the website — you can finish there or come back here).</p>
    </form>

    <p class="form-note">Same account system as dsmnru-pyq.netlify.app — your saved papers
    and comments on the website are already here. Nothing new is created.</p>`;

  const forms = {
    login: node.querySelector('[data-form="login"]'),
    signup: node.querySelector('[data-form="signup"]'),
    reset: node.querySelector('[data-form="reset"]'),
  };

  function showForm(which) {
    Object.entries(forms).forEach(([k, f]) => f.classList.toggle('hidden', k !== which));
    ui.updateChipRow(node.querySelector('#auth-mode'), which === 'signup' ? 'signup' : 'login');
  }

  node.querySelector('#auth-mode').addEventListener('click', (e) => {
    const b = e.target.closest('[data-chip]');
    if (b) showForm(b.dataset.chip === 'signup' ? 'signup' : 'login');
  });
  node.querySelector('[data-act="forgot"]').addEventListener('click', () => showForm('reset'));
  node.querySelector('[data-act="google"]').addEventListener('click', () => {
    ui.closeSheet();
    openGoogleInfo();
  });

  wireSubmit(forms.login, async (f) => {
    await auth.signIn(f.querySelector('#auth-email').value, f.querySelector('#auth-pass').value);
    ui.closeSheet();
    ui.toast('Signed in — full archive unlocked');
    if (onAuthenticated) onAuthenticated();
  });

  wireSubmit(forms.signup, async (f) => {
    await auth.signUp({
      name: f.querySelector('#auth-name').value,
      email: f.querySelector('#auth-s-email').value,
      password: f.querySelector('#auth-s-pass').value,
    });
    ui.closeSheet();
    ui.toast('Account created! Verify your email to unlock everything.');
    if (onAuthenticated) onAuthenticated();
  });

  wireSubmit(forms.reset, async (f) => {
    await auth.requestPasswordReset(f.querySelector('#auth-r-email').value);
    ui.closeSheet();
    ui.toast('Reset link sent — check your inbox');
  });

  sheetRef = ui.sheet({
    title: 'DSMNRU account',
    subtitle: 'Sign in unlocks full search, pagination and PDF actions',
    content: node,
  });
  return sheetRef;
}

/** Same limitation messaging the website shows for embedded WebViews — never silent. */
export function googleInfoSheet() {
  const node = document.createElement('div');
  node.innerHTML = `
    <p class="sheet-text">Google sign-in uses a browser popup that Google blocks inside embedded
    app WebViews, so it can't run natively in this app yet. Your account is still the same
    Firebase account everywhere:</p>
    <div class="sheet-list" style="margin-top:14px">
      <button class="sheet-item" data-act="email" type="button">${ui.icon('mail')}<span>Sign in with email &amp; password<small>Works fully in-app for any account created on the website or here</small></span></button>
      <button class="sheet-item" data-act="web" type="button">${ui.icon('globe')}<span>Open website to use Google<small>Finish on dsmnru-pyq.netlify.app in your browser, then come back — the app shares the same data</small></span></button>
    </div>`;
  const s = ui.sheet({ title: 'Google sign-in', content: node });
  node.querySelector('[data-act="email"]').addEventListener('click', () => {
    s.close();
    openAuthSheet({ mode: 'login' });
  });
  node.querySelector('[data-act="web"]').addEventListener('click', () => {
    s.close();
    native.openExternal('https://dsmnru-pyq.netlify.app/');
  });
  return s;
}

function openGoogleInfo() { googleInfoSheet(); }

export function verificationPromptSheet({ afterVerified } = {}) {
  const node = document.createElement('div');
  const user = auth.current();
  node.innerHTML = `
    <p class="sheet-text">Your email <b>${ui.esc(user && user.email || '')}</b> isn't verified yet — the same rule
    the website applies before search, pagination and paper downloads.</p>
    <div class="sheet-actions">
      <button class="btn btn--ghost" data-act="resend" type="button">Resend email</button>
      <button class="btn btn--primary" data-act="done" type="button">I've verified</button>
    </div>
    <p class="form-note">The verification link opens the website — tap “I've verified” here afterwards.</p>`;
  const s = ui.sheet({ title: 'Verify your email', content: node });
  node.querySelector('[data-act="resend"]').addEventListener('click', async (e) => {
    const b = e.currentTarget;
    b.disabled = true;
    try { await auth.resendVerification(); ui.toast('Verification email sent'); }
    catch (err) { ui.toast(String(err.message || err), 'err'); }
    finally { b.disabled = false; }
  });
  node.querySelector('[data-act="done"]').addEventListener('click', async (e) => {
    const b = e.currentTarget;
    b.disabled = true;
    b.textContent = 'Checking…';
    await auth.reloadProfile();
    ui.closeSheet();
    if (auth.canUnlockPrivileges()) {
      ui.toast('Verified — welcome back!');
      if (afterVerified) afterVerified();
    } else {
      ui.toast('Still unverified — check your inbox', 'err');
    }
  });
  return s;
}
