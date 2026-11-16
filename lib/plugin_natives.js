'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Every native addon under node_modules, including scoped packages
 * (@scope/pkg) and transitive deps (bufferutil, utf-8-validate, …).
 * @param {string} nodeModulesDir
 * @returns {string[]} absolute paths
 */
function findNativeAddons(nodeModulesDir) {
  const found = [];
  if (!nodeModulesDir || !fs.existsSync(nodeModulesDir)) return found;

  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith('.node')) {
        found.push(full);
      }
    }
  }

  walk(nodeModulesDir);
  return found;
}

module.exports = { findNativeAddons };
