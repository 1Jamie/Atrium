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
      let details = next.mode;
      if (next.mode === 'anime4k') {
        details += ` (${next.anime4kMode.toUpperCase()}${next.anime4kPlusA ? '+A' : ''}, ${next.anime4kTier.toUpperCase()})`;
      }
      if (next.sharpenRcas) details += ' +rcas';
      ctx.log('upscale →', details);
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
