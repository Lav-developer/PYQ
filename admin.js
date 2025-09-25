// Initialize Firebase
const firebaseConfig = {
    apiKey: "AIzaSyBRlsk-knQs-AMlaTFxlneBMTwlSfwyFaQ",
    authDomain: "dsmnru-data.firebaseapp.com",
    databaseURL: "https://dsmnru-data-default-rtdb.firebaseio.com",
    projectId: "dsmnru-data",
    storageBucket: "dsmnru-data.firebasestorage.app",
    messagingSenderId: "62250453477",
    appId: "1:62250453477:web:087c07403e4fead220470c",
    measurementId: "G-VL6V3T96YX"
};

firebase.initializeApp(firebaseConfig);

const auth = firebase.auth();
const database = firebase.database();
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
    database.ref().once('value')
        .then(snapshot => {
            allData = snapshot.val() || { pyqs: [], syllabus: [] };
            renderLists();
        })
        .catch(error => {
            console.error('Error loading data:', error);
        });
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
    allData[type].push(item);
    saveData();
}

function editItem(type, index, item) {
    allData[type][index] = item;
    saveData();
}

function deleteItem(type, index) {
    if (confirm('Are you sure you want to delete this item?')) {
        allData[type].splice(index, 1);
        saveData();
    }
}

function saveData() {
    database.ref().set(allData)
        .then(() => {
            alert('Data saved successfully!');
            renderLists();
        })
        .catch(error => {
            console.error('Error saving data:', error);
            alert('Error saving data. Please try again.');
        });
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
