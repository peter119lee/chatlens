const fs = require("node:fs");
const path = require("node:path");
const Database = require("better-sqlite3-multiple-ciphers");

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

const ingestExport = (db, exportData, runId) => {
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

    // Honest coverage: exports that stopped early (row budget hit / corrupt
    // copy) carry coveredFromUnix — only the actually-scanned span becomes
    // coverage, so the missing part can still be re-fetched later. Legacy
    // exports without the field keep the old whole-window behavior.
    const hasCoveredField = Object.prototype.hasOwnProperty.call(exportData, "coveredFromUnix");
    const coveredFrom = hasCoveredField ? exportData.coveredFromUnix : exportData.startUnix;
    for (const groupId of exportData.groupIds ?? []) {
      if (Number.isFinite(coveredFrom) && Number.isFinite(exportData.endUnix) && coveredFrom < exportData.endUnix) {
        insertRange.run(String(groupId), coveredFrom, exportData.endUnix, runId ?? "");
      }
      upsertName.run(String(groupId), exportData.groupNames?.[groupId] ?? "");
    }
  });
  ingestAll();
  return { inserted };
};

const queryMessages = (db, { groupId, fromUnix, toUnix, afterSentAt, afterRowId, beforeSentAt, beforeRowId, limit, search }) => {
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
  const pagingBackward = Number.isFinite(beforeSentAt) && typeof beforeRowId === "string" && beforeRowId.length > 0;
  if (pagingBackward) {
    // Backward (older) keyset page for the chat's scroll-up loader.
    conditions.push("(sent_at < @beforeSentAt OR (sent_at = @beforeSentAt AND row_id < @beforeRowId))");
    params.beforeSentAt = beforeSentAt;
    params.beforeRowId = beforeRowId;
  } else if (Number.isFinite(afterSentAt) && typeof afterRowId === "string" && afterRowId.length > 0) {
    conditions.push("(sent_at > @afterSentAt OR (sent_at = @afterSentAt AND row_id > @afterRowId))");
    params.afterSentAt = afterSentAt;
    params.afterRowId = afterRowId;
  }
  if (typeof search === "string" && search.trim().length > 0) {
    conditions.push("(text LIKE @search OR speaker LIKE @search)");
    params.search = `%${search.trim().replaceAll("%", "").replaceAll("_", "")}%`;
  }

  const safeLimit = Number.isInteger(limit) && limit > 0 && limit <= 500 ? limit : 300;
  const order = pagingBackward ? "DESC" : "ASC";
  const rows = db
    .prepare(`
      SELECT group_id AS groupId, row_id AS rowId, sent_at AS sentAt, speaker, text, is_media AS isMedia, media_kinds AS mediaKinds, speaker_uin AS speakerUin
      FROM messages
      WHERE ${conditions.join(" AND ")}
      ORDER BY sent_at ${order}, row_id ${order}
      LIMIT ${safeLimit + 1}
    `)
    .all(params);

  // hasMore refers to the paged direction (more OLDER rows when paging
  // backward); backward pages return re-sorted ascending for rendering.
  const hasMore = rows.length > safeLimit;
  const page = rows.slice(0, safeLimit);
  if (pagingBackward) {
    page.reverse();
  }
  return { messages: page, hasMore };
};

// Per-group latest coverage end straight from scan_ranges — unlike
// getGroupSummaries this also covers groups whose messages were all pruned,
// so "自上次记录" never silently skips their gap.
const getCoverageEnds = (db) =>
  Object.fromEntries(
    db
      .prepare("SELECT group_id AS groupId, MAX(end_unix) AS coverageEnd FROM scan_ranges GROUP BY group_id")
      .all()
      .map((row) => [row.groupId, row.coverageEnd]),
  );

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

const coverageGaps = (coverage, fromUnix, toUnix) => {
  const gaps = [];
  let cursor = fromUnix;
  for (const range of coverage) {
    const startUnix = Math.max(fromUnix, range.startUnix);
    const endUnix = Math.min(toUnix, range.endUnix);
    if (endUnix <= fromUnix || startUnix >= toUnix) {
      continue;
    }
    if (startUnix > cursor) {
      gaps.push({ startUnix: cursor, endUnix: startUnix });
    }
    cursor = Math.max(cursor, endUnix);
  }
  if (cursor < toUnix) {
    gaps.push({ startUnix: cursor, endUnix: toUnix });
  }
  return gaps;
};

const rescanBatches = (gaps) => {
  const grouped = new Map();
  for (const gap of gaps) {
    const key = `${gap.startUnix}:${gap.endUnix}`;
    const groupIds = grouped.get(key) ?? [];
    grouped.set(key, [...groupIds, gap.groupId]);
  }
  return [...grouped.entries()]
    .map(([key, groupIds]) => {
      const [startUnix, endUnix] = key.split(":").map(Number);
      return { groupIds: [...groupIds].sort(), startUnix, endUnix };
    })
    .sort((left, right) => left.startUnix - right.startUnix || left.endUnix - right.endUnix);
};

const getCoverageHealth = (db, groupIds, fromUnix, toUnix) => {
  const normalizedGroupIds = [...new Set(groupIds.map(String))];
  if (normalizedGroupIds.length === 0) {
    throw new Error("At least one group id is required to calculate coverage health");
  }
  if (!Number.isFinite(fromUnix) || !Number.isFinite(toUnix) || fromUnix >= toUnix) {
    throw new Error(`Invalid coverage health range: ${fromUnix}-${toUnix}`);
  }

  const gaps = normalizedGroupIds.flatMap((groupId) =>
    coverageGaps(getCoverage(db, groupId), fromUnix, toUnix)
      .map((gap) => ({ groupId, ...gap })));
  const totalSeconds = (toUnix - fromUnix) * normalizedGroupIds.length;
  const missingSeconds = gaps.reduce((total, gap) => total + gap.endUnix - gap.startUnix, 0);
  const affectedGroupCount = new Set(gaps.map((gap) => gap.groupId)).size;

  return {
    fromUnix,
    toUnix,
    groupCount: normalizedGroupIds.length,
    totalSeconds,
    coveredSeconds: totalSeconds - missingSeconds,
    missingSeconds,
    coverageRatio: (totalSeconds - missingSeconds) / totalSeconds,
    affectedGroupCount,
    earliestGapUnix: gaps.length > 0 ? Math.min(...gaps.map((gap) => gap.startUnix)) : null,
    gaps,
    batches: rescanBatches(gaps),
  };
};

const getRangeActivity = (db, groupIds, fromUnix, toUnix) => {
  const normalizedGroupIds = [...new Set(groupIds.map(String))];
  if (normalizedGroupIds.length === 0) {
    throw new Error("At least one group id is required to calculate range activity");
  }
  if (!Number.isFinite(fromUnix) || !Number.isFinite(toUnix) || fromUnix >= toUnix) {
    throw new Error(`Invalid range activity window: ${fromUnix}-${toUnix}`);
  }
  const groupParams = Object.fromEntries(normalizedGroupIds.map((groupId, index) => [`group${index}`, groupId]));
  const placeholders = normalizedGroupIds.map((_, index) => `@group${index}`).join(", ");
  const rows = db.prepare(`
    SELECT group_id AS groupId,
           COUNT(*) AS messageCount,
           SUM(CASE WHEN is_media = 1 THEN 1 ELSE 0 END) AS mediaMessageCount
    FROM messages
    WHERE group_id IN (${placeholders})
      AND sent_at >= @fromUnix
      AND sent_at < @toUnix
    GROUP BY group_id
  `).all({ ...groupParams, fromUnix, toUnix });
  const activityByGroup = new Map(rows.map((row) => [row.groupId, row]));
  const durationSeconds = toUnix - fromUnix;
  return normalizedGroupIds.map((groupId) => {
    const coveredSeconds = getCoverage(db, groupId).reduce(
      (total, range) => total + overlapSeconds(range.startUnix, range.endUnix, fromUnix, toUnix),
      0,
    );
    const activity = activityByGroup.get(groupId);
    return {
      groupId,
      messageCount: activity?.messageCount ?? 0,
      mediaMessageCount: activity?.mediaMessageCount ?? 0,
      coveredSeconds,
      coverageRatio: coveredSeconds / durationSeconds,
    };
  });
};

const getEventActivity = (db, events) => {
  if (!Array.isArray(events) || events.length === 0 || events.length > 400) {
    throw new Error("Event activity requires 1-400 events");
  }
  const query = db.prepare(`
    SELECT COUNT(*) AS messageCount,
           SUM(CASE WHEN is_media = 1 THEN 1 ELSE 0 END) AS mediaMessageCount,
           COUNT(DISTINCT speaker) AS speakerCount,
           MIN(sent_at) AS firstMessageUnix,
           MAX(sent_at) AS lastMessageUnix
    FROM messages
    WHERE group_id = @groupId
      AND sent_at >= @fromUnix
      AND sent_at < @toUnix
  `);
  return events.map((event) => {
    const id = String(event.id ?? "");
    const groupId = String(event.groupId ?? "");
    const fromUnix = Number(event.fromUnix);
    const toUnix = Number(event.toUnix);
    if (id.length === 0 || !/^\d+$/u.test(groupId) || !Number.isFinite(fromUnix) || !Number.isFinite(toUnix) || fromUnix >= toUnix) {
      throw new Error(`Invalid gallery event activity request: ${id}/${groupId}/${fromUnix}-${toUnix}`);
    }
    const activity = query.get({ groupId, fromUnix, toUnix });
    const durationSeconds = toUnix - fromUnix;
    const coveredSeconds = getCoverage(db, groupId).reduce(
      (total, range) => total + overlapSeconds(range.startUnix, range.endUnix, fromUnix, toUnix),
      0,
    );
    return {
      id,
      messageCount: activity.messageCount,
      mediaMessageCount: activity.mediaMessageCount ?? 0,
      speakerCount: activity.speakerCount,
      firstMessageUnix: activity.firstMessageUnix ?? null,
      lastMessageUnix: activity.lastMessageUnix ?? null,
      coverageRatio: coveredSeconds / durationSeconds,
      missingSeconds: durationSeconds - coveredSeconds,
    };
  });
};

const overlapSeconds = (leftStart, leftEnd, rightStart, rightEnd) =>
  Math.max(0, Math.min(leftEnd, rightEnd) - Math.max(leftStart, rightStart));

const getCoverageTimeline = (db, groupIds, fromUnix, toUnix, slotSeconds) => {
  const normalizedGroupIds = [...new Set(groupIds.map(String))];
  if (normalizedGroupIds.length === 0) {
    return [];
  }

  const slotCount = Math.ceil((toUnix - fromUnix) / slotSeconds);
  const slotBounds = Array.from({ length: slotCount }, (_, index) => ({
    index,
    startUnix: fromUnix + index * slotSeconds,
    endUnix: Math.min(toUnix, fromUnix + (index + 1) * slotSeconds),
  }));
  const groupParams = Object.fromEntries(normalizedGroupIds.map((groupId, index) => [`group${index}`, groupId]));
  const placeholders = normalizedGroupIds.map((_, index) => `@group${index}`).join(", ");
  const queryParams = { fromUnix, toUnix, slotSeconds, ...groupParams };
  const names = new Map(
    db
      .prepare(`SELECT group_id AS groupId, name FROM group_names WHERE group_id IN (${placeholders})`)
      .all(groupParams)
      .map((row) => [row.groupId, row.name]),
  );
  const activityRows = db
    .prepare(`
      WITH slotted AS (
        SELECT group_id AS groupId,
               CAST((sent_at - @fromUnix) / @slotSeconds AS INTEGER) AS slotIndex,
               sent_at AS sentAt,
               speaker,
               is_media AS isMedia
        FROM messages
        WHERE group_id IN (${placeholders})
          AND sent_at >= @fromUnix
          AND sent_at < @toUnix
      )
      SELECT groupId,
             slotIndex,
             COUNT(*) AS messageCount,
             SUM(CASE WHEN isMedia = 0 THEN 1 ELSE 0 END) AS textCount,
             SUM(CASE WHEN isMedia = 1 THEN 1 ELSE 0 END) AS mediaCount,
             COUNT(DISTINCT speaker) AS speakerCount,
             MIN(sentAt) AS firstMessageUnix,
             MAX(sentAt) AS lastMessageUnix
      FROM slotted
      GROUP BY groupId, slotIndex
    `)
    .all(queryParams);
  const activityBySlot = new Map(activityRows.map((row) => [`${row.groupId}:${row.slotIndex}`, row]));
  const topSpeakerRows = db
    .prepare(`
      WITH speaker_counts AS (
        SELECT group_id AS groupId,
               CAST((sent_at - @fromUnix) / @slotSeconds AS INTEGER) AS slotIndex,
               speaker,
               COUNT(*) AS messageCount
        FROM messages
        WHERE group_id IN (${placeholders})
          AND sent_at >= @fromUnix
          AND sent_at < @toUnix
        GROUP BY groupId, slotIndex, speaker
      ), ranked AS (
        SELECT *, ROW_NUMBER() OVER (
          PARTITION BY groupId, slotIndex
          ORDER BY messageCount DESC, speaker ASC
        ) AS speakerRank
        FROM speaker_counts
      )
      SELECT groupId, slotIndex, speaker, messageCount
      FROM ranked
      WHERE speakerRank <= 3
      ORDER BY groupId, slotIndex, speakerRank
    `)
    .all(queryParams);
  const topSpeakersBySlot = new Map();
  for (const row of topSpeakerRows) {
    const key = `${row.groupId}:${row.slotIndex}`;
    const speakers = topSpeakersBySlot.get(key) ?? [];
    topSpeakersBySlot.set(key, [...speakers, { speaker: row.speaker, messageCount: row.messageCount }]);
  }
  const busiestHourRows = db
    .prepare(`
      WITH hour_counts AS (
        SELECT group_id AS groupId,
               CAST((sent_at - @fromUnix) / @slotSeconds AS INTEGER) AS slotIndex,
               CAST((sent_at - @fromUnix) / 3600 AS INTEGER) AS hourIndex,
               COUNT(*) AS messageCount
        FROM messages
        WHERE group_id IN (${placeholders})
          AND sent_at >= @fromUnix
          AND sent_at < @toUnix
        GROUP BY groupId, slotIndex, hourIndex
      ), ranked AS (
        SELECT *, ROW_NUMBER() OVER (
          PARTITION BY groupId, slotIndex
          ORDER BY messageCount DESC, hourIndex ASC
        ) AS hourRank
        FROM hour_counts
      )
      SELECT groupId, slotIndex, hourIndex, messageCount
      FROM ranked
      WHERE hourRank = 1
    `)
    .all(queryParams);
  const busiestHourBySlot = new Map(busiestHourRows.map((row) => [`${row.groupId}:${row.slotIndex}`, row]));

  return normalizedGroupIds.map((groupId) => {
    const coverage = getCoverage(db, groupId);
    const slots = slotBounds.map((slot) => {
      const durationSeconds = slot.endUnix - slot.startUnix;
      const coveredSeconds = coverage.reduce(
        (total, range) => total + overlapSeconds(range.startUnix, range.endUnix, slot.startUnix, slot.endUnix),
        0,
      );
      const coveredSegments = coverage
        .map((range) => ({
          startUnix: Math.max(range.startUnix, slot.startUnix),
          endUnix: Math.min(range.endUnix, slot.endUnix),
        }))
        .filter((range) => range.startUnix < range.endUnix);
      const key = `${groupId}:${slot.index}`;
      const activity = activityBySlot.get(key);
      const busiestHour = busiestHourBySlot.get(key);
      return {
        ...slot,
        coveredSeconds,
        coverageRatio: durationSeconds > 0 ? coveredSeconds / durationSeconds : 0,
        coverageStartUnix: coveredSegments[0]?.startUnix ?? null,
        coverageEndUnix: coveredSegments.at(-1)?.endUnix ?? null,
        coverageSegmentCount: coveredSegments.length,
        coverageSegments: coveredSegments,
        messageCount: activity?.messageCount ?? 0,
        textCount: activity?.textCount ?? 0,
        mediaCount: activity?.mediaCount ?? 0,
        speakerCount: activity?.speakerCount ?? 0,
        firstMessageUnix: activity?.firstMessageUnix ?? null,
        lastMessageUnix: activity?.lastMessageUnix ?? null,
        busiestHourStartUnix: busiestHour === undefined ? null : fromUnix + busiestHour.hourIndex * 3600,
        busiestHourMessageCount: busiestHour?.messageCount ?? 0,
        topSpeakers: topSpeakersBySlot.get(key) ?? [],
      };
    });
    return { groupId, name: names.get(groupId) ?? "", slots };
  });
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
         OR (excluded.sent_at = read_marks.sent_at AND excluded.row_id > read_marks.row_id)
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
  queryMessages,
  getCoverage,
  getCoverageHealth,
  getRangeActivity,
  getEventActivity,
  getCoverageTimeline,
  getCoverageEnds,
  getStoredGroups,
  getGroupSummaries,
  getReadMark,
  setReadMark,
  getLatestMessage,
};
