'use strict';

const SIZE = 64;

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

async function activate(ctx) {
  const win = ctx.shell.win;
  await ctx.registerHud({
    id: 'main',
    entry: 'ui/index.html',
    width: SIZE,
    height: SIZE,
    defaultVisible: true,
    layoutRect: (w) => centerRect(w),
  });
  ctx.log('static-crosshair active (registerHud)');
}

async function deactivate(ctx) {
  if (ctx && typeof ctx.disposeAll === 'function') ctx.disposeAll();
}

module.exports = { activate, deactivate };
