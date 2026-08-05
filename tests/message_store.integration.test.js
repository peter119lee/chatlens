"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const messageStore = require("../src/message_store");

test("coverage timeline separates scan coverage from useful activity details", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "qq-summary-timeline-"));
  const db = messageStore.openStore(path.join(tempDir, "messages.db"));

  try {
    const insertRange = db.prepare(
      "INSERT INTO scan_ranges (group_id, start_unix, end_unix, run_id) VALUES (?, ?, ?, ?)",
    );
    insertRange.run("1001", 100000, 101200, "run-a");
    insertRange.run("1001", 100800, 102000, "run-b");
    insertRange.run("1002", 100500, 101500, "run-c");
    insertRange.run("1003", 100000, 102000, "run-d");

    const insertMessage = db.prepare(`
      INSERT INTO messages (group_id, row_id, sent_at, speaker, text, is_media, media_kinds, speaker_uin)
      VALUES (?, ?, ?, ?, ?, ?, ?, '')
    `);
    insertMessage.run("1001", "1", 100100, "Alice", "first", 0, "");
    insertMessage.run("1001", "2", 100800, "Alice", "follow up", 0, "");
    insertMessage.run("1001", "4", 100900, "Bob", "latest", 0, "");
    insertMessage.run("1001", "3", 101100, "Carol", "image caption", 1, "image");
    db.prepare("INSERT INTO group_names (group_id, name) VALUES (?, ?)").run("1001", "Test group");

    const groups = messageStore.getCoverageTimeline(db, ["1001", "1002", "1003"], 100000, 102000, 1000);

    assert.equal(groups.length, 3);
    assert.equal(groups[0].name, "Test group");
    assert.deepEqual(groups[0].slots.map((slot) => slot.coverageRatio), [1, 1]);
    assert.equal(groups[0].slots[0].messageCount, 3);
    assert.equal(groups[0].slots[0].textCount, 3);
    assert.equal(groups[0].slots[0].mediaCount, 0);
    assert.equal(groups[0].slots[0].speakerCount, 2);
    assert.deepEqual(groups[0].slots[0].topSpeakers, [
      { speaker: "Alice", messageCount: 2 },
      { speaker: "Bob", messageCount: 1 },
    ]);
    assert.equal(groups[0].slots[0].firstMessageUnix, 100100);
    assert.equal(groups[0].slots[0].lastMessageUnix, 100900);
    assert.equal(groups[0].slots[0].busiestHourStartUnix, 100000);
    assert.equal(groups[0].slots[0].busiestHourMessageCount, 3);
    assert.equal(groups[0].slots[1].mediaCount, 1);
    assert.equal(groups[0].slots[1].textCount, 0);
    assert.deepEqual(groups[1].slots.map((slot) => slot.coverageRatio), [0.5, 0.5]);
    assert.equal(groups[1].slots[0].coverageStartUnix, 100500);
    assert.equal(groups[1].slots[0].coverageEndUnix, 101000);
    assert.equal(groups[1].slots[0].coverageSegmentCount, 1);
    assert.deepEqual(groups[1].slots[0].coverageSegments, [{ startUnix: 100500, endUnix: 101000 }]);
    assert.equal(groups[1].slots[0].messageCount, 0);
    assert.deepEqual(groups[1].slots[0].topSpeakers, []);
    assert.deepEqual(groups[2].slots.map((slot) => slot.coverageRatio), [1, 1]);
    assert.deepEqual(groups[2].slots.map((slot) => slot.messageCount), [0, 0]);
  } finally {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("coverage health returns exact gaps and groups identical rescan batches", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "qq-summary-gaps-"));
  const db = messageStore.openStore(path.join(tempDir, "messages.db"));

  try {
    const insertRange = db.prepare(
      "INSERT INTO scan_ranges (group_id, start_unix, end_unix, run_id) VALUES (?, ?, ?, ?)",
    );
    insertRange.run("1001", 100000, 100500, "run-a");
    insertRange.run("1001", 100700, 101000, "run-b");
    insertRange.run("1002", 100000, 100500, "run-a");
    insertRange.run("1002", 100700, 101000, "run-b");
    insertRange.run("1003", 100200, 101000, "run-c");

    const health = messageStore.getCoverageHealth(db, ["1001", "1002", "1003"], 100000, 101000);

    assert.equal(health.coveredSeconds, 2400);
    assert.equal(health.totalSeconds, 3000);
    assert.equal(health.coverageRatio, 0.8);
    assert.equal(health.missingSeconds, 600);
    assert.equal(health.affectedGroupCount, 3);
    assert.equal(health.earliestGapUnix, 100000);
    assert.deepEqual(health.gaps, [
      { groupId: "1001", startUnix: 100500, endUnix: 100700 },
      { groupId: "1002", startUnix: 100500, endUnix: 100700 },
      { groupId: "1003", startUnix: 100000, endUnix: 100200 },
    ]);
    assert.deepEqual(health.batches, [
      { groupIds: ["1003"], startUnix: 100000, endUnix: 100200 },
      { groupIds: ["1001", "1002"], startUnix: 100500, endUnix: 100700 },
    ]);
  } finally {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("gallery range activity keeps message results separate from scan coverage", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "qq-summary-gallery-range-"));
  const db = messageStore.openStore(path.join(tempDir, "messages.db"));

  try {
    const insertRange = db.prepare(
      "INSERT INTO scan_ranges (group_id, start_unix, end_unix, run_id) VALUES (?, ?, ?, ?)",
    );
    insertRange.run("1001", 100000, 101000, "run-a");
    insertRange.run("1002", 100500, 101000, "run-b");

    const insertMessage = db.prepare(`
      INSERT INTO messages (group_id, row_id, sent_at, speaker, text, is_media, media_kinds, speaker_uin)
      VALUES (?, ?, ?, ?, ?, ?, ?, '')
    `);
    insertMessage.run("1001", "1", 100100, "Alice", "text", 0, "");
    insertMessage.run("1001", "2", 100200, "Alice", "", 1, "image");

    const activity = messageStore.getRangeActivity(db, ["1001", "1002", "1003"], 100000, 101000);

    assert.deepEqual(activity, [
      { groupId: "1001", messageCount: 2, mediaMessageCount: 1, coveredSeconds: 1000, coverageRatio: 1 },
      { groupId: "1002", messageCount: 0, mediaMessageCount: 0, coveredSeconds: 500, coverageRatio: 0.5 },
      { groupId: "1003", messageCount: 0, mediaMessageCount: 0, coveredSeconds: 0, coverageRatio: 0 },
    ]);
  } finally {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("gallery event activity batches related message counts and coverage", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "qq-summary-gallery-events-"));
  const db = messageStore.openStore(path.join(tempDir, "messages.db"));

  try {
    db.prepare("INSERT INTO scan_ranges (group_id, start_unix, end_unix, run_id) VALUES (?, ?, ?, ?)")
      .run("1001", 100000, 101000, "run-a");
    const insertMessage = db.prepare(`
      INSERT INTO messages (group_id, row_id, sent_at, speaker, text, is_media, media_kinds, speaker_uin)
      VALUES (?, ?, ?, ?, ?, ?, ?, '')
    `);
    insertMessage.run("1001", "1", 100100, "Alice", "before", 0, "");
    insertMessage.run("1001", "2", 100200, "Bob", "", 1, "image");
    insertMessage.run("1001", "3", 100300, "Alice", "after", 0, "");

    const activity = messageStore.getEventActivity(db, [
      { id: "event-a", groupId: "1001", fromUnix: 100050, toUnix: 100250 },
      { id: "event-b", groupId: "1002", fromUnix: 100000, toUnix: 101000 },
    ]);

    assert.deepEqual(activity, [
      {
        id: "event-a",
        messageCount: 2,
        mediaMessageCount: 1,
        speakerCount: 2,
        firstMessageUnix: 100100,
        lastMessageUnix: 100200,
        coverageRatio: 1,
        missingSeconds: 0,
      },
      {
        id: "event-b",
        messageCount: 0,
        mediaMessageCount: 0,
        speakerCount: 0,
        firstMessageUnix: null,
        lastMessageUnix: null,
        coverageRatio: 0,
        missingSeconds: 1000,
      },
    ]);
  } finally {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("message ingestion keeps old history instead of applying a retention cutoff", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "qq-summary-permanent-store-"));
  const db = messageStore.openStore(path.join(tempDir, "messages.db"));

  try {
    const result = messageStore.ingestExport(db, {
      groupIds: ["1001"],
      groupNames: { "1001": "Archive group" },
      startUnix: 1,
      endUnix: 10,
      coveredFromUnix: 1,
      messages: [{
        groupId: "1001",
        rowId: "1",
        sentAt: 2,
        senderName: "Alice",
        senderUin: "2001",
        text: "permanent history",
      }],
      mediaMessages: [],
    }, "archive-run");

    assert.equal(result.inserted, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM messages").get().count, 1);
    assert.deepEqual(messageStore.getCoverage(db, "1001"), [{ startUnix: 1, endUnix: 10 }]);
  } finally {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
