const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const {
  COVERAGE_REPAIR_CHUNK_SECONDS,
  createCoverageRepairPlan,
  validateCoverageRepairPlan,
} = require("../coverage_repair_plan");
const { loadState: loadCoverageRepairState } = require("../coverage_repair");
const { loadConfig, toolRoot } = require("./toolkit_state");

const MAX_LOG_LINES = 4000;
const MINIMUM_COVERAGE_REPAIR_HEADROOM_BYTES = 4 * 1024 * 1024 * 1024;
const coverageRepairRoot = path.join(toolRoot, "store", "coverage-repairs");
const TIME_TEXT_PATTERN = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2})?(?:\s*(?:Z|[+-]\d{2}:\d{2}))?$/u;
// UI times are Beijing time (UTC+8) everywhere; stamp the offset explicitly so
// PowerShell never parses them in the machine-local timezone — that used to
// shift scan windows by hours for users outside UTC+8 (or fail the run).
const withBeijingOffset = (text) => (/(?:Z|[+-]\d{2}:\d{2})\s*$/u.test(text) ? text : `${text} +08:00`);

let currentJob = null;
let jobCounter = 0;

const SUMMARY_STAGES = [
  { key: "copy", label: "复制数据库副本" },
  { key: "export", label: "导出消息" },
  { key: "analyze", label: "分析与 LLM 摘要" },
  { key: "media", label: "导出媒体" },
  { key: "report", label: "生成报告" },
];

const GROUP_LIST_STAGES = [
  { key: "copy", label: "复制数据库副本" },
  { key: "list", label: "读取群列表" },
];

const COVERAGE_REPAIR_STAGES = [
  { key: "copy", label: "复制一次数据库副本" },
  { key: "repair", label: "分块写入覆盖记录" },
  { key: "cleanup", label: "清理临时副本" },
];

const newStages = (defs) => defs.map((def) => ({ ...def, status: "pending" }));

const setStage = (job, key) => {
  let reached = false;
  for (const stage of job.stages) {
    if (stage.key === key) {
      reached = true;
      if (stage.status !== "done") {
        stage.status = "active";
      }
    } else if (!reached && stage.status !== "done") {
      stage.status = "done";
    }
  }
};

const finishStages = (job, status) => {
  for (const stage of job.stages) {
    if (stage.status === "active") {
      stage.status = status === "done" ? "done" : "failed";
    } else if (stage.status === "pending" && status !== "done") {
      stage.status = "skipped";
    } else if (stage.status === "pending") {
      stage.status = "done";
    }
  }
};

const RESULT_KEYS = new Set([
  "runDir",
  "reportPath",
  "htmlPath",
  "messagesText",
  "mediaDir",
  "groupIds",
  "llmModel",
  "groupListPath",
  "repairPlanId",
  "repairCompleted",
  "repairFailed",
  "repairMatchedMessages",
  "repairMatchedMedia",
  "repairIngestCandidates",
]);

const applyLine = (job, line) => {
  job.log.push(line);
  if (job.log.length > MAX_LOG_LINES) {
    // logBase keeps cursors absolute across trims: absolute index = logBase + array index.
    const dropped = job.log.length - MAX_LOG_LINES;
    job.log.splice(0, dropped);
    job.logBase += dropped;
    job.logTrimmed = true;
  }

  if (line.startsWith("repairBatch=")) {
    const match = line.match(/^repairBatch=(\d+)\/(\d+)$/u);
    if (match !== null) {
      job.repairCurrent = Number(match[1]);
      job.repairTotal = Number(match[2]);
      job.stages = newStages(SUMMARY_STAGES);
      job.groupsDone = 0;
      job.groupsCurrent = null;
    }
    return;
  }

  if (line.startsWith("repairPlan=")) {
    const match = line.match(/^repairPlan=([a-f0-9]{24}) completed=(\d+) failed=(\d+) total=(\d+)$/u);
    if (match !== null) {
      job.result.repairPlanId = match[1];
      job.repairCurrent = Math.min(Number(match[2]) + 1, Number(match[4]));
      job.repairTotal = Number(match[4]);
      job.groupsDone = Number(match[2]);
      job.repairFailures = 0;
    }
    return;
  }
  if (line.startsWith("repairChunk=")) {
    const match = line.match(/^repairChunk=(\d+)\/(\d+)$/u);
    if (match !== null) {
      job.repairCurrent = Number(match[1]);
      job.repairTotal = Number(match[2]);
      setStage(job, "repair");
    }
    return;
  }
  if (line.startsWith("repairTask ")) {
    const match = line.match(/\bgroupId=(\d+)\b/u);
    if (match !== null) {
      job.groupsCurrent = match[1];
    }
    return;
  }
  if (line.startsWith("repairChunkDone=")) {
    job.groupsDone += 1;
    return;
  }
  if (line.startsWith("repairChunkFailed=")) {
    job.repairFailures += 1;
    return;
  }
  if (line.startsWith("repairFailed=")) {
    const match = line.match(/^repairFailed=(\d+)$/u);
    if (match !== null) {
      job.repairFailures = Number(match[1]);
      job.result.repairFailed = match[1];
      if (job.repairFailures > 0) {
        job.error = `${job.repairFailures} 个补扫块因数据库读取错误未完成；其他成功块已保存，可稍后重试失败块。`;
      }
    }
    return;
  }
  if (line === "progress=coverage-copy-start") {
    setStage(job, "copy");
    return;
  }
  if (line === "progress=coverage-copy-done" || line === "progress=coverage-repair-start") {
    setStage(job, "repair");
    return;
  }
  if (line === "progress=coverage-cleanup-start" || line === "progress=coverage-cleanup-done") {
    setStage(job, "cleanup");
    return;
  }

  if (line.includes("prepare-clean-dbs") && line.startsWith(">")) {
    setStage(job, "copy");
    return;
  }
  if (line.startsWith("cleanDir=")) {
    setStage(job, job.type === "group-list" ? "list" : "export");
    return;
  }
  if (line.startsWith("progress=export-done") || line.startsWith("progress=analyze-done")) {
    setStage(job, "analyze");
    return;
  }
  if (line.startsWith("progress=group-start:")) {
    setStage(job, "analyze");
    job.groupsCurrent = line.slice("progress=group-start:".length).trim();
    return;
  }
  if (line.startsWith("progress=group-llm-done:") || line.startsWith("progress=group-llm-failed:")) {
    job.groupsDone += 1;
    if (line.startsWith("progress=group-llm-failed:")) {
      job.llmFailures += 1;
    }
    return;
  }
  if (line.startsWith("progress=llm-start")) {
    setStage(job, "analyze");
    return;
  }
  if (line.startsWith("progress=llm-failed")) {
    job.llmFailures += 1;
    return;
  }
  if (line.includes("export-media") && line.startsWith(">")) {
    setStage(job, "media");
    return;
  }
  if (line.startsWith("htmlPath=") || line.startsWith("digestPath=")) {
    setStage(job, "report");
  }

  const match = line.match(/^(\w+)=(.+)$/u);
  if (match !== null && RESULT_KEYS.has(match[1])) {
    job.result[match[1]] = match[2].trim();
  }
};

const buildPowershellArgs = (commandText) => [
  "-NoProfile",
  "-ExecutionPolicy",
  "Bypass",
  "-EncodedCommand",
  Buffer.from(commandText, "utf16le").toString("base64"),
];

const quotePs = (value) => `'${String(value).replaceAll("'", "''")}'`;

const readJsonFile = (filePath, label) => {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`${label} could not be read. path=${filePath} cause=${error.message}`);
  }
};

const writeJsonAtomic = (filePath, value) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(tempPath, filePath);
};

const coverageRepairPaths = (planId) => ({
  planPath: path.join(coverageRepairRoot, `${planId}.json`),
  statePath: path.join(coverageRepairRoot, `${planId}.state.json`),
  workDir: path.join(coverageRepairRoot, `${planId}.work`),
});

const fileBytes = (filePath, required) => {
  if (!fs.existsSync(filePath)) {
    if (required) {
      throw new Error(`Required file does not exist. path=${filePath}`);
    }
    return 0;
  }
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) {
    throw new Error(`Expected a file. path=${filePath}`);
  }
  return stat.size;
};

const directoryBytes = (directoryPath) => {
  if (!fs.existsSync(directoryPath)) {
    return 0;
  }
  return fs.readdirSync(directoryPath, { withFileTypes: true }).reduce((total, entry) => {
    const entryPath = path.join(directoryPath, entry.name);
    return total + (entry.isDirectory() ? directoryBytes(entryPath) : fileBytes(entryPath, true));
  }, 0);
};

const sourceSnapshotBytes = (ntDbDir) => [
  ["nt_msg.db", true],
  ["nt_msg.db-wal", false],
  ["nt_msg.db-shm", false],
  ["group_info.db", true],
  ["group_info.db-wal", false],
  ["group_info.db-shm", false],
].reduce((total, [name, required]) => total + fileBytes(path.join(ntDbDir, name), required), 0);

const coverageRepairHeadroomBytes = (snapshotBytes) =>
  Math.max(MINIMUM_COVERAGE_REPAIR_HEADROOM_BYTES, Math.ceil(snapshotBytes * 0.1));

const repairProgressFor = (statePath, plan) => {
  if (!fs.existsSync(statePath)) {
    return { completedTaskCount: 0, failedTaskCount: 0 };
  }
  const progress = loadCoverageRepairState(statePath, plan);
  return {
    completedTaskCount: progress.completedTaskIds.length,
    failedTaskCount: progress.failedTasks.length,
  };
};

const freeDiskBytes = (targetPath) => {
  const stat = fs.statfsSync(targetPath);
  return Number(stat.bavail) * Number(stat.bsize);
};

const estimateCoverageRepair = ({ batches }) => {
  const plan = createCoverageRepairPlan(batches, COVERAGE_REPAIR_CHUNK_SECONDS);
  const config = loadConfig();
  const ntDbDir = String(config.ntDbDir ?? "").trim();
  if (ntDbDir.length === 0 || !path.isAbsolute(ntDbDir)) {
    throw new Error(`config.ntDbDir must be an absolute path. value=${config.ntDbDir}`);
  }
  const scanLimit = Number(config.defaultScanLimit);
  if (!Number.isInteger(scanLimit) || scanLimit <= 0) {
    throw new Error(`config.defaultScanLimit must be a positive integer. value=${config.defaultScanLimit}`);
  }
  const paths = coverageRepairPaths(plan.planId);
  const snapshotBytes = sourceSnapshotBytes(ntDbDir);
  const existingTemporaryBytes = directoryBytes(paths.workDir);
  const cleanMessageDb = path.join(paths.workDir, "clean-db", "nt_msg.clean.db");
  const cleanGroupDb = path.join(paths.workDir, "clean-db", "group_info.clean.db");
  const snapshotReady = fs.existsSync(cleanMessageDb) && fs.existsSync(cleanGroupDb);
  const additionalTemporaryBytes = snapshotReady ? 0 : snapshotBytes;
  const availableBytes = freeDiskBytes(toolRoot);
  const headroomBytes = coverageRepairHeadroomBytes(snapshotBytes);
  const requiredFreeBytes = additionalTemporaryBytes + headroomBytes;
  const progress = repairProgressFor(paths.statePath, plan);
  return {
    planId: plan.planId,
    sourceBatchCount: plan.sourceBatchCount,
    taskCount: plan.tasks.length,
    completedTaskCount: progress.completedTaskCount,
    failedTaskCount: progress.failedTaskCount,
    groupCount: plan.groupCount,
    totalGroupSeconds: plan.totalGroupSeconds,
    chunkSeconds: plan.chunkSeconds,
    scanLimit,
    databaseSnapshotBytes: snapshotBytes,
    existingTemporaryBytes,
    additionalTemporaryBytes,
    messageStoreBytes: ["messages.db", "messages.db-wal", "messages.db-shm"]
      .reduce((total, name) => total + fileBytes(path.join(toolRoot, "store", name), false), 0),
    freeDiskBytes: availableBytes,
    headroomBytes,
    requiredFreeBytes,
    safeToStart: availableBytes >= requiredFreeBytes,
    includesLlm: false,
    includesReports: false,
    includesMediaCopies: false,
    runningJob: currentJob !== null && currentJob.status === "running"
      ? { id: currentJob.id, type: currentJob.type, label: currentJob.label }
      : null,
  };
};

const ensureCoverageRepairPlan = (plan) => {
  const paths = coverageRepairPaths(plan.planId);
  fs.mkdirSync(coverageRepairRoot, { recursive: true });
  if (fs.existsSync(paths.planPath)) {
    const existing = validateCoverageRepairPlan(readJsonFile(paths.planPath, "Coverage repair plan"));
    if (existing.chunkSeconds !== plan.chunkSeconds || JSON.stringify(existing.tasks) !== JSON.stringify(plan.tasks)) {
      throw new Error(`Coverage repair plan id collision. path=${paths.planPath} planId=${plan.planId}`);
    }
  } else {
    writeJsonAtomic(paths.planPath, { ...plan, createdAt: new Date().toISOString() });
  }
  return paths;
};

const buildCoverageRepairCommand = (planPath) => {
  if (typeof planPath !== "string" || planPath.trim().length === 0 || !path.isAbsolute(planPath)) {
    throw new TypeError(`Coverage repair plan path must be absolute. value=${planPath}`);
  }
  const script = path.join(toolRoot, "scripts", "repair_coverage.ps1");
  return `& ${quotePs(script)} -PlanPath ${quotePs(planPath)}`;
};

const safeCleanupPaths = (cleanupPaths) => {
  const resolvedRoot = path.resolve(coverageRepairRoot);
  for (const cleanupPath of cleanupPaths) {
    const resolved = path.resolve(cleanupPath);
    const relative = path.relative(resolvedRoot, resolved);
    if (relative.length === 0 || relative.startsWith("..") || path.isAbsolute(relative) || !resolved.endsWith(".work")) {
      throw new Error(`Refusing to clean a path outside the coverage repair work root. path=${resolved}`);
    }
    fs.rmSync(resolved, { recursive: true, force: true });
  }
};

const spawnJob = (type, label, commandText, stages, cleanupPaths) => {
  if (currentJob !== null && currentJob.status === "running") {
    throw new Error("已有任务在运行中，请等待完成或先取消。");
  }

  jobCounter += 1;
  const job = {
    id: jobCounter,
    type,
    label,
    status: "running",
    startedAt: new Date().toISOString(),
    endedAt: null,
    error: null,
    stages: newStages(stages),
    groupsDone: 0,
    groupsCurrent: null,
    llmFailures: 0,
    repairFailures: 0,
    log: [],
    logBase: 0,
    logTrimmed: false,
    result: {},
    repairCurrent: null,
    repairTotal: null,
    cleanupPaths: [...cleanupPaths],
  };

  // [Console]::OutputEncoding forces UTF-8 on redirected stdout so Chinese log lines survive.
  const wrapped = [
    "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
    "$ErrorActionPreference = 'Stop'",
    commandText,
    "exit $LASTEXITCODE",
  ].join("\n");

  const child = spawn("powershell.exe", buildPowershellArgs(wrapped), {
    cwd: toolRoot,
    windowsHide: true,
  });
  job.pid = child.pid;

  let buffer = "";
  const consume = (chunk) => {
    buffer += chunk.toString("utf8");
    const lines = buffer.split(/\r?\n/u);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim().length > 0) {
        applyLine(job, line);
      }
    }
  };
  child.stdout.on("data", consume);
  child.stderr.on("data", consume);

  child.on("error", (error) => {
    job.status = "failed";
    job.error = error.message;
    job.endedAt = new Date().toISOString();
    finishStages(job, "failed");
  });

  child.on("close", (code) => {
    if (buffer.trim().length > 0) {
      applyLine(job, buffer.trim());
    }
    let cleanupError = null;
    try {
      safeCleanupPaths(job.cleanupPaths);
      if (job.type === "coverage-repair") {
        const cleanupStage = job.stages.find((stage) => stage.key === "cleanup");
        if (cleanupStage !== undefined) {
          cleanupStage.status = "done";
        }
      }
    } catch (error) {
      cleanupError = error;
      console.error(JSON.stringify({ event: "job_cleanup_failed", jobId: job.id, error: error.message }));
    }
    if (job.status === "cancelled") {
      if (cleanupError !== null) {
        job.error = `任务已取消，但临时目录清理失败: ${cleanupError.message}`;
      }
      return;
    }
    job.status = code === 0 && cleanupError === null ? "done" : "failed";
    if (code !== 0 && job.error === null) {
      job.error = `进程退出码 ${code}`;
    } else if (cleanupError !== null) {
      job.error = `补扫完成，但临时目录清理失败: ${cleanupError.message}`;
    }
    job.endedAt = new Date().toISOString();
    finishStages(job, job.status);
  });

  job.child = child;
  currentJob = job;
  return job;
};

const buildRangeArgs = (range) => {
  if (range?.type === "hours") {
    const hours = Number.parseInt(range.hours, 10);
    if (!Number.isInteger(hours) || hours <= 0 || hours > 24 * 90) {
      throw new Error(`无效的小时数: ${range.hours}`);
    }
    return `-SinceHours ${hours}`;
  }
  if (range?.type === "days") {
    const days = Number.parseInt(range.days, 10);
    if (!Number.isInteger(days) || days <= 0 || days > 365) {
      throw new Error(`无效的天数: ${range.days}`);
    }
    return `-Days ${days}`;
  }
  if (range?.type === "custom") {
    const start = String(range.start ?? "").trim();
    const end = String(range.end ?? "").trim();
    if (!TIME_TEXT_PATTERN.test(start)) {
      throw new Error(`无效的开始时间: ${start}`);
    }
    if (end.length > 0 && !TIME_TEXT_PATTERN.test(end)) {
      throw new Error(`无效的结束时间: ${end}`);
    }
    const endArg = end.length > 0 ? ` -EndTime ${quotePs(withBeijingOffset(end))}` : "";
    return `-StartTime ${quotePs(withBeijingOffset(start))}${endArg}`;
  }
  throw new Error(`未知的时间范围类型: ${range?.type}`);
};

const startSummaryJob = ({ mode, groupIds, range }) => {
  const script = path.join(toolRoot, "scripts", "run_one_click_summary.ps1");
  let target;
  if (mode === "watchlist") {
    target = "-UseWatchlist";
  } else if (mode === "groups") {
    const ids = (groupIds ?? []).map(String).map((value) => value.trim());
    if (ids.length === 0 || ids.some((value) => !/^\d+$/u.test(value))) {
      throw new Error("群号必须是纯数字，且至少一个。");
    }
    target = `-GroupIds ${quotePs(ids.join(","))}`;
  } else {
    throw new Error(`未知的运行模式: ${mode}`);
  }

  const rangeArgs = buildRangeArgs(range);
  const command = `& ${quotePs(script)} ${target} ${rangeArgs} -NoOpenReport`;
  return spawnJob("summary", "总结运行", command, SUMMARY_STAGES, []);
};

const startCoverageRepairJob = ({ batches }) => {
  if (currentJob !== null && currentJob.status === "running") {
    throw new Error("已有任务在运行中，请等待完成或先取消。");
  }
  const estimate = estimateCoverageRepair({ batches });
  if (!estimate.safeToStart) {
    throw new Error(
      `磁盘空间不足，未启动补扫。freeBytes=${estimate.freeDiskBytes} requiredFreeBytes=${estimate.requiredFreeBytes} databaseSnapshotBytes=${estimate.databaseSnapshotBytes}`,
    );
  }
  const plan = createCoverageRepairPlan(batches, COVERAGE_REPAIR_CHUNK_SECONDS);
  const paths = ensureCoverageRepairPlan(plan);
  const command = buildCoverageRepairCommand(paths.planPath);
  const job = spawnJob("coverage-repair", "安全补扫覆盖记录", command, COVERAGE_REPAIR_STAGES, [paths.workDir]);
  job.repairCurrent = Math.min(estimate.completedTaskCount + 1, estimate.taskCount);
  job.repairTotal = estimate.taskCount;
  job.groupsDone = estimate.completedTaskCount;
  job.repairFailures = estimate.failedTaskCount;
  job.result.repairPlanId = plan.planId;
  return job;
};

const startGroupListJob = () => {
  const script = path.join(toolRoot, "scripts", "list_groups.ps1");
  const command = `& ${quotePs(script)}`;
  return spawnJob("group-list", "刷新群列表", command, GROUP_LIST_STAGES, []);
};

/* ---------- quick selection summary (separate lightweight slot) ---------- */

let quickJob = null;
let quickCounter = 0;

const cleanupQuickFiles = (job) => {
  for (const filePath of [job.inputPath, job.outputPath]) {
    try {
      fs.rmSync(filePath, { force: true });
    } catch {
      // tmp leftovers are harmless; retention isn't affected.
    }
  }
};

const startQuickSummaryJob = ({ inputPath, outputPath, meta, llm }) => {
  if (quickJob !== null && quickJob.status === "running") {
    throw new Error("已有一个选段总结在进行中，请稍候。");
  }
  const baseUrl = String(llm?.baseUrl ?? "").trim();
  const model = String(llm?.model ?? "").trim();
  if (baseUrl.length === 0 || model.length === 0) {
    throw new Error("config 缺少 llm.baseUrl / llm.model，无法调用 LLM。");
  }

  quickCounter += 1;
  const job = {
    id: quickCounter,
    status: "running",
    error: null,
    result: null,
    meta: meta ?? {},
    inputPath,
    outputPath,
    startedAt: new Date().toISOString(),
    endedAt: null,
    logTail: [],
  };

  const script = path.join(toolRoot, "src", "llm_quick_summary.js");
  const commonPs = path.join(toolRoot, "scripts", "common.ps1");
  // The DeepSeek key only exists DPAPI-encrypted; a PS wrapper decrypts it into env for the child.
  const wrapped = [
    "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
    "$ErrorActionPreference = 'Stop'",
    `. ${quotePs(commonPs)}`,
    "$env:DEEPSEEK_API_KEY = Read-SavedSecret -FileName 'deepseek-api-key.dpapi' -SecretName 'DeepSeek API key'",
    `& node ${quotePs(script)} ${quotePs(inputPath)} ${quotePs(outputPath)} ${quotePs(baseUrl)} ${quotePs(model)} 'DEEPSEEK_API_KEY' | Out-Host`,
    "exit $LASTEXITCODE",
  ].join("\n");

  const child = spawn("powershell.exe", buildPowershellArgs(wrapped), { cwd: toolRoot, windowsHide: true });
  const consume = (chunk) => {
    for (const line of chunk.toString("utf8").split(/\r?\n/u)) {
      if (line.trim().length > 0) {
        job.logTail = [...job.logTail.slice(-19), line.trim()];
      }
    }
  };
  child.stdout.on("data", consume);
  child.stderr.on("data", consume);

  child.on("error", (error) => {
    job.status = "failed";
    job.error = error.message;
    job.endedAt = new Date().toISOString();
    cleanupQuickFiles(job);
  });

  child.on("close", (code) => {
    job.endedAt = new Date().toISOString();
    if (code === 0) {
      try {
        job.result = JSON.parse(fs.readFileSync(outputPath, "utf8"));
        job.status = "done";
      } catch (error) {
        job.status = "failed";
        job.error = `读取总结结果失败: ${error.message}`;
      }
    } else {
      job.status = "failed";
      job.error = job.logTail.at(-1) ?? `进程退出码 ${code}`;
    }
    cleanupQuickFiles(job);
  });

  quickJob = job;
  return job;
};

const quickSummarySnapshot = () => {
  if (quickJob === null) {
    return { job: null };
  }
  return {
    job: {
      id: quickJob.id,
      status: quickJob.status,
      error: quickJob.error,
      result: quickJob.result,
      meta: quickJob.meta,
      startedAt: quickJob.startedAt,
      endedAt: quickJob.endedAt,
    },
  };
};

const cancelJob = () => {
  if (currentJob === null || currentJob.status !== "running") {
    throw new Error("没有正在运行的任务。");
  }

  currentJob.status = "cancelled";
  currentJob.error = "已被用户取消";
  currentJob.endedAt = new Date().toISOString();
  finishStages(currentJob, "failed");
  const killer = spawn("taskkill", ["/pid", String(currentJob.pid), "/t", "/f"], { windowsHide: true });
  killer.on("error", (error) => console.error(`taskkill failed: ${error.message}`));
  return currentJob;
};

const jobSnapshot = (cursor) => {
  if (currentJob === null) {
    return { job: null, lines: [], cursor: 0 };
  }

  const absoluteEnd = currentJob.logBase + currentJob.log.length;
  const requested = Number.isInteger(cursor) && cursor >= 0 ? Math.min(cursor, absoluteEnd) : 0;
  const safeCursor = Math.max(0, requested - currentJob.logBase);
  return {
    job: {
      id: currentJob.id,
      type: currentJob.type,
      label: currentJob.label,
      status: currentJob.status,
      startedAt: currentJob.startedAt,
      endedAt: currentJob.endedAt,
      error: currentJob.error,
      stages: currentJob.stages,
      groupsDone: currentJob.groupsDone,
      groupsCurrent: currentJob.groupsCurrent,
      llmFailures: currentJob.llmFailures,
      repairFailures: currentJob.repairFailures,
      logTrimmed: currentJob.logTrimmed,
      result: currentJob.result,
      repairCurrent: currentJob.repairCurrent,
      repairTotal: currentJob.repairTotal,
    },
    lines: currentJob.log.slice(safeCursor),
    cursor: absoluteEnd,
  };
};

module.exports = {
  startSummaryJob,
  startCoverageRepairJob,
  startGroupListJob,
  cancelJob,
  jobSnapshot,
  startQuickSummaryJob,
  quickSummarySnapshot,
  quotePs,
  buildCoverageRepairCommand,
  estimateCoverageRepair,
  safeCleanupPaths,
};
