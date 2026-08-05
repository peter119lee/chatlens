const fs = require("node:fs");
const Database = require("better-sqlite3-multiple-ciphers");

const sqlQuote = (value) => `'${value.replaceAll("'", "''")}'`;

const requireEnv = (name) => {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
};

const openDatabase = (databasePath, key) => {
  const db = new Database(databasePath, {
    readonly: true,
    fileMustExist: true,
    timeout: 5000,
  });

  try {
    db.pragma("cipher='sqlcipher'");
    db.pragma("legacy=4");
    db.pragma("legacy_page_size=4096");
    db.pragma("kdf_iter=4000");
    db.pragma("hmac_algorithm=0");
    db.pragma("kdf_algorithm=2");
    db.pragma(`key=${sqlQuote(key)}`);
    db.pragma("query_only=ON");
    db.prepare("select count(*) as count from sqlite_master").get();
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
};

const parseArgs = (argv) => {
  if (argv.length !== 9) {
    throw new Error(
      "Usage: node export_group_recent.js <databasePath> <groupInfoDatabasePath> <groupIdsCsv> <startUnix> <endUnix> <outputPath> <scanLimit>",
    );
  }

  return {
    databasePath: argv[2],
    groupInfoDatabasePath: argv[3],
    groupIds: argv[4].split(",").map((value) => value.trim()).filter((value) => value.length > 0),
    startUnix: Number.parseInt(argv[5], 10),
    endUnix: Number.parseInt(argv[6], 10),
    outputPath: argv[7],
    scanLimit: Number.parseInt(argv[8], 10),
  };
};

// Legacy byte-scanner: matches the `82 16` tail of the plain-text element tag
// (field 45101). It catches simple text messages but MISSES the ~18% whose text
// is nested deeper (e.g. msg_type2=4096 rich elements at 45600.x). Kept only as
// a fallback for bodies the strict protobuf parser below can't walk.
const getMessageTextLegacy = (hex) => {
  if (hex === null || hex.length === 0) {
    return "";
  }

  const body = Buffer.from(hex, "hex");
  const text = [];
  let tagStatus = 0;
  let remainingLength = 0;

  for (const byte of body) {
    if (tagStatus === 0) {
      if (byte === 0x82) {
        tagStatus = 1;
      }
      continue;
    }

    if (tagStatus === 1) {
      tagStatus = byte === 0x16 ? 2 : -2;
      continue;
    }

    if (tagStatus === 3 || tagStatus === -3) {
      if (tagStatus > 0) {
        text.push(byte === 0 ? 0x0a : byte);
      }
      remainingLength -= 1;
      if (remainingLength === 0) {
        tagStatus = 0;
      }
      continue;
    }

    remainingLength = byte;
    if (tagStatus > 0) {
      tagStatus += 1;
    } else {
      tagStatus -= 1;
      remainingLength -= 1;
    }
    if (remainingLength <= 0) {
      remainingLength = 0;
      tagStatus = 0;
    }
  }

  return Buffer.from(text).toString("utf8").trim();
};

// Minimal protobuf reader: the QQNT message body (40800) is a protobuf whose
// text lives in length-delimited string fields at varying depths. Walking it
// generically recovers text the legacy `82 16` heuristic never reached.
const readVarint = (buf, index) => {
  let shift = 0;
  let result = 0;
  let pos = index;
  while (pos < buf.length) {
    const byte = buf[pos];
    pos += 1;
    result += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) {
      return [result, pos];
    }
    shift += 7;
    if (shift > 56) {
      return [null, pos];
    }
  }
  return [null, pos];
};

// Strict parse: returns null on any malformed field so a text leaf is never
// confused with a container. Malformed-tail bodies fall back to the legacy
// scanner in getMessageText below.
const parseProtobufFields = (buf) => {
  const fields = [];
  let i = 0;
  while (i < buf.length) {
    const [tag, next] = readVarint(buf, i);
    if (tag === null) {
      return null;
    }
    i = next;
    const fieldNumber = Math.floor(tag / 8);
    const wireType = tag & 7;
    if (fieldNumber === 0) {
      return null;
    }
    if (wireType === 0) {
      const [, afterVarint] = readVarint(buf, i);
      if (afterVarint === null || afterVarint > buf.length) {
        return null;
      }
      i = afterVarint;
    } else if (wireType === 2) {
      const [length, afterLength] = readVarint(buf, i);
      if (length === null || afterLength + length > buf.length) {
        return null;
      }
      fields.push({ wireType, slice: buf.subarray(afterLength, afterLength + length) });
      i = afterLength + length;
    } else if (wireType === 5) {
      if (i + 4 > buf.length) {
        return null;
      }
      i += 4;
    } else if (wireType === 1) {
      if (i + 8 > buf.length) {
        return null;
      }
      i += 8;
    } else {
      return null;
    }
  }
  return fields;
};

const isCjk = (code) =>
  (code >= 0x3400 && code <= 0x9fff) || (code >= 0xf900 && code <= 0xfaff) || (code >= 0x20000 && code <= 0x2ffff);

// A length-delimited slice is message text if it decodes as clean UTF-8 (no
// replacement/control bytes — those betray a protobuf container) and carries a
// CJK run or real word, and does not look like a hash / path / URL / token.
const sliceLooksLikeText = (slice) => {
  if (slice.length === 0 || slice.length > 8192) {
    return false;
  }
  const text = slice.toString("utf8");
  let cjk = 0;
  for (const character of text) {
    const code = character.codePointAt(0);
    if (code === 0xfffd || code < 9 || (code > 13 && code < 32)) {
      return false;
    }
    if (isCjk(code)) {
      cjk += 1;
    }
  }
  if (cjk >= 1) {
    return true;
  }
  if (!/^[\x20-\x7e]+$/u.test(text) || !/[A-Za-z]{2,}/u.test(text)) {
    return false;
  }
  return !(/^[0-9a-fA-F]{16,}$/u.test(text) || /[\\/]/u.test(text) || /^https?:/iu.test(text) || /^[A-Za-z0-9+/=_-]{24,}$/u.test(text));
};

const extractProtobufText = (hex) => {
  if (hex === null || hex.length === 0) {
    return "";
  }
  const parts = [];
  const seen = new Set();
  const walk = (buf, depth) => {
    if (depth > 10) {
      return;
    }
    const fields = parseProtobufFields(buf);
    if (fields === null) {
      return;
    }
    for (const field of fields) {
      if (field.wireType !== 2) {
        continue;
      }
      if (sliceLooksLikeText(field.slice)) {
        const value = field.slice.toString("utf8").trim();
        if (value.length > 0 && !seen.has(value)) {
          seen.add(value);
          parts.push(value);
        }
      } else if (field.slice.length >= 2) {
        walk(field.slice, depth + 1);
      }
    }
  };
  walk(Buffer.from(hex, "hex"), 0);
  return parts.join(" ").replace(/[^\S\n]+/gu, " ").trim();
};

const getMessageText = (hex) => {
  const extracted = extractProtobufText(hex);
  return extracted.length > 0 ? extracted : getMessageTextLegacy(hex);
};

const getBodyText = (hex) => {
  if (hex === null || hex.length === 0) {
    return "";
  }

  return Buffer.from(hex, "hex").toString("utf8");
};

const normalizeFilePath = (value) =>
  value
    .replace(/[^\p{L}\p{N}\p{P}\p{S}\s._:/\\-]+/gu, "")
    .replace(/[，。！？、；：）)]+$/gu, "")
    .trim();

// Longest-first within a stem (jpeg before jpg, docx before doc) so regex
// alternation never matches a prefix and leaves the tail behind.
const IMAGE_EXTENSIONS = ["jpeg", "jpg", "png", "gif", "webp", "bmp", "jfif", "heic"];
const VIDEO_EXTENSIONS = ["mp4", "mov", "avi", "mkv", "webm"];
const AUDIO_EXTENSIONS = ["amr", "silk", "m4a", "wav", "mp3"];
const DOC_EXTENSIONS = ["pdf", "zip", "7z", "rar", "docx", "doc", "xlsx", "xls", "pptx", "ppt", "txt", "apk"];

const getMediaKind = (extension, localPath) => {
  const ext = extension.toLowerCase().replace(".", "");
  const lowerPath = localPath.toLowerCase();
  if (lowerPath.includes("\\emoji\\") || lowerPath.includes("/emoji/")) {
    return "emoji";
  }
  if (AUDIO_EXTENSIONS.includes(ext) || lowerPath.includes("\\ptt\\") || lowerPath.includes("/ptt/")) {
    return "audio";
  }
  if (VIDEO_EXTENSIONS.includes(ext)) {
    return "video";
  }
  if (IMAGE_EXTENSIONS.includes(ext)) {
    return "image";
  }
  return "file";
};

const normalizeHash = (value) => value.replaceAll("-", "").toLowerCase();

const pushUniqueMediaRef = (refs, seen, ref) => {
  const key = JSON.stringify(ref);
  if (!seen.has(key)) {
    seen.add(key);
    refs.push(ref);
  }
};

const extractMediaRefs = (hex) => {
  const bodyText = getBodyText(hex);
  const refs = [];
  const seen = new Set();
  const localPathPattern = /[A-Za-z]:\\[^\u0000-\u001f"'<>|]+?\.(?:jpeg|jpg|png|gif|webp|bmp|jfif|heic|mp4|mov|avi|mkv|webm|amr|silk|m4a|wav|mp3|pdf|zip|7z|rar|docx|doc|xlsx|xls|pptx|ppt|txt|apk)/giu;
  const filePattern = /(?:\{?([a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12})\}?|([a-fA-F0-9]{32}))\.(jpeg|jpg|png|gif|webp|bmp|jfif|heic|mp4|mov|avi|mkv|webm|amr|silk|m4a|wav|mp3|pdf|zip|7z|rar|docx|doc|xlsx|xls|pptx|ppt|txt|apk)/giu;
  const urlPattern = /https?:\/\/[^\s<>"'）)]+/giu;

  for (const match of bodyText.matchAll(localPathPattern)) {
    const localPath = normalizeFilePath(match[0]);
    const extensionMatch = localPath.match(/\.(jpeg|jpg|png|gif|webp|bmp|jfif|heic|mp4|mov|avi|mkv|webm|amr|silk|m4a|wav|mp3|pdf|zip|7z|rar|docx|doc|xlsx|xls|pptx|ppt|txt|apk)$/iu);
    if (extensionMatch === null) {
      continue;
    }
    const extension = `.${extensionMatch[1].toLowerCase()}`;
    const hashMatch = localPath.match(/[a-fA-F0-9]{32}/u);
    pushUniqueMediaRef(refs, seen, {
      source: "localPath",
      kind: getMediaKind(extension, localPath),
      extension,
      hash: hashMatch === null ? null : normalizeHash(hashMatch[0]),
      fileName: localPath.split(/[\\/]/u).at(-1) ?? null,
      localPath,
      url: null,
    });
  }

  for (const match of bodyText.matchAll(filePattern)) {
    const rawHash = match[1] ?? match[2];
    const extension = `.${match[3].toLowerCase()}`;
    const fileName = `${rawHash}.${match[3]}`;
    pushUniqueMediaRef(refs, seen, {
      source: "fileToken",
      kind: getMediaKind(extension, ""),
      extension,
      hash: normalizeHash(rawHash),
      fileName,
      localPath: null,
      url: null,
    });
  }

  for (const match of bodyText.matchAll(urlPattern)) {
    const url = match[0];
    const extensionMatch = url.match(/\.(jpeg|jpg|png|gif|webp|bmp|jfif|heic|mp4|mov|avi|mkv|webm)(?:[?#].*)?$/iu);
    if (extensionMatch === null) {
      continue;
    }
    const extension = `.${extensionMatch[1].toLowerCase()}`;
    pushUniqueMediaRef(refs, seen, {
      source: "url",
      kind: getMediaKind(extension, ""),
      extension,
      hash: null,
      fileName: null,
      localPath: null,
      url,
    });
  }

  return refs;
};

const getBodySnippet = (hex) =>
  getBodyText(hex)
    .replace(/[^\p{L}\p{N}\p{P}\p{S}\s._:/\\-]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 220);

const fetchGroupMemberNames = (groupInfoDatabasePath, key, groupId) => {
  const db = openDatabase(groupInfoDatabasePath, key);
  try {
    const rows = db
      .prepare("select [1000] as uid, [1002] as uin, [20002] as nickname, [64003] as card from group_member3 where [60001] = ?")
      .all(Number.parseInt(groupId, 10));
    return new Map(
      rows.map((row) => [
        row.uid,
        {
          uin: row.uin,
          nickname: row.card || row.nickname || "",
        },
      ]),
    );
  } finally {
    db.close();
  }
};

const toJsonValue = (value) => (typeof value === "bigint" ? value.toString() : value);

const fetchGroupNames = (groupInfoDatabasePath, key, groupIds) => {
  const db = openDatabase(groupInfoDatabasePath, key);
  try {
    const stmt = db.prepare("select [60001] as group_id, [60007] as group_name from group_list where [60001] = ?");
    return new Map(
      groupIds.map((groupId) => {
        const row = stmt.get(Number.parseInt(groupId, 10));
        return [groupId, row?.group_name || ""];
      }),
    );
  } finally {
    db.close();
  }
};

const exportMessages = (args, key) => {
  if (args.groupIds.length === 0) {
    throw new Error("At least one group id is required.");
  }

  const db = openDatabase(args.databasePath, key);
  try {
    const memberNamesByGroup = new Map(
      args.groupIds.map((groupId) => [groupId, fetchGroupMemberNames(args.groupInfoDatabasePath, key, groupId)]),
    );
    const groupNames = fetchGroupNames(args.groupInfoDatabasePath, key, args.groupIds);

    db.defaultSafeIntegers(true);
    // group_msg_table row ids (40001) are GLOBAL insert order, NOT time order:
    // syncing a group's history inserts old messages with brand-new (high) row
    // ids, so scanning the whole 7M-row table newest-first and stopping on a
    // streak of out-of-window rows aborted long before a busy group's in-window
    // history was reached — one backfilled batch near the top hid >99% of the
    // messages. Fetch each group straight through the [40027] (group id) index
    // instead and push the upper time bound into SQLite. This excludes newer
    // rows before they consume the per-group scan budget; JS still performs the
    // lower-bound early stop and sidesteps corrupt pages a full scan would hit.
    const stmt = db.prepare(
      [
        "select",
        "  [40001] as row_id,",
        "  [40002] as msg_uid,",
        "  [40003] as msg_seq,",
        "  [40011] as msg_type1,",
        "  [40012] as msg_type2,",
        "  [40013] as sender_type,",
        "  [40020] as sender_uid,",
        "  [40021] as group_id_text,",
        "  [40027] as group_id_int,",
        "  [40033] as sender_uin,",
        "  [40040] as is_self,",
        "  [40050] as sent_at,",
        "  [40090] as sender_name,",
        "  [40093] as sender_name2,",
        "  hex([40800]) as body_hex",
        "from group_msg_table",
        "where [40027] = ? and [40050] < ?",
        "order by [40003] desc",
      ].join("\n"),
    );

    const startUnix = BigInt(args.startUnix);
    const endUnix = BigInt(args.endUnix);
    // Runaway guard only (default 1e6). Because the query is walked newest-first
    // (msg_seq desc) a cap hit drops the OLDEST rows, so the requested window is
    // still covered; the group is flagged incomplete regardless.
    const perGroupScanLimit = args.scanLimit;
    // Per-group early stop. The (40027,40003) index is walked msg_seq-DESC =
    // newest-first, and msg_seq is monotonic with sent_at WITHIN a group
    // (verified: 0 out-of-order rows in 20k). Unlike the global row_id order —
    // which cross-group history backfill scrambles, the original bug — this is a
    // safe basis to stop: once past the window into a long run of older
    // messages, the rest is older too. The 2000 buffer absorbs any local
    // anomaly and bounds work to ~window+2000 rows instead of the group's whole
    // local history (which grows unbounded as QQ keeps syncing).
    const olderStreakLimit = 2000;

    let scanned = 0;
    const messages = [];
    const mediaMessages = [];
    const errors = [];
    // Groups whose iteration could not be completed (row cap hit or corrupt
    // page); used below to keep coverage honest.
    const incompleteGroups = new Set();

    for (const groupId of args.groupIds) {
      const groupIdInt = BigInt(groupId);
      const memberNames = memberNamesByGroup.get(groupId) ?? new Map();
      const resolvedGroupName = groupNames.get(groupId) ?? "";
      let groupScanned = 0;
      let olderStreak = 0;
      try {
        // Index-driven, newest-first (msg_seq desc) walk of just this group's rows.
        for (const row of stmt.iterate(groupIdInt, endUnix)) {
          scanned += 1;
          groupScanned += 1;
          if (groupScanned > perGroupScanLimit) {
            incompleteGroups.add(groupId);
            break;
          }

          const sentAt = BigInt(row.sent_at);
          // Only real timestamps before the window feed the streak; sent_at<=0
          // (system rows) and in/after-window rows reset it, so a stray 0 can
          // never trigger a false early stop.
          if (sentAt > 0n && sentAt < startUnix) {
            olderStreak += 1;
            if (olderStreak >= olderStreakLimit) {
              break;
            }
            continue;
          }
          olderStreak = 0;
          if (sentAt < startUnix || sentAt >= endUnix) {
            continue;
          }

          const member = memberNames.get(row.sender_uid);
          const messageBase = {
            groupId,
            groupName: resolvedGroupName,
            rowId: toJsonValue(row.row_id),
            msgSeq: toJsonValue(row.msg_seq),
            msgType1: toJsonValue(row.msg_type1),
            msgType2: toJsonValue(row.msg_type2),
            sentAt: Number(row.sent_at),
            senderUid: toJsonValue(row.sender_uid),
            senderUin: toJsonValue(row.sender_uin),
            senderName: row.sender_name || row.sender_name2 || member?.nickname || "",
            memberName: member?.nickname || "",
            memberUin: member?.uin ?? null,
          };

          // Type 2 covers normal chat messages across all subtypes (plain
          // text, replies/quotes, mixed text+image, forwards) — extract text
          // from any of them; empty extractions are filtered downstream.
          if (row.msg_type1 === 2n) {
            messages.push({
              ...messageBase,
              text: getMessageText(row.body_hex),
            });
          }

          const mediaRefs = extractMediaRefs(row.body_hex);
          if (mediaRefs.length > 0) {
            mediaMessages.push({
              ...messageBase,
              bodySnippet: getBodySnippet(row.body_hex),
              mediaRefs,
            });
          }
        }
      } catch (error) {
        // A corrupt page inside this group's rows aborts only this group's
        // iteration: keep what we gathered, record the error, flag it
        // incomplete, and continue so the other groups still export.
        errors.push({ groupId, message: error.message, code: error.code });
        incompleteGroups.add(groupId);
      }
    }

    // A reply / forward / quote re-embeds the ORIGINAL message's image ref, so
    // extractMediaRefs would attribute the quoted image to the replier and show
    // it a second time ("回复图片被算成我发的、重复出现"). Keep each (group, hash)
    // only on its EARLIEST message; later re-references drop that ref. Stickers/
    // emoji and hashless refs (URLs) are exempt so genuine repeats still show.
    const earliestOwnerByHash = new Map();
    for (const media of mediaMessages) {
      for (const ref of media.mediaRefs) {
        if (ref.kind === "emoji" || ref.hash === null) {
          continue;
        }
        const hashKey = `${media.groupId}|${ref.hash}`;
        const owner = earliestOwnerByHash.get(hashKey);
        if (
          owner === undefined ||
          media.sentAt < owner.sentAt ||
          (media.sentAt === owner.sentAt && BigInt(media.rowId) < BigInt(owner.rowId))
        ) {
          earliestOwnerByHash.set(hashKey, { sentAt: media.sentAt, rowId: String(media.rowId) });
        }
      }
    }
    // Quote links are collected separately rather than pushed into
    // mediaMessages: an entry with no mediaRefs of its own would inflate
    // matchedMedia, the 媒体消息 topic count, and leave empty 📷 rows in the
    // message store.
    const quoteLinks = [];
    const dedupedMediaMessages = [];
    for (const media of mediaMessages) {
      const quotedImageHashes = [];
      const keptRefs = media.mediaRefs.filter((ref) => {
        if (ref.kind === "emoji" || ref.hash === null) {
          return true;
        }
        const owner = earliestOwnerByHash.get(`${media.groupId}|${ref.hash}`);
        const isOwner = owner !== undefined && owner.sentAt === media.sentAt && owner.rowId === String(media.rowId);
        // A ref this message did NOT originate identifies the image it is
        // quoting. Dropping it from mediaRefs is right (it is not this
        // person's image), but the link itself is what makes a "show me the
        // prompt" ask resolvable to a specific picture.
        if (!isOwner && ref.kind === "image") {
          quotedImageHashes.push(ref.hash);
        }
        return isOwner;
      });
      if (quotedImageHashes.length > 0) {
        quoteLinks.push({
          groupId: media.groupId,
          rowId: media.rowId,
          sentAt: media.sentAt,
          senderUin: media.senderUin,
          senderName: media.senderName,
          quotedImageHashes: [...new Set(quotedImageHashes)],
        });
      }
      if (keptRefs.length > 0) {
        dedupedMediaMessages.push({ ...media, mediaRefs: keptRefs });
      }
    }

    const sortByTimeAndRow = (left, right) => left.sentAt - right.sentAt || Number(BigInt(left.rowId) - BigInt(right.rowId));

    // Honest coverage: coverage is one floor the store applies to every group,
    // so any incomplete group forces a conservative null ("covered nothing
    // new"). The rows we did gather are still stored; the window simply stays
    // eligible for a later re-scan instead of being falsely marked complete. A
    // completed run covers the whole requested window because the [40027] index
    // walks every one of the group's messages, not a row-budget slice.
    const scanComplete = incompleteGroups.size === 0;
    const scanAborted = errors.length > 0;
    const scanTruncated = !scanComplete && !scanAborted;
    const coveredFromUnix = scanComplete ? args.startUnix : null;
    const stopReason = scanComplete ? "complete" : scanAborted ? "aborted" : "scan-limit";

    if (!scanComplete) {
      console.log(`warning=scan-incomplete reason=${stopReason} groups=${[...incompleteGroups].join(",")}`);
      console.log(scanAborted
        ? "警告：数据库副本读取失败；当前群和时间块不会标记为已覆盖，错误详情会保留供重试。"
        : "警告：群消息数达到当前工作块的扫描预算；当前范围不会标记为已覆盖，可缩小时间块后重试。");
    }

    const output = {
      groupIds: args.groupIds,
      groupNames: Object.fromEntries(args.groupIds.map((groupId) => [groupId, groupNames.get(groupId) ?? ""])),
      startUnix: args.startUnix,
      endUnix: args.endUnix,
      scanned,
      stopReason,
      scanTruncated,
      scanAborted,
      coveredFromUnix,
      matched: messages.length,
      matchedMedia: dedupedMediaMessages.length,
      errors,
      messages: messages.sort(sortByTimeAndRow),
      mediaMessages: dedupedMediaMessages.sort(sortByTimeAndRow),
      // Which image each reply is quoting. Consumed by the prompt-request
      // pairing; carries no media of its own.
      quoteLinks: quoteLinks.sort(sortByTimeAndRow),
    };

    fs.writeFileSync(args.outputPath, JSON.stringify(output, null, 2), "utf8");
    return {
      matched: output.matched,
      matchedMedia: output.matchedMedia,
      scanned: output.scanned,
      scanComplete,
      stopReason,
    };
  } finally {
    db.close();
  }
};

const main = () => {
  const args = parseArgs(process.argv);
  const key = requireEnv("NTQQ_DB_KEY");
  const result = exportMessages(args, key);
  console.log(
    `exportResult scanComplete=${result.scanComplete} stopReason=${result.stopReason} scanned=${result.scanned} matched=${result.matched} matchedMedia=${result.matchedMedia}`,
  );
};

main();
