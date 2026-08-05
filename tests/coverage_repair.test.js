"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { loadState, parseExportResult, runPlanTasks, writeState } = require("../src/coverage_repair");
const {
  createCoverageRepairPlan,
  normalizeRepairBatches,
  validateCoverageRepairPlan,
} = require("../src/coverage_repair_plan");

test("coverage repair plan merges overlaps and splits every group independently", () => {
  const plan = createCoverageRepairPlan([
    { groupIds: ["1001", "1002"], startUnix: 100, endUnix: 350 },
    { groupIds: ["1001"], startUnix: 300, endUnix: 450 },
  ], 100);

  assert.equal(plan.groupCount, 2);
  assert.equal(plan.sourceBatchCount, 2);
  assert.equal(plan.totalGroupSeconds, 600);
  assert.deepEqual(
    plan.tasks.map((task) => [task.groupId, task.startUnix, task.endUnix]),
    [
      ["1001", 100, 200],
      ["1001", 200, 300],
      ["1001", 300, 400],
      ["1001", 400, 450],
      ["1002", 100, 200],
      ["1002", 200, 300],
      ["1002", 300, 350],
    ],
  );
  assert.deepEqual(validateCoverageRepairPlan(plan), plan);
});

test("coverage repair planning has no input batch-count ceiling", () => {
  const batches = Array.from({ length: 150 }, (_, index) => ({
    groupIds: [String(1000 + index)],
    startUnix: 100,
    endUnix: 200,
  }));
  const plan = createCoverageRepairPlan(batches, 100);

  assert.equal(plan.sourceBatchCount, 150);
  assert.equal(plan.groupCount, 150);
  assert.equal(plan.tasks.length, 150);
});

test("coverage repair plan rejects invalid external data with specific errors", () => {
  assert.throws(
    () => normalizeRepairBatches([{ groupIds: [], startUnix: 100, endUnix: 200 }]),
    /至少包含一个群/u,
  );
  assert.throws(
    () => normalizeRepairBatches([{ groupIds: ["bad"], startUnix: 100, endUnix: 200 }]),
    /群号必须是纯数字/u,
  );
  assert.throws(
    () => normalizeRepairBatches([{ groupIds: ["1001"], startUnix: 200, endUnix: 100 }]),
    /补扫时间范围无效/u,
  );
});

test("coverage repair state is atomic, resumable and tied to one plan", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coverage-repair-test-"));
  try {
    const plan = createCoverageRepairPlan([
      { groupIds: ["1001"], startUnix: 100, endUnix: 300 },
    ], 100);
    const statePath = path.join(root, "state.json");

    assert.deepEqual(loadState(statePath, plan).completedTaskIds, []);
    writeState(statePath, {
      version: 1,
      planId: plan.planId,
      completedTaskIds: [plan.tasks[0].id],
      failedTasks: [],
    });
    assert.deepEqual(loadState(statePath, plan).completedTaskIds, [plan.tasks[0].id]);

    const otherPlan = createCoverageRepairPlan([
      { groupIds: ["1002"], startUnix: 100, endUnix: 200 },
    ], 100);
    assert.throws(() => loadState(statePath, otherPlan), /does not match the plan/u);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("coverage repair parses the export completion contract", () => {
  const result = parseExportResult(
    "exportResult scanComplete=true stopReason=complete scanned=120 matched=80 matchedMedia=15\n",
    { groupId: "1001", startUnix: 100, endUnix: 200 },
  );

  assert.deepEqual(result, {
    scanComplete: true,
    stopReason: "complete",
    scanned: 120,
    matched: 80,
    matchedMedia: 15,
  });
});

test("coverage repair records a failed chunk and continues with later chunks", () => {
  const plan = createCoverageRepairPlan([
    { groupIds: ["1001"], startUnix: 100, endUnix: 400 },
  ], 100);
  const calls = [];
  const states = [];
  const lines = [];
  const args = { statePath: "state.json" };
  const taskRunner = (_args, _plan, task) => {
    calls.push(task.id);
    if (task.id === plan.tasks[1].id) {
      throw new Error("database page could not be read");
    }
    return { matched: 2, matchedMedia: 1 };
  };
  const stateWriter = (_statePath, state) => {
    states.push(structuredClone(state));
  };

  assert.throws(
    () => runPlanTasks(
      args,
      plan,
      { version: 1, planId: plan.planId, completedTaskIds: [], failedTasks: [] },
      taskRunner,
      stateWriter,
      (line) => lines.push(line),
    ),
    /failed chunks.*completed=2.*failed=1/u,
  );

  assert.deepEqual(calls, plan.tasks.map((task) => task.id));
  assert.deepEqual(states.at(-1).completedTaskIds, [plan.tasks[0].id, plan.tasks[2].id]);
  assert.deepEqual(states.at(-1).failedTasks, [{
    taskId: plan.tasks[1].id,
    groupId: "1001",
    startUnix: 200,
    endUnix: 300,
    message: "database page could not be read",
  }]);
  assert.ok(lines.some((line) => line.startsWith("repairChunkFailed=2/3")));
  assert.ok(lines.includes("repairFailed=1"));
});
