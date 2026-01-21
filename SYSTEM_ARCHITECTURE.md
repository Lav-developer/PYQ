# System Architecture Diagram

## Complete Data Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                         USER'S BROWSER                          │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │          UPLOAD FORM (index.html)                       │   │
│  ├─────────────────────────────────────────────────────────┤   │
│  │                                                         │   │
│  │  ┌──────────────────────────────────────────────────┐  │   │
│  │  │ Select File (PDF/JPG/PNG, max 20MB)             │  │   │
│  │  └──────────────────────────────────────────────────┘  │   │
│  │                                                         │   │
│  │  ┌──────────────────────────────────────────────────┐  │   │
│  │  │ Title: {2023} Physics Paper 1     [Required]    │  │   │
│  │  └──────────────────────────────────────────────────┘  │   │
│  │                                                         │   │
│  │  ┌──────────────────┬──────────────────────────────┐  │   │
│  │  │ Course: B.Tech   │ Semester: 3rd Sem          │  │   │
│  │  └──────────────────┴──────────────────────────────┘  │   │
│  │                                                         │   │
│  │  ┌──────────────────────────────────────────────────┐  │   │
│  │  │ Description (optional): Mid-term exam           │  │   │
│  │  └──────────────────────────────────────────────────┘  │   │
│  │                                                         │   │
│  │  ┌──────────────────────────────────────────────────┐  │   │
│  │  │ Email (optional): user@example.com              │  │   │
│  │  └──────────────────────────────────────────────────┘  │   │
│  │                                                         │   │
│  │              [Upload File] (Button)                    │   │
│  │                                                         │   │
│  └─────────────────────────────────────────────────────────┘   │
│                          ▼                                      │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ VALIDATION (script.js)                                  │   │
│  ├─────────────────────────────────────────────────────────┤   │
│  │ ✓ File exists and size < 20MB                          │   │
│  │ ✓ File type is PDF/JPG/PNG                             │   │
│  │ ✓ Title is not empty                                   │   │
│  │ ✓ Required fields filled                               │   │
│  └─────────────────────────────────────────────────────────┘   │
│                          ▼                                      │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ Prepare FormData (multipart/form-data)                 │   │
│  │ POST /.netlify/functions/upload                        │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
                           │ HTTPS POST
                           │ Encrypted data
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│                    NETLIFY PLATFORM                             │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │ SERVERLESS FUNCTION (netlify/functions/upload.js)      │  │
│  ├──────────────────────────────────────────────────────────┤  │
│  │                                                          │  │
│  │ 1. Receive multipart/form-data                          │  │
│  │    - Extract file from request                          │  │
│  │    - Parse form fields                                  │  │
│  │                                                          │  │
│  │ 2. Server-side Validation                               │  │
│  │    ✓ File type whitelist (PDF/JPG/PNG)                 │  │
│  │    ✓ File size limit (20MB)                             │  │
│  │    ✓ Required fields (title, file)                      │  │
│  │    ✓ No malicious content                               │  │
│  │                                                          │  │
│  │ 3. Build Telegram Message                               │  │
│  │    📚 Title: {2023} Physics Paper 1                     │  │
│  │    📖 Course: B.Tech CSE                                │  │
│  │    📅 Semester: 3rd Semester                            │  │
│  │    📝 Description: Mid-term exam                        │  │
│  │    📧 Email: user@example.com                           │  │
│  │    📦 File Size: 2.45MB                                 │  │
│  │    ⏰ Time: Jan 21, 2026 10:30 AM                       │  │
│  │    ✅ Status: Pending Review                            │  │
│  │                                                          │  │
│  │ 4. Write to Temporary Storage                           │  │
│  │    - Save file to /tmp                                  │  │
│  │                                                          │  │
│  │ 5. Send to Telegram API                                 │  │
│  │    POST /sendDocument                                   │  │
│  │    - Attach file                                        │  │
│  │    - Include metadata caption                           │  │
│  │                                                          │  │
│  │ 6. Cleanup & Response                                   │  │
│  │    - Delete temp file                                   │  │
│  │    - Return success/error JSON                          │  │
│  │                                                          │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                                 │
│  Environment Variables (Secured)                               │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │ TELEGRAM_BOT_TOKEN = 123456:ABC-DEF1234ghIkl-zyx...   │  │
│  │ TELEGRAM_CHAT_ID = 987654321                            │  │
│  │ (Never exposed to frontend)                             │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
                           │ HTTPS POST
                           │ api.telegram.org/bot...
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│                    TELEGRAM API                                 │
├─────────────────────────────────────────────────────────────────┤
│  - Validates bot token                                          │
│  - Virus scans file                                             │
│  - Stores file in Telegram servers                              │
│  - Sends to chat                                                │
└─────────────────────────────────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│                   TELEGRAM CHAT                                 │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│ Message from Bot:                                               │
│ ┌─────────────────────────────────────────────────────────┐    │
│ │ 📚 **New File Upload**                                  │    │
│ │                                                         │    │
│ │ 📖 Title: {2023} Physics Paper 1                       │    │
│ │ 📚 Course: B.Tech CSE                                  │    │
│ │ 📅 Semester: 3rd Semester                              │    │
│ │ 📝 Description: Mid-term exam                          │    │
│ │ 📧 Uploader: user@example.com                          │    │
│ │ 📦 File Size: 2.45MB                                   │    │
│ │ ⏰ Time: Jan 21, 2026 10:30 AM                         │    │
│ │ ✅ Status: Pending Review                              │    │
│ │                                                         │    │
│ │ [View File] [Download]                                 │    │
│ └─────────────────────────────────────────────────────────┘    │
│                                                                 │
│ → Admin reviews file                                            │
│ → Approves quality/relevance                                    │
│ → Extracts and adds to Firestore                                │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
                           │
                           ▼ (Manual or automated)
┌─────────────────────────────────────────────────────────────────┐
│                    FIREBASE FIRESTORE                           │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Collection: "pyqs" or "syllabus"                               │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ Document:                                               │   │
│  │ {                                                       │   │
│  │   title: "{2023} Physics Paper 1",                     │   │
│  │   file: "https://storage.../document.pdf",            │   │
│  │   course: "B.Tech CSE",                                │   │
│  │   semester: "3rd Semester",                            │   │
│  │   year: 2023,                                          │   │
│  │   uploadedAt: Timestamp,                               │   │
│  │   uploadedBy: "user@example.com"                       │   │
│  │ }                                                       │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│              WEBSITE DISPLAYS NEW CONTENT                       │
├─────────────────────────────────────────────────────────────────┤
│  - Visible in PYQ/Syllabus lists                                │
│  - Searchable                                                   │
│  - Bookmarkable                                                 │
│  - Shareable                                                    │
│  - Viewable                                                     │
└─────────────────────────────────────────────────────────────────┘
```

---

## Response Flow (Back to User)

```
After upload submission:

┌─ Successful Upload ─┐
│                     ▼
│  {"success": true,
│   "message": "File uploaded successfully!",
│   "fileName": "physics.pdf"}
│        │
│        ▼
│  Browser receives
│        │
│        ▼
│  Show green success message
│  "✅ File uploaded successfully!
│   Our team will review and add
│   it to the collection."
│        │
│        ▼
│  Auto-hide after 5 seconds
│        │
│        ▼
│  Form reset for next upload
│
├─ Failed Upload ─┐
│                 ▼
│  {"error": "File too large..."}
│        │
│        ▼
│  Browser receives
│        │
│        ▼
│  Show red error message
│  "❌ File too large.
│   Maximum 20MB allowed."
│        │
│        ▼
│  User can retry
```

---

## Security Layers

```
Layer 1: Browser Validation (UI)
├─ File size check
├─ File type verification
└─ Required field validation

Layer 2: Network Security
├─ HTTPS encryption
├─ No sensitive data in URL
└─ Secure cookie handling

Layer 3: Server Validation
├─ File type whitelist (PDF/JPG/PNG)
├─ File size limit enforcement
├─ Content scanning
└─ Required fields verification

Layer 4: Secret Management
├─ Bot token in environment variables
├─ Never in code/git
├─ Netlify encryption
└─ Server-side only access

Layer 5: Telegram Security
├─ API authentication
├─ Bot token validation
├─ Rate limiting
└─ Malware scanning
```

---

## Component Interactions

```
┌──────────────┐
│  index.html  │  ◄── Upload form markup
└──────────────┘
       │
       ├──────────────────┐
       │                  │
       ▼                  ▼
┌──────────────┐   ┌──────────────┐
│  script.js   │   │ styles.css   │  ◄── Form behavior & styling
└──────────────┘   └──────────────┘
       │                  │
       │         ┌────────┴─────────┐
       │         │                  │
       │         ▼                  ▼
       │    ┌──────────────┐  ┌──────────────────┐
       │    │  admin.html  │  │ upload-styles.css│  ◄── Additional styling
       │    └──────────────┘  └──────────────────┘
       │         │
       │         ▼
       │    ┌──────────────┐
       │    │  admin.js    │  ◄── Admin functions
       │    └──────────────┘
       │
       └─► Form submission (event listener in script.js)
                   │
                   ▼
           FormData object
                   │
                   ▼
           /.netlify/functions/upload
                   │
                   ├──────────────────────────────┐
                   │                              │
                   ▼                              ▼
    netlify/functions/upload.js        Telegram Bot API
                   │                              │
                   └──────────────────┬───────────┘
                                      │
                                      ▼
                             Response to browser
                                      │
                                      ▼
                          Display success/error
```

---

## Deployment Environment

```
Your Local Machine
        │
        ├─► GitHub (version control)
        │        │
        │        ▼
        │   Netlify Build
        │        │
        ├───────┼─────────────────────┐
        │       │                     │
        ▼       ▼                     ▼
    .         Build Output       Netlify
    Files      │                  Functions
              ├─► HTML/CSS/JS   ├─► upload.js
              ├─► Images         └─► Environment vars
              └─► Static files

                        │
                        ▼
                        
              Your Live Website
              https://your-site.netlify.app/
                        │
                        ├─► Upload Form (Public)
                        │
                        └─► Telegram Bot (Private)
                             │
                             ▼
                        Telegram Chat
                        (Admin only)
```

---

## Data Flow Summary

| Step | Component | Action | Time |
|------|-----------|--------|------|
| 1 | Browser | User selects file & fills form | Manual |
| 2 | Browser | Validates form locally | < 100ms |
| 3 | Browser | Creates FormData | < 50ms |
| 4 | Network | Sends HTTPS POST | 50-500ms |
| 5 | Function | Receives request | 1-5ms |
| 6 | Function | Validates file | 10-50ms |
| 7 | Function | Prepares message | 5-10ms |
| 8 | Function | Sends to Telegram | 500-2000ms |
| 9 | Function | Returns response | 5-10ms |
| 10 | Browser | Shows message to user | < 500ms |
| **Total** | **From click to success** | **~1-3 seconds** | **End-to-end** |

---

## Failsafe Mechanisms

```
Problem: File upload fails
           │
           ├─► Invalid file type
           │   └─► Server rejects → Error message
           │
           ├─► File too large
           │   └─► Server rejects → Error message
           │
           ├─► Missing fields
           │   └─► Browser validation → Form highlights error
           │
           ├─► Network error
           │   └─► Browser catches → "Network error" message
           │
           ├─► Telegram API down
           │   └─► Server timeout → "Try again later" message
           │
           └─► Bot token invalid
               └─► Server logs error → Admin notified
```

---

**System Version**: 1.0.0  
**Diagram Created**: January 21, 2026  
**Status**: Production Ready ✅
