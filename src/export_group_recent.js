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

const getMessageText = (hex) => {
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

const getMediaKind = (extension, localPath) => {
  const lowerExtension = extension.toLowerCase();
  const lowerPath = localPath.toLowerCase();
  if (lowerPath.includes("\\emoji\\") || lowerPath.includes("/emoji/")) {
    return "emoji";
  }
  if ([".mp4", ".mov", ".avi", ".mkv", ".webm"].includes(lowerExtension)) {
    return "video";
  }
  if ([".jpg", ".jpeg", ".png", ".gif", ".webp"].includes(lowerExtension)) {
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
  const localPathPattern = /[A-Za-z]:\\[^\u0000-\u001f"'<>|]+?\.(?:jpg|jpeg|png|gif|webp|mp4|mov|avi|mkv)/giu;
  const filePattern = /(?:\{?([a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12})\}?|([a-fA-F0-9]{32}))\.(jpg|jpeg|png|gif|webp|mp4|mov|avi|mkv)/giu;
  const urlPattern = /https?:\/\/[^\s<>"'）)]+/giu;

  for (const match of bodyText.matchAll(localPathPattern)) {
    const localPath = normalizeFilePath(match[0]);
    const extensionMatch = localPath.match(/\.(jpg|jpeg|png|gif|webp|mp4|mov|avi|mkv)$/iu);
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
    const extensionMatch = url.match(/\.(jpg|jpeg|png|gif|webp|mp4|mov|avi|mkv)(?:[?#].*)?$/iu);
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
        "where [40001] < ?",
        "order by [40001] desc",
        "limit ?",
      ].join("\n"),
    );

    const groupIdNumbers = new Map(args.groupIds.map((groupId) => [groupId, BigInt(groupId)]));
    const startUnix = BigInt(args.startUnix);
    const endUnix = BigInt(args.endUnix);
    const chunkSize = 1000;
    const maxQueryErrors = 50;
    let cursor = 9223372036854775807n;
    let scanned = 0;
    const messages = [];
    const mediaMessages = [];
    const errors = [];

    while (scanned < args.scanLimit) {
      let rows;
      try {
        rows = stmt.all(cursor, chunkSize);
      } catch (error) {
        errors.push({
          cursor: cursor.toString(),
          message: error.message,
          code: error.code,
        });
        // A torn/corrupt copy can fail on every page; without a budget this
        // retry loop would shrink the cursor ~9 million times before exiting.
        if (errors.length >= maxQueryErrors) {
          errors.push({ cursor: cursor.toString(), message: `Aborted scan after ${maxQueryErrors} query errors.`, code: "SCAN_ABORTED" });
          break;
        }
        cursor -= 1000000000000n;
        continue;
      }

      if (rows.length === 0) {
        break;
      }

      for (const row of rows) {
        scanned += 1;
        cursor = BigInt(row.row_id);

        const sentAt = BigInt(row.sent_at);
        const matchedGroupId = args.groupIds.find((groupId) => {
          const groupIdNumber = groupIdNumbers.get(groupId);
          return row.group_id_text === groupId || (row.group_id_int !== null && BigInt(row.group_id_int) === groupIdNumber);
        });

        if (matchedGroupId !== undefined && sentAt >= startUnix && sentAt < endUnix) {
          const memberNames = memberNamesByGroup.get(matchedGroupId) ?? new Map();
          const member = memberNames.get(row.sender_uid);
          const messageBase = {
            groupId: matchedGroupId,
            groupName: groupNames.get(matchedGroupId) ?? "",
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

          if (row.msg_type1 === 2n && row.msg_type2 === 1n) {
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
      }

      if (rows.length < chunkSize) {
        break;
      }
    }

    const sortByTimeAndRow = (left, right) => left.sentAt - right.sentAt || Number(BigInt(left.rowId) - BigInt(right.rowId));

    const output = {
      groupIds: args.groupIds,
      groupNames: Object.fromEntries(args.groupIds.map((groupId) => [groupId, groupNames.get(groupId) ?? ""])),
      startUnix: args.startUnix,
      endUnix: args.endUnix,
      scanned,
      matched: messages.length,
      matchedMedia: mediaMessages.length,
      errors,
      messages: messages.sort(sortByTimeAndRow),
      mediaMessages: mediaMessages.sort(sortByTimeAndRow),
    };

    fs.writeFileSync(args.outputPath, JSON.stringify(output, null, 2), "utf8");
  } finally {
    db.close();
  }
};

const main = () => {
  const args = parseArgs(process.argv);
  const key = requireEnv("NTQQ_DB_KEY");
  exportMessages(args, key);
};

main();
