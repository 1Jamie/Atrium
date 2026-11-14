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
 * Launch ptyxis in standalone mode (-s). Without -s a background Ptyxis D-Bus
 * server can steal the argv and drop the caller's spawn environment (including
 * DISCORDO_TOKEN). Token must live in the nest spawn-env bag, never on cmdline.
 */
function discordoLaunch() {
  const term = String(process.env.ATRIUM_DISCORD_TERM || 'ptyxis').toLowerCase();
  if (term.includes('weston')) {
    const weston = hostSpawn('/usr/bin/weston-terminal', [`--shell=${DISCORDO}`]);
    if (weston) return weston;
  }
  // No `env KEY=VAL` argv — UTF-8 + token come from createExternalPane env.
  // --fullscreen: ask Ptyxis/Adwaita to drop CSD chrome; nest still sizes to the pane.
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
    // 2xx or unexpected non-auth failures: keep vault (caller may still spawn).
    return { ok: res.ok, unauthorized: false, status: res.status };
  } catch (_) {
    // Network timeout / DNS — do not wipe the vault.
    return { ok: true, unauthorized: false, networkError: true };
  } finally {
    clearTimeout(timer);
  }
}

async function activate(ctx) {
  const win = ctx.shell.win;
  const r = discordRect(win);

  if (!fs.existsSync(DISCORDO)) {
    ctx.log(`discordo missing at ${DISCORDO}`);
  }

  let authSession = null;
  let appSpawnedAt = 0;
  let ensuring = null;
  let suppressExitHandler = false;

  const authPane = await ctx.createSurfacePane('auth', {
    entry: 'ui/auth.html',
    defaultRect: r,
    layer: 'drawer',
    zIndex: 650,
    visibility: 'overlay-only',
    interactive: 'overlay-only',
    reposition(p, w) {
      const next = discordRect(w);
      p.setRect(next.x, next.y, next.width, next.height);
    },
  });
  authPane.setVisible(false);

  function sendAuth(channel, data) {
    ctx.ipc.send(channel, data);
  }

  function stopAuthSession() {
    if (authSession) {
      authSession.stop({ silent: true });
      authSession = null;
    }
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
        await showDiscordo(token);
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

  function hideAuth() {
    stopAuthSession();
    try {
      authPane.setVisible(false);
    } catch (_) {}
  }

  function showAuthUi() {
    const app = ctx.getPane('app');
    if (app) {
      try {
        app.setVisible(false);
      } catch (_) {}
    }
    try {
      authPane.setVisible(true);
    } catch (_) {}
    sendAuth('auth-status', { text: 'Preparing QR…' });
    startAuthSession();
  }

  async function ensureAppPane(token) {
    if (ctx.getPane('app')) return ctx.getPane('app');
    const launch = discordoLaunch();
    ctx.log(`discord pane command: ${launch.command} ${launch.args.join(' ')}`);
    await ctx.createExternalPane('app', {
      rawPaneId: 'discord',
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
    appSpawnedAt = Date.now();
    return ctx.getPane('app');
  }

  async function showDiscordo(token) {
    hideAuth();
    const app = await ensureAppPane(token);
    app.setVisible(true);
  }

  async function destroyApp() {
    // Terminating the child races the wait-thread nest:external-exit — ignore it.
    suppressExitHandler = true;
    if (ctx.getPane('app')) {
      ctx.destroyPane('app');
    }
    appSpawnedAt = 0;
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
        showAuthUi();
        return false;
      }

      await showDiscordo(token);
      return true;
    })().finally(() => {
      ensuring = null;
    });
    return ensuring;
  }

  ctx.ipc.on('auth-start', () => {
    if (!authPane.visible) return;
    startAuthSession();
  });
  ctx.ipc.on('auth-cancel', () => {
    hideAuth();
  });

  ctx._onTogglePane = async (localId) => {
    if (localId !== 'app' && localId !== 'auth') return;
    const app = ctx.getPane('app');
    const authVisible = !!authPane.visible;
    const appVisible = !!(app && app.visible);

    if (appVisible || authVisible) {
      hideAuth();
      if (app) app.setVisible(false);
      return;
    }
    await ensureDiscord();
  };

  const onExternalExit = (payload) => {
    if (!payload || payload.pane_id !== 'discord') return;
    if (suppressExitHandler) return;
    const life = Number(payload.lifetime_ms) || 0;
    const code = Number(payload.code);
    ctx.log(`discord child exited code=${code} lifetime_ms=${life}`);
    if (life > 0 && life < EARLY_EXIT_MS && code !== 0) {
      ctx.log('early non-zero exit — clearing vault and showing QR');
      clearToken();
      destroyApp().then(() => {
        if (ctx.shell.mode === 'game') ctx.shell.setMode('overlay');
        showAuthUi();
      });
    } else {
      // Child gone — drop handle so next show respawns with current vault token.
      destroyApp();
    }
  };
  ctx.shell.on('nest:external-exit', onExternalExit);
  ctx._offExternalExit = () => ctx.shell.off('nest:external-exit', onExternalExit);

  ctx.log('discord-sidecar active (QR auth bridge; pane id=discord for F9)');
}

async function deactivate(ctx) {
  if (ctx && typeof ctx._offExternalExit === 'function') ctx._offExternalExit();
}

module.exports = { activate, deactivate };
