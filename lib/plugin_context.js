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
  const ipcHandlers = new Map(); // channel → Set<handler>
  const lastIpc = new Map(); // channel → last payload (flushed on reshown)
  const storage = pluginStorage(profile, pluginId);

  function prefixedId(localId) {
    return localId;
  }

  function resolvePaneId(localId, opts = {}) {
    if (opts.rawPaneId) return opts.rawPaneId;
    return `plugin:${pluginId}:${localId}`;
  }

  // Coalesce hot stats onto the Lotus pane WS (msgpack). Never use
  // evaluate_javascript for plugin IPC — Servo retains MozJS arenas under
  // saturation (~14–30MB/min historically). ATRIUM_NO_STATS_IPC still skips.
  const STATS_FLUSH_MS = Number(process.env.ATRIUM_STATS_FLUSH_MS) > 0
    ? Number(process.env.ATRIUM_STATS_FLUSH_MS)
    : 250;
  let statsFlushTimer = null;
  let pendingStats = null;

  function deliverIpcNow(pane, paneId, channel, data) {
    if (!pane || !paneId) return;
    // Track-1 pane WebSocket only — never evaluate_javascript for plugin IPC.
    // (Eval retained MozJS arenas under saturation; tokio/axum WS does not.)
    if (typeof win.sendToPaneRenderer !== 'function') {
      ctx.log('sendToPaneRenderer missing — drop ipc', channel);
      return;
    }
    try {
      win.sendToPaneRenderer(
        paneId,
        'atrium-plugin-host',
        { channel, data },
        channel === 'stats' || channel === 'action'
      );
    } catch (e) {
      ctx.log('pane WS ipc failed:', e.message);
    }
  }

  function flushPendingStats() {
    statsFlushTimer = null;
    const data = pendingStats;
    pendingStats = null;
    if (!data) return;
    for (const { pane, meta } of panes.values()) {
      if (!pane || !pane.visible) continue;
      try {
        deliverIpcNow(pane, meta.paneId, 'stats', data);
      } catch (e) {
        ctx.log('stats ipc send failed:', e.message);
      }
    }
  }

  function deliverIpc(pane, paneId, channel, data) {
    if (!pane) return;
    if (channel === 'stats') {
      if (process.env.ATRIUM_NO_STATS_IPC === '1') return;
      pendingStats = data;
      if (statsFlushTimer != null) return;
      statsFlushTimer = setTimeout(flushPendingStats, STATS_FLUSH_MS);
      return;
    }
    deliverIpcNow(pane, paneId, channel, data);
  }

  /** Push cached IPC + wake the surface after hide→show. */
  function flushPaneAfterShow(pane, paneId) {
    if (!pane || !pane.visible) return;
    for (const [channel, data] of lastIpc) {
      // Live telemetry resumes on the next frame — replaying last stats on
      // every LB/RB tab swap is a stutter source.
      if (channel === 'stats') continue;
      // Ephemeral one-shots — replaying a toast when the game-only surface
      // comes back after closing the overlay looks like "notify on close".
      if (
        channel === 'toast' ||
        channel === 'toast-closed' ||
        channel === 'toast-action' ||
        channel === 'action' ||
        channel === 'notify'
      ) {
        continue;
      }
      try {
        deliverIpc(pane, paneId, channel, data);
      } catch (e) {
        ctx.log('ipc flush failed:', e.message);
      }
    }
    if (paneId && typeof win.sendToPaneRenderer === 'function') {
      try {
        win.sendToPaneRenderer(paneId, 'atrium-pane-shown', {}, true);
        return;
      } catch (_) {}
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
    // Game-only: rest over the game, hidden while the shell overlay is open.
    // Linked overlays are driven by shell._gameOverlays.sync instead.
    if (meta.visibility === 'game-only') {
      if (meta.managedByGameOverlay) return;
      const want = mode === 'game' ? meta.userVisible !== false : false;
      const wasVisible = !!pane.visible;
      if (pane.visible !== want) pane.setVisible(want);
      if (want && !wasVisible) flushPaneAfterShow(pane, meta.paneId);
      return;
    }
    if (meta.visibility === 'overlay-only') {
      const want = mode === 'game' ? false : !!meta.userVisible;
    // Skip no-op SetPaneVisible — a second call flickered the pane open and closed.
      const wasVisible = !!pane.visible;
      if (pane.visible !== want) {
        pane.setVisible(want);
      }
      if (want && !wasVisible) {
        flushPaneAfterShow(pane, meta.paneId);
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
        for (const { pane, meta } of panes.values()) {
          // Never push into a hidden Servo pane — it wedges telemetry until restart.
          if (!pane || !pane.visible) continue;
          try {
            deliverIpc(pane, meta.paneId, channel, data);
          } catch (e) {
            ctx.log('ipc send failed:', e.message);
          }
        }
      },
      on(channel, handler) {
        if (!channel || typeof handler !== 'function') {
          throw new Error('ipc.on: channel and handler required');
        }
        let set = ipcHandlers.get(channel);
        if (!set) {
          set = new Set();
          ipcHandlers.set(channel, set);
        }
        set.add(handler);
        return {
          dispose() {
            set.delete(handler);
            if (set.size === 0) ipcHandlers.delete(channel);
          },
        };
      },
    },
    telemetry: {
      onFrameStats(cb) {
        if (typeof cb !== 'function') {
          throw new Error('onFrameStats: handler required');
        }
        const subs = shell._telemetrySubs;
        subs.push(cb);
        return {
          dispose() {
            const i = subs.indexOf(cb);
            if (i >= 0) subs.splice(i, 1);
          },
        };
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

    _markGameOverlayPane(localId) {
      const entry = panes.get(localId);
      if (entry && entry.meta) entry.meta.managedByGameOverlay = true;
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
      const relEntry = entry.split(path.sep).join('/');
      const surfaceUrl = `lotus-resource://localhost/plugins/${pluginId}/${relEntry}`;
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
      let startVisible;
      if (visibility === 'overlay-only') {
        startVisible = shell.mode !== 'game';
      } else if (visibility === 'game-only') {
        startVisible = shell.mode === 'game' && saved?.visible !== false;
      } else {
        startVisible = saved?.visible !== false;
      }

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

      // Inject AtriumPlugin bridge once. Host→pane traffic uses lotus WS
      // (atrium-plugin-host); evaluate_javascript is only for this bootstrap.
      setTimeout(() => {
        try {
          pane.executeScript(`
            (function(){
              if (window.AtriumPlugin && window.AtriumPlugin._lotusWired) return;
              const _h = window.AtriumPlugin && window.AtriumPlugin._h || {};
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
              function emitHost(ch, data) {
                const fns = _h[ch] || [];
                for (let i = 0; i < fns.length; i++) {
                  try { fns[i](data); } catch (e) {}
                }
                // Hot stats: skip CustomEvent when handlers exist — detail
                // clones retain MozJS arenas under 4–10Hz telemetry.
                // Toast: same — CustomEvent + on() double-fires the stack.
                if ((ch === 'stats' || ch === 'toast') && fns.length) return;
                try {
                  window.dispatchEvent(new CustomEvent(
                    'plugin:' + ${JSON.stringify(pluginId)} + ':' + ch,
                    { detail: data }
                  ));
                } catch (e) {}
              }
              window.AtriumPlugin = {
                id: ${JSON.stringify(pluginId)},
                pane: ${JSON.stringify(localId)},
                _h: _h,
                on(ch, fn) { (_h[ch] = _h[ch] || []).push(fn); },
                _emit(ch, data) { emitHost(ch, data); },
                send(ch, data) { sendHost(ch, data); },
                notify(opts) { sendHost('notify', opts || {}); },
                _lotusWired: false
              };
              function wireLotusHost() {
                const lotus = lotusIpc();
                if (!lotus || typeof lotus.on !== 'function' || window.AtriumPlugin._lotusWired) {
                  return !!(lotus && lotus.send);
                }
                window.AtriumPlugin._lotusWired = true;
                // Eager WS so host→pane msgpack is not stuck in WS_PENDING.
                try {
                  if (typeof lotus._connectWs === 'function') lotus._connectWs();
                } catch (e) {}
                lotus.on('atrium-plugin-host', function(msg) {
                  if (!msg || typeof msg !== 'object') return;
                  emitHost(msg.channel, msg.data);
                });
                lotus.on('atrium-pane-shown', function() {
                  try { window.dispatchEvent(new Event('atrium-pane-shown')); } catch (e) {}
                });
                flushPending();
                return true;
              }
              let tries = 0;
              const wait = setInterval(function() {
                if (wireLotusHost() || ++tries > 50) clearInterval(wait);
              }, 100);
              wireLotusHost();
              // Shared Botanical theme. Touch/pointer only — no spatial pad cursor.
              try {
                if (!document.getElementById('atrium-theme')) {
                  const l = document.createElement('link');
                  l.id = 'atrium-theme';
                  l.rel = 'stylesheet';
                  l.href = 'lotus-resource://localhost/ui/theme.css';
                  document.head.appendChild(l);
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
      const set = ipcHandlers.get(channel);
      if (!set) return;
      for (const fn of set) {
        try {
          fn(data);
        } catch (e) {
          ctx.log('ipc handler failed:', e.message);
        }
      }
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
       * Mirror visibility already applied by the host.
       * Must NOT call pane.setVisible — that re-enters SetPaneVisible.
       */
      syncHostVisible(v) {
        const want = !!v;
        meta.userVisible = want;
        pane.visible = want;
        // Host visibility sync — refit the drawer to the current host size so a
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
          flushPaneAfterShow(pane, meta.paneId);
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
  // Skip when the host already registered this id through the SDK.
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
