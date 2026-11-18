'use strict';

const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');
const { createPluginContext } = require('./plugin_context');
const { resetLayerCounters } = require('./layers');

const PLUGIN_ID_RE = /^[a-z0-9-]+$/;

/**
 * @param {string} root
 * @returns {Array<{ name: string, dir: string, manifestPath: string, manifest: object, id: string }>}
 */
function readPluginDir(root) {
  const out = [];
  if (!root || !fs.existsSync(root)) return out;
  for (const name of fs.readdirSync(root)) {
    const dir = path.join(root, name);
    let st;
    try {
      st = fs.statSync(dir);
    } catch (_) {
      continue;
    }
    if (!st.isDirectory()) continue;
    const manifestPath = path.join(dir, 'plugin.json');
    if (!fs.existsSync(manifestPath)) continue;
    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch (e) {
      console.warn(`[atrium] skip plugin ${name}: bad plugin.json (${e.message})`);
      continue;
    }
    const id = String(manifest.id || name);
    if (!PLUGIN_ID_RE.test(id)) {
      console.warn(`[atrium] skip plugin ${name}: id must match ${PLUGIN_ID_RE}`);
      continue;
    }
    out.push({ name, dir, manifestPath, manifest, id });
  }
  return out;
}

/** Written by `atrium-dev install plugin`. Old auto-copies in config lack this. */
const USER_PLUGIN_MARK = '.atrium-user-plugin';

function isExplicitUserPlugin(dir) {
  return fs.existsSync(path.join(dir, USER_PLUGIN_MARK));
}

/**
 * Bundled plugins load from the package. A config copy overrides the same id
 * only when it was installed on purpose (marker file). Leftover copies from
 * the old ensureConfigLayout mirror are ignored — those still call registerTab
 * and launch Flatpak Discord.
 */
function collectPlugins(bundledDir, pluginsDir) {
  const byId = new Map();
  for (const rec of readPluginDir(bundledDir)) byId.set(rec.id, rec);
  if (pluginsDir && path.resolve(pluginsDir) !== path.resolve(bundledDir || '')) {
    for (const rec of readPluginDir(pluginsDir)) {
      if (byId.has(rec.id) && !isExplicitUserPlugin(rec.dir)) {
        console.warn(
          `[atrium] ignoring ${rec.dir} (stale copy of bundled ${rec.id})`
        );
        continue;
      }
      byId.set(rec.id, rec);
    }
  }
  return [...byId.values()];
}

function nativeAbiMismatch(manifest) {
  const want = manifest && manifest.engines && manifest.engines.modules;
  if (want == null || want === '') return null;
  const have = String(process.versions.modules);
  if (String(want) !== have) {
    return `native ABI modules ${want} != runtime ${have}`;
  }
  return null;
}

/**
 * Discover + activate atrium plugins from a plugins directory.
 */
async function loadPlugins({
  pluginsDir,
  bundledDir,
  win,
  shell,
  profile,
  Anchor,
  disabled = new Set(),
}) {
  resetLayerCounters();
  const loaded = [];

  const dirs = collectPlugins(bundledDir, pluginsDir);

  for (const rec of dirs) {
    const entry = await activatePlugin(rec, {
      win,
      shell,
      profile,
      Anchor,
      disabled,
    });
    if (entry) loaded.push(entry);
  }

  return loaded;
}

async function activatePlugin(rec, deps) {
  const { win, shell, profile, Anchor, disabled } = deps;
  const { dir, manifest } = rec;
  const pluginId = rec.id;
  if (!pluginId || shell._plugins.has(pluginId)) return null;
  if (disabled && disabled.has(pluginId)) {
    console.log(`[atrium] plugin disabled: ${pluginId}`);
    return null;
  }
  if (profile.plugins?.[pluginId]?.enabled === false) {
    console.log(`[atrium] plugin disabled: ${pluginId}`);
    return null;
  }

  const abi = nativeAbiMismatch(manifest);
  if (abi) {
    console.warn(`[atrium] skip plugin ${pluginId}: ${abi}`);
    return null;
  }

  const ctx = createPluginContext({
    pluginId,
    pluginDir: dir,
    manifest,
    win,
    shell,
    profile,
    Anchor,
  });

  for (const btn of manifest.shellButtons || []) {
    shell.registerButton({
      id: `${pluginId}:${btn.id || 'btn'}`,
      label: btn.label,
      shortcut: btn.shortcut,
      action: btn.action,
      pluginId,
      onClick: () => {
        if (typeof btn.action === 'string' && btn.action.startsWith('toggle-pane:')) {
          const localId = btn.action.slice('toggle-pane:'.length);
          const slotKey = `${pluginId}:${localId}`;
          if (shell.getDockSlot && shell.getDockSlot(slotKey)) {
            shell.toggleDockSlot(slotKey);
          } else {
            shell._togglePluginPane(pluginId, localId);
          }
        }
      },
    });
  }

  let mod = null;
  const entry = { pluginId, ctx, manifest, dir, mod: null };
  // Register entry before mod.activate so any IPC emitted during pane mounting finds entry.ctx
  shell._plugins.set(pluginId, entry);

  try {
    if (manifest.host) {
      const hostPath = path.join(dir, manifest.host);
      const req = createRequire(process.execPath);
      try {
        delete req.cache[req.resolve(hostPath)];
      } catch (_) {}
      mod = req(hostPath);
      entry.mod = mod;
      if (typeof mod.activate === 'function') {
        await mod.activate(ctx);
      }
      await ctx._autoMountManifestPanes();
    } else {
      await ctx._autoMountManifestPanes();
    }
  } catch (e) {
    shell._plugins.delete(pluginId);
    console.error(`[atrium] plugin ${pluginId} failed to activate:`, e);
    try {
      if (typeof shell.dropPluginButtons === 'function') shell.dropPluginButtons(pluginId);
    } catch (_) {}
    try {
      if (typeof ctx.disposeAll === 'function') ctx.disposeAll();
    } catch (_) {}
    return null;
  }

  console.log(`[atrium] activated plugin ${pluginId}`);
  return entry;
}

async function deactivatePlugin(shell, pluginId) {
  if (!shell || !shell._plugins) return;
  const entry = shell._plugins.get(pluginId);
  if (!entry) return;
  try {
    if (entry.mod && typeof entry.mod.deactivate === 'function') {
      await entry.mod.deactivate(entry.ctx);
    }
  } catch (e) {
    console.warn(`[atrium] ${pluginId} deactivate failed:`, e.message);
  }
  try {
    if (typeof shell.dropPluginButtons === 'function') shell.dropPluginButtons(pluginId);
  } catch (_) {}
  try {
    if (entry.ctx && typeof entry.ctx.disposeAll === 'function') {
      entry.ctx.disposeAll();
    }
  } catch (e) {
    console.warn(`[atrium] ${pluginId} disposeAll failed:`, e.message);
  }
  shell._plugins.delete(pluginId);
  if (shell._dock && typeof shell._dock.syncOverlays === 'function') {
    shell._dock.syncOverlays({ animate: false }).catch(() => {});
  }
  console.log(`[atrium] unloaded plugin ${pluginId}`);
}

async function unloadPlugins(shell) {
  if (!shell || !shell._plugins) return;
  for (const pluginId of [...shell._plugins.keys()].reverse()) {
    await deactivatePlugin(shell, pluginId);
  }
}

module.exports = {
  loadPlugins,
  unloadPlugins,
  activatePlugin,
  deactivatePlugin,
  collectPlugins,
  nativeAbiMismatch,
  PLUGIN_ID_RE,
  USER_PLUGIN_MARK,
};
