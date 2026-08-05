"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  cleanupStorageCategory,
  getStorageOverview,
  measureStorageCategory,
  resolveStorageOpenPath,
} = require("../src/server/storage_ops");

const writeSizedFile = (filePath, bytes) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, Buffer.alloc(bytes, 1));
};

const createFixture = () => {
  const toolRoot = fs.mkdtempSync(path.join(os.tmpdir(), "qq-storage-test-"));
  const paths = {
    toolRoot,
    ntDbDir: path.join(toolRoot, "qq", "nt_db"),
    ntDataDir: path.join(toolRoot, "qq", "nt_data"),
    runsDir: path.join(toolRoot, "runs"),
    reportsDir: path.join(toolRoot, "reports"),
    secretDir: path.join(toolRoot, "secrets"),
    storeDir: path.join(toolRoot, "store"),
  };
  for (const directoryPath of Object.values(paths).filter((value) => value !== toolRoot)) {
    fs.mkdirSync(directoryPath, { recursive: true });
  }
  fs.mkdirSync(path.join(toolRoot, "config"), { recursive: true });
  const context = {
    toolRoot,
    secretDir: paths.secretDir,
    config: {
      ntDbDir: paths.ntDbDir,
      ntDataDir: paths.ntDataDir,
      runsDir: paths.runsDir,
      reportsDir: paths.reportsDir,
    },
    activity: { jobRunning: false, quickSummaryRunning: false },
  };
  return { context, paths };
};

const populateFixture = (paths) => {
  writeSizedFile(path.join(paths.ntDbDir, "nt_msg.db"), 101);
  writeSizedFile(path.join(paths.ntDataDir, "image", "a.jpg"), 103);
  writeSizedFile(path.join(paths.toolRoot, "config", "defaults.json"), 107);
  writeSizedFile(path.join(paths.secretDir, "ntqq-db-key.dpapi"), 109);
  writeSizedFile(path.join(paths.storeDir, "messages.db"), 11);
  writeSizedFile(path.join(paths.storeDir, "messages.db-wal"), 13);
  writeSizedFile(path.join(paths.storeDir, "knowledge.db"), 17);
  writeSizedFile(path.join(paths.storeDir, "export-ledger.json"), 19);
  writeSizedFile(path.join(paths.storeDir, "media-objects", "aa", `${"a".repeat(32)}.jpg`), 21);
  writeSizedFile(path.join(paths.storeDir, "coverage-repairs", "plan.json"), 23);
  writeSizedFile(path.join(paths.storeDir, "coverage-repairs", "plan.work", "clean-db", "snapshot.db"), 29);
  writeSizedFile(path.join(paths.storeDir, "tmp", "quick.txt"), 31);
  writeSizedFile(path.join(paths.runsDir, "qq-run-1", "analysis.json"), 37);
  writeSizedFile(path.join(paths.runsDir, "qq-run-1", "clean-db", "nt_msg.clean.db"), 41);
  writeSizedFile(path.join(paths.reportsDir, "qq-run-1.html"), 43);
};

test("storage overview exposes deletion policy without arbitrary path actions", (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.paths.toolRoot, { recursive: true, force: true }));
  populateFixture(fixture.paths);

  const overview = getStorageOverview(fixture.context);
  const items = new Map(overview.items.map((item) => [item.id, item]));
  assert.equal(items.get("qq-databases").cleanupAllowed, false);
  assert.equal(items.get("qq-media-cache").measurement, "manual");
  assert.equal(items.get("message-store").policy, "keep");
  assert.equal(items.get("knowledge-media").cleanupAllowed, false);
  assert.equal(items.get("knowledge-media").measurement, "manual");
  assert.equal(items.get("temporary-files").cleanupAllowed, true);
  assert.equal(items.get("run-files").cleanupAllowed, true);
  assert.equal(items.get("reports-exports").cleanupAllowed, true);
  assert.throws(
    () => resolveStorageOpenPath(fixture.context, "../../outside"),
    /Unknown storage category/u,
  );
});

test("storage measurements partition checkpoints, temporary copies, and run outputs", async (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.paths.toolRoot, { recursive: true, force: true }));
  populateFixture(fixture.paths);

  const messages = await measureStorageCategory(fixture.context, "message-store");
  const checkpoints = await measureStorageCategory(fixture.context, "coverage-checkpoints");
  const knowledgeMedia = await measureStorageCategory(fixture.context, "knowledge-media");
  const temporary = await measureStorageCategory(fixture.context, "temporary-files");
  const runs = await measureStorageCategory(fixture.context, "run-files");
  const reports = await measureStorageCategory(fixture.context, "reports-exports");

  assert.equal(messages.bytes, 24);
  assert.equal(checkpoints.bytes, 23);
  assert.equal(knowledgeMedia.bytes, 21);
  assert.equal(temporary.bytes, 101);
  assert.equal(runs.bytes, 37);
  assert.equal(reports.bytes, 43);
});

test("temporary cleanup removes only regenerable data", async (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.paths.toolRoot, { recursive: true, force: true }));
  populateFixture(fixture.paths);

  const result = await cleanupStorageCategory(
    fixture.context,
    "temporary-files",
    "temporary-files",
  );

  assert.equal(result.deletedBytes, 101);
  assert.equal(fs.existsSync(path.join(fixture.paths.storeDir, "tmp")), false);
  assert.equal(fs.existsSync(path.join(fixture.paths.storeDir, "coverage-repairs", "plan.work")), false);
  assert.equal(fs.existsSync(path.join(fixture.paths.runsDir, "qq-run-1", "clean-db")), false);
  assert.equal(fs.existsSync(path.join(fixture.paths.storeDir, "coverage-repairs", "plan.json")), true);
  assert.equal(fs.existsSync(path.join(fixture.paths.storeDir, "messages.db")), true);
  assert.equal(fs.existsSync(path.join(fixture.paths.runsDir, "qq-run-1", "analysis.json")), true);
});

test("protected categories, mismatched confirmation, and active jobs block cleanup", async (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.paths.toolRoot, { recursive: true, force: true }));
  populateFixture(fixture.paths);

  await assert.rejects(
    cleanupStorageCategory(fixture.context, "message-store", "message-store"),
    /protected and cannot be cleaned/u,
  );
  await assert.rejects(
    cleanupStorageCategory(fixture.context, "knowledge-media", "knowledge-media"),
    /protected and cannot be cleaned/u,
  );
  await assert.rejects(
    cleanupStorageCategory(fixture.context, "run-files", "reports-exports"),
    /confirmation does not match/u,
  );
  await assert.rejects(
    cleanupStorageCategory({
      ...fixture.context,
      activity: { jobRunning: true, quickSummaryRunning: false },
    }, "run-files", "run-files"),
    /任务运行中/u,
  );
  assert.equal(fs.existsSync(path.join(fixture.paths.runsDir, "qq-run-1", "analysis.json")), true);
});

test("cleanup refuses configured output roots outside the toolkit", async (t) => {
  const fixture = createFixture();
  const externalRoot = fs.mkdtempSync(path.join(os.tmpdir(), "qq-storage-external-"));
  t.after(() => fs.rmSync(fixture.paths.toolRoot, { recursive: true, force: true }));
  t.after(() => fs.rmSync(externalRoot, { recursive: true, force: true }));
  writeSizedFile(path.join(externalRoot, "keep.txt"), 47);
  const externalContext = {
    ...fixture.context,
    config: { ...fixture.context.config, reportsDir: externalRoot },
  };

  const overview = getStorageOverview(externalContext);
  const reports = overview.items.find((item) => item.id === "reports-exports");
  assert.equal(reports.cleanupAllowed, false);
  assert.match(reports.cleanupBlockedReason, /不在工具目录内/u);
  await assert.rejects(
    cleanupStorageCategory(externalContext, "reports-exports", "reports-exports"),
    /不在工具目录内/u,
  );
  assert.equal(fs.existsSync(path.join(externalRoot, "keep.txt")), true);
});

test("run and report cleanup preserve their configured roots", async (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.paths.toolRoot, { recursive: true, force: true }));
  populateFixture(fixture.paths);

  const runs = await cleanupStorageCategory(fixture.context, "run-files", "run-files");
  const reports = await cleanupStorageCategory(fixture.context, "reports-exports", "reports-exports");

  assert.equal(runs.deletedBytes, 78);
  assert.equal(reports.deletedBytes, 43);
  assert.equal(fs.existsSync(fixture.paths.runsDir), true);
  assert.equal(fs.readdirSync(fixture.paths.runsDir).length, 0);
  assert.equal(fs.existsSync(fixture.paths.reportsDir), true);
  assert.equal(fs.readdirSync(fixture.paths.reportsDir).length, 0);
  assert.equal(fs.existsSync(path.join(fixture.paths.storeDir, "messages.db")), true);
});
