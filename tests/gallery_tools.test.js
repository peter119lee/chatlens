"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  buildGalleryEvents,
  buildGalleryEventsForMatches,
  buildGalleryStory,
  compareGalleryCollections,
  filterGalleryEventsByReview,
  filterGalleryItems,
  galleryEmptyState,
  galleryMessageRowCandidates,
  galleryPresentation,
  galleryNeighborPath,
  groupGalleryPropagation,
  groupGalleryItemsByDay,
  normalizeGalleryReview,
  summarizeGalleryItems,
} = require("../web/gallery_tools");

const items = [
  { webPath: "/runs/c.jpg", groupId: "2", groupName: "Beta", speaker: "Bo", kind: "video", hkt: "2026-07-15 09:00:00", bytes: 300 },
  { webPath: "/runs/a.jpg", groupId: "1", groupName: "Alpha", speaker: "Ann", kind: "image", hkt: "2026-07-14 10:00:00", bytes: 100 },
  { webPath: "/runs/b.jpg", groupId: "1", groupName: "Alpha", speaker: "Bo", kind: "image", hkt: "2026-07-14 11:00:00", bytes: 200 },
  { webPath: "/runs/duplicate.jpg", groupId: "1", groupName: "Alpha", speaker: "Ann", kind: "image", hkt: "2026-07-14 12:00:00", bytes: 400, dup: true },
];

test("gallery filtering combines group, type, person and time without mutating input", () => {
  const filtered = filterGalleryItems(items, {
    groupId: "1",
    kind: "image",
    speaker: "bo",
    fromUnix: Date.UTC(2026, 6, 14, 2, 30, 0) / 1000,
    toUnix: Date.UTC(2026, 6, 14, 4, 0, 0) / 1000,
    sort: "time-desc",
  });

  assert.deepEqual(filtered.map((item) => item.webPath), ["/runs/b.jpg"]);
  assert.deepEqual(items.map((item) => item.webPath), ["/runs/c.jpg", "/runs/a.jpg", "/runs/b.jpg", "/runs/duplicate.jpg"]);
  assert.throws(() => filterGalleryItems(items, {
    groupId: "all",
    kind: "all",
    speaker: "all",
    fromUnix: null,
    toUnix: null,
    sort: "invalid",
  }), /Unsupported gallery sort/u);
});

test("gallery grouping keeps newest day first and preserves item order", () => {
  const filtered = filterGalleryItems(items, {
    groupId: "all",
    kind: "all",
    speaker: "all",
    fromUnix: null,
    toUnix: null,
    sort: "time-desc",
  });

  assert.deepEqual(groupGalleryItemsByDay(filtered).map((group) => ({
    day: group.day,
    paths: group.items.map((item) => item.webPath),
  })), [
    { day: "2026-07-15", paths: ["/runs/c.jpg"] },
    { day: "2026-07-14", paths: ["/runs/b.jpg", "/runs/a.jpg"] },
  ]);
});

test("gallery navigation wraps inside the current filtered result", () => {
  const paths = ["/runs/a.jpg", "/runs/b.jpg", "/runs/c.jpg"];

  assert.equal(galleryNeighborPath(paths, "/runs/a.jpg", -1), "/runs/c.jpg");
  assert.equal(galleryNeighborPath(paths, "/runs/c.jpg", 1), "/runs/a.jpg");
  assert.equal(galleryNeighborPath(paths, "/runs/missing.jpg", 1), "/runs/a.jpg");
  assert.throws(() => galleryNeighborPath([], "/runs/a.jpg", 1), /at least one item/u);
  assert.throws(() => galleryNeighborPath(paths, "/runs/a.jpg", 0), /direction/u);
});

test("gallery summary reports distinct groups, people and the visible range", () => {
  const summary = summarizeGalleryItems(items.filter((item) => item.dup !== true));

  assert.deepEqual(summary, {
    itemCount: 3,
    groupCount: 2,
    speakerCount: 2,
    firstHkt: "2026-07-14 10:00:00",
    lastHkt: "2026-07-15 09:00:00",
    totalBytes: 600,
  });
});

test("gallery presentation follows the copied file type instead of manifest kind alone", () => {
  assert.equal(galleryPresentation({ kind: "video", webPath: "/runs/video-preview.PNG" }), "image");
  assert.equal(galleryPresentation({ kind: "video", webPath: "/runs/clip.mp4" }), "video");
  assert.equal(galleryPresentation({ kind: "image", webPath: "/runs/photo.webp" }), "image");
  assert.equal(galleryPresentation({ kind: "audio", webPath: "/runs/voice.amr" }), "file");
});

test("gallery events join nearby media inside one group and split at the twenty minute boundary", () => {
  const eventItems = [
    { ...items[1], hkt: "2026-07-14 10:00:00", contentKey: "a" },
    { ...items[2], hkt: "2026-07-14 10:19:59", contentKey: "b" },
    { ...items[0], groupId: "2", hkt: "2026-07-14 10:10:00", contentKey: "c" },
    { ...items[1], webPath: "/runs/d.jpg", hkt: "2026-07-14 10:40:00", contentKey: "d" },
  ];

  const events = buildGalleryEvents(eventItems, 20 * 60);

  assert.deepEqual(events.map((event) => ({
    groupId: event.groupId,
    itemCount: event.items.length,
    startHkt: event.startHkt,
    endHkt: event.endHkt,
  })), [
    { groupId: "1", itemCount: 1, startHkt: "2026-07-14 10:40:00", endHkt: "2026-07-14 10:40:00" },
    { groupId: "2", itemCount: 1, startHkt: "2026-07-14 10:10:00", endHkt: "2026-07-14 10:10:00" },
    { groupId: "1", itemCount: 2, startHkt: "2026-07-14 10:00:00", endHkt: "2026-07-14 10:19:59" },
  ]);
  assert.throws(() => buildGalleryEvents(eventItems, 0), /positive gap/u);
});

test("gallery event identity stays stable when filters match only part of an event", () => {
  const eventItems = [
    { ...items[1], hkt: "2026-07-14 10:00:00", rowId: "r1" },
    { ...items[2], hkt: "2026-07-14 10:10:00", rowId: "r2" },
  ];
  const unfiltered = buildGalleryEvents(eventItems, 20 * 60);
  const filtered = buildGalleryEventsForMatches(eventItems, [eventItems[1]], 20 * 60);

  assert.equal(unfiltered.length, 1);
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].id, unfiltered[0].id);
  assert.equal(filtered[0].items.length, 2);
});

test("gallery propagation groups exact file hashes across groups and preserves every occurrence", () => {
  const occurrences = [
    { ...items[1], contentKey: "sha-a", contentKeySource: "hash", rowId: "r1" },
    { ...items[1], webPath: "/runs/a-copy.jpg", groupId: "2", groupName: "Beta", contentKey: "sha-a", contentKeySource: "hash", rowId: "r2", dup: true },
    { ...items[2], contentKey: "sha-b", contentKeySource: "hash", rowId: "r3" },
    { ...items[2], webPath: "/runs/name-only.jpg", groupId: "2", contentKey: "same-name.jpg", contentKeySource: "filename", rowId: "r4" },
    { ...items[2], webPath: "/runs/name-only-2.jpg", contentKey: "same-name.jpg", contentKeySource: "filename", rowId: "r5" },
  ];

  const chains = groupGalleryPropagation(occurrences);

  assert.equal(chains.length, 1);
  assert.equal(chains[0].contentKey, "sha-a");
  assert.equal(chains[0].occurrences.length, 2);
  assert.equal(chains[0].groupCount, 2);
  assert.equal(chains[0].evidence, "hash");
  assert.deepEqual(chains[0].occurrences.map((item) => item.rowId), ["r1", "r2"]);
});

test("gallery comparison reports shared content and differences without mutating either side", () => {
  const left = [
    { ...items[1], contentKey: "shared", contentKeySource: "hash" },
    { ...items[2], contentKey: "left-only", contentKeySource: "hash" },
  ];
  const right = [
    { ...items[0], contentKey: "shared", contentKeySource: "hash" },
    { ...items[0], webPath: "/runs/right.jpg", contentKey: "right-only", contentKeySource: "hash", speaker: "Cara" },
  ];

  const comparison = compareGalleryCollections(left, right);

  assert.equal(comparison.sharedContentCount, 1);
  assert.deepEqual(comparison.leftOnlyContentKeys, ["left-only"]);
  assert.deepEqual(comparison.rightOnlyContentKeys, ["right-only"]);
  assert.deepEqual(comparison.left.kindCounts, { image: 2 });
  assert.deepEqual(comparison.right.speakers, ["Bo", "Cara"]);
  assert.equal(left.length, 2);
  assert.equal(right.length, 2);
});

test("gallery empty state distinguishes no scan, partial scan, scanned silence and no media", () => {
  assert.equal(galleryEmptyState({ coverageRatio: 0, messageCount: 0, mediaMessageCount: 0 }).status, "unscanned");
  assert.equal(galleryEmptyState({ coverageRatio: 0.5, messageCount: 0, mediaMessageCount: 0 }).status, "partial");
  assert.equal(galleryEmptyState({ coverageRatio: 1, messageCount: 0, mediaMessageCount: 0 }).status, "no-messages");
  assert.equal(galleryEmptyState({ coverageRatio: 1, messageCount: 8, mediaMessageCount: 0 }).status, "no-media");
  assert.equal(galleryEmptyState({ coverageRatio: 1, messageCount: 8, mediaMessageCount: 3 }).status, "media-unavailable");
});

test("gallery original-message locator accepts raw and stored media row ids", () => {
  assert.deepEqual(galleryMessageRowCandidates("123"), ["m123", "123"]);
  assert.deepEqual(galleryMessageRowCandidates("m123"), ["m123", "123"]);
  assert.deepEqual(galleryMessageRowCandidates(""), []);
});

test("gallery story separates before, event and after messages and reports coverage gaps", () => {
  const messages = [
    { rowId: "1", sentAt: 100, speaker: "Ann", text: "before", isMedia: 0 },
    { rowId: "2", sentAt: 200, speaker: "Bo", text: "caption", isMedia: 0 },
    { rowId: "3", sentAt: 250, speaker: "Bo", text: "", isMedia: 1 },
    { rowId: "4", sentAt: 400, speaker: "Cara", text: "after", isMedia: 0 },
  ];

  const story = buildGalleryStory(messages, 200, 300, [{ startUnix: 50, endUnix: 275 }], 50, 450);

  assert.deepEqual(story.before.map((message) => message.rowId), ["1"]);
  assert.deepEqual(story.during.map((message) => message.rowId), ["2", "3"]);
  assert.deepEqual(story.after.map((message) => message.rowId), ["4"]);
  assert.equal(story.coverageComplete, false);
  assert.deepEqual(story.gaps, [{ startUnix: 275, endUnix: 450 }]);
});

test("gallery review records validate local state and filter events by workflow", () => {
  const events = [
    { id: "e1" },
    { id: "e2" },
    { id: "e3" },
  ];
  const reviews = {
    e1: normalizeGalleryReview({ status: "reviewed", favorite: true, note: "done" }),
    e2: normalizeGalleryReview({ status: "follow-up", favorite: false, note: "check" }),
  };

  assert.deepEqual(filterGalleryEventsByReview(events, reviews, "unreviewed").map((event) => event.id), ["e3"]);
  assert.deepEqual(filterGalleryEventsByReview(events, reviews, "favorite").map((event) => event.id), ["e1"]);
  assert.deepEqual(filterGalleryEventsByReview(events, reviews, "follow-up").map((event) => event.id), ["e2"]);
  assert.throws(() => normalizeGalleryReview({ status: "invalid", favorite: false, note: "" }), /review status/u);
  assert.throws(() => normalizeGalleryReview({ status: "reviewed", favorite: false }), /review note/u);
});
