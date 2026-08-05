const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { synchronizeManifestMedia } = require("./media_object_store");

const REMOTE_IMAGE_HOST = "https://gchat.qpic.cn";
const REMOTE_DOWNLOAD_ATTEMPTS = 3;
const REMOTE_DOWNLOAD_TIMEOUT_MS = 20000;
const REMOTE_DOWNLOAD_CONCURRENCY = 8;
const REMOTE_IMAGE_EXTENSIONS = new Map([
  ["image/jpeg", ".jpg"],
  ["image/png", ".png"],
  ["image/gif", ".gif"],
  ["image/webp", ".webp"],
  ["image/bmp", ".bmp"],
  ["image/avif", ".avif"],
  ["image/heic", ".heic"],
  ["image/heif", ".heic"],
]);

class RemoteMediaDownloadError extends Error {
  constructor(message, cause) {
    super(message, { cause });
    this.name = "RemoteMediaDownloadError";
    this.statusCode = cause?.statusCode ?? null;
  }
}

class RemoteMediaHttpError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.name = "RemoteMediaHttpError";
    this.statusCode = statusCode;
  }
}

class RemoteMediaContentError extends Error {
  constructor(message) {
    super(message);
    this.name = "RemoteMediaContentError";
  }
}

const parseArgs = (argv) => {
  if (argv.length !== 9) {
    throw new Error(
      "Usage: node export_media_files.js <mediaMessagesJson> <ntDataDir> <outputDir> <formatsCsv> <objectDir> <knowledgeStorePath> <toolRoot>",
    );
  }

  return {
    mediaMessagesJson: argv[2],
    ntDataDir: argv[3],
    outputDir: argv[4],
    formats: argv[5]
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter((value) => value.length > 0),
    objectDir: argv[6],
    knowledgeStorePath: argv[7],
    toolRoot: argv[8],
  };
};

const normalizePath = (value) => value.replaceAll("/", "\\").replace(/[^\p{L}\p{N}\p{P}\p{S}\s._:\\-]+/gu, "").trim();

const pathExists = (filePath) => {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
};

const getExtension = (filePath) => path.extname(filePath).toLowerCase().replace(".", "");

const getCandidateRoots = (ntDataDir) => ["Pic", "Video", "Emoji", "Ptt", "File"].map((name) => path.join(ntDataDir, name));

const walkFiles = (rootDir, visit) => {
  if (!fs.existsSync(rootDir)) {
    return;
  }

  const stack = [rootDir];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      // An unreadable cache subfolder must not kill the whole media export.
      continue;
    }
    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(entryPath);
      } else if (entry.isFile()) {
        visit(entryPath);
      }
    }
  }
};

const buildMediaIndex = (ntDataDir, objectDir) => {
  const roots = [objectDir, ...getCandidateRoots(ntDataDir)];
  const byHash = new Map();
  const byFileName = new Map();

  for (const root of roots) {
    walkFiles(root, (filePath) => {
      const fileName = path.basename(filePath);
      const lowerFileName = fileName.toLowerCase();
      const hashMatch = lowerFileName.match(/[a-f0-9]{32}/u);
      if (hashMatch !== null) {
        const values = byHash.get(hashMatch[0]) ?? [];
        values.push(filePath);
        byHash.set(hashMatch[0], values);
      }

      const fileValues = byFileName.get(lowerFileName) ?? [];
      fileValues.push(filePath);
      byFileName.set(lowerFileName, fileValues);
    });
  }

  return { byHash, byFileName };
};

const pickBestCandidate = (candidates, formats) => {
  const existing = candidates.filter(pathExists);
  if (existing.length === 0) {
    return null;
  }

  const allowed = formats.length === 0 ? existing : existing.filter((filePath) => formats.includes(getExtension(filePath)));
  const pool = allowed.length > 0 ? allowed : existing;
  // Stat each candidate once, tolerating files QQ purges between the exists
  // check and here.
  const sized = [];
  for (const filePath of pool) {
    try {
      sized.push({ filePath, size: fs.statSync(filePath).size });
    } catch {
      // skip vanished candidate
    }
  }
  if (sized.length === 0) {
    return null;
  }
  return sized.sort((left, right) => right.size - left.size)[0].filePath;
};

const findSourcePath = (ref, index, formats) => {
  if (ref.localPath !== null && ref.localPath !== undefined) {
    const normalized = normalizePath(ref.localPath);
    if (pathExists(normalized)) {
      return normalized;
    }
  }

  if (ref.hash !== null && ref.hash !== undefined) {
    const hashCandidates = index.byHash.get(String(ref.hash).toLowerCase()) ?? [];
    const picked = pickBestCandidate(hashCandidates, formats);
    if (picked !== null) {
      return picked;
    }
  }

  if (ref.fileName !== null && ref.fileName !== undefined) {
    const nameCandidates = index.byFileName.get(String(ref.fileName).toLowerCase()) ?? [];
    const picked = pickBestCandidate(nameCandidates, formats);
    if (picked !== null) {
      return picked;
    }
  }

  return null;
};

const safeName = (value) => String(value).replace(/[^A-Za-z0-9_.-]+/gu, "_").slice(0, 120);

const getMediaTargetPath = (message, ref, extension, outputDir, index) => {
  const groupPart = safeName(message.groupName || message.groupId || "group");
  const speakerPart = safeName(message.speaker || message.senderName || "speaker");
  const targetName = `${String(index).padStart(4, "0")}_${message.hkt.replace(/[-: ]/gu, "")}_${groupPart}_${speakerPart}${extension}`;
  const kindDir = ref.kind || "media";
  return path.join(outputDir, kindDir, targetName);
};

const copyMedia = (message, ref, sourcePath, outputDir, index) => {
  const extension = path.extname(sourcePath).toLowerCase();
  const targetPath = getMediaTargetPath(message, ref, extension, outputDir, index);
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.copyFileSync(sourcePath, targetPath);
  return targetPath;
};

const getRemoteGroupImageUrl = (hash) =>
  `${REMOTE_IMAGE_HOST}/gchatpic_new/0/0-0-${hash.toUpperCase()}/0`;

const getResponseBodySnippet = async (response) => {
  try {
    return (await response.text()).slice(0, 2000);
  } catch (error) {
    return `Unable to read response body: ${error.message}`;
  }
};

const fetchRemoteGroupImage = async (hash, fetchImplementation) => {
  const url = getRemoteGroupImageUrl(hash);
  let lastError = null;

  for (let attempt = 1; attempt <= REMOTE_DOWNLOAD_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetchImplementation(url, {
        method: "GET",
        redirect: "follow",
        signal: AbortSignal.timeout(REMOTE_DOWNLOAD_TIMEOUT_MS),
      });
      if (response.status === 404) {
        return { status: "not-found", statusCode: response.status, url };
      }
      if (!response.ok) {
        const responseBody = await getResponseBodySnippet(response);
        throw new RemoteMediaHttpError(
          `QQ media download failed. Url=${url} StatusCode=${response.status} Body=${responseBody}`,
          response.status,
        );
      }

      const contentType = (response.headers.get("content-type") ?? "").split(";", 1)[0].trim().toLowerCase();
      const extension = REMOTE_IMAGE_EXTENSIONS.get(contentType);
      if (extension === undefined) {
        throw new RemoteMediaContentError(
          `QQ media response was not a supported image. Url=${url} StatusCode=${response.status} ContentType=${contentType || "missing"}`,
        );
      }

      const bytes = Buffer.from(await response.arrayBuffer());
      const actualHash = crypto.createHash("md5").update(bytes).digest("hex");
      if (actualHash !== hash.toLowerCase()) {
        throw new RemoteMediaContentError(
          `QQ media integrity check failed. Url=${url} ExpectedMd5=${hash.toLowerCase()} ActualMd5=${actualHash} Bytes=${bytes.length}`,
        );
      }
      return { status: "downloaded", statusCode: response.status, url, extension, bytes };
    } catch (error) {
      lastError = error;
      if (attempt < REMOTE_DOWNLOAD_ATTEMPTS) {
        console.warn("remote-media-download retry", {
          url,
          attempt,
          maxAttempts: REMOTE_DOWNLOAD_ATTEMPTS,
          errorType: error.name,
          error: error.message,
        });
      }
    }
  }

  throw new RemoteMediaDownloadError(
    `QQ media download failed after ${REMOTE_DOWNLOAD_ATTEMPTS} attempts. Url=${url} Error=${lastError?.message ?? "unknown"}`,
    lastError,
  );
};

const writeRemoteMedia = (message, ref, remoteImage, outputDir, index) => {
  const targetPath = getMediaTargetPath(message, ref, remoteImage.extension, outputDir, index);
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, remoteImage.bytes);
  return targetPath;
};

const mapWithConcurrency = async (items, concurrency, operation) => {
  const results = new Array(items.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await operation(items[index]);
    }
  };
  const workerCount = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
};

const createManifestItem = (task, result) => ({
  rowId: task.message.rowId,
  sentAt: task.message.sentAt,
  hkt: task.message.hkt,
  groupId: task.message.groupId,
  groupName: task.message.groupName,
  speaker: task.message.speaker,
  kind: task.ref.kind,
  hash: task.ref.hash,
  fileName: task.ref.fileName,
  requestedExtension: task.ref.extension,
  sourcePath: result.sourcePath,
  copiedPath: result.copiedPath,
  copyError: result.copyError,
  url: task.ref.url,
  remoteUrl: result.remoteUrl,
  remoteStatus: result.remoteStatus,
  remoteStatusCode: result.remoteStatusCode,
});

const canDownloadRemoteGroupImage = (ref) =>
  ref.kind === "image" && typeof ref.hash === "string" && /^[a-f0-9]{32}$/iu.test(ref.hash);

const exportMediaFiles = async (args, fetchImplementation) => {
  if (typeof fetchImplementation !== "function") {
    throw new TypeError("Media export requires a fetch implementation. Use the bundled Node.js runtime or Node.js 18 or newer.");
  }
  const mediaMessages = JSON.parse(fs.readFileSync(args.mediaMessagesJson, "utf8"));
  fs.mkdirSync(args.outputDir, { recursive: true });

  const index = buildMediaIndex(args.ntDataDir, args.objectDir);
  const tasks = [];
  let taskIndex = 0;
  for (const message of mediaMessages) {
    for (const ref of message.mediaRefs ?? []) {
      taskIndex += 1;
      tasks.push({ message, ref, index: taskIndex, sourcePath: findSourcePath(ref, index, args.formats) });
    }
  }

  const manifest = new Array(tasks.length);
  const remoteTasksByHash = new Map();
  let copied = 0;
  let failedCopies = 0;
  let remoteCopied = 0;
  let remoteNotFound = 0;
  let remoteFailed = 0;

  for (const task of tasks) {
    if (task.sourcePath !== null) {
      let copiedPath = null;
      let copyError = null;
      try {
        copiedPath = copyMedia(task.message, task.ref, task.sourcePath, args.outputDir, task.index);
        copied += 1;
      } catch (error) {
        copyError = error.message;
        failedCopies += 1;
      }
      manifest[task.index - 1] = createManifestItem(task, {
        sourcePath: task.sourcePath,
        copiedPath,
        copyError,
        remoteUrl: null,
        remoteStatus: null,
        remoteStatusCode: null,
      });
      continue;
    }

    if (!canDownloadRemoteGroupImage(task.ref)) {
      manifest[task.index - 1] = createManifestItem(task, {
        sourcePath: null,
        copiedPath: null,
        copyError: null,
        remoteUrl: null,
        remoteStatus: null,
        remoteStatusCode: null,
      });
      continue;
    }

    const normalizedHash = task.ref.hash.toLowerCase();
    const hashTasks = remoteTasksByHash.get(normalizedHash) ?? [];
    hashTasks.push(task);
    remoteTasksByHash.set(normalizedHash, hashTasks);
  }

  await mapWithConcurrency([...remoteTasksByHash.entries()], REMOTE_DOWNLOAD_CONCURRENCY, async ([hash, hashTasks]) => {
    let remoteImage;
    try {
      remoteImage = await fetchRemoteGroupImage(hash, fetchImplementation);
    } catch (error) {
      console.warn("remote-media-download failed", {
        hash,
        occurrences: hashTasks.length,
        errorType: error.name,
        error: error.message,
      });
      for (const task of hashTasks) {
        failedCopies += 1;
        remoteFailed += 1;
        manifest[task.index - 1] = createManifestItem(task, {
          sourcePath: null,
          copiedPath: null,
          copyError: error.message,
          remoteUrl: getRemoteGroupImageUrl(hash),
          remoteStatus: "failed",
          remoteStatusCode: error.statusCode ?? null,
        });
      }
      return;
    }

    if (remoteImage.status === "not-found") {
      for (const task of hashTasks) {
        remoteNotFound += 1;
        manifest[task.index - 1] = createManifestItem(task, {
          sourcePath: null,
          copiedPath: null,
          copyError: null,
          remoteUrl: remoteImage.url,
          remoteStatus: remoteImage.status,
          remoteStatusCode: remoteImage.statusCode,
        });
      }
      return;
    }

    for (const task of hashTasks) {
      try {
        const copiedPath = writeRemoteMedia(task.message, task.ref, remoteImage, args.outputDir, task.index);
        copied += 1;
        remoteCopied += 1;
        manifest[task.index - 1] = createManifestItem(task, {
          sourcePath: null,
          copiedPath,
          copyError: null,
          remoteUrl: remoteImage.url,
          remoteStatus: remoteImage.status,
          remoteStatusCode: remoteImage.statusCode,
        });
      } catch (error) {
        failedCopies += 1;
        remoteFailed += 1;
        console.warn("remote-media-write failed", {
          hash,
          rowId: String(task.message.rowId ?? ""),
          errorType: error.name,
          error: error.message,
        });
        manifest[task.index - 1] = createManifestItem(task, {
          sourcePath: null,
          copiedPath: null,
          copyError: error.message,
          remoteUrl: remoteImage.url,
          remoteStatus: "failed",
          remoteStatusCode: remoteImage.statusCode,
        });
      }
    }
  });

  if (failedCopies > 0) {
    console.warn(`警告：${failedCopies} 个媒体文件获取失败（本地复制或远程下载），已跳过，其余照常导出。`);
  }

  const manifestPath = path.join(args.outputDir, "media-manifest.json");
  const manifestTextPath = path.join(args.outputDir, "media-manifest.txt");
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
  fs.writeFileSync(
    manifestTextPath,
    `${manifest
      .map((item) => `[${item.hkt}] [${item.kind}] ${item.groupName || item.groupId} ${item.speaker}: ${item.copiedPath ?? item.sourcePath ?? item.url ?? "NOT_FOUND"}`)
      .join("\n")}\n`,
    "utf8",
  );

  const objectStore = synchronizeManifestMedia({
    manifestPath,
    objectDir: args.objectDir,
    knowledgeStorePath: args.knowledgeStorePath,
    toolRoot: args.toolRoot,
  });

  process.stdout.write(
    JSON.stringify(
      {
        outputDir: args.outputDir,
        manifestPath,
        manifestTextPath,
        refs: manifest.length,
        copied,
        failedCopies,
        remoteCopied,
        remoteNotFound,
        remoteFailed,
        missing: manifest.length - copied,
        objectStore,
      },
      null,
      2,
    ),
  );
};

const main = async () => {
  const args = parseArgs(process.argv);
  await exportMediaFiles(args, globalThis.fetch);
};

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  exportMediaFiles,
  fetchRemoteGroupImage,
  getRemoteGroupImageUrl,
};
