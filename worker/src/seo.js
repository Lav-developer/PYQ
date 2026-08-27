/**
 * Server-rendered public PYQ page helpers.
 *
 * This module only renders metadata that is already public in the compact
 * Worker search index. It intentionally never places file URLs, comments,
 * user data, Firebase credentials, or authenticated-only controls in the
 * server-rendered SEO block.
 */

import { isSafePyqSlug } from './slug.js';
import { isPublicIndexItem } from './search.js';

export const PUBLIC_SITE_ORIGIN = 'https://dsmnru-pyq.netlify.app';

const SITE_NAME = 'DSMNRU Academic Archive';
const SOCIAL_IMAGE = `${PUBLIC_SITE_ORIGIN}/assets/images/social-preview.png`;

function text(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function hasText(value) {
  return text(value).length > 0;
}

// Avoid locale-dependent ordering for deterministic related-card tie breaks.
function stableStringCompare(a, b) {
  const left = String(a);
  const right = String(b);
  return left < right ? -1 : left > right ? 1 : 0;
}

export function escapeHtml(value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeXml(value) {
  return escapeHtml(value).replace(/&#39;/g, '&apos;');
}

function jsonForScript(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function truncate(value, maxLength) {
  const normalized = text(value).replace(/\s+/g, ' ');
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function indexValue(indexItem, key, documentValue) {
  const candidate = indexItem ? indexItem[key] : '';
  return hasText(candidate) ? text(candidate) : text(documentValue);
}

/**
 * Keep SEO fields tied to the compact index: it carries exactly the public
 * title/metadata fields that may enter server-rendered markup, while the
 * per-item document is used for identity and current public-state validation.
 */
export function createSeoPaper(indexItem, document, { seoVariant = 0 } = {}) {
  const title = indexValue(indexItem, 't', document && document.title);
  const course = indexValue(indexItem, 'c', document && (document.course || document.category));
  const semester = indexValue(indexItem, 's', document && (document.semester || document.sem));
  const session = indexValue(indexItem, 'se', document && document.session);
  const branch = indexValue(indexItem, 'b', document && document.branch);
  const subject = indexValue(indexItem, 'su', document && document.subject);
  const views = Number(indexItem && indexItem.v);
  const createdAt = Number(indexItem && indexItem.ts);

  return {
    id: text(indexItem && indexItem.id) || text(document && document.id),
    title,
    course,
    semester,
    session,
    branch,
    subject,
    views: Number.isFinite(views) && views >= 0 ? Math.floor(views) : 0,
    createdAt: Number.isFinite(createdAt) && createdAt > 0 ? createdAt : 0,
    seoVariant: Number.isInteger(Number(seoVariant)) && Number(seoVariant) > 1
      ? Number(seoVariant)
      : 0,
  };
}

function seoDisplayTitle(paper) {
  // Put the variant first so title/description uniqueness survives even when
  // a very long paper title is truncated by a search or social client.
  return paper.seoVariant ? `Archive copy ${paper.seoVariant}: ${paper.title}` : paper.title;
}

export function canonicalPaperUrl(slug) {
  if (!isSafePyqSlug(slug)) {
    throw new Error('Cannot build a canonical URL for an invalid PYQ slug');
  }
  return `${PUBLIC_SITE_ORIGIN}/pyq/${encodeURIComponent(slug)}`;
}

export function buildSeoDescription(paper) {
  const details = [];
  if (paper.course) details.push(paper.course);
  if (paper.semester) details.push(`${paper.semester} semester`);
  if (paper.session) details.push(`session ${paper.session}`);
  if (paper.subject) details.push(paper.subject);
  if (paper.branch) details.push(paper.branch);

  const context = details.length ? ` for ${details.join(', ')}` : '';
  const displayTitle = seoDisplayTitle(paper);
  return truncate(
    `Download ${displayTitle}, a DSMNRU previous year question paper${context}. View paper details, related PYQs, and member preview and download options.`,
    160
  );
}

function isoDateFromTimestamp(timestamp) {
  const numeric = Number(timestamp);
  if (!Number.isFinite(numeric) || numeric <= 0) return '';

  const date = new Date(numeric);
  if (Number.isNaN(date.getTime())) return '';
  return date.toISOString().slice(0, 10);
}

function metadataRows(paper) {
  const rows = [
    ['Course', paper.course || 'General'],
    ['Semester', paper.semester || 'Not specified'],
    ['Session / Year', paper.session || 'Not specified'],
  ];

  if (paper.subject) rows.push(['Subject', paper.subject]);
  if (paper.branch) rows.push(['Branch', paper.branch]);

  return rows.map(([label, value]) => (
    `<li><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></li>`
  )).join('');
}

function breadcrumbMarkup(paper) {
  const crumbs = [
    '<li><a href="/"><i class="fas fa-home"></i> Home</a><span class="sep">/</span></li>',
    '<li><a href="/">PYQs</a><span class="sep">/</span></li>',
  ];

  if (paper.course) {
    crumbs.push(`<li><span>${escapeHtml(paper.course)}</span><span class="sep">/</span></li>`);
  }
  if (paper.semester) {
    crumbs.push(`<li><span>${escapeHtml(paper.semester)}</span><span class="sep">/</span></li>`);
  }

  crumbs.push(
    `<li><span class="current" title="${escapeHtml(paper.title)}">${escapeHtml(paper.title)}</span></li>`
  );
  return crumbs.join('');
}

function relatedMarkup(relatedItems) {
  if (!relatedItems.length) return '';

  const cards = relatedItems.map((item) => {
    const href = `/pyq/${encodeURIComponent(item.sl)}`;
    const meta = [item.c, item.s, item.se].filter(Boolean).join(' • ');
    return `<a class="related-card" href="${escapeHtml(href)}">
      <h4>${escapeHtml(item.t || 'Untitled paper')}</h4>
      <p>${escapeHtml(meta || 'DSMNRU Previous Year Question Paper')}</p>
      <div class="related-meta"><i class="fas fa-file-pdf"></i> View paper details</div>
    </a>`;
  }).join('');

  return `<section class="related-section" id="seoRelatedSection" aria-labelledby="seoRelatedHeading">
    <div class="section-header section-header-left" style="margin-bottom: 16px; max-width: none;">
      <h2 id="seoRelatedHeading" style="font-size: 1.4rem; margin: 0 0 6px;"><i class="fas fa-layer-group"></i> Related Papers</h2>
      <p class="section-description" style="margin:0;">More public DSMNRU PYQs from the same course</p>
    </div>
    <div class="related-grid">${cards}</div>
  </section>`;
}

/**
 * Choose related links from the existing compact index only. This performs no
 * Firestore reads and avoids exposing any non-public index item.
 */
export function getRelatedIndexItems(index, currentItem, limit = 6) {
  const course = text(currentItem && currentItem.c).toLowerCase();
  const subject = text(currentItem && currentItem.su).toLowerCase();
  const semester = text(currentItem && currentItem.s).toLowerCase();
  const session = text(currentItem && currentItem.se).toLowerCase();

  if (!currentItem || (!course && !subject)) return [];

  return ((index && index.items) || [])
    .filter((item) => item
      && item.id !== currentItem.id
      && isPublicIndexItem(item)
      && isSafePyqSlug(item.sl)
      && ((course && text(item.c).toLowerCase() === course)
        || (!course && subject && text(item.su).toLowerCase() === subject)))
    .map((item) => {
      let score = 0;
      if (course && text(item.c).toLowerCase() === course) score += 100;
      if (semester && text(item.s).toLowerCase() === semester) score += 20;
      if (subject && text(item.su).toLowerCase() === subject) score += 10;
      if (session && text(item.se).toLowerCase() === session) score += 5;
      return { item, score };
    })
    .sort((a, b) => b.score - a.score
      || (Number(b.item.v) || 0) - (Number(a.item.v) || 0)
      || (Number(b.item.ts) || 0) - (Number(a.item.ts) || 0)
      || stableStringCompare(a.item.id, b.item.id))
    .slice(0, limit)
    .map(({ item }) => item);
}

function jsonLd(paper, canonicalUrl) {
  const displayTitle = seoDisplayTitle(paper);
  const resource = {
    '@type': 'LearningResource',
    '@id': canonicalUrl,
    name: displayTitle,
    headline: displayTitle,
    description: buildSeoDescription(paper),
    url: canonicalUrl,
    inLanguage: 'en',
    isAccessibleForFree: true,
    provider: {
      '@type': 'Organization',
      name: SITE_NAME,
      url: PUBLIC_SITE_ORIGIN,
    },
    publisher: {
      '@type': 'Organization',
      name: SITE_NAME,
      logo: {
        '@type': 'ImageObject',
        url: `${PUBLIC_SITE_ORIGIN}/assets/icons/icon-512.png`,
      },
    },
    mainEntityOfPage: {
      '@type': 'WebPage',
      '@id': canonicalUrl,
    },
  };

  if (paper.course) resource.educationalLevel = paper.course;
  if (paper.subject) resource.about = { '@type': 'Thing', name: paper.subject };
  if (paper.semester) resource.temporalCoverage = `${paper.semester} semester`;
  if (paper.session) resource.keywords = [paper.course, paper.semester, paper.session, paper.subject, paper.branch]
    .filter(Boolean)
    .join(', ');

  const published = isoDateFromTimestamp(paper.createdAt);
  if (published) resource.datePublished = published;

  const breadcrumbItems = [
    { '@type': 'ListItem', position: 1, name: 'Home', item: `${PUBLIC_SITE_ORIGIN}/` },
    { '@type': 'ListItem', position: 2, name: 'PYQs', item: `${PUBLIC_SITE_ORIGIN}/` },
  ];
  let position = 3;
  if (paper.course) breadcrumbItems.push({ '@type': 'ListItem', position: position++, name: paper.course });
  if (paper.semester) breadcrumbItems.push({ '@type': 'ListItem', position: position++, name: paper.semester });
  breadcrumbItems.push({ '@type': 'ListItem', position, name: paper.title, item: canonicalUrl });

  return {
    '@context': 'https://schema.org',
    '@graph': [
      resource,
      {
        '@type': 'BreadcrumbList',
        itemListElement: breadcrumbItems,
      },
    ],
  };
}

function serverRenderedContent(paper, relatedItems) {
  const kicker = ['PYQ', paper.course, paper.semester, paper.session].filter(Boolean).join(' • ');
  const details = buildSeoDescription(paper);

  return `<section id="seoPaperContent" class="paper-detail-card" data-server-rendered="true" aria-labelledby="seoPaperTitle">
    <div class="paper-detail-head">
      <div class="paper-kicker"><i class="fas fa-file-pdf"></i> <span>${escapeHtml(kicker || 'PYQ')}</span></div>
      <h1 class="paper-title" id="seoPaperTitle">${escapeHtml(paper.title)}</h1>
      <div class="paper-meta-row">
        <span class="meta-pill"><i class="fas fa-graduation-cap"></i> ${escapeHtml(paper.course || 'General')}</span>
        ${paper.semester ? `<span class="meta-pill"><i class="fas fa-layer-group"></i> ${escapeHtml(paper.semester)}</span>` : ''}
        ${paper.session ? `<span class="meta-pill session"><i class="fas fa-calendar"></i> ${escapeHtml(paper.session)}</span>` : ''}
        ${paper.branch ? `<span class="meta-pill"><i class="fas fa-code-branch"></i> ${escapeHtml(paper.branch)}</span>` : ''}
      </div>
      <p class="paper-submeta">${escapeHtml(details)}</p>
    </div>
    <div class="paper-preview-wrap" style="padding-top: 1.25rem;">
      <h2 style="font-size: 1.05rem; font-weight: 800; color: #f8fafc; margin: 0 0 12px;"><i class="fas fa-circle-info"></i> Paper Information</h2>
      <ul class="info-list">${metadataRows(paper)}</ul>
    </div>
    <div class="paper-actions-bar">
      <a href="/" class="btn-paper btn-paper-primary"><i class="fas fa-arrow-left"></i> Browse All PYQs</a>
      <span class="paper-submeta">Sign in to preview and download this paper.</span>
    </div>
  </section>${relatedMarkup(relatedItems)}`;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function replaceElementContent(html, tagName, id, content) {
  const safeId = escapeRegExp(id);
  const pattern = new RegExp(
    `(<${tagName}\\b[^>]*\\bid\\s*=\\s*(?:"${safeId}"|'${safeId}')[^>]*>)[\\s\\S]*?(</${tagName}>)`,
    'i'
  );
  let found = false;
  const result = html.replace(pattern, (match, openTag, closeTag) => {
    found = true;
    return `${openTag}${content}${closeTag}`;
  });
  if (!found) throw new Error(`SEO template marker not found: #${id}`);
  return result;
}

function replaceWholeElement(html, tagName, id, replacement) {
  const safeId = escapeRegExp(id);
  const pattern = new RegExp(
    `<${tagName}\\b[^>]*\\bid\\s*=\\s*(?:"${safeId}"|'${safeId}')[^>]*>[\\s\\S]*?</${tagName}>`,
    'i'
  );
  if (!pattern.test(html)) throw new Error(`SEO template marker not found: #${id}`);
  return html.replace(pattern, () => replacement);
}

function replaceAttribute(html, tagName, id, attribute, value) {
  const safeId = escapeRegExp(id);
  const tagPattern = new RegExp(
    `<${tagName}\\b(?=[^>]*\\bid\\s*=\\s*(?:"${safeId}"|'${safeId}'))[^>]*>`,
    'i'
  );
  let found = false;
  const attributePattern = new RegExp(`(\\s${escapeRegExp(attribute)}\\s*=\\s*)(["'])[^"']*\\2`, 'i');
  const result = html.replace(tagPattern, (openTag) => {
    found = true;
    if (attributePattern.test(openTag)) {
      return openTag.replace(attributePattern, (match, prefix, quote) => `${prefix}${quote}${value}${quote}`);
    }
    return openTag.replace(/>$/, ` ${attribute}="${value}">`);
  });
  if (!found) throw new Error(`SEO template marker not found: #${id}`);
  return result;
}

/**
 * Fill the static paper.html shell with server-rendered, public SEO content.
 * Keeping the interactive shell in one source file prevents two UIs from
 * diverging; paper.js receives the injected ID and hydrates the usual UI.
 */
export function renderSeoPaperHtml(template, paper, slug, relatedItems = []) {
  const canonicalUrl = canonicalPaperUrl(slug);
  const description = buildSeoDescription(paper);
  const displayTitle = seoDisplayTitle(paper);
  const title = truncate(`${displayTitle} | DSMNRU PYQ Archive`, 120);
  const bootstrap = [
    `window.DSMNRU_PYQ_ID = ${jsonForScript(paper.id)};`,
    `window.DSMNRU_PYQ_SLUG = ${jsonForScript(slug)};`,
    `window.DSMNRU_PYQ_SEO_META = ${jsonForScript({
      title: paper.title,
      course: paper.course,
      semester: paper.semester,
      session: paper.session,
      subject: paper.subject,
      branch: paper.branch,
      views: paper.views,
      seoVariant: paper.seoVariant,
    })};`,
  ].join('');

  let html = String(template || '');
  html = replaceElementContent(html, 'title', 'paperPageTitle', escapeHtml(title));
  html = replaceAttribute(html, 'meta', 'paperMetaDescription', 'content', escapeHtml(description));
  html = replaceAttribute(html, 'meta', 'paperRobots', 'content', 'index, follow');
  html = replaceAttribute(html, 'link', 'canonicalLink', 'href', escapeHtml(canonicalUrl));
  html = replaceAttribute(html, 'meta', 'ogTitle', 'content', escapeHtml(displayTitle));
  html = replaceAttribute(html, 'meta', 'ogDescription', 'content', escapeHtml(description));
  html = replaceAttribute(html, 'meta', 'ogUrl', 'content', escapeHtml(canonicalUrl));
  html = replaceAttribute(html, 'meta', 'ogImage', 'content', SOCIAL_IMAGE);
  html = replaceAttribute(html, 'meta', 'twitterTitle', 'content', escapeHtml(displayTitle));
  html = replaceAttribute(html, 'meta', 'twitterDescription', 'content', escapeHtml(description));
  html = replaceAttribute(html, 'meta', 'twitterUrl', 'content', escapeHtml(canonicalUrl));
  html = replaceAttribute(html, 'meta', 'twitterImage', 'content', SOCIAL_IMAGE);
  html = replaceElementContent(html, 'script', 'paperJsonLd', jsonForScript(jsonLd(paper, canonicalUrl)));
  html = replaceElementContent(html, 'script', 'paperSeoBootstrap', bootstrap);
  html = replaceElementContent(html, 'ol', 'paperBreadcrumb', breadcrumbMarkup(paper));
  html = replaceElementContent(html, 'h1', 'paperTitle', escapeHtml(paper.title));
  html = replaceWholeElement(html, 'section', 'seoPaperContent', serverRenderedContent(paper, relatedItems));
  html = replaceAttribute(html, 'div', 'paperLoading', 'style', 'display:none;');
  return html;
}

function basicSeoPage({ title, description, robots, heading, message, status }) {
  return new Response(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title><meta name="description" content="${escapeHtml(description)}"><meta name="robots" content="${robots}">
<link rel="canonical" href="${PUBLIC_SITE_ORIGIN}/"><link rel="stylesheet" href="${PUBLIC_SITE_ORIGIN}/assets/css/styles.css"></head>
<body><main class="container paper-page"><section class="paper-error"><i class="fas fa-folder-open"></i><h1 style="color:#f8fafc; margin:8px 0;">${escapeHtml(heading)}</h1><p style="color:rgba(203,213,225,0.72);">${escapeHtml(message)}</p><a href="/" class="btn-paper btn-paper-primary">Browse All PYQs</a></section></main></body></html>`, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=UTF-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'X-Robots-Tag': robots,
    },
  });
}

export function renderPyqNotFoundPage() {
  return basicSeoPage({
    title: 'PYQ not found | DSMNRU Archive',
    description: 'The requested DSMNRU previous year question paper was not found.',
    robots: 'noindex, follow',
    heading: 'Paper not found',
    message: 'This paper may have been moved, unpublished, or removed from the archive.',
    status: 404,
  });
}

export function renderPyqUnavailablePage() {
  return basicSeoPage({
    title: 'PYQ temporarily unavailable | DSMNRU Archive',
    description: 'The requested DSMNRU previous year question paper is temporarily unavailable.',
    robots: 'noindex, follow',
    heading: 'Paper temporarily unavailable',
    message: 'Please try again shortly or browse the public PYQ archive.',
    status: 503,
  });
}

/**
 * Dynamic sitemap: static public pages plus every valid, public SEO slug in
 * the already-cached search index. It never requests individual documents.
 */
export function renderSitemapXml(index) {
  const staticUrls = [
    { loc: `${PUBLIC_SITE_ORIGIN}/`, changefreq: 'daily', priority: '1.0' },
    { loc: `${PUBLIC_SITE_ORIGIN}/contributors.html`, changefreq: 'weekly', priority: '0.6' },
    { loc: `${PUBLIC_SITE_ORIGIN}/links.html`, changefreq: 'monthly', priority: '0.5' },
  ];

  const pyqUrls = ((index && index.items) || [])
    .filter((item) => item
      && isPublicIndexItem(item)
      && text(item.t)
      && isSafePyqSlug(item.sl))
    .map((item) => ({
      loc: canonicalPaperUrl(item.sl),
      lastmod: isoDateFromTimestamp(item.ts),
      changefreq: 'monthly',
      priority: '0.8',
    }));

  const urls = [...staticUrls, ...pyqUrls];
  const entries = urls.map((entry) => {
    const lines = ['  <url>', `    <loc>${escapeXml(entry.loc)}</loc>`];
    if (entry.lastmod) lines.push(`    <lastmod>${entry.lastmod}</lastmod>`);
    if (entry.changefreq) lines.push(`    <changefreq>${entry.changefreq}</changefreq>`);
    if (entry.priority) lines.push(`    <priority>${entry.priority}</priority>`);
    lines.push('  </url>');
    return lines.join('\n');
  });

  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries.join('\n')}\n</urlset>`;
}
