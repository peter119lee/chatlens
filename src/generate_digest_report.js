const fs = require("node:fs");
const path = require("node:path");
const { readJson, escapeHtml, fileUrl, isImagePath, isVideoPath } = require("./report_utils");

const parseArgs = (argv) => {
  if (argv.length !== 4) {
    throw new Error("Usage: node generate_digest_report.js <runDir> <outputMarkdown>");
  }

  return {
    runDir: argv[2],
    outputMarkdown: argv[3],
  };
};

const loadCombinedAnalysis = (runDir) => readJson(path.join(runDir, "analysis", "analysis.json"));

const loadGroupAnalyses = (runDir) => {
  const groupsDir = path.join(runDir, "analysis", "groups");
  if (!fs.existsSync(groupsDir)) {
    throw new Error(`Digest requires per-group analyses. Missing directory: ${groupsDir}`);
  }

  return fs
    .readdirSync(groupsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const analysisPath = path.join(groupsDir, entry.name, "analysis.json");
      if (!fs.existsSync(analysisPath)) {
        return null;
      }
      return { groupId: entry.name, analysis: readJson(analysisPath) };
    })
    .filter((item) => item !== null);
};

const loadManifest = (runDir) => {
  const manifestPath = path.join(runDir, "media", "media-manifest.json");
  return fs.existsSync(manifestPath) ? readJson(manifestPath) : [];
};

const scanWarningText = (combined) => {
  if (combined.scanTruncated !== true && combined.scanAborted !== true) {
    return null;
  }
  const reason = combined.scanAborted === true ? "数据库副本读取错误过多，扫描提前中止" : "扫描行数达到上限";
  const missing = combined.coveredFromHkt ? `早于 ${combined.coveredFromHkt} 的消息可能缺失` : "请求范围内的消息可能大量缺失";
  return `${reason}，${missing}。可提高 config\\defaults.json 的 defaultScanLimit，或缩小时间范围后重跑。`;
};

const localTopicLine = (analysis) =>
  (analysis.topics ?? [])
    .filter((topic) => topic.count > 0 && topic.id !== "misc" && topic.id !== "media")
    .sort((left, right) => right.count - left.count)
    .slice(0, 3)
    .map((topic) => topic.name)
    .join(" / ");

const buildGroupView = (groupId, analysis, manifest) => {
  const name = analysis.groupNames?.[groupId] || groupId;
  const llm = analysis.llmSummary ?? null;
  const mediaItems = manifest
    .filter(
      (item) =>
        String(item.groupId) === groupId &&
        typeof item.copiedPath === "string" &&
        item.copiedPath.length > 0 &&
        (isImagePath(item.copiedPath) || isVideoPath(item.copiedPath)),
    )
    .slice(0, 12);

  return {
    groupId,
    name,
    label: name === groupId ? groupId : `${name}(${groupId})`,
    llmBasisNote:
      Number.isFinite(llm?.provider?.messageLines) && llm.provider.messageLines < (analysis.parsedTextMessages ?? 0)
        ? `AI 摘要基于最近 ${llm.provider.messageLines} 条`
        : null,
    textMessages: analysis.parsedTextMessages ?? 0,
    mediaMessages: analysis.parsedMediaMessages ?? 0,
    firstHkt: analysis.firstMessageHkt ?? null,
    lastHkt: analysis.lastMessageHkt ?? null,
    llm,
    summaryLine: llm?.summary ?? (localTopicLine(analysis) || "本时段没有可归纳的文本消息。"),
    localTopics: analysis.topics ?? [],
    topSpeakers: (analysis.topSpeakers ?? []).slice(0, 5),
    urls: (analysis.urls ?? []).slice(-10),
    mediaItems,
  };
};

const mergeFromGroups = (groups, pick) =>
  groups.flatMap((group) => (pick(group) ?? []).map((item) => ({ ...item, groupName: group.name })));

const importanceRank = { high: 0, medium: 1, low: 2 };

const sortByImportance = (items, getLevel) =>
  [...items].sort((left, right) => (importanceRank[getLevel(left)] ?? 3) - (importanceRank[getLevel(right)] ?? 3));

const topicMarkdown = (group) => {
  if (group.llm !== null) {
    return group.llm.topics
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
  }

  return group.localTopics
    .filter((topic) => topic.count > 0)
    .sort((left, right) => right.count - left.count)
    .slice(0, 8)
    .map((topic) => `- ${topic.name}: ${topic.count} 条`)
    .join("\n");
};

const sortActionsOpenFirst = (items) =>
  [...items].sort((left, right) => Number(left.status === "resolved") - Number(right.status === "resolved"));

const actionLineMarkdown = (item) => {
  const status = item.status === "resolved" ? "[已解决]" : "[待处理]";
  const resolution = item.resolution ? `｜结果: ${item.resolution}` : "";
  return `- ${status} [${item.groupName}] ${item.owner ?? "未指定"}: ${item.task}${resolution}｜证据: ${item.evidence}`;
};

const timelineMarkdown = (group) => {
  const items = group.llm?.timeline ?? [];
  if (items.length > 0) {
    return items
      .map((item) => `- ${item.start}${item.end ? ` - ${item.end}` : ""} (约 ${item.messageCountEstimate} 条) ${item.title}: ${item.summary}`)
      .join("\n");
  }
  return "";
};

const uncategorizedMarkdown = (group) =>
  (group.llm?.uncategorized ?? [])
    .map((item) => `- [${item.hkt}] ${item.speaker}: ${item.note}`)
    .join("\n");

const writeMarkdown = (combined, groups, outputPath) => {
  const actions = sortActionsOpenFirst(mergeFromGroups(groups, (group) => group.llm?.actions));
  const risks = sortByImportance(
    mergeFromGroups(groups, (group) => group.llm?.risks),
    (item) => item.severity,
  );
  const sections = [
    "# QQ 多群摘要",
    "",
    `- 时间范围: ${combined.firstMessageHkt ?? "无"} 至 ${combined.lastMessageHkt ?? "无"}`,
    `- 群数量: ${groups.length}`,
    `- 文本消息: ${combined.parsedTextMessages ?? 0}`,
    `- 媒体消息: ${combined.parsedMediaMessages ?? 0}`,
    ...(scanWarningText(combined) !== null ? ["", `> ⚠ **扫描不完整**：${scanWarningText(combined)}`] : []),
    "",
    "## 总览",
    "",
    groups
      .map((group) => `- ${group.label} — 文本 ${group.textMessages} · 媒体 ${group.mediaMessages}: ${group.summaryLine}`)
      .join("\n"),
    "",
    "## 待处理事项（全部群）",
    "",
    actions.map(actionLineMarkdown).join("\n") || "- 无",
    "",
    "## 风险点（全部群）",
    "",
    risks.map((item) => `- [${item.groupName}] ${item.severity}: ${item.risk}｜证据: ${item.evidence}`).join("\n") || "- 无",
    "",
    "## 各群详情",
    "",
    groups
      .map((group) =>
        [
          `### ${group.label}`,
          "",
          `- 文本 ${group.textMessages} · 媒体 ${group.mediaMessages} · ${group.llm !== null ? "LLM 主题" : "本地分组"}`,
          `- 时间: ${group.firstHkt ?? "无"} 至 ${group.lastHkt ?? "无"}`,
          "",
          topicMarkdown(group) || "- 无",
          "",
          timelineMarkdown(group).length > 0 ? ["#### 时间线", "", timelineMarkdown(group), ""].join("\n") : "",
          uncategorizedMarkdown(group).length > 0 ? ["#### 未归类但可能重要", "", uncategorizedMarkdown(group), ""].join("\n") : "",
          group.urls.length > 0
            ? ["#### 链接", "", group.urls.map((item) => `- [${item.hkt}] ${item.speaker}: ${item.url}`).join("\n"), ""].join("\n")
            : "",
        ].join("\n"),
      )
      .join("\n"),
    "",
  ];

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, sections.join("\n"), "utf8");
};

const renderChips = (values) => values.map((value) => `<span>${escapeHtml(value)}</span>`).join("");

const renderOverviewCards = (groups) =>
  groups
    .map(
      (group) => `
      <a class="card" href="#group-${escapeHtml(group.groupId)}">
        <h3>${escapeHtml(group.name)}</h3>
        <div class="card-metrics">
          <span>文本 ${escapeHtml(group.textMessages)}</span>
          <span>媒体 ${escapeHtml(group.mediaMessages)}</span>
          <span class="${group.llm !== null ? "ok" : "warn"}">${group.llm !== null ? "LLM" : "本地"}</span>
        </div>
        <p>${escapeHtml(group.summaryLine)}</p>
      </a>`,
    )
    .join("");

const renderMergedList = (items, renderItem) => {
  if (items.length === 0) {
    return "<p>无</p>";
  }

  return `<ul>${items.map((item) => `<li>${renderItem(item)}</li>`).join("")}</ul>`;
};

const renderGroupTopics = (group) => {
  if (group.llm !== null) {
    if (group.llm.topics.length === 0) {
      return "<p>LLM 没有归纳出主题。</p>";
    }
    return group.llm.topics
      .map((topic) => {
        const details = (topic.details ?? []).map((detail) => `<li>${escapeHtml(detail)}</li>`).join("");
        const evidence = (topic.evidence ?? []).map((item) => `<li>${escapeHtml(item)}</li>`).join("");
        return `
        <details class="topic" open>
          <summary>
            <span>${escapeHtml(topic.title)}</span>
            <strong class="imp-${escapeHtml(topic.importance)}">${escapeHtml(topic.importance)} · 约 ${escapeHtml(topic.messageCountEstimate)} 条</strong>
          </summary>
          <div class="topic-meta">${escapeHtml(topic.summary)}</div>
          ${details.length > 0 ? `<h4>要点</h4><ul>${details}</ul>` : ""}
          ${evidence.length > 0 ? `<h4>证据</h4><ul class="evidence">${evidence}</ul>` : ""}
        </details>`;
      })
      .join("");
  }

  const localTopics = group.localTopics
    .filter((topic) => topic.count > 0)
    .sort((left, right) => right.count - left.count)
    .slice(0, 8)
    .map((topic) => {
      const samples = (topic.sampleMessages ?? [])
        .slice(-6)
        .map(
          (message) =>
            `<li><time>${escapeHtml(message.hkt)}</time><span class="speaker">${escapeHtml(message.speaker)}</span> ${escapeHtml(message.text)}</li>`,
        )
        .join("");
      return `
        <details class="topic">
          <summary><span>${escapeHtml(topic.name)}</span><strong>${escapeHtml(topic.count)} 条</strong></summary>
          <ul>${samples}</ul>
        </details>`;
    })
    .join("");
  return localTopics || "<p>本时段没有可归纳的文本消息。</p>";
};

const renderGroupMedia = (group) => {
  if (group.mediaItems.length === 0) {
    return "";
  }

  const figures = group.mediaItems
    .map((item) => {
      const src = fileUrl(item.copiedPath);
      const label = `[${item.hkt}] ${item.speaker}`;
      const media = isVideoPath(item.copiedPath)
        ? `<video src="${escapeHtml(src)}" controls preload="metadata"></video>`
        : `<img src="${escapeHtml(src)}" loading="lazy" alt="${escapeHtml(label)}">`;
      return `<figure>${media}<figcaption>${escapeHtml(label)}</figcaption></figure>`;
    })
    .join("");
  return `<h4>媒体抽样</h4><div class="media-grid">${figures}</div>`;
};

const renderGroupTimeline = (group) => {
  const items = group.llm?.timeline ?? [];
  if (items.length === 0) {
    return "";
  }
  return `<h4>时间线</h4><ul class="links">${items
    .map(
      (item) =>
        `<li><time>${escapeHtml(item.start)}${item.end ? ` - ${escapeHtml(item.end)}` : ""}</time><span class="speaker">${escapeHtml(item.title)}</span> ${escapeHtml(item.summary)}</li>`,
    )
    .join("")}</ul>`;
};

const renderGroupUncategorized = (group) => {
  const items = group.llm?.uncategorized ?? [];
  if (items.length === 0) {
    return "";
  }
  return `<h4>未归类但可能重要</h4><ul class="links">${items
    .map((item) => `<li><time>${escapeHtml(item.hkt)}</time><span class="speaker">${escapeHtml(item.speaker)}</span> ${escapeHtml(item.note)}</li>`)
    .join("")}</ul>`;
};

const renderGroupSection = (group) => `
  <section class="group" id="group-${escapeHtml(group.groupId)}">
    <h2>${escapeHtml(group.name)} <small>${escapeHtml(group.groupId)}</small></h2>
    <div class="meta">
      ${renderChips([
        `文本 ${group.textMessages}`,
        `媒体 ${group.mediaMessages}`,
        `${group.firstHkt ?? "无"} - ${group.lastHkt ?? "无"}`,
        group.llm !== null ? "LLM 主题" : "本地分组",
        ...(group.llmBasisNote !== null ? [group.llmBasisNote] : []),
      ])}
    </div>
    <p class="group-summary">${escapeHtml(group.summaryLine)}</p>
    ${renderGroupTimeline(group)}
    ${renderGroupTopics(group)}
    ${renderGroupUncategorized(group)}
    ${renderGroupMedia(group)}
    ${
      group.urls.length > 0
        ? `<h4>链接</h4><ul class="links">${group.urls
            .map(
              (item) =>
                `<li><time>${escapeHtml(item.hkt)}</time><span class="speaker">${escapeHtml(item.speaker)}</span> <a href="${escapeHtml(item.url)}">${escapeHtml(item.url)}</a></li>`,
            )
            .join("")}</ul>`
        : ""
    }
    ${
      group.topSpeakers.length > 0
        ? `<div class="speakers">活跃: ${group.topSpeakers
            .map(([speaker, count]) => `${escapeHtml(speaker)} (${escapeHtml(count)})`)
            .join(" · ")}</div>`
        : ""
    }
  </section>`;

const writeHtml = (combined, groups, outputMarkdown) => {
  const htmlPath = outputMarkdown.replace(/\.md$/iu, ".html");
  const actions = sortActionsOpenFirst(mergeFromGroups(groups, (group) => group.llm?.actions));
  const risks = sortByImportance(
    mergeFromGroups(groups, (group) => group.llm?.risks),
    (item) => item.severity,
  );
  const html = `<!doctype html>
<html lang="zh-Hans">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>QQ 多群摘要</title>
  <style>
    :root { color-scheme: light; --bg: #f7f7f5; --panel: #ffffff; --text: #1e2329; --muted: #69707a; --line: #dfe3e8; --accent: #1565c0; --ok: #0f9f6e; --warn: #c27803; --risk: #b3261e; }
    body { margin: 0; font-family: "Segoe UI", "Microsoft YaHei", Arial, sans-serif; background: var(--bg); color: var(--text); }
    header { padding: 26px 32px 16px; border-bottom: 1px solid var(--line); background: var(--panel); }
    h1 { margin: 0 0 10px; font-size: 26px; }
    .meta { display: flex; flex-wrap: wrap; gap: 8px; color: var(--muted); font-size: 13px; }
    .meta span { padding: 4px 8px; border: 1px solid var(--line); border-radius: 6px; background: #fafafa; }
    nav { position: sticky; top: 0; z-index: 5; display: flex; flex-wrap: wrap; gap: 8px; padding: 10px 32px; background: var(--panel); border-bottom: 1px solid var(--line); }
    nav a { color: var(--accent); text-decoration: none; font-size: 13px; padding: 4px 8px; border: 1px solid transparent; border-radius: 6px; }
    nav a:hover { border-color: var(--line); background: #fafafa; }
    main { max-width: 1180px; margin: 0 auto; padding: 24px; }
    .cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 14px; margin-bottom: 8px; }
    .card { display: block; background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 14px 16px; color: inherit; text-decoration: none; }
    .card:hover { border-color: var(--accent); }
    .card h3 { margin: 0 0 8px; font-size: 16px; }
    .card-metrics { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 8px; }
    .card-metrics span { font-size: 12px; color: var(--muted); border: 1px solid var(--line); border-radius: 6px; padding: 2px 6px; }
    .card-metrics .ok { color: var(--ok); }
    .card-metrics .warn { color: var(--warn); }
    .card p { margin: 0; color: var(--muted); font-size: 13px; line-height: 1.55; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
    section { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; margin: 16px 0; padding: 18px; }
    h2 { margin: 0 0 12px; font-size: 18px; }
    h2 small { color: var(--muted); font-weight: 400; font-size: 12px; margin-left: 6px; }
    h4 { margin: 14px 0 8px; font-size: 14px; }
    .group-summary { color: var(--muted); line-height: 1.6; margin: 10px 0 14px; }
    details.topic { border: 1px solid var(--line); border-radius: 8px; margin: 10px 0; background: #fff; }
    details.topic summary { cursor: pointer; padding: 11px 14px; display: flex; align-items: center; justify-content: space-between; gap: 10px; font-weight: 650; }
    details.topic summary strong { color: var(--accent); font-size: 12px; white-space: nowrap; }
    details.topic summary strong.imp-high { color: var(--risk); }
    details.topic summary strong.imp-medium { color: var(--warn); }
    details.topic summary strong.imp-low { color: var(--muted); }
    details.topic .topic-meta { padding: 0 14px 8px; color: var(--muted); font-size: 13px; line-height: 1.55; }
    details.topic h4 { margin: 8px 14px 0; }
    details.topic ul { margin: 6px 0 12px; padding: 0 14px; list-style: none; }
    details.topic li { border-top: 1px solid var(--line); padding: 7px 0; font-size: 13px; line-height: 1.5; }
    details.topic li:first-child { border-top: 0; }
    ul.evidence li { color: var(--muted); }
    ul.links { list-style: none; margin: 0; padding: 0; }
    ul.links li { border-top: 1px solid var(--line); padding: 7px 0; font-size: 13px; }
    ul.links li:first-child { border-top: 0; }
    time { color: var(--muted); font-size: 12px; margin-right: 8px; }
    .speaker { font-weight: 650; margin-right: 6px; }
    a { color: var(--accent); word-break: break-all; }
    .media-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(130px, 1fr)); gap: 10px; }
    figure { margin: 0; border: 1px solid var(--line); border-radius: 8px; overflow: hidden; background: #fafafa; }
    figure img, figure video { width: 100%; aspect-ratio: 1 / 1; object-fit: cover; display: block; background: #eee; }
    figcaption { padding: 5px 7px; color: var(--muted); font-size: 11px; line-height: 1.3; }
    .speakers { margin-top: 12px; color: var(--muted); font-size: 13px; }
    .risk-item strong { color: var(--risk); margin-right: 6px; }
    .action-item strong { margin-right: 6px; }
    .group-tag { color: var(--accent); font-size: 12px; margin-right: 6px; }
    section > ul { list-style: none; margin: 0; padding: 0; }
    section > ul > li { border-top: 1px solid var(--line); padding: 8px 0; font-size: 13px; line-height: 1.55; }
    section > ul > li:first-child { border-top: 0; }
    @media print { body { background: #fff; } nav { position: static; } main { max-width: none; padding: 12px; } section, details.topic { break-inside: avoid; } }
  </style>
</head>
<body>
  <header>
    <h1>QQ 多群摘要</h1>
    <div class="meta">
      ${renderChips([
        `${combined.firstMessageHkt ?? "无"} - ${combined.lastMessageHkt ?? "无"}`,
        `${groups.length} 个群`,
        `文本 ${combined.parsedTextMessages ?? 0}`,
        `媒体 ${combined.parsedMediaMessages ?? 0}`,
      ])}
    </div>
  </header>
  <nav>
    ${groups.map((group) => `<a href="#group-${escapeHtml(group.groupId)}">${escapeHtml(group.name)}</a>`).join("")}
  </nav>
  <main>
    ${scanWarningText(combined) !== null
      ? `<section style="border-color:var(--risk)"><h2 style="color:var(--risk)">⚠ 扫描不完整</h2><p>${escapeHtml(scanWarningText(combined))}</p></section>`
      : ""}
    <div class="cards">${renderOverviewCards(groups)}</div>
    <section>
      <h2>待处理事项（全部群）</h2>
      ${renderMergedList(
        actions,
        (item) =>
          `<span class="group-tag">[${escapeHtml(item.groupName)}]</span><strong class="action-item">${item.status === "resolved" ? "✅" : "⏳"} ${escapeHtml(item.owner ?? "未指定")}</strong>${escapeHtml(item.task)}${item.resolution ? `<br><time>结果: ${escapeHtml(item.resolution)}</time>` : ""}<br><time>证据: ${escapeHtml(item.evidence)}</time>`,
      )}
    </section>
    <section>
      <h2>风险点（全部群）</h2>
      ${renderMergedList(
        risks,
        (item) =>
          `<span class="group-tag">[${escapeHtml(item.groupName)}]</span><strong class="risk-item">${escapeHtml(item.severity)}</strong>${escapeHtml(item.risk)}<br><time>证据: ${escapeHtml(item.evidence)}</time>`,
      )}
    </section>
    ${groups.map(renderGroupSection).join("")}
  </main>
</body>
</html>`;

  fs.writeFileSync(htmlPath, html, "utf8");
  return htmlPath;
};

const writeDigestJson = (combined, groups, runDir) => {
  const digest = {
    isDigest: true,
    generatedAt: new Date().toISOString(),
    groupCount: groups.length,
    textMessages: combined.parsedTextMessages ?? 0,
    mediaMessages: combined.parsedMediaMessages ?? 0,
    llmGroups: groups.filter((group) => group.llm !== null).length,
    overview: groups.map((group) => `${group.name}: ${group.summaryLine}`).join("；"),
    groups: groups.map((group) => ({
      groupId: group.groupId,
      name: group.name,
      textMessages: group.textMessages,
      mediaMessages: group.mediaMessages,
      llmUsed: group.llm !== null,
      summary: group.summaryLine,
    })),
  };

  const digestPath = path.join(runDir, "analysis", "digest.json");
  fs.writeFileSync(digestPath, JSON.stringify(digest, null, 2), "utf8");
  return digestPath;
};

const main = () => {
  const args = parseArgs(process.argv);
  const combined = loadCombinedAnalysis(args.runDir);
  const manifest = loadManifest(args.runDir);
  const groupAnalyses = loadGroupAnalyses(args.runDir);
  if (groupAnalyses.length === 0) {
    throw new Error(`No per-group analyses were found under ${path.join(args.runDir, "analysis", "groups")}`);
  }

  const groups = groupAnalyses
    .map(({ groupId, analysis }) => buildGroupView(groupId, analysis, manifest))
    .sort((left, right) => right.textMessages - left.textMessages);

  writeMarkdown(combined, groups, args.outputMarkdown);
  const htmlPath = writeHtml(combined, groups, args.outputMarkdown);
  const digestPath = writeDigestJson(combined, groups, args.runDir);
  console.log(`htmlPath=${htmlPath}`);
  console.log(`digestPath=${digestPath}`);
};

main();
