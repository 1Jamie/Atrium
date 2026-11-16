'use strict';

/**
 * Lower-left navigation: single column, 5 rows.
 *
 * - 1–5 entries: one page, up to 5 plugin rows, no pager.
 * - 6+: 4 plugins per page; row 5 is a split ‹ / › pager.
 *   ‹ is disabled on the first page; › is disabled on the last.
 */

const PAGE_CAPACITY = 4;
const MAX_ROWS = 5;

/**
 * @param {number} total
 * @returns {number}
 */
function pageCount(total) {
  const n = Math.max(0, Math.floor(Number(total) || 0));
  if (n <= MAX_ROWS) return 1;
  return Math.max(1, Math.ceil(n / PAGE_CAPACITY));
}

/**
 * Inclusive contribution index range for a 0-based page.
 * @param {number} total
 * @param {number} page
 * @returns {{ start: number, end: number }}
 */
function pageRange(total, page) {
  const n = Math.max(0, Math.floor(Number(total) || 0));
  const pages = pageCount(n);
  const p = Math.max(0, Math.min(pages - 1, Math.floor(Number(page) || 0)));
  if (n <= MAX_ROWS) {
    return { start: 0, end: n };
  }
  const start = p * PAGE_CAPACITY;
  const end = Math.min(n, start + PAGE_CAPACITY);
  return { start, end };
}

/**
 * Build one page of the 1×5 tab cluster.
 * @param {number} total
 * @param {number} page 0-based
 * @returns {{
 *   rows: Array<object>,
 *   cells: Array<Array<object|null>>,
 *   columns: 1,
 *   page: number,
 *   pages: number
 * }}
 */
function allocateNavPage(total, page = 0) {
  const n = Math.max(0, Math.floor(Number(total) || 0));
  const pages = pageCount(n);
  const p = Math.max(0, Math.min(pages - 1, Math.floor(Number(page) || 0)));
  const rows = [];

  if (n === 0) {
    for (let i = 0; i < MAX_ROWS; i++) rows.push({ type: 'empty' });
    return { rows, cells: rowsToCells(rows), columns: 1, page: 0, pages: 1 };
  }

  if (n <= MAX_ROWS) {
    for (let i = 0; i < n; i++) rows.push({ type: 'plugin', index: i });
    while (rows.length < MAX_ROWS) rows.push({ type: 'empty' });
    return { rows, cells: rowsToCells(rows), columns: 1, page: 0, pages: 1 };
  }

  const { start, end } = pageRange(n, p);
  for (let i = start; i < end; i++) {
    rows.push({ type: 'plugin', index: i });
  }
  while (rows.length < MAX_ROWS - 1) rows.push({ type: 'empty' });
  rows.push({
    type: 'pager',
    prevDisabled: p <= 0,
    nextDisabled: p >= pages - 1,
  });

  return { rows, cells: rowsToCells(rows), columns: 1, page: p, pages };
}

/** Back-compat 5×2 cells view for older callers/tests. */
function rowsToCells(rows) {
  const cells = Array.from({ length: MAX_ROWS }, () => [null, null]);
  for (let r = 0; r < MAX_ROWS; r++) {
    const row = rows[r];
    if (!row || row.type === 'empty') continue;
    if (row.type === 'plugin') {
      cells[r][0] = { type: 'plugin', index: row.index };
    } else if (row.type === 'pager') {
      cells[r][0] = {
        type: 'prev',
        disabled: !!row.prevDisabled,
      };
      cells[r][1] = {
        type: 'next',
        disabled: !!row.nextDisabled,
      };
    } else if (row.type === 'prev' || row.type === 'next') {
      cells[r][0] = row;
    }
  }
  return cells;
}

/**
 * Sort contributions by sortKey then id.
 * @param {Array<{ id?: string, key?: string, sortKey?: number, order?: number }>} list
 */
function sortContributions(list) {
  return (list || []).slice().sort((a, b) => {
    const ao = a.sortKey != null ? a.sortKey : a.order != null ? a.order : 100;
    const bo = b.sortKey != null ? b.sortKey : b.order != null ? b.order : 100;
    if (ao !== bo) return ao - bo;
    const ak = String(a.key || a.id || '');
    const bk = String(b.key || b.id || '');
    return ak.localeCompare(bk);
  });
}

module.exports = {
  PAGE_CAPACITY,
  MAX_ROWS,
  // Back-compat aliases
  PAGE1_CAPACITY: PAGE_CAPACITY,
  LATER_CAPACITY: PAGE_CAPACITY,
  pageCount,
  pageRange,
  allocateNavPage,
  sortContributions,
};
