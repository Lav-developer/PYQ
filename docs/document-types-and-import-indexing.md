# Document types and bulk-import indexing

## Audit scope

- Production base: `main` at `deed78e323e391798401d574ac937267bf92f8ce`.
- Android inspected without switching branches: `origin/android-app` at
  `5bf3216` (`chore(android): bump version to 1.4.4`). Its sources and tests were
  extracted outside the checkout for compatibility testing.
- Implementation branch: `arena/01a0ab0f-pyq` (the session's fixed feature branch).
- Inspected actual HTML/JS, `courses.json`, Firestore rules, Worker router,
  Firestore REST pagination, cache/index/slug/SEO implementations, all existing
  Worker/frontend test commands, and Android API/UI consumers and CI workflow.

### Mutation and read-flow findings

| Flow | Actual behavior and treatment |
|---|---|
| Admin Add | Direct Firestore `addItem`; existing invalidator retained, now called immediately after successful write. PYQs retain generated titles and required course/semester/subject/session; branch remains optional. |
| Admin Edit | Direct Firestore merge; persistent slug retained. Adds type, description and editable optional academic metadata. Existing edit validation (title + primary URL) retained. |
| Admin Delete | Both legacy index-based and ID-based handlers invalidate once after successful deletion. |
| CSV add/update/restore | Previously wrote directly and **never invalidated**. One operation now awaits all writes and invokes the existing authenticated invalidator once, including after partial success. |
| Student upload | Writes only a pending submission; no public index change. |
| Student approval | **Does not publish**: transaction updates review status, reward account and ledger; email follows. Publishing is explicitly manual. No extra invalidation or change to rewards/approval architecture. Manual Add uses the normal publishing path. |
| View counters | Existing verified-user increments remain untouched; do not rebuild the collection on each view. |
| Homepage | Existing Worker/KV summary; additive type on cards, no fabricated General course grouping for non-PYQs without course metadata. |
| Public search/filters | Existing Worker compact-index matching/pagination; optional `type` filter on both list and search. No browser Firestore search. |
| Pretty URL | Existing index slug allocator → cached/full single-document lookup → visibility check → SEO template. No second slug mechanism. |
| Legacy URL | `paper.html?id=<id>` still uses the same JSON detail endpoint. Non-PYQ hydration and both server actions tested. |
| Index rebuild | Existing KV stale-while-revalidate and single-flight rebuild; compact type schema upgrades trigger the same background path. |
| Invalidation | Existing Firebase-admin-token `POST /api/invalidate`; index retained, derived caches cleared, item caches checked against invalidation timestamp. |
| SEO/sitemap | Public visibility predicate preserved and also applied to JSON list/detail. Non-PYQs get category-appropriate metadata and `DigitalDocument` JSON-LD. File URLs remain outside initial SEO HTML, preserving existing download/auth UX. |
| Android | Flexible JSON API client and detail/store consumers tolerate additive fields and absent academic metadata. Existing IDs, file fields, `slug`/`seoSlug`, pagination and routes retained. No Android source changes required. |

## Root cause

CSV import bypassed `addItem` and `editItem`, making its own Firestore writes.
Unlike those helpers, its loop never called `invalidateApiCache()`. The admin's
Firestore list refreshed, but the Worker continued serving its old KV index;
search and canonical slug lookup therefore could not see newly imported IDs.
The seven-day hard TTL was only a safety fallback, not a publishing mechanism.

## Type contract and compatibility

`document-types.js` is the single browser/Worker definition of:
`pyq`, `form`, `scholarship`, `notice`, `syllabus`, `other`.
The Worker imports it through a small ESM adapter. All site consumers of
`script.js` load this dependency first.

- Missing/null/empty type means `pyq`; no database migration is required.
- Valid writes and filters are normalized to lowercase; unknown writes are
  rejected (CSV rows are skipped with row-number warnings), unknown API filters
  return HTTP 400. Unknown pre-existing stored types display as `other`.
- Same `pyqs` collection, IDs and public routes. API fields are retained;
  `type` is additive on list/search/homepage/detail records.
- Explicitly restricted records now also disappear from public JSON responses;
  their detail endpoint returns 404. Two existing tests were **strengthened**
  from “private record has no slug” to “private record is not exposed.”
- Non-PYQ creation needs title and primary file URL; description and secondary
  URL are available. Academic fields are hidden and not required. Editing
  allows relevant optional metadata without filling in fake values.
- Existing PYQ creation title, duplicate-subject prompt, required fields and
  optional branch are preserved. Existing incomplete PYQs remain editable.

## CSV semantics and cache refresh

Example:

```csv
collection,id,title,type,Server 1,Server 2,course,semester,session,subject,branch
pyqs,,Scholarship Docs,scholarship,https://example.org/docs.pdf,,,,,,
```

- Old CSVs without type default to `pyq`, including old update rows.
- ID rows merge into that exact ID (creating it if absent); no-ID rows create
  new documents. Duplicate IDs are processed sequentially: last valid row wins.
- ID-based PYQ imports read that record to preserve its stored slug, or capture
  its old title-based slug before a rename, even if the admin list is unloaded.
  No-ID imports still need just one write per document.
- Existing backup columns are retained. Backup/restore additionally preserves
  visibility flags and camelCase access fields so a restricted record is not
  accidentally republished when restored under a new ID.
- Empty rows are skipped; malformed CSV parsing fails before writes. New
  documents need title and at least one file URL; existing IDs allow partial
  metadata updates. Invalid types are skipped with explicit warnings.
- Mixed-collection restores track the actual rows, not just the selected
  collection, to determine whether public data changed.
- 100 successful no-ID rows = 100 writes + **one** invalidation. Empty/fully
  invalid imports do not invalidate. A failed later write still invalidates
  any earlier successful public writes once.
- If invalidation fails, the saved counts are retained and the admin sees
  “public search/index refresh may be delayed” plus instructions to retry
  Refresh Public Cache. Write failure is separately reported as partial import.
- The form is disabled while importing to prevent accidental double submission.

## Index, slug and performance details

- Compact `ty` stores type; `typeVersion: 1` schedules an ordinary background
  schema upgrade for old KV values. Existing compact fields remain intact.
- Search includes the category label, title and existing academic fields.
- Existing slug generation, collision suffixes and slug-version format are
  unchanged. Admin imports preserve existing stable bases rather than replacing
  them with an edited title or a conflicting supplied CSV slug.
- A rebuild records its **start** time so an invalidation during the paginated
  Firestore sweep cannot be swallowed by a later completion timestamp.
  Same-millisecond invalidations also mark the index stale.
- A rebuild skipped because another isolate owns the KV lock clears its local
  single-flight promise, permitting a later retry rather than getting stuck.
- Warm search/filter/slug requests continue using KV, with no extra Firestore
  reads. Existing 311/1,000/5,000/10,000-document scale tests pass.
- Updated asset URLs and the existing service-worker cache version prevent
  cached old scripts from hiding the new UI. Deployment topology is unchanged.

## Tests and results

Commands run from `worker/` unless specified. Results recorded after final code
changes; tests use mock network/storage, not production writes.

| Command | Passed | Failed | Skipped |
|---|---:|---:|---:|
| `npm test` (Worker + real CSV integration) | 303 | 0 | 0 |
| `npm run test:frontend` | 53 | 0 | 0 |
| `npm run test:paper` | 24 | 0 | 0 |
| `npm run test:points` | 80 | 0 | 0 |
| `npm run test:duplicates` | 45 | 0 | 0 |
| `npm run test:admin-ia` | 73 | 0 | 0 |
| `npm run test:duplicate-freshness` | 13 | 0 | 0 |
| `npm run test:static-pages` | 51 | **3** | 0 |
| Android `npm test` (extracted branch, jsdom available) | 105 | 0 | 0 |
| **Total** | **747** | **3** | **0** |

Also passed: JavaScript syntax checks, `git diff --check`, and
`npx wrangler deploy --dry-run --outdir /tmp/pyq-worker-final` (bundling only,
**not** a production deployment). Android Node/UI tests were also rerun with
this branch's changed Worker modules in the extracted test snapshot: 105/105.
No native APK build, signing or release was performed.

### New regression coverage

The real `admin.html` + `admin.js` submit handler uses real Papa Parse and
FileReader, writes to the Firestore mock shared by the existing Worker REST
harness, and calls the **real authenticated Worker invalidation endpoint**.
The test proves stale-index behavior before refresh, then public search,
canonical HTML and JSON detail after the background rebuild. Further tests
cover all six types, absent/invalid type, 100-row batching, partial failures,
invalidation failure warnings, mixed add/update/restore, duplicate IDs,
malformed/empty CSV, backup access flags, form add/edit/delete, legacy and
non-PYQ collisions, schema refresh, lock retry, same-timestamp invalidation,
private states, sitemap, homepage and zero warm Firestore reads. Frontend smoke
tests exercise the filter parameter and both legacy/pretty non-PYQ hydration.

### Pre-existing test blocker — not introduced or hidden

The untouched base commit produces the **same** static-page result: 51 passed,
3 failed. `worker/test/static-pages-test.cjs` still expects:

1. `releaseUrl: ''` (a pending release),
2. version `1.4.0` / build `11`,
3. no APK URL in `releaseUrl`.

Production `apk-config.js` already describes a published, newer APK. Neither
that config nor these unrelated assertions was changed to force a green run.
Consequently the full “all existing tests pass” acceptance gate is **not met**.
The PR should remain draft pending an agreed resolution of that existing gate.

## Rollout, safety and remaining limitations

- Deploy the Worker and static assets together through the existing process;
  this change does not deploy either automatically. Smoke-test a typed document
  and its pretty/legacy URLs after the usual background refresh.
- Indexing remains intentionally asynchronous: first reads can serve the old
  index. KV propagation, locks, API/client caches and outages can delay public
  refresh. Explicit restrictions on freshly fetched detail records fail closed;
  old cached list metadata follows existing eventual-refresh semantics.
- Existing documents using fake metadata need selective admin correction to
  their proper type; they are not heuristically reclassified or migrated.
- Old CSVs without type explicitly mean PYQ; use a new typed backup to preserve
  a non-PYQ classification on restore/update.
- No Firebase project, auth architecture, Firestore rules, signing, Android
  version metadata, FCM, Resend or release/deployment automation changed.
- No Android code changes. Its existing UI may still show generic academic
  placeholders for these documents; search and downloads remain compatible.
- No production data was read for validation or mutated. Automated tests are
  mock-backed; production rollout verification remains an operator step.
