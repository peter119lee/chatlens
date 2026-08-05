"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { collectRun } = require("../src/run_index");

const writeJson = (filePath, value) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value), "utf8");
};

test("run index keeps scan coverage separate from AI input coverage", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "qq-summary-run-index-"));
  const runDir = path.join(tempDir, "runs", "qq-time-custom-test-20260719-120000");
  const reportsDir = path.join(tempDir, "reports");

  try {
    writeJson(path.join(runDir, "analysis", "analysis.json"), {
      groupIds: ["1001"],
      groupNames: { "1001": "Test group" },
      byGroup: [["Test group", 80]],
      parsedTextMessages: 80,
      parsedMediaMessages: 20,
      firstMessageHkt: "2026-07-19 10:15:00",
      lastMessageHkt: "2026-07-19 11:45:00",
      llmSummary: {
        summary: "Summary",
        coverage: { totalTextMessages: 80, includedTextMessages: 60, chunks: 2, mode: "map-reduce" },
      },
    });
    writeJson(path.join(runDir, "exports", "groups_test_100000_101000.json"), {
      groupIds: ["1001"],
      startUnix: 100000,
      endUnix: 101000,
      coveredFromUnix: 100200,
    });

    const run = collectRun(runDir, reportsDir);

    assert.equal(run.scanCoverage.status, "partial");
    assert.equal(run.scanCoverage.coverageRatio, 0.8);
    assert.equal(run.scanCoverage.missingSeconds, 200);
    assert.equal(run.scanCoverage.requestedStartUnix, 100000);
    assert.equal(run.scanCoverage.requestedEndUnix, 101000);
    assert.equal(run.aiCoverage.status, "partial");
    assert.equal(run.aiCoverage.coverageRatio, 0.75);
    assert.equal(run.aiCoverage.includedMessages, 60);
    assert.equal(run.aiCoverage.totalMessages, 80);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("legacy run reports unknown scan coverage instead of claiming completeness", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "qq-summary-run-legacy-"));
  const runDir = path.join(tempDir, "runs", "qq-time-custom-test-20260719-120000");

  try {
    writeJson(path.join(runDir, "analysis", "analysis.json"), {
      groupIds: ["1001"],
      byGroup: [["1001", 0]],
      parsedTextMessages: 0,
      parsedMediaMessages: 0,
    });

    const run = collectRun(runDir, path.join(tempDir, "reports"));

    assert.equal(run.scanCoverage.status, "unknown");
    assert.equal(run.scanCoverage.coverageRatio, null);
    assert.equal(run.aiCoverage.status, "not-used");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
