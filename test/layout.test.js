'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  unitPx,
  computeLayout,
  MARGIN_U,
  HEADER_H_U,
  FOOTER_H_U,
  CLUSTER_W_U,
  HANG_ROWS,
  ROW_H_U,
} = require('../lib/layout');

describe('layout units', () => {
  it('U scales with host height', () => {
    assert.equal(unitPx(720), 1);
    assert.equal(unitPx(1080), 1.5);
    assert.equal(unitPx(1440), 2);
  });

  it('locks shared L/R edges and hanging docks at 720p', () => {
    const L = computeLayout({ _logicalWidth: 1280, _logicalHeight: 720 });
    assert.equal(L.U, 1);
    const { stage, header, footer, content, nav, hotbar } = L.regions;
    assert.equal(stage.x, MARGIN_U);
    assert.equal(header.x, stage.x);
    assert.equal(footer.x, stage.x);
    assert.equal(content.x, stage.x);
    assert.equal(header.width, stage.width);
    assert.equal(footer.width, stage.width);
    assert.equal(content.width, stage.width);
    assert.equal(header.height, HEADER_H_U);
    assert.equal(footer.height, FOOTER_H_U);
    assert.equal(FOOTER_H_U, 0);
    // Hanging docks flush to stage bottom (0 gap).
    assert.equal(nav.y, stage.y + stage.height);
    assert.equal(hotbar.y, stage.y + stage.height);
    assert.equal(nav.x, stage.x);
    assert.equal(hotbar.x + hotbar.width, stage.x + stage.width);
    assert.equal(nav.width, CLUSTER_W_U);
    assert.equal(nav.height, HANG_ROWS * ROW_H_U);
    // Body sits between header and stage bottom (footer folded into header).
    assert.equal(content.y, header.y + header.height);
    assert.equal(content.y + content.height, stage.y + stage.height);
  });

  it('reserves a left well and shrinks content when splitWell is on', () => {
    const a = computeLayout(
      { _logicalWidth: 1280, _logicalHeight: 720 },
      { splitWell: false }
    );
    const b = computeLayout(
      { _logicalWidth: 1280, _logicalHeight: 720 },
      { splitWell: true }
    );
    // Outer stage stays locked.
    assert.deepEqual(a.regions.stage, b.regions.stage);
    assert.deepEqual(a.regions.header, b.regions.header);
    assert.deepEqual(a.regions.footer, b.regions.footer);
    assert.ok(b.regions.well);
    assert.equal(b.regions.well.x, b.regions.contentFull.x);
    assert.equal(b.regions.well.y, b.regions.contentFull.y);
    assert.ok(b.regions.content.x > b.regions.well.x + b.regions.well.width);
    assert.equal(
      b.regions.content.x + b.regions.content.width,
      b.regions.contentFull.x + b.regions.contentFull.width
    );
    // Without a preview, content fills the full body.
    assert.deepEqual(a.regions.content, a.regions.contentFull);
  });
});
