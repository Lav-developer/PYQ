<div align="center">
  <img src="img/Logo.png" alt="DSMNRU Archive Logo" width="120" />
  <h1>🎓 DSMNRU Academic Archive</h1>
  <p><i>A modern, feature-rich platform for browsing and downloading Previous Year Question Papers (PYQs), syllabi, and academic resources for DSMNRU students.</i></p>
  
  <a href="https://dsmnru-pyq.netlify.app/"><strong>Explore the Live App »</strong></a>
  <br />
  <br />

  [![HTML5](https://img.shields.io/badge/HTML5-E34F26?style=for-the-badge&logo=html5&logoColor=white)](https://developer.mozilla.org/en-US/docs/Web/HTML)
  [![CSS3](https://img.shields.io/badge/CSS3-1572B6?style=for-the-badge&logo=css3&logoColor=white)](https://developer.mozilla.org/en-US/docs/Web/CSS)
  [![JavaScript](https://img.shields.io/badge/JavaScript-F7DF1E?style=for-the-badge&logo=javascript&logoColor=black)](https://developer.mozilla.org/en-US/docs/Web/JavaScript)
  [![Firebase](https://img.shields.io/badge/Firebase-FFCA28?style=for-the-badge&logo=firebase&logoColor=black)](https://firebase.google.com/)
  [![PWA Ready](https://img.shields.io/badge/PWA-Ready-5A0FC8?style=for-the-badge&logo=pwa&logoColor=white)](https://web.dev/progressive-web-apps/)
</div>

<hr />

<details>
<summary>📖 <strong>Table of Contents</strong> (Click to expand)</summary>

- [🌟 Features](#-features)
- [📂 Project Structure](#-project-structure)
- [🚀 Quick Start](#-quick-start)
- [📡 Data & Firebase](#-data--firebase)
- [📤 Student Upload System](#-student-upload-system)
- [👨‍💼 Admin Features](#-admin-features)
- [🎨 Styling & Theme](#-styling--theme)
- [🔐 Firestore Security Rules](#-firestore-security-rules)
- [📱 Progressive Web App (PWA)](#-progressive-web-app-pwa)
- [🔍 SEO](#-seo)
- [🛠️ Development Workflow](#-development-workflow)
- [🚨 Common Issues & Fixes](#-common-issues--fixes)
- [🎯 Future Enhancements](#-future-enhancements)
- [💡 Tips for Best Results](#-tips-for-best-results)

</details>

<hr />

## 🌟 Features

### **For Students**
- � **User Authentication** - Secure sign-up and login with email/password and Google.
- 👤 **User Profiles** - Manage your name, course, and phone number.
- 📚 **Browse PYQs** - Search, filter, and download academic materials.
-  **Bookmarks** - Save your favorite papers for quick access
- 🔍 **Smart Search** - Find papers by course, year, and semester
- 📖 **PDF Viewer** - Preview papers inline
- 📤 **Share Documents** - Easy sharing via social media & links
- 📤 **Upload Papers** - Contribute your own question papers and notes
- ️ **Student Tools** - A suite of utilities to help with academics:
  - **SGPA Calculator**: Calculate semester GPA with subject-wise grades.
  - **Study Planner**: Plan and track your study schedule.
  - **Attendance Tracker**: Monitor attendance records.
- 📝 **Feedback System** - Report broken links or request missing PYQs.
- 🌐 **Progressive Web App (PWA)** - Installable with offline access to cached content.
- 💬 **Live Chat** - Get real-time support.

### **For Admins**
- 🔑 **Secure Admin Login** - Role-based access control for the admin panel.
- ➕ **Add/Edit/Delete Content** - Manage PYQs and Syllabus easily
- 👥 **User Submissions** - Review and approve student-uploaded content
- 📊 **Lazy Loading UI** - Fast admin panel with on-demand data loading
- 🗂️ **Collapsible Sections** - Organize with accordion interface
- 📁 **Pending Uploads** - Queue system for student submissions
- 🗺️ **Sitemap Generation** - Auto-generate sitemaps for SEO

---


---

## 📂 Project Structure

<details>
<summary>Click to view folder structure</summary>

```
.
├── index.html                 # Public homepage & student UI
├── admin.html                 # Admin dashboard (Firebase auth required)
├── script.js                  # Frontend logic (auth, data loading, search, tools, uploads)
├── admin.js                   # Admin functions (auth, CRUD, lazy loading, submissions)
├── styles.css                 # Dark theme styling
├── sw.js                      # Service worker (offline support)
├── manifest.json              # PWA manifest
├── offline.html               # Offline fallback page
├── robots.txt                 # SEO crawler configuration
├── sitemap.xml                # SEO sitemap
├── cors.json                  # CORS configuration
└── img/                       # Images and assets
```

---

## 🚀 Quick Start

### Local Development

Open directly in browser (works out of box):
```bash
# Just open in browser
open index.html
# or admin.html for admin panel
```

Or run a local static server:

**Python:**
```bash
python -m http.server 8000
# Visit: http://localhost:8000
```

**Node:**
```bash
npx serve .
# Visit: http://localhost:3000
```

---

## 📡 Data & Firebase

### **Collections**
- **`pyqs`**: Stores Previous Year Question Papers.
  - Fields: `title`, `file` (Server 1 URL), `file2` (Server 2 URL), `course`, `semester`, `session`, `branch`.
- **`users`**: Stores registered user profiles.
  - Fields: `uid`, `email`, `name`, `course`, `phone`, `role`, `createdAt`.
- **`contributors`**: Manages the list of content contributors.
  - Fields: `name`, `avatar`, `role`.
- **`pendingUploads`**: A queue for student-submitted files awaiting admin review.
  - Fields: `title`, `downloadUrl`, `studentName`, `course`, `semester`, `fileName`, `uploadedAt`, `status`.
- **`feedback`**: Collects user feedback, including broken link reports and PYQ requests.
  - Fields: `type`, `title`, `details`, `status`, `createdAt`.

### **Local Storage Keys**
- `dsmnruBookmarks`: Saved paper URLs.
- `dsmnruStudyPlanner`: Study schedule tasks.
- `dsmnruAttendance`: Attendance records for subjects.
- `dsmnruCgpaLast`: Last CGPA calculation result.
- `profileCompletionDismissed`: Timestamp for dismissing the profile completion reminder.
- `dashboardTheme`, `dashboardLayout`: Admin dashboard UI preferences.

---

## 📤 Student Upload System

### How Students Upload

1.  **Access Upload Form**: Navigate to the "Help us grow the collection" section on the homepage.
2.  **Fill Form**:
    -   **Your Name** (required)
    -   **Title** (e.g., "Effective Technical Communication")
    -   **Course**, **Semester**
    -   **Select Files**: Choose a single PDF or multiple images (JPG, PNG).
3.  **Submit**: Images are automatically converted into a single, optimized PDF. The final PDF is uploaded to a temporary file-hosting service.
4.  **Confirmation**: A success message confirms the submission is sent for admin review.

### How It Works Behind the Scenes

1.  The final PDF (either uploaded directly or converted from images) is sent to **gofile.io**, a free and CORS-enabled file hosting service.
2.  The file's metadata and its `downloadUrl` are saved to the `pendingUploads` collection in Firestore.
3.  The admin reviews the submission in the dashboard's "Review Queue".
4.  The admin can download the file, verify its quality, and add it to the main `pyqs` collection.
5.  The student's name is credited for their contribution.

### Why This Approach?

✅ **Zero Firebase Storage Cost**: Avoids using Firebase Storage quotas.  
✅ **Flexible Uploads**: Supports both direct PDF and image-to-PDF conversion.  
✅ **Quality Control**: All submissions are reviewed by an admin before being published.  
✅ **Student Crediting**: The contributor's name is recorded with each submission.  
✅ **Clean Workflow**: A dedicated queue keeps submissions organized for the admin.

---

## 👨‍💼 Admin Features

### Login & Authentication
1.  Go to `admin.html`.
2.  Sign in with the designated admin email and password. Non-admin accounts are automatically logged out.
3.  The dashboard loads with live stats and collapsible management sections.

### Managing Content

**Add New PYQ:**
- Use the "Quick Create" form to add a new PYQ.
- The title is auto-generated from course, semester, subject, and session fields to ensure consistency.
- Provide up to two server URLs for the file.

**Bulk Import:**
- Upload a CSV file to add or update records in the `pyqs` or `contributors` collections.
- If a row has an `id`, the corresponding document is updated; otherwise, a new document is created.

**Edit & Delete:**
- Expand the "Content Library" to view all PYQs.
- Click "Edit" or "Delete" on any item to manage it.

### Processing Student Uploads

**Workflow:**
1.  Expand the "Review Queue" section in the admin panel.
2.  New submissions appear with the student's name, file details, and a download link.
3.  Click "Download" to get the file.
4.  After verifying, manually add it to the library using the "Quick Create" form.
5.  Click "Delete" to remove the submission from the queue.

---

## 🎨 Styling & Theme

The project features a modern, glassmorphism-inspired dark theme.

**CSS Variables** defined in `styles.css` for easy customization:
- `--color-primary`: The main accent color (teal).
- `--color-background`: The main page background.
- `--color-surface`: The background for cards and modals.
- `--color-text`: The primary text color.

---

## 🔐 Firestore Security Rules

```javascript
rules_version = '2';

service cloud.firestore {
  match /databases/{database}/documents {
    
    // Helper: Check if user is admin
    function isAdminByEmail() {
      return request.auth != null && request.auth.token.email == "kush210431@gmail.com";
    }

    // Public collections are world-readable, admin-writable.
    match /pyqs/{docId} {
      allow read: if true;
      allow write: if isAdminByEmail();
    }
    match /contributors/{docId} {
      allow read: if true;
      allow write: if isAdminByEmail();
    }

    // Users can read/write their own data. Admins have full access.
    match /users/{userId} {
      allow read, update: if request.auth.uid == userId || isAdminByEmail();
      allow create: if request.auth.uid == userId;
      allow delete: if isAdminByEmail();
    }

    // Anyone can submit to pendingUploads and feedback. Only admins can read/delete.
    match /pendingUploads/{docId} {
      allow read: if isAdminByEmail();
      allow create: if request.resource.data.title is string
                    && request.resource.data.studentName is string
                    && request.resource.data.downloadUrl is string;
      allow delete: if isAdminByEmail();
    }
    match /feedback/{docId} {
      allow read, update: if isAdminByEmail();
      allow create: if request.resource.data.type is string;
      allow delete: if isAdminByEmail();
    }

    // Deny all other access
    match /{document=**} {
      allow read: if false;
      allow write: if false;
    }
  }
}
```

---

## 📱 Progressive Web App (PWA)

The site works offline with service worker support:
- `sw.js` - Caches assets for offline access
- `manifest.json` - PWA metadata
- `offline.html` - Fallback offline page

**To install:**
- On a supported browser (like Chrome on desktop or mobile), an "Install" button will appear in the address bar.
- Once installed, the app can be launched from the home screen or app drawer.
- Cached content remains available even when offline.

---

## 🔍 SEO

- Auto-generated `sitemap.xml` from admin panel
- SEO metadata in `index.html` (title, description, OG tags)
- Structured data (JSON-LD) for rich search results
- `robots.txt` for search engine crawling

---

## 🛠️ Development Workflow

### Adding a New Feature

1. **Frontend:** Update `index.html` with new UI
2. **Logic:** Add JavaScript to `script.js`
3. **Styling:** Add CSS to `styles.css`
4. **Admin:** If needed, update `admin.html` and `admin.js`
5. **Test:** Run local server and verify

### Updating Data Flow

- Data loads from Firestore at runtime
- Use `db.collection('collectionName').get()` to fetch
- Save with `add()`, `set()`, `delete()` methods
- Update UI after data changes

---

## 🚨 Common Issues & Fixes

### Issue: Admin can't log in
**Solution:** Ensure the Firebase config is correct in `admin.html` and the email is hardcoded as the admin email in `admin.js`.

### Issue: Changes not showing
**Solution:** Clear browser cache (Ctrl+Shift+Delete) and refresh

### Issue: Uploads not appearing
**Solution:** Check that Firestore rules allow `create` operations on the `pendingUploads` collection.

### Issue: Offline features not working
**Solution:** Service worker needs HTTPS in production (works on localhost)

### Issue: File upload fails
**Solution:** Check CORS configuration and Firestore security rules for `pendingUploads`

---

## 📚 Firebase Setup

1. Create Firebase project
2. Enable Firestore Database
3. Copy config to `script.js`, `admin.js`, `admin.html`
4. Create initial collections: `pyqs`, `users`, `contributors`, `pendingUploads`, `feedback`.
5. Create an admin user account in Firebase Authentication.
6. Apply security rules from above
7. Deploy or run locally

**Firebase Config Location:**
```javascript
const firebaseConfig = {
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_AUTH_DOMAIN",
  projectId: "YOUR_PROJECT_ID",
  storageBucket: "YOUR_STORAGE_BUCKET",
  messagingSenderId: "YOUR_SENDER_ID",
  appId: "YOUR_APP_ID",
  measurementId: "YOUR_MEASUREMENT_ID"
};
```

---

## 📄 License

This project is built for DSMNRU students and contributors.

---

## 👥 Contributors

The heroes who made this archive possible! See homepage "Contributors" section. Thank you to all students who have contributed PYQs and resources!

---

## 📞 Support

- 💬 **Live Chat**: Click the chat button on the site for instant support.
- 📝 **Feedback Forms**: Use the "Report Broken Link" or "Request PYQ" modals on the site.

---

## 🎯 Future Enhancements

- [ ] Rating & reviews for papers
- [ ] Paper difficulty levels
- [ ] Discussion forums
- [ ] Mobile app (React Native)
- [ ] Multiple language support
- [ ] Analytics dashboard for admins
- [ ] Email notifications for new uploads
- [ ] Advanced filtering by exam type
- [ ] Solution uploads alongside questions

---

## 💡 Tips for Best Results

**For Students:**
- Use the SGPA calculator to track your academic performance.
- Bookmark important papers for quick access before exams.
- Use the study planner to organize your preparation schedule.
- Contribute high-quality notes and papers to help the community.
- Share useful resources with classmates using the share feature.

**For Admins:**
- Review submissions regularly to keep the platform up-to-date.
- Organize PDFs logically in your cloud storage before linking them.
- Use consistent naming conventions for files and titles.
- Clear the pending queue after processing uploads.

---

**Built with ❤️ for DSMNRU Students** 🎓
