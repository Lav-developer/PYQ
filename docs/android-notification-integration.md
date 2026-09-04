# DSMNRU PYQ — Android ↔ Website integration

Developer guide (not user-facing) for how the **website (`main` branch)** and
the **Android app (`android-app` branch)** connect. No secrets are documented
or stored in this repository.

---

## 1. Branches & ownership

| Piece | Branch | Deployable |
|---|---|---|
| Website (Netlify), Cloudflare Worker, admin panel | `main` | dsmnru-pyq.netlify.app |
| Android app (Capacitor), FCM receiver, APK build | `android-app` | APK via GitHub Actions |

The branches are independent deployables and are **never merged**. The
`android-app` branch contains the website files as of its branch point plus
`android-app/**`; keep changes on the correct side:

- **Website changes** (download page, admin notifications UI, Worker API) → `main`.
- **Android changes** (app UI, FCM service, token behaviour, APK signing) → `android-app`.

## 2. Android facts (as of android-app @ `android-app`)

- Package / applicationId: **`com.dsmnru.pyq`**
- Version: **1.4.0**, versionCode **11** (`android-app/android/app/build.gradle`)
- Minimum Android: **API 24 — Android 7.0** (`android-app/android/variables.gradle`)
- FCM receiver: `android-app/android/app/src/main/java/com/dsmnru/pyq/FcmService.java`
- Firebase project: **`dsmnru-data`** (same project as the website)

## 3. Push notification architecture (no token database)

```
Android app (FcmService.onNewToken)          Website admin panel (main)
   │ subscribes to FCM topic "all_users"          │ compose title/body/path
   └── (token stays on the device,                 ▼
        never sent to a backend)        POST /api/notify  (Bearer Firebase ID token)
                                             ▼
                                  Cloudflare Worker verifies admin:true claim
                                             ▼
                                  FCM HTTP v1  →  topic: "all_users"
                                             ▼
                                  Android installs subscribed to all_users
```

**Key point:** the Android app does **NOT** register FCM tokens with any
backend, and it never has. It uses one global FCM topic. There is therefore
**no token registration endpoint, no Firestore token collection, and no token
replacement/expiry handling needed on the website side.** The 30-second
server cooldown + per-IP rate limit are the only "duplicate send" protections.

### Expected request (`POST /api/notify`)

```json
{
  "title": "New paper: DBMS {2023}",
  "body": "Just approved — open it in the app.",
  "path": "/pyq/dbms-2023"
}
```

Validation (server-side, enforced again in the Worker):

| Field | Rule |
|---|---|
| `title` | required string, 1–120 chars after trimming; `<`/`>` and control chars stripped |
| `body` | required string, 1–300 chars after trimming; `<`/`>` and control chars stripped |
| `path` | optional; must be a string starting with `/`, ≤500 chars, URL-safe characters only (`/pyq/<slug>`, `/paper.html?id=…`, `/`); omitted → app opens home |

### Expected response

- `200` — FCM accepted the message:

```json
{
  "status": "ok",
  "sent": true,
  "topic": "all_users",
  "messageId": "projects/dsmnru-data/messages/0:…",
  "note": "FCM accepted the notification for the all_users topic. FCM does not report subscriber counts…"
}
```

- `401` — missing/invalid ID token or missing `admin: true` claim.
- `400` — validation error (`error` explains the field).
- `429` — a notification was already sent from this admin within 30 s
  (`Retry-After` header).
- `502` — FCM rejected the request / credentials misconfigured (never leaks
  service-account internals).

### Payload sent to FCM (matches `FcmService.java`)

```json
{
  "message": {
    "topic": "all_users",
    "notification": { "title": "…", "body": "…" },
    "data": { "path": "/pyq/<slug>" },
    "android": {
      "priority": "HIGH",
      "notification": { "channel_id": "dsmnru_general", "notification_count": 1 }
    }
  }
}
```

- Background: Android shows the tray notification itself (branded via the
  manifest: channel `dsmnru_general`, icon `ic_stat_dsmnru`, color `#14B8A6`).
- Foreground: `FcmService.onMessageReceived` renders it on the same channel.
- Tap: `ACTION_VIEW` → `https://dsmnru-pyq.netlify.app + data.path` →
  MainActivity → the app's JS router (never the website).
- No `data.path` → tapping opens the app home.

### Web push

There is no web-push (browser notification) implementation on the website and
none is planned here; the admin panel sends Android push only.

## 4. Admin sending flow (website, main)

1. Sign in to `admin.html` (Firebase Auth, admin rule).
2. Open **Notifications** workspace.
3. Fill title + message (+ optional deep link). Live preview updates as you type.
4. Click **Send Notification** → `POST {API}/api/notify` with the admin's
   Firebase ID token.
5. Success/error is shown inline; the button is disabled while sending, and
   the Worker rejects a second send within 30 s.

## 5. Worker setup (secrets — never commit)

`POST /api/notify` reuses the existing service-account OAuth flow in
`worker/src/auth.js` (scope `datastore + cloud-platform`, which covers the FCM
HTTP v1 API). Required one-time setup:

1. The service account in `FIREBASE_SERVICE_ACCOUNT_JSON` must reference a
   service account in project **`dsmnru-data`** with the **Firebase Cloud
   Messaging API Admin** role (or another role that permits FCM v1 sends).
   It is already a Worker secret used for Firestore, so normally no new
   secret is needed.
2. Deploy: `cd worker && npx wrangler deploy`.
3. Firestore is **not** used for notifications; no rules changes required.

If you prefer a separate credential, store it as a Worker secret and point
`worker/src/fcm.js` at it — but keep it server-side in every case.

## 6. APK release flow

```
Developer updates app on android-app
        ↓
GitHub Actions (android-apk.yml)
   checks → node worker/test/* + android-app npm test
   debug-apk → workflow artifact dsmnru-pyq-debug-apk (14 days)
   release-apk → signed dsmnru-pyq.apk artifact (30 days)   [needs signing secrets]
        ↓
Publish dsmnru-pyq.apk as a GitHub Release asset (android-app change — see §7)
        ↓
main: apk-config.js  → releaseUrl = https://github.com/Lav-developer/PYQ/releases/download/<tag>/dsmnru-pyq.apk
        ↓
download.html CTA → direct file download
```

`main` contains **only** the centralized config (`/apk-config.js`); the APK
binary is never committed to `main`.

### Where to put the URL

`/apk-config.js`:

```js
window.DSMNRU_APK = {
    releaseUrl: 'https://github.com/Lav-developer/PYQ/releases/download/v1.4.0/dsmnru-pyq.apk',
    versionName: '1.4.0',
    versionCode: 11,
    minAndroid: 'Android 7.0 (API 24) or newer',
    fileSize: '18 MB',          // only when known reliably
    releasedAt: '2026-09-04',   // only when known
    releaseNotesUrl: 'https://github.com/Lav-developer/PYQ/releases/tag/v1.4.0'
};
```

When `releaseUrl` is empty the download page keeps its CTA visible but
disabled and explains that no release asset is configured yet — it never
invents a URL.

## 7. REQUIRED ON android-app (not done in main)

The android-app GitHub Actions workflow currently uploads the release APK as
a **workflow artifact only**. To complete the flow above, the android-app
branch needs a small, safe workflow addition (main cannot change that file):

1. In `.github/workflows/android-apk.yml`, after the `release-apk` job builds
   and verifies `dsmnru-pyq.apk`, publish it as a GitHub Release asset, e.g.:

```yaml
  release-asset:
    name: Publish release APK asset
    needs: [checks, release-apk]
    if: github.event_name == 'push' && startsWith(github.ref, 'refs/tags/v')
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      - uses: actions/download-artifact@v4
        with: { name: dsmnru-pyq.apk, path: apk }
      - uses: softprops/action-gh-release@v2
        with:
          files: apk/dsmnru-pyq.apk
          generate_release_notes: true
```

   (Requires `permissions: contents: write` on the job and a signed,
   Firebase-config-enabled release build; keep the existing signing-secret
   gating.)

2. Afterwards, update `apk-config.js` on `main` with the release asset URL
   (`https://github.com/Lav-developer/PYQ/releases/download/<tag>/dsmnru-pyq.apk`)
   and the new version metadata.

## 8. Testing matrix

| Layer | Command | What it proves |
|---|---|---|
| Worker API | `cd worker && npm test` | `/api/notify` auth, validation, exact FCM payload, cooldown, safe errors |
| Admin workspace | `cd worker && node test/admin-ia-test.cjs` | Notifications view, empty-submit block, loading state, Bearer call |
| Static pages | `cd worker && node test/static-pages-test.cjs` | download/terms/privacy render, SEO meta, footer links, no fake APK URL |
| Android | `cd android-app && npm test` | FcmService contract, topic subscribe, payload deep-link mapping |
| Device | manual | actual FCM delivery, permission dialog, cold/warm tap routing (see `android-app/docs/PUSH_NOTIFICATIONS.md`) |

**End-to-end:** website/backend sender is implemented and unit-tested; actual
delivery requires a real Android device with a Firebase-enabled build and a
Google account with the FCM API available for project `dsmnru-data`. Verify
manually with the "Send Notification" form once a device is subscribed.
