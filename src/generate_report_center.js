const fs = require("node:fs");
const path = require("node:path");
const { readJson, escapeHtml, fileUrl, formatBytes } = require("./report_utils");
const { dirSize, collectRuns } = require("./run_index");

const parseArgs = (argv) => {
  if (argv.length !== 4) {
    throw new Error("Usage: node generate_report_center.js <configJson> <outputHtml>");
  }

  return {
    configJson: argv[2],
    outputHtml: argv[3],
  };
};

const sumBy = (items, getValue) => items.reduce((total, item) => total + getValue(item), 0);

const renderActionLink = (enabled, href, label) => {
  if (!enabled) {
    return `<span class="button disabled">${escapeHtml(label)}</span>`;
  }

  return `<a class="button" href="${escapeHtml(fileUrl(href))}">${escapeHtml(label)}</a>`;
};

const renderRows = (runs) =>
  runs
    .map(
      (run) => `
        <tr data-search="${escapeHtml(`${run.groups} ${run.summary} ${run.runId}`.toLowerCase())}" data-llm="${escapeHtml(run.llmStatus)}" data-media="${run.hasMedia ? "yes" : "no"}">
          <td>
            <strong>${escapeHtml(run.firstMessageHkt)} - ${escapeHtml(run.lastMessageHkt)}</strong>
            <span>${escapeHtml(run.runId)}</span>
          </td>
          <td>
            <strong>${run.isDigest ? '<em class="badge">多群</em> ' : ""}${escapeHtml(run.groups)}</strong>
            <span>${escapeHtml(run.summary)}</span>
          </td>
          <td class="number">${escapeHtml(run.textMessages)}</td>
          <td>
            <strong>${escapeHtml(run.copiedMedia)}/${escapeHtml(run.mediaRefs)}</strong>
            <span>${escapeHtml(run.missingMedia)} missing, ${escapeHtml(run.urlOnlyMedia)} URL</span>
          </td>
          <td>
            <strong>${escapeHtml(formatBytes(run.runBytes))}</strong>
            <span>media ${escapeHtml(formatBytes(run.mediaBytes))}${run.hasCleanDb ? `, clean-db ${escapeHtml(formatBytes(run.cleanDbBytes))}` : ""}</span>
          </td>
          <td>
            <span class="status ${escapeHtml(run.llmStatus)}">${run.llmStatus === "done" ? "LLM done" : "Local only"}</span>
            <span>${escapeHtml(run.llmModel || "No model")}</span>
          </td>
          <td class="actions">
            ${renderActionLink(run.hasReportHtml, run.reportHtml, "HTML")}
            ${renderActionLink(run.hasMedia, run.mediaDir, "Media")}
            ${renderActionLink(true, run.runDir, "Folder")}
          </td>
        </tr>`,
    )
    .join("");

const latestRun = (runs) => runs[0] ?? null;

const renderLatest = (run) => {
  if (run === null) {
    return "<p>No reports yet.</p>";
  }

  return `
    <h3>${escapeHtml(run.groups)}</h3>
    <p>${escapeHtml(run.firstMessageHkt)} - ${escapeHtml(run.lastMessageHkt)}</p>
    <p>${escapeHtml(run.summary)}</p>
    <div class="metric-row">
      <span>${escapeHtml(run.textMessages)} text</span>
      <span>${escapeHtml(run.copiedMedia)}/${escapeHtml(run.mediaRefs)} media</span>
      <span>${escapeHtml(formatBytes(run.runBytes))}</span>
    </div>
    <div class="latest-actions">
      ${renderActionLink(run.hasReportHtml, run.reportHtml, "Open HTML")}
      ${renderActionLink(run.hasMedia, run.mediaDir, "Open Media")}
    </div>`;
};

const writeHtml = (runs, config, outputHtml) => {
  const latest = latestRun(runs);
  const totalBytes = sumBy(runs, (run) => run.runBytes);
  const mediaBytes = sumBy(runs, (run) => run.mediaBytes);
  const cleanDbBytes = sumBy(runs, (run) => run.cleanDbBytes);
  const reportBytes = dirSize(config.reportsDir);
  const html = `<!doctype html>
<html lang="zh-Hans">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>QQ 报告中心</title>
  <style>
    :root { color-scheme: light; --bg: #f5f7fa; --panel: #fff; --text: #17202a; --muted: #667085; --line: #d8dee8; --accent: #2563eb; --ok: #0f9f6e; --warn: #c27803; }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: "Segoe UI", "Microsoft YaHei", Arial, sans-serif; background: var(--bg); color: var(--text); }
    header { height: 64px; display: flex; align-items: center; justify-content: space-between; padding: 0 24px; background: var(--panel); border-bottom: 1px solid var(--line); }
    h1 { margin: 0; font-size: 24px; letter-spacing: 0; }
    header span { color: var(--muted); font-size: 13px; }
    main { display: grid; grid-template-columns: minmax(0, 1fr) 340px; gap: 16px; padding: 16px; }
    section { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; }
    .reports { overflow: hidden; }
    .toolbar { display: flex; align-items: center; gap: 10px; padding: 14px 16px; border-bottom: 1px solid var(--line); }
    .toolbar h2 { margin: 0; font-size: 18px; flex: 1; }
    input, select { height: 34px; border: 1px solid var(--line); border-radius: 6px; padding: 0 10px; font: inherit; font-size: 13px; background: #fff; }
    table { width: 100%; border-collapse: collapse; table-layout: fixed; }
    th, td { border-bottom: 1px solid var(--line); padding: 12px 12px; text-align: left; vertical-align: top; font-size: 13px; }
    th { color: var(--muted); font-weight: 650; background: #fafbfc; }
    td strong { display: block; font-weight: 650; }
    td span { display: block; margin-top: 4px; color: var(--muted); line-height: 1.35; word-break: break-word; }
    .number { font-variant-numeric: tabular-nums; }
    .status { color: var(--muted); }
    .status.done { color: var(--ok); }
    .status.not-used { color: var(--warn); }
    .badge { display: inline-block; font-style: normal; font-size: 11px; color: var(--accent); border: 1px solid var(--accent); border-radius: 4px; padding: 0 4px; margin-right: 4px; vertical-align: 1px; }
    .actions { display: flex; gap: 6px; flex-wrap: wrap; }
    .button { display: inline-flex; align-items: center; justify-content: center; min-width: 58px; height: 30px; padding: 0 10px; border: 1px solid var(--line); border-radius: 6px; color: var(--text); text-decoration: none; background: #fff; font-size: 12px; }
    .button:hover { border-color: var(--accent); color: var(--accent); }
    .button.disabled { opacity: .45; pointer-events: none; }
    aside { display: flex; flex-direction: column; gap: 16px; }
    .panel { padding: 16px; }
    h2, h3 { letter-spacing: 0; }
    .panel h2 { margin: 0 0 12px; font-size: 17px; }
    .panel h3 { margin: 0 0 8px; font-size: 16px; }
    .big { font-size: 30px; color: var(--accent); font-weight: 750; margin: 8px 0; }
    .metric-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px; margin-top: 12px; }
    .metric { border-top: 1px solid var(--line); padding-top: 10px; }
    .metric span { display: block; color: var(--muted); font-size: 12px; }
    .metric strong { display: block; margin-top: 4px; }
    .metric-row { display: flex; gap: 8px; flex-wrap: wrap; margin: 12px 0; }
    .metric-row span { border: 1px solid var(--line); border-radius: 6px; padding: 4px 8px; color: var(--muted); font-size: 12px; }
    .latest-actions { display: flex; gap: 8px; margin-top: 12px; }
    .path { font-family: Consolas, monospace; font-size: 12px; color: var(--muted); word-break: break-all; }
    @media (max-width: 1100px) { main { grid-template-columns: 1fr; } }
    @media (max-width: 760px) { header { align-items: flex-start; height: auto; padding: 14px; flex-direction: column; gap: 4px; } .toolbar { flex-wrap: wrap; } table { min-width: 980px; } .reports { overflow-x: auto; } }
  </style>
</head>
<body>
  <header>
    <h1>QQ 报告中心</h1>
    <span>Generated ${escapeHtml(new Date().toLocaleString("sv-SE", { timeZone: "Asia/Hong_Kong" }))}</span>
  </header>
  <main>
    <section class="reports">
      <div class="toolbar">
        <h2>最近报告</h2>
        <input id="search" type="search" placeholder="搜索群名、摘要、run id">
        <select id="llm-filter">
          <option value="all">全部 LLM 状态</option>
          <option value="done">LLM done</option>
          <option value="not-used">Local only</option>
        </select>
        <select id="media-filter">
          <option value="all">全部媒体</option>
          <option value="yes">有媒体目录</option>
          <option value="no">无媒体目录</option>
        </select>
      </div>
      <table>
        <thead>
          <tr>
            <th style="width: 210px;">时间范围</th>
            <th>群和摘要</th>
            <th style="width: 90px;">文本</th>
            <th style="width: 140px;">媒体</th>
            <th style="width: 150px;">占用</th>
            <th style="width: 120px;">LLM</th>
            <th style="width: 190px;">操作</th>
          </tr>
        </thead>
        <tbody id="report-rows">${renderRows(runs)}</tbody>
      </table>
    </section>
    <aside>
      <section class="panel">
        <h2>存储使用</h2>
        <div class="big">${escapeHtml(formatBytes(totalBytes))}</div>
        <div class="metric-grid">
          <div class="metric"><span>媒体文件</span><strong>${escapeHtml(formatBytes(mediaBytes))}</strong></div>
          <div class="metric"><span>报告文件</span><strong>${escapeHtml(formatBytes(reportBytes))}</strong></div>
          <div class="metric"><span>临时 clean-db</span><strong>${escapeHtml(formatBytes(cleanDbBytes))}</strong></div>
          <div class="metric"><span>报告数量</span><strong>${escapeHtml(runs.length)}</strong></div>
        </div>
      </section>
      <section class="panel">
        <h2>最新报告</h2>
        ${renderLatest(latest)}
      </section>
      <section class="panel">
        <h2>清理建议</h2>
        <p>默认新任务会清理 clean-db。旧任务可双击清理按钮移除临时数据库副本。</p>
        <p class="path">QQ清理生成数据.cmd</p>
      </section>
    </aside>
  </main>
  <script>
    const search = document.getElementById("search");
    const llmFilter = document.getElementById("llm-filter");
    const mediaFilter = document.getElementById("media-filter");
    const rows = [...document.querySelectorAll("#report-rows tr")];
    const applyFilters = () => {
      const q = search.value.trim().toLowerCase();
      const llm = llmFilter.value;
      const media = mediaFilter.value;
      for (const row of rows) {
        const matchesSearch = q.length === 0 || row.dataset.search.includes(q);
        const matchesLlm = llm === "all" || row.dataset.llm === llm;
        const matchesMedia = media === "all" || row.dataset.media === media;
        row.hidden = !(matchesSearch && matchesLlm && matchesMedia);
      }
    };
    search.addEventListener("input", applyFilters);
    llmFilter.addEventListener("change", applyFilters);
    mediaFilter.addEventListener("change", applyFilters);
  </script>
</body>
</html>`;

  fs.mkdirSync(path.dirname(outputHtml), { recursive: true });
  fs.writeFileSync(outputHtml, html, "utf8");
};

const main = () => {
  const args = parseArgs(process.argv);
  const config = readJson(args.configJson);
  const runs = collectRuns(config.runsDir, config.reportsDir);
  writeHtml(runs, config, args.outputHtml);
  console.log(`reportCenter=${args.outputHtml}`);
};

main();
