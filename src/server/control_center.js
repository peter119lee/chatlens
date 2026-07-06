const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { spawn } = require("node:child_process");
const state = require("./toolkit_state");
const jobs = require("./run_jobs");
const settings = require("./settings_ops");
const scheduler = require("./scheduler_ops");
const update = require("./update_ops");

const BASE_PORT = 8321;
const MAX_PORT_ATTEMPTS = 10;
const MAX_BODY_BYTES = 64 * 1024;

const token = crypto.randomBytes(16).toString("hex");
const webDir = path.join(state.toolRoot, "web");

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".jfif": "image/jpeg",
  ".heic": "image/heic",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".avi": "video/x-msvideo",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".wav": "audio/wav",
  ".amr": "audio/amr",
  ".silk": "application/octet-stream",
  ".pdf": "application/pdf",
};

const sendJson = (response, statusCode, payload) => {
  const body = JSON.stringify(payload);
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(body);
};

const sendError = (response, statusCode, message) => sendJson(response, statusCode, { error: message });

const readBody = (request) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("Request body too large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("Request body is not valid JSON"));
      }
    });
    request.on("error", reject);
  });

const isLocalHost = (request) => {
  const host = String(request.headers.host ?? "").toLowerCase();
  return host.startsWith("127.0.0.1:") || host.startsWith("localhost:") || host === "127.0.0.1" || host === "localhost";
};

const isAuthorized = (request) => request.headers["x-cc-token"] === token;

const serveStaticFile = (response, filePath, fallbackType) => {
  // fallbackType lets run-media with unusual/absent extensions download
  // instead of 404ing (QQ caches occasionally store extension-less originals).
  const contentType = MIME_TYPES[path.extname(filePath).toLowerCase()] ?? fallbackType;
  if (contentType === undefined || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    sendError(response, 404, "Not found");
    return;
  }

  response.writeHead(200, { "content-type": contentType, "cache-control": "no-cache" });
  fs.createReadStream(filePath).pipe(response);
};

const serveRunsFile = (response, urlPath) => {
  const config = state.loadConfig();
  let relative;
  try {
    relative = decodeURIComponent(urlPath.slice("/runs/".length));
  } catch {
    sendError(response, 400, "Malformed URL encoding");
    return;
  }
  const resolved = path.resolve(config.runsDir, relative);
  const rootCheck = path.relative(path.resolve(config.runsDir), resolved);
  if (rootCheck.startsWith("..") || path.isAbsolute(rootCheck)) {
    sendError(response, 403, "Forbidden");
    return;
  }

  serveStaticFile(response, resolved, "application/octet-stream");
};

const serveIndex = (response) => {
  const indexPath = path.join(webDir, "index.html");
  const html = fs.readFileSync(indexPath, "utf8").replace("__CC_TOKEN__", token);
  response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  response.end(html);
};

const openLocalPath = (targetPath) => {
  if (typeof targetPath !== "string" || targetPath.trim().length === 0) {
    throw new Error("path is required");
  }
  if (!state.isPathAllowedToOpen(targetPath)) {
    throw new Error("Path is outside the reports/runs directories");
  }
  if (!fs.existsSync(targetPath)) {
    throw new Error(`Path does not exist: ${targetPath}`);
  }

  const child = spawn("explorer.exe", [path.resolve(targetPath)], { windowsHide: true, detached: true, stdio: "ignore" });
  child.on("error", (error) => console.error(`explorer.exe failed: ${error.message}`));
  child.unref();
};

const handleApi = async (request, response, url) => {
  if (!isAuthorized(request)) {
    sendError(response, 401, "Missing or invalid token");
    return;
  }

  try {
    if (request.method === "GET" && url.pathname === "/api/state") {
      sendJson(response, 200, state.getState());
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/job") {
      const cursor = Number.parseInt(url.searchParams.get("cursor") ?? "0", 10);
      sendJson(response, 200, jobs.jobSnapshot(cursor));
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/run-detail") {
      sendJson(response, 200, state.getRunDetail(url.searchParams.get("id") ?? ""));
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/messages") {
      sendJson(response, 200, state.getStoreMessages(Object.fromEntries(url.searchParams)));
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/store-overview") {
      sendJson(response, 200, state.getStoreOverview());
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/readmark") {
      const body = await readBody(request);
      sendJson(response, 200, { readMark: state.saveReadMark(body) });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/media-index") {
      sendJson(response, 200, state.buildMediaIndex(url.searchParams.get("refresh") === "1"));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/media-export") {
      const body = await readBody(request);
      const result = state.exportMediaSelection(body.paths);
      openLocalPath(result.folder);
      sendJson(response, 200, result);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/quick-summary") {
      const body = await readBody(request);
      const prepared = state.prepareQuickSummary(body);
      let job;
      try {
        job = jobs.startQuickSummaryJob({
          inputPath: prepared.inputPath,
          outputPath: prepared.outputPath,
          meta: { groupId: prepared.groupId, groupName: prepared.groupName, count: prepared.count },
          llm: state.loadConfig().llm ?? {},
        });
      } catch (error) {
        // The job never started, so its cleanup will never run — remove the prepared input here.
        fs.rmSync(prepared.inputPath, { force: true });
        throw error;
      }
      sendJson(response, 200, { started: true, jobId: job.id, count: prepared.count });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/quick-summary") {
      sendJson(response, 200, jobs.quickSummarySnapshot());
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/run") {
      const body = await readBody(request);
      const job = jobs.startSummaryJob(body);
      sendJson(response, 200, { started: true, jobId: job.id });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/grouplist/refresh") {
      const job = jobs.startGroupListJob();
      sendJson(response, 200, { started: true, jobId: job.id });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/job/cancel") {
      jobs.cancelJob();
      sendJson(response, 200, { cancelled: true });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/watchlist") {
      const body = await readBody(request);
      const entries = state.updateWatchlist({
        add: Array.isArray(body.add) ? body.add : [],
        remove: Array.isArray(body.remove) ? body.remove : [],
      });
      sendJson(response, 200, { watchlist: entries });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/open") {
      const body = await readBody(request);
      openLocalPath(body.path);
      sendJson(response, 200, { opened: true });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/cleanup") {
      const body = await readBody(request);
      const days = Number.parseInt(body.olderThanDays, 10);
      sendJson(response, 200, state.cleanupGeneratedData({
        olderThanDays: Number.isInteger(days) && days > 0 ? days : 0,
      }));
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/settings") {
      sendJson(response, 200, settings.getSettingsStatus());
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/settings/keys") {
      const body = await readBody(request);
      const saved = [];
      if (typeof body.ntqqKey === "string" && body.ntqqKey.trim().length > 0) {
        await settings.saveSecret("ntqqKey", body.ntqqKey);
        saved.push("ntqqKey");
      }
      if (typeof body.llmKey === "string" && body.llmKey.trim().length > 0) {
        await settings.saveSecret("llmKey", body.llmKey);
        saved.push("llmKey");
      }
      if (saved.length === 0) {
        throw new Error("没有提供任何密钥。");
      }
      sendJson(response, 200, { saved });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/settings/llm") {
      const body = await readBody(request);
      sendJson(response, 200, settings.saveLlmConfig(body));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/settings/qq-paths") {
      const body = await readBody(request);
      sendJson(response, 200, settings.saveQqPaths(body));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/settings/detect-qq") {
      sendJson(response, 200, { candidates: settings.detectQqPaths() });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/llm/models") {
      sendJson(response, 200, { models: await settings.fetchLlmModels() });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/update/check") {
      sendJson(response, 200, await update.checkUpdate());
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/update/apply") {
      sendJson(response, 200, await update.applyUpdate());
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/settings/store") {
      const body = await readBody(request);
      sendJson(response, 200, settings.saveStoreConfig(body));
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/schedule") {
      sendJson(response, 200, await scheduler.getScheduleStatus());
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/schedule") {
      const body = await readBody(request);
      if (body.enabled === false) {
        sendJson(response, 200, await scheduler.disableSchedule());
      } else {
        sendJson(response, 200, await scheduler.enableSchedule(body));
      }
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/schedule/run-now") {
      sendJson(response, 200, await scheduler.runScheduleNow());
      return;
    }

    sendError(response, 404, "Unknown API route");
  } catch (error) {
    sendError(response, 400, error.message);
  }
};

const handleRequest = (request, response) => {
  // A single synchronous throw here would take down the whole server process.
  try {
    response.setHeader("x-frame-options", "DENY");
    response.setHeader("x-content-type-options", "nosniff");

    if (!isLocalHost(request)) {
      sendError(response, 403, "Forbidden host");
      return;
    }

    const url = new URL(request.url, "http://127.0.0.1");

    if (url.pathname.startsWith("/api/")) {
      handleApi(request, response, url).catch(() => {
        if (!response.writableEnded) {
          sendError(response, 500, "Internal error");
        }
      });
      return;
    }

    if (request.method !== "GET") {
      sendError(response, 405, "Method not allowed");
      return;
    }

    if (url.pathname === "/" || url.pathname === "/index.html") {
      serveIndex(response);
      return;
    }

    if (url.pathname === "/favicon.ico") {
      response.writeHead(200, { "content-type": "image/svg+xml", "cache-control": "max-age=86400" });
      response.end('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#1565c0"/><text x="16" y="22" font-size="13" font-weight="bold" text-anchor="middle" fill="#fff" font-family="Arial">QQ</text></svg>');
      return;
    }

    if (/^\/[\w-]+\.(?:css|js)$/u.test(url.pathname)) {
      serveStaticFile(response, path.join(webDir, url.pathname.slice(1)));
      return;
    }

    if (url.pathname.startsWith("/runs/")) {
      serveRunsFile(response, url.pathname);
      return;
    }

    sendError(response, 404, "Not found");
  } catch (error) {
    if (!response.writableEnded) {
      try {
        sendError(response, 500, "Internal error");
      } catch {
        response.destroy();
      }
    }
    console.error(`Request failed: ${error.message}`);
  }
};

const openBrowser = (url) => {
  const child = spawn("cmd.exe", ["/c", "start", "", url], { windowsHide: true, detached: true, stdio: "ignore" });
  child.on("error", (error) => console.error(`Failed to open browser: ${error.message}`));
  child.unref();
};

const listen = (port, attempt) => {
  const server = http.createServer(handleRequest);
  server.on("error", (error) => {
    if (error.code === "EADDRINUSE" && attempt < MAX_PORT_ATTEMPTS) {
      listen(port + 1, attempt + 1);
      return;
    }
    console.error(`Control center failed to start: ${error.message}`);
    process.exit(1);
  });
  server.listen(port, "127.0.0.1", () => {
    const url = `http://127.0.0.1:${port}/`;
    console.log(`QQ 摘要控制台已启动: ${url}`);
    console.log("关闭此窗口即可停止控制台。");
    if (!process.argv.includes("--no-open")) {
      openBrowser(url);
    }
  });
};

listen(BASE_PORT, 0);
