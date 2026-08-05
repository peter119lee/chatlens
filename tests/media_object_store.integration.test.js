"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const zlib = require("node:zlib");
const { openKnowledgeStore, recordPromptRequest, upsertImage } = require("../src/knowledge_store");
const { synchronizeManifestMedia } = require("../src/media_object_store");
const knowledge = require("../src/server/knowledge_ops");

const crcTable = (() => {
  const table = new Array(256);
  for (let n = 0; n < 256; n += 1) {
    let value = n;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[n] = value >>> 0;
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

const writePng = (filePath, parameters) => {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(64, 0);
  ihdr.writeUInt32BE(64, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const chunks = [
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
  ];
  if (parameters !== null) {
    chunks.push(pngChunk("tEXt", Buffer.concat([
      Buffer.from("parameters", "latin1"), Buffer.from([0]), Buffer.from(parameters, "latin1"),
    ])));
  }
  chunks.push(pngChunk("IDAT", zlib.deflateSync(Buffer.alloc(32))));
  chunks.push(pngChunk("IEND", Buffer.alloc(0)));
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, Buffer.concat(chunks));
};

const imageRecord = (hash) => ({
  hash,
  filePath: "",
  fileSize: 0,
  fileMtime: 0,
  container: null,
  width: 0,
  height: 0,
  generator: "stripped",
  prompt: "",
  negativePrompt: "",
  checkpoint: "",
  modelHash: "",
  params: {},
  rawChunks: {},
  loras: [],
  parserVersion: 2,
  parsedAt: 1,
});

const createFixture = () => {
  const toolRoot = fs.mkdtempSync(path.join(os.tmpdir(), "qq-media-object-"));
  return {
    toolRoot,
    objectDir: path.join(toolRoot, "store", "media-objects"),
    knowledgeStorePath: path.join(toolRoot, "store", "knowledge.db"),
    manifestPath: path.join(toolRoot, "runs", "run-1", "media", "media-manifest.json"),
  };
};

const writeManifest = (fixture, entry) => {
  fs.mkdirSync(path.dirname(fixture.manifestPath), { recursive: true });
  fs.writeFileSync(fixture.manifestPath, JSON.stringify([entry], null, 2), "utf8");
};

test("tracked media survives run cleanup through the protected object store", (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.toolRoot, { recursive: true, force: true }));
  const copiedPath = path.join(path.dirname(fixture.manifestPath), "image", "answer.png");
  writePng(copiedPath, null);
  const hash = crypto.createHash("md5").update(fs.readFileSync(copiedPath)).digest("hex");
  const db = openKnowledgeStore(fixture.knowledgeStorePath);
  upsertImage(db, imageRecord(hash));
  recordPromptRequest(db, {
    groupId: "1001",
    askRowId: "9",
    askSentAt: 99,
    intent: "original",
    answerKind: "media",
    answerMedia: [{ kind: "image", hash, fileName: `${hash}.png` }],
    answerBy: "User",
    answerSentAt: 100,
    recordedAt: 101,
  });
  db.close();
  writeManifest(fixture, {
    rowId: "10",
    sentAt: 100,
    groupId: "1001",
    groupName: "Group",
    speaker: "User",
    kind: "image",
    hash,
    copiedPath,
    remoteStatus: "downloaded",
  });

  const stats = synchronizeManifestMedia({
    manifestPath: fixture.manifestPath,
    objectDir: fixture.objectDir,
    knowledgeStorePath: fixture.knowledgeStorePath,
    toolRoot: fixture.toolRoot,
  });

  assert.equal(stats.stored, 1);
  const check = openKnowledgeStore(fixture.knowledgeStorePath);
  const row = check.prepare("SELECT generator, object_path FROM images WHERE hash = ?").get(hash);
  check.close();
  assert.equal(row.generator, "stripped");
  assert.equal(fs.existsSync(row.object_path), true);
  fs.rmSync(path.join(fixture.toolRoot, "runs"), { recursive: true, force: true });
  assert.equal(knowledge.imageFilePath(fixture.toolRoot, hash), row.object_path);
  const requests = knowledge.promptRequests(fixture.toolRoot, { onlyAnswered: false, limit: 20 });
  assert.equal(requests.items[0].answerMedia[0].hasFile, true);
});

test("remote media with generation metadata becomes a durable knowledge image", (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.toolRoot, { recursive: true, force: true }));
  const copiedPath = path.join(path.dirname(fixture.manifestPath), "image", "remote.png");
  writePng(copiedPath, "1girl, solo\nNegative prompt: low quality\nSteps: 20, Sampler: Euler, Model: testModel");
  const hash = crypto.createHash("md5").update(fs.readFileSync(copiedPath)).digest("hex");
  writeManifest(fixture, {
    rowId: "11",
    sentAt: 101,
    groupId: "1001",
    groupName: "Group",
    speaker: "User",
    kind: "image",
    hash,
    copiedPath,
    remoteStatus: "downloaded",
  });

  const stats = synchronizeManifestMedia({
    manifestPath: fixture.manifestPath,
    objectDir: fixture.objectDir,
    knowledgeStorePath: fixture.knowledgeStorePath,
    toolRoot: fixture.toolRoot,
  });

  assert.equal(stats.discovered, 1);
  const db = openKnowledgeStore(fixture.knowledgeStorePath);
  const row = db.prepare("SELECT generator, prompt, checkpoint, object_path FROM images WHERE hash = ?").get(hash);
  db.close();
  assert.equal(row.generator, "webui");
  assert.equal(row.prompt, "1girl, solo");
  assert.equal(row.checkpoint, "testModel");
  assert.equal(fs.existsSync(row.object_path), true);
});

test("a hash mismatch is recorded and never enters the durable store", (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.toolRoot, { recursive: true, force: true }));
  const copiedPath = path.join(path.dirname(fixture.manifestPath), "image", "wrong.png");
  writePng(copiedPath, null);
  const hash = "a".repeat(32);
  const db = openKnowledgeStore(fixture.knowledgeStorePath);
  upsertImage(db, imageRecord(hash));
  db.close();
  writeManifest(fixture, {
    rowId: "12",
    sentAt: 102,
    groupId: "1001",
    groupName: "Group",
    speaker: "User",
    kind: "image",
    hash,
    copiedPath,
    remoteStatus: null,
  });

  const stats = synchronizeManifestMedia({
    manifestPath: fixture.manifestPath,
    objectDir: fixture.objectDir,
    knowledgeStorePath: fixture.knowledgeStorePath,
    toolRoot: fixture.toolRoot,
  });

  assert.equal(stats.integrityRejected, 1);
  const check = openKnowledgeStore(fixture.knowledgeStorePath);
  assert.equal(check.prepare("SELECT object_path FROM images WHERE hash = ?").get(hash).object_path, "");
  check.close();
  const manifest = JSON.parse(fs.readFileSync(fixture.manifestPath, "utf8"));
  assert.equal(manifest[0].objectStatus, "hash-mismatch");
  assert.match(manifest[0].actualHash, /^[a-f0-9]{32}$/u);
});
