"use strict";

// Harvests AI metadata for the images referenced by one export, and attributes
// them to the group and sender in the same pass.
//
// This is the forward-looking path and the one that matters: it runs while the
// message is still in the local cache, so the (image -> who posted it, where,
// when) link is captured before QQ evicts either side. The bulk
// build_knowledge_base.js scan is the backfill counterpart; it can attribute
// nothing, because by the time it runs the messages are usually gone.
//
// Read-only with respect to QQ. Never copies images; records their cache path.
//
// Usage:
//   node src/harvest_run_media.js <mediaMessagesJson> <ntDataDir> <knowledgeStorePath> [exportJson]
//
// exportJson is optional: when given, "show me the prompt" exchanges in that
// export are detected and stored too. It is a separate argument because the
// media list is derived (post-analysis) while quote links live on the raw export.

const fs = require("node:fs");
const path = require("node:path");
const { parseAiMetadata, PARSER_VERSION } = require("./ai_metadata");
const { pairPromptRequests } = require("./prompt_requests");
const {
  openKnowledgeStore,
  upsertImage,
  recordSighting,
  recordPromptRequest,
  markScanned,
  loadScanState,
  isUnchanged,
} = require("./knowledge_store");

const parseArgs = (argv) => {
  if (argv.length < 5) {
    throw new Error("Usage: node harvest_run_media.js <mediaMessagesJson> <ntDataDir> <knowledgeStorePath> [exportJson]");
  }
  return {
    mediaMessagesJson: argv[2],
    ntDataDir: argv[3],
    storePath: argv[4],
    exportJson: argv[5] ?? "",
  };
};

// Ori holds the untouched original; Thumb is QQ's re-encode and never carries
// metadata. Both are named by the md5 of the ORIGINAL, so the same hash locates
// either -- but only Ori is worth parsing.
//
// One directory listing per month, reused across every hash in the export.
const buildOriIndex = (ntDataDir) => {
  const picRoot = path.join(ntDataDir, "Pic");
  const byHash = new Map();
  let months;
  try {
    months = fs.readdirSync(picRoot, { withFileTypes: true });
  } catch {
    return byHash;
  }
  for (const month of months) {
    if (!month.isDirectory()) {
      continue;
    }
    const oriDir = path.join(picRoot, month.name, "Ori");
    let names;
    try {
      names = fs.readdirSync(oriDir);
    } catch {
      continue;
    }
    for (const name of names) {
      const match = name.toLowerCase().match(/^([a-f0-9]{32})\./u);
      if (match !== null && !byHash.has(match[1])) {
        byHash.set(match[1], path.join(oriDir, name));
      }
    }
  }
  return byHash;
};

const speakerOf = (message) =>
  message.speaker || message.senderName || message.memberName || String(message.senderUin ?? "") || "";

// Collect (hash -> earliest message that referenced it). The earliest sighting
// is the original post; later ones are replies and forwards re-embedding the
// same ref, which the exporter already treats as non-authoritative.
const collectImageRefs = (mediaMessages) => {
  const byHash = new Map();
  for (const message of mediaMessages) {
    for (const ref of message.mediaRefs ?? []) {
      if (ref.kind !== "image" || typeof ref.hash !== "string" || ref.hash.length !== 32) {
        continue;
      }
      const hash = ref.hash.toLowerCase();
      const existing = byHash.get(hash);
      const sentAt = Number(message.sentAt ?? 0);
      if (existing === undefined || sentAt < existing.sentAt) {
        byHash.set(hash, {
          hash,
          sentAt,
          groupId: String(message.groupId ?? ""),
          groupName: String(message.groupName ?? ""),
          rowId: String(message.rowId ?? ""),
          speaker: speakerOf(message),
          speakerUin: String(message.senderUin ?? message.memberUin ?? ""),
        });
      }
    }
  }
  return byHash;
};

const readJsonOrNull = (filePath) => {
  if (filePath === "") {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
};

const harvestRunMedia = ({ mediaMessagesJson, ntDataDir, storePath, exportJson = "" }) => {
  const mediaMessages = JSON.parse(fs.readFileSync(mediaMessagesJson, "utf8"));
  const refs = collectImageRefs(Array.isArray(mediaMessages) ? mediaMessages : []);
  const exportData = readJsonOrNull(exportJson);
  // Prompt requests are detected from the raw export; pair them against the
  // analysed media list, which carries the resolved speaker names.
  const requests = exportData === null
    ? []
    : pairPromptRequests({ ...exportData, mediaMessages: Array.isArray(mediaMessages) ? mediaMessages : [] });

  const stats = {
    imageRefs: refs.size,
    originalMissing: 0,
    parsed: 0,
    stripped: 0,
    skipped: 0,
    attributed: 0,
    placeholders: 0,
    promptRequests: requests.length,
    answeredRequests: requests.filter((request) => request.answerKind !== "").length,
  };
  // An ask can occur in a window that contributed no new images, so the store is
  // still opened when only requests were found.
  if (refs.size === 0 && requests.length === 0) {
    return { stats };
  }

  const db = openKnowledgeStore(storePath);
  const oriIndex = buildOriIndex(ntDataDir);
  const scanState = loadScanState(db, PARSER_VERSION);
  const knownHashes = new Set(db.prepare("SELECT hash FROM images").all().map((row) => row.hash));

  const applyAll = db.transaction(() => {
    for (const [hash, sighting] of refs) {
      const filePath = oriIndex.get(hash);
      if (filePath === undefined) {
        // No original on disk: either never downloaded at full size, or the
        // cache has been pruned. Counted, not silently dropped.
        stats.originalMissing += 1;
        continue;
      }

      let stat;
      try {
        stat = fs.statSync(filePath);
      } catch {
        stats.originalMissing += 1;
        continue;
      }
      const fileMtime = Math.floor(stat.mtimeMs / 1000);
      const scannedAt = Math.floor(Date.now() / 1000);
      const alreadyParsed = isUnchanged(scanState, filePath, stat.size, fileMtime);

      if (alreadyParsed) {
        stats.skipped += 1;
      } else {
        const result = parseAiMetadata(filePath, stat.size);
        if (result.generator === "unknown") {
          stats.stripped += 1;
          markScanned(db, {
            filePath,
            fileSize: stat.size,
            fileMtime,
            parserVersion: PARSER_VERSION,
            outcome: result.container === null ? "unreadable" : "no-metadata",
            scannedAt,
          });
        } else {
          stats.parsed += 1;
          knownHashes.add(hash);
          upsertImage(db, { ...result, hash, filePath, fileMtime, parsedAt: scannedAt });
          markScanned(db, {
            filePath,
            fileSize: stat.size,
            fileMtime,
            parserVersion: PARSER_VERSION,
            outcome: result.generator,
            scannedAt,
          });
        }
      }

      // Attribution is the whole point of running here rather than in the bulk
      // scan, so record it whenever the image is in the store at all.
      if (knownHashes.has(hash)) {
        recordSighting(db, sighting);
        stats.attributed += 1;
      }
    }

    // Stored after the images, so a request pointing at an image harvested in
    // this same pass resolves against a row that already exists.
    //
    // A request's target frequently has NO metadata row: QQ stripped the
    // parameters, which is exactly why somebody had to ask for the prompt. Keep
    // a minimal placeholder row for those so the pairing can still show the
    // picture and the chat-sourced prompt together, with generator "stripped"
    // marking that nothing was read from the file itself.
    const recordedAt = Math.floor(Date.now() / 1000);
    const ensurePlaceholder = (hash) => {
      if (hash === null || knownHashes.has(hash)) {
        return;
      }
      const filePath = oriIndex.get(hash);
      const sighting = refs.get(hash);
      upsertImage(db, {
        hash,
        filePath: filePath ?? "",
        fileSize: 0,
        fileMtime: 0,
        container: null,
        width: 0,
        height: 0,
        generator: "stripped",
        prompt: "",
        negativePrompt: "",
        checkpoint: "",
        modelHash: "",
        loras: [],
        params: {},
        rawChunks: {},
        parserVersion: PARSER_VERSION,
        parsedAt: recordedAt,
      });
      knownHashes.add(hash);
      stats.placeholders += 1;
      if (sighting !== undefined) {
        recordSighting(db, sighting);
      }
    };
    for (const request of requests) {
      ensurePlaceholder(request.imageHash);
      for (const media of request.answerMedia) {
        ensurePlaceholder(media.hash);
      }
      recordPromptRequest(db, { ...request, recordedAt });
    }
  });
  applyAll();
  db.close();
  return { stats };
};

const main = () => {
  const args = parseArgs(process.argv);
  const { stats } = harvestRunMedia(args);

  const withOriginal = stats.parsed + stats.stripped + stats.skipped;
  process.stdout.write(`image refs=${stats.imageRefs} originals-on-disk=${withOriginal} `);
  process.stdout.write(`parsed=${stats.parsed} stripped=${stats.stripped} `);
  process.stdout.write(`already-known=${stats.skipped} no-original=${stats.originalMissing} `);
  process.stdout.write(`attributed=${stats.attributed}\n`);
  if (stats.promptRequests > 0) {
    process.stdout.write(`prompt requests=${stats.promptRequests} answered=${stats.answeredRequests}`);
    process.stdout.write(` metadata-stripped-targets=${stats.placeholders}\n`);
  }

  // Surfaced because it is actionable: QQ only keeps a full-resolution original
  // when the image was downloaded at original quality, and that is a client
  // setting the user controls.
  if (stats.imageRefs > 0 && stats.originalMissing / stats.imageRefs > 0.5) {
    const percent = ((stats.originalMissing / stats.imageRefs) * 100).toFixed(0);
    process.stdout.write(`提示：本次 ${percent}% 的图片本地没有原图，AI 参数无法读取。\n`);
    process.stdout.write("      在 QQ 设置里开启「自动下载原图」可让以后的图片保留生成参数。\n");
  }
};

if (require.main === module) {
  main();
}

module.exports = { harvestRunMedia, collectImageRefs, buildOriIndex };
