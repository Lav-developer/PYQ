# DSMNRU Academic Archive (PYQ + Syllabus)

A small Dynamic website to browse and download Previous Year Question Papers (PYQs) and syllabi for DSMNRU students.

This repository is a static site (no build step). The public UI reads content from Firestore at runtime and stores small client-side state in localStorage for features like bookmarks and tools.

Quick links

- Public UI: `index.html`
- Admin UI: `admin.html` (Firebase email/password sign-in)
- Client JS: `script.js` (data loading, rendering, bookmarks, student tools)
- Admin JS: `admin.js` (auth + CRUD)
- Styles: `styles.css`

Local development

Open `index.html` directly in a browser for a quick preview, or run a tiny static server from the repository root (PowerShell examples):

```powershell
# From the repo root
python -m http.server 8000
# or (Node)
npx serve .
```

Data sources

- Firestore: public content is stored in two collections named `pyqs` and `syllabus`. The client reads those collections using the Firebase compat SDK. The Firebase config is embedded in `index.html` / `script.js` / `admin.js`.
- localStorage: used for small client-side state with keys such as:
  - `dsmnruBookmarks` — bookmarked file URLs
  - `dsmnruStudyPlanner` — study planner entries
  - `dsmnruAttendance` — attendance records
  - `dsmnruCgpaLast` — last CGPA calculation

Note: The project does NOT use `data.json`. Any references to `data.json` in older documentation are outdated and can be ignored.

Admin / editing content

- Use `admin.html` to sign in (Firebase email/password). After signing in you can add, edit, and delete documents in the `pyqs` and `syllabus` collections. `admin.js` uses `add()`, `doc(id).set(..., {merge:true})`, and `doc(id).delete()`.
