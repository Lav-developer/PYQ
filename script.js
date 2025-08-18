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

    // Function to extract year from title
    function extractYearFromTitle(title) {
        const yearMatch = title.match(/\{(\d{4})/);
        return yearMatch ? parseInt(yearMatch[1]) : 0;
    }

    // Load data from JSON and render them
    fetch('data.json')
        .then(response => response.json())
        .then(data => {
            // Handle both old format (only pyqs) and new format (pyqs + syllabus)
            allData.pyqs = data.pyqs || [];
            allData.syllabus = data.syllabus || [];
            
            // Add year to each PYQ and sort by year in descending order
            const processedPYQs = allData.pyqs.map(pyq => ({
                ...pyq,
                year: extractYearFromTitle(pyq.title)
            })).sort((a, b) => b.year - a.year);
            
            // Process syllabus data
            const processedSyllabus = allData.syllabus.map(syllabus => ({
                ...syllabus,
                year: extractYearFromTitle(syllabus.title)
            })).sort((a, b) => b.year - a.year);
            
            allData.pyqs = processedPYQs;
            allData.syllabus = processedSyllabus;
            
            filteredPyqs = [...processedPYQs];
            filteredSyllabus = [...processedSyllabus];
            
            renderPYQs(filteredPyqs);
            renderSyllabus(filteredSyllabus);
            setupEventListeners();
        })
        .catch(error => {
            console.error('Error loading data:', error);
            showEmptyState('pyqList', 'Error loading question papers');
            showEmptyState('syllabusList', 'Error loading syllabus');
        });

    function renderPYQs(pyqs) {
        if (!pyqs.length) {
            showEmptyState('pyqList', 'No question papers found matching your criteria');
            return;
        }

        pyqList.innerHTML = pyqs.map((pyq, index) => `
            <li class="pyq-item" style="animation-delay: ${0.1 + index * 0.05}s">
                <div class="pyq-info">
                    <div class="pdf-icon">
                        <i class="fas fa-file-pdf"></i>
                    </div>
                    <div class="pyq-details">
                        <h5 class="pyq-title">${pyq.title}</h5>
                        <div class="pyq-actions">
                            <button class="btn btn-action btn-preview" onclick="previewPDF('${pyq.file}', '${pyq.title.replace(/'/g, "\\'")}')">
                                <i class="fas fa-eye"></i> Preview
                            </button>
                            <a href="${pyq.file}" class="btn btn-action btn-download" download>
                                <i class="fas fa-download"></i> Download
                            </a>
                            <button class="btn btn-action btn-share" onclick="shareDocument('${pyq.file}', '${pyq.title.replace(/'/g, "\\'")}')">
                                <i class="fas fa-share-alt"></i> Share
                            </button>
                        </div>
                    </div>
                </div>
            </li>
        `).join('');
    }

    function renderSyllabus(syllabusItems) {
        if (!syllabusItems.length) {
            showEmptyState('syllabusList', 'No syllabus found matching your criteria');
            return;
        }

        syllabusList.innerHTML = syllabusItems.map((syllabus, index) => `
            <li class="syllabus-item" style="animation-delay: ${0.1 + index * 0.05}s">
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
                                <i class="fas fa-eye"></i> Preview
                            </button>
                            <a href="${syllabus.file}" class="btn btn-action btn-download" download>
                                <i class="fas fa-download"></i> Download
                            </a>
                            <button class="btn btn-action btn-share" onclick="shareDocument('${syllabus.file}', '${syllabus.title.replace(/'/g, "\\'")}')">
                                <i class="fas fa-share-alt"></i> Share
                            </button>
                        </div>
                    </div>
                </div>
            </li>
        `).join('');
    }

    function showEmptyState(containerId, message) {
        document.getElementById(containerId).innerHTML = `
            <div class="empty-state">
                <i class="fas fa-search"></i>
                <p>${message}</p>
            </div>
        `;
    }

    function setupEventListeners() {
        // Search functionality
        const searchInput = document.getElementById('searchInput');
        searchInput.addEventListener('input', performSearch);

        // PYQ Filter listeners
        document.getElementById('pyqCourseFilter').addEventListener('change', filterPYQs);
        document.getElementById('pyqYearFilter').addEventListener('change', filterPYQs);

        // Syllabus Filter listeners
        document.getElementById('syllabusCourseFilter').addEventListener('change', filterSyllabus);
        document.getElementById('syllabusSemesterFilter').addEventListener('change', filterSyllabus);

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
                // Clear search when switching tabs
                document.getElementById('searchInput').value = '';
                performSearch();
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
            filterPYQs(); // Apply additional filters
        } else if (activeTab === '#nav-syllabus') {
            const filtered = allData.syllabus.filter(syllabus =>
                syllabus.title.toLowerCase().includes(searchTerm) ||
                (syllabus.course && syllabus.course.toLowerCase().includes(searchTerm)) ||
                (syllabus.semester && syllabus.semester.toLowerCase().includes(searchTerm))
            );
            filteredSyllabus = filtered;
            filterSyllabus(); // Apply additional filters
        }
    };

    // Filter functions
    function filterPYQs() {
        const courseFilter = document.getElementById('pyqCourseFilter').value;
        const yearFilter = document.getElementById('pyqYearFilter').value;
        
        let filtered = [...filteredPyqs];
        
        if (courseFilter) {
            filtered = filtered.filter(pyq => pyq.title.includes(courseFilter));
        }
        
        if (yearFilter) {
            filtered = filtered.filter(pyq => pyq.title.includes(yearFilter));
        }
        
        renderPYQs(filtered);
    }

    function filterSyllabus() {
        const courseFilter = document.getElementById('syllabusCourseFilter').value;
        const semesterFilter = document.getElementById('syllabusSemesterFilter').value;
        
        let filtered = [...filteredSyllabus];
        
        if (courseFilter) {
            filtered = filtered.filter(syllabus => 
                syllabus.course && syllabus.course.includes(courseFilter)
            );
        }
        
        if (semesterFilter) {
            filtered = filtered.filter(syllabus => 
                syllabus.semester && syllabus.semester.includes(semesterFilter)
            );
        }
        
        renderSyllabus(filtered);
    }

    // Clear filter functions
    window.clearPyqFilters = function() {
        document.getElementById('pyqCourseFilter').value = '';
        document.getElementById('pyqYearFilter').value = '';
        filteredPyqs = [...allData.pyqs];
        filterPYQs();
    };

    window.clearSyllabusFilters = function() {
        document.getElementById('syllabusCourseFilter').value = '';
        document.getElementById('syllabusSemesterFilter').value = '';
        filteredSyllabus = [...allData.syllabus];
        filterSyllabus();
    };

    // PDF preview function
    window.previewPDF = function(filePath, title) {
        pdfViewer.src = filePath;
        downloadBtn.href = filePath;
        downloadBtn.download = title;
        document.getElementById('pdfModalLabel').textContent = title;
        pdfModal.show();
    };

    // Share function
    window.shareDocument = function(filePath, title) {
        const currentUrl = window.location.origin + window.location.pathname;
        const shareUrl = `${currentUrl}#${encodeURIComponent(filePath)}`;
        
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

// Add event listeners for tool tracking when DOM is loaded
document.addEventListener('DOMContentLoaded', function() {
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

});