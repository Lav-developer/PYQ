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
let allData = { pyqs: [], syllabus: [] };

document.addEventListener('DOMContentLoaded', function() {
    // Auth state listener
    auth.onAuthStateChanged(user => {
        if (user) {
            // User is signed in
            document.getElementById('loginSection').style.display = 'none';
            document.getElementById('adminSection').style.display = 'block';
            loadData();
        } else {
            // User is signed out
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
    document.getElementById('addPyqForm').addEventListener('submit', function(e) {
        e.preventDefault();
        const title = document.getElementById('pyqTitle').value;
        const file = document.getElementById('pyqFile').value;
        addItem('pyqs', { title, file });
        this.reset();
    });

    // Add Syllabus form
    document.getElementById('addSyllabusForm').addEventListener('submit', function(e) {
        e.preventDefault();
        const title = document.getElementById('syllabusTitle').value;
        const file = document.getElementById('syllabusFile').value;
        const course = document.getElementById('syllabusCourse').value;
        const semester = document.getElementById('syllabusSemester').value;
        addItem('syllabus', { title, file, course, semester });
        this.reset();
    });

    // Edit form
    document.getElementById('editForm').addEventListener('submit', function(e) {
        e.preventDefault();
        const type = document.getElementById('editType').value;
        const index = parseInt(document.getElementById('editIndex').value);
        const title = document.getElementById('editTitle').value;
        const file = document.getElementById('editFile').value;
        const course = document.getElementById('editCourse').value;
        const semester = document.getElementById('editSemester').value;
        editItem(type, index, { title, file, course, semester });
        bootstrap.Modal.getInstance(document.getElementById('editModal')).hide();
    });
});

function loadData() {
    // Don't load data on page load anymore - use lazy loading instead
    // Just initialize UI
    console.log('Admin panel loaded. Data will load when sections are expanded.');
}

function generateSitemap() {
    // Build sitemap XML from allData
    try {
        const baseUrl = (location.protocol + '//' + location.hostname).replace(/\/$/, '') + '/';
        const urls = [];

        // Add homepage
        urls.push({ loc: baseUrl, priority: 1.0, changefreq: 'daily' });

        // Add index.html explicitly
        urls.push({ loc: baseUrl + 'index.html', priority: 0.9, changefreq: 'daily' });

        // Add each pyq and syllabus file URL if present
        allData.pyqs.forEach(item => {
            if (item.file) urls.push({ loc: item.file, priority: 0.8, changefreq: 'monthly' });
        });
        allData.syllabus.forEach(item => {
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

        // Upload to Firebase Storage
        const blob = new Blob([sitemapXml], { type: 'application/xml' });
        const ref = storage.ref().child('sitemap.xml');
        updateSitemapStatus('uploading');
        ref.put(blob, { contentType: 'application/xml' })
            .then(snapshot => snapshot.ref.getDownloadURL())
            .then(url => {
                // Show the download URL to admin
                updateSitemapStatus('done', url);
                alert('Sitemap generated and uploaded. Public URL:\n' + url);
            })
            .catch(err => {
                console.error('Error uploading sitemap:', err);
                updateSitemapStatus('error');
                alert('Failed to upload sitemap: ' + err.message);
            });
    } catch (err) {
        console.error('Error generating sitemap:', err);
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
    renderSyllabus();
}

function renderPyqs() {
    const list = document.getElementById('pyqsList');
    list.innerHTML = allData.pyqs.map((pyq, index) => `
        <div class="list-group-item d-flex justify-content-between align-items-center">
            <div>
                <strong>${pyq.title}</strong><br>
                <small>${pyq.file}</small>
            </div>
            <div>
                <button class="btn btn-sm btn-outline-primary me-2" onclick="editPyq(${index})">Edit</button>
                <button class="btn btn-sm btn-outline-danger" onclick="deleteItem('pyqs', ${index})">Delete</button>
            </div>
        </div>
    `).join('');
}

function renderSyllabus() {
    const list = document.getElementById('syllabusList');
    list.innerHTML = allData.syllabus.map((syllabus, index) => `
        <div class="list-group-item d-flex justify-content-between align-items-center">
            <div>
                <strong>${syllabus.title}</strong><br>
                <small>${syllabus.file}</small><br>
                <small>Course: ${syllabus.course || 'N/A'} | Semester: ${syllabus.semester || 'N/A'}</small>
            </div>
            <div>
                <button class="btn btn-sm btn-outline-primary me-2" onclick="editSyllabus(${index})">Edit</button>
                <button class="btn btn-sm btn-outline-danger" onclick="deleteItem('syllabus', ${index})">Delete</button>
            </div>
        </div>
    `).join('');
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

// Global functions for onclick
window.editPyq = function(index) {
    const pyq = allData.pyqs[index];
    document.getElementById('editType').value = 'pyqs';
    document.getElementById('editIndex').value = index;
    document.getElementById('editTitle').value = pyq.title;
    document.getElementById('editFile').value = pyq.file;
    document.getElementById('editCourseDiv').style.display = 'none';
    document.getElementById('editSemesterDiv').style.display = 'none';
    new bootstrap.Modal(document.getElementById('editModal')).show();
};

window.editSyllabus = function(index) {
    const syllabus = allData.syllabus[index];
    document.getElementById('editType').value = 'syllabus';
    document.getElementById('editIndex').value = index;
    document.getElementById('editTitle').value = syllabus.title;
    document.getElementById('editFile').value = syllabus.file;
    document.getElementById('editCourse').value = syllabus.course || '';
    document.getElementById('editSemester').value = syllabus.semester || '';
    document.getElementById('editCourseDiv').style.display = 'block';
    document.getElementById('editSemesterDiv').style.display = 'block';
    new bootstrap.Modal(document.getElementById('editModal')).show();
};

window.deleteItem = deleteItem;
// Pending Uploads Management
function loadPendingUploads() {
    db.collection('pendingUploads').where('status', '==', 'pending').get()
        .then(snapshot => {
            const pendingCount = snapshot.size;
            document.getElementById('pendingCount').textContent = pendingCount;
            
            if (pendingCount === 0) {
                document.getElementById('pendingUploadsList').innerHTML = '';
                document.getElementById('noPendingMessage').style.display = 'block';
            } else {
                document.getElementById('noPendingMessage').style.display = 'none';
                renderPendingUploads(snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() })));
            }
        })
        .catch(error => {
            console.error('Error loading pending uploads:', error);
        });
}

function renderPendingUploads(pendingDocs) {
    const list = document.getElementById('pendingUploadsList');
    list.innerHTML = pendingDocs.map((doc, index) => {
        // doc is already a converted object with { id, ...data }
        const data = doc;
        const uploadDate = data.uploadedAt ? new Date(data.uploadedAt.toDate()).toLocaleString() : 'Unknown';
        return `
            <div class="list-group-item">
                <div class="d-flex justify-content-between align-items-start">
                    <div style="flex: 1;">
                        <h6 class="mb-1"><strong>${data.title}</strong></h6>
                        <small class="text-muted d-block">
                            File: <code>${data.fileName}</code>
                        </small>
                        <small class="text-muted d-block">
                            Course: ${data.course || 'N/A'} | Semester: ${data.semester || 'N/A'}
                        </small>
                        <small class="text-muted d-block">
                            Uploaded by: <strong>${data.studentName || 'Anonymous'}</strong> | ${uploadDate}
                        </small>
                    </div>
                    <div class="btn-group ms-3" role="group">
                        <button class="btn btn-sm btn-outline-info" onclick="downloadPendingFile('${data.downloadUrl}', '${data.fileName.replace(/'/g, "\\'")}')">
                            <i class="fas fa-download"></i> Download
                        </button>
                        <button class="btn btn-sm btn-outline-danger" onclick="deletePendingUpload('${doc.id}')">
                            <i class="fas fa-trash"></i> Delete
                        </button>
                    </div>
                </div>
            </div>
        `;
    }).join('');
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
    if (confirm('Delete this pending upload from the list? The file on tmpfile.org will auto-delete after 30 days.')) {
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

window.loadSyllabusOnDemand = function() {
    if (syllabusLoaded) return;
    syllabusLoaded = true;
    
    db.collection('syllabus').get()
        .then(syllabusSnap => {
            allData.syllabus = syllabusSnap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
            document.getElementById('syllabusCount').textContent = allData.syllabus.length;
            renderSyllabus();
        })
        .catch(error => {
            console.error('Error loading Syllabus:', error);
            document.getElementById('syllabusList').innerHTML = '<div class="alert alert-danger">Error loading Syllabus</div>';
        });
};

window.loadPendingOnDemand = function() {
    if (pendingLoaded) return;
    pendingLoaded = true;
    loadPendingUploads();
};
