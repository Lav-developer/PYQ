/**
 * DSMNRU PYQ Android — in-app "Upload paper" screen.
 *
 * The website's public upload workflow, rebuilt as native-feeling app UI —
 * NO website page, NO browser redirect:
 *
 *   • same required metadata (title, name, reward email + optional
 *     course/semester), same validation rules (uploadcore.js);
 *   • Android file picker for one PDF (≤10 MB) or several images — standard
 *     <input type=file> which the Capacitor WebView hands to the system
 *     picker (Photos / Documents);
 *   • images are converted to a single PDF on-device (canvas → JPEG →
 *     minimal PDF writer — no jsPDF download, no third-party code);
 *   • the file goes to the SAME gofile.io storage the website uses;
 *   • metadata lands in the SAME Firestore `pendingUploads` collection via
 *     one REST insert (Firestore rules validate it server-side);
 *   • the same local abuse throttle as the website (5 / 6 h, 45 s gap).
 *
 * Uploads are public on the website (the typed email is the reward
 * identity), so no sign-in gate is forced — but when the user IS signed in
 * the form is prefilled and userId is attached, exactly like the site.
 *
 * Network budget: 1 gofile servers call + 1 gofile upload + 1 Firestore
 * insert per successful submission — identical to the website, nothing extra.
 */

import * as ui from '../ui.js';
import * as core from '../uploadcore.js';

const storage = (typeof localStorage !== 'undefined') ? localStorage : null;

/** Canvas-dependent step: one File → { jpeg, width, height } under limits. */
async function encodeImageFile(file, { maxDimension, quality }) {
  const bitmapUrl = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error(`Could not read image “${file.name}”.`));
      el.src = bitmapUrl;
    });
    const scale = Math.min(1, maxDimension / Math.max(img.naturalWidth || img.width, img.naturalHeight || img.height, 1));
    const cw = Math.max(1, Math.round((img.naturalWidth || img.width) * scale));
    const ch = Math.max(1, Math.round((img.naturalHeight || img.height) * scale));
    const canvas = document.createElement('canvas');
    canvas.width = cw;
    canvas.height = ch;
    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, cw, ch);
    ctx.drawImage(img, 0, 0, cw, ch);
    const dataUrl = canvas.toDataURL('image/jpeg', quality);
    const jpeg = base64ToBytes(String(dataUrl).slice(dataUrl.indexOf(',') + 1));
    return { jpeg, width: cw, height: ch };
  } finally {
    try { URL.revokeObjectURL(bitmapUrl); } catch { /* ignore */ }
  }
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function fileToBytes(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result));
    reader.onerror = () => reject(new Error(`Could not read “${file.name}”.`));
    reader.readAsArrayBuffer(file);
  });
}

/** XHR (progress events) upload of one file to gofile — CORS-enabled. */
function uploadToGofile(uploadUrl, file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', uploadUrl, true);
    xhr.responseType = 'json';
    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total);
    });
    xhr.addEventListener('load', () => {
      let data = xhr.response;
      if (data == null) { try { data = JSON.parse(xhr.responseText); } catch { data = null; } }
      if (xhr.status < 200 || xhr.status >= 300) {
        reject(new Error(`Upload failed with status ${xhr.status}`));
        return;
      }
      if (!data || data.status !== 'ok' || !data.data || !data.data.downloadPage) {
        reject(new Error('Upload failed: Invalid response from server'));
        return;
      }
      resolve(data.data.downloadPage);
    });
    xhr.addEventListener('error', () => reject(new Error('Network error while uploading the file.')));
    xhr.addEventListener('abort', () => reject(new Error('Upload cancelled.')));
    const form = new FormData();
    form.append('file', file, file.name || 'paper.pdf');
    xhr.send(form);
  });
}

export default async function renderUpload(root, ctx) {
  const { ui: _u, api, auth } = ctx;
  ctx.setHeader({ title: 'Upload paper', sub: 'help grow the archive', brand: false });

  const user = auth.current();
  const prefillName = user && user.name && user.providerId ? user.name : '';
  const prefillEmail = user && user.email ? user.email : '';

  root.innerHTML = `
    <div class="stack">
      <section class="notice notice--info">
        ${ctx.ui.icon('upload')}
        <div><b>Share a question paper or syllabus.</b> Approved uploads earn
        <b>10 points</b> for the email you enter — the same reward system as the website.</div>
      </section>

      <section class="card card-pad" id="up-card">
        <form id="up-form" novalidate>
          <div class="field">
            <label for="up-title">Title <b class="req">*</b></label>
            <input class="input" id="up-title" type="text" placeholder="e.g., Indian Constitution {2023}" maxlength="200" enterkeyhint="next">
          </div>
          <div class="field">
            <label for="up-name">Your name <b class="req">*</b></label>
            <input class="input" id="up-name" type="text" placeholder="Who should get credit?" maxlength="80" value="${ui.esc(prefillName)}" enterkeyhint="next">
          </div>
          <div class="field">
            <label for="up-email">Your email <b class="req">*</b></label>
            <input class="input" id="up-email" type="email" inputmode="email" placeholder="you@example.com" autocomplete="email" value="${ui.esc(prefillEmail)}" enterkeyhint="next">
            <p class="field-hint">Points are credited to this email (trim + lowercase, like the website).</p>
          </div>
          <div class="field-row">
            <div class="field">
              <label for="up-course">Course <span class="opt">(optional)</span></label>
              <input class="input" id="up-course" type="text" placeholder="e.g., B.A." enterkeyhint="next">
            </div>
            <div class="field">
              <label for="up-sem">Semester <span class="opt">(optional)</span></label>
              <input class="input" id="up-sem" type="text" placeholder="e.g., 4th" enterkeyhint="done">
            </div>
          </div>

          <div class="field">
            <label>File <b class="req">*</b></label>
            <label class="file-drop" id="up-drop" for="up-file">
              <span class="file-drop-ic">${ui.icon('pdf')}</span>
              <span class="file-drop-main" id="up-drop-text">Choose one PDF (≤10 MB) or photos of the paper<small>PDF, JPG, PNG, WebP — picked with the Android file picker</small></span>
              <span class="file-drop-btn">Browse</span>
            </label>
            <input id="up-file" type="file" accept="application/pdf,image/*" multiple hidden>
          </div>

          <div data-err class="form-error" hidden></div>

          <div class="up-progress" id="up-progress" hidden>
            <div class="up-progress-bar"><div id="up-progress-fill" style="width:0%"></div></div>
            <p class="up-progress-text" id="up-progress-text">Preparing…</p>
          </div>

          <button class="btn btn--primary btn--block" id="up-submit" type="submit">${ui.icon('upload')} Upload paper</button>
          <p class="form-note">Same flow as the website: the file goes to the shared storage service and a moderator
          reviews it before it appears in the archive. Nothing is auto-published.</p>
        </form>
      </section>
    </div>`;

  const form = root.querySelector('#up-form');
  const fileInput = root.querySelector('#up-file');
  const dropText = root.querySelector('#up-drop-text');
  const drop = root.querySelector('#up-drop');
  const errEl = root.querySelector('[data-err]');
  const progressWrap = root.querySelector('#up-progress');
  const progressFill = root.querySelector('#up-progress-fill');
  const progressText = root.querySelector('#up-progress-text');
  const submitBtn = root.querySelector('#up-submit');
  let selected = [];

  function paintSelection() {
    if (!selected.length) {
      drop.classList.remove('has-file');
      dropText.innerHTML = `Choose one PDF (≤10 MB) or photos of the paper<small>PDF, JPG, PNG, WebP — picked with the Android file picker</small>`;
      return;
    }
    const { pdfs, images } = core.classifyFiles(selected);
    drop.classList.add('has-file');
    if (pdfs.length === 1) {
      dropText.innerHTML = `${ui.esc(pdfs[0].name)}<small>${(pdfs[0].size / (1024 * 1024)).toFixed(2)} MB · ready</small>`;
    } else if (images.length) {
      dropText.innerHTML = `${images.length} photo${images.length === 1 ? '' : 's'} selected<small>They will be combined into one PDF on this device</small>`;
    } else {
      dropText.innerHTML = `${selected.length} file(s) selected<small>${ui.esc(selected.map((f) => f.name).join(', ').slice(0, 80))}</small>`;
    }
  }

  fileInput.addEventListener('change', () => {
    selected = Array.from(fileInput.files || []);
    errEl.hidden = true;
    paintSelection();
  });

  function setProgress(pct, text) {
    progressWrap.hidden = false;
    progressFill.style.width = `${Math.max(0, Math.min(100, pct))}%`;
    if (text) progressText.textContent = text;
  }
  function setError(msg) {
    errEl.textContent = msg;
    errEl.hidden = false;
    progressWrap.hidden = true;
    submitBtn.disabled = false;
    submitBtn.innerHTML = `${ui.icon('upload')} Upload paper`;
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (submitBtn.disabled) return;

    const title = root.querySelector('#up-title').value;
    const studentName = root.querySelector('#up-name').value;
    const rawEmail = root.querySelector('#up-email').value;
    const course = root.querySelector('#up-course').value;
    const semester = root.querySelector('#up-sem').value;
    const throttle = core.getUploadThrottleState(storage, Date.now());

    const check = core.validateUploadAttempt({
      title, studentName, rawEmail, files: selected, throttleState: throttle,
    });
    if (!check.ok) { setError(check.message); return; }

    errEl.hidden = true;
    submitBtn.disabled = true;
    submitBtn.innerHTML = 'Working…';

    try {
      // 1) Build the final PDF file (single PDF passes through untouched).
      let file = null;
      const { pdfs, images } = core.classifyFiles(selected);
      if (pdfs.length === 1) {
        file = pdfs[0];
        setProgress(12, 'Reading PDF…');
      } else {
        let pages = [];
        const attempts = core.IMAGE_ENCODE_ATTEMPTS;
        for (let a = 0; a < attempts.length; a++) {
          setProgress(10 + a * 5, `Converting ${images.length} photo${images.length === 1 ? '' : 's'} to PDF (pass ${a + 1}/${attempts.length})…`);
          pages = [];
          for (const img of images) {
            pages.push(await encodeImageFile(img, attempts[a]));
          }
          const pdfBytes = core.assemblePdfFromJpegs(pages);
          if (pdfBytes.length <= core.MAX_FINAL_PDF_SIZE) {
            file = new File([pdfBytes], `images-${Date.now()}.pdf`, { type: 'application/pdf' });
            break;
          }
        }
        if (!file) throw new Error('Could not generate a PDF under 10MB. Please upload fewer or clearer photos.');
      }

      // 2) Upload to the shared gofile storage (same service as the website).
      setProgress(30, 'Getting an upload server…');
      const uploadUrl = await core.fetchGofileUploadUrl();
      setProgress(40, 'Uploading file…');
      const downloadUrl = await uploadToGofile(uploadUrl, file, (frac) => {
        setProgress(40 + Math.round(frac * 45), `Uploading file… ${Math.round(frac * 100)}%`);
      });

      // 3) Save metadata to the same pendingUploads queue (one REST insert).
      setProgress(92, 'Saving submission for review…');
      const doc = core.buildPendingUploadDoc({
        title: String(title).trim(),
        course: String(course).trim(),
        semester: String(semester).trim(),
        studentName: String(studentName).trim(),
        studentCourse: String(course).trim() || 'General',
        studentEmail: check.email,
        userId: user ? user.uid : '',
        fileName: file.name || 'paper.pdf',
        downloadUrl,
        fileSize: file.size,
        createdAtIso: new Date().toISOString(),
      });
      const headers = { 'Content-Type': 'application/json' };
      if (user && user.idToken) headers.Authorization = 'Bearer ' + user.idToken;
      const res = await fetch(core.pendingUploadsUrl(), { method: 'POST', headers, body: JSON.stringify(doc) });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error((body && body.error && body.error.message) || 'Could not register the submission. Try again.');
      }

      core.recordUploadThrottle(storage, Date.now());
      setProgress(100, 'Done');

      // 4) In-app success state (no page jump, no website).
      root.innerHTML = `
        <div class="stack">
          <section class="state-block state-block--ok" id="up-success">
            <div class="state-icon">${ui.icon('check')}</div>
            <h4>Submission received</h4>
            <p>“${ui.esc(String(title).trim())}” is now <b>pending review</b> by the moderators.</p>
            <p><b>10 points</b> will be credited to <code>${ui.esc(check.email)}</code> once it is approved.</p>
            <div class="sheet-actions">
              <button class="btn btn--ghost" id="up-again" type="button">Upload another</button>
              <button class="btn btn--primary" id="up-done" type="button">Done</button>
            </div>
          </section>
        </div>`;
      root.querySelector('#up-again').addEventListener('click', () => renderUpload(root, ctx));
      root.querySelector('#up-done').addEventListener('click', () => ctx.router.back());
      ui.toast('Submission received — pending review');
    } catch (err) {
      const raw = String((err && err.message) || err);
      const scrubbed = raw.replace(/https?:\/\/\S+/g, '').replace(/\s{2,}/g, ' ').trim();
      if (/failed to fetch|networkerror|load failed/i.test(raw)) {
        setError('Please check your internet connection and try again.');
      } else {
        setError(scrubbed || 'Something went wrong. Please try again.');
      }
    }
  });

  ctx.setRefresh(() => renderUpload(root, ctx, {}));
}
