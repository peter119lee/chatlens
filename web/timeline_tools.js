"use strict";

const TimelineTools = (() => {
  const createTimelineSelection = (groupId, index) => ({
    groupId,
    anchorIndex: index,
    focusIndex: index,
    startIndex: index,
    endIndex: index,
  });

  const extendTimelineSelection = (selection, groupId, index) => {
    if (selection === null || selection.groupId !== groupId) {
      return createTimelineSelection(groupId, index);
    }
    return {
      groupId,
      anchorIndex: selection.anchorIndex,
      focusIndex: index,
      startIndex: Math.min(selection.anchorIndex, index),
      endIndex: Math.max(selection.anchorIndex, index),
    };
  };

  const isTimelineSlotSelected = (selection, groupId, index) =>
    selection !== null &&
    selection.groupId === groupId &&
    index >= selection.startIndex &&
    index <= selection.endIndex;

  const timelineSelectionForRange = (groups, groupId, fromUnix, toUnix) => {
    const group = groups.find((candidate) => candidate.groupId === groupId);
    if (group === undefined) {
      return null;
    }
    const indexes = group.slots
      .map((slot, index) => ({ slot, index }))
      .filter(({ slot }) => slot.startUnix < toUnix && slot.endUnix > fromUnix)
      .map(({ index }) => index);
    if (indexes.length === 0) {
      return null;
    }
    return {
      groupId,
      anchorIndex: indexes[0],
      focusIndex: indexes.at(-1),
      startIndex: indexes[0],
      endIndex: indexes.at(-1),
    };
  };

  const timelineGapSegments = (slot) => {
    const gaps = [];
    let cursor = slot.startUnix;
    const segments = [...(slot.coverageSegments ?? [])]
      .sort((left, right) => left.startUnix - right.startUnix);
    for (const segment of segments) {
      if (segment.startUnix > cursor) {
        gaps.push({ startUnix: cursor, endUnix: segment.startUnix });
      }
      cursor = Math.max(cursor, segment.endUnix);
    }
    if (cursor < slot.endUnix) {
      gaps.push({ startUnix: cursor, endUnix: slot.endUnix });
    }
    return gaps;
  };

  const mergeAdjacentBatches = (batches) => {
    const byGroups = new Map();
    for (const batch of batches) {
      const groupIds = [...new Set(batch.groupIds.map(String))].sort();
      const key = groupIds.join(",");
      byGroups.set(key, [...(byGroups.get(key) ?? []), { ...batch, groupIds }]);
    }
    const adjacent = [...byGroups.values()].flatMap((items) =>
      [...items]
        .sort((left, right) => left.startUnix - right.startUnix || left.endUnix - right.endUnix)
        .reduce((merged, item) => {
          const previous = merged.at(-1);
          if (previous !== undefined && item.startUnix <= previous.endUnix) {
            return [...merged.slice(0, -1), { ...previous, endUnix: Math.max(previous.endUnix, item.endUnix) }];
          }
          return [...merged, item];
        }, []));
    const byRange = new Map();
    for (const batch of adjacent) {
      const key = `${batch.startUnix}:${batch.endUnix}`;
      byRange.set(key, [...(byRange.get(key) ?? []), ...batch.groupIds]);
    }
    return [...byRange.entries()]
      .map(([key, groupIds]) => {
        const [startUnix, endUnix] = key.split(":").map(Number);
        return { groupIds: [...new Set(groupIds)].sort(), startUnix, endUnix };
      })
      .sort((left, right) => left.startUnix - right.startUnix || left.endUnix - right.endUnix);
  };

  const groupMissingSeconds = (group) => group.slots.reduce(
    (total, slot) => total + Math.max(0, slot.endUnix - slot.startUnix - slot.coveredSeconds),
    0,
  );

  const groupMessageCount = (group) => group.slots.reduce((total, slot) => total + slot.messageCount, 0);

  const groupLatestActivity = (group) => group.slots.reduce(
    (latest, slot) => Math.max(latest, slot.lastMessageUnix ?? Number.NEGATIVE_INFINITY),
    Number.NEGATIVE_INFINITY,
  );

  const filterTimelineGroups = (groups, filter) => {
    const predicates = {
      all: () => true,
      gaps: (group) => group.slots.some((slot) => slot.coverageRatio < 0.999),
      result: (group) => group.slots.some((slot) => slot.coverageRatio > 0 && slot.messageCount > 0),
      "no-messages": (group) => group.slots.some((slot) => slot.coverageRatio > 0 && slot.messageCount === 0),
      unscanned: (group) => group.slots.some((slot) => slot.coverageRatio <= 0),
    };
    if (predicates[filter] === undefined) {
      throw new Error(`Unsupported timeline filter: ${filter}`);
    }
    return groups.filter(predicates[filter]);
  };

  const sortTimelineGroups = (groups, sort) => {
    const comparators = {
      default: () => 0,
      gaps: (left, right) => groupMissingSeconds(right) - groupMissingSeconds(left),
      messages: (left, right) => groupMessageCount(right) - groupMessageCount(left),
      recent: (left, right) => groupLatestActivity(right) - groupLatestActivity(left),
    };
    if (comparators[sort] === undefined) {
      throw new Error(`Unsupported timeline sort: ${sort}`);
    }
    return [...groups].sort(comparators[sort]);
  };

  const selectedMembers = (groups, selection) => {
    const selectedGroups = selection.groupId === "all"
      ? groups
      : groups.filter((group) => group.groupId === selection.groupId);
    if (selectedGroups.length === 0) {
      throw new Error(`Timeline selection group is unavailable: ${selection.groupId}`);
    }
    return selectedGroups.flatMap((group) => group.slots
      .slice(selection.startIndex, selection.endIndex + 1)
      .map((slot) => ({ group, slot })));
  };

  const summarizeTopSpeakers = (members) => {
    const counts = new Map();
    for (const { slot } of members) {
      for (const speaker of slot.topSpeakers ?? []) {
        counts.set(speaker.speaker, (counts.get(speaker.speaker) ?? 0) + speaker.messageCount);
      }
    }
    return [...counts.entries()]
      .map(([speaker, messageCount]) => ({ speaker, messageCount }))
      .sort((left, right) => right.messageCount - left.messageCount || left.speaker.localeCompare(right.speaker))
      .slice(0, 3);
  };

  const summarizeTimelineSelection = (groups, selection) => {
    if (selection === null) {
      throw new Error("Timeline selection is required");
    }
    const members = selectedMembers(groups, selection);
    const groupMembers = new Map(groups.map((group) => [
      group.groupId,
      members.filter((member) => member.group.groupId === group.groupId),
    ]));
    const totalSeconds = members.reduce((total, member) => total + member.slot.endUnix - member.slot.startUnix, 0);
    const coveredSeconds = members.reduce((total, member) => total + member.slot.coveredSeconds, 0);
    const repairBatches = mergeAdjacentBatches(members.flatMap(({ group, slot }) =>
      timelineGapSegments(slot).map((gap) => ({ groupIds: [group.groupId], ...gap }))));
    const activeGroupCount = [...groupMembers.values()].filter((items) =>
      items.some((item) => item.slot.messageCount > 0)).length;
    const emptyGroupCount = [...groupMembers.values()].filter((items) =>
      items.some((item) => item.slot.coverageRatio > 0) && items.every((item) => item.slot.messageCount === 0)).length;
    const unscannedGroupCount = [...groupMembers.values()].filter((items) =>
      items.every((item) => item.slot.coverageRatio <= 0)).length;
    const busiest = members
      .filter((member) => member.slot.busiestHourStartUnix !== null)
      .sort((left, right) => right.slot.busiestHourMessageCount - left.slot.busiestHourMessageCount)[0];
    const firstMessages = members.map((member) => member.slot.firstMessageUnix).filter(Number.isFinite);
    const lastMessages = members.map((member) => member.slot.lastMessageUnix).filter(Number.isFinite);
    return {
      groupId: selection.groupId,
      groupName: selection.groupId === "all" ? `全部目标群 (${groups.length})` : members[0].group.name || selection.groupId,
      slotCount: selection.endIndex - selection.startIndex + 1,
      startUnix: Math.min(...members.map((member) => member.slot.startUnix)),
      endUnix: Math.max(...members.map((member) => member.slot.endUnix)),
      totalSeconds,
      coveredSeconds,
      coverageRatio: totalSeconds > 0 ? coveredSeconds / totalSeconds : 0,
      missingSeconds: totalSeconds - coveredSeconds,
      messageCount: members.reduce((total, member) => total + member.slot.messageCount, 0),
      textCount: members.reduce((total, member) => total + member.slot.textCount, 0),
      mediaCount: members.reduce((total, member) => total + member.slot.mediaCount, 0),
      speakerCount: members.reduce((total, member) => total + member.slot.speakerCount, 0),
      firstMessageUnix: firstMessages.length === 0 ? null : Math.min(...firstMessages),
      lastMessageUnix: lastMessages.length === 0 ? null : Math.max(...lastMessages),
      busiestHourStartUnix: busiest?.slot.busiestHourStartUnix ?? null,
      busiestHourMessageCount: busiest?.slot.busiestHourMessageCount ?? 0,
      topSpeakers: summarizeTopSpeakers(members),
      totalGroupCount: selection.groupId === "all" ? groups.length : 1,
      activeGroupCount,
      emptyGroupCount,
      unscannedGroupCount,
      affectedGroupCount: new Set(repairBatches.flatMap((batch) => batch.groupIds)).size,
      repairBatches,
    };
  };

  return {
    createTimelineSelection,
    extendTimelineSelection,
    filterTimelineGroups,
    isTimelineSlotSelected,
    mergeAdjacentBatches,
    sortTimelineGroups,
    summarizeTimelineSelection,
    timelineSelectionForRange,
    timelineGapSegments,
  };
})();

if (typeof module !== "undefined" && module.exports !== undefined) {
  module.exports = TimelineTools;
}
if (typeof window !== "undefined") {
  window.TimelineTools = TimelineTools;
}
