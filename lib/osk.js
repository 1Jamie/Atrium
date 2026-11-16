'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

/**
 * Steam's on-screen keyboard, and only inside gamescope.
 * Desktop sessions (GNOME, KDE, a game launched from Steam on the desktop)
 * do not get a keyboard from this button.
 */

function desktop() {
  return String(process.env.XDG_CURRENT_DESKTOP || '').toLowerCase();
}

function isGameMode() {
  const desk = desktop();
  if (desk.includes('gamescope') || desk.includes('steamos')) return true;
  if (process.env.GAMESCOPE_WAYLAND_DISPLAY) return true;
  if (process.env.ATRIUM_GAMEMODE === '1') return true;
  return false;
}

function steamBin() {
  const home = os.homedir();
  const candidates = [
    process.env.STEAM_BIN,
    '/usr/bin/steam',
    '/usr/bin/steam-runtime',
    path.join(home, '.local', 'share', 'Steam', 'steam.sh'),
    path.join(home, '.steam', 'steam', 'steam.sh'),
  ].filter(Boolean);
  for (const bin of candidates) {
    try {
      if (fs.existsSync(bin)) return bin;
    } catch (_) {}
  }
  const which = spawnSync('command', ['-v', 'steam'], { encoding: 'utf8', shell: true });
  const found = String(which.stdout || '').trim().split('\n')[0];
  return found || null;
}

function openSteamKeyboard() {
  const bin = steamBin();
  if (!bin) return false;
  try {
    const child = spawn(bin, ['steam://open/keyboard'], {
      detached: true,
      stdio: 'ignore',
    });
    child.on('error', (err) => {
      console.warn('[atrium] osk: steam launch failed:', err.message);
    });
    child.unref();
    return true;
  } catch (err) {
    console.warn('[atrium] osk: steam launch failed:', err.message);
    return false;
  }
}

function triggerOsk() {
  if (!isGameMode()) {
    console.log('[atrium] osk: not gamescope, leaving the keyboard alone');
    return { target: 'none', active: false };
  }
  if (!steamBin()) {
    console.warn('[atrium] osk: gamescope, but no steam binary to open the keyboard');
    return { target: 'none', active: false };
  }
  if (!openSteamKeyboard()) {
    console.warn('[atrium] osk: gamescope, steam keyboard failed to launch');
    return { target: 'none', active: false };
  }
  console.log('[atrium] osk: gamescope, steam://open/keyboard');
  return { target: 'steam', active: true };
}

module.exports = { triggerOsk, isGameMode };
