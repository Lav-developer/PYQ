/**
 * DSMNRU PYQ Android — in-app Links screen.
 *
 * The curated university/government portal list (same data as the website's
 * Links page — see linkdata.js) rendered as native app cards. The LIST lives
 * inside the app; only each final destination (an actual university portal)
 * opens through an Android external intent — never the DSMNRU PYQ website.
 * Static data ⇒ zero network requests.
 */

import * as ui from '../ui.js';
import { LINK_CATEGORIES } from '../linkdata.js';

function hostLabel(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
}

export default async function renderLinks(root, ctx) {
  ctx.setHeader({ title: 'Links', sub: 'essential university portals', brand: false });

  root.innerHTML = `
    <div class="stack">
      <section class="notice notice--info">
        ${ui.icon('link')}
        <div><b>Official portals, one tap away.</b> These open in your browser because they are external
        university & government services — everything else in this app stays in-app.</div>
      </section>
      <div id="links-body"></div>
    </div>`;

  const body = root.querySelector('#links-body');

  LINK_CATEGORIES.forEach((cat) => {
    const section = document.createElement('section');
    section.className = 'card card-pad';
    section.innerHTML = `
      <div class="link-cat-head">
        <span class="tool-ic">${ui.icon(cat.icon)}</span>
        <h3>${ui.esc(cat.title)}</h3>
      </div>
      <div class="link-list" data-cat="${ui.esc(cat.id)}"></div>`;
    const list = section.querySelector('.link-list');

    cat.links.forEach((link) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'sheet-item link-item';
      item.dataset.linkUrl = link.url;
      item.innerHTML = `
        <span class="tool-ic tool-ic--sm">${ui.icon(link.icon || 'link')}</span>
        <span>${ui.esc(link.title)}
          <small>${ui.esc(link.description)}</small>
          <small class="link-host">${ui.esc(hostLabel(link.url))}</small>
        </span>
        <span class="tail">${ui.icon('open')}</span>`;
      list.appendChild(item);
    });

    list.addEventListener('click', (e) => {
      const itemEl = e.target.closest('.link-item');
      if (!itemEl) return;
      // The ONLY external intent on this screen: the exact destination the
      // user picked (a university/government portal).
      ctx.native.openExternal(itemEl.dataset.linkUrl);
    });

    body.appendChild(section);
  });

  ctx.setRefresh(() => renderLinks(root, ctx, {}));
}
