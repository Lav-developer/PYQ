# Push notifications (FCM) — Android implementation & sender guide

The Android app has **full, final FCM support**: registration, token-rotation
handling, the `all_users` topic subscription, notification channels, the
Android 13+ runtime permission dialog, foreground rendering, background tray
display and tap handling with in-app paper deep links. This document is also
the **contract for the sender side** (admin panel → Worker → FCM), which is
the one piece that does **not** exist in this repository yet — see §5.

---

## 1. How the Android side works

```
Firebase (project dsmnru-data — the SAME project the app & website use)
   │  registers the install token with Google Play services
   ▼
FcmService.onNewToken()            ← fires a handful of times per device
   • stores the token in device-local SharedPreferences (diagnostics ONLY;
     nothing is written to Firestore — ever)
   • re-asserts membership of the ONE global topic  `all_users`
   ▼
Sender: POST to FCM v1  { topic: "all_users", ... }     (see §4/§5)
   │
   ├─ app in BACKGROUND → system tray shows the notification automatically
   │    (branded via the manifest meta-data: channel dsmnru_general,
   │     icon ic_stat_dsmnru, color #14B8A6); tray tap → launch intent
   ├─ app in FOREGROUND → FcmService.onMessageReceived() renders the
   │    notification itself on the same channel
   ▼
TAP (either path) → ACTION_VIEW intent with data
   https://dsmnru-pyq.netlify.app + data.path
   → MainActivity (cold: getLaunchUrl / warm: onNewIntent → 'siteDeepLink')
   → the app's JS router (slug.js#parseSiteUrl) opens the IN-APP paper
     screen. The website is never opened for app notifications.
```

### Quota / discipline guarantees

- **No polling, no timers, no listeners** — delivery is entirely FCM's job.
- **No token storage in Firestore** — the token stays on the device.
- **No per-launch synchronization** — the topic subscribe is *version-gated*
  (`TOPIC_VERSION`): one FCM call per install/update, and once more only when
  the FCM token itself rotates (`onNewToken`). Ordinary launches cost zero
  network.
- **No per-notification Firestore writes** — notifications are fire-and-forget.
- **No second Firebase project** — `dsmnru-data` only.

## 2. Android 13+ notification permission

`POST_NOTIFICATIONS` is declared in the manifest and requested through the
**real system dialog** (`ActivityCompat.requestPermissions`), once per
install, ~9 s into the first session (so the user has seen the app first) —
and only when the build actually has Firebase configured. Behavior:

| Situation | Behavior |
|---|---|
| Android < 13 | No runtime dialog exists; notifications work (toggle in system settings) |
| Already granted | Nothing is ever asked again |
| Denied | App continues 100 % normally; foreground/background pushes are silently suppressed (`notificationsGranted` is checked before every post) |
| Asked before | Never re-asked on later launches — the system decision is respected |

There is **no in-app fake toggle** and no website hand-off anywhere.

## 3. What a build needs (out-of-repo, one time)

1. `google-services.json` for **`com.dsmnru.pyq`** from Firebase console →
   Project settings → Your apps (project **dsmnru-data**) → place it at
   `android-app/android/app/google-services.json` (or inject it in CI). The
   Gradle file **already applies the Google Services plugin automatically**
   when the file exists — without it, every FCM code path degrades silently
   and the app runs normally (push simply never activates).
2. The Cloud Messaging API needs to be available for the project (Firebase
   console → Project settings → Cloud Messaging; Firebase auto-enables the
   v1 API). No server key is needed on the device side.

## 4. Message contract (what the sender must send)

FCM **HTTP v1** payload (the app honors exactly this):

```json
{
  "message": {
    "topic": "all_users",
    "notification": { "title": "New paper: DBMS {2023}", "body": "Just approved — open it in the app." },
    "data": {
      "path": "/pyq/dbms-2023"
    },
    "android": {
      "priority": "HIGH",
      "notification": { "channel_id": "dsmnru_general", "notification_count": 1 }
    }
  }
}
```

- `notification.title` / `body` — shown in tray and foreground.
- `data.path` — optional deep link: `/pyq/<slug>`, `/paper.html?id=<id>` or
  any in-app route path (`/` opens the app home). Omit it for a plain
  "open the app" tap.
- For **data-only** messages (silent), the app still renders a notification
  from `data.title` / `data.body` when foregrounded.

## 5. Sender-side work still required (documented, deliberately NOT invented)

The existing Worker (`worker/src/index.js`) has **no push endpoint** today —
its only admin-token-protected route is `POST /api/invalidate`. The existing
web admin panel stays the notification management interface; to complete the
chain, these are the exact steps (all server-side / website-side — **no**
second database, tokens or admin UI):

1. **Service account** (Google Cloud console → IAM → Service accounts →
   create in `dsmnru-data`, role *Firebase Cloud Messaging API Admin*) →
   store the JSON key as a Worker secret:
   `wrangler secret put FCM_SERVICE_ACCOUNT` (never commit it).
2. **Worker route** `POST /api/notify` (in `worker/src/index.js`):
   - guard it with the **existing** `verifyFirebaseAdminToken()` helper
     (same `admin:true` rule as `/api/invalidate`) so only the existing web
     admin panel can send;
   - body `{ title, body, path }` → validate (title ≤ 120, body ≤ 300,
     `path` must start with `/`);
   - sign a service-account JWT (RS256 via WebCrypto, scope
     `https://www.googleapis.com/auth/firebase.messaging`) → exchange at
     `https://oauth2.googleapis.com/token` →
     `POST https://fcm.googleapis.com/v1/projects/dsmnru-data/messages:send`
     with the §4 payload;
   - keep the route cache-free and rate-limited (e.g. one send per minute
     per admin token) to protect quotas.
3. **Admin panel** (website): a small "Send notification" form that calls
   the Worker route above. That is a website change and is intentionally
   left to the website maintainers.

## 6. Device test matrix (requires a real Android device / emulator with Play services)

Automated coverage lives in `android-app/test/fcm.test.mjs` (manifest,
Gradle, service wiring, permission policy, payload→deep-link contract —
everything verifiable without a device). The following must be verified
manually on a device, because FCM delivery and permission dialogs cannot run
in Node:

| # | Scenario | Expected |
|---|---|---|
| 1 | Fresh install, Android 13+, Firebase-enabled build | App runs; ~9 s in, the system notification dialog appears once |
| 2 | Tap **Allow** | Dialog closes; app works; topic subscribed (logcat: `FcmService`/`subscribeToTopic` success) |
| 3 | Tap **Deny** | Dialog closes; app fully usable; a test push does not surface but the app is normal |
| 4 | Relaunch after 2 or 3 | No dialog ever again |
| 5 | Android 12 device | No permission dialog; pushes work |
| 6 | Send §4 payload (background app) | Tray notification with teal accent + book icon |
| 7 | Send §4 payload (app open, foreground) | Same notification rendered by the app |
| 8 | Tap notification (app closed / cold) | App opens **directly on the paper screen** for `data.path` |
| 9 | Tap notification (app open, warm) | Router pushes the paper screen on the existing stack |
| 10 | Payload without `data.path` | App opens on home |
| 11 | Kill app, clear task, tap tray notification | Cold start still lands on the paper screen |
| 12 | `google-services.json` missing build | App identical minus push; no crashes; permission dialog never appears |

**Build note:** `google-services.json` cannot be committed (it is generated
per Firebase account; keep it in CI secrets). All non-device checks are
enforced by `npm test`.
