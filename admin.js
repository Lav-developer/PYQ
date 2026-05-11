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
let allData = { pyqs: [], users: [], pendingUploads: [], contributors: [] };
const ADMIN_EMAIL = 'kush210431@gmail.com';

function isAdminUser(user) {
    return !!user && user.email === ADMIN_EMAIL;
}

document.addEventListener('DOMContentLoaded', function() {
    setupSectionCollapseBehavior();

    // Auth state listener
    auth.onAuthStateChanged(user => {
        if (user) {
            if (!isAdminUser(user)) {
                auth.signOut();
                document.getElementById('loginError').textContent = 'You do not have admin access.';
                document.getElementById('loginError').style.display = 'block';
                document.getElementById('loginSection').style.display = 'block';
                document.getElementById('adminSection').style.display = 'none';
                return;
            }
            // User is signed in
            document.getElementById('loginSection').style.display = 'none';
            document.getElementById('adminSection').style.display = 'block';
            loadData();
        } else {
            // User is signed out
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
    const genBtn = document.getElementById('generateSitemapBtn');
    if (genBtn) {
        genBtn.addEventListener('click', function() {
            if (!auth.currentUser) {
                alert('You must be signed in to generate the sitemap.');
                return;
            }
            generateSitemap();
        });
    }

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
        let title = buildPyqTitle(course, semester, currentSubject, session, branch);
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

            title = buildPyqTitle(course, semester, currentSubject, session, branch);

            duplicateExists = await pyqTitleExists(title);
            if (duplicateExists === null) {
                return;
            }
        }

        addItem('pyqs', { title, file, file2: file2 || '', course, semester, subject: currentSubject, session, branch: branch || '' });
        this.reset();
    });

    // Edit PYQ form submit handler
    const editForm = document.getElementById('editForm');
    if (editForm) {
        editForm.addEventListener('submit', function(e) {
            e.preventDefault();
            const type = document.getElementById('editType').value;
            const index = parseInt(document.getElementById('editIndex').value);
            const title = document.getElementById('editTitle').value.trim();
            const file = document.getElementById('editFile').value.trim();
            const file2 = document.getElementById('editFile2').value.trim();
            
            if (!title || !file) {
                alert('Title and File URL are required.');
                return;
            }

            if (type === 'pyqs') {
                const branch = document.getElementById('editBranch').value.trim();
                editItem(type, index, { title, file, file2: file2 || '', branch: branch || '' });
            } else {
                editItem(type, index, { title, file });
            }
            
            bootstrap.Modal.getInstance(document.getElementById('editModal')).hide();
        });
    }

});

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
    // Auto-load pending uploads and registered users so counts and panels show immediately.
    loadPendingOnDemand();
    loadUsersOnDemand();
}

function resetLazyLoadState() {
    pyqsLoaded = false;
    pendingLoaded = false;
    usersLoaded = false;
    contributorsLoaded = false;
}

function generateSitemap() {
    // Build sitemap XML from allData
    try {
        const baseUrl = 'https://dsmnru-pyq.netlify.app/';
        const urls = [];

        // Add homepage
        urls.push({ loc: baseUrl, priority: 1.0, changefreq: 'daily' });

        // Add index.html explicitly
        urls.push({ loc: baseUrl + 'index.html', priority: 0.9, changefreq: 'daily' });

        // Add each PYQ file URL if present
        allData.pyqs.forEach(item => {
            if (item.file) urls.push({ loc: item.file, priority: 0.8, changefreq: 'monthly' });
        });

        const xmlParts = ['<?xml version="1.0" encoding="UTF-8"?>', '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'];
        urls.forEach(u => {
            xmlParts.push('  <url>');
            xmlParts.push(`    <loc>${escapeXml(u.loc)}</loc>`);
            if (u.changefreq) xmlParts.push(`    <changefreq>${u.changefreq}</changefreq>`);
            if (u.priority !== undefined) xmlParts.push(`    <priority>${u.priority.toFixed(2)}</priority>`);
            xmlParts.push('  </url>');
        });
        xmlParts.push('</urlset>');
        const sitemapXml = xmlParts.join('\n');

        // Download as file instead of uploading to Firebase
        const blob = new Blob([sitemapXml], { type: 'application/xml' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = 'sitemap.xml';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);

        updateSitemapStatus('done', 'sitemap.xml');
        alert(`✓ Sitemap generated successfully!\n\nGenerated ${urls.length} URLs:\n- Homepage\n- ${allData.pyqs.length} PYQ items\n\nFile downloaded as sitemap.xml`);
    } catch (err) {
        console.error('Error generating sitemap:', err);
        updateSitemapStatus('error');
        alert('Error generating sitemap: ' + err.message);
    }
}

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

function updateSitemapStatus(state, url) {
    const container = document.getElementById('sitemapStatus');
    const msg = document.getElementById('sitemapMessage');
    const link = document.getElementById('sitemapUrl');
    if (!container || !msg || !link) return;
    if (state === 'ready') {
        container.style.display = 'none';
    } else if (state === 'uploading') {
        container.style.display = 'block';
        msg.textContent = 'Generating sitemap and uploading...';
        link.style.display = 'none';
    } else if (state === 'done') {
        container.style.display = 'block';
        msg.textContent = 'Sitemap uploaded. Public URL:';
        link.href = url;
        link.textContent = url;
        link.style.display = 'block';
    } else if (state === 'error') {
        container.style.display = 'block';
        msg.textContent = 'Error generating sitemap. See console.';
        link.style.display = 'none';
    }
}

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

    setCount('pyqsCount', allData.pyqs.length);
    setCount('pyqsHeaderCount', allData.pyqs.length);
    setCount('usersCount', allData.users.length);
    setCount('usersHeaderCount', allData.users.length);
    setCount('pendingCount', allData.pendingUploads.length);
    setCount('pendingHeaderCount', allData.pendingUploads.length);
    setCount('contributorsCount', allData.contributors.length);
    setCount('contributorsHeaderCount', allData.contributors.length);
}

function buildCsvContent(rows, columns) {
    const escapeCsv = value => {
        const text = value === null || value === undefined ? '' : String(value);
        return `"${text.replace(/"/g, '""')}"`;
    };

    const header = columns.join(',');
    const lines = rows.map(row => columns.map(column => escapeCsv(row[column])).join(','));
    return [header, ...lines].join('\n');
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

function normalizeCsvHeader(header) {
    return (header || '').toString().trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function normalizeCsvValue(value) {
    if (value === undefined || value === null) {
        return 'null';
    }

    const text = String(value).trim();
    return text ? text : 'null';
}

function normalizeStoredLink(value) {
    const text = (value === undefined || value === null) ? '' : String(value).trim();
    return text && text.toLowerCase() !== 'null' ? text : '';
}

function parseCsvContent(csvText) {
    const rows = [];
    let currentCell = '';
    let currentRow = [];
    let inQuotes = false;

    for (let index = 0; index < csvText.length; index += 1) {
        const character = csvText[index];
        const nextCharacter = csvText[index + 1];

        if (character === '"') {
            if (inQuotes && nextCharacter === '"') {
                currentCell += '"';
                index += 1;
            } else {
                inQuotes = !inQuotes;
            }
            continue;
        }

        if (character === ',' && !inQuotes) {
            currentRow.push(currentCell);
            currentCell = '';
            continue;
        }

        if ((character === '\n' || character === '\r') && !inQuotes) {
            if (character === '\r' && nextCharacter === '\n') {
                index += 1;
            }

            currentRow.push(currentCell);
            rows.push(currentRow);
            currentCell = '';
            currentRow = [];
            continue;
        }

        currentCell += character;
    }

    currentRow.push(currentCell);
    rows.push(currentRow);

    return rows
        .map(row => row.map(cell => cell.trim()))
        .filter(row => row.some(cell => cell !== ''));
}

function getCsvRowValue(row, normalizedHeaders, aliases) {
    for (const alias of aliases) {
        const key = normalizedHeaders[normalizeCsvHeader(alias)];
        if (key !== undefined) {
            return row[key];
        }
    }

    return undefined;
}

async function importPyqCsvFile(file) {
    const status = document.getElementById('pyqCsvImportStatus');

    if (!file) {
        alert('Please choose a CSV file first.');
        return;
    }

    if (status) {
        status.textContent = 'Reading CSV file...';
        status.className = 'small mt-2 text-info';
    }

    const csvText = await file.text();
    const rows = parseCsvContent(csvText);

    if (!rows.length) {
        throw new Error('The CSV file is empty or invalid.');
    }

    const headers = rows.shift();
    const normalizedHeaders = {};
    headers.forEach((header, index) => {
        normalizedHeaders[normalizeCsvHeader(header)] = index;
    });

    let importedCount = 0;
    let skippedCount = 0;

    for (const row of rows) {
        const collection = normalizeCsvValue(getCsvRowValue(row, normalizedHeaders, ['collection']));
        const collectionKey = normalizeCsvHeader(collection);

        if (collectionKey !== 'pyq' && collectionKey !== 'pyqs') {
            skippedCount += 1;
            continue;
        }

        const id = normalizeCsvValue(getCsvRowValue(row, normalizedHeaders, ['id']));
        if (id === 'null') {
            skippedCount += 1;
            continue;
        }

        const payload = {
            title: normalizeCsvValue(getCsvRowValue(row, normalizedHeaders, ['title'])),
            file: normalizeCsvValue(getCsvRowValue(row, normalizedHeaders, ['server 1', 'server1', 'file'])),
            file2: normalizeCsvValue(getCsvRowValue(row, normalizedHeaders, ['server 2', 'server2', 'file2'])),
            course: normalizeCsvValue(getCsvRowValue(row, normalizedHeaders, ['course'])),
            semester: normalizeCsvValue(getCsvRowValue(row, normalizedHeaders, ['semester'])),
            session: normalizeCsvValue(getCsvRowValue(row, normalizedHeaders, ['session']))
        };

        await db.collection('pyqs').doc(id).set(payload, { merge: true });

        const existingIndex = allData.pyqs.findIndex(item => item.id === id);
        if (existingIndex !== -1) {
            allData.pyqs[existingIndex] = { ...allData.pyqs[existingIndex], id, ...payload };
        } else {
            allData.pyqs.push({ id, ...payload });
        }

        importedCount += 1;
    }

    pyqsLoaded = false;
    if (typeof loadPyqsOnDemand === 'function') {
        loadPyqsOnDemand();
    }

    if (status) {
        status.textContent = `Imported ${importedCount} PYQ row(s). Skipped ${skippedCount}.`;
        status.className = 'small mt-2 text-success';
    }
}

async function loadCollectionSnapshot(collectionName) {
    const snapshot = await db.collection(collectionName).get();
    return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
}

async function downloadAllCsvBackup() {
    try {
        const [pyqs, contributors, users] = await Promise.all([
            allData.pyqs.length ? Promise.resolve(allData.pyqs) : loadCollectionSnapshot('pyqs'),
            allData.contributors.length ? Promise.resolve(allData.contributors) : loadCollectionSnapshot('contributors'),
            allData.users.length ? Promise.resolve(allData.users) : loadCollectionSnapshot('users')
        ]);

        const allRows = [];

        pyqs.forEach(item => {
            allRows.push({
                collection: 'pyqs',
                id: item.id || '',
                name: '',
                title: item.title || '',
                'Server 1': item.file || item.server1 || '',
                'Server 2': item.file2 || item.server2 || '',
                course: item.course || '',
                semester: item.semester || '',
                session: item.session || '',
                email: '',
                phone: '',
                role: '',
                avatar: ''
            });
        });

        contributors.forEach(item => {
            allRows.push({
                collection: 'contributors',
                id: item.id || '',
                name: item.name || '',
                title: '',
                file: '',
                course: '',
                semester: '',
                session: '',
                email: '',
                phone: '',
                role: item.role || '',
                avatar: item.avatar || ''
            });
        });

        users.forEach(item => {
            allRows.push({
                collection: 'users',
                id: item.id || item.uid || '',
                name: item.name || item.signupName || '',
                title: '',
                file: '',
                course: item.course || item.signupCourse || '',
                semester: '',
                session: '',
                email: item.email || item.signupEmail || '',
                phone: item.phone || '',
                role: item.role || '',
                avatar: ''
            });
        });

        const csv = buildCsvContent(allRows, ['collection', 'id', 'name', 'title', 'Server 1', 'Server 2', 'course', 'semester', 'session', 'email', 'phone', 'role', 'avatar']);
        downloadCsvFile('database-backup.csv', csv);
        alert('CSV backup downloaded successfully.');
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
                    <div class="resource-kicker">PYQ ${index + 1}</div>
                    <h5 class="resource-title">${escapeHtml(pyq.title)}</h5>
                    <div class="resource-meta">
                        ${pyq.course ? `<span class="resource-pill">${escapeHtml(pyq.course)}</span>` : ''}
                        ${pyq.semester ? `<span class="resource-pill">${escapeHtml(pyq.semester)} semester</span>` : ''}
                        ${pyq.session ? `<span class="resource-pill">${escapeHtml(pyq.session)} session</span>` : ''}
                    </div>
                </div>
                <div class="resource-actions">
                    ${primaryFile ? `<button class="btn btn-sm btn-outline-light" onclick='copyToClipboard(${JSON.stringify(primaryFile)})'>Copy Server 1</button>` : ''}
                    ${secondaryFile ? `<button class="btn btn-sm btn-outline-light" onclick='copyToClipboard(${JSON.stringify(secondaryFile)})'>Copy Server 2</button>` : ''}
                    <button class="btn btn-sm btn-outline-primary" onclick="editPyq(${index})">Edit</button>
                    <button class="btn btn-sm btn-outline-danger" onclick="deleteItem('pyqs', ${index})">Delete</button>
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
                        <div class="resource-kicker">Registered user ${index + 1}</div>
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
                <div>UID: ${escapeHtml(user.uid || 'N/A')}</div>
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
        })
        .catch(error => {
            console.error('Error updating item:', error);
            alert('Error updating item. Please try again.');
        });
}

function deleteItem(type, index) {
    if (confirm('Are you sure you want to delete this item?')) {
        const existing = allData[type][index];
        if (!existing || !existing.id) {
            alert('Unable to find item id to delete.');
            return;
        }
        db.collection(type).doc(existing.id).delete()
            .then(() => {
                allData[type].splice(index, 1);
                renderLists();
                alert('Item deleted successfully!');
            })
            .catch(error => {
                console.error('Error deleting item:', error);
                alert('Error deleting item. Please try again.');
            });
    }
}

function saveData() {
    // Deprecated for Firestore-based flows. Keep for compatibility but warn.
    console.warn('saveData() called - this project now uses Firestore. Use addItem/editItem/deleteItem instead.');
}

function buildPyqTitle(course, semester, subject, session, branch) {
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

function pyqTitleExists(title) {
    return db.collection('pyqs').where('title', '==', title).get()
        .then(snapshot => !snapshot.empty)
        .catch(error => {
            console.error('Error checking for duplicate PYQ title:', error);
            alert('Unable to validate duplicate PYQ titles right now. Please try again.');
            return null;
        });
}

// Global functions for onclick
window.editPyq = function(index) {
    const pyq = allData.pyqs[index];
    document.getElementById('editType').value = 'pyqs';
    document.getElementById('editIndex').value = index;
    document.getElementById('editTitle').value = pyq.title;
    document.getElementById('editFile').value = normalizeStoredLink(pyq.file || pyq.server1);
    document.getElementById('editFile2').value = normalizeStoredLink(pyq.file2 || pyq.server2);
    document.getElementById('editBranch').value = pyq.branch || '';
    document.getElementById('editCourseDiv').style.display = 'none';
    document.getElementById('editSemesterDiv').style.display = 'none';
    document.getElementById('editBranchDiv').style.display = 'none';
    new bootstrap.Modal(document.getElementById('editModal')).show();
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
// Pending Uploads Management
function loadPendingUploads() {
    db.collection('pendingUploads').where('status', '==', 'pending').get()
        .then(snapshot => {
            allData.pendingUploads = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
            const pendingCount = allData.pendingUploads.length;
            updateDashboardStats();
            
            if (pendingCount === 0) {
                document.getElementById('pendingUploadsList').innerHTML = '';
                document.getElementById('noPendingMessage').style.display = 'block';
            } else {
                document.getElementById('noPendingMessage').style.display = 'none';
                renderPendingUploads(allData.pendingUploads);
            }
        })
        .catch(error => {
            console.error('Error loading pending uploads:', error);
        });
}

function renderPendingUploads(pendingDocs) {
    const list = document.getElementById('pendingUploadsList');
    if (!list) return;

    if (!pendingDocs.length) {
        list.innerHTML = '<div class="resource-empty">No pending uploads found.</div>';
        updateDashboardStats();
        return;
    }

    list.innerHTML = pendingDocs.map((doc, index) => {
        // doc is already a converted object with { id, ...data }
        const data = doc;
        const uploadDate = data.uploadedAt ? new Date(data.uploadedAt.toDate()).toLocaleString() : 'Unknown';
        return `
            <article class="resource-card">
                <div class="resource-top">
                    <div>
                        <div class="resource-kicker">Pending upload ${index + 1}</div>
                        <h5 class="resource-title">${escapeHtml(data.title)}</h5>
                        <div class="resource-meta">
                            <span class="resource-pill">${escapeHtml(data.course || 'N/A')}</span>
                            <span class="resource-pill">${escapeHtml(data.semester || 'N/A')}</span>
                        </div>
                    </div>
                    <div class="resource-actions">
                        <button class="btn btn-sm btn-outline-light" onclick='copyToClipboard(${JSON.stringify(data.downloadUrl || '')})'>Copy URL</button>
                        <button class="btn btn-sm btn-outline-info" onclick="downloadPendingFile('${data.downloadUrl}', '${data.fileName.replace(/'/g, "\\'")}')">
                            <i class="fas fa-download me-1"></i> Download
                        </button>
                        <button class="btn btn-sm btn-outline-danger" onclick="deletePendingUpload('${doc.id}')">
                            <i class="fas fa-trash me-1"></i> Delete
                        </button>
                    </div>
                </div>
                <div class="resource-detail">
                    <div>File: <code>${escapeHtml(data.fileName)}</code></div>
                    <div>Uploaded by: <strong>${escapeHtml(data.studentName || 'Anonymous')}</strong></div>
                    <div>${escapeHtml(uploadDate)}</div>
                </div>
            </article>
        `;
    }).join('');

    updateDashboardStats();
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

// Global function for onclick
window.downloadPendingFile = downloadPendingFile;
window.deletePendingUpload = deletePendingUpload;

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
    if (pendingLoaded) return;
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
            })
            .catch(error => {
                console.error('Error adding contributor:', error);
                alert('Error adding contributor: ' + error.message);
            });
        });
        
        // Load contributors on page init
        loadContributors();
    }

    const csvImportButton = document.getElementById('pyqCsvImportBtn');
    const csvImportInput = document.getElementById('pyqCsvFile');
    if (csvImportButton && csvImportInput) {
        csvImportButton.addEventListener('click', async function() {
            const file = csvImportInput.files && csvImportInput.files[0];
            if (!file) {
                alert('Please choose a CSV file to import.');
                return;
            }

            csvImportButton.disabled = true;
            const status = document.getElementById('pyqCsvImportStatus');
            if (status) {
                status.textContent = 'Importing CSV...';
                status.className = 'small mt-2 text-info';
            }

            try {
                await importPyqCsvFile(file);
                csvImportInput.value = '';
            } catch (error) {
                console.error('Error importing CSV:', error);
                if (status) {
                    status.textContent = error.message || 'CSV import failed.';
                    status.className = 'small mt-2 text-danger';
                }
                alert('CSV import failed: ' + error.message);
            } finally {
                csvImportButton.disabled = false;
            }
        });
    }
});

// Contributor edits/removals removed from admin panel.