// Use the exact same definition as the static site's classic scripts.
import '../../document-types.js';
export const { values: DOCUMENT_TYPES, validate: validateDocumentType,
  read: readDocumentType, label: documentTypeLabel } = globalThis.DSMNRUDocumentTypes;
