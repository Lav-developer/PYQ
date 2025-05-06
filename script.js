document.addEventListener('DOMContentLoaded', function() {
  // Initialize modals
  const pdfModal = new bootstrap.Modal(document.getElementById('pdfModal'));
  const shareModal = new bootstrap.Modal(document.getElementById('shareModal'));
  const pdfViewer = document.getElementById('pdfViewer');
  const downloadBtn = document.getElementById('downloadBtn');
  const shareLink = document.getElementById('shareLink');
  const copyLinkBtn = document.getElementById('copyLinkBtn');
  const pyqList = document.getElementById('pyqList');

  // Load PYQs from JSON and render them
  fetch('data.json')
      .then(response => response.json())
      .then(data => {
        const decompressed = PYQStorageOptimizer.decompressData(data);
        renderPYQs(decompressed.pyqs);
        setupEventListeners();
      })
      .catch(error => console.error('Error loading PYQs:', error));

  function renderPYQs(pyqs) {
      pyqList.innerHTML = pyqs.map(pyq => `
          <li>
              <div class="pyq-item">
                  <div class="pyq-info">
                      <i class="fas fa-file-pdf pdf-icon"></i>
                      <div class="pyq-details">
                          <h3 class="pyq-title">${pyq.title}</h3>
                          <div class="pyq-actions">
                              <button class="btn-action btn-preview" data-pdf="${pyq.file}">
                                  <i class="fas fa-eye"></i> <span>Preview</span>
                              </button>
                              <a href="${pyq.file}" class="btn-action btn-download" download>
                                  <i class="fas fa-download"></i> <span>Download</span>
                              </a>
                              <button class="btn-action btn-share" data-title="${pyq.title}" data-link="${pyq.file}">
                                  <i class="fas fa-share-alt"></i> <span>Share</span>
                              </button>
                          </div>
                      </div>
                  </div>
              </div>
          </li>
      `).join('');
  }

  function setupEventListeners() {
      // Preview button functionality
      document.querySelectorAll('.btn-preview').forEach(btn => {
          btn.addEventListener('click', function() {
              const pdfUrl = this.getAttribute('data-pdf');
              pdfViewer.src = pdfUrl;
              downloadBtn.href = pdfUrl;
              document.getElementById('pdfModalTitle').textContent = this.closest('.pyq-item').querySelector('.pyq-title').textContent;
              pdfModal.show();
          });
      });
      
      // Share button functionality
      document.querySelectorAll('.btn-share').forEach(btn => {
          btn.addEventListener('click', function() {
              const title = this.getAttribute('data-title');
              const link = window.location.origin + this.getAttribute('data-link');
              shareLink.value = link;
              
              // Set up share buttons
              document.getElementById('whatsappShare').href = `https://wa.me/?text=${encodeURIComponent(title + ': ' + link)}`;
              document.getElementById('telegramShare').href = `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(title)}`;
              document.getElementById('gmailShare').href = `mailto:?subject=${encodeURIComponent(title)}&body=${encodeURIComponent(link)}`;
              
              shareModal.show();
          });
      });
      
      // Search functionality
      const searchInput = document.querySelector('.search-box input');
      const searchButton = document.querySelector('.search-box button');
      
      function filterPYQs() {
          const searchTerm = searchInput.value.toLowerCase();
          const items = document.querySelectorAll('.pyq-list li');
          
          items.forEach(item => {
              const text = item.textContent.toLowerCase();
              item.style.display = text.includes(searchTerm) ? 'block' : 'none';
          });
          // In script.js - Enhance existing search
function filterPYQs() {
    const searchTerm = searchInput.value.toLowerCase();
    document.querySelectorAll('.pyq-title').forEach(title => {
      const text = title.textContent;
      const html = text.replace(new RegExp(searchTerm, 'gi'), 
        match => `<mark>${match}</mark>`);
      title.innerHTML = html;
    });
  }
      }
      
      searchButton.addEventListener('click', filterPYQs);
      searchInput.addEventListener('input', filterPYQs);
  }
  
  
  // Copy link button
  copyLinkBtn.addEventListener('click', function() {
      shareLink.select();
      document.execCommand('copy');
      const originalText = this.innerHTML;
      this.innerHTML = '<i class="fas fa-check"></i> Copied!';
      setTimeout(() => {
          this.innerHTML = originalText;
      }, 2000);
  });
});


