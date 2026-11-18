#!/usr/bin/env node
'use strict';

/**
 * Pack a plugin directory into a zip the player can install without npm.
 * Walks node_modules recursively for *.node (scoped + transitive). If any
 * addon is present, rebuilds it with the current Node and stamps
 * engines.modules so the SEA host can refuse a mismatched ABI before dlopen.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { findNativeAddons } = require('../lib/plugin_natives');

const ID_RE = /^[a-z0-9-]+$/;

function die(msg) {
  console.error(`pack-plugin: ${msg}`);
  process.exit(1);
}

function usage() {
  console.error('usage: node scripts/pack-plugin.js <plugin-dir> [--out file.zip]');
  process.exit(2);
}

function parseArgs(argv) {
  const args = argv.slice(2);
  let dir = null;
  let out = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--out') {
      out = args[++i];
      if (!out) usage();
    } else if (!dir) {
      dir = args[i];
    } else usage();
  }
  if (!dir) usage();
  return { dir: path.resolve(dir), out };
}

function run(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit' });
  if (r.status !== 0) die(`${cmd} ${args.join(' ')} failed (${r.status})`);
}

function main() {
  const { dir, out } = parseArgs(process.argv);
  const manifestPath = path.join(dir, 'plugin.json');
  if (!fs.existsSync(manifestPath)) die(`missing ${manifestPath}`);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (!manifest.id || !ID_RE.test(manifest.id)) {
    die(`plugin.json id must match ${ID_RE}`);
  }
  if (!manifest.version) die('plugin.json version is required');

  const pkgPath = path.join(dir, 'package.json');
  if (fs.existsSync(pkgPath)) {
    run('npm', ['install', '--omit=dev', '--ignore-scripts'], dir);
    const addons = findNativeAddons(path.join(dir, 'node_modules'));
    if (addons.length) {
      console.log(`pack-plugin: rebuilding ${addons.length} native addon(s) with node ${process.version} modules=${process.versions.modules}`);
      run('npm', ['rebuild'], dir);
      const still = findNativeAddons(path.join(dir, 'node_modules'));
      if (!still.length) die('native rebuild removed every .node file');
      manifest.engines = manifest.engines || {};
      manifest.engines.modules = String(process.versions.modules);
      manifest.engines.node = process.versions.node;
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
    }
  }

  const dest = out || path.join(dir, `${manifest.id}-${manifest.version}.zip`);
  if (fs.existsSync(dest)) fs.unlinkSync(dest);
  run('zip', [
    '-r', dest, '.',
    '-x', '*.git*',
    '-x', `${path.basename(dest)}`,
    '-x', `${manifest.id}-*.zip`,
    '-x', 'build/Release/*.o',
    '-x', 'build/Release/*.obj',
  ], dir);
  console.log(`pack-plugin: wrote ${dest}`);
}

main();
