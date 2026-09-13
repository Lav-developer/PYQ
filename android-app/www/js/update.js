import { native } from './native.js';
import { WORKER_ORIGIN } from './api.js';

export function isNewer(remote, local) { return Number.isInteger(Number(remote)) && Number(remote) > Number(local); }
export function parseUpdate(raw, localVersionCode) {
  if (!raw || typeof raw !== 'object' || !/^\d+\.\d+\.\d+$/.test(String(raw.version)) || !isNewer(raw.versionCode, localVersionCode) || !/^https:\/\/(github\.com|objects\.githubusercontent\.com)\//.test(String(raw.downloadUrl))) return null;
  return { ...raw, versionCode: Number(raw.versionCode), releaseNotes: Array.isArray(raw.releaseNotes) ? raw.releaseNotes.filter(x => typeof x === 'string').slice(0, 5) : [], mandatory: raw.mandatory === true };
}
let lastCheck = 0;
export async function checkForUpdate({ force = false, ui = null } = {}) {
  if (!force && Date.now() - lastCheck < 6 * 60 * 60 * 1000) return null;
  lastCheck = Date.now();
  try { const installed = await native.getAppVersion(); const r = await fetch(`${WORKER_ORIGIN}/api/app-update`, { headers: { Accept: 'application/json' } }); const update = parseUpdate(await r.json(), Number(installed.versionCode)); if (update && ui) showUpdate(update, ui); return update; } catch { return null; }
}

// The native layer now ALWAYS answers downloadAndInstall exactly once
// (resolve or reject, even on internal errors). The watchdog below is the
// belt-and-braces for a wedged bridge: the updater UI must never park on
// "Downloading…" indefinitely. (Test hook lets the suite shrink the window.)
let watchdogMs = 90000;
export function _setUpdateWatchdogMs(ms) { watchdogMs = Number(ms) > 0 ? Number(ms) : 90000; }

const mb = (b) => (b / 1e6).toFixed(2);
const humanError = (e) => String((e && e.message) || e || 'Update failed').replace(/^[A-Z0-9_]+:\s*/, '') || 'Update failed';

function showUpdate(update, ui) {
  const notes = update.releaseNotes.length ? `<ul>${update.releaseNotes.map(x => `<li>${escapeHtml(x)}</li>`).join('')}</ul>` : '<p>Bug fixes and improvements.</p>';
  const buttons = update.mandatory ? '<button class="btn btn--primary" id="update-now">Update Now</button>' : '<button class="btn btn--ghost" id="update-later">Later</button><button class="btn btn--primary" id="update-now">Update Now</button>';
  ui.sheet({ title: 'Update Available', content: `<p>DSMNRU PYQ v${escapeHtml(update.version)}</p>${notes}<div class=\"sheet-actions\">${buttons}</div>` });
  document.querySelector('#update-later')?.addEventListener('click', () => ui.closeSheet());
  document.querySelector('#update-now')?.addEventListener('click', () => runInstall(update, ui));
}

/**
 * One install attempt, driven by the native layer's REAL phases:
 * Downloading… (actual bytes) → Verifying… → Starting installer… → then the
 * button leaves the busy state for good. Every failure — download,
 * verification, permission, or installer launch — resolves into a re-enabled
 * retry button plus a toast, so the UI can never stick on "Downloading…".
 */
async function runInstall(update, ui) {
  const b = document.querySelector('#update-now');
  if (!b || b.dataset.busy === '1') return;
  b.dataset.busy = '1';
  b.disabled = true;
  b.textContent = 'Downloading…';
  let settled = false;
  let watchdog = 0;
  let stopProgress = () => {};
  const stall = () => fail(new Error('UPDATE_WATCHDOG: update is taking too long — check your connection and try again'));
  const arm = () => { clearTimeout(watchdog); watchdog = setTimeout(stall, watchdogMs); };
  const settle = (after) => { if (settled) return; settled = true; clearTimeout(watchdog); stopProgress(); delete b.dataset.busy; if (after) after(); };
  const fail = (e) => settle(() => {
    b.disabled = false;
    b.textContent = /INSTALL_PERMISSION_REQUIRED/.test(String((e && e.message) || '')) ? 'Enable installs & try again' : 'Try again';
    ui.toast(humanError(e), 'err');
  });
  stopProgress = native.onUpdateProgress((ev) => {
    if (settled || !ev) return;
    if (ev.phase === 'download') b.textContent = ev.total > 0 ? `Downloading… ${mb(ev.bytes)} / ${mb(ev.total)} MB` : `Downloading… ${mb(ev.bytes)} MB`;
    else if (ev.phase === 'verify') b.textContent = 'Verifying…';
    else if (ev.phase === 'install') b.textContent = 'Starting installer…';
    if (ev.phase) arm(); // native is alive — keep deferring the watchdog
  });
  arm();
  try {
    await native.downloadAndInstall(update.downloadUrl, `dsmnru-pyq-${update.version}.apk`, update.versionCode);
    settle(() => {
      // The system install screen is up (or the user was taken to the exact
      // settings screen to allow installs). Reopening is instant — the
      // verified APK stays cached — so a cancelled installer can be
      // relaunched from this same button instead of a dead end.
      b.disabled = false;
      b.textContent = 'Open installer';
    });
  } catch (e) { fail(e); }
}
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
