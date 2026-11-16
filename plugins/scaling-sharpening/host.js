'use strict';

async function activate(ctx) {
  await ctx.registerContribution({
    id: 'scaling',
    label: 'Scaling',
    sortKey: 30,
    content: { kind: 'servo', entry: 'ui/index.html' },
    input: { mode: 'pointer' },
  });

  function pushState() {
    const cfg = ctx.shell.getUpscale ? ctx.shell.getUpscale() : {};
    ctx.ipc.send('upscale-state', cfg);
  }

  ctx.ipc.on('upscale-get', () => pushState());
  ctx.ipc.on('upscale-set', (partial) => {
    if (!partial || typeof partial !== 'object') return;
    if (typeof ctx.shell.applyUpscale === 'function') {
      const next = ctx.shell.applyUpscale(partial, { persist: true });
      ctx.ipc.send('upscale-state', next);
      ctx.log('upscale →', next.mode, next.sharpenRcas ? '+rcas' : '');
    }
  });

  ctx.subscribe('upscale-changed', (cfg) => {
    ctx.ipc.send('upscale-state', cfg);
  });

  setTimeout(pushState, 400);
  ctx.log('scaling-sharpening contribution active');
}

async function deactivate(ctx) {
  if (ctx && typeof ctx.disposeAll === 'function') ctx.disposeAll();
}

module.exports = { activate, deactivate };
