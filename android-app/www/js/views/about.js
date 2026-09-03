/**
 * DSMNRU PYQ Android — About screen.
 *
 * In-app app identity/data-source summary (pushed from the drawer). It keeps
 * the audit honest: what runs in-app, and the short, deliberate list of
 * genuinely external destinations.
 */

import { SITE_ORIGIN } from '../api.js';
import * as ui from '../ui.js';

const APP_VERSION = '1.4.0';

export default async function renderAbout(root, ctx) {
  ctx.setHeader({ title: 'About', brand: false });

  root.innerHTML = `
    <div class="stack">
      <section class="card card-pad about-hero">
        <div class="hero-emblem" aria-hidden="true"></div>
        <h1>DSMNRU PYQ</h1>
        <p class="h-sub">Dedicated Android app · v${APP_VERSION}<br>
        Dr. Shakuntala Misra National Rehabilitation University<br>previous-year question-paper archive</p>
      </section>

      <section class="card card-pad">
        <h3 class="about-h3">${ui.icon('check')} Fully inside this app</h3>
        <ul class="about-list">
          <li>Browse, search, filters and course pages — served by the shared Cloudflare Worker API</li>
          <li>In-app PDF viewer (zoom/scroll) — reads the papers' original hosts directly</li>
          <li>Upload paper — same storage + review queue as the website</li>
          <li>Study tools — CGPA, attendance, planner run 100% on this device</li>
          <li>Contributors and Links screens</li>
          <li>Sign-in — email/password and native Google, same Firebase project as the website</li>
          <li>Saved papers & history — stored only on this device</li>
        </ul>
      </section>

      <section class="card card-pad">
        <h3 class="about-h3">${ui.icon('open')} Genuinely external destinations</h3>
        <ul class="about-list">
          <li>University/government portals on the Links screen</li>
          <li>Paper hosts that cannot render in-app (e.g. Drive landing pages)</li>
          <li>The full website & moderation tools (button below)</li>
          <li>Email verification / password-reset links sent by Firebase</li>
        </ul>
      </section>

      <section class="card card-pad">
        <h3 class="about-h3">${ui.icon('info')} Data & accounts</h3>
        <ul class="about-list">
          <li>Papers, search and courses come from the shared archive service — the same data as the website</li>
          <li>Accounts and uploads use the same account system as the website — nothing new is created</li>
          <li>No second database, no mirrored PDFs, no duplicate backend</li>
        </ul>
      </section>

      <section class="card card-pad center">
        <button class="btn btn--ghost btn--block" id="about-web" type="button">${ui.icon('globe')} Open full website (external)</button>
        <p class="form-note">© DSMNRU Academic Archive</p>
      </section>
    </div>`;

  root.querySelector('#about-web').addEventListener('click', () => ctx.native.openExternal(SITE_ORIGIN + '/'));
}
