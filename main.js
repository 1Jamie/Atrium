#!/usr/bin/env node
/**
 * Lotus Atrium — nested Wayland compositor (gamescope-style Steam wrapper).
 *
 * Steam launch options (gamescope flag polarity):
 *   atrium -- %command%
 *   atrium -w 1280 -h 720 -f -- %command%
 *   atrium -w 1280 -h 720 -W 1920 -H 1080 -- %command%
 *
 * Keys: F12 game↔overlay, F11 fullscreen, F7/F8 dock tabs
 * Plugins: ~/.config/lotus-atrium/plugins (+ in-repo defaults)
 */
const fs = require('fs');
const path = require('path');
const { app } = require('@lotus-gui/core');
const { startShell } = require('./lib/shell');

app.warmup();
app.initVfs();

function usage(exitCode = 0) {
  console.log(`Lotus Atrium — nested compositor (Steam / gamescope-style)

  atrium [options] -- <command> [args...]

Options (same polarity as gamescope):
  -w, -h <n>               Nested game size (default 1920x1080)
  -W, -H <n>               Output / host window size
  -f, --fullscreen         Start lotus window fullscreen
  -r, --refresh <Hz>       Nested refresh hint
  --discord / --no-discord Discord sidecar plugin (default: on)
  --hud                    Start in overlay input mode
  --upscale off|sgsr|fsr1  Host upscaler (overrides per-game profile)
  --sharpen rcas|off       Optional RCAS after upscale/bilinear
  --sgsr-threshold <n>     SGSR edge threshold (0–1 or 0–255)
  --sgsr-sharpness <n>     SGSR edge sharpness (default 2)
  --rcas-sharpness <n>     RCAS stops (0=max, default 0.2)
  --help                   Show this help

Keys: F12 game↔overlay (always) · F7/F8 dock tabs · F11 fullscreen (overlay only)
`);
  process.exit(exitCode);
}

function positiveNum(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function isGameModeSession() {
  if (process.env.ATRIUM_GAMEMODE === '1') return true;
  if (process.env.GAMESCOPE_WAYLAND_DISPLAY) return true;
  const desk = String(process.env.XDG_CURRENT_DESKTOP || '').toLowerCase();
  return desk.includes('gamescope');
}

function absorbLauncherResolution() {
  const pairs = [
    ['ATRIUM_GAME_WIDTH', 'ATRIUM_GAME_HEIGHT'],
    ['WIDTH', 'HEIGHT'],
    ['INTERNAL_WIDTH', 'INTERNAL_HEIGHT'],
    ['SCREEN_WIDTH', 'SCREEN_HEIGHT'],
    ['GAMESCOPE_WIDTH', 'GAMESCOPE_HEIGHT'],
    ['XWAYLAND_WIDTH', 'XWAYLAND_HEIGHT'],
  ];
  for (const [wk, hk] of pairs) {
    const w = positiveNum(process.env[wk]);
    const h = positiveNum(process.env[hk]);
    if (w && h) return { w, h, source: `${wk}/${hk}` };
  }
  return null;
}

function parseArgs(argv) {
  const gameMode = isGameModeSession();
  const absorbed = absorbLauncherResolution();
  const out = {
    command: null,
    args: [],
    discord: process.env.ATRIUM_DISCORD !== '0',
    startHudMode: false,
    fullscreen:
      process.env.ATRIUM_FULLSCREEN === '1' ||
      process.env.ATRIUM_FULLSCREEN === 'true' ||
      (gameMode && process.env.ATRIUM_FULLSCREEN !== '0'),
    gameWidth: absorbed ? absorbed.w : 1920,
    gameHeight: absorbed ? absorbed.h : 1080,
    width: positiveNum(process.env.ATRIUM_WIDTH),
    height: positiveNum(process.env.ATRIUM_HEIGHT),
    refreshHz: positiveNum(process.env.ATRIUM_REFRESH),
    sizeExplicit: !!absorbed,
    sizeSource: absorbed ? absorbed.source : 'default',
    gameMode,
  };

  // node argv is [node, main.js, ...user]. SEA is [host, host, ...user].
  // The extra host path is not always byte-identical to execPath (symlink
  // vs realpath), and it was being taken as the game command.
  let raw = argv.slice(1);
  const selfPath = (() => {
    try { return fs.realpathSync(process.execPath); } catch (_) { return process.execPath; }
  })();
  const isSelf = (p) => {
    if (!p || p.startsWith('-')) return false;
    if (p === process.execPath || p === process.argv[0]) return true;
    if (p.endsWith('/main.js') || p.endsWith('/atrium-host')) return true;
    try { return fs.realpathSync(p) === selfPath; } catch (_) { return false; }
  };
  while (raw.length && isSelf(raw[0])) raw.shift();
  const cmd = [];
  let passthrough = false;

  const takeNum = (i, flag) => {
    const v = raw[i + 1];
    if (v == null || v.startsWith('-')) {
      console.error(`atrium: ${flag} requires a number`);
      usage(1);
    }
    const n = positiveNum(v);
    if (!n) {
      console.error(`atrium: ${flag} invalid number: ${v}`);
      usage(1);
    }
    return n;
  };

  for (let i = 0; i < raw.length; i++) {
    const a = raw[i];
    if (!passthrough) {
      if (a === '--') {
        passthrough = true;
        continue;
      }
      if (a === '--help') usage(0);
      if (a === '--discord') {
        out.discord = true;
        continue;
      }
      if (a === '--no-discord') {
        out.discord = false;
        continue;
      }
      if (a === '--hud') {
        out.startHudMode = true;
        continue;
      }
      if (a === '-f' || a === '--fullscreen') {
        out.fullscreen = true;
        continue;
      }
      // gamescope: -w/-h = nested game, -W/-H = output/host
      if (a === '-w' || a === '--nested-width' || a === '--game-width') {
        out.gameWidth = takeNum(i, a);
        out.sizeExplicit = true;
        out.sizeSource = out.sizeSource === '-h' ? '-w/-h' : '-w';
        i++;
        continue;
      }
      if (a === '-h' || a === '--nested-height' || a === '--game-height') {
        // atrium uses --help for help (gamescope-compatible -h)
        out.gameHeight = takeNum(i, a);
        out.sizeExplicit = true;
        out.sizeSource = out.sizeSource === '-w' ? '-w/-h' : '-h';
        i++;
        continue;
      }
      if (a === '-W' || a === '--output-width' || a === '--width') {
        out.width = takeNum(i, a);
        i++;
        continue;
      }
      if (a === '-H' || a === '--output-height' || a === '--height') {
        out.height = takeNum(i, a);
        i++;
        continue;
      }
      if (a === '-r' || a === '--refresh') {
        out.refreshHz = takeNum(i, a);
        i++;
        continue;
      }
      if (a === '--upscale') {
        out.upscale = raw[++i];
        continue;
      }
      if (a === '--sharpen') {
        out.sharpen = raw[++i];
        continue;
      }
      if (a === '--sgsr-threshold') {
        out.sgsrThreshold = raw[++i];
        continue;
      }
      if (a === '--sgsr-sharpness') {
        out.sgsrSharpness = raw[++i];
        continue;
      }
      if (a === '--sgsr-edge-direction') {
        out.sgsrEdgeDirection = raw[++i] !== '0' && raw[i] !== 'off';
        continue;
      }
      if (a === '--no-sgsr-edge-direction') {
        out.sgsrEdgeDirection = false;
        continue;
      }
      if (a === '--rcas-sharpness') {
        out.rcasSharpness = raw[++i];
        continue;
      }
      if (a.startsWith('-')) {
        console.error(`atrium: unknown option: ${a}`);
        usage(1);
      }
    }
    cmd.push(a);
  }

  if (cmd.length === 0) {
    if (process.env.ATRIUM_APP) {
      out.command = process.env.ATRIUM_APP;
      out.args = process.env.ATRIUM_ARGS
        ? process.env.ATRIUM_ARGS.split(/\s+/).filter(Boolean)
        : [];
    } else {
      out.command = 'glxgears';
      out.args = [];
    }
  } else {
    out.command = cmd[0];
    out.args = cmd.slice(1);
  }

  // Host window size ≠ nested game size. In Game Mode the display/root is the
  // host; -w/-h (and Steam WIDTH/HEIGHT) size the nest / upscale source.
  if (!out.width) {
    out.width = out.gameMode ? 1920 : out.gameWidth;
  }
  if (!out.height) {
    out.height = out.gameMode ? 1080 : out.gameHeight;
  }
  return out;
}

function shortGameLabel(command, args) {
  const base = path.basename(command || '');
  const exe = args.find((a) => /\.exe$/i.test(a));
  if (exe) return path.basename(exe).replace(/\.exe$/i, '');
  if (base === 'proton' || base === 'run' || base === 'env') {
    const next = args.find((a) => a && !a.startsWith('-') && !/=/.test(a) && !/proton/i.test(a));
    if (next) return path.basename(next).replace(/\.exe$/i, '');
  }
  if (process.env.SteamAppId) return `App ${process.env.SteamAppId}`;
  return base || 'game';
}

const cfg = parseArgs(process.argv);
cfg.gameLabel = shortGameLabel(cfg.command, cfg.args);
console.error(`[atrium] parsed command=${cfg.command} args=${cfg.args.length}`);

process.env.ATRIUM_GAME_WIDTH = String(cfg.gameWidth);
process.env.ATRIUM_GAME_HEIGHT = String(cfg.gameHeight);
if (cfg.refreshHz > 0) process.env.ATRIUM_REFRESH = String(cfg.refreshHz);

console.log(
  `[atrium] ${cfg.gameLabel}  nested ${cfg.gameWidth}x${cfg.gameHeight}` +
    `  (size=${cfg.sizeSource})` +
    (cfg.gameMode ? '  gamemode' : '') +
    (cfg.fullscreen ? '  fullscreen' : '')
);

startShell(cfg).catch((err) => {
  console.error('[atrium] shell failed:', err);
  process.exit(1);
});
