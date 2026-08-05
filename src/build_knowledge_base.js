"use strict";

// Harvests AI generation metadata from the QQNT image cache into store/knowledge.db.
//
// Read-only with respect to QQ: it walks nt_data\Pic\<YYYY-MM>\Ori, parses each
// image in place, and never copies or modifies the originals. The Ori filename
// IS the md5 of the file contents, which is the join key back to chat messages.
//
// Usage:
//   node src/build_knowledge_base.js <ntDataDir> <storePath> [--limit N] [--rescan]

const fs = require("node:fs");
const path = require("node:path");
const { parseAiMetadata, PARSER_VERSION } = require("./ai_metadata");
const {
  openKnowledgeStore,
  upsertImage,
  markScanned,
  loadScanState,
  isUnchanged,
  markMissingFiles,
  storeSummary,
} = require("./knowledge_store");

const HASH_NAME_PATTERN = /^([a-f0-9]{32})\./iu;
const PARSE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);
const PROGRESS_INTERVAL = 2000;
const COMMIT_INTERVAL = 500;

const parseArgs = (argv) => {
  if (argv.length < 4) {
    throw new Error("Usage: node build_knowledge_base.js <ntDataDir> <storePath> [--limit N] [--rescan]");
  }
  const flags = argv.slice(4);
  const limitIndex = flags.indexOf("--limit");
  return {
    ntDataDir: argv[2],
    storePath: argv[3],
    limit: limitIndex === -1 ? 0 : Number.parseInt(flags[limitIndex + 1] ?? "0", 10),
    rescan: flags.includes("--rescan"),
  };
};

// Only Ori under Pic holds full-resolution originals worth parsing. Thumb
// copies are re-encoded by QQ and never keep metadata, and Emoji\ is stickers
// and reaction images -- 63k files in this cache, none AI-generated -- so both
// are excluded rather than scanned for zero yield.
const collectOriDirectories = (ntDataDir) => {
  const root = path.join(ntDataDir, "Pic");
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(root, entry.name, "Ori"))
    .filter((directory) => fs.existsSync(directory));
};

const collectCandidates = (ntDataDir) => {
  const candidates = [];
  for (const directory of collectOriDirectories(ntDataDir)) {
    let names;
    try {
      names = fs.readdirSync(directory);
    } catch {
      continue;
    }
    for (const name of names) {
      const hashMatch = name.match(HASH_NAME_PATTERN);
      if (hashMatch === null || !PARSE_EXTENSIONS.has(path.extname(name).toLowerCase())) {
        continue;
      }
      candidates.push({ filePath: path.join(directory, name), hash: hashMatch[1].toLowerCase() });
    }
  }
  return candidates;
};

const statOrNull = (filePath) => {
  try {
    const stat = fs.statSync(filePath);
    return stat.isFile() ? stat : null;
  } catch {
    return null;
  }
};

const buildKnowledgeBase = ({ ntDataDir, storePath, limit, rescan }) => {
  const db = openKnowledgeStore(storePath);
  const scanState = rescan ? new Map() : loadScanState(db, PARSER_VERSION);

  const all = collectCandidates(ntDataDir);
  // Candidates arrive grouped by month directory, so a plain head/tail slice
  // would sample one month only. Stride evenly instead, so `--limit` gives a
  // yield estimate representative of the whole cache.
  const stride = limit > 0 && all.length > limit ? Math.floor(all.length / limit) : 1;
  const candidates = stride > 1 ? all.filter((_, index) => index % stride === 0).slice(0, limit) : all;
  process.stdout.write(`candidates=${candidates.length} (of ${all.length} hash-named originals)\n`);

  const stats = { scanned: 0, skipped: 0, parsed: 0, unreadable: 0, noMetadata: 0 };
  const startedAt = Date.now();
  let pending = 0;
  db.prepare("BEGIN").run();

  for (const candidate of candidates) {
    const stat = statOrNull(candidate.filePath);
    if (stat === null) {
      stats.unreadable += 1;
      continue;
    }
    const fileMtime = Math.floor(stat.mtimeMs / 1000);
    if (isUnchanged(scanState, candidate.filePath, stat.size, fileMtime)) {
      stats.skipped += 1;
      continue;
    }

    const result = parseAiMetadata(candidate.filePath, stat.size);
    stats.scanned += 1;
    const scannedAt = Math.floor(Date.now() / 1000);

    if (result.generator === "unknown") {
      stats.noMetadata += 1;
      markScanned(db, {
        filePath: candidate.filePath,
        fileSize: stat.size,
        fileMtime,
        parserVersion: PARSER_VERSION,
        outcome: result.container === null ? "unreadable" : "no-metadata",
        scannedAt,
      });
    } else {
      stats.parsed += 1;
      upsertImage(db, {
        ...result,
        hash: candidate.hash,
        filePath: candidate.filePath,
        fileMtime,
        parsedAt: scannedAt,
      });
      markScanned(db, {
        filePath: candidate.filePath,
        fileSize: stat.size,
        fileMtime,
        parserVersion: PARSER_VERSION,
        outcome: result.generator,
        scannedAt,
      });
    }

    pending += 1;
    if (pending >= COMMIT_INTERVAL) {
      db.prepare("COMMIT").run();
      db.prepare("BEGIN").run();
      pending = 0;
    }
    if (stats.scanned % PROGRESS_INTERVAL === 0) {
      const rate = stats.scanned / ((Date.now() - startedAt) / 1000);
      process.stdout.write(`  scanned=${stats.scanned} parsed=${stats.parsed} (${rate.toFixed(0)}/s)\n`);
    }
  }

  db.prepare("COMMIT").run();
  // Only meaningful on a full sweep: a --limit run sees a fraction of the cache
  // and would flag everything it did not visit as missing.
  const pruned = limit > 0 ? { checked: 0, missing: 0 } : markMissingFiles(db, fs.existsSync);
  const summary = storeSummary(db);
  db.close();
  return { stats, summary, pruned, elapsedMs: Date.now() - startedAt };
};

const main = () => {
  const args = parseArgs(process.argv);
  const { stats, summary, pruned, elapsedMs } = buildKnowledgeBase(args);

  process.stdout.write(`\nelapsed ${(elapsedMs / 1000).toFixed(1)}s\n`);
  process.stdout.write(`scanned=${stats.scanned} parsed=${stats.parsed} no-metadata=${stats.noMetadata} `);
  process.stdout.write(`skipped=${stats.skipped} unreadable=${stats.unreadable}\n`);
  if (pruned.missing > 0) {
    process.stdout.write(`\n${pruned.missing} 张图的本地原文件已被 QQ 清理，参数已保留、预览不可用。\n`);
  }
  process.stdout.write(`\nstore: images=${summary.images} withPrompt=${summary.withPrompt} `);
  process.stdout.write(`attributed=${summary.attributed} loras=${summary.loras} tags=${summary.tags}`);
  process.stdout.write(` fileMissing=${summary.fileMissing}\n`);
  for (const row of summary.generators) {
    process.stdout.write(`  ${String(row.count).padStart(6)}  ${row.generator}\n`);
  }
};

if (require.main === module) {
  main();
}

module.exports = { buildKnowledgeBase, collectCandidates, collectOriDirectories };
