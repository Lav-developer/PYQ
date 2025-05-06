// storage-optimizer.js
class PYQStorageOptimizer {
    // Compress JSON data before saving
    static compressData(data) {
      const compressed = {
        _compressed: true, // Flag to indicate compressed data
        pyqs: LZString.compressToUTF16(JSON.stringify(data.pyqs))
      };
      return compressed;
    }
  
    // Decompress JSON data when loading
    static decompressData(compressedData) {
      if (!compressedData._compressed) return compressedData;
      
      return {
        pyqs: JSON.parse(LZString.decompressFromUTF16(compressedData.pyqs))
      };
    }
  }