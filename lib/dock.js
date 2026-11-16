'use strict';

const { computeLayout } = require('./layout');
const { allocateNavPage, sortContributions, pageCount } = require('./nav_slots');

/**
 * Contribution slot registry + focus for overlay modal.
 * dispose-safe: removeDockSlot clamps activeSlotIndex and re-focuses.
 */
function createDockController(shellApi, opts = {}) {
  const pushChrome = opts.pushChrome || (() => {});
  const slots = []; // ordered by sortKey/order then key
  let activeSlotIndex = -1;
  let focusedKey = null;
  let focusing = false;
  let focusQueued = false;
  let navPage = 0;
  function sortedSlots() {
    return sortContributions(slots);
  }

  function reindex() {
    const sorted = sortedSlots();
    slots.length = 0;
    slots.push(...sorted);
  }

  function getSlot(key) {
    return slots.find((s) => s.key === key) || null;
  }

  function updateSlot(key, partial = {}) {
    const slot = getSlot(key);
    if (!slot) return null;
    if (partial.label != null) slot.label = partial.label;
    if (partial.icon !== undefined) slot.icon = partial.icon;
    if (partial.sortKey != null) {
      slot.sortKey = partial.sortKey;
      slot.order = partial.sortKey;
      reindex();
    }
    pushChrome();
    return slot;
  }

  function chromeSlots() {
    return slots.map((s, i) => ({
      key: s.key,
      label: s.label,
      icon: s.icon || null,
      kind: s.kind,
      contentKind: s.contentKind || null,
      pluginId: s.pluginId,
      localId: s.localId,
      active: i === activeSlotIndex,
    }));
  }

  function navChrome() {
    const total = slots.length;
    const pages = pageCount(total);
    if (navPage >= pages) navPage = Math.max(0, pages - 1);
    const alloc = allocateNavPage(total, navPage);
    const rows = (alloc.rows || []).map((row) => {
      if (!row || row.type === 'empty') return { type: 'empty' };
      if (row.type === 'pager') {
        return {
          type: 'pager',
          prevDisabled: !!row.prevDisabled,
          nextDisabled: !!row.nextDisabled,
        };
      }
      if (row.type === 'plugin') {
        const slot = slots[row.index];
        return {
          type: 'plugin',
          index: row.index,
          key: slot ? slot.key : null,
          label: slot ? slot.label : '',
          icon: slot ? slot.icon : null,
          active: slot ? row.index === activeSlotIndex : false,
        };
      }
      return { type: 'empty' };
    });
    while (rows.length < 5) rows.push({ type: 'empty' });
    return {
      page: alloc.page,
      pages: alloc.pages,
      columns: 1,
      rows: rows.slice(0, 5),
      cells: rows.slice(0, 5),
    };
  }

  function notifyFocus(slot, focused) {
    if (!slot || typeof slot.onFocusChange !== 'function') return;
    try {
      slot.onFocusChange(!!focused);
    } catch (_) {}
  }

  function placeContributionPane(slotKey, pane, win) {
    const slot = getSlot(slotKey);
    if (!slot || !pane) return;
    // Reserve a left preview column when this tab has a linked game overlay.
    const splitWell =
      !!shellApi._gameOverlays &&
      typeof shellApi._gameOverlays.contentSplitFor === 'function' &&
      shellApi._gameOverlays.contentSplitFor(slotKey);
    const layout = computeLayout(win || shellApi.win, { splitWell });
    let r = layout.regions.content;
    // External chat: hairline recess over the stage surface.
    if (slot.contentKind === 'external' || slot.kind === 'pane') {
      const inset = 4;
      r = {
        x: r.x + inset,
        y: r.y + inset,
        width: Math.max(1, r.width - inset * 2),
        height: Math.max(1, r.height - inset * 2),
      };
    }
    try {
      pane.setRect(r.x, r.y, r.width, r.height);
    } catch (_) {}
  }

  function accentForSlot(slot) {
    if (!slot) return 'perf';
    const id = String(slot.localId || slot.key || '').toLowerCase();
    const label = String(slot.label || '').toLowerCase();
    const plugin = String(slot.pluginId || '').toLowerCase();
    if (
      plugin.includes('discord') ||
      id.includes('chat') ||
      id.includes('auth') ||
      label.includes('chat')
    ) {
      return 'chat';
    }
    if (plugin.includes('scaling') || id.includes('scal') || label.includes('scal')) {
      return 'scaling';
    }
    if (plugin.includes('perf') || id.includes('perf') || label.includes('perf')) {
      return 'perf';
    }
    return 'perf';
  }

  async function syncOverlays({ animate } = {}) {
    if (!shellApi._gameOverlays) return;
    const active = activeSlotIndex >= 0 ? slots[activeSlotIndex] : null;
    await shellApi._gameOverlays.sync({
      mode: shellApi.mode,
      activeContributionKey: active ? active.key : null,
      animate: !!animate,
    });
  }

  async function hideAllDockSurfaces(exceptKey) {
    for (const s of slots) {
      if (exceptKey && s.key === exceptKey) continue;
      const entry = shellApi._plugins.get(s.pluginId);
      if (!entry) continue;
      const pane = entry.ctx.getPane(s.localId);
      if (pane && pane.visible) {
        try {
          pane.setVisible(false);
        } catch (_) {}
      }
    }
    if (focusedKey && focusedKey !== exceptKey) {
      notifyFocus(getSlot(focusedKey), false);
      focusedKey = exceptKey || null;
    }
  }

  async function focusActiveSlotOnce({ animateOverlays } = {}) {
    if (slots.length === 0) {
      activeSlotIndex = -1;
      if (focusedKey) {
        notifyFocus(getSlot(focusedKey), false);
        focusedKey = null;
      }
      await syncOverlays({ animate: !!animateOverlays });
      pushChrome();
      return;
    }
    if (activeSlotIndex < 0) activeSlotIndex = 0;
    if (activeSlotIndex >= slots.length) activeSlotIndex = slots.length - 1;

    const slot = slots[activeSlotIndex];
    if (!slot) {
      activeSlotIndex = -1;
      pushChrome();
      return;
    }

    // Already focused and visible — still re-place + sync overlays (resize / well).
    if (focusedKey === slot.key && shellApi.mode !== 'game') {
      const entry = shellApi._plugins.get(slot.pluginId);
      const pane = entry && entry.ctx.getPane(slot.localId);
      if (pane && pane.visible) {
        placeContributionPane(slot.key, pane, shellApi.win);
        await syncOverlays({ animate: !!animateOverlays });
        pushChrome();
        return;
      }
    }

    if (shellApi.mode === 'game') {
      shellApi.setMode('overlay');
    }

    const prevKey = focusedKey;
    const entry = shellApi._plugins.get(slot.pluginId);
    if (!entry) {
      pushChrome();
      return;
    }

    try {
      let pane = entry.ctx.getPane(slot.localId);
      if (!pane && typeof slot.ensure === 'function') {
        await slot.ensure();
        const current = slots[activeSlotIndex];
        if (!current || current.key !== slot.key) return;
        pane = entry.ctx.getPane(slot.localId);
      }
      if (pane) {
        placeContributionPane(slot.key, pane, shellApi.win);
        pane.setVisible(true);
        try {
          if (pane.raw && typeof pane.raw.focus === 'function') {
            pane.raw.focus();
          }
        } catch (_) {}
      }

      for (const s of slots) {
        if (s.key === slot.key) continue;
        const other = shellApi._plugins.get(s.pluginId);
        if (!other) continue;
        const otherPane = other.ctx.getPane(s.localId);
        if (otherPane && otherPane.visible) {
          try {
            otherPane.setVisible(false);
          } catch (_) {}
        }
      }

      try {
        if (typeof shellApi.win.setPadKeyForwardPane === 'function') {
          shellApi.win.setPadKeyForwardPane(null);
        }
        if (typeof shellApi.win.setPadSpatialFocusPane === 'function') {
          shellApi.win.setPadSpatialFocusPane(null);
        }
      } catch (_) {}

      if (prevKey && prevKey !== slot.key) {
        notifyFocus(getSlot(prevKey), false);
      }
      focusedKey = slot.key;
      notifyFocus(slot, true);
      await syncOverlays({ animate: !!animateOverlays });
    } catch (e) {
      console.warn(`[atrium] focusActiveSlot ${slot.key} failed:`, e.message);
    }
    pushChrome();
  }

  async function focusActiveSlot(opts) {
    if (focusing) {
      focusQueued = true;
      return;
    }
    focusing = true;
    try {
      do {
        focusQueued = false;
        await focusActiveSlotOnce(opts);
      } while (focusQueued);
    } finally {
      focusing = false;
    }
  }

  function addDockSlot(slot) {
    if (!slot || !slot.key) throw new Error('addDockSlot: missing key');
    const existing = getSlot(slot.key);
    if (existing) {
      Object.assign(existing, slot);
      reindex();
      pushChrome();
      return;
    }
    slots.push(slot);
    reindex();
    if (activeSlotIndex < 0 && shellApi.mode !== 'game') {
      activeSlotIndex = slots.findIndex((s) => s.key === slot.key);
    }
    pushChrome();
  }

  async function removeDockSlot(key) {
    const idx = slots.findIndex((s) => s.key === key);
    if (idx < 0) return;
    const wasActive = idx === activeSlotIndex;
    const removed = slots[idx];
    slots.splice(idx, 1);
    reindex();

    if (focusedKey === key) focusedKey = null;

    if (slots.length === 0) {
      activeSlotIndex = -1;
    } else if (wasActive) {
      activeSlotIndex = Math.min(idx, slots.length - 1);
      await focusActiveSlot();
      return;
    } else if (activeSlotIndex > idx) {
      activeSlotIndex -= 1;
    }
    if (removed && typeof removed.onFocusChange === 'function' && wasActive) {
      try {
        removed.onFocusChange(false);
      } catch (_) {}
    }
    pushChrome();
  }

  async function selectDockSlot(key) {
    const idx = slots.findIndex((s) => s.key === key);
    if (idx < 0) return;
    activeSlotIndex = idx;
    // Snap overlays when switching tabs while already in overlay.
    await focusActiveSlot({ animateOverlays: false });
  }

  async function toggleDockSlot(key) {
    const idx = slots.findIndex((s) => s.key === key);
    if (idx < 0) return;
    if (shellApi.mode !== 'game' && idx === activeSlotIndex) {
      const entry = shellApi._plugins.get(slots[idx].pluginId);
      const pane = entry && entry.ctx.getPane(slots[idx].localId);
      if (pane && pane.visible) {
        try {
          pane.setVisible(false);
        } catch (_) {}
        if (focusedKey === key) {
          notifyFocus(slots[idx], false);
          focusedKey = null;
        }
        activeSlotIndex = -1;
        await syncOverlays({ animate: false });
        pushChrome();
        return;
      }
    }
    activeSlotIndex = idx;
    await focusActiveSlot({ animateOverlays: shellApi.mode === 'game' });
  }

  async function cycleDock(delta) {
    if (slots.length === 0) return;
    if (shellApi.mode === 'game') {
      activeSlotIndex = delta >= 0 ? 0 : slots.length - 1;
      shellApi.setMode('overlay');
      return;
    }
    if (activeSlotIndex < 0) {
      activeSlotIndex = delta >= 0 ? 0 : slots.length - 1;
    } else {
      activeSlotIndex = (activeSlotIndex + delta + slots.length) % slots.length;
    }
    await focusActiveSlot({ animateOverlays: false });
  }

  async function setNavPage(page) {
    const pages = pageCount(slots.length);
    const next = Math.max(0, Math.min(pages - 1, Math.floor(Number(page) || 0)));
    if (next === navPage) return;
    navPage = next;
    pushChrome();
  }

  async function navPageDelta(delta) {
    await setNavPage(navPage + (delta >= 0 ? 1 : -1));
  }

  /**
   * Shell hotkeys and the Start+Select chord. Never forwarded to plugins.
   * Pad input is only the overlay open/close chord.
   */
  function dispatchAction(action) {
    const act = typeof action === 'string' ? { action } : action || {};
    const name = act.action;

    if (name === 'TabPrev') {
      cycleDock(-1);
      return true;
    }
    if (name === 'TabNext') {
      cycleDock(1);
      return true;
    }
    if (name === 'ToggleOverlay') {
      if (act.modeHandled && typeof act.gameMode === 'boolean') {
        shellApi.setMode(act.gameMode ? 'game' : 'overlay');
        return true;
      }
      shellApi.setMode(shellApi.mode === 'game' ? 'overlay' : 'game');
      return true;
    }
    if (name === 'OskToggle') {
      shellApi.emit('osk-toggle');
      return true;
    }
    if (name === 'Back') {
      if (shellApi.mode !== 'game') {
        shellApi.setMode('game');
        return true;
      }
    }
    return false;
  }

  return {
    get activeSlotIndex() {
      return activeSlotIndex;
    },
    get slots() {
      return slots;
    },
    get navPage() {
      return navPage;
    },
    getSlot,
    updateSlot,
    chromeSlots,
    navChrome,
    placeContributionPane,
    accentForSlot,
    syncOverlays,
    addDockSlot,
    removeDockSlot,
    selectDockSlot,
    toggleDockSlot,
    cycleDock,
    setNavPage,
    navPageDelta,
    focusActiveSlot,
    dispatchAction,
    hideAllDockSurfaces,
  };
}

module.exports = { createDockController };
