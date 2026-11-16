'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { configDir } = require('./profile');

const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

function assertName(name) {
  if (typeof name !== 'string' || !NAME_RE.test(name)) {
    throw new Error(`plugin secret name must match ${NAME_RE}`);
  }
}

function secretPath(name) {
  assertName(name);
  return path.join(configDir(), name);
}

function ensureDir() {
  const dir = configDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch (_) {}
  return dir;
}

function readSecret(name) {
  try {
    const p = secretPath(name);
    if (!fs.existsSync(p)) return null;
    const t = fs.readFileSync(p, 'utf8').trim();
    return t || null;
  } catch (_) {
    return null;
  }
}

function writeSecret(name, value) {
  if (!value || typeof value !== 'string') {
    throw new Error('writeSecret: empty value');
  }
  ensureDir();
  const dest = secretPath(name);
  const tmp = `${dest}.tmp`;
  fs.writeFileSync(tmp, value.trim(), { mode: 0o600, flag: 'w' });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, dest);
}

function clearSecret(name) {
  try {
    fs.unlinkSync(secretPath(name));
  } catch (e) {
    if (e && e.code !== 'ENOENT') throw e;
  }
}

/**
 * libsecret lookup. Attributes become `secret-tool lookup k v` pairs.
 * Times out so a locked keyring prompt cannot hang the shell.
 * @param {Record<string, string>} attributes
 * @param {number} [timeoutMs]
 * @returns {Promise<string|null>}
 */
function lookupKeyring(attributes, timeoutMs = 400) {
  const args = ['lookup'];
  for (const [k, v] of Object.entries(attributes || {})) {
    if (!k || v == null) continue;
    args.push(String(k), String(v));
  }
  if (args.length < 3) return Promise.resolve(null);
  return new Promise((resolve) => {
    const child = execFile(
      'secret-tool',
      args,
      {
        timeout: timeoutMs,
        stdio: ['ignore', 'pipe', 'ignore'],
        encoding: 'utf8',
        maxBuffer: 16 * 1024,
      },
      (err, stdout) => {
        if (err || !stdout) {
          resolve(null);
          return;
        }
        const t = String(stdout).trim();
        resolve(t || null);
      }
    );
    child.on('error', () => resolve(null));
  });
}

module.exports = {
  readSecret,
  writeSecret,
  clearSecret,
  lookupKeyring,
  secretPath,
};
