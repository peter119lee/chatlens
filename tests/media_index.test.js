"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { finalizeMediaIndex } = require("../src/server/toolkit_state");

test("media index keeps every occurrence beyond the former item limits", () => {
  const source = Array.from({ length: 12001 }, (_, index) => ({
    runId: "run-large",
    groupId: "1001",
    groupName: "large-group",
    rowId: String(index),
    hkt: `2026-01-01 00:${String(index % 60).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}`,
    speaker: "sender",
    kind: "image",
    bytes: index + 1,
    webPath: `/runs/large/${index}.jpg`,
    contentKey: `hash-${index}`,
    contentKeySource: "hash",
    dedupKey: `1001|hash-${index}`,
  }));
  const inputSnapshot = source.map((item) => ({ ...item }));

  const result = finalizeMediaIndex(source, source.length);

  assert.equal(result.truncated, false);
  assert.equal(result.scannedRefs, 12001);
  assert.equal(result.totalItems, 12001);
  assert.equal(result.items.length, 12001);
  assert.equal(result.items.some((item) => item.webPath === "/runs/large/12000.jpg"), true);
  assert.deepEqual(source, inputSnapshot);
});

test("media index retains duplicate occurrences while selecting the newest primary", () => {
  const source = [
    {
      dedupKey: "1001|same", hkt: "2026-01-01 10:00:00", webPath: "/runs/old.jpg", groupId: "1001",
    },
    {
      dedupKey: "1001|same", hkt: "2026-01-01 11:00:00", webPath: "/runs/new.jpg", groupId: "1001",
    },
  ];

  const result = finalizeMediaIndex(source, 2);

  assert.equal(result.totalItems, 1);
  assert.equal(result.items.length, 2);
  assert.equal(result.items.find((item) => item.webPath === "/runs/new.jpg").dup, false);
  assert.equal(result.items.find((item) => item.webPath === "/runs/old.jpg").dup, true);
});
