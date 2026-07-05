"use strict";

/* ---------- messages: inbox (QQ-like group list) + chat (Telegram-like) ---------- */

const nowUnix = () => Math.floor(Date.now() / 1000);

const MSG_PAGE_SIZE = 300;
const BUBBLE_GROUP_GAP_SECONDS = 300;
const AUTO_READ_DEBOUNCE_MS = 1500;

const msgObservers = { scroll: null, read: null, readTimer: null, maxSeen: null };

const shortTime = (unix) => {
  if (!Number.isFinite(unix)) {
    return "";
  }
  const text = unixToHkt(unix);
  const today = unixToHkt(nowUnix()).slice(0, 10);
  return text.slice(0, 10) === today ? text.slice(11, 16) : text.slice(5, 10);
};

const displayText = (item) =>
  item.isMedia === 1 ? mediaLabelText(item.mediaKinds, item.text) : item.text.replace(/�/gu, "");

/* ---------- inbox ---------- */

const renderInbox = () => {
  const overview = app.msg.overview;
  const groups = overview?.groups ?? [];

  const rows = groups.map((group) => {
    const name = group.name || group.groupId;
    const last = group.lastMessage;
    const preview = last === null || last === undefined
      ? "（暂无消息）"
      : `${last.speaker}: ${last.isMedia === 1 ? mediaLabelText(last.mediaKinds, last.text) : last.text}`;
    return el("button", {
      class: "inbox-row",
      onclick: () => openChat({ groupId: group.groupId, groupName: name, fromLastRead: true }),
    },
      avatarEl(name, group.groupId, undefined, groupAvatarUrl(group.groupId)),
      el("span", { class: "inbox-main" },
        el("span", { class: "inbox-top" },
          el("span", { class: "inbox-name" }, name),
          el("span", { class: "inbox-time" }, shortTime(group.lastUnix))),
        el("span", { class: "inbox-bottom" },
          el("span", { class: "inbox-preview" }, preview),
          group.unreadCount > 0
            ? el("span", { class: "badge" }, group.unreadCount > 99 ? "99+" : String(group.unreadCount))
            : null)));
  });

  setChildren($("#view-messages"),
    el("div", { class: "card" },
      el("div", { class: "row", style: "justify-content:space-between;margin-bottom:10px" },
        el("h2", { style: "margin:0" }, "群消息"),
        el("span", { class: "card-sub", style: "margin:0" },
          `本地记录保留 ${overview?.retentionDays ?? 3} 天 · 点群进入，蓝点是未读数`)),
      groups.length === 0
        ? el("div", { class: "empty" }, "还没有本地消息记录，先在「运行」页跑一次总结。")
        : el("div", { class: "inbox-list" }, rows)));
};

/* ---------- chat data ---------- */

const buildMessagesQuery = (reset) => {
  const msg = app.msg;
  const params = new URLSearchParams({ groupId: msg.groupId, limit: String(MSG_PAGE_SIZE) });
  if (Number.isFinite(msg.from)) {
    params.set("from", String(msg.from));
  }
  if (Number.isFinite(msg.to)) {
    params.set("to", String(msg.to));
  }
  if (msg.q.trim().length > 0) {
    params.set("q", msg.q.trim());
  }
  if (!reset && msg.items.length > 0) {
    const last = msg.items.at(-1);
    params.set("afterSentAt", String(last.sentAt));
    params.set("afterRowId", last.rowId);
  }
  return params;
};

// Media messages carry no file path; join against the media index by group + timestamp.
const ensureMediaMap = async () => {
  if (app.msg.mediaMap instanceof Map) {
    return;
  }
  try {
    const data = await api("/api/media-index");
    const map = new Map();
    for (const item of data.items ?? []) {
      const key = `${item.groupId}|${item.hkt}`;
      if (!map.has(key)) {
        map.set(key, []);
      }
      map.get(key).push(item);
    }
    app.msg.mediaMap = map;
  } catch {
    app.msg.mediaMap = new Map();
  }
};

const loadMessages = async (reset) => {
  const msg = app.msg;
  if (msg.groupId === null || msg.loading) {
    return;
  }
  msg.loading = true;
  try {
    if (reset) {
      await ensureMediaMap();
    }
    const result = await api(`/api/messages?${buildMessagesQuery(reset)}`);
    msg.items = reset ? result.messages : [...msg.items, ...result.messages];
    msg.hasMore = result.hasMore;
    msg.coverage = result.coverage ?? [];
    msg.readMark = result.readMark ?? null;
    if (reset && msg.dividerAt === null && msg.readMark !== null) {
      msg.dividerAt = msg.readMark.sentAt;
    }
  } finally {
    msg.loading = false;
  }
};

const openChat = async ({ groupId, groupName, fromUnix, toUnix, fromLastRead }) => {
  const msg = app.msg;
  // A pending auto-read from the previous chat must never fire against this group.
  if (msgObservers.readTimer !== null) {
    clearTimeout(msgObservers.readTimer);
    msgObservers.readTimer = null;
  }
  msgObservers.maxSeen = null;
  msg.mode = "chat";
  msg.groupId = groupId;
  msg.groupName = groupName ?? msg.overview?.groups?.find((group) => group.groupId === groupId)?.name ?? groupId;
  msg.q = "";
  msg.items = [];
  msg.selA = null;
  msg.selB = null;
  msg.scrollToUnread = fromLastRead === true;

  const readMark = msg.overview?.groups?.find((group) => group.groupId === groupId)?.readMark ?? null;
  msg.dividerAt = readMark?.sentAt ?? null;
  if (fromLastRead === true) {
    msg.from = readMark !== null ? readMark.sentAt - 1800 : nowUnix() - 48 * 3600;
    msg.to = null;
    msg.rangeKey = "lastread";
  } else {
    msg.from = fromUnix ?? null;
    msg.to = toUnix ?? null;
    msg.rangeKey = "custom";
  }

  renderMessagesView();
  try {
    await loadMessages(true);
  } catch (error) {
    alert(`读取消息失败: ${error.message}`);
  }
  renderMessagesView();
};

const openMessagesView = async (preset) => {
  showView("messages");
  if (preset?.groupId !== undefined) {
    try {
      app.msg.overview = await api("/api/store-overview");
    } catch {
      app.msg.overview = app.msg.overview ?? null;
    }
    await openChat({ ...preset, fromLastRead: preset.fromLastRead === true });
    return;
  }
  app.msg.mode = "inbox";
  renderMessagesView();
  try {
    app.msg.overview = await api("/api/store-overview");
  } catch (error) {
    setChildren($("#view-messages"),
      el("div", { class: "card" }, el("div", { class: "notice risk" }, `读取消息库失败: ${error.message}`)));
    return;
  }
  renderMessagesView();
};

/* ---------- read mark ---------- */

const postReadMark = async (body) => {
  const result = await api("/api/readmark", { method: "POST", body: JSON.stringify({ groupId: app.msg.groupId, ...body }) });
  app.msg.readMark = result.readMark;
  if (app.msg.overview?.groups !== undefined) {
    const group = app.msg.overview.groups.find((entry) => entry.groupId === app.msg.groupId);
    if (group !== undefined && result.readMark !== null) {
      group.readMark = result.readMark;
      group.unreadCount = app.msg.items.filter((item) => item.sentAt > result.readMark.sentAt).length;
    }
  }
};

const markReadToLatest = async () => {
  try {
    await postReadMark({ toLatest: true });
    renderMessagesView();
  } catch (error) {
    alert(error.message);
  }
};

// Advance the read mark as messages actually scroll into view (advance-only on the server).
const scheduleAutoRead = (sentAt, rowId) => {
  const seen = msgObservers.maxSeen;
  if (seen === null || seen.groupId !== app.msg.groupId || sentAt > seen.sentAt) {
    msgObservers.maxSeen = { groupId: app.msg.groupId, sentAt, rowId };
  }
  if (msgObservers.readTimer !== null) {
    return;
  }
  msgObservers.readTimer = setTimeout(async () => {
    msgObservers.readTimer = null;
    const target = msgObservers.maxSeen;
    if (target === null
      || target.groupId !== app.msg.groupId
      || (app.msg.readMark !== null && target.sentAt <= app.msg.readMark.sentAt)) {
      return;
    }
    try {
      await postReadMark({ sentAt: target.sentAt, rowId: target.rowId });
    } catch {
      // Losing one auto-mark is fine; the next scroll retries.
    }
  }, AUTO_READ_DEBOUNCE_MS);
};

/* ---------- selection + quick summary ---------- */

const selectionRange = () => {
  const { selA, selB } = app.msg;
  if (selA === null) {
    return null;
  }
  const end = selB ?? selA;
  return { lo: Math.min(selA, end), hi: Math.max(selA, end) };
};

const onSelectMessage = (index) => {
  const msg = app.msg;
  if (msg.selA === null || msg.selB !== null) {
    msg.selA = index;
    msg.selB = null;
  } else {
    msg.selB = index;
  }
  renderMessagesView();
};

const clearSelection = () => {
  app.msg.selA = null;
  app.msg.selB = null;
  renderMessagesView();
};

const showModal = (title, ...bodyNodes) => {
  const close = () => mask.remove();
  const mask = el("div", { class: "modal-mask", onclick: (event) => { if (event.target === mask) { close(); } } },
    el("div", { class: "modal card" },
      el("div", { class: "row", style: "justify-content:space-between;margin-bottom:10px" },
        el("h2", { style: "margin:0" }, title),
        el("button", { class: "btn small", onclick: close }, "关闭")),
      el("div", { class: "modal-body" }, bodyNodes)));
  document.body.append(mask);
  return { close, mask };
};

const quickSummaryResultNodes = (result) => [
  el("p", { style: "margin:0 0 10px" }, result.summary || "（无总结）"),
  result.points?.length > 0
    ? el("ul", { style: "margin:0 0 10px;padding-left:18px" }, result.points.map((point) => el("li", {}, point)))
    : null,
  result.actions?.length > 0
    ? el("div", {},
        el("h4", { style: "margin:8px 0 4px;font-size:13px" }, "待办 / 提问"),
        el("ul", { class: "item-list" }, result.actions.map((action) =>
          el("li", { class: action.status === "resolved" ? "resolved" : "" },
            `${action.status === "resolved" ? "✅" : "⏳"} ${action.text}`,
            action.resolution ? el("span", { class: "ev" }, `处理：${action.resolution}`) : null))))
    : null,
  el("p", { class: "card-sub", style: "margin:10px 0 0" }, `基于 ${result.messageCount ?? "?"} 条文本消息 · ${result.model ?? ""}`),
];

const summarizeSelection = async () => {
  const range = selectionRange();
  if (range === null) {
    return;
  }
  const items = app.msg.items.slice(range.lo, range.hi + 1);
  if (items.length === 0) {
    clearSelection();
    return;
  }
  const fromUnix = items[0].sentAt;
  const toUnix = items.at(-1).sentAt;

  const status = el("p", { style: "margin:0" }, `正在总结选中的 ${items.length} 条消息…（约 10-30 秒）`);
  const modal = showModal("选段总结", status);
  try {
    await api("/api/quick-summary", { method: "POST", body: JSON.stringify({ groupId: app.msg.groupId, fromUnix, toUnix }) });
  } catch (error) {
    status.textContent = `启动失败: ${error.message}`;
    return;
  }

  const poll = setInterval(async () => {
    if (!document.body.contains(modal.mask)) {
      clearInterval(poll);
      return;
    }
    try {
      const snapshot = await api("/api/quick-summary");
      const job = snapshot.job;
      if (job === null || job.status === "running") {
        return;
      }
      clearInterval(poll);
      if (job.status === "done" && job.result !== null) {
        setChildren(modal.mask.querySelector(".modal-body"), quickSummaryResultNodes(job.result));
        clearSelection();
      } else {
        status.textContent = `总结失败: ${job.error ?? "未知错误"}`;
      }
    } catch (error) {
      clearInterval(poll);
      status.textContent = `查询失败: ${error.message}`;
    }
  }, 1500);
};

/* ---------- chat rendering ---------- */

const coverageGapBetween = (prevUnix, nextUnix) =>
  app.msg.coverage.some((range) => range.endUnix > prevUnix && range.endUnix < nextUnix);

const isImageFile = (kind) => kind === "image" || kind === "sticker" || kind === "face";

const mediaFileFor = (item, counters) => {
  if (item.isMedia !== 1 || !(app.msg.mediaMap instanceof Map)) {
    return null;
  }
  const key = `${item.groupId}|${unixToHkt(item.sentAt)}`;
  const list = app.msg.mediaMap.get(key);
  if (list === undefined) {
    return null;
  }
  const used = counters.get(key) ?? 0;
  counters.set(key, used + 1);
  return list[used] ?? list[0];
};

const chatMessageNode = (item, index, inSelection, mediaFile) => {
  const isUnread = app.msg.dividerAt !== null && item.sentAt > app.msg.dividerAt;
  const showImage = mediaFile != null && isImageFile(mediaFile.kind);
  const classes = ["bubble"];
  if (item.isMedia === 1) {
    classes.push("media");
  }
  if (showImage) {
    classes.push("has-img");
  }
  if (inSelection) {
    classes.push("sel");
  }
  if (isUnread) {
    classes.push("unread");
  }
  return el("div", {
    class: classes.join(" "),
    dataset: { idx: String(index), sentat: String(item.sentAt), rowid: item.rowId },
    onclick: mediaFile != null ? () => window.open(mediaFile.webPath, "_blank", "noopener") : undefined,
    oncontextmenu: (event) => {
      event.preventDefault();
      onSelectMessage(index);
    },
  },
    showImage
      ? el("img", { class: "bubble-img", src: mediaFile.webPath, loading: "lazy", alt: "图片" })
      : displayText(item),
    el("time", {}, unixToHkt(item.sentAt).slice(11, 16)));
};

const compactMessageNode = (item, index, inSelection) => {
  const classes = ["msg-row"];
  if (item.isMedia === 1) {
    classes.push("media");
  }
  if (inSelection) {
    classes.push("sel");
  }
  if (app.msg.dividerAt !== null && item.sentAt > app.msg.dividerAt) {
    classes.push("unread");
  }
  return el("div", {
    class: classes.join(" "),
    dataset: { idx: String(index), sentat: String(item.sentAt), rowid: item.rowId },
    oncontextmenu: (event) => {
      event.preventDefault();
      onSelectMessage(index);
    },
  },
    el("time", {}, unixToHkt(item.sentAt).slice(5, 16)),
    el("span", { class: "msg-speaker" }, item.speaker),
    el("span", { class: "msg-text" }, displayText(item)));
};

const buildChatNodes = () => {
  const msg = app.msg;
  const nodes = [];
  const range = selectionRange();
  const mediaCounters = new Map();
  let currentDay = "";
  let dividerPlaced = msg.dividerAt === null;
  let bubbleBody = null;
  let prevItem = null;

  msg.items.forEach((item, index) => {
    const day = unixToHkt(item.sentAt).slice(0, 10);
    let breakGroup = false;

    if (!dividerPlaced && item.sentAt > msg.dividerAt) {
      nodes.push(el("div", { class: "msg-unread-divider", id: "unread-divider" }, "── 上次读到这里 ──"));
      dividerPlaced = true;
      breakGroup = true;
    }
    if (day !== currentDay) {
      nodes.push(el("div", { class: "msg-day" }, day));
      currentDay = day;
      breakGroup = true;
    }
    if (prevItem !== null && coverageGapBetween(prevItem.sentAt, item.sentAt)) {
      nodes.push(el("div", { class: "msg-gap" }, "⚠ 这段时间之间可能存在未扫描的消息"));
      breakGroup = true;
    }

    const inSelection = range !== null && index >= range.lo && index <= range.hi;
    if (msg.style === "compact") {
      nodes.push(compactMessageNode(item, index, inSelection));
    } else {
      const sameGroup = !breakGroup
        && prevItem !== null
        && prevItem.speaker === item.speaker
        && item.sentAt - prevItem.sentAt < BUBBLE_GROUP_GAP_SECONDS
        && bubbleBody !== null;
      if (!sameGroup) {
        bubbleBody = el("div", { class: "bg-col" },
          el("div", { class: "bg-head" }, item.speaker, el("time", {}, shortTime(item.sentAt))));
        nodes.push(el("div", { class: "bubble-group" },
          avatarEl(item.speaker, item.speaker, "sm", userAvatarUrl(item.speakerUin)), bubbleBody));
      }
      bubbleBody.append(chatMessageNode(item, index, inSelection, mediaFileFor(item, mediaCounters)));
    }
    prevItem = item;
  });

  return nodes;
};

const setupChatObservers = (listNode) => {
  msgObservers.scroll?.disconnect();
  msgObservers.read?.disconnect();

  const sentinel = listNode.querySelector(".load-sentinel");
  if (sentinel !== null) {
    msgObservers.scroll = new IntersectionObserver(async (entries) => {
      if (entries.some((entry) => entry.isIntersecting) && app.msg.hasMore && !app.msg.loading) {
        const keepScroll = listNode.scrollTop;
        try {
          await loadMessages(false);
        } catch {
          return;
        }
        renderMessagesView();
        const nextList = document.querySelector(".chat-scroll");
        if (nextList !== null) {
          nextList.scrollTop = keepScroll;
        }
      }
    }, { root: listNode, rootMargin: "200px" });
    msgObservers.scroll.observe(sentinel);
  }

  msgObservers.read = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) {
        const { sentat, rowid } = entry.target.dataset;
        scheduleAutoRead(Number(sentat), rowid ?? "");
      }
    }
  }, { root: listNode, threshold: 0.5 });
  for (const node of listNode.querySelectorAll("[data-sentat]")) {
    msgObservers.read.observe(node);
  }
};

const chatRangeChips = () => {
  const msg = app.msg;
  const chip = (key, label, apply) =>
    el("button", {
      class: `chip ${msg.rangeKey === key ? "on" : ""}`,
      onclick: async () => {
        msg.rangeKey = key;
        apply();
        msg.items = [];
        msg.selA = null;
        msg.selB = null;
        msg.scrollToUnread = key === "lastread";
        renderMessagesView();
        try {
          await loadMessages(true);
        } catch (error) {
          alert(error.message);
        }
        renderMessagesView();
      },
    }, label);

  return el("div", { class: "chips" },
    chip("lastread", "从上次已读", () => {
      msg.from = msg.readMark !== null ? msg.readMark.sentAt - 1800 : nowUnix() - 48 * 3600;
      msg.to = null;
      msg.dividerAt = msg.readMark?.sentAt ?? null;
    }),
    chip("today", "今天", () => {
      msg.from = hktToUnix(`${unixToHkt(nowUnix()).slice(0, 10)} 00:00:00`);
      msg.to = null;
    }),
    chip("24h", "最近 24 小时", () => {
      msg.from = nowUnix() - 24 * 3600;
      msg.to = null;
    }),
    chip("all", "全部记录", () => {
      msg.from = null;
      msg.to = null;
    }));
};

const renderChat = () => {
  const msg = app.msg;
  const listNodes = buildChatNodes();

  const list = el("div", { class: `chat-scroll ${msg.style === "compact" ? "msg-list" : "chat-list"}` },
    msg.items.length === 0 && !msg.loading
      ? el("div", { class: "empty" }, "这个范围内没有本地记录。")
      : listNodes,
    msg.hasMore ? el("div", { class: "load-sentinel empty" }, "下滑加载更多…") : null);

  const header = el("div", { class: "card chat-head" },
    el("div", { class: "row", style: "margin-bottom:10px" },
      el("button", { class: "btn small", onclick: () => { openMessagesView(); } }, "← 群列表"),
      avatarEl(msg.groupName, msg.groupId, "sm", groupAvatarUrl(msg.groupId)),
      el("h2", { style: "margin:0;font-size:16px" }, msg.groupName),
      el("span", { class: "card-sub", style: "margin:0" }, `${msg.items.length} 条${msg.hasMore ? "+" : ""}`),
      el("span", { style: "flex:1" }),
      el("button", {
        class: "btn small",
        onclick: () => {
          msg.style = msg.style === "compact" ? "bubble" : "compact";
          localStorage.setItem("cc-msgstyle", msg.style);
          renderMessagesView();
        },
      }, msg.style === "compact" ? "🗨️ 气泡模式" : "☰ 紧凑模式"),
      el("button", { class: "btn small", onclick: markReadToLatest }, "全部标为已读")),
    el("div", { class: "row" },
      chatRangeChips(),
      el("input", {
        type: "text",
        placeholder: "搜索关键词或发言人…",
        value: msg.q,
        style: "width:200px;margin-left:auto",
        onchange: async (event) => {
          msg.q = event.target.value;
          msg.items = [];
          msg.selA = null;
          msg.selB = null;
          renderMessagesView();
          try {
            await loadMessages(true);
          } catch (error) {
            alert(error.message);
          }
          renderMessagesView();
        },
      })),
    el("p", { class: "card-sub", style: "margin:8px 0 0" }, "提示：右键点一条消息选起点，再右键另一条选终点，可对选中段落做 AI 总结。"));

  const range = selectionRange();
  const selectionBar = range === null ? null
    : el("div", { class: "sel-bar" },
        el("span", {}, app.msg.selB === null ? "已选起点，右键另一条消息选终点" : `已选 ${range.hi - range.lo + 1} 条`),
        el("button", { class: "btn small primary", onclick: summarizeSelection, disabled: app.msg.selB === null && app.msg.selA === null }, "🧠 总结所选"),
        el("button", { class: "btn small", onclick: clearSelection }, "取消"));

  setChildren($("#view-messages"), header, list, selectionBar);
  setupChatObservers(list);

  if (msg.scrollToUnread) {
    msg.scrollToUnread = false;
    const divider = list.querySelector("#unread-divider");
    if (divider !== null) {
      divider.scrollIntoView({ block: "center" });
    } else {
      list.scrollTop = list.scrollHeight;
    }
  }
};

const renderMessagesView = () => {
  if (app.msg.mode === "chat" && app.msg.groupId !== null) {
    renderChat();
  } else {
    renderInbox();
  }
};
