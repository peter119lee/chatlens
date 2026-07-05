const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { toolRoot } = require("./toolkit_state");

const MAX_LOG_LINES = 4000;
const TIME_TEXT_PATTERN = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2})?$/u;

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

const RESULT_KEYS = new Set(["runDir", "reportPath", "htmlPath", "messagesText", "mediaDir", "groupIds", "llmModel", "groupListPath"]);

const applyLine = (job, line) => {
  job.log.push(line);
  if (job.log.length > MAX_LOG_LINES) {
    // logBase keeps cursors absolute across trims: absolute index = logBase + array index.
    const dropped = job.log.length - MAX_LOG_LINES;
    job.log.splice(0, dropped);
    job.logBase += dropped;
    job.logTrimmed = true;
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

const spawnJob = (type, label, commandText, stages) => {
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
    log: [],
    logBase: 0,
    logTrimmed: false,
    result: {},
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
    if (job.status === "cancelled") {
      return;
    }
    job.status = code === 0 ? "done" : "failed";
    if (code !== 0 && job.error === null) {
      job.error = `进程退出码 ${code}`;
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
    const endArg = end.length > 0 ? ` -EndTime ${quotePs(end)}` : "";
    return `-StartTime ${quotePs(start)}${endArg}`;
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
  return spawnJob("summary", "总结运行", command, SUMMARY_STAGES);
};

const startGroupListJob = () => {
  const script = path.join(toolRoot, "scripts", "list_groups.ps1");
  const command = `& ${quotePs(script)}`;
  return spawnJob("group-list", "刷新群列表", command, GROUP_LIST_STAGES);
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
      logTrimmed: currentJob.logTrimmed,
      result: currentJob.result,
    },
    lines: currentJob.log.slice(safeCursor),
    cursor: absoluteEnd,
  };
};

module.exports = {
  startSummaryJob,
  startGroupListJob,
  cancelJob,
  jobSnapshot,
  startQuickSummaryJob,
  quickSummarySnapshot,
  quotePs,
};
