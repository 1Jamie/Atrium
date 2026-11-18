'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DEFAULTS,
  clampConfig,
  resolveUpscaleConfig,
  writeProfileGame,
  readProfileGame,
  labelForBadge,
  parseMode,
  parseAnime4kMode,
  parseAnime4kTier,
} = require('../lib/upscale');

test('upscale parsing helpers', () => {
  assert.equal(parseMode('anime4k'), 'anime4k');
  assert.equal(parseMode('a4k'), 'anime4k');
  assert.equal(parseMode('sgsr'), 'sgsr');
  assert.equal(parseMode('fsr1'), 'fsr1');
  assert.equal(parseMode('off'), 'off');
  assert.equal(parseMode('invalid'), null);

  assert.equal(parseAnime4kMode('a'), 'a');
  assert.equal(parseAnime4kMode('Mode_B'), 'b');
  assert.equal(parseAnime4kMode('C'), 'c');
  assert.equal(parseAnime4kMode('x'), null);

  assert.equal(parseAnime4kTier('s'), 's');
  assert.equal(parseAnime4kTier('fast'), 's');
  assert.equal(parseAnime4kTier('m'), 'm');
  assert.equal(parseAnime4kTier('balanced'), 'm');
  assert.equal(parseAnime4kTier('l'), 'l');
  assert.equal(parseAnime4kTier('high'), 'l');
  assert.equal(parseAnime4kTier('vl'), 'vl');
  assert.equal(parseAnime4kTier('ul'), 'ul');
  assert.equal(parseAnime4kTier('unknown'), null);
});

test('clampConfig with Anime4K', () => {
  const base = clampConfig({});
  assert.equal(base.mode, 'off');
  assert.equal(base.anime4kMode, 'a');
  assert.equal(base.anime4kTier, 'm');
  assert.equal(base.anime4kPlusA, false);

  const custom = clampConfig({
    mode: 'anime4k',
    anime4kMode: 'b',
    anime4kTier: 'l',
    anime4kPlusA: true,
    sharpenRcas: true,
  });
  assert.equal(custom.mode, 'anime4k');
  assert.equal(custom.anime4kMode, 'b');
  assert.equal(custom.anime4kTier, 'l');
  assert.equal(custom.anime4kPlusA, true);
  assert.equal(custom.sharpenRcas, true);
});

test('labelForBadge formatting for Anime4K', () => {
  assert.equal(
    labelForBadge({ mode: 'anime4k', anime4kMode: 'a', anime4kTier: 'm' }),
    'A4K A (M)'
  );
  assert.equal(
    labelForBadge({ mode: 'anime4k', anime4kMode: 'b', anime4kTier: 's', anime4kPlusA: true }),
    'A4K B+A (S)'
  );
  assert.equal(
    labelForBadge({
      mode: 'anime4k',
      anime4kMode: 'c',
      anime4kTier: 'l',
      sharpenRcas: true,
    }),
    'A4K C (L)+CAS'
  );
  assert.equal(
    labelForBadge({
      mode: 'anime4k',
      anime4kMode: 'a',
      anime4kTier: 'vl',
      anime4kPlusA: true,
      sharpenRcas: true,
    }),
    'A4K A+A (VL)+CAS'
  );
});

test('resolveUpscaleConfig with CLI flags', () => {
  const profile = { games: {} };
  const res = resolveUpscaleConfig({
    profile,
    gameLabel: 'TestGame',
    cli: {
      upscale: 'anime4k',
      anime4kMode: 'b',
      anime4kTier: 's',
      anime4kPlusA: true,
    },
  });
  assert.equal(res.source, 'cli');
  assert.equal(res.launchOverride, true);
  assert.equal(res.config.mode, 'anime4k');
  assert.equal(res.config.anime4kMode, 'b');
  assert.equal(res.config.anime4kTier, 's');
  assert.equal(res.config.anime4kPlusA, true);
});

test('profile persistence for Anime4K', () => {
  const profile = { games: {} };
  const saved = writeProfileGame(profile, 'Cyberpunk 2077', {
    mode: 'anime4k',
    anime4kMode: 'a',
    anime4kTier: 'l',
    anime4kPlusA: true,
  });
  assert.equal(saved.mode, 'anime4k');
  assert.equal(saved.anime4kTier, 'l');

  const loaded = readProfileGame(profile, 'Cyberpunk 2077');
  assert.deepEqual(loaded, saved);
});
