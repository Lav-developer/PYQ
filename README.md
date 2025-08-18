# DSMNRU Academic Archive - Enhanced with Syllabus Support

[![Netlify Status](https://api.netlify.com/api/v1/badges/your-badge-id/deploy-status)](https://dsmnru-pyq.netlify.app)

A modern, comprehensive archive for **Dr. Shakuntala Misra National Rehabilitation University (DSMNRU)** academic resources including Previous Year Question Papers (PYQs) and Syllabus. Easily browse, preview, and download academic materials for B.Tech, B.Sc, and other courses.

🌐 **Official Website:** [https://dsmnru-pyq.netlify.app](https://dsmnru-pyq.netlify.app)

---

## ✨ Features

### 📚 Dual Content Sections
- **Previous Year Questions**: Browse and download question papers from various semesters
- **Syllabus Collection**: Access comprehensive syllabus for all courses and semesters

### 🔍 Advanced Search & Filtering
- **Universal Search**: Search across both PYQs and syllabus
- **Smart Filters**: Filter by course, year, semester, and more
- **Tab-based Navigation**: Seamlessly switch between PYQs and Syllabus

### 🎯 Enhanced User Experience
- **PDF Preview**: View documents directly in browser before downloading
- **One-click Download**: Download papers and syllabus with single click
- **Social Sharing**: Share resources via WhatsApp, Telegram, or Email
- **Responsive Design**: Works perfectly on desktop, tablet, and mobile
- **Dark Academia Theme**: Beautiful, modern UI with enhanced readability

### 📤 Contribution Features
- **Community Upload**: Upload resources via Telegram bot
- **Newsletter Subscription**: Get notified about new uploads
- **Contributors Recognition**: Hall of fame for content providers

### 🚀 Technical Features
- **Fast Loading**: Optimized performance with lazy loading
- **SEO Optimized**: Better discoverability on search engines
- **Keyboard Shortcuts**: Quick navigation (Ctrl/Cmd+K for search)
- **Analytics Ready**: Built-in tracking for popular content

---

## 🗂️ Project Structure

```
.
├── data.json                    # Enhanced data structure with PYQs and Syllabus
├── files/                       # Organized PDF files
│   ├── Papers/                 # B.Tech question papers
│   └── Syllabus/               # Syllabus files
├── index.html                   # Enhanced main page with tabs
├── script.js                    # Enhanced JavaScript functionality
├── styles.css                   # Modern dark academia styling
├── sitemap.xml                  # SEO sitemap
├── robots.txt                   # Search engine directives
└── README.md                    # This documentation
```

---

## 🚀 Enhanced Data Structure

The new `data.json` supports both question papers and syllabus:

```json
{
  "pyqs": [
    {
      "title": "B.Tech 2nd Sem EEE {2024-25}",
      "file": "/files/Papers/2nd_Sem_2024-25/EEE_2nd_sem_2024-25.pdf"
    }
  ],
  "syllabus": [
    {
      "title": "B.Tech CSE 1st Semester Syllabus {2024-25}",
      "file": "/files/Syllabus/B.Tech/CSE_1st_sem_syllabus_2024-25.pdf",
      "course": "B.Tech CSE",
      "semester": "1st Semester",
      "year": "2024-25"
    }
  ]
}
```

---

## 🛠️ Getting Started

### 1. Clone the Repository

```bash
git clone https://github.com/your-username/dsmnru-academic-archive.git
cd dsmnru-academic-archive
```

### 2. Local Development

Open `index.html` in your browser, or use a local server:

```bash
# Using Node.js serve
npx serve .

# Using Python
python -m http.server 8000

# Using PHP
php -S localhost:8000
```

### 3. File Organization

**For Question Papers:**
```
files/Papers/1st_Sem_2024-25/subject_name.pdf
```

**For Syllabus:**
```
files/Syllabus/B.Tech/course_semester_syllabus_year.pdf
```

---

## 📥 How to Contribute

### Add New Content

#### 1. Via Telegram Bot (Recommended)
Send your PDF to [@dsmnru_bot](https://t.me/dsmnru_bot) with format:
- **For PYQs**: `B.Tech/2nd Sem/Subject Name/2024-25`
- **For Syllabus**: `Syllabus/B.Tech CSE/1st Semester/2024-25`

#### 2. Manual Upload (For Contributors)
1. Place PDF in appropriate folder under `files/`
2. Add entry to `data.json`:

**For PYQs:**
```json
{
  "title": "Course Semester Subject {Year}",
  "file": "/files/path/to/file.pdf"
}
```

**For Syllabus:**
```json
{
  "title": "Course Semester Syllabus {Year}",
  "file": "/files/Syllabus/path/to/file.pdf",
  "course": "Course Name",
  "semester": "Semester",
  "year": "Academic Year"
}
```

### Website Improvements

- Fork repository
- Make changes
- Submit pull request
- Areas for contribution:
  - UI/UX improvements
  - New features
  - Bug fixes
  - Content organization
  - SEO optimization

---

## 🎨 Key Features Explained

### Tabbed Interface
- **PYQ Tab**: Browse previous year question papers with course and year filters
- **Syllabus Tab**: Access syllabus with course and semester filters
- **Unified Search**: Search across both content types

### Enhanced Filtering
- **Course Filters**: B.Tech, B.Sc, specific branches
- **Year Filters**: Academic years (2024-25, 2023-24, etc.)
- **Semester Filters**: 1st Sem, 2nd Sem, Complete Syllabus
- **Clear Filters**: Quick reset functionality

### Smart Search
- Search in titles, courses, subjects
- Real-time filtering as you type
- Case-insensitive matching
- Cross-tab search capability

### Responsive Design
- Mobile-first approach
- Optimized for all screen sizes
- Touch-friendly interface
- Consistent experience across devices

---

## 🏆 Contributors & Recognition

**Developers & Maintainers:**
- **Lav Kush** - Lead Developer, Content Uploader
- **Community Contributors** - Content Providers

**Content Contributors:**
- Gaurav Singh, Chanchal Chauhan, Sujeet Singh
- Vikash Chaurasia, Prashant Tripathi, Payal Maurya
- Yogesh Kumar, Ramakant Yadav, Ritesh Kumar
- And many more amazing contributors!

---

## 📞 Connect & Stay Updated

- **🌐 Website:** [https://dsmnru-pyq.netlify.app](https://dsmnru-pyq.netlify.app)
- **📱 Telegram:** [DSMNRU Updates](https://t.me/dsmnru_updates)
- **📺 YouTube:** [DSMNRU Channel](https://youtube.com/@dsmnruupdates)
- **💬 WhatsApp:** [Updates Channel](https://whatsapp.com/channel/0029Vat8KYICxoAmUBFMaO0t)
- **🤖 Upload Bot:** [@dsmnru_bot](https://t.me/dsmnru_bot)

---

## 📋 TODO & Future Enhancements

- [ ] Advanced search with metadata filtering
- [ ] Bookmark/Favorites system
- [ ] Download statistics and popular content
- [ ] User accounts and contribution tracking
- [ ] API for external integrations
- [ ] Offline PWA support
- [ ] Content rating and review system
- [ ] Bulk download functionality

---

## 📄 License

This project is open-source and free to use for educational purposes. All content is contributed by the DSMNRU student community.

---

## 🤝 Support the Project

- ⭐ Star this repository
- 🐛 Report bugs and suggest features
- 📤 Contribute your question papers and syllabus
- 📢 Share with fellow students
- 💝 Join our contributor community

---

> **"Empowering DSMNRU students with easy access to academic resources"**

Made with ❤️ for the DSMNRU student community