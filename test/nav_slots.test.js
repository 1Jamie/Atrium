'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  pageCount,
  pageRange,
  allocateNavPage,
} = require('../lib/nav_slots');

function pluginIndexes(alloc) {
  return (alloc.rows || [])
    .map((r, row) => (r && r.type === 'plugin' ? { row, index: r.index } : null))
    .filter(Boolean);
}

function rowType(alloc, row) {
  const r = alloc.rows[row];
  return r ? r.type : null;
}

describe('nav_slots pageCount', () => {
  it('counts pages for 1–5 single page; 6+ at 4 per page', () => {
    assert.equal(pageCount(0), 1);
    assert.equal(pageCount(1), 1);
    assert.equal(pageCount(5), 1);
    assert.equal(pageCount(6), 2);
    assert.equal(pageCount(8), 2);
    assert.equal(pageCount(9), 3);
    assert.equal(pageCount(12), 3);
  });
});

describe('nav_slots pageRange', () => {
  it('fits ≤5 on one page; paginated pages hold 4', () => {
    assert.deepEqual(pageRange(5, 0), { start: 0, end: 5 });
    assert.deepEqual(pageRange(6, 0), { start: 0, end: 4 });
    assert.deepEqual(pageRange(6, 1), { start: 4, end: 6 });
    assert.deepEqual(pageRange(9, 0), { start: 0, end: 4 });
    assert.deepEqual(pageRange(9, 1), { start: 4, end: 8 });
    assert.deepEqual(pageRange(9, 2), { start: 8, end: 9 });
  });
});

describe('nav_slots allocateNavPage', () => {
  it('1 plugin: single column, no pager', () => {
    const a = allocateNavPage(1, 0);
    assert.equal(a.columns, 1);
    assert.equal(a.pages, 1);
    assert.deepEqual(pluginIndexes(a), [{ row: 0, index: 0 }]);
    assert.equal(rowType(a, 4), 'empty');
  });

  it('5 plugins: all five rows are plugins, no pager', () => {
    const a = allocateNavPage(5, 0);
    assert.equal(a.columns, 1);
    assert.equal(a.pages, 1);
    assert.deepEqual(
      pluginIndexes(a).map((p) => p.index),
      [0, 1, 2, 3, 4]
    );
    assert.equal(rowType(a, 4), 'plugin');
  });

  it('6 plugins: page 1 shows 4 + pager; ‹ disabled, › enabled', () => {
    const a = allocateNavPage(6, 0);
    assert.equal(a.pages, 2);
    assert.deepEqual(
      pluginIndexes(a).map((p) => p.index),
      [0, 1, 2, 3]
    );
    assert.equal(rowType(a, 4), 'pager');
    assert.equal(a.rows[4].prevDisabled, true);
    assert.equal(a.rows[4].nextDisabled, false);
  });

  it('6 plugins: page 2 shows remaining + pager; › disabled', () => {
    const a = allocateNavPage(6, 1);
    assert.deepEqual(
      pluginIndexes(a).map((p) => p.index),
      [4, 5]
    );
    assert.equal(rowType(a, 4), 'pager');
    assert.equal(a.rows[4].prevDisabled, false);
    assert.equal(a.rows[4].nextDisabled, true);
  });

  it('9 plugins: three pages of 4', () => {
    assert.equal(pageCount(9), 3);
    const p0 = allocateNavPage(9, 0);
    assert.equal(p0.rows[4].prevDisabled, true);
    assert.equal(p0.rows[4].nextDisabled, false);
    const p1 = allocateNavPage(9, 1);
    assert.equal(p1.rows[4].prevDisabled, false);
    assert.equal(p1.rows[4].nextDisabled, false);
    const p2 = allocateNavPage(9, 2);
    assert.deepEqual(pluginIndexes(p2).map((p) => p.index), [8]);
    assert.equal(p2.rows[4].prevDisabled, false);
    assert.equal(p2.rows[4].nextDisabled, true);
  });

  it('pager always occupies the bottom row when paginating', () => {
    const a = allocateNavPage(8, 1);
    assert.equal(rowType(a, 4), 'pager');
    for (const p of pluginIndexes(a)) {
      assert.ok(p.row < 4);
    }
  });
});
