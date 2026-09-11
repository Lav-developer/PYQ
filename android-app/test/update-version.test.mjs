import test from 'node:test';
import assert from 'node:assert/strict';
import { isNewer, parseUpdate } from '../www/js/update.js';

test('numeric installed versionCode controls update decisions', () => {
  assert.equal(isNewer(13, 12), true);
  assert.equal(isNewer(12, 12), false);
  assert.equal(isNewer(11, 12), false);
  assert.equal(isNewer(14, 12), true);
});
test('metadata uses native versionCode and does not parse versionName', () => {
  const raw = { version: '1.4.2', versionCode: 13, downloadUrl: 'https://github.com/Lav-developer/PYQ/releases/download/v1.4.2/app.apk' };
  assert.ok(parseUpdate(raw, 12));
  assert.equal(parseUpdate(raw, 13), null);
  assert.equal(parseUpdate({ ...raw, version: '1.4.1', versionCode: 13 }, 12).versionCode, 13);
});
test('Android UI has no duplicated version constants', async () => {
  const fs = await import('node:fs/promises');
  const [about, profile, update] = await Promise.all(['../www/js/views/about.js','../www/js/views/profile.js','../www/js/update.js'].map(x => fs.readFile(new URL(x, import.meta.url), 'utf8')));
  assert.doesNotMatch(about, /APP_VERSION|1\.4\.0|1\.4\.1/);
  assert.doesNotMatch(profile, /APP_VERSION|1\.4\.0|1\.4\.1/);
  assert.doesNotMatch(update, /CURRENT_VERSION_CODE|versionCode\s*=\s*12/);
});
