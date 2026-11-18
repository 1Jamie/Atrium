'use strict';

const path = require('path');
const fs = require('fs');
const { EventEmitter } = require('events');
const { ServoWindow, Anchor, ipcMain } = require('@lotus-gui/core');
const {
  ensureConfigLayout,
  loadProfile,
  saveProfile,
  pluginsDir,
  resolveKeybinds,
  composeResourceRoot,
} = require('./profile');
const { loadPlugins, unloadPlugins, collectPlugins, activatePlugin, deactivatePlugin } = require('./plugin_manager');
const { zIndexForLayer } = require('./layers');
const { createDockController } = require('./dock');
const { createGameOverlayController } = require('./game_overlays');
const { computeLayout } = require('./layout');
const { triggerOsk } = require('./osk');
const {
  resolveUpscaleConfig,
  writeProfileGame,
  labelForBadge,
  clampConfig,
} = require('./upscale');

/**
 * Start the Atrium shell: region-owned chrome, game pane, plugin host.
 */
async function startShell(cfg) {
  function packageRoot() {
    if (process.env.ATRIUM_ROOT) return path.resolve(process.env.ATRIUM_ROOT);
    const execDir = path.dirname(process.execPath);
    if (
      fs.existsSync(path.join(execDir, 'ui')) &&
      fs.existsSync(path.join(execDir, 'plugins'))
    ) {
      return execDir;
    }
    return path.join(__dirname, '..');
  }

  const atriumPackageRoot = packageRoot();
  // User plugins (Discord) load Atrium libs from this path. The launcher
  // exports it; node main.js does not.
  process.env.ATRIUM_ROOT = atriumPackageRoot;
  const bundledPluginsDir = path.join(atriumPackageRoot, 'plugins');
  const layout = ensureConfigLayout();
  const profile = loadProfile();
  const pluginList = collectPlugins(bundledPluginsDir, layout.pluginsDir);
  const resourceRoot = composeResourceRoot(
    atriumPackageRoot,
    pluginList.map((p) => ({ id: p.id, dir: p.dir }))
  );

  const shellZ = zIndexForLayer('shell');
  // Stage surface sits under contribution content (drawer 300–699) and under
  // shell chrome (900+). Ghostty/Chat must paint above this backdrop.
  const stageZ = 280;
  const winW = cfg.width || 1280;
  const winH = cfg.height || 720;
    const initialLayout = computeLayout({
    _logicalWidth: winW,
    _logicalHeight: winH,
  });

  const gameLabel = cfg.gameLabel || 'game';

  const win = new ServoWindow({
    id: 'atrium-hud-window',
    root: resourceRoot,
    index: 'ui/status.html',
    width: winW,
    height: winH,
    title: `Atrium — ${gameLabel}`,
    wmClass: 'lotus-atrium',
    frameless: cfg.gameMode,
    transparent: !cfg.gameMode,
    visible: false,
    panes: [
      {
        id: 'main',
        url: 'lotus-resource://localhost/ui/status.html',
        x: initialLayout.regions.header.x,
        y: initialLayout.regions.header.y,
        width: initialLayout.regions.header.width,
        height: initialLayout.regions.header.height,
        zIndex: shellZ,
        visible: !!(cfg.startHudMode),
        anchor: Anchor.None,
        dockOrder: 0,
      },
    ],
    autoResizeMain: false,
  });

  const shellApi = new EventEmitter();
  shellApi.win = win;
  shellApi._packageRoot = atriumPackageRoot;
  shellApi._resourceRoot = resourceRoot;
  shellApi.mode = cfg.startHudMode ? 'overlay' : 'game';
  shellApi._plugins = new Map();
  shellApi._telemetrySubs = [];
  shellApi._buttons = [];
  shellApi._claimedShortcuts = new Map(); // shortcut → pluginId
  shellApi._surfaceSize = null;
  shellApi.footerChrome = 0;
  /** Last input class: 'mouse' | 'keyboard'. Overlay is pointer/keyboard/touch. */
  shellApi.lastInputDevice = 'mouse';
  shellApi._navPane = null;
  shellApi._hotbarPane = null;
  shellApi._pluginsPane = null;
  shellApi._pluginsOpen = false;
  shellApi._footerPane = null;
  shellApi._stagePane = null;
  shellApi._hotbarActions = []; // future pin registry
  shellApi._gameOverlays = createGameOverlayController(shellApi);

  function pinShellChrome() {
    const L = computeLayout(win);
    const show = shellApi.mode !== 'game';
    try {
      const pane = shellApi._stagePane;
      if (pane) {
        const s = L.regions.stage;
        pane.setRect(s.x, s.y, s.width, s.height);
        pane.zIndex = stageZ;
        pane.setVisible(show);
      }
    } catch (e) {
      console.warn('[atrium] pin stage failed:', e.message);
    }
    try {
      const s = L.regions.header;
      win.pane.setRect(s.x, s.y, s.width, s.height);
      win.pane.zIndex = shellZ;
      win.pane.setVisible(show);
    } catch (e) {
      console.warn('[atrium] pin header failed:', e.message);
    }
    try {
      // Footer strip folded into the header — keep any legacy pane hidden.
      const pane = shellApi._footerPane;
      if (pane) pane.setVisible(false);
    } catch (e) {
      console.warn('[atrium] pin footer failed:', e.message);
    }
    try {
      const pane = shellApi._navPane;
      if (pane) {
        const n = L.regions.nav;
        pane.setRect(n.x, n.y, n.width, n.height);
        pane.zIndex = shellZ;
        pane.setVisible(show);
      }
    } catch (e) {
      console.warn('[atrium] pin nav failed:', e.message);
    }
    try {
      const pane = shellApi._hotbarPane;
      if (pane) {
        const h = L.regions.hotbar;
        pane.setRect(h.x, h.y, h.width, h.height);
        pane.zIndex = shellZ;
        pane.setVisible(show);
      }
    } catch (e) {
      console.warn('[atrium] pin hotbar failed:', e.message);
    }
    try {
      const pane = shellApi._pluginsPane;
      if (pane) {
        const c = L.regions.contentFull;
        pane.setRect(c.x, c.y, c.width, c.height);
        pane.zIndex = shellZ;
        pane.setVisible(show && shellApi._pluginsOpen);
      }
    } catch (e) {
      console.warn('[atrium] pin plugins failed:', e.message);
    }
  }

  function pinShellBar() {
    pinShellChrome();
  }

  /** Recompute chrome + plugin panes for the current atrium resolution. */
  function refitOverlays(reason) {
    pinShellChrome();
    for (const { ctx } of shellApi._plugins.values()) {
      try {
        ctx._onWindowResized();
      } catch (e) {
        console.warn('[atrium] overlay refit failed:', e.message);
      }
    }
    if (shellApi._dock && typeof shellApi._dock.syncOverlays === 'function') {
      shellApi._dock.syncOverlays({ animate: false }).catch(() => {});
    }
    if (reason) {
      console.log(
        `[atrium] overlay refit (${reason}) → ${win._logicalWidth || '?'}x${win._logicalHeight || '?'}`
      );
    }
  }
  shellApi.refitOverlays = refitOverlays;
  shellApi.placeContributionPane = (slotKey, pane, w) => {
    if (shellApi._dock && typeof shellApi._dock.placeContributionPane === 'function') {
      shellApi._dock.placeContributionPane(slotKey, pane, w || win);
    }
  };
  shellApi.gameLabel = gameLabel;

  function pluginCatalog() {
    return pluginList
      .map((p) => ({
        id: p.id,
        name: (p.manifest && (p.manifest.name || p.manifest.title)) || p.id,
        version: (p.manifest && p.manifest.version) || '',
        enabled: profile.plugins?.[p.id]?.enabled !== false,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  shellApi.togglePlugins = () => {
    shellApi._pluginsOpen = !shellApi._pluginsOpen;
    if (shellApi.mode === 'game' && shellApi._pluginsOpen) {
      shellApi.setMode('overlay');
      return;
    }
    pinShellChrome();
    pushShellChrome({ immediate: true });
  };

  const upscaleResolved = resolveUpscaleConfig({
    profile,
    gameLabel,
    cli: {
      upscale: cfg.upscale,
      sharpen: cfg.sharpen,
      sgsrThreshold: cfg.sgsrThreshold,
      sgsrSharpness: cfg.sgsrSharpness,
      sgsrEdgeDirection: cfg.sgsrEdgeDirection,
      rcasSharpness: cfg.rcasSharpness,
    },
  });
  shellApi._upscale = upscaleResolved.config;
  shellApi._upscaleSource = upscaleResolved.source;

  shellApi.getUpscale = () => ({ ...shellApi._upscale });
  shellApi.upscaleBadge = () => labelForBadge(shellApi._upscale);
  shellApi.applyUpscale = (partial = {}, opts = {}) => {
    const next = clampConfig({ ...shellApi._upscale, ...partial });
    shellApi._upscale = next;
    try {
      if (typeof win.setHostUpscale !== 'function') {
        console.warn('[atrium] setHostUpscale missing on window — GL upscaler not updated');
      } else {
        win.setHostUpscale(next);
      }
    } catch (e) {
      console.warn('[atrium] setHostUpscale failed:', e.message);
    }
    if (opts.persist !== false) {
      writeProfileGame(profile, gameLabel, next);
      saveProfile(profile);
    }
    shellApi.emit('upscale-changed', next);
    pushShellChrome({ immediate: true });
    return next;
  };

  let _chromePushTimer = null;
  let _oskActive = false;

  function pushShellChromeNow() {
    _chromePushTimer = null;
    const surf = shellApi._surfaceSize || {};
    const stats = shellApi._lastStats || {};
    const hostW = win._logicalWidth || cfg.width || null;
    const hostH = win._logicalHeight || cfg.height || null;
    const active =
      dock.activeSlotIndex >= 0 ? dock.slots[dock.activeSlotIndex] : null;
    const accent =
      typeof dock.accentForSlot === 'function'
        ? dock.accentForSlot(active)
        : 'perf';
    const payload = {
      mode: shellApi.mode,
      fullscreen: !!cfg.fullscreen,
      game: gameLabel,
      accent,
      dock: dock.chromeSlots(),
      nav: dock.navChrome(),
      hotbar: {
        slots: (shellApi._hotbarActions || []).slice(0, 3).map((a) => ({
          id: a.id,
          label: a.label,
          icon: a.icon || null,
          badge: typeof a.badge === 'function' ? a.badge() : a.badge,
        })),
      },
      activeSlotIndex: dock.activeSlotIndex,
      inputDevice: shellApi.lastInputDevice || 'mouse',
      status: {
        width: stats.width || surf.w || cfg.gameWidth || null,
        height: stats.height || surf.h || cfg.gameHeight || null,
        hostWidth: hostW,
        hostHeight: hostH,
        refreshHz: stats.refresh_hz || cfg.refreshHz || null,
        pacing: stats.pacing_policy || null,
        upscale: labelForBadge(shellApi._upscale),
        upscaleMode: shellApi._upscale.mode,
        tabLabel: active ? active.label : null,
        chatConnected:
          accent === 'chat' &&
          !!active &&
          String(active.pluginId || '').includes('discord') &&
          String(active.localId || '') === 'app',
        oskActive: !!_oskActive,
        pluginsOpen: !!shellApi._pluginsOpen,
        clock: new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
      },
      buttons: shellApi._buttons.map((b) => ({
        id: b.id,
        label: b.label,
        shortcut: b.shortcut || null,
        pluginId: b.pluginId || null,
        action: b.action || null,
      })),
    };
    // Lotus pane WS (msgpack) — not evaluate_javascript.
    try {
      if (typeof win.sendToPaneRenderer === 'function') {
        win.sendToPaneRenderer('main', 'atrium-shell-chrome', payload, true);
        if (shellApi._stagePane) {
          win.sendToPaneRenderer('shell_stage', 'atrium-shell-chrome', payload, true);
        }
        if (shellApi._navPane) {
          win.sendToPaneRenderer('shell_nav', 'atrium-shell-chrome', payload, true);
        }
        if (shellApi._hotbarPane) {
          win.sendToPaneRenderer('shell_hotbar', 'atrium-shell-chrome', payload, true);
        }
        if (shellApi._pluginsPane && shellApi._pluginsOpen) {
          win.sendToPaneRenderer('shell_plugins', 'atrium-plugin-manager', {
            plugins: pluginCatalog(),
          }, true);
        }
        // Active contribution (Scaling/Perf) — accent + host dims for pipeline.
        if (active && active.contentKind === 'servo') {
          const entry = shellApi._plugins.get(active.pluginId);
          const pane = entry && entry.ctx.getPane(active.localId);
          const paneId = pane && (pane.id || pane.paneId);
          if (paneId) {
            win.sendToPaneRenderer(paneId, 'atrium-shell-chrome', payload, true);
          }
        }
      } else if (typeof win.sendToRenderer === 'function') {
        win.sendToRenderer('atrium-shell-chrome', payload, true);
      }
    } catch (_) {}
  }

  /** Coalesce dock/status/footer chrome pushes (tab swap + mode flip). */
  function pushShellChrome(opts = {}) {
    if (opts.immediate) {
      if (_chromePushTimer) {
        clearTimeout(_chromePushTimer);
        _chromePushTimer = null;
      }
      pushShellChromeNow();
      return;
    }
    if (_chromePushTimer) return;
    _chromePushTimer = setTimeout(pushShellChromeNow, 32);
  }
  shellApi.pushShellChrome = pushShellChrome;

  const dock = createDockController(shellApi, { pushChrome: pushShellChrome });
  shellApi.addDockSlot = (s) => dock.addDockSlot(s);
  shellApi.updateDockSlot = (key, partial) => dock.updateSlot(key, partial);
  shellApi.setOverlayRestSize = (pluginId, localId, size) => {
    if (shellApi._gameOverlays && typeof shellApi._gameOverlays.setRestSize === 'function') {
      shellApi._gameOverlays.setRestSize(pluginId, localId, size || {});
    }
  };
  shellApi.registerHotbarAction = (action) => {
    if (!action || !action.id) throw new Error('registerHotbarAction: missing id');
    const list = shellApi._hotbarActions;
    const existing = list.findIndex((a) => a.id === action.id);
    if (existing >= 0) list.splice(existing, 1, action);
    else list.push(action);
    pushShellChrome();
    return {
      dispose() {
        const i = list.findIndex((a) => a.id === action.id);
        if (i >= 0) list.splice(i, 1);
        pushShellChrome();
      },
    };
  };
  shellApi.removeDockSlot = (key) => dock.removeDockSlot(key);
  shellApi.selectDockSlot = (key) => dock.selectDockSlot(key);
  shellApi.toggleDockSlot = (key) => dock.toggleDockSlot(key);
  shellApi.cycleDock = (delta) => dock.cycleDock(delta);
  shellApi.focusActiveSlot = () => dock.focusActiveSlot();
  shellApi.getDockSlot = (key) => dock.getSlot(key);
  shellApi.dispatchAction = (a) => dock.dispatchAction(a);
  shellApi._dock = dock;

  shellApi.dropPluginButtons = (pluginId) => {
    shellApi._buttons = (shellApi._buttons || []).filter((b) => {
      if (b.pluginId !== pluginId) return true;
      if (b.shortcut && shellApi._claimedShortcuts.get(b.shortcut) === pluginId) {
        shellApi._claimedShortcuts.delete(b.shortcut);
      }
      return false;
    });
    shellApi._hotbarActions = (shellApi._hotbarActions || []).filter((a) => {
      return !(typeof a.id === 'string' && a.id.startsWith(`${pluginId}:`));
    });
  };

  shellApi.registerButton = (btn) => {
    const id = btn.id || `btn-${shellApi._buttons.length}`;
    const shortcut = btn.shortcut || null;
    if (shortcut) {
      if (shellApi._claimedShortcuts.has(shortcut)) {
        console.warn(
          `[atrium] shortcut ${shortcut} already claimed by ${shellApi._claimedShortcuts.get(shortcut)}; ignoring ${btn.pluginId || 'shell'}`
        );
      } else {
        shellApi._claimedShortcuts.set(shortcut, btn.pluginId || 'shell');
      }
    }
    shellApi._buttons.push({ ...btn, id });
    pushShellChrome();
  };

  function applyOsk(active) {
    _oskActive = !!active;
    try {
      if (typeof win.setOskActive === 'function') win.setOskActive(_oskActive);
    } catch (e) {
      console.warn('[atrium] osk window state failed:', e.message);
    }
  }

  // Header keyboard button. Gamescope + a steam binary opens Steam's keyboard.
  // Anywhere else this is a no-op.
  shellApi.toggleOsk = () => {
    try {
      const result = triggerOsk();
      applyOsk(!!(result && result.active));
    } catch (e) {
      console.warn('[atrium] osk trigger failed:', e.message);
      applyOsk(false);
    }
    pushShellChrome({ immediate: true });
  };
  shellApi.on('osk-toggle', () => {
    shellApi.toggleOsk();
  });

  shellApi.setMode = (mode) => {
    const next = mode === 'edit' ? 'edit' : mode === 'overlay' ? 'overlay' : 'game';
    const changed = next !== shellApi.mode;
    const prev = shellApi.mode;
    shellApi.mode = next;
    if (next === 'game') shellApi._pluginsOpen = false;
    if (next === 'game') applyOsk(false);
    // Always sync rust game_mode. The pad watcher is read-only (Start+Select
    // chord only) and must not be left thinking the overlay still owns input.
    try {
      if (next === 'game') {
        win.setPadKeyForwardPane(null);
        if (typeof win.setPadSpatialFocusPane === 'function') {
          win.setPadSpatialFocusPane(null);
        }
      }
    } catch (_) {}
    win.setGameMode(next === 'game');
    if (!changed) return;
    // Shell chrome is overlay-only — hide completely in game so HUD owns the glass.
    try {
      pinShellChrome();
    } catch (_) {}
    // Re-arm hotkeys: only F12 (toggle-mode) steals keys while the game has focus.
    installHostHotkeys();
    for (const { ctx } of shellApi._plugins.values()) {
      ctx._applyShellMode(next);
    }
    const animateOverlays = prev === 'game' || next === 'game';
    if (next === 'game') {
      dock.hideAllDockSurfaces().catch(() => {});
      dock.syncOverlays({ animate: animateOverlays }).catch(() => {});
    } else if (dock.slots.length && dock.activeSlotIndex < 0) {
      dock.cycleDock(1).catch(() => {});
    } else {
      dock.focusActiveSlot({ animateOverlays }).catch(() => {});
    }
    shellApi.emit('mode-changed', next);
    pushShellChrome();
    profile.mode = next;
    saveProfile(profile);
  };

  shellApi._togglePluginPane = (pluginId, localId) => {
    const slotKey = `${pluginId}:${localId}`;
    if (dock.getSlot(slotKey)) {
      dock.toggleDockSlot(slotKey);
      return;
    }
    const entry = shellApi._plugins.get(pluginId);
    if (!entry) return;
    if (shellApi.mode === 'game') {
      shellApi.setMode('overlay');
    }
    if (typeof entry.ctx._onTogglePane === 'function') {
      try {
        entry.ctx._onTogglePane(localId);
      } catch (e) {
        console.warn(`[atrium] ${pluginId} _onTogglePane failed:`, e.message);
      }
      return;
    }
    const handle = entry.ctx.getPane(localId);
    if (!handle) return;
    handle.toggleVisibility();
  };

  // Unified in-process toast bus. Surfaces/plugins call notify(); the
  // notifications plugin renders. No system D-Bus — atrium-local only.
  let _notifySeq = 1;
  shellApi.notify = (opts = {}) => {
    const id = opts.id || _notifySeq++;
    const payload = {
      id,
      title: String(opts.title || opts.summary || ''),
      body: String(opts.body || ''),
      icon: opts.icon || null,
      urgency: opts.urgency || 'normal', // low | normal | critical
      timeoutMs:
        opts.timeoutMs != null
          ? Number(opts.timeoutMs)
          : opts.urgency === 'critical'
            ? 8000
            : 4500,
      source: opts.source || null,
      actions: Array.isArray(opts.actions) ? opts.actions : [],
      at: Date.now(),
    };
    shellApi.emit('notify', payload);
    return id;
  };

  function toggleFullscreen() {
    // Nested Steam Game Mode already owns the full output — no windowed toggle.
    if (cfg.gameMode) return;
    cfg._fullscreenOn = !cfg._fullscreenOn;
    try {
      win.setFullscreen(!!cfg._fullscreenOn);
    } catch (e) {
      console.warn('[atrium] fullscreen toggle failed:', e.message);
    }
    pushShellChrome();
  }

  function handleHostHotkey(id) {
    if (id === 'toggle-mode') {
      shellApi.dispatchAction({ action: 'ToggleOverlay' });
      return;
    }
    if (id === 'toggle-fullscreen') {
      toggleFullscreen();
      return;
    }
    if (id === 'dock-prev') {
      shellApi.dispatchAction({ action: 'TabPrev' });
      return;
    }
    if (id === 'dock-next') {
      shellApi.dispatchAction({ action: 'TabNext' });
      return;
    }
    if (id === 'dock-back') {
      shellApi.dispatchAction({ action: 'Back' });
      return;
    }
    if (typeof id === 'string' && id.endsWith(':toggle')) {
      const pluginId = id.slice(0, -':toggle'.length);
      const appKey = `${pluginId}:app`;
      const mainKey = `${pluginId}:main`;
      const tabKey = `${pluginId}:tab`;
      if (shellApi.getDockSlot(appKey)) shellApi.toggleDockSlot(appKey);
      else if (shellApi.getDockSlot(tabKey)) shellApi.toggleDockSlot(tabKey);
      else if (shellApi.getDockSlot(mainKey)) shellApi.toggleDockSlot(mainKey);
      else shellApi._togglePluginPane(pluginId, 'app');
    }
  }

  function installHostHotkeys() {
    const binds = resolveKeybinds(profile);
    const gameInput = shellApi.mode === 'game';
    try {
      win.clearHostHotkeys();
    } catch (_) {}
    // Dock chrome stays on F-keys / Escape (see defaultKeybinds) — never KeyQ/KeyE.
    const overlayBinds = {
      ...binds,
      'dock-prev': binds['dock-prev'] || { key: 'F7' },
      'dock-next': binds['dock-next'] || { key: 'F8' },
      'dock-back': binds['dock-back'] || { key: 'Escape' },
    };
    for (const [id, spec] of Object.entries(overlayBinds)) {
      if (!spec || !spec.key) continue;
      if (cfg.gameMode && id === 'toggle-fullscreen') continue;
      // Game input: only F12 (toggle-mode) may consume keys.
      if (gameInput && id !== 'toggle-mode') continue;
      try {
        win.registerHostHotkey({
          id,
          key: spec.key,
          modifiers: spec.modifiers || {},
        });
      } catch (e) {
        console.warn(`[atrium] registerHostHotkey ${id} failed:`, e.message);
      }
    }
  }

  // Built-in mode control (dock slots come from plugins).
  shellApi.registerButton({
    id: 'mode',
    label: 'Game · F12',
    shortcut: 'F12',
    pluginId: 'shell',
    onClick: () => handleHostHotkey('toggle-mode'),
  });
  if (!cfg.gameMode) {
    shellApi.registerButton({
      id: 'fullscreen',
      label: 'Full · F11',
      shortcut: 'F11',
      pluginId: 'shell',
      onClick: () => handleHostHotkey('toggle-fullscreen'),
    });
  }

  win.once('ready-to-show', async () => {
    win.show();
    const L0 = computeLayout(win);
    try {
      const s = L0.regions.stage;
      shellApi._stagePane = win.createPane('shell_stage', {
        url: 'lotus-resource://localhost/ui/stage.html',
        x: s.x,
        y: s.y,
        width: s.width,
        height: s.height,
        zIndex: stageZ,
        visible: shellApi.mode !== 'game',
        anchor: Anchor.None,
        pointerPassthrough: true,
      });
    } catch (e) {
      console.warn('[atrium] shell_stage pane failed:', e.message);
    }
    shellApi._footerPane = null;
    try {
      const n = L0.regions.nav;
      shellApi._navPane = win.createPane('shell_nav', {
        url: 'lotus-resource://localhost/ui/nav.html',
        x: n.x,
        y: n.y,
        width: n.width,
        height: n.height,
        zIndex: shellZ,
        visible: shellApi.mode !== 'game',
        anchor: Anchor.None,
        pointerPassthrough: false,
      });
    } catch (e) {
      console.warn('[atrium] shell_nav pane failed:', e.message);
    }
    try {
      const c = L0.regions.contentFull;
      shellApi._pluginsPane = win.createPane('shell_plugins', {
        url: 'lotus-resource://localhost/ui/plugins.html',
        x: c.x,
        y: c.y,
        width: c.width,
        height: c.height,
        zIndex: shellZ,
        visible: false,
        anchor: Anchor.None,
        pointerPassthrough: false,
      });
    } catch (e) {
      console.warn('[atrium] shell_plugins pane failed:', e.message);
    }
    try {
      const h = L0.regions.hotbar;
      shellApi._hotbarPane = win.createPane('shell_hotbar', {
        url: 'lotus-resource://localhost/ui/hotbar.html',
        x: h.x,
        y: h.y,
        width: h.width,
        height: h.height,
        zIndex: shellZ,
        visible: shellApi.mode !== 'game',
        anchor: Anchor.None,
        pointerPassthrough: false,
      });
    } catch (e) {
      console.warn('[atrium] shell_hotbar pane failed:', e.message);
    }
    pinShellChrome();
    if (!cfg.sizeExplicit) {
      const w = win._logicalWidth || cfg.width;
      const h = win._logicalHeight || cfg.height;
      if (w > 0 && h > 0 && (w !== cfg.gameWidth || h !== cfg.gameHeight)) {
        cfg.gameWidth = w;
        cfg.gameHeight = h;
        process.env.ATRIUM_GAME_WIDTH = String(w);
        process.env.ATRIUM_GAME_HEIGHT = String(h);
        console.log(`[lotus-atrium] absorbed host size ${w}x${h}`);
        pinShellBar();
      }
    }
    if (cfg.fullscreen) {
      try {
        win.setFullscreen(true);
        cfg._fullscreenOn = true;
      } catch (e) {
        console.warn('[lotus-atrium] fullscreen failed:', e.message);
      }
    }

    // Host hotkeys may register before nest is ready (EC3).
    installHostHotkeys();

    // Shell owns the game pane — must be first external pane (primary).
    // createExternalAppPane + setGameMode share the winit FIFO (EC4).
    win.createExternalAppPane('game_surface', {
      command: cfg.command,
      args: cfg.args,
      anchor: Anchor.Fill,
      zIndex: 0,
      visible: true,
    });
    // Re-pin after game docks in — layout churn can stretch main.
    pinShellBar();

    win.setGameMode(shellApi.mode === 'game');

    // Fan-out nest:hotkey + telemetry (+ surface-size refits).
    // Wire IPC before loading plugins so plugin telemetry/stats and hotkeys are active on startup.
    wireWindowIpc(win, shellApi, {
      refitOverlays,
      cfg,
      onHostHotkey: handleHostHotkey,
    });

    const disabled = new Set();
    shellApi._sessionDisabled = disabled;
    if (!cfg.discord) disabled.add('discord-sidecar');

    if (process.env.ATRIUM_NO_PLUGINS === '1') {
      console.log('[atrium] ATRIUM_NO_PLUGINS=1 — skipping all plugins (leak A/B)');
    } else {
      // ATRIUM_ONLY_PLUGIN=id — leak A/B: load just that plugin (comma-separated OK).
      const only = (process.env.ATRIUM_ONLY_PLUGIN || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      if (only.length) {
        for (const id of [
          'discord-sidecar',
          'notifications',
          'perf-hud',
          'scaling-sharpening',
          'static-crosshair',
        ]) {
          if (!only.includes(id)) disabled.add(id);
        }
        console.log(`[atrium] ATRIUM_ONLY_PLUGIN=${only.join(',')} — disabled=${[...disabled].join(',')}`);
      }
      await loadPlugins({
        pluginsDir: layout.pluginsDir,
        bundledDir: bundledPluginsDir,
        win,
        shell: shellApi,
        profile,
        Anchor,
        disabled,
      });
    }
    pinShellBar();

    // Apply resolved upscaler (CLI/env > per-game profile > default). Shaders lazy-link.
    console.log(
      `[atrium] upscale ${shellApi._upscale.mode}` +
        (shellApi._upscale.sharpenRcas ? '+rcas' : '') +
        `  (source=${shellApi._upscaleSource})`
    );
    shellApi.applyUpscale(shellApi._upscale, { persist: false });

    setTimeout(() => {
      pinShellBar();
      pushShellChrome();
    }, 300);
  });

  const onHostResize = (payload) => {
    if (payload && payload.logicalWidth && payload.logicalHeight) {
      win._logicalWidth = payload.logicalWidth;
      win._logicalHeight = payload.logicalHeight;
    } else if (payload && payload.width && payload.height) {
      const scale = win._scaleFactor || 1;
      win._logicalWidth = Math.round(payload.width / scale);
      win._logicalHeight = Math.round(payload.height / scale);
    }
    refitOverlays('host-resize');
  };
  win.on('resized', onHostResize);
  win.on('resize', onHostResize);

  win.on('closed', () => {
    unloadPlugins(shellApi).catch(() => {});
    setTimeout(() => process.exit(0), 400);
  });

  // Lotus ipcMain emits (payload, clientId) — NOT Electron's (event, payload).
  ipcMain.on('set-game-mode', (gameMode) => {
    shellApi.setMode(gameMode ? 'game' : 'overlay');
  });
  ipcMain.on('set-fullscreen', (enabled) => {
    win.setFullscreen(!!enabled);
    cfg._fullscreenOn = !!enabled;
    pushShellChrome();
  });
  let pluginToggleChain = Promise.resolve();
  ipcMain.on('atrium-plugin-enabled', (payload) => {
    const id = payload && payload.id;
    if (typeof id !== 'string' || !/^[a-z0-9-]+$/.test(id)) return;
    const rec = pluginList.find((p) => p.id === id);
    if (!rec) return;
    const enabled = !!payload.enabled;
    pluginToggleChain = pluginToggleChain
      .then(async () => {
        if (!profile.plugins[id]) profile.plugins[id] = { enabled: true, storage: {} };
        profile.plugins[id].enabled = enabled;
        saveProfile(profile, { immediate: true });
        if (enabled) {
          await activatePlugin(rec, {
            win,
            shell: shellApi,
            profile,
            Anchor,
            disabled: shellApi._sessionDisabled || new Set(),
          });
        } else {
          await deactivatePlugin(shellApi, id);
        }
        if (shellApi._dock && typeof shellApi._dock.focusActiveSlot === 'function') {
          await shellApi._dock.focusActiveSlot({ animateOverlays: false });
        }
        pushShellChrome({ immediate: true });
      })
      .catch((e) => {
        console.warn(`[atrium] plugin toggle ${id} failed:`, e.message);
        pushShellChrome({ immediate: true });
      });
  });
  ipcMain.on('atrium-shell-button', (buttonId) => {
    const id = typeof buttonId === 'string' ? buttonId : buttonId?.id;
    if (typeof id === 'string' && id.startsWith('dock:')) {
      shellApi.selectDockSlot(id.slice('dock:'.length));
      return;
    }
    if (id === 'dismiss') {
      shellApi.setMode('game');
      return;
    }
    if (id === 'osk') {
      shellApi.toggleOsk();
      return;
    }
    if (id === 'plugins') {
      shellApi.togglePlugins();
      return;
    }
    if (id === 'nav:prev') {
      dock.navPageDelta(-1).catch(() => {});
      return;
    }
    if (id === 'nav:next') {
      dock.navPageDelta(1).catch(() => {});
      return;
    }
    if (typeof id === 'string' && id.startsWith('hotbar:')) {
      const actionId = id.slice('hotbar:'.length);
      if (actionId === 'plus') {
        shellApi.emit('hotbar-plus');
        return;
      }
      const action = (shellApi._hotbarActions || []).find((a) => a.id === actionId);
      if (action && typeof action.onTap === 'function') {
        try {
          action.onTap();
        } catch (e) {
          console.warn('[atrium] hotbar action failed:', e.message);
        }
      }
      return;
    }
    const btn = shellApi._buttons.find((b) => b.id === id);
    if (btn?.onClick) btn.onClick();
    else if (btn?.action?.startsWith('toggle-pane:') && btn.pluginId) {
      shellApi._togglePluginPane(btn.pluginId, btn.action.slice('toggle-pane:'.length));
    }
  });
  ipcMain.on('atrium-shell-metrics', () => {
    // Region sizes come from lib/layout.js — ignore content-sized metric reports.
  });
  ipcMain.on('atrium-plugin-ipc', (msg) => {
    if (!msg || !msg.plugin) return;
    // Surfaces can push toasts without round-tripping their own host handler.
    if (msg.channel === 'notify' || msg.channel === '__notify') {
      shellApi.notify({ ...(msg.data || {}), source: msg.plugin });
      return;
    }
    const entry = shellApi._plugins.get(msg.plugin);
    if (entry) entry.ctx._handleHostIpc(msg.channel, msg.data);
  });
  ipcMain.on('atrium-notify', (payload) => {
    const p = payload || {};
    // Prefer stable dbus id when the host bridge paired Notify↔return.
    if (p.dbusId != null && p.id == null) {
      p.id = `dbus:${p.dbusId}`;
    }
    shellApi.notify(p);
  });
  ipcMain.on('atrium-notify-closed', (payload) => {
    shellApi.emit('notify-closed', payload || {});
  });
  ipcMain.on('atrium-notify-action', (payload) => {
    shellApi.emit('notify-action', payload || {});
  });
  return { win, shell: shellApi, profile };
}

function wireWindowIpc(win, shellApi, opts = {}) {
  const refitOverlays = opts.refitOverlays || (() => {});
  const cfg = opts.cfg || {};
  const onHostHotkey = opts.onHostHotkey || (() => {});
  // Renderer events arrive on the window; shell.html forwards nest:hotkey / stats to Node.
  ipcMain.on('nest-hotkey', (payload) => {
    const id = payload && payload.id;
    if (id) onHostHotkey(id);
  });
  ipcMain.on('nest-controller-action', (payload) => {
    // Pad is the Start+Select chord only. Anything else is ignored so plugins
    // never see Nav, Confirm, or other controller actions.
    if (!payload || payload.action !== 'ToggleOverlay') return;
    try {
      shellApi.dispatchAction({
        action: 'ToggleOverlay',
        modeHandled: payload.modeHandled,
        gameMode: payload.gameMode,
      });
    } catch (e) {
      console.warn('[atrium] controller-action failed:', e.message);
    }
  });
  ipcMain.on('nest-input-device', (payload) => {
    const device = payload && payload.device;
    // Overlay navigation is pointer and keyboard. Ignore controller as an input class.
    if (device !== 'mouse' && device !== 'keyboard' && device !== 'touch') return;
    if (shellApi.lastInputDevice === device) return;
    shellApi.lastInputDevice = device;
    try {
      if (typeof shellApi.pushShellChrome === 'function') {
        shellApi.pushShellChrome({ immediate: true });
      }
    } catch (_) {}
  });
  ipcMain.on('atrium-forward-stats', (stats) => {
    if (!stats || typeof stats !== 'object') return;
    shellApi._lastStats = stats;
    for (const cb of shellApi._telemetrySubs) {
      try {
        cb(stats);
      } catch (_) {}
    }

    // Nested game buffer size (ATRIUM_GAME_* / Steam game res). Independent of the
    // host window: game is SGSR'd into the Fill pane; overlay HUD stays at host /
    // display resolution. Never resize the lotus window to match the game buffer
    // (that collapsed overlays to 900p when Steam game res ≠ display).
    const sw = Number(stats.width) | 0;
    const sh = Number(stats.height) | 0;
    if (sw < 640 || sh < 360) return;
    const prev = shellApi._surfaceSize;
    if (prev && prev.w === sw && prev.h === sh) return;
    shellApi._surfaceSize = { w: sw, h: sh };
    win._gameSurface = { width: sw, height: sh };
    // Keep nest env in sync if the primary client renegotiated (rare).
    if (sw > 0 && sh > 0) {
      cfg.gameWidth = sw;
      cfg.gameHeight = sh;
      process.env.ATRIUM_GAME_WIDTH = String(sw);
      process.env.ATRIUM_GAME_HEIGHT = String(sh);
    }
    console.log(
      `[atrium] game surface ${sw}x${sh} (host ${win._logicalWidth || '?'}x${win._logicalHeight || '?'})`
    );
  });
  ipcMain.on('atrium-forward-mode', (data) => {
    if (data && data.game_mode !== undefined) {
      const mode = data.game_mode ? 'game' : 'overlay';
      if (mode !== shellApi.mode) {
        shellApi.mode = mode;
        for (const { ctx } of shellApi._plugins.values()) {
          ctx._applyShellMode(mode);
        }
        shellApi.emit('mode-changed', mode);
        pushChromeSafe(win, shellApi);
        refitOverlays('mode-change');
      }
    }
  });
  ipcMain.on('nest-external-exit', (payload) => {
    shellApi.emit('nest:external-exit', payload || {});
  });
}

function pushChromeSafe(win, shellApi) {
  if (typeof shellApi.pushShellChrome === 'function') {
    try {
      shellApi.pushShellChrome();
      return;
    } catch (_) {}
  }
  try {
    const dock = shellApi._dock;
    const payload = {
      mode: shellApi.mode,
      dock: dock ? dock.chromeSlots() : [],
      nav: dock && dock.navChrome ? dock.navChrome() : null,
      activeSlotIndex: dock ? dock.activeSlotIndex : -1,
      buttons: shellApi._buttons.map((b) => ({
        id: b.id,
        label: b.label,
        shortcut: b.shortcut || null,
        pluginId: b.pluginId || null,
        action: b.action || null,
      })),
    };
    if (typeof win.sendToPaneRenderer === 'function') {
      win.sendToPaneRenderer('main', 'atrium-shell-chrome', payload, true);
      if (shellApi._navPane) {
        win.sendToPaneRenderer('shell_nav', 'atrium-shell-chrome', payload, true);
      }
      if (shellApi._hotbarPane) {
        win.sendToPaneRenderer('shell_hotbar', 'atrium-shell-chrome', payload, true);
      }
    } else if (typeof win.sendToRenderer === 'function') {
      win.sendToRenderer('atrium-shell-chrome', payload, true);
    }
  } catch (_) {}
}

module.exports = { startShell };
