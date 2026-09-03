/**
 * DSMNRU PYQ Android — thin wrapper around the app's own native plugin
 * (`DsmnruApp`, implemented in Java under android/app/src/main/java).
 *
 * It keeps the app genuinely "Android":
 *  - openExternal(): hand PDF/host links to the system (browser, Drive, PDF
 *    readers) — same destination as the website's window.open, no duplicate
 *    PDF storage, no app-private download of everything.
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

  /** Open a direct PDF URL — Android resolves a PDF-capable app or browser. */
  async openPdf(url) {
    return this.openExternal(url);
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
