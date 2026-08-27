// Initialize Firebase
const firebaseConfig = {
    apiKey: "AIzaSyBRlsk-knQs-AMlaTFxlneBMTwlSfwyFaQ",
    authDomain: "dsmnru-data.firebaseapp.com",
    projectId: "dsmnru-data",
    storageBucket: "dsmnru-data.firebasestorage.app",
    messagingSenderId: "62250453477",
    appId: "1:62250453477:web:087c07403e4fead220470c",
    measurementId: "G-VL6V3T96YX"
};

firebase.initializeApp(firebaseConfig);

const auth = firebase.auth();
const db = firebase.firestore();
const storage = firebase.storage();
let allData = { pyqs: [], users: [], pendingUploads: [], contributors: [], feedback: [] };

// The signed-in admin (set in onAuthStateChanged after the rules-based admin
// check). Required before any submission review action.
let currentAdmin = null;

// ===== API CACHE INVALIDATION (Cloudflare Worker) =====
const API_BASE_URL = (function () {
    const raw = (typeof window.DSMNRU_API_URL !== 'undefined' && window.DSMNRU_API_URL)
        ? String(window.DSMNRU_API_URL).trim()
        : '';

    if (!raw) return 'https://dsmnru-pyq-api.kush210431-cloudflare.workers.dev/api';

    const trimmed = raw.replace(/\/+$/, '');
    return /\/api$/i.test(trimmed) ? trimmed : trimmed + '/api';
})();

async function invalidateApiCache() {
    // Content changed — invalidate duplicate matching index locally.
    if (typeof invalidateDuplicateIndex === 'function') {
        invalidateDuplicateIndex();
    }

    try {
        const user = auth.currentUser;

        if (!user) {
            console.warn('Cache invalidation skipped — admin is not signed in');
            return;
        }

        // Force-refresh the Firebase ID token so newly-added custom
        // claims such as admin:true are included.
        const idToken = await user.getIdToken(true);

        const response = await fetch(API_BASE_URL + '/invalidate', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${idToken}`
            }
        });

        if (response.ok) {
            console.log('API cache invalidated');
        } else {
            console.warn(
                'Cache invalidation failed:',
                response.status,
                await response.text()
            );
        }
    } catch (error) {
        console.warn('Cache invalidation error:', error);
    }
}
/**
 * Checks if a user is an admin by attempting to read a document
 * that only admins have access to, based on Firestore security rules.
 * This avoids exposing the admin email on the client-side.
 * @param {firebase.User} user The user to check.
 * @returns {Promise<boolean>} A promise that resolves to true if the user is an admin, false otherwise.
 */
async function isAdminUser(user) {
    if (!user) {
        return false;
    }
    try {
        // Attempt to read a document that is admin-only according to security rules.
        // We use a non-existent doc to minimize data transfer.
        await db.collection('pendingUploads').limit(1).get(); // Check read permission on the collection
        return true; // Read succeeded, user is an admin.
    } catch (error) {
        // A "permission-denied" error is expected for non-admins.
        if (error.code === 'permission-denied') {
            return false; // Read failed, user is not an admin.
        }
        // For other errors (e.g., network), log it and deny access.
        console.error('Admin check failed with unexpected error:', error);
        return false;
    }
}

function updateCsvWidgetVisibility(user) {
    const csvWidget = document.getElementById('csvWidget');
    if (!csvWidget) {
        return;
    }

    // This function is now async, so we need to handle the promise.
    isAdminUser(user).then(isAdmin => {
        csvWidget.style.display = isAdmin ? 'flex' : 'none';
        csvWidget.setAttribute('aria-hidden', isAdmin ? 'false' : 'true');
    });
}

document.addEventListener('DOMContentLoaded', function() {
    setupSectionCollapseBehavior();
    updateCsvWidgetVisibility(null);

    // Load courses.json and populate admin selects
    fetchAdminCoursesJson();

    // Auth state listener
    auth.onAuthStateChanged(async (user) => {
        if (user) {
            const isUserAdmin = await isAdminUser(user);
            if (!isUserAdmin) {
                auth.signOut();
                updateCsvWidgetVisibility(null);
                document.getElementById('loginError').textContent = 'You do not have admin access.';
                document.getElementById('loginError').style.display = 'block';
                document.getElementById('loginSection').style.display = 'block';
                document.getElementById('adminSection').style.display = 'none';
                return; // Stop execution for non-admins
            }
            // User is signed in
            currentAdmin = user;
            updateCsvWidgetVisibility(user);
            document.getElementById('loginSection').style.display = 'none';
            document.getElementById('adminSection').style.display = 'block';
            setAdminIdentity(user);
            loadData();
            showAdminView(window.location.hash.replace('#', '') || 'dashboard');
        } else {
            // User is signed out
            currentAdmin = null;
            updateCsvWidgetVisibility(null);
            resetLazyLoadState();
            document.getElementById('loginSection').style.display = 'block';
            document.getElementById('adminSection').style.display = 'none';
        }
    });

    // Login form
    document.getElementById('loginForm').addEventListener('submit', function(e) {
        e.preventDefault();
        const email = document.getElementById('email').value;
        const password = document.getElementById('password').value;
        const errorDiv = document.getElementById('loginError');

        auth.signInWithEmailAndPassword(email, password)
            .then(() => {
                errorDiv.style.display = 'none';
            })
            .catch(error => {
                errorDiv.textContent = error.message;
                errorDiv.style.display = 'block';
            });
    });

    // Logout
    document.getElementById('logoutBtn').addEventListener('click', function() {
        auth.signOut();
    });

    // Generate sitemap button
    // const genBtn = document.getElementById('generateSitemapBtn');
    // if (genBtn) {
    //     genBtn.addEventListener('click', function() {
    //         if (!auth.currentUser) {
    //             alert('You must be signed in to generate the sitemap.');
    //             return;
    //         }
    //         generateSitemap();
    //     });
    // }

    // Add PYQ form
    document.getElementById('addPyqForm').addEventListener('submit', async function(e) {
        e.preventDefault();
        const course = document.getElementById('pyqCourse').value.trim();
        const semester = document.getElementById('pyqSemester').value.trim();
        const subject = document.getElementById('pyqSubject').value.trim();
        const session = document.getElementById('pyqSession').value.trim();
        const branch = document.getElementById('pyqBranch').value.trim();
        const file = document.getElementById('pyqFile').value;
        const file2 = document.getElementById('pyqFile2').value.trim();

        if (!course || !semester || !subject || !session || !file) {
            alert('Please fill in course, semester, subject, session, and file URL.');
            return;
        }

        let currentSubject = subject;
        let title = buildPyqTitle(course, branch, semester, currentSubject, session);
        let duplicateExists = await pyqTitleExists(title);

        if (duplicateExists === null) {
            return;
        }

        while (duplicateExists) {
            const shouldRename = confirm(
                `A PYQ with this title already exists:\n\n${title}\n\nDo you want to provide another subject name?`
            );

            if (!shouldRename) {
                return;
            }

            const alternativeSubject = prompt('Enter another subject name for this PYQ:', currentSubject);
            if (alternativeSubject === null) {
                return;
            }

            currentSubject = alternativeSubject.trim();
            if (!currentSubject) {
                alert('Subject name cannot be empty.');
                continue;
            }

            title = buildPyqTitle(course, branch, semester, currentSubject, session);

            duplicateExists = await pyqTitleExists(title);
            if (duplicateExists === null) {
                return;
            }
        }

        addItem('pyqs', {
            title,
            file,
            file2: file2 || '',
            course,
            semester,
            subject: currentSubject,
            session,
            branch: branch || '',
            description: buildPyqDescription(title),
            views: 0,
            createdAt: firebase.firestore.FieldValue.serverTimestamp()
        });
        this.reset();
    });

    const csvImportForm = document.getElementById('csvImportForm');
    if (csvImportForm) {
        csvImportForm.addEventListener('submit', async function(e) {
            e.preventDefault();

            const collectionSelect = document.getElementById('csvImportCollection');
            const fileInput = document.getElementById('csvImportFile');
            const selectedCollection = collectionSelect ? collectionSelect.value.trim() : '';
            const csvFile = fileInput && fileInput.files ? fileInput.files[0] : null;

            if (!selectedCollection) {
                alert('Please select a collection to import into.');
                return;
            }

            if (!csvFile) {
                alert('Please choose a CSV file.');
                return;
            }

            if (!window.Papa) {
                alert('CSV parser is not available right now. Please reload the page and try again.');
                return;
            }

            try {
                const csvText = await readFileAsText(csvFile);
                const parsed = window.Papa.parse(csvText, {
                    header: true,
                    skipEmptyLines: true,
                    transformHeader: header => header.trim()
                });

                if (parsed.errors && parsed.errors.length) {
                    throw new Error(parsed.errors[0].message || 'Unable to parse CSV.');
                }

                const rows = Array.isArray(parsed.data) ? parsed.data : [];
                if (!rows.length) {
                    alert('No rows found in the CSV file.');
                    return;
                }

                let addedCount = 0;
                let updatedCount = 0;
                let skippedCount = 0;

                for (const row of rows) {
                    const normalizedRow = normalizeCsvRow(row);
                    const rowCollection = normalizeCsvText(normalizedRow.collection) || selectedCollection;
                    const docId = normalizeCsvText(normalizedRow.id);

                    if (!rowCollection) {
                        skippedCount++;
                        continue;
                    }

                    const payload = buildCsvImportPayload(normalizedRow);
                    delete payload.collection;
                    delete payload.id;

                    if (!Object.keys(payload).length) {
                        skippedCount++;
                        continue;
                    }

                    if (docId) {
                        await db.collection(rowCollection).doc(docId).set(payload, { merge: true });
                        updatedCount++;
                    } else {
                        await db.collection(rowCollection).add(payload);
                        addedCount++;
                    }
                }

                await refreshCollectionAfterCsvImport(selectedCollection);
                csvImportForm.reset();
                alert(`CSV import complete. Added ${addedCount}, updated ${updatedCount}, skipped ${skippedCount}.`);
            } catch (error) {
                console.error('Error importing CSV:', error);
                alert('Error importing CSV: ' + (error && error.message ? error.message : 'Please try again.'));
            }
        });
    }

    // Edit PYQ form submit handler — now supports id (from editPyqById) or old index
    const editForm = document.getElementById('editForm');
    if (editForm) {
        editForm.addEventListener('submit', function(e) {
            e.preventDefault();
            const type = document.getElementById('editType').value;
            const rawIndex = document.getElementById('editIndex').value;
            const title = document.getElementById('editTitle').value.trim();
            const file = document.getElementById('editFile').value.trim();
            const file2 = document.getElementById('editFile2').value.trim();
            
            if (!title || !file) {
                alert('Title and File URL are required.');
                return;
            }

            // rawIndex may be an id (string) or old numeric index
            let idx = parseInt(rawIndex);
            let isId = isNaN(idx) || String(rawIndex).length > 6 || allData[type] && !allData[type][idx];
            if (isId) {
                // find by id
                const id = String(rawIndex).trim();
                idx = allData[type].findIndex(p => p.id === id);
                if (idx === -1) { alert('Item not found (maybe deleted). Refresh.'); return; }
            }
            if (type === 'pyqs') {
                const branch = document.getElementById('editBranch').value.trim();
                editItem(type, idx, { title, file, file2: file2 || '', branch: branch || '' });
            } else {
                editItem(type, idx, { title, file });
            }
            
            bootstrap.Modal.getInstance(document.getElementById('editModal')).hide();
        });
    }

});

// Admin: load courses.json and populate course select(s)
let adminCoursesList = [];
function fetchAdminCoursesJson() {
    fetch('courses.json')
        .then(res => {
            if (!res.ok) throw new Error('Unable to load courses.json');
            return res.json();
        })
        .then(data => {
            // courses.json has structure { courses: [...] }
            if (data && Array.isArray(data.courses)) {
                adminCoursesList = data.courses;
                populateAdminCourseSelects();
            }
        })
        .catch(err => {
            console.warn('admin: courses.json not loaded:', err.message);
        });
}

function populateAdminCourseSelects() {
    const select = document.getElementById('pyqCourse');
    if (!select) return;

    if (!adminCoursesList || !adminCoursesList.length) return;
    
    // Clear and rebuild options
    select.innerHTML = '';
    
    // Add placeholder option
    const placeholderOption = document.createElement('option');
    placeholderOption.value = '';
    placeholderOption.disabled = true;
    placeholderOption.selected = true;
    placeholderOption.textContent = 'Select course';
    select.appendChild(placeholderOption);
    
    // Add courses from courses.json
    adminCoursesList.forEach(course => {
        const label = typeof course === 'string' ? course : (course.name || course.label || '');
        if (!label) return;
        const opt = document.createElement('option');
        opt.value = label;
        opt.textContent = label;
        select.appendChild(opt);
    });
}

function setupSectionCollapseBehavior() {
    const adminSection = document.getElementById('adminSection');
    if (!adminSection || !window.bootstrap || !window.bootstrap.Collapse) {
        return;
    }

    const collapses = Array.from(adminSection.querySelectorAll('.section-card .collapse'));
    collapses.forEach(currentCollapse => {
        currentCollapse.addEventListener('show.bs.collapse', function() {
            collapses.forEach(otherCollapse => {
                if (otherCollapse === currentCollapse || !otherCollapse.classList.contains('show')) {
                    return;
                }

                window.bootstrap.Collapse.getOrCreateInstance(otherCollapse, { toggle: false }).hide();
            });
        });
    });
}

function loadData() {
    // Lazy: no server calls on login — each section fetches only when expanded.
    // This saves 50K reads + keeps admin snappy. Hero counts start at 0 and update as you open sections.
    updateDashboardStats();
    // Optional: show hint that counts are lazy
    ['pyqsCount','pendingCount','usersCount','contributorsCount','feedbackCount'].forEach(id => {
        const el = document.getElementById(id);
        if (el && el.textContent === '0') el.title = 'Click a section below to load — 0 reads until you expand';
    });
}

function resetLazyLoadState() {
    pyqsLoaded = false;
    pendingLoaded = false;
    usersLoaded = false;
    contributorsLoaded = false;
    feedbackLoaded = false;
    dashboardOverviewRequested = false;
    rewardsLoaded = false;
    knownPyqTotal = null;
    currentAdminView = null;
    closeAdminSidebar();
}

// function generateSitemap() {
//     // Build sitemap XML from allData
//     try {
//         const baseUrl = 'https://dsmnru-pyq.netlify.app/';
//         const urls = [];

//         // Add homepage
//         urls.push({ loc: baseUrl, priority: 1.0, changefreq: 'daily' });

//         // Add index.html explicitly
//         urls.push({ loc: baseUrl + 'index.html', priority: 0.9, changefreq: 'daily' });

//         // Add each PYQ file URL if present
//         allData.pyqs.forEach(item => {
//             if (item.file) urls.push({ loc: item.file, priority: 0.8, changefreq: 'monthly' });
//         });

//         const xmlParts = ['<?xml version="1.0" encoding="UTF-8"?>', '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'];
//         urls.forEach(u => {
//             xmlParts.push('  <url>');
//             xmlParts.push(`    <loc>${escapeXml(u.loc)}</loc>`);
//             if (u.changefreq) xmlParts.push(`    <changefreq>${u.changefreq}</changefreq>`);
//             if (u.priority !== undefined) xmlParts.push(`    <priority>${u.priority.toFixed(2)}</priority>`);
//             xmlParts.push('  </url>');
//         });
//         xmlParts.push('</urlset>');
//         const sitemapXml = xmlParts.join('\n');

//         // Download as file instead of uploading to Firebase
//         const blob = new Blob([sitemapXml], { type: 'application/xml' });
//         const url = URL.createObjectURL(blob);
//         const link = document.createElement('a');
//         link.href = url;
//         link.download = 'sitemap.xml';
//         document.body.appendChild(link);
//         link.click();
//         document.body.removeChild(link);
//         URL.revokeObjectURL(url);

//         updateSitemapStatus('done', 'sitemap.xml');
//         alert(`✓ Sitemap generated successfully!\n\nGenerated ${urls.length} URLs:\n- Homepage\n- ${allData.pyqs.length} PYQ items\n\nFile downloaded as sitemap.xml`);
//     } catch (err) {
//         console.error('Error generating sitemap:', err);
//         updateSitemapStatus('error');
//         alert('Error generating sitemap: ' + err.message);
//     }
// }

function escapeXml(unsafe) {
    return (unsafe || '').replace(/[<>&'\"]/g, function(c) {
        switch (c) {
            case '<': return '&lt;';
            case '>': return '&gt;';
            case '&': return '&amp;';
            case "'": return '&apos;';
            case '"': return '&quot;';
        }
    });
}

// function updateSitemapStatus(state, url) {
//     const container = document.getElementById('sitemapStatus');
//     const msg = document.getElementById('sitemapMessage');
//     const link = document.getElementById('sitemapUrl');
//     if (!container || !msg || !link) return;
//     if (state === 'ready') {
//         container.style.display = 'none';
//     } else if (state === 'uploading') {
//         container.style.display = 'block';
//         msg.textContent = 'Generating sitemap and uploading...';
//         link.style.display = 'none';
//     } else if (state === 'done') {
//         container.style.display = 'block';
//         msg.textContent = 'Sitemap uploaded. Public URL:';
//         link.href = url;
//         link.textContent = url;
//         link.style.display = 'block';
//     } else if (state === 'error') {
//         container.style.display = 'block';
//         msg.textContent = 'Error generating sitemap. See console.';
//         link.style.display = 'none';
//     }
// }

function renderLists() {
    renderPyqs();
    renderUsers();
    updateDashboardStats();
}

function updateDashboardStats() {
    const setCount = (id, value) => {
        const element = document.getElementById(id);
        if (element) {
            element.textContent = value;
        }
    };

    // `allData.pendingUploads` holds every submission (pending + reviewed);
    // the hero/header counts still mean "waiting for review".
    const counts = getSubmissionCounts();

    // Until a collection has been opened we show "—" (or the Worker API total
    // for PYQs, which costs no Firestore reads) instead of a misleading 0.
    const pyqTotal = pyqsLoaded ? allData.pyqs.length : (knownPyqTotal === null ? '—' : knownPyqTotal);
    setCount('pyqsCount', pyqTotal);
    setCount('pyqsHeaderCount', pyqTotal);
    setCount('usersCount', usersLoaded ? allData.users.length : '—');
    setCount('usersHeaderCount', usersLoaded ? allData.users.length : '—');
    setCount('pendingCount', counts.pending);
    setCount('pendingHeaderCount', counts.pending);
    setCount('submissionPendingCount', counts.pending);
    setCount('submissionApprovedCount', counts.approved);
    setCount('submissionRejectedCount', counts.rejected);
    setCount('contributorsCount', contributorsLoaded ? allData.contributors.length : '—');
    setCount('contributorsHeaderCount', contributorsLoaded ? allData.contributors.length : '—');

    // Sidebar badges: pending submissions and (once loaded) feedback.
    setNavBadge('navPendingBadge', counts.pending);
    setNavBadge('navFeedbackBadge', allData.feedback ? allData.feedback.length : 0);

    // Update feedback count if available
    const feedbackCountElement = document.getElementById('feedbackCount');
    if (feedbackCountElement) {
        feedbackCountElement.textContent = feedbackLoaded ? allData.feedback.length : '—';
    }
    const feedbackHeader = document.getElementById('feedbackHeaderCount');
    if (feedbackHeader) feedbackHeader.textContent = feedbackLoaded ? allData.feedback.length : '0';

    if (typeof updateStatLoadButtons === 'function') updateStatLoadButtons();
}

// Convert any Firestore value into a CSV-safe string (timestamps, arrays, objects)
function csvCellValue(value) {
    if (value === null || value === undefined) return '';
    if (typeof value.toDate === 'function') {
        try { return value.toDate().toISOString(); } catch (e) { return String(value); }
    }
    if (Array.isArray(value)) return value.map(v => csvCellValue(v)).join('; ');
    if (typeof value === 'object') {
        try { return JSON.stringify(value); } catch (e) { return String(value); }
    }
    return String(value);
}

function buildCsvContent(rows, columns) {
    const escapeCsv = value => {
        const text = csvCellValue(value);
        return `"${text.replace(/"/g, '""')}"`;
    };

    const header = columns.join(',');
    const lines = rows.map(row => columns.map(column => escapeCsv(row[column])).join(','));
    return [header, ...lines].join('\n');
}

function normalizeCsvText(value) {
    return (value === undefined || value === null ? '' : String(value)).trim();
}

function normalizeCsvRow(row) {
    const normalized = {};
    Object.entries(row || {}).forEach(([key, value]) => {
        const normalizedKey = key.toLowerCase().trim().replace(/[^a-z0-9]+/g, '');
        normalized[normalizedKey] = normalizeCsvText(value);
    });
    return normalized;
}

function buildCsvImportPayload(row) {
    const payload = {};
    const aliases = {
        title: 'title',
        server1: 'file',
        file: 'file',
        fileurl: 'file',
        file1: 'file',
        server2: 'file2',
        file2: 'file2',
        file2url: 'file2',
        course: 'course',
        semester: 'semester',
        session: 'session',
        subject: 'subject',
        branch: 'branch',
        name: 'name',
        role: 'role',
        avatar: 'avatar',
        email: 'email',
        phone: 'phone',
        uid: 'uid',
        status: 'status',
        downloadurl: 'downloadUrl',
        studentname: 'studentName',
        filename: 'fileName',
        createdat: 'createdAt',
        uploadedat: 'uploadedAt',
        signupname: 'signupName',
        signupemail: 'signupEmail',
        signupcourse: 'signupCourse'
    };

    Object.entries(row || {}).forEach(([key, value]) => {
        if (!value) {
            return;
        }

        const mappedKey = aliases[key] || key;
        if (mappedKey === 'collection' || mappedKey === 'id') {
            return;
        }

        payload[mappedKey] = value;
    });

    return payload;
}

function readFileAsText(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = function() {
            resolve(reader.result || '');
        };
        reader.onerror = function() {
            reject(new Error('Unable to read the CSV file.'));
        };
        reader.readAsText(file);
    });
}

async function refreshCollectionAfterCsvImport(collectionName) {
    if (collectionName === 'pyqs') {
        const snapshot = await db.collection('pyqs').get();
        allData.pyqs = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        renderLists();
        return;
    }

    if (collectionName === 'contributors') {
        const snapshot = await db.collection('contributors').orderBy('name').get();
        allData.contributors = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        renderLists();
        return;
    }

    if (collectionName === 'users') {
        const snapshot = await db.collection('users').orderBy('createdAt', 'desc').get();
        allData.users = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        renderLists();
        return;
    }

    if (collectionName === 'pendingUploads') {
        // Review queue now holds every submission (pending + reviewed).
        loadPendingUploads();
        renderLists();
    }
}

function downloadCsvFile(fileName, csvContent) {
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
}

function normalizeStoredLink(value) {
    const text = (value === undefined || value === null) ? '' : String(value).trim();
    return text && text.toLowerCase() !== 'null' ? text : '';
}

async function loadCollectionSnapshot(collectionName) {
    const snapshot = await db.collection(collectionName).get();
    return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
}

// All collections included in the CSV backup (order = order in the file)
const CSV_BACKUP_COLLECTIONS = ['pyqs', 'contributors', 'users', 'pendingUploads', 'feedback', 'comments'];

// Every field used by any collection — nothing gets silently dropped
const CSV_BACKUP_COLUMNS = [
    'collection', 'id', 'name', 'title', 'Server 1', 'Server 2', 'course', 'semester',
    'session', 'subject', 'branch', 'description', 'views', 'status', 'type', 'details',
    'text', 'paperId', 'userName', 'userEmail', 'downloadUrl', 'studentName',
    'studentCourse', 'studentEmail', 'userId', 'fileName', 'fileSize', 'email', 'phone',
    'role', 'avatar', 'uid', 'createdAt', 'uploadedAt'
];

// Flatten one Firestore doc into a full backup row
function buildCsvBackupRow(collection, doc) {
    return {
        collection: collection,
        id: doc.id || doc.uid || '',
        name: doc.name || doc.signupName || '',
        title: doc.title || '',
        'Server 1': doc.file || doc.server1 || '',
        'Server 2': doc.file2 || doc.server2 || '',
        course: doc.course || doc.signupCourse || '',
        semester: doc.semester || '',
        session: doc.session || '',
        subject: doc.subject || '',
        branch: doc.branch || '',
        description: doc.description || '',
        views: doc.views !== undefined && doc.views !== null ? doc.views : '',
        status: doc.status || '',
        type: doc.type || '',
        details: doc.details || '',
        text: doc.text || '',
        paperId: doc.paperId || '',
        userName: doc.userName || '',
        userEmail: doc.userEmail || '',
        downloadUrl: doc.downloadUrl || '',
        studentName: doc.studentName || '',
        studentCourse: doc.studentCourse || '',
        studentEmail: doc.studentEmail || '',
        userId: doc.userId || '',
        fileName: doc.fileName || '',
        fileSize: doc.fileSize || '',
        email: doc.email || doc.signupEmail || '',
        phone: doc.phone || '',
        role: doc.role || '',
        avatar: doc.avatar || '',
        uid: doc.uid || '',
        createdAt: doc.createdAt || '',
        uploadedAt: doc.uploadedAt || ''
    };
}

async function downloadAllCsvBackup() {
    try {
        // Always fetch fresh, complete snapshots — cached `allData` may be unloaded
        // (lazy sections) or filtered (e.g. pendingUploads only holds status=='pending').
        const results = await Promise.all(CSV_BACKUP_COLLECTIONS.map(name =>
            loadCollectionSnapshot(name).catch(err => {
                console.warn('CSV backup: could not read "' + name + '":', err.message);
                return null; // null = permission/read failure, [] = empty collection
            })
        ));

        const allRows = [];
        const summary = [];
        const failed = [];
        CSV_BACKUP_COLLECTIONS.forEach((name, i) => {
            const docs = results[i];
            if (docs === null) {
                failed.push(name);
                return;
            }
            docs.forEach(doc => allRows.push(buildCsvBackupRow(name, doc)));
            summary.push(name + ': ' + docs.length);
        });

        if (!allRows.length && failed.length) {
            alert('CSV backup failed — could not read: ' + failed.join(', ') + '. Make sure you are logged in as admin.');
            return;
        }

        const csv = buildCsvContent(allRows, CSV_BACKUP_COLUMNS);
        downloadCsvFile('database-backup.csv', csv);
        alert(
            'CSV backup downloaded.\n\n' + summary.join('\n') +
            (failed.length ? '\n\nCould not read (skipped): ' + failed.join(', ') : '') +
            '\n\nTotal rows: ' + allRows.length
        );
    } catch (error) {
        console.error('Error generating CSV backup:', error);
        alert('Failed to generate CSV backup: ' + error.message);
    }
}

window.downloadAllCsvBackup = downloadAllCsvBackup;

function escapeHtml(value) {
    return (value || '')
        .toString()
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function copyToClipboard(text) {
    const value = (text || '').toString();
    if (!value) {
        alert('Nothing to copy.');
        return;
    }

    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(value)
            .then(() => alert('Copied to clipboard.'))
            .catch(() => fallbackCopy(value));
        return;
    }

    fallbackCopy(value);
}

function fallbackCopy(value) {
    const tempInput = document.createElement('input');
    tempInput.value = value;
    document.body.appendChild(tempInput);
    tempInput.select();
    document.execCommand('copy');
    document.body.removeChild(tempInput);
    alert('Copied to clipboard.');
}

function renderPyqs() {
    const list = document.getElementById('pyqsList');
    if (!list) return;

    if (!allData.pyqs.length) {
        list.innerHTML = '<div class="resource-empty">No PYQs added yet.</div>';
        updateDashboardStats();
        return;
    }

    list.innerHTML = allData.pyqs.map((pyq, index) => {
        const primaryFile = normalizeStoredLink(pyq.file || pyq.server1);
        const secondaryFile = normalizeStoredLink(pyq.file2 || pyq.server2);

        return `
        <article class="resource-card">
            <div class="resource-top">
                <div>
                    <div class="resource-kicker">PYQ</div>
                    <h5 class="resource-title">${escapeHtml(pyq.title)}</h5>
                    <div class="resource-meta">
                        ${pyq.course ? `<span class="resource-pill">${escapeHtml(pyq.course)}</span>` : ''}
                        ${pyq.semester ? `<span class="resource-pill">${escapeHtml(pyq.semester)} sem</span>` : ''}
                        ${pyq.session ? `<span class="resource-pill">${escapeHtml(pyq.session)} session</span>` : ''}
                    </div>
                </div>
                <div class="resource-actions">
                    ${primaryFile ? `<button class="btn btn-sm btn-outline-light" onclick='copyToClipboard(${JSON.stringify(primaryFile)})'>Copy Server 1</button>` : ''}
                    ${secondaryFile ? `<button class="btn btn-sm btn-outline-light" onclick='copyToClipboard(${JSON.stringify(secondaryFile)})'>Copy Server 2</button>` : ''}
                    <button class="btn btn-sm btn-outline-primary" onclick="editPyqById('${pyq.id}')">Edit</button>
                    <button class="btn btn-sm btn-outline-danger" onclick="deletePyqById('${pyq.id}')">Delete</button>
                </div>
            </div>
            <div class="resource-detail">
                <div>Server 1: ${escapeHtml(primaryFile)}</div>
                <div>Server 2: ${escapeHtml(secondaryFile || 'null')}</div>
            </div>
        </article>
    `;
    }).join('');

    updateDashboardStats();
}

function renderUsers() {
    const list = document.getElementById('usersList');
    if (!list) return;

    if (!allData.users.length) {
        list.innerHTML = '<div class="resource-empty">No registered users found.</div>';
        updateDashboardStats();
        return;
    }

    list.innerHTML = allData.users.map((user, index) => {
        const createdAt = user.createdAt ? new Date(user.createdAt.toDate()).toLocaleString() : 'Unknown';
        return `
        <article class="resource-card">
            <div class="resource-top">
                <div class="d-flex align-items-start gap-3">
                    <div class="contributor-avatar-small">${escapeHtml((user.name || user.signupName || 'U').slice(0, 2).toUpperCase())}</div>
                    <div>
                        <h5 class="resource-title">${escapeHtml(user.name || user.signupName || 'Unnamed User')}</h5>
                        <div class="resource-meta">
                            <span class="resource-pill">${escapeHtml(user.role || 'user')}</span>
                            <span class="resource-pill">${escapeHtml(user.course || user.signupCourse || 'N/A')}</span>
                        </div>
                    </div>
                </div>
                <div class="resource-actions">
                    <button class="btn btn-sm btn-outline-primary" onclick="editUser('${user.uid}')"><i class="fas fa-edit me-1"></i>Edit</button>
                    <button class="btn btn-sm btn-outline-danger" onclick="deleteUser('${user.uid}', '${(user.name || user.signupName || 'user').replace(/'/g, "\\'")}')"><i class="fas fa-trash me-1"></i>Delete</button>
                </div>
            </div>
            <div class="resource-detail">
                <div>Email: ${escapeHtml(user.email || user.signupEmail || 'No email')}</div>
                <div>Phone: ${escapeHtml(user.phone || 'N/A')}</div>
                <div>Created: ${escapeHtml(createdAt)}</div>
            </div>
        </article>
    `;
    }).join('');

    updateDashboardStats();
}

function addItem(type, item) {
    // Add document to Firestore collection
    db.collection(type).add(item)
        .then(docRef => {
            allData[type].push({ id: docRef.id, ...item });
            renderLists();
            alert('Item added successfully!');
            if (type === 'pyqs' || type === 'contributors') invalidateApiCache();
        })
        .catch(error => {
            console.error('Error adding item:', error);
            alert('Error adding item. Please try again.');
        });
}

function editItem(type, index, item) {
    const existing = allData[type][index];
    if (!existing || !existing.id) {
        alert('Unable to find item id to update.');
        return;
    }
    db.collection(type).doc(existing.id).set(item, { merge: true })
        .then(() => {
            allData[type][index] = { id: existing.id, ...item };
            renderLists();
            alert('Item updated successfully!');
            if (type === 'pyqs' || type === 'contributors') invalidateApiCache();
        })
        .catch(error => {
            console.error('Error updating item:', error);
            alert('Error updating item. Please try again.');
        });
}

function deleteItem(type, index) {
    // support both index and id (for backward compat)
    let idx = index;
    if (typeof index === 'string' && isNaN(parseInt(index))) {
        idx = allData[type].findIndex(p => p.id === index);
        if (idx === -1) { alert('Item not found'); return; }
    }
    if (confirm('Are you sure you want to delete this item?')) {
        const existing = allData[type][idx];
        if (!existing || !existing.id) {
            alert('Unable to find item id to delete.');
            return;
        }
        db.collection(type).doc(existing.id).delete()
            .then(() => {
                allData[type].splice(idx, 1);
                renderLists();
                alert('Item deleted successfully!');
                if (type === 'pyqs' || type === 'contributors') invalidateApiCache();
            })
            .catch(error => {
                console.error('Error deleting item:', error);
                const msg = error && error.code === 'permission-denied' ? 'permission denied — check admin login & Firestore rules (isAdminByEmail must match your email)' : (error.message || 'Please try again.');
                alert('Error deleting item: ' + msg);
            });
    }
}

function saveData() {
    // Deprecated for Firestore-based flows. Keep for compatibility but warn.
    console.warn('saveData() called - this project now uses Firestore. Use addItem/editItem/deleteItem instead.');
}

function buildPyqTitle(course,branch, semester, subject, session) {
    let title = `${normalizePyqText(course)}`;
    if (branch) {
        title += ` ${normalizePyqText(branch)}`;
    }
    title += ` ${normalizePyqText(semester)} Sem ${normalizePyqText(subject)} {${normalizePyqText(session)}}`;
    return title;
}

function normalizePyqText(value) {
    return (value || '').toString().replace(/\s+/g, ' ').trim();
}

function buildPyqDescription(title) {
    const normalizedTitle = normalizePyqText(title) || 'Document';
    return `${normalizedTitle} for DSMNRU`;
}

function pyqTitleExists(title) {
    return db.collection('pyqs').where('title', '==', title).get()
        .then(snapshot => !snapshot.empty)
        .catch(error => {
            console.error('Error checking for duplicate PYQ title:', error);
            alert('Unable to validate duplicate PYQ titles right now. Please try again.');
            return null;
        });
}

// Global functions for onclick — id-based (fixes filtered-list delete bug)
window.editPyqById = function(id) {
    const pyq = allData.pyqs.find(p => p.id === id);
    if (!pyq) { alert('PYQ not found (maybe already deleted). Refresh.'); return; }
    document.getElementById('editType').value = 'pyqs';
    document.getElementById('editIndex').value = id;
    document.getElementById('editTitle').value = pyq.title;
    document.getElementById('editFile').value = normalizeStoredLink(pyq.file || pyq.server1);
    document.getElementById('editFile2').value = normalizeStoredLink(pyq.file2 || pyq.server2);
    document.getElementById('editBranch').value = pyq.branch || '';
    document.getElementById('editCourseDiv').style.display = 'none';
    document.getElementById('editSemesterDiv').style.display = 'none';
    document.getElementById('editBranchDiv').style.display = 'none';
    new bootstrap.Modal(document.getElementById('editModal')).show();
};
window.deletePyqById = function(id) {
    const idx = allData.pyqs.findIndex(p => p.id === id);
    if (idx === -1) { alert('PYQ not found. Refresh the list.'); return; }
    const pyq = allData.pyqs[idx];
    if (!confirm(`Delete "${pyq.title}"? This cannot be undone.`)) return;
    const deleteBtn = event && event.target ? event.target : null;
    if (deleteBtn) deleteBtn.disabled = true;
    db.collection('pyqs').doc(id).delete()
        .then(() => {
            allData.pyqs.splice(idx, 1);
            renderPyqs();
            updateDashboardStats();
            alert('Item deleted successfully!');
            invalidateApiCache();
        })
        .catch(error => {
            console.error('Error deleting PYQ:', error);
            const msg = error && error.message ? error.message : 'Please try again.';
            if (error && error.code === 'permission-denied') {
                alert('Delete failed: permission denied. Check Firestore rules & that you are logged in as admin ('+ (error.message||'') +').');
            } else {
                alert('Error deleting item: ' + msg);
            }
            if (deleteBtn) deleteBtn.disabled = false;
        });
};
// keep old index-based for backward compat (now delegates to id)
window.editPyq = function(index) {
    // if index is actually an id string (from old cached HTML), delegate
    if (typeof index === 'string' && isNaN(index)) { return window.editPyqById(index); }
    const pyq = allData.pyqs[index];
    if (!pyq) { alert('PYQ not found'); return; }
    return window.editPyqById(pyq.id);
};

window.deleteItem = deleteItem;
window.editUser = function(uid) {
    const user = allData.users.find(item => item.uid === uid);
    if (!user) {
        alert('User not found.');
        return;
    }

    document.getElementById('userEditUid').value = user.uid || '';
    document.getElementById('userEditName').value = user.name || user.signupName || '';
    document.getElementById('userEditEmail').value = user.email || user.signupEmail || '';
    document.getElementById('userEditCourse').value = user.course || user.signupCourse || '';
    document.getElementById('userEditPhone').value = user.phone || '';
    document.getElementById('userEditRole').value = user.role || 'user';
    document.getElementById('userEditCreatedAt').value = user.createdAt ? new Date(user.createdAt.toDate()).toLocaleString() : 'Unknown';

    const modal = new bootstrap.Modal(document.getElementById('userEditModal'));
    modal.show();
};

window.deleteUser = function(uid, name) {
    if (confirm(`Are you sure you want to delete ${name}?`)) {
        db.collection('users').doc(uid).delete()
            .then(() => {
                allData.users = allData.users.filter(item => item.uid !== uid);
                renderUsers();
                alert('User record deleted successfully!');
            })
            .catch(error => {
                console.error('Error deleting user:', error);
                alert('Error deleting user: ' + error.message);
            });
    }
};

    document.addEventListener('DOMContentLoaded', function() {
        const userEditForm = document.getElementById('userEditForm');
        if (!userEditForm) return;

        userEditForm.addEventListener('submit', function(e) {
            e.preventDefault();

            const uid = document.getElementById('userEditUid').value;
            const name = document.getElementById('userEditName').value.trim();
            const email = document.getElementById('userEditEmail').value.trim();
            const course = document.getElementById('userEditCourse').value.trim();
            const phone = document.getElementById('userEditPhone').value.trim();
            const role = document.getElementById('userEditRole').value.trim();

            if (!uid || !name || !email || !course || !phone || !role) {
                alert('All user fields are required.');
                return;
            }

            const updatedUser = {
                uid,
                name,
                email,
                course,
                phone,
                role,
                signupName: name,
                signupEmail: email,
                signupCourse: course
            };

            db.collection('users').doc(uid).set(updatedUser, { merge: true })
                .then(() => {
                    const index = allData.users.findIndex(item => item.uid === uid);
                    if (index !== -1) {
                        allData.users[index] = { ...allData.users[index], ...updatedUser };
                    }
                    renderUsers();
                    bootstrap.Modal.getInstance(document.getElementById('userEditModal')).hide();
                    alert('User updated successfully!');
                })
                .catch(error => {
                    console.error('Error updating user:', error);
                    alert('Error updating user: ' + error.message);
                });
        });
    });
// Pending Uploads Management — PYQ submissions + contribution points
// ─────────────────────────────────────────────────────────────────────
// The review queue holds every submission (pending / approved / rejected).
//   Approve → status approved + reviewedAt/reviewedBy + exactly +10 points to
//             the uploader's normalized email + a ledger entry (idempotent).
//   Reject  → status rejected + reviewedAt/reviewedBy + no points, ever.
// Approval NEVER publishes a PYQ — permanent publishing stays the manual
// "Quick create" flow below, exactly as before.

let submissionFilter = 'pending';
const submissionActionBusy = new Set();

function submissionStatusOf(doc) {
    if (window.DSMNRUPoints) return window.DSMNRUPoints.submissionStatus(doc && doc.status);
    const raw = String((doc && doc.status) || 'pending').trim().toLowerCase();
    return (raw === 'approved' || raw === 'rejected') ? raw : 'pending';
}

function submissionEmailOf(doc) {
    if (window.DSMNRUPoints) return window.DSMNRUPoints.submissionEmail(doc);
    return String((doc && (doc.studentEmail || doc.email)) || '').trim().toLowerCase();
}

function rewardPointsValue() {
    return window.DSMNRUPoints ? window.DSMNRUPoints.PYQ_UPLOAD_REWARD_POINTS : 10;
}

function getSubmissionCounts() {
    const counts = { pending: 0, approved: 0, rejected: 0 };
    allData.pendingUploads.forEach(doc => {
        const status = submissionStatusOf(doc);
        if (counts[status] !== undefined) counts[status] += 1;
    });
    return counts;
}

function uploadTimestampValue(doc) {
    const value = doc && doc.uploadedAt;
    if (!value) return 0;
    if (typeof value.toDate === 'function') {
        const date = value.toDate();
        return Number.isFinite(date.getTime()) ? date.getTime() : 0;
    }
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
}

function reviewTimestampValue(doc) {
    const value = doc && doc.reviewedAt;
    if (!value) return 0;
    if (typeof value.toDate === 'function') {
        const date = value.toDate();
        return Number.isFinite(date.getTime()) ? date.getTime() : 0;
    }
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
}

function loadPendingUploads() {
    // Every submission (all statuses), newest first. Bounded read so the
    // review queue stays cheap as approved/rejected history grows.
    return db.collection('pendingUploads').limit(300).get()
        .then(snapshot => {
            allData.pendingUploads = snapshot.docs
                .map(doc => ({ id: doc.id, ...doc.data() }))
                .sort((a, b) => uploadTimestampValue(b) - uploadTimestampValue(a));
            renderPendingUploads(allData.pendingUploads);
        })
        .catch(error => {
            console.error('Error loading pending uploads:', error);
        });
}

function filterSubmissions(filter) {
    submissionFilter = filter || 'pending';
    document.querySelectorAll('.submission-filter-btn').forEach(btn => {
        const isActive = btn.getAttribute('data-filter') === submissionFilter;
        btn.classList.toggle('active', isActive);
        btn.classList.toggle('btn-primary', isActive);
        btn.classList.toggle('btn-outline-success', !isActive && btn.getAttribute('data-filter') === 'approved');
        btn.classList.toggle('btn-outline-danger', !isActive && btn.getAttribute('data-filter') === 'rejected');
        btn.classList.toggle('btn-outline-light', !isActive && (btn.getAttribute('data-filter') === 'all' || btn.getAttribute('data-filter') === 'pending'));
    });
    renderPendingUploads(allData.pendingUploads);
}

function submissionStatusBadge(status) {
    if (status === 'approved') {
        return '<span class="resource-pill submission-status submission-status-approved"><i class="fas fa-circle-check me-1"></i> Approved</span>';
    }
    if (status === 'rejected') {
        return '<span class="resource-pill submission-status submission-status-rejected"><i class="fas fa-circle-xmark me-1"></i> Rejected</span>';
    }
    return '<span class="resource-pill submission-status submission-status-pending"><i class="fas fa-hourglass-half me-1"></i> Pending</span>';
}

function setSubmissionCardBusy(docId, busy) {
    const card = document.querySelector('[data-submission-id="' + docId + '"]');
    if (!card) return;
    card.querySelectorAll('button').forEach(btn => { btn.disabled = !!busy; });
}

function renderPendingUploads(submissions) {
    const list = document.getElementById('pendingUploadsList');
    const noPendingMessage = document.getElementById('noPendingMessage');
    if (!list) return;

    const all = Array.isArray(submissions) ? submissions : allData.pendingUploads;
    const visible = all.filter(doc => submissionFilter === 'all' || submissionStatusOf(doc) === submissionFilter);

    updateDashboardStats();

    if (!visible.length) {
        list.innerHTML = '';
        if (noPendingMessage) {
            noPendingMessage.style.display = 'block';
            noPendingMessage.textContent = submissionFilter === 'pending'
                ? 'No pending uploads at the moment.'
                : 'No ' + submissionFilter + ' submissions yet.';
        }
        return;
    }

    if (noPendingMessage) noPendingMessage.style.display = 'none';

    list.innerHTML = visible.map((doc, index) => {
        const data = doc;
        const status = submissionStatusOf(data);
        const isPending = status === 'pending';
        const uploadedAt = uploadTimestampValue(data);
        const uploadDate = uploadedAt ? new Date(uploadedAt).toLocaleString() : 'Unknown';
        const reviewedAt = reviewTimestampValue(data);
        const email = submissionEmailOf(data);
        const reward = rewardPointsValue();

        let pointsLine = '';
        if (status === 'approved') {
            const awarded = data.pointsAwarded === true ? '+' + reward : '0';
            pointsLine = '<div>Points: <strong>' + awarded + '</strong>'
                + (email ? ' → <code>' + escapeHtml(email) + '</code>' : '')
                + (data.pointsTransactionId ? ' <span class="text-muted">(txn ' + escapeHtml(data.pointsTransactionId) + ')</span>' : '')
                + '</div>';
        } else if (status === 'pending') {
            pointsLine = '<div class="text-muted">Points: +' + reward + ' on approval</div>';
        } else {
            pointsLine = '<div class="text-muted">Points: 0 (rejected)</div>';
        }

        const reasonLine = status === 'rejected' && data.rejectionReason
            ? '<div>Reason: ' + escapeHtml(data.rejectionReason) + '</div>'
            : '';
        const reviewedLine = data.reviewedBy
            ? '<div class="text-muted">Reviewed by ' + escapeHtml(data.reviewedBy) + (reviewedAt ? ' • ' + new Date(reviewedAt).toLocaleString() : '') + '</div>'
            : '';

        const reviewButtons = isPending
            ? `<button class="btn btn-sm btn-success" onclick="approveSubmission('${doc.id}')">
                    <i class="fas fa-check me-1"></i> Approve <span class="btn-points">+${reward}</span>
                </button>
                <button class="btn btn-sm btn-outline-danger" onclick="rejectSubmission('${doc.id}')">
                    <i class="fas fa-ban me-1"></i> Reject <span class="btn-points">0</span>
                </button>`
            : '';

        return `
            <article class="resource-card" data-submission-id="${doc.id}" data-status="${status}">
                <div class="resource-top">
                    <div>
                        <div class="resource-kicker">${escapeHtml(status)} submission ${index + 1}</div>
                        <h5 class="resource-title">${escapeHtml(data.title)}</h5>
                        <div class="resource-meta">
                            ${submissionStatusBadge(status)}
                            <span class="resource-pill">${escapeHtml(data.course || 'N/A')}</span>
                            <span class="resource-pill">${escapeHtml(data.semester || 'N/A')}</span>
                        </div>
                    </div>
                    <div class="resource-actions">
                        ${reviewButtons}
                        <button class="btn btn-sm btn-outline-info" onclick="previewPendingFile('${data.downloadUrl}')">
                            <i class="fas fa-eye me-1"></i> Preview
                        </button>
                        <button class="btn btn-sm btn-outline-info" onclick="downloadPendingFile('${data.downloadUrl}', '${String(data.fileName || '').replace(/'/g, "\\'")}')">
                            <i class="fas fa-download me-1"></i> Download
                        </button>
                        <button class="btn btn-sm btn-outline-light" onclick='copyToClipboard(${JSON.stringify(data.downloadUrl || '')})'>Copy URL</button>
                        <button class="btn btn-sm btn-outline-danger" onclick="deletePendingUpload('${doc.id}')">
                            <i class="fas fa-trash me-1"></i> Delete
                        </button>
                    </div>
                </div>
                <div class="resource-detail">
                    <div>File: <code>${escapeHtml(data.fileName || 'unnamed-file')}</code></div>
                    <div>Uploaded by: <strong>${escapeHtml(data.studentName || 'Anonymous')}</strong>${email ? ' • <code>' + escapeHtml(email) + '</code>' : ''}</div>
                    <div>${escapeHtml(uploadDate)}</div>
                    ${pointsLine}
                    ${reasonLine}
                    ${reviewedLine}
                </div>
                ${isPending ? duplicateHintPlaceholder(data) : ''}
            </article>
        `;
    }).join('');

    // Fill the duplicate hints once the PYQ index is available (async, and
    // purely additive — it never touches a submission's status or points).
    renderDuplicateHints(visible);
}

// ── Duplicate-detection assistance ────────────────────────────────────
// ADMIN ASSISTANCE ONLY. This never changes a submission's status, never
// awards or withholds points, and never hides a submission: it lists the most
// relevant existing PYQs (title-led, course/semester only adjust confidence)
// so the admin can open the paper and decide — same paper → Reject (0 points),
// different paper → Approve (+10 points).
// Matching itself lives in duplicate-check.js (shared, unit-tested).

let duplicateIndex = null;
let duplicateIndexPromise = null;
let duplicateIndexSource = null;   // 'firestore' (authoritative) | 'api-cache' (may lag)

/**
 * Pull the PYQ title/course/semester list from the Worker API first: it is
 * edge/KV cached and costs zero Firestore reads. Falls back to a direct read
 * (the admin already has `pyqs` read permission) if the API is unreachable.
 */
async function fetchPyqsFromWorkerApi() {
    const items = [];
    let page = 1;
    let totalPages = 1;
    do {
        const response = await fetch(`${API_BASE_URL}/pyqs?limit=100&page=${page}`, {
            headers: { Accept: 'application/json' }
        });
        if (!response.ok) throw new Error('HTTP ' + response.status);
        const data = await response.json();
        (data.items || []).forEach(item => items.push({
            id: item.id,
            title: item.title || '',
            course: item.course || '',
            semester: item.semester || ''
        }));
        totalPages = Number(data.totalPages) || 1;
        page += 1;
    } while (page <= totalPages && page <= 20); // hard stop: 2000 papers
    return items;
}

function duplicateFieldsFrom(doc) {
    return {
        id: doc.id,
        title: doc.title || '',
        course: doc.course || '',
        semester: doc.semester || ''
    };
}

/**
 * Duplicate matching MUST see every published PYQ, so it reads the source of
 * truth. The Worker's /api/pyqs list is served from a KV search index that is
 * only rebuilt on admin invalidation (skipped while API_INVALIDATE_KEY is the
 * placeholder) or after the 7-day hard TTL — it answers 200 OK while silently
 * omitting recently published papers, which is exactly how an exact duplicate
 * went missing. The API is therefore only a last-resort fallback, and when it
 * is used the admin is told the list may be incomplete.
 */
function fetchDuplicateIndex() {
    // Reuse the library already in memory (opening "All PYQs" loads it).
    if (pyqsLoaded && Array.isArray(allData.pyqs) && allData.pyqs.length) {
        duplicateIndexSource = 'firestore';
        return Promise.resolve(allData.pyqs.map(duplicateFieldsFrom));
    }
    return db.collection('pyqs').get()
        .then(snapshot => {
            duplicateIndexSource = 'firestore';
            return snapshot.docs.map(doc => duplicateFieldsFrom({ id: doc.id, ...(doc.data() || {}) }));
        })
        .catch(error => {
            console.warn('Duplicate check: direct pyqs read failed (' + error.message + ') — falling back to the cached Worker API.');
            return fetchPyqsFromWorkerApi().then(items => {
                duplicateIndexSource = 'api-cache';
                return items;
            });
        });
}

/** Drop the cached index (called on every PYQ add/edit/delete/import). */
function invalidateDuplicateIndex() {
    duplicateIndex = null;
    duplicateIndexPromise = null;
    duplicateIndexSource = null;
}

function loadDuplicateIndex() {
    if (duplicateIndex) return Promise.resolve(duplicateIndex);
    if (!duplicateIndexPromise) {
        duplicateIndexPromise = fetchDuplicateIndex()
            .then(items => { duplicateIndex = items; return items; })
            .catch(error => { duplicateIndexPromise = null; throw error; });
    }
    return duplicateIndexPromise;
}

function duplicateSignalBadge(kind, value) {
    if (kind === 'match') return '<span class="dup-signal dup-signal-ok"><i class="fas fa-check me-1"></i>' + escapeHtml(value) + '</span>';
    if (kind === 'different') return '<span class="dup-signal dup-signal-diff"><i class="fas fa-xmark me-1"></i>' + escapeHtml(value) + '</span>';
    return '<span class="dup-signal dup-signal-unknown"><i class="fas fa-question me-1"></i>' + escapeHtml(value) + ' not compared</span>';
}

function duplicateHintPlaceholder(submission) {
    const helpers = window.DSMNRUDuplicates;
    if (!helpers || !helpers.hasText(submission.title)) return '';
    return `<div class="duplicate-hints" id="duplicateHints-${submission.id}">
                    <span class="dup-loading"><i class="fas fa-magnifying-glass me-1"></i> Checking for similar PYQs…</span>
                </div>`;
}

function setDuplicateHint(submissionId, html) {
    const el = document.getElementById('duplicateHints-' + submissionId);
    if (el) el.innerHTML = html;
}

/** Fill the per-submission hint blocks. Purely additive — no status writes. */
async function renderDuplicateHints(submissions) {
    const helpers = window.DSMNRUDuplicates;
    if (!helpers) return;
    // Duplicate matching is only useful (and only worth its read) inside the
    // Review Queue workspace — the dashboard reuses the same renderer for its
    // "needs attention" summary and must stay read-light.
    const reviewView = document.getElementById('view-review');
    if (!reviewView || !reviewView.classList.contains('active')) return;
    const targets = (submissions || []).filter(item => submissionStatusOf(item) === 'pending' && helpers.hasText(item.title));
    if (!targets.length) return;

    let index;
    try {
        index = await loadDuplicateIndex();
    } catch (error) {
        console.warn('Duplicate check unavailable:', error.message);
        targets.forEach(item => setDuplicateHint(item.id, '<span class="dup-none">Could not load the PYQ list to compare against.</span>'));
        return;
    }

    targets.forEach(submission => {
        const candidates = helpers.findCandidates(submission, index, { limit: 5 });
        if (!candidates.length) {
            setDuplicateHint(submission.id, '<span class="dup-none">No similar PYQs found — you can approve without a duplicate check.</span>');
            return;
        }

        const rows = candidates.map(candidate => {
            const pyq = candidate.pyq;
            const percent = Math.round(candidate.confidence * 100);
            const band = candidate.confidence >= 0.75 ? 'dup-confidence-high'
                : candidate.confidence >= 0.55 ? 'dup-confidence-mid' : 'dup-confidence-low';
            const courseBadge = duplicateSignalBadge(candidate.course, 'course');
            const semesterBadge = duplicateSignalBadge(candidate.semester, 'semester');
            return `<div class="dup-item">
                        <div class="dup-item-head">
                            <span class="dup-confidence ${band}">${percent}%</span>
                            <a href="paper.html?id=${encodeURIComponent(pyq.id)}" target="_blank" rel="noopener">${escapeHtml(pyq.title || 'Untitled')}</a>
                            <a class="dup-view" href="paper.html?id=${encodeURIComponent(pyq.id)}" target="_blank" rel="noopener">View</a>
                        </div>
                        <div class="dup-item-meta">
                            <span class="dup-label">${escapeHtml(helpers.confidenceLabel(candidate.confidence))}</span>
                            ${courseBadge}
                            ${semesterBadge}
                        </div>
                    </div>`;
        }).join('');

        const staleNote = duplicateIndexSource === 'api-cache'
            ? '<div class="dup-stale"><i class="fas fa-clock-rotate-left me-1"></i> Matched against the cached Worker index — it can lag behind Firestore. Refresh to re-check.</div>'
            : '';
        setDuplicateHint(submission.id, `${staleNote}<div class="dup-head">
                        <i class="fas fa-triangle-exclamation me-1"></i> Possible Existing PYQs (${candidates.length})
                        <span class="dup-note">warning only — never auto-rejected, you decide</span>
                    </div>
                    ${rows}
                    <div class="dup-foot">Open a paper to compare → same paper: <strong>Reject</strong> (0 points) · different paper: <strong>Approve</strong> (+${rewardPointsValue()} points)</div>`);
    });
}

/** Open the temporary gofile page in a new tab so the admin can read the paper. */
function previewPendingFile(downloadUrl) {
    if (!downloadUrl) { alert('This submission has no file link.'); return; }
    window.open(downloadUrl, '_blank', 'noopener');
}

function downloadPendingFile(downloadUrl, fileName) {
    const a = document.createElement('a');
    a.href = downloadUrl;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
}

function deletePendingUpload(docId) {
    if (confirm('Delete this pending upload from the list? The file on gofile.io will auto-delete after 30 days.')) {
        // Delete from Firestore only
        db.collection('pendingUploads').doc(docId).delete()
            .then(() => {
                alert('Upload removed from pending list!');
                loadPendingUploads();
            })
            .catch(error => {
                console.error('Error deleting upload:', error);
                alert('Error deleting upload: ' + error.message);
            });
    }
}

// ── Approve / Reject (the only path that can award points) ──────────

function requireAdminForReview() {
    if (!currentAdmin) {
        alert('Admin sign-in required to review submissions.');
        return false;
    }
    return true;
}

/**
 * Find the Firebase account that already owns this email (if any) so an
 * existing user's profile shows the points immediately. Non-fatal: points
 * always live on the email-based reward account.
 */
async function resolveRewardUid(email) {
    try {
        const byEmail = await db.collection('users').where('email', '==', email).limit(1).get();
        if (!byEmail.empty) {
            const data = byEmail.docs[0].data() || {};
            return data.uid || byEmail.docs[0].id;
        }
        const bySignupEmail = await db.collection('users').where('signupEmail', '==', email).limit(1).get();
        if (!bySignupEmail.empty) {
            const data = bySignupEmail.docs[0].data() || {};
            return data.uid || bySignupEmail.docs[0].id;
        }
    } catch (error) {
        console.warn('Could not resolve a user for ' + email + ':', error.message);
    }
    return null;
}

async function approveSubmission(docId) {
    if (!requireAdminForReview()) return;
    if (submissionActionBusy.has(docId)) return;

    const submission = allData.pendingUploads.find(item => item.id === docId);
    if (!submission) {
        alert('Submission not found — refresh the review queue.');
        return;
    }

    const email = submissionEmailOf(submission);
    if (!email || (window.DSMNRUPoints && !window.DSMNRUPoints.isValidRewardEmail(email))) {
        alert('This submission has no valid email, so points cannot be credited. Delete it instead.');
        return;
    }

    const reward = rewardPointsValue();
    if (!confirm('Approve this PYQ submission?\n\n' + (submission.title || 'Untitled')
        + '\n\n+' + reward + ' points will be credited to ' + email
        + '.\nApproval does NOT publish the PYQ — publishing stays manual.')) {
        return;
    }

    submissionActionBusy.add(docId);
    setSubmissionCardBusy(docId, true);

    try {
        const uid = await resolveRewardUid(email);
        const accountKey = window.DSMNRUPoints
            ? window.DSMNRUPoints.rewardAccountKey(email)
            : email.replace(/[^a-z0-9]/g, '_');
        const rewardType = window.DSMNRUPoints ? window.DSMNRUPoints.PYQ_UPLOAD_REWARD_TYPE : 'PYQ_UPLOAD_REWARD';

        // One Firestore transaction: submission status + ledger entry + balance.
        // The ledger document id IS the submission id, so a second approval can
        // never create a second reward.
        const result = await db.runTransaction(async (tx) => {
            const submissionRef = db.collection('pendingUploads').doc(docId);
            const accountRef = db.collection('reward_accounts').doc(accountKey);
            const ledgerRef = db.collection('point_transactions').doc(docId);

            const submissionSnap = await tx.get(submissionRef);
            const accountSnap = await tx.get(accountRef);
            const ledgerSnap = await tx.get(ledgerRef);

            if (!submissionSnap.exists) throw new Error('Submission no longer exists.');

            const reviewedPatch = {
                status: 'approved',
                reviewedAt: firebase.firestore.FieldValue.serverTimestamp(),
                reviewedBy: currentAdmin.email || '',
                reviewedByUid: currentAdmin.uid || '',
                rejectionReason: null
            };

            const alreadyAwarded = ledgerSnap.exists
                || submissionSnap.data().pointsAwarded === true
                || !!submissionSnap.data().pointsTransactionId;

            if (alreadyAwarded) {
                // Status only — never a second reward for the same submission.
                tx.update(submissionRef, reviewedPatch);
                const existing = accountSnap.exists ? (accountSnap.data() || {}) : {};
                return { awarded: false, points: 0, total: Number(existing.points) || 0 };
            }

            const account = accountSnap.exists ? (accountSnap.data() || {}) : {};
            const currentPoints = Number(account.points) || 0;
            const now = firebase.firestore.FieldValue.serverTimestamp();

            tx.set(ledgerRef, {
                email: email,
                amount: reward,
                type: rewardType,
                submissionId: docId,
                rewardAccountKey: accountKey,
                uid: uid || account.uid || null,
                createdBy: currentAdmin.email || '',
                createdAt: now
            });

            tx.set(accountRef, {
                email: email,
                points: currentPoints + reward,
                uid: uid || account.uid || null,
                createdAt: account.createdAt || now,
                updatedAt: now
            }, { merge: true });

            tx.update(submissionRef, Object.assign({}, reviewedPatch, {
                pointsAwarded: true,
                pointsTransactionId: docId,
                pointsAmount: reward,
                pointsEmail: email
            }));

            return { awarded: true, points: reward, total: currentPoints + reward };
        });

        alert(result.awarded
            ? 'Approved — +' + result.points + ' points credited. Balance: ' + result.total + '.'
            : 'Approved — points were already awarded for this submission, so nothing extra was credited. Balance: ' + result.total + '.');
    } catch (error) {
        console.error('Error approving submission:', error);
        alert('Could not approve this submission: ' + error.message);
    } finally {
        submissionActionBusy.delete(docId);
        loadPendingUploads();
    }
}

async function rejectSubmission(docId) {
    if (!requireAdminForReview()) return;
    if (submissionActionBusy.has(docId)) return;

    const submission = allData.pendingUploads.find(item => item.id === docId);
    if (!submission) {
        alert('Submission not found — refresh the review queue.');
        return;
    }

    if (submission.pointsAwarded === true || submission.pointsTransactionId) {
        alert('This submission was already approved and rewarded. Points are never removed — leaving it as approved.');
        return;
    }

    const reason = prompt('Reject this submission? No points will be awarded.\n\nOptional reason (stored on the record):', '');
    if (reason === null) return; // cancelled

    submissionActionBusy.add(docId);
    setSubmissionCardBusy(docId, true);

    try {
        await db.collection('pendingUploads').doc(docId).update({
            status: 'rejected',
            reviewedAt: firebase.firestore.FieldValue.serverTimestamp(),
            reviewedBy: currentAdmin.email || '',
            reviewedByUid: currentAdmin.uid || '',
            rejectionReason: reason.trim().slice(0, 300) || null
        });
        alert('Submission rejected. No points were awarded.');
    } catch (error) {
        console.error('Error rejecting submission:', error);
        alert('Could not reject this submission: ' + error.message);
    } finally {
        submissionActionBusy.delete(docId);
        loadPendingUploads();
    }
}

// Global functions for onclick
window.downloadPendingFile = downloadPendingFile;
window.previewPendingFile = previewPendingFile;
window.invalidateDuplicateIndex = invalidateDuplicateIndex;
window.deletePendingUpload = deletePendingUpload;
window.approveSubmission = approveSubmission;
window.rejectSubmission = rejectSubmission;
window.filterSubmissions = filterSubmissions;

// Lazy loading functions - only load data when section is expanded
let pyqsLoaded = false;
let syllabusLoaded = false;
let pendingLoaded = false;
let usersLoaded = false;

window.loadPyqsOnDemand = function() {
    if (pyqsLoaded) return;
    pyqsLoaded = true;
    
    db.collection('pyqs').get()
        .then(pyqSnap => {
            allData.pyqs = pyqSnap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
            document.getElementById('pyqsCount').textContent = allData.pyqs.length;
            renderPyqs();
        })
        .catch(error => {
            console.error('Error loading PYQs:', error);
            document.getElementById('pyqsList').innerHTML = '<div class="alert alert-danger">Error loading PYQs</div>';
        });
};

window.loadPendingOnDemand = function() {
    if (pendingLoaded) {
        // Already in memory (the dashboard loads it) — just re-render so the
        // duplicate hints appear, without reading the collection again.
        renderPendingUploads(allData.pendingUploads);
        return;
    }
    pendingLoaded = true;
    loadPendingUploads();
};

window.loadUsersOnDemand = function() {
    if (usersLoaded) return;
    usersLoaded = true;

    db.collection('users').orderBy('createdAt', 'desc').get()
        .then(snapshot => {
            allData.users = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
            document.getElementById('usersCount').textContent = allData.users.length;
            renderUsers();
        })
        .catch(error => {
            console.error('Error loading users:', error);
            const list = document.getElementById('usersList');
            if (list) {
                list.innerHTML = '<div class="alert alert-danger">Error loading users</div>';
            }
        });
};
// Contributor Management Functions
let contributorsLoaded = false;

window.loadContributorsOnDemand = function() {
    if (contributorsLoaded) return;
    contributorsLoaded = true;
    loadContributors();
};

function loadContributors() {
    db.collection('contributors').orderBy('name').get()
        .then(snapshot => {
            const contributors = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
            allData.contributors = contributors;
            contributorsLoaded = true;
            renderContributors(contributors);
            updateDashboardStats();
        })
        .catch(error => {
            console.error('Error loading contributors:', error);
            document.getElementById('contributorsList').innerHTML = '<div class="alert alert-danger">Error loading contributors</div>';
        });
}

function renderContributors(contributors) {
    const list = document.getElementById('contributorsList');
    if (!list) return;

    if (!contributors.length) {
        list.innerHTML = '<div class="resource-empty">No contributors yet. Add one using the form above.</div>';
        updateDashboardStats();
        return;
    }

    list.innerHTML = contributors.map(contributor => `
        <article class="resource-card">
            <div class="resource-top">
                <div class="d-flex align-items-start gap-3">
                    <div class="contributor-avatar-small">${escapeHtml(contributor.avatar)}</div>
                    <div>
                        <div class="resource-kicker">Contributor</div>
                        <h5 class="resource-title">${escapeHtml(contributor.name)}</h5>
                        <div class="resource-meta">
                            <span class="resource-pill">${escapeHtml(contributor.role)}</span>
                        </div>
                    </div>
                </div>
                <div class="resource-actions">
                    <button class="btn btn-sm btn-outline-primary" onclick="editContributor('${contributor.id}', '${contributor.name}', '${contributor.avatar}', '${contributor.role}')">
                        <i class="fas fa-edit me-1"></i>Edit
                    </button>
                    <button class="btn btn-sm btn-outline-danger" onclick="deleteContributor('${contributor.id}', '${contributor.name}')">
                        <i class="fas fa-trash me-1"></i>Delete
                    </button>
                </div>
            </div>
        </article>
    `).join('');

    updateDashboardStats();
}

function getContributorInitials(name) {
    return name
        .trim()
        .split(/\s+/)
        .filter(part => part.length)
        .map(part => part[0].toUpperCase())
        .join('')
        .slice(0, 4);
}

const allowedContributorRoles = [
    'PYQs Provider',
    'Syllabus Provider',
    'PYQs + Syllabus Provider'
];

window.editContributor = function(id, name, avatar, role) {
    const newName = prompt('Edit name:', name);
    if (newName === null) return;

    const newRole = prompt('Edit role (PYQs Provider / Syllabus Provider / PYQs + Syllabus Provider):', role);
    if (newRole === null) return;

    const trimmedName = newName.trim();
    const trimmedRole = newRole.trim();
    const newAvatar = getContributorInitials(trimmedName);

    if (!trimmedName || !newAvatar || !trimmedRole) {
        alert('All fields are required');
        return;
    }

    if (!allowedContributorRoles.includes(trimmedRole)) {
        alert('Please enter a valid role');
        return;
    }

    db.collection('contributors').doc(id).set({
        name: trimmedName,
        avatar: newAvatar,
        role: trimmedRole
    })
    .then(() => {
        loadContributors();
        invalidateApiCache();
    })
    .catch(error => {
        console.error('Error updating contributor:', error);
        alert('Error updating contributor: ' + error.message);
    });
};

window.deleteContributor = function(id, name) {
    if (confirm(`Are you sure you want to delete ${name}?`)) {
        db.collection('contributors').doc(id).delete()
            .then(() => {
                loadContributors();
                invalidateApiCache();
            })
            .catch(error => {
                console.error('Error deleting contributor:', error);
                alert('Error deleting contributor: ' + error.message);
            });
    }
};

document.addEventListener('DOMContentLoaded', function() {
    // Contributor form submission
    const addContributorForm = document.getElementById('addContributorForm');
    if (addContributorForm) {
        const nameInput = document.getElementById('contributorName');
        const avatarInput = document.getElementById('contributorAvatar');
        const roleInput = document.getElementById('contributorRole');

        if (nameInput && avatarInput) {
            nameInput.addEventListener('input', function() {
                const initials = getContributorInitials(nameInput.value);
                avatarInput.value = initials;
            });
        }

        addContributorForm.addEventListener('submit', function(e) {
            e.preventDefault();

            const name = nameInput.value.trim();
            const avatar = getContributorInitials(name);
            const role = roleInput.value;

            if (!name || !avatar || !role) {
                alert('Please fill all fields');
                return;
            }

            if (!allowedContributorRoles.includes(role)) {
                alert('Please select a valid role');
                return;
            }

            db.collection('contributors').add({
                name,
                avatar,
                role
            })
            .then(() => {
                addContributorForm.reset();
                loadContributors();
                invalidateApiCache();
            })
            .catch(error => {
                console.error('Error adding contributor:', error);
                alert('Error adding contributor: ' + error.message);
            });
        });
    }

});

// Contributor edits/removals removed from admin panel.

// ===================== FEEDBACK MANAGEMENT =====================

let allFeedback = [];
let feedbackLoaded = false;
let feedbackFilter = 'all';

function loadFeedbackOnDemand() {
    if (feedbackLoaded) return;
    feedbackLoaded = true;
    loadFeedback();
}

function loadFeedback() {
    db.collection('feedback')
        .orderBy('createdAt', 'desc')
        .get()
        .then(snap => {
            allFeedback = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
            allData.feedback = allFeedback;
            updateDashboardStats();
            updateFeedbackCount();
            renderFeedback();
        })
        .catch(error => {
            console.error('Error loading feedback:', error);
            document.getElementById('feedbackList').innerHTML = '<div class="resource-empty">Error loading feedback.</div>';
        });
}

function updateFeedbackCount() {
    const newCount = allFeedback.filter(f => f.status === 'new').length;
    document.getElementById('feedbackHeaderCount').textContent = allFeedback.length;
}

function filterFeedback(type) {
    feedbackFilter = type;
    // update active button UI
    document.querySelectorAll('.feedback-filter-btn').forEach(btn => {
        const isActive = btn.getAttribute('data-filter') === type;
        btn.classList.toggle('active', isActive);
        btn.classList.toggle('btn-primary', isActive);
        btn.classList.toggle('btn-outline-warning', !isActive && btn.getAttribute('data-filter')==='broken_link');
        btn.classList.toggle('btn-outline-info', !isActive && btn.getAttribute('data-filter')==='pyq_request');
        btn.classList.toggle('btn-outline-light', !isActive && (btn.getAttribute('data-filter')==='all' || btn.getAttribute('data-filter')==='new'));
    });
    renderFeedback();
}
window.filterFeedback = filterFeedback;
window.loadFeedback = loadFeedback;
window.loadFeedbackOnDemand = loadFeedbackOnDemand;
window.markFeedbackAsResolved = markFeedbackAsResolved;
window.deleteFeedback = deleteFeedback;

function clearResolvedFeedback() {
    const resolved = allFeedback.filter(f => f.status === 'resolved');
    if (!resolved.length) { alert('No resolved items to clear.'); return; }
    if (!confirm(`Delete ${resolved.length} resolved feedback items?`)) return;
    const batch = db.batch();
    resolved.forEach(f => batch.delete(db.collection('feedback').doc(f.id)));
    batch.commit().then(() => {
        allFeedback = allFeedback.filter(f => f.status !== 'resolved');
        allData.feedback = allFeedback;
        updateDashboardStats();
        renderFeedback();
        loadFeedbackCount();
        alert('Resolved feedback cleared.');
    }).catch(e => alert('Error: '+e.message));
}
window.clearResolvedFeedback = clearResolvedFeedback;

// ── Admin Content Library Search ──
function renderPyqsFiltered(filtered) {
    const list = document.getElementById('pyqsList');
    if (!list) return;
    if (!filtered.length) {
        list.innerHTML = '<div class="resource-empty">No PYQs added yet.</div>';
        return;
    }
    list.innerHTML = filtered.map((pyq) => {
        const primaryFile = normalizeStoredLink(pyq.file || pyq.server1);
        const secondaryFile = normalizeStoredLink(pyq.file2 || pyq.server2);
        return `
        <article class="resource-card">
            <div class="resource-top">
                <div>
                    <div class="resource-kicker">PYQ</div>
                    <h5 class="resource-title">${escapeHtml(pyq.title)}</h5>
                    <div class="resource-meta">
                        ${pyq.course ? `<span class="resource-pill">${escapeHtml(pyq.course)}</span>` : ''}
                        ${pyq.semester ? `<span class="resource-pill">${escapeHtml(pyq.semester)} sem</span>` : ''}
                        ${pyq.session ? `<span class="resource-pill">${escapeHtml(pyq.session)} session</span>` : ''}
                    </div>
                </div>
                <div class="resource-actions">
                    ${primaryFile ? `<button class="btn btn-sm btn-outline-light" onclick='copyToClipboard(${JSON.stringify(primaryFile)})'>Copy Server 1</button>` : ''}
                    ${secondaryFile ? `<button class="btn btn-sm btn-outline-light" onclick='copyToClipboard(${JSON.stringify(secondaryFile)})'>Copy Server 2</button>` : ''}
                    <button class="btn btn-sm btn-outline-primary" onclick="editPyqById('${pyq.id}')">Edit</button>
                    <button class="btn btn-sm btn-outline-danger" onclick="deletePyqById('${pyq.id}')">Delete</button>
                </div>
            </div>
            <div class="resource-detail">
                <div>Server 1: ${escapeHtml(primaryFile)}</div>
                <div>Server 2: ${escapeHtml(secondaryFile || 'null')}</div>
            </div>
        </article>
    `;
    }).join('');
}
function setupAdminPyqSearch() {
    const input = document.getElementById('adminPyqSearch');
    if (!input) return;
    input.addEventListener('input', function() {
        const q = this.value.toLowerCase().trim();
        if (!q) { renderPyqs(); return; }
        const filtered = allData.pyqs.filter(p => 
            String(p.title||'').toLowerCase().includes(q) ||
            String(p.course||'').toLowerCase().includes(q) ||
            String(p.semester||'').toLowerCase().includes(q) ||
            String(p.session||'').toLowerCase().includes(q)
        );
        const list = document.getElementById('pyqsList');
        if (!list) return;
        if (!filtered.length) { list.innerHTML = '<div class="resource-empty">No matches for “'+escapeHtml(q)+'”.</div>'; return; }
        renderPyqsFiltered(filtered);
    });
}

function renderFeedback() {
    const list = document.getElementById('feedbackList');
    if (!list) return;

    let filtered = allFeedback;
    
    if (feedbackFilter === 'broken_link') {
        filtered = allFeedback.filter(f => f.type === 'broken_link');
    } else if (feedbackFilter === 'pyq_request') {
        filtered = allFeedback.filter(f => f.type === 'pyq_request');
    } else if (feedbackFilter === 'new') {
        filtered = allFeedback.filter(f => f.status === 'new');
    }

    if (!filtered.length) {
        list.innerHTML = '<div class="resource-empty">No feedback items to display.</div>';
        return;
    }

    list.innerHTML = filtered.map(feedback => {
        const createdDate = feedback.createdAt ? new Date(feedback.createdAt.toDate()).toLocaleString() : 'Unknown';
        const isNew = feedback.status === 'new';
        const isBroken = feedback.type === 'broken_link';

        let content = '';
        if (isBroken) {
            content = `
                <div class="resource-kicker">BROKEN LINK REPORT</div>
                <p class="resource-title"><strong>Document:</strong> ${escapeHtml(feedback.title || 'N/A')}</p>
                <p class="resource-detail"><strong>Course:</strong> ${escapeHtml(feedback.course || 'N/A')}</p>
                <p class="resource-detail"><strong>Issue:</strong> ${escapeHtml(feedback.details || '')}</p>
                ${feedback.email ? `<p class="resource-detail"><strong>Reporter Email:</strong> <code>${escapeHtml(feedback.email)}</code></p>` : ''}
            `;
        } else {
            content = `
                <div class="resource-kicker">PYQ REQUEST</div>
                <p class="resource-title"><strong>Subject:</strong> ${escapeHtml(feedback.subject || 'N/A')}</p>
                <p class="resource-detail"><strong>Course:</strong> ${escapeHtml(feedback.course || 'N/A')}</p>
                <p class="resource-detail"><strong>Semester:</strong> ${escapeHtml(feedback.semester || 'N/A')}</p>
                <p class="resource-detail"><strong>Session:</strong> ${escapeHtml(feedback.session || 'N/A')}</p>
                ${feedback.email ? `<p class="resource-detail"><strong>Requester Email:</strong> <code>${escapeHtml(feedback.email)}</code></p>` : ''}
            `;
        }

        return `
            <div class="resource-card">
                <div class="resource-top">
                    <div>
                        ${content}
                    </div>
                    <div class="resource-actions">
                        ${isNew ? `<span class="badge bg-warning">New</span>` : ''}
                    </div>
                </div>
                <div class="resource-meta mt-2">
                    <span class="resource-pill"><i class="fas fa-calendar"></i> ${createdDate}</span>
                    ${feedback.userEmail ? `<span class="resource-pill"><i class="fas fa-envelope"></i> ${escapeHtml(feedback.userEmail)}</span>` : ''}
                    <span class="resource-pill"><i class="fas fa-tag"></i> ${feedback.status || 'unknown'}</span>
                </div>
                <div class="resource-actions mt-3">
                    ${isNew ? `<button class="btn btn-sm btn-outline-primary" onclick="markFeedbackAsResolved('${feedback.id}')"><i class="fas fa-check"></i> Mark Resolved</button>` : ''}
                    <button class="btn btn-sm btn-outline-danger" onclick="deleteFeedback('${feedback.id}')"><i class="fas fa-trash"></i> Delete</button>
                </div>
            </div>
        `;
    }).join('');
}

function markFeedbackAsResolved(feedbackId) {
    if (confirm('Mark this feedback as resolved?')) {
        db.collection('feedback').doc(feedbackId).update({
            status: 'resolved'
        }).then(() => {
            loadFeedback();
        }).catch(error => {
            console.error('Error updating feedback:', error);
            alert('Error updating feedback status.');
        });
    }
}

function deleteFeedback(feedbackId) {
    if (confirm('Delete this feedback item?')) {
        db.collection('feedback').doc(feedbackId).delete().then(() => {
            loadFeedback();
        }).catch(error => {
            console.error('Error deleting feedback:', error);
            alert('Error deleting feedback.');
        });
    }
}

function escapeHtml(str) {
    const map = {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#039;'
    };
    return String(str).replace(/[&<>"']/g, m => map[m]);
}
// auto-init admin search after DOM ready
document.addEventListener('DOMContentLoaded', function(){ 
    try { setupAdminPyqSearch(); } catch(e){}
    // also init feedback filter active state
    try { 
        const firstBtn = document.querySelector('.feedback-filter-btn[data-filter="all"]');
        if (firstBtn) firstBtn.classList.add('active');
    } catch(e){}
});
// ══════════════════════════════════════════════════════════════════════
// ADMIN NAVIGATION — persistent sidebar + focused views
// ──────────────────────────────────────────────────────────────────────
// Information architecture only: every workspace below reuses the existing
// loaders and renderers (no data logic is duplicated). Each view fetches its
// own data the first time it is opened, so the dashboard stays lightweight.
// ══════════════════════════════════════════════════════════════════════

const ADMIN_VIEWS = {
    'dashboard':     { title: 'Dashboard',    load: function () { loadDashboardOverview(); } },
    'pyqs':          { title: 'All PYQs',     load: function () { window.loadPyqsOnDemand(); } },
    'add-pyq':       { title: 'Add PYQ' },
    'bulk-import':   { title: 'Bulk Import' },
    'review':        { title: 'Review Queue', load: function () { window.loadPendingOnDemand(); } },
    'contributors':  { title: 'Contributors', load: function () { window.loadContributorsOnDemand(); } },
    'users':         { title: 'Users',        load: function () { window.loadUsersOnDemand(); } },
    'feedback':      { title: 'Feedback',     load: function () { window.loadFeedbackOnDemand(); } },
    'rewards':       { title: 'Rewards',      load: function () { loadRewards(); } },
    'settings':      { title: 'Settings',     load: function () { renderSettings(); } }
};
let currentAdminView = null;

function showAdminView(name, options) {
    const opts = options || {};
    const view = ADMIN_VIEWS[name] ? name : 'dashboard';

    document.querySelectorAll('.admin-view').forEach(section => {
        section.classList.toggle('active', section.getAttribute('data-view') === view);
    });
    document.querySelectorAll('.admin-nav-item').forEach(item => {
        item.classList.toggle('active', item.getAttribute('data-view') === view);
    });

    const titleEl = document.getElementById('adminPageTitle');
    if (titleEl) titleEl.textContent = ADMIN_VIEWS[view].title;
    document.title = ADMIN_VIEWS[view].title + ' · DSMNRU Admin';
    currentAdminView = view;
    closeAdminSidebar();

    if (!opts.skipHash && window.location.hash !== '#' + view) {
        try { window.history.replaceState(null, '', '#' + view); }
        catch (error) { window.location.hash = view; }
    }

    const loader = ADMIN_VIEWS[view].load;
    if (typeof loader === 'function') {
        try { loader(); } catch (error) { console.error('Could not load "' + view + '":', error); }
    }
    window.scrollTo(0, 0);
}

function toggleAdminSidebar() {
    document.body.classList.toggle('admin-nav-open');
}

function closeAdminSidebar() {
    document.body.classList.remove('admin-nav-open');
}

function setNavBadge(id, value) {
    const el = document.getElementById(id);
    if (!el) return;
    const count = Number(value) || 0;
    el.textContent = count > 99 ? '99+' : String(count);
    el.classList.toggle('is-zero', count === 0);
}

function setAdminText(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
}

function setAdminIdentity(user) {
    const email = (user && user.email) || '—';
    setAdminText('adminSignedInEmail', email);
    setAdminText('settingsAdminEmail', email);
}

// ── Dashboard: overview only, two bounded reads ───────────────────────
// 1) pending submissions (the action-critical collection, same bounded query
//    the Review Queue uses)  2) recent/total PYQs from the Worker API, which
//    is edge/KV cached and costs zero Firestore reads.
let dashboardOverviewRequested = false;
let knownPyqTotal = null;

function loadDashboardOverview(force) {
    if (dashboardOverviewRequested && !force) {
        renderRecentSubmissions();
        return;
    }
    dashboardOverviewRequested = true;
    renderRecentPyqs();
    Promise.resolve(loadPendingUploads())
        .then(function () {
            // The queue data is already in memory — opening the Review Queue
            // workspace does not need to read the collection again.
            pendingLoaded = true;
            renderRecentSubmissions();
        })
        .catch(error => console.error('Dashboard: could not load submissions:', error.message));
}

function renderRecentSubmissions() {
    const el = document.getElementById('recentSubmissionsList');
    if (!el) return;
    const pending = (allData.pendingUploads || []).filter(item => submissionStatusOf(item) === 'pending');
    if (!pending.length) {
        el.innerHTML = '<div class="resource-empty">Nothing waiting for review.</div>';
        return;
    }
    el.innerHTML = pending.slice(0, 5).map(item => {
        const when = uploadTimestampValue(item);
        return `<article class="resource-card compact-card">
                    <div class="resource-title-sm">${escapeHtml(item.title || 'Untitled')}</div>
                    <div class="resource-meta">
                        <span class="resource-pill">${escapeHtml(item.course || 'no course')}</span>
                        <span class="resource-pill">${escapeHtml(item.semester || 'no semester')}</span>
                    </div>
                    <div class="resource-detail">${escapeHtml(submissionEmailOf(item) || 'no email')}${when ? ' • ' + escapeHtml(new Date(when).toLocaleString()) : ''}</div>
                </article>`;
    }).join('');
}

function renderRecentPyqs() {
    const el = document.getElementById('recentPyqsList');
    if (!el) return;
    fetch(`${API_BASE_URL}/homepage`, { headers: { Accept: 'application/json' } })
        .then(response => {
            if (!response.ok) throw new Error('HTTP ' + response.status);
            return response.json();
        })
        .then(data => {
            const recent = (data && data.recent) || [];
            const stats = (data && data.stats) || {};
            if (stats && Number.isFinite(Number(stats.totalPyqs))) {
                knownPyqTotal = Number(stats.totalPyqs);
                updateDashboardStats();
            }
            if (!recent.length) {
                el.innerHTML = '<div class="resource-empty">No published PYQs yet.</div>';
                return;
            }
            el.innerHTML = recent.map(pyq => `<article class="resource-card compact-card">
                    <div class="resource-title-sm">
                        <a href="paper.html?id=${encodeURIComponent(pyq.id)}" target="_blank" rel="noopener">${escapeHtml(pyq.title || 'Untitled')}</a>
                    </div>
                    <div class="resource-meta">
                        <span class="resource-pill">${escapeHtml(pyq.course || '—')}</span>
                        <span class="resource-pill">${escapeHtml(pyq.semester || '—')}</span>
                        ${pyq.session ? `<span class="resource-pill">${escapeHtml(pyq.session)}</span>` : ''}
                    </div>
                </article>`).join('');
        })
        .catch(error => {
            console.warn('Dashboard: Worker API unavailable:', error.message);
            el.innerHTML = '<div class="resource-empty">Could not reach the Worker API — open “All PYQs” to read from Firestore.</div>';
        });
}

/** KPI cards for the collections we deliberately do NOT load on the dashboard. */
function loadDashboardCount(kind) {
    if (kind === 'users') window.loadUsersOnDemand();
    else if (kind === 'contributors') window.loadContributorsOnDemand();
    else if (kind === 'feedback') window.loadFeedbackOnDemand();
    updateStatLoadButtons();
}

function updateStatLoadButtons() {
    [['users', usersLoaded], ['contributors', contributorsLoaded], ['feedback', feedbackLoaded]].forEach(pair => {
        const btn = document.querySelector('.stat-link[data-load-count="' + pair[0] + '"]');
        if (btn) btn.style.display = pair[1] ? 'none' : '';
    });
}

// ── Rewards: read-only view over the points ledger ────────────────────
let rewardsLoaded = false;

function loadRewards(force) {
    if (rewardsLoaded && !force) return;
    rewardsLoaded = true;
    const txEl = document.getElementById('rewardTxList');
    const accountEl = document.getElementById('rewardAccountsList');
    [txEl, accountEl].forEach(el => { if (el) el.innerHTML = '<div class="resource-empty">Loading…</div>'; });

    Promise.all([
        db.collection('point_transactions').orderBy('createdAt', 'desc').limit(25).get(),
        db.collection('reward_accounts').get()
    ]).then(results => {
        const transactions = results[0].docs.map(doc => ({ id: doc.id, ...doc.data() }));
        const accounts = results[1].docs.map(doc => ({ id: doc.id, ...doc.data() }));

        const totalPoints = accounts.reduce((sum, account) => sum + (Number(account.points) || 0), 0);
        const linked = accounts.filter(account => account.uid).length;
        setAdminText('rewardPointsIssued', String(totalPoints));
        setAdminText('rewardAccountsCount', String(accounts.length));
        setAdminText('rewardLinkedCount', String(linked));
        setAdminText('rewardTxChip', transactions.length + ' latest');
        setAdminText('rewardAccountsChip', accounts.length + ' balances');

        if (txEl) {
            txEl.innerHTML = transactions.length
                ? transactions.map(tx => {
                    const when = rewardWhenValue(tx.createdAt);
                    return `<article class="resource-card compact-card">
                        <div class="resource-title-sm"><span class="reward-amount">+${escapeHtml(Number(tx.amount) || 0)}</span> ${escapeHtml(tx.email || 'unknown email')}</div>
                        <div class="resource-detail">${escapeHtml(tx.type || 'REWARD')}${when ? ' • ' + escapeHtml(when) : ''}${tx.submissionId ? ' • submission <code>' + escapeHtml(tx.submissionId) + '</code>' : ''}</div>
                    </article>`;
                }).join('')
                : '<div class="resource-empty">No rewards issued yet.</div>';
        }

        if (accountEl) {
            const sorted = accounts.slice().sort((a, b) => (Number(b.points) || 0) - (Number(a.points) || 0));
            accountEl.innerHTML = sorted.length
                ? sorted.map(account => `<article class="resource-card compact-card">
                        <div class="resource-title-sm">${escapeHtml(account.email || account.id)}</div>
                        <div class="resource-meta">
                            <span class="resource-pill"><strong>${escapeHtml(Number(account.points) || 0)}</strong> pts</span>
                            <span class="resource-pill">${account.uid ? 'linked to account' : 'no account yet'}</span>
                        </div>
                    </article>`).join('')
                : '<div class="resource-empty">No reward accounts yet.</div>';
        }
    }).catch(error => {
        console.error('Rewards: load failed:', error);
        const message = '<div class="alert alert-danger mb-0">Could not load rewards: ' + escapeHtml(error.message) + '</div>';
        if (txEl) txEl.innerHTML = message;
        if (accountEl) accountEl.innerHTML = '';
        rewardsLoaded = false;
    });
}

function rewardWhenValue(value) {
    if (!value) return '';
    if (typeof value.toDate === 'function') {
        const date = value.toDate();
        return Number.isFinite(date.getTime()) ? date.toLocaleString() : '';
    }
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? new Date(parsed).toLocaleString() : '';
}

// ── Settings: existing utilities only ─────────────────────────────────
function renderSettings() {
    setAdminIdentity(currentAdmin);
    const configured = !!API_INVALIDATE_KEY && API_INVALIDATE_KEY.indexOf('REPLACE_') !== 0;
    setAdminText('settingsApiCacheStatus', configured ? 'Key configured' : 'Key not set — invalidation skipped');
}

function runCacheInvalidation() {
    if (!API_INVALIDATE_KEY || API_INVALIDATE_KEY.indexOf('REPLACE_') === 0) {
        alert('API_INVALIDATE_KEY is not set in admin.js, so invalidation is skipped. Set it to the Worker’s ADMIN_API_KEY secret to purge the cache on demand.');
        return;
    }
    invalidateApiCache();
    alert('Cache invalidation requested — the Worker will rebuild its index in the background.');
}

window.showAdminView = showAdminView;
window.toggleAdminSidebar = toggleAdminSidebar;
window.closeAdminSidebar = closeAdminSidebar;
window.loadDashboardOverview = loadDashboardOverview;
window.loadDashboardCount = loadDashboardCount;
window.loadRewards = loadRewards;
window.renderSettings = renderSettings;
window.runCacheInvalidation = runCacheInvalidation;

document.addEventListener('DOMContentLoaded', function () {
    const settingsLogout = document.getElementById('settingsLogoutBtn');
    if (settingsLogout) settingsLogout.addEventListener('click', function () { auth.signOut(); });

    window.addEventListener('hashchange', function () {
        const name = window.location.hash.replace('#', '');
        if (name && name !== currentAdminView) showAdminView(name, { skipHash: true });
    });
});
