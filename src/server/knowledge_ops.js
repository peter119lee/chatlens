"use strict";

// Read-only query layer over store/knowledge.db for the control centre.
//
// Separate from knowledge_store.js on purpose: that module owns writes and is
// used by the harvesters, while this one only reads and shapes results for the
// UI. Opening read-only also means a browse never blocks a running harvest.

const fs = require("node:fs");
const path = require("node:path");
const Database = require("better-sqlite3-multiple-ciphers");
const { parse: parseQuery } = require("../knowledge_query");

const DEFAULT_LIMIT = 60;
const MAX_LIMIT = 200;
const MAX_QUERY_CHARS = 200;
const PLACEHOLDER_GENERATOR = "stripped";

const knowledgeDbPath = (toolRoot) => path.join(toolRoot, "store", "knowledge.db");
const mediaObjectDir = (toolRoot) => path.join(toolRoot, "store", "media-objects");

const openReadOnly = (toolRoot) => {
  const storePath = knowledgeDbPath(toolRoot);
  if (!fs.existsSync(storePath)) {
    return null;
  }
  return new Database(storePath, { readonly: true, fileMustExist: true });
};

// A read-only connection cannot run migrations, so a store written by an older
// version may be missing newer tables and columns. Queries must therefore probe
// the schema rather than assume it: the alternative is the whole knowledge page
// failing for anyone who has not re-run a harvest since upgrading.
const hasTable = (db, name) =>
  db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;

const hasColumn = (db, table, column) =>
  db.prepare(`PRAGMA table_info(${table})`).all().some((row) => row.name === column);

// FTS5 treats bare punctuation as syntax. User input is therefore tokenised
// into bare words and each is turned into a prefix term, so "wakaba mut" finds
// "wakaba mutsumi" without the caller learning MATCH syntax.
const toMatchExpression = (query) => {
  const terms = String(query ?? "")
    .slice(0, MAX_QUERY_CHARS)
    .split(/[^\p{L}\p{N}_]+/u)
    .map((term) => term.trim())
    .filter((term) => term.length > 0)
    .slice(0, 12);
  if (terms.length === 0) {
    return "";
  }
  return terms.map((term) => `"${term.replaceAll('"', "")}"*`).join(" AND ");
};

const clampLimit = (limit) => {
  const parsed = Number.parseInt(limit, 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    return DEFAULT_LIMIT;
  }
  return Math.min(parsed, MAX_LIMIT);
};

const parseParams = (json) => {
  try {
    const parsed = JSON.parse(json ?? "{}");
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
};

const HASH_PATTERN = /^[a-f0-9]{32}$/u;
const ANSWER_MEDIA_KINDS = new Set(["image", "file"]);

const parseAnswerMedia = (json) => {
  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    throw new SyntaxError(`Invalid prompt request answer_media_json. cause=${error.message}`);
  }
  if (!Array.isArray(parsed)) {
    throw new TypeError("Prompt request answer_media_json must contain an array.");
  }
  return parsed.map((entry, index) => {
    if (typeof entry !== "object" || entry === null || !ANSWER_MEDIA_KINDS.has(entry.kind)) {
      throw new TypeError(`Invalid prompt request media entry. index=${index}`);
    }
    const hash = entry.hash === null ? null : String(entry.hash ?? "").toLowerCase();
    if (hash !== null && !HASH_PATTERN.test(hash)) {
      throw new TypeError(`Invalid prompt request media hash. index=${index}`);
    }
    const fileName = String(entry.fileName ?? "");
    if (hash === null && fileName === "") {
      throw new TypeError(`Prompt request media entry requires hash or fileName. index=${index}`);
    }
    return { kind: entry.kind, hash, fileName };
  });
};

const answerKindExpression = (capabilities, alias) => capabilities.answerKind
  ? `${alias}answer_kind`
  : `CASE WHEN ${alias}answer_text <> '' THEN 'text' ELSE '' END`;

const answerMediaExpression = (capabilities, alias) => capabilities.answerMedia
  ? `${alias}answer_media_json`
  : "'[]'";

const answeredRequestCondition = (capabilities, alias) =>
  `${answerKindExpression(capabilities, alias)} <> ''`;

const availableFileCondition = (capabilities, alias) => {
  const cacheFile = capabilities.fileMissing
    ? `(${alias}file_missing = 0 AND ${alias}file_path <> '')`
    : `${alias}file_path <> ''`;
  return capabilities.objectPath
    ? `(${cacheFile} OR ${alias}object_path <> '')`
    : cacheFile;
};

const decorateRequestAnswer = (row, availabilityStatement) => {
  const answerMedia = parseAnswerMedia(row.answerMediaJson).map((media) => {
    if (media.hash === null) {
      return { ...media, hasFile: false };
    }
    const available = availabilityStatement.get(media.hash);
    return { ...media, hasFile: available?.hasFile === 1 };
  });
  const { answerMediaJson, ...rest } = row;
  return { ...rest, answerMedia };
};

// One image plus everything the UI shows about it. loras and sightings are
// fetched per row rather than joined, so a row with 17 loras does not multiply
// into 17 result rows.
// Why does this image have no group record? Guessing would be unhelpful, so the
// reason is derived from evidence we actually hold:
//
//   outside-coverage  the file entered the cache outside every window we have
//                     summarised -- by far the most common case, and fixable by
//                     summarising that period
//   not-in-messages   the window WAS summarised and the image still never
//                     appeared in a group message, so it came from somewhere
//                     else: your own generations, a private chat, favourites
//   evicted           the original is gone, so nothing can be re-checked
//   unavailable       no local original was ever recorded for this row
//
// Coverage comes from the message store's scan_ranges, which is the same source
// the messages page uses for its timeline.
const ATTRIBUTION_REASONS = {
  attributed: "attributed",
  evicted: "evicted",
  unavailable: "unavailable",
  outsideCoverage: "outside-coverage",
  notInMessages: "not-in-messages",
};

const loadCoverageRanges = (toolRoot) => {
  const storePath = path.join(toolRoot, "store", "messages.db");
  if (!fs.existsSync(storePath)) {
    return [];
  }
  const db = new Database(storePath, { readonly: true, fileMustExist: true });
  try {
    return db.prepare("SELECT start_unix AS startUnix, end_unix AS endUnix FROM scan_ranges ORDER BY start_unix").all();
  } catch {
    return [];
  } finally {
    db.close();
  }
};

const isInsideCoverage = (ranges, unixSeconds) =>
  unixSeconds > 0 && ranges.some((range) => unixSeconds >= range.startUnix && unixSeconds <= range.endUnix);

const attributionReason = (row, ranges, hasSighting) => {
  if (hasSighting) {
    return ATTRIBUTION_REASONS.attributed;
  }
  const hasObject = typeof row.object_path === "string" && row.object_path !== "";
  if (!hasObject && row.file_missing === 1) {
    return ATTRIBUTION_REASONS.evicted;
  }
  if (!hasObject && row.file_path === "") {
    return ATTRIBUTION_REASONS.unavailable;
  }
  return isInsideCoverage(ranges, row.file_mtime)
    ? ATTRIBUTION_REASONS.notInMessages
    : ATTRIBUTION_REASONS.outsideCoverage;
};

// Cards clamp the prompt for display, so shipping the whole thing is waste:
// measured against real data, 77% of prompt bytes never reach the screen, and a
// 5,000-item result would transfer ~11 MB. List responses therefore carry a
// preview, and the full text is fetched per image when the detail view opens.
// The `truncated` flag lets the UI say so rather than silently showing less.
const PROMPT_PREVIEW_CHARS = 400;

const previewText = (value) => {
  const text = String(value ?? "");
  return text.length > PROMPT_PREVIEW_CHARS
    ? { text: text.slice(0, PROMPT_PREVIEW_CHARS), truncated: true }
    : { text, truncated: false };
};

const decorateImage = (db, row, capabilities, ranges = [], { full = false } = {}) => {
  const loras = db.prepare("SELECT lora_name AS name, weight FROM image_loras WHERE hash = ? ORDER BY lora_name").all(row.hash);
  const sightings = db.prepare(`
    SELECT group_id AS groupId, group_name AS groupName, speaker, sent_at AS sentAt
    FROM sightings WHERE hash = ? ORDER BY sent_at LIMIT 8
  `).all(row.hash);
  const answerMediaAvailability = db.prepare(`
    SELECT CASE WHEN ${availableFileCondition(capabilities, "")} THEN 1 ELSE 0 END AS hasFile
    FROM images WHERE hash = ?
  `);
  const requests = capabilities.promptRequests
    ? db.prepare(`
        SELECT asker, ask_text AS askText, intent, confidence, answer_by AS answerBy,
               answer_text AS answerText, ask_sent_at AS askSentAt,
               ${answerKindExpression(capabilities, "")} AS answerKind,
               ${answerMediaExpression(capabilities, "")} AS answerMediaJson
        FROM prompt_requests WHERE image_hash = ? ORDER BY ask_sent_at LIMIT 8
      `).all(row.hash)
        .map((request) => decorateRequestAnswer(request, answerMediaAvailability))
        .map((request) => (full
          ? request
          : { ...request, answerText: previewText(request.answerText).text }))
    : [];

  const hasObject = capabilities.objectPath && row.object_path !== "";
  const fileMissing = capabilities.fileMissing ? row.file_missing === 1 && !hasObject : false;
  const prompt = full ? { text: row.prompt, truncated: false } : previewText(row.prompt);
  return {
    hash: row.hash,
    generator: row.generator,
    isPlaceholder: row.generator === PLACEHOLDER_GENERATOR,
    prompt: prompt.text,
    promptTruncated: prompt.truncated,
    // Only the detail view renders the negative prompt, so list rows omit it
    // entirely rather than carrying a field nothing on a card reads.
    ...(full ? { negativePrompt: row.negative_prompt } : {}),
    checkpoint: row.checkpoint,
    modelHash: row.model_hash,
    width: row.width,
    height: row.height,
    fileSize: row.file_size,
    fileMtime: row.file_mtime,
    // The cache path is never sent to the browser; images are fetched by hash.
    hasFile: (!fileMissing && row.file_path !== "") || hasObject,
    fileMissing,
    attributionReason: attributionReason(row, ranges, sightings.length > 0),
    params: parseParams(row.params_json),
    loras,
    sightings,
    promptRequests: requests,
  };
};

// Capabilities of the store as it exists on disk, so every query can adapt to a
// schema written by an older version.
const probeCapabilities = (db) => {
  const promptRequests = hasTable(db, "prompt_requests");
  return {
    promptRequests,
    fileMissing: hasColumn(db, "images", "file_missing"),
    objectPath: hasColumn(db, "images", "object_path"),
    confidence: promptRequests && hasColumn(db, "prompt_requests", "confidence"),
    answerKind: promptRequests && hasColumn(db, "prompt_requests", "answer_kind"),
    answerMedia: promptRequests && hasColumn(db, "prompt_requests", "answer_media_json"),
  };
};

// Translates a parsed query into SQL conditions.
//
// Every field contributes an AND-ed condition; values WITHIN one list field are
// OR-ed (model:a model:b means either model). Exclusions become NOT EXISTS.
// Free text goes to FTS5; everything else is a plain indexed comparison, so a
// structured query never pays for a full-text scan it does not need.
//
// Returns { where, args, usesFts } for the caller to compose. Parameter names
// are generated to avoid collisions when the same field appears twice.
const buildConditions = (query, capabilities) => {
  const conditions = [];
  const args = {};
  let counter = 0;
  const bind = (value) => {
    counter += 1;
    const name = `p${counter}`;
    args[name] = value;
    return `@${name}`;
  };

  // Values in a list are alternatives; LIKE lets a partial name match, which is
  // what users expect when typing `model:anima` against a long filename.
  const likeAny = (column, values) =>
    `(${values.map((value) => `${column} LIKE ${bind(`%${value}%`)}`).join(" OR ")})`;

  const existsAny = (table, column, values, hashColumn = "hash") =>
    `(${values.map((value) => `EXISTS (SELECT 1 FROM ${table} x WHERE x.${hashColumn} = i.hash AND x.${column} LIKE ${bind(`%${value}%`)})`).join(" OR ")})`;

  const notExistsAll = (table, column, values, hashColumn = "hash") =>
    values.map((value) => `NOT EXISTS (SELECT 1 FROM ${table} x WHERE x.${hashColumn} = i.hash AND x.${column} LIKE ${bind(`%${value}%`)})`).join(" AND ");

  if (query.checkpoints.length > 0) {
    conditions.push(likeAny("i.checkpoint", query.checkpoints));
  }
  if (query.excludeCheckpoints.length > 0) {
    conditions.push(query.excludeCheckpoints.map((value) => `i.checkpoint NOT LIKE ${bind(`%${value}%`)}`).join(" AND "));
  }
  if (query.generators.length > 0) {
    conditions.push(`(${query.generators.map((value) => `i.generator = ${bind(value.toLowerCase())}`).join(" OR ")})`);
  }
  if (query.excludeGenerators.length > 0) {
    conditions.push(query.excludeGenerators.map((value) => `i.generator <> ${bind(value.toLowerCase())}`).join(" AND "));
  }
  if (query.tags.length > 0) {
    conditions.push(existsAny("image_tags", "tag", query.tags));
  }
  if (query.excludeTags.length > 0) {
    conditions.push(notExistsAll("image_tags", "tag", query.excludeTags));
  }
  if (query.loras.length > 0) {
    conditions.push(existsAny("image_loras", "lora_name", query.loras));
  }
  if (query.excludeLoras.length > 0) {
    conditions.push(notExistsAll("image_loras", "lora_name", query.excludeLoras));
  }
  if (query.senders.length > 0) {
    conditions.push(existsAny("sightings", "speaker", query.senders));
  }
  if (query.excludeSenders.length > 0) {
    conditions.push(notExistsAll("sightings", "speaker", query.excludeSenders));
  }
  if (query.groups.length > 0) {
    conditions.push(`(${query.groups.map((value) =>
      `EXISTS (SELECT 1 FROM sightings x WHERE x.hash = i.hash AND (x.group_id = ${bind(value)} OR x.group_name LIKE ${bind(`%${value}%`)}))`).join(" OR ")})`);
  }
  if (query.prompts.length > 0) {
    conditions.push(`(${query.prompts.map((value) => `i.prompt LIKE ${bind(`%${value}%`)}`).join(" OR ")})`);
  }
  if (query.excludePrompts.length > 0) {
    conditions.push(query.excludePrompts.map((value) => `i.prompt NOT LIKE ${bind(`%${value}%`)}`).join(" AND "));
  }
  if (query.seed !== "") {
    // seed lives inside params_json, so match it as a JSON fragment.
    conditions.push(`i.params_json LIKE ${bind(`%"seed":"${query.seed}"%`)}`);
  }

  for (const [field, column] of [["steps", "steps"], ["cfg", "cfgScale"]]) {
    const min = query[`${field}Min`];
    const max = query[`${field}Max`];
    // json_extract keeps this honest for numbers stored as JSON values.
    if (min !== null) {
      conditions.push(`CAST(json_extract(i.params_json, '$.${column}') AS REAL) >= ${bind(min)}`);
    }
    if (max !== null) {
      conditions.push(`CAST(json_extract(i.params_json, '$.${column}') AS REAL) <= ${bind(max)}`);
    }
  }
  for (const field of ["width", "height"]) {
    if (query[`${field}Min`] !== null) {
      conditions.push(`i.${field} >= ${bind(query[`${field}Min`])}`);
    }
    if (query[`${field}Max`] !== null) {
      conditions.push(`i.${field} <= ${bind(query[`${field}Max`])}`);
    }
  }

  if (query.aspect === "square") {
    conditions.push("i.width > 0 AND i.height > 0 AND CAST(i.width AS REAL) / i.height BETWEEN 0.95 AND 1.05");
  } else if (query.aspect === "landscape") {
    conditions.push("i.width > 0 AND i.height > 0 AND CAST(i.width AS REAL) / i.height > 1.05");
  } else if (query.aspect === "portrait") {
    conditions.push("i.width > 0 AND i.height > 0 AND CAST(i.width AS REAL) / i.height < 0.95");
  }

  // Dates are day-inclusive: dateTo covers the whole of that day.
  if (query.dateFrom !== null) {
    conditions.push(`i.file_mtime >= ${bind(Math.floor(Date.parse(`${query.dateFrom}T00:00:00Z`) / 1000))}`);
  }
  if (query.dateTo !== null) {
    conditions.push(`i.file_mtime <= ${bind(Math.floor(Date.parse(`${query.dateTo}T23:59:59Z`) / 1000))}`);
  }

  const flagConditions = {
    prompt: "i.prompt <> ''",
    negative: "i.negative_prompt <> ''",
    lora: "EXISTS (SELECT 1 FROM image_loras x WHERE x.hash = i.hash)",
    sender: "EXISTS (SELECT 1 FROM sightings x WHERE x.hash = i.hash)",
    file: availableFileCondition(capabilities, "i."),
    answer: capabilities.promptRequests
      ? `EXISTS (SELECT 1 FROM prompt_requests x WHERE x.image_hash = i.hash AND ${answeredRequestCondition(capabilities, "x.")})`
      : "1 = 0",
  };
  for (const [flag, wanted] of Object.entries(query.flags)) {
    const condition = flagConditions[flag];
    if (condition === undefined) {
      continue;
    }
    conditions.push(wanted ? condition : `NOT (${condition})`);
  }

  const freeText = query.freeText.join(" ").trim();
  return {
    where: conditions.length > 0 ? `AND ${conditions.join(" AND ")}` : "",
    args,
    freeText,
  };
};

// `file_mtime` is when the image entered the cache and is the only time an
// unattributed image has; a sighting is more meaningful when present. parsed_at
// breaks ties so paging is stable rather than arbitrary.
const RECENCY = "COALESCE((SELECT MAX(s.sent_at) FROM sightings s WHERE s.hash = i.hash), i.file_mtime)";

const SORT_OPTIONS = {
  recent: `${RECENCY} DESC, i.parsed_at DESC, i.hash DESC`,
  oldest: `${RECENCY} ASC, i.parsed_at ASC, i.hash ASC`,
  asked: "(SELECT COUNT(*) FROM prompt_requests r WHERE r.image_hash = i.hash) DESC, i.file_mtime DESC",
  loras: "(SELECT COUNT(*) FROM image_loras l WHERE l.hash = i.hash) DESC, i.file_mtime DESC",
  largest: "i.file_size DESC, i.hash DESC",
  promptLength: "length(i.prompt) DESC, i.hash DESC",
};

const orderClause = (sort, capabilities) => {
  if (sort === "asked" && !capabilities.promptRequests) {
    return SORT_OPTIONS.recent;
  }
  return SORT_OPTIONS[sort] ?? SORT_OPTIONS.recent;
};


const IMAGE_COLUMNS = `
  hash, generator, prompt, negative_prompt, checkpoint, model_hash,
  width, height, file_size, file_path, file_mtime, params_json
`;

const imageColumnsFor = (capabilities) =>
  `${IMAGE_COLUMNS}, ${capabilities.fileMissing ? "file_missing" : "0 AS file_missing"}, ` +
  `${capabilities.objectPath ? "object_path" : "'' AS object_path"}`;

// Searches the library. `query` accepts the full grammar from knowledge_query
// (key:value, -key:value, ranges, flags) plus bare free text; `generator`,
// `groupId` and `sender` are the dropdown equivalents, applied on top.
//
// The parsed query is returned alongside the results so the UI can show what it
// understood and surface warnings, rather than silently ignoring a typo.
const searchImages = (toolRoot, {
  query = "", generator = "", groupId = "", sender = "", sort = "recent", limit, offset = 0,
} = {}) => {
  const db = openReadOnly(toolRoot);
  if (db === null) {
    return { available: false, total: 0, items: [], parsed: null };
  }

  try {
    const capabilities = probeCapabilities(db);
    const columns = imageColumnsFor(capabilities);

    // Dropdown selections are folded into the parsed query so there is exactly
    // one path from "what the user asked for" to SQL.
    const parsed = parseQuery(query);
    if (generator !== "" && !parsed.generators.includes(generator)) {
      parsed.generators.push(generator);
    }
    if (groupId !== "" && !parsed.groups.includes(groupId)) {
      parsed.groups.push(groupId);
    }
    if (sender !== "" && !parsed.senders.includes(sender)) {
      parsed.senders.push(sender);
    }

    const { where, args, freeText } = buildConditions(parsed, capabilities);
    const match = toMatchExpression(freeText);
    const ftsFilter = match === ""
      ? ""
      : "AND i.hash IN (SELECT hash FROM images_fts WHERE images_fts MATCH @ftsMatch)";
    const queryArgs = match === "" ? args : { ...args, ftsMatch: match };
    const ordering = `ORDER BY ${orderClause(sort, capabilities)}`;

    const rows = db.prepare(`
      SELECT ${columns} FROM images i
      WHERE 1 = 1 ${ftsFilter} ${where} ${ordering} LIMIT @limit OFFSET @offset
    `).all({ ...queryArgs, limit: clampLimit(limit), offset });

    const total = db.prepare(`
      SELECT COUNT(*) AS count FROM images i WHERE 1 = 1 ${ftsFilter} ${where}
    `).get(queryArgs).count;

    // Loaded once per request, not per row: this opens a second database.
    const ranges = loadCoverageRanges(toolRoot);
    return {
      available: true,
      total,
      items: rows.map((row) => decorateImage(db, row, capabilities, ranges)),
      parsed: { parts: parsed.parts, warnings: parsed.warnings },
    };
  } finally {
    db.close();
  }
};

// Same query as searchImages, but keeps the on-disk path on each item. For
// server-side consumers only (export); the HTTP layer must never hand these
// objects to the browser, which is why it is a separate function rather than a
// flag on searchImages.
//
// No small cap: exporting the whole library is a legitimate request. The bound is
// a sanity limit against a runaway query, not a product decision, and rows are
// read in batches so a large export does not hold everything at once.
const EXPORT_HARD_CAP = 100000;
const EXPORT_BATCH = 500;

const collectForExport = (toolRoot, options = {}) => {
  const db = openReadOnly(toolRoot);
  if (db === null) {
    return { available: false, items: [] };
  }
  try {
    const capabilities = probeCapabilities(db);
    const parsed = parseQuery(options.query ?? "");
    for (const [key, target] of [["generator", "generators"], ["groupId", "groups"], ["sender", "senders"]]) {
      const value = options[key] ?? "";
      if (value !== "" && !parsed[target].includes(value)) {
        parsed[target].push(value);
      }
    }

    const { where, args, freeText } = buildConditions(parsed, capabilities);
    const match = toMatchExpression(freeText);
    const ftsFilter = match === ""
      ? ""
      : "AND i.hash IN (SELECT hash FROM images_fts WHERE images_fts MATCH @ftsMatch)";

    // An explicit selection wins over the filters: the user ticked those exact
    // images, so nothing else should sneak in.
    const selected = Array.isArray(options.hashes)
      ? options.hashes.filter((hash) => /^[a-f0-9]{32}$/u.test(String(hash ?? "")))
      : null;
    const selectionFilter = selected !== null && selected.length > 0
      ? `AND i.hash IN (${selected.map((_, index) => `@h${index}`).join(", ")})`
      : "";
    const selectionArgs = {};
    if (selectionFilter !== "") {
      selected.forEach((hash, index) => {
        selectionArgs[`h${index}`] = hash;
      });
    }

    const queryArgs = {
      ...args,
      ...selectionArgs,
      ...(match === "" ? {} : { ftsMatch: match }),
    };
    const requested = Number.parseInt(options.limit ?? 0, 10);
    const cap = requested > 0 ? Math.min(requested, EXPORT_HARD_CAP) : EXPORT_HARD_CAP;

    const statement = db.prepare(`
      SELECT ${imageColumnsFor(capabilities)} FROM images i
      WHERE 1 = 1 ${ftsFilter} ${selectionFilter} ${where}
      ORDER BY ${orderClause(options.sort ?? "recent", capabilities)}
      LIMIT @limit OFFSET @offset
    `);

    const ranges = loadCoverageRanges(toolRoot);
    const items = [];
    // Batched so a whole-library export does not build one enormous result set
    // inside the driver before we can start writing files.
    for (let offset = 0; offset < cap; offset += EXPORT_BATCH) {
      const batch = statement.all({
        ...queryArgs,
        limit: Math.min(EXPORT_BATCH, cap - offset),
        offset,
      });
      if (batch.length === 0) {
        break;
      }
      for (const row of batch) {
        items.push({
          // full: a truncated prompt in an exported sidecar would be silent data loss.
          ...decorateImage(db, row, capabilities, ranges, { full: true }),
          filePath: row.file_missing !== 1 && row.file_path !== ""
            ? row.file_path
            : row.object_path,
        });
      }
    }
    return { available: true, items };
  } finally {
    db.close();
  }
};

// Answers "what am I missing?" for the knowledge base, the way the messages page
// answers it for chat history.
//
// Two axes, because they fail independently:
//   by month  where images exist but no summary run covered that time, so the
//             sender is unknown and CAN still be recovered by summarising it
//   by group  which groups contribute images, and which have media messages but
//             nothing attributed at all
//
// Also returns a watermark so the UI can show "new since you last looked"
// without a clock-skew problem: the number comes from the same database that
// stamped the rows.
const MAX_COVERAGE_MONTHS = 36;

const coverage = (toolRoot, { since = 0 } = {}) => {
  const db = openReadOnly(toolRoot);
  if (db === null) {
    return { available: false, months: [], groups: [], unattributedGroups: [] };
  }
  try {
    const capabilities = probeCapabilities(db);
    const ranges = loadCoverageRanges(toolRoot);

    const months = db.prepare(`
      SELECT strftime('%Y-%m', file_mtime, 'unixepoch') AS month,
             COUNT(*) AS images,
             SUM(CASE WHEN EXISTS (SELECT 1 FROM sightings s WHERE s.hash = i.hash) THEN 1 ELSE 0 END) AS attributed,
             SUM(CASE WHEN i.prompt <> '' THEN 1 ELSE 0 END) AS withPrompt,
             MIN(i.file_mtime) AS fromUnix,
             MAX(i.file_mtime) AS toUnix
      FROM images i
      WHERE i.generator <> @placeholder AND i.file_mtime > 0
      GROUP BY month ORDER BY month DESC LIMIT @limit
    `).all({ placeholder: PLACEHOLDER_GENERATOR, limit: MAX_COVERAGE_MONTHS });

    // A month counts as summarised if any scan range overlaps it at all; the
    // point is to distinguish "never looked" from "looked and it wasn't there".
    const decoratedMonths = months.map((row) => {
      const overlapping = ranges.filter((range) =>
        range.endUnix >= row.fromUnix && range.startUnix <= row.toUnix);
      return {
        ...row,
        summarised: overlapping.length > 0,
        unattributed: row.images - row.attributed,
      };
    });

    const groups = db.prepare(`
      SELECT group_id AS groupId, MAX(group_name) AS groupName,
             COUNT(DISTINCT hash) AS images,
             MIN(sent_at) AS firstSeen, MAX(sent_at) AS lastSeen
      FROM sightings GROUP BY group_id ORDER BY images DESC LIMIT 40
    `).all();

    // Groups whose messages we hold but which produced no knowledge at all.
    // Usually means their images arrive already compressed by QQ.
    const messagesPath = path.join(toolRoot, "store", "messages.db");
    const unattributedGroups = [];
    if (fs.existsSync(messagesPath)) {
      const messagesDb = new Database(messagesPath, { readonly: true, fileMustExist: true });
      try {
        const attributed = new Set(groups.map((row) => row.groupId));
        const candidates = messagesDb.prepare(`
          SELECT m.group_id AS groupId, COALESCE(g.name, m.group_id) AS groupName,
                 SUM(m.is_media) AS mediaMessages
          FROM messages m LEFT JOIN group_names g ON g.group_id = m.group_id
          GROUP BY m.group_id HAVING mediaMessages > 0
          ORDER BY mediaMessages DESC LIMIT 40
        `).all();
        for (const row of candidates) {
          if (!attributed.has(row.groupId)) {
            unattributedGroups.push(row);
          }
        }
      } catch {
        // A missing or older message store simply means no gap list.
      } finally {
        messagesDb.close();
      }
    }

    // "New since last visit" must use when the IMAGE arrived, not when it was
    // parsed: a rebuild stamps every row with the same parse time, which would
    // report the whole library as new. file_mtime is the cache arrival time.
    const watermark = db.prepare("SELECT MAX(file_mtime) AS latest FROM images").get().latest ?? 0;
    const newSince = since > 0
      ? db.prepare("SELECT COUNT(*) AS count FROM images WHERE file_mtime > ? AND generator <> ?")
        .get(since, PLACEHOLDER_GENERATOR).count
      : 0;

    const totals = db.prepare(`
      SELECT COUNT(*) AS images,
             SUM(CASE WHEN EXISTS (SELECT 1 FROM sightings s WHERE s.hash = i.hash) THEN 1 ELSE 0 END) AS attributed
      FROM images i WHERE i.generator <> @placeholder
    `).get({ placeholder: PLACEHOLDER_GENERATOR });

    return {
      available: true,
      months: decoratedMonths,
      groups,
      unattributedGroups,
      totals,
      watermark,
      newSince,
      hasPromptRequests: capabilities.promptRequests,
    };
  } finally {
    db.close();
  }
};

const imageByHash = (toolRoot, hash) => {
  if (!/^[a-f0-9]{32}$/u.test(String(hash ?? ""))) {
    return null;
  }
  const db = openReadOnly(toolRoot);
  if (db === null) {
    return null;
  }
  try {
    const capabilities = probeCapabilities(db);
    const row = db.prepare(`SELECT ${imageColumnsFor(capabilities)} FROM images i WHERE hash = ?`).get(hash);
    // full: the detail view is where the entire prompt is actually read.
    return row === undefined
      ? null
      : decorateImage(db, row, capabilities, loadCoverageRanges(toolRoot), { full: true });
  } finally {
    db.close();
  }
};

// Resolves a hash to its on-disk cache path so the server can stream the file.
// Returns null when the row is unknown or the original is gone; the caller must
// not fall back to guessing a path.
const imageFilePath = (toolRoot, hash) => {
  if (!/^[a-f0-9]{32}$/u.test(String(hash ?? ""))) {
    return null;
  }
  const db = openReadOnly(toolRoot);
  if (db === null) {
    return null;
  }
  try {
    const capabilities = probeCapabilities(db);
    const row = db.prepare(`
      SELECT file_path,
             ${capabilities.fileMissing ? "file_missing" : "0 AS file_missing"},
             ${capabilities.objectPath ? "object_path" : "'' AS object_path"}
      FROM images WHERE hash = ?
    `).get(hash);
    if (row === undefined) {
      return null;
    }
    if (row.file_missing !== 1 && row.file_path !== "") {
      if (fs.existsSync(row.file_path) || row.object_path === "") {
        return row.file_path;
      }
    }
    return row.object_path !== "" && fs.existsSync(row.object_path) ? row.object_path : null;
  } finally {
    db.close();
  }
};

// Grid cards must NOT be served the original: measured on real data, 60
// full-resolution cards cost 127 MB of transfer and ~850 MB of decoded bitmap
// (width*height*4), which is what made the page lag.
//
// QQ already keeps its own reduced copies beside each original, in a sibling
// Thumb directory, named <md5>_<variant>. The smallest variant is ~8x smaller
// than the original, so the grid uses it and the detail view keeps the original.
// Returns null when no thumbnail exists, letting the caller fall back.
const thumbnailFilePath = (toolRoot, hash) => {
  const original = imageFilePath(toolRoot, hash);
  if (original === null) {
    return null;
  }
  const objectRootCheck = path.relative(path.resolve(mediaObjectDir(toolRoot)), path.resolve(original));
  if (!objectRootCheck.startsWith("..") && !path.isAbsolute(objectRootCheck)) {
    return null;
  }
  const thumbDir = path.join(path.dirname(path.dirname(original)), "Thumb");
  let names;
  try {
    names = fs.readdirSync(thumbDir);
  } catch {
    return null;
  }

  const candidates = [];
  for (const name of names) {
    if (!name.toLowerCase().startsWith(hash)) {
      continue;
    }
    const full = path.join(thumbDir, name);
    try {
      const stat = fs.statSync(full);
      if (stat.isFile() && stat.size > 0) {
        candidates.push({ full, size: stat.size });
      }
    } catch {
      // A file that vanished between listing and stat is simply not a candidate.
    }
  }
  if (candidates.length === 0) {
    return null;
  }
  // Smallest wins: the grid only needs enough pixels for a 132-320px card.
  candidates.sort((left, right) => left.size - right.size);
  return candidates[0].full;
};

const promptRequests = (toolRoot, { onlyAnswered = false, limit } = {}) => {
  const db = openReadOnly(toolRoot);
  if (db === null) {
    return { available: false, items: [] };
  }
  try {
    const capabilities = probeCapabilities(db);
    if (!capabilities.promptRequests) {
      // Store predates prompt-request tracking; a harvest will create it.
      return { available: true, items: [], needsHarvest: true };
    }
    const answerMediaAvailability = db.prepare(`
      SELECT CASE WHEN ${availableFileCondition(capabilities, "")} THEN 1 ELSE 0 END AS hasFile
      FROM images WHERE hash = ?
    `);
    const rows = db.prepare(`
      SELECT r.group_id AS groupId, r.group_name AS groupName, r.intent, r.rule,
             r.asker, r.ask_text AS askText, r.ask_sent_at AS askSentAt,
             r.image_hash AS imageHash, r.image_owner AS imageOwner,
             ${capabilities.confidence ? "r.confidence" : "'' AS confidence"},
             r.target_via AS targetVia,
             r.answer_by AS answerBy, r.answer_text AS answerText,
             ${answerKindExpression(capabilities, "r.")} AS answerKind,
             ${answerMediaExpression(capabilities, "r.")} AS answerMediaJson,
             r.answer_sent_at AS answerSentAt,
             i.generator AS imageGenerator,
             CASE WHEN i.hash IS NULL THEN 0 ELSE 1 END AS imageKnown,
             CASE WHEN ${availableFileCondition(capabilities, "i.")} THEN 1 ELSE 0 END AS imageHasFile,
             CASE WHEN ${capabilities.fileMissing ? "COALESCE(i.file_missing, 0)" : "0"} = 1
                       AND ${capabilities.objectPath ? "COALESCE(i.object_path, '') = ''" : "1 = 1"}
                  THEN 1 ELSE 0 END AS imageFileMissing
      FROM prompt_requests r
      LEFT JOIN images i ON i.hash = r.image_hash
      ${onlyAnswered ? `WHERE ${answeredRequestCondition(capabilities, "r.")}` : ""}
      ORDER BY r.ask_sent_at DESC
      LIMIT @limit
    `).all({ limit: clampLimit(limit) })
      .map((row) => decorateRequestAnswer(row, answerMediaAvailability));
    return { available: true, items: rows };
  } finally {
    db.close();
  }
};

// Facets for the filter controls, plus the honest counters the UI shows so the
// gaps (stripped metadata, evicted files) are visible rather than implied.
const overview = (toolRoot) => {
  const db = openReadOnly(toolRoot);
  if (db === null) {
    return { available: false };
  }
  try {
    const capabilities = probeCapabilities(db);
    const counts = db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM images WHERE generator <> @placeholder) AS images,
        (SELECT COUNT(*) FROM images WHERE generator = @placeholder) AS placeholders,
        (SELECT COUNT(*) FROM images WHERE prompt <> '') AS withPrompt,
        ${capabilities.fileMissing
          ? `(SELECT COUNT(*) FROM images WHERE file_missing = 1${capabilities.objectPath ? " AND object_path = ''" : ""}) AS fileMissing,`
          : "0 AS fileMissing,"}
        (SELECT COUNT(DISTINCT hash) FROM sightings) AS attributed,
        (SELECT COUNT(DISTINCT lora_name) FROM image_loras) AS loras,
        (SELECT COUNT(DISTINCT tag) FROM image_tags) AS tags,
        ${capabilities.promptRequests
          ? `(SELECT COUNT(*) FROM prompt_requests) AS promptRequests,
             (SELECT COUNT(*) FROM prompt_requests WHERE ${answeredRequestCondition(capabilities, "")}) AS answeredRequests`
          : "0 AS promptRequests, 0 AS answeredRequests"}
    `).get({ placeholder: PLACEHOLDER_GENERATOR });

    const generators = db.prepare(`
      SELECT generator, COUNT(*) AS count FROM images
      WHERE generator <> @placeholder GROUP BY generator ORDER BY count DESC
    `).all({ placeholder: PLACEHOLDER_GENERATOR });

    const groups = db.prepare(`
      SELECT group_id AS groupId, MAX(group_name) AS groupName, COUNT(DISTINCT hash) AS images
      FROM sightings GROUP BY group_id ORDER BY images DESC LIMIT 30
    `).all();

    // Who posted the images we can attribute. Only meaningful for the ~few
    // percent with a sighting, so the UI labels it as such.
    const senders = db.prepare(`
      SELECT speaker, COUNT(DISTINCT hash) AS images
      FROM sightings WHERE speaker <> '' GROUP BY speaker ORDER BY images DESC LIMIT 40
    `).all();

    const topCheckpoints = db.prepare(`
      SELECT checkpoint, COUNT(*) AS count FROM images
      WHERE checkpoint <> '' GROUP BY checkpoint ORDER BY count DESC LIMIT 20
    `).all();

    const topLoras = db.prepare(`
      SELECT lora_name AS name, COUNT(*) AS count FROM image_loras
      GROUP BY lora_name ORDER BY count DESC LIMIT 20
    `).all();

    const topTags = db.prepare(`
      SELECT tag, COUNT(*) AS count FROM image_tags
      GROUP BY tag ORDER BY count DESC LIMIT 40
    `).all();

    // Aggregate reasons, so the page can explain the shape of the library
    // instead of leaving the user to infer it from individual cards.
    const ranges = loadCoverageRanges(toolRoot);
    const reasonRows = db.prepare(`
      SELECT i.file_mtime, i.file_path,
             ${capabilities.fileMissing ? "i.file_missing" : "0 AS file_missing"},
             ${capabilities.objectPath ? "i.object_path" : "'' AS object_path"},
             EXISTS (SELECT 1 FROM sightings s WHERE s.hash = i.hash) AS has_sighting
      FROM images i WHERE i.generator <> @placeholder
    `).all({ placeholder: PLACEHOLDER_GENERATOR });

    const reasons = { attributed: 0, evicted: 0, unavailable: 0, "outside-coverage": 0, "not-in-messages": 0 };
    for (const row of reasonRows) {
      const reason = attributionReason(row, ranges, row.has_sighting === 1);
      reasons[reason] = (reasons[reason] ?? 0) + 1;
    }

    // The window that could have produced attribution at all.
    const coverage = ranges.length === 0
      ? null
      : {
        fromUnix: Math.min(...ranges.map((range) => range.startUnix)),
        toUnix: Math.max(...ranges.map((range) => range.endUnix)),
        rangeCount: ranges.length,
      };

    return { available: true, counts, generators, groups, senders, topCheckpoints, topLoras, topTags, reasons, coverage };
  } finally {
    db.close();
  }
};

module.exports = {
  knowledgeDbPath,
  searchImages,
  collectForExport,
  imageByHash,
  imageFilePath,
  thumbnailFilePath,
  promptRequests,
  overview,
  coverage,
  toMatchExpression,
};
