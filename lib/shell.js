'use strict';

const path = require('path');
const { EventEmitter } = require('events');
const { ServoWindow, Anchor, ipcMain } = require('@lotus-gui/core');
const {
  TOP_CHROME,
  CHROME_INSET,
  ensureConfigLayout,
  loadProfile,
  saveProfile,
  pluginsDir,
  resolveKeybinds,
} = require('./profile');
const { loadPlugins, unloadPlugins } = require('./plugin_manager');
const { zIndexForLayer } = require('./layers');
const { createDockController } = require('./dock');
const { FOOTER_CHROME } = require('./plugin_sdk');
const {
  resolveUpscaleConfig,
  writeProfileGame,
  labelForBadge,
  clampConfig,
} = require('./upscale');

/**
 * Start the Atrium shell: compact top-bar chrome, game pane, plugin host.
 */
async function startShell(cfg) {
  const bundledPluginsDir = path.join(__dirname, '../plugins');
  const layout = ensureConfigLayout(bundledPluginsDir);
  const profile = loadProfile();

  const gameLabel = cfg.gameLabel || 'game';
  // Window root = atrium package so ui/ + plugins/ load as lotus-resource://
  // (trusted for window.lotus). Do NOT symlink outside the root — lotus
  // canonicalize() rejects those as path traversal and shell/overlays go blank.
  const atriumPackageRoot = path.join(__dirname, '..');

  const shellZ = zIndexForLayer('shell');
  const winW = cfg.width || 1280;
  const winH = cfg.height || 720;

  const win = new ServoWindow({
    id: 'atrium-hud-window',
    root: atriumPackageRoot,
    index: 'ui/shell.html',
    width: winW,
    height: winH,
    title: `Atrium — ${gameLabel}`,
    wmClass: 'lotus-atrium',
    frameless: cfg.gameMode,
    transparent: !cfg.gameMode,
    visible: false,
    // Floating top strip (Anchor.None) — NOT docked. A docked Top+Fill pair was
    // ending up full-window, centering the bar mid-screen and stealing Discord hits.
    panes: [
      {
        id: 'main',
        url: 'lotus-resource://localhost/ui/shell.html',
        x: CHROME_INSET,
        y: CHROME_INSET,
        width: Math.min(420, winW - CHROME_INSET * 2),
        height: TOP_CHROME,
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
  shellApi.mode = cfg.startHudMode ? 'overlay' : 'game';
  shellApi._plugins = new Map();
  shellApi._telemetrySubs = [];
  shellApi._buttons = [];
  shellApi._claimedShortcuts = new Map(); // shortcut → pluginId
  shellApi._surfaceSize = null;
  shellApi.footerChrome = FOOTER_CHROME;
  /** Last input class: 'mouse' | 'keyboard'. Overlay is pointer/keyboard/touch. */
  shellApi.lastInputDevice = 'mouse';
  // Dock island (top-left) + status strip (top-right) — separate panes so the
  // LB/RB capsule stays encapsulated and status sits on the opposite side.
  shellApi._shellBarWidth = Math.min(420, winW);
  shellApi._shellBarHeight = TOP_CHROME;
  shellApi._statusBarWidth = Math.min(520, winW);
  shellApi._statusBarHeight = 40;
  shellApi._footerPane = null;
  shellApi._statusPane = null;

  function pinShellBar() {
    const maxW = win._logicalWidth || cfg.width || winW;
    const maxH = win._logicalHeight || cfg.height || winH;
    const inset = CHROME_INSET;
    const w = Math.max(160, Math.min(maxW - inset * 2, shellApi._shellBarWidth || 420));
    const h = Math.max(TOP_CHROME, shellApi._shellBarHeight || TOP_CHROME);
    try {
      // Floating top-left capsule — inset from edges, fully encapsulated (not flush-docked).
      win.pane.setRect(inset, inset, w, h);
      win.pane.zIndex = shellZ;
    } catch (e) {
      console.warn('[atrium] pinShellBar failed:', e.message);
    }
    pinShellStatus(maxW, maxH);
    pinShellFooter(maxW, maxH);
  }

  function pinShellStatus(maxW, maxH) {
    const pane = shellApi._statusPane;
    if (!pane) return;
    const fw = maxW || win._logicalWidth || cfg.width || winW;
    const inset = CHROME_INSET;
    const w = Math.max(120, Math.min(fw - inset * 2, shellApi._statusBarWidth || 320));
    const h = Math.max(32, Math.min(80, shellApi._statusBarHeight || 40));
    try {
      // Floating top-right capsule — mirrored inset from the dock island.
      pane.setRect(Math.max(inset, fw - inset - w), inset, w, h);
      pane.zIndex = shellZ;
      pane.setVisible(shellApi.mode !== 'game');
    } catch (e) {
      console.warn('[atrium] pinShellStatus failed:', e.message);
    }
  }

  function pinShellFooter(maxW, maxH) {
    const pane = shellApi._footerPane;
    if (!pane) return;
    const fw = maxW || win._logicalWidth || cfg.width || winW;
    const fh = maxH || win._logicalHeight || cfg.height || winH;
    const barH = FOOTER_CHROME;
    try {
      pane.setRect(0, Math.max(0, fh - barH), fw, barH);
      pane.zIndex = shellZ;
      pane.setVisible(shellApi.mode !== 'game');
    } catch (e) {
      console.warn('[atrium] pinShellFooter failed:', e.message);
    }
  }

  /** Recompute Discord/HUD/toast panes for the current atrium resolution. */
  function refitOverlays(reason) {
    pinShellBar();
    for (const { ctx } of shellApi._plugins.values()) {
      try {
        ctx._onWindowResized();
      } catch (e) {
        console.warn('[atrium] overlay refit failed:', e.message);
      }
    }
    if (reason) {
      console.log(
        `[atrium] overlay refit (${reason}) → ${win._logicalWidth || '?'}x${win._logicalHeight || '?'}`
      );
    }
  }
  shellApi.refitOverlays = refitOverlays;
  shellApi.gameLabel = gameLabel;

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

  function pushShellChromeNow() {
    _chromePushTimer = null;
    const surf = shellApi._surfaceSize || {};
    const stats = shellApi._lastStats || {};
    const hostW = win._logicalWidth || cfg.width || null;
    const hostH = win._logicalHeight || cfg.height || null;
    const payload = {
      mode: shellApi.mode,
      fullscreen: !!cfg.fullscreen,
      game: gameLabel,
      dock: dock.chromeSlots(),
      activeSlotIndex: dock.activeSlotIndex,
      footer: dock.footerHints(),
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
    // Lotus pane WS (msgpack) — not evaluate_javascript. Chrome updates are
    // bursty on tab swap; eval retained MozJS arenas the same way plugin IPC did.
    try {
      if (typeof win.sendToPaneRenderer === 'function') {
        win.sendToPaneRenderer('main', 'atrium-shell-chrome', payload, true);
      } else if (typeof win.sendToRenderer === 'function') {
        win.sendToRenderer('atrium-shell-chrome', payload, true);
      }
    } catch (_) {}
    try {
      if (shellApi._statusPane && typeof win.sendToPaneRenderer === 'function') {
        win.sendToPaneRenderer('shell_status', 'atrium-shell-chrome', payload, true);
      }
    } catch (_) {}
    try {
      if (shellApi._footerPane && typeof win.sendToPaneRenderer === 'function') {
        win.sendToPaneRenderer('shell_footer', 'atrium-shell-chrome', payload, true);
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
  shellApi.removeDockSlot = (key) => dock.removeDockSlot(key);
  shellApi.selectDockSlot = (key) => dock.selectDockSlot(key);
  shellApi.toggleDockSlot = (key) => dock.toggleDockSlot(key);
  shellApi.cycleDock = (delta) => dock.cycleDock(delta);
  shellApi.focusActiveSlot = () => dock.focusActiveSlot();
  shellApi.getDockSlot = (key) => dock.getSlot(key);
  shellApi.dispatchAction = (a) => dock.dispatchAction(a);
  shellApi.addActionHandler = (pluginId, handler) => dock.addActionHandler(pluginId, handler);
  shellApi._dock = dock;

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

  shellApi.setMode = (mode) => {
    const next = mode === 'edit' ? 'edit' : mode === 'overlay' ? 'overlay' : 'game';
    const changed = next !== shellApi.mode;
    shellApi.mode = next;
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
      win.pane.setVisible(next !== 'game');
      if (shellApi._statusPane) shellApi._statusPane.setVisible(next !== 'game');
      if (shellApi._footerPane) shellApi._footerPane.setVisible(next !== 'game');
      if (next !== 'game') pinShellBar();
    } catch (_) {}
    // Re-arm hotkeys: only F12 (toggle-mode) steals keys while the game has focus.
    installHostHotkeys();
    for (const { ctx } of shellApi._plugins.values()) {
      ctx._applyShellMode(next);
    }
    if (next === 'game') {
      dock.hideAllDockSurfaces().catch(() => {});
    } else if (dock.slots.length && dock.activeSlotIndex < 0) {
      dock.cycleDock(1).catch(() => {});
    } else {
      dock.focusActiveSlot().catch(() => {});
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
    if (id === 'discord-sidecar:toggle') {
      // Prefer Chat pane; fall back to auth tab.
      if (shellApi.getDockSlot('discord-sidecar:app')) {
        shellApi.toggleDockSlot('discord-sidecar:app');
      } else if (shellApi.getDockSlot('discord-sidecar:auth')) {
        shellApi.toggleDockSlot('discord-sidecar:auth');
      } else {
        shellApi._togglePluginPane('discord-sidecar', 'app');
      }
      return;
    }
    if (id === 'perf-hud:toggle') {
      // F10 toggles glanceable HUD pill; detailed view is a dock tab.
      const entry = shellApi._plugins.get('perf-hud');
      const pill = entry && entry.ctx.getPane('pill');
      if (pill) {
        pill.toggleVisibility();
        return;
      }
      if (shellApi.getDockSlot('perf-hud:tab')) {
        shellApi.toggleDockSlot('perf-hud:tab');
        return;
      }
      shellApi._togglePluginPane('perf-hud', 'main');
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
    const maxW0 = win._logicalWidth || cfg.width || winW;
    const maxH0 = win._logicalHeight || cfg.height || winH;
    // Top-right status capsule — separate floating island from the LB/RB dock.
    try {
      const inset = CHROME_INSET;
      const sw = Math.min(520, maxW0 - inset * 2);
      shellApi._statusPane = win.createPane('shell_status', {
        url: 'lotus-resource://localhost/ui/status.html',
        x: Math.max(inset, maxW0 - inset - sw),
        y: inset,
        width: sw,
        height: 40,
        zIndex: shellZ,
        visible: shellApi.mode !== 'game',
        anchor: Anchor.None,
        pointerPassthrough: true,
      });
    } catch (e) {
      console.warn('[atrium] shell_status pane failed:', e.message);
    }
    // Bottom glyph footer — separate pane so top dock stays content-sized.
    try {
      shellApi._footerPane = win.createPane('shell_footer', {
        url: 'lotus-resource://localhost/ui/footer.html',
        x: 0,
        y: Math.max(0, maxH0 - FOOTER_CHROME),
        width: maxW0,
        height: FOOTER_CHROME,
        zIndex: shellZ,
        visible: shellApi.mode !== 'game',
        anchor: Anchor.None,
        pointerPassthrough: true,
      });
    } catch (e) {
      console.warn('[atrium] shell_footer pane failed:', e.message);
    }
    pinShellBar();
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

    const disabled = new Set();
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

    // Fan-out nest:hotkey + telemetry (+ surface-size refits).
    wireWindowIpc(win, shellApi, {
      refitOverlays,
      cfg,
      onHostHotkey: handleHostHotkey,
    });

    // Smoke the toast bus once plugins are up (surfaces can also AtriumPlugin.notify).
    setTimeout(() => {
      try {
        shellApi.notify({
          title: 'Atrium ready',
          body: 'Unified toasts are live — plugins call ctx.notify().',
          source: 'shell',
          urgency: 'normal',
          timeoutMs: 3500,
        });
      } catch (_) {}
    }, 800);

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
  ipcMain.on('atrium-shell-button', (buttonId) => {
    const id = typeof buttonId === 'string' ? buttonId : buttonId?.id;
    if (typeof id === 'string' && id.startsWith('dock:')) {
      shellApi.selectDockSlot(id.slice('dock:'.length));
      return;
    }
    const btn = shellApi._buttons.find((b) => b.id === id);
    if (btn?.onClick) btn.onClick();
    else if (btn?.action?.startsWith('toggle-pane:') && btn.pluginId) {
      shellApi._togglePluginPane(btn.pluginId, btn.action.slice('toggle-pane:'.length));
    }
  });
  ipcMain.on('atrium-shell-metrics', (metrics) => {
    if (!metrics || typeof metrics !== 'object') return;
    const maxW = win._logicalWidth || cfg.width || winW;
    const kind = metrics.kind === 'status' ? 'status' : 'dock';
    const nextW = Math.ceil(Number(metrics.width) || 0);
    const nextH = Math.ceil(Number(metrics.height) || 0);
    if (nextW < 80) return;
    if (kind === 'status') {
      const w = Math.max(120, Math.min(maxW, nextW + 2));
      const h = Math.max(32, Math.min(80, nextH + 2));
      if (
        Math.abs(w - (shellApi._statusBarWidth || 0)) < 2 &&
        Math.abs(h - (shellApi._statusBarHeight || 0)) < 2
      ) {
        return;
      }
      shellApi._statusBarWidth = w;
      shellApi._statusBarHeight = h;
      pinShellStatus(maxW, win._logicalHeight || cfg.height || winH);
      return;
    }
    const w = Math.max(160, Math.min(maxW, nextW + 2));
    const h = Math.max(TOP_CHROME, Math.min(120, nextH + 2));
    if (
      Math.abs(w - (shellApi._shellBarWidth || 0)) < 2 &&
      Math.abs(h - (shellApi._shellBarHeight || 0)) < 2
    ) {
      return;
    }
    shellApi._shellBarWidth = w;
    shellApi._shellBarHeight = h;
    pinShellBar();
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
    if (!payload || !payload.action) return;
    // Start+Select still arrives here as ToggleOverlay. It does not switch the
    // shell into a controller hint mode.
    try {
      shellApi.dispatchAction(payload);
    } catch (e) {
      console.warn('[atrium] controller-action failed:', e.message);
    }
  });
  ipcMain.on('nest-input-device', (payload) => {
    const device = payload && payload.device;
    if (device !== 'mouse' && device !== 'keyboard' && device !== 'controller') return;
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
  // Prefer the full chrome pusher (includes status + footer) when available.
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
      activeSlotIndex: dock ? dock.activeSlotIndex : -1,
      footer: dock ? dock.footerHints() : [],
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
      if (shellApi._statusPane) {
        win.sendToPaneRenderer('shell_status', 'atrium-shell-chrome', payload, true);
      }
      if (shellApi._footerPane) {
        win.sendToPaneRenderer('shell_footer', 'atrium-shell-chrome', payload, true);
      }
    } else if (typeof win.sendToRenderer === 'function') {
      win.sendToRenderer('atrium-shell-chrome', payload, true);
    }
  } catch (_) {}
}

module.exports = { startShell, TOP_CHROME };
