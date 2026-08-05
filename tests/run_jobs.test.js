"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const { buildCoverageRepairCommand } = require("../src/server/run_jobs");

test("coverage repair command invokes only the dedicated scan pipeline", () => {
  const planPath = path.resolve("store", "coverage-repairs", "0123456789abcdef01234567.json");
  const command = buildCoverageRepairCommand(planPath);

  assert.match(command, /repair_coverage\.ps1/u);
  assert.match(command, /-PlanPath/u);
  assert.match(command, /0123456789abcdef01234567\.json/u);
  assert.doesNotMatch(command, /run_one_click_summary/u);
  assert.doesNotMatch(command, /UseLlm|ExportMedia|generate_report/u);
});

test("coverage repair command requires an absolute plan path", () => {
  assert.throws(
    () => buildCoverageRepairCommand("relative-plan.json"),
    /must be absolute/u,
  );
  assert.throws(
    () => buildCoverageRepairCommand(""),
    /must be absolute/u,
  );
});
