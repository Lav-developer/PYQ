/**
 * DSMNRU PYQ Android — Home screen.
 *
 * Built from ONE Worker request (`GET /api/homepage`) served through the
 * app's cached client (instant re-render from cache, background revalidate,
 * offline fallback). Nothing here reuses website markup: quick-access
 * courses, recent/trending rails, continue-reading (device history) and
 * shortcuts are app-native sections. There is deliberately NO hero/greeting
 * block and NO second search field here — the app bar is the one branding
 * surface and the bottom-navigation Search tab is the one full search.
 */

export default async function renderHome(root, ctx) {
  const { ui, api, store } = ctx;

  ctx.setHeader({ title: 'DSMNRU PYQ', brand: true });

  // ONE branding surface per screen: the app bar already carries the logo.
  // Home starts straight with the useful content — no hero, no duplicate
  // search UI (the bottom-navigation Search tab is the single full search).
  root.innerHTML = `
    <div class="stack">
      <section id="home-courses"></section>

      <section id="home-recent"></section>

      <section id="home-trending"></section>

      <section id="home-continue" class="hidden"></section>

      <section id="home-shortcuts"></section>
    </div>`;

  // One request for everything below (cached + SWR; 0 network on re-entry).
  let res;
  try {
    res = await api.homepage();
  } catch (err) {
    const box = document.createElement('div');
    box.appendChild(ui.stateBlock({
      iconName: 'wifiOff',
      tone: 'error',
      title: "Couldn't load the archive overview",
      text: ctx.state.online ? 'Something went wrong. Please try again.' : 'You appear to be offline and no cached copy exists yet.',
      actionLabel: 'Retry',
      onAction: () => ctx.router.tab('home'),
    }));
    root.appendChild(box);
    return;
  }

  const data = res.data || {};
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
      renderRecent(fresh);
      renderTrending(fresh);
      renderCourses(fresh);
    });
  }

  ctx.setRefresh(() => {
    api.homepage({ force: true }).then((r) => {
      const fresh = r.data || {};
      renderCourses(fresh);
      renderRecent(fresh);
      renderTrending(fresh);
      ui.toast('Archive overview up to date');
    }).catch(() => ui.toast('Refresh failed — still offline?', 'err'));
  });

  // ── sections ─────────────────────────────────────────────────────────
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
    if (!items.length) {
      // Empty rails stay invisible — no placeholder boxes, no filler text.
      host.innerHTML = '';
      host.classList.add('hidden');
      return;
    }
    host.classList.remove('hidden');
    host.appendChild(ui.sectionHead(title, {
      iconName,
      actionLabel: 'Browse all',
      onAction: () => ctx.router.tab('browse'),
    }));
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
