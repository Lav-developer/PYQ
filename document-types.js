/* Shared by classic browser scripts and the Worker. No Firebase dependency. */
(function (root) {
    'use strict';
    const labels = Object.freeze({
        pyq: 'PYQ', form: 'Form', scholarship: 'Scholarship',
        notice: 'Notice', syllabus: 'Syllabus', other: 'Other'
    });
    const values = Object.freeze(Object.keys(labels));
    // Missing/empty legacy fields are PYQs. Unknown stored values are displayed
    // as Other; writes and filter parameters must use the strict validator.
    function normalize(value) {
        const type = String(value == null ? '' : value).trim().toLowerCase();
        return type || 'pyq';
    }
    function validate(value) {
        const type = normalize(value);
        if (!values.includes(type)) throw new Error('Invalid document type: ' + type);
        return type;
    }
    function read(value) {
        const type = normalize(value);
        return values.includes(type) ? type : 'other';
    }
    root.DSMNRUDocumentTypes = Object.freeze({ values, labels, validate, read,
        label: value => labels[read(value)] });
})(globalThis);
