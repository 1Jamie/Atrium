#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ID_RE = /^[a-z0-9-]+$/;

function die(msg) {
  console.error(`install-plugin: ${msg}`);
  process.exit(1);
}

function pluginsDir() {
  const base = process.env.XDG_CONFIG_HOME
    ? process.env.XDG_CONFIG_HOME
    : path.join(os.homedir(), '.config');
  return path.join(base, 'lotus-atrium', 'plugins');
}

function listZip(zip) {
  const r = spawnSync('unzip', ['-Z1', zip], { encoding: 'utf8' });
  if (r.status !== 0) die(`cannot list ${zip}`);
  return r.stdout.split('\n').filter(Boolean);
}

function assertSafeNames(names) {
  for (const name of names) {
    if (name.startsWith('/') || name.includes('\\') || name.split('/').includes('..')) {
      die(`refusing zip member ${name}`);
    }
  }
}

function stageFromDir(dir) {
  const cleanup = fs.mkdtempSync(path.join(os.tmpdir(), 'atrium-plugin-'));
  fs.cpSync(dir, cleanup, {
    recursive: true,
    filter: (src) => path.basename(src) !== '.git',
  });
  return { root: cleanup, cleanup };
}

function stageFromZip(zip) {
  const names = listZip(zip);
  assertSafeNames(names);
  const cleanup = fs.mkdtempSync(path.join(os.tmpdir(), 'atrium-plugin-'));
  const extracted = spawnSync('unzip', ['-q', zip, '-d', cleanup], { stdio: 'inherit' });
  if (extracted.status !== 0) die('unzip failed');
  let root = cleanup;
  const top = fs.readdirSync(cleanup).filter((n) => n !== '__MACOSX');
  if (top.length === 1 && fs.statSync(path.join(cleanup, top[0])).isDirectory()) {
    const inner = path.join(cleanup, top[0], 'plugin.json');
    if (fs.existsSync(inner)) root = path.join(cleanup, top[0]);
  }
  return { root, cleanup };
}

function main() {
  const source = process.argv[2];
  if (!source) die('usage: install-plugin.js <plugin-dir|plugin.zip>');
  if (!fs.existsSync(source)) die(`not found: ${source}`);
  const staged = fs.statSync(source).isDirectory() ? stageFromDir(source) : stageFromZip(source);
  const root = staged.root;
  const manifestPath = path.join(root, 'plugin.json');
  if (!fs.existsSync(manifestPath)) die('zip has no plugin.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (!manifest.id || !ID_RE.test(manifest.id)) die(`id must match ${ID_RE}`);

  const dest = path.join(pluginsDir(), manifest.id);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(root, dest, { recursive: true });
  fs.writeFileSync(path.join(dest, '.atrium-user-plugin'), manifest.id + '\n');
  fs.rmSync(staged.cleanup, { recursive: true, force: true });
  console.log(`install-plugin: ${manifest.id} -> ${dest}`);
}

main();
