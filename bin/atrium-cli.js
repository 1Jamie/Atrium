#!/usr/bin/env node
'use strict';

/**
 * Dev harness for the Atrium tree. Steam still launches ./bin/atrium.
 *
 *   npx atrium-dev <command>
 *   node bin/atrium-cli.js <command>
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const LOTUS = path.resolve(ROOT, '../lotus/packages/lotus-dev/bin/lotus.js');

function die(msg) {
  console.error(`atrium: ${msg}`);
  process.exit(1);
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd || ROOT,
    stdio: 'inherit',
    env: { ...process.env, ...opts.env },
  });
  if (r.error) die(r.error.message);
  process.exit(r.status == null ? 1 : r.status);
}

function help() {
  console.log(`atrium — dev harness (repo: ${ROOT})

  npx atrium-dev run [-- args]          launch the shell (Steam wrapper)
  npx atrium-dev test                    node --test test/*.test.js
  npx atrium-dev pack plugin <dir> [--out zip]
  npx atrium-dev install plugin <dir|zip>  into ~/.config/lotus-atrium/plugins
  npx atrium-dev remove plugin <id>
  npx atrium-dev build                   lotus build --target dir (SEA + sidecars)
  npx atrium-dev installer [out.AppImage]

The Steam command stays ./bin/atrium. This harness does not replace it.
`);
}

function main(argv) {
  const [cmd, sub, ...rest] = argv;
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    help();
    return;
  }

  if (cmd === 'run') {
    run(path.join(ROOT, 'bin', 'atrium'), rest, {
      env: { RUST_LOG: process.env.RUST_LOG || 'info' },
    });
  }

  if (cmd === 'test') {
    const files = rest.length
      ? rest
      : fs.readdirSync(path.join(ROOT, 'test'))
        .filter((name) => name.endsWith('.test.js'))
        .map((name) => path.join('test', name));
    run(process.execPath, ['--test', ...files]);
  }

  if (cmd === 'pack' && sub === 'plugin') {
    if (!rest[0]) die('pack plugin <dir> [--out zip]');
    run(process.execPath, [path.join(ROOT, 'scripts', 'pack-plugin.js'), ...rest]);
  }

  if (cmd === 'install' && sub === 'plugin') {
    if (!rest[0]) die('install plugin <dir|zip>');
    run(process.execPath, [path.join(ROOT, 'scripts', 'install-plugin.js'), rest[0]]);
  }

  if (cmd === 'remove' && sub === 'plugin') {
    if (!rest[0]) die('remove plugin <id>');
    run(path.join(ROOT, 'bin', 'atrium'), ['--remove-plugin', rest[0]]);
  }

  if (cmd === 'build') {
    run(process.execPath, [LOTUS, 'build', '--target', 'dir', ...rest], { cwd: ROOT });
  }

  if (cmd === 'installer') {
    run('bash', [path.join(ROOT, 'scripts', 'mkinstaller.sh'), ...rest]);
  }

  die(`unknown command: ${[cmd, sub].filter(Boolean).join(' ')} (try: npx atrium-dev help)`);
}

main(process.argv.slice(2));
