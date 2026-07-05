const fs = require("node:fs");
const path = require("node:path");
const Database = require("better-sqlite3-multiple-ciphers");

const DAY_SECONDS = 24 * 60 * 60;

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS messages (
    group_id TEXT NOT NULL,
    row_id TEXT NOT NULL,
    sent_at INTEGER NOT NULL,
    speaker TEXT NOT NULL DEFAULT '',
    text TEXT NOT NULL DEFAULT '',
    is_media INTEGER NOT NULL DEFAULT 0,
    media_kinds TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (group_id, row_id)
  )`,
  "CREATE INDEX IF NOT EXISTS idx_messages_group_time ON messages(group_id, sent_at, row_id)",
  `CREATE TABLE IF NOT EXISTS scan_ranges (
    group_id TEXT NOT NULL,
    start_unix INTEGER NOT NULL,
    end_unix INTEGER NOT NULL,
    run_id TEXT NOT NULL DEFAULT ''
  )`,
  "CREATE INDEX IF NOT EXISTS idx_scan_ranges_group ON scan_ranges(group_id, start_unix)",
  `CREATE TABLE IF NOT EXISTS read_marks (
    group_id TEXT PRIMARY KEY,
    sent_at INTEGER NOT NULL,
    row_id TEXT NOT NULL DEFAULT '',
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS group_names (
    group_id TEXT PRIMARY KEY,
    name TEXT NOT NULL DEFAULT ''
  )`,
];

const openStore = (storePath) => {
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  const db = new Database(storePath);
  db.pragma("journal_mode = WAL");
  for (const statement of SCHEMA_STATEMENTS) {
    db.prepare(statement).run();
  }
  const columns = db.prepare("PRAGMA table_info(messages)").all().map((column) => column.name);
  if (!columns.includes("speaker_uin")) {
    db.prepare("ALTER TABLE messages ADD COLUMN speaker_uin TEXT NOT NULL DEFAULT ''").run();
  }
  return db;
};

const getSpeaker = (message) =>
  message.senderName || message.memberName || String(message.senderUin ?? "") || "Unknown";

// Body snippets come from raw protobuf bytes: mojibake soup with the odd real caption.
// Keep only segments that random bytes almost never produce (Han runs, real words, numbers);
// if too little survives, treat the whole snippet as noise.
// Regular text messages are real text, but @-mentions leave stray replacement chars behind.
const lightCleanText = (raw) =>
  String(raw ?? "")
    .replace(/[\u{FFFD}\u{0000}-\u{0008}\u{000B}-\u{001F}\u{007F}]/gu, "")
    .replace(/ {2,}/gu, " ")
    .trim();

const looksLikeWord = (token) => {
  if (!/^[A-Za-z'-]+$/u.test(token)) {
    return true;
  }
  if (token.length > 14 || !/[aeiou]/iu.test(token)) {
    return false;
  }
  let caseSwitches = 0;
  for (let index = 1; index < token.length; index += 1) {
    if (/[A-Z]/u.test(token[index - 1]) !== /[A-Z]/u.test(token[index])) {
      caseSwitches += 1;
    }
  }
  return caseSwitches <= 2;
};

const sanitizeSnippet = (raw) => {
  const stripped = String(raw ?? "").replace(/[\u{FFFD}\u{0000}-\u{001F}\u{007F}-\u{00A0}]/gu, " ");
  const segments = (stripped.match(/[一-鿿]{2,}[，。！？、：；]?|[A-Za-z][A-Za-z'-]{2,}|\d{2,}/gu) ?? []).filter(looksLikeWord);
  const text = segments.join(" ").trim().slice(0, 120);
  return text.length >= 4 ? text : "";
};

const mediaText = (message) => {
  const kinds = [...new Set((message.mediaRefs ?? []).map((ref) => ref.kind))].join(",");
  const fileName = (message.mediaRefs ?? []).map((ref) => ref.fileName).find((name) => typeof name === "string" && name.length > 0);
  const snippet = sanitizeSnippet(message.bodySnippet);
  const text = snippet.length >= 2 ? snippet : fileName ?? "";
  return { kinds, text };
};

const ingestExport = (db, exportData, runId, retentionDays) => {
  const insertMessage = db.prepare(`
    INSERT OR IGNORE INTO messages (group_id, row_id, sent_at, speaker, text, is_media, media_kinds, speaker_uin)
    VALUES (@groupId, @rowId, @sentAt, @speaker, @text, @isMedia, @mediaKinds, @speakerUin)
  `);
  const insertRange = db.prepare(
    "INSERT INTO scan_ranges (group_id, start_unix, end_unix, run_id) VALUES (?, ?, ?, ?)",
  );
  const upsertName = db.prepare(
    "INSERT INTO group_names (group_id, name) VALUES (?, ?) ON CONFLICT(group_id) DO UPDATE SET name = excluded.name WHERE excluded.name <> ''",
  );

  let inserted = 0;
  const ingestAll = db.transaction(() => {
    for (const message of exportData.messages ?? []) {
      const text = lightCleanText(message.text);
      if (text.length === 0) {
        continue;
      }
      inserted += insertMessage.run({
        groupId: String(message.groupId),
        rowId: String(message.rowId),
        sentAt: message.sentAt,
        speaker: getSpeaker(message),
        text,
        isMedia: 0,
        mediaKinds: "",
        speakerUin: String(message.senderUin ?? ""),
      }).changes;
    }

    for (const message of exportData.mediaMessages ?? []) {
      const media = mediaText(message);
      inserted += insertMessage.run({
        groupId: String(message.groupId),
        rowId: `m${message.rowId}`,
        sentAt: message.sentAt,
        speaker: getSpeaker(message),
        text: media.text,
        isMedia: 1,
        mediaKinds: media.kinds,
        speakerUin: String(message.senderUin ?? ""),
      }).changes;
    }

    for (const groupId of exportData.groupIds ?? []) {
      insertRange.run(String(groupId), exportData.startUnix, exportData.endUnix, runId ?? "");
      upsertName.run(String(groupId), exportData.groupNames?.[groupId] ?? "");
    }
  });
  ingestAll();

  const pruned = pruneStore(db, retentionDays);
  return { inserted, ...pruned };
};

const pruneStore = (db, retentionDays) => {
  const days = Number.isFinite(retentionDays) && retentionDays > 0 ? retentionDays : 3;
  const cutoff = Math.floor(Date.now() / 1000) - days * DAY_SECONDS;
  const prunedMessages = db.prepare("DELETE FROM messages WHERE sent_at < ?").run(cutoff).changes;
  const prunedRanges = db.prepare("DELETE FROM scan_ranges WHERE end_unix < ?").run(cutoff).changes;
  return { prunedMessages, prunedRanges, cutoff };
};

const queryMessages = (db, { groupId, fromUnix, toUnix, afterSentAt, afterRowId, limit, search }) => {
  const conditions = ["group_id = @groupId"];
  const params = { groupId: String(groupId) };

  if (Number.isFinite(fromUnix)) {
    conditions.push("sent_at >= @fromUnix");
    params.fromUnix = fromUnix;
  }
  if (Number.isFinite(toUnix)) {
    conditions.push("sent_at < @toUnix");
    params.toUnix = toUnix;
  }
  if (Number.isFinite(afterSentAt) && typeof afterRowId === "string" && afterRowId.length > 0) {
    conditions.push("(sent_at > @afterSentAt OR (sent_at = @afterSentAt AND row_id > @afterRowId))");
    params.afterSentAt = afterSentAt;
    params.afterRowId = afterRowId;
  }
  if (typeof search === "string" && search.trim().length > 0) {
    conditions.push("(text LIKE @search OR speaker LIKE @search)");
    params.search = `%${search.trim().replaceAll("%", "").replaceAll("_", "")}%`;
  }

  const safeLimit = Number.isInteger(limit) && limit > 0 && limit <= 500 ? limit : 300;
  const rows = db
    .prepare(`
      SELECT group_id AS groupId, row_id AS rowId, sent_at AS sentAt, speaker, text, is_media AS isMedia, media_kinds AS mediaKinds, speaker_uin AS speakerUin
      FROM messages
      WHERE ${conditions.join(" AND ")}
      ORDER BY sent_at ASC, row_id ASC
      LIMIT ${safeLimit + 1}
    `)
    .all(params);

  const hasMore = rows.length > safeLimit;
  return { messages: rows.slice(0, safeLimit), hasMore };
};

const getCoverage = (db, groupId) => {
  const rows = db
    .prepare("SELECT start_unix AS startUnix, end_unix AS endUnix FROM scan_ranges WHERE group_id = ? ORDER BY start_unix")
    .all(String(groupId));

  const merged = [];
  for (const row of rows) {
    const last = merged.at(-1);
    if (last !== undefined && row.startUnix <= last.endUnix) {
      last.endUnix = Math.max(last.endUnix, row.endUnix);
    } else {
      merged.push({ startUnix: row.startUnix, endUnix: row.endUnix });
    }
  }
  return merged;
};

const getStoredGroups = (db) =>
  db
    .prepare(`
      SELECT m.group_id AS groupId,
             COALESCE(n.name, '') AS name,
             COUNT(*) AS messageCount,
             MIN(m.sent_at) AS firstUnix,
             MAX(m.sent_at) AS lastUnix
      FROM messages m
      LEFT JOIN group_names n ON n.group_id = m.group_id
      GROUP BY m.group_id
      ORDER BY lastUnix DESC
    `)
    .all();

// One row per group with everything the QQ-style inbox list needs.
const getGroupSummaries = (db) =>
  db
    .prepare(`
      SELECT m.group_id AS groupId,
             COALESCE(n.name, '') AS name,
             COUNT(*) AS messageCount,
             MIN(m.sent_at) AS firstUnix,
             MAX(m.sent_at) AS lastUnix,
             SUM(CASE WHEN m.sent_at > COALESCE(r.sent_at, 0)
                        OR (m.sent_at = COALESCE(r.sent_at, 0) AND m.row_id > COALESCE(r.row_id, ''))
                      THEN 1 ELSE 0 END) AS unreadCount,
             (SELECT MAX(end_unix) FROM scan_ranges s WHERE s.group_id = m.group_id) AS coverageEnd
      FROM messages m
      LEFT JOIN group_names n ON n.group_id = m.group_id
      LEFT JOIN read_marks r ON r.group_id = m.group_id
      GROUP BY m.group_id
      ORDER BY lastUnix DESC
    `)
    .all()
    .map((group) => ({
      ...group,
      lastMessage:
        db
          .prepare(
            "SELECT sent_at AS sentAt, speaker, text, is_media AS isMedia, media_kinds AS mediaKinds FROM messages WHERE group_id = ? ORDER BY sent_at DESC, row_id DESC LIMIT 1",
          )
          .get(group.groupId) ?? null,
    }));

const getReadMark = (db, groupId) =>
  db
    .prepare("SELECT sent_at AS sentAt, row_id AS rowId, updated_at AS updatedAt FROM read_marks WHERE group_id = ?")
    .get(String(groupId)) ?? null;

const setReadMark = (db, groupId, sentAt, rowId) => {
  // Advance-only: a partially loaded or filtered view must never drag the marker backward.
  db.prepare(`
    INSERT INTO read_marks (group_id, sent_at, row_id, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(group_id) DO UPDATE
      SET sent_at = excluded.sent_at, row_id = excluded.row_id, updated_at = excluded.updated_at
      WHERE excluded.sent_at > read_marks.sent_at
  `).run(String(groupId), sentAt, rowId ?? "", Math.floor(Date.now() / 1000));
};

const getLatestMessage = (db, groupId) =>
  db
    .prepare("SELECT sent_at AS sentAt, row_id AS rowId FROM messages WHERE group_id = ? ORDER BY sent_at DESC, row_id DESC LIMIT 1")
    .get(String(groupId)) ?? null;

module.exports = {
  openStore,
  sanitizeSnippet,
  lightCleanText,
  ingestExport,
  pruneStore,
  queryMessages,
  getCoverage,
  getStoredGroups,
  getGroupSummaries,
  getReadMark,
  setReadMark,
  getLatestMessage,
};
