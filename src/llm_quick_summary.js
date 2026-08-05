const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");

const MAX_MESSAGES = 600;
const MAX_CHARS = 60000;
const REQUEST_TIMEOUT_MS = 120000;

const parseArgs = (argv) => {
  if (argv.length !== 7) {
    throw new Error("Usage: node llm_quick_summary.js <inputJson> <outputJson> <baseUrl> <model> <apiKeyEnv>");
  }
  return { inputJson: argv[2], outputJson: argv[3], baseUrl: argv[4], model: argv[5], apiKeyEnv: argv[6] };
};

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
            reject(new Error(`LLM request failed. StatusCode=${response.statusCode} Body=${responseBody.slice(0, 1000)}`));
            return;
          }
          try {
            resolve(JSON.parse(responseBody));
          } catch (error) {
            reject(new Error(`LLM response was not valid JSON: ${error.message}`));
          }
        });
      },
    );
    request.setTimeout(REQUEST_TIMEOUT_MS, () => {
      request.destroy(new Error(`LLM request timed out after ${REQUEST_TIMEOUT_MS} ms`));
    });
    request.on("error", reject);
    request.write(body);
    request.end();
  });

const buildPrompt = (input) => {
  const lines = [];
  let usedChars = 0;
  for (const message of (input.messages ?? []).slice(-MAX_MESSAGES)) {
    const line = `[${message.hkt}] ${message.speaker}: ${message.text}`;
    usedChars += line.length;
    if (usedChars > MAX_CHARS) {
      break;
    }
    lines.push(line);
  }
  return [
    `以下是 QQ 群「${input.groupName || input.groupId}」中用户手动选取的一段连续消息（共 ${lines.length} 条）。`,
    "请只针对这段消息输出 JSON（简体中文）：",
    '{"summary": "两三句话概括这段对话", "points": ["要点1", "要点2"], "actions": [{"text": "待办或提问", "status": "open 或 resolved", "resolution": "若已解决，说明谁如何解决"}]}',
    "规则：points 3-8 条，按时间顺序；actions 只列明确请求某人执行、明确承诺执行、或带责任/截止时间的事项。普通提问、求购、求推荐和征询意见不算 action。检查后文，明确完成的标 resolved；没有则给空数组。",
    "",
    ...lines,
  ].join("\n");
};

const normalizeResult = (raw) => ({
  summary: typeof raw.summary === "string" ? raw.summary : "",
  points: (Array.isArray(raw.points) ? raw.points : []).map(String).slice(0, 12),
  actions: (Array.isArray(raw.actions) ? raw.actions : [])
    .map((action) => ({
      text: String(action?.text ?? ""),
      status: action?.status === "resolved" ? "resolved" : "open",
      resolution: typeof action?.resolution === "string" ? action.resolution : "",
    }))
    .filter((action) => action.text.length > 0)
    .slice(0, 12),
});

const main = async () => {
  const args = parseArgs(process.argv);
  const apiKey = process.env[args.apiKeyEnv];
  if (typeof apiKey !== "string" || apiKey.trim().length === 0) {
    throw new Error(`Missing API key in env ${args.apiKeyEnv}`);
  }

  const input = JSON.parse(fs.readFileSync(args.inputJson, "utf8"));
  if (!Array.isArray(input.messages) || input.messages.length === 0) {
    throw new Error("Input has no messages to summarize");
  }

  const response = await requestJson(getChatCompletionsUrl(args.baseUrl), apiKey, {
    model: args.model,
    messages: [
      { role: "system", content: "你是精炼的群聊摘要助手，只输出合法 JSON。" },
      { role: "user", content: buildPrompt(input) },
    ],
    response_format: { type: "json_object" },
    temperature: 0.3,
    max_tokens: 2048,
  });

  const content = response.choices?.[0]?.message?.content;
  if (typeof content !== "string") {
    throw new Error("LLM response missing message content");
  }

  const result = normalizeResult(JSON.parse(content));
  result.model = args.model;
  result.messageCount = input.messages.length;
  fs.writeFileSync(args.outputJson, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  console.log(`quickSummaryPath=${args.outputJson}`);
};

main().catch((error) => {
  console.error(`llm_quick_summary failed: ${error.message}`);
  process.exit(1);
});
