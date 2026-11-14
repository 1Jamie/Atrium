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

function discordoLaunch() {
  const term = String(process.env.ATRIUM_DISCORD_TERM || 'ptyxis').toLowerCase();
  if (term.includes('weston')) {
    const weston = hostSpawn('/usr/bin/weston-terminal', [`--shell=${DISCORDO}`]);
    if (weston) return weston;
  }
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

  function sendAuth(channel, data) {
    ctx.ipc.send(channel, data);
  }

  function stopAuthSession() {
    if (authSession) {
      authSession.stop({ silent: true });
      authSession = null;
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
    const launch = discordoLaunch();
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
        notificationApps: ['discordo', 'Discord', 'discord', 'com.discordapp.Discord'],
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
    if (localId !== 'app' && localId !== 'auth') return;
    const chatKey = 'discord-sidecar:app';
    const authKey = 'discord-sidecar:auth';
    if (localId === 'auth') {
      await showAuthUi();
      return;
    }
    const chatVisible =
      ctx.shell.mode !== 'game' &&
      ctx.shell.getDockSlot(chatKey) &&
      ctx.getPane('app') &&
      ctx.getPane('app').visible;
    const authVisible = ctx.getPane('auth') && ctx.getPane('auth').visible;
    if (chatVisible || authVisible) {
      if (ctx.getPane('app')) ctx.getPane('app').setVisible(false);
      stopAuthSession();
      if (ctx.getPane('auth')) ctx.getPane('auth').setVisible(false);
      return;
    }
    await ensureDiscord();
  };

  // Pre-register Chat dock when token already exists so F9 / dock work immediately.
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
    }
    return false;
  });

  ctx.log('discord-sidecar active (auth tab → chat pane dock)');
}

async function deactivate(ctx) {
  if (ctx && typeof ctx._offExternalExit === 'function') ctx._offExternalExit();
  if (ctx && typeof ctx.disposeAll === 'function') ctx.disposeAll();
}

module.exports = { activate, deactivate };
