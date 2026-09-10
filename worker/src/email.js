/**
 * Resend email service for DSMNRU PYQ — trusted server-side only.
 *
 * Sends the three transactional notifications from the verified Resend
 * domain (dsmnrupyq.lovie.me):
 *   1. Student receipt       — a submission landed in the review queue.
 *   2. Admin alert           — a new submission needs review (ADMIN_EMAIL).
 *   3. Student approve/reject— the review outcome (+10 points on approval).
 *
 * Security & reliability contract:
 *  - The API key lives ONLY in the Worker secret `RESEND_API_KEY`. It is read
 *    from the environment bindings at call time, is never returned by an API,
 *    never logged, and never sent to the browser. All sends happen here,
 *    server-side.
 *  - Every dynamic value (title, name, course, semester, reason, …) is
 *    normalized (control characters stripped) and HTML-escaped before it
 *    touches an email template. Recipient addresses must pass a shape check.
 *  - `sendEmail` NEVER throws: it resolves to a small result object so an
 *    email failure can never break the submission/approval/rejection that
 *    triggered it. Callers log the outcome; the Worker responds with safe,
 *    generic errors only.
 *  - Upstream error bodies are logged only in truncated, key-redacted form
 *    for the operator; the client never sees Resend internals.
 *
 * This module has no cache and no state; every send is a real Resend request.
 */

// ── Verified sending identity (Resend domain: dsmnrupyq.lovie.me) ──────
export const EMAIL_SENDER = 'DSMNRU PYQ <noreply@dsmnrupyq.lovie.me>';
export const EMAIL_REPLY_TO = 'contact@dsmnrupyq.lovie.me';

const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const PUBLIC_SITE_ORIGIN = 'https://dsmnru-pyq.netlify.app';

/** Validation limits — over-limit inputs are rejected, never truncated. */
export const EMAIL_FIELD_LIMITS = {
  emailMax: 160,        // same ceiling as the reward identity in points.js
  studentNameMax: 80,
  titleMax: 200,
  courseMax: 100,
  semesterMax: 40,
  submissionIdMax: 100,
  reasonMax: 300,       // matches admin.js → rejectSubmission slice(0, 300)
  pointsBalanceMax: 10000000,
};

// ── Small shared helpers ───────────────────────────────────────────────

/** Read a Worker binding from the isolate globals (same pattern as fcm.js). */
function envBinding(name) {
  try {
    if (typeof globalThis !== 'undefined' && globalThis[name]) {
      return String(globalThis[name]).trim();
    }
  } catch (_) { /* ignore */ }
  return '';
}

function resendApiKey() {
  return envBinding('RESEND_API_KEY');
}

/** True when the Worker has the minimum bindings needed to send email. */
export function isEmailConfigured() {
  return resendApiKey().length > 0;
}

/** Shape check — identical rule to points.js `isValidRewardEmail`. */
export function isValidEmailAddress(value) {
  const email = String(value || '').trim();
  if (!email || email.length > EMAIL_FIELD_LIMITS.emailMax) return false;
  return /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(email);
}

/** Mask a recipient for SAFE logging: never a full personal address. */
export function maskEmail(value) {
  const email = String(value || '').trim();
  const at = email.indexOf('@');
  if (at <= 0) return '[invalid]';
  const local = email.slice(0, at);
  return `${local.slice(0, 1)}***${email.slice(at)}`;
}

/**
 * Strip control characters and trim — mirrors fcm.js normalizeText. Angle
 * brackets are preserved here and neutralized by escapeEmailHtml at render
 * time, so the student sees exactly what they typed.
 */
export function normalizeTextField(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim();
}

/** Escape a dynamic value before inserting it into email HTML. */
export function escapeEmailHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => {
    const entities = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    return entities[char] || char;
  });
}

/** Truncated, API-key-redacted upstream detail for the operator log only. */
function safeUpstreamDetail(text) {
  let detail = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  const key = resendApiKey();
  if (key && detail.includes(key)) detail = detail.split(key).join('[redacted]');
  return detail;
}

// ── Resend sender ──────────────────────────────────────────────────────

/**
 * Send ONE email through the Resend HTTP API.
 * Resolves to `{ ok: true, id }` or `{ ok: false, reason, status? }`.
 * Never throws; never logs or returns the API key.
 */
export async function sendEmail({ to, subject, html, text }) {
  if (!isEmailConfigured()) {
    return { ok: false, reason: 'not_configured' };
  }
  if (!isValidEmailAddress(to)) {
    return { ok: false, reason: 'invalid_email' };
  }

  const payload = {
    from: EMAIL_SENDER,
    to: [String(to).trim()],
    subject: String(subject || ''),
    html: String(html || ''),
    reply_to: EMAIL_REPLY_TO,
  };
  if (text) payload.text = String(text);

  try {
    const response = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${resendApiKey()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      // Operator log only: status + truncated upstream message, never the
      // Authorization header and never the full recipient address.
      console.error(
        `Resend send failed: HTTP ${response.status} to ${maskEmail(to)} — ${safeUpstreamDetail(await response.text().catch(() => ''))}`
      );
      return { ok: false, reason: 'http', status: response.status };
    }

    const data = await response.json().catch(() => ({}));
    return { ok: true, id: (data && data.id) || null };
  } catch (error) {
    console.error('Resend send failed (network):', error && error.message ? error.message : error);
    return { ok: false, reason: 'network' };
  }
}

// ── Payload validation (strict types, hard caps, reject-not-truncate) ──

function validatedField(raw, max, label, { required = false } = {}) {
  const value = normalizeTextField(raw);
  if (required && !value) {
    return { ok: false, error: `${label} is required.` };
  }
  if (value.length > max) {
    return { ok: false, error: `${label} must be ${max} characters or fewer.` };
  }
  return { ok: true, value };
}

function validatedEmail(raw, label) {
  const value = normalizeTextField(raw);
  if (!isValidEmailAddress(value)) {
    return { ok: false, error: `${label} must be a valid email address.` };
  }
  return { ok: true, value };
}

/**
 * Validate the public "submission received" payload:
 * `{ to, title, studentName?, course?, semester?, submissionId? }`
 */
export function validateSubmissionReceivedPayload(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'Request body must be a JSON object.' };
  }

  const to = validatedEmail(body.to, 'Recipient email');
  if (!to.ok) return to;

  const title = validatedField(body.title, EMAIL_FIELD_LIMITS.titleMax, 'Paper title', { required: true });
  if (!title.ok) return title;

  const studentName = validatedField(body.studentName, EMAIL_FIELD_LIMITS.studentNameMax, 'Student name');
  if (!studentName.ok) return studentName;

  const course = validatedField(body.course, EMAIL_FIELD_LIMITS.courseMax, 'Course');
  if (!course.ok) return course;

  const semester = validatedField(body.semester, EMAIL_FIELD_LIMITS.semesterMax, 'Semester');
  if (!semester.ok) return semester;

  const submissionId = validatedField(body.submissionId, EMAIL_FIELD_LIMITS.submissionIdMax, 'Submission ID');
  if (!submissionId.ok) return submissionId;

  return {
    ok: true,
    value: {
      to: to.value,
      title: title.value,
      studentName: studentName.value,
      course: course.value,
      semester: semester.value,
      submissionId: submissionId.value,
    },
  };
}

/**
 * Validate an admin-triggered review-outcome payload (approved / rejected):
 * `{ to, title, studentName?, course?, semester?, submissionId?,
 *    reason? (rejected only), pointsBalance? (approved only) }`
 */
export function validateReviewEmailPayload(body, kind) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'Request body must be a JSON object.' };
  }

  const to = validatedEmail(body.to, 'Recipient email');
  if (!to.ok) return to;

  const title = validatedField(body.title, EMAIL_FIELD_LIMITS.titleMax, 'Paper title', { required: true });
  if (!title.ok) return title;

  const studentName = validatedField(body.studentName, EMAIL_FIELD_LIMITS.studentNameMax, 'Student name');
  if (!studentName.ok) return studentName;

  const course = validatedField(body.course, EMAIL_FIELD_LIMITS.courseMax, 'Course');
  if (!course.ok) return course;

  const semester = validatedField(body.semester, EMAIL_FIELD_LIMITS.semesterMax, 'Semester');
  if (!semester.ok) return semester;

  const submissionId = validatedField(body.submissionId, EMAIL_FIELD_LIMITS.submissionIdMax, 'Submission ID');
  if (!submissionId.ok) return submissionId;

  let reason = '';
  if (kind === 'rejected') {
    const parsedReason = validatedField(body.reason, EMAIL_FIELD_LIMITS.reasonMax, 'Rejection reason');
    if (!parsedReason.ok) return parsedReason;
    reason = parsedReason.value;
  }

  // Display-only value reported by the existing approval transaction.
  let pointsBalance = null;
  if (kind === 'approved' && body.pointsBalance !== undefined && body.pointsBalance !== null) {
    const parsed = Number(body.pointsBalance);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > EMAIL_FIELD_LIMITS.pointsBalanceMax) {
      return { ok: false, error: 'pointsBalance must be a number between 0 and 10000000.' };
    }
    pointsBalance = Math.floor(parsed);
  }

  return {
    ok: true,
    value: {
      to: to.value,
      title: title.value,
      studentName: studentName.value,
      course: course.value,
      semester: semester.value,
      submissionId: submissionId.value,
      ...(kind === 'rejected' ? { reason } : {}),
      ...(kind === 'approved' ? { pointsBalance } : {}),
    },
  };
}

// ── Responsive HTML shell (table-based, inline CSS, mobile-friendly) ───

const BRAND_TEAL_DARK = '#14636e';  // headings / accents (site teal, darkened for contrast)
const BRAND_TEAL = '#1d7480';       // site --color-teal-600
const BRAND_MUTED = '#5b6670';      // secondary text
const BRAND_BORDER = '#e4e9ee';

function brandHeader() {
  return `
        <tr>
          <td style="padding:28px 32px 0 32px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif; font-size:17px; font-weight:700; color:${BRAND_TEAL_DARK};">
                  🎓 DSMNRU PYQ Archive
                </td>
              </tr>
            </table>
          </td>
        </tr>`;
}

function brandFooter() {
  return `
        <tr>
          <td style="padding:0 32px 28px 32px;">
            <div style="border-top:1px solid ${BRAND_BORDER}; padding-top:16px; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif; font-size:12px; line-height:18px; color:${BRAND_MUTED};">
              Need help? Just reply to this email — it reaches the DSMNRU PYQ team.<br>
              You received this email because a PYQ submission or review action was made with this address on
              <a href="${PUBLIC_SITE_ORIGIN}" style="color:${BRAND_TEAL}; text-decoration:none;">dsmnru-pyq.netlify.app</a>.
            </div>
          </td>
        </tr>`;
}

/**
 * Shared responsive email shell: 600px fluid table layout, inline styles
 * only (email clients strip <style> blocks), no marketing language.
 */
function renderEmailShell({ heading, headingColor = BRAND_TEAL_DARK, bodyHtml }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light">
</head>
<body style="margin:0; padding:0; background-color:#f4f6f9;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f4f6f9;">
    <tr>
      <td align="center" style="padding:24px 12px;">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px; width:100%; background-color:#ffffff; border-radius:14px; border:1px solid ${BRAND_BORDER}; overflow:hidden;">
${brandHeader()}
          <tr>
            <td style="padding:20px 32px 0 32px;">
              <h1 style="margin:0; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif; font-size:21px; line-height:28px; font-weight:700; color:${headingColor};">${heading}</h1>
            </td>
          </tr>
          <tr>
            <td style="padding:12px 32px 8px 32px; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif; font-size:14px; line-height:22px; color:#24292f;">
              ${bodyHtml}
            </td>
          </tr>
${brandFooter()}
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

/** Label/value rows for submission details. */
function renderDetailRows(rows) {
  const cells = rows
    .filter((row) => row && row.value)
    .map((row) => `
              <tr>
                <td style="padding:7px 14px; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif; font-size:13px; color:${BRAND_MUTED}; white-space:nowrap; vertical-align:top;">${row.label}</td>
                <td style="padding:7px 14px; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif; font-size:13px; color:#24292f; font-weight:600; word-break:break-word;">${row.value}</td>
              </tr>`)
    .join('');
  return `
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f8fafb; border:1px solid ${BRAND_BORDER}; border-radius:10px; margin:12px 0 4px 0;">${cells}
              </table>`;
}

function paragraph(text) {
  return `<p style="margin:0 0 12px 0;">${text}</p>`;
}

// ── Email templates (each returns { subject, html, text }) ────────────

/**
 * 1. Student receipt — sent right after a submission lands in pendingUploads.
 *    Deliberately says PENDING; never claims approval.
 */
export function submissionReceivedEmailTemplate(data) {
  const subject = 'PYQ Submission Received — DSMNRU PYQ';
  const firstName = (data.studentName || '').split(/\s+/)[0] || 'there';
  const name = escapeEmailHtml(firstName);
  const title = escapeEmailHtml(data.title);

  const bodyHtml = `
                ${paragraph(`Hi ${name},`)}
                ${paragraph(`Your PYQ submission <strong>“${title}”</strong> was <strong>successfully received</strong>.`)}
                ${paragraph('It is currently <strong>pending admin verification</strong>. Our team reviews every submission before it is added to the archive.')}
                ${renderDetailRows([
                  { label: 'Paper title', value: `<strong>${title}</strong>` },
                  { label: 'Course', value: escapeEmailHtml(data.course) },
                  { label: 'Semester', value: escapeEmailHtml(data.semester) },
                ])}
                ${paragraph(`You will receive another email as soon as your submission is <strong>approved or rejected</strong>. If it is approved, <strong>+10 contribution points</strong> are credited to this email address automatically.`)}
                ${paragraph('Thank you for helping the DSMNRU student community grow its collection of previous year papers! 🙌')}`;

  const text = [
    `Hi ${firstName},`,
    '',
    `Your PYQ submission "${data.title}" was successfully received.`,
    'It is currently pending admin verification.',
    data.course ? `Course: ${data.course}` : '',
    data.semester ? `Semester: ${data.semester}` : '',
    "You will receive another email when it is approved or rejected. Approval credits +10 contribution points to this email address.",
    '',
    '— DSMNRU PYQ Archive',
  ].filter((line) => line !== '').join('\n');

  return { subject, html: renderEmailShell({ heading: 'We received your PYQ submission ✅', bodyHtml }), text };
}

/**
 * 2. Admin alert — sent to ADMIN_EMAIL alongside the student receipt.
 */
export function submissionAdminAlertEmailTemplate(data) {
  const subject = 'New PYQ Submission — Review Required';
  const title = escapeEmailHtml(data.title);

  const bodyHtml = `
                ${paragraph('A new PYQ submission was received and is <strong>waiting for admin review</strong>.')}
                ${renderDetailRows([
                  { label: 'Paper title', value: `<strong>${title}</strong>` },
                  { label: 'Student name', value: escapeEmailHtml(data.studentName) },
                  { label: 'Student email', value: escapeEmailHtml(data.to) },
                  { label: 'Course', value: escapeEmailHtml(data.course) },
                  { label: 'Semester', value: escapeEmailHtml(data.semester) },
                  { label: 'Submission ID', value: escapeEmailHtml(data.submissionId) },
                ])}
                ${paragraph('<strong>Action required:</strong> open the Review Queue in the admin panel to approve (+10 points) or reject the submission.')}
                <p style="margin:0 0 12px 0;"><a href="${PUBLIC_SITE_ORIGIN}/admin.html" style="color:${BRAND_TEAL}; font-weight:600; text-decoration:none;">Open the admin Review Queue →</a></p>`;

  const text = [
    'New PYQ submission — review required.',
    '',
    `Paper title: ${data.title}`,
    data.studentName ? `Student name: ${data.studentName}` : '',
    `Student email: ${data.to}`,
    data.course ? `Course: ${data.course}` : '',
    data.semester ? `Semester: ${data.semester}` : '',
    data.submissionId ? `Submission ID: ${data.submissionId}` : '',
    '',
    `Review it in the admin panel: ${PUBLIC_SITE_ORIGIN}/admin.html`,
  ].filter((line) => line !== '').join('\n');

  return { subject, html: renderEmailShell({ heading: 'New PYQ submission needs review', bodyHtml }), text };
}

/**
 * 3. Approval — sent ONLY after the existing approval transaction awarded
 *    +10 points (awarded === true), so retries cannot duplicate it.
 */
export function submissionApprovedEmailTemplate(data) {
  const subject = 'PYQ Approved — You Earned 10 Points 🎉';
  const firstName = (data.studentName || '').split(/\s+/)[0] || 'there';
  const name = escapeEmailHtml(firstName);
  const title = escapeEmailHtml(data.title);

  const bodyHtml = `
                ${paragraph(`Hi ${name},`)}
                ${paragraph(`Great news! Your PYQ submission <strong>“${title}”</strong> has been <strong>approved</strong> and added to the DSMNRU archive. 🎉`)}
                ${renderDetailRows([
                  { label: 'Points earned', value: `<strong style="color:${BRAND_TEAL_DARK};">+10 points</strong>` },
                  { label: 'Paper title', value: title },
                  ...(data.pointsBalance !== null && data.pointsBalance !== undefined
                    ? [{ label: 'New balance', value: `${escapeEmailHtml(String(data.pointsBalance))} points` }]
                    : []),
                ])}
                ${paragraph('Thank you for contributing to the DSMNRU archive and helping fellow students find previous year papers! 🙌')}`;

  const text = [
    `Hi ${firstName},`,
    '',
    `Great news! Your PYQ submission "${data.title}" has been approved and added to the DSMNRU archive.`,
    'Points earned: +10',
    data.pointsBalance !== null && data.pointsBalance !== undefined ? `New balance: ${data.pointsBalance} points` : '',
    '',
    'Thank you for contributing to the DSMNRU archive!',
    '— DSMNRU PYQ Archive',
  ].filter((line) => line !== '').join('\n');

  return { subject, html: renderEmailShell({ heading: 'Your PYQ was approved — +10 points 🎉', bodyHtml }), text };
}

/**
 * 4. Rejection — sent after the rejection update succeeds. The reason is
 *    included only when one was actually provided (never invented).
 */
export function submissionRejectedEmailTemplate(data) {
  const subject = 'PYQ Submission Update — DSMNRU PYQ';
  const firstName = (data.studentName || '').split(/\s+/)[0] || 'there';
  const name = escapeEmailHtml(firstName);
  const title = escapeEmailHtml(data.title);
  const reasonHtml = data.reason
    ? renderDetailRows([{ label: 'Reason', value: escapeEmailHtml(data.reason) }])
    : '';

  const bodyHtml = `
                ${paragraph(`Hi ${name},`)}
                ${paragraph(`After review, your PYQ submission <strong>“${title}”</strong> was <strong>not approved</strong> for the archive at this time.`)}
                ${reasonHtml}
                ${paragraph('If the paper was unclear, incomplete, or a duplicate, you are welcome to correct it and submit it again — contributions that pass review earn <strong>+10 points</strong>.')}
                ${paragraph('If you believe this was a mistake, simply reply to this email and we will take another look.')}`;

  const text = [
    `Hi ${firstName},`,
    '',
    `After review, your PYQ submission "${data.title}" was not approved for the archive at this time.`,
    data.reason ? `Reason: ${data.reason}` : '',
    'If the paper was unclear, incomplete, or a duplicate, you are welcome to correct it and submit it again — approved contributions earn +10 points.',
    'If you believe this was a mistake, simply reply to this email.',
    '',
    '— DSMNRU PYQ Archive',
  ].filter((line) => line !== '').join('\n');

  return { subject, html: renderEmailShell({ heading: 'Update on your PYQ submission', bodyHtml }), text };
}

// ── Flow-level senders (template + sendEmail composition) ─────────────

function adminRecipientEmail() {
  const adminEmail = envBinding('ADMIN_EMAIL');
  return adminEmail && isValidEmailAddress(adminEmail) ? adminEmail : '';
}

/**
 * Submission received → student receipt + admin alert.
 * Returns `{ configured, student, admin }`; individual results are
 * `{ ok, reason?, status?, id? }`. Never throws.
 */
export async function sendSubmissionReceivedEmails(data) {
  const studentTemplate = submissionReceivedEmailTemplate(data);
  const student = await sendEmail({ to: data.to, ...studentTemplate });
  if (!student.ok) {
    console.warn(`Student receipt email not sent (reason=${student.reason}${student.status ? ' status=' + student.status : ''}, to=${maskEmail(data.to)})`);
  }

  const adminEmail = adminRecipientEmail();
  let admin = { ok: false, reason: adminEmail ? 'send_failed' : 'not_configured' };
  if (adminEmail) {
    const adminTemplate = submissionAdminAlertEmailTemplate(data);
    admin = await sendEmail({ to: adminEmail, ...adminTemplate });
    if (!admin.ok) {
      console.warn(`Admin alert email not sent (reason=${admin.reason}${admin.status ? ' status=' + admin.status : ''})`);
    }
  } else {
    console.warn('Admin alert email skipped: ADMIN_EMAIL is not configured');
  }

  return { configured: isEmailConfigured(), student, admin };
}

/** Approval outcome → student email. Returns `{ configured, result }`. */
export async function sendApprovedEmail(data) {
  const template = submissionApprovedEmailTemplate(data);
  const result = await sendEmail({ to: data.to, ...template });
  if (!result.ok) {
    console.warn(`Approval email not sent (reason=${result.reason}${result.status ? ' status=' + result.status : ''}, to=${maskEmail(data.to)})`);
  }
  return { configured: isEmailConfigured(), result };
}

/** Rejection outcome → student email. Returns `{ configured, result }`. */
export async function sendRejectedEmail(data) {
  const template = submissionRejectedEmailTemplate(data);
  const result = await sendEmail({ to: data.to, ...template });
  if (!result.ok) {
    console.warn(`Rejection email not sent (reason=${result.reason}${result.status ? ' status=' + result.status : ''}, to=${maskEmail(data.to)})`);
  }
  return { configured: isEmailConfigured(), result };
}
