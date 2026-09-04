/**
 * FCM v1 sender for DSMNRU PYQ — trusted server-side only.
 *
 * The Android app subscribes every opted-in install to ONE global FCM topic
 * (`all_users`) and renders notifications from the standard
 * `notification.title` / `notification.body` fields, using the optional
 * `data.path` value as the tap deep link. See
 * docs/android-notification-integration.md for the full contract.
 *
 * Security:
 *  - The Firebase service account lives in the Worker secret
 *    `FIREBASE_SERVICE_ACCOUNT_JSON` (same secret the Firestore client uses;
 *    its OAuth scope already includes cloud-platform, which covers FCM v1).
 *    It is NEVER exposed to the browser, committed, or returned by an API.
 *  - Credential/permission failures are logged server-side; callers only get
 *    safe, generic errors.
 *  - The message payload is validated and length-capped before sending.
 *  - This module has no cache; every send is a real FCM request.
 */

import { getAccessToken, clearTokenCache } from './auth.js';

const FCM_MESSAGING_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const FCM_ENDPOINT = 'https://fcm.googleapis.com/v1/projects';

/** The single topic the Android app subscribes to (FcmService.java). */
export const NOTIFICATION_TOPIC = 'all_users';

/** Android notification channel declared in the app manifest. */
const ANDROID_CHANNEL_ID = 'dsmnru_general';

/** Validation limits — mirror docs/PUSH_NOTIFICATIONS.md §5. */
export const NOTIFICATION_LIMITS = {
  titleMin: 1,
  titleMax: 120,
  bodyMin: 1,
  bodyMax: 300,
  pathMax: 500,
};

function normalizeText(value) {
  if (typeof value !== 'string') return '';
  // Strip control characters and markup angle brackets; preserve normal text.
  return String(value)
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[<>]/g, '')
    .trim();
}

/**
 * Validate + sanitize an admin notification payload.
 * Returns `{ ok: true, title, body, path }` or `{ ok: false, error }`.
 * Over-limit inputs are rejected (not silently truncated) so an admin sees
 * a clear validation error instead of a subtly altered message.
 */
export function validateNotificationPayload(body) {
  if (!body || typeof body !== 'object') {
    return { ok: false, error: 'Request body must be a JSON object.' };
  }

  const title = normalizeText(body.title);
  const message = normalizeText(body.body);

  if (title.length < NOTIFICATION_LIMITS.titleMin) {
    return { ok: false, error: 'Notification title is required.' };
  }
  if (title.length > NOTIFICATION_LIMITS.titleMax) {
    return { ok: false, error: `Notification title must be ${NOTIFICATION_LIMITS.titleMax} characters or fewer.` };
  }
  if (message.length < NOTIFICATION_LIMITS.bodyMin) {
    return { ok: false, error: 'Notification message is required.' };
  }
  if (message.length > NOTIFICATION_LIMITS.bodyMax) {
    return { ok: false, error: `Notification message must be ${NOTIFICATION_LIMITS.bodyMax} characters or fewer.` };
  }

  let path = '';
  if (body.path !== undefined && body.path !== null && body.path !== '') {
    if (typeof body.path !== 'string') {
      return { ok: false, error: 'Optional URL/path must be a string.' };
    }
    path = normalizeText(body.path);
    if (path.length > NOTIFICATION_LIMITS.pathMax) {
      return { ok: false, error: `Optional URL/path must be ${NOTIFICATION_LIMITS.pathMax} characters or fewer.` };
    }
    if (!path.startsWith('/')) {
      return { ok: false, error: 'Optional URL/path must start with "/" (e.g. /pyq/dbms-2023).' };
    }
    if (!/^\/[A-Za-z0-9\-._~%/?=&+#:]*$/.test(path)) {
      return { ok: false, error: 'Optional URL/path contains unsupported characters.' };
    }
  }

  return { ok: true, title, body: message, path };
}

function projectIdFromEnv() {
  if (typeof FIREBASE_PROJECT_ID !== 'undefined' && FIREBASE_PROJECT_ID) {
    return FIREBASE_PROJECT_ID;
  }
  try {
    const sa = JSON.parse(FIREBASE_SERVICE_ACCOUNT_JSON);
    if (sa.project_id) return sa.project_id;
  } catch (_) { /* fall through */ }
  throw new Error('FIREBASE_PROJECT_ID is not configured');
}

/**
 * Send a topic notification via FCM HTTP v1.
 * Uses the same service-account OAuth flow as the Firestore client
 * (auth.js) — cloud-platform scope covers FCM v1, so no new secret is
 * required. Throws a safe generic Error on failure; the detailed cause is
 * logged by the caller.
 */
export async function sendTopicNotification({ title, body, path }) {
  const projectId = projectIdFromEnv();
  const accessToken = await getAccessToken(FCM_MESSAGING_SCOPE);

  const message = {
    topic: NOTIFICATION_TOPIC,
    notification: { title, body },
    android: {
      priority: 'HIGH',
      notification: {
        channel_id: ANDROID_CHANNEL_ID,
        notification_count: 1,
      },
    },
  };

  // Optional deep link consumed by FcmService.deepLinkUri() →
  // MainActivity → in-app router. Omitted entirely when absent, so a plain
  // tap opens the app home.
  if (path) {
    message.data = { path };
  }

  const response = await fetch(`${FCM_ENDPOINT}/${projectId}/messages:send`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ message }),
  });

  if (response.status === 401) {
    clearTokenCache();
  }

  if (!response.ok) {
    // Do not surface the upstream body to callers — it can echo credential
    // or project internals. Log the details for the operator instead.
    console.error(
      `FCM send failed: HTTP ${response.status}`,
      (await response.text().catch(() => '')).slice(0, 500)
    );
    const error = new Error('The notification service rejected the request.');
    error.status = response.status;
    throw error;
  }

  const data = await response.json().catch(() => ({}));
  return {
    messageId: (data && (data.name || data.message_id)) || null,
  };
}
