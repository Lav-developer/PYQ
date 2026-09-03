/**
 * DSMNRU PYQ Android — local device persistence (saved papers, recent views,
 * recent searches, small prefs).
 *
 * Deliberately tiny and 100% on-device: no Firestore collection, no second
 * database, no sync — exactly as the product spec requires. The saved list
 * stores the compact index item (id/title/course/semester/session/branch/slug)
 * so the Saved tab renders offline with zero API traffic; opening a saved
 * paper still refreshes its full detail through the normal (cached) Worker path.
 *
 * DOM-free: accepts any localStorage-compatible `storage` (null in tests).
 */

const KEY_SAVED = 'dsm.saved.v1';
const KEY_RECENT = 'dsm.recentViews.v1';
const KEY_QUERIES = 'dsm.recentQueries.v1';
const MAX_SAVED = 300;
const MAX_RECENT = 12;
const MAX_QUERIES = 10;

function readList(storage, key) {
  if (!storage) return [];
  try {
    const raw = storage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeList(storage, key, list) {
  if (!storage) return;
  try {
    storage.setItem(key, JSON.stringify(list));
  } catch { /* quota — feature degrades quietly, UI keeps session state */ }
}

function compactPaper(item) {
  if (!item || !item.id) return null;
  return {
    id: String(item.id),
    title: String(item.title || ''),
    course: String(item.course || ''),
    semester: String(item.semester || ''),
    session: String(item.session || ''),
    branch: String(item.branch || ''),
    subject: String(item.subject || ''),
    year: item.year || '',
    views: Number.isFinite(Number(item.views)) ? Number(item.views) : 0,
    slug: String(item.slug || ''),
  };
}

export function createStore({ storage = null } = {}) {
  const listeners = new Set();

  function emit() {
    for (const fn of listeners) {
      try { fn(); } catch { /* one bad listener must not break the loop */ }
    }
  }

  // ---------------- saved / favorites ----------------
  function savedList() {
    return readList(storage, KEY_SAVED);
  }

  function isSaved(id) {
    if (!id) return false;
    return savedList().some((x) => x && x.id === id);
  }

  function savePaper(item) {
    const paper = compactPaper(item);
    if (!paper) return false;
    const list = savedList().filter((x) => x && x.id !== paper.id);
    list.unshift({ ...paper, savedAt: Date.now() });
    writeList(storage, KEY_SAVED, list.slice(0, MAX_SAVED));
    emit();
    return true;
  }

  function unsavePaper(id) {
    const list = savedList().filter((x) => x && x.id !== id);
    if (list.length === savedList().length) return false;
    writeList(storage, KEY_SAVED, list);
    emit();
    return true;
  }

  function toggleSaved(item) {
    if (isSaved(item && item.id)) {
      unsavePaper(item.id);
      return false;
    }
    savePaper(item);
    return true;
  }

  function clearSaved() {
    writeList(storage, KEY_SAVED, []);
    emit();
  }

  function savedSearch(term) {
    const list = savedList();
    const q = String(term || '').trim().toLowerCase();
    if (!q) return list;
    return list.filter((x) => {
      const hay = [x.title, x.course, x.semester, x.session, x.branch, x.subject].join(' ').toLowerCase();
      return hay.includes(q);
    });
  }

  // ---------------- recently viewed ----------------
  function recentViews() {
    return readList(storage, KEY_RECENT);
  }

  function pushRecentView(item) {
    const paper = compactPaper(item);
    if (!paper) return;
    const list = recentViews().filter((x) => x && x.id !== paper.id);
    list.unshift({ ...paper, viewedAt: Date.now() });
    writeList(storage, KEY_RECENT, list.slice(0, MAX_RECENT));
    emit();
  }

  // ---------------- recent search queries ----------------
  function recentQueries() {
    return readList(storage, KEY_QUERIES);
  }

  function pushRecentQuery(text) {
    const q = String(text || '').trim();
    if (q.length < 2) return;
    const list = recentQueries().filter((x) => x !== q);
    list.unshift(q);
    writeList(storage, KEY_QUERIES, list.slice(0, MAX_QUERIES));
  }

  function clearRecentQueries() {
    writeList(storage, KEY_QUERIES, []);
    emit();
  }

  return {
    savedList, isSaved, savePaper, unsavePaper, toggleSaved, clearSaved, savedSearch,
    recentViews, pushRecentView,
    recentQueries, pushRecentQuery, clearRecentQueries,
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  };
}
