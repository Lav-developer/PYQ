/**
 * DSMNRU PYQ Android — course drill-down (Courses → semester/session/subject
 * search → papers). Backed by the two existing paginated Worker endpoints:
 *
 *   GET /api/pyqs?course&semester&session&page&limit&sort      (plain browsing)
 *   GET /api/pyqs/search?course&q&semester&session&...          (subject search)
 *
 * Nothing is fetched "per card": one request per visible page, cached briefly,
 * stale search responses aborted. Semester/session chips use exactly the
 * values the Worker's validators accept, so filters never silently mismatch.
 */

const SEMESTERS = ['1st', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th'];
const SESSIONS = ['2026-27', '2025-26', '2024-25', '2023-24', '2022-23', '2021-22', '2020-21', '2019-20'];
const SORTS = [['newest', 'Newest'], ['popular', 'Popular'], ['az', 'A→Z'], ['za', 'Z→A'], ['oldest', 'Oldest']];
const PAGE_SIZE = 20;

export default async function renderCourse(root, ctx, params = {}) {
  const { ui, api, auth } = ctx;
  const course = String(params.course || '');
  ctx.setHeader({
    title: course || 'All papers',
    brand: false,
    sub: course ? 'papers by semester & session' : 'the complete archive',
  });

  const s = {
    q: '', semester: '', session: '', sort: 'newest',
    items: [], total: 0, page: 1, totalPages: 0,
    loading: true, error: '', stale: false,
  };

  root.innerHTML = `
    <div class="stack">
      ${course ? `
      <div class="search-wrap">
        <div class="search-input-shell" id="cq-shell">
          ${ui.icon('search')}
          <input id="cq" type="search" placeholder="Search within ${ui.esc(course)}…" autocomplete="off" enterkeyhint="search">
        </div>
      </div>` : ''}
      <div class="chip-row" id="sem-row"></div>
      <div class="chip-row" id="sess-row" style="display:none"></div>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap" id="course-meta"></div>
      <div id="course-list"></div>
      <div id="course-pager" class="center" style="padding:4px 0 10px"></div>
    </div>`;

  const listEl = root.querySelector('#course-list');
  const pagerEl = root.querySelector('#course-pager');
  const metaEl = root.querySelector('#course-meta');
  const sessRow = root.querySelector('#sess-row');

  root.querySelector('#sem-row').appendChild(ui.chipRow(
    [{ value: '', label: 'All sems' }].concat(SEMESTERS.map((x) => ({ value: x, label: x + ' sem' }))),
    { active: '', onPick: (v) => { s.semester = s.semester === v ? '' : v; refreshChips(); load(1); } },
  ));
  sessRow.appendChild(ui.chipRow(
    [{ value: '', label: 'All sessions' }].concat(SESSIONS.map((x) => ({ value: x, label: x }))),
    { active: '', onPick: (v) => { s.session = s.session === v ? '' : v; refreshChips(); load(1); } },
  ));

  let expanded = false;
  function refreshChips() {
    if (s.semester || s.session || expanded) sessRow.style.display = '';
    ui.updateChipRow(root.querySelector('#sem-row'), s.semester);
    ui.updateChipRow(root.querySelector('#sess-row'), s.session);
    renderMeta();
  }

  function renderMeta() {
    metaEl.innerHTML = '';
    const count = document.createElement('span');
    count.className = 'results-count';
    count.innerHTML = s.loading ? 'loading…' : `<b>${s.total}</b> paper${s.total === 1 ? '' : 's'}${s.q ? ' matching “' + ui.esc(s.q) + '”' : ''}`;
    metaEl.appendChild(count);
    if (s.stale) { const p = document.createElement('span'); p.innerHTML = ui.stalePill(); metaEl.appendChild(p); }
    const more = document.createElement('button');
    more.className = 'link-btn';
    more.type = 'button';
    more.textContent = expanded ? 'Fewer filters' : 'Session / sort';
    more.addEventListener('click', () => {
      expanded = !expanded;
      sessRow.style.display = expanded || s.semester || s.session ? '' : 'none';
      sortRowHost.style.display = expanded ? '' : 'none';
    });
    metaEl.appendChild(more);
  }

  const sortRowHost = document.createElement('div');
  sortRowHost.className = 'chip-row';
  sortRowHost.style.display = 'none';
  sortRowHost.appendChild(ui.chipRow(SORTS.map(([value, label]) => ({ value, label })), {
    active: s.sort,
    onPick: (v) => { s.sort = v; ui.updateChipRow(sortRowHost, s.sort); load(1); },
  }));
  metaEl.parentElement.insertBefore(sortRowHost, listEl);

  if (course) {
    let timer = null;
    const input = root.querySelector('#cq');
    input.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        s.q = input.value.trim();
        load(1);
      }, 350);
    });
  }

  let controller = null;
  let gen = 0;
  async function load(page) {
    const myGen = ++gen;
    if (controller) controller.abort();
    controller = new AbortController();
    s.loading = true;
    s.error = '';
    render();
    try {
      const args = { course, semester: s.semester, session: s.session, sort: s.sort, page, limit: PAGE_SIZE };
      let res;
      if (s.q) {
        if (s.q.length < 2) { s.loading = false; render(); return; }
        res = await api.search({ ...args, q: s.q }, { signal: controller.signal });
      } else {
        res = await api.list(args, { signal: controller.signal });
      }
      if (myGen !== gen) return;
      const data = res.data || {};
      s.total = data.total || 0;
      s.page = data.page || page;
      s.totalPages = data.totalPages || 0;
      s.stale = !!res.stale;
      s.items = page === 1 ? (data.items || []) : [...s.items, ...(data.items || [])];
    } catch (err) {
      if (err && err.name === 'AbortError') return;
      if (myGen !== gen) return;
      s.error = err.message || 'Could not reach the archive';
    } finally {
      if (myGen === gen) { s.loading = false; render(); }
    }
  }

  function render() {
    renderMeta();
    if (s.loading && !s.items.length) { listEl.innerHTML = ui.skeletonRows(4); pagerEl.innerHTML = ''; return; }
    if (s.error && !s.items.length) {
      listEl.innerHTML = '';
      listEl.appendChild(ui.stateBlock({
        iconName: 'wifiOff', tone: 'error',
        title: 'Couldn\'t load papers',
        text: ctx.state.online ? s.error : 'Offline and nothing cached for this course yet.',
        actionLabel: 'Retry', onAction: () => load(1),
      }));
      pagerEl.innerHTML = '';
      return;
    }
    if (!s.items.length) {
      listEl.innerHTML = '';
      listEl.appendChild(ui.stateBlock({
        iconName: 'bookOpen',
        title: s.q ? 'No papers match here' : 'No papers listed yet',
        text: s.q ? 'Try fewer words or clear the search within this course.' : 'This semester/session combination has no archive copies yet. Try “All sems”.',
        actionLabel: s.q || s.semester || s.session ? 'Reset filters' : '',
        onAction: () => {
          s.q = ''; s.semester = ''; s.session = '';
          const input = root.querySelector('#cq');
          if (input) input.value = '';
          refreshChips();
          load(1);
        },
      }));
      pagerEl.innerHTML = '';
      return;
    }
    ui.paperList(listEl, ctx, s.items, { showSaved: true });
    if (s.page < s.totalPages) {
      pagerEl.innerHTML = `<button class="btn btn--ghost" id="course-more" type="button">${ui.icon('download')} Load more</button>`;
      pagerEl.querySelector('#course-more').addEventListener('click', () => {
        // Website policy: page 2+ requires a verified account.
        if (!auth.canUnlockPrivileges()) {
          ctx.requireAuth(() => load(s.page + 1), 'Continuing past the first page needs a verified sign-in.');
          return;
        }
        load(s.page + 1);
      });
    } else {
      pagerEl.innerHTML = s.total > PAGE_SIZE ? `<p class="server-note">End of results — ${s.total} papers</p>` : '';
    }
  }

  load(1);
  ctx.setRefresh(() => load(1));
}
