import { native } from './native.js';
import { WORKER_ORIGIN } from './api.js';

export const CURRENT_VERSION_CODE = 12;
export function isNewer(remote, local = CURRENT_VERSION_CODE) { return Number.isInteger(Number(remote)) && Number(remote) > Number(local); }
export function parseUpdate(raw) {
  if (!raw || typeof raw !== 'object' || !/^\d+\.\d+\.\d+$/.test(String(raw.version)) || !isNewer(raw.versionCode) || !/^https:\/\/(github\.com|objects\.githubusercontent\.com)\//.test(String(raw.downloadUrl))) return null;
  return { ...raw, versionCode: Number(raw.versionCode), releaseNotes: Array.isArray(raw.releaseNotes) ? raw.releaseNotes.filter(x => typeof x === 'string').slice(0, 5) : [], mandatory: raw.mandatory === true };
}
let lastCheck = 0;
export async function checkForUpdate({ force = false, ui = null } = {}) {
  if (!force && Date.now() - lastCheck < 6 * 60 * 60 * 1000) return null;
  lastCheck = Date.now();
  try { const r = await fetch(`${WORKER_ORIGIN}/api/app-update`, { headers: { Accept: 'application/json' } }); const update = parseUpdate(await r.json()); if (update && ui) showUpdate(update, ui); return update; } catch { return null; }
}
function showUpdate(update, ui) {
  const notes = update.releaseNotes.length ? `<ul>${update.releaseNotes.map(x => `<li>${escapeHtml(x)}</li>`).join('')}</ul>` : '<p>Bug fixes and improvements.</p>';
  const buttons = update.mandatory ? '<button class="btn btn--primary" id="update-now">Update Now</button>' : '<button class="btn btn--ghost" id="update-later">Later</button><button class="btn btn--primary" id="update-now">Update Now</button>';
  ui.sheet({ title: 'Update Available', content: `<p>DSMNRU PYQ v${escapeHtml(update.version)}</p>${notes}<div class=\"sheet-actions\">${buttons}</div>` });
  document.querySelector('#update-later')?.addEventListener('click', () => ui.closeSheet());
  document.querySelector('#update-now')?.addEventListener('click', async () => { const b=document.querySelector('#update-now'); b.disabled=true; b.textContent='Downloading…'; try { await native.downloadAndInstall(update.downloadUrl, `dsmnru-pyq-${update.version}.apk`); } catch (e) { b.disabled=false; b.textContent='Try again'; ui.toast(e.message || 'Update failed', 'err'); } });
}
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
