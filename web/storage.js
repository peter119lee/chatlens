"use strict";

const storageState = {
  overview: null,
  measurements: new Map(),
  measuring: new Set(),
  errors: new Map(),
  notice: null,
  requestId: 0,
};

const STORAGE_SECTIONS = [
  { id: "protected", title: "受保护的 QQ 与工具数据", description: "这些位置只能查看。控制台没有删除入口。" },
  { id: "important", title: "重要数据库、媒体与续跑记录", description: "长期保存的索引、媒体副本和进度；各项占用会分别显示。" },
  { id: "regenerable", title: "可重新生成", description: "任务结束后可以清理；需要时工具会重新创建。" },
  { id: "history", title: "历史输出", description: "可以删除，但会失去对应报告、导出文件或媒体预览。" },
];

const storagePolicyClass = (policy) => {
  if (policy === "protected") {
    return "protected";
  }
  if (policy === "keep") {
    return "keep";
  }
  if (policy === "cleanup") {
    return "cleanup";
  }
  return "deletable";
};

const storageMeasuredBytes = (itemIds) => itemIds.reduce((total, itemId) => {
  const measurement = storageState.measurements.get(itemId);
  return total + (measurement?.bytes ?? 0);
}, 0);

const storageMeasurementCell = (item) => {
  const measurement = storageState.measurements.get(item.id);
  const error = storageState.errors.get(item.id);
  if (storageState.measuring.has(item.id)) {
    return el("div", { class: "storage-size measuring" },
      el("strong", {}, "正在计算…"),
      el("span", {}, ["qq-media-cache", "knowledge-media"].includes(item.id) ? "大型目录可能需要较久" : "逐项读取文件元数据"));
  }
  if (error !== undefined) {
    return el("div", { class: "storage-size error" },
      el("strong", {}, "计算失败"),
      el("span", { title: error }, error));
  }
  if (measurement === undefined) {
    return el("div", { class: "storage-size pending" },
      el("strong", {}, "未计算"),
      el("span", {}, item.measurement === "manual" ? "按需计算，避免磁盘长时间繁忙" : "等待计算"));
  }
  const detail = `${measurement.fileCount.toLocaleString()} 个文件` +
    (measurement.skippedSymlinkCount > 0 ? ` · 跳过 ${measurement.skippedSymlinkCount} 个链接` : "") +
    (measurement.changedPathCount > 0 ? ` · ${measurement.changedPathCount} 项在计算时变化` : "");
  return el("div", { class: "storage-size" },
    el("strong", {}, formatBytes(measurement.bytes)),
    el("span", {}, detail));
};

const storageMeasureCategory = async (category) => {
  if (storageState.measuring.has(category)) {
    return;
  }
  storageState.measuring.add(category);
  storageState.errors.delete(category);
  renderStorageView();
  try {
    const measurement = await api("/api/storage/measure", {
      method: "POST",
      body: JSON.stringify({ category }),
    });
    storageState.measurements.set(category, measurement);
  } catch (error) {
    storageState.errors.set(category, error.message);
  }
  storageState.measuring.delete(category);
  renderStorageView();
};

const storageRefreshAutomatic = async (requestId) => {
  const items = storageState.overview?.items ?? [];
  for (const item of items.filter((candidate) => candidate.measurement === "automatic")) {
    if (requestId !== storageState.requestId) {
      return;
    }
    await storageMeasureCategory(item.id);
  }
};

const storageOpenCategory = async (category) => {
  try {
    await api("/api/storage/open", {
      method: "POST",
      body: JSON.stringify({ category }),
    });
  } catch (error) {
    storageState.notice = { text: error.message, tone: "risk" };
    renderStorageView();
  }
};

const storageCleanupPrompt = (item) => {
  if (item.id === "temporary-files") {
    return [
      "确定清理所有临时数据库副本？",
      "",
      "不会删除消息库、报告、媒体副本或补扫检查点。",
      "下次扫描可能需要重新复制 QQ 数据库。",
    ].join("\n");
  }
  if (item.id === "run-files") {
    return [
      "确定删除所有运行产物与媒体副本？",
      "",
      "工具消息库和咒语库长期媒体副本仍会保留，但历史报告里的媒体预览、聊天内嵌媒体和运行详情可能失效。",
      "此操作不可撤销。",
    ].join("\n");
  }
  return [
    "确定删除所有报告与导出文件？",
    "",
    "HTML/Markdown 报告、媒体导出和咒语库导出都会消失。",
    "消息库与运行产物不会同时删除。此操作不可撤销。",
  ].join("\n");
};

const storageCleanupCategory = async (item, button) => {
  if (!window.confirm(storageCleanupPrompt(item))) {
    return;
  }
  button.disabled = true;
  storageState.notice = { text: `正在清理「${item.label}」…`, tone: "warn" };
  renderStorageView();
  try {
    const result = await api("/api/storage/cleanup", {
      method: "POST",
      body: JSON.stringify({ category: item.cleanupCategory, confirmation: item.cleanupCategory }),
    });
    const diskDelta = result.freeDiskDeltaBytes > 0
      ? `，磁盘可用空间增加 ${formatBytes(result.freeDiskDeltaBytes)}`
      : "";
    const warnings = result.warnings.length > 0 ? `；注意：${result.warnings.join("；")}` : "";
    storageState.notice = {
      text: `已删除 ${formatBytes(result.deletedBytes)}，共 ${result.removedFileCount.toLocaleString()} 个文件${diskDelta}${warnings}`,
      tone: result.warnings.length > 0 ? "warn" : "ok",
    };
    storageState.measurements.clear();
    storageState.errors.clear();
    storageState.overview = await api("/api/storage/overview");
    await loadState();
    renderStorageView();
    await storageRefreshAutomatic(storageState.requestId);
  } catch (error) {
    storageState.notice = { text: error.message, tone: "risk" };
    renderStorageView();
  }
};

const storageActions = (item) => {
  const measureButton = el("button", {
    class: "icon-btn storage-icon-button",
    title: item.measurement === "manual" ? "计算此目录占用（可能较久）" : "重新计算占用",
    "aria-label": item.measurement === "manual" ? "计算占用" : "重新计算占用",
    "data-testid": `storage-measure-${item.id}`,
    disabled: storageState.measuring.has(item.id),
    onclick: () => storageMeasureCategory(item.id),
  }, "↻");
  const openButton = el("button", {
    class: "icon-btn storage-icon-button",
    title: item.openable ? "在资源管理器中打开位置" : "路径当前不存在",
    "aria-label": "打开位置",
    "data-testid": `storage-open-${item.id}`,
    disabled: !item.openable,
    onclick: () => storageOpenCategory(item.id),
  }, "📂");
  const cleanupButton = item.cleanupCategory === null
    ? null
    : el("button", {
        class: "btn small danger",
        title: item.cleanupAllowed ? item.cleanupImpact : item.cleanupBlockedReason,
        "data-testid": `storage-cleanup-${item.id}`,
        disabled: !item.cleanupAllowed,
        onclick: (event) => storageCleanupCategory(item, event.currentTarget),
      }, item.id === "temporary-files" ? "清理" : "删除全部");
  return el("div", { class: "storage-actions" }, measureButton, openButton, cleanupButton);
};

const storageRow = (item) => el("div", {
  class: "storage-row",
  "data-testid": `storage-row-${item.id}`,
},
el("div", { class: "storage-item" },
  el("strong", {}, item.label),
  el("span", {}, item.description),
  el("small", {}, item.cleanupImpact)),
el("div", { class: "storage-paths" },
  item.paths.length === 0
    ? el("code", {}, "尚未配置")
    : item.paths.map((itemPath) => el("code", { title: itemPath }, itemPath))),
storageMeasurementCell(item),
el("div", { class: "storage-policy" },
  el("span", { class: `storage-policy-badge ${storagePolicyClass(item.policy)}` }, item.policyLabel),
  item.cleanupBlockedReason !== null && item.cleanupCategory !== null
    ? el("small", {}, item.cleanupBlockedReason)
    : null),
storageActions(item));

const storageSummary = (overview) => {
  const toolIds = overview.items
    .filter((item) => item.id !== "qq-databases" && item.id !== "qq-media-cache")
    .map((item) => item.id);
  const qqIds = ["qq-databases", "qq-media-cache"];
  const measuredCount = overview.items.filter((item) => storageState.measurements.has(item.id)).length;
  const volumeNodes = overview.volumes.map((volume) =>
    volume.error === null
      ? el("div", { class: "storage-summary-cell" },
          el("span", {}, `${volume.root} 可用空间`),
          el("strong", {}, formatBytes(volume.freeBytes)),
          el("small", {}, `总容量 ${formatBytes(volume.totalBytes)}`))
      : el("div", { class: "storage-summary-cell risk" },
          el("span", {}, `${volume.root || "磁盘"} 状态`),
          el("strong", {}, "无法读取"),
          el("small", { title: volume.error }, volume.error)));
  return el("div", { class: "storage-summary", "data-testid": "storage-summary" },
    el("div", { class: "storage-summary-cell" },
      el("span", {}, "本工具已计算占用"),
      el("strong", {}, formatBytes(storageMeasuredBytes(toolIds))),
      el("small", {}, `${measuredCount}/${overview.items.length} 项已有结果`)),
    el("div", { class: "storage-summary-cell" },
      el("span", {}, "QQ 已计算占用"),
      el("strong", {}, formatBytes(storageMeasuredBytes(qqIds))),
      el("small", {}, storageState.measurements.has("qq-media-cache") ? "包含媒体缓存" : "媒体缓存尚未计算")),
    volumeNodes);
};

const renderStorageView = () => {
  const root = $("#view-storage");
  if (storageState.overview === null) {
    setChildren(root, el("div", { class: "card" }, el("div", { class: "empty" }, "正在读取存储位置…")));
    return;
  }
  const overview = storageState.overview;
  const notice = storageState.notice === null
    ? null
    : el("div", { class: `notice ${storageState.notice.tone}` }, storageState.notice.text);
  const sections = STORAGE_SECTIONS.map((section) => {
    const items = overview.items.filter((item) => item.section === section.id);
    return el("section", { class: "storage-section", "aria-labelledby": `storage-section-${section.id}` },
      el("div", { class: "storage-section-head" },
        el("div", {},
          el("h2", { id: `storage-section-${section.id}` }, section.title),
          el("p", {}, section.description))),
      el("div", { class: "storage-table" },
        el("div", { class: "storage-table-head", "aria-hidden": "true" },
          el("span", {}, "数据"),
          el("span", {}, "位置"),
          el("span", {}, "占用"),
          el("span", {}, "删除规则"),
          el("span", {}, "操作")),
        items.map(storageRow)));
  });
  setChildren(root,
    el("div", { class: "storage-toolbar", "data-testid": "storage-view" },
      el("div", {},
        el("strong", {}, "容量计算不会读取文件内容，也不会跟随目录链接。"),
        el("span", {}, "QQ 媒体缓存可能包含大量小文件，因此只在你点击该行的刷新按钮后计算。")),
      el("button", {
        class: "btn small",
        "data-testid": "storage-refresh",
        disabled: storageState.measuring.size > 0,
        onclick: async () => {
          storageState.measurements.clear();
          storageState.errors.clear();
          renderStorageView();
          await storageRefreshAutomatic(storageState.requestId);
        },
      }, "↻ 刷新工具占用")),
    notice,
    storageSummary(overview),
    sections);
};

const openStorageView = async () => {
  showView("storage");
  storageState.requestId += 1;
  const requestId = storageState.requestId;
  storageState.notice = null;
  renderStorageView();
  try {
    storageState.overview = await api("/api/storage/overview");
  } catch (error) {
    setChildren($("#view-storage"),
      el("div", { class: "card" }, el("div", { class: "notice risk" }, `读取存储状态失败：${error.message}`)));
    return;
  }
  renderStorageView();
  await storageRefreshAutomatic(requestId);
};
