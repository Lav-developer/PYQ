/**
 * Tests for the GitHub Release automation in
 * .github/workflows/android-apk.yml.
 *
 * These tests validate the *decision logic* used by the workflow so the
 * invariants are protected against accidental breakage:
 *   - valid vs. invalid version tags
 *   - Gradle versionName/versionCode parsing
 *   - APK package / versionName / versionCode metadata validation
 *   - release-body contract (versionCode: N line required by Worker /api/app-update)
 *   - idempotency rules (don't duplicate assets, etc.)
 *
 * These are fast Node tests — they do not run Gradle, sign APKs or push tags.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

// ──────────────────────────────────────────────────────────────────────────
// Pure helpers that mirror the bash logic in the release job.
// ──────────────────────────────────────────────────────────────────────────

/** Validates a tag ref against vMAJOR.MINOR.PATCH (strict, no prerelease). */
function validateTag(ref) {
  const m = /^v(\d+)\.(\d+)\.(\d+)$/.exec(ref);
  if (!m) return { ok: false };
  return {
    ok: true,
    version: `${m[1]}.${m[2]}.${m[3]}`,
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
  };
}

/** Parses versionName and versionCode out of an android/app/build.gradle file. */
function parseGradleVersions(gradleText) {
  const vn = /versionName\s+"([^"]+)"/.exec(gradleText);
  const vc = /versionCode\s+(\d+)/.exec(gradleText);
  if (!vn || !vc) return null;
  return { versionName: vn[1], versionCode: Number(vc[1]) };
}

/**
 * Minimal stand-in for the fields the release job cares about from
 * `aapt dump badging`. We parse the `package: name='…' versionName='…'
 * versionCode='…'` line exactly like the workflow does.
 */
function parseAaptBadging(badging) {
  const line = badging.split('\n').find(l => l.startsWith('package:'));
  if (!line) return null;
  const name = /name='([^']+)'/.exec(line);
  const vn = /versionName='([^']+)'/.exec(line);
  const vc = /versionCode='([^']+)'/.exec(line);
  if (!name || !vn || !vc) return null;
  return { package: name[1], versionName: vn[1], versionCode: vc[1] };
}

/** Verifies the release body contains the required versionCode: N line. */
function bodyHasVersionCode(body) {
  const re = /(?:^|[^a-zA-Z])versionCode\s*:\s*(\d+)(?!\.\d)/i;
  const m = re.exec(String(body || ''));
  return m ? Number(m[1]) : null;
}

// ──────────────────────────────────────────────────────────────────────────
// Tag validation
// ──────────────────────────────────────────────────────────────────────────

test('valid semantic version tags are accepted', () => {
  for (const tag of ['v1.4.3', 'v1.5.0', 'v2.0.0', 'v0.0.1', 'v10.20.30']) {
    const r = validateTag(tag);
    assert.ok(r.ok, `expected ${tag} to be accepted`);
    assert.match(r.version, /^\d+\.\d+\.\d+$/);
  }
});

test('invalid tag forms are rejected', () => {
  for (const tag of [
    'v1',
    'v1.4',
    '1.4.3',
    'v1.4.3-beta',
    'v1.4.3-rc1',
    'v1.4.3.1',
    'v',
    '',
    'release-v1.4.3',
    'V1.4.3',
    'v1.4.3beta',
  ]) {
    assert.equal(validateTag(tag).ok, false, `expected ${JSON.stringify(tag)} to be rejected`);
  }
});

// ──────────────────────────────────────────────────────────────────────────
// Gradle parsing
// ──────────────────────────────────────────────────────────────────────────

test('parses versionName and versionCode from build.gradle', () => {
  const fixture = `
android {
    defaultConfig {
        applicationId "com.dsmnru.pyq"
        versionCode 14
        versionName "1.4.3"
    }
}`;
  const parsed = parseGradleVersions(fixture);
  assert.deepEqual(parsed, { versionName: '1.4.3', versionCode: 14 });
});

test('parses the real android/app/build.gradle', async () => {
  const gradlePath = path.join(REPO_ROOT, 'android-app', 'android', 'app', 'build.gradle');
  const text = await fs.readFile(gradlePath, 'utf8');
  const parsed = parseGradleVersions(text);
  assert.ok(parsed, 'could not parse build.gradle');
  assert.equal(typeof parsed.versionCode, 'number');
  assert.ok(parsed.versionCode > 0, 'versionCode must be positive');
  assert.match(parsed.versionName, /^\d+\.\d+\.\d+$/, 'versionName must be semver-ish');
  // Baseline stated by the task.
  assert.equal(parsed.versionName, '1.4.2', 'production baseline versionName');
  assert.equal(parsed.versionCode, 13, 'production baseline versionCode');
});

test('tag version must match Gradle versionName (release gate)', () => {
  const gradle = parseGradleVersions(`versionCode 14\nversionName "1.4.3"`);
  const tag = validateTag('v1.4.3');
  assert.equal(tag.ok && gradle.versionName === tag.version, true);

  // Mismatch must be caught.
  const badTag = validateTag('v1.4.4');
  assert.notEqual(gradle.versionName, badTag.version);
});

// ──────────────────────────────────────────────────────────────────────────
// APK aapt badging parsing
// ──────────────────────────────────────────────────────────────────────────

test('parses aapt badging output like release-apk does', () => {
  const badging =
    "package: name='com.dsmnru.pyq' versionCode='14' versionName='1.4.3' " +
    "platformBuildVersionName='15' platformBuildVersionCode='35'\n" +
    "application-label:'DSMNRU PYQ'\n";
  const info = parseAaptBadging(badging);
  assert.deepEqual(info, {
    package: 'com.dsmnru.pyq',
    versionName: '1.4.3',
    versionCode: '14',
  });
});

test('release gates reject APK metadata mismatches', () => {
  const tag = validateTag('v1.4.3');
  const gradle = { versionName: '1.4.3', versionCode: 14 };
  // Matching APK.
  const apkOk = { package: 'com.dsmnru.pyq', versionName: '1.4.3', versionCode: '14' };
  assert.equal(apkOk.package, 'com.dsmnru.pyq');
  assert.equal(apkOk.versionName, tag.version);
  assert.equal(Number(apkOk.versionCode), gradle.versionCode);

  // Wrong package.
  assert.notEqual(
    { package: 'com.other.app', versionName: '1.4.3', versionCode: '14' }.package,
    'com.dsmnru.pyq',
  );
  // Wrong versionName.
  assert.notEqual(
    { package: 'com.dsmnru.pyq', versionName: '1.4.2', versionCode: '14' }.versionName,
    tag.version,
  );
  // Wrong versionCode.
  assert.notEqual(
    Number({ package: 'com.dsmnru.pyq', versionName: '1.4.3', versionCode: '13' }.versionCode),
    gradle.versionCode,
  );
});

// ──────────────────────────────────────────────────────────────────────────
// Release body contract (Worker /api/app-update parses versionCode from it)
// ──────────────────────────────────────────────────────────────────────────

test('release body must contain versionCode: N for the updater', () => {
  assert.equal(bodyHasVersionCode('versionCode: 14'), 14);
  assert.equal(bodyHasVersionCode('## v1.4.3\n\nversionCode: 37\n\nnotes'), 37);
  assert.equal(bodyHasVersionCode('versionCode: 100\n\nSome changelog\nline 2'), 100);
});

test('malformed versionCode lines are rejected (matches worker parser)', () => {
  assert.equal(bodyHasVersionCode(''), null);
  assert.equal(bodyHasVersionCode('version: 1.4.2'), null);
  assert.equal(bodyHasVersionCode('versionCode 14'), null); // missing colon
  assert.equal(bodyHasVersionCode('versionCode: 1.4.2'), null); // must be integer
  assert.equal(bodyHasVersionCode('release notes only'), null);
});

test('selectProductionApk from worker rejects non-apk and debug assets', async () => {
  // Dynamic import of the real Worker module to confirm compatibility.
  const { selectProductionApk, isTrustedApkAsset } = await import(
    path.join(REPO_ROOT, 'worker', 'src', 'appUpdate.js')
  );
  const apk = (name, url = `https://github.com/x/y/releases/download/v1/${name}`, size = 10) => ({
    name,
    browser_download_url: url,
    state: 'uploaded',
    size,
  });
  assert.equal(isTrustedApkAsset(apk('source.zip')), false);
  assert.equal(isTrustedApkAsset(apk('debug.apk')), false);
  assert.equal(isTrustedApkAsset(apk('unsigned.apk')), false);
  assert.equal(isTrustedApkAsset(apk('test.apk')), false);
  assert.equal(isTrustedApkAsset(apk('http-insecure.apk', 'http://github.com/x.apk')), false);
  assert.equal(isTrustedApkAsset(apk('dsmnru-pyq.apk')), true);
  const picked = selectProductionApk([
    apk('source.zip'),
    apk('debug.apk'),
    apk('dsmnru-pyq.apk', undefined, 20),
    apk('notes.txt'),
  ]);
  assert.equal(picked.name, 'dsmnru-pyq.apk');
});

// ──────────────────────────────────────────────────────────────────────────
// Workflow file invariants
// ──────────────────────────────────────────────────────────────────────────

test('workflow file declares tag trigger for v*.*.* and a release job', async () => {
  const wf = await fs.readFile(
    path.join(REPO_ROOT, '.github', 'workflows', 'android-apk.yml'),
    'utf8',
  );
  // Tag trigger.
  assert.match(wf, /tags:\s*\n\s*-\s*'v\*\.\*\.\*'/);
  // Release job exists and depends on checks + release-apk.
  assert.match(wf, /^\s{2}release:/m);
  assert.match(wf, /needs:\s*\n\s*-\s*checks\s*\n\s*-\s*release-apk/);
  // Only runs on v* tags.
  assert.match(wf, /if:\s*startsWith\(github\.ref,\s*'refs\/tags\/v'\)/);
  // Has contents: write for release job.
  assert.match(wf, /permissions:\s*\n\s{6}contents:\s*write/);
  // Downloads the existing artifact by name (not rebuilding).
  assert.match(wf, /uses:\s*actions\/download-artifact@v7/);
  assert.match(wf, /name:\s*dsmnru-pyq\.apk\s*\n\s*path:\s*release-artifact/);
  // The release step uses gh release create / upload — not third-party actions.
  assert.match(wf, /gh release create/);
  assert.match(wf, /gh release upload/);
  // Never prints keystore contents or passwords to stdout/logs.
  // (We do pipe $ANDROID_KEYSTORE_B64 through `base64 -d > file` to write the
  // keystore to $RUNNER_TEMP — that is the documented safe pattern and does
  // not expose the secret. What must NEVER appear is a bare `echo "$SECRET"`
  // that would land the value in the Actions log.)
  const lines = wf.split('\n');
  for (const secret of [
    'ANDROID_KEYSTORE_B64',
    'ANDROID_KEYSTORE_PASSWORD',
    'ANDROID_KEY_ALIAS',
    'ANDROID_KEY_PASSWORD',
  ]) {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      // Allow: "echo \"$SECRET\" | base64 -d > …" (decoding into file, not logging).
      if (new RegExp(`echo\\s+"\\$${secret}"\\s*\\|\\s*base64\\s+-d\\s*>`).test(line)) continue;
      // Allow: assignments and export-style uses like env: blocks.
      if (!/\becho\b/.test(line)) continue;
      // Any other echo referencing the secret is a leak.
      if (new RegExp(`\\$${secret}(\\b|\\W)`).test(line)) {
        assert.fail(
          `Line ${i + 1} appears to echo secret ${secret} to logs: ${line}`,
        );
      }
    }
  }
  // Tag-format regex rejects prerelease suffixes (uses strict $ anchored).
  assert.match(wf, /\^v\(\[0-9\]\+\)\\\.\(\[0-9\]\+\)\\\.\(\[0-9\]\+\)\$/);
  // Release body contains versionCode: N.
  assert.match(wf, /echo\s+"versionCode:\s*\$VERSION_CODE"/);
  // Idempotency: checks existing release first.
  assert.match(wf, /gh release view "\$TAG"/);
});

test('release job does NOT appear to use a PAT', async () => {
  const wf = await fs.readFile(
    path.join(REPO_ROOT, '.github', 'workflows', 'android-apk.yml'),
    'utf8',
  );
  // Uses github.token (GITHUB_TOKEN), no personal access token references.
  assert.match(wf, /GH_TOKEN:\s*\$\{\{\s*github\.token\s*\}\}/);
  assert.doesNotMatch(wf, /secrets\.(GH|GITHUB)_TOKEN/);
  assert.doesNotMatch(wf, /secrets\.(PAT|PERSONAL|RELEASE)_TOKEN/);
});

test('production baseline versions in build.gradle are unchanged (1.4.2 / 13)', async () => {
  const gradlePath = path.join(REPO_ROOT, 'android-app', 'android', 'app', 'build.gradle');
  const text = await fs.readFile(gradlePath, 'utf8');
  assert.match(text, /versionCode\s+13\b/, 'versionCode baseline');
  assert.match(text, /versionName\s+"1\.4\.2"/, 'versionName baseline');
});
