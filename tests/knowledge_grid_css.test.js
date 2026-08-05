"use strict";

// The windowed grid's arithmetic assumes a fixed row height. If the CSS card
// height and the JS rowHeight ever disagree, rows drift and cards overlap or gap.
// Assert they agree by parsing the actual stylesheet.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { DENSITY_METRICS } = require("../web/knowledge_grid_math");

const css = fs.readFileSync(path.join(__dirname, "..", "web", "app.css"), "utf8");

const heightOf = (selector) => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const rule = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, "u").exec(css);
  assert.ok(rule !== null, `selector not found in app.css: ${selector}`);
  const height = /height:\s*(\d+)px/u.exec(rule[1]);
  assert.ok(height !== null, `no height declared for ${selector}`);
  return Number.parseInt(height[1], 10);
};

const gapOf = (selector) => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const rule = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, "u").exec(css);
  assert.ok(rule !== null, `selector not found in app.css: ${selector}`);
  const gap = /gap:\s*(\d+)px/u.exec(rule[1]);
  assert.ok(gap !== null, `no gap declared for ${selector}`);
  return Number.parseInt(gap[1], 10);
};

test("detail row height matches the card height plus the gap in css", () => {
  const cardHeight = heightOf(".kb-vgrid-window.detail .kb-card");
  const gap = gapOf(".kb-vgrid-window.detail");

  assert.equal(DENSITY_METRICS.detail.gap, gap, "gap must match app.css");
  assert.equal(
    DENSITY_METRICS.detail.rowHeight,
    cardHeight + gap,
    `rowHeight (${DENSITY_METRICS.detail.rowHeight}) must equal card height (${cardHeight}) + gap (${gap})`,
  );
});

test("compact row height matches the card height plus the gap in css", () => {
  const cardHeight = heightOf(".kb-vgrid-window.compact .kb-card");
  const gap = gapOf(".kb-vgrid-window.compact");

  assert.equal(DENSITY_METRICS.compact.gap, gap, "gap must match app.css");
  assert.equal(
    DENSITY_METRICS.compact.rowHeight,
    cardHeight + gap,
    `rowHeight (${DENSITY_METRICS.compact.rowHeight}) must equal card height (${cardHeight}) + gap (${gap})`,
  );
});

test("windowed cards declare a fixed height, which the arithmetic depends on", () => {
  // Without an explicit height the row positions are guesses.
  assert.match(css, /\.kb-vgrid-window\.detail \.kb-card \{[^}]*height:\s*\d+px/u);
  assert.match(css, /\.kb-vgrid-window\.compact \.kb-card \{[^}]*height:\s*\d+px/u);
});

test("the spacer and window are positioned for the scroll illusion to work", () => {
  // The spacer carries the full height; the window is absolutely placed inside.
  assert.match(css, /\.kb-vgrid-spacer \{[^}]*position:\s*relative/u);
  assert.match(css, /\.kb-vgrid-window \{[^}]*position:\s*absolute/u);
});
