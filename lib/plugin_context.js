'use strict';

const path = require('path');
const { pathToFileURL } = require('url');
const { zIndexForLayer } = require('./layers');
const { getPaneRect, setPaneRect, pluginStorage } = require('./profile');
const { clampRect, windowBounds } = require('./bounds');
const { resolveExternalClientOptions } = require('./external_client');
const { installPluginSdk } = require('./plugin_sdk');

/**
 * Build a namespaced PluginContext for one plugin.
 */
function createPluginContext({
  pluginId,
  pluginDir,
  manifest,
  win,
  shell,
  profile,
  Anchor,
}) {
  const panes = new Map(); // localId → { pane, meta }
  const ipcHandlers = new Map();
  const lastIpc = new Map(); // channel → last payload (flushed on reshown)
  const storage = pluginStorage(profile, pluginId);

  function prefixedId(localId) {
    // Discord F9 bridge: allow rawPaneId override (legacy "discord").
    return localId;
  }

  function resolvePaneId(localId, opts = {}) {
    if (opts.rawPaneId) return opts.rawPaneId;
    return `plugin:${pluginId}:${localId}`;
  }

  // Per-frame telemetry must not stampede executeScript (pill+tab × nest Hz).
  // Coalesce to ~1 flush / 32ms; lotus also skips Servo spin on ExecuteScript.
  let statsFlushTimer = null;
  let pendingStats = null;

  function deliverIpcNow(pane, channel, data) {
    if (!pane || typeof pane.executeScript !== 'function') return;
    // Pad Nav/Confirm is hot — emit only via AtriumPlugin (skip duplicate CustomEvent).
    if (channel === 'action') {
      pane.executeScript(
        `window.AtriumPlugin&&window.AtriumPlugin._emit("action",${JSON.stringify(data)});`
      );
      return;
    }
    const full = `plugin:${pluginId}:${channel}`;
    pane.executeScript(`
      window.dispatchEvent(new CustomEvent(${JSON.stringify(full)}, {
        detail: ${JSON.stringify(data)}
      }));
      if (window.AtriumPlugin && typeof window.AtriumPlugin._emit === 'function') {
        window.AtriumPlugin._emit(${JSON.stringify(channel)}, ${JSON.stringify(data)});
      }
    `);
  }

  function flushPendingStats() {
    statsFlushTimer = null;
    const data = pendingStats;
    pendingStats = null;
    if (!data) return;
    for (const { pane } of panes.values()) {
      if (!pane || !pane.visible) continue;
      try {
        deliverIpcNow(pane, 'stats', data);
      } catch (e) {
        ctx.log('stats ipc send failed:', e.message);
      }
    }
  }

  function deliverIpc(pane, channel, data) {
    if (!pane || typeof pane.executeScript !== 'function') return;
    if (channel === 'stats') {
      pendingStats = data;
      if (statsFlushTimer != null) return;
      statsFlushTimer = setTimeout(flushPendingStats, 32);
      return;
    }
    deliverIpcNow(pane, channel, data);
  }

  /** Push cached IPC + wake the surface after hide→show (Servo drops updates while hidden). */
  function flushPaneAfterShow(pane) {
    if (!pane || !pane.visible) return;
    for (const [channel, data] of lastIpc) {
      // Live telemetry resumes on the next frame — replaying last stats via
      // executeScript on every LB/RB tab swap is a major stutter source.
      if (channel === 'stats') continue;
      try {
        deliverIpc(pane, channel, data);
      } catch (e) {
        ctx.log('ipc flush failed:', e.message);
      }
    }
    try {
      pane.executeScript(`window.dispatchEvent(new Event('atrium-pane-shown'));`);
    } catch (_) {}
  }

  function applyModeFlags(pane, meta, mode) {
    if (!pane) return;
    const interactive = meta.interactive || 'overlay-only';
    if (interactive === 'never') {
      pane.setPassthrough(true);
    } else if (interactive === 'overlay-only') {
      pane.setPassthrough(mode === 'game');
    } else {
      pane.setPassthrough(false);
    }
    if (meta.visibility === 'overlay-only') {
      const want = mode === 'game' ? false : !!meta.userVisible;
      // Skip no-op SetPaneVisible — re-entering after Rust F9 caused open↔close flicker.
      const wasVisible = !!pane.visible;
      if (pane.visible !== want) {
        pane.setVisible(want);
      }
      if (want && !wasVisible) {
        flushPaneAfterShow(pane);
      }
    }
  }

  const ctx = {
    id: pluginId,
    dir: pluginDir,
    manifest,
    log(...args) {
      console.log(`[atrium:${pluginId}]`, ...args);
    },
    storage,
    shell,
    ipc: {
      send(channel, data) {
        lastIpc.set(channel, data);
        for (const { pane } of panes.values()) {
          // Never evaluate into a hidden Servo pane — it wedges telemetry until restart.
          if (!pane || !pane.visible) continue;
          try {
            deliverIpc(pane, channel, data);
          } catch (e) {
            ctx.log('ipc send failed:', e.message);
          }
        }
      },
      on(channel, handler) {
        ipcHandlers.set(channel, handler);
      },
    },
    telemetry: {
      onFrameStats(cb) {
        shell._telemetrySubs.push(cb);
      },
    },

    /** Push a toast into the unified atrium notification surface. */
    notify(opts = {}) {
      if (typeof shell.notify !== 'function') {
        ctx.log('notify: shell.notify unavailable');
        return null;
      }
      return shell.notify({ ...opts, source: opts.source || pluginId });
    },

    getPane(localId) {
      const entry = panes.get(localId);
      return entry ? wrapPaneHandle(localId, entry.pane, entry.meta) : null;
    },

    /** Tear down a pane (Servo or external) and drop the plugin handle. */
    destroyPane(localId) {
      const entry = panes.get(localId);
      if (!entry) return;
      try {
        if (typeof entry.pane.remove === 'function') {
          entry.pane.remove();
        } else {
          win.removePane(entry.meta.paneId);
        }
      } catch (e) {
        ctx.log('destroyPane failed:', e.message);
      }
      panes.delete(localId);
    },

    async createSurfacePane(localId, options = {}) {
      const paneId = resolvePaneId(localId, options);
      const layer = options.layer || 'hud';
      const zIndex = zIndexForLayer(layer, options.zIndex);
      const entry = options.entry || (manifest.panes?.[localId]?.entry);
      if (!entry) throw new Error(`createSurfacePane('${localId}'): missing entry`);
      // Prefer lotus-resource:// under the package root so window.lotus mounts
      // (pane→host IPC). file:// is opaque and never gets the bridge.
      const absEntry = path.resolve(pluginDir, entry);
      const pluginRoot = path.resolve(pluginDir);
      if (absEntry !== pluginRoot && !absEntry.startsWith(pluginRoot + path.sep)) {
        throw new Error(`createSurfacePane('${localId}'): entry escapes plugin dir`);
      }
      let surfaceUrl = pathToFileURL(absEntry).href;
      const packageRoot = shell._packageRoot && path.resolve(shell._packageRoot);
      if (packageRoot) {
        const relPlugin = path.relative(packageRoot, pluginRoot);
        if (
          relPlugin &&
          !relPlugin.startsWith('..') &&
          !path.isAbsolute(relPlugin)
        ) {
          const relEntry = entry.split(path.sep).join('/');
          const relDir = relPlugin.split(path.sep).join('/');
          surfaceUrl = `lotus-resource://localhost/${relDir}/${relEntry}`;
        } else {
          ctx.log(
            `createSurfacePane('${localId}'): plugin outside package root, file:// has no lotus IPC`
          );
        }
      }
      // Always size from the live host window — each atrium session (game +
      // resolution) is its own layout; never restore geometry from a prior run.
      const saved = getPaneRect(profile, pluginId, localId);
      const def = options.defaultRect || manifest.panes?.[localId]?.defaultRect || {};
      const rect = clampRect(
        {
          x: def.x ?? 20,
          y: def.y ?? 20,
          width: def.width ?? 280,
          height: def.height ?? 200,
        },
        windowBounds(win)
      );
      const visibility = options.visibility || manifest.panes?.[localId]?.visibility || 'always';
      const interactive =
        options.interactive || manifest.panes?.[localId]?.interactive || 'overlay-only';
      const startVisible =
        visibility === 'overlay-only' ? shell.mode !== 'game' : saved?.visible !== false;

      const pane = win.createPane(paneId, {
        url: surfaceUrl,
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        zIndex,
        anchor: Anchor.None,
        visible: startVisible,
        pointerPassthrough: interactive === 'never',
      });

      // Inject tiny AtriumPlugin bridge into the surface.
      setTimeout(() => {
        try {
          pane.executeScript(`
            (function(){
              if (window.AtriumPlugin) return;
              const _h = {};
              const _pending = [];
              function lotusIpc() {
                return window.lotus?.ipc || window.lotus || null;
              }
              function flushPending() {
                const ipc = lotusIpc();
                if (!ipc || !ipc.send) return;
                while (_pending.length) {
                  const m = _pending.shift();
                  try { ipc.send(m.channel, m.data); } catch (e) {}
                }
              }
              function sendHost(channel, data) {
                const ipc = lotusIpc();
                const payload = {
                  plugin: ${JSON.stringify(pluginId)},
                  channel: channel,
                  data: data
                };
                if (ipc && ipc.send) {
                  ipc.send('atrium-plugin-ipc', payload);
                  return;
                }
                _pending.push({ channel: 'atrium-plugin-ipc', data: payload });
              }
              window.AtriumPlugin = {
                id: ${JSON.stringify(pluginId)},
                pane: ${JSON.stringify(localId)},
                on(ch, fn) { (_h[ch] = _h[ch] || []).push(fn); },
                _emit(ch, data) { (_h[ch] || []).forEach(fn => { try { fn(data); } catch(e){} }); },
                send(ch, data) { sendHost(ch, data); },
                notify(opts) { sendHost('notify', opts || {}); }
              };
              // lotus-resource pages get window.lotus from userscripts; file:// never does.
              let tries = 0;
              const wait = setInterval(function() {
                flushPending();
                if ((lotusIpc() && lotusIpc().send) || ++tries > 50) clearInterval(wait);
              }, 100);
              // Shared Botanical theme + spatial focus helper.
              try {
                if (!document.getElementById('atrium-theme')) {
                  const l = document.createElement('link');
                  l.id = 'atrium-theme';
                  l.rel = 'stylesheet';
                  l.href = 'lotus-resource://localhost/ui/theme.css';
                  document.head.appendChild(l);
                }
                if (!document.getElementById('atrium-focus-js')) {
                  const s = document.createElement('script');
                  s.id = 'atrium-focus-js';
                  s.src = 'lotus-resource://localhost/ui/focus.js';
                  document.head.appendChild(s);
                }
              } catch (e) {}
            })();
          `);
        } catch (_) {}
      }, 200);

      const meta = {
        localId,
        paneId,
        layer,
        visibility,
        interactive,
        userVisible: startVisible,
        reposition: options.reposition,
      };
      panes.set(localId, { pane, meta });
      applyModeFlags(pane, meta, shell.mode);
      return wrapPaneHandle(localId, pane, meta);
    },

    async createExternalPane(localId, options = {}) {
      const paneId = resolvePaneId(localId, options);
      const layer = options.layer || 'drawer';
      const zIndex = zIndexForLayer(layer, options.zIndex);
      // Geometry is always recomputed for this host size (Discord drawer, etc.).
      // Profile only remembers userVisible — not x/y/w/h from another game/res.
      const saved = getPaneRect(profile, pluginId, localId);
      const def = options.defaultRect || {};
      const { x, y, width, height } = clampRect(
        {
          x: def.x ?? 0,
          y: def.y ?? 56,
          width: def.width ?? 400,
          height: def.height ?? 600,
        },
        windowBounds(win)
      );
      const visibility = options.visibility || 'overlay-only';
      const interactive = options.interactive || 'overlay-only';
      const startVisible =
        visibility === 'overlay-only' ? false : saved?.visible !== false;

      const dbus = options.dbus || {};
      const env =
        options.env && typeof options.env === 'object' && !Array.isArray(options.env)
          ? options.env
          : {};
      const clientOpts = resolveExternalClientOptions(
        { ...options, _winForReference: win },
        width,
        height
      );
      const pane = win.createExternalAppPane(paneId, {
        command: options.command,
        args: options.args || [],
        x,
        y,
        width,
        height,
        zIndex,
        anchor: Anchor.None,
        visible: startVisible,
        pointerPassthrough: interactive === 'never',
        clientSizing:
          clientOpts.clientSizing === 'fixed'
            ? { width: clientOpts.clientWidth, height: clientOpts.clientHeight }
            : 'dock',
        clientUpscale: clientOpts.clientUpscale,
        resizable: options.resizable,
        env,
        dbus: {
          notifications: dbus.notifications || 'off',
          notificationApps: Array.isArray(dbus.notificationApps)
            ? dbus.notificationApps
            : [],
        },
      });

      const meta = {
        localId,
        paneId,
        layer,
        visibility,
        interactive,
        userVisible: saved?.visible === true,
        reposition: options.reposition,
        clientSizing: clientOpts.clientSizing,
        clientUpscale: clientOpts.clientUpscale,
      };
      panes.set(localId, { pane, meta });
      applyModeFlags(pane, meta, shell.mode);
      return wrapPaneHandle(localId, pane, meta);
    },

    _applyShellMode(mode) {
      for (const { pane, meta } of panes.values()) {
        applyModeFlags(pane, meta, mode);
      }
    },

    _onWindowResized() {
      for (const { pane, meta } of panes.values()) {
        try {
          if (typeof meta.reposition === 'function') {
            meta.reposition(pane, win);
          } else {
            // Absolute panes without a reposition hook still get clamped.
            const b = windowBounds(win);
            const cur = {
              x: pane._layout?.x ?? 0,
              y: pane._layout?.y ?? 0,
              width: pane._layout?.width ?? b.width,
              height: pane._layout?.height ?? b.height,
            };
            const next = clampRect(cur, b);
            if (
              next.x !== cur.x ||
              next.y !== cur.y ||
              next.width !== cur.width ||
              next.height !== cur.height
            ) {
              pane.setRect(next.x, next.y, next.width, next.height);
            }
          }
        } catch (e) {
          ctx.log('reposition failed:', e.message);
        }
      }
    },

    _handleHostIpc(channel, data) {
      const fn = ipcHandlers.get(channel);
      if (fn) fn(data);
    },
  };

  function wrapPaneHandle(localId, pane, meta) {
    return {
      id: meta.paneId,
      localId,
      get visible() {
        return pane.visible;
      },
      /**
       * Mirror visibility already applied by the host (Rust F9 bridge).
       * Must NOT call pane.setVisible — that re-enters SetPaneVisible and
       * open↔closes Discord on a single keypress.
       */
      syncHostVisible(v) {
        const want = !!v;
        meta.userVisible = want;
        pane.visible = want;
        // F9 / Rust visibility sync — refit drawer to current host size so a
        // profile rect from a larger resolution cannot sit past the right edge.
        if (want && typeof meta.reposition === 'function') {
          try {
            meta.reposition(
              {
                setRect: (x, y, width, height) => {
                  pane.setRect(x, y, width, height);
                  setPaneRect(profile, pluginId, localId, {
                    x,
                    y,
                    width,
                    height,
                    visible: want,
                  });
                },
              },
              win
            );
            return;
          } catch (e) {
            ctx.log('syncHostVisible reposition failed:', e.message);
          }
        }
        setPaneRect(profile, pluginId, localId, {
          x: pane._layout?.x ?? 0,
          y: pane._layout?.y ?? 0,
          width: pane._layout?.width ?? 0,
          height: pane._layout?.height ?? 0,
          visible: want,
        });
      },
      setVisible(v) {
        const wasVisible = !!pane.visible;
        meta.userVisible = !!v;
        // If the user wants it shown while still in game mode, flip to overlay
        // first — otherwise overlay-only panes would be force-hidden and look
        // like "can't open/close Discord".
        if (meta.visibility === 'overlay-only' && meta.userVisible && shell.mode === 'game') {
          shell.setMode('overlay');
        }
        // Refit before show so a 1920-era saved drawer cannot open off-screen
        // on a 1600×900 (or gamescope-absorbed) host.
        if (meta.userVisible && typeof meta.reposition === 'function') {
          try {
            meta.reposition(
              {
                setRect: (x, y, width, height) => {
                  const cur = pane._layout;
                  if (
                    cur &&
                    cur.x === x &&
                    cur.y === y &&
                    cur.width === width &&
                    cur.height === height
                  ) {
                    return;
                  }
                  pane.setRect(x, y, width, height);
                  setPaneRect(profile, pluginId, localId, {
                    x,
                    y,
                    width,
                    height,
                    visible: meta.userVisible,
                  });
                },
              },
              win
            );
          } catch (e) {
            ctx.log('pre-show reposition failed:', e.message);
          }
        }
        if (meta.visibility === 'overlay-only' && shell.mode === 'game') {
          if (pane.visible) pane.setVisible(false);
        } else if (pane.visible !== !!meta.userVisible) {
          pane.setVisible(!!meta.userVisible);
        }
        // Visibility-only dock swaps: update in-memory profile without forcing
        // a geometry rewrite when the rect did not change.
        const lay = pane._layout || {};
        const prev = getPaneRect(profile, pluginId, localId);
        if (
          !prev ||
          prev.visible !== meta.userVisible ||
          prev.x !== (lay.x ?? 0) ||
          prev.y !== (lay.y ?? 0) ||
          prev.width !== (lay.width ?? 0) ||
          prev.height !== (lay.height ?? 0)
        ) {
          setPaneRect(profile, pluginId, localId, {
            x: lay.x ?? 0,
            y: lay.y ?? 0,
            width: lay.width ?? 0,
            height: lay.height ?? 0,
            visible: meta.userVisible,
          });
        }
        if (pane.visible && !wasVisible) {
          flushPaneAfterShow(pane);
        }
      },
      toggleVisibility() {
        const next = !(pane.visible || meta.userVisible);
        this.setVisible(next);
        return next;
      },
      setRect(x, y, width, height) {
        const next = clampRect({ x, y, width, height }, windowBounds(win));
        pane.setRect(next.x, next.y, next.width, next.height);
        setPaneRect(profile, pluginId, localId, {
          x: next.x,
          y: next.y,
          width: next.width,
          height: next.height,
          visible: meta.userVisible,
        });
      },
      setClientSize(width, height) {
        if (meta.clientSizing !== 'fixed' || typeof pane.setClientSize !== 'function') {
          return;
        }
        pane.setClientSize(width, height);
      },
      on() {
        /* WindowCreated deferred */
      },
      raw: pane,
    };
  }

  // Auto-create declarative surface panes from manifest (UI-only / default surfaces).
  // Skip when host uses registerHud/Tab (SDK) for the same localId.
  ctx._autoMountManifestPanes = async () => {
    const decls = manifest.panes || {};
    for (const [localId, decl] of Object.entries(decls)) {
      if (decl.type === 'external') continue;
      if (panes.has(localId)) continue;
      if (decl.sdk === true) continue;
      await ctx.createSurfacePane(localId, {
        entry: decl.entry,
        defaultRect: decl.defaultRect,
        layer: decl.layer || 'hud',
        visibility: decl.visibility,
        interactive: decl.interactive,
      });
    }
  };

  installPluginSdk(ctx);
  return ctx;
}

module.exports = { createPluginContext };
