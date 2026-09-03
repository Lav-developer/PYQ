/**
 * DSMNRU PYQ Android — Courses tab (root).
 *
 * App-native course grid built from cached, already-fetched data:
 * `/api/courses` (catalog) merged with the `courseCounts` inside the SAME
 * `/api/homepage` payload the Home screen uses — so opening this tab costs
 * at most one light request, usually zero.
 * Tapping a course opens the semester/subject drill-down (course.js).
 */

export default async function renderBrowse(root, ctx) {
  const { ui, api } = ctx;
  ctx.setHeader({ title: 'Courses', brand: false });

  root.innerHTML = `
    <div class="stack">
      <section id="br-all"></section>
      <section id="br-grid"></section>
      <section id="br-trend"></section>
    </div>`;

  // Entry card: plain unfiltered browse (free for anonymous users, page 1 —
  // exactly the website's policy).
  const allHost = root.querySelector('#br-all');
  const allCard = document.createElement('button');
  allCard.className = 'course-card';
  allCard.type = 'button';
  allCard.style.gridColumn = '1 / -1';
  allCard.innerHTML = `
    ${ui.icon('bookOpen')}
    <b>All papers</b>
    <span id="br-all-count">Browse the complete archive, newest first</span>`;
  allCard.addEventListener('click', () => ctx.router.go('course', { course: '' }));
  allHost.appendChild(allCard);

  const gridHost = root.querySelector('#br-grid');
  gridHost.innerHTML = '';
  gridHost.appendChild(ui.sectionHead('Programs', { iconName: 'courses' }));
  const grid = document.createElement('div');
  grid.className = 'quick-grid';
  grid.style.marginTop = '10px';
  grid.innerHTML = ui.skeletonRows(2);
  gridHost.appendChild(grid);

  let catalog = [];
  let counts = {};
  let stale = false;
  try {
    const [coursesRes, homeRes] = await Promise.all([api.courses(), api.homepage()]);
    catalog = Array.isArray(coursesRes.data) ? coursesRes.data : [];
    counts = Object.fromEntries(((homeRes.data || {}).courseCounts || []).map((c) => [c.course, c.count]));
    stale = !!(coursesRes.stale || homeRes.stale);
  } catch (err) {
    grid.innerHTML = '';
    grid.appendChild(ui.stateBlock({
      iconName: 'wifiOff',
      tone: 'error',
      title: 'Course list unavailable',
      text: ctx.state.online ? 'Something went wrong. Please try again.' : 'Offline and nothing cached yet.',
      actionLabel: 'Retry',
      onAction: () => ctx.router.tab('browse'),
    }));
    return;
  }

  // Catalog + any course that actually has papers, deduped, sorted by size.
  const names = [...new Set([...catalog, ...Object.keys(counts)])];
  names.sort((a, b) => (counts[b] || 0) - (counts[a] || 0) || a.localeCompare(b));

  const total = Object.values(counts).reduce((x, y) => x + (Number(y) || 0), 0);
  if (total) {
    root.querySelector('#br-all-count').textContent = `${total} papers across ${names.length} programs`;
  }

  grid.innerHTML = names.map((name) => `
    <button class="course-card" type="button" data-course="${ui.esc(name)}">
      ${ui.icon('chevron')}
      <b>${ui.esc(name)}</b>
      <span>${Number(counts[name]) || 0} paper${(Number(counts[name]) || 0) === 1 ? '' : 's'}</span>
    </button>`).join('');
  if (stale) {
    const note = document.createElement('p');
    note.className = 'server-note';
    note.innerHTML = ui.stalePill('Offline copy of the catalog');
    gridHost.appendChild(note);
  }

  grid.addEventListener('click', (e) => {
    const b = e.target.closest('[data-course]');
    if (!b) return;
    openCourse(b.dataset.course);
  });

  // Trending strip so this tab is useful even before picking a course.
  const trendHost = root.querySelector('#br-trend');
  api.homepage().then((res) => {
    const items = ((res.data || {}).trending || []).slice(0, 4);
    if (!items.length) return;
    trendHost.innerHTML = '';
    trendHost.appendChild(ui.sectionHead('Popular right now', { iconName: 'flame' }));
    const list = document.createElement('div');
    list.style.marginTop = '10px';
    ui.paperList(list, ctx, items);
    trendHost.appendChild(list);
  }).catch(() => {});

  function openCourse(course) {
    // Filtered browsing follows the website gate: verified sign-in required.
    ctx.requireAuth(
      () => ctx.router.go('course', { course }),
      'Course browsing uses the archive filters — sign in (same policy as the website).'
    );
  }

  ctx.setRefresh(() => {
    api.homepage({ force: true });
    api.courses({ force: true }).then(() => ctx.router.tab('browse'));
  });
}
