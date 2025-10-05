This repository is a small static frontend that serves a collection of previous-year question papers (PYQs) and syllabi. The project uses Firebase for authentication, storage and (now) Firestore as the primary data store.

Key facts for AI agents working on this codebase
- Project type: static single-page frontend (HTML + JS). Key files: `index.html`, `script.js`, `admin.html`, `admin.js`, `styles.css`.
- Data model: Two main collections in Firestore: `pyqs` and `syllabus`. Each document represents one resource and typically has fields: `title` (string), `file` (URL string), `course` (string, optional), `semester` (string, optional). Documents created by the admin UI include a Firestore-generated `id` stored in the local in-memory arrays.
- Authentication: Admin panel uses Firebase Authentication (email/password) via the compat SDK. No backend functions are required for basic CRUD (uses Firestore client SDK).

Why Firestore (project decisions)
- The app migrated from Realtime Database to Firestore for better querying and document-level operations. The UI expects to read two collections separately and merge/sort results client-side.

Helpful patterns and conventions (concrete)
- Collection names: Use `pyqs` and `syllabus` (plural). Do not change these unless migrating data and updating both front-end reads and the Copilot instructions.
- Document shape: Keep documents flat. Example: { title: 'Data Structures {2021}', file: 'https://.../ds-2021.pdf', course: 'CSE', semester: '4' }
- Loading data: The homepage (in `script.js`) performs two independent collection reads and then processes the arrays (adds a computed `year` field by parsing the title). Follow the same pattern for new pages/features.
- Admin writes: The admin UI (in `admin.js`) uses `add`, `set` (merge) and `delete` on collection documents. The client keeps an in-memory array `allData` with objects that include the `id` returned by Firestore. Use that `id` for updates/deletes.

Code examples (copy-paste friendly)
- Read both collections (homepage pattern):
  const db = firebase.firestore();
  Promise.all([ db.collection('pyqs').get(), db.collection('syllabus').get() ])
    .then(([pyqSnap, syllabusSnap]) => {
      const pyqs = pyqSnap.docs.map(d => ({ id: d.id, ...d.data() }));
      const syllabus = syllabusSnap.docs.map(d => ({ id: d.id, ...d.data() }));
      // process and render
    });

- Add a document (admin pattern):
  db.collection('pyqs').add({ title, file })
    .then(docRef => { /* push { id: docRef.id, title, file } into local array */ });

- Update a document (admin pattern):
  db.collection('pyqs').doc(id).set({ title, file }, { merge: true })

- Delete a document:
  db.collection('syllabus').doc(id).delete()

Developer workflows & debugging tips
- Local testing: run the site by opening `index.html`/`admin.html` in a browser (it's a static frontend). Firebase client SDK requires the browser to be able to reach Firebase; ensure your firebaseConfig in `script.js`/`admin.js` is correct.
- If you change collection names or document fields: update both `script.js` and `admin.js` and migrate Firestore data accordingly.
- Logging: use console.error/console.log in the exact files (`script.js`, `admin.js`) — the UI shows alerts for success/failure in admin flows.

What NOT to change without coordination
- Do not remove the compat Firebase script tags unless you also update the code to the modular SDK everywhere. Current code uses the compat API.
- Do not change the client-side auth model; admin actions are gated by Firebase Auth state in `admin.js`.

If you need to extend data or add features
- Follow the existing pattern: add a Firestore collection (plural), read it with `collection().get()`, map docs to objects with `id`, push into `allData`, then reuse rendering helpers.
- For search/filtering, prefer client-side filtering on the loaded arrays (as current app does). If the dataset grows large, migrate to Firestore queries and update UI to fetch incrementally.

Files to reference when coding
- `index.html` — homepage markup and SDK script tags
- `script.js` — homepage logic, data loading, render functions, bookmarks
- `admin.html` — admin UI markup and SDK script tags
- `admin.js` — authentication and admin CRUD operations

If anything is unclear, leave a short TODO comment in the relevant file (e.g. `// TODO: verify firestore collection 'pyqs' has 'course' field`) and ask the repo owner for the missing schema details.

Ask me if you want me to: update the code to use the modular SDK, add Firestore security rules examples, or add unit tests for the data-loading logic.
