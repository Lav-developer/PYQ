/**
 * Firestore REST API client for Cloudflare Workers.
 */
import { getAccessToken, clearTokenCache } from './auth.js';

const FIRESTORE_BASE = 'https://firestore.googleapis.com/v1';

function extractFieldValue(fields, fieldPath) {
  if (!fields || !fieldPath) return null;
  const value = fields[fieldPath];
  if (!value) return null;
  if ('stringValue' in value) return value.stringValue;
  if ('integerValue' in value) return parseInt(value.integerValue, 10);
  if ('doubleValue' in value) return parseFloat(value.doubleValue);
  if ('booleanValue' in value) return value.booleanValue;
  if ('timestampValue' in value) return value.timestampValue;
  return null;
}

export function documentToObject(doc) {
  if (!doc || !doc.name) return null;
  const nameParts = doc.name.split('/');
  const docId = nameParts[nameParts.length - 1];
  const fields = doc.fields || {};
  const obj = { id: docId };

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

function toFieldValue(value) {
  if (value === null || value === undefined) return { nullValue: null };
  if (typeof value === 'string') return { stringValue: value };
  if (typeof value === 'number') {
    if (Number.isInteger(value)) return { integerValue: String(value) };
    return { doubleValue: value };
  }
  if (typeof value === 'boolean') return { booleanValue: value };
  if (Array.isArray(value)) {
    return { arrayValue: { values: value.map(toFieldValue) } };
  }
  return { stringValue: String(value) };
}

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

function buildStructuredQuery({ from, where = [], orderBy = [], limit = 20, select = null, startAt = null }) {
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

  if (limit) {
    query.limit = limit;
  }

  if (select && select.length > 0) {
    query.select = { fields: select.map((f) => ({ fieldPath: f })) };
  }

  if (startAt && startAt.length > 0) {
    query.startAt = {
      values: startAt.map((v) => toFieldValue(v)),
      before: false,
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

export async function runQuery(collectionId, options = {}) {
  const {
    where = [],
    orderBy = [],
    limit = 20,
    select = null,
    startAt = null,
  } = options;

  const token = await getAccessToken();
  const projectId = getProjectId();
  const structuredQuery = buildStructuredQuery({ from: collectionId, where, orderBy, limit, select, startAt });

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
  for (const item of data) {
    if (item.document) {
      const obj = documentToObject(item.document);
      if (obj) documents.push(obj);
    }
  }

  return { documents };
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

export async function getAllDocuments(collectionId, options = {}) {
  const { orderBy = [], select = null } = options;
  let allDocs = [];
  let startAt = null;
  let page = 0;

  while (page < 50) {
    const result = await runQuery(collectionId, {
      orderBy,
      limit: 300,
      select,
      startAt,
    });

    if (result.documents.length === 0) {
      break;
    }

    allDocs = allDocs.concat(result.documents);

    if (result.documents.length < 300) {
      break;
    }

    // Build the next cursor from the last document's orderBy values.
    // `documents` are plain objects (already converted), so read the
    // field directly from the object.
    const lastDoc = result.documents[result.documents.length - 1];
    if (orderBy.length > 0 && lastDoc) {
      const cursor = orderBy.map((o) => {
        const val = lastDoc[o.field];
        return val !== null && val !== undefined ? val : lastDoc.id;
      });
      startAt = cursor;
    } else {
      // Fallback: no orderBy — break to avoid infinite loop
      break;
    }

    page += 1;
  }

  return allDocs;
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

export { extractFieldValue };
