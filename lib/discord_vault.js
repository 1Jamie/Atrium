'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { configDir } = require('./profile');

function vaultDir() {
  return configDir();
}

function tokenPath() {
  return path.join(vaultDir(), 'discord.token');
}

function ensureVaultDir() {
  const dir = vaultDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch (_) {}
  return dir;
}

function readToken() {
  try {
    const p = tokenPath();
    if (!fs.existsSync(p)) return null;
    const t = fs.readFileSync(p, 'utf8').trim();
    return t || null;
  } catch (_) {
    return null;
  }
}

function writeToken(token) {
  if (!token || typeof token !== 'string') {
    throw new Error('writeToken: empty token');
  }
  ensureVaultDir();
  const dest = tokenPath();
  const tmp = `${dest}.tmp`;
  fs.writeFileSync(tmp, token.trim(), { mode: 0o600, flag: 'w' });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, dest);
}

function clearToken() {
  try {
    fs.unlinkSync(tokenPath());
  } catch (e) {
    if (e && e.code !== 'ENOENT') throw e;
  }
}

/**
 * Silent one-shot import from libsecret. Hard 400ms timeout so a locked
 * keyring Prompter cannot hang game mode.
 * @returns {Promise<string|null>}
 */
function trySeedFromKeyring() {
  return new Promise((resolve) => {
    const child = execFile(
      'secret-tool',
      ['lookup', 'service', 'discordo', 'username', 'token'],
      {
        timeout: 400,
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
  readToken,
  writeToken,
  clearToken,
  trySeedFromKeyring,
  tokenPath,
};
