'use strict';

const fs = require('fs');
const path = require('path');
const { ensureCachedAppImage, readReady } = require('./runtime_cache');

/** Pinned community AppImage (pkgforge). Bump VERSION + URLs together. */
const VERSION = '1.4.0';
const APPIMAGE_URLS = {
  x64: `https://github.com/pkgforge-dev/ghostty-appimage/releases/download/v${VERSION}/Ghostty-${VERSION}-x86_64.AppImage`,
  arm64: `https://github.com/pkgforge-dev/ghostty-appimage/releases/download/v${VERSION}/Ghostty-${VERSION}-aarch64.AppImage`,
};

function fileName(arch) {
  return arch === 'arm64'
    ? `Ghostty-${VERSION}-aarch64.AppImage`
    : `Ghostty-${VERSION}-x86_64.AppImage`;
}

function findGhosttyBinary(extractDir) {
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

const SPEC = {
  id: 'ghostty',
  version: VERSION,
  urls: APPIMAGE_URLS,
  fileName,
  findBinary: findGhosttyBinary,
  userAgent: 'lotus-atrium',
};

function ensureGhostty(onProgress) {
  return ensureCachedAppImage(SPEC, onProgress);
}

function readReadyBinary() {
  return readReady(SPEC);
}

/**
 * Run a program inside Ghostty, undecorated, filling the dock slot.
 * Colors and window class come from the caller.
 * @param {string} ghosttyBin
 * @param {string} command program passed to `ghostty -e`
 * @param {{ className?: string, background?: string, foreground?: string, cursor?: string }} [opts]
 */
function ghosttyEmbedArgs(ghosttyBin, command, opts = {}) {
  const args = [
    '--gtk-single-instance=false',
    '--quit-after-last-window-closed=true',
    '--window-decoration=none',
    '--maximize=false',
    '--window-padding-x=0',
    '--window-padding-y=0',
    '--window-padding-balance=false',
    `--class=${opts.className || 'atrium-embed'}`,
  ];
  if (opts.background) args.push(`--background=${opts.background}`);
  if (opts.foreground) args.push(`--foreground=${opts.foreground}`);
  if (opts.cursor) args.push(`--cursor-color=${opts.cursor}`);
  args.push('-e', command);
  return { command: ghosttyBin, args };
}

module.exports = {
  VERSION,
  APPIMAGE_URLS,
  ensureGhostty,
  readReadyBinary,
  ghosttyEmbedArgs,
  findGhosttyBinary,
};
