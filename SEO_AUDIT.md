# Production SEO and crawlability audit

**Audited:** 2026-08-25  
**Canonical production origin:** `https://dsmnru-pyq.netlify.app/`

The repository and README identify this as the production Netlify hostname. The
Netlify deploy-preview hostname supplied with the audit is never emitted in
canonical, sitemap, Open Graph, Twitter, or JSON-LD fields.

## Architecture and route inventory

This is a static, multi-page Netlify site (not an SPA router). `index.html`
loads public archive data from a Cloudflare Worker; authentication, profiles,
comments, uploads, and view increments use Firebase client SDK compat modules.
There is no server-rendering/build-time paper-data source in this repository.

| Route | Public | Indexable | Direct HTTP behavior | Canonical | Unique metadata | Sitemap | HTML link | Status |
|---|---:|---:|---|---|---|---:|---:|---|
| `/` | yes | yes | 200 static document | self | yes | yes | yes | primary public archive |
| `/index.html` | yes | no (301) | redirects to `/` | `/` | inherited | no | no | duplicate eliminated |
| `/contributors.html` | yes | yes | 200 static document | self | yes | yes | yes | public contributor page |
| `/links.html` | yes | yes | 200 static document | self | yes | yes | yes | public curated links |
| `/tools.html` | yes | no | 200 | self | yes | no | yes | client-side/student utility, intentionally thin/non-indexable |
| `/paper.html?id={id}` | yes | no | 200 UI shell for a Worker-loaded record | base (noindex) | dynamic only | no | generated after data load | query ID is unbounded and no meaningful document exists without JS; must not create invalid generic sitemap entries |
| `/paper.html` | yes | no | 200 UI/error state | self | yes | no | no | no standalone content |
| `/admin.html` | authenticated admin | no | 200 login/admin shell | n/a | noindex header/meta | no | no | private |
| unknown path | no | no | Netlify 404.html / 404 | n/a | noindex | no | n/a | real 404, not homepage fallback |

## Dynamic paper indexing limitation and next implementation

The individual paper URLs are valuable, but this static repository does **not**
have a trusted build-time export of the Worker/Firestore records. A crawler
initially receives a generic shell and query ID metadata is only mutated in the
browser; social crawlers often do not execute it. Therefore indexing those URLs
would produce duplicate/thin documents. They are deliberately noindexed and
removed from the sitemap rather than falsely claiming them indexable.

To index individual papers, add a production data export plus a build step (or
an edge-rendered Netlify/Worker HTML endpoint) that emits one deterministic
HTML page per approved paper with visible title/course/session/description,
self-canonical URL, JSON-LD and a generated sitemap entry. Only then remove the
`paper.html` noindex rule. This requires access to the deployed Worker data or
Firestore service account and is not safely inferable from this checkout.

## Verification checklist

Run after deploying: `curl -I` each sitemap URL, `curl /robots.txt`, and
validate sitemap XML. Confirm `/missing-route` returns 404. Submit the sitemap
in Search Console and request indexing for the three canonical documents;
Google indexing itself remains asynchronous.
