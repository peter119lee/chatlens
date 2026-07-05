const fs = require("node:fs");
const path = require("node:path");

const parseArgs = (argv) => {
  if (argv.length !== 4 && argv.length !== 5) {
    throw new Error("Usage: node analyze_export.js <inputJson> <outputDir> [groupId]");
  }

  return {
    inputJson: argv[2],
    outputDir: argv[3],
    groupId: argv[4] ?? null,
  };
};

const filterInputByGroup = (input, groupId) => {
  const messages = (input.messages ?? []).filter((message) => String(message.groupId) === groupId);
  const mediaMessages = (input.mediaMessages ?? []).filter((message) => String(message.groupId) === groupId);
  return {
    ...input,
    groupIds: [groupId],
    groupNames: { [groupId]: input.groupNames?.[groupId] ?? "" },
    matched: messages.length,
    matchedMedia: mediaMessages.length,
    messages,
    mediaMessages,
  };
};

const formatDateTime = (unixSeconds) =>
  new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Hong_Kong",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(unixSeconds * 1000));

const formatDate = (unixSeconds) => formatDateTime(unixSeconds).slice(0, 10);

const cleanText = (text) =>
  text
    .replace(/\u0000/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

const getSpeaker = (message) =>
  message.senderName || message.memberName || message.senderUin || message.senderUid || "Unknown";

const countBy = (items, getKey) => {
  const counts = new Map();
  for (const item of items) {
    const key = getKey(item);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()].sort((left, right) => right[1] - left[1]);
};

const extractUrls = (text) => text.match(/https?:\/\/[^\s<>"'）)]+/gu) ?? [];

const formatMediaRefs = (mediaRefs) =>
  [...new Map(
    mediaRefs.map((ref) => {
      const name = ref.fileName ?? ref.hash ?? ref.url ?? "unknown";
      return [`${ref.kind}:${String(name).toLowerCase()}`, `${ref.kind}:${name}`];
    }),
  ).values()]
    .join("; ");

const stopWords = new Set([
  "这个",
  "那个",
  "什么",
  "怎么",
  "可以",
  "可能",
  "还是",
  "就是",
  "不是",
  "没有",
  "已经",
  "现在",
  "今天",
  "昨天",
  "明天",
  "一下",
  "一个",
  "直接",
  "然后",
  "应该",
  "感觉",
  "看看",
  "哈哈",
  "的话",
  "是不是",
  "为什么",
  "有人",
  "大家",
  "我们",
  "你们",
  "他们",
  "自己",
  "这里",
  "那里",
  "问题",
  "东西",
  "消息",
  "群里",
  "the",
  "and",
  "for",
  "with",
  "that",
  "this",
  "from",
  "http",
  "https",
  "com",
]);

const splitChineseTerms = (text) => text.match(/[\p{Script=Han}]{2,8}/gu) ?? [];

const splitAlphaNumericTerms = (text) => text.match(/[a-zA-Z][a-zA-Z0-9_-]{2,}|[0-9]{3,}/gu) ?? [];

const normalizeToken = (token) => token.toLowerCase().trim();

const isUsefulToken = (token) =>
  token.length >= 2 &&
  token.length <= 24 &&
  !stopWords.has(token) &&
  !/^\d{1,2}$/u.test(token) &&
  !/^https?$/iu.test(token);

const extractTokens = (text) =>
  [...splitChineseTerms(text), ...splitAlphaNumericTerms(text)]
    .map(normalizeToken)
    .filter(isUsefulToken);

const topTokenStats = (messages) => {
  const counts = new Map();
  const messageCounts = new Map();
  for (const message of messages) {
    const tokens = extractTokens(message.text);
    for (const token of tokens) {
      counts.set(token, (counts.get(token) ?? 0) + 1);
    }
    for (const token of new Set(tokens)) {
      messageCounts.set(token, (messageCounts.get(token) ?? 0) + 1);
    }
  }

  return [...counts.entries()]
    .map(([token, count]) => ({
      token,
      count,
      messages: messageCounts.get(token) ?? 0,
    }))
    .filter((item) => item.messages >= 2 || item.count >= 3)
    .sort((left, right) => right.messages - left.messages || right.count - left.count || left.token.localeCompare(right.token));
};

const getMessageTokens = (message, importantTokens) => {
  const important = new Set(importantTokens);
  return [...new Set(extractTokens(message.text).filter((token) => important.has(token)))];
};

const scoreTopicSeed = (seed, messages, importantTokens) => {
  const seedTokens = new Set(getMessageTokens(seed, importantTokens));
  if (seedTokens.size === 0) {
    return [];
  }

  return messages
    .map((message) => {
      const tokens = getMessageTokens(message, importantTokens);
      const overlap = tokens.filter((token) => seedTokens.has(token)).length;
      const timeDistanceHours = Math.abs(message.sentAt - seed.sentAt) / 3600;
      const timeScore = timeDistanceHours <= 3 ? 1 : timeDistanceHours <= 12 ? 0.4 : 0;
      const score = overlap * 3 + timeScore;
      return {
        message,
        score,
        tokens,
      };
    })
    .filter((item) => item.score >= 3)
    .sort((left, right) => right.score - left.score || left.message.sentAt - right.message.sentAt);
};

const getTopicName = (items) => {
  const tokens = topTokenStats(items.map((item) => item.message))
    .map((item) => item.token)
    .slice(0, 4);
  if (tokens.length > 0) {
    return tokens.join(" / ");
  }

  const sampleText = items[0]?.message.text.replace(/\s+/gu, " ").slice(0, 18);
  return sampleText ? `关于 ${sampleText}` : "动态主题";
};

const topicFromItems = (id, name, items) => {
  const topicMessages = items
    .map((item) => item.message)
    .sort((left, right) => left.sentAt - right.sentAt);
  return {
    id,
    name,
    count: topicMessages.length,
    firstHkt: topicMessages[0]?.hkt ?? null,
    lastHkt: topicMessages.at(-1)?.hkt ?? null,
    topSpeakers: countBy(topicMessages, (message) => message.speaker).slice(0, 8),
    keywords: topTokenStats(topicMessages).slice(0, 10),
    sampleMessages: topicMessages.slice(-40).map((message) => ({
      hkt: message.hkt,
      groupId: message.groupId,
      groupName: message.groupName,
      speaker: message.speaker,
      text: message.text,
    })),
  };
};

const buildDynamicTopics = (messages) => {
  if (messages.length === 0) {
    return [];
  }

  const tokenStats = topTokenStats(messages);
  const importantTokens = tokenStats.slice(0, 80).map((item) => item.token);
  const seedMessages = messages
    .map((message) => ({
      message,
      tokenCount: getMessageTokens(message, importantTokens).length,
      textLength: message.text.length,
    }))
    .filter((item) => item.tokenCount > 0)
    .sort((left, right) => right.tokenCount - left.tokenCount || right.textLength - left.textLength)
    .map((item) => item.message);

  const used = new Set();
  const topics = [];
  for (const seed of seedMessages) {
    if (used.has(seed.id ?? `${seed.sentAt}:${seed.text}`)) {
      continue;
    }

    const items = scoreTopicSeed(seed, messages, importantTokens)
      .filter((item) => !used.has(item.message.id ?? `${item.message.sentAt}:${item.message.text}`))
      .slice(0, 80);
    if (items.length < 2) {
      continue;
    }

    for (const item of items) {
      used.add(item.message.id ?? `${item.message.sentAt}:${item.message.text}`);
    }

    topics.push(topicFromItems(`topic-${topics.length + 1}`, getTopicName(items), items));
    if (topics.length >= 12) {
      break;
    }
  }

  const unmatched = messages.filter((message) => !used.has(message.id ?? `${message.sentAt}:${message.text}`));
  if (unmatched.length > 0) {
    const fallbackItems = unmatched.map((message) => ({
      message,
      score: 1,
      tokens: getMessageTokens(message, importantTokens),
    }));
    topics.push(topicFromItems("misc", "未归类 / 零散消息", fallbackItems));
  }

  return topics;
};

const TIME_BLOCK_GAP_SECONDS = 30 * 60;

const buildTimeBlocks = (messages) => {
  const blocks = [];
  for (const message of messages) {
    const last = blocks.at(-1);
    if (last === undefined || message.sentAt - last.endUnix > TIME_BLOCK_GAP_SECONDS) {
      blocks.push({
        startUnix: message.sentAt,
        endUnix: message.sentAt,
        startHkt: message.hkt,
        endHkt: message.hkt,
        count: 0,
        speakerCounts: new Map(),
      });
    }

    const block = blocks.at(-1);
    block.endUnix = message.sentAt;
    block.endHkt = message.hkt;
    block.count += 1;
    block.speakerCounts.set(message.speaker, (block.speakerCounts.get(message.speaker) ?? 0) + 1);
  }

  return blocks.map((block) => ({
    startUnix: block.startUnix,
    endUnix: block.endUnix,
    startHkt: block.startHkt,
    endHkt: block.endHkt,
    count: block.count,
    topSpeakers: [...block.speakerCounts.entries()]
      .sort((left, right) => right[1] - left[1])
      .slice(0, 5),
  }));
};

const buildSignalStats = (messages) => {
  const urls = messages.flatMap((message) =>
    extractUrls(message.text).map((url) => ({
      hkt: message.hkt,
      speaker: message.speaker,
      url,
      text: message.text,
    })),
  );
  const possibleActions = messages
    .filter((message) => /(?:请|麻烦|需要|能否|能不能|帮我|帮忙|谁能|处理|确认|回复|看看|解决|安排|发一下|给一下)/iu.test(message.text))
    .slice(-80)
    .map((message) => ({
      hkt: message.hkt,
      groupId: message.groupId,
      groupName: message.groupName,
      speaker: message.speaker,
      text: message.text,
    }));
  const riskSignals = messages
    .filter((message) => /(?:报错|错误|失败|不能用|异常|投诉|退款|封号|丢失|泄露|风险|报警|崩|挂|卡死|超时|timeout|404|403|401|429)/iu.test(message.text))
    .slice(-80)
    .map((message) => ({
      hkt: message.hkt,
      groupId: message.groupId,
      groupName: message.groupName,
      speaker: message.speaker,
      text: message.text,
    }));

  return {
    urls,
    possibleActions,
    riskSignals,
  };
};

const buildAnalysisReport = (input, messages, mediaMessages, topics, signalStats) => ({
  groupIds: input.groupIds ?? (input.groupId === undefined ? [] : [input.groupId]),
  groupNames: input.groupNames ?? {},
  scanned: input.scanned,
  matchedRaw: input.matched,
  matchedMediaRaw: input.matchedMedia ?? mediaMessages.length,
  parsedTextMessages: messages.length,
  parsedMediaMessages: mediaMessages.length,
  firstMessageHkt: messages[0]?.hkt ?? null,
  lastMessageHkt: messages.at(-1)?.hkt ?? null,
  byDay: countBy(messages, (message) => message.day).sort((left, right) => left[0].localeCompare(right[0])),
  byGroup: countBy(messages, (message) => message.groupName || message.groupId || "unknown-group"),
  topSpeakers: countBy(messages, (message) => message.speaker).slice(0, 20),
  keywordStats: topTokenStats(messages).slice(0, 30).map((item) => ({
    name: item.token,
    count: item.messages,
    occurrences: item.count,
  })),
  topics,
  timeBlocks: buildTimeBlocks(messages),
  urls: signalStats.urls,
  possibleActions: signalStats.possibleActions,
  riskSignals: signalStats.riskSignals,
  llmSummary: null,
  mediaSummary: {
    messages: mediaMessages.length,
    refs: mediaMessages.reduce((total, message) => total + message.mediaRefs.length, 0),
    byKind: countBy(mediaMessages.flatMap((message) => message.mediaRefs), (ref) => ref.kind),
  },
});

const main = () => {
  const args = parseArgs(process.argv);
  const rawInput = JSON.parse(fs.readFileSync(args.inputJson, "utf8"));
  const input = args.groupId === null ? rawInput : filterInputByGroup(rawInput, args.groupId);
  fs.mkdirSync(args.outputDir, { recursive: true });

  const messages = input.messages
    .map((message) => ({
      ...message,
      hkt: formatDateTime(message.sentAt),
      day: formatDate(message.sentAt),
      speaker: getSpeaker(message),
      text: cleanText(message.text),
    }))
    .filter((message) => message.text.length > 0);

  const mediaMessages = (input.mediaMessages ?? []).map((message) => ({
    ...message,
    hkt: formatDateTime(message.sentAt),
    day: formatDate(message.sentAt),
    speaker: getSpeaker(message),
  }));

  const lines = messages.map((message) => {
    const groupLabel = message.groupName || message.groupId || "unknown-group";
    return `[${message.hkt}] [${groupLabel}] ${message.speaker}: ${message.text}`;
  });
  fs.writeFileSync(path.join(args.outputDir, "messages-clean.txt"), `${lines.join("\n")}\n`, "utf8");

  for (const [day] of countBy(messages, (message) => message.day).sort((left, right) => left[0].localeCompare(right[0]))) {
    const dayLines = messages
      .filter((message) => message.day === day)
      .map((message) => {
        const groupLabel = message.groupName || message.groupId || "unknown-group";
        return `[${message.hkt.slice(11)}] [${groupLabel}] ${message.speaker}: ${message.text}`;
      });
    fs.writeFileSync(path.join(args.outputDir, `${day}.txt`), `${dayLines.join("\n")}\n`, "utf8");
  }

  const topics = buildDynamicTopics(messages);
  if (mediaMessages.length > 0) {
    topics.push({
      id: "media",
      name: "媒体消息",
      count: mediaMessages.length,
      firstHkt: mediaMessages[0]?.hkt ?? null,
      lastHkt: mediaMessages.at(-1)?.hkt ?? null,
      topSpeakers: countBy(mediaMessages, (message) => message.speaker).slice(0, 8),
      keywords: [],
      sampleMessages: mediaMessages.slice(-40).map((message) => ({
        hkt: message.hkt,
        groupId: message.groupId,
        groupName: message.groupName,
        speaker: message.speaker,
        text: `[${message.mediaRefs.length} media] ${formatMediaRefs(message.mediaRefs)}`,
      })),
    });
  }

  const signalStats = buildSignalStats(messages);
  const report = buildAnalysisReport(input, messages, mediaMessages, topics, signalStats);

  fs.writeFileSync(path.join(args.outputDir, "messages.json"), JSON.stringify(messages, null, 2), "utf8");
  fs.writeFileSync(path.join(args.outputDir, "media-messages.json"), JSON.stringify(mediaMessages, null, 2), "utf8");
  fs.writeFileSync(path.join(args.outputDir, "topics.json"), JSON.stringify(topics, null, 2), "utf8");
  fs.writeFileSync(path.join(args.outputDir, "analysis.json"), JSON.stringify(report, null, 2), "utf8");
  console.log(JSON.stringify(report, null, 2));
};

main();
