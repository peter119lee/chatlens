"use strict";

const GalleryTools = (() => {
  const HKT_OFFSET_SECONDS = 8 * 60 * 60;

  const hktToUnix = (text) => {
    const match = String(text).match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/u);
    if (match === null) {
      throw new Error(`Invalid gallery HKT timestamp: ${text}`);
    }
    return Math.floor(Date.UTC(+match[1], +match[2] - 1, +match[3], +match[4], +match[5], +match[6]) / 1000)
      - HKT_OFFSET_SECONDS;
  };

  const applyGalleryFilters = (items, filters) => {
    const comparators = {
      "time-desc": (left, right) => right.hkt.localeCompare(left.hkt),
      "time-asc": (left, right) => left.hkt.localeCompare(right.hkt),
      "size-desc": (left, right) => right.bytes - left.bytes || right.hkt.localeCompare(left.hkt),
    };
    const comparator = comparators[filters.sort];
    if (comparator === undefined) {
      throw new Error(`Unsupported gallery sort: ${filters.sort}`);
    }
    return items
      .filter((item) => filters.groupId === "all" || item.groupId === filters.groupId)
      .filter((item) => filters.kind === "all" || item.kind === filters.kind)
      .filter((item) => filters.speaker === "all" || item.speaker.toLocaleLowerCase().includes(filters.speaker.toLocaleLowerCase()))
      .filter((item) => filters.fromUnix === null || hktToUnix(item.hkt) >= filters.fromUnix)
      .filter((item) => filters.toUnix === null || hktToUnix(item.hkt) < filters.toUnix)
      .sort(comparator);
  };

  const filterGalleryItems = (items, filters) => applyGalleryFilters(
    items.filter((item) => item.dup !== true),
    filters,
  );

  const filterGalleryOccurrences = (items, filters) => applyGalleryFilters(items, filters);

  const groupGalleryItemsByDay = (items) => {
    const grouped = new Map();
    for (const item of items) {
      const day = item.hkt.slice(0, 10);
      grouped.set(day, [...(grouped.get(day) ?? []), item]);
    }
    return [...grouped.entries()].map(([day, dayItems]) => ({ day, items: dayItems }));
  };

  const summarizeEvent = (items) => {
    const ordered = [...items].sort((left, right) => left.hkt.localeCompare(right.hkt));
    const first = ordered[0];
    const last = ordered.at(-1);
    const firstEvidence = first.rowId || first.contentKey || first.webPath;
    const kindCounts = ordered.reduce(
      (counts, item) => ({ ...counts, [item.kind]: (counts[item.kind] ?? 0) + 1 }),
      {},
    );
    return {
      id: `event:${first.groupId}:${firstEvidence}:${hktToUnix(first.hkt)}`,
      groupId: first.groupId,
      groupName: first.groupName || first.groupId,
      startHkt: first.hkt,
      endHkt: last.hkt,
      startUnix: hktToUnix(first.hkt),
      endUnix: hktToUnix(last.hkt),
      speakers: [...new Set(ordered.map((item) => item.speaker))].sort(),
      kindCounts,
      totalBytes: ordered.reduce((total, item) => total + item.bytes, 0),
      items: ordered,
    };
  };

  const buildGalleryEvents = (items, gapSeconds) => {
    if (!Number.isFinite(gapSeconds) || gapSeconds <= 0) {
      throw new Error(`Gallery event grouping requires a positive gap: ${gapSeconds}`);
    }
    const byGroup = new Map();
    for (const item of items) {
      byGroup.set(item.groupId, [...(byGroup.get(item.groupId) ?? []), item]);
    }
    return [...byGroup.values()]
      .flatMap((groupItems) => [...groupItems]
        .sort((left, right) => left.hkt.localeCompare(right.hkt))
        .reduce((events, item) => {
          const previous = events.at(-1);
          const previousItem = previous?.at(-1);
          if (previousItem !== undefined && hktToUnix(item.hkt) - hktToUnix(previousItem.hkt) <= gapSeconds) {
            return [...events.slice(0, -1), [...previous, item]];
          }
          return [...events, [item]];
        }, [])
        .map(summarizeEvent))
      .sort((left, right) => right.startUnix - left.startUnix || left.groupId.localeCompare(right.groupId));
  };

  const buildGalleryEventsForMatches = (allItems, matchedItems, gapSeconds) => {
    const matchedPaths = new Set(matchedItems.map((item) => item.webPath));
    return buildGalleryEvents(allItems, gapSeconds)
      .filter((event) => event.items.some((item) => matchedPaths.has(item.webPath)));
  };

  const groupGalleryPropagation = (items) => {
    const byContent = new Map();
    for (const item of items) {
      if (item.contentKeySource === "hash" && typeof item.contentKey === "string" && item.contentKey.length > 0) {
        byContent.set(item.contentKey, [...(byContent.get(item.contentKey) ?? []), item]);
      }
    }
    return [...byContent.entries()]
      .map(([contentKey, occurrences]) => {
        const ordered = [...occurrences].sort((left, right) =>
          left.hkt.localeCompare(right.hkt) || left.groupId.localeCompare(right.groupId));
        return {
          contentKey,
          evidence: "hash",
          firstHkt: ordered[0].hkt,
          lastHkt: ordered.at(-1).hkt,
          groupCount: new Set(ordered.map((item) => item.groupId)).size,
          speakerCount: new Set(ordered.map((item) => item.speaker)).size,
          occurrences: ordered,
        };
      })
      .filter((chain) => chain.occurrences.length > 1)
      .sort((left, right) => right.groupCount - left.groupCount || right.occurrences.length - left.occurrences.length || right.lastHkt.localeCompare(left.lastHkt));
  };

  const summarizeComparisonSide = (items) => ({
    itemCount: items.length,
    totalBytes: items.reduce((total, item) => total + item.bytes, 0),
    groupCount: new Set(items.map((item) => item.groupId)).size,
    speakers: [...new Set(items.map((item) => item.speaker))].sort(),
    kindCounts: items.reduce(
      (counts, item) => ({ ...counts, [item.kind]: (counts[item.kind] ?? 0) + 1 }),
      {},
    ),
  });

  const compareGalleryCollections = (leftItems, rightItems) => {
    const comparisonKey = (item) => item.contentKeySource === "hash" && item.contentKey
      ? item.contentKey
      : `path:${item.webPath}`;
    const leftKeys = new Set(leftItems.map(comparisonKey));
    const rightKeys = new Set(rightItems.map(comparisonKey));
    return {
      left: summarizeComparisonSide(leftItems),
      right: summarizeComparisonSide(rightItems),
      sharedContentCount: [...leftKeys].filter((key) => rightKeys.has(key)).length,
      leftOnlyContentKeys: [...leftKeys].filter((key) => !rightKeys.has(key)).sort(),
      rightOnlyContentKeys: [...rightKeys].filter((key) => !leftKeys.has(key)).sort(),
    };
  };

  const galleryEmptyState = ({ coverageRatio, messageCount, mediaMessageCount }) => {
    if (coverageRatio <= 0) {
      return { status: "unscanned", title: "没有扫描记录", detail: "结果未知，不能判断这个范围是否存在聊天或媒体。" };
    }
    if (coverageRatio < 0.999) {
      return { status: "partial", title: "扫描不完整", detail: "当前范围仍有时间缺口，空结果不能代表没有媒体。" };
    }
    if (messageCount === 0) {
      return { status: "no-messages", title: "已扫描，没有聊天", detail: "这是有效结果：当前范围内没有消息。" };
    }
    if (mediaMessageCount > 0) {
      return { status: "media-unavailable", title: "有媒体消息，但没有可展示文件", detail: `当前范围有 ${mediaMessageCount} 条媒体消息，原文件未进入现有索引或已不可用。` };
    }
    return { status: "no-media", title: "已扫描，没有媒体", detail: `当前范围有 ${messageCount} 条消息，但没有媒体消息。` };
  };

  const galleryMessageRowCandidates = (rowId) => {
    const normalized = String(rowId);
    if (normalized.length === 0) {
      return [];
    }
    if (normalized.startsWith("m")) {
      const raw = normalized.slice(1);
      return raw.length === 0 ? [normalized] : [normalized, raw];
    }
    return [`m${normalized}`, normalized];
  };

  const coverageGaps = (coverage, fromUnix, toUnix) => {
    const segments = [...coverage]
      .map((range) => ({ startUnix: Math.max(fromUnix, range.startUnix), endUnix: Math.min(toUnix, range.endUnix) }))
      .filter((range) => range.startUnix < range.endUnix)
      .sort((left, right) => left.startUnix - right.startUnix);
    const gaps = [];
    let cursor = fromUnix;
    for (const segment of segments) {
      if (segment.startUnix > cursor) {
        gaps.push({ startUnix: cursor, endUnix: segment.startUnix });
      }
      cursor = Math.max(cursor, segment.endUnix);
    }
    return cursor < toUnix ? [...gaps, { startUnix: cursor, endUnix: toUnix }] : gaps;
  };

  const buildGalleryStory = (messages, eventStartUnix, eventEndUnix, coverage, contextStartUnix, contextEndUnix) => {
    if (!Number.isFinite(eventStartUnix) || !Number.isFinite(eventEndUnix) || eventStartUnix >= eventEndUnix) {
      throw new Error(`Invalid gallery story range: ${eventStartUnix}-${eventEndUnix}`);
    }
    const ordered = [...messages].sort((left, right) => left.sentAt - right.sentAt || left.rowId.localeCompare(right.rowId));
    if (!Number.isFinite(contextStartUnix) || !Number.isFinite(contextEndUnix) || contextStartUnix > eventStartUnix || contextEndUnix < eventEndUnix) {
      throw new Error(`Invalid gallery story context: ${contextStartUnix}-${contextEndUnix}`);
    }
    const gaps = coverageGaps(coverage, contextStartUnix, contextEndUnix);
    return {
      before: ordered.filter((message) => message.sentAt < eventStartUnix),
      during: ordered.filter((message) => message.sentAt >= eventStartUnix && message.sentAt < eventEndUnix),
      after: ordered.filter((message) => message.sentAt >= eventEndUnix),
      gaps,
      coverageComplete: gaps.length === 0,
    };
  };

  const REVIEW_STATUSES = new Set(["unreviewed", "reviewed", "follow-up"]);

  const normalizeGalleryReview = (review) => {
    const status = String(review.status);
    if (!REVIEW_STATUSES.has(status)) {
      throw new Error(`Unsupported gallery review status: ${status}`);
    }
    if (typeof review.note !== "string") {
      throw new TypeError("Gallery review note must be a string");
    }
    return {
      status,
      favorite: review.favorite === true,
      note: String(review.note).trim().slice(0, 500),
    };
  };

  const filterGalleryEventsByReview = (events, reviews, filter) => {
    const predicates = {
      all: () => true,
      unreviewed: (event) => (reviews[event.id]?.status ?? "unreviewed") === "unreviewed",
      reviewed: (event) => reviews[event.id]?.status === "reviewed",
      "follow-up": (event) => reviews[event.id]?.status === "follow-up",
      favorite: (event) => reviews[event.id]?.favorite === true,
    };
    if (predicates[filter] === undefined) {
      throw new Error(`Unsupported gallery review filter: ${filter}`);
    }
    return events.filter(predicates[filter]);
  };

  const galleryPresentation = (item) => {
    const extension = item.webPath.split(/[?#]/u)[0].split(".").at(-1)?.toLowerCase() ?? "";
    if (["jpg", "jpeg", "png", "gif", "webp", "bmp", "avif"].includes(extension)) {
      return "image";
    }
    if (["mp4", "webm", "mov", "m4v", "ogg"].includes(extension)) {
      return "video";
    }
    return "file";
  };

  const galleryNeighborPath = (paths, currentPath, direction) => {
    if (paths.length === 0) {
      throw new Error("Gallery navigation requires at least one item");
    }
    if (direction !== -1 && direction !== 1) {
      throw new Error(`Gallery direction must be -1 or 1: ${direction}`);
    }
    const currentIndex = paths.indexOf(currentPath);
    const origin = currentIndex === -1 ? (direction === 1 ? -1 : 0) : currentIndex;
    return paths[(origin + direction + paths.length) % paths.length];
  };

  const summarizeGalleryItems = (items) => {
    if (items.length === 0) {
      return {
        itemCount: 0,
        groupCount: 0,
        speakerCount: 0,
        firstHkt: null,
        lastHkt: null,
        totalBytes: 0,
      };
    }
    const stamps = items.map((item) => item.hkt).sort();
    return {
      itemCount: items.length,
      groupCount: new Set(items.map((item) => item.groupId)).size,
      speakerCount: new Set(items.map((item) => item.speaker)).size,
      firstHkt: stamps[0],
      lastHkt: stamps.at(-1),
      totalBytes: items.reduce((total, item) => total + item.bytes, 0),
    };
  };

  return {
    buildGalleryEvents,
    buildGalleryEventsForMatches,
    buildGalleryStory,
    compareGalleryCollections,
    filterGalleryEventsByReview,
    filterGalleryItems,
    filterGalleryOccurrences,
    galleryEmptyState,
    galleryMessageRowCandidates,
    galleryPresentation,
    galleryNeighborPath,
    groupGalleryPropagation,
    groupGalleryItemsByDay,
    hktToUnix,
    normalizeGalleryReview,
    summarizeGalleryItems,
  };
})();

if (typeof module !== "undefined" && module.exports !== undefined) {
  module.exports = GalleryTools;
}
if (typeof window !== "undefined") {
  window.GalleryTools = GalleryTools;
}
