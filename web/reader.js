"use strict";

/* ---------- reader view ---------- */

const stampsRange = (stamps, padSeconds = 600) => {
  const valid = stamps.filter((value) => value !== null);
  if (valid.length === 0) {
    return null;
  }
  return { from: Math.min(...valid) - padSeconds, to: Math.max(...valid) + padSeconds };
};

const jumpToMessagesButton = (groupId, range, label = "查看该时段完整消息") =>
  range !== null
    ? el("button", {
        class: "btn small",
        style: "margin-top:8px",
        onclick: () => openMessagesView({ groupId, fromUnix: range.from, toUnix: range.to }),
      }, label)
    : null;

const topicNodes = (group) => {
  if (group.llmSummary !== null) {
    const topics = group.llmSummary.topics ?? [];
    if (topics.length === 0) {
      return [el("p", { class: "empty" }, "LLM 没有归纳出主题。")];
    }
    return topics.map((topic) => {
      const range = stampsRange((topic.evidence ?? []).map(hktToUnix));
      const details = el("details", { class: "topic" },
        el("summary", {},
          el("span", {}, topic.title),
          el("span", { class: `imp ${topic.importance}` }, `${topic.importance} · 约 ${topic.messageCountEstimate} 条`)),
        el("div", { class: "topic-body" },
          el("p", { class: "summary-line" }, topic.summary),
          (topic.details ?? []).length > 0 ? el("h4", {}, "要点") : null,
          (topic.details ?? []).length > 0 ? el("ul", {}, topic.details.map((item) => el("li", {}, item))) : null,
          (topic.evidence ?? []).length > 0 ? el("h4", {}, "证据") : null,
          (topic.evidence ?? []).length > 0 ? el("ul", { class: "evidence" }, topic.evidence.map((item) => el("li", {}, item))) : null,
          jumpToMessagesButton(group.groupId, range)));
      details.open = true;
      return details;
    });
  }

  const topics = (group.localTopics ?? []).filter((topic) => topic.id !== "misc").slice(0, 8);
  if (topics.length === 0) {
    return [el("p", { class: "empty" }, "本时段没有可归纳的文本消息。")];
  }
  return topics.map((topic) =>
    el("details", { class: "topic" },
      el("summary", {},
        el("span", {}, topic.name),
        el("span", { class: "imp low" }, `${topic.count} 条`)),
      el("div", { class: "topic-body" },
        el("ul", {}, (topic.sampleMessages ?? []).map((message) =>
          el("li", {},
            el("span", { style: "color:var(--muted)" }, `[${message.hkt}] `),
            el("b", {}, message.speaker),
            `: ${message.text}`))),
        jumpToMessagesButton(group.groupId, stampsRange((topic.sampleMessages ?? []).map((message) => hktToUnix(message.hkt)))))));
};

const timelineNodes = (group) => {
  const items = group.llmSummary?.timeline ?? [];
  if (items.length === 0) {
    return null;
  }
  return el("div", {},
    el("h4", { style: "margin:14px 0 4px" }, "时间线"),
    el("ul", { class: "item-list" }, items.map((item) => {
      const range = stampsRange([hktToUnix(item.start), hktToUnix(item.end ?? item.start)]);
      return el("li", {},
        el("span", { style: "color:var(--muted)" }, `${item.start}${item.end ? ` - ${item.end}` : ""} `),
        el("b", {}, item.title),
        `（约 ${item.messageCountEstimate} 条）${item.summary} `,
        range !== null
          ? el("button", {
              class: "btn small",
              onclick: () => openMessagesView({ groupId: group.groupId, fromUnix: range.from, toUnix: range.to }),
            }, "查看消息")
          : null);
    })));
};

const uncategorizedNodes = (group) => {
  const items = group.llmSummary?.uncategorized ?? [];
  if (items.length === 0) {
    return null;
  }
  return el("div", {},
    el("h4", { style: "margin:14px 0 4px" }, "未归类但可能重要"),
    el("ul", { class: "item-list" }, items.map((item) =>
      el("li", {},
        el("span", { style: "color:var(--muted)" }, `[${item.hkt}] `),
        el("b", {}, item.speaker),
        `: ${item.note}`))));
};

const groupSectionNode = (group, media) => {
  const groupMedia = media.filter((item) => item.groupId === group.groupId).slice(0, 12);
  const isVideoPath = (value) => /\.(mp4|mov|webm|mkv|avi)$/iu.test(value);

  return el("div", { class: "card group-section", id: `reader-group-${group.groupId}` },
    el("h2", {}, group.name,
      el("small", {}, `${group.groupId} · 文本 ${group.textMessages} · 媒体 ${group.mediaMessages} · ${group.llmSummary !== null ? "LLM 主题" : "本地分组"}${
        Number.isFinite(group.llmSummary?.provider?.messageLines) && group.llmSummary.provider.messageLines < group.textMessages
          ? ` · AI 摘要基于最近 ${group.llmSummary.provider.messageLines} 条`
          : ""
      }`)),
    group.llmSummary?.summary ? el("p", { class: "card-sub" }, group.llmSummary.summary) : null,
    timelineNodes(group),
    topicNodes(group),
    uncategorizedNodes(group),
    groupMedia.length > 0 ? el("h4", { style: "margin:14px 0 4px" }, "媒体抽样") : null,
    groupMedia.length > 0
      ? el("div", { class: "media-grid" }, groupMedia.map((item) =>
          el("figure", {},
            isVideoPath(item.webPath)
              ? el("video", { src: item.webPath, controls: true, preload: "metadata" })
              : el("img", { src: item.webPath, loading: "lazy", alt: `[${item.hkt}] ${item.speaker}` }),
            el("figcaption", {}, `[${item.hkt}] ${item.speaker}`))))
      : null,
    (group.urls ?? []).length > 0 ? el("h4", { style: "margin:14px 0 4px" }, "链接") : null,
    (group.urls ?? []).length > 0
      ? el("ul", { class: "item-list links-list" }, group.urls.map((item) =>
          el("li", {},
            el("span", { style: "color:var(--muted)" }, `[${item.hkt}] `),
            el("b", {}, item.speaker),
            " ",
            /^https?:\/\//iu.test(item.url)
              ? el("a", { href: item.url, target: "_blank", rel: "noopener noreferrer" }, item.url)
              : item.url)))
      : null,
    (group.topSpeakers ?? []).length > 0
      ? el("div", { class: "speakers" }, `活跃: ${group.topSpeakers.map(([name, count]) => `${name} (${count})`).join(" · ")}`)
      : null);
};

const mergedItems = (groups, pick) =>
  groups.flatMap((group) => (pick(group) ?? []).map((item) => ({ ...item, groupName: group.name })));

const openReader = async (runId) => {
  showView("reader");
  setChildren($("#view-reader"), el("div", { class: "card" }, el("div", { class: "empty" }, "加载中…")));

  let detail;
  try {
    detail = await api(`/api/run-detail?id=${encodeURIComponent(runId)}`);
  } catch (error) {
    setChildren($("#view-reader"), el("div", { class: "card" }, el("div", { class: "notice risk" }, error.message)));
    return;
  }

  const actions = mergedItems(detail.groups, (group) => group.llmSummary?.actions)
    .sort((left, right) => Number(left.status === "resolved") - Number(right.status === "resolved"));
  const risks = mergedItems(detail.groups, (group) => group.llmSummary?.risks);

  const head = el("div", { class: "reader-head" },
    el("button", { class: "btn small", onclick: () => { showView("history"); renderHistoryView(); } }, "← 返回"),
    el("h2", {}, `${detail.firstHkt ?? ""} — ${detail.lastHkt ?? ""}`),
    el("span", { class: "tag plain" }, `文本 ${detail.textMessages}`),
    el("span", { class: "tag plain" }, `媒体 ${detail.mediaMessages}`),
    detail.reportHtml !== null ? el("button", { class: "btn small", onclick: openPath(detail.reportHtml) }, "打开原始 HTML") : null);

  const overview = detail.groups.length > 1
    ? el("div", { class: "overview-cards" }, detail.groups.map((group) =>
        el("div", {
          class: "card",
          onclick: () => document.getElementById(`reader-group-${group.groupId}`)?.scrollIntoView({ behavior: "smooth" }),
        },
          el("h3", {}, group.name),
          el("div", { class: "row" },
            el("span", { class: "tag plain" }, `文本 ${group.textMessages}`),
            el("span", { class: "tag plain" }, `媒体 ${group.mediaMessages}`),
            el("span", { class: `tag ${group.llmSummary !== null ? "" : "plain"}` }, group.llmSummary !== null ? "LLM" : "本地")),
          el("p", {}, group.llmSummary?.summary ?? ""))))
    : null;

  const actionsCard = actions.length > 0
    ? el("div", { class: "card" },
        el("h2", {}, "待处理事项（全部群）"),
        el("ul", { class: "item-list" }, actions.map((item) =>
          el("li", { class: item.status === "resolved" ? "resolved" : "" },
            el("span", { class: "gtag" }, `[${item.groupName}]`),
            el("span", { class: "who" }, `${item.status === "resolved" ? "✅" : "⏳"} ${item.owner ?? "未指定"}`),
            item.task,
            item.resolution ? el("span", { class: "ev" }, `结果: ${item.resolution}`) : null,
            el("span", { class: "ev" }, `证据: ${item.evidence}`)))))
    : null;

  const risksCard = risks.length > 0
    ? el("div", { class: "card" },
        el("h2", {}, "风险点（全部群）"),
        el("ul", { class: "item-list" }, risks.map((item) =>
          el("li", {},
            el("span", { class: "gtag" }, `[${item.groupName}]`),
            el("span", { class: `sev ${item.severity}` }, item.severity),
            item.risk,
            el("span", { class: "ev" }, `证据: ${item.evidence}`)))))
    : null;

  setChildren($("#view-reader"), 
    head,
    overview,
    actionsCard,
    risksCard,
    ...detail.groups.map((group) => groupSectionNode(group, detail.media)));
};

