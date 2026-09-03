/**
 * DSMNRU PYQ Android — in-app Contributors screen.
 *
 * ONE cached Worker request (GET /api/contributors — the exact endpoint the
 * website uses, KV-backed server-side) feeds the whole screen; the payload is
 * persisted with a 24h fresh window and served stale-while-revalidate, so
 * revisits and offline starts cost zero network and there is never a request
 * per contributor.
 */

import * as ui from '../ui.js';

export default async function renderContributors(root, ctx) {
  const { api } = ctx;
  ctx.setHeader({ title: 'Contributors', sub: 'the students behind the archive', brand: false });

  root.innerHTML = `
    <div class="stack">
      <section class="notice notice--info">
        ${ctx.ui.icon('users')}
        <div><b>Every paper here was shared by a student.</b> Approvals earn 10 contribution points per paper.</div>
      </section>
      <section id="contrib-list" aria-live="polite">${ui.skeletonRows(5)}</section>
    </div>`;

  const listHost = root.querySelector('#contrib-list');

  try {
    const res = await api.contributors();
    const items = Array.isArray(res.data) ? res.data : [];

    listHost.innerHTML = '';
    const grid = document.createElement('div');
    grid.className = 'contrib-grid';

    items.forEach((c, i) => {
      const card = document.createElement('div');
      card.className = 'card card-pad contrib-card';
      // Deterministic pastel from the name so the avatar is stable per person.
      const hues = [168, 200, 45, 320, 265, 20, 120, 240];
      const hue = hues[i % hues.length];
      const initial = String(c.name || '?').trim().charAt(0).toUpperCase() || '?';
      card.innerHTML = `
        <div class="contrib-avatar" style="background:hsla(${hue}, 60%, 45%, 0.25);color:hsl(${hue}, 70%, 70%)">${ui.esc(c.avatar || initial)}</div>
        <div class="contrib-main">
          <b>${ui.esc(c.name || 'Contributor')}</b>
          <span>${ui.esc(c.role || 'Paper contributor')}</span>
        </div>`;
      grid.appendChild(card);
    });

    // "Join" card routes to the IN-APP upload screen — never the website.
    const join = document.createElement('button');
    join.type = 'button';
    join.className = 'card card-pad contrib-card contrib-join';
    join.innerHTML = `
      <div class="contrib-avatar contrib-avatar--ghost">${ui.icon('upload')}</div>
      <div class="contrib-main">
        <b>Join them!</b>
        <span>Upload a paper to earn points</span>
      </div>
      <span class="paper-card-go">${ui.icon('chevron')}</span>`;
    join.addEventListener('click', () => ctx.router.go('upload'));
    grid.appendChild(join);

    listHost.appendChild(grid);
    if (res.stale) {
      const note = document.createElement('p');
      note.className = 'server-note';
      note.innerHTML = ui.stalePill('Offline copy of the contributor list');
      listHost.appendChild(note);
    }
    if (!items.length) {
      const empty = ui.stateBlock({
        iconName: 'users',
        title: 'No contributors listed yet',
        text: 'Be the first — upload a paper and your name will appear here after approval.',
        actionLabel: 'Upload a paper',
        onAction: () => ctx.router.go('upload'),
      });
      listHost.innerHTML = '';
      listHost.appendChild(empty);
    }

    ctx.setRefresh(() => {
      api.contributors({ force: true }).then(() => renderContributors(root, ctx)).catch(() => ui.toast('Still offline', 'err'));
    });
  } catch (err) {
    listHost.innerHTML = '';
    listHost.appendChild(ui.stateBlock({
      iconName: ctx.state.online ? 'alert' : 'wifiOff',
      tone: 'error',
      title: "Couldn't load contributors",
      text: ctx.state.online ? String(err.message || err) : 'You appear to be offline and no cached copy exists yet.',
      actionLabel: 'Retry',
      onAction: () => renderContributors(root, ctx),
    }));
  }
}
