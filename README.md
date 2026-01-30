# DSMNRU Academic Archive (PYQ + Syllabus)

A modern, feature-rich platform for browsing and downloading Previous Year Question Papers (PYQs), syllabi, and academic resources for DSMNRU students.

## 🌟 Features

### **For Students**
- 📚 **Browse PYQs & Syllabus** - Search, filter, and download academic materials
- 🔖 **Bookmarks** - Save your favorite papers for quick access
- 🔍 **Smart Search** - Find papers by course, year, and semester
- 📖 **PDF Viewer** - Preview papers inline
- 📤 **Share Documents** - Easy sharing via social media & links
- 📤 **Upload Papers** - Contribute your own question papers and notes
- 🧮 **SGPA Calculator** - Calculate semester GPA with subject-wise grades
- 📅 **Study Planner** - Plan and track your study schedule
- ✓ **Attendance Tracker** - Monitor attendance records
- 🌐 **Progressive Web App** - Works offline with service worker support
- 💬 **Live Chat** - Real-time support for students

### **For Admins**
- ➕ **Add/Edit/Delete Content** - Manage PYQs and Syllabus easily
- 👥 **User Submissions** - Review and approve student-uploaded content
- 📊 **Lazy Loading UI** - Fast admin panel with on-demand data loading
- 🗂️ **Collapsible Sections** - Organize with accordion interface
- 📁 **Pending Uploads** - Queue system for student submissions
- 🗺️ **Sitemap Generation** - Auto-generate sitemaps for SEO

---

## 📂 Project Structure

```
.
├── index.html                 # Public homepage & student UI
├── admin.html                 # Admin dashboard (Firebase auth required)
├── script.js                  # Frontend logic (data loading, search, bookmarks, uploads)
├── admin.js                   # Admin functions (auth, CRUD, lazy loading, submissions)
├── styles.css                 # Dark theme styling
├── sw.js                      # Service worker (offline support)
├── manifest.json              # PWA manifest
├── offline.html               # Offline fallback page
├── robots.txt                 # SEO robots configuration
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
- **`pyqs`** - Previous Year Question Papers
  - Fields: `title`, `file` (URL), `id`, `year`
  
- **`syllabus`** - Course Syllabus
  - Fields: `title`, `file` (URL), `course`, `semester`, `id`

- **`pendingUploads`** - Student Submissions (awaiting review)
  - Fields: `title`, `downloadUrl`, `studentName`, `course`, `semester`, `fileName`, `uploadedAt`, `status`

### **Local Storage Keys**
- `dsmnruBookmarks` - Saved paper URLs
- `dsmnruStudyPlanner` - Study schedule entries
- `dsmnruAttendance` - Attendance records
- `dsmnruCgpaLast` - Last CGPA calculation
- `quickPyq` - Quick access toggle
- `quickSyllabus` - Quick access toggle
- `quickSearch` - Quick access toggle
- `quickUpload` - Quick access toggle

---

## 📤 Student Upload System

### How Students Upload

1. **Access Upload Form** - Scroll to "Help us grow the collection" section on homepage
2. **Fill Form:**
   - **Title** (required) - e.g., "CSE 301 {2023}"
   - **Course** (optional) - e.g., "CSE 301"
   - **Semester** (optional) - e.g., "6th"
   - **PDF File** (required) - Select PDF (max 50MB)
   - **Your Name** (required) - Enter your full name
3. **Submit** - File uploads to temporary storage
4. **Confirmation** - Get success message with contribution credit

### How It Works Behind the Scenes

1. PDF file → uploaded to **tmpfiles.org** (temporary storage, auto-expires)
2. Metadata saved to Firestore `pendingUploads` collection
3. Admin reviews in dashboard
4. Admin downloads and uploads to personal cloud storage
5. Admin adds external link to main collection
6. Student contribution is credited

### Why This Approach?

✅ **Zero Firebase Storage cost** - No quota consumption  
✅ **No space limitations** - Unlimited submissions  
✅ **Quality control** - Admin reviews before publishing  
✅ **Student crediting** - Contributor name displayed  
✅ **Temporary staging** - Clean workflow for admin  
✅ **Auto-cleanup** - Files auto-expire after retention period  

---

## 👨‍💼 Admin Features

### Login & Authentication
1. Go to `admin.html`
2. Sign in with Firebase email/password (admin account required)
3. Dashboard loads with lazy-loading sections

### Managing Content

**Add New PYQ:**
- Click "Add New PYQ" accordion
- Enter title (e.g., "CSE 301 {2023}")
- Paste file URL (from Google Drive, OneDrive, etc.)
- Click "Add PYQ"

**Add New Syllabus:**
- Click "Add New Syllabus" accordion
- Enter title, file URL
- Optionally add course & semester
- Click "Add Syllabus"

**Edit Content:**
- Expand "Manage PYQs" or "Manage Syllabus"
- Click "Edit" button on any item
- Update and save changes

**Delete Content:**
- Click "Delete" button on any item
- Confirm deletion

### Processing Student Uploads

**Workflow:**
1. Student uploads PDF from homepage with name & metadata
2. File stored temporarily on **tmpfiles.org** (available for hours)
3. Admin sees upload in "Pending User Uploads" section with student name
4. Admin clicks "Download" to save PDF locally
5. Admin uploads PDF to personal cloud storage (Google Drive, OneDrive, etc.)
6. Admin adds the external link to main PYQ/Syllabus collection
7. Admin clicks "Delete" to remove from pending queue
8. Student sees their contribution credited on homepage

---

## 🎨 Styling & Theme

**Dark Theme Colors:**
- Primary: Teal/Cyan (`#32b8c6`, `#2da6b2`)
- Background: Charcoal (`#1f2121`, `#262828`)
- Text: Light Gray (`#f5f5f5`)
- Accent: Teal gradient

**CSS Variables** defined in `styles.css` for easy customization:
- `--color-primary` - Primary color
- `--color-background` - Page background
- `--color-surface` - Card/section background
- `--color-text` - Text color

---

## 🔐 Firestore Security Rules

```javascript
rules_version = '2';

service cloud.firestore {
  match /databases/{database}/documents {
    
    // Helper: Check if user is admin
    function isAdminByEmail() {
      return request.auth != null
             && request.auth.token.email == "your-email@gmail.com";
    }

    // Public read, admin write only
    match /pyqs/{doc} {
      allow read: if true;
      allow write: if isAdminByEmail();
    }

    match /syllabus/{doc} {
      allow read: if true;
      allow write: if isAdminByEmail();
    }

    // Public submissions, admin review only
    match /pendingUploads/{doc} {
      allow read: if isAdminByEmail();
      allow create: if request.resource.data.title is string
                    && request.resource.data.studentName is string
                    && request.resource.data.downloadUrl is string;
      allow update, delete: if isAdminByEmail();
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
- `manifest.json` - PWA configuration
- `offline.html` - Fallback offline page

**To install:**
- Open on mobile/desktop
- "Add to Home Screen" option appears
- Works offline with cached content

---

## 🔍 SEO

- Auto-generated `sitemap.xml` from admin panel
- SEO metadata in `index.html` (title, description, OG tags)
- Structured data (JSON-LD) for schema.org
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
**Solution:** Ensure Firebase config is correct in `admin.html` and email is registered as admin

### Issue: Changes not showing
**Solution:** Clear browser cache (Ctrl+Shift+Delete) and refresh

### Issue: Uploads not appearing
**Solution:** Check Firestore rules allow unauthenticated creates to `pendingUploads`

### Issue: Offline features not working
**Solution:** Service worker needs HTTPS in production (works on localhost)

### Issue: File upload fails
**Solution:** Check CORS configuration and Firestore security rules for `pendingUploads`

---

## 📚 Firebase Setup

1. Create Firebase project
2. Enable Firestore Database
3. Copy config to `script.js`, `admin.js`, `admin.html`
4. Create two collections: `pyqs` and `syllabus`
5. Create admin user account
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

- 💬 **Live Chat** - Click chat button on site for instant support
- 📧 **Email** - Contact via website contact form
- 🐛 **Report Issues** - Use feedback form or contact admin

---

## 🎯 Future Enhancements

- [ ] User accounts & profiles
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
- Use the SGPA calculator regularly to track performance
- Bookmark important papers for quick access
- Use the study planner to organize preparation
- Contribute quality notes and papers
- Share with classmates using the share feature

**For Admins:**
- Review submissions regularly to keep platform updated
- Organize PDFs logically in personal cloud storage
- Use consistent naming conventions for PDFs
- Delete processed uploads to keep pending list clean
- Generate sitemap monthly for SEO benefits

---

**Built with ❤️ for DSMNRU Students** 🎓
