/**
 * Input validation and sanitization utilities.
 */

export function sanitizeSearchQuery(query) {
  if (!query) return '';
  return String(query)
    .trim()
    .slice(0, 200)
    .replace(/[<>]/g, '');
}

export function parsePagination(params) {
  let page = parseInt(params.get('page'), 10);
  let limit = parseInt(params.get('limit'), 10);

  if (Number.isNaN(page)) page = 1;
  if (Number.isNaN(limit)) limit = 20;

  if (page < 1) page = 1;
  if (page > 100) page = 100;
  if (limit < 1) limit = 1;
  if (limit > 100) limit = 100;

  return { page, limit };
}

export function validateSort(sort) {
  const allowed = ['newest', 'popular', 'az', 'za', 'oldest'];
  if (sort && allowed.includes(sort)) {
    return sort;
  }
  return 'newest';
}

export function validateFilters(params) {
  const filters = {};

  const course = params.get('course');
  if (course && course.trim()) {
    filters.course = course.trim().slice(0, 100);
  }

  const semester = params.get('semester');
  if (semester && semester.trim()) {
    const sem = semester.trim().toLowerCase();
    if (/^(1st|2nd|3rd|4th|5th|6th|7th|8th)$/.test(sem)) {
      filters.semester = sem;
    }
  }

  const session = params.get('session');
  if (session && session.trim()) {
    filters.session = session.trim().slice(0, 20);
  }

  const year = params.get('year');
  if (year && year.trim()) {
    filters.year = year.trim().slice(0, 20);
  }

  return filters;
}

export function isValidDocId(id) {
  if (!id) return false;
  if (typeof id !== 'string') return false;
  if (id.length > 1500) return false;
  return /^[a-zA-Z0-9_\-./]+$/.test(id);
}

export async function parseJSONBody(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}
