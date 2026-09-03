/**
 * DSMNRU PYQ Android — in-app Study Tools screen.
 *
 * The website's student tools as native-feeling app cards + bottom sheets.
 * Every tool runs ENTIRELY on-device (they are client-side calculators on
 * the website too) — ZERO Worker/API traffic, no WebView, no website page:
 *
 *   • CGPA/SGPA calculator  — same 10-point scale, saved history locally
 *   • Attendance tracker    — per-subject day marks, month %, 75% warnings
 *   • Study planner         — tasks with due dates + progress
 *   • Request a tool        → the maintainers' Telegram bot (genuinely
 *                             external destination — not a PYQ feature)
 */

import * as ui from '../ui.js';
import * as tools from '../toolscore.js';

const storage = (typeof localStorage !== 'undefined') ? localStorage : null;

export default async function renderTools(root, ctx) {
  ctx.setHeader({ title: 'Study tools', sub: 'run on this device', brand: false });

  root.innerHTML = `
    <div class="stack">
      <section class="notice notice--info">
        ${ctx.ui.icon('shield')}
        <div><b>Runs fully offline on this device.</b> Your marks, attendance and plans never leave the phone.</div>
      </section>
      <section class="tool-grid" id="tools-grid"></section>
    </div>`;

  const grid = root.querySelector('#tools-grid');

  function toolCard({ icon, title, desc, statHtml, buttonLabel, onTap }) {
    const card = document.createElement('section');
    card.className = 'card card-pad tool-card';
    card.innerHTML = `
      <div class="tool-head">
        <span class="tool-ic">${ui.icon(icon)}</span>
        <div class="grow">
          <div class="tool-title">${ui.esc(title)}</div>
          <p class="tool-desc">${ui.esc(desc)}</p>
        </div>
      </div>
      ${statHtml ? `<div class="tool-stat" data-stat></div>` : ''}
      <button class="btn btn--primary btn--block" type="button">${ui.icon(icon)} ${ui.esc(buttonLabel)}</button>`;
    card.querySelector('button').addEventListener('click', onTap);
    card.dataset.statSlot = statHtml ? '1' : '';
    grid.appendChild(card);
    return card.querySelector('[data-stat]');
  }

  // ── CGPA calculator ──────────────────────────────────────────────────
  const cgpaStat = toolCard({
    icon: 'calc',
    title: 'CGPA calculator',
    desc: 'Semester SGPA / CGPA on the university 10-point scale (O → F).',
    statHtml: true,
    buttonLabel: 'Open calculator',
    onTap: () => openCgpaSheet(),
  });
  const lastCgpa = tools.loadLastCgpa(storage);
  cgpaStat.innerHTML = lastCgpa && Number.isFinite(Number(lastCgpa.gpa))
    ? `<span class="tool-stat-pill">Last result <b>${Number(lastCgpa.gpa).toFixed(2)}</b> · ${tools.gradeLabel(lastCgpa.gpa)}</span>`
    : `<span class="tool-stat-pill tool-stat-pill--soft">No calculation yet</span>`;

  // ── Attendance tracker ───────────────────────────────────────────────
  const attStat = toolCard({
    icon: 'calcheck',
    title: 'Attendance tracker',
    desc: 'Mark present/absent per subject and watch the 75% limit.',
    statHtml: true,
    buttonLabel: 'Open tracker',
    onTap: () => openAttendanceSheet(),
  });
  function paintAttendanceStat() {
    const summary = tools.attendanceSummary(tools.loadAttendance(storage));
    attStat.innerHTML = summary.subjects
      ? `<span class="tool-stat-pill ${summary.near ? 'is-warn' : ''}"><b>${summary.subjects}</b> subject${summary.subjects === 1 ? '' : 's'}${summary.near ? ` · <b>${summary.near}</b> near the limit</span>` : ' tracked</span>'}`
      : `<span class="tool-stat-pill tool-stat-pill--soft">No subjects yet</span>`;
  }
  paintAttendanceStat();

  // ── Study planner ────────────────────────────────────────────────────
  const plannerStat = toolCard({
    icon: 'tasks',
    title: 'Study planner',
    desc: 'Plan tasks with due dates and track your progress.',
    statHtml: true,
    buttonLabel: 'Open planner',
    onTap: () => openPlannerSheet(),
  });
  function paintPlannerStat() {
    const s = tools.plannerStats(tools.loadPlannerTasks(storage));
    plannerStat.innerHTML = s.total
      ? `<span class="tool-stat-pill"><b>${s.total}</b> task${s.total === 1 ? '' : 's'} · <b>${s.completed}</b> done</span>
         <div class="tool-progress"><div style="width:${s.pct}%"></div></div>`
      : `<span class="tool-stat-pill tool-stat-pill--soft">No tasks yet</span>`;
  }
  paintPlannerStat();

  // ── Request a tool (genuinely external destination) ──────────────────
  const reqCard = document.createElement('section');
  reqCard.className = 'card card-pad tool-card';
  reqCard.innerHTML = `
    <div class="tool-head">
      <span class="tool-ic tool-ic--gold">${ui.icon('send')}</span>
      <div class="grow">
        <div class="tool-title">Request a tool</div>
        <p class="tool-desc">Have an idea that would help DSMNRU students? Suggest it to the maintainers on Telegram.</p>
      </div>
    </div>
    <button class="btn btn--ghost btn--block" type="button">${ui.icon('send')} Suggest a tool</button>`;
  reqCard.querySelector('button').addEventListener('click', () => {
    ctx.native.openExternal('https://t.me/dsmnru_bot');
  });
  grid.appendChild(reqCard);

  // ══ CGPA sheet ═══════════════════════════════════════════════════════
  function openCgpaSheet() {
    let count = 1;
    const node = document.createElement('div');
    node.innerHTML = `
      <div class="tool-count-row">
        <span class="field-label">Subjects</span>
        <button class="step-btn" data-step="-1" type="button" aria-label="Fewer subjects">−</button>
        <b id="cg-count">1</b>
        <button class="step-btn" data-step="1" type="button" aria-label="More subjects">+</button>
        <span class="grow"></span>
        <button class="link-btn" id="cg-reset" type="button">${ui.icon('refresh')} Reset</button>
      </div>
      <div id="cg-rows" style="margin-top:12px"></div>
      <div id="cg-result" style="margin-top:12px"></div>
      <button class="btn btn--primary btn--block" id="cg-calc" type="button" style="margin-top:12px">Calculate SGPA</button>`;

    const rowsEl = node.querySelector('#cg-rows');
    const countEl = node.querySelector('#cg-count');
    const resultEl = node.querySelector('#cg-result');

    function renderRows() {
      countEl.textContent = String(count);
      rowsEl.innerHTML = '';
      for (let i = 1; i <= count; i++) {
        const row = document.createElement('div');
        row.className = 'cg-row';
        const options = Object.keys(tools.GRADE_POINTS).map((g) =>
          `<option value="${g}">${g} — ${tools.GRADE_POINTS[g]} pts</option>`).join('');
        row.innerHTML = `
          <span class="cg-row-num">${i}</span>
          <select class="input cg-grade" data-i="${i}" aria-label="Grade for subject ${i}">${options}</select>
          <div class="step-group">
            <button class="step-btn" data-cred="-1" aria-label="Fewer credits" type="button">−</button>
            <input class="input cg-credit" data-i="${i}" type="number" min="0" max="30" value="4" aria-label="Credits for subject ${i}">
            <button class="step-btn" data-cred="1" aria-label="More credits" type="button">+</button>
          </div>`;
        rowsEl.appendChild(row);
      }
      rowsEl.querySelectorAll('[data-cred]').forEach((b) => {
        b.addEventListener('click', () => {
          const input = b.closest('.step-group').querySelector('.cg-credit');
          input.value = Math.max(0, Math.min(30, (Number(input.value) || 0) + Number(b.dataset.cred)));
        });
      });
    }

    node.querySelector('.tool-count-row').addEventListener('click', (e) => {
      const b = e.target.closest('[data-step]');
      if (!b) return;
      count = Math.max(1, Math.min(20, count + Number(b.dataset.step)));
      renderRows();
    });
    node.querySelector('#cg-reset').addEventListener('click', () => {
      count = 1;
      resultEl.innerHTML = '';
      renderRows();
    });
    node.querySelector('#cg-calc').addEventListener('click', () => {
      const rows = [...rowsEl.querySelectorAll('.cg-row')].map((row) => ({
        grade: row.querySelector('.cg-grade').value,
        credits: Number(row.querySelector('.cg-credit').value) || 0,
      }));
      const { totalCredits, totalPoints, gpa } = tools.computeGpa(rows);
      if (!totalCredits) {
        resultEl.innerHTML = `<div class="tool-result tool-result--warn">Enter credits for at least one subject.</div>`;
        return;
      }
      resultEl.innerHTML = `
        <div class="tool-result">
          <div class="tool-result-gpa">${gpa.toFixed(2)}</div>
          <div class="tool-result-meta">${tools.gradeLabel(gpa)} · ${totalCredits} credits · ${totalPoints.toFixed(1)} points</div>
        </div>`;
      tools.saveLastCgpa(storage, { totalCredits, totalPoints, gpa, timestamp: new Date().toISOString() });
      cgpaStat.innerHTML = `<span class="tool-stat-pill">Last result <b>${gpa.toFixed(2)}</b> · ${tools.gradeLabel(gpa)}</span>`;
    });

    renderRows();
    ui.sheet({ title: 'CGPA calculator', subtitle: 'Pick a letter grade + credits per subject', content: node });
  }

  // ══ Attendance sheet ═════════════════════════════════════════════════
  function openAttendanceSheet() {
    const subjects = tools.loadAttendance(storage);
    let viewMonth = tools.monthOf(tools.todayISO());
    let markDate = tools.todayISO();

    const node = document.createElement('div');
    node.innerHTML = `
      <form id="att-add" class="tool-form-row">
        <input class="input" id="att-subject" type="text" placeholder="Add a subject (e.g., Mathematics)" maxlength="60" enterkeyhint="done">
        <button class="btn btn--primary" type="submit">Add</button>
      </form>
      <div class="tool-date-row">
        <label>Mark date <input class="input" id="att-date" type="date"></label>
        <label>Month view <input class="input" id="att-month" type="month"></label>
      </div>
      <div id="att-list" style="margin-top:12px"></div>
      <button class="link-btn" id="att-clear" type="button" style="margin-top:10px">${ui.icon('trash')} Clear all subjects</button>`;

    const listEl = node.querySelector('#att-list');
    const dateInput = node.querySelector('#att-date');
    const monthInput = node.querySelector('#att-month');
    dateInput.value = markDate;
    monthInput.value = viewMonth;

    function persist() {
      tools.saveAttendance(storage, subjects);
      paintAttendanceStat();
    }

    function render() {
      viewMonth = tools.monthOf(monthInput.value || viewMonth);
      markDate = dateInput.value || markDate;
      if (!subjects.length) {
        listEl.innerHTML = `<div class="tool-empty">No subjects yet — add one above to start tracking.</div>`;
        return;
      }
      listEl.innerHTML = subjects.map((s) => {
        const stats = tools.attendanceMonthStats(s.records, viewMonth);
        const status = s.records && s.records[markDate];
        const warn = stats.total >= 3 && stats.pct < tools.ATTENDANCE_WARNING_THRESHOLD;
        return `
        <div class="card card-pad att-card" data-id="${s.id}">
          <div class="att-head">
            <b>${ui.esc(s.subject)}</b>
            <span class="att-pct ${warn ? 'is-warn' : ''}">${stats.total ? stats.pct + '%' : '—'}</span>
          </div>
          <div class="att-meta">${stats.total
            ? `${stats.present}/${stats.total} present in ${viewMonth}`
            : `No marks in ${viewMonth} yet`}${status ? ` · ${markDate}: <b>${status === 'P' ? 'Present' : 'Absent'}</b>` : ''}</div>
          <div class="tool-progress"><div style="width:${stats.pct}%"></div></div>
          <div class="att-actions">
            <button class="btn btn--ghost btn--sm" data-mark="P" type="button">Present</button>
            <button class="btn btn--ghost btn--sm" data-mark="A" type="button">Absent</button>
            <button class="btn btn--ghost btn--sm" data-del="1" type="button">${ui.icon('trash')}</button>
          </div>
        </div>`;
      }).join('');
    }

    node.querySelector('#att-add').addEventListener('submit', (e) => {
      e.preventDefault();
      const input = node.querySelector('#att-subject');
      const name = String(input.value || '').trim();
      if (!name) return;
      subjects.push({ id: Date.now(), subject: name, records: {} });
      input.value = '';
      persist();
      render();
    });
    node.querySelector('#att-list').addEventListener('click', (e) => {
      const cardEl = e.target.closest('[data-id]');
      if (!cardEl) return;
      const subject = subjects.find((x) => String(x.id) === cardEl.dataset.id);
      if (!subject) return;
      const mark = e.target.closest('[data-mark]');
      if (mark) {
        if (!subject.records) subject.records = {};
        subject.records[dateInput.value || markDate] = mark.dataset.mark;
        persist();
        render();
        return;
      }
      if (e.target.closest('[data-del]')) {
        const idx = subjects.indexOf(subject);
        subjects.splice(idx, 1);
        persist();
        render();
      }
    });
    dateInput.addEventListener('input', render);
    monthInput.addEventListener('input', render);
    node.querySelector('#att-clear').addEventListener('click', () => {
      ui.confirmSheet({
        title: 'Clear attendance?',
        text: 'This removes every subject and mark from this device. The archive is untouched.',
        confirmLabel: 'Clear',
        danger: true,
        onConfirm: () => { subjects.length = 0; persist(); render(); },
      });
    });

    render();
    ui.sheet({ title: 'Attendance tracker', subtitle: '75% is the usual warning line', content: node });
  }

  // ══ Planner sheet ════════════════════════════════════════════════════
  function openPlannerSheet() {
    let tasks = tools.loadPlannerTasks(storage);

    const node = document.createElement('div');
    node.innerHTML = `
      <form id="pl-add" class="tool-form-row">
        <input class="input" id="pl-title" type="text" placeholder="Task (e.g., Revise Unit 3)" maxlength="120" enterkeyhint="next">
        <input class="input" id="pl-due" type="datetime-local" aria-label="Due date">
        <button class="btn btn--primary" type="submit">Add</button>
      </form>
      <div class="tool-progress" style="margin-top:10px"><div id="pl-fill" style="width:0%"></div></div>
      <div class="tool-stat-line" id="pl-stats">No tasks yet</div>
      <div id="pl-list" style="margin-top:10px"></div>`;

    const listEl = node.querySelector('#pl-list');
    const statsEl = node.querySelector('#pl-stats');
    const fillEl = node.querySelector('#pl-fill');

    function persist() {
      tools.savePlannerTasks(storage, tasks);
      paintPlannerStat();
    }
    function paintStats() {
      const s = tools.plannerStats(tasks);
      fillEl.style.width = `${s.pct}%`;
      statsEl.innerHTML = s.total
        ? `<b>${s.completed}/${s.total}</b> completed`
        : 'No tasks yet';
    }
    function render() {
      const sorted = tools.sortPlannerTasks(tasks);
      if (!sorted.length) {
        listEl.innerHTML = `<div class="tool-empty">Nothing planned — add a task above.</div>`;
        paintStats();
        return;
      }
      listEl.innerHTML = sorted.map((t) => `
        <div class="card card-pad pl-card ${t.completed ? 'is-done' : ''}" data-id="${t.id}">
          <label class="pl-check"><input type="checkbox" data-toggle="1" ${t.completed ? 'checked' : ''} aria-label="Toggle task"></label>
          <div class="grow" style="min-width:0">
            <div class="pl-title">${ui.esc(t.title)}</div>
            ${t.due ? `<div class="pl-due">${ui.icon('clock')} ${ui.esc(fmtDue(t.due))}</div>` : ''}
          </div>
          <button class="icon-btn" data-del="1" type="button" aria-label="Delete task">${ui.icon('trash')}</button>
        </div>`).join('');
      paintStats();
    }

    node.querySelector('#pl-add').addEventListener('submit', (e) => {
      e.preventDefault();
      const titleEl = node.querySelector('#pl-title');
      const dueEl = node.querySelector('#pl-due');
      const title = String(titleEl.value || '').trim();
      if (!title) return;
      tasks.push({ id: Date.now(), title, due: dueEl.value || null, completed: false });
      titleEl.value = '';
      persist();
      render();
    });
    listEl.addEventListener('click', (e) => {
      const cardEl = e.target.closest('[data-id]');
      if (!cardEl) return;
      const task = tasks.find((x) => String(x.id) === cardEl.dataset.id);
      if (!task) return;
      if (e.target.matches('[data-toggle]')) {
        task.completed = e.target.checked;
        persist();
        render();
        return;
      }
      if (e.target.closest('[data-del]')) {
        tasks = tasks.filter((x) => x !== task);
        persist();
        render();
      }
    });

    render();
    ui.sheet({ title: 'Study planner', subtitle: 'Stored on this device only', content: node });
  }

  function fmtDue(iso) {
    try {
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return iso;
      return d.toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
    } catch { return iso; }
  }

  ctx.setRefresh(() => renderTools(root, ctx, {}));
}
