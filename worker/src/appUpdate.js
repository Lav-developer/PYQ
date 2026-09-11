/** Pure GitHub release validation used by the Android update endpoint. */
export function parseVersionCode(body) {
  const match = String(body || '').match(/(?:android\s+)?versionCode\s*[:=]\s*(\d+)(?![.\d])/i);
  if (!match) return null;
  const code = Number(match[1]);
  return Number.isSafeInteger(code) && code > 0 ? code : null;
}

export function isTrustedApkAsset(asset) {
  if (!asset || asset.state && asset.state !== 'uploaded') return false;
  const name = String(asset.name || '');
  const url = String(asset.browser_download_url || '');
  if (!/\.apk$/i.test(name) || /(?:debug|unsigned|source|test)/i.test(name)) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && (parsed.hostname === 'github.com' || parsed.hostname === 'objects.githubusercontent.com');
  } catch { return false; }
}

export function selectProductionApk(assets) {
  const valid = (Array.isArray(assets) ? assets : []).filter(isTrustedApkAsset);
  if (!valid.length) return null;
  // Prefer an explicitly production-looking asset, then the largest APK.
  return valid.sort((a, b) => {
    const score = x => /(?:release|dsmnru[-_]?pyq)/i.test(String(x.name)) ? 1 : 0;
    return score(b) - score(a) || Number(b.size || 0) - Number(a.size || 0);
  })[0];
}

export function toUpdateMetadata(release) {
  if (!release || release.draft || release.prerelease || !release.published_at || !/^v?\d+\.\d+\.\d+$/.test(String(release.tag_name || ''))) return null;
  const versionCode = parseVersionCode(release.body);
  const asset = selectProductionApk(release.assets);
  if (!versionCode || !asset) return null;
  return {
    version: String(release.tag_name).replace(/^v/, ''),
    versionCode,
    downloadUrl: asset.browser_download_url,
    releaseNotes: String(release.body || '').split('\n').map(x => x.replace(/^[-*]\s*/, '').trim()).filter(Boolean).slice(0, 5),
    mandatory: false,
    publishedAt: release.published_at,
  };
}
