const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");

const parseArgs = (argv) => {
  if (argv.length !== 10) {
    throw new Error(
      "Usage: node llm_adapter.js <analysisJson> <messagesJson> <outputJson> <baseUrl> <model> <apiKeyEnv> <maxMessages> <maxChars>",
    );
  }

  const maxMessages = Number.parseInt(argv[8], 10);
  const maxChars = Number.parseInt(argv[9], 10);
  if (!Number.isInteger(maxMessages) || maxMessages <= 0) {
    throw new Error(`Invalid maxMessages. It must be a positive integer. maxMessages=${argv[8]}`);
  }
  if (!Number.isInteger(maxChars) || maxChars <= 0) {
    throw new Error(`Invalid maxChars. It must be a positive integer. maxChars=${argv[9]}`);
  }

  return {
    analysisJson: argv[2],
    messagesJson: argv[3],
    outputJson: argv[4],
    baseUrl: argv[5],
    model: argv[6],
    apiKeyEnv: argv[7],
    maxMessages,
    maxChars,
  };
};

const readJson = (filePath) => JSON.parse(fs.readFileSync(filePath, "utf8"));

// Runaway guard for map-reduce: with the default 400-msg / 50k-char chunk this
// covers ~16k messages per group in a single window before any is dropped —
// far beyond any real watched group's daily volume. Override via LLM_MAX_CHUNKS.
const MAX_CHUNKS = (() => {
  const raw = Number.parseInt(process.env.LLM_MAX_CHUNKS ?? "", 10);
  return Number.isInteger(raw) && raw > 0 ? raw : 40;
})();

const MAP_MAX_TOKENS = 6144;
const REDUCE_MAX_TOKENS = 8192;
const SINGLE_MAX_TOKENS = 6144;

const getChatCompletionsUrl = (rawBaseUrl) => {
  const url = new URL(rawBaseUrl);
  const pathname = url.pathname.replace(/\/+$/u, "");
  url.pathname = pathname.endsWith("/chat/completions") ? pathname : `${pathname}/chat/completions`;
  return url;
};

const requestJson = (url, apiKey, payload) =>
  new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const transport = url.protocol === "http:" ? http : https;
    const request = transport.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port,
        method: "POST",
        path: `${url.pathname}${url.search}`,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
          "content-length": Buffer.byteLength(body),
        },
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          const responseBody = Buffer.concat(chunks).toString("utf8");
          if (response.statusCode < 200 || response.statusCode >= 300) {
            reject(
              new Error(
                `LLM request failed. StatusCode=${response.statusCode} Body=${responseBody.slice(0, 2000)}`,
              ),
            );
            return;
          }

          try {
            resolve(JSON.parse(responseBody));
          } catch (error) {
            reject(new Error(`LLM response was not valid JSON. Body=${responseBody.slice(0, 2000)} Error=${error.message}`));
          }
        });
      },
    );

    request.setTimeout(120000, () => {
      request.destroy(new Error(`LLM request timed out after 120000 ms. Url=${url.toString()}`));
    });
    request.on("error", (error) => reject(error));
    request.write(body);
    request.end();
  });

const sleep = (milliseconds) =>
  new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });

const requestJsonWithRetry = async (url, apiKey, payload) => {
  const delays = [0, 1200, 3000];
  let lastError = null;
  for (let index = 0; index < delays.length; index += 1) {
    if (delays[index] > 0) {
      await sleep(delays[index]);
    }

    try {
      return await requestJson(url, apiKey, payload);
    } catch (error) {
      lastError = error;
      console.warn(
        JSON.stringify({
          level: "warn",
          event: "llm_request_failed",
          attempt: index + 1,
          maxAttempts: delays.length,
          message: error.message,
        }),
      );
    }
  }

  throw lastError;
};

const groupLabel = (message) => message.groupName || message.groupId || "unknown-group";

const formatMessageLine = (message) =>
  `[${message.hkt}] [${groupLabel(message)}] ${message.speaker}: ${String(message.text).replace(/\s+/gu, " ").trim()}`;

// Split EVERY in-window message into consecutive time-ordered chunks that each
// fit the model budget (≤ maxMessages lines and ≤ maxChars). Unlike the old
// capMessages (which kept only the last maxMessages and silently dropped the
// rest of the day), this covers 100% of the messages so a busy group's 24h
// digest actually reflects all 24 hours. MAX_CHUNKS is a runaway guard only.
const buildChunks = (messages, maxMessages, maxChars) => {
  const chunks = [];
  let current = [];
  let currentChars = 0;
  for (const message of messages) {
    const line = formatMessageLine(message);
    const full = current.length >= maxMessages || (current.length > 0 && currentChars + line.length + 1 > maxChars);
    if (full) {
      chunks.push(current);
      current = [];
      currentChars = 0;
      if (chunks.length >= MAX_CHUNKS) {
        break;
      }
    }
    current.push(line);
    currentChars += line.length + 1;
  }
  if (current.length > 0 && chunks.length < MAX_CHUNKS) {
    chunks.push(current);
  }
  const covered = chunks.reduce((total, chunk) => total + chunk.length, 0);
  return { chunks, covered, capped: covered < messages.length };
};

const buildLocalTopicContext = (analysis) =>
  (analysis.topics ?? [])
    .filter((topic) => topic.count > 0)
    .slice(0, 12)
    .map((topic) => ({
      name: topic.name,
      count: topic.count,
      keywords: (topic.keywords ?? []).slice(0, 6).map((item) => item.token ?? item.name ?? String(item)),
    }));

const OUTPUT_SCHEMA = {
  summary: "string",
  topics: [
    {
      title: "string",
      summary: "string",
      importance: "high | medium | low",
      messageCountEstimate: "number",
      details: ["string"],
      evidence: ["string"],
    },
  ],
  timeline: [
    {
      start: "string, e.g. 2026-07-05 09:10",
      end: "string",
      title: "string",
      summary: "string",
      messageCountEstimate: "number",
    },
  ],
  uncategorized: [
    {
      hkt: "string, message time",
      speaker: "string",
      note: "string, what it says and why it may matter",
    },
  ],
  actions: [
    {
      owner: "string | null",
      task: "string",
      status: "open | resolved",
      resolution: "string | null",
      evidence: "string",
    },
  ],
  risks: [
    {
      severity: "high | medium | low",
      risk: "string",
      evidence: "string",
    },
  ],
  links: [
    {
      title: "string",
      url: "string",
      why: "string",
    },
  ],
  announcementDraft: "string | null",
};

const SUMMARY_RULES = [
  "主题 title 必须来自这批消息的真实内容。",
  "每个主题需要 summary、details、evidence。",
  "timeline 按时间段归纳：群聊通常集中在几个时间段，每段给出起止时间、这段时间主要在聊什么。用 localTimeBlocks 提示的分段作参考，可合并或拆分。",
  "uncategorized 列出不属于任何主题、但可能重要的零散消息（通知、约定、金额、链接、提醒、求助），逐条注明时间、发言人和为什么值得注意。纯闲聊不要列。",
  "actions 只列出明确需要人处理或回复的事项。必须检查后续消息：如果已经有人回复、解决或当事人自己搞定了，status 用 resolved 并在 resolution 写一句是谁怎么解决的；仍然没人处理的才用 open。",
  "risks 只列出明显风险、争议、故障、投诉、资金或账号安全问题。",
  "links 只保留值得保存或回看的链接。",
  "如果没有某类内容，用空数组或 null。",
];

const SYSTEM_PROMPT = [
  "你是一个 QQ 群聊摘要分析器。",
  "你必须根据当前输入的消息动态归纳主题，不能使用预设行业分类。",
  "不要因为工具名或示例而默认群聊在讨论 AI、模型、账号、订单或编程，除非消息内容确实在讨论这些。",
  "输出必须是合法 JSON，不要使用 Markdown，不要输出额外解释。",
].join("\n");

// Prompt over an explicit set of already-formatted message lines (no capping
// here — the caller decides the slice/chunk).
const buildPromptFromLines = (analysis, messageLines, partMeta) => ({
  system: SYSTEM_PROMPT,
  user: JSON.stringify(
    {
      task: "请动态总结这些 QQ 群消息。",
      ...(partMeta === undefined
        ? {}
        : {
            partContext: {
              part: partMeta.part,
              totalParts: partMeta.total,
              hint: `这是同一个群按时间先后切分的第 ${partMeta.part}/${partMeta.total} 段消息，请客观提取本段内容，稍后会与其它段合并成完整摘要。`,
            },
          }),
      rules: SUMMARY_RULES,
      outputSchema: OUTPUT_SCHEMA,
      context: {
        groups: analysis.byGroup,
        timeRange: {
          firstMessageHkt: analysis.firstMessageHkt,
          lastMessageHkt: analysis.lastMessageHkt,
        },
        parsedTextMessages: analysis.parsedTextMessages,
        parsedMediaMessages: analysis.parsedMediaMessages,
        localDynamicTopicHints: buildLocalTopicContext(analysis),
        localTimeBlocks: (analysis.timeBlocks ?? []).slice(0, 24).map((block) => ({
          start: block.startHkt,
          end: block.endHkt,
          messages: block.count,
        })),
      },
      messages: messageLines,
    },
    null,
    2,
  ),
});

// Trim a raw map partial before feeding the reduce step. Per-chunk caps keep
// the merge input (and therefore the merge OUTPUT) small enough to fit the
// model's max_tokens — an untrimmed 7-chunk merge overflowed 8192 tokens and
// silently fell back to the local merge.
const trimPartialForReduce = (partial) => ({
  summary: typeof partial.summary === "string" ? partial.summary : "",
  topics: (Array.isArray(partial.topics) ? partial.topics : []).slice(0, 8).map((topic) => ({
    title: topic?.title,
    summary: topic?.summary,
    importance: topic?.importance,
    messageCountEstimate: topic?.messageCountEstimate,
    details: (Array.isArray(topic?.details) ? topic.details : []).slice(0, 2),
    evidence: (Array.isArray(topic?.evidence) ? topic.evidence : []).slice(0, 1),
  })),
  timeline: (Array.isArray(partial.timeline) ? partial.timeline : []).slice(0, 8),
  uncategorized: (Array.isArray(partial.uncategorized) ? partial.uncategorized : []).slice(0, 10),
  actions: (Array.isArray(partial.actions) ? partial.actions : []).slice(0, 10),
  risks: (Array.isArray(partial.risks) ? partial.risks : []).slice(0, 6),
  links: (Array.isArray(partial.links) ? partial.links : []).slice(0, 8),
});

const buildReducePrompt = (analysis, partials) => ({
  system: [
    "你是一个 QQ 群聊摘要合并器。",
    "输入是同一个群、按时间先后切分的多段局部摘要（JSON），请合并成一份完整、不重复的总摘要。",
    "输出必须是合法 JSON，不要使用 Markdown，不要输出额外解释。",
  ].join("\n"),
  user: JSON.stringify(
    {
      task: "把下面同一个群的多段局部摘要合并成一份覆盖整个时间范围的总摘要。",
      rules: [
        "同一主题在多段出现时必须合并成一个 topic：summary 综合各段，details/evidence 取有代表性的，不要堆叠重复。",
        "输出必须精简，宁缺毋滥——这是给忙碌的人快速扫读的，不是流水账。严格遵守下列数量上限：",
        "topics 最多 10 个，按重要性和涉及消息量排序，messageCountEstimate 汇总各段；每个 topic 的 details 最多 3 条、evidence 最多 2 条，evidence 引用要短。",
        "timeline 最多 12 段，按时间顺序合并，相邻同话题可合并成一段。",
        "actions 最多 15 条，优先未解决(open)的；跨段判断状态：某段还是 open、后段已被处理或当事人自己解决的，改成 resolved 并在 resolution 说明是谁怎么解决的；仍无人处理才保留 open。相同事项去重。",
        "uncategorized 最多 15 条、risks 最多 10 条、links 最多 12 条，去重合并，只保留真正值得注意的。",
        "summary 用 3-6 句概括这一整个时间范围最重要的内容。",
        "如果没有某类内容，用空数组或 null。",
      ],
      outputSchema: OUTPUT_SCHEMA,
      context: {
        timeRange: {
          firstMessageHkt: analysis.firstMessageHkt,
          lastMessageHkt: analysis.lastMessageHkt,
        },
        parsedTextMessages: analysis.parsedTextMessages,
        totalParts: partials.length,
      },
      partials: partials.map(trimPartialForReduce),
    },
    null,
    2,
  ),
});

const requiredString = (value, pathName) => {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Invalid LLM JSON. Required string is missing: ${pathName}`);
  }

  return value.trim();
};

const optionalString = (value, pathName) => {
  if (value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new Error(`Invalid LLM JSON. Expected string or null: ${pathName}`);
  }

  return value.trim();
};

const requiredArray = (value, pathName) => {
  if (!Array.isArray(value)) {
    throw new Error(`Invalid LLM JSON. Expected array: ${pathName}`);
  }

  return value;
};

const requiredNumber = (value, pathName) => {
  if (!Number.isFinite(value)) {
    throw new Error(`Invalid LLM JSON. Expected finite number: ${pathName}`);
  }

  return value;
};

const normalizeImportance = (value, pathName) => {
  if (value === "high" || value === "medium" || value === "low") {
    return value;
  }

  throw new Error(`Invalid LLM JSON. Expected high, medium, or low: ${pathName}`);
};

const normalizeTopic = (topic, index) => ({
  title: requiredString(topic.title, `topics[${index}].title`),
  summary: requiredString(topic.summary, `topics[${index}].summary`),
  importance: normalizeImportance(topic.importance, `topics[${index}].importance`),
  messageCountEstimate: requiredNumber(topic.messageCountEstimate, `topics[${index}].messageCountEstimate`),
  details: requiredArray(topic.details, `topics[${index}].details`).map((detail, detailIndex) =>
    requiredString(detail, `topics[${index}].details[${detailIndex}]`),
  ),
  evidence: requiredArray(topic.evidence, `topics[${index}].evidence`).map((evidence, evidenceIndex) =>
    requiredString(evidence, `topics[${index}].evidence[${evidenceIndex}]`),
  ),
});

const normalizeActionStatus = (value) => (value === "resolved" ? "resolved" : "open");

const normalizeAction = (action, index) => ({
  owner: optionalString(action.owner, `actions[${index}].owner`),
  task: requiredString(action.task, `actions[${index}].task`),
  status: normalizeActionStatus(action.status),
  resolution: typeof action.resolution === "string" && action.resolution.trim().length > 0 ? action.resolution.trim() : null,
  evidence: requiredString(action.evidence, `actions[${index}].evidence`),
});

const normalizeTimelineItem = (item, index) => ({
  start: requiredString(item.start, `timeline[${index}].start`),
  end: optionalString(item.end ?? null, `timeline[${index}].end`),
  title: requiredString(item.title, `timeline[${index}].title`),
  summary: requiredString(item.summary, `timeline[${index}].summary`),
  messageCountEstimate: Number.isFinite(item.messageCountEstimate) ? item.messageCountEstimate : 0,
});

const normalizeUncategorizedItem = (item, index) => ({
  hkt: requiredString(item.hkt, `uncategorized[${index}].hkt`),
  speaker: requiredString(item.speaker, `uncategorized[${index}].speaker`),
  note: requiredString(item.note, `uncategorized[${index}].note`),
});

const normalizeRisk = (risk, index) => ({
  severity: normalizeImportance(risk.severity, `risks[${index}].severity`),
  risk: requiredString(risk.risk, `risks[${index}].risk`),
  evidence: requiredString(risk.evidence, `risks[${index}].evidence`),
});

const normalizeLink = (link, index) => ({
  title: requiredString(link.title, `links[${index}].title`),
  url: requiredString(link.url, `links[${index}].url`),
  why: requiredString(link.why, `links[${index}].why`),
});

const normalizeLlmSummary = (rawSummary, provider) => ({
  provider,
  generatedAt: new Date().toISOString(),
  summary: requiredString(rawSummary.summary, "summary"),
  topics: requiredArray(rawSummary.topics, "topics").map(normalizeTopic),
  // Every list except topics is optional: tolerate models that omit fields
  // from older or partial schema responses.
  timeline: requiredArray(rawSummary.timeline ?? [], "timeline").map(normalizeTimelineItem),
  uncategorized: requiredArray(rawSummary.uncategorized ?? [], "uncategorized").map(normalizeUncategorizedItem),
  actions: requiredArray(rawSummary.actions ?? [], "actions").map(normalizeAction),
  risks: requiredArray(rawSummary.risks ?? [], "risks").map(normalizeRisk),
  links: requiredArray(rawSummary.links ?? [], "links").map(normalizeLink),
  announcementDraft: optionalString(rawSummary.announcementDraft, "announcementDraft"),
});

// Deterministic merge used only when the LLM reduce step fails, so a busy group
// still gets a complete (if less polished) summary instead of falling back to
// no LLM summary at all.
const mergeKey = (value) => String(value ?? "").replace(/\s+/gu, " ").trim().toLowerCase();

const deterministicMerge = (partials) => {
  const topicByTitle = new Map();
  for (const partial of partials) {
    for (const topic of Array.isArray(partial.topics) ? partial.topics : []) {
      if (!topic || typeof topic.title !== "string" || topic.title.trim().length === 0) {
        continue;
      }
      const key = mergeKey(topic.title);
      const existing = topicByTitle.get(key);
      const details = (Array.isArray(topic.details) ? topic.details : []).filter((item) => typeof item === "string" && item.trim().length > 0);
      const evidence = (Array.isArray(topic.evidence) ? topic.evidence : []).filter((item) => typeof item === "string" && item.trim().length > 0);
      const count = Number.isFinite(topic.messageCountEstimate) ? topic.messageCountEstimate : 0;
      const importance = ["high", "medium", "low"].includes(topic.importance) ? topic.importance : "medium";
      if (existing === undefined) {
        topicByTitle.set(key, {
          title: topic.title.trim(),
          summary: typeof topic.summary === "string" && topic.summary.trim().length > 0 ? topic.summary.trim() : topic.title.trim(),
          importance,
          messageCountEstimate: count,
          details: [...details],
          evidence: [...evidence],
        });
      } else {
        existing.messageCountEstimate += count;
        existing.details.push(...details);
        existing.evidence.push(...evidence);
        const rank = { high: 3, medium: 2, low: 1 };
        if (rank[importance] > rank[existing.importance]) {
          existing.importance = importance;
        }
      }
    }
  }

  const topics = [...topicByTitle.values()]
    .map((topic) => ({
      ...topic,
      details: [...new Set(topic.details)].slice(0, 5),
      evidence: [...new Set(topic.evidence)].slice(0, 4),
    }))
    .sort((left, right) => right.messageCountEstimate - left.messageCountEstimate)
    .slice(0, 10);

  const dedupeBy = (getItems, keyOf) => {
    const seen = new Set();
    const out = [];
    for (const partial of partials) {
      for (const item of getItems(partial)) {
        const key = keyOf(item);
        if (key === null || seen.has(key)) {
          continue;
        }
        seen.add(key);
        out.push(item);
      }
    }
    return out;
  };

  const timeline = partials.flatMap((partial) => (Array.isArray(partial.timeline) ? partial.timeline : []));

  const actionByTask = new Map();
  for (const partial of partials) {
    for (const action of Array.isArray(partial.actions) ? partial.actions : []) {
      if (!action || typeof action.task !== "string" || action.task.trim().length === 0) {
        continue;
      }
      const key = mergeKey(action.task);
      const existing = actionByTask.get(key);
      const isResolved = action.status === "resolved";
      if (existing === undefined) {
        actionByTask.set(key, { ...action });
      } else if (isResolved) {
        existing.status = "resolved";
        existing.resolution = typeof action.resolution === "string" ? action.resolution : existing.resolution;
      }
    }
  }

  const summaries = partials
    .map((partial) => (typeof partial.summary === "string" ? partial.summary.trim() : ""))
    .filter((text) => text.length > 0);

  // Cap every list so the local-merge fallback stays as scannable as the LLM
  // reduce (which is instructed to obey the same limits). Actions keep the
  // still-open ones first since those are what a reader must act on.
  const actions = [...actionByTask.values()]
    .sort((left, right) => (left.status === "open" ? 0 : 1) - (right.status === "open" ? 0 : 1))
    .slice(0, 15);

  // Raw map items may omit fields the strict normalizer requires. Since this is
  // the FALLBACK (must never itself throw), drop items that would fail so the
  // merged object always validates.
  const nonEmpty = (value) => typeof value === "string" && value.trim().length > 0;

  return {
    summary: summaries.slice(0, 4).join(" ") || "本时间段消息较多，已按主题合并汇总。",
    topics,
    timeline: timeline
      .filter((item) => item && nonEmpty(item.start) && nonEmpty(item.title) && nonEmpty(item.summary))
      .map((item) => ({
        start: item.start,
        end: nonEmpty(item.end) ? item.end : null,
        title: item.title,
        summary: item.summary,
        messageCountEstimate: Number.isFinite(item.messageCountEstimate) ? item.messageCountEstimate : 0,
      }))
      .slice(0, 12),
    uncategorized: dedupeBy(
      (partial) => (Array.isArray(partial.uncategorized) ? partial.uncategorized : []),
      (item) => (item && nonEmpty(item.note) ? `${item.hkt ?? ""}|${mergeKey(item.note)}` : null),
    )
      .filter((item) => nonEmpty(item.hkt) && nonEmpty(item.speaker) && nonEmpty(item.note))
      .slice(0, 15),
    actions: actions
      .filter((item) => nonEmpty(item.task) && nonEmpty(item.evidence))
      .map((item) => ({
        owner: nonEmpty(item.owner) ? item.owner : null,
        task: item.task,
        status: item.status === "resolved" ? "resolved" : "open",
        resolution: nonEmpty(item.resolution) ? item.resolution : null,
        evidence: item.evidence,
      })),
    risks: dedupeBy(
      (partial) => (Array.isArray(partial.risks) ? partial.risks : []),
      (item) => (item && nonEmpty(item.risk) ? mergeKey(item.risk) : null),
    )
      .filter((item) => ["high", "medium", "low"].includes(item.severity) && nonEmpty(item.risk) && nonEmpty(item.evidence))
      .slice(0, 10),
    links: dedupeBy(
      (partial) => (Array.isArray(partial.links) ? partial.links : []),
      (item) => (item && nonEmpty(item.url) ? mergeKey(item.url) : null),
    )
      .filter((item) => nonEmpty(item.title) && nonEmpty(item.url) && nonEmpty(item.why))
      .slice(0, 12),
    announcementDraft: null,
  };
};

const extractAssistantContent = (responseBody) => {
  const finishReason = responseBody?.choices?.[0]?.finish_reason;
  if (finishReason === "length") {
    throw new Error(`LLM response was truncated. Increase max_tokens or reduce LlmMaxMessages/LlmMaxChars. Body=${JSON.stringify(responseBody).slice(0, 2000)}`);
  }

  const content = responseBody?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || content.trim().length === 0) {
    throw new Error(`LLM response did not contain choices[0].message.content. Body=${JSON.stringify(responseBody).slice(0, 2000)}`);
  }

  return content;
};

const callLlm = async (url, apiKey, model, prompt, maxTokens) => {
  const payload = {
    model,
    messages: [
      { role: "system", content: prompt.system },
      { role: "user", content: prompt.user },
    ],
    response_format: { type: "json_object" },
    max_tokens: maxTokens,
    thinking: { type: "disabled" },
    temperature: 0.2,
    stream: false,
  };
  const responseBody = await requestJsonWithRetry(url, apiKey, payload);
  return JSON.parse(extractAssistantContent(responseBody));
};

// Cap a single slice the old way (last maxMessages, trimmed to maxChars) for
// the single-chunk fast path.
const capMessages = (messages, maxMessages, maxChars) => {
  const recentMessages = messages.slice(Math.max(0, messages.length - maxMessages));
  const selected = [];
  let usedChars = 0;
  for (let index = recentMessages.length - 1; index >= 0; index -= 1) {
    const line = formatMessageLine(recentMessages[index]);
    if (usedChars + line.length > maxChars && selected.length > 0) {
      break;
    }

    selected.push(line);
    usedChars += line.length + 1;
  }

  return selected.reverse();
};

const summarize = async (analysis, messages, args, url, apiKey, provider) => {
  const { chunks, covered, capped } = buildChunks(messages, args.maxMessages, args.maxChars);

  // Single chunk (quiet group / small window): one call, same as before.
  if (chunks.length <= 1) {
    const lines = chunks[0] ?? capMessages(messages, args.maxMessages, args.maxChars);
    const raw = await callLlm(url, apiKey, args.model, buildPromptFromLines(analysis, lines), SINGLE_MAX_TOKENS);
    const summary = normalizeLlmSummary(raw, { ...provider, messageLines: lines.length });
    return { summary, coverage: { totalTextMessages: messages.length, includedTextMessages: lines.length, chunks: 1, mode: "single", capped } };
  }

  // Map: summarize every chunk so the whole window is covered. Track how many
  // messages actually made it into a partial, so coverage reflects the failed
  // chunks instead of claiming full coverage.
  console.log(`llm map-reduce: ${messages.length} messages -> ${chunks.length} chunks${capped ? " (capped)" : ""}`);
  const partials = [];
  let includedMessages = 0;
  for (let index = 0; index < chunks.length; index += 1) {
    try {
      const partial = await callLlm(
        url,
        apiKey,
        args.model,
        buildPromptFromLines(analysis, chunks[index], { part: index + 1, total: chunks.length }),
        MAP_MAX_TOKENS,
      );
      partials.push(partial);
      includedMessages += chunks[index].length;
      console.log(`llm map chunk ${index + 1}/${chunks.length} ok`);
    } catch (error) {
      console.warn(`llm map chunk ${index + 1}/${chunks.length} failed: ${error.message}`);
    }
  }
  if (partials.length === 0) {
    throw new Error("All map chunks failed; no partial summary was produced.");
  }

  // Reduce: merge partials into one digest. Validate the merged result HERE so a
  // reduce that returns malformed JSON (not just a network/truncation error)
  // also falls back to the deterministic merge instead of failing the group.
  const providerWithLines = { ...provider, messageLines: includedMessages };
  let summary;
  let mode;
  try {
    const raw = await callLlm(url, apiKey, args.model, buildReducePrompt(analysis, partials), REDUCE_MAX_TOKENS);
    summary = normalizeLlmSummary(raw, providerWithLines);
    mode = "mapreduce";
  } catch (error) {
    console.warn(`llm reduce failed, using deterministic merge: ${error.message}`);
    summary = normalizeLlmSummary(deterministicMerge(partials), providerWithLines);
    mode = "mapreduce-local-merge";
  }

  return {
    summary,
    coverage: {
      totalTextMessages: messages.length,
      includedTextMessages: includedMessages,
      chunks: chunks.length,
      summarizedChunks: partials.length,
      mode,
      // A dropped map chunk means the window is not fully summarized either.
      capped: capped || partials.length < chunks.length,
    },
  };
};

const main = async () => {
  const args = parseArgs(process.argv);
  const apiKey = process.env[args.apiKeyEnv];
  if (typeof apiKey !== "string" || apiKey.trim().length === 0) {
    throw new Error(`Missing LLM API key. Set environment variable ${args.apiKeyEnv} before running -UseLlm.`);
  }

  const analysis = readJson(args.analysisJson);
  const messages = readJson(args.messagesJson);
  const url = getChatCompletionsUrl(args.baseUrl);
  const provider = { baseUrl: args.baseUrl, model: args.model, apiKeyEnv: args.apiKeyEnv };

  // summarize() already validated and normalized the summary (so a malformed
  // reduce fell back to the local merge rather than crashing the group here).
  const { summary, coverage } = await summarize(analysis, messages, args, url, apiKey.trim(), provider);

  const llmSummary = { ...summary, coverage };
  const updatedAnalysis = {
    ...analysis,
    llmSummary,
  };

  fs.writeFileSync(args.outputJson, JSON.stringify(llmSummary, null, 2), "utf8");
  fs.writeFileSync(args.analysisJson, JSON.stringify(updatedAnalysis, null, 2), "utf8");
  console.log(`llmSummaryPath=${args.outputJson} coverage=${coverage.includedTextMessages}/${coverage.totalTextMessages} chunks=${coverage.chunks} mode=${coverage.mode}`);
};

main().catch((error) => {
  console.error(error.stack ?? error.message);
  process.exit(1);
});
