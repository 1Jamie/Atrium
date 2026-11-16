'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const QRCode = require('qrcode');

const { rightDrawerRect } = require('../../lib/bounds');
const {
  readToken,
  writeToken,
  clearToken,
  trySeedFromKeyring,
} = require('../../lib/discord_vault');
const {
  ensureGhostty,
  readReadyBinary,
  ghosttyLaunchArgs,
} = require('../../lib/ghostty_runtime');
const { RemoteAuthSession, DESKTOP_UA_SHORT } = require('./remote_auth');

const DISCORDO = path.join(os.homedir(), '.local', 'bin', 'discordo');
const TOP_CHROME = 56;
const PREFLIGHT_MS = 1500;
const EARLY_EXIT_MS = 3000;
const APP_PANE_ID = 'plugin:discord-sidecar:app';

function discordRect(win) {
  return rightDrawerRect(win, {
    top: TOP_CHROME,
    fraction: 0.38,
    minWidth: 280,
  });
}

function hostSpawn(bin, args) {
  if (fs.existsSync(bin)) {
    return { command: bin, args };
  }
  const hostBin = bin.startsWith('/usr/') ? `/run/host${bin}` : null;
  if (hostBin && fs.existsSync(hostBin) && fs.existsSync('/usr/bin/host-spawn')) {
    return {
      command: '/usr/bin/host-spawn',
      args: [
        '-no-pty',
        '-env',
        'WAYLAND_DISPLAY,GDK_BACKEND,XDG_RUNTIME_DIR,HOME,SDL_VIDEODRIVER,QT_QPA_PLATFORM,LANG,LC_ALL,LC_CTYPE,DBUS_SESSION_BUS_ADDRESS,DISCORDO_TOKEN',
        bin,
        ...args,
      ],
    };
  }
  return null;
}

/**
 * Prefer cached Ghostty → discordo. Explicit ATRIUM_DISCORD_TERM=weston|ptyxis
 * keeps the old host-terminal path for debugging.
 */
function discordoLaunch(ghosttyBin) {
  const term = String(process.env.ATRIUM_DISCORD_TERM || 'ghostty').toLowerCase();
  if (term.includes('weston')) {
    const weston = hostSpawn('/usr/bin/weston-terminal', [`--shell=${DISCORDO}`]);
    if (weston) return weston;
  }
  if (term.includes('ptyxis')) {
    const ptyxisArgs = ['-s', '--fullscreen', '-T', 'Discord', '--', DISCORDO];
    const ptyxis = hostSpawn('/usr/bin/ptyxis', ptyxisArgs);
    if (ptyxis) return ptyxis;
    return { command: 'ptyxis', args: ptyxisArgs };
  }
  if (ghosttyBin) {
    return ghosttyLaunchArgs(ghosttyBin, DISCORDO);
  }
  // Last resort if ensure failed and override wasn't set.
  const ptyxisArgs = ['-s', '--fullscreen', '-T', 'Discord', '--', DISCORDO];
  const ptyxis = hostSpawn('/usr/bin/ptyxis', ptyxisArgs);
  if (ptyxis) return ptyxis;
  return { command: 'ptyxis', args: ptyxisArgs };
}

function spawnEnv(token) {
  const uid = os.userInfo().uid;
  const env = {
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    LC_CTYPE: 'C.UTF-8',
    DBUS_SESSION_BUS_ADDRESS: `unix:path=/run/user/${uid}/bus`,
  };
  if (token) env.DISCORDO_TOKEN = token;
  return env;
}

async function preflightToken(token) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), PREFLIGHT_MS);
  try {
    const res = await fetch('https://discord.com/api/v9/users/@me', {
      method: 'GET',
      headers: {
        Authorization: token,
        'User-Agent': DESKTOP_UA_SHORT,
      },
      signal: ac.signal,
    });
    if (res.status === 401 || res.status === 403) {
      return { ok: false, unauthorized: true };
    }
    return { ok: res.ok, unauthorized: false, status: res.status };
  } catch (_) {
    return { ok: true, unauthorized: false, networkError: true };
  } finally {
    clearTimeout(timer);
  }
}

async function activate(ctx) {
  const win = ctx.shell.win;

  if (!fs.existsSync(DISCORDO)) {
    ctx.log(`discordo missing at ${DISCORDO}`);
  }

  let authSession = null;
  let ensuring = null;
  let suppressExitHandler = false;
  let authTabDisp = null;
  let chatPaneDisp = null;
  let prepTabDisp = null;
  let ghosttyBin = readReadyBinary();
  let ghosttyEnsure = null;

  function sendAuth(channel, data) {
    ctx.ipc.send(channel, data);
  }

  function sendPrep(data) {
    ctx.ipc.send('prep-status', data || {});
  }

  function stopAuthSession() {
    if (authSession) {
      authSession.stop({ silent: true });
      authSession = null;
    }
  }

  function wantGhostty() {
    const term = String(process.env.ATRIUM_DISCORD_TERM || 'ghostty').toLowerCase();
    return !term.includes('weston') && !term.includes('ptyxis');
  }

  /** Kick download/extract without awaiting — never blocks game seat. */
  function beginGhosttyEnsure() {
    if (!wantGhostty()) return null;
    if (ghosttyBin) return Promise.resolve(ghosttyBin);
    if (ghosttyEnsure) return ghosttyEnsure;
    ctx.log('ghostty: ensuring AppImage extract cache…');
    ghosttyEnsure = ensureGhostty((ev) => {
      sendPrep({
        text: ev.message || ev.phase,
        percent: ev.percent == null ? null : ev.percent,
        kind: ev.phase === 'ready' ? 'ok' : '',
      });
    })
      .then((bin) => {
        ghosttyBin = bin;
        ctx.log(`ghostty ready: ${bin}`);
        return bin;
      })
      .catch((e) => {
        ctx.log(`ghostty ensure failed: ${e.message || e}`);
        throw e;
      })
      .finally(() => {
        ghosttyEnsure = null;
      });
    return ghosttyEnsure;
  }

  async function showPreparingUi() {
    if (ctx.getPane('prep')) {
      const pane = ctx.getPane('prep');
      pane.setVisible(true);
      try {
        await ctx.shell.selectDockSlot('discord-sidecar:prep');
      } catch (_) {}
      return pane;
    }
    prepTabDisp = await ctx.registerTab({
      id: 'prep',
      label: 'Discord',
      order: 9,
      entry: 'ui/preparing.html',
      input: { mode: 'spatial', handlesBack: true },
      layoutRect: (w) => discordRect(w),
    });
    try {
      await ctx.shell.selectDockSlot('discord-sidecar:prep');
    } catch (_) {}
    return ctx.getPane('prep');
  }

  async function hidePreparingUi() {
    if (prepTabDisp) {
      try {
        prepTabDisp.dispose();
      } catch (_) {}
      prepTabDisp = null;
    } else if (ctx.getPane('prep')) {
      try {
        ctx.destroyPane('prep');
      } catch (_) {}
      try {
        ctx.shell.removeDockSlot('discord-sidecar:prep');
      } catch (_) {}
    }
  }

  /**
   * Wait for Ghostty when needed. Shows overlay preparing UI if the user is
   * already looking at Discord; otherwise downloads quietly in the background.
   */
  async function resolveGhosttyBin({ showUi } = { showUi: false }) {
    if (!wantGhostty()) return null;
    if (ghosttyBin) return ghosttyBin;
    const pending = beginGhosttyEnsure();
    if (!pending) return null;
    if (showUi) {
      await showPreparingUi();
      sendPrep({ text: 'Checking Ghostty…', percent: null });
    }
    try {
      const bin = await pending;
      if (showUi) await hidePreparingUi();
      return bin;
    } catch (e) {
      if (showUi) {
        sendPrep({
          text: `Ghostty failed — falling back…`,
          kind: 'error',
          percent: null,
        });
        await new Promise((r) => setTimeout(r, 600));
        await hidePreparingUi();
      }
      // Fall through to Ptyxis rather than hard-fail chat.
      return null;
    }
  }

  async function ensureAuthTab() {
    if (ctx.getPane('auth')) return ctx.getPane('auth');
    authTabDisp = await ctx.registerTab({
      id: 'auth',
      label: 'Sign in',
      order: 5,
      entry: 'ui/auth.html',
      input: { mode: 'spatial', handlesBack: true },
      layoutRect: (w) => discordRect(w),
      onFocusChange(focused) {
        if (focused) startAuthSession();
        else stopAuthSession();
      },
    });
    return ctx.getPane('auth');
  }

  async function ensureAppPane(token) {
    if (ctx.getPane('app')) return ctx.getPane('app');
    const bin = await resolveGhosttyBin({ showUi: true });
    const launch = discordoLaunch(bin);
    ctx.log(`discord pane command: ${launch.command} ${launch.args.join(' ')}`);
    await ctx.createExternalPane('app', {
      command: launch.command,
      args: launch.args,
      env: spawnEnv(token),
      defaultRect: discordRect(win),
      resizable: {
        edges: ['left', 'bottom'],
        anchor: 'top-right',
        minWidth: 280,
        minHeight: 120,
      },
      layer: 'drawer',
      visibility: 'overlay-only',
      interactive: 'overlay-only',
      dbus: {
        notifications: 'mirror',
        notificationApps: ['discordo', 'Discord', 'discord', 'com.discordapp.Discord', 'atrium-discordo'],
      },
      reposition(p, w) {
        const next = discordRect(w);
        p.setRect(next.x, next.y, next.width, next.height);
      },
    });
    return ctx.getPane('app');
  }

  async function ensureChatDock(token) {
    if (ctx.shell.getDockSlot('discord-sidecar:app')) {
      await ensureAppPane(token);
      return;
    }
    chatPaneDisp = await ctx.registerPane({
      id: 'app',
      dockEntry: { label: 'Chat', order: 10 },
      input: { mode: 'raw' },
      async ensure() {
        return ensureAppPane(token || readToken());
      },
    });
  }

  async function startAuthSession() {
    stopAuthSession();
    const session = new RemoteAuthSession();
    authSession = session;

    session.on('status', (s) => {
      if (s === 'waiting') sendAuth('auth-status', { text: 'Scan with the Discord mobile app' });
      else if (s === 'connected') sendAuth('auth-status', { text: 'Connected…' });
    });
    session.on('qr', async (url) => {
      try {
        const dataUrl = await QRCode.toDataURL(url, {
          margin: 2,
          width: 280,
          errorCorrectionLevel: 'M',
        });
        sendAuth('auth-qr', { dataUrl, url });
      } catch (e) {
        sendAuth('auth-error', { message: e.message || String(e) });
      }
    });
    session.on('scanned', (user) => {
      sendAuth('auth-scanned', user);
    });
    session.on('token', async (token) => {
      try {
        writeToken(token);
        sendAuth('auth-done', {});
        sendAuth('auth-status', { text: 'Signed in', kind: 'ok' });
        await handoffToChat(token);
      } catch (e) {
        sendAuth('auth-error', { message: e.message || String(e) });
      }
    });
    session.on('error', (err) => {
      sendAuth('auth-error', { message: err.message || String(err) });
    });
    session.on('expired', () => {
      sendAuth('auth-status', { text: 'Code expired — refreshing…' });
    });

    session.start();
  }

  /**
   * Auth success: register/show Chat first, then dispose auth tab so
   * dock clamp lands on Chat (never OOB / dead surface).
   */
  async function handoffToChat(token) {
    stopAuthSession();
    await ensureChatDock(token);
    await ensureAppPane(token);
    await ctx.shell.selectDockSlot('discord-sidecar:app');
    if (authTabDisp) {
      authTabDisp.dispose();
      authTabDisp = null;
    }
  }

  async function showAuthUi() {
    await hidePreparingUi();
    await ensureAuthTab();
    await ctx.shell.selectDockSlot('discord-sidecar:auth');
    sendAuth('auth-status', { text: 'Preparing QR…' });
  }

  async function destroyApp() {
    suppressExitHandler = true;
    if (chatPaneDisp) {
      chatPaneDisp.dispose();
      chatPaneDisp = null;
    } else if (ctx.getPane('app')) {
      ctx.destroyPane('app');
      try {
        ctx.shell.removeDockSlot('discord-sidecar:app');
      } catch (_) {}
    }
    setTimeout(() => {
      suppressExitHandler = false;
    }, 750);
  }

  async function ensureDiscord() {
    if (ensuring) return ensuring;
    ensuring = (async () => {
      if (!readToken()) {
        const seeded = await trySeedFromKeyring();
        if (seeded) {
          try {
            writeToken(seeded);
            ctx.log('seeded discord token from secret-tool');
          } catch (e) {
            ctx.log('keyring seed write failed:', e.message);
          }
        }
      }

      let token = readToken();
      if (token) {
        const check = await preflightToken(token);
        if (check.unauthorized) {
          ctx.log('vault token rejected (401) — clearing');
          clearToken();
          await destroyApp();
          token = null;
        }
      }

      if (!token) {
        await showAuthUi();
        return false;
      }

      // Ensure Ghostty before selecting Chat so F9 doesn't flash an empty dock.
      await resolveGhosttyBin({ showUi: true });
      await ensureChatDock(token);
      await ctx.shell.selectDockSlot('discord-sidecar:app');
      return true;
    })().finally(() => {
      ensuring = null;
    });
    return ensuring;
  }

  ctx.ipc.on('auth-start', () => {
    const auth = ctx.getPane('auth');
    if (!auth || !auth.visible) return;
    startAuthSession();
  });
  ctx.ipc.on('auth-cancel', () => {
    stopAuthSession();
    if (authTabDisp) {
      authTabDisp.dispose();
      authTabDisp = null;
    } else if (ctx.getPane('auth')) {
      ctx.destroyPane('auth');
      try {
        ctx.shell.removeDockSlot('discord-sidecar:auth');
      } catch (_) {}
    }
  });

  // F9 / dock: open Chat if vaulted, else auth tab.
  ctx._onTogglePane = async (localId) => {
    if (localId !== 'app' && localId !== 'auth' && localId !== 'prep') return;
    const chatKey = 'discord-sidecar:app';
    const authKey = 'discord-sidecar:auth';
    if (localId === 'auth') {
      await showAuthUi();
      return;
    }
    if (localId === 'prep') {
      await showPreparingUi();
      beginGhosttyEnsure();
      return;
    }
    const chatVisible =
      ctx.shell.mode !== 'game' &&
      ctx.shell.getDockSlot(chatKey) &&
      ctx.getPane('app') &&
      ctx.getPane('app').visible;
    const authVisible = ctx.getPane('auth') && ctx.getPane('auth').visible;
    const prepVisible = ctx.getPane('prep') && ctx.getPane('prep').visible;
    if (chatVisible || authVisible || prepVisible) {
      if (ctx.getPane('app')) ctx.getPane('app').setVisible(false);
      stopAuthSession();
      if (ctx.getPane('auth')) ctx.getPane('auth').setVisible(false);
      if (ctx.getPane('prep')) ctx.getPane('prep').setVisible(false);
      return;
    }
    await ensureDiscord();
  };

  // Background ensure on plugin init — does not await, does not block game.
  beginGhosttyEnsure();

  // Pre-register Chat dock when token already exists so F9 / dock work immediately.
  // Pane spawn still waits on Ghostty inside ensure().
  if (readToken()) {
    ensureChatDock(readToken()).catch((e) => ctx.log('chat dock seed failed:', e.message));
  }

  const onExternalExit = (payload) => {
    if (!payload || (payload.pane_id !== APP_PANE_ID && payload.pane_id !== 'app')) return;
    if (suppressExitHandler) return;
    const life = Number(payload.lifetime_ms) || 0;
    const code = Number(payload.code);
    ctx.log(`discord child exited code=${code} lifetime_ms=${life}`);
    if (life > 0 && life < EARLY_EXIT_MS && code !== 0) {
      ctx.log('early non-zero exit — clearing vault and showing QR');
      clearToken();
      destroyApp().then(() => showAuthUi());
    } else {
      destroyApp();
    }
  };
  ctx.shell.on('nest:external-exit', onExternalExit);
  ctx._offExternalExit = () => ctx.shell.off('nest:external-exit', onExternalExit);

  ctx.onAction((action) => {
    if (action && action.action === 'Back') {
      const auth = ctx.getPane('auth');
      if (auth && auth.visible) {
        stopAuthSession();
        return true;
      }
      const prep = ctx.getPane('prep');
      if (prep && prep.visible) {
        prep.setVisible(false);
        return true;
      }
    }
    return false;
  });

  ctx.log('discord-sidecar active (ghostty cache → auth tab → chat pane)');
}

async function deactivate(ctx) {
  if (ctx && typeof ctx._offExternalExit === 'function') ctx._offExternalExit();
  if (ctx && typeof ctx.disposeAll === 'function') ctx.disposeAll();
}

module.exports = { activate, deactivate };
