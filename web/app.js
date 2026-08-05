"use strict";

const TOKEN = document.querySelector('meta[name="cc-token"]').content;
const $ = (selector) => document.querySelector(selector);
const {
  createTimelineSelection,
  extendTimelineSelection,
  filterTimelineGroups,
  isTimelineSlotSelected,
  mergeAdjacentBatches,
  sortTimelineGroups,
  summarizeTimelineSelection,
  timelineSelectionForRange,
  timelineGapSegments,
} = window.TimelineTools;
const { buildGalleryEvents: buildTimelineGalleryEvents } = window.GalleryTools;
const TIMELINE_GALLERY_EVENT_GAP_SECONDS = 20 * 60;

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
  runNotice: "",
  runNoticeTone: "info",
  runGroups: {
    selected: [],
    query: "",
    open: false,
  },
  timeline: {
    days: 7,
    windowEndUnix: null,
    filter: "all",
    sort: "default",
    selection: null,
    dragging: false,
    loading: false,
    key: "",
    requestKey: "",
    requestId: 0,
    data: null,
    error: null,
    preview: null,
    locateRange: null,
  },
  job: null,
  logCursor: 0,
  logText: "",
  pollTimer: null,
  watchSearch: "",
  historyFilters: {
    query: "",
    groupId: "all",
    coverage: "all",
  },
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
    hasOlder: false,
    loading: false,
    mediaMap: null,
    mediaRowMap: null,
    mediaMapAt: 0,
    coverage: [],
    readMark: null,
    dividerAt: null,
    scrollToUnread: false,
    selA: null,
    selB: null,
    origin: null,
  },
  mediaTab: {
    data: null,
    group: "all",
    kind: "all",
    person: "all",
    sort: "time-desc",
    mode: localStorage.getItem("cc-mediamode") ?? "detail",
    selecting: false,
    selected: new Set(),
    fromUnix: null,
    toUnix: null,
    viewerPath: null,
    viewerEventId: null,
    story: null,
    surface: localStorage.getItem("cc-gallery-surface") ?? "events",
    reviewFilter: "all",
    reviews: {},
    rangeState: null,
    rangeStateKey: "",
    compare: {
      leftGroup: "all",
      rightGroup: "all",
      leftFromUnix: null,
      leftToUnix: null,
      rightFromUnix: null,
      rightToUnix: null,
    },
  },
  knowledgeTab: {
    surface: "images",
    query: "",
    generator: "",
    groupId: "",
    sender: "",
    sort: "recent",
    showHelp: false,
    density: "detail",
    loadingMore: false,
    showExport: false,
    exportMode: "new",
    exportScope: "filtered",
    exportLabel: "",
    exportImages: true,
    exportSidecars: true,
    exportIndex: true,
    exportVerify: false,
    exportPreview: null,
    exportResult: null,
    exporting: false,
    selected: new Set(),
    overview: null,
    results: null,
    requests: null,
    coverage: null,
    loading: false,
    error: null,
    detail: null,
    requestId: 0,
  },
};

const VIEW_TITLES = { run: "运行", messages: "消息", history: "历史报告", media: "画廊", knowledge: "咒语库", watchlist: "关注群", reader: "阅读报告", storage: "存储", settings: "设置" };
const NAV_ICONS = { run: "▶", messages: "💬", history: "📚", media: "🖼️", knowledge: "🔮", watchlist: "⭐", storage: "💾", settings: "⚙️" };
const KIND_ICONS = { image: "📷", video: "🎬", sticker: "😃", face: "😃", emoji: "😃", audio: "🎵", file: "📎" };
const KIND_LABELS = { image: "图片", video: "视频", sticker: "表情", face: "表情", emoji: "表情", audio: "语音", file: "文件" };

const settings = {
  theme: localStorage.getItem("cc-theme") ?? "light",
  // Always on. Kept as a field because it also gates real avatar images, not
  // just nav emoji; the toggle was removed since nobody wants them off.
  icons: true,
};

const applySettings = () => {
  document.documentElement.dataset.theme = settings.theme;
  for (const button of document.querySelectorAll("#nav button")) {
    const name = button.dataset.view;
    button.textContent = `${NAV_ICONS[name] ?? ""} ${VIEW_TITLES[name] ?? name}`;
  }
  const themeButton = $("#theme-toggle");
  if (themeButton !== null) {
    themeButton.textContent = settings.theme === "dark" ? "☀️ 日间模式" : "🌙 夜间模式";
  }
};

const toggleTheme = () => {
  settings.theme = settings.theme === "dark" ? "light" : "dark";
  localStorage.setItem("cc-theme", settings.theme);
  applySettings();
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
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
};

// Every hkt string produced by the pipeline (reports, media index, deep links)
// is rendered in Asia/Hong_Kong (UTC+8, no DST). Use the same fixed offset here:
// the browser's local zone would shift displayed times and break the
// groupId|hkt media join on non-UTC+8 machines.
const HKT_OFFSET_SECONDS = 8 * 3600;

const unixToHkt = (unix) => {
  const date = new Date((unix + HKT_OFFSET_SECONDS) * 1000);
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
};

const hktToUnix = (text) => {
  const match = String(text ?? "").match(/(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/u);
  if (match === null) {
    return null;
  }
  return Math.floor(Date.UTC(+match[1], +match[2] - 1, +match[3], +match[4], +match[5], +(match[6] ?? 0)) / 1000) - HKT_OFFSET_SECONDS;
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
// coverageEnds comes straight from scan_ranges, so groups whose messages were
// pruned by retention still contribute; groups never scanned produce a warning.
const resolveSinceStoreRange = async (request) => {
  const overview = await api("/api/store-overview");
  const targets = request.mode === "groups"
    ? [...new Set(request.groupIds)]
    : (app.state?.watchlist ?? []).map((entry) => entry.groupId);
  const coverageEnds = overview.coverageEnds
    ?? Object.fromEntries((overview.groups ?? []).map((group) => [group.groupId, group.coverageEnd]));
  const covered = targets.filter((groupId) => Number.isFinite(coverageEnds[groupId]) && coverageEnds[groupId] > 0);
  if (covered.length === 0) {
    throw new Error("这些群还没有任何记录，请先用固定时间范围跑一次。");
  }
  const start = Math.min(...covered.map((groupId) => coverageEnds[groupId])) - 600;
  const uncovered = targets.filter((groupId) => !covered.includes(groupId));
  return {
    range: { type: "custom", start: unixToHkt(start), end: "" },
    warning: uncovered.length > 0
      ? `提示：群 ${uncovered.join("、")} 还没有本地记录，本次只会从 ${unixToHkt(start).slice(0, 16)} 开始扫描；需要更早历史请用固定范围再跑一次。`
      : null,
  };
};

const rangeMatchesPreset = (preset) =>
  preset.type === app.range.type &&
  (preset.type !== "hours" || preset.hours === app.range.hours) &&
  (preset.type !== "days" || preset.days === app.range.days);

const runTargetGroups = () => {
  const selectedIds = app.runMode === "groups"
    ? app.runGroups.selected
    : (app.state?.watchlist ?? []).map((entry) => entry.groupId);
  const knownById = new Map([
    ...(app.state?.knownGroups ?? []),
    ...(app.state?.watchlist ?? []),
  ].map((group) => [group.groupId, group]));
  return [...new Set(selectedIds)].map((groupId) => ({
    groupId,
    name: knownById.get(groupId)?.name ?? "",
  }));
};

const invalidateRunTimeline = () => {
  app.timeline.requestId += 1;
  app.timeline.loading = false;
  app.timeline.key = "";
  app.timeline.requestKey = "";
  app.timeline.error = null;
  app.timeline.preview = null;
  app.timeline.selection = null;
  app.timeline.dragging = false;
};

const setRunGroups = (groupIds) => {
  app.runGroups.selected = [...new Set(groupIds)];
  invalidateRunTimeline();
};

const toggleRunGroup = (groupId) => {
  setRunGroups(app.runGroups.selected.includes(groupId)
    ? app.runGroups.selected.filter((selectedId) => selectedId !== groupId)
    : [...app.runGroups.selected, groupId]);
  renderRunView();
};

const chooseRunGroup = (groupId) => {
  app.runGroups.query = "";
  app.runGroups.open = false;
  toggleRunGroup(groupId);
};

const renderGroupPicker = () => {
  const knownGroups = [...new Map([
    ...(app.state?.watchlist ?? []),
    ...(app.state?.knownGroups ?? []),
  ].map((group) => [group.groupId, group])).values()];
  const selectedSet = new Set(app.runGroups.selected);
  const matchingGroups = (rawQuery) => {
    const query = rawQuery.trim().toLowerCase();
    return knownGroups
      .filter((group) => query.length === 0 || group.groupId.includes(query) || group.name.toLowerCase().includes(query))
      .slice(0, 80);
  };
  const groupedOptions = (rawQuery) => {
    if (rawQuery.trim().length > 0) {
      return [{ label: "搜索结果", groups: matchingGroups(rawQuery) }];
    }
    const groupById = new Map(knownGroups.map((group) => [group.groupId, group]));
    const used = new Set();
    const take = (groupIds) => groupIds
      .filter((groupId) => groupById.has(groupId) && !used.has(groupId))
      .map((groupId) => {
        used.add(groupId);
        return groupById.get(groupId);
      });
    const health = app.state?.watchHealth ?? [];
    const sections = [
      { label: "当前有缺口", groups: take(health.filter((item) => item.missingSeconds > 0).map((item) => item.groupId)) },
      { label: "关注群", groups: take((app.state?.watchlist ?? []).map((item) => item.groupId)) },
      { label: "最近扫描", groups: take((app.state?.groupActivity ?? []).slice(0, 20).map((item) => item.groupId)) },
      { label: "全部群", groups: take(knownGroups.map((item) => item.groupId)) },
    ];
    return sections.filter((section) => section.groups.length > 0);
  };
  const groupOption = (group) =>
    el("button", {
      type: "button",
      dataset: { groupId: group.groupId },
      class: `group-option ${selectedSet.has(group.groupId) ? "selected" : ""}`,
      onclick: () => chooseRunGroup(group.groupId),
    },
    el("span", { class: "group-option-check", "aria-hidden": "true" }, selectedSet.has(group.groupId) ? "✓" : ""),
    el("span", { class: "group-option-name" }, group.name || group.groupId),
    el("span", { class: "group-option-id" }, group.groupId));
  const renderOptions = (optionsNode, rawQuery) => {
    const sections = groupedOptions(rawQuery);
    const groups = sections.flatMap((section) => section.groups);
    setChildren(optionsNode,
      groups.length === 0
        ? el("div", { class: "group-option-empty" },
            /^\d+$/u.test(rawQuery.trim()) ? "按 Enter 添加这个群号" : "没有匹配的群")
        : sections.map((section) => [
            el("div", { class: "group-option-section" }, section.label),
            section.groups.map(groupOption),
          ]));
  };
  const picker = el("div", {
    class: "group-picker",
    onfocusout: (event) => {
      if (!picker.contains(event.relatedTarget)) {
        app.runGroups.open = false;
        picker.querySelector(".group-options").hidden = true;
      }
    },
  },
    el("div", { class: "group-picker-input" },
      el("input", {
        type: "text",
        id: "group-input",
        "data-testid": "run-group-search",
        placeholder: "搜索群名或群号，也可粘贴陌生群号",
        value: app.runGroups.query,
        onfocus: () => {
          app.runGroups.open = true;
          picker.classList.add("open");
          const optionsNode = picker.querySelector(".group-options");
          optionsNode.hidden = false;
          renderOptions(optionsNode, app.runGroups.query);
        },
        oninput: (event) => {
          app.runGroups.query = event.target.value;
          app.runGroups.open = true;
          const optionsNode = picker.querySelector(".group-options");
          optionsNode.hidden = false;
          renderOptions(optionsNode, app.runGroups.query);
        },
        onkeydown: (event) => {
          if (event.key === "Escape") {
            app.runGroups.open = false;
            picker.querySelector(".group-options").hidden = true;
            return;
          }
          if (event.key !== "Enter") {
            return;
          }
          const groupIds = event.target.value.split(/[,;，；\s]+/u).filter(Boolean);
          if (groupIds.length === 0 || groupIds.some((groupId) => !/^\d+$/u.test(groupId))) {
            return;
          }
          event.preventDefault();
          setRunGroups([...app.runGroups.selected, ...groupIds]);
          app.runGroups.query = "";
          app.runGroups.open = false;
          renderRunView();
        },
      }),
      el("span", { class: "group-picker-count" }, `已选 ${app.runGroups.selected.length}`)),
    el("div", { class: "selected-groups" },
      runTargetGroups().map((group) =>
        el("span", { class: "selected-group" },
          el("span", {}, group.name || group.groupId),
          el("button", {
            type: "button",
            title: `移除 ${group.name || group.groupId}`,
            "aria-label": `移除 ${group.name || group.groupId}`,
            onclick: () => toggleRunGroup(group.groupId),
          }, "×")))),
    app.runGroups.selected.length > 0
      ? el("div", { class: "group-set-save" },
          el("input", { type: "text", placeholder: "组合名称", "aria-label": "常用群组合名称" }),
          el("button", {
            type: "button",
            class: "btn small",
            onclick: async (event) => {
              const input = event.target.parentElement.querySelector("input");
              const name = input.value.trim();
              if (name.length === 0) {
                input.focus();
                return;
              }
              const result = await api("/api/group-sets", {
                method: "POST",
                body: JSON.stringify({ save: { name, groupIds: app.runGroups.selected } }),
              });
              app.state.groupSets = result.groupSets;
              renderRunView();
            },
          }, "保存为常用组合"))
      : null,
    (app.state?.groupSets ?? []).length > 0
      ? el("div", { class: "group-set-row" },
          (app.state.groupSets ?? []).map((set) =>
            el("span", { class: "group-set" },
              el("button", {
                type: "button",
                class: "chip",
                onclick: () => {
                  setRunGroups(set.groupIds);
                  renderRunView();
                },
              }, `${set.name} (${set.groupIds.length})`),
              el("button", {
                type: "button",
                class: "group-set-remove",
                title: `删除组合 ${set.name}`,
                "aria-label": `删除组合 ${set.name}`,
                onclick: async () => {
                  const result = await api("/api/group-sets", { method: "POST", body: JSON.stringify({ remove: set.name }) });
                  app.state.groupSets = result.groupSets;
                  renderRunView();
                },
              }, "×"))))
      : null,
    el("div", { class: "group-options", hidden: !app.runGroups.open },
      groupedOptions(app.runGroups.query).map((section) => [
        el("div", { class: "group-option-section" }, section.label),
        section.groups.map(groupOption),
      ])));
  return picker;
};

const timelineKey = () => [
  app.timeline.days,
  app.timeline.windowEndUnix ?? "now",
  runTargetGroups().map((group) => group.groupId).sort().join(","),
].join(":");

const loadRunTimeline = async () => {
  const groups = runTargetGroups();
  const key = timelineKey();
  if (groups.length === 0 || app.timeline.requestKey === key) {
    return;
  }
  const requestId = app.timeline.requestId + 1;
  app.timeline.requestId = requestId;
  app.timeline.requestKey = key;
  app.timeline.loading = true;
  app.timeline.error = null;
  try {
    const windowQuery = app.timeline.windowEndUnix === null ? "" : `&toUnix=${app.timeline.windowEndUnix}`;
    const [data, mediaData] = await Promise.all([
      api(`/api/store-timeline?groupIds=${encodeURIComponent(groups.map((group) => group.groupId).join(","))}&days=${app.timeline.days}${windowQuery}`),
      app.mediaTab.data === null ? api("/api/media-index") : Promise.resolve(null),
    ]);
    if (requestId !== app.timeline.requestId) {
      return;
    }
    app.timeline.data = data;
    if (mediaData !== null) {
      app.mediaTab.data = mediaData;
    }
    app.timeline.key = key;
    if (app.timeline.locateRange !== null) {
      app.timeline.selection = timelineSelectionForRange(
        data.groups,
        app.timeline.locateRange.groupId,
        app.timeline.locateRange.fromUnix,
        app.timeline.locateRange.toUnix,
      );
      app.timeline.locateRange = null;
    }
  } catch (error) {
    if (requestId !== app.timeline.requestId) {
      return;
    }
    app.timeline.error = error.message;
    app.timeline.key = key;
  } finally {
    if (requestId === app.timeline.requestId) {
      app.timeline.loading = false;
      renderRunView();
    }
  }
};

const openTimelineRange = async ({ groupId, fromUnix, toUnix }) => {
  if (!Number.isFinite(fromUnix) || !Number.isFinite(toUnix) || fromUnix >= toUnix) {
    throw new Error(`Invalid timeline location range: ${fromUnix}-${toUnix}`);
  }
  const knownGroups = [...new Map([
    ...(app.state?.watchlist ?? []),
    ...(app.state?.knownGroups ?? []),
  ].map((group) => [group.groupId, group])).values()];
  const groupIds = groupId === "all"
    ? (runTargetGroups().length > 0 ? runTargetGroups() : knownGroups.slice(0, 50)).map((group) => group.groupId)
    : [groupId];
  if (groupIds.length === 0) {
    throw new Error("No groups are available for timeline location");
  }
  app.runMode = "groups";
  setRunGroups(groupIds);
  const durationDays = Math.ceil((toUnix - fromUnix) / (24 * 60 * 60));
  app.timeline.days = durationDays <= 1 ? 1 : durationDays <= 7 ? 7 : 30;
  const now = Math.floor(Date.now() / 1000);
  app.timeline.windowEndUnix = toUnix >= now ? null : toUnix;
  app.timeline.locateRange = groupId === "all" ? null : { groupId, fromUnix, toUnix };
  showView("run");
  renderRunView();
  await loadRunTimeline();
  document.querySelector("#run-timeline")?.scrollIntoView({ block: "start" });
};

const slotScanStatus = (coverageRatio) => coverageRatio >= 0.999 ? "complete" : coverageRatio > 0 ? "partial" : "none";

const slotResultStatus = (slot) => {
  if (slot.coverageRatio <= 0) {
    return "unscanned";
  }
  return slot.messageCount > 0 ? "result" : "no-messages";
};

const timelineSlotLabel = (group, slot) => {
  const scanStatus = { complete: "完整扫描", partial: `扫描 ${Math.round(slot.coverageRatio * 100)}%`, none: "无扫描记录" }[
    slotScanStatus(slot.coverageRatio)
  ];
  const resultStatus = group.groupId === "all"
    ? `${slot.activeGroupCount} 群有消息，${slot.emptyGroupCount} 群已扫描无消息，${slot.unscannedGroupCount} 群无扫描记录`
    : slot.messageCount > 0 ? `${slot.messageCount} 条消息` : slot.coverageRatio > 0 ? "已扫描无消息" : "结果未知";
  return `${unixToHkt(slot.startUnix).slice(5, 16)} 至 ${unixToHkt(slot.endUnix).slice(5, 16)}，${scanStatus}，${resultStatus}`;
};

const previewTimelineSlot = (group, slot) => {
  app.timeline.preview = { group, slot };
  const preview = $("#timeline-preview");
  if (preview !== null) {
    setChildren(preview, renderTimelinePreview());
  }
};

const clearTimelinePreview = () => {
  app.timeline.preview = null;
  if (app.timeline.selection === null) {
    const preview = $("#timeline-preview");
    if (preview !== null) {
      setChildren(preview, renderTimelinePreview());
    }
  }
};

const formatDuration = (seconds) => {
  const safeSeconds = Math.max(0, Math.round(seconds));
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.round((safeSeconds % 3600) / 60);
  if (hours > 0 && minutes > 0) {
    return `${hours} 小时 ${minutes} 分`;
  }
  return hours > 0 ? `${hours} 小时` : `${minutes} 分钟`;
};

const startCoverageRepair = async (batches) => {
  if (batches.length === 0) {
    return;
  }
  try {
    const estimate = await api("/api/run/repair-coverage/estimate", {
      method: "POST",
      body: JSON.stringify({ batches }),
    });
    if (estimate.runningJob !== null) {
      throw new Error(`已有任务正在运行：${estimate.runningJob.label}。请等待完成或先取消。`);
    }
    if (!estimate.safeToStart) {
      throw new Error(
        `磁盘空间不足，补扫未启动。当前可用 ${formatBytes(estimate.freeDiskBytes)}，至少需要 ${formatBytes(estimate.requiredFreeBytes)}。`,
      );
    }
    const remainingTasks = Math.max(0, estimate.taskCount - estimate.completedTaskCount);
    const temporaryLine = estimate.additionalTemporaryBytes === 0
      ? `临时数据库：复用已有 ${formatBytes(estimate.existingTemporaryBytes)} 副本，不再新增完整副本`
      : `临时数据库：最多新增约 ${formatBytes(estimate.additionalTemporaryBytes)}，完成或取消后清理`;
    const confirmed = window.confirm([
      "开始安全补扫覆盖记录？",
      "",
      `范围：${estimate.groupCount} 个群，累计 ${formatDuration(estimate.totalGroupSeconds)}`,
      `队列：剩余 ${remainingTasks}/${estimate.taskCount} 个串行小块，每块最多 ${formatDuration(estimate.chunkSeconds)}${estimate.failedTaskCount > 0 ? `；其中 ${estimate.failedTaskCount} 个是上次失败重试` : ""}`,
      temporaryLine,
      `磁盘：当前可用 ${formatBytes(estimate.freeDiskBytes)}，另保留 ${formatBytes(estimate.headroomBytes)} 安全余量`,
      `消息库：当前 ${formatBytes(estimate.messageStoreBytes)}，永久保留且不会自动删除；实际增长取决于消息量`,
      "",
      "本任务不会调用 LLM，不生成报告，不复制图片或视频文件。",
      "每个小块完成后都会保存；失败可继续，取消会清理临时数据库。",
    ].join("\n"));
    if (!confirmed) {
      return;
    }
    await api("/api/run/repair-coverage", { method: "POST", body: JSON.stringify({ batches }) });
    app.logCursor = 0;
    app.logText = "";
    showView("run");
    renderRunView();
    startPolling();
  } catch (error) {
    const errorNode = $("#run-error");
    if (errorNode !== null) {
      errorNode.textContent = error.message;
    } else {
      alert(error.message);
    }
  }
};

const timelineTimeRange = (startUnix, endUnix) =>
  `${unixToHkt(startUnix).slice(0, 16)} - ${unixToHkt(endUnix).slice(5, 16)}`;

const shortTimelineTimeRange = (startUnix, endUnix) =>
  unixToHkt(startUnix).slice(0, 10) === unixToHkt(endUnix).slice(0, 10)
    ? `${unixToHkt(startUnix).slice(11, 16)}-${unixToHkt(endUnix).slice(11, 16)}`
    : `${unixToHkt(startUnix).slice(5, 16)} - ${unixToHkt(endUnix).slice(5, 16)}`;

const timelineMetric = (value, label) =>
  el("div", { class: "timeline-metric" }, el("strong", {}, value), el("span", {}, label));

const repairTimelineSlot = (group, slot) => {
  const batches = group.groupId === "all"
    ? slot.repairBatches
    : timelineGapSegments(slot).map((gap) => ({ groupIds: [group.groupId], ...gap }));
  startCoverageRepair(batches);
};

const groupCoverageDetail = (slot) => {
  if (slot.coverageRatio <= 0) {
    return "没有扫描记录，无法判断这个时段是否存在消息。";
  }
  if (slot.coverageRatio >= 0.999) {
    return "整个时段均有扫描记录，没有时间缺口。";
  }
  const missingSeconds = slot.endUnix - slot.startUnix - slot.coveredSeconds;
  const ranges = (slot.coverageSegments ?? [])
    .slice(0, 3)
    .map((segment) => shortTimelineTimeRange(segment.startUnix, segment.endUnix))
    .join("、");
  const segmentNote = slot.coverageSegmentCount > 3 ? ` 等 ${slot.coverageSegmentCount} 段` : "";
  return `已扫描 ${ranges}${segmentNote}，仍有 ${formatDuration(missingSeconds)} 没有扫描记录。`;
};

const renderGroupTimelinePreview = (group, slot) => {
  const scanStatus = slotScanStatus(slot.coverageRatio);
  const resultStatus = slotResultStatus(slot);
  const resultText = resultStatus === "result"
    ? "已扫描 · 有消息"
    : resultStatus === "no-messages" ? "已扫描 · 无消息" : "无扫描记录";
  const activeSpan = slot.messageCount > 0
    ? shortTimelineTimeRange(slot.firstMessageUnix, slot.lastMessageUnix)
    : null;
  const busiestHourEnd = slot.busiestHourStartUnix === null
    ? null
    : Math.min(slot.endUnix, slot.busiestHourStartUnix + 3600);
  const speakerText = (slot.topSpeakers ?? [])
    .map((speaker) => `${speaker.speaker} ${speaker.messageCount}`)
    .join(" · ");
  const actions = el("div", { class: "timeline-preview-actions" },
    slot.messageCount > 0
      ? el("button", {
          class: "btn small",
          "data-testid": "timeline-open-messages",
          onclick: () => openMessagesView({
            groupId: group.groupId,
            fromUnix: slot.startUnix,
            toUnix: slot.endUnix,
            origin: { view: "run", label: "扫描时间表" },
          }),
        }, "查看该时段消息")
      : null,
    scanStatus !== "complete"
      ? el("button", {
          class: "btn small",
          "data-testid": "timeline-set-rescan-range",
          onclick: () => repairTimelineSlot(group, slot),
        }, `补扫 ${timelineGapSegments(slot).length} 个缺口`)
      : null);

  return el("div", { class: "timeline-preview-content" },
    el("div", { class: "timeline-preview-head" },
      el("div", {}, el("strong", {}, group.name || group.groupId), el("span", {}, timelineTimeRange(slot.startUnix, slot.endUnix))),
      el("span", { class: `timeline-status ${resultStatus}` }, resultText)),
    el("p", { class: "timeline-coverage-note" }, groupCoverageDetail(slot)),
    resultStatus === "unscanned"
      ? el("p", { class: "timeline-result-note" }, "结果未知。灰色表示没有任何扫描记录，而不是没有聊天。")
      : resultStatus === "no-messages"
        ? el("p", { class: "timeline-result-note no-messages" }, "这是有效的扫描结果：已覆盖的时间内没有发现群消息，不等同于漏扫。")
        : el("div", {},
            el("div", { class: "timeline-metrics" },
              timelineMetric(slot.messageCount, "总消息"),
              timelineMetric(slot.textCount, "文本"),
              timelineMetric(slot.mediaCount, "媒体"),
              timelineMetric(slot.speakerCount, "参与者")),
            el("div", { class: "timeline-detail-list" },
              el("span", {}, el("b", {}, "活跃时段"), activeSpan),
              el("span", {}, el("b", {}, "小时峰值"), `${shortTimelineTimeRange(slot.busiestHourStartUnix, busiestHourEnd)} · ${slot.busiestHourMessageCount} 条`),
              el("span", {}, el("b", {}, "主要参与者"), speakerText || "无"))),
    actions);
};

const renderOverallTimelinePreview = (group, slot) => {
  const coverageText = slot.completeGroupCount === slot.totalGroupCount
    ? `全部 ${slot.totalGroupCount} 个目标群均完整扫描。`
    : `完整 ${slot.completeGroupCount} 群，部分 ${slot.partialGroupCount} 群，无记录 ${slot.unscannedGroupCount} 群。`;
  const topGroups = (slot.topGroups ?? []).map((item) => `${item.name} ${item.messageCount}`).join(" · ");
  return el("div", { class: "timeline-preview-content" },
    el("div", { class: "timeline-preview-head" },
      el("div", {}, el("strong", {}, group.name), el("span", {}, timelineTimeRange(slot.startUnix, slot.endUnix))),
      el("span", { class: "timeline-status overall" }, `平均扫描 ${Math.round(slot.coverageRatio * 100)}%`)),
    el("p", { class: "timeline-coverage-note" }, coverageText),
    el("div", { class: "timeline-metrics overall" },
      timelineMetric(slot.activeGroupCount, "有消息的群"),
      timelineMetric(slot.emptyGroupCount, "已扫描无消息"),
      timelineMetric(slot.unscannedGroupCount, "无扫描记录"),
      timelineMetric(slot.messageCount, "总消息")),
    el("p", { class: "timeline-result-note" }, "整体格的纵向颜色高度表示所有目标群在该时段的群时覆盖占比，不代表消息数量。"),
    slot.messageCount > 0
      ? el("div", { class: "timeline-detail-list" },
          el("span", {}, el("b", {}, "内容构成"), `文本 ${slot.textCount} · 媒体 ${slot.mediaCount}`),
          el("span", {}, el("b", {}, "最活跃群"), topGroups))
      : el("p", { class: "timeline-result-note no-messages" }, "所有已扫描群在这个时段都没有发现消息。"),
    slot.coverageRatio < 0.999
      ? el("div", { class: "timeline-preview-actions" },
          el("button", {
            class: "btn small",
            "data-testid": "timeline-set-rescan-range",
            onclick: () => repairTimelineSlot(group, slot),
          }, `补扫 ${slot.repairBatches.length} 个批次`))
      : null);
};

const aggregateTimelineGroups = (groups) => {
  if (groups.length === 0) {
    return null;
  }
  return {
    groupId: "all",
    name: `全部目标群 (${groups.length})`,
    slots: groups[0].slots.map((slot, index) => {
      const members = groups.map((group) => ({ group, slot: group.slots[index] }));
      const activeMembers = members.filter((member) => member.slot.coverageRatio > 0 && member.slot.messageCount > 0);
      const emptyMembers = members.filter((member) => member.slot.coverageRatio > 0 && member.slot.messageCount === 0);
      const repairBatches = mergeAdjacentBatches(members.flatMap((member) =>
        timelineGapSegments(member.slot).map((gap) => ({ groupIds: [member.group.groupId], ...gap }))));
      return {
        ...slot,
        coverageRatio: members.reduce((sum, member) => sum + member.slot.coverageRatio, 0) / groups.length,
        resultCoverageRatio: activeMembers.reduce((sum, member) => sum + member.slot.coverageRatio, 0) / groups.length,
        emptyCoverageRatio: emptyMembers.reduce((sum, member) => sum + member.slot.coverageRatio, 0) / groups.length,
        coveredSeconds: members.reduce((sum, member) => sum + member.slot.coveredSeconds, 0),
        messageCount: members.reduce((sum, member) => sum + member.slot.messageCount, 0),
        textCount: members.reduce((sum, member) => sum + member.slot.textCount, 0),
        mediaCount: members.reduce((sum, member) => sum + member.slot.mediaCount, 0),
        completeGroupCount: members.filter((member) => member.slot.coverageRatio >= 0.999).length,
        partialGroupCount: members.filter((member) => member.slot.coverageRatio > 0 && member.slot.coverageRatio < 0.999).length,
        unscannedGroupCount: members.filter((member) => member.slot.coverageRatio <= 0).length,
        activeGroupCount: activeMembers.length,
        emptyGroupCount: emptyMembers.length,
        totalGroupCount: groups.length,
        repairBatches,
        topGroups: activeMembers
          .map((member) => ({ name: member.group.name || member.group.groupId, messageCount: member.slot.messageCount }))
          .sort((left, right) => right.messageCount - left.messageCount)
          .slice(0, 3),
      };
    }),
  };
};

const currentTimelineGroups = () => {
  const targets = runTargetGroups();
  const targetNames = new Map(targets.map((group) => [group.groupId, group.name]));
  return (app.timeline.data?.groups ?? []).map((group) => ({
    ...group,
    name: group.name || targetNames.get(group.groupId) || "",
  }));
};

const timelineSelectionSummary = () => app.timeline.selection === null
  ? null
  : summarizeTimelineSelection(currentTimelineGroups(), app.timeline.selection);

const setSummaryRangeFromTimeline = (summary) => {
  app.range = {
    type: "custom",
    start: unixToHkt(summary.startUnix),
    end: unixToHkt(summary.endUnix),
  };
  if (summary.groupId !== "all") {
    app.runMode = "groups";
    setRunGroups([summary.groupId]);
  } else {
    app.timeline.selection = null;
  }
  app.runNotice = "已填入时间表选区，确认后点「立即总结」。";
  app.runNoticeTone = "info";
  renderRunView();
  $("#start-input")?.focus();
};

const renderTimelineSelection = (summary) => {
  const isOverall = summary.groupId === "all";
  const resultStatus = summary.coverageRatio <= 0
    ? "unscanned"
    : summary.messageCount > 0 ? "result" : "no-messages";
  const resultText = summary.coverageRatio <= 0
    ? "无扫描记录"
    : summary.messageCount > 0 ? "选区内有消息" : "选区内无消息";
  const activeSpan = summary.firstMessageUnix === null
    ? "无"
    : shortTimelineTimeRange(summary.firstMessageUnix, summary.lastMessageUnix);
  const busiestHourEnd = summary.busiestHourStartUnix === null
    ? null
    : Math.min(summary.endUnix, summary.busiestHourStartUnix + 3600);
  const busiestText = busiestHourEnd === null
    ? "无"
    : `${shortTimelineTimeRange(summary.busiestHourStartUnix, busiestHourEnd)} · ${summary.busiestHourMessageCount} 条`;
  const speakerText = summary.topSpeakers
    .map((speaker) => `${speaker.speaker} ${speaker.messageCount}`)
    .join(" · ") || "无";
  const coverageText = summary.missingSeconds === 0
    ? `扫描覆盖完整，共 ${summary.slotCount} 个连续时间格。`
    : `扫描 ${Math.round(summary.coverageRatio * 100)}%，仍有 ${formatDuration(summary.missingSeconds)} 没有扫描记录。`;
  return el("div", { class: "timeline-preview-content", "data-testid": "timeline-selection-detail" },
    el("div", { class: "timeline-preview-head" },
      el("div", {},
        el("strong", {}, summary.groupName),
        el("span", {}, timelineTimeRange(summary.startUnix, summary.endUnix)),
        el("span", { class: "timeline-pinned" }, `${summary.slotCount} 格 · 已固定`)),
      el("span", { class: `timeline-status ${resultStatus}` }, resultText)),
    el("p", { class: "timeline-coverage-note" }, coverageText),
    el("div", { class: "timeline-metrics" },
      timelineMetric(summary.messageCount, "总消息"),
      timelineMetric(summary.textCount, "文本"),
      timelineMetric(summary.mediaCount, "媒体"),
      timelineMetric(isOverall ? summary.activeGroupCount : summary.speakerCount, isOverall ? "有消息的群" : "参与者计次")),
    el("div", { class: "timeline-detail-list" },
      el("span", {}, el("b", {}, "活跃跨度"), activeSpan),
      el("span", {}, el("b", {}, "小时峰值"), busiestText),
      el("span", {}, el("b", {}, "主要参与者"), speakerText),
      isOverall ? el("span", {}, el("b", {}, "受影响群"), `${summary.affectedGroupCount}/${summary.totalGroupCount}`) : null,
      isOverall ? el("span", {}, el("b", {}, "已扫无消息"), `${summary.emptyGroupCount} 群`) : null,
      isOverall ? el("span", {}, el("b", {}, "完全无记录"), `${summary.unscannedGroupCount} 群`) : null),
    el("div", { class: "timeline-preview-actions" },
      !isOverall && summary.messageCount > 0
        ? el("button", {
            class: "btn small",
            "data-testid": "timeline-open-selection-messages",
            onclick: () => openMessagesView({
              groupId: summary.groupId,
              fromUnix: summary.startUnix,
              toUnix: summary.endUnix,
              origin: { view: "run", label: "扫描时间表" },
            }),
          }, "查看选区消息")
        : null,
      summary.mediaCount > 0
        ? el("button", {
            class: "btn small",
            "data-testid": "timeline-open-gallery",
            onclick: () => openGalleryRange({
              groupId: summary.groupId,
              fromUnix: summary.startUnix,
              toUnix: summary.endUnix,
            }),
          }, "打开选区画廊")
        : null,
      summary.repairBatches.length > 0
        ? el("button", {
            class: "btn small",
            "data-testid": "timeline-repair-selection",
            onclick: () => startCoverageRepair(summary.repairBatches),
          }, `补扫 ${summary.repairBatches.length} 个缺口批次`)
        : null,
      el("button", {
        class: "btn small",
        "data-testid": "timeline-use-selection",
        onclick: () => setSummaryRangeFromTimeline(summary),
      }, "设为总结范围"),
      el("button", {
        class: "btn small quiet",
        "data-testid": "timeline-clear-selection",
        onclick: () => {
          app.timeline.selection = null;
          renderRunView();
        },
      }, "清除选择")));
};

const renderTimelinePreview = () => {
  const summary = timelineSelectionSummary();
  if (summary !== null) {
    return renderTimelineSelection(summary);
  }
  const preview = app.timeline.preview;
  if (preview === null) {
    return el("span", {}, "悬停可快速查看；单击固定详情，Shift + 单击或拖动可选择连续时间格。");
  }
  const { group, slot } = preview;
  return group.groupId === "all" ? renderOverallTimelinePreview(group, slot) : renderGroupTimelinePreview(group, slot);
};

const renderCoverageHealth = (health, visibleGroupCount, totalGroupCount) => {
  const unreadTotal = (app.state?.watchHealth ?? [])
    .filter((entry) => runTargetGroups().some((target) => target.groupId === entry.groupId))
    .reduce((total, entry) => total + entry.localUnviewedCount, 0);
  const complete = health.missingSeconds === 0;
  return el("div", { class: `coverage-health ${complete ? "complete" : "gaps"}`, "data-testid": "coverage-health" },
    el("div", { class: "coverage-health-main" },
      el("strong", {}, complete ? "当前范围没有扫描缺口" : `发现 ${health.batches.length} 个补扫批次`),
      el("span", {}, `${app.timeline.days} 天群时覆盖 ${Math.round(health.coverageRatio * 100)}% · 基于全部 ${totalGroupCount} 群${visibleGroupCount === totalGroupCount ? "" : ` · 当前显示 ${visibleGroupCount} 群`}`)),
    el("div", { class: "coverage-health-metrics" },
      timelineMetric(formatDuration(health.missingSeconds), "缺失群时"),
      timelineMetric(health.affectedGroupCount, "受影响群"),
      timelineMetric(health.earliestGapUnix === null ? "无" : unixToHkt(health.earliestGapUnix).slice(5, 16), "最早缺口"),
      timelineMetric(unreadTotal > 99 ? "99+" : unreadTotal, "本地未查看")),
    complete
      ? null
      : el("button", {
          class: "btn primary",
          "data-testid": "repair-all-gaps",
          onclick: () => startCoverageRepair(health.batches),
        }, "评估并安全补扫"));
};

const slotFillNodes = (group, slot) => {
  if (group.groupId === "all") {
    return [
      el("span", { class: "timeline-slot-fill result aggregate", style: `top:0;height:${slot.resultCoverageRatio * 100}%` }),
      el("span", {
        class: "timeline-slot-fill no-messages aggregate",
        style: `top:${slot.resultCoverageRatio * 100}%;height:${slot.emptyCoverageRatio * 100}%`,
      }),
    ];
  }
  const resultStatus = slotResultStatus(slot);
  return (slot.coverageSegments ?? []).map((segment) => {
    const duration = slot.endUnix - slot.startUnix;
    const left = ((segment.startUnix - slot.startUnix) / duration) * 100;
    const width = ((segment.endUnix - segment.startUnix) / duration) * 100;
    return el("span", { class: `timeline-slot-fill ${resultStatus}`, style: `left:${left}%;width:${width}%` });
  });
};

const refreshTimelineSelection = () => {
  for (const slot of document.querySelectorAll(".timeline-slot")) {
    const selected = isTimelineSlotSelected(
      app.timeline.selection,
      slot.dataset.timelineGroup,
      Number(slot.dataset.slotIndex),
    );
    slot.classList.toggle("selected", selected);
    slot.setAttribute("aria-pressed", String(selected));
  }
  const preview = $("#timeline-preview");
  if (preview !== null) {
    setChildren(preview, renderTimelinePreview());
  }
};

const selectTimelineSlot = (groupId, index, extend) => {
  const current = app.timeline.selection;
  const sameSingleSlot = !extend && current !== null && current.groupId === groupId &&
    current.startIndex === index && current.endIndex === index;
  app.timeline.selection = sameSingleSlot
    ? null
    : extendTimelineSelection(extend ? current : null, groupId, index);
  refreshTimelineSelection();
};

const timelineEventsForSlot = (group, slot, events) => {
  if (group.groupId === "all") {
    return [];
  }
  return events.filter((event) => event.startUnix < slot.endUnix && event.endUnix + 1 > slot.startUnix);
};

const renderTimelineRow = (group, events) =>
  el("div", { class: "timeline-row", dataset: { timelineGroup: group.groupId } },
    el("div", { class: "timeline-name", title: group.name || group.groupId }, group.name || group.groupId),
    el("div", { class: "timeline-slots" }, group.slots.map((slot, index) =>
      el("button", {
        type: "button",
        dataset: { timelineGroup: group.groupId, slotIndex: String(index), slotStart: String(slot.startUnix) },
        class: `timeline-slot scan-${slotScanStatus(slot.coverageRatio)} ${isTimelineSlotSelected(app.timeline.selection, group.groupId, index) ? "selected" : ""}`,
        "aria-label": timelineSlotLabel(group, slot),
        "aria-pressed": String(isTimelineSlotSelected(app.timeline.selection, group.groupId, index)),
        title: timelineSlotLabel(group, slot),
        onpointerdown: (event) => {
          if (event.button !== 0) {
            return;
          }
          event.preventDefault();
          selectTimelineSlot(group.groupId, index, event.shiftKey);
          app.timeline.dragging = app.timeline.selection !== null;
        },
        onpointerenter: () => {
          if (app.timeline.dragging && app.timeline.selection?.groupId === group.groupId) {
            app.timeline.selection = extendTimelineSelection(app.timeline.selection, group.groupId, index);
            refreshTimelineSelection();
            return;
          }
          previewTimelineSlot(group, slot);
        },
        onpointerleave: clearTimelinePreview,
        onfocus: () => previewTimelineSlot(group, slot),
        onkeydown: (event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            selectTimelineSlot(group.groupId, index, event.shiftKey);
          }
        },
      },
      slotFillNodes(group, slot),
      (() => {
        const unreviewedCount = timelineEventsForSlot(group, slot, events)
          .filter((event) => (app.mediaTab.reviews[event.id]?.status ?? "unreviewed") === "unreviewed").length;
        return unreviewedCount > 0
          ? el("span", {
              class: "timeline-review-count",
              title: `${unreviewedCount} 个未审阅媒体事件`,
            }, unreviewedCount)
          : null;
      })()))));

const showPreviousTimelineWindow = (data) => {
  app.timeline.windowEndUnix = data.fromUnix;
  invalidateRunTimeline();
  renderRunView();
};

const showNextTimelineWindow = (data) => {
  const nowUnix = Math.floor(Date.now() / 1000);
  const nextEndUnix = data.toUnix + app.timeline.days * 24 * 60 * 60;
  app.timeline.windowEndUnix = nextEndUnix >= nowUnix ? null : nextEndUnix;
  invalidateRunTimeline();
  renderRunView();
};

const showCurrentTimelineWindow = () => {
  app.timeline.windowEndUnix = null;
  invalidateRunTimeline();
  renderRunView();
};

const timelineOption = (value, label) => el("option", { value }, label);

const renderTimelineToolbar = (data) => el("div", { class: "timeline-toolbar", "data-testid": "timeline-toolbar" },
  el("label", {}, el("span", {}, "状态"), el("select", {
    "data-testid": "timeline-filter",
    onchange: (event) => {
      app.timeline.filter = event.target.value;
      app.timeline.selection = null;
      renderRunView();
    },
  },
  [
    timelineOption("all", "全部"),
    timelineOption("gaps", "有扫描缺口"),
    timelineOption("result", "有消息"),
    timelineOption("no-messages", "已扫描无消息"),
    timelineOption("unscanned", "无扫描记录"),
  ].map((option) => {
    option.selected = option.value === app.timeline.filter;
    return option;
  }))),
  el("label", {}, el("span", {}, "群排序"), el("select", {
    "data-testid": "timeline-sort",
    onchange: (event) => {
      app.timeline.sort = event.target.value;
      app.timeline.selection = null;
      renderRunView();
    },
  },
  [
    timelineOption("default", "原顺序"),
    timelineOption("gaps", "缺口最多"),
    timelineOption("messages", "消息最多"),
    timelineOption("recent", "最近活跃"),
  ].map((option) => {
    option.selected = option.value === app.timeline.sort;
    return option;
  }))),
  el("div", { class: "timeline-window-controls" },
    el("button", {
      type: "button",
      class: "btn icon-btn",
      title: "前一个时间窗口",
      "aria-label": "前一个时间窗口",
      "data-testid": "timeline-window-previous",
      onclick: () => showPreviousTimelineWindow(data),
    }, "←"),
    app.timeline.windowEndUnix === null
      ? el("span", { class: "timeline-window-label" }, "当前窗口")
      : el("button", {
          type: "button",
          class: "btn small",
          "data-testid": "timeline-window-current",
          onclick: showCurrentTimelineWindow,
        }, "回到现在"),
    el("button", {
      type: "button",
      class: "btn icon-btn",
      title: "后一个时间窗口",
      "aria-label": "后一个时间窗口",
      "data-testid": "timeline-window-next",
      disabled: app.timeline.windowEndUnix === null,
      onclick: () => showNextTimelineWindow(data),
    }, "→")));

const renderRunTimeline = () => {
  const targets = runTargetGroups();
  const data = app.timeline.data;
  const matchesCurrentTargets = app.timeline.key === timelineKey();
  const targetNames = new Map(targets.map((group) => [group.groupId, group.name]));
  const groups = matchesCurrentTargets
    ? (data?.groups ?? []).map((group) => ({ ...group, name: group.name || targetNames.get(group.groupId) || "" }))
    : [];
  const visibleGroups = sortTimelineGroups(filterTimelineGroups(groups, app.timeline.filter), app.timeline.sort);
  const overall = aggregateTimelineGroups(groups);
  const mediaEventsByGroup = app.mediaTab.data === null
    ? new Map()
    : new Map(groups.map((group) => [
        group.groupId,
        buildTimelineGalleryEvents(
          app.mediaTab.data.items.filter((item) => item.dup !== true && item.groupId === group.groupId),
          TIMELINE_GALLERY_EVENT_GAP_SECONDS,
        ),
      ]));
  return el("div", { class: "card timeline-card", id: "run-timeline", "data-testid": "coverage-timeline" },
    el("div", { class: "timeline-head" },
      el("div", {},
        el("h2", {}, "扫描时间表"),
        el("p", { class: "card-sub" }, "颜色表示扫描结果，格内灰色余量表示尚未扫描的时间。")),
      el("div", { class: "timeline-range", role: "group", "aria-label": "时间表范围" },
        [1, 7, 30].map((days) => el("button", {
          class: `chip ${app.timeline.days === days ? "on" : ""}`,
          onclick: () => {
            app.timeline.days = days;
            invalidateRunTimeline();
            renderRunView();
          },
        }, `${days} 天`)))),
    targets.length === 0
      ? el("div", { class: "empty" }, "选择群后，这里会显示整体与逐群扫描时间表。")
      : app.timeline.loading || !matchesCurrentTargets
        ? el("div", { class: "empty" }, "正在读取扫描记录…")
        : app.timeline.error !== null
          ? el("div", { class: "notice risk" }, app.timeline.error)
          : el("div", {},
              renderCoverageHealth(data.health, visibleGroups.length, groups.length),
              renderTimelineToolbar(data),
              el("div", { class: "timeline-scroll" },
              el("div", { class: "timeline-axis" },
                el("span", {}),
                el("span", {}, unixToHkt(data.fromUnix).slice(5, 10)),
                el("span", {}, unixToHkt(data.toUnix).slice(5, 10))),
              overall === null ? null : renderTimelineRow(overall, []),
              visibleGroups.length === 0
                ? el("div", { class: "timeline-filter-empty", "data-testid": "timeline-filter-empty" }, "当前筛选没有匹配的群。")
                : visibleGroups.map((group) => renderTimelineRow(group, mediaEventsByGroup.get(group.groupId) ?? [])))),
    el("div", { class: "timeline-legend" },
      el("span", {}, el("i", { class: "result" }), "已扫描 · 有消息"),
      el("span", {}, el("i", { class: "no-messages" }), "已扫描 · 无消息"),
      el("span", {}, el("i", { class: "unscanned" }), "无扫描记录"),
      el("span", {}, el("i", { class: "partial-scan" }), "逐群：横向位置 = 扫描时段"),
      el("span", {}, el("i", { class: "overall-share" }), "整体：纵向占比 = 群覆盖情况")),
    el("div", { class: "timeline-preview", id: "timeline-preview", "aria-live": "polite" }, renderTimelinePreview()));
};

const renderRunView = () => {
  const watchlist = app.state?.watchlist ?? [];
  const defaults = app.state?.runDefaults ?? {};

  const modeChip = (mode, label) =>
    el("button", {
      "data-testid": `run-mode-${mode}`,
      class: `chip ${app.runMode === mode ? "on" : ""}`,
      onclick: () => {
        app.runMode = mode;
        app.runGroups.open = false;
        invalidateRunTimeline();
        renderRunView();
      },
    }, label);

  const targetRow = app.runMode === "watchlist"
    ? el("div", { class: "row", style: "margin-bottom:14px" },
        watchlist.length > 0
          ? watchlist.map((entry) => el("span", { class: "tag" }, entry.name || entry.groupId))
          : el("span", { class: "tag plain" }, "还没有关注群，先到「关注群」页添加"))
    : el("div", { class: "row", style: "margin-bottom:14px" },
        renderGroupPicker());

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
        el("input", { type: "text", id: "end-input", placeholder: "结束（留空 = 现在）", style: "width:230px", value: app.range.end ?? "" }),
        el("span", { class: "card-sub", style: "margin:0;flex-basis:100%" }, "时间按北京时间（UTC+8）解析，与界面显示一致。"))
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
      el("span", { id: "run-error", class: `run-feedback ${app.runNoticeTone}` }, app.runNotice)));

  const jobCard = el("div", { class: "card", id: "job-card", hidden: app.job === null },
    el("h2", {}, "任务状态"),
    el("div", { id: "job-body" }));

  setChildren($("#view-run"), runCard, renderRunTimeline(), jobCard);
  renderJobPanel();
  loadRunTimeline();
};

const collectRunRequest = () => {
  const range = { ...app.range };
  if (range.type === "custom") {
    range.start = $("#start-input").value.trim();
    range.end = $("#end-input").value.trim();
    app.range = range;
  }
  if (app.runMode === "groups") {
    const pending = app.runGroups.query.trim();
    const pendingIds = pending.length === 0 ? [] : pending.split(/[,;，；\s]+/u).filter(Boolean);
    const groupIds = [...new Set([...app.runGroups.selected, ...pendingIds])];
    return { mode: "groups", groupIds, range };
  }
  return { mode: "watchlist", range };
};

const startRun = async () => {
  app.runNotice = "";
  app.runNoticeTone = "info";
  $("#run-error").textContent = "";
  try {
    const request = collectRunRequest();
    if (request.range.type === "sinceStore") {
      const resolved = await resolveSinceStoreRange(request);
      request.range = resolved.range;
      if (resolved.warning !== null) {
        app.runNotice = resolved.warning;
        app.runNoticeTone = "warn";
        $("#run-error").textContent = resolved.warning;
      }
    }
    await api("/api/run", { method: "POST", body: JSON.stringify(request) });
    app.logCursor = 0;
    app.logText = "";
    startPolling();
  } catch (error) {
    app.runNotice = error.message;
    app.runNoticeTone = "risk";
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
      stage.key === "analyze" && job.groupsDone > 0 ? el("small", {}, ` 已完成 ${job.groupsDone} 个群`) : null,
      stage.key === "repair" && (job.groupsDone > 0 || job.repairFailures > 0)
        ? el("small", {}, ` 已保存 ${job.groupsDone} 个块${job.repairFailures > 0 ? `，失败 ${job.repairFailures} 个` : ""}`)
        : null));

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
      job.repairTotal > 1
        ? el("span", { class: "tag plain" }, `第 ${job.repairCurrent ?? 1}/${job.repairTotal} ${job.type === "coverage-repair" ? "块" : "批"}`)
        : null,
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
    job.type === "coverage-repair" && job.repairFailures > 0
      ? el("div", { class: "notice warn" }, "失败块不会写入覆盖记录，也不会阻止其他块继续；再次运行同一缺口时只重试未完成块。")
      : null,
    job.llmFailures > 0 ? el("div", { class: "notice warn" }, `${job.llmFailures} 个群的 LLM 摘要失败，已降级为本地分组。`) : null,
    el("div", { class: "stages" }, stageNodes),
    resultRow,
    job.status === "done" && job.type === "coverage-repair"
      ? el("div", { class: "notice ok" }, `已保存 ${job.repairTotal ?? 1} 个覆盖补扫块；未调用 LLM，也未复制媒体文件。扫描时间表已刷新。`)
      : null,
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
    // A finished run may have produced new media; drop the cached join map so
    // the chat inlines them without a page reload.
    app.msg.mediaMap = null;
    app.msg.mediaRowMap = null;
    app.msg.mediaMapAt = 0;
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

  const filters = app.historyFilters;
  const groupNames = new Map([...(app.state?.knownGroups ?? []), ...(app.state?.watchlist ?? [])]
    .map((group) => [group.groupId, group.name || group.groupId]));
  const knownGroups = [...new Map(runs
    .flatMap((run) => (run.groupIds ?? []).map((groupId) => [groupId, groupNames.get(groupId) ?? groupId]))).entries()];
  const filteredRuns = runs.filter((run) => {
    const query = filters.query.trim().toLowerCase();
    const matchesQuery = query.length === 0
      || run.groups.toLowerCase().includes(query)
      || run.summary.toLowerCase().includes(query)
      || run.runId.toLowerCase().includes(query);
    const matchesGroup = filters.groupId === "all" || (run.groupIds ?? []).includes(filters.groupId);
    const matchesCoverage = filters.coverage === "all" || run.scanCoverage?.status === filters.coverage;
    return matchesQuery && matchesGroup && matchesCoverage;
  });
  const signatures = new Map();
  const duplicateRunIds = new Set();
  for (const run of runs) {
    const signature = JSON.stringify({
      groupIds: [...(run.groupIds ?? [])].sort(),
      start: run.scanCoverage?.requestedStartUnix ?? run.firstMessageHkt,
      end: run.scanCoverage?.requestedEndUnix ?? run.lastMessageHkt,
      text: run.textMessages,
      media: run.mediaMessages,
    });
    if (signatures.has(signature)) {
      duplicateRunIds.add(run.runId);
    } else {
      signatures.set(signature, run.runId);
    }
  }
  const coverageText = (coverage) => {
    if (coverage?.status === "complete") {
      return "扫描完整";
    }
    if (coverage?.status === "partial") {
      return `扫描 ${Math.round(coverage.coverageRatio * 100)}%`;
    }
    if (coverage?.status === "none") {
      return "没有有效扫描";
    }
    return "扫描完整性未知";
  };
  const aiText = (coverage) => {
    if (coverage?.status === "not-used") {
      return "未使用 AI";
    }
    if (coverage?.status === "complete") {
      return `AI ${coverage.includedMessages}/${coverage.totalMessages}`;
    }
    if (coverage?.status === "empty") {
      return "AI 无文本输入";
    }
    if (coverage?.status === "unknown") {
      return "AI 输入覆盖未知";
    }
    return `AI ${coverage?.includedMessages ?? 0}/${coverage?.totalMessages ?? 0}`;
  };
  const controls = el("div", { class: "history-toolbar", "data-testid": "history-filters" },
    el("input", {
      type: "search",
      placeholder: "搜索群名、摘要或运行 ID",
      value: filters.query,
      oninput: (event) => {
        filters.query = event.target.value;
        renderHistoryView();
      },
    }),
    el("select", {
      value: filters.groupId,
      onchange: (event) => {
        filters.groupId = event.target.value;
        renderHistoryView();
      },
    },
      el("option", { value: "all" }, "全部群"),
      knownGroups.map(([groupId, name]) => el("option", { value: groupId }, `${name} · ${groupId}`))),
    el("select", {
      value: filters.coverage,
      onchange: (event) => {
        filters.coverage = event.target.value;
        renderHistoryView();
      },
    },
      el("option", { value: "all" }, "全部扫描状态"),
      el("option", { value: "complete" }, "扫描完整"),
      el("option", { value: "partial" }, "部分扫描"),
      el("option", { value: "unknown" }, "完整性未知"),
      el("option", { value: "none" }, "没有有效扫描")),
    el("span", { class: "card-sub" }, `${filteredRuns.length}/${runs.length} 份报告`));

  setChildren($("#view-history"), 
    controls,
    filteredRuns.length === 0 ? el("div", { class: "card empty" }, "没有符合筛选条件的报告。") : null,
    ...filteredRuns.map((run) =>
      el("div", { class: "card run-card" },
        el("div", {},
          el("div", { class: "meta-line" },
            run.scanCoverage?.requestedStartUnix === null
              ? `${run.firstMessageHkt} — ${run.lastMessageHkt}`
              : `${unixToHkt(run.scanCoverage.requestedStartUnix).slice(0, 16)} — ${unixToHkt(run.scanCoverage.requestedEndUnix).slice(0, 16)}`),
          el("h3", {},
            run.isDigest ? el("span", { class: "tag" }, "多群") : null,
            run.isDigest ? " " : null,
            /^\d+$/u.test(run.groups) && run.groupIds?.length === 1
              ? `${groupNames.get(run.groupIds[0]) ?? run.groups} (${run.groups})`
              : run.groups),
          el("p", {}, run.summary),
          el("div", { class: "report-status-row" },
            el("span", { class: `report-status ${run.scanCoverage?.status ?? "unknown"}` }, coverageText(run.scanCoverage)),
            el("span", { class: `report-status ${run.aiCoverage?.status ?? "not-used"}` }, aiText(run.aiCoverage)),
            run.firstMessageHkt === "N/A" ? el("span", { class: "report-status unknown" }, "无消息范围") : null,
            duplicateRunIds.has(run.runId) ? el("span", { class: "report-status duplicate" }, "可能重复") : null),
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
  await loadState();
  renderWatchlistView();
};

const renderWatchlistView = () => {
  const watchlist = app.state?.watchlist ?? [];
  const knownGroups = app.state?.knownGroups ?? [];
  const watchIds = new Set(watchlist.map((entry) => entry.groupId));
  const query = app.watchSearch.trim().toLowerCase();
  const healthById = new Map((app.state?.watchHealth ?? []).map((entry) => [entry.groupId, entry]));
  const filtered = knownGroups.filter(
    (group) => query.length === 0 || group.groupId.includes(query) || group.name.toLowerCase().includes(query));

  const watchRow = (entry) => {
    const health = healthById.get(entry.groupId);
    const healthText = health === undefined
      ? "尚无健康数据"
      : health.missingSeconds === 0
        ? `7 天完整 · 最近扫描 ${unixToHkt(health.latestScanUnix).slice(5, 16)}`
        : `7 天覆盖 ${Math.round(health.coverageRatio * 100)}% · 缺 ${formatDuration(health.missingSeconds)}`;
    return (
    el("div", { class: "wl-row" },
      el("div", {},
        el("span", { class: "gname" }, entry.name || entry.groupId),
        el("span", { class: "gid" }, entry.groupId),
        el("span", { class: `watch-health ${health?.missingSeconds === 0 ? "complete" : "gaps"}` }, healthText),
        health?.localUnviewedCount > 0
          ? el("span", { class: "watch-unviewed" }, `${health.localUnviewedCount > 99 ? "99+" : health.localUnviewedCount} 条本地未查看`)
          : null),
      el("button", {
        class: "btn small danger",
        onclick: () => updateWatchlist({ remove: [entry.groupId] }).catch((error) => alert(error.message)),
      }, "移除")));
  };

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
          : [...watchlist].sort((left, right) =>
              (healthById.get(right.groupId)?.missingSeconds ?? 0) - (healthById.get(left.groupId)?.missingSeconds ?? 0))
            .map(watchRow)),
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
  } else if (app.view === "knowledge") {
    // Loads on first visit, then renders from cached state.
    ensureKnowledgeLoaded();
  } else if (app.view === "storage") {
    renderStorageView();
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
    openMediaView(false);
    return;
  }
  if (name === "settings") {
    openSettingsView();
    return;
  }
  if (name === "storage") {
    openStorageView();
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
  window.addEventListener("pointerup", () => {
    app.timeline.dragging = false;
  });
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
