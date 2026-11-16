'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { findNativeAddons } = require('../lib/plugin_natives');
const { nativeAbiMismatch, collectPlugins } = require('../lib/plugin_manager');
const { linkOrCopyFile } = require('../lib/profile');

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atrium-pack-'));
}

function testNestedNativeScan() {
  const root = tmp();
  const nm = path.join(root, 'node_modules');
  const deep = path.join(nm, '@scope', 'pkg', 'node_modules', 'bufferutil', 'build', 'Release');
  fs.mkdirSync(deep, { recursive: true });
  fs.writeFileSync(path.join(deep, 'bufferutil.node'), 'x');
  fs.mkdirSync(path.join(nm, 'ws'), { recursive: true });
  fs.writeFileSync(path.join(nm, 'ws', 'index.js'), '');
  const found = findNativeAddons(nm);
  assert.strictEqual(found.length, 1);
  assert.ok(found[0].endsWith(`${path.sep}bufferutil.node`));
  fs.rmSync(root, { recursive: true, force: true });
}

function testAbiCheckBeforeLoad() {
  const prev = process.versions.modules;
  assert.strictEqual(nativeAbiMismatch({ engines: {} }), null);
  assert.strictEqual(nativeAbiMismatch({ engines: { modules: String(prev) } }), null);
  const msg = nativeAbiMismatch({ engines: { modules: '0' } });
  assert.ok(msg && msg.includes('0'));
  assert.ok(msg.includes(String(prev)));
}

function testUserOverrideById() {
  const root = tmp();
  const bundled = path.join(root, 'bundled');
  const user = path.join(root, 'user');
  fs.mkdirSync(path.join(bundled, 'discord-sidecar'), { recursive: true });
  fs.mkdirSync(path.join(user, 'my-discord'), { recursive: true });
  fs.writeFileSync(
    path.join(bundled, 'discord-sidecar', 'plugin.json'),
    JSON.stringify({ id: 'discord', version: '1' })
  );
  fs.writeFileSync(
    path.join(user, 'my-discord', 'plugin.json'),
    JSON.stringify({ id: 'discord', version: '9' })
  );
  fs.writeFileSync(path.join(user, 'my-discord', '.atrium-user-plugin'), 'discord\n');
  const list = collectPlugins(bundled, user);
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].manifest.version, '9');
  assert.ok(list[0].dir.endsWith('my-discord'));
  fs.unlinkSync(path.join(user, 'my-discord', '.atrium-user-plugin'));
  const stale = collectPlugins(bundled, user);
  assert.strictEqual(stale[0].manifest.version, '1');
  fs.rmSync(root, { recursive: true, force: true });
}

function testLinkOrCopy() {
  const root = tmp();
  const src = path.join(root, 'a.txt');
  const dest = path.join(root, 'sub', 'b.txt');
  fs.writeFileSync(src, 'hi');
  linkOrCopyFile(src, dest);
  assert.strictEqual(fs.readFileSync(dest, 'utf8'), 'hi');
  const srcStat = fs.statSync(src);
  const destStat = fs.statSync(dest);
  assert.strictEqual(srcStat.ino, destStat.ino);
  fs.rmSync(root, { recursive: true, force: true });
}

testNestedNativeScan();
testAbiCheckBeforeLoad();
testUserOverrideById();
testLinkOrCopy();
console.log('plugin_packaging.test.js ok');
