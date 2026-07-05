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
  if (argv.length !== 7) {
    throw new Error("Usage: node inspect_message_types.js <databasePath> <groupId> <startUnix> <endUnix> <scanLimit>");
  }

  return {
    databasePath: argv[2],
    groupId: argv[3],
    startUnix: Number.parseInt(argv[4], 10),
    endUnix: Number.parseInt(argv[5], 10),
    scanLimit: Number.parseInt(argv[6], 10),
  };
};

const toStringValue = (value) => (typeof value === "bigint" ? value.toString() : String(value));

const printableSnippet = (hex) => {
  if (hex === null || hex.length === 0) {
    return "";
  }

  const raw = Buffer.from(hex, "hex").toString("utf8");
  return raw
    .replace(/[^\p{L}\p{N}\p{P}\p{S}\s._:/\\-]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 260);
};

const extractLikelyTokens = (hex) => {
  if (hex === null || hex.length === 0) {
    return [];
  }

  const raw = Buffer.from(hex, "hex").toString("utf8");
  const matches = raw.match(/[a-fA-F0-9]{32}|[A-Za-z]:\\[^\u0000-\u001f"'<>|]+|[A-Za-z0-9_.-]+\.(?:jpg|jpeg|png|gif|webp|mp4|mov|avi|mkv)/gu) ?? [];
  return [...new Set(matches)].slice(0, 12);
};

const main = () => {
  const args = parseArgs(process.argv);
  const key = requireEnv("NTQQ_DB_KEY");
  const db = openDatabase(args.databasePath, key);
  db.defaultSafeIntegers(true);

  try {
    const stmt = db
      .prepare(
        [
          "select",
          "  [40001] as row_id,",
          "  [40011] as type1,",
          "  [40012] as type2,",
          "  [40021] as group_id_text,",
          "  [40027] as group_id_int,",
          "  [40050] as sent_at,",
          "  hex([40800]) as body_hex",
          "from group_msg_table",
          "where [40001] < ?",
          "order by [40001] desc",
          "limit 1000",
        ].join("\n"),
      );

    const groupIdNumber = BigInt(args.groupId);
    const startUnix = BigInt(args.startUnix);
    const endUnix = BigInt(args.endUnix);
    const countMap = new Map();
    const samples = [];
    let cursor = 9223372036854775807n;
    let scanned = 0;

    while (scanned < args.scanLimit) {
      const rows = stmt.all(cursor);
      if (rows.length === 0) {
        break;
      }

      for (const row of rows) {
        scanned += 1;
        cursor = BigInt(row.row_id);
        const sentAt = BigInt(row.sent_at);
        const matchedGroup =
          row.group_id_text === args.groupId ||
          (row.group_id_int !== null && BigInt(row.group_id_int) === groupIdNumber);

        if (!matchedGroup || sentAt < startUnix || sentAt >= endUnix) {
          continue;
        }

        const keyText = `${toStringValue(row.type1)}:${toStringValue(row.type2)}`;
        countMap.set(keyText, (countMap.get(keyText) ?? 0) + 1);
        if (samples.length < 120) {
          samples.push({
            rowId: toStringValue(row.row_id),
            type1: toStringValue(row.type1),
            type2: toStringValue(row.type2),
            sentAt: toStringValue(row.sent_at),
            likelyTokens: extractLikelyTokens(row.body_hex),
            snippet: printableSnippet(row.body_hex),
          });
        }
      }

      if (rows.length < 1000) {
        break;
      }
    }

    const counts = [...countMap.entries()]
      .map(([keyText, count]) => {
        const [type1, type2] = keyText.split(":");
        return { type1, type2, count };
      })
      .sort((left, right) => right.count - left.count);

    process.stdout.write(JSON.stringify({ scanned, counts, samples }, null, 2));
  } finally {
    db.close();
  }
};

main();
