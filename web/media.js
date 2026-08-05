"use strict";

/* ---------- media gallery ---------- */

const {
  buildGalleryEvents,
  buildGalleryEventsForMatches,
  buildGalleryStory,
  compareGalleryCollections,
  filterGalleryEventsByReview,
  filterGalleryItems,
  filterGalleryOccurrences,
  galleryEmptyState,
  galleryMessageRowCandidates,
  galleryNeighborPath,
  galleryPresentation,
  groupGalleryItemsByDay,
  groupGalleryPropagation,
  normalizeGalleryReview,
  summarizeGalleryItems,
} = window.GalleryTools;

const MEDIA_RENDER_BATCH = 400;
const MEDIA_EXPORT_BATCH = 100;
const GALLERY_EVENT_GAP_SECONDS = 20 * 60;
const GALLERY_CONTEXT_SECONDS = 15 * 60;
const GALLERY_REVIEW_KEY = "cc-gallery-reviews";
const GALLERY_SURFACES = new Set(["events", "files", "propagation", "compare"]);

const isVisualMedia = (item) => galleryPresentation(item) !== "file";

const replaceMediaTab = (patch) => {
  app.mediaTab = { ...app.mediaTab, ...patch };
};

const galleryRenderedCount = () => Number.isInteger(app.mediaTab.renderedCount) && app.mediaTab.renderedCount > 0
  ? app.mediaTab.renderedCount
  : MEDIA_RENDER_BATCH;

const loadMoreGalleryItems = () => {
  replaceMediaTab({ renderedCount: galleryRenderedCount() + MEDIA_RENDER_BATCH });
  renderMediaView();
};

const observeGalleryLoadMore = () => {
  const button = document.querySelector('[data-testid="gallery-load-more"]');
  if (button === null || typeof IntersectionObserver !== "function") {
    return;
  }
  const observer = new IntersectionObserver((entries) => {
    if (entries.some((entry) => entry.isIntersecting)) {
      observer.disconnect();
      loadMoreGalleryItems();
    }
  }, { rootMargin: "600px 0px" });
  observer.observe(button);
};

const galleryKnownGroups = () => [...new Map([
  ...(app.state?.watchlist ?? []),
  ...(app.state?.knownGroups ?? []),
  ...(app.mediaTab.data?.items ?? []).map((item) => ({ groupId: item.groupId, name: item.groupName || item.groupId })),
].map((group) => [group.groupId, group])).values()]
  .sort((left, right) => (left.name || left.groupId).localeCompare(right.name || right.groupId));

const defaultGalleryComparison = (data, compare) => {
  if (compare.leftGroup !== "all" || compare.rightGroup !== "all") {
    return compare;
  }
  const groupIds = [...new Set((data.items ?? []).filter((item) => item.dup !== true).map((item) => item.groupId))];
  return {
    ...compare,
    leftGroup: groupIds[0] ?? "all",
    rightGroup: groupIds[1] ?? groupIds[0] ?? "all",
  };
};

const loadGalleryReviews = () => {
  const raw = localStorage.getItem(GALLERY_REVIEW_KEY);
  if (raw === null) {
    return {};
  }
  const parsed = JSON.parse(raw);
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new TypeError("Gallery review storage must be an object");
  }
  return Object.fromEntries(Object.entries(parsed).map(([eventId, review]) => [eventId, normalizeGalleryReview(review)]));
};

const persistGalleryReviews = (reviews) => {
  localStorage.setItem(GALLERY_REVIEW_KEY, JSON.stringify(reviews));
};

const updateGalleryReview = (eventId, patch) => {
  const current = app.mediaTab.reviews[eventId] ?? { status: "unreviewed", favorite: false, note: "" };
  const review = normalizeGalleryReview({ ...current, ...patch });
  const reviews = { ...app.mediaTab.reviews, [eventId]: review };
  persistGalleryReviews(reviews);
  replaceMediaTab({ reviews });
  renderMediaView();
};

const galleryFilters = (overrides) => ({
  groupId: app.mediaTab.group,
  kind: app.mediaTab.kind,
  speaker: app.mediaTab.person,
  fromUnix: app.mediaTab.fromUnix,
  toUnix: app.mediaTab.toUnix,
  sort: app.mediaTab.sort,
  ...overrides,
});

const mediaFilteredItems = () => filterGalleryItems(app.mediaTab.data?.items ?? [], galleryFilters({}));

const galleryFilteredOccurrences = () => filterGalleryOccurrences(app.mediaTab.data?.items ?? [], galleryFilters({ groupId: "all" }));

const galleryEvents = () => {
  const allPrimaryItems = (app.mediaTab.data?.items ?? []).filter((item) => item.dup !== true);
  return buildGalleryEventsForMatches(allPrimaryItems, mediaFilteredItems(), GALLERY_EVENT_GAP_SECONDS);
};

const galleryEventForItem = (events, item) =>
  events.find((event) => event.items.some((candidate) => candidate.webPath === item.webPath)) ?? null;

const galleryRangeKey = () => [app.mediaTab.group, app.mediaTab.fromUnix, app.mediaTab.toUnix].join(":");

const loadGalleryRangeState = async () => {
  const tab = app.mediaTab;
  if (!Number.isFinite(tab.fromUnix) || !Number.isFinite(tab.toUnix) || tab.fromUnix >= tab.toUnix) {
    replaceMediaTab({ rangeState: null, rangeStateKey: "" });
    return;
  }
  const groups = tab.group === "all" ? galleryKnownGroups() : galleryKnownGroups().filter((group) => group.groupId === tab.group);
  if (groups.length === 0) {
    throw new Error(`Gallery range has no known group: ${tab.group}`);
  }
  const key = galleryRangeKey();
  if (tab.rangeStateKey === key) {
    return;
  }
  const batches = Array.from({ length: Math.ceil(groups.length / 50) }, (_, index) => groups.slice(index * 50, (index + 1) * 50));
  const responses = await Promise.all(batches.map((batch) => {
    const params = new URLSearchParams({
      groupIds: batch.map((group) => group.groupId).join(","),
      fromUnix: String(tab.fromUnix),
      toUnix: String(tab.toUnix),
    });
    return api(`/api/gallery-range?${params}`);
  }));
  const rangeState = {
    fromUnix: tab.fromUnix,
    toUnix: tab.toUnix,
    activity: responses.flatMap((response) => response.activity),
  };
  replaceMediaTab({ rangeState, rangeStateKey: key });
};

const loadGalleryEventActivity = async (events) => {
  const tab = app.mediaTab;
  const missing = events.filter((event) => tab.eventActivity?.[event.id] === undefined);
  if (missing.length === 0 || tab.eventActivityLoading === true) {
    return;
  }
  replaceMediaTab({ eventActivityLoading: true, eventActivityError: null });
  try {
    const result = await api("/api/gallery-event-activity", {
      method: "POST",
      body: JSON.stringify({
        events: missing.slice(0, galleryRenderedCount()).map((event) => ({
          id: event.id,
          groupId: event.groupId,
          fromUnix: event.startUnix - GALLERY_CONTEXT_SECONDS,
          toUnix: event.endUnix + GALLERY_CONTEXT_SECONDS + 1,
        })),
      }),
    });
    const eventActivity = {
      ...(app.mediaTab.eventActivity ?? {}),
      ...Object.fromEntries(result.activity.map((activity) => [activity.id, activity])),
    };
    replaceMediaTab({ eventActivity, eventActivityLoading: false });
  } catch (error) {
    replaceMediaTab({ eventActivityLoading: false, eventActivityError: error.message });
  }
  renderMediaView();
};

const openMediaView = async (forceRefresh) => {
  showView("media");
  if (app.mediaTab.data === null || forceRefresh === true) {
    setChildren($("#view-media"), el("div", { class: "card" }, el("div", { class: "empty" }, "正在扫描媒体索引…")));
    try {
      const data = await api(`/api/media-index${forceRefresh === true ? "?refresh=1" : ""}`);
      replaceMediaTab({
        data,
        renderedCount: MEDIA_RENDER_BATCH,
        compare: defaultGalleryComparison(data, app.mediaTab.compare),
        viewerPath: null,
        viewerEventId: null,
        eventActivity: {},
        story: null,
      });
    } catch (error) {
      setChildren($("#view-media"), el("div", { class: "card" }, el("div", { class: "notice risk" }, `读取媒体索引失败: ${error.message}`)));
      return;
    }
  }
  try {
    await loadGalleryRangeState();
  } catch (error) {
    replaceMediaTab({ rangeState: { error: error.message }, rangeStateKey: galleryRangeKey() });
  }
  renderMediaView();
};

const openGalleryRange = async ({ groupId, fromUnix, toUnix }) => {
  replaceMediaTab({
    group: groupId,
    kind: "all",
    person: "all",
    fromUnix,
    toUnix,
    sort: "time-asc",
    surface: "events",
    reviewFilter: "all",
    selected: new Set(),
    selecting: false,
    viewerPath: null,
    viewerEventId: null,
    rangeState: null,
    rangeStateKey: "",
    renderedCount: MEDIA_RENDER_BATCH,
  });
  localStorage.setItem("cc-gallery-surface", "events");
  await openMediaView(false);
};

const setMediaFilters = async (patch) => {
  replaceMediaTab({ ...patch, selected: new Set(), viewerPath: null, viewerEventId: null, rangeStateKey: "", renderedCount: MEDIA_RENDER_BATCH });
  renderMediaView();
  try {
    await loadGalleryRangeState();
  } catch (error) {
    replaceMediaTab({ rangeState: { error: error.message }, rangeStateKey: galleryRangeKey() });
  }
  renderMediaView();
};

const setGallerySurface = (surface) => {
  if (!GALLERY_SURFACES.has(surface)) {
    throw new Error(`Unsupported gallery surface: ${surface}`);
  }
  const groups = galleryKnownGroups();
  const mediaGroups = groups.filter((group) => (app.mediaTab.data?.items ?? []).some((item) => item.dup !== true && item.groupId === group.groupId));
  const compare = surface === "compare" && app.mediaTab.compare.leftGroup === "all" && app.mediaTab.compare.rightGroup === "all"
    ? {
        ...app.mediaTab.compare,
        leftGroup: mediaGroups[0]?.groupId ?? "all",
        rightGroup: mediaGroups[1]?.groupId ?? mediaGroups[0]?.groupId ?? "all",
      }
    : app.mediaTab.compare;
  replaceMediaTab({ surface, compare, selecting: surface === "files" ? app.mediaTab.selecting : false, selected: new Set(), viewerPath: null, renderedCount: MEDIA_RENDER_BATCH });
  localStorage.setItem("cc-gallery-surface", surface);
  renderMediaView();
};

const toggleMediaSelect = (item) => {
  const selected = new Set(app.mediaTab.selected);
  if (selected.has(item.webPath)) {
    selected.delete(item.webPath);
  } else {
    selected.add(item.webPath);
  }
  replaceMediaTab({ selected });
  renderMediaView();
};

const exportSelectedMedia = async () => {
  if (app.mediaTab.selected.size === 0) {
    return;
  }
  try {
    const paths = [...app.mediaTab.selected];
    let folder = null;
    let copied = 0;
    const failed = [];
    for (let offset = 0; offset < paths.length; offset += MEDIA_EXPORT_BATCH) {
      const batch = paths.slice(offset, offset + MEDIA_EXPORT_BATCH);
      const result = await api("/api/media-export", {
        method: "POST",
        body: JSON.stringify({
          paths: batch,
          folder,
          openFolder: offset + batch.length >= paths.length,
        }),
      });
      folder = result.folder;
      copied += result.copied;
      failed.push(...result.failed);
    }
    alert(`已导出 ${copied} 个原始文件到：\n${folder}${failed.length > 0 ? `\n（${failed.length} 个失败）` : ""}\n文件夹已自动打开。`);
    replaceMediaTab({ selected: new Set(), selecting: false });
    renderMediaView();
  } catch (error) {
    alert(`导出失败: ${error.message}`);
  }
};

const mediaThumb = (item, loading) => {
  if (galleryPresentation(item) === "image") {
    return el("img", {
      src: item.webPath,
      loading,
      alt: `${item.groupName || item.groupId} · ${item.speaker} · ${item.hkt.slice(0, 16)}`,
    });
  }
  if (galleryPresentation(item) === "video") {
    return el("video", { src: item.webPath, muted: true, preload: "metadata", "aria-label": `${item.speaker} 的视频` });
  }
  return el("span", { class: "media-file-tile" },
    el("span", { class: "media-file-icon" }, KIND_ICONS[item.kind] ?? "📎"),
    el("span", { class: "media-file-name" }, decodeURIComponent(item.webPath.split("/").at(-1) ?? "")));
};

const openMessageContextForMedia = (item) => {
  replaceMediaTab({ viewerPath: null, viewerEventId: null });
  const center = hktToUnix(item.hkt);
  openMessagesView({
    groupId: item.groupId,
    fromUnix: center - GALLERY_CONTEXT_SECONDS,
    toUnix: center + GALLERY_CONTEXT_SECONDS,
    scrollToTime: center,
    scrollToRowIds: galleryMessageRowCandidates(item.rowId),
    origin: { view: "media", label: "返回画廊" },
  });
};

const openMessageContextForEvent = (event) => {
  replaceMediaTab({ viewerPath: null, viewerEventId: null });
  openMessagesView({
    groupId: event.groupId,
    fromUnix: event.startUnix - GALLERY_CONTEXT_SECONDS,
    toUnix: event.endUnix + GALLERY_CONTEXT_SECONDS + 1,
    scrollToTime: event.startUnix,
    origin: { view: "media", label: "返回画廊" },
  });
};

const loadGalleryStory = async (event) => {
  const storyKey = `${event.id}:${event.startUnix}:${event.endUnix}`;
  if (app.mediaTab.story?.key === storyKey && app.mediaTab.story.loading !== true) {
    return;
  }
  replaceMediaTab({ story: { key: storyKey, eventId: event.id, loading: true, error: null, data: null } });
  renderMediaView();
  const fromUnix = event.startUnix - GALLERY_CONTEXT_SECONDS;
  const toUnix = event.endUnix + GALLERY_CONTEXT_SECONDS + 1;
  const params = new URLSearchParams({ groupId: event.groupId, from: String(fromUnix), to: String(toUnix), limit: "500" });
  try {
    const result = await api(`/api/messages?${params}`);
    const data = buildGalleryStory(
      result.messages,
      event.startUnix,
      event.endUnix + 1,
      result.coverage ?? [],
      fromUnix,
      toUnix,
    );
    if (app.mediaTab.story?.key === storyKey) {
      replaceMediaTab({ story: { key: storyKey, eventId: event.id, loading: false, error: null, data } });
      renderMediaView();
    }
  } catch (error) {
    if (app.mediaTab.story?.key === storyKey) {
      replaceMediaTab({ story: { key: storyKey, eventId: event.id, loading: false, error: error.message, data: null } });
      renderMediaView();
    }
  }
};

const openGalleryViewer = (item, event) => {
  if (!isVisualMedia(item)) {
    window.open(item.webPath, "_blank", "noopener");
    return;
  }
  replaceMediaTab({ viewerPath: item.webPath, viewerEventId: event?.id ?? null, story: null });
  renderMediaView();
  if (event !== null) {
    void loadGalleryStory(event);
  }
};

const galleryOption = (value, label, selectedValue) => {
  const option = el("option", { value }, label);
  option.selected = value === selectedValue;
  return option;
};

const renderGalleryMetric = (value, label) =>
  el("div", { class: "gallery-metric" }, el("strong", {}, value), el("span", {}, label));

const renderGallerySurfaceNav = () => el("div", { class: "gallery-surface-nav", role: "tablist", "aria-label": "画廊视图" },
  [
    ["events", "事件"],
    ["files", "文件"],
    ["propagation", "传播"],
    ["compare", "对比"],
  ].map(([surface, label]) => el("button", {
    role: "tab",
    class: app.mediaTab.surface === surface ? "active" : "",
    "aria-selected": String(app.mediaTab.surface === surface),
    "data-testid": `gallery-surface-${surface}`,
    onclick: () => setGallerySurface(surface),
  }, label)));

const renderGalleryControls = (allItems, filtered) => {
  const tab = app.mediaTab;
  const groups = galleryKnownGroups();
  const kinds = [...new Set((tab.data?.items ?? []).map((item) => item.kind))].sort();
  const groupScoped = tab.group === "all" ? allItems : allItems.filter((item) => item.groupId === tab.group);
  const personCounts = groupScoped.reduce((counts, item) => {
    counts.set(item.speaker, (counts.get(item.speaker) ?? 0) + 1);
    return counts;
  }, new Map());
  const persons = [...personCounts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
  const summary = summarizeGalleryItems(filtered);
  const eventCount = galleryEvents().length;
  const setMode = (mode) => {
    replaceMediaTab({ mode });
    localStorage.setItem("cc-mediamode", mode);
    renderMediaView();
  };
  return el("div", { class: "card gallery-controls", "data-testid": "gallery-controls" },
    el("div", { class: "gallery-head" },
      el("div", {},
        el("h2", {}, `画廊 (${summary.itemCount})`),
        el("p", { class: "card-sub" }, summary.itemCount === 0
          ? "当前范围没有可见媒体。"
          : `${summary.firstHkt.slice(0, 16)} - ${summary.lastHkt.slice(5, 16)}`)),
      el("div", { class: "gallery-actions" },
        el("button", { class: "btn icon-btn", title: "刷新媒体索引", "aria-label": "刷新媒体索引", onclick: () => openMediaView(true) }, "↻"),
        tab.surface === "files"
          ? el("button", {
              class: `btn small ${tab.selecting ? "primary" : ""}`,
              "data-testid": "gallery-select-mode",
              onclick: () => {
                replaceMediaTab({ selecting: !tab.selecting, selected: new Set(), viewerPath: null });
                renderMediaView();
              },
            }, tab.selecting ? "退出选择" : "选择")
          : null,
        tab.surface === "files" && tab.selecting
          ? el("button", {
              class: "btn small",
              onclick: () => {
                replaceMediaTab({ selected: new Set(filtered.filter(isVisualMedia).map((item) => item.webPath)) });
                renderMediaView();
              },
            }, "全选当前")
          : null,
        tab.surface === "files" && tab.selecting
          ? el("button", { class: "btn small primary", disabled: tab.selected.size === 0, onclick: exportSelectedMedia }, `导出原图 (${tab.selected.size})`)
          : null)),
    renderGallerySurfaceNav(),
    tab.reviewStorageError === undefined
      ? null
      : el("div", { class: "notice risk" }, `读取本地审阅状态失败: ${tab.reviewStorageError}`),
    el("div", { class: "gallery-summary" },
      renderGalleryMetric(tab.surface === "events" ? eventCount : summary.itemCount, tab.surface === "events" ? "事件" : "媒体"),
      renderGalleryMetric(summary.groupCount, "群"),
      renderGalleryMetric(summary.speakerCount, "参与者"),
      renderGalleryMetric(formatBytes(summary.totalBytes), "总大小")),
    el("div", { class: "gallery-filter-grid" },
      el("label", {}, el("span", {}, "群"), el("select", {
        "data-testid": "gallery-group-filter",
        onchange: (event) => void setMediaFilters({ group: event.target.value, person: "all" }),
      },
      galleryOption("all", "全部群", tab.group),
      groups.map((group) => galleryOption(group.groupId, `${group.name || group.groupId} · ${group.groupId}`, tab.group)))),
      el("label", {}, el("span", {}, "类型"), el("select", {
        "data-testid": "gallery-kind-filter",
        onchange: (event) => void setMediaFilters({ kind: event.target.value }),
      },
      galleryOption("all", "全部类型", tab.kind),
      kinds.map((kind) => galleryOption(kind, KIND_LABELS[kind] ?? kind, tab.kind)))),
      el("label", {}, el("span", {}, "参与者"),
        el("div", { class: "gallery-person-control" },
          el("input", {
            type: "search",
            list: "gallery-person-options",
            value: tab.person === "all" ? "" : tab.person,
            placeholder: "全部人，可输入名字",
            "aria-label": "搜索参与者",
            "data-testid": "gallery-person-filter",
            onchange: (event) => void setMediaFilters({ person: event.target.value.trim() || "all" }),
            onkeydown: (event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void setMediaFilters({ person: event.target.value.trim() || "all" });
              }
            },
          }),
          el("button", {
            type: "button",
            class: "btn icon-btn",
            title: tab.person === "all" ? "应用参与者筛选" : "清除参与者筛选",
            "aria-label": tab.person === "all" ? "应用参与者筛选" : "清除参与者筛选",
            onclick: (event) => {
              const input = event.currentTarget.parentElement.querySelector("input");
              void setMediaFilters({ person: tab.person === "all" ? input.value.trim() || "all" : "all" });
            },
          }, tab.person === "all" ? "⌕" : "×")),
        el("datalist", { id: "gallery-person-options" },
          persons.map(([speaker, count]) => el("option", { value: speaker, label: `${count} 项` })))),
      tab.surface === "events"
        ? el("label", {}, el("span", {}, "审阅"), el("select", {
            "data-testid": "gallery-review-filter",
            onchange: (event) => {
              replaceMediaTab({ reviewFilter: event.target.value });
              renderMediaView();
            },
          },
          galleryOption("all", "全部事件", tab.reviewFilter),
          galleryOption("unreviewed", "未审阅", tab.reviewFilter),
          galleryOption("reviewed", "已审阅", tab.reviewFilter),
          galleryOption("follow-up", "待跟进", tab.reviewFilter),
          galleryOption("favorite", "已收藏", tab.reviewFilter)))
        : el("label", {}, el("span", {}, "排序"), el("select", {
            "data-testid": "gallery-sort",
            onchange: (event) => void setMediaFilters({ sort: event.target.value }),
          },
          galleryOption("time-desc", "最新优先", tab.sort),
          galleryOption("time-asc", "最早优先", tab.sort),
          galleryOption("size-desc", "文件最大", tab.sort)))),
    el("div", { class: "gallery-range-row" },
      el("label", {}, el("span", {}, "开始"), el("input", {
        type: "datetime-local",
        value: Number.isFinite(tab.fromUnix) ? unixToHkt(tab.fromUnix).slice(0, 16).replace(" ", "T") : "",
        "aria-label": "画廊开始时间",
        onchange: (event) => void setMediaFilters({ fromUnix: event.target.value.length > 0 ? hktToUnix(event.target.value.replace("T", " ")) : null }),
      })),
      el("label", {}, el("span", {}, "结束"), el("input", {
        type: "datetime-local",
        value: Number.isFinite(tab.toUnix) ? unixToHkt(tab.toUnix).slice(0, 16).replace(" ", "T") : "",
        "aria-label": "画廊结束时间",
        onchange: (event) => void setMediaFilters({ toUnix: event.target.value.length > 0 ? hktToUnix(event.target.value.replace("T", " ")) : null }),
      })),
      Number.isFinite(tab.fromUnix) || Number.isFinite(tab.toUnix)
        ? el("button", { class: "btn small", onclick: () => void setMediaFilters({ fromUnix: null, toUnix: null }) }, "清除时间")
        : null,
      tab.surface === "files"
        ? el("div", { class: "gallery-modes", role: "group", "aria-label": "画廊布局" },
            [["detail", "详细"], ["grid", "网格"], ["falls", "瀑布流"]].map(([mode, label]) =>
              el("button", { class: `chip ${tab.mode === mode ? "on" : ""}`, "data-testid": `gallery-mode-${mode}`, onclick: () => setMode(mode) }, label)))
        : el("span", { class: "gallery-range-hint" }, "事件以同群相邻 20 分钟归组")));
};

const reviewStatusLabel = (review) => ({
  unreviewed: "未审阅",
  reviewed: "已审阅",
  "follow-up": "待跟进",
}[review.status]);

const renderEventMediaRail = (event) => el("div", { class: "gallery-event-media" },
  event.items.slice(0, 6).map((item) => el("button", {
    class: "gallery-event-thumb",
    "aria-label": `查看 ${item.speaker} 在 ${item.hkt.slice(0, 16)} 的媒体`,
    onclick: () => openGalleryViewer(item, event),
  }, mediaThumb(item, "lazy"))),
  event.items.length > 6 ? el("span", { class: "gallery-event-more" }, `+${event.items.length - 6}`) : null);

const renderEventCard = (event) => {
  const review = app.mediaTab.reviews[event.id] ?? { status: "unreviewed", favorite: false, note: "" };
  const activity = app.mediaTab.eventActivity?.[event.id];
  const timeText = event.startHkt.slice(0, 10) === event.endHkt.slice(0, 10)
    ? `${event.startHkt.slice(5, 16)}-${event.endHkt.slice(11, 16)}`
    : `${event.startHkt.slice(5, 16)} - ${event.endHkt.slice(5, 16)}`;
  return el("article", { class: `gallery-event review-${review.status}`, "data-testid": "gallery-event", dataset: { eventId: event.id } },
    el("div", { class: "gallery-event-head" },
      el("div", {},
        el("h3", {}, event.groupName),
        el("span", {}, timeText)),
      el("div", { class: "gallery-event-review" },
        el("span", { class: `review-state ${review.status}` }, reviewStatusLabel(review)),
        review.favorite ? el("span", { class: "review-favorite", title: "已收藏" }, "★") : null)),
    renderEventMediaRail(event),
    el("div", { class: "gallery-event-facts" },
      el("span", {}, el("strong", {}, event.items.length), " 媒体"),
      el("span", {}, el("strong", {}, event.speakers.length), " 参与者"),
      el("span", {}, el("strong", {}, activity?.messageCount ?? "…"), " 相关消息"),
      activity === undefined
        ? null
        : el("span", { class: activity.coverageRatio >= 0.999 ? "coverage-complete" : "coverage-partial" },
            activity.coverageRatio >= 0.999 ? "扫描完整" : `扫描 ${Math.round(activity.coverageRatio * 100)}%`)),
    el("div", { class: "gallery-event-speakers" }, event.speakers.slice(0, 5).join(" · ")),
    review.note.length > 0 ? el("p", { class: "gallery-event-note" }, review.note) : null,
    el("div", { class: "gallery-event-actions" },
      el("button", { class: "btn small primary", onclick: () => {
        const first = event.items.find(isVisualMedia);
        if (first === undefined) {
          openMessageContextForEvent(event);
          return;
        }
        openGalleryViewer(first, event);
      } }, "查看事件"),
      el("button", { class: "btn small", onclick: () => openMessageContextForEvent(event) }, "消息"),
      el("button", { class: "btn small", "data-testid": "gallery-locate-timeline", onclick: () => void openTimelineRange({
        groupId: event.groupId,
        fromUnix: event.startUnix,
        toUnix: event.endUnix + 1,
      }) }, "时间表"),
      el("button", {
        class: `btn small ${review.status === "reviewed" ? "active" : ""}`,
        title: review.status === "reviewed" ? "标为未审阅" : "标为已审阅",
        onclick: () => updateGalleryReview(event.id, { status: review.status === "reviewed" ? "unreviewed" : "reviewed" }),
      }, review.status === "reviewed" ? "撤销审阅" : "完成审阅"),
      el("button", {
        class: `btn icon-btn ${review.favorite ? "active" : ""}`,
        title: review.favorite ? "取消收藏" : "收藏事件",
        "aria-label": review.favorite ? "取消收藏事件" : "收藏事件",
        onclick: () => updateGalleryReview(event.id, { favorite: !review.favorite }),
      }, review.favorite ? "★" : "☆")));
};

const reviewedGalleryEvents = (events) => filterGalleryEventsByReview(events, app.mediaTab.reviews, app.mediaTab.reviewFilter);

const renderGalleryEvents = (events) => {
  const reviewed = reviewedGalleryEvents(events);
  const rendered = reviewed.slice(0, galleryRenderedCount());
  if (events.length > 0) {
    void loadGalleryEventActivity(rendered);
  }
  return el("div", { class: "gallery-events", "data-testid": "gallery-events" },
    app.mediaTab.eventActivityError === null || app.mediaTab.eventActivityError === undefined
      ? null
      : el("div", { class: "notice risk" }, `读取事件消息统计失败: ${app.mediaTab.eventActivityError}`),
    reviewed.length === 0
      ? el("div", { class: "card empty" }, events.length === 0 ? "当前范围没有事件。" : "没有符合审阅状态的事件。")
      : rendered.map(renderEventCard));
};

const mediaItemNode = (item, mode, event) => {
  const picked = app.mediaTab.selected.has(item.webPath);
  const caption = mode === "detail"
    ? el("figcaption", {},
        el("strong", {}, item.groupName || item.groupId),
        el("span", {}, item.speaker),
        el("span", {}, `${item.hkt.slice(5, 16)} · ${formatBytes(item.bytes)}`),
        el("button", { class: "media-context", onclick: (clickEvent) => {
          clickEvent.stopPropagation();
          openMessageContextForMedia(item);
        } }, "查看前后消息"))
    : null;
  return el("figure", {
    class: `media-item ${picked ? "picked" : ""} ${app.mediaTab.selecting ? "selecting" : ""}`,
    title: `${item.speaker} · ${item.hkt.slice(0, 16)} · ${formatBytes(item.bytes)}`,
    dataset: { mediaPath: item.webPath },
    "data-testid": "gallery-item",
    onclick: () => app.mediaTab.selecting ? toggleMediaSelect(item) : openGalleryViewer(item, event),
  }, mediaThumb(item, "lazy"), caption);
};

const renderGalleryFiles = (shown, events) => {
  const mode = app.mediaTab.mode;
  const className = mode === "falls" ? "media-falls" : `media-grid ${mode === "grid" ? "pure" : ""}`;
  const groups = app.mediaTab.sort === "size-desc" ? [{ day: "按文件大小", items: shown }] : groupGalleryItemsByDay(shown);
  return groups.map((group) => el("section", { class: "gallery-day", dataset: { galleryDay: group.day } },
    el("div", { class: "gallery-day-head" }, el("h3", {}, group.day), el("span", {}, `${group.items.length} 项`)),
    el("div", { class: className }, group.items.map((item) => mediaItemNode(item, mode, galleryEventForItem(events, item))))));
};

const galleryPropagationChains = () => groupGalleryPropagation(galleryFilteredOccurrences())
    .filter((chain) => app.mediaTab.group === "all" || chain.occurrences.some((item) => item.groupId === app.mediaTab.group));
const renderPropagation = (chains) => {
  return el("div", { class: "gallery-propagation", "data-testid": "gallery-propagation" },
    el("div", { class: "gallery-explainer" },
      el("strong", {}, "完全相同文件的出现记录"),
      el("span", {}, "只使用文件哈希建立传播链，不把视觉相似或同名文件当作相同内容。")),
    chains.length === 0
      ? el("div", { class: "card empty" }, "当前范围没有重复出现且带真实哈希的文件。")
      : chains.slice(0, galleryRenderedCount()).map((chain) => {
          const primary = chain.occurrences[0];
          return el("article", { class: "propagation-row" },
            el("button", { class: "propagation-thumb", "aria-label": "查看传播文件", onclick: () => openGalleryViewer(primary, galleryEventForItem(galleryEvents(), primary)) }, mediaThumb(primary, "lazy")),
            el("div", { class: "propagation-body" },
              el("div", { class: "propagation-head" },
                el("strong", {}, `${chain.occurrences.length} 次出现 · ${chain.groupCount} 群`),
                el("span", {}, `${chain.firstHkt.slice(5, 16)} - ${chain.lastHkt.slice(5, 16)}`)),
              el("ol", {}, chain.occurrences.slice(0, 8).map((item) => el("li", {},
                el("time", {}, item.hkt.slice(5, 16)),
                el("span", {}, item.groupName || item.groupId),
                el("strong", {}, item.speaker),
                el("button", { class: "btn small", onclick: () => openMessageContextForMedia(item) }, "消息"))))));
        }));
};

const updateCompare = (patch) => {
  replaceMediaTab({ compare: { ...app.mediaTab.compare, ...patch }, viewerPath: null });
  renderMediaView();
};

const compareDateValue = (unix) => Number.isFinite(unix) ? unixToHkt(unix).slice(0, 16).replace(" ", "T") : "";

const comparisonCollection = (side) => {
  const compare = app.mediaTab.compare;
  return filterGalleryItems(app.mediaTab.data?.items ?? [], galleryFilters({
    groupId: compare[`${side}Group`],
    fromUnix: compare[`${side}FromUnix`] ?? app.mediaTab.fromUnix,
    toUnix: compare[`${side}ToUnix`] ?? app.mediaTab.toUnix,
  }));
};

const renderComparisonSideControls = (side, label, groups) => {
  const compare = app.mediaTab.compare;
  const groupKey = `${side}Group`;
  const fromKey = `${side}FromUnix`;
  const toKey = `${side}ToUnix`;
  return el("fieldset", { class: "compare-side-controls" },
    el("legend", {}, label),
    el("label", {}, el("span", {}, "群"), el("select", {
      "data-testid": `gallery-compare-${side}-group`,
      onchange: (event) => updateCompare({ [groupKey]: event.target.value }),
    }, galleryOption("all", "全部群", compare[groupKey]), groups.map((group) => galleryOption(group.groupId, group.name || group.groupId, compare[groupKey])))),
    el("label", {}, el("span", {}, "开始"), el("input", {
      type: "datetime-local",
      value: compareDateValue(compare[fromKey]),
      onchange: (event) => updateCompare({ [fromKey]: event.target.value ? hktToUnix(event.target.value.replace("T", " ")) : null }),
    })),
    el("label", {}, el("span", {}, "结束"), el("input", {
      type: "datetime-local",
      value: compareDateValue(compare[toKey]),
      onchange: (event) => updateCompare({ [toKey]: event.target.value ? hktToUnix(event.target.value.replace("T", " ")) : null }),
    })));
};

const renderComparison = () => {
  const left = comparisonCollection("left");
  const right = comparisonCollection("right");
  const comparison = compareGalleryCollections(left, right);
  const kindRows = [...new Set([...Object.keys(comparison.left.kindCounts), ...Object.keys(comparison.right.kindCounts)])].sort();
  const controls = el("div", { class: "compare-controls" },
    renderComparisonSideControls("left", "A 范围", galleryKnownGroups()),
    renderComparisonSideControls("right", "B 范围", galleryKnownGroups()));
  const summary = el("div", { class: "compare-summary-row" },
    el("div", {}, el("strong", {}, comparison.left.itemCount), el("span", {}, "A 媒体")),
    el("div", { class: "compare-shared" }, el("strong", {}, comparison.sharedContentCount), el("span", {}, "完全相同")),
    el("div", {}, el("strong", {}, comparison.right.itemCount), el("span", {}, "B 媒体")));
  const table = el("div", { class: "compare-table", role: "table", "aria-label": "画廊对比" },
    el("div", { class: "compare-table-head", role: "row" }, el("span", {}, "指标"), el("strong", {}, "A"), el("strong", {}, "B")),
    el("div", { role: "row" }, el("span", {}, "参与者"), el("strong", {}, comparison.left.speakers.length), el("strong", {}, comparison.right.speakers.length)),
    el("div", { role: "row" }, el("span", {}, "群"), el("strong", {}, comparison.left.groupCount), el("strong", {}, comparison.right.groupCount)),
    el("div", { role: "row" }, el("span", {}, "总大小"), el("strong", {}, formatBytes(comparison.left.totalBytes)), el("strong", {}, formatBytes(comparison.right.totalBytes))),
    kindRows.map((kind) => el("div", { role: "row" },
      el("span", {}, KIND_LABELS[kind] ?? kind),
      el("strong", {}, comparison.left.kindCounts[kind] ?? 0),
      el("strong", {}, comparison.right.kindCounts[kind] ?? 0))));
  const exclusive = el("div", { class: "compare-exclusive" },
    el("span", {}, `A 独有 ${comparison.leftOnlyContentKeys.length}`),
    el("span", {}, `B 独有 ${comparison.rightOnlyContentKeys.length}`));
  return el("div", { class: "gallery-compare", "data-testid": "gallery-compare" },
    controls,
    el("div", { class: "compare-result" }, summary, table, exclusive));
};

const storyMessageNode = (message) => el("li", {},
  el("time", {}, unixToHkt(message.sentAt).slice(11, 16)),
  el("strong", {}, message.speaker || "未知参与者"),
  el("span", {}, message.text.trim().length > 0 ? message.text : `[${message.mediaKinds || "媒体"}]`));

const renderStorySection = (title, messages) => el("section", { class: "story-section" },
  el("div", { class: "story-section-head" }, el("h4", {}, title), el("span", {}, messages.length)),
  messages.length === 0
    ? el("p", { class: "story-empty" }, "没有消息")
    : el("ol", {}, messages.slice(0, 6).map(storyMessageNode)),
  messages.length > 6 ? el("p", { class: "story-more" }, `另有 ${messages.length - 6} 条，请打开消息查看`) : null);

const renderGalleryStory = (event) => {
  const story = app.mediaTab.story;
  const review = app.mediaTab.reviews[event.id] ?? { status: "unreviewed", favorite: false, note: "" };
  if (story?.eventId !== event.id || story.loading === true) {
    return el("aside", { class: "gallery-story" }, el("div", { class: "empty" }, "正在整理事件上下文…"));
  }
  if (story.error !== null) {
    return el("aside", { class: "gallery-story" }, el("div", { class: "notice risk" }, `读取上下文失败: ${story.error}`));
  }
  const data = story.data;
  return el("aside", { class: "gallery-story", "data-testid": "gallery-story" },
    el("div", { class: "gallery-story-head" },
      el("div", {}, el("h3", {}, "事件故事线"), el("span", {}, `${event.items.length} 个媒体 · ${event.speakers.length} 位参与者`)),
      el("button", {
        class: `btn icon-btn ${review.favorite ? "active" : ""}`,
        title: review.favorite ? "取消收藏" : "收藏事件",
        "aria-label": review.favorite ? "取消收藏事件" : "收藏事件",
        onclick: () => updateGalleryReview(event.id, { favorite: !review.favorite }),
      }, review.favorite ? "★" : "☆")),
    el("div", { class: `story-coverage ${data.coverageComplete ? "complete" : "partial"}` },
      data.coverageComplete ? "上下文扫描完整" : `上下文有 ${data.gaps.length} 个扫描缺口`),
    renderStorySection("发送前", data.before),
    renderStorySection("事件中", data.during),
    renderStorySection("后续反应", data.after),
    el("div", { class: "gallery-review-editor" },
      el("div", { class: "review-segmented", role: "group", "aria-label": "事件审阅状态" },
        [["unreviewed", "未审阅"], ["reviewed", "已审阅"], ["follow-up", "待跟进"]].map(([status, label]) => el("button", {
          class: review.status === status ? "active" : "",
          "aria-pressed": String(review.status === status),
          onclick: () => updateGalleryReview(event.id, { status }),
        }, label))),
      el("label", {}, el("span", {}, "本地备注"), el("textarea", {
        rows: "3",
        maxlength: "500",
        placeholder: "记录需要跟进的原因",
        onchange: (changeEvent) => updateGalleryReview(event.id, { note: changeEvent.target.value }),
      }, review.note)),
      el("div", { class: "story-actions" },
        el("button", { class: "btn small", onclick: () => openMessageContextForEvent(event) }, "打开完整消息"),
        el("button", { class: "btn small", onclick: () => void openTimelineRange({ groupId: event.groupId, fromUnix: event.startUnix, toUnix: event.endUnix + 1 }) }, "定位时间表"))));
};

const setGalleryViewerDirection = (items, direction) => {
  const paths = items.filter(isVisualMedia).map((item) => item.webPath);
  replaceMediaTab({ viewerPath: galleryNeighborPath(paths, app.mediaTab.viewerPath, direction) });
  renderMediaView();
};

const renderGalleryViewer = (shown, events) => {
  const event = events.find((candidate) => candidate.id === app.mediaTab.viewerEventId) ?? null;
  const collection = event?.items ?? shown;
  const visualItems = collection.filter(isVisualMedia);
  const item = visualItems.find((candidate) => candidate.webPath === app.mediaTab.viewerPath);
  if (item === undefined) {
    return null;
  }
  const index = visualItems.findIndex((candidate) => candidate.webPath === item.webPath);
  const presentation = galleryPresentation(item);
  const media = presentation === "video"
    ? el("video", { src: item.webPath, controls: true, autoplay: true, preload: "metadata" })
    : el("img", { src: item.webPath, alt: `${item.groupName || item.groupId} · ${item.speaker}` });
  const kindLabel = item.kind === "video" && presentation === "image" ? "视频预览图" : KIND_LABELS[item.kind] ?? item.kind;
  return el("div", {
    class: "gallery-viewer-mask",
    role: "presentation",
    onclick: (clickEvent) => {
      if (clickEvent.target === clickEvent.currentTarget) {
        replaceMediaTab({ viewerPath: null, viewerEventId: null, story: null });
        renderMediaView();
      }
    },
  },
  el("div", { class: `gallery-viewer ${event === null ? "file-only" : "with-story"}`, role: "dialog", "aria-modal": "true", "aria-label": "媒体查看器", "data-testid": "gallery-viewer" },
    el("div", { class: "gallery-viewer-head" },
      el("div", {}, el("strong", {}, item.groupName || item.groupId), el("span", {}, `${index + 1} / ${visualItems.length}`)),
      el("button", {
        class: "gallery-viewer-close",
        title: "关闭查看器",
        "aria-label": "关闭查看器",
        "data-testid": "gallery-viewer-close",
        onclick: () => {
          replaceMediaTab({ viewerPath: null, viewerEventId: null, story: null });
          renderMediaView();
        },
      }, "×")),
    el("div", { class: "gallery-viewer-body" },
      el("div", { class: "gallery-viewer-main" },
        el("div", { class: "gallery-viewer-stage" },
          visualItems.length > 1
            ? el("button", { class: "gallery-viewer-nav previous", title: "上一个", "aria-label": "上一个媒体", onclick: () => setGalleryViewerDirection(collection, -1) }, "←")
            : null,
          media,
          visualItems.length > 1
            ? el("button", { class: "gallery-viewer-nav next", title: "下一个", "aria-label": "下一个媒体", onclick: () => setGalleryViewerDirection(collection, 1) }, "→")
            : null),
        el("div", { class: "gallery-viewer-foot" },
          el("div", { class: "gallery-viewer-meta" },
            el("strong", {}, item.speaker || "未知参与者"),
            el("span", {}, `${item.hkt.slice(0, 16)} · ${kindLabel} · ${formatBytes(item.bytes)}`)),
          el("div", { class: "gallery-viewer-actions" },
            el("button", { class: "btn small", onclick: () => openMessageContextForMedia(item) }, "原消息"),
            el("button", { class: "btn small", onclick: () => window.open(item.webPath, "_blank", "noopener") }, "打开原文件")))),
      event === null ? null : renderGalleryStory(event))));
};

const aggregateRangeState = () => {
  const rangeState = app.mediaTab.rangeState;
  if (rangeState === null || rangeState.error !== undefined) {
    return rangeState;
  }
  const activity = rangeState.activity;
  const duration = rangeState.toUnix - rangeState.fromUnix;
  const totalSeconds = duration * activity.length;
  return {
    coverageRatio: totalSeconds > 0 ? activity.reduce((total, item) => total + item.coveredSeconds, 0) / totalSeconds : 0,
    messageCount: activity.reduce((total, item) => total + item.messageCount, 0),
    mediaMessageCount: activity.reduce((total, item) => total + item.mediaMessageCount, 0),
  };
};

const renderGalleryEmpty = () => {
  if (app.mediaTab.kind !== "all" || app.mediaTab.person !== "all") {
    return el("div", { class: "card empty-state filtered", "data-testid": "gallery-empty-filtered" },
      el("strong", {}, "没有符合筛选的媒体"),
      el("span", {}, "扫描状态不等于筛选结果。清除类型或参与者条件可查看这个范围内的其他媒体。"));
  }
  const state = aggregateRangeState();
  if (state?.error !== undefined) {
    return el("div", { class: "card empty-state risk" }, el("strong", {}, "无法验证扫描状态"), el("span", {}, state.error));
  }
  if (state === null) {
    return el("div", { class: "card empty" }, "没有匹配的媒体文件。调整筛选，或从时间表选择一个明确时段。");
  }
  const empty = galleryEmptyState(state);
  return el("div", { class: `card empty-state ${empty.status}`, "data-testid": `gallery-empty-${empty.status}` },
    el("strong", {}, empty.title),
    el("span", {}, empty.detail),
    el("button", { class: "btn small", onclick: () => void openTimelineRange({
      groupId: app.mediaTab.group,
      fromUnix: app.mediaTab.fromUnix,
      toUnix: app.mediaTab.toUnix,
    }) }, "在时间表中查看"));
};

const renderMediaView = () => {
  const filtered = mediaFilteredItems();
  const renderedCount = galleryRenderedCount();
  const shown = filtered.slice(0, renderedCount);
  const events = galleryEvents();
  const propagationChains = app.mediaTab.surface === "propagation" ? galleryPropagationChains() : [];
  const allItems = (app.mediaTab.data?.items ?? []).filter((item) => item.dup !== true);
  let content;
  if (app.mediaTab.surface === "events") {
    content = events.length === 0 ? renderGalleryEmpty() : renderGalleryEvents(events);
  } else if (app.mediaTab.surface === "files") {
    content = shown.length === 0 ? renderGalleryEmpty() : renderGalleryFiles(shown, events);
  } else if (app.mediaTab.surface === "propagation") {
    content = renderPropagation(propagationChains);
  } else {
    content = renderComparison();
  }
  const surfaceTotal = app.mediaTab.surface === "events"
    ? reviewedGalleryEvents(events).length
    : app.mediaTab.surface === "files" ? filtered.length : propagationChains.length;
  const surfaceLabel = app.mediaTab.surface === "events" ? "事件" : app.mediaTab.surface === "propagation" ? "传播链" : "媒体";
  const gallery = el("div", { class: "media-gallery-surface", "data-testid": "media-gallery" },
    content,
    app.mediaTab.surface !== "compare" && surfaceTotal > renderedCount
      ? el("div", { class: "gallery-load-more" },
          el("span", {}, `已加载 ${renderedCount} / ${surfaceTotal} ${surfaceLabel}`),
          el("button", { class: "btn small", "data-testid": "gallery-load-more", onclick: loadMoreGalleryItems }, "继续加载"))
      : null);
  setChildren($("#view-media"), renderGalleryControls(allItems, filtered), gallery, renderGalleryViewer(shown, events));
  observeGalleryLoadMore();
};

try {
  const surface = GALLERY_SURFACES.has(app.mediaTab.surface) ? app.mediaTab.surface : "events";
  replaceMediaTab({
    surface,
    reviews: loadGalleryReviews(),
    eventActivity: {},
    eventActivityLoading: false,
    eventActivityError: null,
  });
} catch (error) {
  replaceMediaTab({ reviewStorageError: error.message, reviews: {} });
}

document.addEventListener("keydown", (event) => {
  if (app.mediaTab.viewerPath === null || app.view !== "media") {
    return;
  }
  if (event.key === "Escape") {
    replaceMediaTab({ viewerPath: null, viewerEventId: null, story: null });
    renderMediaView();
    return;
  }
  if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
    event.preventDefault();
    const events = galleryEvents();
    const selectedEvent = events.find((candidate) => candidate.id === app.mediaTab.viewerEventId);
    setGalleryViewerDirection(selectedEvent?.items ?? mediaFilteredItems(), event.key === "ArrowLeft" ? -1 : 1);
  }
});
