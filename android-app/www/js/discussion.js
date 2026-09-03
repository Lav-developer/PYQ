/**
 * DSMNRU PYQ Android — paper discussion (logic module).
 *
 * Uses the SAME Firestore `comments` data as the website: top-level
 * `comments` documents { paperId, text, userId, userName, userEmail,
 * createdAt } with a `pyqs/{id}/comments` legacy fallback, exactly like the
 * site's paper page — same collection, same field names, no second database.
 *
 * Read path mirrors the website's resilient chain: the primary ordered query
 * (paperId == …, orderBy createdAt DESC — needs the composite index) falls
 * back ON ERROR OR EMPTY to the unordered query (still fully index-backed
 * through the automatic single-field paperId index; sorted client-side),
 * then to the legacy subcollection. Writes try the top-level collection and
 * fall back to the subcollection, like the website.
 *
 * Failures are CLASSIFIED for humans (network vs permission vs query/data)
 * and logged with technical detail only (Logcat/console). One-time fetches
 * only — no realtime listeners. Views never touch these endpoints.
 */

const FS_BASE = 'https://firestore.googleapis.com/v1/projects/dsmnru-data/databases/(default)/documents';
const KEY = 'AIzaSyBRlsk-knQs-AMlaTFxlneBMTwlSfwyFaQ'; // public client config, same as the website

function fail(kind, message) {
  const e = new Error(message);
  e.kind = kind; // 'network' | 'permission' | 'query' | 'data' | 'write' | 'validation'
  return e;
}

/** Human message for a classified failure — technical detail stays in logs. */
export function discussionErrorMessage(err) {
  if (err && err.kind === 'network') return 'Unable to load discussion. Check your connection and try again.';
  if (err && err.kind === 'permission') return 'Unable to load this discussion right now.';
  return 'Unable to load this discussion. Please try again.';
}

/** Query the website's paper page runs first (requires the composite index). */
function orderedQueryBody(paperId) {
  return {
    structuredQuery: {
      from: [{ collectionId: 'comments' }],
      where: { fieldFilter: { field: { fieldPath: 'paperId' }, op: 'EQUAL', value: { stringValue: String(paperId) } } },
      orderBy: [{ field: { fieldPath: 'createdAt' }, direction: 'DESCENDING' }],
      limit: 30,
    },
  };
}

/** The website's own fallback: equality filter only (automatic single-field
 *  index — NOT a collection scan), newest-first applied client-side. */
function unorderedQueryBody(paperId) {
  return {
    structuredQuery: {
      from: [{ collectionId: 'comments' }],
      where: { fieldFilter: { field: { fieldPath: 'paperId' }, op: 'EQUAL', value: { stringValue: String(paperId) } } },
      limit: 30,
    },
  };
}

/** Legacy subcollection scan — the parent document scopes the paper, so no
 *  paperId filter (legacy rows may not carry the field). */
function subcollectionQueryBody() {
  return { structuredQuery: { from: [{ collectionId: 'comments' }], limit: 30 } };
}

/**
 * Parse one REST document into a view comment. Returns null for anything
 * unusable (missing name/text, unparseable shape) so ONE malformed document
 * can never break the whole list. Tolerates pending/null server timestamps
 * and missing dates on legacy rows.
 */
function docToComment(row) {
  try {
    const doc = row && row.document;
    if (!doc || !doc.fields) return null;
    const f = doc.fields;
    const id = String(doc.name || '').split('/').pop();
    const text = (f.text && f.text.stringValue) || (f.comment && f.comment.stringValue) || '';
    if (!id || !text) return null; // incomplete/legacy row — skip it safely
    const name = (f.userName && f.userName.stringValue)
      || (f.author && f.author.stringValue)
      || ((f.userEmail && f.userEmail.stringValue || '').split('@')[0])
      || 'Anonymous';
    let date = '';
    const rawDate = f.createdAt && (f.createdAt.timestampValue || '');
    if (rawDate) {
      const t = new Date(rawDate).getTime();
      if (Number.isFinite(t)) date = rawDate; // null/pending server timestamps stay dateless
    }
    return { id, name, text, date };
  } catch (err) {
    console.warn('skipping a malformed comment document:', err); // dev log only
    return null;
  }
}

function sortNewestFirst(list) {
  return [...list].sort((a, b) => (b.date ? new Date(b.date).getTime() : 0) - (a.date ? new Date(a.date).getTime() : 0));
}

function dedupeById(list) {
  const seen = new Set();
  return list.filter((c) => (seen.has(c.id) ? false : (seen.add(c.id), true)));
}

/** Execute one runQuery; classify every failure mode for the UI. */
async function executeQuery(parent, body, doFetch) {
  let res;
  try {
    res = await doFetch(`${FS_BASE}${parent}:runQuery?key=${KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw fail('network', 'comments request did not leave the device');
  }
  if (!res.ok) {
    const detail = await res.json().catch(() => null);
    const status = String((detail && detail.error && detail.error.status) || '');
    const msg = String((detail && detail.error && detail.error.message) || '');
    console.warn(`comments query failed: HTTP ${res.status} ${status || msg}`); // Logcat/dev only — never rendered
    const kind = (res.status === 403 || status === 'PERMISSION_DENIED') ? 'permission' : 'query';
    throw fail(kind, msg || status || `HTTP ${res.status}`);
  }
  let rows;
  try {
    rows = await res.json();
  } catch (err) {
    throw fail('data', 'unparsable comments response');
  }
  if (!Array.isArray(rows)) throw fail('data', 'unexpected comments response shape');
  return rows.map(docToComment).filter(Boolean);
}

/**
 * Load the latest comments for a paper (public read — same rule as the
 * website). One-time fetch, no listeners. Resolves a deduplicated,
 * newest-first array (possibly empty); throws CLASSIFIED errors.
 */
export async function loadComments({ paperId }, fetchImpl) {
  const doFetch = fetchImpl || ((...args) => fetch(...args));
  if (!paperId) throw fail('data', 'no paper id resolved for this discussion');
  console.info('discussion: loading comments for paper', paperId); // dev log only — never rendered

  const failures = [];
  let sawSuccess = false;
  let list = [];

  // 1) The website's primary query.
  try {
    list = await executeQuery('', orderedQueryBody(paperId), doFetch);
    sawSuccess = true;
  } catch (err) {
    failures.push(err);
  }

  // 2) On ERROR or EMPTY — the website's unordered fallback (client sort).
  if (!list.length) {
    try {
      list = await executeQuery('', unorderedQueryBody(paperId), doFetch);
      sawSuccess = true;
    } catch (err) {
      failures.push(err);
    }
  }

  // 3) Last resort: the legacy pyqs/{id}/comments subcollection.
  if (!list.length) {
    try {
      list = await executeQuery(`/pyqs/${encodeURIComponent(paperId)}`, subcollectionQueryBody(), doFetch);
      sawSuccess = true;
    } catch (err) {
      failures.push(err);
    }
  }

  // Only fail when EVERY path failed; if any read succeeded, an empty result
  // is the truthful answer (the discussion simply has no comments).
  if (!list.length && !sawSuccess && failures.length) {
    const worst = failures.find((e) => e.kind === 'network')
      || failures.find((e) => e.kind === 'permission')
      || failures[0];
    throw worst;
  }
  return dedupeById(sortNewestFirst(list)).slice(0, 30);
}

/**
 * Post a comment as the signed-in (verified) user — SAME collection and
 * field shape the website writes (rules: text 3..600, userId must match the
 * caller). Tries the top-level collection, then the legacy subcollection
 * (the website's write fallback). Resolves the freshly written comment WITH
 * its real Firestore document id so the UI can dedupe; throws human errors.
 */
export async function postComment({ paperId, text }, user, fetchImpl) {
  const doFetch = fetchImpl || ((...args) => fetch(...args));
  const body = String(text || '').trim();
  if (body.length < 3) throw fail('validation', 'Comment is a little too short.');
  if (body.length > 600) throw fail('validation', 'Please keep comments under 600 characters.');
  if (!user || !user.uid) throw fail('validation', 'Please sign in to join the discussion.');
  if (!paperId) throw fail('validation', 'Open the paper again and try posting once more.');
  const fields = {
    paperId: { stringValue: String(paperId) },
    text: { stringValue: body },
    userId: { stringValue: user.uid },
    userName: { stringValue: user.name || (user.email || 'User').split('@')[0] || 'User' },
    userEmail: { stringValue: user.email || '' },
    createdAt: { timestampValue: new Date().toISOString() },
  };
  const headers = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + user.idToken };

  const attempt = async (parent) => {
    let res;
    try {
      res = await doFetch(`${FS_BASE}${parent}/comments?key=${KEY}`, {
        method: 'POST', headers, body: JSON.stringify({ fields }),
      });
    } catch (err) {
      throw fail('network', 'comment request did not leave the device');
    }
    if (res.status === 403) {
      throw fail('permission', 'Verify your email to join the discussion (same rule as the website).');
    }
    if (!res.ok) {
      const detail = await res.json().catch(() => null);
      const msg = String((detail && detail.error && detail.error.message) || '');
      throw fail('write', msg || `HTTP ${res.status}`);
    }
    const written = await res.json().catch(() => null);
    const comment = written ? docToComment({ document: written }) : null;
    if (!comment) throw fail('data', 'unreadable write response');
    return comment;
  };

  try {
    return await attempt('');
  } catch (err) {
    if (err.kind === 'validation' || err.kind === 'permission') throw err;
    if (err.kind === 'network') {
      throw fail('network', "Couldn't post your comment. Check your connection and try again.");
    }
    console.warn('top-level comment write failed — trying the legacy subcollection:', err); // dev log
  }
  try {
    return await attempt(`/pyqs/${encodeURIComponent(paperId)}`);
  } catch (err) {
    if (err.kind === 'validation' || err.kind === 'permission') throw err;
    if (err.kind === 'network') {
      throw fail('network', "Couldn't post your comment. Check your connection and try again.");
    }
    console.warn('comment write failed:', err); // Logcat/dev only — never rendered
    throw fail('write', "Couldn't post your comment. Please try again.");
  }
}
