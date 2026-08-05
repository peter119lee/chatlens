"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  metricsFor, columnsFor, rowStride, totalHeight, windowFor, shouldVirtualize,
  DENSITY_METRICS, VIRTUAL_THRESHOLD, ROW_BUFFER,
} = require("../web/knowledge_grid_math");

const detail = DENSITY_METRICS.detail;
const compact = DENSITY_METRICS.compact;

// --- density metrics -------------------------------------------------------

test("returns metrics for each known density", () => {
  assert.equal(metricsFor("detail").minColumnWidth, 320);
  assert.equal(metricsFor("compact").minColumnWidth, 132);
});

test("an unknown density falls back to detail rather than crashing", () => {
  assert.deepEqual(metricsFor("nonsense"), DENSITY_METRICS.detail);
  assert.deepEqual(metricsFor(undefined), DENSITY_METRICS.detail);
});

// --- columns ---------------------------------------------------------------

test("computes how many cards fit across", () => {
  // detail: 320 wide + 14 gap. 1000px fits 3 (3*320 + 2*14 = 988).
  assert.equal(columnsFor(1000, detail), 3);
  assert.equal(columnsFor(680, detail), 2);
  assert.equal(columnsFor(340, detail), 1);
});

test("compact fits far more columns at the same width", () => {
  assert.equal(columnsFor(1000, compact), 7);
});

test("never returns fewer than one column", () => {
  // A narrow or not-yet-measured container must still render something.
  assert.equal(columnsFor(50, detail), 1);
  assert.equal(columnsFor(0, detail), 1);
  assert.equal(columnsFor(undefined, detail), 1);
  assert.equal(columnsFor(NaN, detail), 1);
});

// --- total height ----------------------------------------------------------

test("scroll height covers every row without a trailing gap", () => {
  // 7 items at 3 columns = 3 rows.
  const height = totalHeight(7, 3, detail);

  assert.equal(height, 3 * rowStride(detail) - detail.gap);
});

test("an empty result set has no height", () => {
  assert.equal(totalHeight(0, 3, detail), 0);
});

test("a single item is one row tall", () => {
  assert.equal(totalHeight(1, 3, detail), detail.rowHeight);
});

// --- window ----------------------------------------------------------------

test("at the top, renders the first rows plus the buffer", () => {
  const view = windowFor({ itemCount: 1000, columns: 3, metrics: detail, scrollTop: 0, viewportHeight: 900 });

  assert.equal(view.from, 0);
  assert.equal(view.firstRow, 0);
  assert.equal(view.offsetY, 0);
  // 900px viewport / 232px stride ~= 4 rows, plus buffer.
  assert.ok(view.to >= 11, `expected at least 4 rows of 3, got ${view.to + 1} items`);
});

test("scrolling down moves the window and offsets it", () => {
  const stride = rowStride(detail);
  const view = windowFor({
    itemCount: 1000, columns: 3, metrics: detail, scrollTop: stride * 10, viewportHeight: 900,
  });

  assert.equal(view.firstRow, 10 - ROW_BUFFER);
  assert.equal(view.offsetY, (10 - ROW_BUFFER) * stride);
  assert.equal(view.from, (10 - ROW_BUFFER) * 3);
});

test("the window never runs past the last item", () => {
  const view = windowFor({
    itemCount: 10, columns: 3, metrics: detail, scrollTop: 100000, viewportHeight: 900,
  });

  assert.equal(view.to, 9, "must clamp to the final index, not overshoot");
  assert.ok(view.from <= 9);
});

test("an empty result set yields an empty window", () => {
  const view = windowFor({ itemCount: 0, columns: 3, metrics: detail, scrollTop: 0, viewportHeight: 900 });

  assert.equal(view.from, 0);
  assert.equal(view.to, -1, "to < from means render nothing");
});

test("a negative scroll position is treated as the top", () => {
  // getBoundingClientRect can report a positive top before the user scrolls.
  const view = windowFor({ itemCount: 100, columns: 3, metrics: detail, scrollTop: -500, viewportHeight: 900 });

  assert.equal(view.firstRow, 0);
  assert.equal(view.offsetY, 0);
});

test("windows are contiguous, so scrolling reveals no gaps", () => {
  // Walk down in small steps and confirm every index is covered by some window.
  const stride = rowStride(detail);
  const covered = new Set();
  for (let scrollTop = 0; scrollTop < stride * 40; scrollTop += stride / 3) {
    const view = windowFor({ itemCount: 120, columns: 3, metrics: detail, scrollTop, viewportHeight: 800 });
    for (let index = view.from; index <= view.to; index += 1) {
      covered.add(index);
    }
  }

  assert.equal(covered.size, 120, "every item should appear in at least one window while scrolling");
});

test("the rendered window stays small regardless of result size", () => {
  // The whole point: cost tracks the viewport, not the result count.
  const small = windowFor({ itemCount: 300, columns: 3, metrics: detail, scrollTop: 5000, viewportHeight: 900 });
  const huge = windowFor({ itemCount: 100000, columns: 3, metrics: detail, scrollTop: 5000, viewportHeight: 900 });

  assert.equal(huge.to - huge.from, small.to - small.from);
  assert.ok(huge.to - huge.from < 40, `window should be a few rows, got ${huge.to - huge.from + 1} items`);
});

test("a taller viewport renders proportionally more", () => {
  const short = windowFor({ itemCount: 1000, columns: 3, metrics: detail, scrollTop: 0, viewportHeight: 400 });
  const tall = windowFor({ itemCount: 1000, columns: 3, metrics: detail, scrollTop: 0, viewportHeight: 1600 });

  assert.ok(tall.to > short.to);
});

// --- threshold -------------------------------------------------------------

test("small result sets skip windowing", () => {
  assert.equal(shouldVirtualize(10), false);
  assert.equal(shouldVirtualize(VIRTUAL_THRESHOLD), false);
  assert.equal(shouldVirtualize(VIRTUAL_THRESHOLD + 1), true);
});
