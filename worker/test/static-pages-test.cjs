/**
 * Static pages test: download / terms / privacy + footer integration.
 *
 * Verifies (without a browser):
 *  - the three pages exist, render canonical/description/OG/JSON-LD and are
 *    mobile-friendly (viewport);
 *  - legal pages load no Firebase/analytics script (static render);
 *  - the download page wires the centralized apk-config.js and does NOT
 *    invent a download URL;
 *  - footer links (Home / Download App / Privacy Policy / Terms) are present
 *    on every public page, and the same links appear in the page-nav;
 *  - sitemap.xml includes the new pages.
 *
 * Run: cd worker && node test/static-pages-test.cjs
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

let pass = 0;
let fail = 0;
function check(name, condition, detail = '') {
  if (condition) { pass += 1; console.log(`  ✅ ${name}`); }
  else { fail += 1; console.log(`  ❌ ${name} ${detail}`); }
}

const SITE = 'https://dsmnru-pyq.netlify.app';
const PUBLIC_PAGES = ['index.html', 'contributors.html', 'links.html', 'tools.html', 'paper.html', 'download.html', 'terms.html', 'privacy.html'];
const FOOTER_LINKS = [
  ['/', 'Home'],
  ['download.html', 'Download App'],
  ['privacy.html', 'Privacy Policy'],
  ['terms.html', 'Terms & Conditions'],
];

console.log('\n📄 Static pages\n');

// ── Per-page checks ──────────────────────────────────────────────────
const pages = {
  'download.html': {
    title: 'Download DSMNRU PYQ Android App',
    desc: 'Download the free DSMNRU PYQ Android app',
  },
  'terms.html': {
    title: 'Terms & Conditions',
    desc: 'Terms and conditions for using the DSMNRU PYQ archive',
  },
  'privacy.html': {
    title: 'Privacy Policy',
    desc: 'How the DSMNRU PYQ archive handles your data',
  },
};

for (const [file, meta] of Object.entries(pages)) {
  const html = read(file);
  const title = meta.title.replace(/&/g, '&amp;');
  console.log(`- ${file}`);
  check('doctype + lang', /^<!DOCTYPE html>/i.test(html) && /<html lang="en">/.test(html));
  check('viewport (mobile-friendly)', /<meta name="viewport" content="width=device-width, initial-scale=1\.0">/.test(html));
  check('title', html.includes(`<title>${title}`), title);
  check('meta description', html.includes(`<meta name="description" content="${meta.desc}`));
  check('canonical', html.includes(`<link rel="canonical" href="${SITE}/${file}">`));
  check('Open Graph title/url', html.includes(`<meta property="og:title" content="${title}`)
    && html.includes(`<meta property="og:url" content="${SITE}/${file}">`));
  check('robots allows indexing', /<meta name="robots" content="index, follow">/.test(html));
  check('JSON-LD WebPage', /"@type":"WebPage"/.test(html));
  check('footer links present', (() => {
    const footer = html.match(/<footer class="footer">[\s\S]*?<\/footer>/);
    if (!footer) return false;
    return FOOTER_LINKS.every(([href]) => footer[0].includes(`href="${href}"`))
      && footer[0].includes('Terms &amp; Conditions');
  })());
}

// Legal pages render statically: only JSON-LD script tags, no external JS.
for (const file of ['terms.html', 'privacy.html']) {
  const html = read(file);
  const scripts = html.match(/<script\b[^>]*>/g) || [];
  check(`${file} loads no scripts for static rendering`,
    scripts.every((s) => s.includes('application/ld+json')) && !/<script[^>]*src=/.test(html));
}

// ── Download page ────────────────────────────────────────────────────
console.log('\n- download page / APK contract');
{
  const html = read('download.html');
  const config = read('apk-config.js');

  check('no Firebase/analytics SDK on the download page',
    !/www\.gstatic\.com|firebasejs|firebase-app|firebase-auth|firestore-compat|firestore\.js|googletagmanager|gtag\(/.test(html));
  check('CTA carries the analytics event hook (data-track-event)', /id="downloadApkBtn"[\s\S]*data-track-event="apk_download_click"/.test(html));
  check('page does not claim the click installs the app',
    /does <em>not<\/em> install the app/.test(html));
  check('installation note allows "unknown sources"', /Install unknown apps|Allow from this source/i.test(html));
  check('known version metadata is shown (1.4.0 / build 11)', html.includes('id="apkVersionName"') && html.includes('id="apkVersionCode"'));
  check('Android requirement sourced from the project (API 24)', /Android 7\.0 \(API 24\) or newer/.test(html));
  check('links to Privacy and Terms', /href="privacy\.html"/.test(html) && /href="terms\.html"/.test(html));

  // Centralized config — must stay a placeholder until a GitHub Release exists.
  check('config points at one releaseUrl field', /releaseUrl: ''/.test(config));
  check('config documents the GitHub Release asset format (docs only)', /releases\/download/.test(config));
  check('config mirrors android-app version metadata', /versionName: '1\.4\.0'/.test(config) && /versionCode: 11/.test(config));
  check('releaseUrl itself is never an .apk URL', !/releaseUrl:\s*'[^']*\.apk/.test(config));
  check('download.js guards the missing-URL state', /is-pending|removeAttribute\('aria-disabled'\)/s.test(read('download.js')));
}

// ── Navigation integration ───────────────────────────────────────────
console.log('\n- navigation / footer integration');
for (const file of ['index.html', 'contributors.html', 'links.html', 'tools.html', 'paper.html']) {
  const html = read(file);
  check(`${file} nav links Download App`, /page-nav[\s\S]*href="download\.html"/.test(html)
    || /href="download\.html"/.test(html.match(/<header[\s\S]*?<\/header>/) || ''));
  check(`${file} footer links all three new pages`,
    FOOTER_LINKS.slice(1).every(([href]) => html.match(/<footer class="footer">[\s\S]*?<\/footer>/) && html.match(/<footer class="footer">[\s\S]*?<\/footer>/)[0].includes(`href="${href}"`)));
}

// ── Sitemap ──────────────────────────────────────────────────────────
console.log('\n- sitemap');
{
  const sitemap = read('sitemap.xml');
  for (const file of ['download.html', 'terms.html', 'privacy.html']) {
    check(`sitemap includes ${file}`, sitemap.includes(`${SITE}/${file}`));
  }
}

console.log(`\nResults: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
