const fs = require("node:fs");
const path = require("node:path");
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
  if (argv.length !== 4) {
    throw new Error("Usage: node list_groups.js <groupInfoDatabasePath> <outputPath>");
  }

  return {
    groupInfoDatabasePath: argv[2],
    outputPath: argv[3],
  };
};

const normalizeText = (value) => {
  if (value === null || value === undefined) {
    return "";
  }
  return String(value).replace(/\s+/gu, " ").trim();
};

const main = () => {
  const args = parseArgs(process.argv);
  const key = requireEnv("NTQQ_DB_KEY");
  const db = openDatabase(args.groupInfoDatabasePath, key);

  try {
    const rows = db
      .prepare(
        [
          "select",
          "  [60001] as group_id,",
          "  [60007] as group_name",
          "from group_list",
          "order by [60001]",
        ].join("\n"),
      )
      .all()
      .map((row) => ({
        groupId: String(row.group_id),
        groupName: normalizeText(row.group_name),
      }));

    const lines = rows.map((row) => `${row.groupId}\t${row.groupName}`);
    fs.mkdirSync(path.dirname(args.outputPath), { recursive: true });
    fs.writeFileSync(args.outputPath, `${lines.join("\n")}\n`, "utf8");
    process.stdout.write(JSON.stringify({ outputPath: args.outputPath, groupCount: rows.length }, null, 2));
  } finally {
    db.close();
  }
};

main();
