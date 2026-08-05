"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  createTimelineSelection,
  extendTimelineSelection,
  filterTimelineGroups,
  isTimelineSlotSelected,
  timelineSelectionForRange,
  sortTimelineGroups,
  summarizeTimelineSelection,
} = require("../web/timeline_tools");

const slot = (startUnix, coverageRatio, messageCount, overrides) => ({
  startUnix,
  endUnix: startUnix + 100,
  coveredSeconds: coverageRatio * 100,
  coverageRatio,
  coverageSegments: coverageRatio === 0 ? [] : [{ startUnix, endUnix: startUnix + coverageRatio * 100 }],
  messageCount,
  textCount: messageCount,
  mediaCount: 0,
  speakerCount: messageCount > 0 ? 1 : 0,
  firstMessageUnix: messageCount > 0 ? startUnix + 10 : null,
  lastMessageUnix: messageCount > 0 ? startUnix + 90 : null,
  busiestHourStartUnix: messageCount > 0 ? startUnix : null,
  busiestHourMessageCount: messageCount,
  topSpeakers: messageCount > 0 ? [{ speaker: "Alice", messageCount }] : [],
  ...overrides,
});

const groups = [
  { groupId: "1001", name: "Alpha", slots: [slot(1000, 0.5, 4, {}), slot(1100, 0, 0, {})] },
  { groupId: "1002", name: "Beta", slots: [slot(1000, 1, 0, {}), slot(1100, 1, 2, {})] },
  { groupId: "1003", name: "Gamma", slots: [slot(1000, 1, 10, {}), slot(1100, 1, 8, {})] },
];

test("timeline selection stays on one row and normalizes its bounds", () => {
  const selected = createTimelineSelection("1001", 3);
  const extended = extendTimelineSelection(selected, "1001", 1);
  const restarted = extendTimelineSelection(extended, "1002", 2);

  assert.deepEqual(extended, { groupId: "1001", anchorIndex: 3, focusIndex: 1, startIndex: 1, endIndex: 3 });
  assert.equal(isTimelineSlotSelected(extended, "1001", 2), true);
  assert.equal(isTimelineSlotSelected(extended, "1002", 2), false);
  assert.deepEqual(restarted, { groupId: "1002", anchorIndex: 2, focusIndex: 2, startIndex: 2, endIndex: 2 });
});

test("timeline selection aggregates useful details and merges adjacent repair gaps", () => {
  const summary = summarizeTimelineSelection(groups, extendTimelineSelection(createTimelineSelection("1001", 0), "1001", 1));

  assert.equal(summary.groupId, "1001");
  assert.equal(summary.slotCount, 2);
  assert.equal(summary.startUnix, 1000);
  assert.equal(summary.endUnix, 1200);
  assert.equal(summary.coverageRatio, 0.25);
  assert.equal(summary.missingSeconds, 150);
  assert.equal(summary.messageCount, 4);
  assert.deepEqual(summary.repairBatches, [{ groupIds: ["1001"], startUnix: 1050, endUnix: 1200 }]);
});

test("overall selection reports unique affected groups and combines identical repair windows", () => {
  const summary = summarizeTimelineSelection(groups, createTimelineSelection("all", 0));

  assert.equal(summary.groupId, "all");
  assert.equal(summary.totalGroupCount, 3);
  assert.equal(summary.activeGroupCount, 2);
  assert.equal(summary.emptyGroupCount, 1);
  assert.equal(summary.affectedGroupCount, 1);
  assert.equal(summary.messageCount, 14);
  assert.deepEqual(summary.repairBatches, [{ groupIds: ["1001"], startUnix: 1050, endUnix: 1100 }]);
});

test("timeline filters rows by state without changing their slots", () => {
  assert.deepEqual(filterTimelineGroups(groups, "gaps").map((group) => group.groupId), ["1001"]);
  assert.deepEqual(filterTimelineGroups(groups, "result").map((group) => group.groupId), ["1001", "1002", "1003"]);
  assert.deepEqual(filterTimelineGroups(groups, "no-messages").map((group) => group.groupId), ["1002"]);
  assert.throws(() => filterTimelineGroups(groups, "invalid"), /Unsupported timeline filter/u);
});

test("timeline sorting prioritizes missing time, messages and latest activity", () => {
  assert.deepEqual(sortTimelineGroups(groups, "gaps").map((group) => group.groupId), ["1001", "1002", "1003"]);
  assert.deepEqual(sortTimelineGroups(groups, "messages").map((group) => group.groupId), ["1003", "1001", "1002"]);
  assert.deepEqual(sortTimelineGroups(groups, "recent").map((group) => group.groupId), ["1002", "1003", "1001"]);
  assert.deepEqual(groups.map((group) => group.groupId), ["1001", "1002", "1003"]);
  assert.throws(() => sortTimelineGroups(groups, "invalid"), /Unsupported timeline sort/u);
});

test("timeline locates a gallery event across every overlapping slot", () => {
  const selection = timelineSelectionForRange(groups, "1002", 1040, 1160);

  assert.deepEqual(selection, {
    groupId: "1002",
    anchorIndex: 0,
    focusIndex: 1,
    startIndex: 0,
    endIndex: 1,
  });
  assert.equal(timelineSelectionForRange(groups, "missing", 1040, 1160), null);
  assert.equal(timelineSelectionForRange(groups, "1002", 1300, 1400), null);
});
