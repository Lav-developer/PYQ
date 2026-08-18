/**
 * Firestore REST API client for Cloudflare Workers.
 *
 * Robustness notes:
 *  - Pagination cursors are composite: [primaryFieldValue, __name__]. The
 *    `__name__` tiebreaker is mandatory for correctness when the primary
 *    orderBy field is non-unique (e.g. `views`, `createdAt` for duplicate
 *    timestamps). Real Firestore orders by the listed fields lex-ascending
 *    for `startAt`, so a missing tiebreaker would skip or duplicate rows.
 *  - Cursor values preserve their original Firestore type by extracting from
 *    the raw REST `fields` map (not the unwrapped plain object). This is
 *    important for timestamps: a `timestampValue` cursor must round-trip
 *    back as `{timestampValue: ...}`, never as `{stringValue: ...}`.
 */
import { getAccessToken, clearTokenCache } from './auth.js';

const FIRESTORE_BASE = 'https://firestore.googleapis.com/v1';

// ── Field extraction helpers ──────────────────────────────────────

/**
 * Extract a plain JS value from a Firestore `fields` map.
 * Returns the unwrapped primitive (string, number, boolean, ISO timestamp
 * string, etc.). Use `extractRawFieldValue` if you need the original type.
 */
export function extractFieldValue(fields, fieldPath) {
  if (!fields || !fieldPath) return null;
  const value = fields[fieldPath];
  if (!value) return null;
  if ('stringValue' in value) return value.stringValue;
  if ('integerValue' in value) return parseInt(value.integerValue, 10);
  if ('doubleValue' in value) return parseFloat(value.doubleValue);
  if ('booleanValue' in value) return value.booleanValue;
  if ('timestampValue' in value) return value.timestampValue;
  if ('nullValue' in value) return null;
  return null;
}

/**
 * Extract the RAW Firestore Value object (preserves type info needed to
 * build a valid `startAt.values` cursor). Returns null if missing.
 */
export function extractRawFieldValue(fields, fieldPath) {
  if (!fields || !fieldPath) return null;
  const value = fields[fieldPath];
  return value && typeof value === 'object' ? value : null;
}

/**
 * Convert a Firestore REST document into a plain JS object, preserving the
 * document name (for cursor use) via a hidden `_firestoreName` field.
 */
export function documentToObject(doc) {
  if (!doc || !doc.name) return null;
  const nameParts = doc.name.split('/');
  const docId = nameParts[nameParts.length - 1];
  const fields = doc.fields || {};
  const obj = {
    id: docId,
    _firestoreName: doc.name,
  };

  for (const [key, value] of Object.entries(fields)) {
    if ('stringValue' in value) {
      obj[key] = value.stringValue;
    } else if ('integerValue' in value) {
      const num = parseInt(value.integerValue, 10);
      obj[key] = Number.isFinite(num) ? num : null;
    } else if ('doubleValue' in value) {
      obj[key] = parseFloat(value.doubleValue);
    } else if ('booleanValue' in value) {
      obj[key] = value.booleanValue;
    } else if ('timestampValue' in value) {
      obj[key] = value.timestampValue;
    } else if ('nullValue' in value) {
      obj[key] = null;
    } else if ('arrayValue' in value) {
      obj[key] = (value.arrayValue.values || []).map((v) => {
        if ('stringValue' in v) return v.stringValue;
        if ('integerValue' in v) return parseInt(v.integerValue, 10);
        if ('booleanValue' in v) return v.booleanValue;
        return null;
      });
    } else if ('mapValue' in value) {
      const inner = value.mapValue.fields || {};
      const innerObj = {};
      for (const [k, v] of Object.entries(inner)) {
        if ('stringValue' in v) innerObj[k] = v.stringValue;
        else if ('integerValue' in v) innerObj[k] = parseInt(v.integerValue, 10);
        else if ('booleanValue' in v) innerObj[k] = v.booleanValue;
        else if ('timestampValue' in v) innerObj[k] = v.timestampValue;
        else innerObj[k] = null;
      }
      obj[key] = innerObj;
    } else {
      obj[key] = null;
    }
  }

  return obj;
}

/**
 * Convert a plain JS value to a Firestore REST `Value` object.
 * Detects ISO-8601 timestamps so an extracted `timestampValue` string
 * round-trips back as `timestampValue` (not `stringValue`) when used as
 * a cursor value.
 */
function toFieldValue(value) {
  if (value === null || value === undefined) return { nullValue: null };
  if (typeof value === 'boolean') return { booleanValue: value };
  if (typeof value === 'number') {
    if (Number.isInteger(value)) return { integerValue: String(value) };
    return { doubleValue: value };
  }
  if (typeof value === 'string') {
    // Firestore REST returns timestamps as ISO-8601 UTC strings.
    // Detect and re-emit as timestampValue for correct cursor typing.
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(value)) {
      return { timestampValue: value };
    }
    return { stringValue: value };
  }
  if (Array.isArray(value)) {
    return { arrayValue: { values: value.map(toFieldValue) } };
  }
  return { stringValue: String(value) };
}

/**
 * Convert a raw Firestore REST `Value` object to a `Value` suitable for
 * `startAt.values`. Used for cursors where we already have the raw value.
 */
function rawToFieldValue(rawValue) {
  if (!rawValue || typeof rawValue !== 'object') return { nullValue: null };
  return rawValue;
}

// ── Structured query construction ─────────────────────────────────

function buildFilterClause({ field, op, value }) {
  if (op === 'IN') {
    return {
      fieldFilter: {
        field: { fieldPath: field },
        op: 'IN',
        value: { arrayValue: { values: value.map((v) => toFieldValue(v)) } },
      },
    };
  }
  return {
    fieldFilter: {
      field: { fieldPath: field },
      op: op || 'EQUAL',
      value: toFieldValue(value),
    },
  };
}

/**
 * Build a structured query. If `tiebreakerField` is set and the caller
 * supplies `startAtRaw`, an extra `orderBy` is appended and the startAt
 * values are extended with the tiebreaker value. This guarantees stable
 * pagination across pages even when the primary orderBy field has
 * duplicated values.
 */
function buildStructuredQuery({
  from,
  where = [],
  orderBy = [],
  limit = 20,
  select = null,
  startAt = null,
  startAtRaw = null,
  tiebreakerField = null,
}) {
  const query = { from: [{ collectionId: from }] };

  if (where.length === 1) {
    query.where = buildFilterClause(where[0]);
  } else if (where.length > 1) {
    query.where = {
      compositeFilter: {
        op: 'AND',
        filters: where.map((w) => buildFilterClause(w)),
      },
    };
  }

  if (orderBy.length > 0) {
    query.orderBy = orderBy.map((o) => ({
      field: { fieldPath: o.field },
      direction: o.direction || 'ASCENDING',
    }));
  }
  if (tiebreakerField) {
    // Always add the tiebreaker with the same direction as the first
    // orderBy (or ASCENDING if none). `__name__` is the document path.
    const dir = orderBy.length > 0 ? (orderBy[0].direction || 'ASCENDING') : 'ASCENDING';
    query.orderBy = query.orderBy || [];
    query.orderBy.push({
      field: { fieldPath: tiebreakerField },
      direction: dir,
    });
  }

  if (limit) {
    query.limit = limit;
  }

  if (select && select.length > 0) {
    query.select = { fields: select.map((f) => ({ fieldPath: f })) };
  }

  if (startAtRaw && startAtRaw.length > 0) {
    query.startAt = {
      values: startAtRaw.map(rawToFieldValue),
      before: true,
    };
  } else if (startAt && startAt.length > 0) {
    query.startAt = {
      values: startAt.map((v) => toFieldValue(v)),
      before: true,
    };
  }

  return query;
}

function getProjectId() {
  if (typeof FIREBASE_PROJECT_ID !== 'undefined' && FIREBASE_PROJECT_ID) {
    return FIREBASE_PROJECT_ID;
  }
  try {
    const sa = JSON.parse(FIREBASE_SERVICE_ACCOUNT_JSON);
    if (sa.project_id) return sa.project_id;
  } catch {}
  throw new Error('FIREBASE_PROJECT_ID is not configured');
}

// ── Public API ─────────────────────────────────────────────────────

/**
 * Execute a structured query against Firestore. Returns both converted
 * plain documents AND the raw REST document objects (for cursor building).
 */
export async function runQuery(collectionId, options = {}) {
  const {
    where = [],
    orderBy = [],
    limit = 20,
    select = null,
    startAt = null,
    startAtRaw = null,
    tiebreakerField = '__name__',
  } = options;

  const token = await getAccessToken();
  const projectId = getProjectId();
  const structuredQuery = buildStructuredQuery({
    from: collectionId,
    where,
    orderBy,
    limit,
    select,
    startAt,
    startAtRaw,
    tiebreakerField,
  });

  const url = `${FIRESTORE_BASE}/projects/${projectId}/databases/(default)/documents:runQuery`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ structuredQuery }),
  });

  if (!response.ok) {
    if (response.status === 401) {
      clearTokenCache();
      throw new Error(`Firestore auth error: ${response.status}`);
    }
    const errText = await response.text();
    throw new Error(`Firestore query failed: ${response.status} ${errText}`);
  }

  const data = await response.json();
  const documents = [];
  const rawDocuments = [];
  for (const item of data) {
    if (item.document) {
      const obj = documentToObject(item.document);
      if (obj) {
        documents.push(obj);
        rawDocuments.push(item.document);
      }
    }
  }

  return { documents, rawDocuments };
}

export async function getDocument(collectionId, docId) {
  const token = await getAccessToken();
  const projectId = getProjectId();

  const url = `${FIRESTORE_BASE}/projects/${projectId}/databases/(default)/documents/${collectionId}/${docId}`;

  const response = await fetch(url, {
    headers: { 'Authorization': `Bearer ${token}` },
  });

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    if (response.status === 401) {
      clearTokenCache();
      throw new Error(`Firestore auth error: ${response.status}`);
    }
    const errText = await response.text();
    throw new Error(`Firestore get failed: ${response.status} ${errText}`);
  }

  const doc = await response.json();
  return documentToObject(doc);
}

/**
 * Fetch ALL documents from a collection using cursor pagination with a
 * composite cursor (primary orderBy field + `__name__` tiebreaker).
 * Uses the raw REST `fields` to build the cursor so types are preserved
 * (important for timestamp ordering).
 *
 * Returns plain converted documents (without the `_firestoreName` field
 * since callers don't need it).
 */
export async function getAllDocuments(collectionId, options = {}) {
  const {
    orderBy = [],
    select = null,
    pageSize = 300,
    maxPages = 100,
    tiebreakerField = '__name__',
  } = options;
  let allDocs = [];
  let lastOrderByRawValues = null;
  let lastDocName = null;
  let page = 0;

  while (page < maxPages) {
    const result = await runQuery(collectionId, {
      orderBy,
      limit: pageSize,
      select,
      startAtRaw: lastOrderByRawValues
        ? [...lastOrderByRawValues, { stringValue: lastDocName }]
        : null,
      tiebreakerField,
    });

    if (result.documents.length === 0) {
      break;
    }

    allDocs = allDocs.concat(result.documents);

    if (result.documents.length < pageSize) {
      break;
    }

    // Build the next cursor from the LAST document in this page.
    // Use the RAW REST fields to preserve types (timestamp stays timestamp).
    const lastRawDoc = result.rawDocuments[result.rawDocuments.length - 1];
    const lastRawFields = lastRawDoc.fields || {};
    const lastObj = result.documents[result.documents.length - 1];

    if (orderBy.length > 0 && lastRawDoc) {
      const rawValues = orderBy.map((o) => {
        const raw = extractRawFieldValue(lastRawFields, o.field);
        if (raw) return raw;
        // Fallback to id if field is missing
        return { stringValue: lastObj.id };
      });
      lastOrderByRawValues = rawValues;
      lastDocName = lastRawDoc.name;
    } else {
      // No orderBy — can't build a meaningful cursor
      break;
    }

    page += 1;
  }

  return allDocs.map((d) => {
    delete d._firestoreName;
    return d;
  });
}

export async function setDocument(collectionId, docId, data) {
  const token = await getAccessToken();
  const projectId = getProjectId();

  const fields = {};
  for (const [key, value] of Object.entries(data)) {
    if (key === 'id') continue;
    fields[key] = toFieldValue(value);
  }

  const url = `${FIRESTORE_BASE}/projects/${projectId}/databases/(default)/documents/${collectionId}/${docId}?updateMask.fieldPaths=*`;

  const response = await fetch(url, {
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ fields }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Firestore write failed: ${response.status} ${errText}`);
  }

  const doc = await response.json();
  return documentToObject(doc);
}
