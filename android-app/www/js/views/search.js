/**
 * DSMNRU PYQ Android — dedicated search screen.
 *
 * Rules implemented here (mirroring the production site + Worker API):
 *  - Server-side search only: GET /api/pyqs/search (title/subject/course/
 *    semester/session/year). The archive is NEVER downloaded to the client.
 *  - 350 ms debounce; every new query aborts the previous request via
 *    AbortController so a stale response can never overwrite a fresh one.
 *  - Minimum 2 characters (Worker validation).
 *  - Pagination via page/limit (20) — “Load more” only fetches the next page.
 *  - Anonymous visitors see the free first page of plain browsing; typed
 *    queries, filters and page 2+ require a verified sign-in — the exact gate
 *    policy of the website, shown as a friendly sheet instead of a hard stop.
 *  - Distinct empty / loading / error / offline states everywhere.
 */

const SESSIONS = ['2026-27', '2025-26', '2024-25', '2023-24', '2022-23', '2021-22', '2020-21', '2019-20'];
const SEMESTERS = ['1st', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th'];
const SORTS = [
  ['newest', 'Newest first'],
  ['popular', 'Most viewed'],
  ['az', 'Title A → Z'],
  ['za', 'Title Z → A'],
  ['oldest', 'Oldest first'],
];
const DEBOUNCE_MS = 350;
const PAGE_SIZE = 20;

export default async function renderSearch(root, ctx, params = {}) {
  const { ui, api, store } = ctx;
  ctx.setHeader({ title: 'Search the archive', brand: false });

  const s = {
    q: (params.q || '').trim(),
    course: '',
    semester: '',
    session: '',
    sort: 'newest',
    items: [],
    total: 0,
    page: 1,
    totalPages: 0,
    mode: s0(),
    stale: false,
    error: '',
    loading: false,
    hasFilters: () => !!(s.q || s.course || s.semester || s.session),
  };
  function s0() { return params.q ? 'results' : 'idle'; }

  root.innerHTML = `
    <div class="stack">
      <div class="search-wrap">
        <div class="search-input-shell" id="sq-shell">
          ${ui.icon('search')}
          <input id="sq" type="search" placeholder="Subject, course, year, session…" autocomplete="off" spellcheck="false" enterkeyhint="search">
          <button class="clr" id="sq-clear" type="button" aria-label="Clear">${ui.icon('x')}</button>
        </div>
        <button class="icon-btn" id="btn-filter" type="button" aria-label="Filters" style="border:1px solid var(--line-strong);border-radius:14px">${ui.icon('filter')}</button>
      </div>
      <div class="chip-row" id="sort-row" style="display:none"></div>
      <div id="results-meta" class="search-meta" hidden></div>
      <div id="results"></div>
      <div id="pager" class="center" style="padding:4px 0 10px"></div>
    </div>`;

  const input = root.querySelector('#sq');
  const shell = root.querySelector('#sq-shell');
  const resultsEl = root.querySelector('#results');
  const pagerEl = root.querySelector('#pager');
  const metaEl = root.querySelector('#results-meta');
  const sortRow = root.querySelector('#sort-row');
  input.value = s.q;
  shell.classList.toggle('has-text', !!s.q);

  // Courses for the filter sheet (cached catalog — no per-card fetches).
  let courseNames = [];
  api.courses().then((r) => { courseNames = Array.isArray(r.data) ? r.data : []; }).catch(() => {});

  // ── stateless renderers ──────────────────────────────────────────────
  function renderSortRow() {
    const active = s.sort;
    sortRow.style.display = s.mode === 'results' ? '' : 'none';
    sortRow.innerHTML = '';
    const row = ui.chipRow(SORTS.map(([value, label]) => ({ value, label })), {
      active,
      onPick: (v) => { s.sort = v; run(true); },
    });
    sortRow.appendChild(row);
  }

  function renderMeta() {
    if (s.mode !== 'results') { metaEl.hidden = true; return; }
    metaEl.hidden = false;
    const parts = [];
    parts.push(`<span class="results-count"><b>${s.total}</b> paper${s.total === 1 ? '' : 's'}</span>`);
    const chips = [];
    if (s.course) chips.push(`<button class="chip is-active" data-rm="course">${ui.esc(s.course)} ${ui.icon('x')}</button>`);
    if (s.semester) chips.push(`<button class="chip is-active" data-rm="semester">${ui.esc(s.semester)} sem ${ui.icon('x')}</button>`);
    if (s.session) chips.push(`<button class="chip is-active" data-rm="session">${ui.esc(s.session)} ${ui.icon('x')}</button>`);
    if (s.stale) parts.push(ui.stalePill());
    metaEl.innerHTML = `<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">${parts.join('')}${chips.length ? '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-left:auto">' + chips.join('') + '</div>' : ''}</div>`;
    metaEl.querySelectorAll('[data-rm]').forEach((b) => {
      b.addEventListener('click', () => {
        s[b.dataset.rm] = '';
        run(true);
      });
    });
  }

  function renderResults() {
    if (s.loading) {
      resultsEl.innerHTML = ui.skeletonRows(4);
      pagerEl.innerHTML = '';
      return;
    }
    if (s.error) {
      resultsEl.innerHTML = '';
      resultsEl.appendChild(ui.stateBlock({
        iconName: 'alert',
        tone: 'error',
        title: 'Search failed',
        text: s.error,
        actionLabel: 'Retry',
        onAction: () => run(true),
      }));
      pagerEl.innerHTML = '';
      return;
    }
    if (s.mode === 'idle') {
      renderIdle();
      pagerEl.innerHTML = '';
      return;
    }
    if (!s.items.length) {
      resultsEl.innerHTML = '';
      resultsEl.appendChild(ui.stateBlock({
        iconName: s.hasFilters() ? 'search' : 'bookOpen',
        title: 'No papers matched',
        text: s.hasFilters()
          ? 'Try clearing a filter or searching fewer words — the archive keeps every paper on the server, so this reflects reality, not a download problem.'
          : 'The archive is empty right now.',
        actionLabel: 'Clear everything',
        onAction: () => {
          s.q = ''; s.course = ''; s.semester = ''; s.session = '';
          input.value = '';
          shell.classList.remove('has-text');
          run(true);
        },
      }));
      pagerEl.innerHTML = '';
      return;
    }
    ui.paperList(resultsEl, ctx, s.items, { showSaved: true });
    renderPager();
  }

  function renderPager() {
    if (s.page < s.totalPages) {
      pagerEl.innerHTML = `<button class="btn btn--ghost" id="load-more" type="button">${ui.icon('download')} Load ${Math.min(PAGE_SIZE, s.total - s.items.length)} more</button>`;
      pagerEl.querySelector('#load-more').addEventListener('click', () => loadMore());
    } else if (s.total > PAGE_SIZE) {
      pagerEl.innerHTML = `<p class="server-note">End of results — ${s.total} papers</p>`;
    } else pagerEl.innerHTML = '';
  }

  function renderIdle() {
    resultsEl.innerHTML = '';
    const queries = store.recentQueries();
    const recent = store.recentViews();
    const box = document.createElement('div');
    box.className = 'stack';
    if (queries.length) {
      box.appendChild(ui.sectionHead('Recent searches', { iconName: 'clock' }));
      const row = ui.chipRow(queries.map((q) => ({ value: q, label: q })), {
        active: '',
        onPick: (v) => { s.q = v; input.value = v; shell.classList.add('has-text'); run(true); },
      });
      box.appendChild(row);
    }
    if (recent.length) {
      box.appendChild(ui.sectionHead('You recently opened', { iconName: 'eye' }));
      const list = document.createElement('div');
      ui.paperList(list, ctx, recent);
      box.appendChild(list);
    }
    if (!queries.length && !recent.length) {
      const hint = ui.stateBlock({
        iconName: 'search',
        title: 'Search the whole archive',
        text: 'Type a subject, course, semester or session — e.g. “data structures”, “B.Tech”, “2023-24”. Everything runs through the same server search the website uses.',
      });
      box.appendChild(hint);
    }
    resultsEl.appendChild(box);
  }

  // ── fetching ─────────────────────────────────────────────────────────
  let controller = null;
  let debounceTimer = null;
  let gen = 0;

  async function fetchPage(page, replace, force = false) {
    const myGen = ++gen;
    if (controller) controller.abort();
    controller = new AbortController();
    s.loading = true;
    s.error = '';
    s.mode = 'results';
    renderResults();
    renderSortRow();
    try {
      const args = {
        q: s.q, course: s.course, semester: s.semester, session: s.session,
        sort: s.sort, page, limit: PAGE_SIZE,
      };
      const res = await api.search(args, { signal: controller.signal, force });
      if (myGen !== gen) return; // a newer query superseded this one
      const data = res.data || {};
      s.total = data.total || 0;
      s.page = data.page || page;
      s.totalPages = data.totalPages || 0;
      s.stale = !!res.stale;
      s.items = replace ? (data.items || []) : [...s.items, ...(data.items || [])];
    } catch (err) {
      if (err && err.name === 'AbortError') return;
      if (myGen !== gen) return;
      console.warn('search failed:', err); // detail in the log, never in the UI
      s.error = 'Something went wrong. Please try again.';
    } finally {
      if (myGen === gen) {
        s.loading = false;
        renderResults();
        renderMeta();
        renderSortRow();
      }
    }
  }

  function run(replace = true, force = false) {
    if (replace) { s.items = []; s.page = 1; }
    const privileged = auth().canUnlockPrivileges();
    if (!privileged && s.hasFilters()) {
      // Website gate: a typed query or any filter requires a verified session.
      s.mode = 'idle';
      s.loading = false;
      renderIdleLike();
      gateOnce();
      return;
    }
    if (!s.hasFilters()) {
      // Unfiltered = the free browse page 1 (server-side pagination).
      s.page = 1;
      fetchBrowse();
      renderMeta();
      return;
    }
    fetchPage(1, true, force);
  }

  let browseCache = null;
  async function fetchBrowse() {
    if (browseCache && browseCache.sort === s.sort) {
      s.items = browseCache.items; s.total = browseCache.total;
      s.page = 1; s.totalPages = browseCache.totalPages;
      renderResults(); renderMeta(); renderSortRow();
      return;
    }
    const myGen = ++gen;
    if (controller) controller.abort();
    controller = new AbortController();
    s.loading = true;
    renderResults();
    try {
      const res = await api.list({ page: 1, limit: PAGE_SIZE, sort: s.sort }, { signal: controller.signal });
      if (myGen !== gen) return;
      const data = res.data || {};
      browseCache = { sort: s.sort, items: data.items || [], total: data.total || 0, totalPages: data.totalPages || 0 };
      s.items = browseCache.items;
      s.total = browseCache.total;
      s.totalPages = browseCache.totalPages;
      s.stale = !!res.stale;
      s.mode = 'results';
    } catch (err) {
      if (err && err.name === 'AbortError') return;
      if (myGen !== gen) return;
      console.warn('search failed:', err);
      s.error = "Couldn't load results. Check your connection and try again.";
      s.mode = 'results';
      s.items = [];
    } finally {
      if (myGen === gen) {
        s.loading = false;
        renderResults();
        renderMeta();
        renderSortRow();
      }
    }
  }

  function renderIdleLike() {
    resultsEl.innerHTML = '';
    pagerEl.innerHTML = '';
    metaEl.hidden = true;
    renderIdle();
  }

  let gateShownFor = null;
  function gateOnce() {
    const key = JSON.stringify([s.q, s.course, s.semester, s.session]);
    if (gateShownFor === key) return; // don't nag on every keystroke
    gateShownFor = key;
    ctx.requireAuth(() => run(true), 'Search runs on the same login policy as the DSMNRU website — verified accounts unlock server search.');
  }

  async function loadMore() {
    if (!auth().canUnlockPrivileges()) {
      ctx.requireAuth(() => loadMore(), 'The second page of results needs a verified sign-in (website rule).');
      return;
    }
    await fetchPage(s.page + 1, false);
  }

  function auth() { return ctx.auth; }

  // ── input wiring ─────────────────────────────────────────────────────
  input.addEventListener('input', () => {
    const v = input.value;
    shell.classList.toggle('has-text', !!v);
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      const trimmed = v.trim();
      if (trimmed === s.q) return;
      s.q = trimmed;
      if (trimmed.length >= 2) store.pushRecentQuery(trimmed);
      run(true);
    }, DEBOUNCE_MS);
  });
  root.querySelector('#sq-clear').addEventListener('click', () => {
    input.value = '';
    shell.classList.remove('has-text');
    s.q = '';
    run(true);
    input.focus();
  });

  // Filter sheet (course / semester / session) — same params the API supports.
  root.querySelector('#btn-filter').addEventListener('click', () => {
    const node = document.createElement('div');
    node.innerHTML = `
      <div class="field"><label>Course</label><div class="chip-row" data-group="course"></div></div>
      <div class="field"><label>Semester</label><div class="chip-row" data-group="semester"></div></div>
      <div class="field"><label>Session</label><div class="chip-row" data-group="session"></div></div>
      <div class="sheet-actions">
        <button class="btn btn--ghost" data-f="clear" type="button">Clear</button>
        <button class="btn btn--primary" data-f="apply" type="button">Apply</button>
      </div>`;
    const draft = { course: s.course, semester: s.semester, session: s.session };
    function group(name, chips, value) {
      const host = node.querySelector(`[data-group="${name}"]`);
      host.innerHTML = '';
      host.appendChild(ui.chipRow(chips, {
        active: draft[name],
        onPick: (v) => {
          draft[name] = draft[name] === v ? '' : v;
          ui.updateChipRow(host, draft[name]);
        },
      }));
      void value;
    }
    group('course', [{ value: '', label: 'All courses' }].concat(courseNames.map((c) => ({ value: c, label: c }))), s.course);
    group('semester', [{ value: '', label: 'All semesters' }].concat(SEMESTERS.map((x) => ({ value: x, label: x }))), s.semester);
    group('session', [{ value: '', label: 'All sessions' }].concat(SESSIONS.map((x) => ({ value: x, label: x }))), s.session);

    const sh = ui.sheet({ title: 'Filters', subtitle: 'Same facets as the Worker search API', content: node });
    node.querySelector('[data-f="clear"]').addEventListener('click', () => {
      draft.course = ''; draft.semester = ''; draft.session = '';
      s.course = ''; s.semester = ''; s.session = '';
      sh.close();
      run(true);
    });
    node.querySelector('[data-f="apply"]').addEventListener('click', () => {
      s.course = draft.course; s.semester = draft.semester; s.session = draft.session;
      sh.close();
      gateShownFor = null;
      run(true);
    });
  });

  // Initial state
  renderSortRow();
  if (params.q) run(true);
  else { renderIdle(); renderMeta(); }

  ctx.setRefresh(() => {
    browseCache = null;
    run(true, true);
  });
}
