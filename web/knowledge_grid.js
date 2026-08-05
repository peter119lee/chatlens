"use strict";

/* ---------- windowed grid rendering ---------- */

// Keeps the DOM bounded when a result set is large, which in this project is the
// normal case rather than an edge case.
//
// Measured before building this: a detail card is ~21 DOM nodes, so 2,000 cards
// is ~41,000 nodes and 7,319 is ~151,000 -- enough to make scrolling and every
// later re-render slow. Windowing renders only the rows that can be seen plus a
// buffer, so cost tracks the viewport rather than the result count.
//
// All arithmetic lives in knowledge_grid_math.js (pure, unit-tested); this file
// only touches the DOM.

// Read lazily inside the mount call rather than destructured at load time: a
// top-level destructure of a missing global throws while the script is being
// parsed, which takes the whole page down instead of degrading one feature.
const gridMath = () => window.KnowledgeGridMath;

// Renders `items` into `container`, swapping the visible window on scroll.
// Returns a teardown function; callers MUST call it before re-rendering, or the
// old listeners keep firing against a detached container.
const mountVirtualGrid = ({ container, items, density, renderItem }) => {
  const math = gridMath();
  if (math === undefined) {
    // Fall back to a plain grid: fewer results render fine unwindowed, and a
    // missing helper must not blank the page.
    setChildren(container, items.map(renderItem));
    return () => {};
  }
  const { metricsFor, columnsFor, totalHeight, windowFor } = math;
  const metrics = metricsFor(density);
  let columns = columnsFor(container.clientWidth, metrics);
  let rendered = { from: -1, to: -1 };
  let frame = null;

  // A spacer of the full scroll height with an absolutely positioned window
  // inside: the scrollbar stays honest while the DOM stays small.
  const spacer = el("div", { class: "kb-vgrid-spacer" });
  const pane = el("div", { class: `kb-vgrid-window ${density}` });
  spacer.append(pane);
  setChildren(container, spacer);

  const applyHeight = () => {
    spacer.style.height = `${totalHeight(items.length, columns, metrics)}px`;
  };

  const paint = () => {
    // The container scrolls with the page, so its offset from the viewport top
    // is what decides which rows are visible.
    const top = container.getBoundingClientRect().top;
    const view = windowFor({
      itemCount: items.length,
      columns,
      metrics,
      scrollTop: Math.max(0, -top),
      viewportHeight: window.innerHeight,
    });
    if (view.from === rendered.from && view.to === rendered.to) {
      return;
    }
    rendered = { from: view.from, to: view.to };
    pane.style.transform = `translateY(${view.offsetY}px)`;
    pane.style.gridTemplateColumns = `repeat(${columns}, minmax(0, 1fr))`;
    setChildren(pane, items.slice(view.from, view.to + 1).map(renderItem));
  };

  const schedule = () => {
    if (frame !== null) {
      return;
    }
    frame = requestAnimationFrame(() => {
      frame = null;
      paint();
    });
  };

  const onResize = () => {
    const next = columnsFor(container.clientWidth, metrics);
    if (next !== columns) {
      columns = next;
      applyHeight();
      // Same indices now map to different rows, so force a repaint.
      rendered = { from: -1, to: -1 };
    }
    schedule();
  };

  applyHeight();
  paint();
  window.addEventListener("scroll", schedule, { passive: true });
  window.addEventListener("resize", onResize);

  return () => {
    window.removeEventListener("scroll", schedule);
    window.removeEventListener("resize", onResize);
    if (frame !== null) {
      cancelAnimationFrame(frame);
    }
  };
};

window.KnowledgeGrid = { mountVirtualGrid };
