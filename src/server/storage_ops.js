"use strict";

const fs = require("node:fs");
const path = require("node:path");

const STORAGE_CATEGORIES = new Set([
  "qq-databases",
  "qq-media-cache",
  "tool-config",
  "tool-secrets",
  "message-store",
  "knowledge-store",
  "knowledge-media",
  "coverage-checkpoints",
  "temporary-files",
  "run-files",
  "reports-exports",
]);

const CLEANABLE_CATEGORIES = new Set([
  "temporary-files",
  "run-files",
  "reports-exports",
]);

const PROTECTED_TOOL_DIRECTORIES = new Set([
  "config",
  "node",
  "node_modules",
  "scripts",
  "src",
  "store",
  "web",
]);

const ensureObject = (value, label) => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  return value;
};

const ensureAbsolutePath = (value, label, allowEmpty) => {
  if (allowEmpty && (value === null || value === undefined || value === "")) {
    return "";
  }
  if (typeof value !== "string" || value.trim().length === 0 || !path.isAbsolute(value.trim())) {
    throw new TypeError(`${label} must be an absolute path. value=${String(value)}`);
  }
  return path.resolve(value.trim());
};

const validateContext = (context) => {
  const value = ensureObject(context, "Storage context");
  const config = ensureObject(value.config, "Storage context config");
  const activity = ensureObject(value.activity, "Storage context activity");
  if (typeof activity.jobRunning !== "boolean" || typeof activity.quickSummaryRunning !== "boolean") {
    throw new TypeError("Storage context activity flags must be booleans.");
  }
  return {
    toolRoot: ensureAbsolutePath(value.toolRoot, "Storage context toolRoot", false),
    secretDir: ensureAbsolutePath(value.secretDir, "Storage context secretDir", false),
    config: {
      ntDbDir: ensureAbsolutePath(config.ntDbDir, "config.ntDbDir", true),
      ntDataDir: ensureAbsolutePath(config.ntDataDir, "config.ntDataDir", true),
      runsDir: ensureAbsolutePath(config.runsDir, "config.runsDir", false),
      reportsDir: ensureAbsolutePath(config.reportsDir, "config.reportsDir", false),
    },
    activity: {
      jobRunning: activity.jobRunning,
      quickSummaryRunning: activity.quickSummaryRunning,
    },
  };
};

const isPathInside = (rootPath, targetPath, allowRoot) => {
  const relative = path.relative(path.resolve(rootPath), path.resolve(targetPath));
  if (relative.length === 0) {
    return allowRoot;
  }
  return !relative.startsWith("..") && !path.isAbsolute(relative);
};

const cleanableRootError = (context, targetPath, label) => {
  const relative = path.relative(context.toolRoot, targetPath);
  if (relative.length === 0 || relative.startsWith("..") || path.isAbsolute(relative)) {
    return `${label} 不在工具目录内，控制台不会删除这里的数据。path=${targetPath}`;
  }
  const topLevel = relative.split(path.sep)[0].toLowerCase();
  if (PROTECTED_TOOL_DIRECTORIES.has(topLevel)) {
    return `${label} 位于受保护的工具目录内，控制台拒绝清理。path=${targetPath}`;
  }
  return null;
};

const activityBlockReason = (activity) => {
  if (activity.jobRunning) {
    return "当前有扫描、补扫或报告任务运行中；完成或取消后才能清理。";
  }
  if (activity.quickSummaryRunning) {
    return "当前有选段 AI 总结运行中；完成后才能清理。";
  }
  return null;
};

const pathExists = (targetPath) => targetPath.length > 0 && fs.existsSync(targetPath);

const publicItem = (item, activity) => {
  const runningReason = CLEANABLE_CATEGORIES.has(item.id) ? activityBlockReason(activity) : null;
  const blockedReason = runningReason ?? item.cleanupBlockedReason;
  return {
    id: item.id,
    section: item.section,
    label: item.label,
    description: item.description,
    paths: [...item.paths],
    exists: item.exists,
    openable: pathExists(item.openPath),
    policy: item.policy,
    policyLabel: item.policyLabel,
    cleanupAllowed: item.cleanupCategory !== null && blockedReason === null,
    cleanupCategory: item.cleanupCategory,
    cleanupImpact: item.cleanupImpact,
    cleanupBlockedReason: blockedReason,
    measurement: item.measurement,
  };
};

const storageCatalog = (context) => {
  const storeDir = path.join(context.toolRoot, "store");
  const coverageDir = path.join(storeDir, "coverage-repairs");
  const configPath = path.join(context.toolRoot, "config", "defaults.json");
  const messagePaths = ["messages.db", "messages.db-wal", "messages.db-shm"].map((name) => path.join(storeDir, name));
  const knowledgePaths = ["knowledge.db", "knowledge.db-wal", "knowledge.db-shm", "export-ledger.json"]
    .map((name) => path.join(storeDir, name));
  const knowledgeMediaDir = path.join(storeDir, "media-objects");
  const temporaryTargets = collectTemporaryTargets(context, false).targets;
  const runCleanupError = cleanableRootError(context, context.config.runsDir, "runsDir");
  const reportCleanupError = cleanableRootError(context, context.config.reportsDir, "reportsDir");
  return [
    {
      id: "qq-databases",
      section: "protected",
      label: "QQ 原始数据库",
      description: "QQ 的加密消息数据库。工具只复制读取，不会修改。",
      paths: context.config.ntDbDir.length === 0 ? [] : [context.config.ntDbDir],
      exists: pathExists(context.config.ntDbDir),
      openPath: context.config.ntDbDir,
      policy: "protected",
      policyLabel: "绝不由本工具删除",
      cleanupCategory: null,
      cleanupImpact: "删除会破坏 QQ 本地聊天数据，只能由 QQ 自己管理。",
      cleanupBlockedReason: "QQ 原始数据库受永久保护。",
      measurement: "automatic",
    },
    {
      id: "qq-media-cache",
      section: "protected",
      label: "QQ 媒体缓存",
      description: "QQ 下载的图片、视频、语音和文件。本工具只读取或复制需要的文件。",
      paths: context.config.ntDataDir.length === 0 ? [] : [context.config.ntDataDir],
      exists: pathExists(context.config.ntDataDir),
      openPath: context.config.ntDataDir,
      policy: "protected",
      policyLabel: "请在 QQ 内管理",
      cleanupCategory: null,
      cleanupImpact: "清理后旧媒体可能无法预览或导出；本工具不会代替 QQ 删除缓存。",
      cleanupBlockedReason: "QQ 媒体缓存只能查看，控制台不提供删除。",
      measurement: "manual",
    },
    {
      id: "tool-config",
      section: "protected",
      label: "工具配置",
      description: "QQ 路径、关注群、模型和运行选项。",
      paths: [configPath],
      exists: pathExists(configPath),
      openPath: path.dirname(configPath),
      policy: "protected",
      policyLabel: "应保留",
      cleanupCategory: null,
      cleanupImpact: "删除会丢失设置并需要重新配置。",
      cleanupBlockedReason: "配置文件不属于可清理数据。",
      measurement: "automatic",
    },
    {
      id: "tool-secrets",
      section: "protected",
      label: "加密密钥",
      description: "Windows DPAPI 加密的 QQ 数据库密钥和 LLM API key。",
      paths: [context.secretDir],
      exists: pathExists(context.secretDir),
      openPath: context.secretDir,
      policy: "protected",
      policyLabel: "应保留",
      cleanupCategory: null,
      cleanupImpact: "删除后需要重新获取 QQ 密钥并重新保存 LLM key。",
      cleanupBlockedReason: "密钥目录不属于可清理数据。",
      measurement: "automatic",
    },
    {
      id: "message-store",
      section: "important",
      label: "工具消息库",
      description: "已扫描消息、覆盖范围和本工具查看进度；长期增量保存。",
      paths: [path.join(storeDir, "messages.db")],
      exists: messagePaths.some(pathExists),
      openPath: storeDir,
      policy: "keep",
      policyLabel: "重要，不应删除",
      cleanupCategory: null,
      cleanupImpact: "删除会永久丢失工具内消息、覆盖记录和查看进度，必须重新补扫。",
      cleanupBlockedReason: "运行中的 SQLite 消息库不提供在线删除。",
      measurement: "automatic",
    },
    {
      id: "knowledge-store",
      section: "important",
      label: "咒语库与导出记录",
      description: "图片生成参数索引、媒体位置和已导出记录。",
      paths: [path.join(storeDir, "knowledge.db"), path.join(storeDir, "export-ledger.json")],
      exists: knowledgePaths.some(pathExists),
      openPath: storeDir,
      policy: "keep",
      policyLabel: "重要，不应删除",
      cleanupCategory: null,
      cleanupImpact: "删除会丢失已建立的咒语索引和增量导出记录。",
      cleanupBlockedReason: "咒语库不提供在线删除。",
      measurement: "automatic",
    },
    {
      id: "knowledge-media",
      section: "important",
      label: "咒语库媒体副本",
      description: "按 MD5 去重保存的长期图片副本；QQ 缓存或运行历史被清理后仍可预览。",
      paths: [knowledgeMediaDir],
      exists: pathExists(knowledgeMediaDir),
      openPath: knowledgeMediaDir,
      policy: "keep",
      policyLabel: "重要，不应删除",
      cleanupCategory: null,
      cleanupImpact: "删除会让已经保住的咒语库图片再次失去预览，且远程文件可能无法重新下载。",
      cleanupBlockedReason: "持久媒体副本不提供在线删除。",
      measurement: "manual",
    },
    {
      id: "coverage-checkpoints",
      section: "important",
      label: "补扫检查点",
      description: "记录长时间补扫已经完成和失败的分块，体积通常很小。",
      paths: [coverageDir],
      exists: pathExists(coverageDir),
      openPath: coverageDir,
      policy: "keep",
      policyLabel: "建议保留",
      cleanupCategory: null,
      cleanupImpact: "删除后续跑进度会丢失，同一范围可能需要从头补扫。",
      cleanupBlockedReason: "检查点用于可靠续跑，不作为常规清理项。",
      measurement: "automatic",
    },
    {
      id: "temporary-files",
      section: "regenerable",
      label: "临时数据库副本",
      description: "扫描产生的 clean-db、补扫 .work 和短期临时文件；需要时会重新生成。",
      paths: [
        path.join(context.config.runsDir, "*", "clean-db"),
        path.join(coverageDir, "*.work"),
        path.join(storeDir, "tmp"),
      ],
      exists: temporaryTargets.length > 0,
      openPath: storeDir,
      policy: "cleanup",
      policyLabel: "可安全清理",
      cleanupCategory: "temporary-files",
      cleanupImpact: "不会删除消息库、检查点或报告；下次扫描可能需要重新复制数据库。",
      cleanupBlockedReason: null,
      measurement: "automatic",
    },
    {
      id: "run-files",
      section: "history",
      label: "运行产物与媒体副本",
      description: "每次运行的导出消息、分析数据和复制出的图片、视频等。",
      paths: [context.config.runsDir],
      exists: pathExists(context.config.runsDir),
      openPath: context.config.runsDir,
      policy: "deletable",
      policyLabel: "可删除，但会影响历史",
      cleanupCategory: "run-files",
      cleanupImpact: "删除后历史报告的媒体预览、聊天内嵌媒体和运行详情可能失效；消息库及咒语库长期媒体副本仍保留。",
      cleanupBlockedReason: runCleanupError,
      measurement: "automatic",
    },
    {
      id: "reports-exports",
      section: "history",
      label: "报告与导出文件",
      description: "HTML/Markdown 报告、媒体导出和咒语库导出。",
      paths: [context.config.reportsDir],
      exists: pathExists(context.config.reportsDir),
      openPath: context.config.reportsDir,
      policy: "deletable",
      policyLabel: "可删除，但不可恢复",
      cleanupCategory: "reports-exports",
      cleanupImpact: "删除后已生成报告和导出文件消失；消息库与运行产物不会同时删除。",
      cleanupBlockedReason: reportCleanupError,
      measurement: "automatic",
    },
  ];
};

const nearestExistingPath = (targetPath) => {
  let current = path.resolve(targetPath);
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error(`No existing parent found for storage path. path=${targetPath}`);
    }
    current = parent;
  }
  return current;
};

const volumeStats = (targetPath) => {
  const existing = nearestExistingPath(targetPath);
  const stat = fs.statfsSync(existing);
  const blockSize = Number(stat.bsize);
  return {
    root: path.parse(existing).root,
    totalBytes: Number(stat.blocks) * blockSize,
    freeBytes: Number(stat.bavail) * blockSize,
  };
};

const getStorageOverview = (rawContext) => {
  const context = validateContext(rawContext);
  const itemCatalog = storageCatalog(context);
  const volumePaths = [context.toolRoot, context.config.ntDbDir, context.config.ntDataDir]
    .filter((value) => value.length > 0);
  const volumes = [];
  const seenRoots = new Set();
  for (const volumePath of volumePaths) {
    try {
      const stats = volumeStats(volumePath);
      const key = stats.root.toLowerCase();
      if (!seenRoots.has(key)) {
        seenRoots.add(key);
        volumes.push({ ...stats, error: null });
      }
    } catch (error) {
      const root = path.parse(volumePath).root;
      const key = root.toLowerCase();
      if (!seenRoots.has(key)) {
        seenRoots.add(key);
        volumes.push({ root, totalBytes: null, freeBytes: null, error: error.message });
      }
    }
  }
  return {
    measuredAt: null,
    activity: { ...context.activity },
    volumes,
    items: itemCatalog.map((item) => publicItem(item, context.activity)),
  };
};

const categoryItem = (context, category) => {
  if (typeof category !== "string" || !STORAGE_CATEGORIES.has(category)) {
    throw new TypeError(`Unknown storage category. category=${String(category)}`);
  }
  const item = storageCatalog(context).find((candidate) => candidate.id === category);
  if (item === undefined) {
    throw new Error(`Storage category is not configured. category=${category}`);
  }
  return item;
};

const categoryMeasurePaths = (context, category) => {
  const storeDir = path.join(context.toolRoot, "store");
  if (category === "qq-databases") {
    return context.config.ntDbDir.length === 0 ? [] : [context.config.ntDbDir];
  }
  if (category === "qq-media-cache") {
    return context.config.ntDataDir.length === 0 ? [] : [context.config.ntDataDir];
  }
  if (category === "tool-config") {
    return [path.join(context.toolRoot, "config", "defaults.json")];
  }
  if (category === "tool-secrets") {
    return [context.secretDir];
  }
  if (category === "message-store") {
    return ["messages.db", "messages.db-wal", "messages.db-shm"].map((name) => path.join(storeDir, name));
  }
  if (category === "knowledge-store") {
    return ["knowledge.db", "knowledge.db-wal", "knowledge.db-shm", "export-ledger.json"]
      .map((name) => path.join(storeDir, name));
  }
  if (category === "knowledge-media") {
    return [path.join(storeDir, "media-objects")];
  }
  if (category === "coverage-checkpoints") {
    return [path.join(storeDir, "coverage-repairs")];
  }
  if (category === "temporary-files") {
    return collectTemporaryTargets(context, false).targets;
  }
  if (category === "run-files") {
    return [context.config.runsDir];
  }
  if (category === "reports-exports") {
    return [context.config.reportsDir];
  }
  throw new Error(`Storage measurement paths are not implemented. category=${category}`);
};

const shouldSkipDirectory = (category, directoryPath) => {
  const name = path.basename(directoryPath).toLowerCase();
  if (category === "coverage-checkpoints" && name.endsWith(".work")) {
    return true;
  }
  return category === "run-files" && name === "clean-db";
};

const measurePaths = async (targetPaths, category) => {
  const stack = [...new Set(targetPaths.map((targetPath) => path.resolve(targetPath)))];
  const measurement = {
    bytes: 0,
    fileCount: 0,
    directoryCount: 0,
    skippedSymlinkCount: 0,
    changedPathCount: 0,
  };
  let processed = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    let stat;
    try {
      stat = await fs.promises.lstat(current);
    } catch (error) {
      if (error.code === "ENOENT") {
        measurement.changedPathCount += 1;
        continue;
      }
      throw new Error(`Storage measurement failed. category=${category} path=${current} cause=${error.message}`);
    }
    if (stat.isSymbolicLink()) {
      measurement.skippedSymlinkCount += 1;
    } else if (stat.isFile()) {
      measurement.bytes += stat.size;
      measurement.fileCount += 1;
    } else if (stat.isDirectory()) {
      if (shouldSkipDirectory(category, current)) {
        continue;
      }
      measurement.directoryCount += 1;
      let entries;
      try {
        entries = await fs.promises.readdir(current, { withFileTypes: true });
      } catch (error) {
        throw new Error(`Storage directory could not be read. category=${category} path=${current} cause=${error.message}`);
      }
      for (const entry of entries) {
        stack.push(path.join(current, entry.name));
      }
    }
    processed += 1;
    if (processed % 512 === 0) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  }
  return measurement;
};

const measureStorageCategory = async (rawContext, category) => {
  const context = validateContext(rawContext);
  categoryItem(context, category);
  const targetPaths = categoryMeasurePaths(context, category).filter((targetPath) => fs.existsSync(targetPath));
  const measurement = await measurePaths(targetPaths, category);
  return {
    category,
    measuredAt: new Date().toISOString(),
    ...measurement,
  };
};

const directChildPaths = (directoryPath) => {
  if (!fs.existsSync(directoryPath)) {
    return [];
  }
  const stat = fs.lstatSync(directoryPath);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Expected a real directory for storage cleanup. path=${directoryPath}`);
  }
  return fs.readdirSync(directoryPath, { withFileTypes: true })
    .map((entry) => path.join(directoryPath, entry.name));
};

function collectTemporaryTargets(context, strictRunsRoot) {
  const targets = [];
  const warnings = [];
  const storeTmp = path.join(context.toolRoot, "store", "tmp");
  if (fs.existsSync(storeTmp)) {
    targets.push(storeTmp);
  }

  const coverageRoot = path.join(context.toolRoot, "store", "coverage-repairs");
  if (fs.existsSync(coverageRoot)) {
    for (const entry of fs.readdirSync(coverageRoot, { withFileTypes: true })) {
      if (entry.name.endsWith(".work")) {
        if (entry.isDirectory() && !entry.isSymbolicLink()) {
          targets.push(path.join(coverageRoot, entry.name));
        } else if (strictRunsRoot) {
          warnings.push(`跳过了不是普通目录的补扫临时项。path=${path.join(coverageRoot, entry.name)}`);
        }
      }
    }
  }

  const runsError = cleanableRootError(context, context.config.runsDir, "runsDir");
  if (runsError !== null) {
    if (strictRunsRoot) {
      warnings.push(runsError);
    }
    return { targets, warnings };
  }
  if (fs.existsSync(context.config.runsDir)) {
    for (const runEntry of fs.readdirSync(context.config.runsDir, { withFileTypes: true })) {
      if (!runEntry.isDirectory() || runEntry.isSymbolicLink()) {
        continue;
      }
      const cleanDbPath = path.join(context.config.runsDir, runEntry.name, "clean-db");
      if (fs.existsSync(cleanDbPath)) {
        if (!fs.lstatSync(cleanDbPath).isSymbolicLink()) {
          targets.push(cleanDbPath);
        } else if (strictRunsRoot) {
          warnings.push(`跳过了符号链接形式的 clean-db。path=${cleanDbPath}`);
        }
      }
    }
  }
  return { targets, warnings };
}

const cleanupTargets = (context, category) => {
  if (category === "temporary-files") {
    return collectTemporaryTargets(context, true);
  }
  if (category === "run-files") {
    const error = cleanableRootError(context, context.config.runsDir, "runsDir");
    if (error !== null) {
      throw new Error(error);
    }
    return { targets: directChildPaths(context.config.runsDir), warnings: [] };
  }
  if (category === "reports-exports") {
    const error = cleanableRootError(context, context.config.reportsDir, "reportsDir");
    if (error !== null) {
      throw new Error(error);
    }
    return { targets: directChildPaths(context.config.reportsDir), warnings: [] };
  }
  throw new TypeError(`Storage category cannot be cleaned. category=${category}`);
};

const assertCleanupTarget = (context, category, targetPath) => {
  const allowedRoots = category === "reports-exports"
    ? [context.config.reportsDir]
    : category === "run-files"
      ? [context.config.runsDir]
      : [context.toolRoot];
  if (!allowedRoots.some((rootPath) => isPathInside(rootPath, targetPath, false))) {
    throw new Error(`Refusing storage cleanup outside the allowed root. category=${category} path=${targetPath}`);
  }
};

const cleanupStorageCategory = async (rawContext, category, confirmation) => {
  const context = validateContext(rawContext);
  categoryItem(context, category);
  if (!CLEANABLE_CATEGORIES.has(category)) {
    throw new TypeError(`Storage category is protected and cannot be cleaned. category=${category}`);
  }
  if (confirmation !== category) {
    throw new TypeError(`Storage cleanup confirmation does not match. category=${category}`);
  }
  const runningReason = activityBlockReason(context.activity);
  if (runningReason !== null) {
    throw new Error(runningReason);
  }

  const collected = cleanupTargets(context, category);
  for (const targetPath of collected.targets) {
    assertCleanupTarget(context, category, targetPath);
  }
  const before = await measurePaths(collected.targets, `cleanup:${category}`);
  const diskBefore = volumeStats(context.toolRoot).freeBytes;
  let removedTargetCount = 0;
  for (const targetPath of collected.targets) {
    if (!fs.existsSync(targetPath)) {
      throw new Error(`Storage cleanup target disappeared before deletion. category=${category} path=${targetPath}`);
    }
    const stat = fs.lstatSync(targetPath);
    if (stat.isSymbolicLink()) {
      throw new Error(`Refusing to delete a symbolic link. category=${category} path=${targetPath}`);
    }
    fs.rmSync(targetPath, { recursive: stat.isDirectory(), force: false });
    removedTargetCount += 1;
  }
  const diskAfter = volumeStats(context.toolRoot).freeBytes;
  return {
    category,
    removedTargetCount,
    removedFileCount: before.fileCount,
    removedDirectoryCount: before.directoryCount,
    deletedBytes: before.bytes,
    freeDiskDeltaBytes: diskAfter - diskBefore,
    warnings: collected.warnings,
  };
};

const resolveStorageOpenPath = (rawContext, category) => {
  const context = validateContext(rawContext);
  const item = categoryItem(context, category);
  if (item.openPath.length === 0 || !fs.existsSync(item.openPath)) {
    throw new Error(`Storage location does not exist. category=${category} path=${item.openPath}`);
  }
  return item.openPath;
};

module.exports = {
  cleanupStorageCategory,
  getStorageOverview,
  measureStorageCategory,
  resolveStorageOpenPath,
};
