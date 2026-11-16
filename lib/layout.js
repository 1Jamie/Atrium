'use strict';

const { windowBounds, clampRect } = require('./bounds');

/** Design height for the unit system (1U = 1px at 720p). */
const DESIGN_HEIGHT = 720;

/** Outer margin — shared by header, stage, and hanging docks (logical px at 720p). */
const MARGIN_U = 12;
/** Stage header strip height (carries title + scaler/pacing details). */
const HEADER_H_U = 48;
/** Former footer strip — folded into the header; kept at 0 for API compat. */
const FOOTER_H_U = 0;
/** Hanging tab cluster width. */
const CLUSTER_W_U = 176;
/** Action socket width (sized for stacked quick-actions). */
const SOCKET_W_U = 176;
/** Tab / action row height. */
const ROW_H_U = 64;
/** Locked hanging band: 5 rows so stage geometry never jumps. */
const HANG_ROWS = 5;

/**
 * Logical pixels per U from host window height (never the game backbuffer).
 * @param {number} hostHeight
 */
function unitPx(hostHeight) {
  const h = Math.max(1, Number(hostHeight) || DESIGN_HEIGHT);
  return h / DESIGN_HEIGHT;
}

/**
 * Round a U value to integer logical pixels.
 * @param {number} u
 * @param {number} U
 */
function px(u, U) {
  return Math.max(1, Math.round(Number(u) * U));
}

/**
 * Locked overlay geometry. Header, stage body, and docks share left/right edges.
 * Tab cluster and action socket hang from the stage bottom with 0px gap.
 *
 * @param {object} win ServoWindow-like
 * @param {{ splitWell?: boolean }} [opts] When true, reserves a left preview
 *   well and shrinks `content` to the remaining column. Outer stage/header/
 *   footer/docks stay locked either way.
 */
function computeLayout(win, opts = {}) {
  const bounds = windowBounds(win);
  const U = unitPx(bounds.height);
  const margin = px(MARGIN_U, U);
  const headerH = px(HEADER_H_U, U);
  // Allow 0 — footer strip was folded into the header.
  const footerH =
    FOOTER_H_U <= 0 ? 0 : px(FOOTER_H_U, U);
  const clusterW = px(CLUSTER_W_U, U);
  const socketW = px(SOCKET_W_U, U);
  const rowH = px(ROW_H_U, U);
  const hangH = HANG_ROWS * rowH;

  const stage = clampRect(
    {
      x: margin,
      y: margin,
      width: Math.max(1, bounds.width - margin * 2),
      height: Math.max(headerH + 80, bounds.height - margin * 2 - hangH),
    },
    bounds
  );

  const header = clampRect(
    {
      x: stage.x,
      y: stage.y,
      width: stage.width,
      height: headerH,
    },
    bounds
  );

  // Zero-height stub at stage bottom (details live in the header now).
  // Skip clampRect when height is 0 — it forces a 1px minimum.
  const footer =
    footerH <= 0
      ? { x: stage.x, y: stage.y + stage.height, width: stage.width, height: 0 }
      : clampRect(
          {
            x: stage.x,
            y: stage.y + stage.height - footerH,
            width: stage.width,
            height: footerH,
          },
          bounds
        );

  // Body from header bottom to stage bottom — locked for every tab.
  const contentFull = clampRect(
    {
      x: stage.x,
      y: header.y + header.height,
      width: stage.width,
      height: Math.max(1, stage.y + stage.height - (header.y + header.height)),
    },
    bounds
  );

  // Hanging docks: flush against stage bottom (0 gap), same outer L/R as stage.
  const nav = clampRect(
    {
      x: stage.x,
      y: stage.y + stage.height,
      width: clusterW,
      height: hangH,
    },
    bounds
  );

  const hotbar = clampRect(
    {
      x: stage.x + stage.width - socketW,
      y: stage.y + stage.height,
      width: socketW,
      height: hangH,
    },
    bounds
  );

  // Preview pocket (left) for linked overlays — when present, contribution
  // content is the remaining column so the embed never stacks on UI.
  const gutter = px(12, U);
  let well = null;
  let content = contentFull;
  if (opts.splitWell) {
    const wellW = Math.min(
      Math.max(px(220, U), Math.floor(contentFull.width / 3)),
      px(300, U)
    );
    well = clampRect(
      {
        x: contentFull.x,
        y: contentFull.y,
        width: wellW,
        height: contentFull.height,
      },
      bounds
    );
    content = clampRect(
      {
        x: well.x + well.width + gutter,
        y: contentFull.y,
        width: Math.max(1, contentFull.x + contentFull.width - (well.x + well.width + gutter)),
        height: contentFull.height,
      },
      bounds
    );
  }

  return {
    U,
    bounds,
    tokens: {
      margin,
      headerH,
      footerH,
      clusterW,
      socketW,
      rowH,
      hangH,
      hangRows: HANG_ROWS,
      // Back-compat aliases used by older callers / tests.
      statusH: headerH,
      cell: rowH,
      gap: 0,
      inset: margin,
      bottomBandH: hangH,
      navW: clusterW,
      hotbarW: socketW,
      hotbarSlot: rowH,
    },
    regions: {
      stage,
      status: header,
      header,
      footer,
      contentFull,
      content,
      well,
      nav,
      hotbar,
    },
  };
}

/**
 * @deprecated Prefer hanging cluster rows; kept for callers that map a grid cell.
 */
function navCellRect(navRect, tokens, col, row) {
  const rowH = tokens.rowH || tokens.cell || 64;
  return {
    x: navRect.x,
    y: navRect.y + row * rowH,
    width: navRect.width,
    height: rowH,
  };
}

module.exports = {
  DESIGN_HEIGHT,
  MARGIN_U,
  HEADER_H_U,
  FOOTER_H_U,
  CLUSTER_W_U,
  SOCKET_W_U,
  ROW_H_U,
  HANG_ROWS,
  // Back-compat exports
  STATUS_H_U: HEADER_H_U,
  CELL_U: ROW_H_U,
  CELL_GAP_U: 0,
  INSET_U: MARGIN_U,
  NAV_ROWS: HANG_ROWS,
  unitPx,
  px,
  computeLayout,
  navCellRect,
};
