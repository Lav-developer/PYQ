/**
 * DSMNRU PYQ Android — upload feature core (pure, DOM-free, unit-tested).
 *
 * A faithful port of the website's public upload workflow rules
 * (script.js → userUploadForm) so the in-app Upload Paper screen behaves
 * EXACTLY like the website against the SAME backends:
 *
 *   1. Same field validation (title/name/email + file-type rules).
 *   2. Same reward identity: email = trim + lowercase (points.js parity).
 *   3. Same client-side throttle (45 s gap, 5 uploads per 6 h window,
 *      `dsmnruUploadThrottle` localStorage key — the site's own guard).
 *   4. Same metadata document written to the SAME `pendingUploads`
 *      collection (Firestore rules validate the shape server-side).
 *
 * The image→PDF conversion avoids the website's jsPDF CDN dependency with a
 * minimal PDF 1.4 writer that embeds already-encoded JPEGs (/DCTDecode) on
 * A4 pages — zero third-party code, byte-accurate xref offsets.
 */

export const MAX_FINAL_PDF_SIZE = 10 * 1024 * 1024; // 10 MB, like the website
export const GOFILE_SERVERS_URL = 'https://api.gofile.io/servers';

// ── reward identity (points.js parity) ─────────────────────────────────

export function normalizeRewardEmail(raw) {
  if (raw === null || raw === undefined) return '';
  return String(raw).trim().toLowerCase();
}

export function isValidRewardEmail(raw) {
  const email = normalizeRewardEmail(raw);
  if (!email || email.length > 160) return false;
  return /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(email);
}

// ── file classification ────────────────────────────────────────────────

export function isPdfFile(file) {
  const type = String(file && file.type || '').toLowerCase();
  const name = String(file && file.name || '').toLowerCase();
  return type === 'application/pdf' || /\.pdf$/.test(name);
}

export function isImageFile(file) {
  const type = String(file && file.type || '').toLowerCase();
  const name = String(file && file.name || '').toLowerCase();
  return type.startsWith('image/') || /\.(jpe?g|png|webp|gif|bmp)$/.test(name);
}

/**
 * Split a FileList into { pdfs, images, unsupported } — the same buckets the
 * website validates before anything is uploaded.
 */
export function classifyFiles(files) {
  const list = Array.from(files || []);
  return {
    pdfs: list.filter(isPdfFile),
    images: list.filter((f) => isImageFile(f) && !isPdfFile(f)),
    unsupported: list.filter((f) => !isPdfFile(f) && !isImageFile(f)),
  };
}

// ── validation (mirrors the website's alerts) ──────────────────────────

/**
 * Validate one upload attempt BEFORE any network traffic.
 * @returns { ok: true, email } or { ok: false, message }
 */
export function validateUploadAttempt({ title, studentName, rawEmail, files, throttleState }) {
  const name = String(studentName || '').trim();
  const rewardEmail = normalizeRewardEmail(rawEmail);

  if (!name) return { ok: false, message: 'Please enter your name.' };
  if (name.length < 2 || name.length > 80) {
    return { ok: false, message: 'Name must be between 2 and 80 characters.' };
  }
  const cleanTitle = String(title || '').trim();
  if (cleanTitle.length < 3 || cleanTitle.length > 200) {
    return { ok: false, message: 'Title must be between 3 and 200 characters.' };
  }
  if (!rewardEmail) {
    return { ok: false, message: 'Please enter your email — it is used to credit your contribution points.' };
  }
  if (!isValidRewardEmail(rewardEmail)) {
    return { ok: false, message: 'Please enter a valid email address.' };
  }

  const { pdfs, images, unsupported } = classifyFiles(files);
  if (!files.length) {
    return { ok: false, message: 'Please select a PDF or images.' };
  }
  if (unsupported.length) {
    return { ok: false, message: 'Only PDF or image files are allowed.' };
  }
  if (!pdfs.length && !images.length) {
    return { ok: false, message: 'Please select one PDF or one or more images.' };
  }
  if (pdfs.length > 1) {
    return { ok: false, message: 'Please select only one PDF file.' };
  }
  if (pdfs.length === 1 && images.length > 0) {
    return { ok: false, message: 'Please upload either one PDF or multiple images, not both together.' };
  }
  if (pdfs.length === 1 && pdfs[0].size > MAX_FINAL_PDF_SIZE) {
    return { ok: false, message: 'PDF size exceeds 10MB. Please upload a smaller PDF.' };
  }

  if (throttleState && !throttleState.allowed) {
    return { ok: false, message: throttleState.message };
  }
  return { ok: true, email: rewardEmail };
}

// ── client-side throttle (same constants + key as the website) ─────────

export const UPLOAD_THROTTLE_KEY = 'dsmnruUploadThrottle';
export const UPLOAD_THROTTLE_MIN_GAP_MS = 45 * 1000;
export const UPLOAD_THROTTLE_WINDOW_MS = 6 * 60 * 60 * 1000;
export const UPLOAD_THROTTLE_MAX_PER_WINDOW = 5;

/** Read+prune the throttle log. `storage` is localStorage-compatible or null. */
export function readThrottleLog(storage, nowMs) {
  if (!storage) return [];
  let raw = null;
  try { raw = storage.getItem(UPLOAD_THROTTLE_KEY); } catch { return []; }
  let parsed = [];
  try { parsed = raw ? JSON.parse(raw) : []; } catch { parsed = []; }
  if (!Array.isArray(parsed)) parsed = [];
  return parsed
    .map((n) => Number(n))
    .filter((n) => Number.isFinite(n) && nowMs - n < UPLOAD_THROTTLE_WINDOW_MS)
    .sort((a, b) => a - b);
}

export function getUploadThrottleState(storage, nowMs) {
  const log = readThrottleLog(storage, nowMs);
  if (log.length >= UPLOAD_THROTTLE_MAX_PER_WINDOW) {
    const waitMinutes = Math.max(1, Math.ceil((UPLOAD_THROTTLE_WINDOW_MS - (nowMs - log[0])) / 60000));
    return {
      allowed: false,
      log,
      message: `Upload limit reached (${UPLOAD_THROTTLE_MAX_PER_WINDOW} per 6 hours). Try again in about ${waitMinutes} minute${waitMinutes === 1 ? '' : 's'}.`,
    };
  }
  if (log.length && nowMs - log[log.length - 1] < UPLOAD_THROTTLE_MIN_GAP_MS) {
    const waitSec = Math.ceil((UPLOAD_THROTTLE_MIN_GAP_MS - (nowMs - log[log.length - 1])) / 1000);
    return {
      allowed: false,
      log,
      message: `Please wait ${waitSec}s between uploads.`,
    };
  }
  return { allowed: true, log };
}

/** Persist one successful upload into the throttle log (website parity). */
export function recordUploadThrottle(storage, nowMs) {
  if (!storage) return;
  const log = readThrottleLog(storage, nowMs);
  log.push(nowMs);
  try {
    storage.setItem(UPLOAD_THROTTLE_KEY, JSON.stringify(log.slice(-UPLOAD_THROTTLE_MAX_PER_WINDOW)));
  } catch { /* quota — throttle degrades quietly, server rules stay authoritative */ }
}

// ── gofile upload (same service the website uses) ──────────────────────

/** Pick the first gofile upload server. Resolves to an https upload URL. */
export async function fetchGofileUploadUrl(fetchImpl = (...a) => fetch(...a)) {
  const res = await fetchImpl(GOFILE_SERVERS_URL);
  if (!res.ok) throw new Error('Failed to get upload server');
  const data = await res.json().catch(() => null);
  const servers = data && data.status === 'ok' && data.data && Array.isArray(data.data.servers)
    ? data.data.servers
    : (data && data.data && data.data.servers);
  if (!Array.isArray(servers) || !servers.length || !servers[0] || !servers[0].name) {
    throw new Error('No upload servers available');
  }
  return `https://${servers[0].name}.gofile.io/uploadFile`;
}

// ── pendingUploads metadata document (Firestore REST shape) ────────────

/**
 * Build the exact `pendingUploads` document the website writes, in Firestore
 * REST `fields` form. Review state / points fields are intentionally absent —
 * the Firestore rules reject any submission that carries them.
 */
export function buildPendingUploadDoc({ title, course = '', semester = '', studentName, studentCourse = '', studentEmail, userId = '', fileName, downloadUrl, fileSize = 0, createdAtIso }) {
  const s = (v) => ({ stringValue: String(v ?? '') });
  return {
    fields: {
      title: s(title),
      course: s(course),
      semester: s(semester),
      studentName: s(studentName),
      studentCourse: s(studentCourse),
      // Normalized reward identity — admin approval credits +10 points here.
      studentEmail: s(studentEmail),
      email: s(studentEmail),
      userId: s(userId),
      fileName: s(fileName),
      downloadUrl: s(downloadUrl),
      fileSize: { integerValue: String(Math.max(0, Math.round(Number(fileSize) || 0))) },
      uploadedAt: { timestampValue: createdAtIso || new Date().toISOString() },
      status: { stringValue: 'pending' },
    },
  };
}

/** Firestore REST insert URL (auto document id, like collection.add). */
export function pendingUploadsUrl(projectId = 'dsmnru-data') {
  return `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/pendingUploads`;
}

// ── minimal PDF writer for image submissions (DCTDecode embedding) ─────

const A4 = { width: 595.28, height: 841.89 };
const PAGE_MARGIN = 20;

/**
 * Read pixel dimensions from a JPEG byte stream (SOF0/SOF1/SOF2/SOF9-15).
 * @returns { width, height } or null when the stream is not a JPEG.
 */
export function jpegDimensions(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  if (u8.length < 4 || u8[0] !== 0xFF || u8[1] !== 0xD8) return null;
  let i = 2;
  while (i + 9 < u8.length) {
    if (u8[i] !== 0xFF) { i++; continue; }
    const marker = u8[i + 1];
    if (marker === 0xD8 || (marker >= 0xD0 && marker <= 0xD9)) { i += 2; continue; }
    const len = (u8[i + 2] << 8) | u8[i + 3];
    const isSof = (marker >= 0xC0 && marker <= 0xC3) || (marker >= 0xC5 && marker <= 0xC7)
      || (marker >= 0xC9 && marker <= 0xCB) || (marker >= 0xCD && marker <= 0xCF);
    if (isSof) {
      return {
        height: (u8[i + 5] << 8) | u8[i + 6],
        width: (u8[i + 7] << 8) | u8[i + 8],
      };
    }
    i += 2 + len;
  }
  return null;
}

class ByteWriter {
  constructor() { this.chunks = []; this.length = 0; }
  push(chunk) {
    const u8 = typeof chunk === 'string'
      ? new TextEncoder().encode(chunk)
      : (chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk));
    this.chunks.push(u8);
    this.length += u8.length;
  }
  /** 10-digit zero-padded xref offset */
  offset10() { return String(this.length).padStart(10, '0'); }
  concat() {
    const out = new Uint8Array(this.length);
    let at = 0;
    for (const c of this.chunks) { out.set(c, at); at += c.length; }
    return out;
  }
}

/**
 * Assemble a single-page-per-image PDF from JPEG streams.
 * @param {Array<{jpeg: Uint8Array, width: number, height: number}>} pages
 * @returns {Uint8Array} the complete PDF file bytes
 */
export function assemblePdfFromJpegs(pages) {
  if (!Array.isArray(pages) || !pages.length) throw new Error('No pages to assemble');
  const w = new ByteWriter();
  const objectOffsets = []; // object number → byte offset
  const n = pages.length;

  // Header + binary comment line (high bytes so tools sniff the file as binary).
  w.push(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2D, 0x31, 0x2E, 0x34, 0x0A, 0x25, 0xE2, 0xE3, 0xCF, 0xD3, 0x0A]));

  const writeObj = (num, body) => {
    objectOffsets[num] = w.offset10();
    w.push(`${num} 0 obj\n${body}\nendobj\n`);
  };

  writeObj(1, '<< /Type /Catalog /Pages 2 0 R >>');

  const kids = pages.map((_, i) => `${3 + i * 3} 0 R`).join(' ');
  writeObj(2, `<< /Type /Pages /Kids [${kids}] /Count ${n} >>`);

  pages.forEach((p, i) => {
    const pageObj = 3 + i * 3;
    const contentObj = pageObj + 1;
    const imageObj = pageObj + 2;

    // Fit the image inside the content box, centered (website parity).
    const boxW = A4.width - PAGE_MARGIN * 2;
    const boxH = A4.height - PAGE_MARGIN * 2;
    const fit = Math.min(boxW / p.width, boxH / p.height);
    const drawW = p.width * fit;
    const drawH = p.height * fit;
    const x = (A4.width - drawW) / 2;
    const y = (A4.height - drawH) / 2;
    const content = `q\n${drawW.toFixed(2)} 0 0 ${drawH.toFixed(2)} ${x.toFixed(2)} ${y.toFixed(2)} cm\n/Im${i} Do\nQ\n`;

    writeObj(pageObj, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${A4.width.toFixed(2)} ${A4.height.toFixed(2)}] `
      + `/Resources << /XObject << /Im${i} ${imageObj} 0 R >> >> /Contents ${contentObj} 0 R >>`);

    objectOffsets[contentObj] = w.offset10();
    w.push(`${contentObj} 0 obj\n<< /Length ${content.length} >>\nstream\n${content}endstream\nendobj\n`);

    objectOffsets[imageObj] = w.offset10();
    w.push(`${imageObj} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${p.width} /Height ${p.height} `
      + `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${p.jpeg.length} >>\nstream\n`);
    w.push(p.jpeg);
    w.push('\nendstream\nendobj\n');
  });

  const xrefStart = w.offset10();
  const size = 3 + n * 3;
  let xref = `xref\n0 ${size}\n0000000000 65535 f \n`;
  for (let num = 1; num < size; num++) {
    xref += `${objectOffsets[num] || '0000000000'} 00000 n \n`;
  }
  xref += `trailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
  w.push(xref);
  return w.concat();
}

/**
 * Quality ladder used when re-encoding photos to fit the 10 MB cap —
 * same idea as the website's attempts list.
 */
export const IMAGE_ENCODE_ATTEMPTS = [
  { maxDimension: 2000, quality: 0.9 },
  { maxDimension: 1700, quality: 0.82 },
  { maxDimension: 1500, quality: 0.76 },
  { maxDimension: 1300, quality: 0.7 },
  { maxDimension: 1100, quality: 0.64 },
  { maxDimension: 900, quality: 0.58 },
];
