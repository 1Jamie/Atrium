'use strict';

const { anchorRect } = require('./bounds');

const DEFAULT_HUD_W = 220;
const DEFAULT_HUD_H = 72;
/** @deprecated footer chrome removed; kept for callers that still read the export */
const FOOTER_CHROME = 0;

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
 * Attach registerContribution / registerGameOverlay / registerAction onto a PluginContext.
 */
function installPluginSdk(ctx) {
  if (!ctx || ctx.registerContribution) return ctx;
  const shell = ctx.shell;
  const disposables = [];
  ctx._sdkDisposables = disposables;

  function track(d) {
    disposables.push(d);
    return d;
  }

  /**
   * Host-owned content contribution (nav cell). No coordinates.
   * content.kind: 'servo' | 'external'
   */
  ctx.registerContribution = async function registerContribution(spec = {}) {
    const id = spec.id;
    if (!id) throw new Error('registerContribution: missing id');
    const content = spec.content || {};
    const kind = content.kind || (content.entry ? 'servo' : content.command ? 'external' : null);
    if (kind !== 'servo' && kind !== 'external') {
      throw new Error(`registerContribution('${id}'): content.kind must be servo|external`);
    }

    const slotKey = `${ctx.id}:${id}`;
    let ensure = null;

    if (kind === 'servo') {
      const entry = content.entry || spec.entry;
      if (!entry) throw new Error(`registerContribution('${id}'): servo needs entry`);
      // Placeholder rect — shell assigns the content/well rect on focus.
      await ctx.createSurfacePane(id, {
        entry,
        defaultRect: { x: 0, y: 0, width: 320, height: 240 },
        layer: 'drawer',
        visibility: 'overlay-only',
        interactive: 'overlay-only',
        reposition(p, w) {
          if (typeof shell.placeContributionPane === 'function') {
            shell.placeContributionPane(slotKey, p, w);
          }
        },
      });
      const pane = ctx.getPane(id);
      if (pane) pane.setVisible(false);
    } else {
      ensure = async () => {
        if (ctx.getPane(id)) return ctx.getPane(id);
        if (typeof content.ensure === 'function') {
          return content.ensure();
        }
        const spawn = content.spawn || content;
        return ctx.createExternalPane(id, {
          command: spawn.command || spawn.cmd,
          args: spawn.args || [],
          env: spawn.env || {},
          defaultRect: { x: 0, y: 0, width: 400, height: 600 },
          layer: 'drawer',
          visibility: 'overlay-only',
          interactive: 'overlay-only',
          clientSizing: spawn.clientSizing || content.clientSizing || 'dock',
          clientUpscale: spawn.clientUpscale || content.clientUpscale,
          dbus: spawn.dbus || content.dbus,
          reposition(p, w) {
            if (typeof shell.placeContributionPane === 'function') {
              shell.placeContributionPane(slotKey, p, w);
            }
          },
        });
      };
      if (content.lazy === false) {
        await ensure();
      }
    }

    shell.addDockSlot({
      key: slotKey,
      pluginId: ctx.id,
      localId: id,
      kind: kind === 'external' ? 'pane' : 'tab',
      contentKind: kind,
      label: spec.label || spec.title || id,
      icon: spec.icon || null,
      sortKey: spec.sortKey != null ? spec.sortKey : spec.order != null ? spec.order : 100,
      order: spec.sortKey != null ? spec.sortKey : spec.order != null ? spec.order : 100,
      input: spec.input || { mode: kind === 'external' ? 'raw' : 'pointer' },
      onFocusChange: spec.onFocusChange || null,
      ensure,
    });

    const handle = {
      id: slotKey,
      dispose() {
        try {
          shell.removeDockSlot(slotKey);
        } catch (_) {}
        try {
          ctx.destroyPane(id);
        } catch (_) {}
      },
      update(partial = {}) {
        if (typeof shell.updateDockSlot === 'function') {
          shell.updateDockSlot(slotKey, partial);
        }
      },
      focus() {
        if (typeof shell.selectDockSlot === 'function') {
          return shell.selectDockSlot(slotKey);
        }
        return Promise.resolve();
      },
    };
    return track(handle);
  };

  /**
   * Game-mode floating surface. Plugin owns rest rect; shell owns well/hide.
   */
  ctx.registerGameOverlay = async function registerGameOverlay(spec = {}) {
    const id = spec.id || 'overlay';
    const entry = spec.entry;
    if (!entry) throw new Error('registerGameOverlay: missing entry');
    const anchor = spec.anchor || 'top-left';
    const width = spec.width || DEFAULT_HUD_W;
    const height = spec.height || DEFAULT_HUD_H;
    const win = shell.win;

    const layoutRect =
      typeof spec.layoutRect === 'function'
        ? spec.layoutRect
        : () =>
            anchorRect(win, anchor, width, height, {
              topChrome: 0,
              bottomChrome: 0,
              margin: 16,
            });

    const rect = layoutRect(win);
    await ctx.createSurfacePane(id, {
      entry,
      defaultRect: rect,
      layer: 'hud',
      visibility: 'game-only',
      interactive: 'never',
      reposition(p, w) {
        // Only apply rest rect while in game mode; shell owns well placement.
        if (shell.mode !== 'game') return;
        const next =
          typeof spec.layoutRect === 'function'
            ? spec.layoutRect(w)
            : anchorRect(w, anchor, width, height, {
                topChrome: 0,
                bottomChrome: 0,
                margin: 16,
              });
        p.setRect(next.x, next.y, next.width, next.height);
      },
    });

    if (typeof ctx._markGameOverlayPane === 'function') {
      ctx._markGameOverlayPane(id);
    }

    if (spec.defaultVisible === false) {
      const pane = ctx.getPane(id);
      if (pane) pane.setVisible(false);
    }

    if (shell._gameOverlays) {
      shell._gameOverlays.register({
        pluginId: ctx.id,
        localId: id,
        linkedContribution: spec.linkedContribution || null,
        anchor,
        width,
        height,
        layoutRect,
        wellFit: spec.wellFit === 'stretch' ? 'stretch' : 'natural',
        enabled: spec.defaultVisible !== false,
      });
    }

    const handle = {
      id: `${ctx.id}:${id}`,
      dispose() {
        try {
          if (shell._gameOverlays) shell._gameOverlays.unregister(ctx.id, id);
        } catch (_) {}
        try {
          ctx.destroyPane(id);
        } catch (_) {}
      },
      setRestSize(size = {}) {
        if (typeof shell.setOverlayRestSize === 'function') {
          shell.setOverlayRestSize(ctx.id, id, size);
        }
      },
      setShown(on) {
        if (shell._gameOverlays && typeof shell._gameOverlays.setEnabled === 'function') {
          shell._gameOverlays.setEnabled(ctx.id, id, !!on);
        }
        const pane = ctx.getPane(id);
        if (!on && pane) {
          try { pane.setVisible(false); } catch (_) {}
        }
        if (shell._dock && typeof shell._dock.syncOverlays === 'function') {
          shell._dock.syncOverlays({ animate: false }).catch(() => {});
        }
      },
    };
    return track(handle);
  };

  /**
   * Pin a quick action in the bottom-right socket (max 3 shown).
   */
  ctx.registerAction = function registerAction(spec = {}) {
    if (!spec.id) throw new Error('registerAction: missing id');
    if (typeof shell.registerHotbarAction !== 'function') {
      throw new Error('registerAction: shell socket unavailable');
    }
    const rec = shell.registerHotbarAction({
      id: `${ctx.id}:${spec.id}`,
      label: spec.label || spec.id,
      icon: spec.icon || null,
      badge: spec.badge != null ? spec.badge : null,
      onTap: typeof spec.onTap === 'function' ? spec.onTap : () => {},
    });
    return track(rec);
  };

  /**
   * Subscribe to a shell event. Returned disposable is also dropped by disposeAll.
   * Controller / pad actions are not a shell event plugins can subscribe to.
   */
  ctx.subscribe = function subscribe(event, handler) {
    if (!event || typeof handler !== 'function') {
      throw new Error('subscribe: event and handler required');
    }
    shell.on(event, handler);
    return track(
      disposable(() => {
        shell.off(event, handler);
      })
    );
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
