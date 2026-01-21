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

document.addEventListener('DOMContentLoaded', function() {
    // Initialize modals
    const pdfModal = new bootstrap.Modal(document.getElementById('pdfModal'));
    const shareModal = new bootstrap.Modal(document.getElementById('shareModal'));
    const pdfViewer = document.getElementById('pdfViewer');
    const downloadBtn = document.getElementById('downloadBtn');
    const shareLink = document.getElementById('shareLink');
    const copyLinkBtn = document.getElementById('copyLinkBtn');
    const pyqList = document.getElementById('pyqList');
    const syllabusList = document.getElementById('syllabusList');

    // Global data storage
    let allData = { pyqs: [], syllabus: [] };
    let filteredPyqs = [];
    let filteredSyllabus = [];
    let bookmarks = { pyqs: [], syllabus: [] };

    // Pagination variables for PYQs
    let currentPage = 1;
    const itemsPerPage = 10;

    // Pagination variables for Syllabus
    let currentPageSyllabus = 1;
    const itemsPerPageSyllabus = 10;

    // Pagination variables for Bookmarks
    let currentPageBookmarks = 1;
    const itemsPerPageBookmarks = 10;

    // Function to extract year from title
    function extractYearFromTitle(title) {
        const yearMatch = title.match(/\{(\d{4})/);
        return yearMatch ? parseInt(yearMatch[1]) : 0;
    }

    // Load data from Firestore
    const db = firebase.firestore();
    Promise.all([
        db.collection('pyqs').get(),
        db.collection('syllabus').get()
    ])
    .then(([pyqSnap, syllabusSnap]) => {
        allData.pyqs = pyqSnap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        allData.syllabus = syllabusSnap.docs.map(doc => ({ id: doc.id, ...doc.data() }));

        // Add year to each item and sort
        const processedPYQs = allData.pyqs.map(pyq => ({
            ...pyq,
            year: extractYearFromTitle(pyq.title)
        })).sort((a, b) => b.year - a.year);

        const processedSyllabus = allData.syllabus.map(syllabus => ({
            ...syllabus,
            year: extractYearFromTitle(syllabus.title)
        })).sort((a, b) => b.year - a.year);

        allData.pyqs = processedPYQs;
        allData.syllabus = processedSyllabus;

        filteredPyqs = [...processedPYQs];
        filteredSyllabus = [...processedSyllabus];

        loadBookmarks();
        renderPYQs(filteredPyqs);
        renderSyllabus(filteredSyllabus);
        setupEventListeners();
    })
    .catch(error => {
        console.error('Error loading data from Firestore:', error);
        showEmptyState('pyqList', 'Error loading question papers');
        showEmptyState('syllabusList', 'Error loading syllabus');
    });

    function renderPYQs(pyqs) {
        const startIndex = (currentPage - 1) * itemsPerPage;
        const endIndex = startIndex + itemsPerPage;
        const pyqsToRender = filteredPyqs.slice(startIndex, endIndex);

        if (!pyqsToRender.length) {
            if (currentPage === 1) {
                showEmptyState('pyqList', 'No question papers found matching your criteria');
            }
            document.getElementById('loadMoreBtn').style.display = 'none';
            return;
        }

        if (currentPage === 1) {
            pyqList.innerHTML = '';
        }

        pyqList.insertAdjacentHTML('beforeend', pyqsToRender.map((pyq, index) => `
            <li class="pyq-item" style="animation-delay: ${0.1 + (startIndex + index) * 0.05}s">
                <div class="pyq-info">
                    <div class="pdf-icon">
                        <i class="fas fa-file-pdf"></i>
                    </div>
                    <div class="pyq-details">
                        <h5 class="pyq-title">${pyq.title}</h5>
                        <div class="pyq-actions">
                            <button class="btn btn-action btn-preview" onclick="previewPDF('${pyq.file}', '${pyq.title.replace(/'/g, "\\'")}')">
                                <i class="fas fa-eye"></i> View
                            </button>
                            <button class="btn btn-action btn-share" onclick="shareDocument('${pyq.file}', '${pyq.title.replace(/'/g, "\\'")}')">
                                <i class="fas fa-share-alt"></i> Share
                            </button>
                            <button class="btn btn-action btn-bookmark ${isBookmarked('pyqs', pyq.file) ? 'bookmarked' : ''}" onclick="toggleBookmark('pyqs', '${pyq.file}')">
                                <i class="fas fa-bookmark"></i> ${isBookmarked('pyqs', pyq.file) ? 'Bookmarked' : 'Bookmark'}
                            </button>
                        </div>
                    </div>
                </div>
            </li>
        `).join(''));

        // Show or hide Load More button
        const loadMoreBtn = document.getElementById('loadMoreBtn');
        if (endIndex < filteredPyqs.length) {
            loadMoreBtn.style.display = 'inline-block';
        } else {
            loadMoreBtn.style.display = 'none';
        }
    }

    function renderSyllabus(syllabusItems) {
        const startIndex = (currentPageSyllabus - 1) * itemsPerPageSyllabus;
        const endIndex = startIndex + itemsPerPageSyllabus;
        const syllabusToRender = filteredSyllabus.slice(startIndex, endIndex);

        if (!syllabusToRender.length) {
            if (currentPageSyllabus === 1) {
                showEmptyState('syllabusList', 'No syllabus found matching your criteria');
            }
            document.getElementById('loadMoreSyllabusBtn').style.display = 'none';
            return;
        }

        if (currentPageSyllabus === 1) {
            syllabusList.innerHTML = '';
        }

        syllabusList.insertAdjacentHTML('beforeend', syllabusToRender.map((syllabus, index) => `
            <li class="syllabus-item" style="animation-delay: ${0.1 + (startIndex + index) * 0.05}s">
                <div class="syllabus-info">
                    <div class="syllabus-icon">
                        <i class="fas fa-book"></i>
                    </div>
                    <div class="syllabus-details">
                        <h5 class="syllabus-title">${syllabus.title}</h5>
                        <div class="syllabus-meta">
                            <span class="meta-tag course">${syllabus.course || 'General'}</span>
                            <span class="meta-tag semester">${syllabus.semester || 'All Semesters'}</span>
                            <span class="meta-tag">${syllabus.year || 'Latest'}</span>
                        </div>
                        <div class="syllabus-actions">
                            <button class="btn btn-action btn-preview" onclick="previewPDF('${syllabus.file}', '${syllabus.title.replace(/'/g, "\\'")}')">
                                <i class="fas fa-eye"></i> View
                            </button>
                            <button class="btn btn-action btn-share" onclick="shareDocument('${syllabus.file}', '${syllabus.title.replace(/'/g, "\\'")}')">
                                <i class="fas fa-share-alt"></i> Share
                            </button>
                            <button class="btn btn-action btn-bookmark ${isBookmarked('syllabus', syllabus.file) ? 'bookmarked' : ''}" onclick="toggleBookmark('syllabus', '${syllabus.file}')">
                                <i class="fas fa-bookmark"></i> ${isBookmarked('syllabus', syllabus.file) ? 'Bookmarked' : 'Bookmark'}
                            </button>
                        </div>
                    </div>
                </div>
            </li>
        `).join(''));

        // Show or hide Load More button
        const loadMoreSyllabusBtn = document.getElementById('loadMoreSyllabusBtn');
        if (endIndex < filteredSyllabus.length) {
            loadMoreSyllabusBtn.style.display = 'inline-block';
        } else {
            loadMoreSyllabusBtn.style.display = 'none';
        }
    }

    function renderBookmarks(searchTerm = '') {
        const startIndex = (currentPageBookmarks - 1) * itemsPerPageBookmarks;
        const endIndex = startIndex + itemsPerPageBookmarks;

        // Collect all bookmarked items
        let bookmarkedItems = [];
        bookmarks.pyqs.forEach(filePath => {
            const item = allData.pyqs.find(pyq => pyq.file === filePath);
            if (item) {
                bookmarkedItems.push({ ...item, type: 'pyq' });
            }
        });
        bookmarks.syllabus.forEach(filePath => {
            const item = allData.syllabus.find(syllabus => syllabus.file === filePath);
            if (item) {
                bookmarkedItems.push({ ...item, type: 'syllabus' });
            }
        });

        // Filter by search term if provided
        if (searchTerm) {
            bookmarkedItems = bookmarkedItems.filter(item =>
                item.title.toLowerCase().includes(searchTerm) ||
                (item.course && item.course.toLowerCase().includes(searchTerm)) ||
                (item.semester && item.semester.toLowerCase().includes(searchTerm))
            );
        }

        // Sort by year descending
        bookmarkedItems.sort((a, b) => b.year - a.year);

        const bookmarksToRender = bookmarkedItems.slice(startIndex, endIndex);

        if (!bookmarksToRender.length) {
            if (currentPageBookmarks === 1) {
                showEmptyState('bookmarksList', 'No bookmarked items yet. Bookmark items from PYQs or Syllabus tabs to see them here.');
            }
            document.getElementById('loadMoreBookmarksBtn').style.display = 'none';
            return;
        }

        if (currentPageBookmarks === 1) {
            document.getElementById('bookmarksList').innerHTML = '';
        }

        document.getElementById('bookmarksList').insertAdjacentHTML('beforeend', bookmarksToRender.map((item, index) => {
            if (item.type === 'pyq') {
                return `
                    <li class="pyq-item" style="animation-delay: ${0.1 + (startIndex + index) * 0.05}s">
                        <div class="pyq-info">
                            <div class="pdf-icon">
                                <i class="fas fa-file-pdf"></i>
                            </div>
                            <div class="pyq-details">
                                <h5 class="pyq-title">${item.title}</h5>
                                <div class="pyq-actions">
                                    <button class="btn btn-action btn-preview" onclick="previewPDF('${item.file}', '${item.title.replace(/'/g, "\\'")}')">
                                        <i class="fas fa-eye"></i> View
                                    </button>
                                    <button class="btn btn-action btn-share" onclick="shareDocument('${item.file}', '${item.title.replace(/'/g, "\\'")}')">
                                        <i class="fas fa-share-alt"></i> Share
                                    </button>
                                    <button class="btn btn-action btn-bookmark bookmarked" onclick="toggleBookmark('pyqs', '${item.file}')">
                                        <i class="fas fa-bookmark"></i> Bookmarked
                                    </button>
                                </div>
                            </div>
                        </div>
                    </li>
                `;
            } else {
                return `
                    <li class="syllabus-item" style="animation-delay: ${0.1 + (startIndex + index) * 0.05}s">
                        <div class="syllabus-info">
                            <div class="syllabus-icon">
                                <i class="fas fa-book"></i>
                            </div>
                            <div class="syllabus-details">
                                <h5 class="syllabus-title">${item.title}</h5>
                                <div class="syllabus-meta">
                                    <span class="meta-tag course">${item.course || 'General'}</span>
                                    <span class="meta-tag semester">${item.semester || 'All Semesters'}</span>
                                    <span class="meta-tag">${item.year || 'Latest'}</span>
                                </div>
                                <div class="syllabus-actions">
                                    <button class="btn btn-action btn-preview" onclick="previewPDF('${item.file}', '${item.title.replace(/'/g, "\\'")}')">
                                        <i class="fas fa-eye"></i> View
                                    </button>
                                    <button class="btn btn-action btn-share" onclick="shareDocument('${item.file}', '${item.title.replace(/'/g, "\\'")}')">
                                        <i class="fas fa-share-alt"></i> Share
                                    </button>
                                    <button class="btn btn-action btn-bookmark bookmarked" onclick="toggleBookmark('syllabus', '${item.file}')">
                                        <i class="fas fa-bookmark"></i> Bookmarked
                                    </button>
                                </div>
                            </div>
                        </div>
                    </li>
                `;
            }
        }).join(''));

        // Show or hide Load More button
        const loadMoreBookmarksBtn = document.getElementById('loadMoreBookmarksBtn');
        if (endIndex < bookmarkedItems.length) {
            loadMoreBookmarksBtn.style.display = 'inline-block';
        } else {
            loadMoreBookmarksBtn.style.display = 'none';
        }
    }

    function showEmptyState(containerId, message) {
        document.getElementById(containerId).innerHTML = `
            <div class="empty-state">
                <i class="fas fa-search"></i>
                <p>${message}</p>
            </div>
        `;
    }

    // Bookmark functions
    function loadBookmarks() {
        const savedBookmarks = localStorage.getItem('dsmnruBookmarks');
        if (savedBookmarks) {
            bookmarks = JSON.parse(savedBookmarks);
        }
    }

    function saveBookmarks() {
        localStorage.setItem('dsmnruBookmarks', JSON.stringify(bookmarks));
    }

    function toggleBookmark(type, filePath) {
        const index = bookmarks[type].indexOf(filePath);
        if (index > -1) {
            bookmarks[type].splice(index, 1);
        } else {
            bookmarks[type].push(filePath);
        }
        saveBookmarks();
        // Update all bookmark buttons in the DOM without re-rendering
        document.querySelectorAll('.btn-bookmark').forEach(button => {
            const onclick = button.getAttribute('onclick');
            const match = onclick.match(/toggleBookmark\('([^']+)', '([^']+)'\)/);
            if (match) {
                const btnType = match[1];
                const btnFilePath = match[2];
                const isBookmarkedNow = isBookmarked(btnType, btnFilePath);
                button.classList.toggle('bookmarked', isBookmarkedNow);
                button.innerHTML = `<i class="fas fa-bookmark"></i> ${isBookmarkedNow ? 'Bookmarked' : 'Bookmark'}`;
            }
        });
        // Refresh bookmarks tab if it's currently active
        const activeTab = document.querySelector('.nav-link.active');
        if (activeTab && activeTab.getAttribute('data-bs-target') === '#nav-bookmarks') {
            currentPageBookmarks = 1;
            renderBookmarks();
        }
    }

    // Make toggleBookmark globally accessible for onclick handlers
    window.toggleBookmark = toggleBookmark;

    function isBookmarked(type, filePath) {
        return bookmarks[type].includes(filePath);
    }

    function setupEventListeners() {
        // Search functionality
        const searchInput = document.getElementById('searchInput');
        searchInput.addEventListener('input', performSearch);



        // Load More button for PYQs
        document.getElementById('loadMoreBtn').addEventListener('click', function() {
            currentPage++;
            renderPYQs();
        });

        // Load More button for Syllabus
        document.getElementById('loadMoreSyllabusBtn').addEventListener('click', function() {
            currentPageSyllabus++;
            renderSyllabus();
        });

        // Load More button for Bookmarks
        document.getElementById('loadMoreBookmarksBtn').addEventListener('click', function() {
            currentPageBookmarks++;
            renderBookmarks();
        });

        // Copy link button
        copyLinkBtn.addEventListener('click', function() {
            shareLink.select();
            document.execCommand('copy');

            const originalText = copyLinkBtn.innerHTML;
            copyLinkBtn.innerHTML = '<i class="fas fa-check"></i> Copied!';
            setTimeout(() => {
                copyLinkBtn.innerHTML = originalText;
            }, 2000);
        });

        // Tab switching
        document.querySelectorAll('[data-bs-toggle="tab"]').forEach(tab => {
            tab.addEventListener('shown.bs.tab', function(event) {
                const targetTab = event.target.getAttribute('data-bs-target');
                // Clear search when switching tabs
                document.getElementById('searchInput').value = '';
                performSearch();
                // Render bookmarks when bookmarks tab is shown
                if (targetTab === '#nav-bookmarks') {
                    currentPageBookmarks = 1;
                    renderBookmarks();
                }
            });
        });
    }

    // Search function
    window.performSearch = function() {
        const searchTerm = document.getElementById('searchInput').value.toLowerCase();
        const activeTab = document.querySelector('.nav-link.active').getAttribute('data-bs-target');

        if (activeTab === '#nav-pyq') {
            const filtered = allData.pyqs.filter(pyq =>
                pyq.title.toLowerCase().includes(searchTerm)
            );
            filteredPyqs = filtered;
            currentPage = 1;
            renderPYQs();
        } else if (activeTab === '#nav-syllabus') {
            const filtered = allData.syllabus.filter(syllabus =>
                syllabus.title.toLowerCase().includes(searchTerm) ||
                (syllabus.course && syllabus.course.toLowerCase().includes(searchTerm)) ||
                (syllabus.semester && syllabus.semester.toLowerCase().includes(searchTerm))
            );
            filteredSyllabus = filtered;
            currentPageSyllabus = 1;
            renderSyllabus();
        } else if (activeTab === '#nav-bookmarks') {
            // For bookmarks, we need to filter the bookmarked items
            // Since bookmarks are stored as file paths, we need to filter the actual items
            currentPageBookmarks = 1;
            renderBookmarks(searchTerm);
        }
    };



    // PDF view function
    window.previewPDF = function(filePath, title) {
        window.open(filePath, '_blank');
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
            <div class="loading">
                <div class="spinner-border" role="status">
                    <span class="visually-hidden">Loading...</span>
                </div>
                <p class="mt-2">Loading content...</p>
            </div>
        `;
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

/* ============= File Upload Handler ============= */
document.addEventListener('DOMContentLoaded', function() {
    const uploadForm = document.getElementById('uploadForm');
    const uploadStatus = document.getElementById('uploadStatus');
    const submitBtn = document.getElementById('submitBtn');

    if (uploadForm) {
        uploadForm.addEventListener('submit', async function(e) {
            e.preventDefault();

            const fileInput = document.getElementById('uploadFile');
            const titleInput = document.getElementById('uploadTitle');
            const courseInput = document.getElementById('uploadCourse');
            const semesterInput = document.getElementById('uploadSemester');
            const descriptionInput = document.getElementById('uploadDescription');
            const emailInput = document.getElementById('uploaderEmail');

            if (!fileInput.files[0]) {
                showUploadStatus('Please select a file', 'error');
                return;
            }

            const file = fileInput.files[0];
            const fileSize = file.size / (1024 * 1024); // Convert to MB

            // Validation
            if (fileSize > 20) {
                showUploadStatus('File size exceeds 20MB limit', 'error');
                return;
            }

            const allowedTypes = ['application/pdf', 'image/jpeg', 'image/png', 'image/jpg'];
            if (!allowedTypes.includes(file.type)) {
                showUploadStatus('Invalid file type. Only PDF and images are allowed.', 'error');
                return;
            }

            if (!titleInput.value.trim()) {
                showUploadStatus('Title is required', 'error');
                return;
            }

            // Prepare form data
            const formData = new FormData();
            formData.append('file', file);
            formData.append('title', titleInput.value.trim());
            formData.append('course', courseInput.value.trim());
            formData.append('semester', semesterInput.value.trim());
            formData.append('description', descriptionInput.value.trim());
            formData.append('email', emailInput.value.trim());

            // Show loading state
            submitBtn.disabled = true;
            submitBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Uploading...';
            uploadStatus.style.display = 'none';

            try {
                const response = await fetch('/.netlify/functions/upload', {
                    method: 'POST',
                    body: formData
                });

                const result = await response.json();

                if (response.ok && result.success) {
                    showUploadStatus(
                        `✅ ${result.message}`,
                        'success'
                    );
                    uploadForm.reset();
                    
                    // Reset button
                    setTimeout(() => {
                        submitBtn.disabled = false;
                        submitBtn.innerHTML = '<i class="fas fa-upload"></i> Upload File';
                    }, 3000);
                } else {
                    showUploadStatus(
                        `❌ ${result.error || 'Upload failed. Please try again.'}`,
                        'error'
                    );
                    submitBtn.disabled = false;
                    submitBtn.innerHTML = '<i class="fas fa-upload"></i> Upload File';
                }
            } catch (error) {
                console.error('Upload error:', error);
                showUploadStatus(
                    '❌ Network error. Please check your connection and try again.',
                    'error'
                );
                submitBtn.disabled = false;
                submitBtn.innerHTML = '<i class="fas fa-upload"></i> Upload File';
            }
        });
    }

    function showUploadStatus(message, type) {
        const uploadStatus = document.getElementById('uploadStatus');
        uploadStatus.className = `alert alert-${type === 'error' ? 'danger' : 'success'} mt-3`;
        uploadStatus.innerHTML = message;
        uploadStatus.style.display = 'block';
        
        // Auto-hide success message after 5 seconds
        if (type === 'success') {
            setTimeout(() => {
                uploadStatus.style.display = 'none';
            }, 5000);
        }
    }
});

