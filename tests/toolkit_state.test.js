"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  currentCoverageWindow,
  historicalCoverageWindow,
  normalizeGroupSets,
} = require("../src/server/toolkit_state");

test("group sets require names and numeric unique group ids", () => {
  assert.deepEqual(normalizeGroupSets([
    { name: "AI 群", groupIds: ["1001", "1001", "1002"] },
    { name: "", groupIds: ["1003"] },
    { name: "无效", groupIds: ["bad"] },
  ]), [
    { name: "AI 群", groupIds: ["1001", "1002"] },
  ]);
});

test("timeline windows keep the current partial day and use complete historical ranges", () => {
  const noonHongKong = Date.UTC(2026, 6, 19, 4, 0, 0) / 1000;

  assert.deepEqual(currentCoverageWindow(7, noonHongKong), {
    fromUnix: Date.UTC(2026, 6, 12, 16, 0, 0) / 1000,
    toUnix: noonHongKong,
  });
  assert.deepEqual(historicalCoverageWindow(7, noonHongKong), {
    fromUnix: noonHongKong - 7 * 24 * 60 * 60,
    toUnix: noonHongKong,
  });
});
