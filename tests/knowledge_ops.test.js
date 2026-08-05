"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const Database = require("better-sqlite3-multiple-ciphers");

const knowledge = require("../src/server/knowledge_ops");
const { openKnowledgeStore, upsertImage, recordSighting, recordPromptRequest } = require("../src/knowledge_store");

// A tool root with a populated store, shaped like the real one.
const makeToolRoot = (build) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kops-"));
  const db = openKnowledgeStore(path.join(root, "store", "knowledge.db"));
  build(db);
  db.close();
  return root;
};

const image = (hash, overrides) => ({
  hash,
  filePath: `C:\\nt_data\\Pic\\2026-08\\Ori\\${hash}.png`,
  fileSize: 2048,
  fileMtime: 1700000000,
  container: "png",
  width: 1024,
  height: 1536,
  generator: "forge",
  prompt: "masterpiece, 1girl, wakaba mutsumi, green hair",
  negativePrompt: "worst quality",
  checkpoint: "someCheckpoint",
  modelHash: "abc123",
  params: { steps: 30, seed: "42" },
  rawChunks: {},
  loras: [{ name: "styleA.safetensors", weight: 0.8 }],
  parserVersion: 2,
  parsedAt: 1700000001,
  ...overrides,
});

// --- match expression ------------------------------------------------------

test("turns free text into prefix terms joined by AND", () => {
  assert.equal(knowledge.toMatchExpression("wakaba mut"), '"wakaba"* AND "mut"*');
});

test("strips punctuation that fts5 would treat as syntax", () => {
  assert.equal(knowledge.toMatchExpression("1girl, solo"), '"1girl"* AND "solo"*');
  assert.equal(knowledge.toMatchExpression('a "quoted" b'), '"a"* AND "quoted"* AND "b"*');
  assert.equal(knowledge.toMatchExpression("NOT OR AND"), '"NOT"* AND "OR"* AND "AND"*');
});

test("keeps CJK terms searchable", () => {
  assert.equal(knowledge.toMatchExpression("水墨"), '"水墨"*');
});

test("returns an empty expression for input with no usable terms", () => {
  assert.equal(knowledge.toMatchExpression(""), "");
  assert.equal(knowledge.toMatchExpression("   "), "");
  assert.equal(knowledge.toMatchExpression("!!!"), "");
  assert.equal(knowledge.toMatchExpression(null), "");
});

// --- absent store ----------------------------------------------------------

test("reports unavailable rather than throwing when no store exists", () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "kops-empty-"));

  assert.equal(knowledge.overview(empty).available, false);
  assert.equal(knowledge.searchImages(empty).available, false);
  assert.equal(knowledge.promptRequests(empty).available, false);
  assert.equal(knowledge.imageByHash(empty, "a".repeat(32)), null);
  assert.equal(knowledge.imageFilePath(empty, "a".repeat(32)), null);
});

// --- search ----------------------------------------------------------------

test("an empty query returns images most-recently-seen first", () => {
  // A group sighting outranks the file's own cache time: if someone posted it
  // recently, that is the most relevant "when" for this image.
  const root = makeToolRoot((db) => {
    upsertImage(db, image("a".repeat(32), { fileMtime: 100, parsedAt: 100 }));
    upsertImage(db, image("b".repeat(32), { fileMtime: 200, parsedAt: 200 }));
    recordSighting(db, {
      hash: "a".repeat(32), groupId: "1001", rowId: "1", sentAt: 9000, speaker: "Alice", speakerUin: "1", groupName: "G",
    });
  });

  const found = knowledge.searchImages(root, {});

  assert.equal(found.total, 2);
  assert.equal(found.items[0].hash, "a".repeat(32), "a recent sighting outranks a newer file time");
});

test("searches prompt text, checkpoint and lora names", () => {
  const root = makeToolRoot((db) => {
    upsertImage(db, image("a".repeat(32)));
    upsertImage(db, image("b".repeat(32), {
      prompt: "totally different subject", checkpoint: "otherModel", loras: [{ name: "zzz.safetensors", weight: 1 }],
    }));
  });

  assert.equal(knowledge.searchImages(root, { query: "wakaba" }).total, 1);
  assert.equal(knowledge.searchImages(root, { query: "someCheckpoint" }).total, 1);
  assert.equal(knowledge.searchImages(root, { query: "styleA" }).total, 1);
  assert.equal(knowledge.searchImages(root, { query: "nothinghere" }).total, 0);
});

test("supports prefix matching so partial words find results", () => {
  const root = makeToolRoot((db) => {
    upsertImage(db, image("a".repeat(32)));
  });

  assert.equal(knowledge.searchImages(root, { query: "wakab" }).total, 1);
  assert.equal(knowledge.searchImages(root, { query: "wakaba muts" }).total, 1);
});

test("filters by generator and by group", () => {
  const root = makeToolRoot((db) => {
    upsertImage(db, image("a".repeat(32), { generator: "nai" }));
    upsertImage(db, image("b".repeat(32), { generator: "comfyui" }));
    recordSighting(db, {
      hash: "a".repeat(32), groupId: "1001", rowId: "1", sentAt: 1, speaker: "Alice", speakerUin: "1", groupName: "G1",
    });
  });

  assert.equal(knowledge.searchImages(root, { generator: "nai" }).total, 1);
  assert.equal(knowledge.searchImages(root, { generator: "comfyui" }).total, 1);
  assert.equal(knowledge.searchImages(root, { groupId: "1001" }).total, 1);
  assert.equal(knowledge.searchImages(root, { groupId: "9999" }).total, 0);
});

test("caps the page size however large a limit is requested", () => {
  const root = makeToolRoot((db) => {
    for (let index = 0; index < 5; index += 1) {
      upsertImage(db, image(String(index).repeat(32)));
    }
  });

  assert.equal(knowledge.searchImages(root, { limit: 2 }).items.length, 2);
  assert.equal(knowledge.searchImages(root, { limit: 99999 }).items.length, 5);
  assert.equal(knowledge.searchImages(root, { limit: "nonsense" }).items.length, 5);
});

test("does not leak the cache path to the client", () => {
  const root = makeToolRoot((db) => {
    upsertImage(db, image("a".repeat(32)));
  });

  const item = knowledge.searchImages(root, {}).items[0];

  assert.equal(item.hasFile, true);
  assert.equal(item.filePath, undefined, "the browser fetches by hash, never by path");
  assert.equal(item.file_path, undefined);
});

test("carries loras, params and sightings on each result", () => {
  const root = makeToolRoot((db) => {
    upsertImage(db, image("a".repeat(32)));
    recordSighting(db, {
      hash: "a".repeat(32), groupId: "1001", rowId: "1", sentAt: 500, speaker: "Alice", speakerUin: "1", groupName: "G1",
    });
  });

  const item = knowledge.searchImages(root, {}).items[0];

  assert.deepEqual(item.loras, [{ name: "styleA.safetensors", weight: 0.8 }]);
  assert.equal(item.params.steps, 30);
  assert.equal(item.sightings.length, 1);
  assert.equal(item.sightings[0].speaker, "Alice");
});

// --- file resolution -------------------------------------------------------

test("resolves a file path only for a well-formed known hash", () => {
  const root = makeToolRoot((db) => {
    upsertImage(db, image("a".repeat(32)));
  });

  assert.ok(knowledge.imageFilePath(root, "a".repeat(32)).includes("Ori"));
  assert.equal(knowledge.imageFilePath(root, "b".repeat(32)), null, "unknown hash");
  assert.equal(knowledge.imageFilePath(root, "../../secret"), null, "traversal attempt");
  assert.equal(knowledge.imageFilePath(root, "SHORT"), null);
  assert.equal(knowledge.imageFilePath(root, `${"a".repeat(32)}/../..`), null);
});

test("refuses a path for an image whose file was evicted", () => {
  const root = makeToolRoot((db) => {
    upsertImage(db, image("a".repeat(32), { filePath: "" }));
  });

  assert.equal(knowledge.imageFilePath(root, "a".repeat(32)), null);
});

// --- prompt requests -------------------------------------------------------

test("returns prompt requests joined to what is known about the image", () => {
  const root = makeToolRoot((db) => {
    upsertImage(db, image("a".repeat(32), { generator: "stripped", prompt: "" }));
    recordPromptRequest(db, {
      groupId: "1001", askRowId: "600", askSentAt: 1000, groupName: "G1", intent: "prompt", rule: "kk:t",
      asker: "Asker", askText: "kkt", imageHash: "a".repeat(32), imageOwner: "Alice", imageSentAt: 900,
      targetVia: "quote", confidence: "high", answerText: "1girl, solo, masterpiece",
      answerBy: "Alice", answerSentAt: 1100, recordedAt: 1200,
    });
  });

  const result = knowledge.promptRequests(root, {});

  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].confidence, "high");
  assert.equal(result.items[0].imageKnown, 1);
  assert.equal(result.items[0].imageHasFile, 1);
  assert.equal(result.items[0].imageGenerator, "stripped");
  assert.equal(result.items[0].answerKind, "text");
  assert.deepEqual(result.items[0].answerMedia, []);
});

test("can list only the answered requests", () => {
  const root = makeToolRoot((db) => {
    recordPromptRequest(db, {
      groupId: "1001", askRowId: "1", askSentAt: 1, intent: "prompt", rule: "kk:t", asker: "A", askText: "kkt",
      imageHash: null, targetVia: "none", confidence: "none", answerText: "", recordedAt: 1,
    });
    recordPromptRequest(db, {
      groupId: "1001", askRowId: "2", askSentAt: 2, intent: "prompt", rule: "kk:t", asker: "B", askText: "kkt",
      imageHash: null, targetVia: "none", confidence: "none", answerText: "1girl, solo", answerBy: "C", recordedAt: 2,
    });
    recordPromptRequest(db, {
      groupId: "1001", askRowId: "3", askSentAt: 3, intent: "original", rule: "kk:o", asker: "D", askText: "kko",
      imageHash: null, targetVia: "none", confidence: "none", answerKind: "media",
      answerMedia: [{ kind: "file", hash: null, fileName: "original.zip" }], answerBy: "E", recordedAt: 3,
    });
  });

  const all = knowledge.promptRequests(root, {}).items;
  assert.equal(all.length, 3);
  assert.equal(knowledge.promptRequests(root, { onlyAnswered: true }).items.length, 2);
  assert.equal(all[0].answerKind, "media");
  assert.deepEqual(all[0].answerMedia, [{ kind: "file", hash: null, fileName: "original.zip", hasFile: false }]);
});

// --- overview --------------------------------------------------------------

test("overview separates real images from stripped placeholders", () => {
  const root = makeToolRoot((db) => {
    upsertImage(db, image("a".repeat(32)));
    upsertImage(db, image("b".repeat(32), { generator: "stripped", prompt: "", loras: [] }));
  });

  const result = knowledge.overview(root);

  assert.equal(result.counts.images, 1);
  assert.equal(result.counts.placeholders, 1);
  assert.deepEqual(result.generators.map((row) => row.generator), ["forge"]);
});

test("overview lists facets for the filter controls", () => {
  const root = makeToolRoot((db) => {
    upsertImage(db, image("a".repeat(32)));
    recordSighting(db, {
      hash: "a".repeat(32), groupId: "1001", rowId: "1", sentAt: 1, speaker: "Alice", speakerUin: "1", groupName: "G1",
    });
  });

  const result = knowledge.overview(root);

  assert.equal(result.groups[0].groupName, "G1");
  assert.equal(result.topCheckpoints[0].checkpoint, "someCheckpoint");
  assert.equal(result.topLoras[0].name, "styleA.safetensors");
  assert.ok(result.topTags.some((row) => row.tag === "1girl"));
});

// --- structured filtering --------------------------------------------------

const filterFixture = () => makeToolRoot((db) => {
  upsertImage(db, image("a".repeat(32), {
    generator: "nai",
    prompt: "masterpiece, 1girl, long hair",
    checkpoint: "NovelAI Diffusion V4.5",
    width: 832,
    height: 1216,
    fileMtime: 1700000000,
    fileSize: 1000,
    params: { steps: 28, cfgScale: 4, seed: "111" },
    loras: [],
  }));
  upsertImage(db, image("b".repeat(32), {
    generator: "comfyui",
    prompt: "1boy, short hair, nsfw",
    checkpoint: "anima_baseV10.safetensors",
    width: 1920,
    height: 1080,
    fileMtime: 1700100000,
    fileSize: 5000,
    params: { steps: 40, cfgScale: 7, seed: "222" },
    loras: [{ name: "darklight-style.safetensors", weight: 0.8 }],
  }));
  recordSighting(db, {
    hash: "b".repeat(32), groupId: "1001", rowId: "5", sentAt: 1700100500,
    speaker: "Caesar.", speakerUin: "9", groupName: "AIGC Group",
  });
});

const hashesFor = (root, options) =>
  knowledge.searchImages(root, options).items.map((item) => item.hash[0]).sort();

test("filters by tag, and excludes with a leading dash", () => {
  const root = filterFixture();

  assert.deepEqual(hashesFor(root, { query: "tag:1girl" }), ["a"]);
  assert.deepEqual(hashesFor(root, { query: "-tag:nsfw" }), ["a"]);
});

test("filters by model and lora with partial names", () => {
  const root = filterFixture();

  assert.deepEqual(hashesFor(root, { query: "model:anima" }), ["b"]);
  assert.deepEqual(hashesFor(root, { query: "model:NovelAI" }), ["a"]);
  assert.deepEqual(hashesFor(root, { query: "lora:darklight" }), ["b"]);
});

test("filters by generator", () => {
  const root = filterFixture();

  assert.deepEqual(hashesFor(root, { query: "generator:nai" }), ["a"]);
  assert.deepEqual(hashesFor(root, { query: "-generator:nai" }), ["b"]);
});

test("filters by sender, from the query or the dropdown", () => {
  const root = filterFixture();

  assert.deepEqual(hashesFor(root, { query: "sender:Caesar" }), ["b"]);
  assert.deepEqual(hashesFor(root, { sender: "Caesar." }), ["b"]);
  assert.deepEqual(hashesFor(root, { query: "sender:Nobody" }), []);
});

test("filters by numeric bounds and ranges on generation params", () => {
  const root = filterFixture();

  assert.deepEqual(hashesFor(root, { query: "steps>=30" }), ["b"]);
  assert.deepEqual(hashesFor(root, { query: "steps<=30" }), ["a"]);
  assert.deepEqual(hashesFor(root, { query: "steps:20..30" }), ["a"]);
  assert.deepEqual(hashesFor(root, { query: "cfg>=7" }), ["b"]);
});

test("filters by dimensions and aspect", () => {
  const root = filterFixture();

  assert.deepEqual(hashesFor(root, { query: "width>=1900" }), ["b"]);
  assert.deepEqual(hashesFor(root, { query: "aspect:portrait" }), ["a"]);
  assert.deepEqual(hashesFor(root, { query: "aspect:landscape" }), ["b"]);
});

test("filters by seed", () => {
  const root = filterFixture();

  assert.deepEqual(hashesFor(root, { query: "seed:111" }), ["a"]);
});

test("filters by date range against the file time", () => {
  const root = filterFixture();
  const day = (unix) => new Date(unix * 1000).toISOString().slice(0, 10);

  assert.deepEqual(hashesFor(root, { query: `date:${day(1700000000)}` }), ["a"]);
  assert.deepEqual(hashesFor(root, { query: `date:${day(1700000000)}..${day(1700100000)}` }), ["a", "b"]);
});

test("filters by has/no flags", () => {
  const root = filterFixture();

  assert.deepEqual(hashesFor(root, { query: "has:lora" }), ["b"]);
  assert.deepEqual(hashesFor(root, { query: "no:lora" }), ["a"]);
  assert.deepEqual(hashesFor(root, { query: "has:sender" }), ["b"]);
  assert.deepEqual(hashesFor(root, { query: "no:sender" }), ["a"]);
});

test("stacks unrelated filters with AND", () => {
  const root = filterFixture();

  assert.deepEqual(hashesFor(root, { query: "generator:comfyui has:lora steps>=40 aspect:landscape" }), ["b"]);
  assert.deepEqual(hashesFor(root, { query: "generator:comfyui aspect:portrait" }), [], "conflicting filters yield nothing");
});

test("combines a dropdown selection with a typed query", () => {
  const root = filterFixture();

  assert.deepEqual(hashesFor(root, { generator: "comfyui", query: "has:lora" }), ["b"]);
  assert.deepEqual(hashesFor(root, { generator: "nai", query: "has:lora" }), [], "both must hold");
});

test("returns the parse so the UI can show what it understood", () => {
  const root = filterFixture();

  const result = knowledge.searchImages(root, { query: "tag:1girl steps:bogus" });

  assert.ok(result.parsed.parts.some((part) => part.text.includes("1girl")));
  assert.equal(result.parsed.warnings.length, 1);
});

test("sorting options change the order", () => {
  const root = filterFixture();

  assert.equal(knowledge.searchImages(root, { sort: "largest" }).items[0].hash[0], "b");
  assert.equal(knowledge.searchImages(root, { sort: "loras" }).items[0].hash[0], "b");
  assert.equal(knowledge.searchImages(root, { sort: "oldest" }).items[0].hash[0], "a");
  assert.equal(knowledge.searchImages(root, { sort: "promptLength" }).items[0].hash[0], "a");
});

test("an unknown sort falls back to the default instead of failing", () => {
  const root = filterFixture();

  assert.equal(knowledge.searchImages(root, { sort: "nonsense" }).available, true);
});

test("senders facet lists who posted attributable images", () => {
  const root = filterFixture();

  const senders = knowledge.overview(root).senders;

  assert.deepEqual(senders, [{ speaker: "Caesar.", images: 1 }]);
});

// --- export collection -----------------------------------------------------

test("export keeps the on-disk path, which list results never expose", () => {
  const root = filterFixture();

  const collected = knowledge.collectForExport(root, {});

  assert.ok(collected.items[0].filePath.length > 0);
  assert.equal(knowledge.searchImages(root, {}).items[0].filePath, undefined);
});

test("export carries the full prompt, never the clamped preview", () => {
  // A truncated prompt written to a sidecar would be silent data loss.
  const long = "x".repeat(3000);
  const root = makeToolRoot((db) => {
    upsertImage(db, image("a".repeat(32), { prompt: long, negativePrompt: long }));
  });

  const exported = knowledge.collectForExport(root, {}).items[0];
  const listed = knowledge.searchImages(root, {}).items[0];

  assert.equal(exported.prompt.length, 3000);
  assert.equal(exported.negativePrompt.length, 3000);
  assert.ok(listed.prompt.length < 3000, "list rows must be clamped");
  assert.equal(listed.negativePrompt, undefined, "list rows omit the negative prompt");
});

test("an explicit hash selection overrides the filters", () => {
  const root = filterFixture();

  const selected = knowledge.collectForExport(root, { hashes: ["a".repeat(32)] });

  assert.equal(selected.items.length, 1);
  assert.equal(selected.items[0].hash, "a".repeat(32));
});

test("selection and filters intersect rather than one winning silently", () => {
  const root = filterFixture();

  // "a" is the nai image; asking for it while filtering to comfyui yields none.
  const conflicting = knowledge.collectForExport(root, {
    hashes: ["a".repeat(32)],
    generator: "comfyui",
  });

  assert.equal(conflicting.items.length, 0);
});

test("malformed hashes in a selection are ignored, not passed to sql", () => {
  const root = filterFixture();

  const collected = knowledge.collectForExport(root, {
    hashes: ["not-a-hash", "'; DROP TABLE images; --", "a".repeat(32)],
  });

  assert.equal(collected.items.length, 1);
  assert.equal(collected.items[0].hash, "a".repeat(32));
});

test("an empty selection array falls back to the filters", () => {
  const root = filterFixture();

  assert.equal(knowledge.collectForExport(root, { hashes: [] }).items.length, 2);
});

test("export is not capped at a small page size", () => {
  // Exporting a whole library is a legitimate request; a 60-row page limit here
  // would silently export a fraction of what the user asked for.
  const root = makeToolRoot((db) => {
    for (let index = 0; index < 250; index += 1) {
      upsertImage(db, image(String(index).padStart(32, "0")));
    }
  });

  assert.equal(knowledge.collectForExport(root, {}).items.length, 250);
});

test("an explicit limit still bounds the export", () => {
  const root = makeToolRoot((db) => {
    for (let index = 0; index < 250; index += 1) {
      upsertImage(db, image(String(index).padStart(32, "0")));
    }
  });

  assert.equal(knowledge.collectForExport(root, { limit: 10 }).items.length, 10);
});

// --- thumbnails ------------------------------------------------------------

test("prefers the smallest sibling thumbnail over the original", () => {
  // Serving originals to the grid cost ~14 MB of decoded bitmap per card.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kops-thumb-"));
  const ori = path.join(root, "cache", "Pic", "2026-08", "Ori");
  const thumb = path.join(root, "cache", "Pic", "2026-08", "Thumb");
  fs.mkdirSync(ori, { recursive: true });
  fs.mkdirSync(thumb, { recursive: true });
  const hash = "a".repeat(32);
  fs.writeFileSync(path.join(ori, `${hash}.png`), Buffer.alloc(5000));
  fs.writeFileSync(path.join(thumb, `${hash}_720.png`), Buffer.alloc(900));
  fs.writeFileSync(path.join(thumb, `${hash}_0.png`), Buffer.alloc(200));

  const db = openKnowledgeStore(path.join(root, "store", "knowledge.db"));
  upsertImage(db, image(hash, { filePath: path.join(ori, `${hash}.png`) }));
  db.close();

  const chosen = knowledge.thumbnailFilePath(root, hash);

  assert.ok(chosen.endsWith("_0.png"), `expected the smallest variant, got ${path.basename(chosen)}`);
});

test("reports no thumbnail when none exists, so the caller can fall back", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kops-nothumb-"));
  const ori = path.join(root, "cache", "Pic", "2026-08", "Ori");
  fs.mkdirSync(ori, { recursive: true });
  const hash = "a".repeat(32);
  fs.writeFileSync(path.join(ori, `${hash}.png`), Buffer.alloc(5000));

  const db = openKnowledgeStore(path.join(root, "store", "knowledge.db"));
  upsertImage(db, image(hash, { filePath: path.join(ori, `${hash}.png`) }));
  db.close();

  assert.equal(knowledge.thumbnailFilePath(root, hash), null);
});

test("a thumbnail is refused for an unknown or malformed hash", () => {
  const root = filterFixture();

  assert.equal(knowledge.thumbnailFilePath(root, "not-a-hash"), null);
  assert.equal(knowledge.thumbnailFilePath(root, "f".repeat(32)), null);
});

// --- attribution reason ----------------------------------------------------

// A tool root with both a knowledge store and a message store, so coverage
// ranges are available the way they are in a real install.
const makeToolRootWithCoverage = (buildKnowledge, ranges) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kops-cov-"));
  const knowledgeDb = openKnowledgeStore(path.join(root, "store", "knowledge.db"));
  buildKnowledge(knowledgeDb);
  knowledgeDb.close();

  const messagesDb = new Database(path.join(root, "store", "messages.db"));
  messagesDb.prepare("CREATE TABLE scan_ranges (group_id TEXT, start_unix INTEGER, end_unix INTEGER, run_id TEXT DEFAULT '')").run();
  const insert = messagesDb.prepare("INSERT INTO scan_ranges (group_id, start_unix, end_unix) VALUES (?, ?, ?)");
  for (const range of ranges) {
    insert.run("1001", range.startUnix, range.endUnix);
  }
  messagesDb.close();
  return root;
};

test("an image seen in a group message is reported as attributed", () => {
  const root = makeToolRootWithCoverage((db) => {
    upsertImage(db, image("a".repeat(32), { fileMtime: 1500 }));
    recordSighting(db, {
      hash: "a".repeat(32), groupId: "1001", rowId: "1", sentAt: 1500, speaker: "Alice", speakerUin: "1", groupName: "G1",
    });
  }, [{ startUnix: 1000, endUnix: 2000 }]);

  assert.equal(knowledge.searchImages(root, {}).items[0].attributionReason, "attributed");
});

test("blames the coverage gap when the image predates every summarised range", () => {
  // The dominant real case: 97.7% of a measured library. Calling this
  // "probably your own image" would be wrong and would hide a fixable gap.
  const root = makeToolRootWithCoverage((db) => {
    upsertImage(db, image("a".repeat(32), { fileMtime: 500 }));
  }, [{ startUnix: 1000, endUnix: 2000 }]);

  assert.equal(knowledge.searchImages(root, {}).items[0].attributionReason, "outside-coverage");
});

test("says the image was absent from messages when its window WAS summarised", () => {
  const root = makeToolRootWithCoverage((db) => {
    upsertImage(db, image("a".repeat(32), { fileMtime: 1500 }));
  }, [{ startUnix: 1000, endUnix: 2000 }]);

  assert.equal(knowledge.searchImages(root, {}).items[0].attributionReason, "not-in-messages");
});

test("reports a missing cache file as evicted ahead of coverage reasoning", () => {
  const root = makeToolRootWithCoverage((db) => {
    upsertImage(db, image("a".repeat(32), { fileMtime: 1500 }));
    db.prepare("UPDATE images SET file_path = '', file_missing = 1 WHERE hash = ?").run("a".repeat(32));
  }, [{ startUnix: 1000, endUnix: 2000 }]);

  assert.equal(knowledge.searchImages(root, {}).items[0].attributionReason, "evicted");
});

test("does not claim QQ cleaned a placeholder that never had a local path", () => {
  const root = makeToolRootWithCoverage((db) => {
    upsertImage(db, image("a".repeat(32), { fileMtime: 1500, filePath: "" }));
  }, [{ startUnix: 1000, endUnix: 2000 }]);

  const item = knowledge.searchImages(root, {}).items[0];
  assert.equal(item.fileMissing, false);
  assert.equal(item.attributionReason, "unavailable");
});

test("treats everything as outside coverage when nothing was ever summarised", () => {
  const root = makeToolRootWithCoverage((db) => {
    upsertImage(db, image("a".repeat(32), { fileMtime: 1500 }));
  }, []);

  const result = knowledge.searchImages(root, {});
  assert.equal(result.items[0].attributionReason, "outside-coverage");
  assert.equal(knowledge.overview(root).coverage, null);
});

test("overview aggregates the reasons and the covered window", () => {
  const root = makeToolRootWithCoverage((db) => {
    upsertImage(db, image("a".repeat(32), { fileMtime: 1500 }));
    recordSighting(db, {
      hash: "a".repeat(32), groupId: "1001", rowId: "1", sentAt: 1500, speaker: "A", speakerUin: "1", groupName: "G1",
    });
    upsertImage(db, image("b".repeat(32), { fileMtime: 500 }));
    upsertImage(db, image("c".repeat(32), { fileMtime: 1600 }));
    upsertImage(db, image("d".repeat(32), { fileMtime: 1700, filePath: "" }));
  }, [{ startUnix: 1000, endUnix: 2000 }]);

  const result = knowledge.overview(root);

  assert.equal(result.reasons.attributed, 1);
  assert.equal(result.reasons["outside-coverage"], 1);
  assert.equal(result.reasons["not-in-messages"], 1);
  assert.equal(result.reasons.unavailable, 1);
  assert.equal(result.reasons.evicted, 0);
  assert.deepEqual(result.coverage, { fromUnix: 1000, toUnix: 2000, rangeCount: 1 });
});

test("placeholder rows are left out of the reason breakdown", () => {
  const root = makeToolRootWithCoverage((db) => {
    upsertImage(db, image("a".repeat(32), { fileMtime: 500 }));
    upsertImage(db, image("b".repeat(32), { fileMtime: 500, generator: "stripped", prompt: "", loras: [] }));
  }, [{ startUnix: 1000, endUnix: 2000 }]);

  const result = knowledge.overview(root);
  const total = Object.values(result.reasons).reduce((sum, count) => sum + count, 0);

  assert.equal(total, 1, "a placeholder is not a knowledge-base image");
});

test("works when the message store is absent entirely", () => {
  const root = makeToolRoot((db) => {
    upsertImage(db, image("a".repeat(32), { fileMtime: 1500 }));
  });

  assert.equal(knowledge.searchImages(root, {}).items[0].attributionReason, "outside-coverage");
  assert.equal(knowledge.overview(root).coverage, null);
});

// --- coverage --------------------------------------------------------------

test("coverage groups images by month and marks summarised ones", () => {
  const jan = Math.floor(Date.UTC(2026, 0, 15) / 1000);
  const jul = Math.floor(Date.UTC(2026, 6, 15) / 1000);
  const root = makeToolRootWithCoverage((db) => {
    upsertImage(db, image("a".repeat(32), { fileMtime: jan }));
    upsertImage(db, image("b".repeat(32), { fileMtime: jul }));
    recordSighting(db, {
      hash: "b".repeat(32), groupId: "1001", rowId: "1", sentAt: jul, speaker: "Alice", speakerUin: "1", groupName: "G1",
    });
  }, [{ startUnix: jul - 86400, endUnix: jul + 86400 }]);

  const result = knowledge.coverage(root, {});
  const january = result.months.find((row) => row.month === "2026-01");
  const july = result.months.find((row) => row.month === "2026-07");

  assert.equal(january.summarised, false, "never summarised, so the sender is still recoverable");
  assert.equal(january.attributed, 0);
  assert.equal(january.unattributed, 1);
  assert.equal(july.summarised, true);
  assert.equal(july.attributed, 1);
});

test("coverage lists groups that contributed images", () => {
  const root = makeToolRootWithCoverage((db) => {
    upsertImage(db, image("a".repeat(32), { fileMtime: 1500 }));
    recordSighting(db, {
      hash: "a".repeat(32), groupId: "1001", rowId: "1", sentAt: 1500, speaker: "Alice", speakerUin: "1", groupName: "My Group",
    });
  }, [{ startUnix: 1000, endUnix: 2000 }]);

  const result = knowledge.coverage(root, {});

  assert.equal(result.groups.length, 1);
  assert.equal(result.groups[0].groupName, "My Group");
  assert.equal(result.groups[0].images, 1);
});

test("coverage reports totals and excludes placeholders", () => {
  const root = makeToolRootWithCoverage((db) => {
    upsertImage(db, image("a".repeat(32), { fileMtime: 1500 }));
    upsertImage(db, image("b".repeat(32), { fileMtime: 1500, generator: "stripped", prompt: "", loras: [] }));
  }, [{ startUnix: 1000, endUnix: 2000 }]);

  const result = knowledge.coverage(root, {});

  assert.equal(result.totals.images, 1, "a placeholder is not a knowledge-base image");
});

test("new-since counts by cache arrival, not by parse time", () => {
  // A rebuild stamps every row with the same parsed_at; using it would report
  // the entire library as new on every visit.
  const root = makeToolRootWithCoverage((db) => {
    upsertImage(db, image("a".repeat(32), { fileMtime: 1000, parsedAt: 9999 }));
    upsertImage(db, image("b".repeat(32), { fileMtime: 5000, parsedAt: 9999 }));
  }, []);

  const result = knowledge.coverage(root, { since: 3000 });

  assert.equal(result.newSince, 1);
  assert.equal(result.watermark, 5000, "watermark is the newest arrival");
});

test("new-since is zero without a stored watermark", () => {
  const root = makeToolRootWithCoverage((db) => {
    upsertImage(db, image("a".repeat(32), { fileMtime: 1000 }));
  }, []);

  assert.equal(knowledge.coverage(root, {}).newSince, 0);
});

test("coverage degrades when there is no store", () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "kops-nocov-"));

  const result = knowledge.coverage(empty, {});

  assert.equal(result.available, false);
  assert.deepEqual(result.months, []);
});

// --- backward compatibility ------------------------------------------------

test("works against a store written before prompt requests existed", () => {
  // The upgrade path that matters: a read-only connection cannot migrate, so
  // every query must tolerate the older schema instead of failing the page.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kops-old-"));
  const storePath = path.join(root, "store", "knowledge.db");
  fs.mkdirSync(path.dirname(storePath), { recursive: true });

  const db = new Database(storePath);
  db.prepare(`CREATE TABLE images (
    hash TEXT PRIMARY KEY, file_path TEXT NOT NULL DEFAULT '', file_size INTEGER NOT NULL DEFAULT 0,
    file_mtime INTEGER NOT NULL DEFAULT 0, container TEXT NOT NULL DEFAULT '',
    width INTEGER NOT NULL DEFAULT 0, height INTEGER NOT NULL DEFAULT 0,
    generator TEXT NOT NULL DEFAULT 'unknown', prompt TEXT NOT NULL DEFAULT '',
    negative_prompt TEXT NOT NULL DEFAULT '', checkpoint TEXT NOT NULL DEFAULT '',
    model_hash TEXT NOT NULL DEFAULT '', params_json TEXT NOT NULL DEFAULT '{}',
    raw_chunks_json TEXT NOT NULL DEFAULT '{}', parser_version INTEGER NOT NULL DEFAULT 0,
    parsed_at INTEGER NOT NULL DEFAULT 0
  )`).run();
  db.prepare("CREATE TABLE sightings (hash TEXT, group_id TEXT, row_id TEXT, sent_at INTEGER DEFAULT 0, speaker TEXT DEFAULT '', speaker_uin TEXT DEFAULT '', group_name TEXT DEFAULT '', PRIMARY KEY (hash, group_id, row_id))").run();
  db.prepare("CREATE TABLE image_loras (hash TEXT, lora_name TEXT, weight REAL, PRIMARY KEY (hash, lora_name))").run();
  db.prepare("CREATE TABLE image_tags (hash TEXT, tag TEXT, source TEXT DEFAULT 'prompt', PRIMARY KEY (hash, tag, source))").run();
  db.prepare("CREATE VIRTUAL TABLE images_fts USING fts5(hash UNINDEXED, prompt, negative_prompt, checkpoint, loras, tokenize = 'unicode61')").run();
  db.prepare("INSERT INTO images (hash, file_path, generator, prompt, checkpoint, parsed_at) VALUES (?, ?, 'forge', 'masterpiece, 1girl', 'oldModel', 5)")
    .run("a".repeat(32), "C:\\nt_data\\Pic\\2026-01\\Ori\\aaa.png");
  db.prepare("INSERT INTO images_fts (hash, prompt, negative_prompt, checkpoint, loras) VALUES (?, 'masterpiece, 1girl', '', 'oldModel', '')").run("a".repeat(32));
  db.close();

  const overview = knowledge.overview(root);
  assert.equal(overview.available, true);
  assert.equal(overview.counts.images, 1);
  assert.equal(overview.counts.promptRequests, 0, "absent table reads as zero, not an error");
  assert.equal(overview.counts.fileMissing, 0, "absent column reads as zero");

  const found = knowledge.searchImages(root, { query: "1girl" });
  assert.equal(found.total, 1);
  assert.equal(found.items[0].hasFile, true, "no file_missing column means the file is presumed present");
  assert.deepEqual(found.items[0].promptRequests, []);

  const requests = knowledge.promptRequests(root, {});
  assert.equal(requests.available, true);
  assert.deepEqual(requests.items, []);
  assert.equal(requests.needsHarvest, true, "tells the UI a harvest will populate this");

  assert.ok(knowledge.imageFilePath(root, "a".repeat(32)).includes("Ori"));
});
