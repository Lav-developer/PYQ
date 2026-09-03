/**
 * DSMNRU PYQ Android — Home screen.
 *
 * Built from ONE Worker request (`GET /api/homepage`) served through the
 * app's cached client (instant re-render from cache, background revalidate,
 * offline fallback). Nothing here reuses website markup: greeting hero,
 * search launcher, stat pills, quick courses, continue-reading (device
 * history), recent/trending rails and shortcuts are app-native sections.
 */

export default async function renderHome(root, ctx) {
  const { ui, api, store } = ctx;

  ctx.setHeader({ title: 'DSMNRU PYQ', brand: true });

  root.innerHTML = `
    <div class="stack">
      <section class="hero">
        <div class="hero-top">
          <div class="hero-emblem" aria-hidden="true"></div>
          <div class="grow">
            <div class="hero-kicker" id="home-greet">Bharatpur University archive</div>
            <div class="hero-title">Find any <em>PYQ</em> in seconds</div>
          </div>
        </div>
        <button class="search-launch" id="home-search" type="button">
          ${ui.icon('search')}<span>Search papers, subjects, sessions…</span>
        </button>
        <div class="stat-pills" id="home-stats"></div>
      </section>

      <section id="home-continue" class="hidden"></section>

      <section id="home-courses"></section>

      <section id="home-recent"></section>

      <section id="home-trending"></section>

      <section id="home-shortcuts"></section>
    </div>`;

  root.querySelector('#home-search').addEventListener('click', () => ctx.router.tab('search'));

  const hour = new Date().getHours();
  const greet = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  root.querySelector('#home-greet').textContent = `${greet} — ${new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'short' })}`;

  // One request for everything below (cached + SWR; 0 network on re-entry).
  let res;
  try {
    res = await api.homepage();
  } catch (err) {
    root.querySelector('#home-stats').innerHTML = '';
    const box = document.createElement('div');
    box.appendChild(ui.stateBlock({
      iconName: 'wifiOff',
      tone: 'error',
      title: 'Couldn\'t load the archive overview',
      text: ctx.state.online ? (err.message || 'Network error') : 'You appear to be offline and no cached copy exists yet.',
      actionLabel: 'Retry',
      onAction: () => ctx.router.tab('home'),
    }));
    root.appendChild(box);
    return;
  }

  const data = res.data || {};
  renderStats(data);
  renderCourses(data);
  renderContinue();
  renderRecent(data);
  renderTrending(data);
  renderShortcuts();

  // Silent background refresh (only fired when the cached copy was already
  // past its fresh window — otherwise the promise resolves immediately).
  if (res.revalidating) {
    res.revalidating.then((fresh) => {
      if (!fresh || JSON.stringify(fresh) === JSON.stringify(data)) return;
      renderStats(fresh);
      renderRecent(fresh);
      renderTrending(fresh);
      renderCourses(fresh);
    });
  }

  ctx.setRefresh(() => {
    api.homepage({ force: true }).then((r) => {
      const fresh = r.data || {};
      renderStats(fresh);
      renderCourses(fresh);
      renderRecent(fresh);
      renderTrending(fresh);
      ui.toast('Archive overview up to date');
    }).catch(() => ui.toast('Refresh failed — still offline?', 'err'));
  });

  // ── sections ─────────────────────────────────────────────────────────
  function renderStats(d) {
    const stats = d.stats || {};
    const el = root.querySelector('#home-stats');
    if (!el) return; // view changed before a late async render (revalidate/refresh) — nothing to update
    el.innerHTML = `
      <span class="stat-pill"><b>${Number(stats.totalPyqs) || 0}</b> papers</span>
      <span class="stat-pill"><b>${Number(stats.totalCourses) || 0}</b> courses</span>
      ${res.stale ? ui.stalePill('Offline copy') : ''}`;
  }

  function renderCourses(d) {
    const host = root.querySelector('#home-courses');
    if (!host) return; // view changed before a late async render
    const counts = Array.isArray(d.courseCounts) ? d.courseCounts.slice(0, 6) : [];
    host.innerHTML = '';
    if (!counts.length) return;
    host.appendChild(ui.sectionHead('Quick access', {
      iconName: 'courses',
      actionLabel: 'See all',
      onAction: () => ctx.router.tab('browse'),
    }));
    const grid = document.createElement('div');
    grid.className = 'quick-grid';
    grid.style.marginTop = '10px';
    grid.innerHTML = counts.map((c) => `
      <button class="course-card" type="button" data-course="${ui.esc(c.course)}">
        ${ui.icon('chevron')}
        <b>${ui.esc(c.course)}</b>
        <span>${Number(c.count) || 0} papers</span>
      </button>`).join('');
    grid.addEventListener('click', (e) => {
      const b = e.target.closest('[data-course]');
      if (!b) return;
      // Course browsing is filtered access → mirrors the website's login gate.
      ctx.requireAuth(() => ctx.router.go('course', { course: b.dataset.course }),
        'Sign in to browse papers by course (same rule as the website).');
    });
    host.appendChild(grid);
  }

  function renderContinue() {
    const host = root.querySelector('#home-continue');
    if (!host) return; // view changed before a late async render
    const items = store.recentViews().slice(0, 4);
    if (!items.length) { host.classList.add('hidden'); return; }
    host.classList.remove('hidden');
    host.innerHTML = '';
    host.appendChild(ui.sectionHead('Pick up where you left off', { iconName: 'clock' }));
    const list = document.createElement('div');
    list.style.marginTop = '10px';
    ui.paperList(list, ctx, items);
    host.appendChild(list);
  }

  function rail(d, key, title, iconName) {
    const host = root.querySelector(`#home-${key === 'recent' ? 'recent' : 'trending'}`);
    if (!host) return; // view changed before a late async render
    const items = Array.isArray(d[key]) ? d[key].slice(0, 6) : [];
    host.innerHTML = '';
    const head = ui.sectionHead(title, {
      iconName,
      actionLabel: items.length ? 'Browse all' : '',
      onAction: () => ctx.router.tab('browse'),
    });
    host.appendChild(head);
    if (!items.length) {
      const p = document.createElement('p');
      p.className = 'h-sub';
      p.style.marginTop = '8px';
      p.textContent = d[key] ? 'Nothing here yet.' : 'Load once you are online.';
      host.appendChild(p);
      return;
    }
    const list = document.createElement('div');
    list.style.marginTop = '10px';
    ui.paperList(list, ctx, items);
    host.appendChild(list);
  }

  function renderRecent(d) { rail(d, 'recent', 'Recently added papers', 'star'); }
  function renderTrending(d) { rail(d, 'trending', 'Trending this week', 'flame'); }

  function renderShortcuts() {
    const host = root.querySelector('#home-shortcuts');
    if (!host) return; // view changed before a late async render
    host.innerHTML = '';
    host.appendChild(ui.sectionHead('Shortcuts', { iconName: 'tools' }));
    const row = document.createElement('div');
    row.className = 'shortcut-row';
    row.style.marginTop = '10px';
    // All shortcuts open IN-APP screens (same features the drawer offers) —
    // the website is never involved.
    const items = [
      { icon: 'upload', label: 'Upload a paper', view: 'upload' },
      { icon: 'tools', label: 'Study tools', view: 'tools' },
      { icon: 'users', label: 'Contributors', view: 'contributors' },
      { icon: 'link', label: 'Links', view: 'links' },
    ];
    row.innerHTML = items.map((s, i) => `
      <button class="shortcut" type="button" data-i="${i}">
        <span class="sc-ic">${ui.icon(s.icon)}</span>
        <b>${ui.esc(s.label)}</b>
      </button>`).join('');
    row.addEventListener('click', (e) => {
      const b = e.target.closest('[data-i]');
      if (!b) return;
      ctx.router.go(items[Number(b.dataset.i)].view);
    });
    host.appendChild(row);
  }
}
