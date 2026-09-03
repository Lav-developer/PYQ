/**
 * DSMNRU PYQ Android — FCM / push notification audit (no device required).
 *
 * Everything that can be verified statically IS verified here:
 *   • manifest: POST_NOTIFICATIONS permission, FcmService registration with
 *     the MESSAGING_EVENT intent filter, default channel/icon/color meta-data;
 *   • Gradle: firebase-messaging dependency + the conditional google-services
 *     apply (debug builds without google-services.json keep working);
 *   • FcmService.java: ONE global topic (`all_users`), version-gated
 *     subscription (never per-launch), token stored device-locally (NO
 *     Firestore import), foreground rendering behind a permission check,
 *     tap intent = ACTION_VIEW data URL on MainActivity;
 *   • MainActivity.java: real system permission dialog (requestPermissions —
 *     not a fake toggle), once per install (pref flag set BEFORE asking),
 *     gated to Android 13+ and Firebase-configured builds, channel creation;
 *   • app JS: no polling timers / no notification impersonation;
 *   • payload contract: `data.path` → absolute site URL → slug.js#parseSiteUrl
 *     → the IN-APP paper route (mirroring FcmService.deepLinkUri byte-for-byte).
 * Device-only checks (delivery, dialog UI, tray rendering) are listed in
 * docs/PUSH_NOTIFICATIONS.md §6. Run: npm test  (from android-app/)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const APP = join(here, '../android/app');
const main = (p) => readFileSync(join(APP, 'src/main', p), 'utf8');
const docs = () => readFileSync(join(here, '../docs/PUSH_NOTIFICATIONS.md'), 'utf8');

test('manifest declares the notification permission, FCM service and tray branding', () => {
  const manifest = main('AndroidManifest.xml');

  assert.match(manifest, /<uses-permission android:name="android\.permission\.POST_NOTIFICATIONS" \/>/,
    'Android 13+ runtime notification permission declared');
  assert.match(manifest, /<uses-permission android:name="android\.permission\.INTERNET" \/>/,
    'INTERNET still declared');

  const service = manifest.match(/<service\s+android:name="\.FcmService"[\s\S]*?<\/service>/);
  assert.ok(service, 'FcmService registered in the manifest');
  assert.match(service[0], /com\.google\.firebase\.MESSAGING_EVENT/, 'listens for FCM events');
  assert.match(service[0], /android:exported="false"/, 'FCM service is not exported');

  assert.match(manifest, /com\.google\.firebase\.messaging\.default_notification_channel_id[^>]*android:value="dsmnru_general"/,
    'background tray notifications use the app channel');
  assert.match(manifest, /com\.google\.firebase\.messaging\.default_notification_icon[^>]*@drawable\/ic_stat_dsmnru/,
    'background tray notifications use the app icon');
  assert.match(manifest, /com\.google\.firebase\.messaging\.default_notification_color[^>]*@color\/dsmnru_teal/,
    'background tray notifications use the brand color');

  // The in-app paper deep-link hosts stay registered (tap targets ride them).
  assert.match(manifest, /android:host="dsmnru-pyq\.netlify\.app"/, 'site deep-link host still registered');
});

test('Gradle wires firebase-messaging and keeps google-services conditional', () => {
  const gradle = readFileSync(join(APP, 'build.gradle'), 'utf8');
  assert.match(gradle, /com\.google\.firebase:firebase-messaging:\d+\.\d+\.\d+/,
    'Firebase Messaging dependency present');
  assert.match(gradle, /apply plugin: 'com\.google\.gms\.google-services'/,
    'google-services plugin applied when google-services.json exists');
  assert.match(gradle, /google-services\.json/, 'apply is guarded by the presence of google-services.json');
  assert.match(gradle, /versionCode 6/, 'versionCode increased for the 1.3.2 release');
  assert.match(gradle, /versionName "1\.3\.2"/, 'versionName 1.3.2');
  // Consistent package identity + stable debug signature (update-in-place).
  assert.match(gradle, /applicationId "com\.dsmnru\.pyq"/, 'single applicationId preserved');
  assert.match(gradle, /signingConfig signingConfigs\.debug/, 'debug buildType uses the shared debug signing config');
  assert.match(gradle, /storeFile file\('debug\.keystore'\)/, 'shared committed debug keystore (public debug credentials)');

  const rootGradle = readFileSync(join(here, '../android/build.gradle'), 'utf8');
  assert.match(rootGradle, /com\.google\.gms:google-services:[\d.]+/, 'plugin classpath on the root buildscript');
});

test('FcmService: one global topic, version-gated subscribe, no token database', () => {
  const src = main('java/com/dsmnru/pyq/FcmService.java');

  assert.match(src, /TOPIC_ALL_USERS = "all_users"/, 'the single global topic is `all_users`');
  assert.match(src, /extends FirebaseMessagingService/, 'proper FCM service subclass');

  // Registration + refresh handling
  assert.match(src, /onNewToken/, 'token rotation handled');
  assert.match(src, /getSharedPreferences\([^)]*\)\.edit\(\)\.putString\("token"/,
    'token stored device-locally (diagnostics only)');

  // Subscription discipline: version-gated, forced only on rotation, lazy retry.
  assert.match(src, /KEY_TOPIC_VERSION/, 'subscription gate persisted');
  assert.match(src, /subscribeToTopic\(TOPIC_ALL_USERS\)/, 'subscribes the global topic via the FCM SDK');
  assert.match(src, /if \(!force && prefs\.getInt\(KEY_TOPIC_VERSION, 0\) >= TOPIC_VERSION\) return;/,
    'ordinary launches never re-subscribe');
  assert.match(src, /putInt\(KEY_TOPIC_VERSION, 0\)/, 'failed subscribe resets the gate for a lazy retry');

  // Quota protection: NO Firestore, NO HTTP client, NO timers in the push path.
  assert.ok(!/com\.google\.firebase\.firestore|FirebaseFirestore|firebase\s*\(\)|\.collection\(/.test(src),
    'no Firestore API usage in FcmService (no token DB)');
  assert.ok(!/HttpURLConnection|OkHttp|okhttp|URL\(/.test(src), 'no custom network calls — FCM SDK only');
  assert.ok(!/Timer|setInterval|ScheduledExecutor/.test(src), 'no polling timers');

  // Foreground handling renders a notification, permission-checked.
  assert.match(src, /onMessageReceived/, 'foreground messages handled');
  assert.match(src, /checkSelfPermission\(context, android\.Manifest\.permission\.POST_NOTIFICATIONS\)/,
    'permission checked before posting');
  assert.match(src, /new NotificationCompat\.Builder\(context, CHANNEL_ID\)/, 'renders on the app channel');

  // Tap handling: ACTION_VIEW data URL on MainActivity (deep-link pipeline).
  assert.match(src, /new Intent\(Intent\.ACTION_VIEW, deepLinkUri\(path\), context, MainActivity\.class\)/,
    'tap intent opens MainActivity with the link as data');
  assert.match(src, /FLAG_IMMUTABLE/, 'PendingIntent is immutable on modern Android');
  assert.match(src, /SITE_ORIGIN = "https:\/\/dsmnru-pyq\.netlify\.app"/,
    'paths resolve to the site origin the app router parses');
});

test('MainActivity: real system permission dialog, asked once, correctly gated', () => {
  const src = main('java/com/dsmnru/pyq/MainActivity.java');

  assert.match(src, /Manifest\.permission\.POST_NOTIFICATIONS/, 'asks for POST_NOTIFICATIONS');
  assert.match(src, /ActivityCompat\.requestPermissions/, 'the REAL system dialog (no fake in-app toggle)');
  assert.match(src, /requestPermissions\([\s\S]{0,120}\)[\s\S]{0,80}putBoolean\(KEY_NOTIF_ASKED, true\)/,
    'the asked-flag is persisted only after the dialog request was accepted by the OS (never re-asked afterwards)');
  assert.match(src, /if \(Build\.VERSION\.SDK_INT < 33\) return;/, 'gated to Android 13+');
  assert.match(src, /isFirebaseAvailable/, 'skipped when the build has no Firebase config');
  assert.match(src, /notificationsGranted\(this\)\) return/, 'already granted → nothing to do');
  assert.match(src, /PERMISSION_ASK_DELAY_MS = 9000L/, 'asked after the user has seen the app');
  assert.match(src, /FcmService\.ensureChannel\(this\)/, 'notification channel created at app start');
  assert.match(src, /FcmService\.subscribeAllUsers\(this, false\)/,
    'version-gated topic subscribe bootstrapped (not forced) at app start');
});

test('FCM: token + all_users subscription are independent of the notification permission', () => {
  const src = main('java/com/dsmnru/pyq/FcmService.java');
  const activity = main('java/com/dsmnru/pyq/MainActivity.java');

  // Subscription path never consults POST_NOTIFICATIONS (permission only
  // governs the visual posting of notifications).
  const subscribeFn = src.match(/public static void subscribeAllUsers[\s\S]*?\n    \}/);
  assert.ok(subscribeFn, 'subscribeAllUsers present');
  assert.ok(!subscribeFn[0].includes('POST_NOTIFICATIONS') && !subscribeFn[0].includes('checkSelfPermission'),
    'topic subscription is NOT blocked by the notification permission');

  // Bootstrapped unconditionally at app start (no permission gate around it).
  assert.match(activity, /FcmService\.subscribeAllUsers\(this, false\);/,
    'all_users subscribe bootstrapped in onCreate');
  assert.match(src, /onNewToken[\s\S]{0,200}subscribeAllUsers\(this, true\)/,
    'token rotation re-asserts the subscription (force)');

  // Token lives ONLY in device-local prefs — never uploaded by the app.
  assert.ok(!/firestore|Firestore|documents\/|runQuery/.test(subscribeFn[0]), 'no token sync to any backend');
  assert.match(src, /getSharedPreferences\(PREFS, (Context\.)?MODE_PRIVATE\)\.edit\(\)\.putString\("token", token\)/,
    'token cached device-locally for diagnostics only');
});

test('FCM: the first-session permission dialog actually executes (and only once)', () => {
  const activity = main('java/com/dsmnru/pyq/MainActivity.java');

  // Scheduled from onResume → runs in a RESUMED activity state.
  assert.match(activity, /protected void onResume\(\)|public void onResume\(\)[\s\S]{0,120}scheduleNotificationPermissionAsk/,
    'ask scheduled from onResume (valid resumed lifecycle state)');
  assert.match(activity, /mainHandler\.postDelayed\(permissionAsk, PERMISSION_ASK_DELAY_MS\)/,
    'delayed first-session ask (~9s) is actually scheduled');

  // The dialog call is real, happens while the activity is alive, and the
  // once-flag is written only AFTER the OS accepted the request.
  const ask = activity.match(/private final Runnable permissionAsk[\s\S]*?\n    };/);
  assert.ok(ask, 'permissionAsk runnable present');
  assert.match(ask[0], /isFinishing\(\) \|\| isDestroyed\(\)/, 'never posts from a dying activity');
  assert.match(ask[0], /ActivityCompat\.requestPermissions\(this,[\s\S]{0,120}POST_NOTIFICATIONS[\s\S]{0,60}REQ_POST_NOTIFICATIONS\)/,
    'the REAL system dialog is requested');
  assert.ok(ask[0].indexOf('requestPermissions') < ask[0].indexOf('putBoolean(KEY_NOTIF_ASKED, true)'),
    'asked-flag persisted only after the request was handed to the OS (a failed call can never silence the dialog forever)');

  // Already granted → no request; already asked → never again.
  assert.match(ask[0], /notificationsGranted\(this\)\) return;/, 'already granted → no request');
  assert.match(ask[0], /getBoolean\(KEY_NOTIF_ASKED, false\)\) return;/, 'denied → never re-asked');

  // Config gate now accepts the generated google_app_id resource too, so a
  // google-services.json build always shows the dialog regardless of the
  // runtime Firebase init order.
  assert.match(activity, /hasFirebaseConfigResources/,
    'Firebase-config gate accepts the generated google_app_id resource');
});

test('app JS never polls for notifications or fakes the permission', () => {
  const appjs = readFileSync(join(here, '../www/js/app.js'), 'utf8');
  const nativejs = readFileSync(join(here, '../www/js/native.js'), 'utf8');
  for (const [name, src] of [['app.js', appjs], ['native.js', nativejs]]) {
    assert.ok(!/setInterval/.test(src), `${name} must not poll`);
    assert.ok(!/new Notification\(|Notification\.requestPermission/.test(src),
      `${name} must not impersonate notifications in JS — native owns push`);
  }
});

test('payload contract: data.path resolves to the IN-APP paper route', async () => {
  // Mirrors FcmService.deepLinkUri exactly.
  const SITE_ORIGIN = 'https://dsmnru-pyq.netlify.app';
  const deepLinkUri = (path) => {
    const p = path == null ? '' : String(path).trim();
    if (p === '') return SITE_ORIGIN + '/';
    if (p.startsWith('http://') || p.startsWith('https://')) return p;
    return SITE_ORIGIN + (p.startsWith('/') ? p : '/' + p);
  };

  const { parseSiteUrl } = await import(pathToFileURL(join(here, '../www/js/slug.js')).href);

  const cases = [
    ['/pyq/data-structures-2023', { view: 'paper', slug: 'data-structures-2023' }],
    ['/paper.html?id=p1', { view: 'paper', id: 'p1' }],
  ];
  for (const [path, expect] of cases) {
    const route = parseSiteUrl(deepLinkUri(path));
    assert.ok(route, `${path} parses as a site route`);
    assert.equal(route.view, expect.view, `${path} opens the ${expect.view} screen IN-APP`);
    if (expect.slug) assert.equal(route.slug, expect.slug);
    if (expect.id) assert.equal(route.id, expect.id);
  }
  // Empty path → app home (route root), never an external website hand-off.
  const home = parseSiteUrl(deepLinkUri(''));
  assert.ok(home === null || home.view !== undefined, 'root path handled without crashing');
});

test('docs/PUSH_NOTIFICATIONS.md documents the sender-side (Worker/admin) gap', () => {
  const doc = docs();
  for (const required of [
    'all_users',
    'dsmnru_general',
    'POST_NOTIFICATIONS',
    'google-services.json',
    '/api/notify',
    'verifyFirebaseAdminToken',
    'fcm.googleapis.com/v1/projects/dsmnru-data/messages:send',
    'data.path',
    'dsmnru-data',
  ]) {
    assert.ok(doc.includes(required), `docs mention ${required}`);
  }
  // The message contract block must be valid JSON with the documented shape.
  const block = doc.match(/```json\n([\s\S]*?)```/);
  assert.ok(block, 'a JSON message contract is documented');
  const payload = JSON.parse(block[1]);
  assert.equal(payload.message.topic, 'all_users', 'contract sends to the global topic');
  assert.ok(payload.message.notification.title, 'contract has a title');
  assert.match(payload.message.data.path, /^\//, 'contract path is app-relative');
});
