"use strict";

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { validateCoverageRepairPlan } = require("./coverage_repair_plan");

const STATE_VERSION = 1;
const CHILD_MAX_BUFFER_BYTES = 16 * 1024 * 1024;

const parsePositiveInteger = (value, field) => {
  const number = Number.parseInt(value, 10);
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`${field} must be a positive integer. value=${value}`);
  }
  return number;
};

const parseArgs = (argv) => {
  if (argv.length !== 9) {
    throw new Error(
      "Usage: node coverage_repair.js <planPath> <statePath> <messageDbPath> <groupInfoDbPath> <storeDbPath> <scanLimit> <workDir>",
    );
  }
  return {
    planPath: path.resolve(argv[2]),
    statePath: path.resolve(argv[3]),
    messageDbPath: path.resolve(argv[4]),
    groupInfoDbPath: path.resolve(argv[5]),
    storeDbPath: path.resolve(argv[6]),
    scanLimit: parsePositiveInteger(argv[7], "scanLimit"),
    workDir: path.resolve(argv[8]),
  };
};

const readJsonObject = (filePath, label) => {
  let value;
  try {
    value = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`${label} could not be read. path=${filePath} cause=${error.message}`);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must contain a JSON object. path=${filePath}`);
  }
  return value;
};

const loadState = (statePath, plan) => {
  if (!fs.existsSync(statePath)) {
    return { version: STATE_VERSION, planId: plan.planId, completedTaskIds: [], failedTasks: [] };
  }
  const value = readJsonObject(statePath, "Coverage repair state");
  if (value.version !== STATE_VERSION || value.planId !== plan.planId || !Array.isArray(value.completedTaskIds)) {
    throw new Error(
      `Coverage repair state does not match the plan. path=${statePath} expectedPlanId=${plan.planId} actualPlanId=${value.planId}`,
    );
  }
  const knownTaskIds = new Set(plan.tasks.map((task) => task.id));
  const completedTaskIds = [...new Set(value.completedTaskIds.map(String))];
  const invalidTaskId = completedTaskIds.find((taskId) => !knownTaskIds.has(taskId));
  if (invalidTaskId !== undefined) {
    throw new Error(`Coverage repair state contains an unknown task. path=${statePath} taskId=${invalidTaskId}`);
  }
  const taskById = new Map(plan.tasks.map((task) => [task.id, task]));
  const rawFailures = value.failedTasks ?? [];
  if (!Array.isArray(rawFailures)) {
    throw new TypeError(`Coverage repair state failedTasks must be an array. path=${statePath}`);
  }
  const failedTasks = rawFailures.map((failure, index) => {
    if (failure === null || typeof failure !== "object" || Array.isArray(failure)) {
      throw new TypeError(`Coverage repair failure must be an object. path=${statePath} index=${index}`);
    }
    const taskId = String(failure.taskId ?? "");
    const task = taskById.get(taskId);
    const message = String(failure.message ?? "").trim();
    if (task === undefined || completedTaskIds.includes(taskId) || message.length === 0) {
      throw new Error(`Coverage repair state contains an invalid failure. path=${statePath} taskId=${taskId}`);
    }
    return { ...task, taskId, message };
  });
  if (new Set(failedTasks.map((failure) => failure.taskId)).size !== failedTasks.length) {
    throw new Error(`Coverage repair state contains duplicate failures. path=${statePath}`);
  }
  return { version: STATE_VERSION, planId: plan.planId, completedTaskIds, failedTasks };
};

const writeState = (statePath, state) => {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  const next = {
    version: STATE_VERSION,
    planId: state.planId,
    completedTaskIds: [...state.completedTaskIds],
    failedTasks: [...state.failedTasks],
    updatedAt: new Date().toISOString(),
  };
  const tempPath = `${statePath}.tmp-${process.pid}`;
  fs.writeFileSync(tempPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  fs.renameSync(tempPath, statePath);
  return next;
};

const runChild = (scriptPath, args, label) => {
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: path.dirname(scriptPath),
    encoding: "utf8",
    env: process.env,
    maxBuffer: CHILD_MAX_BUFFER_BYTES,
    windowsHide: true,
  });
  const stdout = typeof result.stdout === "string" ? result.stdout : "";
  const stderr = typeof result.stderr === "string" ? result.stderr : "";
  if (stdout.length > 0) {
    process.stdout.write(stdout);
  }
  if (stderr.length > 0) {
    process.stderr.write(stderr);
  }
  if (result.error !== undefined) {
    throw new Error(`${label} could not start. script=${scriptPath} cause=${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `${label} failed. script=${scriptPath} status=${result.status} signal=${result.signal ?? "none"} stderr=${stderr.slice(-2000)}`,
    );
  }
  return stdout;
};

const parseExportResult = (stdout, task) => {
  const match = stdout.match(
    /exportResult scanComplete=(true|false) stopReason=([^\s]+) scanned=(\d+) matched=(\d+) matchedMedia=(\d+)/u,
  );
  if (match === null) {
    throw new Error(
      `Message export did not report completion. groupId=${task.groupId} startUnix=${task.startUnix} endUnix=${task.endUnix}`,
    );
  }
  return {
    scanComplete: match[1] === "true",
    stopReason: match[2],
    scanned: Number(match[3]),
    matched: Number(match[4]),
    matchedMedia: Number(match[5]),
  };
};

const readExportErrors = (exportPath, task) => {
  const output = readJsonObject(exportPath, "Coverage message export");
  if (!Array.isArray(output.errors)) {
    throw new TypeError(
      `Coverage message export errors must be an array. groupId=${task.groupId} path=${exportPath}`,
    );
  }
  return output.errors.map((error, index) => {
    if (error === null || typeof error !== "object" || Array.isArray(error)) {
      throw new TypeError(`Coverage message export error must be an object. path=${exportPath} index=${index}`);
    }
    const message = String(error.message ?? "").trim();
    if (message.length === 0) {
      throw new Error(`Coverage message export error is missing a message. path=${exportPath} index=${index}`);
    }
    return {
      groupId: String(error.groupId ?? task.groupId),
      code: String(error.code ?? "unknown"),
      message,
    };
  });
};

const runTask = (args, plan, task) => {
  const root = path.resolve(__dirname);
  const exportScript = path.join(root, "export_group_recent.js");
  const ingestScript = path.join(root, "ingest_store.js");
  const exportPath = path.join(args.workDir, `${task.id}.json`);
  const runId = `coverage-repair-${plan.planId}-${task.id}`;
  fs.mkdirSync(args.workDir, { recursive: true });
  try {
    const exportStdout = runChild(exportScript, [
      args.messageDbPath,
      args.groupInfoDbPath,
      task.groupId,
      String(task.startUnix),
      String(task.endUnix),
      exportPath,
      String(args.scanLimit),
    ], "Coverage message export");
    const exportResult = parseExportResult(exportStdout, task);
    runChild(ingestScript, [
      exportPath,
      args.storeDbPath,
      runId,
    ], "Coverage store ingest");
    if (!exportResult.scanComplete) {
      const sourceErrors = readExportErrors(exportPath, task);
      throw new Error(
        `Coverage chunk was incomplete. groupId=${task.groupId} startUnix=${task.startUnix} endUnix=${task.endUnix} stopReason=${exportResult.stopReason} scanned=${exportResult.scanned} scanLimit=${args.scanLimit} sourceErrors=${JSON.stringify(sourceErrors)}`,
      );
    }
    return exportResult;
  } finally {
    fs.rmSync(exportPath, { force: true });
  }
};

const failureForTask = (task, error) => ({
  taskId: task.id,
  groupId: task.groupId,
  startUnix: task.startUnix,
  endUnix: task.endUnix,
  message: error instanceof Error ? error.message : String(error),
});

const runPlanTasks = (args, plan, initialState, taskRunner, stateWriter, emitLine) => {
  const completed = new Set(initialState.completedTaskIds);
  const failures = new Map(initialState.failedTasks.map((failure) => [failure.taskId, failure]));
  emitLine(`repairPlan=${plan.planId} completed=${completed.size} failed=${failures.size} total=${plan.tasks.length}`);
  let insertedMessages = 0;
  let matchedMessages = 0;
  let matchedMedia = 0;
  for (let index = 0; index < plan.tasks.length; index += 1) {
    const task = plan.tasks[index];
    if (completed.has(task.id)) {
      emitLine(`repairChunkSkipped=${index + 1}/${plan.tasks.length} taskId=${task.id}`);
      continue;
    }
    emitLine(`repairChunk=${index + 1}/${plan.tasks.length}`);
    emitLine(`repairTask taskId=${task.id} groupId=${task.groupId} startUnix=${task.startUnix} endUnix=${task.endUnix}`);
    let result;
    try {
      result = taskRunner(args, plan, task);
    } catch (error) {
      const failure = failureForTask(task, error);
      failures.set(task.id, failure);
      stateWriter(args.statePath, {
        version: STATE_VERSION,
        planId: plan.planId,
        completedTaskIds: [...completed],
        failedTasks: [...failures.values()],
      });
      emitLine(`repairChunkFailed=${index + 1}/${plan.tasks.length} taskId=${task.id} error=${JSON.stringify(failure.message)}`);
      continue;
    }
    completed.add(task.id);
    failures.delete(task.id);
    stateWriter(args.statePath, {
      version: STATE_VERSION,
      planId: plan.planId,
      completedTaskIds: [...completed],
      failedTasks: [...failures.values()],
    });
    matchedMessages += result.matched;
    matchedMedia += result.matchedMedia;
    insertedMessages += result.matched + result.matchedMedia;
    emitLine(`repairChunkDone=${index + 1}/${plan.tasks.length} taskId=${task.id}`);
  }
  emitLine(`repairPlanId=${plan.planId}`);
  emitLine(`repairCompleted=${completed.size}/${plan.tasks.length}`);
  emitLine(`repairFailed=${failures.size}`);
  emitLine(`repairMatchedMessages=${matchedMessages}`);
  emitLine(`repairMatchedMedia=${matchedMedia}`);
  emitLine(`repairIngestCandidates=${insertedMessages}`);
  if (failures.size > 0) {
    throw new Error(
      `Coverage repair completed with failed chunks. planId=${plan.planId} completed=${completed.size} total=${plan.tasks.length} failed=${failures.size} statePath=${args.statePath}`,
    );
  }
  return { completed: completed.size, failed: failures.size, matchedMessages, matchedMedia, insertedMessages };
};

const main = () => {
  const args = parseArgs(process.argv);
  const plan = validateCoverageRepairPlan(readJsonObject(args.planPath, "Coverage repair plan"));
  const initialState = loadState(args.statePath, plan);
  runPlanTasks(args, plan, initialState, runTask, writeState, (line) => console.log(line));
};

if (require.main === module) {
  main();
}

module.exports = {
  loadState,
  parseExportResult,
  readExportErrors,
  runPlanTasks,
  runTask,
  writeState,
};
