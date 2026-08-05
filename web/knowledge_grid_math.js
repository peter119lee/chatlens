"use strict";

// Pure layout arithmetic for the windowed grid, kept apart from the DOM so it can
// be tested directly. Loaded in the browser as a classic script (window.*) and
// required by tests in Node.
//
// The model: a uniform grid. Row height is fixed per density (cards are uniform
// because the prompt text is clamped), so a row's position is arithmetic and no
// per-item measurement or observer is needed.

const VIRTUAL_THRESHOLD = 240;
const ROW_BUFFER = 2;

// rowHeight must match the rendered card height in CSS for each density.
const DENSITY_METRICS = {
  detail: { rowHeight: 218, gap: 14, minColumnWidth: 320 },
  compact: { rowHeight: 184, gap: 8, minColumnWidth: 132 },
};

const metricsFor = (density) => DENSITY_METRICS[density] ?? DENSITY_METRICS.detail;

// How many cards fit across. At least one, so a narrow window still renders.
const columnsFor = (containerWidth, metrics) => {
  const usable = Math.max(Number(containerWidth) || 0, metrics.minColumnWidth);
  return Math.max(1, Math.floor((usable + metrics.gap) / (metrics.minColumnWidth + metrics.gap)));
};

const rowStride = (metrics) => metrics.rowHeight + metrics.gap;

// Total scrollable height, so the scrollbar reflects the whole result set even
// though only a window exists in the DOM. No trailing gap after the last row.
const totalHeight = (itemCount, columns, metrics) => {
  const rows = Math.ceil(itemCount / columns);
  return rows === 0 ? 0 : rows * rowStride(metrics) - metrics.gap;
};

// The slice of items to render for a given scroll position, padded by ROW_BUFFER
// rows on each side so scrolling does not reveal blank space before a repaint.
const windowFor = ({ itemCount, columns, metrics, scrollTop, viewportHeight }) => {
  if (itemCount === 0 || columns <= 0) {
    return { from: 0, to: -1, firstRow: 0, offsetY: 0 };
  }
  const rows = Math.ceil(itemCount / columns);
  const stride = rowStride(metrics);
  const relative = Math.max(0, Number(scrollTop) || 0);
  // firstRow is clamped to the last row: a scroll position past the end (which
  // happens when the list shrinks under the viewport) would otherwise produce
  // from > to and render nothing at all.
  const firstRow = Math.min(
    Math.max(0, rows - 1),
    Math.max(0, Math.floor(relative / stride) - ROW_BUFFER),
  );
  const lastRow = Math.min(rows - 1, Math.ceil((relative + Math.max(0, viewportHeight)) / stride) + ROW_BUFFER);
  return {
    from: firstRow * columns,
    to: Math.min(itemCount - 1, (Math.max(lastRow, firstRow) + 1) * columns - 1),
    firstRow,
    offsetY: firstRow * stride,
  };
};

// Windowing only pays off past a threshold; below it the plain grid is simpler
// and avoids the fixed-height constraint entirely.
const shouldVirtualize = (itemCount) => itemCount > VIRTUAL_THRESHOLD;

// Named for the module, NOT `api`: these are classic scripts sharing one global
// scope, and app.js already declares `const api` for its fetch helper. A second
// top-level `const api` is a SyntaxError that kills this whole file.
const knowledgeGridMath = {
  VIRTUAL_THRESHOLD,
  ROW_BUFFER,
  DENSITY_METRICS,
  metricsFor,
  columnsFor,
  rowStride,
  totalHeight,
  windowFor,
  shouldVirtualize,
};

if (typeof module !== "undefined" && module.exports !== undefined) {
  module.exports = knowledgeGridMath;
}
if (typeof window !== "undefined") {
  window.KnowledgeGridMath = knowledgeGridMath;
}
