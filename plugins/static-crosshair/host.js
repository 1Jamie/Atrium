'use strict';

const SIZE = 64;

const DEFAULTS = {
  enabled: true,
  color: '#ffffff',
  thickness: 2,
  length: 8,
  gap: 0,
  outline: true,
};

function centerRect(win) {
  const w = win._logicalWidth || 1280;
  const h = win._logicalHeight || 720;
  return {
    x: Math.max(0, Math.floor((w - SIZE) / 2)),
    y: Math.max(0, Math.floor((h - SIZE) / 2)),
    width: SIZE,
    height: SIZE,
  };
}

function clampInt(v, min, max, fallback) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function normalize(cfg) {
  const src = cfg && typeof cfg === 'object' ? cfg : {};
  const color = typeof src.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(src.color)
    ? src.color.toLowerCase()
    : DEFAULTS.color;
  return {
    enabled: src.enabled !== false,
    color,
    thickness: clampInt(src.thickness, 1, 4, DEFAULTS.thickness),
    length: clampInt(src.length, 4, 20, DEFAULTS.length),
    gap: clampInt(src.gap, 0, 10, DEFAULTS.gap),
    outline: src.outline !== false,
  };
}

async function activate(ctx) {
  let cfg = normalize(ctx.storage.get('crosshair', {}));

  const overlay = await ctx.registerGameOverlay({
    id: 'main',
    entry: 'ui/index.html',
    width: SIZE,
    height: SIZE,
    defaultVisible: cfg.enabled,
    layoutRect: (w) => centerRect(w),
  });

  function push() {
    ctx.ipc.send('config', cfg);
    if (overlay && typeof overlay.setShown === 'function') {
      overlay.setShown(cfg.enabled);
    }
  }

  ctx.ipc.on('get', () => push());
  ctx.ipc.on('set', (partial) => {
    if (!partial || typeof partial !== 'object') return;
    cfg = normalize(Object.assign({}, cfg, partial));
    ctx.storage.set('crosshair', cfg);
    push();
  });

  await ctx.registerContribution({
    id: 'settings',
    label: 'Crosshair',
    sortKey: 90,
    content: { kind: 'servo', entry: 'ui/settings.html' },
    input: { mode: 'pointer' },
  });

  setTimeout(push, 400);
  ctx.log('static-crosshair active');
}

async function deactivate(ctx) {
  if (ctx && typeof ctx.disposeAll === 'function') ctx.disposeAll();
}

module.exports = { activate, deactivate };
