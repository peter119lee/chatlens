const fs = require("node:fs");
const path = require("node:path");
const { readJson } = require("../report_utils");
const { collectRuns, pathExists } = require("../run_index");
const messageStore = require("../message_store");

const toolRoot = path.resolve(__dirname, "..", "..");
const configPath = path.join(toolRoot, "config", "defaults.json");
const configExamplePath = path.join(toolRoot, "config", "defaults.example.json");
const storeDbPath = path.join(toolRoot, "store", "messages.db");

// First run on a fresh clone: bootstrap the local config from the tracked template.
// Relative dirs in the template resolve against the toolkit root, not the cwd.
const loadConfig = () => {
  if (!fs.existsSync(configPath) && fs.existsSync(configExamplePath)) {
    fs.copyFileSync(configExamplePath, configPath);
  }
  const config = readJson(configPath);
  for (const key of ["runsDir", "reportsDir"]) {
    if (typeof config[key] === "string" && config[key].length > 0 && !path.isAbsolute(config[key])) {
      config[key] = path.join(toolRoot, config[key]);
    }
  }
  return config;
};

let storeHandle = null;
const getStore = () => {
  if (storeHandle === null) {
    storeHandle = messageStore.openStore(storeDbPath);
  }
  return storeHandle;
};

const normalizeWatchlist = (config) =>
  (config.watchlist ?? [])
    .map((item) =>
      typeof item === "string"
        ? { groupId: item.trim(), name: "" }
        : { groupId: String(item?.groupId ?? "").trim(), name: String(item?.name ?? "") },
    )
    .filter((entry) => /^\d+$/u.test(entry.groupId));

const saveWatchlist = (entries) => {
  const config = loadConfig();
  config.watchlist = entries.map((entry) => ({ groupId: entry.groupId, name: entry.name }));
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
};

const getKnownGroups = (config) => {
  const reportsDir = config.reportsDir;
  if (!pathExists(reportsDir)) {
    return [];
  }

  const latestList = fs
    .readdirSync(reportsDir)
    .filter((name) => /^group-list-\d{8}-\d{6}\.txt$/u.test(name))
    .sort()
    .at(-1);
  if (latestList === undefined) {
    return [];
  }

  return fs
    .readFileSync(path.join(reportsDir, latestList), "utf8")
    .split(/\r?\n/u)
    .map((line) => {
      const [groupId, name = ""] = line.split("\t", 2);
      return { groupId: (groupId ?? "").trim(), name: name.trim() };
    })
    .filter((entry) => /^\d+$/u.test(entry.groupId));
};

const updateWatchlist = ({ add = [], remove = [] }) => {
  const config = loadConfig();
  const known = new Map(getKnownGroups(config).map((group) => [group.groupId, group.name]));
  const removeSet = new Set(remove.map(String));
  let entries = normalizeWatchlist(config).filter((entry) => !removeSet.has(entry.groupId));

  for (const rawGroupId of add) {
    const groupId = String(rawGroupId).trim();
    if (!/^\d+$/u.test(groupId)) {
      throw new Error(`Invalid group id: ${rawGroupId}`);
    }
    if (!entries.some((entry) => entry.groupId === groupId)) {
      entries = [...entries, { groupId, name: known.get(groupId) ?? "" }];
    }
  }

  saveWatchlist(entries);
  return entries;
};

const getState = () => {
  const config = loadConfig();
  return {
    watchlist: normalizeWatchlist(config),
    runDefaults: config.runDefaults ?? {},
    knownGroups: getKnownGroups(config),
    runs: collectRuns(config.runsDir, config.reportsDir).map((run) => ({
      ...run,
      // Absolute paths stay for /api/open; webPath is what the UI links to.
      runId: run.runId,
    })),
  };
};

const toWebPath = (runsDir, absolutePath) => {
  const relative = path.relative(runsDir, absolutePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return null;
  }
  return `/runs/${relative.split(path.sep).map(encodeURIComponent).join("/")}`;
};

const trimTopic = (topic) => ({
  id: topic.id,
  name: topic.name,
  count: topic.count,
  sampleMessages: (topic.sampleMessages ?? []).slice(-8),
});

const groupViewFromAnalysis = (groupId, analysis) => ({
  groupId,
  name: analysis.groupNames?.[groupId] || groupId,
  textMessages: analysis.parsedTextMessages ?? 0,
  mediaMessages: analysis.parsedMediaMessages ?? 0,
  firstHkt: analysis.firstMessageHkt ?? null,
  lastHkt: analysis.lastMessageHkt ?? null,
  llmSummary: analysis.llmSummary ?? null,
  localTopics: (analysis.topics ?? [])
    .filter((topic) => topic.count > 0 && topic.id !== "media")
    .slice(0, 10)
    .map(trimTopic),
  topSpeakers: (analysis.topSpeakers ?? []).slice(0, 5),
  urls: (analysis.urls ?? []).slice(-10),
});

const getRunDetail = (runId) => {
  if (!/^qq-[\w.-]+$/u.test(runId)) {
    throw new Error(`Invalid run id: ${runId}`);
  }

  const config = loadConfig();
  const runDir = path.join(config.runsDir, runId);
  const analysisPath = path.join(runDir, "analysis", "analysis.json");
  if (!pathExists(analysisPath)) {
    throw new Error(`Run not found: ${runId}`);
  }

  const combined = readJson(analysisPath);
  const digestPath = path.join(runDir, "analysis", "digest.json");
  const digest = pathExists(digestPath) ? readJson(digestPath) : null;

  const groupsDir = path.join(runDir, "analysis", "groups");
  let groups;
  if (pathExists(groupsDir)) {
    groups = fs
      .readdirSync(groupsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        const groupAnalysisPath = path.join(groupsDir, entry.name, "analysis.json");
        return pathExists(groupAnalysisPath) ? groupViewFromAnalysis(entry.name, readJson(groupAnalysisPath)) : null;
      })
      .filter((group) => group !== null)
      .sort((left, right) => right.textMessages - left.textMessages);
  } else {
    const groupId = String(combined.groupIds?.[0] ?? "unknown");
    groups = [groupViewFromAnalysis(groupId, combined)];
  }

  const manifestPath = path.join(runDir, "media", "media-manifest.json");
  const media = pathExists(manifestPath)
    ? readJson(manifestPath)
        .filter((item) => typeof item.copiedPath === "string" && item.copiedPath.length > 0)
        .map((item) => ({
          hkt: item.hkt,
          groupId: String(item.groupId ?? ""),
          speaker: item.speaker,
          kind: item.kind,
          webPath: toWebPath(config.runsDir, item.copiedPath),
        }))
        .filter((item) => item.webPath !== null)
        .slice(0, 120)
    : [];

  const reportHtml = path.join(config.reportsDir, `${runId}.html`);
  return {
    runId,
    runDir,
    reportHtml: pathExists(reportHtml) ? reportHtml : null,
    firstHkt: combined.firstMessageHkt ?? null,
    lastHkt: combined.lastMessageHkt ?? null,
    textMessages: combined.parsedTextMessages ?? 0,
    mediaMessages: combined.parsedMediaMessages ?? 0,
    digest,
    groups,
    media,
  };
};

const parseUnixParam = (value) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
};

const getStoreMessages = (query) => {
  const groupId = String(query.groupId ?? "");
  if (!/^\d+$/u.test(groupId)) {
    throw new Error("groupId is required");
  }

  const db = getStore();
  const result = messageStore.queryMessages(db, {
    groupId,
    fromUnix: parseUnixParam(query.from),
    toUnix: parseUnixParam(query.to),
    afterSentAt: parseUnixParam(query.afterSentAt),
    afterRowId: typeof query.afterRowId === "string" && query.afterRowId.length > 0 ? query.afterRowId : undefined,
    limit: Number.parseInt(query.limit ?? "300", 10),
    search: typeof query.q === "string" ? query.q : undefined,
  });

  return {
    ...result,
    coverage: messageStore.getCoverage(db, groupId),
    readMark: messageStore.getReadMark(db, groupId),
  };
};

const getStoreOverview = () => {
  const db = getStore();
  return {
    groups: messageStore.getGroupSummaries(db).map((group) => ({
      ...group,
      readMark: messageStore.getReadMark(db, group.groupId),
    })),
    retentionDays: (() => {
      const config = loadConfig();
      const days = Number(config.store?.retentionDays);
      return Number.isFinite(days) && days > 0 ? days : 3;
    })(),
  };
};

// Matches the queryMessages server-side clamp; larger selections keep the oldest 500.
const QUICK_SUMMARY_MAX_MESSAGES = 500;

const toLocalStamp = (unix) => {
  const date = new Date(unix * 1000);
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

const prepareQuickSummary = ({ groupId, fromUnix, toUnix }) => {
  const normalizedGroupId = String(groupId ?? "");
  if (!/^\d+$/u.test(normalizedGroupId)) {
    throw new Error("groupId is required");
  }
  const from = Number.parseInt(fromUnix, 10);
  const to = Number.parseInt(toUnix, 10);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from <= 0 || to < from) {
    throw new Error("Invalid selection time range");
  }

  const db = getStore();
  const { messages } = messageStore.queryMessages(db, {
    groupId: normalizedGroupId,
    fromUnix: from,
    toUnix: to + 1,
    limit: 500,
  });
  const textMessages = messages.filter((message) => message.isMedia !== 1 && message.text.trim().length > 0);
  if (textMessages.length === 0) {
    throw new Error("选中的范围内没有文本消息。");
  }

  const groupName = messageStore.getGroupSummaries(db).find((group) => group.groupId === normalizedGroupId)?.name ?? "";
  const tmpDir = path.join(toolRoot, "store", "tmp");
  fs.mkdirSync(tmpDir, { recursive: true });
  const stamp = Date.now();
  const inputPath = path.join(tmpDir, `quick-${stamp}-in.json`);
  const outputPath = path.join(tmpDir, `quick-${stamp}-out.json`);
  fs.writeFileSync(
    inputPath,
    JSON.stringify({
      groupId: normalizedGroupId,
      groupName,
      messages: textMessages.slice(-QUICK_SUMMARY_MAX_MESSAGES).map((message) => ({
        hkt: toLocalStamp(message.sentAt),
        speaker: message.speaker,
        text: message.text,
      })),
    }),
    "utf8",
  );

  return { inputPath, outputPath, count: textMessages.length, groupId: normalizedGroupId, groupName };
};

const resolveRunsWebPath = (webPath) => {
  if (typeof webPath !== "string" || !webPath.startsWith("/runs/")) {
    return null;
  }
  const config = loadConfig();
  let relative;
  try {
    relative = decodeURIComponent(webPath.slice("/runs/".length));
  } catch {
    return null;
  }
  const resolved = path.resolve(config.runsDir, relative);
  const rootCheck = path.relative(path.resolve(config.runsDir), resolved);
  if (rootCheck.startsWith("..") || path.isAbsolute(rootCheck)) {
    return null;
  }
  return resolved;
};

const MEDIA_EXPORT_MAX_ITEMS = 200;

// Copies the run-folder media files byte-for-byte (these are already 1:1 copies of
// the QQNT cache originals — no re-encoding happens anywhere in the pipeline).
const exportMediaSelection = (webPaths) => {
  if (!Array.isArray(webPaths) || webPaths.length === 0) {
    throw new Error("没有选中任何媒体文件。");
  }
  if (webPaths.length > MEDIA_EXPORT_MAX_ITEMS) {
    throw new Error(`一次最多导出 ${MEDIA_EXPORT_MAX_ITEMS} 个文件。`);
  }

  const config = loadConfig();
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  let exportDir = path.join(config.reportsDir, `media-export-${stamp}`);
  for (let suffix = 2; fs.existsSync(exportDir); suffix += 1) {
    exportDir = path.join(config.reportsDir, `media-export-${stamp}-${suffix}`);
  }
  fs.mkdirSync(exportDir, { recursive: true });

  let copied = 0;
  const failed = [];
  const usedNames = new Set();
  for (const webPath of webPaths) {
    const sourcePath = resolveRunsWebPath(webPath);
    if (sourcePath === null || !fs.existsSync(sourcePath)) {
      failed.push(String(webPath));
      continue;
    }
    let targetName = path.basename(sourcePath);
    if (usedNames.has(targetName.toLowerCase())) {
      targetName = `${copied + 1}_${targetName}`;
    }
    usedNames.add(targetName.toLowerCase());
    try {
      fs.copyFileSync(sourcePath, path.join(exportDir, targetName));
      copied += 1;
    } catch {
      failed.push(String(webPath));
    }
  }

  if (copied === 0) {
    fs.rmSync(exportDir, { recursive: true, force: true });
    throw new Error("所有文件都复制失败（可能已被清理）。");
  }
  return { folder: exportDir, copied, failed };
};

const saveReadMark = ({ groupId, sentAt, rowId, toLatest }) => {
  const normalizedGroupId = String(groupId ?? "");
  if (!/^\d+$/u.test(normalizedGroupId)) {
    throw new Error("groupId is required");
  }

  const db = getStore();
  if (toLatest === true) {
    const latest = messageStore.getLatestMessage(db, normalizedGroupId);
    if (latest !== null) {
      messageStore.setReadMark(db, normalizedGroupId, latest.sentAt, latest.rowId);
    }
    return messageStore.getReadMark(db, normalizedGroupId);
  }

  const normalizedSentAt = Number.parseInt(sentAt, 10);
  if (!Number.isFinite(normalizedSentAt) || normalizedSentAt <= 0) {
    throw new Error("sentAt is required");
  }

  messageStore.setReadMark(db, normalizedGroupId, normalizedSentAt, typeof rowId === "string" ? rowId : "");
  return messageStore.getReadMark(db, normalizedGroupId);
};

const MEDIA_INDEX_TTL_MS = 30 * 1000;
const MEDIA_INDEX_MAX_ITEMS = 4000;
let mediaIndexCache = null;

const buildMediaIndex = (forceRefresh) => {
  if (forceRefresh !== true && mediaIndexCache !== null && Date.now() - mediaIndexCache.builtAt < MEDIA_INDEX_TTL_MS) {
    return mediaIndexCache.payload;
  }

  const config = loadConfig();
  const allItems = [];
  let scannedRefs = 0;

  if (pathExists(config.runsDir)) {
    for (const entry of fs.readdirSync(config.runsDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith("qq-")) {
        continue;
      }
      const manifestPath = path.join(config.runsDir, entry.name, "media", "media-manifest.json");
      if (!pathExists(manifestPath)) {
        continue;
      }

      let manifest;
      try {
        manifest = readJson(manifestPath);
      } catch {
        // A truncated manifest from a killed run must not break the whole index.
        continue;
      }

      for (const item of manifest) {
        if (typeof item.copiedPath !== "string" || item.copiedPath.length === 0) {
          continue;
        }
        scannedRefs += 1;
        const webPath = toWebPath(config.runsDir, item.copiedPath);
        if (webPath === null) {
          continue;
        }

        let bytes;
        try {
          bytes = fs.statSync(item.copiedPath).size;
        } catch {
          continue;
        }

        allItems.push({
          runId: entry.name,
          groupId: String(item.groupId ?? ""),
          groupName: item.groupName ?? "",
          hkt: item.hkt ?? "",
          speaker: item.speaker ?? "",
          kind: item.kind ?? "file",
          bytes,
          webPath,
          dedupKey: item.hash ?? path.basename(item.copiedPath).toLowerCase(),
        });
      }
    }
  }

  // Duplicates stay in the index (the chat view joins by timestamp and needs every
  // occurrence); the media tab hides dup=true so each file shows once.
  const primaryByKey = new Map();
  for (const item of allItems) {
    const primary = primaryByKey.get(item.dedupKey);
    if (primary === undefined || item.hkt > primary.hkt) {
      primaryByKey.set(item.dedupKey, item);
    }
  }
  for (const item of allItems) {
    item.dup = primaryByKey.get(item.dedupKey) !== item;
  }

  const items = allItems.sort((left, right) => right.hkt.localeCompare(left.hkt));
  const uniqueCount = primaryByKey.size;
  const payload = {
    totalItems: uniqueCount,
    truncated: items.length > MEDIA_INDEX_MAX_ITEMS,
    scannedRefs,
    items: items.slice(0, MEDIA_INDEX_MAX_ITEMS),
  };
  mediaIndexCache = { builtAt: Date.now(), payload };
  return payload;
};

const isPathAllowedToOpen = (targetPath) => {
  const config = loadConfig();
  const resolved = path.resolve(targetPath);
  return [config.runsDir, config.reportsDir].some((root) => {
    const relative = path.relative(path.resolve(root), resolved);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  });
};

module.exports = {
  toolRoot,
  configPath,
  loadConfig,
  getState,
  updateWatchlist,
  getRunDetail,
  isPathAllowedToOpen,
  getStoreMessages,
  getStoreOverview,
  saveReadMark,
  buildMediaIndex,
  prepareQuickSummary,
  exportMediaSelection,
};
