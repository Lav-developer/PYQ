/**
 * DSMNRU PYQ Android — study-tools core (pure, DOM-free, unit-tested).
 *
 * Ports of the website's client-side tools (script.js IIFE modules) so the
 * in-app Study Tools screen computes exactly the same numbers with the same
 * storage keys — 100% on-device, zero network:
 *
 *   • CGPA/SGPA calculator  — same 10-point grade map (O..F), credit-weighted
 *   • Attendance tracker    — same record shape { subject, records: { 'YYYY-MM-DD': 'P'|'A' } }
 *                             and the same 75% warning threshold
 *   • Study planner         — same task shape { id, title, due, completed }
 */

// ── CGPA / SGPA (website gradeMap parity) ──────────────────────────────

export const GRADE_POINTS = { O: 10, 'A+': 9, A: 8, 'B+': 7, B: 6, C: 5, D: 4, F: 0 };

/**
 * Credit-weighted GPA over rows of { grade, credits }.
 * Rows with unknown grades count 0 points (website behaviour); credits of 0
 * are skipped so they cannot divide the total.
 * @returns { totalCredits, totalPoints, gpa }
 */
export function computeGpa(rows) {
  const list = Array.isArray(rows) ? rows : [];
  let totalPoints = 0;
  let totalCredits = 0;
  for (const row of list) {
    const credits = Number(row && row.credits) || 0;
    const grade = String(row && row.grade || '').trim().toUpperCase();
    const points = Object.prototype.hasOwnProperty.call(GRADE_POINTS, grade) ? GRADE_POINTS[grade] : 0;
    if (credits <= 0) continue;
    totalPoints += points * credits;
    totalCredits += credits;
  }
  const gpa = totalCredits ? totalPoints / totalCredits : 0;
  return { totalCredits, totalPoints, gpa };
}

export function gradeLabel(gpa) {
  const g = Number(gpa) || 0;
  if (g >= 9) return 'Outstanding';
  if (g >= 8) return 'Excellent';
  if (g >= 7) return 'Very good';
  if (g >= 6) return 'Good';
  if (g >= 5) return 'Pass';
  if (g > 0) return 'Needs work';
  return '—';
}

// ── Attendance (website record shape + threshold parity) ───────────────

export const ATTENDANCE_WARNING_THRESHOLD = 75;

export function todayISO(now = new Date()) {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}
export function monthOf(iso) {
  return String(iso || '').slice(0, 7);
}

/** Percent present for one subject record map ({} → 0). */
export function attendancePercent(records) {
  const map = records && typeof records === 'object' ? records : {};
  const total = Object.keys(map).length;
  if (!total) return 0;
  const present = Object.keys(map).filter((k) => map[k] === 'P').length;
  return Math.round((present / total) * 100);
}

/** { present, total, pct } for one subject restricted to a 'YYYY-MM' month. */
export function attendanceMonthStats(records, month) {
  const map = records && typeof records === 'object' ? records : {};
  const keys = Object.keys(map).filter((k) => String(k).startsWith(month));
  const present = keys.filter((k) => map[k] === 'P').length;
  return { present, total: keys.length, pct: keys.length ? Math.round((present / keys.length) * 100) : 0 };
}

/** Overall + per-subject warnings at the website's 75% threshold. */
export function attendanceSummary(subjects, { now = new Date() } = {}) {
  const list = Array.isArray(subjects) ? subjects : [];
  const month = monthOf(todayISO(now));
  let low = 0;
  let near = 0;
  for (const s of list) {
    const pct = attendanceMonthStats(s && s.records, month).pct || attendancePercent(s && s.records);
    if (pct && pct < ATTENDANCE_WARNING_THRESHOLD) {
      low++;
      if (pct >= ATTENDANCE_WARNING_THRESHOLD - 5) near++;
    }
  }
  return { subjects: list.length, low, near };
}

// ── Study planner ──────────────────────────────────────────────────────

/** { total, completed, pct } over planner tasks. */
export function plannerStats(tasks) {
  const list = Array.isArray(tasks) ? tasks : [];
  const total = list.length;
  const completed = list.filter((t) => t && t.completed).length;
  return { total, completed, pct: total ? Math.round((completed / total) * 100) : 0 };
}

/** Sort tasks: incomplete first, then by due date (undated last), then newest. */
export function sortPlannerTasks(tasks) {
  const list = Array.from(Array.isArray(tasks) ? tasks : []);
  return list.sort((a, b) => {
    const ac = !!(a && a.completed);
    const bc = !!(b && b.completed);
    if (ac !== bc) return ac ? 1 : -1;
    const ad = a && a.due ? Date.parse(a.due) : NaN;
    const bd = b && b.due ? Date.parse(b.due) : NaN;
    if (!Number.isNaN(ad) && !Number.isNaN(bd)) return ad - bd;
    if (!Number.isNaN(ad)) return -1;
    if (!Number.isNaN(bd)) return 1;
    return (b && b.id || 0) - (a && a.id || 0);
  });
}

// ── local persistence (same keys as the website modules) ──────────────

function readJson(storage, key, fallback) {
  if (!storage) return fallback;
  try {
    const raw = storage.getItem(key);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed === null ? fallback : parsed;
  } catch { return fallback; }
}

function writeJson(storage, key, value) {
  if (!storage) return;
  try { storage.setItem(key, JSON.stringify(value)); } catch { /* quota */ }
}

export const KEYS = {
  planner: 'dsmnruStudyPlanner',
  attendance: 'dsmnruAttendance',
  cgpaLast: 'dsmnruCgpaLast',
};

export function loadPlannerTasks(storage) { return readJson(storage, KEYS.planner, []); }
export function savePlannerTasks(storage, tasks) { writeJson(storage, KEYS.planner, Array.isArray(tasks) ? tasks : []); }
export function loadAttendance(storage) { return readJson(storage, KEYS.attendance, []); }
export function saveAttendance(storage, subjects) { writeJson(storage, KEYS.attendance, Array.isArray(subjects) ? subjects : []); }
export function loadLastCgpa(storage) { return readJson(storage, KEYS.cgpaLast, null); }
export function saveLastCgpa(storage, payload) { writeJson(storage, KEYS.cgpaLast, payload); }
