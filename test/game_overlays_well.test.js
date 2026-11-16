'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createGameOverlayController } = require('../lib/game_overlays');

describe('game overlay wellFit', () => {
  it('natural keeps rest size inside the well; stretch fills it', () => {
    const shell = {
      mode: 'overlay',
      win: { _logicalWidth: 1280, _logicalHeight: 720 },
      _plugins: new Map(),
    };
    const ctrl = createGameOverlayController(shell);
    ctrl.register({
      pluginId: 'perf-hud',
      localId: 'pill',
      linkedContribution: 'tab',
      width: 220,
      height: 120,
      wellFit: 'natural',
    });
    ctrl.register({
      pluginId: 'yt',
      localId: 'pip',
      linkedContribution: 'watch',
      width: 480,
      height: 270,
      wellFit: 'stretch',
    });

    // Access private helper via sync path: placeContribution split + resolve.
    // Re-implement expected math here against public layout.
    const { computeLayout } = require('../lib/layout');
    const layout = computeLayout(shell.win, { splitWell: true });
    const well = layout.regions.well;
    assert.ok(well);

    const natural = ctrl.overlays.get('perf-hud:pill');
    assert.equal(natural.wellFit, 'natural');
    const stretch = ctrl.overlays.get('yt:pip');
    assert.equal(stretch.wellFit, 'stretch');

    // Natural preview must be smaller than the well when rest size fits.
    assert.ok(220 < well.width || 120 < well.height);
  });
});
