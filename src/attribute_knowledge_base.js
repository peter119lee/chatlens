"use strict";

// Attributes knowledge-base images to the person and group that posted them.
//
// Two sources, cheapest first:
//   1. Existing run manifests (runs\<id>\media\media-manifest.json) -- already
//      carry hash + group + speaker + time, no DB access needed.
//   2. store\messages.db media rows, whose row_id is "m<rowId>" and which the
//      manifests key back to.
//
// Deliberately does NOT open the 8 GB encrypted nt_msg.db: everything needed is
// already in artefacts produced by previous runs. Attribution therefore covers
// the time windows that have been exported, and the gap is reported rather than
// hidden.
//
// Usage:
//   node src/attribute_knowledge_base.js <toolkitRoot> <knowledgeStorePath>

const fs = require("node:fs");
const path = require("node:path");
const Database = require("better-sqlite3-multiple-ciphers");
const { openKnowledgeStore, recordSighting, storeSummary } = require("./knowledge_store");

const parseArgs = (argv) => {
  if (argv.length < 4) {
    throw new Error("Usage: node attribute_knowledge_base.js <toolkitRoot> <knowledgeStorePath>");
  }
  return { toolkitRoot: argv[2], storePath: argv[3] };
};

const readJsonOrNull = (filePath) => {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
};

// Manifest entries carry `hkt` (a formatted local timestamp) rather than a unix
// time, so the message cache is consulted for the real sent_at when available.
const collectManifestEntries = (toolkitRoot) => {
  const runsDir = path.join(toolkitRoot, "runs");
  let runs;
  try {
    runs = fs.readdirSync(runsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const entries = [];
  for (const run of runs) {
    if (!run.isDirectory()) {
      continue;
    }
    const manifest = readJsonOrNull(path.join(runsDir, run.name, "media", "media-manifest.json"));
    if (!Array.isArray(manifest)) {
      continue;
    }
    for (const item of manifest) {
      if (item.kind !== "image" || typeof item.hash !== "string" || item.hash.length !== 32) {
        continue;
      }
      entries.push({
        hash: item.hash.toLowerCase(),
        groupId: String(item.groupId ?? ""),
        groupName: String(item.groupName ?? ""),
        rowId: String(item.rowId ?? ""),
        speaker: String(item.speaker ?? ""),
      });
    }
  }
  return entries;
};

// Media rows in the message cache are stored as "m<rowId>" to avoid colliding
// with the text row for the same message.
const loadMessageIndex = (toolkitRoot) => {
  const storePath = path.join(toolkitRoot, "store", "messages.db");
  if (!fs.existsSync(storePath)) {
    return { byRowId: new Map(), groupNames: new Map() };
  }
  const db = new Database(storePath, { readonly: true });
  const rows = db.prepare(
    "SELECT group_id, row_id, sent_at, speaker, speaker_uin FROM messages WHERE is_media = 1",
  ).all();
  const names = db.prepare("SELECT group_id, name FROM group_names").all();
  db.close();

  const byRowId = new Map();
  for (const row of rows) {
    const bare = row.row_id.startsWith("m") ? row.row_id.slice(1) : row.row_id;
    byRowId.set(`${row.group_id}|${bare}`, row);
  }
  return { byRowId, groupNames: new Map(names.map((row) => [row.group_id, row.name])) };
};

const attributeKnowledgeBase = ({ toolkitRoot, storePath }) => {
  const db = openKnowledgeStore(storePath);
  const known = new Set(db.prepare("SELECT hash FROM images").all().map((row) => row.hash));
  const { byRowId, groupNames } = loadMessageIndex(toolkitRoot);
  const entries = collectManifestEntries(toolkitRoot);

  const stats = { entries: entries.length, matched: 0, unknownHash: 0, noTime: 0 };
  const seenHashes = new Set();

  const applyAll = db.transaction(() => {
    for (const entry of entries) {
      if (!known.has(entry.hash)) {
        stats.unknownHash += 1;
        continue;
      }
      const message = byRowId.get(`${entry.groupId}|${entry.rowId}`);
      if (message === undefined) {
        stats.noTime += 1;
      }
      recordSighting(db, {
        hash: entry.hash,
        groupId: entry.groupId,
        rowId: entry.rowId,
        sentAt: message?.sent_at ?? 0,
        speaker: entry.speaker || (message?.speaker ?? ""),
        speakerUin: message?.speaker_uin ?? "",
        groupName: entry.groupName || (groupNames.get(entry.groupId) ?? ""),
      });
      stats.matched += 1;
      seenHashes.add(entry.hash);
    }
  });
  applyAll();

  const summary = storeSummary(db);
  const byGroup = db.prepare(`
    SELECT s.group_id, MAX(s.group_name) AS group_name, COUNT(DISTINCT s.hash) AS images
    FROM sightings s
    GROUP BY s.group_id
    ORDER BY images DESC
  `).all();
  db.close();

  return { stats, summary, byGroup, uniqueHashes: seenHashes.size };
};

const main = () => {
  const args = parseArgs(process.argv);
  const { stats, summary, byGroup, uniqueHashes } = attributeKnowledgeBase(args);

  process.stdout.write(`manifest image entries : ${stats.entries}\n`);
  process.stdout.write(`matched to kb images   : ${stats.matched} (${uniqueHashes} unique)\n`);
  process.stdout.write(`hash not in kb         : ${stats.unknownHash}\n`);
  process.stdout.write(`matched but no sent_at : ${stats.noTime}\n`);
  process.stdout.write(`\nkb images ${summary.images}, attributed ${summary.attributed}`);
  process.stdout.write(` (${((summary.attributed / Math.max(summary.images, 1)) * 100).toFixed(1)}%)\n`);
  process.stdout.write("\n---- attributed images by group ----\n");
  for (const row of byGroup) {
    process.stdout.write(`  ${String(row.images).padStart(6)}  ${row.group_id}  ${row.group_name}\n`);
  }
};

if (require.main === module) {
  main();
}

module.exports = { attributeKnowledgeBase, collectManifestEntries };
