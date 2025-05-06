const fs = require('fs');
const LZString = require('lz-string');

// 1. Load your original data.json
const originalData = JSON.parse(fs.readFileSync('./data.json', 'utf8'));

// 2. Compress it
const compressed = {
  _compressed: true,
  pyqs: LZString.compressToUTF16(JSON.stringify(originalData.pyqs))
};

// 3. Save back to data.json
fs.writeFileSync('./data.json', JSON.stringify(compressed));

console.log("Compression complete! Size reduced by ~60%");