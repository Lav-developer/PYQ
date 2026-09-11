(async () => {
  const { parseVersionCode, selectProductionApk, toUpdateMetadata } = await import('../src/appUpdate.js');
  const assert = require('node:assert/strict');
  const apk = (name, url = `https://github.com/Lav-developer/PYQ/releases/download/v2/${name}`, size = 10) => ({ name, browser_download_url: url, state: 'uploaded', size });
  assert.equal(parseVersionCode('Android versionCode: 37'), 37);
  assert.equal(parseVersionCode('versionCode: 1.4.2'), null);
  assert.equal(parseVersionCode('release notes'), null);
  const release = (extra = {}) => ({ tag_name: 'v2.0.0', published_at: '2026-01-01T00:00:00Z', body: 'versionCode: 37\n- Fast', assets: [apk('source.zip'), apk('debug.apk'), apk('dsmnru-pyq.apk', undefined, 20), apk('notes.txt')], ...extra });
  assert.equal(toUpdateMetadata({ ...release(), draft: true }), null);
  assert.equal(toUpdateMetadata({ ...release(), prerelease: true }), null);
  assert.equal(toUpdateMetadata({ ...release({ body: 'release notes' }) }), null);
  assert.equal(toUpdateMetadata({ ...release({ assets: [apk('source.zip')] }) }), null);
  assert.equal(selectProductionApk([apk('small.apk', undefined, 1), apk('dsmnru-pyq-release.apk', undefined, 2)]).name, 'dsmnru-pyq-release.apk');
  assert.equal(selectProductionApk([apk('app.apk', 'http://github.com/x/app.apk')]), null);
  assert.equal(toUpdateMetadata(release()).versionCode, 37);
  console.log('app-update tests: 9 passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
