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
  if (argv.length !== 4) {
    throw new Error("Usage: node query_ntqq.js <databasePath> <sqlPath>");
  }

  return {
    databasePath: argv[2],
    sqlPath: argv[3],
  };
};

const main = () => {
  const args = parseArgs(process.argv);
  const key = requireEnv("NTQQ_DB_KEY");
  const sql = fs.readFileSync(args.sqlPath, "utf8");
  const db = openDatabase(args.databasePath, key);

  try {
    const rows = db.prepare(sql).all();
    process.stdout.write(JSON.stringify(rows, null, 2));
  } finally {
    db.close();
  }
};

main();
