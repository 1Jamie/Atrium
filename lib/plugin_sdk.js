'use strict';

const { anchorRect, rightDrawerRect, windowBounds } = require('./bounds');
const { TOP_CHROME } = require('./profile');

const FOOTER_CHROME = 40;
const DEFAULT_HUD_W = 220;
const DEFAULT_HUD_H = 72;

function disposable(fn) {
  let done = false;
  return {
    dispose() {
      if (done) return;
      done = true;
      try {
        fn();
      } catch (_) {}
    },
  };
}

/**
 * Attach registerHud / registerTab / registerPane / onAction onto a PluginContext.
 * Wraps existing createSurfacePane / createExternalPane; does not replace them.
 */
function installPluginSdk(ctx) {
  if (!ctx || ctx.registerHud) return ctx;
  const shell = ctx.shell;
  const disposables = [];
  ctx._sdkDisposables = disposables;

  function track(d) {
    disposables.push(d);
    return d;
  }

  ctx.registerHud = async function registerHud(spec = {}) {
    const id = spec.id || 'hud';
    const anchor = spec.anchor || 'top-left';
    const width = spec.width || DEFAULT_HUD_W;
    const height = spec.height || DEFAULT_HUD_H;
    const win = shell.win;
    const rect =
      spec.defaultRect ||
      (typeof spec.layoutRect === 'function'
        ? spec.layoutRect(win)
        : anchorRect(win, anchor, width, height, {
            topChrome: TOP_CHROME,
            bottomChrome: FOOTER_CHROME,
          }));
    const pane = await ctx.createSurfacePane(id, {
      entry: spec.entry,
      defaultRect: rect,
      layer: 'hud',
      visibility: 'always',
      interactive: 'never',
      reposition:
        spec.reposition ||
        ((p, w) => {
          const next =
            typeof spec.layoutRect === 'function'
              ? spec.layoutRect(w)
              : anchorRect(w, anchor, width, height, {
                  topChrome: TOP_CHROME,
                  bottomChrome: FOOTER_CHROME,
                });
          p.setRect(next.x, next.y, next.width, next.height);
        }),
    });
    if (spec.defaultVisible === false) {
      pane.setVisible(false);
    }
    return track(
      disposable(() => {
        try {
          ctx.destroyPane(id);
        } catch (_) {}
      })
    );
  };

  ctx.registerTab = async function registerTab(spec = {}) {
    const id = spec.id;
    if (!id) throw new Error('registerTab: missing id');
    const win = shell.win;
    const bounds = windowBounds(win);
    const defaultRect =
      spec.defaultRect ||
      rightDrawerRect(win, { top: TOP_CHROME, fraction: 0.42, minWidth: 320 });
    const pane = await ctx.createSurfacePane(id, {
      entry: spec.entry,
      defaultRect,
      layer: 'drawer',
      visibility: 'overlay-only',
      interactive: 'overlay-only',
      reposition:
        spec.reposition ||
        ((p, w) => {
          const next =
            typeof spec.layoutRect === 'function'
              ? spec.layoutRect(w)
              : rightDrawerRect(w, { top: TOP_CHROME, fraction: 0.42, minWidth: 320 });
          p.setRect(next.x, next.y, next.width, next.height);
        }),
    });
    pane.setVisible(false);

    const slotKey = `${ctx.id}:${id}`;
    shell.addDockSlot({
      key: slotKey,
      pluginId: ctx.id,
      localId: id,
      kind: 'tab',
      label: spec.label || id,
      icon: spec.icon || null,
      order: spec.order != null ? spec.order : 100,
      input: spec.input || { mode: 'spatial' },
      onFocusChange: spec.onFocusChange || null,
    });

    return track(
      disposable(() => {
        try {
          shell.removeDockSlot(slotKey);
        } catch (_) {}
        try {
          ctx.destroyPane(id);
        } catch (_) {}
      })
    );
  };

  ctx.registerPane = async function registerPane(spec = {}) {
    const id = spec.id;
    if (!id) throw new Error('registerPane: missing id');
    let paneHandle = ctx.getPane(id);
    let ensured = !!paneHandle;

    async function ensure() {
      if (ensured && ctx.getPane(id)) return ctx.getPane(id);
      if (typeof spec.ensure === 'function') {
        paneHandle = await spec.ensure();
      } else if (spec.spawn) {
        const spawn = spec.spawn;
        paneHandle = await ctx.createExternalPane(id, {
          command: spawn.cmd || spawn.command,
          args: spawn.args || [],
          env: spawn.env || {},
          defaultRect:
            spec.defaultRect ||
            rightDrawerRect(shell.win, { top: TOP_CHROME, fraction: 0.38, minWidth: 280 }),
          layer: 'drawer',
          visibility: 'overlay-only',
          interactive: 'overlay-only',
          resizable: spec.layout?.resize
            ? {
                edges: spec.layout.resize,
                anchor: spec.layout.anchor || 'top-right',
                minWidth: 280,
                minHeight: 120,
              }
            : undefined,
          dbus: spec.dbus,
          reposition:
            spec.reposition ||
            ((p, w) => {
              const next = rightDrawerRect(w, {
                top: TOP_CHROME,
                fraction: 0.38,
                minWidth: 280,
              });
              p.setRect(next.x, next.y, next.width, next.height);
            }),
        });
      } else {
        throw new Error(`registerPane('${id}'): need spawn or ensure()`);
      }
      ensured = true;
      return paneHandle;
    }

    if (spec.spawn && spec.lazy === false) {
      await ensure();
    }

    const slotKey = `${ctx.id}:${id}`;
    if (spec.dockEntry) {
      shell.addDockSlot({
        key: slotKey,
        pluginId: ctx.id,
        localId: id,
        kind: 'pane',
        label: spec.dockEntry.label || id,
        icon: spec.dockEntry.icon || null,
        order: spec.dockEntry.order != null ? spec.dockEntry.order : 100,
        input: spec.input || { mode: 'raw' },
        onFocusChange: spec.onFocusChange || null,
        ensure,
      });
    }

    return track(
      disposable(() => {
        try {
          shell.removeDockSlot(slotKey);
        } catch (_) {}
        try {
          ctx.destroyPane(id);
        } catch (_) {}
      })
    );
  };

  ctx.onAction = function onAction(handler) {
    if (typeof handler !== 'function') {
      throw new Error('onAction: handler required');
    }
    return track(shell.addActionHandler(ctx.id, handler));
  };

  ctx.disposeAll = function disposeAll() {
    while (disposables.length) {
      const d = disposables.pop();
      try {
        d.dispose();
      } catch (_) {}
    }
  };

  return ctx;
}

module.exports = {
  installPluginSdk,
  disposable,
  FOOTER_CHROME,
  DEFAULT_HUD_W,
  DEFAULT_HUD_H,
};
