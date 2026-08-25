# Performance audit — 2026-08-25

## Baseline supplied by the requester

| Category | Score |
| --- | ---: |
| Performance | 54 |
| Accessibility | 96 |
| Best Practices | 92 |
| SEO | 100 |
| PWA | 100 |

## Measurement constraints

The production host could not be fetched from this environment (TLS connection
reset), and this runner has no installed Chrome binary. A local Lighthouse run
therefore cannot be made honest: Lighthouse exits with `CHROME_PATH` missing.
The changes below are based on the actual critical-path markup and exact asset
sizes in the checkout; they must be validated by a production Lighthouse run
once Netlify has deployed this branch.

## Top five contributors found in the source/profile inventory

1. **1.164 MB favicon request.** The 1024×1024 `img/Logo.png` was referenced
   twice on the homepage as favicon/shortcut icon. The browser can fetch it
   even though it is far larger than an icon needs to be. This alone explains
   a substantial portion of the prior approximately 1.9 MB transfer budget.
2. **Firestore compat on every anonymous landing-page visit.** The public list
   is delivered by the Worker API, but `firebase-firestore-compat.js` was
   downloaded, parsed and initialized before a visitor used an authenticated
   feature.
3. **SweetAlert2 on every anonymous landing-page visit.** It is only called by
   login/profile/upload/feedback interaction paths, yet was part of initial
   JavaScript execution.
4. **A single 147 KB unminified `script.js` owns both archive and optional
   account/tool functionality.** It remains a candidate for a follow-up
   bundler/module split; moving it blindly would break inline handlers, so it
   was not mechanically split in this change.
5. **Render-blocking design dependencies.** Bootstrap, Font Awesome, the
   Manrope stylesheet and site CSS are currently needed for first-paint layout
   and icons. They were retained rather than using unsafe async-CSS patterns
   that create a flash of unstyled/inaccessible content.

## Implemented changes and measured asset deltas

| Change | Why | Measured result |
| --- | --- | --- |
| Replace `Logo.png` favicon references with `icon-192.png` | A favicon does not need a 1024px, 1.164 MB source image | **1,220,215 bytes → 31,982 bytes**, roughly **1.13 MB less** per cold page load; the primary page no longer references `Logo.png` |
| Optimize social preview to 8-bit PNG | Preserve the same generated sharing graphic while reducing platform transfer | `social-preview.png`: **232,989 → 97,094 bytes** |
| Lazy-load Firestore compat | Public browsing uses the Worker; Firestore is only needed for logged-in profile state, uploads, feedback, comments and view writes | No Firestore resource on an anonymous homepage request; `ensureFirestore()` loads it before a signed-in sync or data write |
| Lazy-load SweetAlert2 | It is only used after interaction | No SweetAlert2 resource on initial document load; `showAlert()` preserves existing notices and loads it on demand |
| Remove unused Firebase Performance compat tags | No source calls `firebase.performance()` | Removes an unused third-party request from contributors, links and tools |

## Functional safety

- Auth **app + auth compat** remain on the initial page because the profile
  state must still be correct.
- A returning signed-in visitor loads Firestore before profile synchronization.
- Every explicit homepage write path now awaits `ensureFirestore()`.
- The paper page retains its current Firestore loading because `paper.js`
  directly initializes comments/view logic; changing it requires a separate
  paper-route integration test and was outside the homepage critical path.
- SweetAlert calls were routed through `showAlert()`; behavior and notification
  content are preserved.

## Required production validation

After Netlify deploy, run a mobile Lighthouse trace on the canonical origin and
record: LCP resource/element, JS execution, TBT, main-thread work, total bytes,
request count, unused JavaScript/CSS and long tasks. Confirm the initial
waterfall does not contain `Logo.png`, Firestore compat, SweetAlert2 or Firebase
Performance compat for an anonymous homepage visitor.

If the score remains below 90 after these high-transfer/high-execution changes,
the remaining dominant bottleneck is expected to be the monolithic global
`script.js` plus Bootstrap/Font Awesome. The safe next step is a tested module
build that keeps compatibility wrappers for every inline handler, not removal
of archive/auth functionality.
