This repository is a small static frontend that serves Previous Year Question Papers (PYQs) and Syllabi using Firebase (Firestore + Auth) for data and admin flows.

Quick orientation
- Frontend: static HTML + JS (no build step). Key files: `index.html` (public UI), `script.js` (homepage logic), `admin.html` (admin UI), `admin.js` (admin logic), `styles.css`.
- Data: Firestore collections named exactly `pyqs` and `syllabus`. Documents are flat objects: title (string), file (URL), optional course and semester.
- Auth: Admin uses Firebase email/password (compat SDK). The admin UI relies on `auth.onAuthStateChanged(...)` to toggle UI.

Essential patterns for AI edits
- Read both collections then client-side merge/sort (homepage):
  const db = firebase.firestore();
  Promise.all([ db.collection('pyqs').get(), db.collection('syllabus').get() ])
    .then(([pyqSnap, syllabusSnap]) => {/* map docs -> {id, ...data} then render */});
- Admin writes: use `add()` to create, `doc(id).set(..., {merge: true})` to update, and `doc(id).delete()` to delete. Keep `allData` in sync with Firestore ids.
- Year extraction: `script.js` computes a `year` by parsing `{YYYY}` from `title` — preserve this convention if you add year-based sorting.

Developer workflows
- Local dev: open `index.html` / `admin.html` in a browser or run a simple static server (e.g., `python -m http.server` or `npx serve .`). No build required.
- Firebase config: `firebaseConfig` is embedded in `script.js` and `admin.js`. Ensure the project matches these credentials when testing.

Conventions & gotchas
- Collection names are plural (`pyqs`, `syllabus`) — changing them requires updates in both `script.js` and `admin.js`.
- Code uses the Firebase compat SDK (script tags in HTML). Do not remove compat tags unless migrating all code to the modular SDK.

Files to check when changing behavior
- `script.js` — data loading, rendering, search, pagination
- `admin.js` — auth flows, add/edit/delete helpers, `allData` array handling
- `index.html` / `admin.html` — script tags (compat SDKs) and DOM IDs used by JS

Small examples (copy-paste)
- Add document (admin):
  db.collection('pyqs').add({ title, file })
    .then(docRef => { allData.pyqs.push({ id: docRef.id, title, file }); renderLists(); });
- Update document:
  db.collection('pyqs').doc(id).set({ title, file }, { merge: true });

If you need more (modular SDK migration, Firestore security rules, or tests for data-loading), tell me which and I'll add step-by-step changes.
