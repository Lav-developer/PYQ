/**
 * DSMNRU PYQ Android — authentication sheet flows (login / sign-up / reset /
 * email verification), built on the same Firebase project the website uses
 * (see ./auth.js). These sheets are also what the archive "gates" open,
 * mirroring the website's login-modal policy for search, pagination and PDFs.
 *
 * Google sign-in is NATIVE: the device's Google account chooser (Android
 * Credential Manager via DsmnruAppPlugin) returns a Google ID token which is
 * exchanged with the same Firebase project — no browser, no Chrome, no
 * website hand-off, ever.
 */

import * as ui from './ui.js';
import { native } from './native.js';

let busy = false;
let auth = null;

/** app.js injects the shared auth singleton (same session across all screens). */
export function initAuthUI(authInstance) {
  auth = authInstance;
}

/** Fresh nonce binding the Google credential to this sign-in attempt. */
function generateNonce() {
  try {
    const bytes = new Uint8Array(16);
    (globalThis.crypto || window.crypto).getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return 'n-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12);
  }
}

/**
 * Run the Android-native Google sign-in end-to-end:
 * account chooser → Google ID token → Firebase (same project) → session.
 * Resolves true when the user ended up signed in.
 */
export async function startGoogleSignIn({ onAuthenticated } = {}) {
  const nonce = generateNonce();
  ui.toast('Signing in with Google…');
  const res = await native.googleSignIn(nonce);
  if (res && res.ok && res.idToken) {
    try {
      await auth.signInWithGoogleCredential({ idToken: res.idToken, nonce: res.nonce || nonce });
      ui.closeSheet();
      ui.toast('Signed in successfully.');
      if (onAuthenticated) onAuthenticated();
      return true;
    } catch (err) {
      // Firebase exchange failed — human message only, never raw errors.
      console.warn('google exchange failed:', err);
      ui.toast('Unable to sign in with Google. Please try again.', 'err');
      return false;
    }
  }
  const code = (res && res.code) || '';
  if (code === 'GOOGLE_SIGNIN_CANCELLED') {
    ui.toast('Google sign-in was cancelled.');
    return false;
  }
  googleInfoSheet({ code, onAuthenticated });
  return false;
}

function field(id, label, type, placeholder, autocomplete) {
  return `
    <div class="field">
      <label for="${id}">${label}</label>
      <input class="input" id="${id}" type="${type}" placeholder="${placeholder}" autocomplete="${autocomplete}" ${type === 'email' ? 'inputmode="email" enterkeyhint="next"' : 'enterkeyhint="done"'}>
    </div>`;
}

function wireSubmit(formEl, onSubmit, { busyLabel = 'Please wait…' } = {}) {
  formEl.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (busy) return; // no duplicate submissions
    busy = true;
    const btn = formEl.querySelector('button[type=submit]');
    // Every form owns its error target — a failure must ALWAYS be visible
    // on the page (this div used to live outside the signup/reset forms,
    // which made those failures silent).
    let errEl = formEl.querySelector('[data-err]');
    if (!errEl) {
      errEl = document.createElement('div');
      errEl.className = 'form-error';
      errEl.setAttribute('data-err', '');
      formEl.prepend(errEl);
    }
    errEl.hidden = true;
    const original = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = busyLabel; }
    try {
      await onSubmit(formEl);
    } catch (err) {
      errEl.textContent = String(err && err.message || err);
      errEl.hidden = false;
      try { errEl.scrollIntoView({ block: 'nearest' }); } catch { /* jsdom */ }
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
    <form data-form="login" ${mode === 'signup' ? 'class="hidden"' : ''}>
      <div data-err class="form-error" hidden role="alert"></div>
      ${field('auth-email', 'Email', 'email', 'you@student.edu', 'email')}
      ${field('auth-pass', 'Password', 'password', '••••••••', 'current-password')}
      <button class="btn btn--primary btn--block" type="submit">Sign in</button>
      <div class="auth-or"><span>or</span></div>
      <button class="btn btn--google btn--block" type="button" data-act="google">
        <span class="g-mark" aria-hidden="true">G</span> Sign in with Google
      </button>
      <div style="display:flex;justify-content:center;margin-top:10px">
        <button class="link-btn" type="button" data-act="forgot">Forgot password?</button>
      </div>
    </form>

    <form data-form="signup" ${mode === 'signup' ? '' : 'class="hidden"'}>
      <div data-err class="form-error" hidden role="alert"></div>
      ${field('auth-name', 'Full name', 'text', 'e.g. Ananya Sharma', 'name')}
      ${field('auth-s-email', 'Email', 'email', 'you@student.edu', 'email')}
      ${field('auth-s-pass', 'Password (6+ characters)', 'password', 'Choose a strong password', 'new-password')}
      <button class="btn btn--primary btn--block" type="submit">Create account</button>
    </form>

    <form data-form="reset" class="hidden">
      <div data-err class="form-error" hidden role="alert"></div>
      <div data-reset-ok class="form-note" style="color:var(--teal)" hidden></div>
      ${field('auth-r-email', 'Account email', 'email', 'you@student.edu', 'email')}
      <button class="btn btn--gold btn--block" type="submit">Send reset link</button>
      <p class="form-note">The reset email comes from the same account system the website uses — open the
      link on this device and set a new password.</p>
    </form>

    <p class="form-note">Same account system as the DSMNRU PYQ website — your saved papers
    and comments there are already here. Nothing new is created.</p>`;

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
    startGoogleSignIn({ onAuthenticated });
  });

  wireSubmit(forms.login, async (f) => {
    await auth.signIn(f.querySelector('#auth-email').value, f.querySelector('#auth-pass').value);
    ui.closeSheet();
    ui.toast('Signed in — full archive unlocked');
    if (onAuthenticated) onAuthenticated();
  }, { busyLabel: 'Signing in…' });

  wireSubmit(forms.signup, async (f) => {
    await auth.signUp({
      name: f.querySelector('#auth-name').value,
      email: f.querySelector('#auth-s-email').value,
      password: f.querySelector('#auth-s-pass').value,
    });
    ui.closeSheet();
    ui.toast('Account created successfully — welcome!');
    if (onAuthenticated) onAuthenticated();
  }, { busyLabel: 'Creating account…' });

  wireSubmit(forms.reset, async (f) => {
    await auth.requestPasswordReset(f.querySelector('#auth-r-email').value);
    // The Firebase request resolved — the email is on its way. Show the
    // confirmation in-form (not a toast) so it cannot be missed.
    const ok = f.querySelector('[data-reset-ok]');
    if (ok) {
      ok.textContent = 'Password reset email sent. Please check your inbox and spam folder.';
      ok.hidden = false;
      f.querySelector('[data-err]').hidden = true;
    }
  }, { busyLabel: 'Sending reset link…' });

  sheetRef = ui.sheet({
    title: 'DSMNRU account',
    subtitle: 'Sign in unlocks full search, pagination and PDF actions',
    content: node,
  });
  return sheetRef;
}

/**
 * Google sign-in explainer — shown only when the native flow could not run
 * (cancelled attempts never surface this). There is NO "open the website"
 * hand-off: the user either signs in natively when the build supports it, or
 * uses email & password against the same Firebase account.
 */
export function googleInfoSheet({ code = '', onAuthenticated } = {}) {
  const configured = code !== 'GOOGLE_SIGNIN_NOT_CONFIGURED';
  const node = document.createElement('div');
  node.innerHTML = `
    <p class="sheet-text"><b>Unable to sign in with Google. Please try again.</b></p>
    ${configured
      ? `<p class="sheet-text">Google sign-in runs with the device's own account chooser — no browser needed.
         It isn't available right now (no Google account on the phone, or Play services needs updating).</p>`
      : `<p class="sheet-text">Google sign-in isn't set up in this build of the app yet. Your DSMNRU email
         &amp; password works right now:</p>`}
    <div class="sheet-list" style="margin-top:14px">
      <button class="sheet-item" data-act="email" type="button">${ui.icon('mail')}<span>Sign in with email &amp; password<small>Works fully in-app for any account created on the website or here</small></span></button>
      ${configured ? `<button class="sheet-item" data-act="retry" type="button">${ui.icon('google')}<span>Try Google again<small>Opens the device Google account chooser</small></span></button>` : ''}
    </div>`;
  const s = ui.sheet({ title: 'Google sign-in', content: node });
  node.querySelector('[data-act="email"]').addEventListener('click', () => {
    s.close();
    openAuthSheet({ mode: 'login' });
  });
  const retry = node.querySelector('[data-act="retry"]');
  if (retry) {
    retry.addEventListener('click', () => {
      s.close();
      startGoogleSignIn({ onAuthenticated });
    });
  }
  return s;
}

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
