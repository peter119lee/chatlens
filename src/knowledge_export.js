"use strict";

// Exports knowledge-base images and their prompts, with a ledger so repeated
// exports only write what is new.
//
// Two output shapes, both produced in one pass:
//   * a folder of images plus sidecar .txt files holding the prompt -- the
//     layout kohya / sd-scripts and sd-image-sorter already understand, so the
//     result is directly usable for LoRA training or import elsewhere;
//   * index.jsonl / index.csv, one row per image, for spreadsheets and scripts.
//
// Dedup is content-addressed: the QQ cache filename IS the md5 of the file's
// bytes (verified), so the same picture cannot be exported twice under a
// different name, and a re-export after the source is re-cached is still a
// no-op. The ledger is global rather than per-folder, so "have I already got
// this?" has one answer regardless of which folder it went to.
//
// Safety properties:
//   * the ledger is written atomically (temp file + rename), so an interrupted
//     export cannot corrupt it;
//   * a run records its outcome per image, including WHY something was skipped;
//   * the ledger refuses to load a file it does not recognise, rather than
//     overwriting someone else's json.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const LEDGER_SCHEMA = "qqsummarytools.knowledge-export";
const LEDGER_VERSION = 1;
const LEDGER_FILENAME = "export-ledger.json";

// Windows path limits plus a margin for the sidecar extension.
const MAX_STEM_CHARS = 80;
const MAX_PROMPT_BYTES = 200000;

const ledgerPath = (toolRoot) => path.join(toolRoot, "store", LEDGER_FILENAME);

const emptyLedger = () => ({
  schema: LEDGER_SCHEMA,
  version: LEDGER_VERSION,
  exports: {},
});

// Refuses to interpret an unrecognised file as a ledger: silently replacing it
// would destroy whatever it actually was.
const loadLedger = (toolRoot) => {
  const target = ledgerPath(toolRoot);
  if (!fs.existsSync(target)) {
    return emptyLedger();
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(target, "utf8"));
  } catch {
    throw new Error(`导出记录文件损坏，无法解析：${target}（重命名或删除后重试）`);
  }
  if (parsed?.schema !== LEDGER_SCHEMA) {
    throw new Error(`${target} 不是本工具的导出记录文件，请先移走或改名`);
  }
  return {
    schema: LEDGER_SCHEMA,
    version: LEDGER_VERSION,
    exports: typeof parsed.exports === "object" && parsed.exports !== null ? parsed.exports : {},
  };
};

// Temp file in the same directory then rename: rename is atomic on the same
// volume, so readers never observe a half-written ledger.
const saveLedger = (toolRoot, ledger) => {
  const target = ledgerPath(toolRoot);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = path.join(path.dirname(target), `.${LEDGER_FILENAME}.${process.pid}.tmp`);
  fs.writeFileSync(temp, JSON.stringify(ledger, null, 2), "utf8");
  fs.renameSync(temp, target);
};

// Reserved device names must not become filenames on Windows, and a trailing dot
// or space is silently dropped by the OS, which would break the sidecar pairing.
const RESERVED_NAMES = new Set([
  "con", "prn", "aux", "nul",
  ...Array.from({ length: 9 }, (_, index) => `com${index + 1}`),
  ...Array.from({ length: 9 }, (_, index) => `lpt${index + 1}`),
]);

const sanitizeStem = (value, fallback) => {
  const cleaned = String(value ?? "")
    .replace(/[\u0000-\u001F<>:"/\\|?*]/gu, "_")
    .replace(/\s+/gu, " ")
    .replace(/[. ]+$/u, "")
    .trim()
    .slice(0, MAX_STEM_CHARS);
  if (cleaned.length === 0 || RESERVED_NAMES.has(cleaned.toLowerCase())) {
    return fallback;
  }
  return cleaned;
};

// Name files so they sort meaningfully and stay traceable: date, speaker or
// model, then a hash prefix that guarantees uniqueness without the full 32 chars.
const buildStem = (item, index) => {
  const date = item.fileMtime > 0
    ? new Date(item.fileMtime * 1000).toISOString().slice(0, 10).replaceAll("-", "")
    : "00000000";
  const who = item.sightings?.[0]?.speaker ?? "";
  const model = path.basename(String(item.checkpoint ?? "")).replace(/\.(safetensors|ckpt|pt|pth|bin)$/iu, "");
  const label = sanitizeStem(who || model, "image");
  return `${date}_${label}_${item.hash.slice(0, 8)}` || `image_${index}`;
};

// The prompt that best represents this image: its own metadata when present,
// otherwise the answer someone gave in chat -- which for a stripped image is the
// only record that exists.
const promptFor = (item) => {
  if (typeof item.prompt === "string" && item.prompt.trim().length > 0) {
    return { text: item.prompt.trim(), source: "metadata" };
  }
  const answered = (item.promptRequests ?? []).find((request) => request.answerText.trim().length > 0);
  if (answered !== undefined) {
    return { text: answered.answerText.trim(), source: "chat" };
  }
  return { text: "", source: "none" };
};

const sidecarText = (item, prompt) => {
  const lines = [prompt.text];
  if (typeof item.negativePrompt === "string" && item.negativePrompt.trim().length > 0) {
    lines.push("", `Negative prompt: ${item.negativePrompt.trim()}`);
  }
  return `${lines.join("\n").slice(0, MAX_PROMPT_BYTES)}\n`;
};

const indexRecord = (item, prompt, imageName, sidecarName) => {
  const seen = item.sightings?.[0];
  return {
    hash: item.hash,
    imageFile: imageName,
    promptFile: sidecarName,
    generator: item.generator,
    prompt: prompt.text,
    promptSource: prompt.source,
    negativePrompt: item.negativePrompt ?? "",
    checkpoint: item.checkpoint ?? "",
    loras: (item.loras ?? []).map((lora) => lora.name),
    params: item.params ?? {},
    width: item.width,
    height: item.height,
    fileMtime: item.fileMtime,
    sender: seen?.speaker ?? "",
    groupName: seen?.groupName ?? "",
    groupId: seen?.groupId ?? "",
    sentAt: seen?.sentAt ?? 0,
  };
};

const CSV_COLUMNS = [
  "hash", "imageFile", "promptFile", "generator", "promptSource", "checkpoint",
  "loras", "width", "height", "sender", "groupName", "sentAt", "prompt", "negativePrompt",
];

// Excel treats a leading =, +, - or @ as a formula; prefix those so a prompt
// cannot execute anything when the CSV is opened.
const csvCell = (value) => {
  const text = Array.isArray(value) ? value.join(" | ") : String(value ?? "");
  const guarded = /^[=+\-@\t\r]/u.test(text) ? `'${text}` : text;
  return `"${guarded.replaceAll('"', '""')}"`;
};

const csvFrom = (records) => {
  const header = CSV_COLUMNS.join(",");
  const rows = records.map((record) => CSV_COLUMNS.map((column) => csvCell(record[column])).join(","));
  return `﻿${[header, ...rows].join("\r\n")}\r\n`;
};

const md5File = (filePath) => {
  const hash = crypto.createHash("md5");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
};

// Exports `items` into `outputDir`.
//
// mode:
//   "new"   skip anything the ledger has already exported (default)
//   "all"   export everything, refreshing the ledger
// Images whose cache file is gone are reported, never silently dropped: their
// prompt is still written so the knowledge is not lost with the picture.
const exportImages = ({
  toolRoot,
  outputDir,
  items,
  mode = "new",
  includeImages = true,
  includeSidecars = true,
  includeIndex = true,
  verifyHash = false,
}) => {
  if (!Array.isArray(items) || items.length === 0) {
    return { exported: 0, skipped: 0, missingFile: 0, failed: 0, outputDir, records: [], notes: [] };
  }
  const ledger = loadLedger(toolRoot);
  fs.mkdirSync(outputDir, { recursive: true });

  const stats = { exported: 0, skipped: 0, missingFile: 0, failed: 0 };
  const notes = [];
  const records = [];
  // Guards against two images resolving to the same stem within one run.
  const usedStems = new Set();
  const exportedAt = Math.floor(Date.now() / 1000);

  for (const [index, item] of items.entries()) {
    const previous = ledger.exports[item.hash];
    if (mode === "new" && previous !== undefined) {
      stats.skipped += 1;
      continue;
    }

    let stem = buildStem(item, index);
    let suffix = 1;
    while (usedStems.has(stem.toLowerCase())) {
      suffix += 1;
      stem = `${buildStem(item, index)}_${suffix}`;
    }
    usedStems.add(stem.toLowerCase());

    const prompt = promptFor(item);
    const extension = path.extname(item.filePath ?? "") || ".png";
    const imageName = `${stem}${extension}`;
    const sidecarName = `${stem}.txt`;

    let wroteImage = false;
    if (includeImages && item.filePath !== "" && item.filePath !== undefined) {
      try {
        if (verifyHash && md5File(item.filePath) !== item.hash) {
          // The cache slot was reused for different bytes; exporting it would
          // pair the wrong picture with this prompt.
          notes.push(`${item.hash.slice(0, 8)}：文件内容与记录不符，已跳过图片`);
          stats.failed += 1;
          continue;
        }
        fs.copyFileSync(item.filePath, path.join(outputDir, imageName));
        wroteImage = true;
      } catch (error) {
        stats.missingFile += 1;
        notes.push(`${item.hash.slice(0, 8)}：原图读取失败（${error.code ?? error.message}），只导出咒语`);
      }
    } else if (includeImages) {
      stats.missingFile += 1;
    }

    if (includeSidecars && prompt.text.length > 0) {
      try {
        fs.writeFileSync(path.join(outputDir, sidecarName), sidecarText(item, prompt), "utf8");
      } catch (error) {
        stats.failed += 1;
        notes.push(`${item.hash.slice(0, 8)}：写咒语文件失败（${error.code ?? error.message}）`);
        continue;
      }
    }

    records.push(indexRecord(item, prompt, wroteImage ? imageName : "", prompt.text.length > 0 ? sidecarName : ""));
    ledger.exports[item.hash] = {
      exportedAt,
      outputDir,
      imageFile: wroteImage ? imageName : "",
      promptFile: prompt.text.length > 0 ? sidecarName : "",
      promptSource: prompt.source,
    };
    stats.exported += 1;
  }

  if (includeIndex && records.length > 0) {
    const jsonl = records.map((record) => JSON.stringify(record)).join("\n");
    fs.writeFileSync(path.join(outputDir, "index.jsonl"), `${jsonl}\n`, "utf8");
    fs.writeFileSync(path.join(outputDir, "index.csv"), csvFrom(records), "utf8");
  }

  saveLedger(toolRoot, ledger);
  return { ...stats, outputDir, records, notes };
};

// How many of these would actually be written, without touching the disk. Lets
// the UI say "42 new, 18 already exported" before the user commits.
const previewExport = (toolRoot, items, mode = "new") => {
  const ledger = loadLedger(toolRoot);
  let fresh = 0;
  let already = 0;
  for (const item of items) {
    if (mode === "new" && ledger.exports[item.hash] !== undefined) {
      already += 1;
    } else {
      fresh += 1;
    }
  }
  return { fresh, already, ledgerSize: Object.keys(ledger.exports).length };
};

const forgetExports = (toolRoot, hashes = null) => {
  const ledger = loadLedger(toolRoot);
  const before = Object.keys(ledger.exports).length;
  if (hashes === null) {
    ledger.exports = {};
  } else {
    for (const hash of hashes) {
      delete ledger.exports[hash];
    }
  }
  saveLedger(toolRoot, ledger);
  return { removed: before - Object.keys(ledger.exports).length };
};

module.exports = {
  exportImages,
  previewExport,
  forgetExports,
  loadLedger,
  saveLedger,
  ledgerPath,
  // exported for tests
  buildStem,
  sanitizeStem,
  promptFor,
  csvFrom,
  LEDGER_SCHEMA,
};
