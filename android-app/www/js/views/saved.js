/**
 * DSMNRU PYQ Android — Saved tab.
 *
 * Bookmarks are device-local on purpose (localStorage via store.js): the
 * platform has no favorites API, and inventing one would mean a second data
 * source. The list renders fully offline because each entry keeps its compact
 * index fields; opening one refreshes the full document through the normal
 * cached Worker path.
 */

export default async function renderSaved(root, ctx) {
  const { ui, store } = ctx;
  ctx.setHeader({ title: 'Saved papers', brand: false });

  const unsub = store.onChange(() => {
    if (!root.isConnected) { unsub(); return; }
    paint();
  });

  root.innerHTML = `
    <div class="stack">
      <div class="search-wrap">
        <div class="search-input-shell" id="sv-shell">
          ${ui.icon('search')}
          <input id="sv-filter" type="search" placeholder="Filter your saved papers…" autocomplete="off">
        </div>
      </div>
      <div id="sv-meta" class="results-count"></div>
      <div id="sv-list"></div>
      <div id="sv-actions" class="center" style="padding:6px 0 4px"></div>
    </div>`;

  const listEl = root.querySelector('#sv-list');
  const metaEl = root.querySelector('#sv-meta');
  const actionsEl = root.querySelector('#sv-actions');
  const input = root.querySelector('#sv-filter');
  const shell = root.querySelector('#sv-shell');
  let filter = '';

  function paint() {
    const all = store.savedList();
    const items = all.filter((x) => {
      if (!filter) return true;
      const hay = [x.title, x.course, x.semester, x.session, x.branch, x.subject].join(' ').toLowerCase();
      return hay.includes(filter.toLowerCase());
    });
    metaEl.innerHTML = all.length
      ? `<b>${items.length}</b> saved${filter && items.length !== all.length ? ` of ${all.length}` : ''} · stored on this device`
      : '';
    shell.classList.toggle('has-text', !!filter);

    if (!all.length) {
      listEl.innerHTML = '';
      listEl.appendChild(ui.stateBlock({
        iconName: 'bookmark',
        title: 'Nothing saved yet',
        text: 'Tap the bookmark icon on any paper — or in search results — to keep it here for quick access, even offline.',
        actionLabel: 'Find a paper',
        onAction: () => ctx.router.tab('search'),
      }));
      actionsEl.innerHTML = '';
      return;
    }
    if (!items.length) {
      listEl.innerHTML = '';
      listEl.appendChild(ui.stateBlock({
        iconName: 'search', title: 'No saved paper matches',
        text: `“${filter}” doesn't match your ${all.length} saved paper${all.length === 1 ? '' : 's'}.`,
        actionLabel: 'Clear filter',
        onAction: () => { filter = ''; input.value = ''; paint(); },
      }));
      actionsEl.innerHTML = '';
      return;
    }
    ui.paperList(listEl, ctx, items, { showSaved: true });

    // Turn the bookmark toggle in each card into a "remove" affordance when saved.
    listEl.querySelectorAll('.paper-card-save.is-saved').forEach((btn) => {
      btn.innerHTML = ui.icon('trash');
      btn.style.color = 'var(--danger)';
    });

    actionsEl.innerHTML = `<button class="link-btn" id="sv-clear" type="button">${ui.icon('trash')} Clear all saved</button>`;
    actionsEl.querySelector('#sv-clear').addEventListener('click', () => {
      ui.confirmSheet({
        title: 'Clear saved papers?',
        text: `This removes all ${all.length} bookmarks from this device. The archive itself is untouched.`,
        confirmLabel: 'Clear',
        danger: true,
        onConfirm: () => { store.clearSaved(); ui.toast('Saved list cleared'); },
      });
    });
  }

  input.addEventListener('input', () => {
    filter = input.value.trim();
    paint();
  });

  paint();
  ctx.setRefresh(() => paint());
}
