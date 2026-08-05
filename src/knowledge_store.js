"use strict";

// Knowledge-base store for AI image metadata harvested from the QQNT cache.
//
// Lives in its own SQLite file (store/knowledge.db) rather than store/messages.db:
// the message cache is pruned on a retention window, while knowledge rows are
// meant to outlive the chat history they were discovered in.
//
// Attribution is deliberately separate from the image itself. One md5 can be
// posted in several groups by several people, so sightings are their own table
// and an image with no sighting yet is still a valid row.

const fs = require("node:fs");
const path = require("node:path");
const Database = require("better-sqlite3-multiple-ciphers");
const { normalizeOriginalReplyMedia } = require("./prompt_requests");

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS images (
    hash TEXT PRIMARY KEY,
    file_path TEXT NOT NULL DEFAULT '',
    file_size INTEGER NOT NULL DEFAULT 0,
    file_mtime INTEGER NOT NULL DEFAULT 0,
    container TEXT NOT NULL DEFAULT '',
    width INTEGER NOT NULL DEFAULT 0,
    height INTEGER NOT NULL DEFAULT 0,
    generator TEXT NOT NULL DEFAULT 'unknown',
    prompt TEXT NOT NULL DEFAULT '',
    negative_prompt TEXT NOT NULL DEFAULT '',
    checkpoint TEXT NOT NULL DEFAULT '',
    model_hash TEXT NOT NULL DEFAULT '',
    params_json TEXT NOT NULL DEFAULT '{}',
    raw_chunks_json TEXT NOT NULL DEFAULT '{}',
    parser_version INTEGER NOT NULL DEFAULT 0,
    parsed_at INTEGER NOT NULL DEFAULT 0
  )`,
  "CREATE INDEX IF NOT EXISTS idx_images_generator ON images(generator)",
  "CREATE INDEX IF NOT EXISTS idx_images_checkpoint ON images(checkpoint)",
  // Same image, same group, same message counts once; a genuine repost in
  // another group or by another person is a separate sighting.
  `CREATE TABLE IF NOT EXISTS sightings (
    hash TEXT NOT NULL,
    group_id TEXT NOT NULL,
    row_id TEXT NOT NULL,
    sent_at INTEGER NOT NULL DEFAULT 0,
    speaker TEXT NOT NULL DEFAULT '',
    speaker_uin TEXT NOT NULL DEFAULT '',
    group_name TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (hash, group_id, row_id)
  )`,
  "CREATE INDEX IF NOT EXISTS idx_sightings_group_time ON sightings(group_id, sent_at)",
  "CREATE INDEX IF NOT EXISTS idx_sightings_hash ON sightings(hash)",
  `CREATE TABLE IF NOT EXISTS image_loras (
    hash TEXT NOT NULL,
    lora_name TEXT NOT NULL,
    weight REAL,
    PRIMARY KEY (hash, lora_name)
  )`,
  "CREATE INDEX IF NOT EXISTS idx_image_loras_name ON image_loras(lora_name)",
  `CREATE TABLE IF NOT EXISTS image_tags (
    hash TEXT NOT NULL,
    tag TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'prompt',
    PRIMARY KEY (hash, tag, source)
  )`,
  "CREATE INDEX IF NOT EXISTS idx_image_tags_tag ON image_tags(tag)",
  // A "show me the prompt" exchange. Stored even when unanswered: the ask alone
  // marks the image as one people thought worth asking about, and an
  // answer that arrives in a later run can fill the row in.
  //
  // answer_text is the only place a prompt survives when QQ stripped the
  // image's metadata, which is the whole reason this table exists.
  `CREATE TABLE IF NOT EXISTS prompt_requests (
    group_id TEXT NOT NULL,
    ask_row_id TEXT NOT NULL,
    ask_sent_at INTEGER NOT NULL DEFAULT 0,
    group_name TEXT NOT NULL DEFAULT '',
    intent TEXT NOT NULL DEFAULT '',
    rule TEXT NOT NULL DEFAULT '',
    asker TEXT NOT NULL DEFAULT '',
    ask_text TEXT NOT NULL DEFAULT '',
    image_hash TEXT,
    image_owner TEXT NOT NULL DEFAULT '',
    image_sent_at INTEGER NOT NULL DEFAULT 0,
    target_via TEXT NOT NULL DEFAULT '',
    -- high = the reply quoted the image, medium = corroborated by the answering
    -- author, low = single-candidate guess, none = unresolved. Never presented
    -- to the user as a fact below "medium".
    confidence TEXT NOT NULL DEFAULT '',
    answer_text TEXT NOT NULL DEFAULT '',
    answer_kind TEXT NOT NULL DEFAULT '',
    answer_media_json TEXT NOT NULL DEFAULT '[]',
    answer_by TEXT NOT NULL DEFAULT '',
    answer_sent_at INTEGER NOT NULL DEFAULT 0,
    recorded_at INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (group_id, ask_row_id)
  )`,
  "CREATE INDEX IF NOT EXISTS idx_prompt_requests_hash ON prompt_requests(image_hash)",
  "CREATE INDEX IF NOT EXISTS idx_prompt_requests_time ON prompt_requests(group_id, ask_sent_at)",
  // Files that parsed to nothing are recorded so a rescan can skip them until
  // either the file or the parser changes.
  `CREATE TABLE IF NOT EXISTS scan_state (
    file_path TEXT PRIMARY KEY,
    file_size INTEGER NOT NULL DEFAULT 0,
    file_mtime INTEGER NOT NULL DEFAULT 0,
    parser_version INTEGER NOT NULL DEFAULT 0,
    outcome TEXT NOT NULL DEFAULT '',
    scanned_at INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE VIRTUAL TABLE IF NOT EXISTS images_fts USING fts5(
    hash UNINDEXED,
    prompt,
    negative_prompt,
    checkpoint,
    loras,
    tokenize = 'unicode61'
  )`,
];

const openKnowledgeStore = (storePath) => {
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  const db = new Database(storePath);
  db.pragma("journal_mode = WAL");
  for (const statement of SCHEMA_STATEMENTS) {
    db.prepare(statement).run();
  }
  // Additive migration, matching the pattern used by message_store.js, so an
  // existing knowledge.db keeps working after an upgrade.
  const columns = db.prepare("PRAGMA table_info(images)").all().map((column) => column.name);
  if (!columns.includes("file_missing")) {
    db.prepare("ALTER TABLE images ADD COLUMN file_missing INTEGER NOT NULL DEFAULT 0").run();
  }
  if (!columns.includes("object_path")) {
    db.prepare("ALTER TABLE images ADD COLUMN object_path TEXT NOT NULL DEFAULT ''").run();
  }
  const requestColumns = db.prepare("PRAGMA table_info(prompt_requests)").all().map((column) => column.name);
  if (!requestColumns.includes("answer_kind")) {
    db.prepare("ALTER TABLE prompt_requests ADD COLUMN answer_kind TEXT NOT NULL DEFAULT ''").run();
  }
  if (!requestColumns.includes("answer_media_json")) {
    db.prepare("ALTER TABLE prompt_requests ADD COLUMN answer_media_json TEXT NOT NULL DEFAULT '[]'").run();
  }
  db.prepare("UPDATE prompt_requests SET answer_kind = 'text' WHERE answer_kind = '' AND answer_text <> ''").run();
  return db;
};

// Prompts are comma-separated tag soup in this corpus. Split on commas only:
// splitting on spaces would shred multi-word Danbooru tags like `long hair`.
// Weight syntax (`(tag:1.2)`, `{{tag}}`, `[tag]`) and lora tags are stripped so
// the same concept collapses to one tag regardless of emphasis.
const MAX_TAG_CHARS = 80;
const MAX_TAGS_PER_IMAGE = 200;

const tagsFromPrompt = (prompt) => {
  const withoutLoras = String(prompt ?? "").replace(/<[^>]*>/gu, ",");
  const tags = withoutLoras
    .split(/[,\n]/u)
    // Unescape before stripping brackets: character tags are written
    // `\(azur lane\)`, so removing the parens first orphans the backslashes.
    .map((raw) => raw
      .replace(/\\(.)/gu, "$1")
      .replace(/[{}[\]()]/gu, "")
      .replace(/:\s*[\d.]+\s*$/u, "")
      .replace(/\s+/gu, " ")
      .trim()
      .toLowerCase())
    .filter((tag) => tag.length > 0 && tag.length <= MAX_TAG_CHARS);
  return [...new Set(tags)].slice(0, MAX_TAGS_PER_IMAGE);
};

const upsertImage = (db, record) => {
  const insertImage = db.prepare(`
    INSERT INTO images (
      hash, file_path, file_size, file_mtime, container, width, height,
      generator, prompt, negative_prompt, checkpoint, model_hash,
      params_json, raw_chunks_json, parser_version, parsed_at
    ) VALUES (
      @hash, @filePath, @fileSize, @fileMtime, @container, @width, @height,
      @generator, @prompt, @negativePrompt, @checkpoint, @modelHash,
      @paramsJson, @rawChunksJson, @parserVersion, @parsedAt
    )
    ON CONFLICT(hash) DO UPDATE SET
      file_path = excluded.file_path,
      file_size = excluded.file_size,
      file_mtime = excluded.file_mtime,
      container = excluded.container,
      width = excluded.width,
      height = excluded.height,
      generator = excluded.generator,
      prompt = excluded.prompt,
      negative_prompt = excluded.negative_prompt,
      checkpoint = excluded.checkpoint,
      model_hash = excluded.model_hash,
      params_json = excluded.params_json,
      raw_chunks_json = excluded.raw_chunks_json,
      parser_version = excluded.parser_version,
      parsed_at = excluded.parsed_at,
      -- The same md5 can reappear in a later month directory after eviction.
      file_missing = 0
  `);
  const deleteLoras = db.prepare("DELETE FROM image_loras WHERE hash = ?");
  const insertLora = db.prepare(
    "INSERT OR IGNORE INTO image_loras (hash, lora_name, weight) VALUES (?, ?, ?)",
  );
  const deleteTags = db.prepare("DELETE FROM image_tags WHERE hash = ? AND source = 'prompt'");
  const insertTag = db.prepare(
    "INSERT OR IGNORE INTO image_tags (hash, tag, source) VALUES (?, ?, 'prompt')",
  );
  const deleteFts = db.prepare("DELETE FROM images_fts WHERE hash = ?");
  const insertFts = db.prepare(`
    INSERT INTO images_fts (hash, prompt, negative_prompt, checkpoint, loras)
    VALUES (?, ?, ?, ?, ?)
  `);

  insertImage.run({
    hash: record.hash,
    filePath: record.filePath,
    fileSize: record.fileSize ?? 0,
    fileMtime: record.fileMtime ?? 0,
    container: record.container ?? "",
    width: record.width ?? 0,
    height: record.height ?? 0,
    generator: record.generator,
    prompt: record.prompt,
    negativePrompt: record.negativePrompt,
    checkpoint: record.checkpoint,
    modelHash: record.modelHash,
    paramsJson: JSON.stringify(record.params ?? {}),
    rawChunksJson: JSON.stringify(record.rawChunks ?? {}),
    parserVersion: record.parserVersion,
    parsedAt: record.parsedAt,
  });

  deleteLoras.run(record.hash);
  for (const lora of record.loras ?? []) {
    insertLora.run(record.hash, lora.name, lora.weight);
  }

  deleteTags.run(record.hash);
  for (const tag of tagsFromPrompt(record.prompt)) {
    insertTag.run(record.hash, tag);
  }

  // FTS5 has no upsert; delete-then-insert keeps the index single-rowed.
  deleteFts.run(record.hash);
  insertFts.run(
    record.hash,
    record.prompt,
    record.negativePrompt,
    record.checkpoint,
    (record.loras ?? []).map((lora) => lora.name).join(" "),
  );
};

const recordSighting = (db, sighting) =>
  db.prepare(`
    INSERT INTO sightings (hash, group_id, row_id, sent_at, speaker, speaker_uin, group_name)
    VALUES (@hash, @groupId, @rowId, @sentAt, @speaker, @speakerUin, @groupName)
    ON CONFLICT(hash, group_id, row_id) DO UPDATE SET
      sent_at = excluded.sent_at,
      speaker = excluded.speaker,
      speaker_uin = excluded.speaker_uin,
      group_name = CASE WHEN excluded.group_name <> '' THEN excluded.group_name ELSE sightings.group_name END
  `).run({
    hash: sighting.hash,
    groupId: String(sighting.groupId),
    rowId: String(sighting.rowId),
    sentAt: sighting.sentAt ?? 0,
    speaker: sighting.speaker ?? "",
    speakerUin: String(sighting.speakerUin ?? ""),
    groupName: sighting.groupName ?? "",
  });

const attachMediaObject = (db, mediaObject) =>
  db.prepare(`
    UPDATE images
    SET object_path = @objectPath
    WHERE hash = @hash
  `).run({
    hash: mediaObject.hash,
    objectPath: mediaObject.objectPath,
  });

const markScanned = (db, state) =>
  db.prepare(`
    INSERT INTO scan_state (file_path, file_size, file_mtime, parser_version, outcome, scanned_at)
    VALUES (@filePath, @fileSize, @fileMtime, @parserVersion, @outcome, @scannedAt)
    ON CONFLICT(file_path) DO UPDATE SET
      file_size = excluded.file_size,
      file_mtime = excluded.file_mtime,
      parser_version = excluded.parser_version,
      outcome = excluded.outcome,
      scanned_at = excluded.scanned_at
  `).run({
    filePath: state.filePath,
    fileSize: state.fileSize,
    fileMtime: state.fileMtime,
    parserVersion: state.parserVersion,
    outcome: state.outcome,
    scannedAt: state.scannedAt,
  });

// Upserts a detected prompt request. An answer is never overwritten with a
// blank one: a later run that re-scans the same window without seeing the reply
// (or a narrower time range) must not erase an answer already captured.
const ANSWER_KINDS = new Set(["", "text", "media"]);

const normalizeRequestAnswer = (request) => {
  const answerText = String(request.answerText ?? "");
  const answerMedia = normalizeOriginalReplyMedia(request.answerMedia);
  const inferredKind = answerText !== "" ? "text" : (answerMedia.length > 0 ? "media" : "");
  const answerKind = request.answerKind ?? inferredKind;
  if (!ANSWER_KINDS.has(answerKind)) {
    throw new RangeError(`Unsupported prompt request answer kind. answerKind=${answerKind}`);
  }
  if (answerKind === "text" && answerText === "") {
    throw new TypeError("Prompt request text answer requires answerText.");
  }
  if (answerKind === "media" && answerMedia.length === 0) {
    throw new TypeError("Original-image request answer requires at least one image or file.");
  }
  return { answerKind, answerText, answerMedia };
};

const recordPromptRequest = (db, request) => {
  const answer = normalizeRequestAnswer(request);
  return db.prepare(`
    INSERT INTO prompt_requests (
      group_id, ask_row_id, ask_sent_at, group_name, intent, rule, asker, ask_text,
      image_hash, image_owner, image_sent_at, target_via, confidence,
      answer_text, answer_kind, answer_media_json, answer_by, answer_sent_at, recorded_at
    ) VALUES (
      @groupId, @askRowId, @askSentAt, @groupName, @intent, @rule, @asker, @askText,
      @imageHash, @imageOwner, @imageSentAt, @targetVia, @confidence,
      @answerText, @answerKind, @answerMediaJson, @answerBy, @answerSentAt, @recordedAt
    )
    ON CONFLICT(group_id, ask_row_id) DO UPDATE SET
      group_name = CASE WHEN excluded.group_name <> '' THEN excluded.group_name ELSE prompt_requests.group_name END,
      intent = excluded.intent,
      rule = excluded.rule,
      asker = excluded.asker,
      ask_text = excluded.ask_text,
      image_hash = COALESCE(excluded.image_hash, prompt_requests.image_hash),
      image_owner = CASE WHEN excluded.image_owner <> '' THEN excluded.image_owner ELSE prompt_requests.image_owner END,
      image_sent_at = MAX(excluded.image_sent_at, prompt_requests.image_sent_at),
      target_via = excluded.target_via,
      confidence = excluded.confidence,
      answer_text = CASE WHEN excluded.answer_kind <> '' THEN excluded.answer_text ELSE prompt_requests.answer_text END,
      answer_kind = CASE WHEN excluded.answer_kind <> '' THEN excluded.answer_kind ELSE prompt_requests.answer_kind END,
      answer_media_json = CASE WHEN excluded.answer_kind <> '' THEN excluded.answer_media_json ELSE prompt_requests.answer_media_json END,
      answer_by = CASE WHEN excluded.answer_kind <> '' THEN excluded.answer_by ELSE prompt_requests.answer_by END,
      answer_sent_at = CASE WHEN excluded.answer_kind <> '' THEN excluded.answer_sent_at ELSE prompt_requests.answer_sent_at END,
      recorded_at = excluded.recorded_at
  `).run({
    groupId: String(request.groupId),
    askRowId: String(request.askRowId),
    askSentAt: request.askSentAt ?? 0,
    groupName: request.groupName ?? "",
    intent: request.intent ?? "",
    rule: request.rule ?? "",
    asker: request.asker ?? "",
    askText: request.askText ?? "",
    imageHash: request.imageHash ?? null,
    imageOwner: request.imageOwner ?? "",
    imageSentAt: request.imageSentAt ?? 0,
    targetVia: request.targetVia ?? "",
    confidence: request.confidence ?? "",
    answerText: answer.answerText,
    answerKind: answer.answerKind,
    answerMediaJson: JSON.stringify(answer.answerMedia),
    answerBy: request.answerBy ?? "",
    answerSentAt: request.answerSentAt ?? 0,
    recordedAt: request.recordedAt ?? 0,
  });
};

// A file is re-parsed when its bytes changed or the parser was upgraded, so a
// parser fix retroactively improves rows without a manual purge.
const loadScanState = (db, parserVersion) => {
  const rows = db.prepare(
    "SELECT file_path, file_size, file_mtime FROM scan_state WHERE parser_version >= ?",
  ).all(parserVersion);
  return new Map(rows.map((row) => [row.file_path, row]));
};

const isUnchanged = (state, filePath, fileSize, fileMtime) => {
  const known = state.get(filePath);
  return known !== undefined && known.file_size === fileSize && known.file_mtime === fileMtime;
};

const countsByGenerator = (db) =>
  db.prepare("SELECT generator, COUNT(*) AS count FROM images GROUP BY generator ORDER BY count DESC").all();

// Placeholder rows (generator 'stripped') exist only so a chat-sourced prompt
// can still show its picture. They carry no parsed metadata, so counting them as
// knowledge-base images would overstate what was actually recovered.
const PLACEHOLDER_GENERATOR = "stripped";

// QQ evicts cached originals continuously, so rows accumulate that point at
// files which no longer exist. Their metadata is still the most valuable thing
// in the store -- it outlived the image -- so a missing file is RECORDED, not
// deleted: file_path is cleared and file_missing set, keeping prompt, model and
// attribution searchable while marking the preview as unavailable.
const markMissingFiles = (db, existsOnDisk) => {
  const rows = db.prepare("SELECT hash, file_path FROM images WHERE file_path <> '' AND file_missing = 0").all();
  const clear = db.prepare("UPDATE images SET file_path = '', file_missing = 1 WHERE hash = ?");
  const dropScanState = db.prepare("DELETE FROM scan_state WHERE file_path = ?");

  let missing = 0;
  const applyAll = db.transaction(() => {
    for (const row of rows) {
      if (existsOnDisk(row.file_path)) {
        continue;
      }
      clear.run(row.hash);
      // Drop the scan_state row too, so the same md5 arriving again in a later
      // month directory is parsed rather than skipped as "already seen".
      dropScanState.run(row.file_path);
      missing += 1;
    }
  });
  applyAll();
  return { checked: rows.length, missing };
};

const storeSummary = (db) => ({
  images: db.prepare("SELECT COUNT(*) AS count FROM images WHERE generator <> ?").get(PLACEHOLDER_GENERATOR).count,
  placeholders: db.prepare("SELECT COUNT(*) AS count FROM images WHERE generator = ?").get(PLACEHOLDER_GENERATOR).count,
  withPrompt: db.prepare("SELECT COUNT(*) AS count FROM images WHERE prompt <> ''").get().count,
  attributed: db.prepare("SELECT COUNT(DISTINCT hash) AS count FROM sightings").get().count,
  sightings: db.prepare("SELECT COUNT(*) AS count FROM sightings").get().count,
  loras: db.prepare("SELECT COUNT(DISTINCT lora_name) AS count FROM image_loras").get().count,
  tags: db.prepare("SELECT COUNT(DISTINCT tag) AS count FROM image_tags").get().count,
  fileMissing: db.prepare("SELECT COUNT(*) AS count FROM images WHERE file_missing = 1 AND object_path = ''").get().count,
  durableMedia: db.prepare("SELECT COUNT(*) AS count FROM images WHERE object_path <> ''").get().count,
  promptRequests: db.prepare("SELECT COUNT(*) AS count FROM prompt_requests").get().count,
  answeredRequests: db.prepare("SELECT COUNT(*) AS count FROM prompt_requests WHERE answer_kind <> ''").get().count,
  generators: countsByGenerator(db),
});

module.exports = {
  openKnowledgeStore,
  upsertImage,
  recordSighting,
  attachMediaObject,
  recordPromptRequest,
  markScanned,
  loadScanState,
  isUnchanged,
  markMissingFiles,
  storeSummary,
  countsByGenerator,
  tagsFromPrompt,
};
