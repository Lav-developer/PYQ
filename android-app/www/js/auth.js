/**
 * DSMNRU PYQ Android — authentication against the EXISTING Firebase project
 * (`dsmnru-data`). This is the same user base, the same email/password
 * credentials, and the same verification rules the website uses — NOT a
 * second auth system.
 *
 * Why REST instead of the firebase-auth JS SDK?
 *  - Email/password, verification and token refresh map 1:1 to Identity
 *    Toolkit endpoints — the same calls the JS SDK makes under the hood —
 *    without pulling ~270 KB of SDK into the APK, and without any Firestore
 *    reads at startup.
 *  - Google sign-in runs NATIVELY in the app: the DsmnruApp plugin collects a
 *    Google ID token through Android's Credential Manager (device account
 *    chooser — no popup, no browser), and this module exchanges it with
 *    `accounts:signInWithIdp` against the same `dsmnru-data` project, so the
 *    user identity is identical to the website's.
 *  - The web API key below is the same public client config already embedded
 *    in the production website (script.js); it is not a secret, and no
 *    service-account or private credential is ever shipped here.
 *
 * Google accounts get the same privileges as on the website (google.com
 * provider claims skip the email-verification gate). If a particular APK
 * build lacks the Google client-ID configuration (see
 * docs/GOOGLE_SIGNIN_SETUP.md), the UI explains it and offers in-app
 * email/password — it never sends the user to the website to sign in.
 *
 * Session storage: idToken + refresh token + parsed expiry, refreshed lazily
 * (on app resume / when within 5 minutes of expiry). No polling.
 */

export const FIREBASE_PROJECT_ID = 'dsmnru-data';
export const FIREBASE_WEB_API_KEY = 'AIzaSyBRlsk-knQs-AMlaTFxlneBMTwlSfwyFaQ';

const IDT = 'https://identitytoolkit.googleapis.com/v1';
const SECURE_TOKEN = 'https://securetoken.googleapis.com/v1/token';
const FS = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents`;
const SESSION_KEY = 'dsm.auth.session.v1';
const VERIFY_CONTINUE_URL = 'https://dsmnru-pyq.netlify.app/';
const REFRESH_SKEW_MS = 5 * 60 * 1000;

const FRIENDLY_ERRORS = {
  'EMAIL_NOT_FOUND': 'No account exists for this email yet.',
  'INVALID_EMAIL': 'That email address does not look valid.',
  'INVALID_LOGIN_CREDENTIALS': 'Incorrect email or password.',
  'INVALID_PASSWORD': 'Incorrect password. Try again or reset it.',
  'WRONG_PASSWORD': 'Incorrect password. Try again or reset it.',
  'MISSING_PASSWORD': 'Please enter your password.',
  'USER_DISABLED': 'This account has been disabled.',
  'EMAIL_EXISTS': 'An account with this email already exists — sign in instead.',
  'WEAK_PASSWORD': 'Please choose a password with at least 6 characters.',
  'OPERATION_NOT_ALLOWED': 'Email sign-in is currently disabled for this project.',
  'TOO_MANY_ATTEMPTS_TRY_LATER': 'Too many attempts. Please wait a minute and try again.',
  'NETWORK_REQUEST_FAILED': 'Firebase is unreachable right now. Check your connection.',
  'TOKEN_EXPIRED': 'Your session expired — please sign in again.',
  'USER_NOT_FOUND': 'Your Firebase session is no longer valid — please sign in again.',
  'INVALID_REFRESH_TOKEN': 'Your saved session is no longer valid — please sign in again.',
};

function friendly(err) {
  const code = String((err && (err.code || err.error && err.error.message)) || '');
  for (const key of Object.keys(FRIENDLY_ERRORS)) {
    if (code.includes(key)) return FRIENDLY_ERRORS[key];
  }
  // Never surface raw backend text (it can embed URLs/identifiers) in the UI.
  const raw = String((err && err.message) || '');
  if (!raw || /failed to fetch|networkerror|load failed|timed?\s?out/i.test(raw)) {
    return 'Please check your internet connection and try again.';
  }
  const scrubbed = raw.replace(/https?:\/\/\S+/g, '').replace(/\s{2,}/g, ' ').trim();
  return scrubbed || 'Something went wrong. Please try again.';
}

/** Decode a JWT payload without verification — display/session metadata only. */
export function decodeJwtPayload(token) {
  try {
    const parts = String(token || '').split('.');
    if (parts.length !== 3) return null;
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const json = atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, '='));
    return JSON.parse(json);
  } catch {
    return null;
  }
}

export function createAuth(options = {}) {
  const fetchImpl = options.fetchImpl || ((...args) => fetch(...args));
  const storage = options.storage || null;
  const now = options.now || (() => Date.now());
  const onUserDocMissing = options.syncUserDoc || null; // optional test seam

  let user = null;         // normalized session view
  let persist = true;      // false while offline-recovering
  const listeners = new Set();
  // Session-scoped reward summary cache (see fetchRewardSummary): one pair
  // of reads per short window instead of one pair per Profile visit.
  let rewardCache = null;  // { uid, email, at, summary }

  function emit() {
    for (const fn of listeners) {
      try { fn(user); } catch { /* ignore */ }
    }
  }

  function loadSession() {
    if (!storage) return null;
    try {
      const raw = storage.getItem(SESSION_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  }

  function storeSession(session) {
    persist = true;
    if (!storage) return;
    try {
      if (session) storage.setItem(SESSION_KEY, JSON.stringify(session));
      else storage.removeItem(SESSION_KEY);
    } catch { /* ignore quota */ }
  }

  function viewFromTokens(idToken, refreshToken, obtainedAt, nameOverride) {
    const claims = decodeJwtPayload(idToken) || {};
    const provider = (claims.firebase && claims.firebase.sign_in_provider) || 'password';
    const exp = Number(claims.exp) || 0;
    return {
      uid: claims.user_id || claims.sub || '',
      email: claims.email || '',
      name: nameOverride || claims.name || claims.email || 'Student',
      picture: claims.picture || '',
      emailVerified: claims.email_verified === true,
      providerId: provider,
      admin: claims.admin === true,
      expiresAt: exp ? exp * 1000 : obtainedAt + 3600 * 1000,
      obtainedAt,
      idToken,
      refreshToken,
    };
  }

  function persistFromUser() {
    if (!user || !persist) return;
    storeSession({
      idToken: user.idToken,
      refreshToken: user.refreshToken,
      expiresAt: user.expiresAt,
      obtainedAt: user.obtainedAt,
    });
  }

  function setUser(next, { remember = true } = {}) {
    user = next;
    persist = remember;
    if (remember) persistFromUser();
    if (!next && storage) {
      try { storage.removeItem(SESSION_KEY); } catch { /* ignore */ }
    }
    emit();
  }

  async function postJson(url, body, headers = {}) {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error((data && (data.error && data.error.message || data.error)) || 'Request failed');
      err.code = data && data.error ? String(data.error.message || '') : '';
      throw err;
    }
    return data;
  }

  async function identity(endpoint, body) {
    return postJson(`${IDT}/accounts:${endpoint}?key=${FIREBASE_WEB_API_KEY}`, body);
  }

  /** Sign-in (or sign-up) responses both carry idToken/refreshToken. */
  async function adoptTokenSession(payload, nameOverride) {
    const session = viewFromTokens(payload.idToken, payload.refreshToken, now(), nameOverride);
    if (!session.uid) throw new Error('Unexpected auth response');
    setUser(session);
    await syncUserDocument().catch(() => { /* non-fatal, best effort */ });
    return session;
  }

  /**
   * Mirror the website's `ensureUserDocumentSynced` — create users/{uid} only
   * when it is missing (one Firestore read, zero-or-one write, and ONLY right
   * after a manual sign-in — never at app startup).
   */
  async function syncUserDocument() {
    if (!user || !user.uid) return;
    const docUrl = `${FS}/users/${encodeURIComponent(user.uid)}?key=${FIREBASE_WEB_API_KEY}`;
    const get = await fetchImpl(docUrl, {
      headers: { Authorization: 'Bearer ' + user.idToken },
    });
    if (get.status === 200) return; // already synced (web signup flow or earlier app login)
    if (get.status !== 404) throw new Error('profile lookup failed');

    const fields = {
      uid: { stringValue: user.uid },
      email: { stringValue: user.email || '' },
      name: { stringValue: user.name || 'User' },
      signupName: { stringValue: user.name || 'User' },
      signupEmail: { stringValue: user.email || '' },
      signupCourse: { stringValue: '' },
      course: { stringValue: '' },
      phone: { stringValue: '' },
      role: { stringValue: 'user' },
      emailVerified: { booleanValue: !!user.emailVerified },
      createdAt: { timestampValue: new Date().toISOString() },
    };
    if (onUserDocMissing) { await onUserDocMissing(fields); return; }
    await fetchImpl(`${FS}/users?documentId=${encodeURIComponent(user.uid)}&key=${FIREBASE_WEB_API_KEY}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + user.idToken,
      },
      body: JSON.stringify({ fields }),
    }); // best effort; profile features tolerate a late sync on web
  }

  const auth = {
    current() { return user; },

    /** Website-parity gate helpers (see paper.js/script.js in the web frontend). */
    isGoogle() { return !!user && user.providerId === 'google.com'; },
    needsEmailVerification() { return !!user && !auth.isGoogle() && !user.emailVerified; },
    /** Search / filters / load-more / PDF actions require a verified session. */
    canUnlockPrivileges() { return !!user && !auth.needsEmailVerification(); },

    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },

    /**
     * Restore a persisted session at startup (called once), refreshing the ID
     * token when it is expired or close to it. Network failure while a
     * session still exists → user stays visible with a "degraded" flag so the
     * cached app keeps working offline; a rejected refresh → hard sign-out.
     */
    async restore() {
      const saved = loadSession();
      if (!saved || !saved.idToken) return null;
      let session = viewFromTokens(saved.idToken, saved.refreshToken, saved.obtainedAt || now());
      if (now() >= session.expiresAt - REFRESH_SKEW_MS && session.refreshToken) {
        try {
          const data = await postJson(`${SECURE_TOKEN}?key=${FIREBASE_WEB_API_KEY}`, {
            grant_type: 'refresh_token',
            refresh_token: session.refreshToken,
          });
          session = viewFromTokens(data.id_token, data.refresh_token || session.refreshToken, now());
        } catch (err) {
          if (err instanceof TypeError) {
            // Network layer failed — keep the (possibly expired) session for
            // offline UI, but do not persist a new expiry.
            setUser({ ...session, degraded: true }, { remember: false });
            return user;
          }
          setUser(null);
          return null;
        }
      }
      setUser(session);
      return user;
    },

    /** Lightweight refresh on resume when the session is close to expiry. */
    async refreshIfNeeded() {
      if (!user || !user.refreshToken) return;
      if (now() < user.expiresAt - REFRESH_SKEW_MS && !user.degraded) return;
      try {
        const data = await postJson(`${SECURE_TOKEN}?key=${FIREBASE_WEB_API_KEY}`, {
          grant_type: 'refresh_token',
          refresh_token: user.refreshToken,
        });
        setUser(viewFromTokens(data.id_token, data.refresh_token || user.refreshToken, now()));
      } catch { /* keep current session; privileged calls will surface errors */ }
    },

    async signIn(email, password) {
      try {
        const data = await identity('signInWithPassword', {
          email: String(email || '').trim(),
          password: String(password || ''),
          returnSecureToken: true,
        });
        return await adoptTokenSession(data);
      } catch (err) {
        throw new Error(friendly(err));
      }
    },

    /**
     * Android-native Google sign-in, second (final) step.
     *
     * The DsmnruApp plugin first obtains a Google ID token from the device's
     * Google account chooser (Credential Manager — see DsmnruAppPlugin.java).
     * That token is exchanged here against the SAME Firebase project the
     * website uses, via the Identity Toolkit `accounts:signInWithIdp`
     * endpoint — the exact call the Firebase JS SDK makes for
     * signInWithPopup(GoogleAuthProvider). The result is the same user
     * identity, session shape and users/{uid} sync as every other sign-in —
     * no second auth system, no browser, no website redirect.
     *
     * `nonce` (raw, generated in JS) is bound into the Google token by the
     * plugin (SHA-256 form) and replayed here so Identity Toolkit can verify
     * it — standard anti-replay pairing.
     */
    async signInWithGoogleCredential({ idToken, nonce = '' } = {}) {
      const token = String(idToken || '').trim();
      if (!token) throw new Error('Google did not return a credential.');
      const postBody = 'id_token=' + encodeURIComponent(token)
        + '&providerId=google.com'
        + (nonce ? '&nonce=' + encodeURIComponent(String(nonce)) : '');
      try {
        const data = await identity('signInWithIdp', {
          postBody,
          requestUri: 'http://localhost',
          returnIdpCredential: true,
          returnSecureToken: true,
        });
        return await adoptTokenSession(data);
      } catch (err) {
        throw new Error(friendly(err));
      }
    },

    async signUp({ name, email, password }) {
      let data;
      try {
        data = await identity('signUp', {
          email: String(email || '').trim(),
          password: String(password || ''),
          returnSecureToken: true,
        });
      } catch (err) {
        throw new Error(friendly(err));
      }
      const displayName = String(name || '').trim();
      try {
        if (displayName) {
          await identity('update', { idToken: data.idToken, displayName });
          data.displayName = displayName;
        }
      } catch { /* name is cosmetic; never fail signup over it */ }
      const session = await adoptTokenSession(data, displayName || undefined);
      try {
        await identity('sendOobCode', { requestType: 'VERIFY_EMAIL', idToken: session.idToken, continueUrl: VERIFY_CONTINUE_URL });
      } catch { /* the website will re-prompt verification */ }
      return session;
    },

    signOut() {
      rewardCache = null;
      setUser(null);
    },

    /**
     * Profile management (same Firestore profile the website uses):
     * updates the Firebase Auth display name AND the users/{uid}.name field
     * (owner-writable per the existing security rules), then refreshes the
     * in-app session. Throws human-readable errors.
     */
    async updateDisplayName(nextName) {
      if (!user) throw new Error('Sign in first to update your profile.');
      const displayName = String(nextName || '').trim();
      if (displayName.length < 2 || displayName.length > 80) {
        throw new Error('Name must be between 2 and 80 characters.');
      }
      try {
        await identity('update', { idToken: user.idToken, displayName });
      } catch (err) {
        throw new Error(friendly(err));
      }
      try {
        await fetchImpl(`${FS}/users/${encodeURIComponent(user.uid)}?updateMask=name&key=${FIREBASE_WEB_API_KEY}`, {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer ' + user.idToken,
          },
          body: JSON.stringify({ fields: { name: { stringValue: displayName } } }),
        }); // best effort — the auth-side name is already updated
      } catch { /* non-fatal */ }
      const refreshed = await auth.reloadProfile();
      setUser({ ...(refreshed || user), name: displayName });
      return user;
    },

    /**
     * Reward/contribution summary for the signed-in user — SAME data the
     * website's points card reads: reward_accounts/{email-key}.points plus
     * the user's point_transactions (rewarded uploads). Exactly TWO lazy
     * reads, only on request (Profile screen), never at startup.
     * Missing account ⇒ zero-state, not an error.
     */
    async fetchRewardSummary() {
      if (!user || !user.email) return null;
      const email = String(user.email).trim().toLowerCase();
      const nowMs = now();
      if (rewardCache && rewardCache.uid === user.uid && rewardCache.email === email
          && nowMs - rewardCache.at < 5 * 60 * 1000) {
        return rewardCache.summary; // short-window cache — Profile revisits cost zero reads
      }
      const accountKey = email.replace(/[^a-z0-9]/g, '_'); // points.js derivation
      const headers = { Authorization: 'Bearer ' + user.idToken };
      let points = 0;
      try {
        const res = await fetchImpl(`${FS}/reward_accounts/${encodeURIComponent(accountKey)}?key=${FIREBASE_WEB_API_KEY}`, { headers });
        if (res.status === 200) {
          const body = await res.json().catch(() => null);
          const f = (body && body.fields) || {};
          points = Number(f.points && (f.points.integerValue ?? f.points.doubleValue)) || 0;
        } else if (res.status !== 404 && res.status !== 403) {
          throw new Error('reward lookup failed');
        }
      } catch (err) {
        if (String(err && err.message) === 'reward lookup failed') throw err;
        throw new Error('points unavailable'); // network failure — caller humanizes
      }
      let transactions = [];
      try {
        const res = await fetchImpl(`${FS}:runQuery?key=${FIREBASE_WEB_API_KEY}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...headers },
          body: JSON.stringify({
            structuredQuery: {
              from: [{ collectionId: 'point_transactions' }],
              where: { fieldFilter: { field: { fieldPath: 'email' }, op: 'EQUAL', value: { stringValue: email } } },
              limit: 20,
            },
          }),
        });
        if (res.ok) {
          const rows = await res.json().catch(() => []);
          transactions = (Array.isArray(rows) ? rows : [])
            .filter((r) => r && r.document && r.document.fields)
            .map((r) => {
              const f = r.document.fields;
              const ts = (f.createdAt && (f.createdAt.timestampValue || '')) || (f.date && f.date.timestampValue) || '';
              return {
                amount: Number(f.amount && (f.amount.integerValue ?? f.amount.doubleValue)) || 0,
                type: (f.type && f.type.stringValue) || 'Reward',
                date: ts,
              };
            });
        }
      } catch { /* history is optional decoration — balance already shown */ }
      const summary = { points, transactions };
      rewardCache = { uid: user.uid, email, at: nowMs, summary };
      return summary;
    },

    async resendVerification() {
      if (!user) return;
      try {
        await identity('sendOobCode', { requestType: 'VERIFY_EMAIL', idToken: user.idToken, continueUrl: VERIFY_CONTINUE_URL });
        return true;
      } catch (err) {
        throw new Error(friendly(err));
      }
    },

    async requestPasswordReset(email) {
      try {
        await identity('sendOobCode', { requestType: 'PASSWORD_RESET', email: String(email || '').trim() });
        return true;
      } catch (err) {
        throw new Error(friendly(err));
      }
    },

    /**
     * Re-checks email_verified + profile claims against accounts:lookup
     * (used by the "I verified my email" button — one request, on tap only).
     */
    async reloadProfile() {
      if (!user) return null;
      try {
        const data = await identity('lookup', { idToken: user.idToken });
        const acct = data && Array.isArray(data.users) ? data.users[0] : null;
        if (acct) {
          setUser({
            ...user,
            name: acct.displayName || user.name,
            picture: acct.photoUrl || user.picture,
            email: acct.email || user.email,
            emailVerified: !!acct.emailVerified,
            providerId: (acct.providerData && acct.providerData[0] && acct.providerData[0].providerId) || user.providerId,
          });
        }
        await syncUserDocument().catch(() => {});
      } catch (err) {
        if (/expired|invalid/i.test(String(err && err.code))) await auth.restore();
      }
      return user;
    },
  };

  return auth;
}
