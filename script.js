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

// Firebase Storage and Firestore references
const db = firebase.firestore();
const auth = firebase.auth();

db.enablePersistence({ synchronizeTabs: true }).catch((error) => {
    // Multi-tab and unsupported-browser failures are safe to ignore for this app.
    if (error.code !== 'failed-precondition' && error.code !== 'unimplemented') {
        console.warn('Firestore persistence unavailable:', error.message);
    }
});

// ===== API CONFIGURATION (Cloudflare Worker) =====
// Public data (PYQs, search, contributors, homepage) now comes from the
// Cloudflare Worker API — never from direct full-collection Firestore reads.
// The browser still talks to Firestore directly ONLY for user-scoped data:
// auth/profile, comments, feedback, uploads, and view increments.
//
// Set the Worker URL via window.DSMNRU_API_URL (see index.html/paper.html)
// or via a Netlify `_redirects` proxy of `/api/*` to the Worker.
const API_BASE_URL = (typeof window.DSMNRU_API_URL !== 'undefined' && window.DSMNRU_API_URL)
    ? window.DSMNRU_API_URL
    : '/api';

async function apiGet(path, params) {
    const query = params ? '?' + new URLSearchParams(params).toString() : '';
    const res = await fetch(API_BASE_URL + path + query, {
        headers: { 'Accept': 'application/json' }
    });
    if (!res.ok) {
        throw new Error('API error ' + res.status);
    }
    return res.json();
}

// Paginated PYQ list from the Worker (page/limit/sort/filters)
async function fetchPyqsPage(page, limit, sort) {
    return apiGet('/pyqs', { page: String(page), limit: String(limit), sort: sort || 'newest' });
}

// Server-side search over the Worker's KV-cached search index
async function searchPyqs(params) {
    return apiGet('/pyqs/search', params);
}

// Single PYQ full document (includes file/server URLs)
async function fetchPyqById(id) {
    return apiGet('/pyqs/' + encodeURIComponent(id));
}

// Contributors list (KV-cached, long TTL)
async function fetchContributors() {
    return apiGet('/contributors');
}

// Homepage summary: recent, trending, course counts, stats
async function fetchHomepage() {
    return apiGet('/homepage');
}

// Aggregated stats
async function fetchStats() {
    return apiGet('/stats');
}

// ===== CLIENT CACHE FOR API RESPONSES =====
// The Worker + Cloudflare KV/edge cache already serve most traffic with zero
// Firestore reads. This small session cache just avoids repeat API calls
// within a single page session. It never stores the full collection.
const API_SESSION_CACHE = {};
const API_SESSION_TTL_MS = 2 * 60 * 1000; // 2 minutes

function getApiSessionCache(key) {
    const entry = API_SESSION_CACHE[key];
    if (entry && Date.now() - entry.t < API_SESSION_TTL_MS) {
        return entry.data;
    }
    return null;
}

function setApiSessionCache(key, data) {
    try {
        API_SESSION_CACHE[key] = { data, t: Date.now() };
        // keep the in-memory map small
        const keys = Object.keys(API_SESSION_CACHE);
        if (keys.length > 50) {
            delete API_SESSION_CACHE[keys[0]];
        }
    } catch (e) { /* ignore */ }
}

// Cached fetch of a PYQ page (used by browsing + Load More)
async function fetchPyqsPageCached(page, limit, sort) {
    const key = 'pyqs:' + page + ':' + limit + ':' + (sort || 'newest');
    const cached = getApiSessionCache(key);
    if (cached) return cached;
    const data = await fetchPyqsPage(page, limit, sort);
    setApiSessionCache(key, data);
    return data;
}

function clearPyqsCache() {
    for (const key of Object.keys(API_SESSION_CACHE)) {
        delete API_SESSION_CACHE[key];
    }
}

// Courses loaded from local courses.json (used to populate course selects)
let coursesList = [];

// Fetch courses.json and populate course filters on the homepage
function fetchCoursesJson() {
    fetch('courses.json')
        .then(res => {
            if (!res.ok) throw new Error('Unable to load courses.json');
            return res.json();
        })
        .then(data => {
            // courses.json has structure { courses: [...] }
            if (data && Array.isArray(data.courses)) {
                coursesList = data.courses;
                try { populateCourseFilter(); } catch (e) { /* ignore */ }
            }
        })
        .catch(err => {
            console.warn('courses.json not loaded:', err.message);
        });
}

// Populate the course select used for filtering on the homepage
function populateCourseFilter() {
    const select = document.getElementById('filterCourse');
    if (!select) return;

    if (!coursesList || !coursesList.length) return;

    // Clear all options and rebuild
    select.innerHTML = '';
    
    // Add "All Courses" option first
    const allOption = document.createElement('option');
    allOption.value = '';
    allOption.textContent = 'All Courses';
    select.appendChild(allOption);

    // Add courses from courses.json
    coursesList.forEach(course => {
        const label = typeof course === 'string' ? course : (course.name || course.label || '');
        if (!label) return;
        const opt = document.createElement('option');
        opt.value = label;
        opt.textContent = label;
        select.appendChild(opt);
    });
}

// Kick off load on script initialization (ensure DOM is ready)
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', fetchCoursesJson);
} else {
    fetchCoursesJson();
}

// ===== USER AUTHENTICATION & PROFILE MANAGEMENT =====

// Global user state
let currentUser = null;
let searchGateVisible = false;

function isGoogleUser(user) {
    if (!user || !Array.isArray(user.providerData)) return false;
    return user.providerData.some(provider => provider && provider.providerId === 'google.com');
}

function requiresEmailVerification(user) {
    return !!user && !isGoogleUser(user) && !user.emailVerified;
}

async function ensureUserDocumentSynced(user) {
    if (!user) return;

    const googleAccount = isGoogleUser(user);

    const userRef = db.collection('users').doc(user.uid);
    const existingDoc = await userRef.get();
    const existingData = existingDoc.exists ? existingDoc.data() : {};

    await userRef.set({
        uid: user.uid,
        email: user.email || existingData.email || '',
        name: existingData.name || existingData.signupName || user.displayName || 'User',
        signupName: existingData.signupName || existingData.name || user.displayName || 'User',
        signupEmail: existingData.signupEmail || existingData.email || user.email || '',
        signupCourse: existingData.signupCourse || existingData.course || '',
        course: existingData.course || existingData.signupCourse || '',
        phone: existingData.phone || '',
        role: existingData.role || 'user',
        emailVerified: !!user.emailVerified || googleAccount,
        createdAt: existingData.createdAt || firebase.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
}

async function sendSubscriberToMakeOnce(uid, name, email, source) {
    if (!uid || !email) return false;

    const userRef = db.collection('users').doc(uid);
    const shouldSend = await db.runTransaction(async transaction => {
        const snapshot = await transaction.get(userRef);
        const data = snapshot.exists ? snapshot.data() : {};

        if (data.makeSubscriberSynced === true || data.makeSubscriberSyncInProgress === true) {
            return false;
        }

        transaction.set(userRef, {
            makeSubscriberSyncInProgress: true,
            makeSubscriberSyncSource: source || 'unknown',
            makeSubscriberSyncRequestedAt: firebase.firestore.FieldValue.serverTimestamp()
        }, { merge: true });

        return true;
    });

    if (!shouldSend) {
        return false;
    }

    try {
        await sendSubscriberToMake(name, email);
        await userRef.set({
            makeSubscriberSynced: true,
            makeSubscriberSyncInProgress: false,
            makeSubscriberSyncedAt: firebase.firestore.FieldValue.serverTimestamp(),
            makeSubscriberSyncError: ''
        }, { merge: true });
        return true;
    } catch (error) {
        await userRef.set({
            makeSubscriberSynced: false,
            makeSubscriberSyncInProgress: false,
            makeSubscriberSyncError: error?.message || 'Webhook request failed',
            makeSubscriberSyncFailedAt: firebase.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
        throw error;
    }
}

// Update UI based on auth state
function updateUploadAccessUI() {
    const uploadSection = document.querySelector('.upload-section');
    const uploadOverlay = document.getElementById('uploadFormLockOverlay');
    const uploadForm = document.getElementById('userUploadForm');
    if (!uploadSection || !uploadOverlay || !uploadForm) return;

    const formControls = uploadForm.querySelectorAll('input, button');
    uploadSection.classList.remove('upload-locked');
    uploadOverlay.style.display = 'none';
    formControls.forEach(control => {
        control.disabled = false;
    });
}

// Monitor auth state changes
auth.onAuthStateChanged(user => {
    currentUser = user;
    updateUserUI();
    updateUploadAccessUI();
    updatePyqFilterUI();
    // handle verification block overlay
    if (!user) {
        hideVerificationBlock();
    } else if (requiresEmailVerification(user)) {
        // will be confirmed after reload
    }
    if (user) {
        // Check if email is verified
        user.reload()
            .then(async () => {
                await ensureUserDocumentSynced(user);
                if (requiresEmailVerification(user)) {
                    showEmailVerificationPrompt();
                } else {
                    hideVerificationBlock();
                    loadUserProfile();
                    checkAndShowProfileCompletionReminder();
                    const searchInput = document.getElementById('searchInput');
                    if (searchInput && searchInput.value.trim()) {
                        performSearch();
                    }
                }
            })
            .catch(error => {
                console.error('Error syncing auth user with Firestore profile:', error);
                if (user && requiresEmailVerification(user)) showEmailVerificationPrompt();
            });
    } else {
        hideVerificationBlock();
    }
});

// Update UI based on auth state
function updateUserUI() {
    const loggedOutMenu = document.getElementById('userLoggedOutMenu');
    const loggedInMenu = document.getElementById('userLoggedInMenu');
    const profileBtn = document.getElementById('profileBtn');
    const userDisplayName = document.getElementById('userDisplayName');

    if (currentUser) {
        loggedOutMenu.style.display = 'none';
        loggedInMenu.style.display = 'block';
        userDisplayName.textContent = currentUser.displayName || currentUser.email.split('@')[0];
        document.getElementById('userNameDisplay').textContent = currentUser.displayName || 'User';
        document.getElementById('userEmailDisplay').textContent = currentUser.email;
        
        // Show verification badge if email not verified
        const verificationBadge = document.getElementById('emailVerificationBadge');
        if (verificationBadge) {
            if (requiresEmailVerification(currentUser)) {
                verificationBadge.style.display = 'inline-block';
            } else {
                verificationBadge.style.display = 'none';
            }
        }
    } else {
        loggedOutMenu.style.display = 'block';
        loggedInMenu.style.display = 'none';
        userDisplayName.textContent = 'Login';
    }
}

// Profile dropdown toggle
function toggleProfileDropdown() {
    const dropdown = document.getElementById('profileDropdown');
    dropdown.style.display = dropdown.style.display === 'none' ? 'block' : 'none';
}

// Close dropdown when clicking outside
document.addEventListener('click', function(event) {
    const profileSection = document.querySelector('.user-profile-section');
    if (!profileSection.contains(event.target)) {
        document.getElementById('profileDropdown').style.display = 'none';
    }
});

// ===== LOGIN FUNCTIONS =====
function openLoginModal() {
    document.getElementById('profileDropdown').style.display = 'none';
    const modal = new bootstrap.Modal(document.getElementById('loginModal'));
    modal.show();
}

function closeLoginModal() {
    const modal = bootstrap.Modal.getInstance(document.getElementById('loginModal'));
    if (modal) modal.hide();
}

async function signInWithGoogle(providerEntryPoint) {
    try {
        const provider = new firebase.auth.GoogleAuthProvider();
        const result = await auth.signInWithPopup(provider);
        await result.user.reload();
        await ensureUserDocumentSynced(result.user);

        // --- NEW CODE: SEND GOOGLE SIGNUPS TO MAKE.COM ---
        // Firebase tells us if this is their first time ever logging in
        const isNewUser = result.additionalUserInfo?.isNewUser || providerEntryPoint === 'signup';
        
        if (isNewUser) {
            const displayName = result.user.displayName || result.user.email.split('@')[0] || 'User';
            await sendSubscriberToMakeOnce(result.user.uid, displayName, result.user.email, 'google-signup');
        }
        // -------------------------------------------------

        const loginModal = bootstrap.Modal.getInstance(document.getElementById('loginModal'));
        if (loginModal) loginModal.hide();
        const signupModal = bootstrap.Modal.getInstance(document.getElementById('signupModal'));
        if (signupModal) signupModal.hide();

        document.getElementById('loginForm').reset();
        document.getElementById('signupForm').reset();

        Swal.fire({
            title: 'Signed in with Google',
            text: providerEntryPoint === 'signup' ? 'Your Google account was created and signed in.' : 'You are now signed in with your Google account.',
            icon: 'success'
        });
        // Ensure filter UI updates immediately after sign in
        try { updatePyqFilterUI(); populateCourseFilter(); } catch (e) { /* ignore */ }
    } catch (error) {
        const message = error.code === 'auth/popup-closed-by-user'
            ? 'Google sign-in was cancelled.'
            : error.message;
        const errorDiv = providerEntryPoint === 'signup'
            ? document.getElementById('signupError')
            : document.getElementById('loginError');

        if (errorDiv) {
            errorDiv.textContent = message;
            errorDiv.style.display = 'block';
        } else {
            Swal.fire('Error', message, 'error');
        }
    }
}

document.getElementById('loginForm').addEventListener('submit', async function(e) {
    e.preventDefault();
    const email = document.getElementById('loginEmail').value;
    const password = document.getElementById('loginPassword').value;
    const errorDiv = document.getElementById('loginError');

    try {
        errorDiv.style.display = 'none';
        const result = await auth.signInWithEmailAndPassword(email, password);
        await result.user.reload();
        
        closeLoginModal();
        document.getElementById('loginForm').reset();
        
        if (!requiresEmailVerification(result.user)) {
            Swal.fire('Success', 'Logged in successfully!', 'success');
            try { updatePyqFilterUI(); populateCourseFilter(); } catch (e) {}
        } else {
            Swal.fire({
                title: 'Welcome Back!',
                html: '<p>Your email is not verified yet.</p><p>Please verify your email to unlock all features.</p>',
                icon: 'info'
            });
            showEmailVerificationPrompt();
        }
    } catch (error) {
        errorDiv.textContent = error.message;
        errorDiv.style.display = 'block';
    }
});

// Function to send new users to the beehiiv/Make.com mailing list
async function sendSubscriberToMake(name, email) {
    const webhookUrl = "https://hook.us2.make.com/sc9ldu43pg3hnq48y9d6s6fds6j48bqk";
    try {
        const response = await fetch(webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: name, email: email })
        });

        if (!response.ok) {
            throw new Error(`Make.com webhook returned ${response.status}`);
        }

        console.log('Subscriber sent to Make.com successfully!');
    } catch (err) {
        console.error('Make.com webhook failed:', err);
        throw err;
    }
}

// ===== SIGNUP FUNCTIONS =====
function openSignupModal() {
    document.getElementById('profileDropdown').style.display = 'none';
    const modal = new bootstrap.Modal(document.getElementById('signupModal'));
    modal.show();
}

function closeSearchGateModal() {
    const modalElement = document.getElementById('searchGateModal');
    const modal = bootstrap.Modal.getInstance(modalElement) || bootstrap.Modal.getOrCreateInstance(modalElement);
    modal.hide();
    searchGateVisible = false;
}

function openSearchGateModal() {
    if (searchGateVisible) return;
    const modalElement = document.getElementById('searchGateModal');
    const modal = bootstrap.Modal.getOrCreateInstance(modalElement, {
        backdrop: 'static',
        keyboard: false
    });
    searchGateVisible = true;
    modal.show();
}

const searchGateModalElement = document.getElementById('searchGateModal');
if (searchGateModalElement) {
    searchGateModalElement.addEventListener('shown.bs.modal', function() {
        const backdrop = document.querySelector('.modal-backdrop:last-of-type');
        if (backdrop) {
            backdrop.classList.add('search-gate-backdrop');
        }
    });

    searchGateModalElement.addEventListener('hidden.bs.modal', function() {
        searchGateVisible = false;
        document.querySelectorAll('.modal-backdrop.search-gate-backdrop').forEach(backdrop => {
            backdrop.classList.remove('search-gate-backdrop');
        });
    });
}

function continueBrowsingWithoutSearch() {
    closeSearchGateModal();
    const searchInput = document.getElementById('searchInput');
    if (searchInput) {
        searchInput.value = '';
    }
    performSearch();
}

function closeSignupModal() {
    const modal = bootstrap.Modal.getInstance(document.getElementById('signupModal'));
    if (modal) modal.hide();
}

document.getElementById('signupForm').addEventListener('submit', async function(e) {
    e.preventDefault();
    
    // 1. Lock the submit button to prevent double-clicks
    const submitBtn = e.target.querySelector('button[type="submit"]');
    const originalBtnText = submitBtn.innerHTML;
    submitBtn.disabled = true;
    submitBtn.innerHTML = '<span class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span> Creating...';

    const email = document.getElementById('signupEmail').value.trim();
    const password = document.getElementById('signupPassword').value;
    const confirmPassword = document.getElementById('signupConfirmPassword').value;
    const errorDiv = document.getElementById('signupError');

    if (!email || !password || !confirmPassword) {
        errorDiv.textContent = 'Email, password, and password confirmation are required.';
        errorDiv.style.display = 'block';
        resetButton();
        return;
    }

    if (password !== confirmPassword) {
        errorDiv.textContent = 'Passwords do not match';
        errorDiv.style.display = 'block';
        resetButton();
        return;
    }

    try {
        errorDiv.style.display = 'none';
        const userCredential = await auth.createUserWithEmailAndPassword(email, password);
        const user = userCredential.user;
        const displayName = email.split('@')[0] || 'User';

        // Update user profile
        await user.updateProfile({ displayName });

        // Send verification email only for non-Google password accounts
        if (!isGoogleUser(user)) {
            await user.sendEmailVerification();
        }

        // Create user document in Firestore
        await db.collection('users').doc(user.uid).set({
            uid: user.uid,
            email: email,
            signupEmail: email,
            name: displayName,
            signupName: displayName,
            course: '',
            signupCourse: '',
            emailVerified: isGoogleUser(user) ? true : false,
            createdAt: firebase.firestore.FieldValue.serverTimestamp(),
            phone: '',
            preferences: {},
            role: 'user'
        }, { merge: true });

        // 2. Safely call the webhook ONLY after Firestore succeeds
        await sendSubscriberToMakeOnce(user.uid, displayName, email, 'email-signup');

        closeSignupModal();
        document.getElementById('signupForm').reset();
        
        // Show success message with verification instruction
        Swal.fire({
            title: 'Account Created!',
            html: isGoogleUser(user)
                ? '<p>Google account created successfully.</p><p>You can use the app immediately. No email verification is needed.</p>'
                : `<p>Account created successfully!</p><p>A verification email has been sent to <strong>${email}</strong>.</p><p>Please check your email and click the verification link to activate your account.</p><p>You can add your name, course, and phone number later from your profile.</p>`,
            icon: 'success',
            confirmButtonText: 'OK'
        });
        // Update filter UI immediately for newly created users
        try { updatePyqFilterUI(); populateCourseFilter(); } catch (e) {}
    } catch (error) {
        errorDiv.textContent = error.message;
        errorDiv.style.display = 'block';
    } finally {
        // Always unlock the button when finished
        resetButton();
    }

    function resetButton() {
        submitBtn.disabled = false;
        submitBtn.innerHTML = originalBtnText;
    }
});

// ===== PROFILE FUNCTIONS =====
function openProfileModal() {
    document.getElementById('profileDropdown').style.display = 'none';
    if (currentUser) {
        loadUserProfile();
        const modal = new bootstrap.Modal(document.getElementById('profileModal'));
        modal.show();
    }
}

async function loadUserProfile() {
    if (!currentUser) return;
    
    try {
        await ensureUserDocumentSynced(currentUser);
        const userDoc = await db.collection('users').doc(currentUser.uid).get();
        if (userDoc.exists) {
            const userData = userDoc.data();
            const nameValue = userData.name || userData.signupName || currentUser.displayName || '';
            const emailValue = userData.email || userData.signupEmail || currentUser.email || '';
            const courseValue = userData.course || userData.signupCourse || '';
            const phoneValue = userData.phone || '';

            document.getElementById('profileName').value = nameValue;
            document.getElementById('profileEmail').value = emailValue;
            document.getElementById('profileCourse').value = courseValue;
            document.getElementById('profilePhone').value = phoneValue;

            document.getElementById('profileEmail').readOnly = true;
            
            if (userData.createdAt) {
                const date = new Date(userData.createdAt.toDate()).toLocaleDateString();
                document.getElementById('profileCreatedDate').textContent = date;
            }
        } else {
            document.getElementById('profileName').value = currentUser.displayName || 'User';
            document.getElementById('profileEmail').value = currentUser.email || '';
            document.getElementById('profileCourse').value = '';
            document.getElementById('profilePhone').value = '';
        }
    } catch (error) {
        console.error('Error loading profile:', error);
    }
}

document.getElementById('profileForm').addEventListener('submit', async function(e) {
    e.preventDefault();
    if (!currentUser) return;

    const name = document.getElementById('profileName').value.trim();
    const course = document.getElementById('profileCourse').value.trim();
    const phone = document.getElementById('profilePhone').value.trim();
    const errorDiv = document.getElementById('profileError');
    const successDiv = document.getElementById('profileSuccess');

    if (!phone) {
        errorDiv.textContent = 'Phone number is required.';
        errorDiv.style.display = 'block';
        return;
    }

    try {
        errorDiv.style.display = 'none';
        successDiv.style.display = 'none';

        // Update auth profile
        await currentUser.updateProfile({
            displayName: name
        });

        // Update Firestore user document
        await db.collection('users').doc(currentUser.uid).set({
            name: name,
            course: course,
            phone: phone,
            email: currentUser.email,
            uid: currentUser.uid
        }, { merge: true });

        successDiv.textContent = 'Profile updated successfully!';
        successDiv.style.display = 'block';
        updateUserUI();
        
        // Clear dismissal timestamp so reminder won't show again for this profile
        localStorage.removeItem('profileCompletionDismissed');
        
        // Close the profile completion reminder modal if it's open
        const profileCompletionModal = bootstrap.Modal.getInstance(document.getElementById('profileCompletionModal'));
        if (profileCompletionModal) {
            profileCompletionModal.hide();
        }
        
        setTimeout(() => {
            successDiv.style.display = 'none';
        }, 3000);
    } catch (error) {
        errorDiv.textContent = error.message;
        errorDiv.style.display = 'block';
    }
});

// ===== SETTINGS FUNCTIONS =====
function openSettingsModal() {
    document.getElementById('profileDropdown').style.display = 'none';
    const modal = new bootstrap.Modal(document.getElementById('settingsModal'));
    modal.show();
}

function openChangePasswordModal() {
    const settingsModal = bootstrap.Modal.getInstance(document.getElementById('settingsModal'));
    if (settingsModal) settingsModal.hide();
    
    const modal = new bootstrap.Modal(document.getElementById('changePasswordModal'));
    modal.show();
}

document.getElementById('changePasswordForm').addEventListener('submit', async function(e) {
    e.preventDefault();
    if (!currentUser) return;

    const currentPassword = document.getElementById('currentPassword').value;
    const newPassword = document.getElementById('newPassword').value;
    const confirmPassword = document.getElementById('confirmNewPassword').value;
    const errorDiv = document.getElementById('passwordError');
    const successDiv = document.getElementById('passwordSuccess');

    if (newPassword !== confirmPassword) {
        errorDiv.textContent = 'New passwords do not match';
        errorDiv.style.display = 'block';
        return;
    }

    try {
        errorDiv.style.display = 'none';
        successDiv.style.display = 'none';

        // Re-authenticate user
        const credential = firebase.auth.EmailAuthProvider.credential(
            currentUser.email,
            currentPassword
        );
        await currentUser.reauthenticateWithCredential(credential);

        // Update password
        await currentUser.updatePassword(newPassword);

        successDiv.textContent = 'Password updated successfully!';
        successDiv.style.display = 'block';
        document.getElementById('changePasswordForm').reset();

        setTimeout(() => {
            const modal = bootstrap.Modal.getInstance(document.getElementById('changePasswordModal'));
            if (modal) modal.hide();
        }, 2000);
    } catch (error) {
        errorDiv.textContent = error.message;
        errorDiv.style.display = 'block';
    }
});

function deleteAccountConfirm() {
    Swal.fire({
        title: 'Delete Account?',
        text: 'This action cannot be undone. All your data will be permanently deleted.',
        icon: 'warning',
        showCancelButton: true,
        confirmButtonColor: '#d33',
        cancelButtonColor: '#3085d6',
        confirmButtonText: 'Yes, delete my account'
    }).then(async (result) => {
        if (result.isConfirmed) {
            try {
                const user = auth.currentUser;
                await db.collection('users').doc(user.uid).delete();
                await user.delete();
                Swal.fire('Deleted', 'Your account has been deleted.', 'success');
            } catch (error) {
                Swal.fire('Error', error.message, 'error');
            }
        }
    });
}

// ===== EMAIL VERIFICATION FUNCTIONS =====
let _verificationBlockEl = null;
function ensureVerificationBlock() {
    if (_verificationBlockEl) return _verificationBlockEl;
    _verificationBlockEl = document.createElement('div');
    _verificationBlockEl.id = 'verificationBlockOverlay';
    _verificationBlockEl.style.cssText = 'position:fixed;inset:0;background:rgba(2,6,23,0.92);backdrop-filter:blur(8px);z-index:1085;display:none;align-items:center;justify-content:center;padding:1rem;';
    _verificationBlockEl.innerHTML = `<div style="max-width:460px;width:100%;background:linear-gradient(180deg, rgba(15,23,42,0.96), rgba(15,23,42,0.88));border:1px solid rgba(110,231,216,0.22);border-radius:22px;padding:1.5rem 1.25rem;text-align:center;box-shadow:0 20px 50px rgba(0,0,0,0.5);">
        <div style="width:64px;height:64px;margin:0 auto 12px;border-radius:50%;display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,#f59e0b,#f97316);color:#fff;font-size:1.6rem;"><i class="fas fa-envelope"></i></div>
        <h5 style="color:#f8fafc;font-weight:800;margin:0 0 8px;">Verify your email to continue</h5>
        <p style="color:rgba(203,213,225,0.78);font-size:13px;line-height:1.5;margin:0 0 14px;">We sent a link to <strong id="verificationBlockEmail" style="color:#f8fafc;"></strong>. You must verify before you can search, view papers or comment. Check spam too.</p>
        <div style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap;">
            <button class="btn btn-primary btn-sm" onclick="resendVerificationEmail()"><i class="fas fa-redo me-1"></i> Resend email</button>
            <button class="btn btn-outline-light btn-sm" onclick="checkEmailVerification()"><i class="fas fa-check me-1"></i> I verified — Check</button>
            <button class="btn btn-outline-danger btn-sm" onclick="logoutAndChangeEmail()"><i class="fas fa-sign-out-alt me-1"></i> Use different email</button>
        </div>
        <small style="color:rgba(203,213,225,0.55);display:block;margin-top:10px;">No email? Click “Use different email” to delete this unverified account and sign up again.</small>
    </div>`;
    document.body.appendChild(_verificationBlockEl);
    return _verificationBlockEl;
}
function showEmailVerificationPrompt() {
    if (!currentUser) return;
    const modalElement = document.getElementById('emailVerificationModal');
    const blockEl = ensureVerificationBlock();
    const emailEl = document.getElementById('verificationEmail');
    const blockEmailEl = document.getElementById('verificationBlockEmail');
    if (emailEl) emailEl.textContent = currentUser.email;
    if (blockEmailEl) blockEmailEl.textContent = currentUser.email;
    // Show blocking overlay (covers entire page, cannot be bypassed by closing modal)
    if (blockEl) blockEl.style.display = 'flex';
    // Also show the Bootstrap modal as static (cannot be dismissed)
    if (modalElement) {
        const modal = bootstrap.Modal.getOrCreateInstance(modalElement, {backdrop: 'static', keyboard: false});
        modal.show();
        // If user somehow hides the modal (console), re-show while still unverified
        modalElement.addEventListener('hidden.bs.modal', function handler() {
            if (currentUser && requiresEmailVerification(currentUser)) {
                setTimeout(() => {
                    const m = bootstrap.Modal.getOrCreateInstance(modalElement, {backdrop: 'static', keyboard: false});
                    m.show();
                }, 200);
            } else {
                modalElement.removeEventListener('hidden.bs.modal', handler);
                if (blockEl) blockEl.style.display = 'none';
            }
        });
    }
}
function hideVerificationBlock() {
    ['verificationBlockOverlay','paperVerificationBlock'].forEach(id=>{
        const el=document.getElementById(id);
        if(el) el.style.display='none';
    });
    const modalElement = document.getElementById('emailVerificationModal');
    if (modalElement) {
        try { bootstrap.Modal.getInstance(modalElement)?.hide(); } catch(e){}
    }
}
function isVerifiedOrPrompt() {
    if (currentUser && requiresEmailVerification(currentUser)) {
        showEmailVerificationPrompt();
        return false;
    }
    return true;
}

async function logoutAndChangeEmail() {
    Swal.fire({
        title: 'Use Different Email?',
        html: '<p>This will log you out so you can create a new account with a different email address.</p><p><strong>Note:</strong> Your current unverified account will be deleted.</p>',
        icon: 'question',
        showCancelButton: true,
        confirmButtonColor: '#d33',
        confirmButtonText: 'Yes, logout and change email',
        cancelButtonText: 'Cancel'
    }).then(async (result) => {
        if (result.isConfirmed) {
            try {
                const user = auth.currentUser;
                const uid = user.uid;
                
                // Close verification modal
                const modal = bootstrap.Modal.getInstance(document.getElementById('emailVerificationModal'));
                if (modal) modal.hide();
                
                // Delete user data from Firestore
                await db.collection('users').doc(uid).delete();
                
                // Delete Firebase Auth user
                await user.delete();
                
                // Sign out
                await auth.signOut();
                
                Swal.fire({
                    title: 'Account Deleted',
                    text: 'Your account has been deleted. You can now sign up with a different email.',
                    icon: 'success'
                }).then(() => {
                    // Show signup modal
                    openSignupModal();
                });
            } catch (error) {
                if (error.code === 'auth/requires-recent-login') {
                    Swal.fire({
                        title: 'Re-authentication Required',
                        text: 'Please log out and log back in to delete your account. Then try again.',
                        icon: 'warning'
                    }).then(async () => {
                        await auth.signOut();
                        window.location.reload();
                    });
                } else {
                    Swal.fire('Error', error.message, 'error');
                }
            }
        }
    });
}

async function resendVerificationEmail() {
    try {
        const resendBtn = document.getElementById('resendVerificationBtn');
        const originalText = resendBtn.innerHTML;
        resendBtn.disabled = true;
        
        await currentUser.sendEmailVerification();
        
        Swal.fire({
            title: 'Email Sent!',
            text: 'Verification email has been sent to ' + currentUser.email,
            icon: 'success',
            timer: 3000
        });
        
        resendBtn.disabled = false;
        resendBtn.innerHTML = originalText;
    } catch (error) {
        Swal.fire('Error', error.message, 'error');
        resendBtn.disabled = false;
    }
}

async function checkEmailVerification() {
    try {
        await currentUser.reload();
        
        if (currentUser.emailVerified) {
            // Update Firestore document
            await db.collection('users').doc(currentUser.uid).set({
                emailVerified: true
            }, { merge: true });
            
            hideVerificationBlock();
            const modal = bootstrap.Modal.getInstance(document.getElementById('emailVerificationModal'));
            if (modal) modal.hide();
            
            Swal.fire({
                title: 'Email Verified!',
                text: 'Your email has been verified successfully. You now have full access to all features.',
                icon: 'success'
            });
            
            updateUploadAccessUI();
            // also reload profile and allow actions
            try { await ensureUserDocumentSynced(currentUser); loadUserProfile(); } catch(e){}
        } else {
            Swal.fire({
                title: 'Email Not Verified Yet',
                text: 'Please check your email and click the verification link. Then try again.',
                icon: 'info'
            });
        }
    } catch (error) {
        Swal.fire('Error', error.message, 'error');
    }
}

// ===== PROFILE COMPLETION REMINDER FUNCTIONS =====
function isProfileComplete(userData) {
    if (!userData) return false;
    
    // Check if all required fields are present and not empty
    const hasName = userData.name && userData.name.trim() && userData.name !== 'User';
    const hasCourse = userData.course && userData.course.trim();
    const hasPhone = userData.phone && userData.phone.trim();
    
    return hasName && hasCourse && hasPhone;
}

async function checkAndShowProfileCompletionReminder() {
    if (!currentUser) return;
    
    try {
        // Fetch user document to check profile completeness
        const userDoc = await db.collection('users').doc(currentUser.uid).get();
        const userData = userDoc.exists ? userDoc.data() : {};
        
        // Check if profile is incomplete
        if (!isProfileComplete(userData)) {
            // Check if user has dismissed the reminder recently (within 24 hours)
            const lastDismissed = localStorage.getItem('profileCompletionDismissed');
            if (lastDismissed) {
                const hoursSinceDismissed = (Date.now() - parseInt(lastDismissed)) / (1000 * 60 * 60);
                if (hoursSinceDismissed < 24) {
                    // User dismissed recently, don't show again
                    return;
                }
            }
            
            // Show the reminder modal
            showProfileCompletionReminder();
        }
    } catch (error) {
        console.error('Error checking profile completion:', error);
    }
}

function showProfileCompletionReminder() {
    const modalElement = document.getElementById('profileCompletionModal');
    if (modalElement) {
        const modal = new bootstrap.Modal(modalElement, {
            backdrop: 'static',
            keyboard: false
        });
        modal.show();
    }
}

function dismissProfileCompletionReminder() {
    const modal = bootstrap.Modal.getInstance(document.getElementById('profileCompletionModal'));
    if (modal) modal.hide();
    
    // Store timestamp of dismissal in localStorage
    localStorage.setItem('profileCompletionDismissed', Date.now().toString());
}

function openProfileModalFromReminder() {
    const modal = bootstrap.Modal.getInstance(document.getElementById('profileCompletionModal'));
    if (modal) modal.hide();
    
    // Clear the dismissal timestamp so reminder can show again after completion
    localStorage.removeItem('profileCompletionDismissed');
    
    // Open profile modal
    openProfileModal();
}

// ===== LOGOUT FUNCTION =====
function logout() {
    Swal.fire({
        title: 'Logout?',
        text: 'You will be logged out from your account.',
        icon: 'question',
        showCancelButton: true,
        confirmButtonText: 'Yes, logout'
    }).then(async (result) => {
        if (result.isConfirmed) {
            try {
                await auth.signOut();
                document.getElementById('profileDropdown').style.display = 'none';
                Swal.fire('Logged Out', 'You have been logged out successfully.', 'success');
            } catch (error) {
                Swal.fire('Error', error.message, 'error');
            }
        }
    });
}

// User Upload Handler
function isImageFile(file) {
    return !!file && typeof file.type === 'string' && file.type.startsWith('image/');
}

function isPdfFile(file) {
    return !!file && (file.type === 'application/pdf' || /\.pdf$/i.test(file.name || ''));
}

function formatFileSize(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) {
        return '0 B';
    }

    const units = ['B', 'KB', 'MB', 'GB'];
    let size = bytes;
    let unitIndex = 0;

    while (size >= 1024 && unitIndex < units.length - 1) {
        size /= 1024;
        unitIndex += 1;
    }

    const precision = unitIndex === 0 ? 0 : 1;
    return `${size.toFixed(precision)} ${units[unitIndex]}`;
}

function renderSelectedUploadFilesPreview(files) {
    const previewContainer = document.getElementById('uploadFilePreview');
    const previewSummary = document.getElementById('uploadFilePreviewSummary');
    const previewPages = document.getElementById('uploadFilePreviewPages');
    const previewList = document.getElementById('uploadFilePreviewList');

    if (!previewContainer || !previewSummary || !previewPages || !previewList) {
        return;
    }

    const selectedFiles = Array.from(files || []);
    previewList.innerHTML = '';
    previewContainer.classList.remove('is-warning');

    if (!selectedFiles.length) {
        previewContainer.style.display = 'none';
        previewSummary.textContent = 'No files selected';
        previewPages.textContent = 'Estimated pages: 0';
        return;
    }

    const imageFiles = selectedFiles.filter(isImageFile);
    const pdfFiles = selectedFiles.filter(isPdfFile);
    const unsupportedFiles = selectedFiles.filter(file => !isImageFile(file) && !isPdfFile(file));
    const totalSize = selectedFiles.reduce((sum, file) => sum + (file.size || 0), 0);

    let summaryText = `${selectedFiles.length} file(s) selected (${formatFileSize(totalSize)})`;
    let pagesText = 'Estimated pages: 0';

    if (imageFiles.length && !pdfFiles.length) {
        pagesText = `Estimated pages after conversion: ~${imageFiles.length}`;
    } else if (pdfFiles.length === 1 && !imageFiles.length) {
        const pdfSize = pdfFiles[0].size || 0;
        summaryText = `1 PDF selected (${formatFileSize(pdfSize)})`;
        pagesText = 'Estimated pages: using existing PDF';
    } else if (pdfFiles.length && imageFiles.length) {
        previewContainer.classList.add('is-warning');
        pagesText = `Estimated pages: ~${imageFiles.length} (images only)`;
        summaryText = 'Mixed selection detected (PDF + images). Please choose one mode.';
    } else if (unsupportedFiles.length) {
        previewContainer.classList.add('is-warning');
        pagesText = 'Estimated pages: unsupported file type selected';
    }

    if (unsupportedFiles.length) {
        previewContainer.classList.add('is-warning');
    }

    previewSummary.textContent = summaryText;
    previewPages.textContent = pagesText;
    previewContainer.style.display = 'block';

    selectedFiles.forEach(file => {
        const item = document.createElement('li');
        const name = document.createElement('span');
        const size = document.createElement('span');
        const typeLabel = document.createElement('span');

        name.className = 'file-name';
        size.className = 'file-size';
        typeLabel.className = 'file-size';
        name.textContent = file.name || 'Unnamed file';
        size.textContent = formatFileSize(file.size || 0);
        typeLabel.textContent = isPdfFile(file) ? 'PDF' : (isImageFile(file) ? 'Image' : 'File');
        typeLabel.title = typeLabel.textContent;

        item.title = file.name || 'Unnamed file';

        item.appendChild(name);
        item.appendChild(typeLabel);
        item.appendChild(size);
        previewList.appendChild(item);
    });
}

function loadImageElementFromFile(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = function() {
            const image = new Image();
            image.onload = () => resolve(image);
            image.onerror = () => reject(new Error(`Failed to read image: ${file.name}`));
            image.src = reader.result;
        };
        reader.onerror = () => reject(new Error(`Failed to load file: ${file.name}`));
        reader.readAsDataURL(file);
    });
}

let jsPdfLoaderPromise = null;

function loadJsPdfLibrary() {
    if (window.jspdf && window.jspdf.jsPDF) {
        return Promise.resolve(window.jspdf);
    }

    if (jsPdfLoaderPromise) {
        return jsPdfLoaderPromise;
    }

    jsPdfLoaderPromise = new Promise((resolve, reject) => {
        const existingScript = document.querySelector('script[data-jspdf-loader="true"]');
        if (existingScript) {
            existingScript.addEventListener('load', () => resolve(window.jspdf));
            existingScript.addEventListener('error', () => reject(new Error('Failed to load PDF converter.')));
            return;
        }

        const script = document.createElement('script');
        script.src = 'https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js';
        script.async = true;
        script.dataset.jspdfLoader = 'true';
        script.onload = () => resolve(window.jspdf);
        script.onerror = () => reject(new Error('Failed to load PDF converter.'));
        document.head.appendChild(script);
    }).catch(error => {
        jsPdfLoaderPromise = null;
        throw error;
    });

    return jsPdfLoaderPromise;
}

async function convertImagesToPdfUnderLimit(imageFiles, maxBytes, setStatus) {
    const jspdfNamespace = await loadJsPdfLibrary();

    const images = await Promise.all(imageFiles.map(file => loadImageElementFromFile(file)));
    const { jsPDF } = jspdfNamespace;
    const attempts = [
        { maxDimension: 2000, quality: 0.9 },
        { maxDimension: 1700, quality: 0.82 },
        { maxDimension: 1500, quality: 0.76 },
        { maxDimension: 1300, quality: 0.7 },
        { maxDimension: 1100, quality: 0.64 },
        { maxDimension: 900, quality: 0.58 }
    ];

    for (let attemptIndex = 0; attemptIndex < attempts.length; attemptIndex += 1) {
        const attempt = attempts[attemptIndex];
        setStatus(`Converting images to PDF (attempt ${attemptIndex + 1}/${attempts.length})...`);

        const pdf = new jsPDF({ orientation: 'p', unit: 'pt', format: 'a4', compress: true });
        const pageWidth = pdf.internal.pageSize.getWidth();
        const pageHeight = pdf.internal.pageSize.getHeight();
        const margin = 20;
        const contentWidth = pageWidth - margin * 2;
        const contentHeight = pageHeight - margin * 2;

        for (let imageIndex = 0; imageIndex < images.length; imageIndex += 1) {
            const image = images[imageIndex];

            const sourceWidth = image.naturalWidth || image.width;
            const sourceHeight = image.naturalHeight || image.height;
            const sourceScale = Math.min(1, attempt.maxDimension / Math.max(sourceWidth, sourceHeight));
            const canvasWidth = Math.max(1, Math.round(sourceWidth * sourceScale));
            const canvasHeight = Math.max(1, Math.round(sourceHeight * sourceScale));

            const canvas = document.createElement('canvas');
            canvas.width = canvasWidth;
            canvas.height = canvasHeight;
            const ctx = canvas.getContext('2d', { alpha: false });
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, canvasWidth, canvasHeight);
            ctx.drawImage(image, 0, 0, canvasWidth, canvasHeight);

            const imageDataUrl = canvas.toDataURL('image/jpeg', attempt.quality);
            const fitScale = Math.min(contentWidth / canvasWidth, contentHeight / canvasHeight);
            const renderWidth = canvasWidth * fitScale;
            const renderHeight = canvasHeight * fitScale;
            const x = (pageWidth - renderWidth) / 2;
            const y = (pageHeight - renderHeight) / 2;

            if (imageIndex > 0) {
                pdf.addPage();
            }
            pdf.addImage(imageDataUrl, 'JPEG', x, y, renderWidth, renderHeight, undefined, 'FAST');
        }

        const pdfBlob = pdf.output('blob');
        if (pdfBlob.size <= maxBytes) {
            return new File([pdfBlob], `images-${Date.now()}.pdf`, { type: 'application/pdf' });
        }
    }

    throw new Error('Could not generate a PDF under 10MB. Please upload fewer or clearer-compressed images.');
}

function setupUserUploadHandler() {
    const uploadForm = document.getElementById('userUploadForm');
    const uploadFileInput = document.getElementById('uploadFile');
    if (!uploadForm) return;

    if (uploadFileInput) {
        uploadFileInput.addEventListener('change', function() {
            renderSelectedUploadFilesPreview(uploadFileInput.files);
        });
    }

    uploadForm.addEventListener('submit', async function(e) {
        e.preventDefault();
        if (currentUser && requiresEmailVerification(currentUser)) { showEmailVerificationPrompt(); return; }
        if (!currentUser) { openLoginModal(); return; }

        const uploadName = document.getElementById('uploadName').value.trim();
        const title = document.getElementById('uploadTitle').value;
        const course = document.getElementById('uploadCourse').value;
        const semester = document.getElementById('uploadSemester').value;
        const selectedFiles = Array.from(document.getElementById('uploadFile').files || []);

        if (!uploadName) {
            alert('Please enter your name');
            return;
        }

        if (!selectedFiles.length) {
            alert('Please select a PDF or images');
            return;
        }

        const imageFiles = selectedFiles.filter(isImageFile);
        const pdfFiles = selectedFiles.filter(isPdfFile);
        const unsupportedFiles = selectedFiles.filter(file => !isImageFile(file) && !isPdfFile(file));
        const maxFinalPdfSize = 10 * 1024 * 1024;

        if (unsupportedFiles.length) {
            alert('Only PDF or image files are allowed.');
            return;
        }

        if (pdfFiles.length > 1) {
            alert('Please select only one PDF file.');
            return;
        }

        if (pdfFiles.length === 1 && imageFiles.length > 0) {
            alert('Please upload either one PDF or multiple images, not both together.');
            return;
        }

        const statusDiv = document.getElementById('uploadStatus');
        const statusMessage = document.getElementById('uploadStatusMessage');
        const progressDiv = document.getElementById('uploadProgress');
        const progressBar = document.getElementById('uploadProgressBar');

        statusDiv.style.display = 'block';
        statusMessage.textContent = 'Fetching your profile...';
        progressDiv.style.display = 'block';
        progressBar.style.width = '10%';

        try {
            const userName = uploadName || (currentUser && (currentUser.displayName || currentUser.email)) || 'Anonymous';
            const userCourse = course || 'General';
            const userEmail = currentUser ? currentUser.email || '' : '';

            let file;
            if (pdfFiles.length === 1) {
                file = pdfFiles[0];
                if (file.size > maxFinalPdfSize) {
                    throw new Error('PDF size exceeds 10MB. Please upload a smaller PDF.');
                }
            } else {
                if (!imageFiles.length) {
                    throw new Error('Please select one PDF or one or more images.');
                }

                statusMessage.textContent = 'Preparing images for PDF conversion...';
                progressBar.style.width = '30%';
                file = await convertImagesToPdfUnderLimit(imageFiles, maxFinalPdfSize, message => {
                    statusMessage.textContent = message;
                });
            }

            statusMessage.textContent = 'Uploading file to database...';
            progressBar.style.width = '60%';
            // Upload to gofile.io (CORS enabled, unlimited file storage)
            // First, get an available server
            const serverResponse = await fetch('https://api.gofile.io/servers');
            if (!serverResponse.ok) {
                throw new Error('Failed to get upload server');
            }

            const serverData = await serverResponse.json();
            if (serverData.status !== 'ok' || !serverData.data || !serverData.data.servers || serverData.data.servers.length === 0) {
                throw new Error('No upload servers available');
            }

            // Use the first available server
            const server = serverData.data.servers[0];
            const uploadUrl = `https://${server.name}.gofile.io/uploadFile`;

            // Now upload the file
            const formData = new FormData();
            formData.append('file', file);

            const response = await fetch(uploadUrl, {
                method: 'POST',
                body: formData
            });

            if (!response.ok) {
                throw new Error(`Upload failed with status ${response.status}`);
            }

            const result = await response.json();
            
            if (result.status !== 'ok' || !result.data || !result.data.downloadPage) {
                throw new Error('Upload failed: Invalid response from server');
            }

            // gofile.io returns downloadPage URL directly
            const fileUrl = result.data.downloadPage;

            progressBar.style.width = '90%';
            statusMessage.textContent = 'File uploaded successfully! Saving metadata...';

            // Save metadata to Firestore pendingUploads collection
            await db.collection('pendingUploads').add({
                title: title,
                course: course,
                semester: semester,
                studentName: userName,
                studentCourse: userCourse,
                studentEmail: userEmail,
                userId: currentUser ? currentUser.uid : '',
                fileName: file.name,
                downloadUrl: fileUrl,
                fileSize: file.size,
                uploadedAt: firebase.firestore.FieldValue.serverTimestamp(),
                status: 'pending'
            });

            progressBar.style.width = '100%';
            statusMessage.innerHTML = '<strong class="text-success">✓ File uploaded successfully! Our team will review it soon.</strong>';
            progressDiv.style.display = 'none';
            uploadForm.reset();
            renderSelectedUploadFilesPreview([]);

            // Hide success message after 5 seconds
            setTimeout(() => {
                statusDiv.style.display = 'none';
            }, 5000);
        } catch (error) {
            console.error('Upload error:', error);
            statusMessage.innerHTML = `<strong class="text-danger">Error: ${error.message}</strong>`;
            progressDiv.style.display = 'none';
        }
    });
}

// Update UI for PYQ filters — PYQ-only P0: search & filters are free for everyone
function updatePyqFilterUI() {
    const panel = document.getElementById('pyqFilterPanel');
    if (!panel) return;
    panel.style.display = 'block';
    const hint = document.getElementById('filterHint');
    if (hint) {
        // Keep a friendly hint but never gate — just show count info
        hint.style.display = 'inline';
    }
    const badge = document.getElementById('pyqCountBadge');
    if (badge) {
        const total = (typeof filteredPyqs !== 'undefined' && filteredPyqs.length) ? filteredPyqs.length : (typeof allData !== 'undefined' && allData.pyqs ? allData.pyqs.length : 0);
        badge.textContent = total ? `${total} papers` : `${coursesList.length ? coursesList.length+' courses' : 'All PYQs free'}`;
    }
    updatePyqResultsBar();
}

function getSortValue() {
    const sel = document.getElementById('sortBy');
    return sel ? sel.value : 'newest';
}

function applyPyqSorting(list) {
    const sort = getSortValue();
    const arr = [...list];
    if (sort === 'popular') {
        return arr.sort((a,b) => (Number(b.views)||0) - (Number(a.views)||0) || getRecentSortValue(b) - getRecentSortValue(a));
    }
    if (sort === 'az') {
        return arr.sort((a,b) => String(a.title||'').localeCompare(String(b.title||'')));
    }
    if (sort === 'za') {
        return arr.sort((a,b) => String(b.title||'').localeCompare(String(a.title||'')));
    }
    if (sort === 'oldest') {
        return arr.sort((a,b) => getRecentSortValue(a) - getRecentSortValue(b));
    }
    // newest (default)
    return arr.sort((a,b) => getRecentSortValue(b) - getRecentSortValue(a));
}

function updatePyqResultsBar() {
    const bar = document.getElementById('pyqResultsBar');
    const countEl = document.getElementById('pyqResultsCount');
    const chipsEl = document.getElementById('activeFilterChips');
    if (!bar || !countEl || !chipsEl) return;
    const hasFilters = typeof hasActivePyqFilters === 'function' ? hasActivePyqFilters() : false;
    const searchTerm = (document.getElementById('searchInput') && document.getElementById('searchInput').value.trim()) || '';
    const total = (typeof filteredPyqs !== 'undefined') ? filteredPyqs.length : 0;
    if (!hasFilters && !searchTerm) {
        bar.style.display = 'none';
        return;
    }
    bar.style.display = 'block';
    countEl.textContent = total;
    // build chips
    const chips = [];
    if (searchTerm) chips.push(`<span class="filter-chip"><i class="fas fa-search"></i> “${escapeHtml(searchTerm)}”</span>`);
    try {
        const f = getPyqFilterState();
        if (f.course) {
            const label = document.getElementById('filterCourse')?.selectedOptions[0]?.textContent?.trim() || f.course;
            chips.push(`<span class="filter-chip"><i class="fas fa-graduation-cap"></i> ${escapeHtml(label)}</span>`);
        }
        if (f.year) chips.push(`<span class="filter-chip"><i class="fas fa-layer-group"></i> ${escapeHtml(f.year)}</span>`);
        if (f.session) chips.push(`<span class="filter-chip"><i class="fas fa-calendar"></i> ${escapeHtml(f.session)}</span>`);
        const sortLabel = document.getElementById('sortBy')?.selectedOptions[0]?.textContent?.trim();
        if (sortLabel) chips.push(`<span class="filter-chip sort-chip"><i class="fas fa-sort"></i> ${escapeHtml(sortLabel)}</span>`);
    } catch(e){}
    chipsEl.innerHTML = chips.join('') || '<span class="text-muted small">No filters</span>';
}

document.addEventListener('DOMContentLoaded', function() {
    // Initialize modals
    const pdfModal = new bootstrap.Modal(document.getElementById('pdfModal'));
    const shareModal = new bootstrap.Modal(document.getElementById('shareModal'));
    const pdfViewer = document.getElementById('pdfViewer');
    const downloadBtn = document.getElementById('downloadBtn');
    const shareLink = document.getElementById('shareLink');
    const copyLinkBtn = document.getElementById('copyLinkBtn');
    const pyqList = document.getElementById('pyqList');

    document.getElementById('pdfModal').addEventListener('hidden.bs.modal', function() {
        pdfViewer.src = '';
    });

    // Global data storage
    let allData = { pyqs: [] };
    let filteredPyqs = [];

    const serverPageSize = 20;
    let pyqLastVisible = null;
    let pyqHasMore = true;

    // Pagination variables for PYQs
    let currentPage = 1;
    const itemsPerPage = 20;

    // Tracks the active server-side search (for Load More of search results)
    let searchState = null;

    // Function to extract year from title
    function extractYearFromTitle(title) {
        const yearMatch = title.match(/\{(\d{4})/);
        return yearMatch ? parseInt(yearMatch[1]) : 0;
    }

    // Items returned by the API are already sorted server-side.
    // Keep the name for compatibility but only normalize fields here.
    function processAndSortItems(items) {
        return items.map(item => normalizePyqMetadata({
            ...item,
            year: extractYearFromTitle(item.title || '')
        }));
    }

    function normalizePyqMetadata(pyq) {
        const parsedViews = Number(pyq && pyq.views);

        return {
            ...pyq,
            views: Number.isFinite(parsedViews) && parsedViews >= 0 ? Math.floor(parsedViews) : 0
        };
    }

    function getPyqSemesterValue(pyq) {
        const semesterValue = (pyq && (pyq.semester || pyq.sem || pyq.sessionSemester)) ? String(pyq.semester || pyq.sem || pyq.sessionSemester).trim().toLowerCase() : '';
        if (semesterValue) return semesterValue;

        const title = (pyq && pyq.title) ? String(pyq.title).toLowerCase() : '';
        const semesterMatch = title.match(/\b(1st|2nd|3rd|4th|5th|6th|7th|8th)\b/);
        return semesterMatch ? semesterMatch[1] : '';
    }

    function getPyqFilterState() {
        const course = document.getElementById('filterCourse');
        const year = document.getElementById('filterYear');
        const session = document.getElementById('filterSession');

        return {
            course: course ? normalizeForCompare(course.value) : '',
            year: year ? year.value.trim().toLowerCase() : '',
            session: session ? session.value.trim().toLowerCase() : ''
        };
    }

    // Normalize strings for reliable comparisons (remove dots/spaces/punctuation)
    function normalizeForCompare(str) {
        if (!str) return '';
        try {
            return String(str).toLowerCase().trim().replace(/[\.\s\-_&\(\),]+/g, '').replace(/[^a-z0-9]/g, '');
        } catch (e) {
            return '';
        }
    }

    // Populate Course filter options dynamically from loaded PYQs (keeps user options in-sync with data)
    function populateCourseFilter() {
        const select = document.getElementById('filterCourse');
        if (!select || !allData.pyqs || !allData.pyqs.length) return;

        const knownMap = {
            'bcom': 'B.Com.',
            'ba': 'B.A.',
            'bsc': 'B.Sc.',
            'btech': 'B.Tech',
            'ma': 'M.A.',
            'mcom': 'M.Com.',
            'msc': 'M.Sc.',
            'mtech': 'M.Tech'
        };

        const found = new Map();
        allData.pyqs.forEach(pyq => {
            const raw = (pyq.course || pyq.category || '').toString().trim();
            const fromTitle = (pyq.title || '').toString();
            let key = normalizeForCompare(raw);
            if (!key) {
                // attempt to infer from title using knownMap keys
                const titleLower = fromTitle.toLowerCase();
                Object.keys(knownMap).some(token => {
                    if (titleLower.includes(token) || titleLower.includes(token.replace(/([a-z])/g, '$1.'))) {
                        key = token;
                        return true;
                    }
                    return false;
                });
            }
            if (key) {
                const display = raw || knownMap[key] || key.toUpperCase();
                if (!found.has(key)) found.set(key, display);
            }
        });

        // Append dynamic options (preserve existing built-in options)
        // Remove previously appended dynamic options first
        Array.from(select.querySelectorAll('option[data-generated="true"]')).forEach(o => o.remove());

        const sorted = Array.from(found.entries()).sort((a,b)=> a[1].localeCompare(b[1]));
        sorted.forEach(([key, display]) => {
            // Skip if matches the empty placeholder or existing values
            const exists = Array.from(select.options).some(opt => normalizeForCompare(opt.value) === key);
            if (exists) return;
            const opt = document.createElement('option');
            opt.value = display; // keep human-readable value but we'll normalize when reading
            opt.textContent = display;
            opt.setAttribute('data-generated', 'true');
            select.appendChild(opt);
        });
    }

    function hasActivePyqFilters() {
        const filters = getPyqFilterState();
        return !!(filters.course || filters.year || filters.session);
    }

    function clearPyqFilters(resetResults = true) {
        const course = document.getElementById('filterCourse');
        const year = document.getElementById('filterYear');
        const session = document.getElementById('filterSession');
        const searchInput = document.getElementById('searchInput');
        const sortSel = document.getElementById('sortBy');

        if (course) course.value = '';
        if (year) year.value = '';
        if (session) session.value = '';
        if (searchInput) searchInput.value = '';
        if (sortSel) sortSel.value = 'newest';

        if (resetResults && allData.pyqs.length) {
            filteredPyqs = applyPyqSorting([...allData.pyqs]);
            currentPage = 1;
            updatePyqResultsBar();
            renderPYQs();
        }
    }

    window.clearPyqFilters = function() {
        clearPyqFilters(true);
    };

    async function loadCollectionPage(collectionName, append = false) {
        const isPyq = collectionName === 'pyqs';
        if (!isPyq) return;

        // Server-side pagination via the Worker API — the Worker serves the
        // page from its KV-cached search index (zero Firestore reads).
        const pageToLoad = append
            ? Math.floor(allData.pyqs.length / serverPageSize) + 1
            : 1;
        const sort = getSortValue();

        try {
            const result = await fetchPyqsPageCached(pageToLoad, serverPageSize, sort);
            const pageItems = processAndSortItems(result.items || []);

            allData.pyqs = append ? [...allData.pyqs, ...pageItems] : pageItems;
            filteredPyqs = [...allData.pyqs];
            pyqHasMore = pageToLoad < (result.totalPages || 1);
        } catch (error) {
            console.error('Error loading pyqs page from API:', error);
            if (!append) {
                showEmptyState('pyqList', 'Error loading question papers. Please try again.');
            }
        }
    }

    async function bootstrapContent() {
        if (!document.getElementById('pyqList')) {
            return;
        }

        try {
            await loadCollectionPage('pyqs');
            // Apply current sort (P0)
            try { filteredPyqs = applyPyqSorting([...filteredPyqs]); } catch(e){}
            loadHomepageSections();

            // Populate filter options based on loaded PYQs
            populateCourseFilter();

            renderPYQs(filteredPyqs);
            setupEventListeners();
            updatePyqFilterUI();
        } catch (error) {
            console.error('Error loading data from Firestore:', error);
            showEmptyState('pyqList', 'Error loading question papers');
        }
    }

    bootstrapContent();

    setupUserUploadHandler();

    // Load and render contributors from the Worker API (KV-cached, long TTL)
    async function loadContributors() {
        try {
            const contributors = await fetchContributors();
            if (Array.isArray(contributors)) {
                renderContributors(contributors);
            }
        } catch (error) {
            console.error('Error loading contributors from API:', error);
        }
    }

    function renderContributors(contributors) {
                const contributorsGrid = document.getElementById('contributorsGrid');
                if (!contributorsGrid) return;

                contributorsGrid.innerHTML = '';
                
                (contributors || []).forEach(contributor => {
                    const card = document.createElement('div');
                    card.className = 'contributor-card';
                    card.innerHTML = `
                        <div class="contributor-avatar">${escapeHtml(contributor.avatar || '')}</div>
                        <h5>${escapeHtml(contributor.name || '')}</h5>
                        <p class="contributor-role">${escapeHtml(contributor.role || '')}</p>
                    `;
                    contributorsGrid.appendChild(card);
                });

                // Add the "Join our team" card at the end
                const joinCard = document.createElement('div');
                joinCard.className = 'contributor-more';
                joinCard.innerHTML = `
                    <div class="more-avatar">+</div>
                    <h5>Join our team!</h5>
                    <p class="contributor-role">Become a contributor</p>
                `;
                contributorsGrid.appendChild(joinCard);
    }

    async function loadAggregatedStats() {
        // Stats now come from the Worker API (KV-cached). Firestore is never
        // read directly for stats anymore.
        try {
            await fetchStats();
        } catch (error) {
            console.warn('Aggregated stats unavailable:', error.message);
        }
    }

    function escapeHtml(value) {
        return String(value || '').replace(/[&<>"']/g, function(char) {
            const entities = {
                '&': '&amp;',
                '<': '&lt;',
                '>': '&gt;',
                '"': '&quot;',
                "'": '&#39;'
            };

            return entities[char] || char;
        });
    }

    function getPyqTimestampValue(pyq) {
        const candidate = pyq && (pyq.createdAt || pyq.uploadedAt || pyq.addedAt);
        if (!candidate) {
            return 0;
        }

        if (typeof candidate.toDate === 'function') {
            return candidate.toDate().getTime();
        }

        const parsed = Date.parse(candidate);
        return Number.isFinite(parsed) ? parsed : 0;
    }

    function getRecentSortValue(pyq) {
        const timestamp = getPyqTimestampValue(pyq);
        if (timestamp) {
            return timestamp;
        }

        const sessionMatch = String(pyq && pyq.session ? pyq.session : '').match(/(\d{4})/);
        if (sessionMatch) {
            return parseInt(sessionMatch[1], 10);
        }

        return extractYearFromTitle((pyq && pyq.title) || '');
    }

    async function fetchCourseCatalog() {
        try {
            const response = await fetch('courses.json', { cache: 'no-store' });
            if (!response.ok) {
                throw new Error('Unable to load course catalog');
            }

            const data = await response.json();
            return Array.isArray(data.courses) ? data.courses : [];
        } catch (error) {
            console.warn('Course catalog unavailable:', error.message);
            return ['B.A.', 'B.Com', 'B.Tech', 'B.Ed.', 'B.V.A.', 'BPO', 'D.Pharm', 'MBA', 'MCA', 'M.Tech'];
        }
    }

    function renderCompactPyqList(containerId, items, emptyMessage) {
        const container = document.getElementById(containerId);
        if (!container) {
            return;
        }

        const list = Array.isArray(items) ? items : [];
        if (!list.length) {
            container.innerHTML = `
                <div class="empty-state empty-state-compact">
                    <i class="fas fa-folder-open"></i>
                    <p>${escapeHtml(emptyMessage)}</p>
                </div>
            `;
            return;
        }

        container.innerHTML = list.map(item => {
            const primaryFile = getPyqPrimaryLink(item);
            const secondaryFile = getPyqSecondaryLink(item);
            const targetFile = primaryFile || secondaryFile;
            const safeTitle = escapeJsString(item.title || 'Document');
            const safeId = escapeJsString(item.id || '');
            const views = Number.isFinite(Number(item.views)) ? Number(item.views) : 0;
            const metaParts = [item.course, item.semester ? `${item.semester} sem` : '', item.session].filter(Boolean);

            return `
                <article class="mini-pyq-card">
                    <div class="mini-pyq-copy">
                        <h4>${escapeHtml(item.title || 'Document')}</h4>
                        <p>${escapeHtml(metaParts.join(' • ') || 'No course metadata')}</p>
                    </div>
                    <div class="mini-pyq-actions">
                        <span class="mini-pyq-views"><i class="fas fa-eye"></i> ${views}</span>
                        <a href="paper.html?id=${encodeURIComponent(item.id)}" class="btn btn-sm btn-outline-info"><i class="fas fa-eye me-1"></i> View Details</a>
                    </div>
                </article>
            `;
        }).join('');
    }

    async function loadHomepageSections() {
        const courseCardsContainer = document.getElementById('courseCards');
        const recentContainer = document.getElementById('recentlyAddedList');
        const trendingContainer = document.getElementById('trendingList');

        if (!courseCardsContainer && !recentContainer && !trendingContainer) {
            return;
        }

        if (courseCardsContainer) {
            courseCardsContainer.innerHTML = `
                <div class="skeleton-grid">
                    <div class="skeleton-card"></div>
                    <div class="skeleton-card"></div>
                    <div class="skeleton-card"></div>
                    <div class="skeleton-card"></div>
                </div>
            `;
        }

        if (recentContainer) {
            showLoading('recentlyAddedList');
        }

        if (trendingContainer) {
            showLoading('trendingList');
        }

        try {
            // Homepage data comes from the Worker API — a single KV-cached
            // payload with recent, trending, course counts and stats.
            // Zero Firestore reads for the frontend.
            const [courseNames, homepage] = await Promise.all([
                fetchCourseCatalog().catch(() => []),
                fetchHomepage().catch(() => null)
            ]);

            const recentItems = (homepage && homepage.recent) || [];
            const trendingItems = (homepage && homepage.trending) || [];
            const courseCounts = (homepage && homepage.courseCounts) || [];

            if (courseCardsContainer) {
                renderCourseCardsFromCounts(courseNames, courseCounts);
            }
            if (recentContainer) {
                renderCompactPyqList('recentlyAddedList', recentItems, 'No recently added question papers yet.');
            }
            if (trendingContainer) {
                renderCompactPyqList('trendingList', trendingItems, 'No trending papers yet.');
            }
        } catch (error) {
            console.error('Unable to load homepage sections:', error);
            if (courseCardsContainer) {
                courseCardsContainer.innerHTML = '<div class="empty-state empty-state-compact"><i class="fas fa-graduation-cap"></i><p>Course cards are unavailable right now.</p></div>';
            }
            if (recentContainer) {
                showEmptyState('recentlyAddedList', 'Recently added papers are unavailable right now.');
            }
            if (trendingContainer) {
                showEmptyState('trendingList', 'Trending papers are unavailable right now.');
            }
        }
    }

    // Render course cards from the Worker's courseCounts payload
    function renderCourseCardsFromCounts(courseNames, courseCounts) {
        const container = document.getElementById('courseCards');
        if (!container) return;

        const countsMap = new Map(
            (courseCounts || []).map(c => [normalizeForCompare(c.course || ''), Number(c.count) || 0])
        );

        const uniqueCourses = Array.from(new Set((courseNames || []).filter(Boolean).map(course => String(course).trim())))
            .map(label => {
                const key = normalizeForCompare(label);
                return {
                    label,
                    count: countsMap.get(key) || 0
                };
            })
            .filter(course => course.label)
            .sort((a, b) => a.label.localeCompare(b.label));

        container.innerHTML = uniqueCourses.map(course => `
            <button type="button" class="course-card" data-course="${escapeJsString(course.label)}">
                <span class="course-card-label">${escapeHtml(course.label)}</span>
                <strong>${course.count}</strong>
                <small>question paper${course.count === 1 ? '' : 's'}</small>
            </button>
        `).join('');

        container.querySelectorAll('.course-card').forEach(button => {
            button.addEventListener('click', function() {
                window.jumpToCourse(this.getAttribute('data-course') || '');
            });
        });
    }

    window.jumpToCourse = function(courseLabel) {
        const courseSelect = document.getElementById('filterCourse');
        if (courseSelect) {
            courseSelect.value = courseLabel || '';
        }

        const pyqTab = document.getElementById('nav-pyq-tab');
        if (pyqTab) {
            pyqTab.click();
        }

        // PYQ-only: no login gate
        performSearch();
        // smooth scroll to papers
        const section = document.getElementById('pyqs-section');
        if (section) section.scrollIntoView({ behavior: 'smooth', block: 'start' });
    };

    // Load contributors only on pages that render the contributors grid.
    if (document.getElementById('contributorsGrid')) {
        loadContributors();
        loadAggregatedStats();
    }

    function renderPYQs(pyqs) {
        const startIndex = (currentPage - 1) * itemsPerPage;
        const endIndex = startIndex + itemsPerPage;
        const pyqsToRender = filteredPyqs.slice(startIndex, endIndex);

        if (!pyqsToRender.length) {
            if (currentPage === 1) {
                showEmptyState('pyqList', 'No question papers found matching your criteria');
            }
            document.getElementById('loadMoreBtn').style.display = 'none';
            updatePyqFilterUI();
            return;
        }

        if (currentPage === 1) {
            pyqList.innerHTML = '';
        }

        pyqList.insertAdjacentHTML('beforeend', pyqsToRender.map((pyq, index) => {
            const primaryFile = getPyqPrimaryLink(pyq);
            const secondaryFile = getPyqSecondaryLink(pyq);
            const shareTarget = primaryFile || secondaryFile;
            const safeTitle = escapeJsString(pyq.title || 'Document');
            const safeId = escapeJsString(pyq.id || '');
            const viewCount = Number.isFinite(Number(pyq.views)) ? Number(pyq.views) : 0;
            // Build pills from course/sem/session/branch
            const pills = [];
            if (pyq.course) pills.push(`<span class="meta-tag course"><i class="fas fa-graduation-cap"></i> ${escapeHtml(pyq.course)}</span>`);
            if (pyq.semester) pills.push(`<span class="meta-tag semester"><i class="fas fa-layer-group"></i> ${escapeHtml(pyq.semester)}</span>`);
            if (pyq.session) pills.push(`<span class="meta-tag"><i class="fas fa-calendar"></i> ${escapeHtml(pyq.session)}</span>`);
            if (pyq.branch) pills.push(`<span class="meta-tag"><i class="fas fa-code-branch"></i> ${escapeHtml(pyq.branch)}</span>`);
            if (!pills.length && pyq.title) {
                // fallback: try to extract from title
                const sem = getPyqSemesterValue(pyq);
                if (sem) pills.push(`<span class="meta-tag semester">${escapeHtml(sem)}</span>`);
            }

            return `
            <li class="pyq-item" style="animation-delay: ${0.1 + (startIndex + index) * 0.05}s">
                <div class="pyq-info">
                    <div class="pdf-icon">
                        <i class="fas fa-file-pdf"></i>
                    </div>
                    <div class="pyq-details">
                        <h5 class="pyq-title"><a href="paper.html?id=${encodeURIComponent(pyq.id)}" style="color:inherit; text-decoration:none;">${escapeHtml(pyq.title)}</a></h5>
                        <div class="syllabus-meta" style="margin-bottom:8px;">${pills.join('')}</div>
                        <div class="pyq-meta" style="margin-bottom:10px; display:flex; gap:12px; flex-wrap:wrap; align-items:center; font-size:13px; color: var(--color-text-secondary);">
                            <span><i class="fas fa-eye"></i> ${viewCount} views</span>
                            ${pyq.branch ? `<span><i class="fas fa-code-branch"></i> ${escapeHtml(pyq.branch)}</span>` : ''}
                        </div>
                        <div class="pyq-actions">
                            <a href="paper.html?id=${encodeURIComponent(pyq.id)}" class="btn btn-action btn-preview"><i class="fas fa-eye"></i> View Details</a>
                        </div>
                    </div>
                </div>
            </li>
        `;
        }).join(''));

        // Show or hide Load More button
        const loadMoreBtn = document.getElementById('loadMoreBtn');
        const searchTerm = document.getElementById('searchInput').value.trim();
        const filtersActive = hasActivePyqFilters();
        const moreSearchPages = searchState && searchState.page < searchState.totalPages;
        if (endIndex < filteredPyqs.length || moreSearchPages || (!searchTerm && !filtersActive && pyqHasMore)) {
            loadMoreBtn.style.display = 'inline-block';
        } else {
            loadMoreBtn.style.display = 'none';
        }
        updatePyqFilterUI();
    }

    function normalizePyqLink(value) {
        if (value === undefined || value === null) {
            return '';
        }

        const text = String(value).trim();
        if (!text || text.toLowerCase() === 'null') {
            return '';
        }

        return text;
    }

    function getPyqPrimaryLink(pyq) {
        return normalizePyqLink(pyq && (pyq.file || pyq.server1));
    }

    function getPyqSecondaryLink(pyq) {
        return normalizePyqLink(pyq && (pyq.file2 || pyq.server2));
    }

    function escapeJsString(value) {
        return (value || '')
            .toString()
            .replace(/\\/g, '\\\\')
            .replace(/'/g, "\\'")
            .replace(/\r?\n/g, ' ');
    }

    function showEmptyState(containerId, message) {
        const isPyqList = containerId === 'pyqList';
        document.getElementById(containerId).innerHTML = `
            <div class="empty-state">
                <i class="fas fa-search"></i>
                <p>${message}</p>
                ${isPyqList ? `
                <div class="d-flex flex-wrap gap-2 justify-content-center mt-3">
                    <button class="btn btn-primary btn-sm" onclick="openRequestPyqModal()"><i class="fas fa-plus me-1"></i> Request this PYQ</button>
                    <button class="btn btn-outline-light btn-sm" onclick="clearPyqFilters()"><i class="fas fa-undo me-1"></i> Clear filters</button>
                    <button class="btn btn-outline-light btn-sm" onclick="document.getElementById('searchInput').value=''; performSearch();"><i class="fas fa-broom me-1"></i> Clear search</button>
                </div>
                <p class="small text-muted mt-2" style="opacity:0.7;">Can't find it? Request it and contributors will try to upload.</p>
                ` : ''}
            </div>
        `;
    }

    function setupEventListeners() {
        // Search functionality with debounce to limit server reads
        const searchInput = document.getElementById('searchInput');
        // debounce helper: ensures the wrapped function runs after `wait` ms of inactivity
        function debounce(fn, wait) {
            let timer = null;
            return function(...args) {
                if (timer) clearTimeout(timer);
                timer = setTimeout(() => {
                    timer = null;
                    try { fn.apply(this, args); } catch (e) { console.error(e); }
                }, wait);
            };
        }

        const debouncedSearch = debounce(() => {
            if (typeof window.performSearch === 'function') window.performSearch();
        }, 1000);

        if (searchInput) searchInput.addEventListener('input', debouncedSearch);

        const filterCourse = document.getElementById('filterCourse');
        const filterYear = document.getElementById('filterYear');
        const filterSession = document.getElementById('filterSession');
        const sortBy = document.getElementById('sortBy');
        // PYQ-only P0: filters & sort are free for everyone — no gating
        const triggerFilterSearch = () => {
            performSearch();
        };

        if (filterCourse) filterCourse.addEventListener('change', triggerFilterSearch);
        if (filterYear) filterYear.addEventListener('change', triggerFilterSearch);
        if (filterSession) filterSession.addEventListener('change', triggerFilterSearch);
        if (sortBy) sortBy.addEventListener('change', function(){
            // re-apply sorting instantly without server fetch if no search/filters
            const searchTerm = document.getElementById('searchInput').value.trim();
            const filtersActive = hasActivePyqFilters();
            if (!searchTerm && !filtersActive && filteredPyqs.length) {
                filteredPyqs = applyPyqSorting(filteredPyqs);
                currentPage = 1;
                renderPYQs();
            } else {
                performSearch();
            }
        });



        // Load More button for PYQs — gated: beyond first page requires login + verified
        document.getElementById('loadMoreBtn').addEventListener('click', async function() {
            if (!currentUser) {
                openSearchGateModal();
                return;
            }
            if (requiresEmailVerification(currentUser)) {
                showEmailVerificationPrompt();
                return;
            }
            const searchTerm = document.getElementById('searchInput').value.trim();
            const filtersActive = hasActivePyqFilters();

            // Load more search results from the Worker API
            if ((searchTerm || filtersActive) && searchState) {
                if (searchState.page < searchState.totalPages) {
                    try {
                        const nextPage = searchState.page + 1;
                        const result = await searchPyqs(buildSearchParams(
                            searchState.query, searchState.filters, searchState.sort, nextPage, itemsPerPage
                        ));
                        const more = processAndSortItems(result.items || []);
                        filteredPyqs = [...filteredPyqs, ...more];
                        searchState.page = result.page || nextPage;
                        searchState.totalPages = result.totalPages || searchState.totalPages;
                        searchState.total = result.total || searchState.total;
                    } catch (err) {
                        console.error('Load more search results failed:', err);
                    }
                }
                currentPage++;
                renderPYQs();
                return;
            }

            if (pyqHasMore) {
                await loadCollectionPage('pyqs', true);
            }
            currentPage++;
            renderPYQs();
        });

        // Copy link button
        if (copyLinkBtn) copyLinkBtn.addEventListener('click', function() {
            shareLink.select();
            document.execCommand('copy');

            const originalText = copyLinkBtn.innerHTML;
            copyLinkBtn.innerHTML = '<i class="fas fa-check"></i> Copied!';
            setTimeout(() => {
                copyLinkBtn.innerHTML = originalText;
            }, 2000);
        });

        // Tab switching — guarded (tabs may not exist on every page)
        const _tabs = document.querySelectorAll('[data-bs-toggle="tab"]');
        if (_tabs && _tabs.length) {
            _tabs.forEach(tab => {
                tab.addEventListener('shown.bs.tab', function(event) {
                    const targetTab = event.target.getAttribute('data-bs-target');
                    const _searchInput = document.getElementById('searchInput');
                    if (_searchInput) _searchInput.value = '';
                    if (typeof performSearch === 'function') try { performSearch(); } catch(e){}
                });
            });
        }
    }

    // Build API search params from the current UI state.
    // NOTE: the frontend "Year" dropdown is actually the Semester selector,
    // so we map it to the API `semester` parameter.
    function buildSearchParams(searchTerm, filters, sort, page, limit) {
        const params = { page: String(page), limit: String(limit), sort: sort || 'newest' };
        if (searchTerm) params.q = searchTerm;
        if (filters.course) params.course = filters.course;
        if (filters.year) params.semester = filters.year;
        if (filters.session) params.session = filters.session;
        return params;
    }

    // Search function — gated (existing behavior), but searches now run
    // server-side in the Worker against its KV-cached search index.
    // No full Firestore collection reads.
    window.performSearch = async function() {
        const searchTerm = document.getElementById('searchInput').value.toLowerCase().trim();
        const filters = getPyqFilterState();
        const filtersActive = hasActivePyqFilters();

        // 🔒 GATE: search & filters require login (existing behavior preserved)
        if ((searchTerm || filtersActive) && !currentUser) {
            openSearchGateModal();
            return;
        }
        // 🔒 Email verification gate — unverified cannot search
        if (currentUser && requiresEmailVerification(currentUser)) {
            showEmailVerificationPrompt();
            return;
        }

        const activeTabEl = document.querySelector('.nav-link.active');
        const activeTab = activeTabEl ? activeTabEl.getAttribute('data-bs-target') : '#nav-pyq';

        if (activeTab === '#nav-pyq') {
            if (!searchTerm && !filtersActive) {
                // Empty search — show paginated browse data with current sort
                filteredPyqs = applyPyqSorting([...allData.pyqs]);
                currentPage = 1;
                searchState = null;
                updatePyqResultsBar();
                renderPYQs();
                return;
            }

            showLoading('pyqList');
            const sort = getSortValue();
            try {
                const result = await searchPyqs(buildSearchParams(searchTerm, filters, sort, 1, itemsPerPage));
                const items = processAndSortItems(result.items || []);
                filteredPyqs = items;
                searchState = {
                    query: searchTerm,
                    filters,
                    sort,
                    page: result.page || 1,
                    totalPages: result.totalPages || 1,
                    total: result.total || 0
                };
                currentPage = 1;
                updatePyqResultsBar();
                renderPYQs();
            } catch (err) {
                console.error('Search failed:', err);
                showEmptyState('pyqList', 'Search is temporarily unavailable. Please try again.');
            }
        }
    };



    // PDF view function
    window.previewPDF = function(filePath, title) {
        if (!filePath || filePath === 'null') {
            alert('No document link available.');
            return;
        }

        if (isDirectPdfUrl(filePath) && !isMediaFireUrl(filePath)) {
            pdfViewer.src = filePath;
            document.getElementById('pdfModalLabel').textContent = title || 'Document Preview';
            pdfModal.show();
            return;
        }

        window.open(filePath, '_blank', 'noopener,noreferrer');
    };

    function incrementPyqViews(pyqId) {
        if (!pyqId) {
            return;
        }

        const incrementValue = firebase.firestore.FieldValue.increment(1);
        db.collection('pyqs').doc(pyqId).set({ views: incrementValue }, { merge: true })
            .catch(error => {
                console.warn('Unable to increment views:', error.message);
            });

        allData.pyqs = allData.pyqs.map(item => {
            if (item.id !== pyqId) {
                return item;
            }

            return {
                ...item,
                views: (Number(item.views) || 0) + 1
            };
        });

        filteredPyqs = filteredPyqs.map(item => {
            if (item.id !== pyqId) {
                return item;
            }

            return {
                ...item,
                views: (Number(item.views) || 0) + 1
            };
        });
    }

    window.openPyqDocument = function(pyqId, filePath, title) {
        if (!currentUser) {
            openSearchGateModal();
            return;
        }
        if (requiresEmailVerification(currentUser)) {
            showEmailVerificationPrompt();
            return;
        }
        incrementPyqViews(pyqId);
        // call original preview without re-gating (avoid double check)
        _origPreviewPDF(filePath, title);
    };
    // also gate direct preview wrapper for related cards
    const _origPreviewPDF = window.previewPDF;
    window.previewPDF = function(filePath, title) {
        if (!currentUser) {
            openSearchGateModal();
            return;
        }
        if (requiresEmailVerification(currentUser)) {
            showEmailVerificationPrompt();
            return;
        }
        return _origPreviewPDF(filePath, title);
    };

    // Share function
    window.shareDocument = function(filePath, title) {
        const currentUrl = window.location.origin + window.location.pathname;
        const shareUrl = `${(filePath)}`;
        
        shareLink.value = shareUrl;
        
        // Update social sharing links
        const whatsappShare = document.getElementById('whatsappShare');
        const telegramShare = document.getElementById('telegramShare');
        const emailShare = document.getElementById('emailShare');
        
        const shareText = `Check out this ${title} from DSMNRU Academic Archive`;
        
        whatsappShare.href = `https://wa.me/?text=${encodeURIComponent(shareText + ' ' + shareUrl)}`;
        telegramShare.href = `https://t.me/share/url?url=${encodeURIComponent(shareUrl)}&text=${encodeURIComponent(shareText)}`;
        emailShare.href = `mailto:?subject=${encodeURIComponent(title)}&body=${encodeURIComponent(shareText + '\n\n' + shareUrl)}`;
        
        shareModal.show();
    };

    // Newsletter subscription
    window.subscribeNewsletter = function(event) {
        event.preventDefault();
        const email = event.target.querySelector('input[type="email"]').value;
        
        // Here you would typically send the email to your backend
        alert(`Thank you for subscribing with email: ${email}. You'll receive updates about new uploads!`);
        event.target.reset();
    };

    // Handle direct PDF links from URL hash
    if (window.location.hash) {
        const pdfPath = decodeURIComponent(window.location.hash.substring(1));
        if (pdfPath.endsWith('.pdf')) {
            previewPDF(pdfPath, 'Shared Document');
        }
    }

    // Add loading states
    function showLoading(containerId) {
        document.getElementById(containerId).innerHTML = `
            <div class="loading loading-skeleton">
                <div class="skeleton-line skeleton-line-lg"></div>
                <div class="skeleton-line"></div>
                <div class="skeleton-line skeleton-line-sm"></div>
                <div class="skeleton-line skeleton-line-sm"></div>
            </div>
        `;
    }

    function isDirectPdfUrl(filePath) {
        const cleanUrl = filePath.split('#')[0].split('?')[0].toLowerCase();
        return cleanUrl.endsWith('.pdf');
    }

    function isMediaFireUrl(filePath) {
        try {
            return new URL(filePath).hostname.toLowerCase().includes('mediafire.com');
        } catch (error) {
            return /mediafire\.com/i.test(filePath);
        }
    }

    function getPreviewButtonMeta(filePath) {
        if (isDirectPdfUrl(filePath) && !isMediaFireUrl(filePath)) {
            return { label: 'Preview PDF', icon: 'fas fa-eye' };
        }

        return { label: 'Download', icon: 'fas fa-download' };
    }

    // Enhanced error handling
    function handleError(error, containerId, message) {
        console.error('Error:', error);
        document.getElementById(containerId).innerHTML = `
            <div class="empty-state">
                <i class="fas fa-exclamation-triangle"></i>
                <p>${message}</p>
                <button class="btn btn-outline-light mt-2" onclick="location.reload()">
                    <i class="fas fa-refresh"></i> Retry
                </button>
            </div>
        `;
    }

    // Keyboard shortcuts
    document.addEventListener('keydown', function(event) {
        // Ctrl+K or Cmd+K to focus search
        if ((event.ctrlKey || event.metaKey) && event.key === 'k') {
            event.preventDefault();
            document.getElementById('searchInput').focus();
        }
        
        // Escape to close modals
        if (event.key === 'Escape') {
            if (pdfModal._isShown) pdfModal.hide();
            if (shareModal._isShown) shareModal.hide();
        }
    });

    // Add smooth scrolling for better UX
    function smoothScrollToTop() {
        window.scrollTo({
            top: 0,
            behavior: 'smooth'
        });
    }

    // Show scroll to top button when needed
    window.addEventListener('scroll', function() {
        const scrollButton = document.getElementById('scrollToTop');
        if (window.pageYOffset > 300) {
            if (scrollButton) scrollButton.style.display = 'block';
        } else {
            if (scrollButton) scrollButton.style.display = 'none';
        }
    });

    // Add analytics tracking (placeholder)
    function trackEvent(category, action, label) {
        // Example: Google Analytics 4
        if (typeof gtag !== 'undefined') {
            gtag('event', action, {
                event_category: category,
                event_label: label
            });
        }
    }

    // Track downloads and shares
    document.addEventListener('click', function(event) {
        if (event.target.classList.contains('btn-download')) {
            trackEvent('Download', 'PDF', event.target.closest('.pyq-item, .syllabus-item').querySelector('h5').textContent);
        } else if (event.target.classList.contains('btn-share')) {
            trackEvent('Share', 'PDF', event.target.closest('.pyq-item, .syllabus-item').querySelector('h5').textContent);
        } else if (event.target.classList.contains('btn-preview')) {
            trackEvent('Preview', 'PDF', event.target.closest('.pyq-item, .syllabus-item').querySelector('h5').textContent);
        }
    });

    // Tool Information Modal Handler
function showToolInfo(toolId) {
    const toolInfo = {
        'cgpa': {
            title: 'CGPA Calculator',
            description: 'A comprehensive tool to calculate your Semester Grade Point Average (SGPA) for a set of subjects. Use it to compute semester performance quickly.',
            features: [
                'Calculate SGPA from letter grades and credits',
                'Adjust subject count dynamically',
                'Quick credit +/- controls',
                'Results preview and last-calculation persistence'
            ],
            benefits: [
                'Quickly estimate semester performance',
                'Plan target grades for upcoming subjects',
                'Save and reuse values locally'
            ]
        },
        'attendance': {
            title: 'Attendance Tracker',
            description: 'Track daily attendance per subject and view monthly summaries. Mark Present/Absent for specific dates and monitor percent attendance for each subject.',
            features: [
                'Record attendance by date (Present / Absent)',
                'Monthly summary and percentage calculation',
                'Edit and delete subjects',
                'Local persistence using localStorage'
            ],
            benefits: [
                'Keep a reliable local record of attendance',
                'Identify subjects close to attendance warning thresholds',
                'Simple offline-first design'
            ]
        },
        'planner': {
            title: 'Study Planner',
            description: 'Create tasks with due dates and reminders. Track progress and completion to stay organized during the semester.',
            features: [
                'Add / edit / delete study tasks',
                'Mark tasks complete and track progress',
                'Optional reminders for upcoming due dates',
                'Lightweight local storage for quick start'
            ],
            benefits: [
                'Organize study sessions and assignments',
                'Track completion rate visually',
                'Receive simple reminders for priority tasks'
            ]
        }
    };

    const info = toolInfo[toolId];
    if (!info) return;

    // Create modal HTML
    const modalHTML = `
        <div class="modal fade tool-info-modal" id="toolInfoModal" tabindex="-1" aria-hidden="true">
            <div class="modal-dialog modal-lg">
                <div class="modal-content">
                    <div class="modal-header">
                        <h5 class="modal-title">
                            <i class="fas fa-info-circle me-2"></i>${info.title}
                        </h5>
                        <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button>
                    </div>
                    <div class="modal-body">
                        <p class="mb-4">${info.description}</p>
                        
                        <div class="row">
                            <div class="col-md-6">
                                <h6><i class="fas fa-star text-warning me-2"></i>Key Features</h6>
                                <ul class="list-unstyled">
                                    ${info.features.map(feature => `<li><i class="fas fa-check text-success me-2"></i>${feature}</li>`).join('')}
                                </ul>
                            </div>
                            <div class="col-md-6">
                                <h6><i class="fas fa-lightbulb text-info me-2"></i>Benefits</h6>
                                <ul class="list-unstyled">
                                    ${info.benefits.map(benefit => `<li><i class="fas fa-arrow-right text-primary me-2"></i>${benefit}</li>`).join('')}
                                </ul>
                            </div>
                        </div>
                        
                        <div class="alert alert-info mt-3">
                            <i class="fas fa-info-circle me-2"></i>
                            <strong>Pro Tip:</strong> Use this tool regularly to stay on top of your academic tasks and attendance.
                        </div>
                    </div>
                    <div class="modal-footer">
                        <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Close</button>
                        <button type="button" class="btn btn-primary" id="openToolBtn">
                            <i class="fas fa-play me-2"></i> Open Tool
                        </button>
                    </div>
                </div>
            </div>
        </div>
    `;

    // Remove existing modal if any
    const existingModal = document.getElementById('toolInfoModal');
    if (existingModal) {
        existingModal.remove();
    }

    // Add new modal to body
    document.body.insertAdjacentHTML('beforeend', modalHTML);

    // Show modal
    const modalEl = document.getElementById('toolInfoModal');
    const modal = new bootstrap.Modal(modalEl);
    modal.show();

    // Wire Open Tool button to trigger the corresponding tool
    const openButtonMap = { cgpa: 'openCgpaBtn', attendance: 'openAttendanceBtn', planner: 'openPlannerBtn' };
    const openToolBtn = document.getElementById('openToolBtn');
    if (openToolBtn) {
        openToolBtn.addEventListener('click', () => {
            modal.hide();
            const targetBtnId = openButtonMap[toolId];
            const targetBtn = document.getElementById(targetBtnId);
            if (targetBtn) {
                targetBtn.click();
                trackToolUsage(toolId, 'open_from_info');
            } else {
                // Fallback: if no button exists, just log
                console.warn('Open button for', toolId, 'not found');
            }
        });
    }
}

// Expose to global scope for inline onclick handlers
window.showToolInfo = showToolInfo;

// Enhanced analytics for tool usage
function trackToolUsage(toolName, action) {
    // Track tool usage for analytics
    if (typeof gtag !== 'undefined') {
        gtag('event', 'tool_interaction', {
            'tool_name': toolName,
            'action': action,
            'page_location': window.location.href
        });
    }
    
    console.log(`Tool Usage: ${toolName} - ${action}`);
}

    // Floating Dashboard Button Functionality
    const dashboardBtn = document.getElementById('dashboardBtn');

    if (dashboardBtn) {
        dashboardBtn.addEventListener('click', function() {
            window.location.href = 'admin.html';
        });
    }

    // Dashboard Settings Functionality
    function loadDashboardSettings() {
        // Load theme setting
        const savedTheme = localStorage.getItem('dashboardTheme') || 'auto';
        document.querySelector(`input[name="theme"][value="${savedTheme}"]`).checked = true;

        // Load layout setting
        const savedLayout = localStorage.getItem('dashboardLayout') || 'expanded';
        document.querySelector(`input[name="layout"][value="${savedLayout}"]`).checked = true;

        // Load quick access settings
        const quickPyq = localStorage.getItem('quickPyq') === 'true';
        const quickSyllabus = localStorage.getItem('quickSyllabus') === 'true';
        const quickSearch = localStorage.getItem('quickSearch') === 'true';
        const quickUpload = localStorage.getItem('quickUpload') === 'true';

        document.getElementById('quickPyq').checked = quickPyq;
        document.getElementById('quickSyllabus').checked = quickSyllabus;
        document.getElementById('quickSearch').checked = quickSearch;
        document.getElementById('quickUpload').checked = quickUpload;
    }

    function saveDashboardSettings() {
        // Save theme setting
        const selectedTheme = document.querySelector('input[name="theme"]:checked').value;
        localStorage.setItem('dashboardTheme', selectedTheme);
        applyTheme(selectedTheme);

        // Save layout setting
        const selectedLayout = document.querySelector('input[name="layout"]:checked').value;
        localStorage.setItem('dashboardLayout', selectedLayout);
        applyLayout(selectedLayout);

        // Save quick access settings
        const quickPyq = document.getElementById('quickPyq').checked;
        const quickSyllabus = document.getElementById('quickSyllabus').checked;
        const quickSearch = document.getElementById('quickSearch').checked;
        const quickUpload = document.getElementById('quickUpload').checked;

        localStorage.setItem('quickPyq', quickPyq);
        localStorage.setItem('quickSyllabus', quickSyllabus);
        localStorage.setItem('quickSearch', quickSearch);
        localStorage.setItem('quickUpload', quickUpload);

        applyQuickAccess({ quickPyq, quickSyllabus, quickSearch, quickUpload });

        // Show success message
        showSettingsSavedMessage();
    }

    function applyTheme(theme) {
        const body = document.body;
        body.classList.remove('theme-light', 'theme-dark', 'theme-auto');

        if (theme === 'light') {
            body.classList.add('theme-light');
        } else if (theme === 'dark') {
            body.classList.add('theme-dark');
        } else {
            body.classList.add('theme-auto');
            // Apply system preference
            if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
                body.classList.add('theme-dark');
            } else {
                body.classList.add('theme-light');
            }
        }
    }

    function applyLayout(layout) {
        const body = document.body;
        body.classList.remove('layout-compact', 'layout-expanded');
        body.classList.add(`layout-${layout}`);
    }

    function applyQuickAccess(settings) {
        // This could be extended to show/hide quick access elements
        // For now, we'll just store the preferences
        console.log('Quick access settings applied:', settings);
    }

    function showSettingsSavedMessage() {
        // Create and show a temporary success message
        const toast = document.createElement('div');
        toast.className = 'toast align-items-center text-white bg-success border-0 position-fixed';
        toast.style.cssText = 'top: 20px; right: 20px; z-index: 9999;';
        toast.innerHTML = `
            <div class="d-flex">
                <div class="toast-body">
                    <i class="fas fa-check-circle me-2"></i> Settings saved successfully!
                </div>
                <button type="button" class="btn-close btn-close-white me-2 m-auto" data-bs-dismiss="toast"></button>
            </div>
        `;

        document.body.appendChild(toast);
        const bsToast = new bootstrap.Toast(toast);
        bsToast.show();

        // Remove toast after it's hidden
        toast.addEventListener('hidden.bs.toast', () => {
            document.body.removeChild(toast);
        });
    }

    // Save Settings Button Event Listener
    const saveSettingsBtn = document.getElementById('saveDashboardSettings');
    if (saveSettingsBtn) {
        saveSettingsBtn.addEventListener('click', function() {
            saveDashboardSettings();
            dashboardModal.hide();
        });
    }

    // Apply saved settings on page load
    function applySavedSettings() {
        const savedTheme = localStorage.getItem('dashboardTheme') || 'auto';
        const savedLayout = localStorage.getItem('dashboardLayout') || 'expanded';

        applyTheme(savedTheme);
        applyLayout(savedLayout);
    }

    // Apply settings when DOM is loaded
    applySavedSettings();

    /* ----------------- CGPA Calculator Module ----------------- */
    const cgpaModalEl = document.getElementById('cgpaModal');
    const openCgpaBtn = document.getElementById('openCgpaBtn');
    if (openCgpaBtn && cgpaModalEl) {
        const cgpaModal = new bootstrap.Modal(cgpaModalEl);
        openCgpaBtn.addEventListener('click', ()=>{ cgpaModal.show(); renderCgpaSubjects(); });

        // Grade to points mapping (example 10-point scale)
        const gradeMap = { 'O':10, 'A+':9, 'A':8, 'B+':7, 'B':6, 'C':5, 'D':4, 'F':0 };

        const cgpaCountInput = document.getElementById('cgpaCount');
        const cgpaInc = document.getElementById('cgpaInc');
        const cgpaDec = document.getElementById('cgpaDec');
        const cgpaSubjects = document.getElementById('cgpaSubjects');
        const calculateCgpaBtn = document.getElementById('calculateCgpaBtn');
        const resetCgpaBtn = document.getElementById('resetCgpaBtn');
        const cgpaResults = document.getElementById('cgpaResults');

        function renderCgpaSubjects(){
            const count = Number(cgpaCountInput.value) || 1;
            cgpaSubjects.innerHTML = '';
            for(let i=1;i<=count;i++){
                const row = document.createElement('div');
                row.className = 'd-flex gap-2 align-items-center mb-2';
                row.innerHTML = `
                    <div style="flex:1">
                        <label class="form-label">Letter grade for subject ${i}</label>
                        <select class="form-control cgpa-grade" data-i="${i}">
                            <option value="O">O</option>
                            <option value="A+">A+</option>
                            <option value="A">A</option>
                            <option value="B+">B+</option>
                            <option value="B">B</option>
                            <option value="C">C</option>
                            <option value="D">D</option>
                            <option value="F">F</option>
                        </select>
                    </div>
                    <div style="width:120px">
                        <label class="form-label">Credits</label>
                        <div class="d-flex align-items-center">
                            <button class="btn btn-outline-light btn-sm credit-dec" type="button">-</button>
                            <input type="number" min="0" value="1" class="form-control form-control-sm mx-1 cgpa-credit" style="width:60px" />
                            <button class="btn btn-outline-light btn-sm credit-inc" type="button">+</button>
                        </div>
                    </div>
                `;
                cgpaSubjects.appendChild(row);
            }

            // wire credit +/- buttons
            cgpaSubjects.querySelectorAll('.credit-inc').forEach(btn=> btn.addEventListener('click', (e)=>{ const input = e.target.closest('div').querySelector('.cgpa-credit'); input.value = Number(input.value||0)+1; }));
            cgpaSubjects.querySelectorAll('.credit-dec').forEach(btn=> btn.addEventListener('click', (e)=>{ const input = e.target.closest('div').querySelector('.cgpa-credit'); input.value = Math.max(0, Number(input.value||0)-1); }));
        }

        cgpaInc.addEventListener('click', ()=>{ cgpaCountInput.value = Math.min(20, Number(cgpaCountInput.value||1)+1); renderCgpaSubjects(); });
        cgpaDec.addEventListener('click', ()=>{ cgpaCountInput.value = Math.max(1, Number(cgpaCountInput.value||1)-1); renderCgpaSubjects(); });
        cgpaCountInput.addEventListener('change', renderCgpaSubjects);

        function calculateCgpa(){
            const grades = Array.from(document.querySelectorAll('.cgpa-grade')).map(s=>s.value);
            const credits = Array.from(document.querySelectorAll('.cgpa-credit')).map(i=>Number(i.value||0));
            let totalPoints = 0, totalCredits = 0;
            for(let i=0;i<grades.length;i++){
                const g = grades[i];
                const c = credits[i]||0;
                const pts = (gradeMap[g]!==undefined)? gradeMap[g] : 0;
                totalPoints += pts * c;
                totalCredits += c;
            }
            const sgpa = totalCredits ? (totalPoints/totalCredits) : 0;
            cgpaResults.innerHTML = `
                <div class="card card__body">
                    <p><strong>Total Credits:</strong> ${totalCredits}</p>
                    <p><strong>Total Grade Points:</strong> ${totalPoints.toFixed(2)}</p>
                    <p><strong>SGPA / Semester GPA:</strong> ${sgpa.toFixed(2)}</p>
                </div>
            `;

            // Save to simple local history (last calculation)
            localStorage.setItem('dsmnruCgpaLast', JSON.stringify({ totalCredits, totalPoints, sgpa, timestamp: new Date().toISOString() }));
        }

        calculateCgpaBtn.addEventListener('click', calculateCgpa);
        resetCgpaBtn.addEventListener('click', ()=>{ cgpaCountInput.value = 1; renderCgpaSubjects(); cgpaResults.innerHTML = ''; });

        // initial render
        renderCgpaSubjects();
    }

    // Add event listeners for tool tracking
    // Track CGPA calculator clicks
    const cgpaButtons = document.querySelectorAll('a[href*="cgpa-calc.streamlit.app"]');
    cgpaButtons.forEach(button => {
        button.addEventListener('click', () => {
            trackToolUsage('CGPA Calculator', 'external_link_click');
        });
    });

    // Track tool info button clicks
    const infoButtons = document.querySelectorAll('.btn-tool-info');
    infoButtons.forEach(button => {
        button.addEventListener('click', (e) => {
            const toolName = e.target.closest('.tool-card').querySelector('.tool-title').textContent;
            trackToolUsage(toolName, 'info_modal_open');
        });
    });

    // Track suggestion clicks
    const suggestionButtons = document.querySelectorAll('a[href*="t.me/dsmnru_updates"]');
    suggestionButtons.forEach(button => {
        if (button.textContent.includes('Suggest Tool')) {
            button.addEventListener('click', () => {
                trackToolUsage('Tool Suggestion', 'telegram_click');
            });
        }
    });

});

// Global fallback toggle for chat widget (so inline onclick works)
function toggleChatWidget() {
    try {
        // Open the official chat panel in a new tab/window; fallback to same-tab if blocked
        const CHAT_URL = 'https://realtime-agent-cfje.onrender.com/';
        // Use noopener for security
        const newWin = window.open(CHAT_URL, '_blank', 'noopener');
        // Optionally store a metric that user opened the external chat
        try { localStorage.setItem('dsmnru_chat_last_open', Date.now().toString()); } catch (e) { /* ignore */ }
    } catch (err) {
        console.error('toggleChatWidget error:', err);
    }
}

/* ------------------ Study Planner (global) ------------------ */
(function(){
    const PLANNER_KEY = 'dsmnruStudyPlanner';
    let plannerTasks = [];

    function loadPlanner(){
        try{ plannerTasks = JSON.parse(localStorage.getItem(PLANNER_KEY)) || []; }catch(e){ plannerTasks = []; }
        updatePlannerSummary();
    }
    function savePlanner(){ localStorage.setItem(PLANNER_KEY, JSON.stringify(plannerTasks)); updatePlannerSummary(); }

    function updatePlannerSummary(){
        const total = plannerTasks.length;
        const completed = plannerTasks.filter(t=>t.completed).length;
        const countEl = document.getElementById('plannerCount');
        const compEl = document.getElementById('plannerCompleted');
        const fill = document.getElementById('plannerProgressFill');
        if(countEl) countEl.textContent = `${total} task${total!==1?'s':''}`;
        if(compEl) compEl.textContent = `${completed} completed`;
        if(fill) fill.style.width = total? `${Math.round((completed/total)*100)}%` : '0%';
    }

    function renderPlannerModal(){
        let modal = document.getElementById('plannerModal');
        if(!modal){
            modal = document.createElement('div'); modal.id='plannerModal'; modal.className='modal fade'; modal.tabIndex=-1;
            modal.innerHTML = `
            <div class="modal-dialog modal-lg modal-dialog-centered">
              <div class="modal-content planner-panel">
                <div class="modal-header">
                  <h5 class="modal-title">Study Planner</h5>
                  <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
                </div>
                <div class="modal-body">
                  <form id="plannerForm" class="mb-3 d-flex gap-2">
                    <input id="plannerTitle" class="form-control" placeholder="Task title (e.g. Read Chapters 1-3)" required />
                    <input id="plannerDue" type="datetime-local" class="form-control" />
                    <button class="btn btn-primary" type="submit">Add</button>
                  </form>
                  <ul id="plannerList" class="planner-list"></ul>
                </div>
                <div class="modal-footer">
                  <button class="btn btn-secondary" data-bs-dismiss="modal">Close</button>
                  <button class="btn btn-outline-light" id="clearPlannerBtn">Clear All</button>
                </div>
              </div>
            </div>`;
            document.body.appendChild(modal);
            modal.bs = new bootstrap.Modal(modal);
            modal.querySelector('#plannerForm').addEventListener('submit', function(e){
                e.preventDefault();
                const title = document.getElementById('plannerTitle').value.trim();
                const due = document.getElementById('plannerDue').value || null;
                if(!title) return;
                plannerTasks.push({ id: Date.now(), title, due, completed:false }); savePlanner(); renderPlannerItems(); document.getElementById('plannerForm').reset(); scheduleReminders();
            });
            modal.querySelector('#clearPlannerBtn').addEventListener('click', function(){ if(confirm('Clear all tasks?')){ plannerTasks = []; savePlanner(); renderPlannerItems(); } });
        }
        renderPlannerItems(); modal.bs.show();
    }

    function renderPlannerItems(){
        const list = document.getElementById('plannerList'); if(!list) return;
        if(plannerTasks.length===0){ list.innerHTML = `<li class="empty-state"><p>No tasks yet. Add a task using the form above.</p></li>`; updatePlannerSummary(); return; }
        list.innerHTML = plannerTasks.map(task => `
            <li class="planner-item" data-id="${task.id}">
                <div class="left">
                    <input type="checkbox" class="planner-checkbox" ${task.completed? 'checked':''} />
                    <div>
                      <div class="planner-title">${escapeHtml(task.title)}</div>
                      <div class="meta">${task.due? ('Due: '+ formatDate(task.due)) : ''}</div>
                    </div>
                </div>
                <div class="planner-actions">
                    <button class="btn btn-sm btn-outline-light btn-edit">Edit</button>
                    <button class="btn btn-sm btn-outline-danger btn-delete">Delete</button>
                </div>
            </li>`).join('');
        list.querySelectorAll('.planner-item').forEach(li=>{
            const id = Number(li.getAttribute('data-id'));
            li.querySelector('.planner-checkbox').addEventListener('change', function(){ const task = plannerTasks.find(t=>t.id===id); if(!task) return; task.completed = this.checked; savePlanner(); renderPlannerItems(); });
            li.querySelector('.btn-delete').addEventListener('click', function(){ if(confirm('Delete task?')){ plannerTasks = plannerTasks.filter(t=>t.id!==id); savePlanner(); renderPlannerItems(); } });
            li.querySelector('.btn-edit').addEventListener('click', function(){ const task = plannerTasks.find(t=>t.id===id); if(!task) return; const newTitle = prompt('Edit task title', task.title); if(newTitle!==null){ task.title = newTitle.trim() || task.title; savePlanner(); renderPlannerItems(); } });
        });
        updatePlannerSummary();
    }

    function scheduleReminders(){ if(window._plannerTimeouts) window._plannerTimeouts.forEach(t=>clearTimeout(t)); window._plannerTimeouts = []; plannerTasks.forEach(task=>{ if(task.due && !task.completed){ const when = new Date(task.due).getTime(); const now = Date.now(); const delta = when - now; if(delta>0 && delta<1000*60*60*24*7){ const timeout = setTimeout(()=>{ if(window.Notification && Notification.permission==='granted'){ new Notification('Study Planner Reminder', { body: task.title }); } else { alert('Reminder: '+task.title); } }, delta); window._plannerTimeouts.push(timeout); } } }); }

    function formatDate(iso){ try{ const d = new Date(iso); return d.toLocaleString(); }catch(e){return iso} }
    function escapeHtml(s){ return String(s).replace(/[&<>"]+/g, c=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }

    // wire open button
    document.addEventListener('DOMContentLoaded', function(){ const openPlannerBtn = document.getElementById('openPlannerBtn'); if(openPlannerBtn) openPlannerBtn.addEventListener('click', function(){ renderPlannerModal(); }); loadPlanner(); scheduleReminders(); if('Notification' in window && Notification.permission==='default'){ try{ Notification.requestPermission(); }catch(e){} } });

})();

/* ------------------ Attendance Tracker (global) ------------------ */
(function(){
        const ATT_KEY = 'dsmnruAttendance';
        let attendance = []; // {id, subject, present, total}
        const WARNING_THRESHOLD = 75; // percent

        // Local HTML-escape helper (attendance module scope)
        function escapeHtml(s){ return String(s).replace(/[&<>"']/g, function(c){
            return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":"&#39;"}[c]);
        }); }

        function loadAttendance(){
                try{ attendance = JSON.parse(localStorage.getItem(ATT_KEY)) || []; }catch(e){ attendance = []; }
                updateAttendanceSummary();
        }
        function saveAttendance(){ localStorage.setItem(ATT_KEY, JSON.stringify(attendance)); updateAttendanceSummary(); }

        function updateAttendanceSummary(){
                const subs = attendance.length;
                const near = attendance.filter(s=> percentage(s) < WARNING_THRESHOLD && percentage(s) >= WARNING_THRESHOLD-5).length;
                const subjectsEl = document.getElementById('attendanceSubjects');
                const warnEl = document.getElementById('attendanceWarn');
                if(subjectsEl) subjectsEl.textContent = `${subs} subject${subs!==1?'s':''}`;
                if(warnEl) warnEl.textContent = `${near} near limit`;
        }

        function percentage(s){ if(!s || s.total===0) return 0; return Math.round((s.present / s.total)*100); }

        function renderAttendanceModal(){
                let modal = document.getElementById('attendanceModal');
                if(!modal){
                        modal = document.createElement('div'); modal.id='attendanceModal'; modal.className='modal fade'; modal.tabIndex=-1;
                        modal.innerHTML = `
                        <div class="modal-dialog modal-lg modal-dialog-centered">
                            <div class="modal-content planner-panel">
                                <div class="modal-header">
                                    <h5 class="modal-title">Attendance Tracker</h5>
                                    <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
                                </div>
                                <div class="modal-body">
                                    <form id="attendanceForm" class="mb-3 d-flex gap-2">
                                        <input id="attendanceSubject" class="form-control" placeholder="Subject name (e.g. Mathematics)" required />
                                        <button class="btn btn-primary" type="submit">Add Subject</button>
                                    </form>
                                    <div class="d-flex gap-2 mb-3">
                                        <label class="form-label mb-0">Mark date:</label>
                                        <input id="attendanceDate" type="date" class="form-control" />
                                        <label class="form-label mb-0">View month:</label>
                                        <input id="attendanceMonth" type="month" class="form-control" />
                                    </div>
                                    <ul id="attendanceList" class="attendance-list"></ul>
                                </div>
                                <div class="modal-footer">
                                    <button class="btn btn-secondary" data-bs-dismiss="modal">Close</button>
                                    <button class="btn btn-outline-light" id="clearAttendanceBtn">Clear All</button>
                                </div>
                            </div>
                        </div>`;
                        document.body.appendChild(modal);
                        modal.bs = new bootstrap.Modal(modal);
                        // set default values for date/month inputs when modal created
                        const dateInput = modal.querySelector('#attendanceDate');
                        const monthInput = modal.querySelector('#attendanceMonth');
                        const today = new Date();
                        const yyyy = today.getFullYear();
                        const mm = String(today.getMonth()+1).padStart(2,'0');
                        dateInput.value = `${yyyy}-${mm}-${String(today.getDate()).padStart(2,'0')}`;
                        monthInput.value = `${yyyy}-${mm}`;

                        modal.querySelector('#attendanceForm').addEventListener('submit', function(e){
                            e.preventDefault();
                            const sub = document.getElementById('attendanceSubject').value.trim();
                            if(!sub) return;
                            // new structure uses records mapping date->'P'|'A'
                            attendance.push({ id: Date.now(), subject: sub, records: {} });
                            saveAttendance(); renderAttendanceItems(); this.reset();
                        });
                        modal.querySelector('#clearAttendanceBtn').addEventListener('click', function(){ if(confirm('Clear attendance data for all subjects?')){ attendance=[]; saveAttendance(); renderAttendanceItems(); } });
                        // when month or date changes, re-render list to show current month values
                        modal.querySelector('#attendanceMonth').addEventListener('input', renderAttendanceItems);
                        modal.querySelector('#attendanceDate').addEventListener('input', renderAttendanceItems);
                }
                renderAttendanceItems(); modal.bs.show();
        }

        function renderAttendanceItems(){
                const list = document.getElementById('attendanceList'); if(!list) return;
                if(attendance.length===0){ list.innerHTML = `<li class="empty-state"><p>No subjects yet. Add a subject to start tracking attendance.</p></li>`; updateAttendanceSummary(); return; }
                const monthInput = document.getElementById('attendanceMonth');
                const dateInput = document.getElementById('attendanceDate');
                const selectedMonth = monthInput && monthInput.value ? monthInput.value : (new Date()).toISOString().slice(0,7);
                const selectedDate = dateInput && dateInput.value ? dateInput.value : (new Date()).toISOString().slice(0,10);
                list.innerHTML = attendance.map(s=>{
                        // support legacy present/total if records missing
                        let pct = 0; let monthSummaryText = '';
                        if(s.records){
                            const keys = Object.keys(s.records).filter(k => k.startsWith(selectedMonth));
                            const total = keys.length;
                            const present = keys.filter(k => s.records[k]==='P').length;
                            pct = total? Math.round((present/total)*100) : 0;
                            monthSummaryText = total? `Present this month: ${present} / ${total} (${pct}%)` : 'No records this month';
                        } else if(typeof s.present === 'number'){
                            pct = percentage(s);
                            monthSummaryText = `Present: ${s.present} / ${s.total} (${pct}%)`;
                        }
                        // status for selected date
                        const statusForDate = (s.records && s.records[selectedDate]) ? s.records[selectedDate] : 'N/A';
                        return `
                        <li class="attendance-item" data-id="${s.id}">
                            <div>
                                <strong>${escapeHtml(s.subject)}</strong>
                                <div class="meta">${monthSummaryText}</div>
                                <div class="meta">Status on ${selectedDate}: ${statusForDate}</div>
                                <div class="attendance-progress"><div style="width:${pct}%"></div></div>
                            </div>
                            <div>
                                <button class="btn btn-sm btn-outline-light mark-present">Present</button>
                                <button class="btn btn-sm btn-outline-danger mark-absent">Absent</button>
                                <button class="btn btn-sm btn-outline-light btn-edit">Edit</button>
                                <button class="btn btn-sm btn-outline-danger btn-delete">Delete</button>
                            </div>
                        </li>`;
                }).join('');
                list.querySelectorAll('.attendance-item').forEach(li=>{
                        const id = Number(li.getAttribute('data-id'));
                        li.querySelector('.mark-present').addEventListener('click', ()=>{ const s = attendance.find(x=>x.id===id); const dateInput = document.getElementById('attendanceDate'); const d = dateInput && dateInput.value ? dateInput.value : (new Date()).toISOString().slice(0,10); if(!s.records) s.records = {}; s.records[d]='P'; saveAttendance(); renderAttendanceItems(); checkWarnings(s); });
                        li.querySelector('.mark-absent').addEventListener('click', ()=>{ const s = attendance.find(x=>x.id===id); const dateInput = document.getElementById('attendanceDate'); const d = dateInput && dateInput.value ? dateInput.value : (new Date()).toISOString().slice(0,10); if(!s.records) s.records = {}; s.records[d]='A'; saveAttendance(); renderAttendanceItems(); checkWarnings(s); });
                        li.querySelector('.btn-delete').addEventListener('click', ()=>{ if(confirm('Delete subject?')){ attendance = attendance.filter(x=>x.id!==id); saveAttendance(); renderAttendanceItems(); } });
                        li.querySelector('.btn-edit').addEventListener('click', ()=>{ const s = attendance.find(x=>x.id===id); const newName = prompt('Edit subject name', s.subject); if(newName!==null){ s.subject = newName.trim() || s.subject; saveAttendance(); renderAttendanceItems(); } });
                });
                updateAttendanceSummary();
        }

        function checkWarnings(s){ const pct = percentage(s); if(pct < WARNING_THRESHOLD){ if(pct < WARNING_THRESHOLD-10){ alert(`Warning: ${s.subject} attendance is low (${pct}%).`); } else { /* softer warning */ } } }

        // wire button
        document.addEventListener('DOMContentLoaded', function(){ const openBtn = document.getElementById('openAttendanceBtn'); if(openBtn) openBtn.addEventListener('click', ()=> renderAttendanceModal()); loadAttendance(); });

})();

/* ======================== FEEDBACK MODULE (Report Broken Links & Request PYQs) ======================== */

// Function to open Report Broken Link modal
window.openReportBrokenLinkModal = function(title = '', course = '') {
    if (currentUser && requiresEmailVerification(currentUser)) { showEmailVerificationPrompt(); return; }
    if (!currentUser) { openLoginModal(); return; }
    const modal = new bootstrap.Modal(document.getElementById('reportBrokenLinkModal'));
    if (title) document.getElementById('reportTitle').value = title;
    if (course) document.getElementById('reportCourse').value = course;
    modal.show();
};

// Function to open Request PYQ modal
window.openRequestPyqModal = function() {
    if (currentUser && requiresEmailVerification(currentUser)) { showEmailVerificationPrompt(); return; }
    if (!currentUser) { openLoginModal(); return; }
    const modal = new bootstrap.Modal(document.getElementById('requestPyqModal'));
    modal.show();
};

// Handle Report Broken Link form submission
document.addEventListener('DOMContentLoaded', function() {
    const reportForm = document.getElementById('reportBrokenLinkForm');
    if (reportForm) {
        reportForm.addEventListener('submit', async function(e) {
            e.preventDefault();
            
            const title = document.getElementById('reportTitle').value.trim();
            const course = document.getElementById('reportCourse').value.trim();
            const details = document.getElementById('reportDetails').value.trim();
            const email = document.getElementById('reportEmail').value.trim();
            
            if (!title || !course || !details) {
                showFeedbackError('reportBrokenLinkError', 'Please fill in all required fields');
                return;
            }
            
            try {
                // Submit to Firestore
                await db.collection('feedback').add({
                    type: 'broken_link',
                    title: title,
                    course: course,
                    details: details,
                    email: email || null,
                    userId: currentUser ? currentUser.uid : null,
                    userEmail: currentUser ? currentUser.email : null,
                    createdAt: firebase.firestore.FieldValue.serverTimestamp(),
                    status: 'new'
                });
                
                showFeedbackSuccess('reportBrokenLinkSuccess', 'Thank you! We\'ll look into this issue.');
                reportForm.reset();
                setTimeout(() => {
                    document.getElementById('reportBrokenLinkSuccess').style.display = 'none';
                    bootstrap.Modal.getInstance(document.getElementById('reportBrokenLinkModal')).hide();
                }, 2000);
            } catch (error) {
                console.error('Error submitting report:', error);
                showFeedbackError('reportBrokenLinkError', 'Failed to submit report. Please try again.');
            }
        });
    }
    
    // Handle Request PYQ form submission
    const requestForm = document.getElementById('requestPyqForm');
    if (requestForm) {
        requestForm.addEventListener('submit', async function(e) {
            e.preventDefault();
            
            const course = document.getElementById('requestCourseField').value.trim();
            const subject = document.getElementById('requestSubject').value.trim();
            const semester = document.getElementById('requestSemester').value.trim();
            const session = document.getElementById('requestSession').value.trim();
            const email = document.getElementById('requestEmail2').value.trim();
            
            if (!course || !subject || !semester) {
                showFeedbackError('requestPyqError', 'Please fill in all required fields');
                return;
            }
            
            try {
                // Submit to Firestore
                await db.collection('feedback').add({
                    type: 'pyq_request',
                    course: course,
                    subject: subject,
                    semester: semester,
                    session: session || null,
                    email: email || null,
                    userId: currentUser ? currentUser.uid : null,
                    userEmail: currentUser ? currentUser.email : null,
                    createdAt: firebase.firestore.FieldValue.serverTimestamp(),
                    status: 'new'
                });
                
                showFeedbackSuccess('requestPyqSuccess', 'Thank you! We\'ll try to find this PYQ for you.');
                requestForm.reset();
                setTimeout(() => {
                    document.getElementById('requestPyqSuccess').style.display = 'none';
                    bootstrap.Modal.getInstance(document.getElementById('requestPyqModal')).hide();
                }, 2000);
            } catch (error) {
                console.error('Error submitting request:', error);
                showFeedbackError('requestPyqError', 'Failed to submit request. Please try again.');
            }
        });
    }
});

// Helper functions for feedback forms
function showFeedbackError(elementId, message) {
    const errorEl = document.getElementById(elementId);
    if (errorEl) {
        errorEl.textContent = message;
        errorEl.style.display = 'block';
        setTimeout(() => {
            errorEl.style.display = 'none';
        }, 5000);
    }
}

function showFeedbackSuccess(elementId, message) {
    const successEl = document.getElementById(elementId);
    if (successEl) {
        successEl.textContent = message;
        successEl.style.display = 'block';
    }
}
