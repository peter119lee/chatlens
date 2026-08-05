"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const zlib = require("node:zlib");

const { collectImageRefs, buildOriIndex, harvestRunMedia } = require("../src/harvest_run_media");
const { openKnowledgeStore, storeSummary } = require("../src/knowledge_store");

// --- ref collection --------------------------------------------------------

const mediaMessage = (overrides) => ({
  groupId: "1001",
  groupName: "Test Group",
  rowId: "500",
  sentAt: 1700000000,
  speaker: "Alice",
  senderUin: "111",
  mediaRefs: [],
  ...overrides,
});

test("collects only image refs that carry a full md5", () => {
  const refs = collectImageRefs([
    mediaMessage({
      mediaRefs: [
        { kind: "image", hash: "a".repeat(32) },
        { kind: "video", hash: "b".repeat(32) },
        { kind: "image", hash: null },
        { kind: "image", hash: "tooshort" },
      ],
    }),
  ]);

  assert.deepEqual([...refs.keys()], ["a".repeat(32)]);
});

test("attributes a hash to the earliest message that referenced it", () => {
  // A reply or forward re-embeds the original's image ref; the first poster owns it.
  const refs = collectImageRefs([
    mediaMessage({ rowId: "900", sentAt: 1700000900, speaker: "Replier", mediaRefs: [{ kind: "image", hash: "c".repeat(32) }] }),
    mediaMessage({ rowId: "100", sentAt: 1700000100, speaker: "Author", mediaRefs: [{ kind: "image", hash: "c".repeat(32) }] }),
  ]);

  const sighting = refs.get("c".repeat(32));
  assert.equal(sighting.speaker, "Author");
  assert.equal(sighting.rowId, "100");
});

test("falls back through speaker name fields", () => {
  const refs = collectImageRefs([
    mediaMessage({ speaker: "", senderName: "", memberName: "FromMember", mediaRefs: [{ kind: "image", hash: "d".repeat(32) }] }),
  ]);

  assert.equal(refs.get("d".repeat(32)).speaker, "FromMember");
});

test("tolerates messages with no media refs at all", () => {
  assert.equal(collectImageRefs([mediaMessage({ mediaRefs: undefined })]).size, 0);
  assert.equal(collectImageRefs([]).size, 0);
});

// --- Ori index -------------------------------------------------------------

const makeNtData = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ntdata-"));
  fs.mkdirSync(path.join(root, "Pic", "2026-08", "Ori"), { recursive: true });
  fs.mkdirSync(path.join(root, "Pic", "2026-08", "Thumb"), { recursive: true });
  return root;
};

const crcTable = (() => {
  const table = new Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) === 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

const crc32 = (buffer) => {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
};

const pngChunk = (type, data) => {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);
  return Buffer.concat([length, typeAndData, crc]);
};

const writeAiPng = (filePath, parameters) => {
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(512, 0);
  ihdrData.writeUInt32BE(768, 4);
  ihdrData[8] = 8;
  ihdrData[9] = 6;
  const textData = Buffer.concat([Buffer.from("parameters", "latin1"), Buffer.from([0]), Buffer.from(parameters, "latin1")]);
  fs.writeFileSync(filePath, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdrData),
    pngChunk("tEXt", textData),
    pngChunk("IDAT", zlib.deflateSync(Buffer.alloc(16))),
    pngChunk("IEND", Buffer.alloc(0)),
  ]));
};

const writePlainPng = (filePath) => {
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(64, 0);
  ihdrData.writeUInt32BE(64, 4);
  ihdrData[8] = 8;
  ihdrData[9] = 6;
  fs.writeFileSync(filePath, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdrData),
    pngChunk("IDAT", zlib.deflateSync(Buffer.alloc(16))),
    pngChunk("IEND", Buffer.alloc(0)),
  ]));
};

test("indexes Ori files by md5 and ignores Thumb", () => {
  const root = makeNtData();
  const hash = "e".repeat(32);
  writePlainPng(path.join(root, "Pic", "2026-08", "Ori", `${hash}.png`));
  writePlainPng(path.join(root, "Pic", "2026-08", "Thumb", `${"f".repeat(32)}_720.png`));

  const index = buildOriIndex(root);

  assert.equal(index.size, 1);
  assert.ok(index.get(hash).includes("Ori"));
});

test("returns an empty index when nt_data has no Pic directory", () => {
  assert.equal(buildOriIndex(fs.mkdtempSync(path.join(os.tmpdir(), "empty-"))).size, 0);
});

// --- end-to-end harvest ----------------------------------------------------

const PARAMS = "1girl, solo\nNegative prompt: bad\nSteps: 20, Sampler: Euler, CFG scale: 7, Model: testModel";

const runHarvest = (root, mediaMessages) => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "harvest-"));
  const mediaMessagesJson = path.join(workDir, "media-messages.json");
  fs.writeFileSync(mediaMessagesJson, JSON.stringify(mediaMessages), "utf8");
  const storePath = path.join(workDir, "knowledge.db");
  const { stats } = harvestRunMedia({ mediaMessagesJson, ntDataDir: root, storePath });
  return { stats, storePath };
};

test("parses and attributes an image in one pass", () => {
  const root = makeNtData();
  const hash = "1".repeat(32);
  writeAiPng(path.join(root, "Pic", "2026-08", "Ori", `${hash}.png`), PARAMS);

  const { stats, storePath } = runHarvest(root, [
    mediaMessage({ mediaRefs: [{ kind: "image", hash }] }),
  ]);

  assert.equal(stats.parsed, 1);
  assert.equal(stats.attributed, 1);
  assert.equal(stats.originalMissing, 0);

  const db = openKnowledgeStore(storePath);
  const image = db.prepare("SELECT prompt, checkpoint FROM images WHERE hash = ?").get(hash);
  assert.equal(image.prompt, "1girl, solo");
  assert.equal(image.checkpoint, "testModel");

  const sighting = db.prepare("SELECT group_id, speaker, sent_at FROM sightings WHERE hash = ?").get(hash);
  assert.equal(sighting.group_id, "1001");
  assert.equal(sighting.speaker, "Alice");
  assert.equal(sighting.sent_at, 1700000000);
  db.close();
});

test("counts a stripped image separately and does not attribute it", () => {
  const root = makeNtData();
  const hash = "2".repeat(32);
  writePlainPng(path.join(root, "Pic", "2026-08", "Ori", `${hash}.png`));

  const { stats, storePath } = runHarvest(root, [
    mediaMessage({ mediaRefs: [{ kind: "image", hash }] }),
  ]);

  assert.equal(stats.parsed, 0);
  assert.equal(stats.stripped, 1);
  assert.equal(stats.attributed, 0, "an image with no metadata is not knowledge-base content");

  const db = openKnowledgeStore(storePath);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM images").get().c, 0);
  // Recorded in scan_state so a rescan skips it until the file or parser changes.
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM scan_state").get().c, 1);
  db.close();
});

test("counts refs whose original is absent from the cache", () => {
  const root = makeNtData();

  const { stats } = runHarvest(root, [
    mediaMessage({ mediaRefs: [{ kind: "image", hash: "3".repeat(32) }] }),
  ]);

  assert.equal(stats.imageRefs, 1);
  assert.equal(stats.originalMissing, 1);
  assert.equal(stats.parsed, 0);
});

test("re-harvesting the same export re-attributes without re-parsing", () => {
  const root = makeNtData();
  const hash = "4".repeat(32);
  writeAiPng(path.join(root, "Pic", "2026-08", "Ori", `${hash}.png`), PARAMS);
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "harvest-"));
  const mediaMessagesJson = path.join(workDir, "media-messages.json");
  fs.writeFileSync(mediaMessagesJson, JSON.stringify([mediaMessage({ mediaRefs: [{ kind: "image", hash }] })]), "utf8");
  const storePath = path.join(workDir, "knowledge.db");

  const first = harvestRunMedia({ mediaMessagesJson, ntDataDir: root, storePath });
  const second = harvestRunMedia({ mediaMessagesJson, ntDataDir: root, storePath });

  assert.equal(first.stats.parsed, 1);
  assert.equal(second.stats.parsed, 0, "unchanged file must not be re-parsed");
  assert.equal(second.stats.skipped, 1);
  assert.equal(second.stats.attributed, 1, "attribution must still be recorded on a rerun");

  const db = openKnowledgeStore(storePath);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM sightings WHERE hash = ?").get(hash).c, 1);
  db.close();
});

test("an export with no media messages does nothing and opens no store", () => {
  const root = makeNtData();
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "harvest-"));
  const mediaMessagesJson = path.join(workDir, "media-messages.json");
  fs.writeFileSync(mediaMessagesJson, "[]", "utf8");
  const storePath = path.join(workDir, "knowledge.db");

  const { stats } = harvestRunMedia({ mediaMessagesJson, ntDataDir: root, storePath });

  assert.equal(stats.imageRefs, 0);
  assert.equal(fs.existsSync(storePath), false, "no images means no reason to create a store file");
});

// --- prompt requests -------------------------------------------------------

const PROMPT_ANSWER = "masterpiece, best quality, 1girl, solo, long hair, blue eyes, looking at viewer";

test("stores a prompt request alongside the image it points at", () => {
  const root = makeNtData();
  const hash = "5".repeat(32);
  writeAiPng(path.join(root, "Pic", "2026-08", "Ori", `${hash}.png`), PARAMS);
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "harvest-"));

  const mediaMessagesJson = path.join(workDir, "media-messages.json");
  fs.writeFileSync(mediaMessagesJson, JSON.stringify([
    mediaMessage({ mediaRefs: [{ kind: "image", hash }] }),
  ]), "utf8");

  const exportJson = path.join(workDir, "export.json");
  fs.writeFileSync(exportJson, JSON.stringify({
    messages: [
      { groupId: "1001", groupName: "Test Group", rowId: "600", sentAt: 1700000100, senderUin: "222", senderName: "Asker", text: "kkt" },
      { groupId: "1001", groupName: "Test Group", rowId: "700", sentAt: 1700000200, senderUin: "111", senderName: "Alice", text: PROMPT_ANSWER },
    ],
    quoteLinks: [{ groupId: "1001", rowId: "600", quotedImageHashes: [hash] }],
  }), "utf8");

  const storePath = path.join(workDir, "knowledge.db");
  const { stats } = harvestRunMedia({ mediaMessagesJson, ntDataDir: root, storePath, exportJson });

  assert.equal(stats.promptRequests, 1);
  assert.equal(stats.answeredRequests, 1);

  const db = openKnowledgeStore(storePath);
  const row = db.prepare("SELECT * FROM prompt_requests WHERE group_id = ? AND ask_row_id = ?").get("1001", "600");
  assert.equal(row.intent, "prompt");
  assert.equal(row.image_hash, hash);
  assert.equal(row.answer_text, PROMPT_ANSWER);
  assert.equal(row.answer_by, "Alice");
  assert.equal(row.target_via, "quote");
  db.close();
});

test("stores an image or file reply for an original-image request", () => {
  const root = makeNtData();
  const targetHash = "8".repeat(32);
  const replyHash = "9".repeat(32);
  writePlainPng(path.join(root, "Pic", "2026-08", "Ori", `${targetHash}.png`));
  writePlainPng(path.join(root, "Pic", "2026-08", "Ori", `${replyHash}.png`));
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "harvest-original-"));
  const mediaMessagesJson = path.join(workDir, "media-messages.json");
  fs.writeFileSync(mediaMessagesJson, JSON.stringify([
    mediaMessage({ rowId: "500", sentAt: 1700000000, mediaRefs: [{ kind: "image", hash: targetHash, fileName: `${targetHash}.png` }] }),
    mediaMessage({
      rowId: "700", sentAt: 1700000120, speaker: "Replier", senderUin: "333",
      mediaRefs: [
        { kind: "image", hash: replyHash, fileName: `${replyHash}.png` },
        { kind: "file", hash: null, fileName: "original.zip" },
      ],
    }),
  ]), "utf8");
  const exportJson = path.join(workDir, "export.json");
  fs.writeFileSync(exportJson, JSON.stringify({
    messages: [
      { groupId: "1001", rowId: "600", sentAt: 1700000100, senderUin: "222", senderName: "Asker", text: "kko" },
    ],
    quoteLinks: [{ groupId: "1001", rowId: "600", quotedImageHashes: [targetHash] }],
  }), "utf8");
  const storePath = path.join(workDir, "knowledge.db");

  const { stats } = harvestRunMedia({ mediaMessagesJson, ntDataDir: root, storePath, exportJson });

  assert.equal(stats.promptRequests, 1);
  assert.equal(stats.answeredRequests, 1);
  assert.equal(stats.placeholders, 2, "both the asked-about image and media reply stay displayable");
  const db = openKnowledgeStore(storePath);
  const row = db.prepare("SELECT answer_kind, answer_text, answer_media_json, answer_by FROM prompt_requests WHERE ask_row_id = ?").get("600");
  assert.equal(row.answer_kind, "media");
  assert.equal(row.answer_text, "");
  assert.equal(row.answer_by, "Replier");
  assert.deepEqual(JSON.parse(row.answer_media_json), [
    { kind: "image", hash: replyHash, fileName: `${replyHash}.png` },
    { kind: "file", hash: null, fileName: "original.zip" },
  ]);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM images WHERE hash IN (?, ?)").get(targetHash, replyHash).c, 2);
  db.close();
});

test("records an ask even when the window contributed no images", () => {
  const root = makeNtData();
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "harvest-"));
  const mediaMessagesJson = path.join(workDir, "media-messages.json");
  fs.writeFileSync(mediaMessagesJson, "[]", "utf8");
  const exportJson = path.join(workDir, "export.json");
  fs.writeFileSync(exportJson, JSON.stringify({
    messages: [{ groupId: "1001", rowId: "600", sentAt: 1700000100, senderUin: "222", senderName: "Asker", text: "kkt" }],
    quoteLinks: [],
  }), "utf8");
  const storePath = path.join(workDir, "knowledge.db");

  const { stats } = harvestRunMedia({ mediaMessagesJson, ntDataDir: root, storePath, exportJson });

  assert.equal(stats.imageRefs, 0);
  assert.equal(stats.promptRequests, 1, "an ask is a signal even with no image harvested");
  assert.equal(fs.existsSync(storePath), true);
});

test("a later run does not erase an answer it cannot see", () => {
  const root = makeNtData();
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "harvest-"));
  const mediaMessagesJson = path.join(workDir, "media-messages.json");
  fs.writeFileSync(mediaMessagesJson, "[]", "utf8");
  const storePath = path.join(workDir, "knowledge.db");

  const withAnswer = path.join(workDir, "with-answer.json");
  fs.writeFileSync(withAnswer, JSON.stringify({
    messages: [
      { groupId: "1001", rowId: "600", sentAt: 1700000100, senderUin: "222", senderName: "Asker", text: "kkt" },
      { groupId: "1001", rowId: "700", sentAt: 1700000200, senderUin: "111", senderName: "Alice", text: PROMPT_ANSWER },
    ],
    quoteLinks: [],
  }), "utf8");

  // A narrower re-scan that includes the ask but not the reply.
  const withoutAnswer = path.join(workDir, "without-answer.json");
  fs.writeFileSync(withoutAnswer, JSON.stringify({
    messages: [{ groupId: "1001", rowId: "600", sentAt: 1700000100, senderUin: "222", senderName: "Asker", text: "kkt" }],
    quoteLinks: [],
  }), "utf8");

  harvestRunMedia({ mediaMessagesJson, ntDataDir: root, storePath, exportJson: withAnswer });
  harvestRunMedia({ mediaMessagesJson, ntDataDir: root, storePath, exportJson: withoutAnswer });

  const db = openKnowledgeStore(storePath);
  const row = db.prepare("SELECT answer_text, answer_by FROM prompt_requests WHERE ask_row_id = ?").get("600");
  assert.equal(row.answer_text, PROMPT_ANSWER, "a captured answer must survive a re-scan that misses it");
  assert.equal(row.answer_by, "Alice");
  db.close();
});

test("ignores a malformed export instead of failing the harvest", () => {
  const root = makeNtData();
  const hash = "6".repeat(32);
  writeAiPng(path.join(root, "Pic", "2026-08", "Ori", `${hash}.png`), PARAMS);
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "harvest-"));
  const mediaMessagesJson = path.join(workDir, "media-messages.json");
  fs.writeFileSync(mediaMessagesJson, JSON.stringify([mediaMessage({ mediaRefs: [{ kind: "image", hash }] })]), "utf8");
  const exportJson = path.join(workDir, "broken.json");
  fs.writeFileSync(exportJson, "{ not json at all", "utf8");

  const { stats } = harvestRunMedia({
    mediaMessagesJson, ntDataDir: root, storePath: path.join(workDir, "knowledge.db"), exportJson,
  });

  assert.equal(stats.parsed, 1, "image harvesting must not depend on the export parsing");
  assert.equal(stats.promptRequests, 0);
});

test("keeps a placeholder image row when the ask target had its metadata stripped", () => {
  // The common real case: somebody asks for the prompt precisely BECAUSE QQ
  // stripped the parameters, so the target has no parsed metadata to store.
  const root = makeNtData();
  const hash = "7".repeat(32);
  writePlainPng(path.join(root, "Pic", "2026-08", "Ori", `${hash}.png`));
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "harvest-"));

  const mediaMessagesJson = path.join(workDir, "media-messages.json");
  fs.writeFileSync(mediaMessagesJson, JSON.stringify([
    mediaMessage({ mediaRefs: [{ kind: "image", hash }], sentAt: 1700000000 }),
  ]), "utf8");

  const exportJson = path.join(workDir, "export.json");
  fs.writeFileSync(exportJson, JSON.stringify({
    messages: [
      { groupId: "1001", rowId: "600", sentAt: 1700000060, senderUin: "222", senderName: "Asker", text: "kkt" },
      { groupId: "1001", rowId: "700", sentAt: 1700000120, senderUin: "111", senderName: "Alice", text: PROMPT_ANSWER },
    ],
    quoteLinks: [{ groupId: "1001", rowId: "600", quotedImageHashes: [hash] }],
  }), "utf8");

  const storePath = path.join(workDir, "knowledge.db");
  const { stats } = harvestRunMedia({ mediaMessagesJson, ntDataDir: root, storePath, exportJson });

  assert.equal(stats.stripped, 1);
  assert.equal(stats.placeholders, 1);

  const db = openKnowledgeStore(storePath);
  const image = db.prepare("SELECT generator, prompt, file_path FROM images WHERE hash = ?").get(hash);
  assert.equal(image.generator, "stripped", "marks that nothing was read from the file");
  assert.equal(image.prompt, "", "the placeholder must not invent a prompt");
  assert.ok(image.file_path.length > 0, "the picture itself is still on disk and displayable");

  // The chat-sourced prompt is joinable to the picture.
  const joined = db.prepare(`
    SELECT r.answer_text FROM prompt_requests r JOIN images i ON i.hash = r.image_hash WHERE r.ask_row_id = ?
  `).get("600");
  assert.equal(joined.answer_text, PROMPT_ANSWER);

  // Placeholders must not inflate the knowledge-base image count.
  const summary = storeSummary(db);
  assert.equal(summary.images, 0);
  assert.equal(summary.placeholders, 1);
  db.close();
});

test("does not create a placeholder for an unresolved ask", () => {
  const root = makeNtData();
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "harvest-"));
  const mediaMessagesJson = path.join(workDir, "media-messages.json");
  fs.writeFileSync(mediaMessagesJson, "[]", "utf8");
  const exportJson = path.join(workDir, "export.json");
  fs.writeFileSync(exportJson, JSON.stringify({
    messages: [{ groupId: "1001", rowId: "600", sentAt: 1700000100, senderUin: "222", senderName: "Asker", text: "kkt" }],
    quoteLinks: [],
  }), "utf8");
  const storePath = path.join(workDir, "knowledge.db");

  const { stats } = harvestRunMedia({ mediaMessagesJson, ntDataDir: root, storePath, exportJson });

  assert.equal(stats.placeholders, 0);
  const db = openKnowledgeStore(storePath);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM images").get().c, 0);
  db.close();
});
