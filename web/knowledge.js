"use strict";

/* ---------- knowledge base (prompt / model / lora library) ---------- */

const KNOWLEDGE_SURFACES = new Set(["images", "requests", "coverage"]);
const KNOWLEDGE_PAGE_SIZE = 60;
const PROMPT_CLAMP_CHARS = 320;
const LAST_VISIT_KEY = "cc-knowledge-last-visit";

const GENERATOR_LABELS = {
  webui: "A1111",
  forge: "Forge",
  reforge: "reForge",
  comfyui: "ComfyUI",
  nai: "NovelAI",
  stripped: "未检测到生成参数",
  unknown: "未知",
};

// Only "high" and "medium" targets are stated as fact; below that the UI says so.
const CONFIDENCE_LABELS = {
  high: { text: "引用确认", tone: "ok" },
  medium: { text: "作者相符", tone: "ok" },
  low: { text: "推测，可能不准", tone: "warn" },
  none: { text: "未能定位图片", tone: "muted" },
};

const INTENT_LABELS = { prompt: "要咒语", original: "要原图" };

// Each reason is phrased as "what happened + what you can do", because the
// unhelpful version of this message ("可能是你自己生成或私聊收到的") made a
// coverage gap look like an unknowable property of the image.
const REASON_TEXT = {
  attributed: null,
  evicted: "QQ 缓存中的原图现在已不存在，参数还留着",
  unavailable: "本地没有原图副本，可能从未下载过原图",
  "outside-coverage": "这张图的时间不在已总结的范围内 —— 补跑那段时间就能对上发图人",
  "not-in-messages": "那段时间已扫过，但群里没出现这张图（你自己生成 / 私聊 / 收藏）",
};

const replaceKnowledgeTab = (patch) => {
  app.knowledgeTab = { ...app.knowledgeTab, ...patch };
};

// Cards request QQ's reduced copy; the detail view asks for the original. Serving
// originals to the grid cost ~14 MB of decoded bitmap per card.
const knowledgeFileUrl = (hash) => `/knowledge-file?hash=${encodeURIComponent(hash)}`;
const knowledgeThumbUrl = (hash) => `/knowledge-file?hash=${encodeURIComponent(hash)}&thumb=1`;

const SORT_LABELS = {
  recent: "最近的在前",
  oldest: "最早的在前",
  asked: "被求咒语最多",
  loras: "LoRA 最多",
  largest: "文件最大",
  promptLength: "咒语最长",
};

// Documented syntax, kept in sync with the parser by a test.
const SYNTAX_HELP = [
  ["1girl solo", "自由文字（咒语 / 模型 / LoRA）"],
  ["tag:1girl", "必须含这个标签"],
  ["-tag:nsfw", "排除这个标签"],
  ['prompt:"long hair"', "含空格的值加引号"],
  ["model:anima", "指定模型（可只写一部分）"],
  ["lora:darklight", "指定 LoRA"],
  ["sender:Caesar", "只看某人发的图"],
  ["generator:nai", "webui / forge / comfyui / nai"],
  ["steps>=30", "数字比较：steps / cfg / width / height"],
  ["steps:20..40", "数字范围"],
  ["aspect:portrait", "square / landscape / portrait"],
  ["date:2026-07-01..2026-07-31", "按图片时间"],
  ["has:answer", "已有文字或媒体回复"],
  ["no:file", "本地没有可用原图"],
];

// Times must match the rest of the app, which renders everything in fixed
// Asia/Hong_Kong regardless of the machine's zone (see unixToHkt in app.js).
// Using browser-local time here would disagree with the reports and media pages.
const formatUnix = (unixSeconds) => {
  if (!Number.isFinite(unixSeconds) || unixSeconds <= 0) {
    return "";
  }
  return unixToHkt(unixSeconds).slice(0, 16);
};

const generatorLabel = (generator) => GENERATOR_LABELS[generator] ?? generator;

/* ---------- data loading ---------- */

const loadKnowledgeOverview = async () => {
  try {
    replaceKnowledgeTab({ overview: await api("/api/knowledge/overview") });
  } catch (error) {
    // Recorded AND rendered by the caller: a silent failure here used to leave
    // the whole page blank with no explanation.
    replaceKnowledgeTab({ error: `读取咒语库信息失败：${error.message}` });
  }
};

// requestId guards against an earlier, slower search overwriting a later one.
// `append` adds a page instead of replacing, which is how the library beyond the
// first 60 images is reachable at all.
const loadKnowledgeResults = async ({ append = false } = {}) => {
  const requestId = app.knowledgeTab.requestId + 1;
  const offset = append ? (app.knowledgeTab.results?.items.length ?? 0) : 0;
  replaceKnowledgeTab({
    requestId,
    loading: true,
    loadingMore: append,
    error: null,
    ...(append ? {} : { results: null }),
  });
  if (append) {
    renderKnowledgeView();
  }

  const params = new URLSearchParams({
    q: app.knowledgeTab.query,
    generator: app.knowledgeTab.generator,
    groupId: app.knowledgeTab.groupId,
    sender: app.knowledgeTab.sender,
    sort: app.knowledgeTab.sort,
    limit: String(KNOWLEDGE_PAGE_SIZE),
    offset: String(offset),
  });
  try {
    const page = await api(`/api/knowledge/search?${params.toString()}`);
    if (app.knowledgeTab.requestId !== requestId) {
      return;
    }
    const previous = append ? (app.knowledgeTab.results?.items ?? []) : [];
    // Dedupe on append: a harvest running concurrently can shift the window and
    // re-serve a row, which would otherwise render twice.
    const seen = new Set(previous.map((item) => item.hash));
    const merged = [...previous, ...page.items.filter((item) => !seen.has(item.hash))];
    replaceKnowledgeTab({
      results: { ...page, items: merged },
      loading: false,
      loadingMore: false,
    });
  } catch (error) {
    if (app.knowledgeTab.requestId !== requestId) {
      return;
    }
    replaceKnowledgeTab({ loading: false, loadingMore: false, error: error.message });
  }
  renderKnowledgeView();
};

const loadKnowledgeRequests = async () => {
  replaceKnowledgeTab({ loading: true, error: null });
  try {
    const requests = await api("/api/knowledge/requests?limit=200");
    replaceKnowledgeTab({ requests, loading: false });
  } catch (error) {
    replaceKnowledgeTab({ loading: false, error: error.message });
  }
  renderKnowledgeView();
};

// The watermark is stored only when the page is actually opened, so "new" means
// "since you last looked at this page" rather than "since the app started".
const readLastVisit = () => {
  const stored = Number.parseInt(localStorage.getItem(LAST_VISIT_KEY) ?? "0", 10);
  return Number.isFinite(stored) && stored > 0 ? stored : 0;
};

const loadKnowledgeCoverage = async () => {
  replaceKnowledgeTab({ loading: true, error: null });
  try {
    const coverage = await api(`/api/knowledge/coverage?since=${readLastVisit()}`);
    replaceKnowledgeTab({ coverage, loading: false });
    if (coverage.watermark > 0) {
      localStorage.setItem(LAST_VISIT_KEY, String(coverage.watermark));
    }
  } catch (error) {
    replaceKnowledgeTab({ loading: false, error: error.message });
  }
  renderKnowledgeView();
};

const ensureKnowledgeLoaded = async () => {
  // Paint FIRST, then fetch. Awaiting before the first render left the page
  // completely blank while loading, and permanently blank if a request failed --
  // there was no frame in which the error could be shown.
  renderKnowledgeView();

  if (app.knowledgeTab.overview === null) {
    await loadKnowledgeOverview();
    renderKnowledgeView();
  }
  if (app.knowledgeTab.surface === "images" && app.knowledgeTab.results === null) {
    await loadKnowledgeResults();
    return;
  }
  if (app.knowledgeTab.surface === "requests" && app.knowledgeTab.requests === null) {
    await loadKnowledgeRequests();
    return;
  }
  if (app.knowledgeTab.surface === "coverage" && app.knowledgeTab.coverage === null) {
    await loadKnowledgeCoverage();
    return;
  }
  renderKnowledgeView();
};

/* ---------- shared bits ---------- */

const copyToClipboard = async (text, label) => {
  try {
    await navigator.clipboard.writeText(text);
    alert(`${label}已复制`);
  } catch {
    alert("复制失败，请手动选取文本。");
  }
};

const promptBlock = (text, label, { truncated = false } = {}) => {
  if (typeof text !== "string" || text.trim().length === 0) {
    return null;
  }
  const clamped = truncated || text.length > PROMPT_CLAMP_CHARS;
  const shown = text.length > PROMPT_CLAMP_CHARS ? `${text.slice(0, PROMPT_CLAMP_CHARS)}…` : text;
  return el("div", { class: "kb-prompt" },
    el("div", { class: "kb-prompt-head" },
      el("span", { class: "kb-prompt-label" }, label),
      // A clamped card cannot offer a correct copy, so it says where to get one
      // rather than silently copying a partial prompt.
      truncated
        ? el("span", { class: "kb-meta" }, "点图看完整")
        : el("button", {
          class: "btn small",
          onclick: () => copyToClipboard(text, label),
        }, "复制")),
    el("p", { class: clamped ? "kb-prompt-text clamped" : "kb-prompt-text" }, shown));
};

const confidenceBadge = (confidence) => {
  const meta = CONFIDENCE_LABELS[confidence] ?? CONFIDENCE_LABELS.none;
  return el("span", { class: `kb-badge ${meta.tone}` }, meta.text);
};

const unavailableImageText = (fileMissing) => fileMissing
  ? "缓存原图已不存在"
  : "本地没有原图副本";

const requestIsAnswered = (row) => row.answerKind === "text" || row.answerKind === "media";

const requestAnswer = (row) => {
  if (row.answerKind === "text") {
    return promptBlock(row.answerText, `${row.answerBy} 的咒语回复`);
  }
  if (row.answerKind !== "media") {
    return null;
  }
  const media = row.answerMedia ?? [];
  return el("div", { class: "kb-answer" },
    el("span", { class: "kb-prompt-label" }, `${row.answerBy} 回复了 ${media.length} 个图片或文件`),
    el("div", { class: "kb-answer-media" }, media.map((item) => {
      const label = item.fileName || item.hash || (item.kind === "image" ? "图片" : "文件");
      return item.kind === "image" && item.hash !== null && item.hasFile
        ? el("a", {
          class: "kb-answer-image",
          href: knowledgeFileUrl(item.hash),
          target: "_blank",
          rel: "noreferrer",
          title: label,
        }, el("img", { src: knowledgeThumbUrl(item.hash), alt: label, loading: "lazy", decoding: "async" }))
        : el("div", { class: "kb-answer-file", title: label },
          el("span", {}, item.kind === "image" ? "图片" : "文件"),
          el("strong", {}, label),
          item.kind === "image" ? el("small", {}, "本地没有可预览副本") : null);
    })));
};

// List responses carry a clamped prompt to keep large result sets small, so the
// detail view fetches the full record. The clamped copy is shown immediately so
// the panel never appears empty while the request is in flight.
const openDetail = async (item) => {
  replaceKnowledgeTab({ detail: item, detailLoading: true });
  renderKnowledgeView();
  try {
    const full = await api(`/api/knowledge/image?hash=${encodeURIComponent(item.hash)}`);
    // Ignore a late response for an image the user has already navigated away from.
    if (app.knowledgeTab.detail?.hash !== item.hash) {
      return;
    }
    replaceKnowledgeTab({ detail: full, detailLoading: false });
  } catch {
    // The clamped version is still useful; just stop showing a spinner.
    replaceKnowledgeTab({ detailLoading: false });
  }
  renderKnowledgeView();
};

const thumbnail = (item) => {
  if (!item.hasFile) {
    return el("div", { class: "kb-thumb missing" },
      el("span", {}, "?"),
      el("small", {}, unavailableImageText(item.fileMissing)));
  }
  return el("img", {
    class: "kb-thumb",
    src: knowledgeThumbUrl(item.hash),
    loading: "lazy",
    decoding: "async",
    alt: item.prompt.slice(0, 60) || item.hash,
    onclick: () => openDetail(item),
  });
};

/* ---------- images surface ---------- */

const paramChips = (item) => {
  const params = item.params ?? {};
  const chips = [
    params.steps === undefined ? null : `steps ${params.steps}`,
    params.cfgScale === undefined ? null : `cfg ${params.cfgScale}`,
    params.sampler === undefined ? null : String(params.sampler),
    params.scheduler === undefined ? null : String(params.scheduler),
    params.seed === undefined ? null : `seed ${params.seed}`,
    item.width > 0 ? `${item.width}×${item.height}` : null,
  ].filter((chip) => chip !== null);
  return chips.map((chip) => el("span", { class: "kb-chip" }, chip));
};

// Narrowing by clicking what you see, rather than retyping it. Implemented as a
// query mutation so the visible search box always reflects the active filter.
const filterBy = (expression) => () => {
  replaceKnowledgeTab({ query: expression, detail: null });
  loadKnowledgeResults();
};

const quoteIfNeeded = (value) => (/\s/u.test(value) ? `"${value}"` : value);

// A checkbox overlaid on the thumbnail, so picking specific images for export
// never requires leaving the grid.
const selectionBox = (item) => {
  const picked = app.knowledgeTab.selected.has(item.hash);
  return el("label", {
    class: picked ? "kb-pick picked" : "kb-pick",
    title: "选中以便只导出这些",
    onclick: (event) => event.stopPropagation(),
  },
  el("input", {
    type: "checkbox",
    checked: picked,
    onchange: (event) => {
      // A Set is mutated in place here rather than copied: the alternative is
      // rebuilding a 7,000-entry set on every click.
      if (event.target.checked) {
        app.knowledgeTab.selected.add(item.hash);
      } else {
        app.knowledgeTab.selected.delete(item.hash);
      }
      renderKnowledgeView();
    },
  }));
};

const imageCard = (item) => {
  const seen = item.sightings[0];
  const asks = item.promptRequests ?? [];
  return el("article", { class: "kb-card", "data-testid": "kb-card" },
    el("div", { class: "kb-thumb-wrap" }, thumbnail(item), selectionBox(item)),
    el("div", { class: "kb-card-body" },
      el("div", { class: "kb-card-head" },
        el("span", { class: "kb-badge" }, generatorLabel(item.generator)),
        item.checkpoint === ""
          ? null
          : el("button", {
            class: "kb-model kb-linkish",
            title: "只看这个模型",
            onclick: filterBy(`model:${quoteIfNeeded(item.checkpoint)}`),
          }, item.checkpoint),
        asks.length > 0
          ? el("span", { class: "kb-badge ok" }, `${asks.length} 人求过`)
          : null),
      item.isPlaceholder
        ? el("p", { class: "kb-note" }, "本地副本中没有可解析的 AI 生成参数；下面的咒语来自群里的回复。")
        : promptBlock(item.prompt, "咒语", { truncated: item.promptTruncated }),
      item.loras.length === 0
        ? null
        : el("div", { class: "kb-loras" },
          el("span", { class: "kb-prompt-label" }, `LoRA ×${item.loras.length}`),
          el("div", { class: "kb-chip-row" },
            item.loras.slice(0, 6).map((lora) =>
              el("button", {
                class: "kb-chip clickable",
                title: "只看用了这个 LoRA 的图",
                onclick: filterBy(`lora:${quoteIfNeeded(lora.name)}`),
              }, lora.weight === null ? lora.name : `${lora.name} @${lora.weight}`)),
            item.loras.length > 6 ? el("span", { class: "kb-chip" }, `+${item.loras.length - 6}`) : null)),
      el("div", { class: "kb-chip-row" }, paramChips(item)),
      asks.map(requestAnswer),
      seen === undefined
        ? el("p", { class: "kb-meta muted" }, REASON_TEXT[item.attributionReason] ?? "没有群消息记录")
        : el("p", { class: "kb-meta" },
          el("button", {
            class: "kb-linkish",
            title: "只看这个人发的图",
            onclick: filterBy(`sender:${quoteIfNeeded(seen.speaker)}`),
          }, seen.speaker),
          ` · ${seen.groupName || seen.groupId} · ${formatUnix(seen.sentAt)}`)));
};

// Shows how the query was understood, straight from the server's own parse.
// Without this an operator grammar is undiscoverable: a user cannot tell a typo
// from "no results", and warnings would be invisible.
const searchPreview = () => {
  const parsed = app.knowledgeTab.results?.parsed;
  if (parsed === null || parsed === undefined) {
    return null;
  }
  if (parsed.parts.length === 0 && parsed.warnings.length === 0) {
    return null;
  }
  return el("div", { class: "kb-preview" },
    parsed.parts.length === 0 ? null : el("span", { class: "kb-prompt-label" }, "理解为"),
    parsed.parts.map((part) =>
      el("span", { class: `kb-preview-chip ${part.kind === "exclude" ? "exclude" : ""}` }, part.text)),
    parsed.warnings.map((warning) =>
      el("span", { class: "kb-preview-chip warn", title: warning.reason }, `⚠ ${warning.raw} — ${warning.reason}`)));
};

const syntaxHelpPanel = () => {
  if (!app.knowledgeTab.showHelp) {
    return null;
  }
  return el("div", { class: "kb-help" },
    SYNTAX_HELP.map(([syntax, meaning]) =>
      el("div", { class: "kb-help-row" },
        el("code", {
          class: "kb-help-syntax",
          title: "点击填入搜索框",
          onclick: () => {
            replaceKnowledgeTab({ query: syntax });
            loadKnowledgeResults();
          },
        }, syntax),
        el("span", { class: "kb-meta" }, meaning))));
};

// The request body shared by preview and export, so the estimate can never
// describe a different set from what actually gets written.
const exportRequestBody = () => {
  const selectedOnly = app.knowledgeTab.exportScope === "selected";
  return {
    query: app.knowledgeTab.query,
    generator: app.knowledgeTab.generator,
    groupId: app.knowledgeTab.groupId,
    sender: app.knowledgeTab.sender,
    sort: app.knowledgeTab.sort,
    mode: app.knowledgeTab.exportMode,
    hashes: selectedOnly ? [...app.knowledgeTab.selected] : null,
    label: app.knowledgeTab.exportLabel.trim(),
    includeImages: app.knowledgeTab.exportImages,
    includeSidecars: app.knowledgeTab.exportSidecars,
    includeIndex: app.knowledgeTab.exportIndex,
    verifyHash: app.knowledgeTab.exportVerify,
  };
};

const loadExportPreview = async () => {
  const body = exportRequestBody();
  const params = new URLSearchParams({
    q: body.query,
    generator: body.generator,
    groupId: body.groupId,
    sender: body.sender,
    sort: body.sort,
    mode: body.mode,
  });
  if (body.hashes !== null) {
    params.set("hashes", body.hashes.join(","));
  }
  try {
    replaceKnowledgeTab({ exportPreview: await api(`/api/knowledge/export-preview?${params.toString()}`) });
  } catch (error) {
    replaceKnowledgeTab({ error: error.message });
  }
  renderKnowledgeView();
};

const runExport = async () => {
  replaceKnowledgeTab({ exporting: true, exportResult: null });
  renderKnowledgeView();
  try {
    const result = await api("/api/knowledge/export", {
      method: "POST",
      body: JSON.stringify(exportRequestBody()),
    });
    replaceKnowledgeTab({ exporting: false, exportResult: result, exportPreview: null });
  } catch (error) {
    replaceKnowledgeTab({ exporting: false, error: error.message });
  }
  renderKnowledgeView();
};

const exportPanel = () => {
  if (!app.knowledgeTab.showExport) {
    return null;
  }
  const preview = app.knowledgeTab.exportPreview;
  const result = app.knowledgeTab.exportResult;
  const selectedCount = app.knowledgeTab.selected.size;
  const scope = app.knowledgeTab.exportScope;

  const scopeRadio = (value, label, hint) =>
    el("label", { class: "kb-inline-label", title: hint },
      el("input", {
        type: "radio",
        name: "kb-export-scope",
        checked: scope === value,
        disabled: value === "selected" && selectedCount === 0,
        onchange: () => {
          replaceKnowledgeTab({ exportScope: value, exportPreview: null });
          loadExportPreview();
        },
      }),
      label);

  const checkbox = (key, label, hint) =>
    el("label", { class: "kb-inline-label", title: hint ?? "" },
      el("input", {
        type: "checkbox",
        checked: app.knowledgeTab[key],
        onchange: (event) => {
          replaceKnowledgeTab({ [key]: event.target.checked });
          renderKnowledgeView();
        },
      }),
      label);

  return el("div", { class: "kb-export" },
    el("div", { class: "kb-export-section" },
      el("span", { class: "kb-prompt-label" }, "导出范围"),
      el("div", { class: "kb-control-row" },
        scopeRadio("filtered", "当前筛选的全部", "包括还没滚动到的那些"),
        scopeRadio("selected", selectedCount > 0 ? `已勾选的 ${selectedCount} 张` : "已勾选的（先勾选图片）", "在图片右上角勾选"))),

    el("div", { class: "kb-export-section" },
      el("span", { class: "kb-prompt-label" }, "已导出过的图片"),
      el("div", { class: "kb-control-row" },
        el("label", { class: "kb-inline-label" },
          el("input", {
            type: "radio",
            name: "kb-export-mode",
            checked: app.knowledgeTab.exportMode === "new",
            onchange: () => {
              replaceKnowledgeTab({ exportMode: "new", exportPreview: null });
              loadExportPreview();
            },
          }),
          "跳过"),
        el("label", { class: "kb-inline-label" },
          el("input", {
            type: "radio",
            name: "kb-export-mode",
            checked: app.knowledgeTab.exportMode === "all",
            onchange: () => {
              replaceKnowledgeTab({ exportMode: "all", exportPreview: null });
              loadExportPreview();
            },
          }),
          "也重新导出"))),

    el("div", { class: "kb-export-section" },
      el("span", { class: "kb-prompt-label" }, "导出内容"),
      el("div", { class: "kb-control-row" },
        checkbox("exportImages", "图片文件"),
        checkbox("exportSidecars", "同名 .txt 咒语", "kohya / sd-scripts 等训练工具通用"),
        checkbox("exportIndex", "index.jsonl + index.csv"),
        checkbox("exportVerify", "校验图片内容", "比对 md5，防止缓存槽被复用导致图文不符；会慢一些"))),

    el("div", { class: "kb-export-section" },
      el("span", { class: "kb-prompt-label" }, "文件夹名（可留空）"),
      el("div", { class: "kb-control-row" },
        el("input", {
          type: "text",
          class: "kb-search",
          placeholder: "例如 anima-portrait",
          value: app.knowledgeTab.exportLabel,
          oninput: (event) => replaceKnowledgeTab({ exportLabel: event.target.value }),
        })),
      el("p", { class: "kb-meta" },
        "会导出到 ",
        el("code", { class: "kb-help-syntax" }, "reports\\prompt-export-<名字>-<时间>\\"),
        " —— 导出完成后会显示完整路径。")),

    preview === null || preview === undefined
      ? null
      : el("p", { class: "kb-meta" },
        `本次范围 ${preview.matched} 张：会导出 ${preview.fresh} 张`,
        preview.already > 0 ? `，跳过 ${preview.already} 张（之前导过）` : "",
        `。累计已导出 ${preview.ledgerSize} 张。`),

    el("div", { class: "kb-control-row" },
      el("button", {
        class: "btn primary",
        disabled: app.knowledgeTab.exporting || (scope === "selected" && selectedCount === 0),
        onclick: runExport,
      }, app.knowledgeTab.exporting ? "导出中…" : "开始导出"),
      el("button", { class: "btn small", onclick: loadExportPreview }, "重新估算"),
      el("button", {
        class: "btn small",
        title: "清空导出记录后，所有图片会被视为没导过",
        onclick: async () => {
          if (!confirm("清空导出记录？之后所有图片都会被当成没导过。")) {
            return;
          }
          try {
            await api("/api/knowledge/forget-exports", { method: "POST", body: JSON.stringify({}) });
            replaceKnowledgeTab({ exportPreview: null, exportResult: null });
            loadExportPreview();
          } catch (error) {
            replaceKnowledgeTab({ error: error.message });
            renderKnowledgeView();
          }
        },
      }, "清空导出记录")),

    result === null || result === undefined
      ? null
      : el("div", { class: "kb-export-result" },
        el("p", { class: "kb-meta" },
          `导出完成：${result.exported} 张`,
          result.skipped > 0 ? `，跳过 ${result.skipped} 张（之前导过）` : "",
          result.missingFile > 0 ? `，${result.missingFile} 张没有可导出的本地原图` : "",
          result.failed > 0 ? `，${result.failed} 张失败` : "",
          "。"),
        // The real path, and an honest statement about whether it opened.
        el("p", { class: "kb-meta" },
          el("strong", {}, "位置："),
          el("code", { class: "kb-help-syntax", title: "点击复制", onclick: () => copyToClipboard(result.outputDir, "路径") }, result.outputDir)),
        result.folderOpened
          ? el("p", { class: "kb-meta" }, "已在文件资源管理器中打开。")
          : el("p", { class: "kb-meta" },
            result.openError === null || result.openError === undefined
              ? "（没有自动打开文件夹，可复制上面的路径。）"
              : `没能自动打开文件夹：${result.openError}`),
        result.notes.length === 0
          ? null
          : el("details", {},
            el("summary", { class: "kb-meta" }, `${result.notes.length} 条说明`),
            el("ul", { class: "kb-sightings" }, result.notes.map((note) => el("li", {}, note))))));
};

const DENSITY_KEY = "cc-knowledge-density";
const DENSITIES = new Set(["detail", "compact"]);

// Detail shows the prompt on the card; compact is a thumbnail wall for scanning
// a large result set. Persisted because it is a lasting preference, not a
// per-search choice.
const densityToggle = () => {
  const button = (value, label) =>
    el("button", {
      class: app.knowledgeTab.density === value ? "btn small active" : "btn small",
      onclick: () => {
        replaceKnowledgeTab({ density: value });
        localStorage.setItem(DENSITY_KEY, value);
        renderKnowledgeView();
      },
    }, label);
  return el("div", { class: "kb-density" }, button("detail", "详细"), button("compact", "只看图"));
};

const knowledgeFilters = () => {
  const overview = app.knowledgeTab.overview;
  const generators = overview?.generators ?? [];
  const groups = overview?.groups ?? [];
  const senders = overview?.senders ?? [];

  const searchInput = el("input", {
    type: "search",
    class: "kb-search",
    placeholder: "搜咒语，或用 tag: model: lora: sender: steps>=30 …",
    value: app.knowledgeTab.query,
    "data-testid": "kb-search",
  });
  // Search on Enter rather than per keystroke: each query hits FTS plus a COUNT
  // over thousands of rows, and the store is also written by harvest runs.
  searchInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      replaceKnowledgeTab({ query: searchInput.value.trim() });
      loadKnowledgeResults();
    }
  });

  const picker = (value, onchange, placeholder, options) =>
    el("select", { class: "kb-select", onchange: (event) => onchange(event.target.value) },
      el("option", { value: "" }, placeholder),
      options.map((option) =>
        el("option", { value: option.value, selected: option.value === value }, option.label)));

  const generatorSelect = picker(app.knowledgeTab.generator, (value) => {
    replaceKnowledgeTab({ generator: value });
    loadKnowledgeResults();
  }, "全部来源", generators.map((row) => ({ value: row.generator, label: `${generatorLabel(row.generator)} (${row.count})` })));

  const groupSelect = picker(app.knowledgeTab.groupId, (value) => {
    replaceKnowledgeTab({ groupId: value });
    loadKnowledgeResults();
  }, "全部群", groups.map((row) => ({ value: row.groupId, label: `${row.groupName || row.groupId} (${row.images})` })));

  // Only images with a sighting have a known sender, so the count is small by
  // nature; the label says so to avoid looking broken.
  const senderSelect = picker(app.knowledgeTab.sender, (value) => {
    replaceKnowledgeTab({ sender: value });
    loadKnowledgeResults();
  }, senders.length === 0 ? "没有已知发图人" : "全部发图人", senders.map((row) => ({ value: row.speaker, label: `${row.speaker} (${row.images})` })));

  const sortSelect = picker(app.knowledgeTab.sort, (value) => {
    replaceKnowledgeTab({ sort: value || "recent" });
    loadKnowledgeResults();
  }, SORT_LABELS.recent, Object.entries(SORT_LABELS).map(([value, label]) => ({ value, label })));

  const hasFilters = app.knowledgeTab.query !== "" || app.knowledgeTab.generator !== ""
    || app.knowledgeTab.groupId !== "" || app.knowledgeTab.sender !== "";

  return el("div", { class: "kb-controls" },
    el("div", { class: "kb-control-row" },
      searchInput,
      el("button", {
        class: "btn",
        onclick: () => {
          replaceKnowledgeTab({ query: searchInput.value.trim() });
          loadKnowledgeResults();
        },
      }, "搜索"),
      el("button", {
        class: app.knowledgeTab.showHelp ? "btn small active" : "btn small",
        title: "搜索语法",
        onclick: () => {
          replaceKnowledgeTab({ showHelp: !app.knowledgeTab.showHelp });
          renderKnowledgeView();
        },
      }, "语法"),
      el("button", {
        class: app.knowledgeTab.showExport ? "btn small active" : "btn small",
        title: "导出当前筛选结果",
        onclick: () => {
          const showExport = !app.knowledgeTab.showExport;
          replaceKnowledgeTab({ showExport });
          if (showExport) {
            loadExportPreview();
          } else {
            renderKnowledgeView();
          }
        },
      }, "导出"),
      hasFilters
        ? el("button", {
          class: "btn small",
          onclick: () => {
            replaceKnowledgeTab({ query: "", generator: "", groupId: "", sender: "" });
            loadKnowledgeResults();
          },
        }, "清除筛选")
        : null),
    el("div", { class: "kb-control-row" }, generatorSelect, groupSelect, senderSelect, sortSelect, densityToggle()),
    searchPreview(),
    syntaxHelpPanel(),
    exportPanel());
};

// Explains the library's shape up front. Without this the user sees thousands of
// cards saying "no group record" and reasonably concludes the feature is broken,
// when the real cause is simply that summaries cover a narrow time range.
const knowledgeCoverageNote = () => {
  const overview = app.knowledgeTab.overview;
  const reasons = overview?.reasons;
  if (reasons === undefined) {
    return null;
  }
  const outside = reasons["outside-coverage"] ?? 0;
  const notInMessages = reasons["not-in-messages"] ?? 0;
  const unavailable = reasons.unavailable ?? 0;
  const evicted = reasons.evicted ?? 0;
  const total = Object.values(reasons).reduce((sum, count) => sum + count, 0);
  if (total === 0 || outside + notInMessages + unavailable + evicted === 0) {
    return null;
  }

  const coverage = overview.coverage;
  const covered = coverage === null || coverage === undefined
    ? "还没有总结过任何时间范围"
    : `已总结 ${formatUnix(coverage.fromUnix).slice(0, 10)} ~ ${formatUnix(coverage.toUnix).slice(0, 10)}`;

  return el("details", { class: "kb-coverage" },
    el("summary", {},
      `${reasons.attributed ?? 0} / ${total} 张能对上发图人`,
      el("span", { class: "kb-meta" }, `　${covered}`)),
    el("div", { class: "kb-coverage-body" },
      outside === 0 ? null : el("p", { class: "kb-meta" },
        `${outside} 张的时间不在已总结范围内。这些图的参数已经存好了，只是还不知道是谁发的；到「运行」页补跑那段时间就会逐步对上。`),
      notInMessages === 0 ? null : el("p", { class: "kb-meta" },
        `${notInMessages} 张所在时间段已扫过，但群消息里没有 —— 这些多半是你自己生成、私聊收到或从收藏进缓存的。`),
      unavailable === 0 ? null : el("p", { class: "kb-meta" },
        `${unavailable} 张从未记录到本地原图路径，可能没有下载过原图。`),
      evicted === 0 ? null : el("p", { class: "kb-meta" },
        `${evicted} 张曾有本地原图，但对应缓存文件现在已不存在；参数仍然保留。`),
      el("p", { class: "kb-meta" },
        "提示：QQ 设置里开启「自动下载原图」后，之后群里的图才会保留 AI 参数 —— 压缩过的图读不出任何参数。")));
};

const knowledgeStats = () => {
  const counts = app.knowledgeTab.overview?.counts;
  if (counts === undefined) {
    return null;
  }
  const stat = (label, value, hint) =>
    el("div", { class: "kb-stat", title: hint ?? "" },
      el("strong", {}, String(value)),
      el("span", {}, label));

  return el("div", { class: "kb-stats" },
    stat("张图有参数", counts.images),
    stat("个 LoRA", counts.loras),
    stat("个标签", counts.tags),
    stat("张能对上发图人", counts.attributed, "只有跑过总结的时间段才对得上"),
    counts.promptRequests > 0
      ? stat("次求图 / 咒语", counts.promptRequests, `其中 ${counts.answeredRequests} 次已有回复`)
      : null,
    counts.fileMissing > 0
      ? stat("张缓存原图已不存在", counts.fileMissing, "参数还留着，当前没有本地原图")
      : null);
};

/* ---------- requests surface ---------- */

const requestRow = (row) => {
  const targetResolved = row.imageHash !== null;
  const targetMissingText = targetResolved
    ? unavailableImageText(row.imageFileMissing === 1)
    : "未能定位被问的图";
  return el("article", { class: "kb-request", "data-testid": "kb-request" },
    targetResolved && row.imageHasFile === 1
      ? el("img", {
        class: "kb-thumb small",
        src: knowledgeThumbUrl(row.imageHash),
        loading: "lazy",
        decoding: "async",
        alt: "被问的图",
      })
      : el("div", { class: "kb-thumb small missing" },
        el("span", {}, "?"),
        el("small", {}, targetMissingText)),
    el("div", { class: "kb-request-body" },
      el("div", { class: "kb-card-head" },
        el("span", { class: "kb-badge" }, INTENT_LABELS[row.intent] ?? row.intent),
        confidenceBadge(row.confidence),
        el("span", { class: "kb-meta" }, `${row.groupName || row.groupId} · ${formatUnix(row.askSentAt)}`)),
      el("p", { class: "kb-ask" }, `${row.asker}：${row.askText}`),
      requestIsAnswered(row)
        ? requestAnswer(row)
        : el("p", { class: "kb-note muted" }, row.intent === "original"
          ? "还没有人回复原图或文件"
          : "还没有人回复咒语")));
};

const renderRequests = () => {
  const data = app.knowledgeTab.requests;
  if (data === null) {
    return el("div", { class: "empty" }, "读取中…");
  }
  if (data.needsHarvest === true) {
    return el("div", { class: "empty" },
      "这个库还是旧版本建的，跑一次总结就会开始记录群里的「求咒语」。");
  }
  if (data.items.length === 0) {
    return el("div", { class: "empty" },
      "还没有记录到求图或求咒语。工具会在每次总结时自动检测 kkt / kko / kky 和「求tag」「看看原图」这类消息。");
  }
  const answered = data.items.filter(requestIsAnswered).length;
  return el("div", {},
    el("p", { class: "kb-meta" }, `共 ${data.items.length} 次，其中 ${answered} 次已有回复。`),
    el("div", { class: "kb-request-list" }, data.items.map(requestRow)));
};

/* ---------- coverage surface ---------- */

// Answers "what am I missing?" concretely. A bar per month, split into the part
// whose sender is known and the part still unattributed, with whether that month
// was ever summarised -- which is the difference between "nothing to find" and
// "haven't looked yet".
const coverageMonthRow = (row, maxImages) => {
  const attributedShare = row.images === 0 ? 0 : (row.attributed / row.images) * 100;
  const width = maxImages === 0 ? 0 : (row.images / maxImages) * 100;
  return el("div", { class: "kb-cov-row" },
    el("button", {
      class: "kb-cov-month kb-linkish",
      title: "只看这个月的图",
      onclick: () => {
        const from = `${row.month}-01`;
        // Day 31 is accepted for short months too: the comparison is a bound,
        // not a calendar date, so no month-length logic is needed.
        replaceKnowledgeTab({ surface: "images", query: `date:${from}..${row.month}-31` });
        loadKnowledgeResults();
      },
    }, row.month),
    el("div", { class: "kb-cov-bar", style: `width: ${width.toFixed(1)}%` },
      el("div", { class: "kb-cov-fill", style: `width: ${attributedShare.toFixed(1)}%` })),
    el("span", { class: "kb-cov-count" }, String(row.images)),
    row.summarised
      ? el("span", { class: "kb-badge ok" }, `${row.attributed} 已知发图人`)
      : el("span", { class: "kb-badge warn" }, "这段时间没总结过"));
};

const renderCoverage = () => {
  const data = app.knowledgeTab.coverage;
  if (data === null || data === undefined) {
    return el("div", { class: "empty" }, "读取中…");
  }
  if (data.available === false) {
    return el("div", { class: "empty" }, "还没有咒语库。跑一次总结就会开始建库。");
  }
  if (data.months.length === 0) {
    return el("div", { class: "empty" }, "库里还没有图片。");
  }

  const maxImages = Math.max(...data.months.map((row) => row.images));
  const unsummarised = data.months.filter((row) => !row.summarised);
  const recoverable = unsummarised.reduce((sum, row) => sum + row.unattributed, 0);

  return el("div", { class: "kb-coverage-view" },
    el("div", { class: "kb-stats" },
      el("div", { class: "kb-stat" }, el("strong", {}, String(data.totals.images)), el("span", {}, "张图有参数")),
      el("div", { class: "kb-stat" }, el("strong", {}, String(data.totals.attributed)), el("span", {}, "张知道谁发的")),
      data.newSince > 0
        ? el("div", { class: "kb-stat" }, el("strong", {}, String(data.newSince)), el("span", {}, "张上次来之后新增"))
        : null),

    recoverable === 0
      ? null
      : el("p", { class: "kb-note" },
        `有 ${recoverable} 张图所在的月份从没总结过，所以还不知道是谁发的。`,
        "到「运行」页把那段时间补跑一次，这些图就会自动对上发图人 —— 参数已经存好了，不会重复解析。"),

    el("div", { class: "kb-cov-legend" },
      el("span", {}, el("i", { class: "kb-cov-swatch known" }), "已知发图人"),
      el("span", {}, el("i", { class: "kb-cov-swatch unknown" }), "还不知道"),
      el("span", { class: "kb-meta" }, "点月份只看那个月的图")),

    el("div", { class: "kb-cov-list" }, data.months.map((row) => coverageMonthRow(row, maxImages))),

    data.groups.length === 0
      ? null
      : el("div", {},
        el("h3", { class: "kb-cov-heading" }, "有图片归属的群"),
        el("div", { class: "kb-cov-list" },
          data.groups.map((row) =>
            el("div", { class: "kb-cov-group" },
              el("button", {
                class: "kb-linkish",
                title: "只看这个群的图",
                onclick: () => {
                  replaceKnowledgeTab({ surface: "images", groupId: row.groupId, query: "" });
                  loadKnowledgeResults();
                },
              }, row.groupName || row.groupId),
              el("span", { class: "kb-meta" }, `${row.images} 张 · ${formatUnix(row.firstSeen).slice(0, 10)} ~ ${formatUnix(row.lastSeen).slice(0, 10)}`))))),

    data.unattributedGroups.length === 0
      ? null
      : el("div", {},
        el("h3", { class: "kb-cov-heading" }, "有图但一张都没入库的群"),
        el("p", { class: "kb-meta" },
          "这些群发的图基本都被 QQ 压缩过，读不到 AI 参数。开启「自动下载原图」后，以后的图才有机会入库。"),
        el("div", { class: "kb-cov-list" },
          data.unattributedGroups.map((row) =>
            el("div", { class: "kb-cov-group" },
              el("span", {}, row.groupName),
              el("span", { class: "kb-meta" }, `${row.mediaMessages} 条图片消息`))))));
};

/* ---------- detail overlay ---------- */

// Moves the open detail view to the next/previous image in the current results.
// Declared before the renderer that references it: the calls sit inside click
// handlers so a later declaration would still work, but only by accident.
const stepDetail = (delta) => {
  const items = app.knowledgeTab.results?.items ?? [];
  const current = app.knowledgeTab.detail;
  if (current === null || items.length === 0) {
    return;
  }
  const index = items.findIndex((item) => item.hash === current.hash);
  if (index === -1) {
    return;
  }
  const next = items[index + delta];
  if (next === undefined) {
    return;
  }
  // Goes through openDetail so the neighbour's full prompt is fetched too.
  openDetail(next);
};

const detailRow = (label, value) =>
  value === undefined || value === null || value === "" ? null : el("div", { class: "kb-detail-row" },
    el("span", { class: "kb-detail-label" }, label),
    el("span", { class: "kb-detail-value" }, String(value)));

const renderKnowledgeDetail = () => {
  const item = app.knowledgeTab.detail;
  if (item === null) {
    return null;
  }
  const params = item.params ?? {};
  const close = () => {
    replaceKnowledgeTab({ detail: null });
    renderKnowledgeView();
  };

  const items = app.knowledgeTab.results?.items ?? [];
  const index = items.findIndex((entry) => entry.hash === item.hash);
  const position = index === -1 ? "" : `${index + 1} / ${items.length}`;

  return el("div", {
    class: "kb-overlay",
    onclick: (event) => {
      if (event.target.classList.contains("kb-overlay")) {
        close();
      }
    },
  },
  el("div", { class: "kb-overlay-panel" },
    el("div", { class: "kb-overlay-head" },
      el("strong", {}, generatorLabel(item.generator)),
      el("div", { class: "kb-overlay-nav" },
        position === "" ? null : el("span", { class: "kb-meta" }, position),
        el("button", {
          class: "btn small",
          title: "上一张（←）",
          disabled: index <= 0,
          onclick: () => stepDetail(-1),
        }, "←"),
        el("button", {
          class: "btn small",
          title: "下一张（→）",
          disabled: index === -1 || index >= items.length - 1,
          onclick: () => stepDetail(1),
        }, "→"),
        el("button", { class: "btn small", onclick: close }, "关闭"))),
    item.hasFile
      ? el("img", { class: "kb-overlay-image", src: knowledgeFileUrl(item.hash), alt: "原图" })
      : el("div", { class: "kb-thumb missing" }, el("span", {}, unavailableImageText(item.fileMissing))),
    promptBlock(item.prompt, "咒语"),
    promptBlock(item.negativePrompt, "负面咒语"),
    el("div", { class: "kb-detail-grid" },
      detailRow("模型", item.checkpoint),
      detailRow("模型 hash", item.modelHash),
      detailRow("尺寸", item.width > 0 ? `${item.width}×${item.height}` : ""),
      detailRow("steps", params.steps),
      detailRow("CFG", params.cfgScale),
      detailRow("采样器", params.sampler),
      detailRow("调度", params.scheduler),
      detailRow("seed", params.seed),
      detailRow("重绘幅度", params.denoisingStrength),
      detailRow("md5", item.hash)),
    item.loras.length === 0
      ? null
      : el("div", { class: "kb-loras" },
        el("span", { class: "kb-prompt-label" }, `LoRA ×${item.loras.length}`),
        el("div", { class: "kb-chip-row" },
          item.loras.map((lora) =>
            el("span", { class: "kb-chip" }, lora.weight === null ? lora.name : `${lora.name} @${lora.weight}`)))),
    item.sightings.length === 0
      ? null
      : el("div", {},
        el("span", { class: "kb-prompt-label" }, "群里出现过"),
        el("ul", { class: "kb-sightings" },
          item.sightings.map((seen) =>
            el("li", {}, `${formatUnix(seen.sentAt)} · ${seen.groupName || seen.groupId} · ${seen.speaker}`)))),
    (item.promptRequests ?? []).map(requestAnswer)));
};

/* ---------- view ---------- */

const knowledgeSurfaceTabs = () => {
  const tab = (name, label) =>
    el("button", {
      class: app.knowledgeTab.surface === name ? "btn small active" : "btn small",
      onclick: () => {
        replaceKnowledgeTab({ surface: name });
        ensureKnowledgeLoaded();
      },
    }, label);
  return el("div", { class: "kb-tabs" },
    tab("images", "图库"),
    tab("requests", "求图 / 咒语记录"),
    tab("coverage", "覆盖情况"));
};

// Watches the bottom sentinel and loads the next page when it comes into view.
// One observer is reused across renders; observing a fresh node each time would
// leak an observer per render.
let sentinelObserver = null;

const observeSentinel = (node) => {
  if (typeof IntersectionObserver === "undefined") {
    // Without observer support the page still works: the sentinel text tells the
    // user to scroll, and any filter change reloads from the top.
    return;
  }
  if (sentinelObserver === null) {
    sentinelObserver = new IntersectionObserver((entries) => {
      const visible = entries.some((entry) => entry.isIntersecting);
      const tab = app.knowledgeTab;
      const loaded = tab.results?.items.length ?? 0;
      const total = tab.results?.total ?? 0;
      if (visible && !tab.loading && !tab.loadingMore && loaded < total && app.view === "knowledge") {
        loadKnowledgeResults({ append: true });
      }
    }, { rootMargin: "400px" });
  }
  sentinelObserver.disconnect();
  // Observe on the next tick so the node is in the document and can intersect.
  queueMicrotask(() => {
    if (node.isConnected) {
      sentinelObserver.observe(node);
    }
  });
};

// Windowed rendering is used past a threshold; below it a plain grid is simpler
// and imposes no fixed-height constraint. The teardown handle must be released
// before each re-render or old scroll listeners keep firing on a detached node.
let releaseVirtualGrid = null;

const teardownVirtualGrid = () => {
  if (releaseVirtualGrid !== null) {
    releaseVirtualGrid();
    releaseVirtualGrid = null;
  }
};

const renderImages = () => {
  const results = app.knowledgeTab.results;
  if (results === null || results === undefined) {
    return el("div", { class: "empty" }, "读取中…");
  }
  if (results.available === false) {
    return el("div", { class: "empty" },
      "还没有咒语库。跑一次总结，工具就会从 QQ 图片缓存里读出 AI 生成参数并建库。");
  }
  if (results.items.length === 0) {
    return el("div", { class: "empty" },
      app.knowledgeTab.query === "" && app.knowledgeTab.generator === "" && app.knowledgeTab.groupId === "" && app.knowledgeTab.sender === ""
        ? "库里还没有图片。"
        : "没有符合条件的图片。可以放宽筛选，或点「清除筛选」。");
  }

  const remaining = results.total - results.items.length;
  const windowed = window.KnowledgeGridMath.shouldVirtualize(results.items.length);
  const grid = windowed
    ? el("div", { class: "kb-vgrid", "data-testid": "kb-vgrid" })
    : el("div", { class: `kb-grid ${app.knowledgeTab.density}` }, results.items.map(imageCard));

  if (windowed) {
    // Mounted after this subtree is in the document, so clientWidth is real.
    queueMicrotask(() => {
      if (!grid.isConnected) {
        return;
      }
      teardownVirtualGrid();
      releaseVirtualGrid = window.KnowledgeGrid.mountVirtualGrid({
        container: grid,
        items: results.items,
        density: app.knowledgeTab.density,
        renderItem: imageCard,
      });
    });
  }

  // Scrolling loads the next page: a button to continue reading a list is noise,
  // since reaching the bottom already expresses the intent. The sentinel is
  // observed rather than polled on scroll so it costs nothing while idle.
  const sentinel = remaining <= 0
    ? null
    : el("div", { class: "kb-sentinel" },
      app.knowledgeTab.loadingMore
        ? el("span", { class: "kb-meta" }, "读取中…")
        : el("span", { class: "kb-meta" }, `继续下滑加载（还有 ${remaining} 张）`));
  if (sentinel !== null) {
    observeSentinel(sentinel);
  }

  return el("div", {},
    el("p", { class: "kb-meta" },
      remaining > 0
        ? `共 ${results.total} 张，已显示 ${results.items.length} 张。`
        : `共 ${results.total} 张，已全部显示。`,
      windowed ? "　（大量结果已启用窗口渲染）" : ""),
    grid,
    sentinel);
};

const renderKnowledgeView = () => {
  const surface = app.knowledgeTab.surface;
  // Every render replaces the grid node, so any previous window must be released
  // first; renderImages re-mounts it when it is still the active surface.
  teardownVirtualGrid();
  const body = surface === "images"
    ? renderImages()
    : surface === "requests" ? renderRequests() : renderCoverage();
  setChildren($("#view-knowledge"),
    el("section", { class: "panel" },
      knowledgeSurfaceTabs(),
      surface === "coverage" ? null : knowledgeStats(),
      surface === "images" ? knowledgeCoverageNote() : null,
      surface === "images" ? knowledgeFilters() : null,
      app.knowledgeTab.error === null
        ? null
        : el("p", { class: "kb-note warn" }, app.knowledgeTab.error),
      body),
    renderKnowledgeDetail());
};

try {
  if (!KNOWLEDGE_SURFACES.has(app.knowledgeTab.surface)) {
    replaceKnowledgeTab({ surface: "images" });
  }
  const stored = localStorage.getItem(DENSITY_KEY);
  replaceKnowledgeTab({ density: DENSITIES.has(stored) ? stored : "detail" });
} catch {
  // A blocked localStorage must never stop the page from loading.
  replaceKnowledgeTab({ surface: "images", density: "detail" });
}

document.addEventListener("keydown", (event) => {
  if (app.view !== "knowledge") {
    return;
  }
  // Never hijack keys while the user is typing in the search box.
  const tag = document.activeElement?.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
    return;
  }
  if (event.key === "Escape" && app.knowledgeTab.detail !== null) {
    replaceKnowledgeTab({ detail: null });
    renderKnowledgeView();
    return;
  }
  if (app.knowledgeTab.detail !== null && (event.key === "ArrowRight" || event.key === "ArrowLeft")) {
    event.preventDefault();
    stepDetail(event.key === "ArrowRight" ? 1 : -1);
  }
});
