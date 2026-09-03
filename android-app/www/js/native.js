/**
 * DSMNRU PYQ Android — thin wrapper around the app's own native plugin
 * (`DsmnruApp`, implemented in Java under android/app/src/main/java).
 *
 * It keeps the app genuinely "Android":
 *  - pdfViewer(): the in-app PDF screen (native PdfRenderer + zoom/scroll,
 *    progress and error states) — the FIRST thing "Open PDF" tries.
 *  - googleSignIn(): the device's Google account chooser (Credential
 *    Manager) → Google ID token for Firebase sign-in — no browser, no popup,
 *    no website hand-off.
 *  - openExternal(): hand genuinely-external links (university portals,
 *    Drive landing pages, the explicitly-chosen website) to the system —
 *    same destination as the website's window.open, no duplicate storage.
 *  - download(): direct .pdf links via Android's system DownloadManager into
 *    the public Downloads folder (system notification, resumable, permission
 *    free) — only when the user explicitly taps Download.
 *  - share(): the real Android share sheet (ACTION_SEND). navigator.share
 *    does not exist inside the Capacitor WebView, so this is the share action.
 *  - Launch/warm deep links from /pyq/<slug> URLs (handled in MainActivity).
 *
 * In a plain browser (dev testing, unit harnesses) the fallbacks keep every
 * code path functional; no behavior is silently skipped.
 */

// A Java-only Capacitor plugin surfaces on the injected Capacitor global as
// window.Capacitor.Plugins.DsmnruApp — no npm package, no extra dependency.
// Read lazily (with typeof guards) so this module stays importable in Node.
function resolveBridge() {
  try {
    const cap = globalThis.Capacitor;
    return (cap && cap.Plugins && cap.Plugins.DsmnruApp) || null;
  } catch {
    return null;
  }
}

let bridge = resolveBridge();

export function isNative() {
  if (!bridge) bridge = resolveBridge();
  return !!(bridge && typeof bridge.openExternal === 'function');
}

const httpUrl = (u) => {
  try {
    const url = new URL(String(u));
    return (url.protocol === 'https:' || url.protocol === 'http:') ? url.toString() : '';
  } catch {
    return '';
  }
};

export const native = {
  isNative,

  /** Open a URL with the best Android handler (browser / Drive / PDF app). */
  async openExternal(url) {
    const safe = httpUrl(url);
    if (!safe) return false;
    if (isNative()) {
      try { await bridge.openExternal({ url: safe }); return true; } catch { /* fall through */ }
    }
    try {
      window.open(safe, '_blank', 'noopener,noreferrer');
      return true;
    } catch {
      location.href = safe;
      return true;
    }
  },

  /**
   * Open a PDF INSIDE the app, in the native viewer screen
   * (PdfViewerActivity: progress, zoom/scroll, back navigation, retry and
   * open-external fallbacks). The direct `file`/`server1`/`file2`/`server2`
   * URL is fetched by Android itself — no Cloudflare Worker traffic, no
   * permanent download (the file lives in the system cache dir and is
   * deleted when the viewer closes).
   *
   * Returns { ok: true } when the native viewer took over, or
   * { ok: false, reason } when the environment has no native layer (plain
   * browser preview / unit harness) so the caller can fall back to
   * openExternal — never to the DSMNRU website.
   */
  async pdfViewer(url, title) {
    const safe = httpUrl(url);
    if (!safe) return { ok: false, reason: 'invalid-url' };
    if (isNative() && typeof bridge.pdfView === 'function') {
      try {
        await bridge.pdfView({ url: safe, title: String(title || 'Paper') });
        return { ok: true };
      } catch (err) {
        return { ok: false, reason: String((err && err.message) || err || 'viewer-error') };
      }
    }
    return { ok: false, reason: 'unavailable' };
  },

  /**
   * Android-native Google sign-in, first step: the device's own Google
   * account chooser (Credential Manager) returns a Google ID token which the
   * caller exchanges with Firebase (auth.signInWithGoogleCredential).
   * Resolves { ok: true, idToken, nonce } on success, or
   * { ok: false, code, message } with one of the machine codes below —
   * notably GOOGLE_SIGNIN_NOT_CONFIGURED when this APK build lacks the
   * Google client-ID configuration (never a website redirect).
   */
  async googleSignIn(nonce) {
    if (isNative() && typeof bridge.googleSignIn === 'function') {
      try {
        const res = await bridge.googleSignIn({ nonce: String(nonce || '') });
        if (res && res.idToken) return { ok: true, idToken: res.idToken, nonce: res.nonce || nonce || '' };
        return { ok: false, code: 'GOOGLE_SIGNIN_UNAVAILABLE', message: 'Empty Google credential' };
      } catch (err) {
        const msg = String((err && err.message) || err || 'Google sign-in failed');
        let code = 'GOOGLE_SIGNIN_UNAVAILABLE';
        if (/GOOGLE_SIGNIN_NOT_CONFIGURED/.test(msg)) code = 'GOOGLE_SIGNIN_NOT_CONFIGURED';
        else if (/GOOGLE_SIGNIN_CANCELLED/.test(msg)) code = 'GOOGLE_SIGNIN_CANCELLED';
        else if (/GOOGLE_SIGNIN_NO_ACCOUNT/.test(msg)) code = 'GOOGLE_SIGNIN_NO_ACCOUNT';
        return { ok: false, code, message: msg };
      }
    }
    return { ok: false, code: 'GOOGLE_SIGNIN_UNAVAILABLE', message: 'Native Google sign-in not available here' };
  },

  /** Save a direct .pdf to the device Downloads via DownloadManager. */
  async download(url, fileName) {
    const safe = httpUrl(url);
    if (!safe) return false;
    if (isNative()) {
      try {
        await bridge.download({ url: safe, fileName: String(fileName || 'dsmnru-paper.pdf') });
        return true;
      } catch { /* fall back to browser download below */ }
    }
    try {
      const a = document.createElement('a');
      a.href = safe;
      a.download = fileName || 'dsmnru-paper.pdf';
      a.rel = 'noopener';
      a.target = '_blank';
      document.body.appendChild(a);
      a.click();
      a.remove();
      return true;
    } catch {
      return false;
    }
  },

  /** System share sheet for a paper: title + link text. */
  async share(title, url) {
    const text = `${title ? title + '\n' : ''}${url || ''}`.trim();
    if (!text) return false;
    if (isNative()) {
      try { await bridge.share({ title: title || 'DSMNRU PYQ', text, url: url || '' }); return true; } catch { /* fall through */ }
    }
    try {
      if (navigator.share) {
        await navigator.share({ title: title || 'DSMNRU PYQ', url: url || undefined, text: url ? undefined : text });
        return true;
      }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch { /* cancelled or unsupported */ }
    return false;
  },

  /** URL this app was launched/forwarded from (site deep link) or ''. */
  async getLaunchUrl() {
    if (isNative() && typeof bridge.getLaunchUrl === 'function') {
      try {
        const res = await bridge.getLaunchUrl();
        return (res && res.url) || '';
      } catch { return ''; }
    }
    return '';
  },

  /** Subscribe to warm-start deep links dispatched by MainActivity. */
  onLink(fn) {
    if (isNative() && typeof bridge.addListener === 'function') {
      try {
        const h = bridge.addListener('siteDeepLink', (ev) => fn((ev && ev.url) || ''));
        return () => { try { h.remove && h.remove(); } catch { /* ignore */ } };
      } catch { return () => {}; }
    }
    return () => {};
  },
};
