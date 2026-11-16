/**
 * Legacy stub. Overlay is touch / mouse / keyboard — no spatial pad focus cursor.
 * Kept so old lotus-resource caches do not 404.
 */
(function () {
  if (window.AtriumFocus) return;
  window.AtriumFocus = {
    move() {
      return false;
    },
    confirm() {
      return false;
    },
    ensureInitial() {},
    setFocused() {},
    listFocusables() {
      return [];
    },
    clearControllerCursor() {},
    markControllerInput() {},
  };
})();
