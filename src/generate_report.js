const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const parseArgs = (argv) => {
  if (argv.length !== 5) {
    throw new Error("Usage: node generate_report.js <analysisJson> <messagesText> <outputMarkdown>");
  }

  return {
    analysisJson: argv[2],
    messagesText: argv[3],
    outputMarkdown: argv[4],
  };
};

const readJson = (filePath) => JSON.parse(fs.readFileSync(filePath, "utf8"));

const readLines = (filePath) =>
  fs
    .readFileSync(filePath, "utf8")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

const escapeHtml = (value) =>
  String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

const formatBytes = (bytes) => {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }

  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / (1024 ** index)).toFixed(index === 0 ? 0 : 2)} ${units[index]}`;
};

const fileSize = (filePath) => {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
};

const dirSize = (dirPath) => {
  if (!fs.existsSync(dirPath)) {
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

const fileUrl = (filePath) => pathToFileURL(filePath).href;

const isImagePath = (filePath) => /\.(?:jpg|jpeg|png|gif|webp|bmp)$/iu.test(filePath);

const isVideoPath = (filePath) => /\.(?:mp4|mov|webm|mkv|avi)$/iu.test(filePath);

const loadMediaReport = (analysisJson) => {
  const runDir = path.dirname(path.dirname(analysisJson));
  const mediaDir = path.join(runDir, "media");
  const manifestPath = path.join(mediaDir, "media-manifest.json");
  const manifest = fs.existsSync(manifestPath) ? readJson(manifestPath) : [];
  const copiedItems = manifest.filter((item) => typeof item.copiedPath === "string" && item.copiedPath.length > 0);
  const missingItems = manifest.filter((item) => item.copiedPath === null && item.url === null);
  const urlOnlyItems = manifest.filter((item) => item.copiedPath === null && typeof item.url === "string" && item.url.length > 0);
  const previewItems = copiedItems
    .filter((item) => isImagePath(item.copiedPath) || isVideoPath(item.copiedPath))
    .slice(0, 80);

  return {
    runDir,
    mediaDir,
    manifestPath,
    manifestExists: fs.existsSync(manifestPath),
    mediaDirExists: fs.existsSync(mediaDir),
    refs: manifest.length,
    copied: copiedItems.length,
    missing: missingItems.length,
    urlOnly: urlOnlyItems.length,
    mediaBytes: dirSize(mediaDir),
    previewItems,
  };
};

// Surfaced prominently: a truncated/aborted scan used to be invisible (raw
// "扫描行数" only), which read as "the tool lost my messages".
const scanWarningText = (analysis) => {
  if (analysis.scanTruncated !== true && analysis.scanAborted !== true) {
    return null;
  }
  const reason = analysis.scanAborted === true ? "数据库副本读取错误过多，扫描提前中止" : "扫描行数达到上限";
  const missing = analysis.coveredFromHkt ? `早于 ${analysis.coveredFromHkt} 的消息可能缺失` : "请求范围内的消息可能大量缺失";
  return `${reason}，${missing}。可提高 config\\defaults.json 的 defaultScanLimit，或缩小时间范围后重跑。`;
};

const llmBasisText = (analysis) => {
  const lines = analysis.llmSummary?.provider?.messageLines;
  if (!Number.isFinite(lines) || lines >= (analysis.parsedTextMessages ?? 0)) {
    return null;
  }
  return `AI 摘要基于最近 ${lines} 条文本消息（共 ${analysis.parsedTextMessages} 条）；更早的内容见「本地动态分组」与 messages-clean.txt。`;
};

const topItems = (items, limit) => items.slice(0, limit).map(([name, count]) => `- ${name}: ${count}`).join("\n");

const keywordItems = (items) =>
  items
    .filter((item) => item.count > 0)
    .sort((left, right) => right.count - left.count)
    .map((item) => `- ${item.name}: ${item.count}${item.occurrences ? ` 次提及 ${item.occurrences}` : ""}`)
    .join("\n");

const pickRecentLines = (lines, limit) => lines.slice(Math.max(0, lines.length - limit));

const getGroupLabel = (analysis) =>
  (analysis.groupIds ?? [])
    .map((groupId) => {
      const name = analysis.groupNames?.[groupId];
      return name ? `${name}(${groupId})` : groupId;
    })
    .join(", ");

const topicMarkdown = (topics) =>
  (topics ?? [])
    .filter((topic) => topic.count > 0)
    .sort((left, right) => right.count - left.count)
    .map((topic) => {
      const samples = (topic.sampleMessages ?? [])
        .slice(-8)
        .map((message) => `  - [${message.hkt}] ${message.speaker}: ${message.text.replace(/\s+/gu, " ").slice(0, 220)}`)
        .join("\n");
      return [`- ${topic.name}: ${topic.count}`, samples].filter((value) => value.length > 0).join("\n");
    })
    .join("\n");

const llmTopicMarkdown = (summary) =>
  (summary?.topics ?? [])
    .map((topic) => {
      const details = (topic.details ?? []).map((detail) => `  - ${detail}`).join("\n");
      const evidence = (topic.evidence ?? []).map((item) => `  - 证据: ${item}`).join("\n");
      return [
        `- ${topic.title} (${topic.importance}, 约 ${topic.messageCountEstimate} 条): ${topic.summary}`,
        details,
        evidence,
      ]
        .filter((value) => value.length > 0)
        .join("\n");
    })
    .join("\n");

const actionStatusLabel = (item) => (item.status === "resolved" ? "[已解决]" : "[待处理]");

const actionMarkdown = (items) =>
  (items ?? [])
    .map((item) => {
      const resolution = item.resolution ? `｜结果: ${item.resolution}` : "";
      return `- ${actionStatusLabel(item)} ${item.owner ?? "未指定"}: ${item.task}${resolution}｜证据: ${item.evidence}`;
    })
    .join("\n");

const timelineMarkdown = (llmSummary, timeBlocks) => {
  const llmTimeline = llmSummary?.timeline ?? [];
  if (llmTimeline.length > 0) {
    return llmTimeline
      .map((item) => `- ${item.start}${item.end ? ` - ${item.end}` : ""} (约 ${item.messageCountEstimate} 条) ${item.title}: ${item.summary}`)
      .join("\n");
  }

  return (timeBlocks ?? [])
    .map((block) => {
      const speakers = (block.topSpeakers ?? []).slice(0, 3).map(([name]) => name).join("、");
      return `- ${block.startHkt} - ${block.endHkt} (${block.count} 条) 主要发言: ${speakers || "无"}`;
    })
    .join("\n");
};

const uncategorizedMarkdown = (llmSummary) =>
  (llmSummary?.uncategorized ?? [])
    .map((item) => `- [${item.hkt}] ${item.speaker}: ${item.note}`)
    .join("\n");

const riskMarkdown = (items) =>
  (items ?? [])
    .map((item) => `- ${item.severity}: ${item.risk}｜证据: ${item.evidence}`)
    .join("\n");

const llmLinkMarkdown = (items) =>
  (items ?? [])
    .map((item) => `- ${item.title}: ${item.url}｜${item.why}`)
    .join("\n");

const mediaPreviewMarkdown = (mediaReport) => {
  if (!mediaReport.manifestExists) {
    return "- 未导出媒体文件；需要媒体时运行时启用 `-ExportMedia`。";
  }

  const previewLines = mediaReport.previewItems
    .slice(0, 20)
    .map((item) => `- [${item.hkt}] ${item.speaker}: ${item.copiedPath}`)
    .join("\n");
  return [
    `- 媒体目录: ${mediaReport.mediaDir}`,
    `- manifest: ${mediaReport.manifestPath}`,
    `- 已复制: ${mediaReport.copied}/${mediaReport.refs}`,
    `- 本地缺失: ${mediaReport.missing}`,
    `- URL-only: ${mediaReport.urlOnly}`,
    `- 媒体占用: ${formatBytes(mediaReport.mediaBytes)}`,
    "",
    previewLines || "- 无可预览本地媒体",
  ].join("\n");
};

const writeMarkdownReport = (analysis, lines, outputPath, mediaReport) => {
  const recentLines = pickRecentLines(lines, 80);
  const groupLabel = getGroupLabel(analysis);
  const sections = [
    "# QQ 群消息初报",
    "",
    `- 群: ${groupLabel || "无"}`,
    `- 时间范围: ${analysis.firstMessageHkt ?? "无"} 至 ${analysis.lastMessageHkt ?? "无"}`,
    `- 文本消息: ${analysis.parsedTextMessages}`,
    `- 媒体消息: ${analysis.parsedMediaMessages ?? 0}`,
    `- 原始匹配: ${analysis.matchedRaw}`,
    `- 扫描行数: ${analysis.scanned}`,
    ...(scanWarningText(analysis) !== null ? ["", `> ⚠ **扫描不完整**：${scanWarningText(analysis)}`] : []),
    "",
    "## LLM 动态摘要",
    "",
    analysis.llmSummary?.summary ?? "- 未启用 LLM；这里只包含本地动态分组和统计。",
    ...(llmBasisText(analysis) !== null ? ["", `> ℹ ${llmBasisText(analysis)}`] : []),
    "",
    "## LLM 动态主题",
    "",
    llmTopicMarkdown(analysis.llmSummary) || "- 无",
    "",
    "## 时间线",
    "",
    timelineMarkdown(analysis.llmSummary, analysis.timeBlocks) || "- 无",
    "",
    "## 未归类但可能重要",
    "",
    uncategorizedMarkdown(analysis.llmSummary) || "- 无",
    "",
    "## 待处理事项",
    "",
    actionMarkdown(analysis.llmSummary?.actions) || "- 无",
    "",
    "## 风险点",
    "",
    riskMarkdown(analysis.llmSummary?.risks) || "- 无",
    "",
    "## LLM 筛选链接",
    "",
    llmLinkMarkdown(analysis.llmSummary?.links) || "- 无",
    "",
    "## 本地动态分组",
    "",
    topicMarkdown(analysis.topics) || "- 无",
    "",
    "## 每日数量",
    "",
    topItems(analysis.byDay ?? [], 20) || "- 无",
    "",
    "## 群分布",
    "",
    topItems(analysis.byGroup ?? [], 50) || "- 无",
    "",
    "## 活跃发言人",
    "",
    topItems(analysis.topSpeakers ?? [], 20) || "- 无",
    "",
    "## 本地高频词",
    "",
    keywordItems(analysis.keywordStats ?? []) || "- 无",
    "",
    "## 媒体统计",
    "",
    `- 媒体消息: ${analysis.mediaSummary?.messages ?? 0}`,
    `- 媒体引用: ${analysis.mediaSummary?.refs ?? 0}`,
    topItems(analysis.mediaSummary?.byKind ?? [], 20) || "- 无",
    "",
    "## 本地媒体文件",
    "",
    mediaPreviewMarkdown(mediaReport),
    "",
    "## 链接",
    "",
    (analysis.urls ?? []).slice(-30).map((item) => `- [${item.hkt}] ${item.speaker}: ${item.url}`).join("\n") || "- 无",
    "",
    "## 给 agent 的总结要求",
    "",
    "请根据 `messages-clean.txt`、`topics.json` 和 `llm-summary.json`（如存在）输出：",
    "",
    "- 根据当前消息内容动态归纳主题，不使用固定行业分类",
    "- 每个主题的 1-3 句摘要",
    "- 重要待办/需要回复的人",
    "- 故障、投诉、退款、封号、配置问题等风险点",
    "- 值得保存的链接或公告素材",
    "- 可以直接发给用户/群里的简短公告草稿（如有必要）",
    "",
    "## 最近消息抽样",
    "",
    "```text",
    recentLines.join("\n"),
    "```",
    "",
  ];

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, sections.join("\n"), "utf8");
};

const renderStatsList = (items, limit) =>
  `<ul>${(items ?? [])
    .slice(0, limit)
    .map(([name, count]) => `<li><span>${escapeHtml(name)}</span><strong>${escapeHtml(count)}</strong></li>`)
    .join("")}</ul>`;

const renderTopicDetails = (topics) =>
  (topics ?? [])
    .filter((topic) => topic.count > 0)
    .sort((left, right) => right.count - left.count)
    .map((topic) => {
      const samples = (topic.sampleMessages ?? [])
        .slice(-40)
        .map(
          (message) => `
            <li>
              <time>${escapeHtml(message.hkt)}</time>
              <span class="speaker">${escapeHtml(message.speaker)}</span>
              <p>${escapeHtml(message.text)}</p>
            </li>`,
        )
        .join("");

      return `
        <details class="topic" open>
          <summary>
            <span>${escapeHtml(topic.name)}</span>
            <strong>${escapeHtml(topic.count)}</strong>
          </summary>
          <div class="topic-meta">
            <span>${escapeHtml(topic.firstHkt ?? "无")} - ${escapeHtml(topic.lastHkt ?? "无")}</span>
          </div>
          <ol>${samples}</ol>
        </details>`;
    })
    .join("");

const renderLlmTopics = (summary) =>
  (summary?.topics ?? [])
    .map((topic) => {
      const details = (topic.details ?? []).map((detail) => `<li>${escapeHtml(detail)}</li>`).join("");
      const evidence = (topic.evidence ?? []).map((item) => `<li>${escapeHtml(item)}</li>`).join("");
      return `
        <details class="topic" open>
          <summary>
            <span>${escapeHtml(topic.title)}</span>
            <strong>${escapeHtml(topic.importance)}</strong>
          </summary>
          <div class="topic-meta">
            <span>${escapeHtml(topic.summary)}</span>
          </div>
          <h3>要点</h3>
          <ul>${details}</ul>
          <h3>证据</h3>
          <ul>${evidence}</ul>
        </details>`;
    })
    .join("");

const renderLlmList = (items, renderItem) =>
  `<ul>${(items ?? []).map((item) => `<li>${renderItem(item)}</li>`).join("")}</ul>`;

const renderMediaGallery = (mediaReport) => {
  if (!mediaReport.manifestExists) {
    return "<p>未导出媒体文件；需要媒体时运行时启用 <code>-ExportMedia</code>。</p>";
  }

  const items = mediaReport.previewItems
    .map((item) => {
      const src = fileUrl(item.copiedPath);
      const label = `[${item.hkt}] ${item.speaker}`;
      const media = isVideoPath(item.copiedPath)
        ? `<video src="${escapeHtml(src)}" controls preload="metadata"></video>`
        : `<img src="${escapeHtml(src)}" loading="lazy" alt="${escapeHtml(label)}">`;
      return `
        <figure>
          ${media}
          <figcaption>${escapeHtml(label)}</figcaption>
        </figure>`;
    })
    .join("");

  return `
    <div class="media-meta">
      <span>目录: <a href="${escapeHtml(fileUrl(mediaReport.mediaDir))}">${escapeHtml(mediaReport.mediaDir)}</a></span>
      <span>已复制: ${escapeHtml(mediaReport.copied)}/${escapeHtml(mediaReport.refs)}</span>
      <span>本地缺失: ${escapeHtml(mediaReport.missing)}</span>
      <span>URL-only: ${escapeHtml(mediaReport.urlOnly)}</span>
      <span>占用: ${escapeHtml(formatBytes(mediaReport.mediaBytes))}</span>
    </div>
    <div class="media-grid">${items || "<p>无可预览本地媒体</p>"}</div>`;
};

const writeHtmlReport = (analysis, outputMarkdown, mediaReport) => {
  const htmlPath = outputMarkdown.replace(/\.md$/iu, ".html");
  const groupLabel = getGroupLabel(analysis);
  const html = `<!doctype html>
<html lang="zh-Hans">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>QQ 群消息报告</title>
  <style>
    :root { color-scheme: light; --bg: #f7f7f5; --panel: #ffffff; --text: #1e2329; --muted: #69707a; --line: #dfe3e8; --accent: #1565c0; --risk: #b3261e; }
    body { margin: 0; font-family: "Segoe UI", "Microsoft YaHei", Arial, sans-serif; background: var(--bg); color: var(--text); }
    header { padding: 28px 32px 18px; border-bottom: 1px solid var(--line); background: var(--panel); }
    h1 { margin: 0 0 12px; font-size: 26px; letter-spacing: 0; }
    .meta { display: flex; flex-wrap: wrap; gap: 10px; color: var(--muted); font-size: 13px; }
    .meta span { padding: 4px 8px; border: 1px solid var(--line); border-radius: 6px; background: #fafafa; }
    main { max-width: 1180px; margin: 0 auto; padding: 24px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 14px; margin-bottom: 18px; }
    .metric, section { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; }
    .metric { padding: 14px 16px; }
    .metric span { display: block; color: var(--muted); font-size: 12px; }
    .metric strong { display: block; margin-top: 6px; font-size: 24px; }
    section { margin: 16px 0; padding: 18px; }
    h2 { margin: 0 0 12px; font-size: 18px; }
    h3 { margin: 8px 14px 0; font-size: 14px; }
    ul { list-style: none; padding: 0; margin: 0; }
    li { border-top: 1px solid var(--line); padding: 8px 0; }
    li:first-child { border-top: 0; }
    li strong { float: right; color: var(--accent); }
    details.topic { border: 1px solid var(--line); border-radius: 8px; margin: 10px 0; background: #fff; }
    details.topic summary { cursor: pointer; padding: 12px 14px; display: flex; align-items: center; justify-content: space-between; font-weight: 650; }
    details.topic summary strong { color: var(--accent); }
    .topic-meta { padding: 0 14px 8px; color: var(--muted); font-size: 12px; }
    ol { margin: 0; padding: 0 14px 14px; list-style: none; }
    time { color: var(--muted); font-size: 12px; margin-right: 8px; }
    .speaker { font-weight: 650; }
    p { margin: 6px 0 0; line-height: 1.55; white-space: pre-wrap; }
    a { color: var(--accent); word-break: break-all; }
    code { font-family: Consolas, monospace; }
    .media-meta { display: flex; flex-wrap: wrap; gap: 8px; color: var(--muted); font-size: 12px; margin-bottom: 12px; }
    .media-meta span { border: 1px solid var(--line); border-radius: 6px; padding: 4px 8px; background: #fafafa; }
    .media-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 12px; }
    figure { margin: 0; border: 1px solid var(--line); border-radius: 8px; overflow: hidden; background: #fafafa; }
    figure img, figure video { width: 100%; aspect-ratio: 1 / 1; object-fit: cover; display: block; background: #eee; }
    figcaption { padding: 6px 8px; color: var(--muted); font-size: 12px; line-height: 1.35; }
    @media print { body { background: #fff; } main { max-width: none; padding: 12px; } details.topic { break-inside: avoid; } }
  </style>
</head>
<body>
  <header>
    <h1>QQ 群消息报告</h1>
    <div class="meta">
      <span>${escapeHtml(groupLabel || "无群")}</span>
      <span>${escapeHtml(analysis.firstMessageHkt ?? "无")} - ${escapeHtml(analysis.lastMessageHkt ?? "无")}</span>
    </div>
  </header>
  <main>
    <div class="grid">
      <div class="metric"><span>文本消息</span><strong>${escapeHtml(analysis.parsedTextMessages ?? 0)}</strong></div>
      <div class="metric"><span>媒体消息</span><strong>${escapeHtml(analysis.parsedMediaMessages ?? 0)}</strong></div>
      <div class="metric"><span>媒体引用</span><strong>${escapeHtml(analysis.mediaSummary?.refs ?? 0)}</strong></div>
      <div class="metric"><span>扫描行数</span><strong>${escapeHtml(analysis.scanned ?? 0)}</strong></div>
    </div>
    ${scanWarningText(analysis) !== null
      ? `<section style="border-color:var(--risk)"><h2 style="color:var(--risk)">⚠ 扫描不完整</h2><p>${escapeHtml(scanWarningText(analysis))}</p></section>`
      : ""}
    <section>
      <h2>LLM 动态摘要</h2>
      <p>${escapeHtml(analysis.llmSummary?.summary ?? "未启用 LLM；这里只包含本地动态分组和统计。")}</p>
      ${llmBasisText(analysis) !== null ? `<p style="color:var(--muted);font-size:12px">${escapeHtml(llmBasisText(analysis))}</p>` : ""}
    </section>
    <section>
      <h2>LLM 动态主题</h2>
      ${renderLlmTopics(analysis.llmSummary) || "<p>无</p>"}
    </section>
    <section>
      <h2>时间线</h2>
      <ul>${(analysis.llmSummary?.timeline ?? []).length > 0
        ? (analysis.llmSummary?.timeline ?? [])
            .map((item) => `<li><time>${escapeHtml(item.start)}${item.end ? ` - ${escapeHtml(item.end)}` : ""}</time><span class="speaker">${escapeHtml(item.title)}</span><p>${escapeHtml(item.summary)}</p></li>`)
            .join("")
        : (analysis.timeBlocks ?? [])
            .map((block) => `<li><time>${escapeHtml(block.startHkt)} - ${escapeHtml(block.endHkt)}</time><p>${escapeHtml(block.count)} 条消息</p></li>`)
            .join("")}</ul>
    </section>
    <section>
      <h2>未归类但可能重要</h2>
      ${renderLlmList(analysis.llmSummary?.uncategorized, (item) => `<time>${escapeHtml(item.hkt)}</time><span class="speaker">${escapeHtml(item.speaker)}</span><p>${escapeHtml(item.note)}</p>`)}
    </section>
    <section>
      <h2>待处理事项</h2>
      ${renderLlmList(analysis.llmSummary?.actions, (item) => `<span class="speaker">${item.status === "resolved" ? "✅" : "⏳"} ${escapeHtml(item.owner ?? "未指定")}</span><p>${escapeHtml(item.task)}${item.resolution ? `<br>结果: ${escapeHtml(item.resolution)}` : ""}<br>证据: ${escapeHtml(item.evidence)}</p>`)}
    </section>
    <section>
      <h2>风险点</h2>
      ${renderLlmList(analysis.llmSummary?.risks, (item) => `<span class="speaker">${escapeHtml(item.severity)}</span><p>${escapeHtml(item.risk)}<br>证据: ${escapeHtml(item.evidence)}</p>`)}
    </section>
    <section>
      <h2>本地动态分组</h2>
      ${renderTopicDetails(analysis.topics)}
    </section>
    <section>
      <h2>本地媒体文件</h2>
      ${renderMediaGallery(mediaReport)}
    </section>
    <section>
      <h2>活跃发言人</h2>
      ${renderStatsList(analysis.topSpeakers, 20)}
    </section>
    <section>
      <h2>群分布</h2>
      ${renderStatsList(analysis.byGroup, 50)}
    </section>
    <section>
      <h2>链接</h2>
      <ul>${(analysis.urls ?? [])
        .slice(-50)
        .map((item) => `<li><time>${escapeHtml(item.hkt)}</time><span class="speaker">${escapeHtml(item.speaker)}</span><p><a href="${escapeHtml(item.url)}">${escapeHtml(item.url)}</a></p></li>`)
        .join("")}</ul>
    </section>
  </main>
</body>
</html>`;

  fs.writeFileSync(htmlPath, html, "utf8");
  return htmlPath;
};

const main = () => {
  const args = parseArgs(process.argv);
  const analysis = readJson(args.analysisJson);
  const lines = readLines(args.messagesText);
  const mediaReport = loadMediaReport(args.analysisJson);
  writeMarkdownReport(analysis, lines, args.outputMarkdown, mediaReport);
  const htmlPath = writeHtmlReport(analysis, args.outputMarkdown, mediaReport);
  console.log(`htmlPath=${htmlPath}`);
};

main();
