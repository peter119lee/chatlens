"use strict";

const TOKEN = document.querySelector('meta[name="cc-token"]').content;
const $ = (selector) => document.querySelector(selector);

// DOM builder: children are appended as text nodes unless they are already Nodes,
// so untrusted strings can never be parsed as HTML.
const el = (tag, props = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) {
      continue;
    }
    if (key === "class") {
      node.className = value;
    } else if (key === "dataset") {
      Object.assign(node.dataset, value);
    } else if (key.startsWith("on") && typeof value === "function") {
      node.addEventListener(key.slice(2), value);
    } else {
      node.setAttribute(key, value === true ? "" : value);
    }
  }
  for (const child of children.flat(Infinity)) {
    if (child !== undefined && child !== null && child !== false) {
      node.append(child instanceof Node ? child : String(child));
    }
  }
  return node;
};

// replaceChildren renders bare null/false as the strings "null"/"false"; always go through this.
const setChildren = (node, ...children) => {
  node.replaceChildren(...children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false));
};

const api = async (path, options = {}) => {
  const response = await fetch(path, {
    ...options,
    headers: {
      "x-cc-token": TOKEN,
      ...(options.body !== undefined ? { "content-type": "application/json" } : {}),
    },
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error ?? `HTTP ${response.status}`);
  }
  return payload;
};

const app = {
  state: null,
  view: "run",
  runMode: "watchlist",
  range: { type: "hours", hours: 24 },
  rangeInitialized: false,
  job: null,
  logCursor: 0,
  logText: "",
  pollTimer: null,
  watchSearch: "",
  msg: {
    overview: null,
    mode: "inbox",
    style: localStorage.getItem("cc-msgstyle") ?? "bubble",
    groupId: null,
    groupName: "",
    from: null,
    to: null,
    q: "",
    items: [],
    hasMore: false,
    loading: false,
    coverage: [],
    readMark: null,
    dividerAt: null,
    scrollToUnread: false,
    selA: null,
    selB: null,
  },
  mediaTab: {
    data: null,
    group: "all",
    kind: "all",
    person: "all",
    sort: "time",
    mode: localStorage.getItem("cc-mediamode") ?? "detail",
    selecting: false,
    selected: new Set(),
  },
};

const VIEW_TITLES = { run: "运行", messages: "消息", history: "历史报告", media: "媒体", watchlist: "关注群", reader: "阅读报告", settings: "设置" };
const NAV_ICONS = { run: "▶", messages: "💬", history: "📚", media: "🖼️", watchlist: "⭐", settings: "⚙️" };
const KIND_ICONS = { image: "📷", video: "🎬", sticker: "😃", face: "😃", file: "📎" };
const KIND_LABELS = { image: "图片", video: "视频", sticker: "表情", face: "表情", file: "文件" };

const settings = {
  theme: localStorage.getItem("cc-theme") ?? "light",
  icons: localStorage.getItem("cc-icons") !== "off",
};

const applySettings = () => {
  document.documentElement.dataset.theme = settings.theme;
  for (const button of document.querySelectorAll("#nav button")) {
    const name = button.dataset.view;
    button.textContent = settings.icons ? `${NAV_ICONS[name] ?? ""} ${VIEW_TITLES[name] ?? name}` : VIEW_TITLES[name] ?? name;
  }
  const themeButton = $("#theme-toggle");
  if (themeButton !== null) {
    themeButton.textContent = settings.theme === "dark" ? "☀️ 日间模式" : "🌙 夜间模式";
  }
  const iconsButton = $("#icons-toggle");
  if (iconsButton !== null) {
    iconsButton.textContent = settings.icons ? "图标：开" : "图标：关";
  }
};

const toggleTheme = () => {
  settings.theme = settings.theme === "dark" ? "light" : "dark";
  localStorage.setItem("cc-theme", settings.theme);
  applySettings();
};

const toggleIcons = () => {
  settings.icons = !settings.icons;
  localStorage.setItem("cc-icons", settings.icons ? "on" : "off");
  applySettings();
  renderCurrentView();
};

// Deterministic avatar color per group/speaker id or name.
const hashHue = (value) => {
  let hash = 0;
  for (const char of String(value)) {
    hash = (hash * 31 + char.codePointAt(0)) % 3600;
  }
  return hash % 360;
};

// QQ's public avatar CDN — the same endpoints the QQ client itself loads from.
const groupAvatarUrl = (groupId) => `https://p.qlogo.cn/gh/${groupId}/${groupId}/100`;
const userAvatarUrl = (uin) =>
  /^\d+$/u.test(String(uin ?? "")) ? `https://q1.qlogo.cn/g?b=qq&nk=${uin}&s=100` : null;

const avatarEl = (label, seed, size, avatarUrl) => {
  const node = el("span", {
    class: `av ${size === "sm" ? "av-sm" : ""}`,
    style: `background:hsl(${hashHue(seed)} 55% ${settings.theme === "dark" ? "38%" : "46%"})`,
  }, String(label ?? "?").trim().slice(0, 1) || "?");
  // Real avatar on top of the colored initial; if the CDN misses, the initial stays visible.
  if (settings.icons && typeof avatarUrl === "string") {
    node.append(el("img", {
      class: "av-img",
      src: avatarUrl,
      loading: "lazy",
      alt: "",
      onerror: (event) => event.target.remove(),
    }));
  }
  return node;
};

const mediaLabelText = (kinds, text) => {
  const kind = String(kinds ?? "").split(",")[0];
  const icon = KIND_ICONS[kind] ?? "📎";
  const label = KIND_LABELS[kind] ?? "媒体";
  return text && text.trim().length > 0 ? `${icon} [${label}] ${text.trim()}` : `${icon} [${label}]`;
};

const formatBytes = (bytes) => {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
};

const unixToHkt = (unix) => {
  const date = new Date(unix * 1000);
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
};

const hktToUnix = (text) => {
  const match = String(text ?? "").match(/(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/u);
  if (match === null) {
    return null;
  }
  return Math.floor(
    new Date(+match[1], +match[2] - 1, +match[3], +match[4], +match[5], +(match[6] ?? 0)).getTime() / 1000,
  );
};

/* ---------- navigation ---------- */

const showView = (name) => {
  app.view = name;
  for (const button of document.querySelectorAll("#nav button")) {
    button.classList.toggle("active", button.dataset.view === name);
  }
  for (const view of document.querySelectorAll(".view")) {
    view.hidden = view.id !== `view-${name}`;
  }
  $("#view-title").textContent = VIEW_TITLES[name] ?? name;
};

const openPath = (targetPath) => async () => {
  try {
    await api("/api/open", { method: "POST", body: JSON.stringify({ path: targetPath }) });
  } catch (error) {
    alert(error.message);
  }
};

/* ---------- run view ---------- */

const RANGE_PRESETS = [
  { label: "自上次记录", type: "sinceStore" },
  { label: "最近 6 小时", type: "hours", hours: 6 },
  { label: "最近 24 小时", type: "hours", hours: 24 },
  { label: "最近 2 天", type: "days", days: 2 },
  { label: "最近 7 天", type: "days", days: 7 },
  { label: "最近 30 天", type: "days", days: 30 },
  { label: "自定义", type: "custom" },
];

// "自上次记录": start where store coverage for the target groups ends (10 min overlap for dedup).
const resolveSinceStoreRange = async (request) => {
  const overview = await api("/api/store-overview");
  const targetIds = request.mode === "groups"
    ? new Set(request.groupIds)
    : new Set((app.state?.watchlist ?? []).map((entry) => entry.groupId));
  const ends = (overview.groups ?? [])
    .filter((group) => targetIds.size === 0 || targetIds.has(group.groupId))
    .map((group) => group.coverageEnd)
    .filter((value) => Number.isFinite(value) && value > 0);
  if (ends.length === 0) {
    throw new Error("这些群还没有任何记录，请先用固定时间范围跑一次。");
  }
  return { type: "custom", start: unixToHkt(Math.min(...ends) - 600), end: "" };
};

const rangeMatchesPreset = (preset) =>
  preset.type === app.range.type &&
  (preset.type !== "hours" || preset.hours === app.range.hours) &&
  (preset.type !== "days" || preset.days === app.range.days);

const renderRunView = () => {
  const watchlist = app.state?.watchlist ?? [];
  const defaults = app.state?.runDefaults ?? {};

  const modeChip = (mode, label) =>
    el("button", {
      class: `chip ${app.runMode === mode ? "on" : ""}`,
      onclick: () => {
        app.runMode = mode;
        renderRunView();
      },
    }, label);

  const targetRow = app.runMode === "watchlist"
    ? el("div", { class: "row", style: "margin-bottom:14px" },
        watchlist.length > 0
          ? watchlist.map((entry) => el("span", { class: "tag" }, entry.name || entry.groupId))
          : el("span", { class: "tag plain" }, "还没有关注群，先到「关注群」页添加"))
    : el("div", { class: "row", style: "margin-bottom:14px" },
        el("input", { type: "text", id: "group-input", placeholder: "群号，逗号分隔，例如 123456,789012", style: "flex:1" }));

  const presetChips = el("div", { class: "chips", style: "margin-bottom:14px" },
    RANGE_PRESETS.map((preset) =>
      el("button", {
        class: `chip ${rangeMatchesPreset(preset) ? "on" : ""}`,
        onclick: () => {
          app.range = preset.type === "custom" ? { type: "custom", start: "", end: "" } : { ...preset };
          renderRunView();
        },
      }, preset.label)));

  const customRow = app.range.type === "custom"
    ? el("div", { class: "row", style: "margin-bottom:14px" },
        el("input", { type: "text", id: "start-input", placeholder: "开始 2026-07-05 08:00:00", style: "width:230px", value: app.range.start ?? "" }),
        el("span", { style: "color:var(--muted)" }, "至"),
        el("input", { type: "text", id: "end-input", placeholder: "结束（留空 = 现在）", style: "width:230px", value: app.range.end ?? "" }))
    : null;

  const runCard = el("div", { class: "card" },
    el("h2", {}, "运行一次总结"),
    el("p", { class: "card-sub" },
      `LLM ${defaults.useLlm ? "开启" : "关闭"} · 媒体导出 ${defaults.exportMedia ? "开启" : "关闭"}（默认值在 config\\defaults.json）`),
    el("div", { class: "row", style: "margin-bottom:14px" },
      modeChip("watchlist", `关注群 (${watchlist.length})`),
      modeChip("groups", "指定群号")),
    targetRow,
    presetChips,
    customRow,
    el("div", { class: "row" },
      el("button", { class: "btn primary", onclick: startRun }, "立即总结"),
      el("span", { id: "run-error", style: "color:var(--risk);font-size:13px" })));

  const jobCard = el("div", { class: "card", id: "job-card", hidden: app.job === null },
    el("h2", {}, "任务状态"),
    el("div", { id: "job-body" }));

  setChildren($("#view-run"), runCard, jobCard);
  renderJobPanel();
};

const collectRunRequest = () => {
  const range = { ...app.range };
  if (range.type === "custom") {
    range.start = $("#start-input").value.trim();
    range.end = $("#end-input").value.trim();
    app.range = range;
  }
  if (app.runMode === "groups") {
    const raw = $("#group-input").value.trim();
    const groupIds = raw.split(/[,;，；\s]+/u).filter((value) => value.length > 0);
    return { mode: "groups", groupIds, range };
  }
  return { mode: "watchlist", range };
};

const startRun = async () => {
  $("#run-error").textContent = "";
  try {
    const request = collectRunRequest();
    if (request.range.type === "sinceStore") {
      request.range = await resolveSinceStoreRange(request);
    }
    await api("/api/run", { method: "POST", body: JSON.stringify(request) });
    app.logCursor = 0;
    app.logText = "";
    startPolling();
  } catch (error) {
    $("#run-error").textContent = error.message;
  }
};

/* ---------- job panel ---------- */

const renderJobPanel = () => {
  const jobCard = $("#job-card");
  if (jobCard === null) {
    return;
  }
  if (app.job === null) {
    jobCard.hidden = true;
    return;
  }

  jobCard.hidden = false;
  const job = app.job;
  const statusText = { running: "运行中", done: "已完成", failed: "失败", cancelled: "已取消" }[job.status] ?? job.status;
  const elapsedSeconds = Math.round(((job.endedAt ? new Date(job.endedAt) : new Date()) - new Date(job.startedAt)) / 1000);
  const logOpen = $("#job-body .log-box")?.open;

  const stageNodes = job.stages.map((stage) =>
    el("div", { class: `stage ${stage.status}` },
      el("span", { class: "stage-dot" }),
      el("span", {}, stage.label),
      stage.key === "analyze" && job.groupsDone > 0 ? el("small", {}, ` 已完成 ${job.groupsDone} 个群`) : null));

  const resultRow = job.status === "done" && job.type === "summary"
    ? el("div", { class: "row", style: "margin-bottom:12px" },
        el("button", {
          class: "btn primary",
          onclick: () => {
            const runId = (job.result.runDir ?? "").split("\\").pop();
            if (runId) {
              openReader(runId);
            }
          },
        }, "阅读报告"),
        job.result.htmlPath ? el("button", { class: "btn", onclick: openPath(job.result.htmlPath) }, "打开 HTML 报告") : null,
        job.result.runDir ? el("button", { class: "btn", onclick: openPath(job.result.runDir) }, "打开 run 文件夹") : null)
    : null;

  const logBox = el("details", { class: "log-box" },
    el("summary", {}, "运行日志"),
    el("div", { class: "console", id: "job-log" }, app.logText));
  logBox.open = logOpen ?? (job.status === "running" || job.status === "failed");

  setChildren($("#job-body"), 
    el("div", { class: "row", style: "margin-bottom:10px" },
      el("span", { class: "tag" }, `${job.label} · ${statusText}`),
      el("span", { style: "color:var(--muted);font-size:12px" }, `${elapsedSeconds}s`),
      job.status === "running"
        ? el("button", {
            class: "btn small danger",
            onclick: async () => {
              try {
                await api("/api/job/cancel", { method: "POST", body: "{}" });
              } catch (error) {
                alert(error.message);
              }
            },
          }, "取消")
        : null),
    job.error !== null && job.status !== "done" ? el("div", { class: "notice risk" }, job.error) : null,
    job.llmFailures > 0 ? el("div", { class: "notice warn" }, `${job.llmFailures} 个群的 LLM 摘要失败，已降级为本地分组。`) : null,
    el("div", { class: "stages" }, stageNodes),
    resultRow,
    job.status === "done" && job.type === "group-list" ? el("div", { class: "notice ok" }, "群列表已刷新，可到「关注群」页添加。") : null,
    logBox);
};

const updateJobPill = () => {
  const pill = $("#job-pill");
  if (app.job === null) {
    pill.hidden = true;
    return;
  }
  pill.hidden = false;
  pill.className = `job-pill ${app.job.status === "running" ? "running" : app.job.status === "done" ? "done" : "failed"}`;
  pill.textContent = { running: "任务运行中", done: "任务完成", failed: "任务失败", cancelled: "已取消" }[app.job.status] ?? app.job.status;
};

const pollJobOnce = async () => {
  const snapshot = await api(`/api/job?cursor=${app.logCursor}`);
  const wasRunning = app.job?.status === "running";
  app.job = snapshot.job;
  updateJobPill();

  if (snapshot.job === null) {
    return;
  }
  if (snapshot.lines.length > 0) {
    app.logText += `${snapshot.lines.join("\n")}\n`;
  }
  if ($("#job-body") !== null) {
    renderJobPanel();
    const logNode = $("#job-log");
    if (logNode !== null) {
      logNode.scrollTop = logNode.scrollHeight;
    }
  }
  app.logCursor = snapshot.cursor;

  if (wasRunning && snapshot.job.status !== "running") {
    await loadState();
    renderCurrentView();
  }
};

const startPolling = () => {
  if (app.pollTimer !== null) {
    return;
  }
  const tick = async () => {
    try {
      await pollJobOnce();
    } catch {
      /* transient polling errors retry on the next tick */
    }
    if (app.job?.status === "running") {
      app.pollTimer = setTimeout(tick, 1200);
    } else {
      app.pollTimer = null;
    }
  };
  app.pollTimer = setTimeout(tick, 300);
};

/* ---------- history view ---------- */

const renderHistoryView = () => {
  const runs = app.state?.runs ?? [];
  if (runs.length === 0) {
    setChildren($("#view-history"), 
      el("div", { class: "card" }, el("div", { class: "empty" }, "还没有任何报告。到「运行」页跑一次总结。")));
    return;
  }

  setChildren($("#view-history"), 
    ...runs.map((run) =>
      el("div", { class: "card run-card" },
        el("div", {},
          el("div", { class: "meta-line" }, `${run.firstMessageHkt} — ${run.lastMessageHkt}`),
          el("h3", {}, run.isDigest ? el("span", { class: "tag" }, "多群") : null, run.isDigest ? " " : null, run.groups),
          el("p", {}, run.summary),
          el("div", { class: "meta-line", style: "margin-top:8px" },
            `文本 ${run.textMessages} · 媒体 ${run.copiedMedia}/${run.mediaRefs} · ${run.llmStatus === "done" ? run.llmModel || "LLM" : "仅本地分组"}`)),
        el("div", { class: "actions" },
          el("button", { class: "btn small", onclick: () => openReader(run.runId) }, "阅读"),
          run.hasReportHtml ? el("button", { class: "btn small", onclick: openPath(run.reportHtml) }, "HTML") : null,
          el("button", { class: "btn small", onclick: openPath(run.runDir) }, "文件夹")))));
};

/* ---------- watchlist view ---------- */

const updateWatchlist = async (payload) => {
  const result = await api("/api/watchlist", { method: "POST", body: JSON.stringify(payload) });
  app.state.watchlist = result.watchlist;
  renderWatchlistView();
};

const renderWatchlistView = () => {
  const watchlist = app.state?.watchlist ?? [];
  const knownGroups = app.state?.knownGroups ?? [];
  const watchIds = new Set(watchlist.map((entry) => entry.groupId));
  const query = app.watchSearch.trim().toLowerCase();
  const filtered = knownGroups.filter(
    (group) => query.length === 0 || group.groupId.includes(query) || group.name.toLowerCase().includes(query));

  const watchRow = (entry) =>
    el("div", { class: "wl-row" },
      el("div", {},
        el("span", { class: "gname" }, entry.name || entry.groupId),
        el("span", { class: "gid" }, entry.groupId)),
      el("button", {
        class: "btn small danger",
        onclick: () => updateWatchlist({ remove: [entry.groupId] }).catch((error) => alert(error.message)),
      }, "移除"));

  const knownRow = (group) =>
    el("div", { class: "wl-row" },
      el("div", {},
        el("span", { class: "gname" }, group.name || group.groupId),
        el("span", { class: "gid" }, group.groupId)),
      watchIds.has(group.groupId)
        ? el("span", { class: "tag" }, "已关注")
        : el("button", {
            class: "btn small",
            onclick: () => updateWatchlist({ add: [group.groupId] }).catch((error) => alert(error.message)),
          }, "添加"));

  const searchInput = el("input", {
    type: "text",
    class: "search-box",
    placeholder: "搜索群名或群号",
    value: app.watchSearch,
    oninput: (event) => {
      app.watchSearch = event.target.value;
      const scroll = $("#view-watchlist .wl-scroll");
      if (scroll !== null) {
        const q = app.watchSearch.trim().toLowerCase();
        setChildren(scroll, ...knownGroups
          .filter((group) => q.length === 0 || group.groupId.includes(q) || group.name.toLowerCase().includes(q))
          .map(knownRow));
      }
    },
  });

  setChildren($("#view-watchlist"), 
    el("div", { class: "grid-2" },
      el("div", { class: "card" },
        el("h2", {}, `当前关注 (${watchlist.length})`),
        watchlist.length === 0
          ? el("div", { class: "empty" }, "还没有关注任何群。从右侧添加。")
          : watchlist.map(watchRow)),
      el("div", { class: "card" },
        el("div", { class: "row", style: "justify-content:space-between;margin-bottom:12px" },
          el("h2", { style: "margin:0" }, `全部群 (${knownGroups.length})`),
          el("button", {
            class: "btn small",
            onclick: async () => {
              try {
                await api("/api/grouplist/refresh", { method: "POST", body: "{}" });
                app.logCursor = 0;
                app.logText = "";
                showView("run");
                renderRunView();
                startPolling();
              } catch (error) {
                alert(error.message);
              }
            },
          }, "刷新群列表")),
        knownGroups.length === 0
          ? el("div", { class: "empty" }, "还没有群列表缓存，点「刷新群列表」读取一次（需要复制数据库，约 1-2 分钟）。")
          : el("div", {}, searchInput, el("div", { class: "wl-scroll" }, filtered.map(knownRow))))));
};

/* ---------- boot ---------- */

const loadState = async () => {
  app.state = await api("/api/state");
  if (!app.rangeInitialized) {
    const defaultHours = Number(app.state.runDefaults?.sinceHours);
    if (Number.isInteger(defaultHours) && defaultHours > 0) {
      app.range = { type: "hours", hours: defaultHours };
    }
    app.rangeInitialized = true;
  }
};

const renderCurrentView = () => {
  if (app.view === "run") {
    renderRunView();
  } else if (app.view === "history") {
    renderHistoryView();
  } else if (app.view === "watchlist") {
    renderWatchlistView();
  } else if (app.view === "messages") {
    renderMessagesView();
  } else if (app.view === "media") {
    renderMediaView();
  } else if (app.view === "settings") {
    renderSettingsView();
  }
};

const openView = (name) => {
  if (name === "messages") {
    openMessagesView();
    return;
  }
  if (name === "media") {
    openMediaView();
    return;
  }
  if (name === "settings") {
    openSettingsView();
    return;
  }
  showView(name);
  renderCurrentView();
};

const boot = async () => {
  for (const button of document.querySelectorAll("#nav button")) {
    button.addEventListener("click", () => openView(button.dataset.view));
  }
  $("#theme-toggle")?.addEventListener("click", toggleTheme);
  $("#icons-toggle")?.addEventListener("click", toggleIcons);
  applySettings();
  $("#job-pill").addEventListener("click", () => {
    showView("run");
    renderRunView();
  });

  try {
    await loadState();
  } catch (error) {
    setChildren($("#view-run"), 
      el("div", { class: "card" }, el("div", { class: "notice risk" }, `无法连接控制台服务: ${error.message}`)));
    return;
  }

  renderRunView();
  try {
    await pollJobOnce();
    if (app.job?.status === "running") {
      startPolling();
    }
  } catch {
    /* no active job yet */
  }
};

boot();
