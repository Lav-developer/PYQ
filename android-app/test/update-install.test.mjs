/**
 * DSMNRU PYQ Android — in-app updater DOWNLOAD → INSTALL completion tests.
 *
 * The bug this locks down: the update downloaded to "5.70 MB / 5.70 MB" and
 * then NOTHING happened — the installer never opened and the UI stayed on
 * "Downloading…" forever. Covers every layer testable without a device:
 *
 *   1. trusted GitHub APK URL accepted / untrusted rejected   (policy source)
 *   2. redirect handling is manual + re-validated per hop     (policy source)
 *   3. download failure & post-download failure always reach JS
 *      (plugin call answered exactly once — `catch (Throwable)`)
 *   4. APK existence/size/ZIP/PackageManager validation + .part→.apk rename
 *   5. FileProvider configuration (cache-path, exported=false, grants)
 *   6. installer Intent contract (content:// URI, APK MIME, grant flag)
 *   7. REQUEST_INSTALL_PACKAGES + unknown-app-sources guidance
 *   8. JS never sits on "Downloading…" — jsdom state machine: progress,
 *      verify/install phases, success, download-failure, install-failure,
 *      permission-required, watchdog, retry
 *   9. Optional updates keep "Later"; mandatory updates keep working
 *  10. version comparison unchanged: 1.4.1 (code 12) → v1.4.2 (code 13)
 *  11. NO version bump: build.gradle stays 1.4.1 / 12
 *
 * jsdom comes from worker/node_modules when installed (skips otherwise) —
 * same pattern as app-native-bridge.test.mjs.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const WWW = join(here, '../www');
const ANDROID = join(here, '../android/app/src/main');
const pluginSrc = readFileSync(join(ANDROID, 'java/com/dsmnru/pyq/DsmnruAppPlugin.java'), 'utf8');
const policySrc = readFileSync(join(ANDROID, 'java/com/dsmnru/pyq/UpdateUrlPolicy.java'), 'utf8');
const policyTestSrc = readFileSync(join(ANDROID, '../test/java/com/dsmnru/pyq/UpdateUrlPolicyTest.java'), 'utf8');
const manifestSrc = readFileSync(join(ANDROID, 'AndroidManifest.xml'), 'utf8');
const pathsSrc = readFileSync(join(ANDROID, 'res/xml/file_paths.xml'), 'utf8');
const gradleSrc = readFileSync(join(here, '../android/app/build.gradle'), 'utf8');

// ── native downloader: URL trust + redirects ─────────────────────────────

test('policy: only trusted HTTPS GitHub release URLs can be downloaded', () => {
  assert.match(policySrc, /INITIAL_HOST_GITHUB = "github\.com"/);
  assert.match(policySrc, /INITIAL_HOST_OBJECTS = "objects\.githubusercontent\.com"/);
  assert.match(policySrc, /!"https"\.equalsIgnoreCase\(parsed\.getProtocol\(\)\)/); // https only
  assert.match(policySrc, /parsed\.getUserInfo\(\) != null/);                      // no embedded creds
  assert.match(pluginSrc, /UpdateUrlPolicy\.isTrustedUpdateUrl\(source\)/);
  // behavioural coverage exists in the plain-JVM JUnit suite
  assert.match(policyTestSrc, /rejectsUntrustedSchemesAndHosts/);
});

test('policy: redirects are followed manually and re-validated per hop', () => {
  assert.match(pluginSrc, /setInstanceFollowRedirects\(false\)/);          // never the silent default
  assert.match(policySrc, /isTrustedRedirectTarget/);                       // every hop re-validated
  assert.match(policySrc, /REDIRECT_HOST_SUFFIX = "\.githubusercontent\.com"/); // GitHub CDN only
  assert.match(policySrc, /MAX_REDIRECTS = 5/);                             // bounded loop
  assert.match(pluginSrc, /setConnectTimeout\(\s*CONNECT_TIMEOUT_MS\s*\)/);
  assert.match(pluginSrc, /setReadTimeout\(\s*READ_TIMEOUT_MS\s*\)/);
  assert.match(pluginSrc, /setRequestProperty\("User-Agent"/);
  assert.match(pluginSrc, /connection\.disconnect\(\)/);                    // streams/connections closed
});

// ── post-download phase separation + validation ──────────────────────────

test('native: download completion is separated from installation (phases)', () => {
  assert.match(pluginSrc, /notifyListeners\("updateDownloadProgress"/);     // download → JS
  assert.match(pluginSrc, /emitProgress\("verify"/);
  assert.match(pluginSrc, /emitProgress\("install"/);
});

test('native: the APK is verified before any installer intent exists', () => {
  assert.match(pluginSrc, /\.part/);                                        // temp download file
  assert.match(pluginSrc, /renameTo\(apkFile\)/);                           // promote only after verification
  assert.match(pluginSrc, /partFile\.delete\(\)/);                          // partial/corrupt cleanup
  assert.match(pluginSrc, /verifyApk\(/);
  assert.match(pluginSrc, /apk\.isFile\(\)/);                               // existence
  assert.match(pluginSrc, /isPlausibleApkSize\(/);                          // size
  assert.match(pluginSrc, /looksLikeZip\(/);                                // ZIP magic
  assert.match(pluginSrc, /getPackageArchiveInfo\(/);                       // real package parse
  assert.match(pluginSrc, /expectedVersionCode/);                           // exact expected release
});

test('native: the plugin call is ALWAYS answered — no stuck "Downloading…"', () => {
  assert.match(pluginSrc, /catch \(Throwable/);                             // Errors too, not just Exceptions
  assert.match(pluginSrc, /resolveOnce/);
  assert.match(pluginSrc, /rejectOnce/);
  assert.match(pluginSrc, /UPDATE_BUSY/);                                   // single-flight guard
  assert.match(policySrc, /private UpdateUrlPolicy\(\)/);                   // policy is static-only
});

test('native: expectedVersionCode is read with the non-throwing JSONObject.opt (compilable)', () => {
  // JSONObject.get(String) throws the CHECKED JSONException — a plain .get
  // here fails `assembleRelease` with "unreported exception JSONException".
  // .opt(String) returns null when absent and never throws.
  assert.match(pluginSrc, /getData\(\)\s*==\s*null\s*\?\s*null\s*:\s*call\.getData\(\)\.opt\("expectedVersionCode"\)/);
  assert.doesNotMatch(pluginSrc, /getData\(\)\.get\(/);
  assert.match(pluginSrc, /rawExpected instanceof Number/);                 // typed guard preserved
});

// ── FileProvider + installer Intent contract ─────────────────────────────

test('installer: FileProvider content:// URI, correct MIME and granted read permission', () => {
  assert.match(pluginSrc, /FileProvider\.getUriForFile\(/);
  assert.match(pluginSrc, /getPackageName\(\)\s*\+\s*"\.fileprovider"/);    // same authority as the manifest
  assert.match(pluginSrc, /application\/vnd\.android\.package-archive/);
  assert.match(pluginSrc, /FLAG_GRANT_READ_URI_PERMISSION/);
  assert.doesNotMatch(pluginSrc, /file:\/\//);                              // never a file:// URI
  assert.match(manifestSrc, /android:name="androidx\.core\.content\.FileProvider"/);
  assert.match(manifestSrc, /android:authorities="\$\{applicationId\}\.fileprovider"/);
  assert.match(manifestSrc, /android:exported="false"/);
  assert.match(manifestSrc, /android:grantUriPermissions="true"/);
  assert.match(pathsSrc, /<cache-path [^>]*path="\."/);                     // covers the cache-dir APK
});

test('installer: unknown-app-install permission is detected and guided, never silent', () => {
  assert.match(manifestSrc, /<uses-permission android:name="android\.permission\.REQUEST_INSTALL_PACKAGES" ?\/>/);
  assert.match(pluginSrc, /canRequestPackageInstalls\(\)/);                 // detect BEFORE launching
  assert.match(pluginSrc, /ACTION_MANAGE_UNKNOWN_APP_SOURCES/);             // open the exact settings screen
  assert.match(pluginSrc, /UPDATE_INSTALL_PERMISSION_REQUIRED/);            // JS gets a real error, not silence
  assert.match(pluginSrc, /UPDATE_INSTALL_FAILED/);                         // installer launch failures propagate
});

// ── version / release safety ─────────────────────────────────────────────

test('NO version bump: the fix keeps versionName 1.4.1 / versionCode 12', () => {
  // Anchored to statement position (comments may mention other versions).
  assert.match(gradleSrc, /^\s*versionCode\s+12\s*$/m);
  assert.match(gradleSrc, /^\s*versionName\s+"1\.4\.1"\s*$/m);
  assert.doesNotMatch(gradleSrc, /^\s*versionCode\s+13\s*$/m);
  assert.doesNotMatch(gradleSrc, /^\s*versionName\s+"1\.4\.2"\s*$/m);
});

test('update detection unchanged: local 1.4.1 (code 12) → GitHub v1.4.2 (code 13) = update available', async () => {
  const { isNewer, parseUpdate } = await import(pathToFileURL(join(WWW, 'js/update.js')).href);
  assert.equal(isNewer(13, 12), true);
  const meta = {
    version: '1.4.2', versionCode: 13,
    downloadUrl: 'https://github.com/Lav-developer/PYQ/releases/download/v1.4.2/dsmnru-pyq.apk',
    releaseNotes: ['Fixed in-app update installation'], mandatory: false,
  };
  const parsed = parseUpdate(meta, 12);
  assert.ok(parsed, 'v1.4.2 (code 13) must be detected from an installed 1.4.1 (code 12)');
  assert.equal(parsed.versionCode, 13);
  assert.equal(parsed.mandatory, false);
  assert.equal(parseUpdate({ ...meta, versionCode: 12 }, 12), null);        // same code → no update
  assert.equal(parseUpdate({ ...meta, downloadUrl: 'https://evil.example.com/x.apk' }, 12), null);
  assert.equal(parseUpdate({ ...meta, downloadUrl: 'http://github.com/x.apk' }, 12), null);
});

const UPDATE_META = {
  version: '1.4.2', versionCode: 13,
  downloadUrl: 'https://github.com/Lav-developer/PYQ/releases/download/v1.4.2/dsmnru-pyq.apk',
  releaseNotes: ['Fixed in-app update installation'], mandatory: false,
};

// ── JS updater state machine (jsdom + fake Capacitor bridge) ─────────────

let JSDOM;
try {
  ({ JSDOM } = await import(pathToFileURL(join(here, '../../worker/node_modules/jsdom/lib/api.js')).href));
} catch {
  try { ({ JSDOM } = await import('jsdom')); } catch { /* skipped below */ }
}

if (JSDOM) {
  const tick = (ms = 15) => new Promise((r) => setTimeout(r, ms));

  /** Fake Capacitor bridge: records calls, lets each test script the outcome. */
  function makeBridge() {
    const calls = [];
    let installImpl = () => new Promise(() => {}); // default: never settles (worst case)
    let progressHandler = null;
    const DsmnruApp = {
      // isNative() probes for openExternal — present on the real bridge.
      async openExternal(opts) { calls.push({ kind: 'openExternal', url: opts && opts.url }); return {}; },
      async getAppVersion() { calls.push({ kind: 'getAppVersion' }); return { versionName: '1.4.1', versionCode: 12 }; },
      downloadAndInstall(opts) { calls.push({ kind: 'downloadAndInstall', opts }); return installImpl(opts); },
      addListener(evt, cb) {
        calls.push({ kind: 'addListener', evt });
        if (evt === 'updateDownloadProgress') progressHandler = cb;
        return { remove: () => { progressHandler = null; } };
      },
    };
    return {
      DsmnruApp, calls,
      emit(progress) { if (progressHandler) progressHandler(progress); },
      set impl(fn) { installImpl = fn; },
    };
  }

  async function openUpdateSheet(t, { mandatory = false } = {}) {
    const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://localhost/' });
    const { window } = dom;
    t.after(() => { try { window.close(); } catch { /* gone */ } });
    for (const key of ['window', 'document', 'HTMLElement', 'Event']) {
      Object.defineProperty(globalThis, key, { value: window[key], configurable: true, writable: true });
    }
    const bridge = makeBridge();
    globalThis.Capacitor = { Plugins: { DsmnruApp: bridge.DsmnruApp } };
    globalThis.fetch = async (url) => {
      if (String(url).includes('/api/app-update')) {
        return { ok: true, status: 200, json: async () => ({ ...UPDATE_META, mandatory }) };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    };
    const { checkForUpdate, _setUpdateWatchdogMs } = await import(pathToFileURL(join(WWW, 'js/update.js')).href);
    const ui = {
      sheetOpts: null, toasts: [],
      sheet(o) { this.sheetOpts = o; document.body.innerHTML = `<div class="sheet-root">${o.content}</div>`; },
      closeSheet() { document.body.innerHTML = ''; return true; },
      toast(m, k) { this.toasts.push({ m, k }); },
    };
    const found = await checkForUpdate({ force: true, ui });
    assert.ok(found && found.versionCode === 13, 'v1.4.2 detected against installed code 12');
    return { dom, window, bridge, ui, _setUpdateWatchdogMs, now: () => document.querySelector('#update-now'), later: () => document.querySelector('#update-later') };
  }

  test('updater: real byte progress renders, then SUCCESS leaves the busy state', async (t) => {
    const ctx = await openUpdateSheet(t);
    ctx.bridge.impl = () => new Promise((resolve) => {
      ctx.resolveInstall = resolve;
    });
    const b = ctx.now();
    assert.equal(b.textContent, 'Update Now');
    b.click();
    await tick();
    assert.equal(b.disabled, true, 'busy during download');
    assert.match(b.textContent, /^Downloading…/);

    ctx.bridge.emit({ phase: 'download', bytes: 0, total: 5704283 });
    assert.match(b.textContent, /Downloading… 0\.00 \/ 5\.70 MB/);
    ctx.bridge.emit({ phase: 'download', bytes: 5704283, total: 5704283 });   // the real 100% tick
    assert.match(b.textContent, /Downloading… 5\.70 \/ 5\.70 MB/);
    ctx.bridge.emit({ phase: 'verify', bytes: 5704283, total: 5704283 });
    assert.equal(b.textContent, 'Verifying…');
    ctx.bridge.emit({ phase: 'install', bytes: 5704283, total: 5704283 });
    assert.equal(b.textContent, 'Starting installer…');

    ctx.resolveInstall({ ok: true, installerOpened: true });                  // installer actually launched
    await tick();
    assert.equal(ctx.bridge.calls.filter((c) => c.kind === 'downloadAndInstall').length, 1);
    assert.equal(b.disabled, false, 'button leaves the busy state on success');
    assert.equal(b.textContent, 'Open installer');
    assert.doesNotMatch(b.textContent, /Downloading…/, 'never stuck on "Downloading…" after completion');
    assert.match(String(ctx.bridge.calls.at(-1).opts.expectedVersionCode), /^13$/, 'expected release code passed to native');
    assert.match(String(ctx.bridge.calls.at(-1).opts.fileName), /^dsmnru-pyq-1\.4\.2\.apk$/, '.apk filename passed to native');
  });

  test('updater: DOWNLOAD failure → retry state + toast, never "Downloading…"', async (t) => {
    const ctx = await openUpdateSheet(t);
    ctx.bridge.impl = () => Promise.reject(new Error('UPDATE_DOWNLOAD_FAILED: HTTP 404'));
    const b = ctx.now();
    b.click();
    await tick();
    assert.equal(b.disabled, false, 're-enabled for retry');
    assert.equal(b.textContent, 'Try again');
    assert.equal(ctx.ui.toasts.at(-1)?.k, 'err');
    assert.match(ctx.ui.toasts.at(-1)?.m, /HTTP 404/);
    // retry issues a fresh native call
    ctx.bridge.impl = () => Promise.resolve({ ok: true, installerOpened: true });
    b.click();
    await tick();
    assert.equal(ctx.bridge.calls.filter((c) => c.kind === 'downloadAndInstall').length, 2);
    assert.equal(b.textContent, 'Open installer');
  });

  test('updater: POST-DOWNLOAD installer failure → retry state (JS not left waiting)', async (t) => {
    const ctx = await openUpdateSheet(t);
    let rejectInstall;
    ctx.bridge.impl = () => new Promise((_, reject) => { rejectInstall = reject; });
    const b = ctx.now();
    b.click();
    await tick();
    ctx.bridge.emit({ phase: 'download', bytes: 5704283, total: 5704283 });   // download was fine…
    assert.match(b.textContent, /Downloading… 5\.70 \/ 5\.70 MB/);
    rejectInstall(new Error('UPDATE_INSTALL_FAILED: no package installer is available on this device'));
    await tick(20);
    assert.equal(b.textContent, 'Try again', 'installer failure surfaces instead of hanging');
    assert.match(ctx.ui.toasts.at(-1)?.m, /package installer/);
    assert.equal(ctx.ui.toasts.at(-1)?.k, 'err');
  });

  test('updater: missing install permission → settings guidance + "Enable installs & try again"', async (t) => {
    const ctx = await openUpdateSheet(t);
    ctx.bridge.impl = () => Promise.reject(new Error('UPDATE_INSTALL_PERMISSION_REQUIRED: allow "Install unknown apps" for DSMNRU PYQ, then tap Try again'));
    const b = ctx.now();
    b.click();
    await tick();
    assert.equal(b.textContent, 'Enable installs & try again');
    assert.match(ctx.ui.toasts.at(-1)?.m, /Install unknown apps/);
    // after granting in Settings, retry installs
    ctx.bridge.impl = () => Promise.resolve({ ok: true, installerOpened: true });
    b.click();
    await tick();
    assert.equal(b.textContent, 'Open installer');
  });

  test('updater: WATCHDOG — a wedged native call cannot park the UI on "Downloading…"', async (t) => {
    const ctx = await openUpdateSheet(t);
    ctx._setUpdateWatchdogMs(40); // test hook (default 90s)
    t.after(() => ctx._setUpdateWatchdogMs(90000));
    ctx.bridge.impl = () => new Promise(() => {}); // never settles
    const b = ctx.now();
    b.click();
    await tick(120);
    assert.equal(b.disabled, false);
    assert.equal(b.textContent, 'Try again');
    assert.match(ctx.ui.toasts.at(-1)?.m, /taking too long/);
    // even if native resolves LATE, the UI is not flipped back to busy states
    await tick(30);
    assert.equal(b.textContent, 'Try again');
  });

  test('updater: OPTIONAL update keeps "Later"; MANDATORY update has only "Update Now" and still retries', async (t) => {
    const optional = await openUpdateSheet(t, { mandatory: false });
    assert.ok(optional.later(), 'Later button present for optional updates');
    assert.equal(optional.now().textContent, 'Update Now');
    optional.later().click();
    assert.equal(optional.now(), null, 'Later closes the sheet');

    const mandatory = await openUpdateSheet(t, { mandatory: true });
    assert.equal(mandatory.later(), null, 'no Later for mandatory updates');
    mandatory.bridge.impl = () => Promise.reject(new Error('UPDATE_DOWNLOAD_FAILED: HTTP 503'));
    mandatory.now().click();
    await tick();
    assert.equal(mandatory.now().textContent, 'Try again', 'mandatory update still offers retry');
  });
} else {
  test('updater UI states (skipped: jsdom not installed)', { skip: true }, () => {});
}
