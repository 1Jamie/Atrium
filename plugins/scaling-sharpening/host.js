'use strict';

async function activate(ctx) {
  await ctx.registerTab({
    id: 'scaling',
    label: 'Scaling',
    order: 30,
    entry: 'ui/index.html',
    input: { mode: 'spatial', handlesBack: false },
  });

  function pushState() {
    const cfg =
      typeof ctx.shell.getUpscale === 'function'
        ? ctx.shell.getUpscale()
        : ctx.shell._upscale || {};
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

  if (typeof ctx.shell.on === 'function') {
    ctx.shell.on('upscale-changed', (cfg) => {
      ctx.ipc.send('upscale-state', cfg);
    });
  }

  ctx.onAction((act) => {
    if (!act || !act.action) return false;
    if (act.action === 'Nav' || act.action === 'Confirm') {
      ctx.ipc.send('action', act);
      return true;
    }
    return false;
  });

  setTimeout(pushState, 400);
  ctx.log('scaling-sharpening tab active');
}

async function deactivate(ctx) {
  if (ctx && typeof ctx.disposeAll === 'function') ctx.disposeAll();
}

module.exports = { activate, deactivate };
