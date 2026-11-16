'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { createWriteStream } = require('fs');

/** Pinned community AppImage (pkgforge). Bump VERSION + URLs together. */
const VERSION = '1.4.0';
const APPIMAGE_URLS = {
  x64: `https://github.com/pkgforge-dev/ghostty-appimage/releases/download/v${VERSION}/Ghostty-${VERSION}-x86_64.AppImage`,
  arm64: `https://github.com/pkgforge-dev/ghostty-appimage/releases/download/v${VERSION}/Ghostty-${VERSION}-aarch64.AppImage`,
};

function cacheRoot() {
  const xdg = process.env.XDG_CACHE_HOME;
  const base = xdg ? xdg : path.join(os.homedir(), '.cache');
  return path.join(base, 'lotus-atrium', 'ghostty', VERSION);
}

function archKey() {
  const a = process.arch;
  if (a === 'arm64' || a === 'aarch64') return 'arm64';
  return 'x64';
}

function appImageName() {
  return archKey() === 'arm64'
    ? `Ghostty-${VERSION}-aarch64.AppImage`
    : `Ghostty-${VERSION}-x86_64.AppImage`;
}

function paths() {
  const root = cacheRoot();
  return {
    root,
    appImage: path.join(root, appImageName()),
    extractDir: path.join(root, 'squashfs-root'),
    readyMarker: path.join(root, 'READY'),
    downloadTmp: path.join(root, `${appImageName()}.part`),
  };
}

function findGhosttyBinary(extractDir) {
  // AppRun first — pkgforge AppImage needs its wrapper for lib/ path mapping.
  const candidates = [
    path.join(extractDir, 'AppRun'),
    path.join(extractDir, 'bin', 'ghostty'),
    path.join(extractDir, 'usr', 'bin', 'ghostty'),
    path.join(extractDir, 'ghostty'),
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
    } catch (_) {}
  }
  return null;
}

function readReadyBinary() {
  const p = paths();
  try {
    if (!fs.existsSync(p.readyMarker)) return null;
    const bin = fs.readFileSync(p.readyMarker, 'utf8').trim();
    if (bin && fs.existsSync(bin)) return bin;
  } catch (_) {}
  const found = findGhosttyBinary(p.extractDir);
  if (found) {
    try {
      fs.writeFileSync(p.readyMarker, `${found}\n`, { mode: 0o644 });
    } catch (_) {}
    return found;
  }
  return null;
}

/**
 * @param {(ev: { phase: string, message?: string, percent?: number|null }) => void} [onProgress]
 * @returns {Promise<string>} absolute path to ghostty (or AppRun)
 */
let ensurePromise = null;

function ensureGhostty(onProgress) {
  const notify = (ev) => {
    if (typeof onProgress === 'function') {
      try {
        onProgress(ev);
      } catch (_) {}
    }
  };

  const existing = readReadyBinary();
  if (existing) {
    notify({ phase: 'ready', message: 'Ghostty ready', percent: 100 });
    return Promise.resolve(existing);
  }

  if (ensurePromise) return ensurePromise;

  ensurePromise = (async () => {
    const p = paths();
    fs.mkdirSync(p.root, { recursive: true, mode: 0o755 });

    const cached = readReadyBinary();
    if (cached) {
      notify({ phase: 'ready', message: 'Ghostty ready', percent: 100 });
      return cached;
    }

    const url = APPIMAGE_URLS[archKey()];
    if (!url) throw new Error(`ghostty: unsupported arch ${process.arch}`);

    notify({ phase: 'download', message: 'Downloading Ghostty…', percent: 0 });
    await downloadFile(url, p.downloadTmp, (pct) => {
      notify({
        phase: 'download',
        message: pct != null ? `Downloading Ghostty… ${pct}%` : 'Downloading Ghostty…',
        percent: pct,
      });
    });
    fs.renameSync(p.downloadTmp, p.appImage);
    fs.chmodSync(p.appImage, 0o755);

    notify({ phase: 'extract', message: 'Extracting Ghostty…', percent: null });
    await extractAppImage(p.appImage, p.root, p.extractDir);

    const bin = findGhosttyBinary(p.extractDir);
    if (!bin) {
      throw new Error('ghostty: extracted AppImage but no binary found');
    }
    try {
      fs.chmodSync(bin, 0o755);
    } catch (_) {}
    fs.writeFileSync(p.readyMarker, `${bin}\n`, { mode: 0o644 });

    // Drop the packed AppImage once extracted — keeps cache lean.
    try {
      fs.unlinkSync(p.appImage);
    } catch (_) {}

    notify({ phase: 'ready', message: 'Ghostty ready', percent: 100 });
    return bin;
  })().finally(() => {
    ensurePromise = null;
  });

  return ensurePromise;
}

async function downloadFile(url, dest, onPct) {
  const res = await fetch(url, {
    redirect: 'follow',
    headers: { 'User-Agent': 'lotus-atrium-ghostty/1.0' },
  });
  if (!res.ok || !res.body) {
    throw new Error(`ghostty download failed: HTTP ${res.status}`);
  }
  const total = Number(res.headers.get('content-length')) || 0;
  let got = 0;
  let lastPct = -1;
  const tmp = dest;
  fs.mkdirSync(path.dirname(tmp), { recursive: true });
  try {
    fs.unlinkSync(tmp);
  } catch (_) {}

  const out = createWriteStream(tmp, { mode: 0o600 });
  const reader = res.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      got += value.byteLength;
      await new Promise((resolve, reject) => {
        out.write(Buffer.from(value), (err) => (err ? reject(err) : resolve()));
      });
      if (total > 0 && typeof onPct === 'function') {
        const pct = Math.min(99, Math.floor((got / total) * 100));
        if (pct !== lastPct && (pct === 0 || pct === 99 || pct - lastPct >= 5)) {
          lastPct = pct;
          onPct(pct);
        }
      }
    }
    await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
  } catch (e) {
    try {
      out.destroy();
    } catch (_) {}
    try {
      fs.unlinkSync(tmp);
    } catch (_) {}
    throw e;
  }
  if (typeof onPct === 'function') onPct(100);
}

function extractAppImage(appImagePath, workDir, extractDir) {
  return new Promise((resolve, reject) => {
    // Fresh extract — AppImage always writes cwd/squashfs-root.
    try {
      fs.rmSync(extractDir, { recursive: true, force: true });
    } catch (_) {}
    const child = spawn(appImagePath, ['--appimage-extract'], {
      cwd: workDir,
      env: {
        ...process.env,
        APPIMAGE_EXTRACT_AND_RUN: '1',
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let err = '';
    child.stderr.on('data', (d) => {
      err += String(d);
      if (err.length > 4000) err = err.slice(-2000);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`ghostty extract failed (code ${code}): ${err.trim() || 'unknown'}`));
        return;
      }
      if (!fs.existsSync(extractDir)) {
        reject(new Error('ghostty extract: squashfs-root missing'));
        return;
      }
      resolve();
    });
  });
}

/** Chat accent — matches --atrium-accent-chat / data-accent="chat". */
const CHAT_BG = '#080c14';
const CHAT_FG = '#93c5fd';
const CHAT_CURSOR = '#60a5fa';

/**
 * Build argv to run discordo inside Ghostty, maximized / undecorated so the
 * nest drawer acts like a tiled full-bleed terminal surface.
 * Theme bg/fg track the Chat accent so the blit matches the stage chrome.
 */
function ghosttyLaunchArgs(ghosttyBin, discordoBin) {
  return {
    command: ghosttyBin,
    args: [
      '--gtk-single-instance=false',
      '--quit-after-last-window-closed=true',
      '--window-decoration=none',
      // Nest dock sizes the surface — maximize letterboxes inside the pane.
      '--maximize=false',
      '--window-padding-x=0',
      '--window-padding-y=0',
      '--window-padding-balance=false',
      '--class=atrium-discordo',
      `--background=${CHAT_BG}`,
      `--foreground=${CHAT_FG}`,
      `--cursor-color=${CHAT_CURSOR}`,
      '-e',
      discordoBin,
    ],
  };
}

module.exports = {
  VERSION,
  APPIMAGE_URLS,
  cacheRoot,
  paths,
  ensureGhostty,
  readReadyBinary,
  ghosttyLaunchArgs,
  findGhosttyBinary,
};
