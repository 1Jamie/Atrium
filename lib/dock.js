'use strict';

/**
 * Top-dock slot registry + focus for overlay modal.
 * dispose-safe: removeDockSlot clamps activeSlotIndex and re-focuses.
 */
function createDockController(shellApi, opts = {}) {
  const pushChrome = opts.pushChrome || (() => {});
  const slots = []; // ordered by `order` then insert
  let activeSlotIndex = -1;
  let focusedKey = null;
  let focusing = false;
  let focusQueued = false;
  const actionHandlers = []; // { pluginId, handler }

  function sortedSlots() {
    return slots.slice().sort((a, b) => {
      const ao = a.order != null ? a.order : 100;
      const bo = b.order != null ? b.order : 100;
      if (ao !== bo) return ao - bo;
      return String(a.key).localeCompare(String(b.key));
    });
  }

  function reindex() {
    const sorted = sortedSlots();
    slots.length = 0;
    slots.push(...sorted);
  }

  function getSlot(key) {
    return slots.find((s) => s.key === key) || null;
  }

  function chromeSlots() {
    return slots.map((s, i) => ({
      key: s.key,
      label: s.label,
      icon: s.icon || null,
      kind: s.kind,
      pluginId: s.pluginId,
      localId: s.localId,
      active: i === activeSlotIndex,
    }));
  }

  function footerHints() {
    const hints = [];
    const slot = activeSlotIndex >= 0 ? slots[activeSlotIndex] : null;
    if (shellApi.mode !== 'game' && slot) {
      if (slot.kind === 'pane') {
        hints.push(
          { glyph: 'dpad', label: 'Navigate' },
          { glyph: 'a', label: 'Enter', tone: 'jade' },
          { glyph: 'b', label: 'Esc', tone: 'coral' },
          { glyph: 'x', label: 'Keyboard', tone: 'blue' }
        );
      } else {
        const handlesBack = !!(slot.input && slot.input.handlesBack);
        hints.push(
          { glyph: 'a', label: 'Select', tone: 'jade' },
          { glyph: 'b', label: handlesBack ? 'Back' : 'Close', tone: 'coral' }
        );
      }
    }
    hints.push(
      { glyph: 'lb_rb', label: 'Switch Tab', alt: 'Q/E' },
      { glyph: 'start_select', label: 'Resume Game', alt: 'F12' }
    );
    return hints;
  }

  function notifyFocus(slot, focused) {
    if (!slot || typeof slot.onFocusChange !== 'function') return;
    try {
      slot.onFocusChange(!!focused);
    } catch (_) {}
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

  async function focusActiveSlotOnce() {
    if (slots.length === 0) {
      activeSlotIndex = -1;
      if (focusedKey) {
        notifyFocus(getSlot(focusedKey), false);
        focusedKey = null;
      }
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

    // Already focused and visible — no chrome thrash (was a major input stall).
    if (focusedKey === slot.key && shellApi.mode !== 'game') {
      const entry = shellApi._plugins.get(slot.pluginId);
      const pane = entry && entry.ctx.getPane(slot.localId);
      if (pane && pane.visible) {
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
      // Lazy external panes only — skip await when the surface already exists.
      let pane = entry.ctx.getPane(slot.localId);
      if (!pane && typeof slot.ensure === 'function') {
        await slot.ensure();
        const current = slots[activeSlotIndex];
        if (!current || current.key !== slot.key) return;
        pane = entry.ctx.getPane(slot.localId);
      }
      // Show next first so the drawer never blanks between tabs.
      if (pane) {
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
        const paneId = pane && (pane.id || pane.localId);
        if (slot.kind === 'pane' && paneId) {
          // External TUI: pad→keys into the nest client.
          if (typeof shellApi.win.setPadSpatialFocusPane === 'function') {
            shellApi.win.setPadSpatialFocusPane(null);
          }
          shellApi.win.setPadKeyForwardPane(paneId);
        } else if (paneId) {
          // Spatial Servo tab: rust injects AtriumFocus directly (mouse-parity).
          shellApi.win.setPadKeyForwardPane(null);
          if (typeof shellApi.win.setPadSpatialFocusPane === 'function') {
            shellApi.win.setPadSpatialFocusPane(paneId);
          }
        } else {
          shellApi.win.setPadKeyForwardPane(null);
          if (typeof shellApi.win.setPadSpatialFocusPane === 'function') {
            shellApi.win.setPadSpatialFocusPane(null);
          }
        }
      } catch (_) {}

      if (prevKey && prevKey !== slot.key) {
        notifyFocus(getSlot(prevKey), false);
      }
      focusedKey = slot.key;
      notifyFocus(slot, true);
    } catch (e) {
      console.warn(`[atrium] focusActiveSlot ${slot.key} failed:`, e.message);
    }
    pushChrome();
  }

  /**
   * Coalesce rapid LB/RB: overlapping calls collapse to the latest activeSlotIndex
   * instead of stacking hide/show/reposition/flush work.
   */
  async function focusActiveSlot() {
    if (focusing) {
      focusQueued = true;
      return;
    }
    focusing = true;
    try {
      do {
        focusQueued = false;
        await focusActiveSlotOnce();
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
    await focusActiveSlot();
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
        pushChrome();
        return;
      }
    }
    activeSlotIndex = idx;
    await focusActiveSlot();
  }

  async function cycleDock(delta) {
    if (slots.length === 0) return;
    if (shellApi.mode === 'game') {
      // Set target before setMode — overlay entry already calls focusActiveSlot.
      activeSlotIndex = delta >= 0 ? 0 : slots.length - 1;
      shellApi.setMode('overlay');
      return;
    }
    if (activeSlotIndex < 0) {
      activeSlotIndex = delta >= 0 ? 0 : slots.length - 1;
    } else {
      activeSlotIndex = (activeSlotIndex + delta + slots.length) % slots.length;
    }
    await focusActiveSlot();
  }

  function addActionHandler(pluginId, handler) {
    const rec = { pluginId, handler };
    actionHandlers.push(rec);
    return {
      dispose() {
        const i = actionHandlers.indexOf(rec);
        if (i >= 0) actionHandlers.splice(i, 1);
      },
    };
  }

  /**
   * @returns {boolean} true if consumed
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
      // Rust already flipped game_mode / evdev grab — mirror absolute state.
      if (act.modeHandled && typeof act.gameMode === 'boolean') {
        shellApi.setMode(act.gameMode ? 'game' : 'overlay');
        return true;
      }
      shellApi.setMode(shellApi.mode === 'game' ? 'overlay' : 'game');
      return true;
    }
    if (name === 'OskToggle') {
      // Slice 3: summon Steam/DE OSK + setOskActive handshake.
      shellApi.emit('osk-toggle');
      return true;
    }

    // Rust already injected AtriumFocus for spatial Nav/Confirm — do not re-fire.
    if (act.spatialHandled && (name === 'Nav' || name === 'Confirm')) {
      return true;
    }

    const active = activeSlotIndex >= 0 ? slots[activeSlotIndex] : null;
    // Spatial tabs: inject focus move/confirm directly into the visible pane.
    // Skips plugin onAction → ipc.send → executeScript (was stacking 1–2s lag).
    if (
      active &&
      (name === 'Nav' || name === 'Confirm') &&
      (!active.input || active.input.mode === 'spatial')
    ) {
      const entry = shellApi._plugins.get(active.pluginId);
      const pane = entry && entry.ctx.getPane(active.localId);
      const raw = pane && (pane.raw || pane);
      if (pane && pane.visible && raw && typeof raw.executeScript === 'function') {
        try {
          if (name === 'Nav' && act.dir) {
            raw.executeScript(
              `window.AtriumFocus&&window.AtriumFocus.move(${JSON.stringify(String(act.dir))});`
            );
            return true;
          }
          if (name === 'Confirm') {
            raw.executeScript(
              `window.AtriumFocus&&window.AtriumFocus.confirm();`
            );
            return true;
          }
        } catch (e) {
          console.warn(`[atrium] spatial pad inject failed:`, e.message);
        }
      }
    }
    if (active) {
      for (const rec of actionHandlers) {
        if (rec.pluginId !== active.pluginId) continue;
        try {
          if (rec.handler(act) === true) return true;
        } catch (e) {
          console.warn(`[atrium] onAction ${rec.pluginId}:`, e.message);
        }
      }
    }

    if (name === 'Back') {
      if (shellApi.mode !== 'game') {
        shellApi.setMode('game');
        return true;
      }
    }

    for (const rec of actionHandlers) {
      if (active && rec.pluginId === active.pluginId) continue;
      try {
        if (rec.handler(act) === true) return true;
      } catch (_) {}
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
    getSlot,
    chromeSlots,
    footerHints,
    addDockSlot,
    removeDockSlot,
    selectDockSlot,
    toggleDockSlot,
    cycleDock,
    focusActiveSlot,
    addActionHandler,
    dispatchAction,
    hideAllDockSurfaces,
  };
}

module.exports = { createDockController };
