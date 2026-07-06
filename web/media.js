"use strict";

/* ---------- media tab: view modes, person filter, multi-select export ---------- */

const MEDIA_SHOWN_CAP = 400;
const MEDIA_EXPORT_CAP = 200;

const isImageKind = (kind) => kind === "image" || kind === "sticker" || kind === "face" || kind === "emoji";

const openMediaView = async (forceRefresh) => {
  showView("media");
  const tab = app.mediaTab;
  if (tab.data === null || forceRefresh === true) {
    setChildren($("#view-media"), el("div", { class: "card" }, el("div", { class: "empty" }, "正在扫描媒体索引…")));
    try {
      tab.data = await api(`/api/media-index${forceRefresh === true ? "?refresh=1" : ""}`);
    } catch (error) {
      setChildren($("#view-media"), el("div", { class: "card" }, el("div", { class: "notice risk" }, `读取媒体索引失败: ${error.message}`)));
      return;
    }
  }
  renderMediaView();
};

const mediaFilteredItems = () => {
  const tab = app.mediaTab;
  let items = (tab.data?.items ?? []).filter((item) => item.dup !== true);
  if (tab.group !== "all") {
    items = items.filter((item) => item.groupId === tab.group);
  }
  if (tab.kind !== "all") {
    items = items.filter((item) => item.kind === tab.kind);
  }
  if (tab.person !== "all") {
    items = items.filter((item) => item.speaker === tab.person);
  }
  return [...items].sort((left, right) =>
    tab.sort === "size" ? right.bytes - left.bytes : right.hkt.localeCompare(left.hkt));
};

const toggleMediaSelect = (item) => {
  const selected = app.mediaTab.selected;
  if (selected.has(item.webPath)) {
    selected.delete(item.webPath);
  } else if (selected.size < MEDIA_EXPORT_CAP) {
    selected.add(item.webPath);
  } else {
    alert(`一次最多选 ${MEDIA_EXPORT_CAP} 个文件。`);
    return;
  }
  renderMediaView();
};

const exportSelectedMedia = async () => {
  const tab = app.mediaTab;
  if (tab.selected.size === 0) {
    return;
  }
  try {
    const result = await api("/api/media-export", {
      method: "POST",
      body: JSON.stringify({ paths: [...tab.selected] }),
    });
    alert(`已导出 ${result.copied} 个原始文件到：\n${result.folder}${result.failed.length > 0 ? `\n（${result.failed.length} 个失败）` : ""}\n文件夹已自动打开。`);
    tab.selected = new Set();
    tab.selecting = false;
    renderMediaView();
  } catch (error) {
    alert(`导出失败: ${error.message}`);
  }
};

const mediaThumb = (item) => {
  if (isImageKind(item.kind)) {
    return el("img", { src: item.webPath, loading: "lazy", alt: item.kind });
  }
  return el("span", { class: "media-file-tile" },
    el("span", { class: "media-file-icon" }, KIND_ICONS[item.kind] ?? "📎"),
    el("span", { class: "media-file-name" }, decodeURIComponent(item.webPath.split("/").at(-1) ?? "")));
};

const mediaItemNode = (item, mode) => {
  const tab = app.mediaTab;
  const picked = tab.selected.has(item.webPath);
  const onclick = () => {
    if (tab.selecting) {
      toggleMediaSelect(item);
    } else {
      window.open(item.webPath, "_blank", "noopener");
    }
  };

  const caption = mode === "detail"
    ? el("figcaption", {},
        `${item.groupName || item.groupId} · ${item.speaker}`,
        el("br"),
        `${item.hkt.slice(5, 16)} · ${formatBytes(item.bytes)}`)
    : null;

  return el("figure", {
    class: `media-item ${picked ? "picked" : ""} ${tab.selecting ? "selecting" : ""}`,
    title: `${item.speaker} · ${item.hkt.slice(0, 16)} · ${formatBytes(item.bytes)}`,
    onclick,
  }, mediaThumb(item), caption);
};

const mediaChip = (isOn, label, onclick) =>
  el("button", { class: `chip ${isOn ? "on" : ""}`, onclick }, label);

const renderMediaView = () => {
  const tab = app.mediaTab;
  const allItems = (tab.data?.items ?? []).filter((item) => item.dup !== true);
  const rerender = () => renderMediaView();

  const groupEntries = [...new Map(allItems.map((item) => [item.groupId, item.groupName || item.groupId]))];
  const kinds = [...new Set(allItems.map((item) => item.kind))];
  const groupScoped = tab.group === "all" ? allItems : allItems.filter((item) => item.groupId === tab.group);
  const personCounts = new Map();
  for (const item of groupScoped) {
    personCounts.set(item.speaker, (personCounts.get(item.speaker) ?? 0) + 1);
  }
  const persons = [...personCounts.entries()].sort((left, right) => right[1] - left[1]).slice(0, 20);

  const filtered = mediaFilteredItems();
  const shown = filtered.slice(0, MEDIA_SHOWN_CAP);

  const setAndRender = (patch) => {
    Object.assign(tab, patch);
    rerender();
  };

  const modeChip = (mode, label) =>
    mediaChip(tab.mode === mode, label, () => {
      tab.mode = mode;
      localStorage.setItem("cc-mediamode", mode);
      rerender();
    });

  const controls = el("div", { class: "card" },
    el("div", { class: "row", style: "justify-content:space-between;margin-bottom:10px" },
      el("h2", { style: "margin:0" }, `媒体 (${filtered.length}${tab.data?.truncated ? "+" : ""})`),
      el("div", { class: "row" },
        el("button", { class: "btn small", onclick: () => openMediaView(true) }, "🔄 刷新索引"),
        el("button", {
          class: `btn small ${tab.selecting ? "primary" : ""}`,
          onclick: () => setAndRender({ selecting: !tab.selecting, selected: new Set() }),
        }, tab.selecting ? "退出选择" : "☑️ 选择"),
        tab.selecting
          ? el("button", {
              class: "btn small",
              onclick: () => {
                tab.selected = new Set(shown.filter((item) => isImageKind(item.kind) || item.kind === "video").slice(0, MEDIA_EXPORT_CAP).map((item) => item.webPath));
                rerender();
              },
            }, "全选当前")
          : null,
        tab.selecting
          ? el("button", { class: "btn small primary", disabled: tab.selected.size === 0, onclick: exportSelectedMedia },
              `📥 导出原图 (${tab.selected.size})`)
          : null)),
    tab.data?.truncated
      ? el("p", { class: "card-sub", style: "margin:0 0 8px" }, "媒体索引已达上限，更早的文件未列出（可在设置页清理旧运行，或用筛选缩小范围）。")
      : null,
    el("div", { class: "chips", style: "margin-bottom:8px" },
      mediaChip(tab.group === "all", "全部群", () => setAndRender({ group: "all", person: "all", selected: new Set() })),
      groupEntries.map(([groupId, name]) =>
        mediaChip(tab.group === groupId, name, () => setAndRender({ group: groupId, person: "all", selected: new Set() })))),
    el("div", { class: "chips", style: "margin-bottom:8px" },
      mediaChip(tab.kind === "all", "全部类型", () => setAndRender({ kind: "all", selected: new Set() })),
      kinds.map((kind) => mediaChip(tab.kind === kind, `${KIND_ICONS[kind] ?? ""} ${KIND_LABELS[kind] ?? kind}`, () => setAndRender({ kind, selected: new Set() })))),
    el("div", { class: "chips", style: "margin-bottom:8px" },
      mediaChip(tab.person === "all", "全部人", () => setAndRender({ person: "all", selected: new Set() })),
      persons.map(([speaker, count]) =>
        mediaChip(tab.person === speaker, `${speaker} (${count})`, () => setAndRender({ person: speaker, selected: new Set() })))),
    el("div", { class: "chips" },
      mediaChip(tab.sort === "time", "按时间", () => setAndRender({ sort: "time" })),
      mediaChip(tab.sort === "size", "按大小", () => setAndRender({ sort: "size" })),
      el("span", { style: "width:14px" }),
      modeChip("detail", "详细"),
      modeChip("grid", "纯图网格"),
      modeChip("falls", "瀑布流")));

  const gridClass = tab.mode === "falls" ? "media-falls" : `media-grid ${tab.mode === "grid" ? "pure" : ""}`;
  const gallery = el("div", { class: "card" },
    shown.length === 0
      ? el("div", { class: "empty" }, "没有匹配的媒体文件。跑一次带媒体导出的总结后这里会出现内容。")
      : el("div", { class: gridClass }, shown.map((item) => mediaItemNode(item, tab.mode))),
    filtered.length > MEDIA_SHOWN_CAP
      ? el("p", { class: "card-sub", style: "margin:10px 0 0" }, `仅显示前 ${MEDIA_SHOWN_CAP} 项，共 ${filtered.length} 项 — 用筛选缩小范围。`)
      : null);

  setChildren($("#view-media"), controls, gallery);
};
