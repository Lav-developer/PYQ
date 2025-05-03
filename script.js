
  document.addEventListener('DOMContentLoaded', function() {
    const searchInput = document.querySelector('.search-box input');
    const searchButton = document.querySelector('.search-box button');
    const pyqItems = document.querySelectorAll('.pyq-list li');

    function filterPYQs() {
      const searchTerm = searchInput.value.toLowerCase();
      
      pyqItems.forEach(item => {
        const text = item.textContent.toLowerCase();
        if (text.includes(searchTerm)) {
          item.style.display = 'block';
        } else {
          item.style.display = 'none';
        }
      });
    }

    // Search when button is clicked
    searchButton.addEventListener('click', filterPYQs);
    
    // Search as you type (optional)
    searchInput.addEventListener('input', filterPYQs);
});