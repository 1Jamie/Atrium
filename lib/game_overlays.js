'use strict';

const { computeLayout } = require('./layout');
const { anchorRect, windowBounds, clampRect } = require('./bounds');

/**
 * Shell-owned registry for game-mode overlay surfaces (perf pill, crosshair, PiP).
 * States: rest (game mode) | well (overlay + linked tab selected) | hidden.
 */

const WELL_TWEEN_MS = 220;

function createGameOverlayController(shellApi) {
  /** @type {Map<string, object>} */
  const overlays = new Map();
  let wellKey = null;

  function entryKey(pluginId, localId) {
    return `${pluginId}:${localId}`;
  }

  function linkedKey(pluginId, contributionId) {
    if (!contributionId) return null;
    return `${pluginId}:${contributionId}`;
  }

  function resolveRestRect(rec) {
    const win = shellApi.win;
    if (typeof rec.layoutRect === 'function') {
      try {
        const r = rec.layoutRect(win);
        // Prefer live width/height from the registry (pill can grow/shrink).
        if (rec.width != null) r.width = rec.width;
        if (rec.height != null) r.height = rec.height;
        return clampRect(r, windowBounds(win));
      } catch (_) {}
    }
    if (rec.restRect) {
      return clampRect(rec.restRect, windowBounds(win));
    }
    return anchorRect(win, rec.anchor || 'top-left', rec.width || 220, rec.height || 72, {
      topChrome: 0,
      bottomChrome: 0,
      margin: 16,
    });
  }

  /**
   * Place a linked overlay inside the reserved preview well.
   * wellFit 'stretch' fills the well (YouTube PiP).
   * wellFit 'natural' (default) keeps rest size, top-centered in the well.
   */
  function resolveWellRect(rec, well) {
    if (!well) return null;
    if (rec.wellFit === 'stretch') {
      return { x: well.x, y: well.y, width: well.width, height: well.height };
    }
    const rest = resolveRestRect(rec);
    const inset = 12;
    const maxW = Math.max(1, well.width - inset * 2);
    const maxH = Math.max(1, well.height - inset * 2);
    const w = Math.max(1, Math.min(rest.width || maxW, maxW));
    const h = Math.max(1, Math.min(rest.height || maxH, maxH));
    return {
      x: well.x + Math.round((well.width - w) / 2),
      y: well.y + inset,
      width: w,
      height: h,
    };
  }

  function getPane(rec) {
    const entry = shellApi._plugins.get(rec.pluginId);
    if (!entry) return null;
    return entry.ctx.getPane(rec.localId);
  }

  function register(rec) {
    if (!rec || !rec.pluginId || !rec.localId) {
      throw new Error('registerGameOverlay: pluginId and localId required');
    }
    const key = entryKey(rec.pluginId, rec.localId);
    overlays.set(key, {
      key,
      pluginId: rec.pluginId,
      localId: rec.localId,
      linkedContribution: linkedKey(rec.pluginId, rec.linkedContribution),
      anchor: rec.anchor || 'top-left',
      width: rec.width,
      height: rec.height,
      layoutRect: rec.layoutRect || null,
      restRect: rec.restRect || null,
      // 'natural' | 'stretch' — stretch fills the well; natural keeps rest size.
      wellFit: rec.wellFit === 'stretch' ? 'stretch' : 'natural',
      enabled: rec.enabled !== false,
    });
    return key;
  }

  function setEnabled(pluginId, localId, enabled) {
    const rec = overlays.get(entryKey(pluginId, localId));
    if (!rec) return;
    rec.enabled = !!enabled;
    if (!rec.enabled) {
      const pane = getPane(rec);
      try {
        if (pane && pane.visible) pane.setVisible(false);
      } catch (_) {}
    }
  }

  function setRestSize(pluginId, localId, size = {}) {
    const rec = overlays.get(entryKey(pluginId, localId));
    if (!rec) return;
    if (size.width != null) rec.width = size.width;
    if (size.height != null) rec.height = size.height;
  }

  function unregister(pluginId, localId) {
    const key = entryKey(pluginId, localId);
    overlays.delete(key);
    if (wellKey === key) wellKey = null;
  }

  function findLinkedToContribution(contributionKey) {
    if (!contributionKey) return null;
    for (const rec of overlays.values()) {
      if (rec.enabled && rec.linkedContribution === contributionKey) return rec;
    }
    return null;
  }

  /**
   * @param {{ mode: string, activeContributionKey: string|null, animate?: boolean }} opts
   */
  async function sync(opts = {}) {
    const mode = opts.mode || shellApi.mode;
    const activeKey = opts.activeContributionKey || null;
    const animate = !!opts.animate;
    const win = shellApi.win;
    const linked = mode !== 'game' ? findLinkedToContribution(activeKey) : null;
    // Linked preview → reserve left well; contribution uses the remaining column.
    const layout = computeLayout(win, { splitWell: !!linked });
    const nextWellKey = linked ? linked.key : null;

    const tasks = [];
    for (const rec of overlays.values()) {
      if (!rec.enabled) continue;
      const pane = getPane(rec);
      if (!pane) continue;
      const raw = pane.raw || pane;

      if (mode === 'game') {
        const rest = resolveRestRect(rec);
        const fromWell = wellKey === rec.key;
        const durationMs = animate && fromWell ? WELL_TWEEN_MS : 0;
        tasks.push(
          (async () => {
            try {
              try {
                if (raw && raw.zIndex != null) raw.zIndex = 120;
                else if (pane.raw) pane.raw.zIndex = 120;
              } catch (_) {}
              if (typeof raw.movePane === 'function') {
                await raw.movePane(rest.x, rest.y, rest.width, rest.height, {
                  durationMs,
                });
              } else {
                pane.setRect(rest.x, rest.y, rest.width, rest.height);
              }
              if (typeof raw.setPassthrough === 'function') {
                raw.setPassthrough(true);
              } else if (typeof pane.raw?.setPassthrough === 'function') {
                pane.raw.setPassthrough(true);
              }
              if (!pane.visible) pane.setVisible(true);
            } catch (e) {
              console.warn(`[atrium] game overlay rest ${rec.key}:`, e.message);
            }
          })()
        );
        continue;
      }

      // Overlay mode.
      if (linked && rec.key === linked.key) {
        const well = layout.regions.well || layout.regions.content;
        const target = resolveWellRect(rec, well);
        if (!target) continue;
        const fromRest = wellKey !== rec.key;
        const durationMs = animate && fromRest ? WELL_TWEEN_MS : 0;
        tasks.push(
          (async () => {
            try {
              if (!pane.visible) pane.setVisible(true);
              // Preview sits above the contribution drawer while in the well.
              try {
                if (raw && raw.zIndex != null) raw.zIndex = 850;
                else if (pane.raw) pane.raw.zIndex = 850;
              } catch (_) {}
              if (typeof raw.setPassthrough === 'function') {
                raw.setPassthrough(false);
              } else if (typeof pane.raw?.setPassthrough === 'function') {
                pane.raw.setPassthrough(false);
              }
              if (typeof raw.movePane === 'function') {
                await raw.movePane(target.x, target.y, target.width, target.height, {
                  durationMs,
                });
              } else {
                pane.setRect(target.x, target.y, target.width, target.height);
              }
            } catch (e) {
              console.warn(`[atrium] game overlay well ${rec.key}:`, e.message);
            }
          })()
        );
        continue;
      }

      // Hidden: not the selected linked overlay (or unlinked).
      tasks.push(
        (async () => {
          try {
            if (pane.visible) pane.setVisible(false);
          } catch (_) {}
        })()
      );
    }

    await Promise.all(tasks);
    wellKey = nextWellKey;
    return { layout, wellKey, linked };
  }

  function contentSplitFor(contributionKey) {
    if (shellApi.mode === 'game') return false;
    return !!findLinkedToContribution(contributionKey);
  }

  return {
    register,
    unregister,
    setEnabled,
    setRestSize,
    sync,
    findLinkedToContribution,
    contentSplitFor,
    get overlays() {
      return overlays;
    },
    get wellKey() {
      return wellKey;
    },
  };
}

module.exports = { createGameOverlayController, WELL_TWEEN_MS };
