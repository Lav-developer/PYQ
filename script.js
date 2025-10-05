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
            description: 'A comprehensive tool to calculate your Cumulative Grade Point Average (CGPA) and Semester Grade Point Average (SGPA).',
            features: [
                'Calculate CGPA for multiple semesters',
                'Track individual semester performance',
                'Support for different grading systems',
                'Export results and maintain history',
                'Mobile-responsive design',
                'Secure and privacy-focused'
            ],
            benefits: [
                'Monitor your academic progress',
                'Plan future semester targets',
                'Prepare for scholarship applications',
                'Track improvement over time'
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
                            <i class="fas fa-calculator me-2"></i>${info.title}
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
                            <strong>Pro Tip:</strong> Use this calculator regularly to stay on top of your academic performance and set realistic goals for upcoming semesters.
                        </div>
                    </div>
                    <div class="modal-footer">
                        <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Close</button>
                        <a href="https://cgpa-calc.streamlit.app/" target="_blank" class="btn btn-primary">
                            <i class="fas fa-external-link-alt me-2"></i>Use Calculator
                        </a>
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
    const modal = new bootstrap.Modal(document.getElementById('toolInfoModal'));
    modal.show();
}

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
