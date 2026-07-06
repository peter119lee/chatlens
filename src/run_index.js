const fs = require("node:fs");
const path = require("node:path");
const { readJson } = require("./report_utils");

const pathExists = (filePath) => fs.existsSync(filePath);

const fileSize = (filePath) => {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
};

const dirSize = (dirPath) => {
  if (!pathExists(dirPath)) {
    return 0;
  }

  const stack = [dirPath];
  let total = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(entryPath);
      } else if (entry.isFile()) {
        total += fileSize(entryPath);
      }
    }
  }

  return total;
};

const latestMtime = (dirPath) => {
  if (!pathExists(dirPath)) {
    return 0;
  }

  const stack = [dirPath];
  let latest = fs.statSync(dirPath).mtimeMs;
  while (stack.length > 0) {
    const current = stack.pop();
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      let stat;
      try {
        stat = fs.statSync(entryPath);
      } catch {
        continue;
      }
      latest = Math.max(latest, stat.mtimeMs);
      if (entry.isDirectory()) {
        stack.push(entryPath);
      }
    }
  }

  return latest;
};

const parseRunTimestamp = (runId) => {
  const match = runId.match(/(\d{8})-(\d{6})$/u);
  if (match === null) {
    return null;
  }

  const [, datePart, timePart] = match;
  const iso = `${datePart.slice(0, 4)}-${datePart.slice(4, 6)}-${datePart.slice(6, 8)}T${timePart.slice(0, 2)}:${timePart.slice(2, 4)}:${timePart.slice(4, 6)}+08:00`;
  const timestamp = Date.parse(iso);
  return Number.isFinite(timestamp) ? timestamp : null;
};

const countManifest = (manifestPath) => {
  if (!pathExists(manifestPath)) {
    return {
      refs: 0,
      copied: 0,
      missing: 0,
      urlOnly: 0,
    };
  }

  const manifest = readJson(manifestPath);
  return {
    refs: manifest.length,
    copied: manifest.filter((item) => typeof item.copiedPath === "string" && item.copiedPath.length > 0).length,
    missing: manifest.filter((item) => item.copiedPath === null && item.url === null).length,
    urlOnly: manifest.filter((item) => item.copiedPath === null && typeof item.url === "string" && item.url.length > 0).length,
  };
};

const groupLabel = (analysis) =>
  (analysis.byGroup ?? [])
    .slice(0, 3)
    .map(([name, count]) => `${name} (${count})`)
    .join(", ") || (analysis.groupIds ?? []).join(", ") || "Unknown";

const summarizeTopics = (analysis) => {
  if (analysis.llmSummary?.summary) {
    return analysis.llmSummary.summary;
  }

  return (analysis.topics ?? [])
    .filter((topic) => topic.count > 0)
    .sort((left, right) => right.count - left.count)
    .slice(0, 3)
    .map((topic) => topic.name)
    .join(" / ") || "No summary";
};

// A run left behind with truncated/corrupt JSON must not take down the whole listing.
const collectRun = (runDir, reportsDir) => {
  try {
    return collectRunUnsafe(runDir, reportsDir);
  } catch (error) {
    console.error(`run-index: skipping unreadable run ${path.basename(runDir)}: ${error.message}`);
    return null;
  }
};

const collectRunUnsafe = (runDir, reportsDir) => {
  const runId = path.basename(runDir);
  const analysisPath = path.join(runDir, "analysis", "analysis.json");
  if (!pathExists(analysisPath)) {
    return null;
  }

  const analysis = readJson(analysisPath);
  const digestPath = path.join(runDir, "analysis", "digest.json");
  const digest = pathExists(digestPath) ? readJson(digestPath) : null;
  const mediaDir = path.join(runDir, "media");
  const manifestPath = path.join(mediaDir, "media-manifest.json");
  const reportHtml = path.join(reportsDir, `${runId}.html`);
  const reportMd = path.join(reportsDir, `${runId}.md`);
  const cleanDbDir = path.join(runDir, "clean-db");
  const mediaStats = countManifest(manifestPath);
  const mediaBytes = dirSize(mediaDir);
  const cleanDbBytes = dirSize(cleanDbDir);
  const runBytes = dirSize(runDir);

  return {
    runId,
    runDir,
    analysisPath,
    reportHtml,
    reportMd,
    mediaDir,
    manifestPath,
    hasReportHtml: pathExists(reportHtml),
    hasReportMd: pathExists(reportMd),
    hasMedia: pathExists(manifestPath),
    hasCleanDb: pathExists(cleanDbDir),
    firstMessageHkt: analysis.firstMessageHkt ?? "N/A",
    lastMessageHkt: analysis.lastMessageHkt ?? "N/A",
    isDigest: digest !== null,
    groups: groupLabel(analysis),
    summary: digest?.overview ?? summarizeTopics(analysis),
    textMessages: analysis.parsedTextMessages ?? 0,
    mediaMessages: analysis.parsedMediaMessages ?? 0,
    mediaRefs: analysis.mediaSummary?.refs ?? mediaStats.refs,
    copiedMedia: mediaStats.copied,
    missingMedia: mediaStats.missing,
    urlOnlyMedia: mediaStats.urlOnly,
    llmStatus: (digest ? digest.llmGroups > 0 : analysis.llmSummary) ? "done" : "not-used",
    llmModel: digest ? `${digest.llmGroups}/${digest.groupCount} 群 LLM` : analysis.llmSummary?.provider?.model ?? "",
    mediaBytes,
    cleanDbBytes,
    runBytes,
    createdMs: parseRunTimestamp(runId),
    mtimeMs: latestMtime(runDir),
  };
};

const collectRuns = (runsDir, reportsDir) => {
  if (!pathExists(runsDir)) {
    return [];
  }

  return fs
    .readdirSync(runsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("qq-"))
    .map((entry) => collectRun(path.join(runsDir, entry.name), reportsDir))
    .filter((run) => run !== null)
    .sort((left, right) => (right.createdMs ?? right.mtimeMs) - (left.createdMs ?? left.mtimeMs));
};

module.exports = {
  pathExists,
  dirSize,
  countManifest,
  parseRunTimestamp,
  collectRun,
  collectRuns,
};
