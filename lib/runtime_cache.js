'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { createWriteStream } = require('fs');

function cacheBase() {
  const xdg = process.env.XDG_CACHE_HOME;
  const base = xdg ? xdg : path.join(os.homedir(), '.cache');
  return path.join(base, 'lotus-atrium');
}

function archKey() {
  const a = process.arch;
  if (a === 'arm64' || a === 'aarch64') return 'arm64';
  return 'x64';
}

const inflight = new Map();

/**
 * Download an AppImage into ~/.cache/lotus-atrium/<id>/<version>/, extract it,
 * and remember the binary path in a READY file.
 *
 * spec: { id, version, urls: { x64, arm64 }, fileName(arch), findBinary(dir), userAgent }
 * @returns {Promise<string>} absolute path to the extracted binary
 */
function ensureCachedAppImage(spec, onProgress) {
  if (!spec || !spec.id || !spec.version) {
    return Promise.reject(new Error('ensureCachedAppImage: id and version required'));
  }
  const key = `${spec.id}@${spec.version}`;
  const notify = (ev) => {
    if (typeof onProgress !== 'function') return;
    try { onProgress(ev); } catch (_) {}
  };

  const existing = readReady(spec);
  if (existing) {
    notify({ phase: 'ready', message: `${spec.id} ready`, percent: 100 });
    return Promise.resolve(existing);
  }
  if (inflight.has(key)) return inflight.get(key);

  const job = (async () => {
    const p = layout(spec);
    fs.mkdirSync(p.root, { recursive: true, mode: 0o755 });
    const cached = readReady(spec);
    if (cached) {
      notify({ phase: 'ready', message: `${spec.id} ready`, percent: 100 });
      return cached;
    }
    const url = spec.urls && spec.urls[archKey()];
    if (!url) throw new Error(`${spec.id}: unsupported arch ${process.arch}`);

    notify({ phase: 'download', message: `Downloading ${spec.id}…`, percent: 0 });
    await downloadFile(url, p.downloadTmp, spec.userAgent || 'lotus-atrium', (pct) => {
      notify({
        phase: 'download',
        message: pct != null ? `Downloading ${spec.id}… ${pct}%` : `Downloading ${spec.id}…`,
        percent: pct,
      });
    });
    fs.renameSync(p.downloadTmp, p.appImage);
    fs.chmodSync(p.appImage, 0o755);

    notify({ phase: 'extract', message: `Extracting ${spec.id}…`, percent: null });
    await extractAppImage(p.appImage, p.root, p.extractDir, spec.id);

    const bin = spec.findBinary(p.extractDir);
    if (!bin) throw new Error(`${spec.id}: extracted AppImage but no binary found`);
    try { fs.chmodSync(bin, 0o755); } catch (_) {}
    fs.writeFileSync(p.readyMarker, `${bin}\n`, { mode: 0o644 });
    try { fs.unlinkSync(p.appImage); } catch (_) {}
    notify({ phase: 'ready', message: `${spec.id} ready`, percent: 100 });
    return bin;
  })().finally(() => {
    inflight.delete(key);
  });

  inflight.set(key, job);
  return job;
}

function layout(spec) {
  const root = path.join(cacheBase(), spec.id, spec.version);
  const name = spec.fileName(archKey());
  return {
    root,
    appImage: path.join(root, name),
    extractDir: path.join(root, 'squashfs-root'),
    readyMarker: path.join(root, 'READY'),
    downloadTmp: path.join(root, `${name}.part`),
  };
}

function readReady(spec) {
  const p = layout(spec);
  try {
    if (!fs.existsSync(p.readyMarker)) return null;
    const bin = fs.readFileSync(p.readyMarker, 'utf8').trim();
    if (bin && fs.existsSync(bin)) return bin;
  } catch (_) {}
  if (!fs.existsSync(p.extractDir) || typeof spec.findBinary !== 'function') return null;
  const found = spec.findBinary(p.extractDir);
  if (!found) return null;
  try { fs.writeFileSync(p.readyMarker, `${found}\n`, { mode: 0o644 }); } catch (_) {}
  return found;
}

async function downloadFile(url, dest, userAgent, onPct) {
  const res = await fetch(url, {
    redirect: 'follow',
    headers: { 'User-Agent': userAgent },
  });
  if (!res.ok || !res.body) {
    throw new Error(`download failed: HTTP ${res.status}`);
  }
  const total = Number(res.headers.get('content-length')) || 0;
  let got = 0;
  let lastPct = -1;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  try { fs.unlinkSync(dest); } catch (_) {}
  const out = createWriteStream(dest, { mode: 0o600 });
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
    try { out.destroy(); } catch (_) {}
    try { fs.unlinkSync(dest); } catch (_) {}
    throw e;
  }
  if (typeof onPct === 'function') onPct(100);
}

function extractAppImage(appImagePath, workDir, extractDir, id) {
  return new Promise((resolve, reject) => {
    try { fs.rmSync(extractDir, { recursive: true, force: true }); } catch (_) {}
    const child = spawn(appImagePath, ['--appimage-extract'], {
      cwd: workDir,
      env: { ...process.env, APPIMAGE_EXTRACT_AND_RUN: '1' },
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
        reject(new Error(`${id} extract failed (code ${code}): ${err.trim() || 'unknown'}`));
        return;
      }
      if (!fs.existsSync(extractDir)) {
        reject(new Error(`${id} extract: squashfs-root missing`));
        return;
      }
      resolve();
    });
  });
}

module.exports = {
  cacheBase,
  archKey,
  ensureCachedAppImage,
  readReady,
};
