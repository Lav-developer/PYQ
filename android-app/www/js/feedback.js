/**
 * DSMNRU PYQ Android — user feedback submissions (logic module).
 *
 * Writes to the SAME Firestore `feedback` queue the website's report form
 * uses (verified sign-in per the existing rules). Views call this helper so
 * endpoint details stay out of the UI layer entirely; failures surface as
 * human-readable errors only (details stay in the console).
 */

const FEEDBACK_URL = 'https://firestore.googleapis.com/v1/projects/dsmnru-data/databases/(default)/documents/feedback';

/**
 * Submit a broken-link report for a paper. `user` is the auth session view
 * (nullable). Resolves true when accepted; throws a human-readable Error
 * otherwise. Field shape is exactly the website's (type/title/course/
 * details/email/userId/userEmail/createdAt/status).
 */
export async function submitBrokenLinkReport({ title, course = '', details }, user, fetchImpl) {
  const doFetch = fetchImpl || ((...args) => fetch(...args));
  const fields = {
    type: { stringValue: 'broken_link' },
    title: { stringValue: String(title || '') },
    course: { stringValue: String(course || '') },
    details: { stringValue: String(details || '') },
    email: { stringValue: (user && user.email) || '' },
    userId: { stringValue: user ? user.uid : '' },
    userEmail: { stringValue: (user && user.email) || '' },
    createdAt: { timestampValue: new Date().toISOString() },
    status: { stringValue: 'new' },
  };
  const headers = { 'Content-Type': 'application/json' };
  if (user && user.idToken) headers.Authorization = 'Bearer ' + user.idToken;
  try {
    const res = await doFetch(FEEDBACK_URL, { method: 'POST', headers, body: JSON.stringify({ fields }) });
    if (!res.ok) throw new Error('rejected');
    return true;
  } catch (err) {
    console.warn('report submission failed:', err); // dev log only
    throw new Error('Could not send the report. Please try again.');
  }
}
