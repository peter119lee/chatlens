"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  exportImages, previewExport, forgetExports, loadLedger, ledgerPath,
  buildStem, sanitizeStem, promptFor, csvFrom, LEDGER_SCHEMA,
} = require("../src/knowledge_export");

const makeWorkspace = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kexp-"));
  fs.mkdirSync(path.join(root, "store"), { recursive: true });
  fs.mkdirSync(path.join(root, "cache"), { recursive: true });
  return root;
};

// A real file on disk, so copy/hash behaviour is exercised rather than mocked.
const sourceImage = (root, hash, bytes = "fake png bytes") => {
  const filePath = path.join(root, "cache", `${hash}.png`);
  fs.writeFileSync(filePath, bytes);
  return filePath;
};

const item = (root, hash, overrides = {}) => ({
  hash,
  filePath: sourceImage(root, hash),
  generator: "forge",
  prompt: "masterpiece, 1girl, long hair",
  negativePrompt: "worst quality",
  checkpoint: "someModel.safetensors",
  width: 1024,
  height: 1536,
  fileMtime: 1700000000,
  params: { steps: 30, seed: "42" },
  loras: [{ name: "styleA.safetensors", weight: 0.8 }],
  sightings: [],
  promptRequests: [],
  ...overrides,
});

const outputIn = (root, name = "out") => path.join(root, name);
const listFiles = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []);

// --- filename safety -------------------------------------------------------

test("strips characters Windows forbids in filenames", () => {
  assert.equal(sanitizeStem('a<b>c:d"e/f\\g|h?i*j', "fallback"), "a_b_c_d_e_f_g_h_i_j");
});

test("falls back when a name sanitises to nothing", () => {
  assert.equal(sanitizeStem("///", "fallback"), "___", "forbidden chars become underscores, which is a usable name");
  assert.equal(sanitizeStem("", "fallback"), "fallback");
  assert.equal(sanitizeStem("   ", "fallback"), "fallback");
  assert.equal(sanitizeStem(null, "fallback"), "fallback");
});

test("refuses reserved windows device names", () => {
  // A file called CON.png cannot be created on Windows.
  assert.equal(sanitizeStem("CON", "safe"), "safe");
  assert.equal(sanitizeStem("nul", "safe"), "safe");
  assert.equal(sanitizeStem("com1", "safe"), "safe");
});

test("drops a trailing dot or space, which windows silently removes", () => {
  // Left in place, the sidecar would no longer pair with the image.
  assert.equal(sanitizeStem("name.", "safe"), "name");
  assert.equal(sanitizeStem("name ", "safe"), "name");
});

test("names files by date, who or model, and a hash prefix", () => {
  const root = makeWorkspace();
  // Note the sender's trailing dot is dropped: Windows silently strips it, which
  // would otherwise break the image/sidecar pairing.
  const withSender = item(root, "a".repeat(32), { sightings: [{ speaker: "Caesar.", groupName: "G", groupId: "1", sentAt: 1 }] });

  const stem = buildStem(withSender, 0);

  assert.match(stem, /^\d{8}_Caesar_aaaaaaaa$/u);
});

test("falls back to the model name when the sender is unknown", () => {
  const root = makeWorkspace();

  assert.match(buildStem(item(root, "b".repeat(32)), 0), /_someModel_bbbbbbbb$/u);
});

// --- prompt selection ------------------------------------------------------

test("prefers the image's own metadata prompt", () => {
  const result = promptFor({ prompt: "from metadata", promptRequests: [{ answerText: "from chat" }] });

  assert.deepEqual(result, { text: "from metadata", source: "metadata" });
});

test("falls back to a chat answer when metadata has no prompt", () => {
  // The whole point of the kkt feature: for a stripped image this is the only
  // record that exists.
  const result = promptFor({ prompt: "", promptRequests: [{ answerText: "from chat" }] });

  assert.deepEqual(result, { text: "from chat", source: "chat" });
});

test("reports no prompt when neither source has one", () => {
  assert.deepEqual(promptFor({ prompt: "", promptRequests: [] }), { text: "", source: "none" });
});

// --- basic export ----------------------------------------------------------

test("writes the image, a sidecar prompt, and both index files", () => {
  const root = makeWorkspace();
  const outputDir = outputIn(root);

  const result = exportImages({ toolRoot: root, outputDir, items: [item(root, "a".repeat(32))] });

  assert.equal(result.exported, 1);
  const files = listFiles(outputDir);
  assert.equal(files.filter((name) => name.endsWith(".png")).length, 1);
  assert.equal(files.filter((name) => name.endsWith(".txt")).length, 1);
  assert.ok(files.includes("index.jsonl"));
  assert.ok(files.includes("index.csv"));
});

test("the sidecar holds the prompt and the negative prompt", () => {
  const root = makeWorkspace();
  const outputDir = outputIn(root);

  exportImages({ toolRoot: root, outputDir, items: [item(root, "a".repeat(32))] });

  const sidecar = listFiles(outputDir).find((name) => name.endsWith(".txt"));
  const text = fs.readFileSync(path.join(outputDir, sidecar), "utf8");
  assert.match(text, /masterpiece, 1girl, long hair/u);
  assert.match(text, /Negative prompt: worst quality/u);
});

test("the image and its sidecar share a stem so trainers pair them", () => {
  const root = makeWorkspace();
  const outputDir = outputIn(root);

  exportImages({ toolRoot: root, outputDir, items: [item(root, "a".repeat(32))] });

  const files = listFiles(outputDir);
  const image = files.find((name) => name.endsWith(".png"));
  const sidecar = files.find((name) => name.endsWith(".txt"));
  assert.equal(path.parse(image).name, path.parse(sidecar).name);
});

test("jsonl has one parseable record per image", () => {
  const root = makeWorkspace();
  const outputDir = outputIn(root);

  exportImages({
    toolRoot: root, outputDir, items: [item(root, "a".repeat(32)), item(root, "b".repeat(32))],
  });

  const lines = fs.readFileSync(path.join(outputDir, "index.jsonl"), "utf8").trim().split("\n");
  assert.equal(lines.length, 2);
  const record = JSON.parse(lines[0]);
  assert.equal(record.hash, "a".repeat(32));
  assert.equal(record.promptSource, "metadata");
  assert.deepEqual(record.loras, ["styleA.safetensors"]);
});

// --- incremental behaviour -------------------------------------------------

test("a second export of the same images writes nothing new", () => {
  const root = makeWorkspace();
  const items = [item(root, "a".repeat(32)), item(root, "b".repeat(32))];

  const first = exportImages({ toolRoot: root, outputDir: outputIn(root, "run1"), items });
  const second = exportImages({ toolRoot: root, outputDir: outputIn(root, "run2"), items });

  assert.equal(first.exported, 2);
  assert.equal(second.exported, 0);
  assert.equal(second.skipped, 2);
});

test("only genuinely new images are written on a later run", () => {
  const root = makeWorkspace();
  const first = [item(root, "a".repeat(32))];
  const later = [item(root, "a".repeat(32)), item(root, "b".repeat(32))];

  exportImages({ toolRoot: root, outputDir: outputIn(root, "run1"), items: first });
  const second = exportImages({ toolRoot: root, outputDir: outputIn(root, "run2"), items: later });

  assert.equal(second.exported, 1);
  assert.equal(second.skipped, 1);
  assert.equal(listFiles(outputIn(root, "run2")).filter((name) => name.endsWith(".png")).length, 1);
});

test("the ledger is global, so a different folder still skips", () => {
  // "Have I already got this?" must have one answer regardless of destination.
  const root = makeWorkspace();
  const items = [item(root, "a".repeat(32))];

  exportImages({ toolRoot: root, outputDir: outputIn(root, "folderA"), items });
  const other = exportImages({ toolRoot: root, outputDir: outputIn(root, "folderB"), items });

  assert.equal(other.exported, 0);
  assert.equal(other.skipped, 1);
});

test("mode all re-exports regardless of history", () => {
  const root = makeWorkspace();
  const items = [item(root, "a".repeat(32))];

  exportImages({ toolRoot: root, outputDir: outputIn(root, "run1"), items });
  const forced = exportImages({ toolRoot: root, outputDir: outputIn(root, "run2"), items, mode: "all" });

  assert.equal(forced.exported, 1);
  assert.equal(forced.skipped, 0);
});

test("forgetting an export makes it eligible again", () => {
  const root = makeWorkspace();
  const items = [item(root, "a".repeat(32))];
  exportImages({ toolRoot: root, outputDir: outputIn(root, "run1"), items });

  const forgotten = forgetExports(root, ["a".repeat(32)]);
  const again = exportImages({ toolRoot: root, outputDir: outputIn(root, "run2"), items });

  assert.equal(forgotten.removed, 1);
  assert.equal(again.exported, 1);
});

test("forgetting everything clears the ledger", () => {
  const root = makeWorkspace();
  exportImages({
    toolRoot: root, outputDir: outputIn(root), items: [item(root, "a".repeat(32)), item(root, "b".repeat(32))],
  });

  assert.equal(forgetExports(root).removed, 2);
  assert.deepEqual(loadLedger(root).exports, {});
});

test("preview reports the split without writing anything", () => {
  const root = makeWorkspace();
  const items = [item(root, "a".repeat(32)), item(root, "b".repeat(32))];
  exportImages({ toolRoot: root, outputDir: outputIn(root, "run1"), items: [items[0]] });

  const preview = previewExport(root, items);

  assert.equal(preview.fresh, 1);
  assert.equal(preview.already, 1);
  assert.equal(preview.ledgerSize, 1);
  assert.equal(listFiles(outputIn(root, "preview")).length, 0);
});

// --- degraded sources ------------------------------------------------------

test("a missing original still exports its prompt, and is counted", () => {
  // The prompt outlived the picture; losing it too would be the real failure.
  const root = makeWorkspace();
  const outputDir = outputIn(root);
  const gone = item(root, "a".repeat(32), { filePath: path.join(root, "cache", "absent.png") });

  const result = exportImages({ toolRoot: root, outputDir, items: [gone] });

  assert.equal(result.exported, 1);
  assert.equal(result.missingFile, 1);
  assert.equal(result.notes.length, 1);
  assert.equal(listFiles(outputDir).filter((name) => name.endsWith(".txt")).length, 1);
  assert.equal(listFiles(outputDir).filter((name) => name.endsWith(".png")).length, 0);
});

test("an image with no prompt at all writes no sidecar", () => {
  const root = makeWorkspace();
  const outputDir = outputIn(root);

  const result = exportImages({
    toolRoot: root, outputDir, items: [item(root, "a".repeat(32), { prompt: "", negativePrompt: "" })],
  });

  assert.equal(result.exported, 1);
  assert.equal(listFiles(outputDir).filter((name) => name.endsWith(".txt")).length, 0);
});

test("verifyHash refuses a file whose bytes no longer match its md5", () => {
  // A reused cache slot would otherwise pair the wrong picture with this prompt.
  const root = makeWorkspace();
  const outputDir = outputIn(root);
  const mismatched = item(root, "a".repeat(32), { filePath: sourceImage(root, "a".repeat(32), "different bytes") });

  const result = exportImages({ toolRoot: root, outputDir, items: [mismatched], verifyHash: true });

  assert.equal(result.exported, 0);
  assert.equal(result.failed, 1);
  assert.match(result.notes[0], /内容与记录不符/u);
});

test("two images that would share a filename get distinct ones", () => {
  const root = makeWorkspace();
  const outputDir = outputIn(root);
  // Same date, same sender: the stem collides before the hash prefix is added.
  const shared = { sightings: [{ speaker: "Same", groupName: "G", groupId: "1", sentAt: 1 }] };

  exportImages({
    toolRoot: root,
    outputDir,
    items: [item(root, "a".repeat(32), shared), item(root, "b".repeat(32), shared)],
  });

  const images = listFiles(outputDir).filter((name) => name.endsWith(".png"));
  assert.equal(images.length, 2);
  assert.equal(new Set(images).size, 2);
});

// --- ledger integrity ------------------------------------------------------

test("the ledger records schema, version and per-image detail", () => {
  const root = makeWorkspace();
  exportImages({ toolRoot: root, outputDir: outputIn(root), items: [item(root, "a".repeat(32))] });

  const ledger = loadLedger(root);

  assert.equal(ledger.schema, LEDGER_SCHEMA);
  assert.equal(ledger.version, 1);
  const entry = ledger.exports["a".repeat(32)];
  assert.ok(entry.exportedAt > 0);
  assert.match(entry.imageFile, /\.png$/u);
  assert.equal(entry.promptSource, "metadata");
});

test("refuses to overwrite a foreign file at the ledger path", () => {
  const root = makeWorkspace();
  fs.writeFileSync(ledgerPath(root), JSON.stringify({ somethingElse: true }), "utf8");

  assert.throws(() => loadLedger(root), /不是本工具的导出记录文件/u);
});

test("reports a corrupt ledger instead of silently starting over", () => {
  const root = makeWorkspace();
  fs.writeFileSync(ledgerPath(root), "{ not json", "utf8");

  assert.throws(() => loadLedger(root), /损坏/u);
});

test("no ledger file yet is not an error", () => {
  const root = makeWorkspace();

  assert.deepEqual(loadLedger(root).exports, {});
});

test("an empty item list touches nothing", () => {
  const root = makeWorkspace();

  const result = exportImages({ toolRoot: root, outputDir: outputIn(root), items: [] });

  assert.equal(result.exported, 0);
  assert.equal(fs.existsSync(ledgerPath(root)), false, "no work means no ledger write");
});

// --- csv -------------------------------------------------------------------

test("csv quotes values and escapes embedded quotes", () => {
  const csv = csvFrom([{ hash: "a", prompt: 'has "quotes", and a comma', loras: ["x", "y"] }]);

  assert.match(csv, /"has ""quotes"", and a comma"/u);
  assert.match(csv, /"x \| y"/u);
});

test("csv neutralises spreadsheet formula injection", () => {
  // A prompt beginning with = would otherwise be executed by Excel on open.
  const csv = csvFrom([{ hash: "a", prompt: "=cmd|' /c calc'!A1" }]);

  assert.match(csv, /"'=cmd/u);
});

test("csv starts with a BOM so excel reads utf-8", () => {
  assert.equal(csvFrom([{ hash: "a" }]).charCodeAt(0), 0xfeff);
});
