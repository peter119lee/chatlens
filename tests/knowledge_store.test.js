"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  openKnowledgeStore,
  upsertImage,
  recordSighting,
  markScanned,
  loadScanState,
  isUnchanged,
  markMissingFiles,
  storeSummary,
  tagsFromPrompt,
} = require("../src/knowledge_store");

const tempStore = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "kb-")), "knowledge.db");

const imageRecord = (overrides) => ({
  hash: "a".repeat(32),
  filePath: "C:\\cache\\Ori\\aaa.png",
  fileSize: 1024,
  fileMtime: 1700000000,
  container: "png",
  width: 1024,
  height: 1536,
  generator: "forge",
  prompt: "1girl, solo, long hair",
  negativePrompt: "worst quality",
  checkpoint: "someModel",
  modelHash: "abc123",
  params: { steps: 30, seed: "42" },
  rawChunks: { parameters: "..." },
  loras: [{ name: "styleA", weight: 0.8 }],
  parserVersion: 1,
  parsedAt: 1700000001,
  ...overrides,
});

// --- tag extraction --------------------------------------------------------

test("splits a prompt on commas and keeps multi-word danbooru tags intact", () => {
  assert.deepEqual(tagsFromPrompt("1girl, long hair, looking at viewer"), ["1girl", "long hair", "looking at viewer"]);
});

test("strips weight syntax so emphasised tags collapse to one form", () => {
  assert.deepEqual(tagsFromPrompt("(masterpiece:1.4), {{best quality}}, [solo]"), ["masterpiece", "best quality", "solo"]);
});

test("drops lora tags from the tag list", () => {
  assert.deepEqual(tagsFromPrompt("1girl, <lora:styleA:0.8>, solo"), ["1girl", "solo"]);
});

test("unescapes parenthesised character names", () => {
  assert.deepEqual(tagsFromPrompt("august von parseval \\(azur lane\\)"), ["august von parseval azur lane"]);
});

test("deduplicates repeated tags", () => {
  assert.deepEqual(tagsFromPrompt("1girl, solo, 1girl, SOLO"), ["1girl", "solo"]);
});

// --- image upsert ----------------------------------------------------------

test("stores an image with its loras, prompt tags and fts row", () => {
  const db = openKnowledgeStore(tempStore());

  upsertImage(db, imageRecord({}));

  const row = db.prepare("SELECT * FROM images WHERE hash = ?").get("a".repeat(32));
  assert.equal(row.generator, "forge");
  assert.equal(row.prompt, "1girl, solo, long hair");
  assert.equal(JSON.parse(row.params_json).steps, 30);

  const loras = db.prepare("SELECT lora_name, weight FROM image_loras WHERE hash = ?").all("a".repeat(32));
  assert.deepEqual(loras, [{ lora_name: "styleA", weight: 0.8 }]);

  const tags = db.prepare("SELECT tag FROM image_tags WHERE hash = ? ORDER BY tag").all("a".repeat(32));
  assert.deepEqual(tags.map((tag) => tag.tag), ["1girl", "long hair", "solo"]);

  const fts = db.prepare("SELECT COUNT(*) AS count FROM images_fts WHERE hash = ?").get("a".repeat(32));
  assert.equal(fts.count, 1);
  db.close();
});

test("re-upserting the same hash replaces loras and keeps one fts row", () => {
  const db = openKnowledgeStore(tempStore());

  upsertImage(db, imageRecord({}));
  upsertImage(db, imageRecord({
    prompt: "2girls, short hair",
    loras: [{ name: "styleB", weight: 1 }],
    parserVersion: 2,
  }));

  const images = db.prepare("SELECT COUNT(*) AS count FROM images").get();
  assert.equal(images.count, 1);

  const loras = db.prepare("SELECT lora_name FROM image_loras WHERE hash = ?").all("a".repeat(32));
  assert.deepEqual(loras.map((lora) => lora.lora_name), ["styleB"]);

  const tags = db.prepare("SELECT tag FROM image_tags WHERE hash = ? ORDER BY tag").all("a".repeat(32));
  assert.deepEqual(tags.map((tag) => tag.tag), ["2girls", "short hair"]);

  const fts = db.prepare("SELECT COUNT(*) AS count FROM images_fts WHERE hash = ?").get("a".repeat(32));
  assert.equal(fts.count, 1, "stale fts rows would duplicate search hits");
  db.close();
});

test("full-text search finds an image by prompt, checkpoint and lora name", () => {
  const db = openKnowledgeStore(tempStore());
  upsertImage(db, imageRecord({}));

  const search = (query) => db.prepare("SELECT hash FROM images_fts WHERE images_fts MATCH ?").all(query);

  assert.equal(search("hair").length, 1);
  assert.equal(search("someModel").length, 1);
  assert.equal(search("styleA").length, 1);
  assert.equal(search("nonexistentterm").length, 0);
  db.close();
});

// --- sightings -------------------------------------------------------------

test("records one sighting per group and message, and keeps repeats separate", () => {
  const db = openKnowledgeStore(tempStore());
  upsertImage(db, imageRecord({}));
  const base = { hash: "a".repeat(32), sentAt: 1700000000, speaker: "Alice", speakerUin: "123", groupName: "G1" };

  recordSighting(db, { ...base, groupId: "1001", rowId: "5" });
  recordSighting(db, { ...base, groupId: "1001", rowId: "5" });
  recordSighting(db, { ...base, groupId: "1002", rowId: "9", groupName: "G2" });

  const rows = db.prepare("SELECT group_id, row_id FROM sightings ORDER BY group_id").all();
  assert.deepEqual(rows, [
    { group_id: "1001", row_id: "5" },
    { group_id: "1002", row_id: "9" },
  ]);
  db.close();
});

test("an existing group name is not overwritten by a blank one", () => {
  const db = openKnowledgeStore(tempStore());
  const base = { hash: "a".repeat(32), groupId: "1001", rowId: "5", sentAt: 1, speaker: "Alice", speakerUin: "1" };

  recordSighting(db, { ...base, groupName: "Real Name" });
  recordSighting(db, { ...base, groupName: "" });

  const row = db.prepare("SELECT group_name FROM sightings WHERE hash = ?").get("a".repeat(32));
  assert.equal(row.group_name, "Real Name");
  db.close();
});

// --- scan state ------------------------------------------------------------

test("unchanged files are skipped but modified ones are not", () => {
  const db = openKnowledgeStore(tempStore());
  markScanned(db, {
    filePath: "C:\\a.png", fileSize: 100, fileMtime: 500, parserVersion: 1, outcome: "forge", scannedAt: 1,
  });

  const state = loadScanState(db, 1);

  assert.equal(isUnchanged(state, "C:\\a.png", 100, 500), true);
  assert.equal(isUnchanged(state, "C:\\a.png", 101, 500), false, "size change must force a re-parse");
  assert.equal(isUnchanged(state, "C:\\a.png", 100, 501), false, "mtime change must force a re-parse");
  assert.equal(isUnchanged(state, "C:\\b.png", 100, 500), false);
  db.close();
});

test("a parser upgrade invalidates rows scanned by an older version", () => {
  const db = openKnowledgeStore(tempStore());
  markScanned(db, {
    filePath: "C:\\a.png", fileSize: 100, fileMtime: 500, parserVersion: 1, outcome: "no-metadata", scannedAt: 1,
  });

  assert.equal(loadScanState(db, 1).size, 1);
  assert.equal(loadScanState(db, 2).size, 0, "version 2 must re-parse what version 1 saw");
  db.close();
});

// --- evicted files --------------------------------------------------------

test("keeps metadata but flags the preview when QQ evicts the original", () => {
  const db = openKnowledgeStore(tempStore());
  upsertImage(db, imageRecord({ hash: "a".repeat(32), filePath: "C:\\gone.png" }));
  upsertImage(db, imageRecord({ hash: "b".repeat(32), filePath: "C:\\here.png" }));
  markScanned(db, {
    filePath: "C:\\gone.png", fileSize: 1, fileMtime: 1, parserVersion: 1, outcome: "forge", scannedAt: 1,
  });

  const result = markMissingFiles(db, (filePath) => filePath === "C:\\here.png");

  assert.equal(result.missing, 1);
  const gone = db.prepare("SELECT file_path, file_missing, prompt FROM images WHERE hash = ?").get("a".repeat(32));
  assert.equal(gone.file_missing, 1);
  assert.equal(gone.file_path, "");
  assert.equal(gone.prompt, "1girl, solo, long hair", "the prompt outlived the file and must be kept");

  const here = db.prepare("SELECT file_missing FROM images WHERE hash = ?").get("b".repeat(32));
  assert.equal(here.file_missing, 0);

  // The stale scan_state row is dropped so the md5 is re-parsed if it returns.
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM scan_state WHERE file_path = 'C:\\gone.png'").get().c, 0);
  db.close();
});

test("clears the missing flag when the same image reappears", () => {
  const db = openKnowledgeStore(tempStore());
  upsertImage(db, imageRecord({ filePath: "C:\\gone.png" }));
  markMissingFiles(db, () => false);

  upsertImage(db, imageRecord({ filePath: "C:\\Pic\\2026-09\\Ori\\aaa.png" }));

  const row = db.prepare("SELECT file_missing, file_path FROM images WHERE hash = ?").get("a".repeat(32));
  assert.equal(row.file_missing, 0);
  assert.equal(row.file_path, "C:\\Pic\\2026-09\\Ori\\aaa.png");
  db.close();
});

test("summary reports how many images lost their local file", () => {
  const db = openKnowledgeStore(tempStore());
  upsertImage(db, imageRecord({ hash: "a".repeat(32), filePath: "C:\\gone.png" }));
  upsertImage(db, imageRecord({ hash: "b".repeat(32), filePath: "C:\\here.png" }));

  markMissingFiles(db, (filePath) => filePath === "C:\\here.png");

  assert.equal(storeSummary(db).fileMissing, 1);
  assert.equal(storeSummary(db).images, 2, "an evicted image is still a knowledge-base row");
  db.close();
});

// --- summary ---------------------------------------------------------------

test("summary counts images, attribution and distinct assets", () => {
  const db = openKnowledgeStore(tempStore());
  upsertImage(db, imageRecord({}));
  upsertImage(db, imageRecord({
    hash: "b".repeat(32), generator: "comfyui", prompt: "", loras: [{ name: "styleZ", weight: null }],
  }));
  recordSighting(db, {
    hash: "a".repeat(32), groupId: "1001", rowId: "5", sentAt: 1, speaker: "Alice", speakerUin: "1", groupName: "G1",
  });

  const summary = storeSummary(db);

  assert.equal(summary.images, 2);
  assert.equal(summary.withPrompt, 1);
  assert.equal(summary.attributed, 1);
  assert.equal(summary.loras, 2);
  assert.deepEqual(
    summary.generators.map((row) => row.generator).sort(),
    ["comfyui", "forge"],
  );
  db.close();
});
