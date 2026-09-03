/**
 * DSMNRU PYQ Android — paper discussion (logic module).
 *
 * Uses the SAME Firestore `comments` data as the website: top-level
 * `comments` documents { paperId, text, userId, userName, userEmail,
 * createdAt } with a `pyqs/{id}/comments` fallback, exactly like the site's
 * paper page. Views never touch these endpoints; failures surface as
 * human-readable errors only (detail stays in console logs).
 */

const FS_BASE = 'https://firestore.googleapis.com/v1/projects/dsmnru-data/databases/(default)/documents';
const KEY = 'AIzaSyBRlsk-knQs-AMlaTFxlneBMTwlSfwyFaQ'; // public client config, same as the website

function runQueryBody({ paperId, order = true }) {
  const q = {
    structuredQuery: {
      from: [{ collectionId: 'comments' }],
      where: { fieldFilter: { field: { fieldPath: 'paperId' }, op: 'EQUAL', value: { stringValue: paperId } } },
      limit: 30,
    },
  };
  if (order) q.structuredQuery.orderBy = [{ field: { fieldPath: 'createdAt' }, direction: 'DESCENDING' }];
  return q;
}

function docToComment(doc) {
  const f = (doc && doc.fields) || {};
  const name = (f.userName && f.userName.stringValue)
    || (f.author && f.author.stringValue)
    || ((f.userEmail && f.userEmail.stringValue || '').split('@')[0])
    || 'Anonymous';
  return {
    id: (doc && doc.name || '').split('/').pop(),
    name,
    text: (f.text && f.text.stringValue) || (f.comment && f.comment.stringValue) || '',
    date: (f.createdAt && f.createdAt.timestampValue) || '',
  };
}

function sortNewestFirst(list) {
  return list.sort((a, b) => (b.date ? new Date(b.date).getTime() : 0) - (a.date ? new Date(a.date).getTime() : 0));
}

/**
 * Load the latest comments for a paper (public read — same rule as the
 * website). Mirrors the site's query order incl. the missing-index
 * fallback (unordered fetch, sorted client-side) and the subcollection
 * fallback. Resolves a (possibly empty) array; throws human errors.
 */
export async function loadComments({ paperId }, fetchImpl) {
  const doFetch = fetchImpl || ((...args) => fetch(...args));
  const tryQuery = async (body, parent = '') => {
    const res = await doFetch(`${FS_BASE}${parent}:runQuery?key=${KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error('query failed');
    const rows = await res.json().catch(() => []);
    return (Array.isArray(rows) ? rows : [])
      .filter((r) => r && r.document && r.document.fields)
      .map(docToComment);
  };
  try {
    let list = await tryQuery(runQueryBody({ paperId }));
    if (!list.length) list = await tryQuery(runQueryBody({ paperId, order: false }));
    if (!list.length) {
      list = await tryQuery(runQueryBody({ paperId, order: false }), `/pyqs/${encodeURIComponent(paperId)}`);
    }
    return sortNewestFirst(list).slice(0, 30);
  } catch (err) {
    console.warn('comments load failed:', err); // dev log only — never rendered
    throw new Error("Couldn't load the discussion. Check your connection and try again.");
  }
}

/**
 * Post a comment as the signed-in (verified) user — same collection, same
 * field shape the website writes (rules: text 3..600, userId must match the
 * caller). Resolves the freshly written comment so the UI can show it
 * immediately; throws human errors.
 */
export async function postComment({ paperId, text }, user, fetchImpl) {
  const doFetch = fetchImpl || ((...args) => fetch(...args));
  const body = String(text || '').trim();
  if (body.length < 3) throw new Error('Comment is a little too short.');
  if (body.length > 600) throw new Error('Please keep comments under 600 characters.');
  if (!user || !user.uid) throw new Error('Please sign in to join the discussion.');
  const fields = {
    paperId: { stringValue: String(paperId) },
    text: { stringValue: body },
    userId: { stringValue: user.uid },
    userName: { stringValue: user.name || (user.email || 'User').split('@')[0] || 'User' },
    userEmail: { stringValue: user.email || '' },
    createdAt: { timestampValue: new Date().toISOString() },
  };
  const headers = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + user.idToken };
  try {
    const res = await doFetch(`${FS_BASE}/comments?key=${KEY}`, {
      method: 'POST', headers, body: JSON.stringify({ fields }),
    });
    if (res.status === 403) {
      throw new Error('Verify your email to join the discussion (same rule as the website).');
    }
    if (!res.ok) throw new Error('write failed');
    const written = await res.json().catch(() => null);
    return docToComment(written);
  } catch (err) {
    if (String(err && err.message).startsWith('Verify') || String(err && err.message).startsWith('Comment')
        || String(err && err.message).startsWith('Please')) throw err;
    console.warn('comment post failed:', err); // dev log only
    throw new Error("Couldn't post your comment. Please try again.");
  }
}
