/**
 * Spatial controller focus for Atrium Servo tabs.
 * Loaded into registerTab / registerHud surfaces via host inject.
 *
 * Pad Nav dirs are lowercase ("up"|"down"|"left"|"right") — see plugin_sdk.d.ts.
 */
(function () {
  if (window.AtriumFocus) return;

  function listFocusables() {
    return Array.from(
      document.querySelectorAll('.atrium-focusable:not([disabled]):not([hidden])')
    ).filter((el) => {
      if (el.getAttribute('aria-hidden') === 'true') return false;
      if (el.closest('[hidden]')) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
  }

  function setFocused(el) {
    for (const n of document.querySelectorAll('.atrium-focusable.is-focused')) {
      n.classList.remove('is-focused');
    }
    if (!el) return;
    el.classList.add('is-focused');
    try {
      el.focus({ preventScroll: true });
    } catch (_) {
      try {
        el.focus();
      } catch (_) {}
    }
    try {
      el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    } catch (_) {}
  }

  function currentIndex(items) {
    const focused =
      document.activeElement && document.activeElement.classList.contains('atrium-focusable')
        ? document.activeElement
        : document.querySelector('.atrium-focusable.is-focused');
    if (!focused) return -1;
    return items.indexOf(focused);
  }

  function overlap1d(a0, a1, b0, b1) {
    return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
  }

  function normalizeDir(dir) {
    const d = String(dir || '').trim().toLowerCase();
    if (d === 'up' || d === 'down' || d === 'left' || d === 'right') return d;
    return '';
  }

  /**
   * True 2D spatial move. Prefer candidates in the movement cone that share
   * axis overlap with the current rect (grid-friendly Left/Right/Up/Down).
   * No linear wrap — stay put when nothing lies in that direction.
   */
  function move(dir) {
    const items = listFocusables();
    if (!items.length) return false;
    let idx = currentIndex(items);
    if (idx < 0) {
      setFocused(items[0]);
      return true;
    }
    const d = normalizeDir(dir);
    if (!d) return false;

    const cur = items[idx].getBoundingClientRect();
    const cx = cur.left + cur.width / 2;
    const cy = cur.top + cur.height / 2;

    let best = null;
    let bestScore = Infinity;
    for (let i = 0; i < items.length; i++) {
      if (i === idx) continue;
      const r = items[i].getBoundingClientRect();
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      const dx = x - cx;
      const dy = y - cy;

      let ok = false;
      let primary = 0;
      let cross = 0;
      let overlap = 0;

      if (d === 'up') {
        ok = dy < -2;
        primary = -dy;
        cross = Math.abs(dx);
        overlap = overlap1d(cur.left, cur.right, r.left, r.right);
      } else if (d === 'down') {
        ok = dy > 2;
        primary = dy;
        cross = Math.abs(dx);
        overlap = overlap1d(cur.left, cur.right, r.left, r.right);
      } else if (d === 'left') {
        ok = dx < -2;
        primary = -dx;
        cross = Math.abs(dy);
        overlap = overlap1d(cur.top, cur.bottom, r.top, r.bottom);
      } else if (d === 'right') {
        ok = dx > 2;
        primary = dx;
        cross = Math.abs(dy);
        overlap = overlap1d(cur.top, cur.bottom, r.top, r.bottom);
      }
      if (!ok) continue;

      // Prefer same-row / same-column neighbors (overlap), then nearest primary.
      const overlapBonus = overlap > 2 ? 0 : 500000;
      const score = overlapBonus + primary * 40 + cross * 12;
      if (score < bestScore) {
        bestScore = score;
        best = items[i];
      }
    }
    if (!best) return false;
    setFocused(best);
    return true;
  }

  function confirm() {
    const items = listFocusables();
    let el =
      document.querySelector('.atrium-focusable.is-focused') ||
      (document.activeElement && document.activeElement.classList.contains('atrium-focusable')
        ? document.activeElement
        : null);
    if (!el && items[0]) {
      setFocused(items[0]);
      el = items[0];
    }
    if (!el) return false;
    if (typeof el.click === 'function') el.click();
    return true;
  }

  function ensureInitial() {
    if (document.querySelector('.atrium-focusable.is-focused')) return;
    const items = listFocusables();
    if (items[0]) setFocused(items[0]);
  }

  function clearControllerCursor() {
    setFocused(null);
    document.body.classList.remove('controller-input');
    document.body.classList.add('mouse-input');
  }

  function markControllerInput() {
    document.body.classList.remove('mouse-input');
    document.body.classList.add('controller-input');
  }

  window.AtriumFocus = {
    move,
    confirm,
    ensureInitial,
    setFocused,
    listFocusables,
    clearControllerCursor,
    markControllerInput,
  };

  // M/KB: hide the orange spatial ring so it does not sit on a random option.
  window.addEventListener(
    'pointerdown',
    () => {
      clearControllerCursor();
    },
    true
  );
  window.addEventListener(
    'mousemove',
    () => {
      if (document.querySelector('.atrium-focusable.is-focused')) {
        clearControllerCursor();
      }
    },
    { passive: true, capture: true }
  );

  window.addEventListener('atrium-shell-chrome', (e) => {
    const d = (e && e.detail) || {};
    if (d.inputDevice === 'mouse' || d.inputDevice === 'keyboard') {
      clearControllerCursor();
    } else if (d.inputDevice === 'controller') {
      markControllerInput();
      ensureInitial();
    }
  });

  window.addEventListener('atrium-pane-shown', () => {
    // Only seed spatial focus when the controller is the active device.
    setTimeout(() => {
      if (document.body.classList.contains('mouse-input')) return;
      ensureInitial();
    }, 30);
  });

  // Host pad Nav/Confirm arrives on the Lotus pane WS (not evaluate_javascript).
  function wireLotusFocus() {
    const lotus = window.lotus?.ipc || window.lotus;
    if (!lotus || typeof lotus.on !== 'function' || window.AtriumFocus._lotusWired) {
      return !!(lotus && typeof lotus.on === 'function');
    }
    window.AtriumFocus._lotusWired = true;
    lotus.on('atrium-focus', (msg) => {
      if (!msg || typeof msg !== 'object') return;
      if (msg.action === 'move' && msg.dir) move(String(msg.dir));
      else if (msg.action === 'confirm') confirm();
    });
    lotus.on('atrium-shell-chrome', (d) => {
      d = d || {};
      if (d.inputDevice === 'mouse' || d.inputDevice === 'keyboard') {
        clearControllerCursor();
      } else if (d.inputDevice === 'controller') {
        markControllerInput();
        ensureInitial();
      }
    });
    lotus.on('atrium-pane-shown', () => {
      setTimeout(() => {
        if (document.body.classList.contains('mouse-input')) return;
        ensureInitial();
      }, 30);
    });
    return true;
  }
  let focusWireTries = 0;
  const focusWireWait = setInterval(() => {
    if (wireLotusFocus() || ++focusWireTries > 50) clearInterval(focusWireWait);
  }, 100);
  wireLotusFocus();

  setTimeout(() => {
    if (!document.body.classList.contains('mouse-input')) ensureInitial();
  }, 200);
})();
