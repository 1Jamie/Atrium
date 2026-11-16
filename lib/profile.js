'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

/** Top botanical dock island height (overlay mode). Status is a separate right pane. */
const TOP_CHROME = 52;
/** Inset from screen edges so dock/status float as encapsulated capsules (not edge-docked). */
const CHROME_INSET = 12;

function configDir() {
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg ? xdg : path.join(os.homedir(), '.config');
  return path.join(base, 'lotus-atrium');
}

function profilePath() {
  return path.join(configDir(), 'overlay-profile.json');
}

function pluginsDir() {
  return path.join(configDir(), 'plugins');
}

/** Staging root served as lotus-resource://localhost/ (ui/ + plugins/<id>/). */
function resourceRootDir() {
  return path.join(configDir(), 'resource-root');
}

function ensureSymlink(target, linkPath) {
  const absTarget = path.resolve(target);
  fs.mkdirSync(path.dirname(linkPath), { recursive: true });
  try {
    const st = fs.lstatSync(linkPath);
    if (st.isSymbolicLink()) {
      const cur = path.resolve(path.dirname(linkPath), fs.readlinkSync(linkPath));
      if (cur === absTarget) return;
      fs.unlinkSync(linkPath);
    } else {
      fs.rmSync(linkPath, { recursive: true, force: true });
    }
  } catch (e) {
    if (e && e.code !== 'ENOENT') throw e;
  }
  fs.symlinkSync(absTarget, linkPath, 'dir');
}

/**
 * Prepare ~/.config/lotus-atrium/resource-root so shell + plugin HTML can load
 * as lotus-resource:// (trusted for window.lotus). file:// panes never get IPC.
 */
function ensureResourceRoot(atriumPackageRoot) {
  const root = resourceRootDir();
  fs.mkdirSync(path.join(root, 'plugins'), { recursive: true });
  ensureSymlink(path.join(atriumPackageRoot, 'ui'), path.join(root, 'ui'));
  return root;
}

/** Mount a plugin directory at resource-root/plugins/<pluginId>. */
function linkPluginResource(pluginId, pluginDir) {
  if (!pluginId || !pluginDir) return null;
  const linkPath = path.join(resourceRootDir(), 'plugins', pluginId);
  ensureSymlink(pluginDir, linkPath);
  return linkPath;
}

/** Default host hotkeys (W3C KeyboardEvent.code). Overridable via profile.keybinds.
 *  Keep overlay chrome on F-keys — never bind bare typing keys (KeyQ/KeyE/…);
 *  host hotkeys beat plugin focus and would swallow Discord chat input. */
function defaultKeybinds() {
  return {
    'toggle-mode': { key: 'F12' },
    'toggle-fullscreen': { key: 'F11' },
    'discord-sidecar:toggle': { key: 'F9' },
    'perf-hud:toggle': { key: 'F10' },
    'dock-prev': { key: 'F7' },
    'dock-next': { key: 'F8' },
    'dock-back': { key: 'Escape' },
  };
}

function defaultProfile() {
  return {
    version: 2,
    mode: 'game',
    plugins: {},
    games: {},
    keybinds: defaultKeybinds(),
    panes: {},
  };
}

/** Merge saved keybinds over defaults (missing ids keep defaults). */
function resolveKeybinds(profile) {
  const defaults = defaultKeybinds();
  const saved = profile && typeof profile.keybinds === 'object' ? profile.keybinds : {};
  const out = { ...defaults };
  for (const [id, spec] of Object.entries(saved)) {
    if (!spec || typeof spec !== 'object') continue;
    if (typeof spec.key !== 'string' || !spec.key) continue;
    out[id] = {
      key: spec.key,
      modifiers: spec.modifiers && typeof spec.modifiers === 'object' ? spec.modifiers : {},
    };
  }
  return out;
}

function ensureConfigLayout(bundledPluginsDir) {
  const dir = configDir();
  const plugs = pluginsDir();
  fs.mkdirSync(plugs, { recursive: true });
  const profile = profilePath();
  if (!fs.existsSync(profile)) {
    fs.writeFileSync(profile, JSON.stringify(defaultProfile(), null, 2));
  }
  // Copy missing first-party plugins from the in-repo tree.
  if (bundledPluginsDir && fs.existsSync(bundledPluginsDir)) {
    for (const name of fs.readdirSync(bundledPluginsDir)) {
      const src = path.join(bundledPluginsDir, name);
      const dest = path.join(plugs, name);
      if (!fs.statSync(src).isDirectory()) continue;
      if (fs.existsSync(dest)) continue;
      copyDir(src, dest);
    }
  }
  return { configDir: dir, pluginsDir: plugs, profilePath: profile };
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

function loadProfile() {
  try {
    const raw = fs.readFileSync(profilePath(), 'utf8');
    return { ...defaultProfile(), ...JSON.parse(raw) };
  } catch {
    return defaultProfile();
  }
}

let _saveTimer = null;
let _savePending = null;

function saveProfile(profile, opts = {}) {
  _savePending = profile;
  const flush = () => {
    _saveTimer = null;
    const p = _savePending;
    _savePending = null;
    if (!p) return;
    fs.mkdirSync(configDir(), { recursive: true });
    fs.writeFileSync(profilePath(), JSON.stringify(p, null, 2));
  };
  // Tab swaps call setPaneRect many times per frame — coalesce disk writes.
  if (opts && opts.immediate) {
    if (_saveTimer) {
      clearTimeout(_saveTimer);
      _saveTimer = null;
    }
    flush();
    return;
  }
  if (_saveTimer) clearTimeout(_saveTimer);
  _saveTimer = setTimeout(flush, 300);
}

function pluginStorage(profile, pluginId) {
  if (!profile.plugins[pluginId]) {
    profile.plugins[pluginId] = { enabled: true, storage: {} };
  }
  if (!profile.plugins[pluginId].storage) {
    profile.plugins[pluginId].storage = {};
  }
  return {
    get(key, fallback) {
      const v = profile.plugins[pluginId].storage[key];
      return v === undefined ? fallback : v;
    },
    set(key, value) {
      profile.plugins[pluginId].storage[key] = value;
      saveProfile(profile);
    },
  };
}

function paneKey(pluginId, localId) {
  return `${pluginId}:${localId}`;
}

function getPaneRect(profile, pluginId, localId) {
  return profile.panes[paneKey(pluginId, localId)] || null;
}

function setPaneRect(profile, pluginId, localId, rect) {
  profile.panes[paneKey(pluginId, localId)] = {
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
    visible: rect.visible,
  };
  saveProfile(profile);
}

module.exports = {
  TOP_CHROME,
  CHROME_INSET,
  configDir,
  profilePath,
  pluginsDir,
  resourceRootDir,
  ensureResourceRoot,
  linkPluginResource,
  ensureConfigLayout,
  loadProfile,
  saveProfile,
  pluginStorage,
  getPaneRect,
  setPaneRect,
  paneKey,
  defaultKeybinds,
  resolveKeybinds,
};
