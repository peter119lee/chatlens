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

const buildLocalTopicContext = (analysis) =>
  (analysis.topics ?? [])
    .filter((topic) => topic.count > 0)
    .slice(0, 12)
    .map((topic) => ({
      name: topic.name,
      count: topic.count,
      keywords: (topic.keywords ?? []).slice(0, 6).map((item) => item.token ?? item.name ?? String(item)),
    }));

const buildPrompt = (analysis, messages, maxMessages, maxChars) => {
  const messageLines = capMessages(messages, maxMessages, maxChars);
  return {
    system: [
      "你是一个 QQ 群聊摘要分析器。",
      "你必须根据当前输入的消息动态归纳主题，不能使用预设行业分类。",
      "不要因为工具名或示例而默认群聊在讨论 AI、模型、账号、订单或编程，除非消息内容确实在讨论这些。",
      "输出必须是合法 JSON，不要使用 Markdown，不要输出额外解释。",
    ].join("\n"),
    user: JSON.stringify(
      {
        task: "请动态总结这些 QQ 群消息。",
        rules: [
          "主题 title 必须来自这批消息的真实内容。",
          "每个主题需要 summary、details、evidence。",
          "timeline 按时间段归纳：群聊通常集中在几个时间段，每段给出起止时间、这段时间主要在聊什么。用 localTimeBlocks 提示的分段作参考，可合并或拆分。",
          "uncategorized 列出不属于任何主题、但可能重要的零散消息（通知、约定、金额、链接、提醒、求助），逐条注明时间、发言人和为什么值得注意。纯闲聊不要列。",
          "actions 只列出明确需要人处理或回复的事项。必须检查后续消息：如果已经有人回复、解决或当事人自己搞定了，status 用 resolved 并在 resolution 写一句是谁怎么解决的；仍然没人处理的才用 open。",
          "risks 只列出明显风险、争议、故障、投诉、资金或账号安全问题。",
          "links 只保留值得保存或回看的链接。",
          "如果没有某类内容，用空数组或 null。",
        ],
        outputSchema: {
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
        },
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
  };
};

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
  // timeline/uncategorized are newer schema fields; tolerate models that omit them.
  timeline: (rawSummary.timeline ?? []).map(normalizeTimelineItem),
  uncategorized: (rawSummary.uncategorized ?? []).map(normalizeUncategorizedItem),
  actions: requiredArray(rawSummary.actions, "actions").map(normalizeAction),
  risks: requiredArray(rawSummary.risks, "risks").map(normalizeRisk),
  links: requiredArray(rawSummary.links, "links").map(normalizeLink),
  announcementDraft: optionalString(rawSummary.announcementDraft, "announcementDraft"),
});

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

const main = async () => {
  const args = parseArgs(process.argv);
  const apiKey = process.env[args.apiKeyEnv];
  if (typeof apiKey !== "string" || apiKey.trim().length === 0) {
    throw new Error(`Missing LLM API key. Set environment variable ${args.apiKeyEnv} before running -UseLlm.`);
  }

  const analysis = readJson(args.analysisJson);
  const messages = readJson(args.messagesJson);
  const prompt = buildPrompt(analysis, messages, args.maxMessages, args.maxChars);
  const url = getChatCompletionsUrl(args.baseUrl);
  const payload = {
    model: args.model,
    messages: [
      {
        role: "system",
        content: prompt.system,
      },
      {
        role: "user",
        content: prompt.user,
      },
    ],
    response_format: {
      type: "json_object",
    },
    max_tokens: 6144,
    thinking: {
      type: "disabled",
    },
    temperature: 0.2,
    stream: false,
  };

  const responseBody = await requestJsonWithRetry(url, apiKey.trim(), payload);
  const content = extractAssistantContent(responseBody);
  const rawSummary = JSON.parse(content);
  const llmSummary = normalizeLlmSummary(rawSummary, {
    baseUrl: args.baseUrl,
    model: args.model,
    apiKeyEnv: args.apiKeyEnv,
    messageLines: capMessages(messages, args.maxMessages, args.maxChars).length,
  });
  const updatedAnalysis = {
    ...analysis,
    llmSummary,
  };

  fs.writeFileSync(args.outputJson, JSON.stringify(llmSummary, null, 2), "utf8");
  fs.writeFileSync(args.analysisJson, JSON.stringify(updatedAnalysis, null, 2), "utf8");
  console.log(`llmSummaryPath=${args.outputJson}`);
};

main().catch((error) => {
  console.error(error.stack ?? error.message);
  process.exit(1);
});
