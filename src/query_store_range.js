const Database = require("better-sqlite3-multiple-ciphers");

// Prints the earliest coverage end across the given groups so the pipeline's
// -SinceLastRecord mode can continue exactly where the store's records stop.
const main = () => {
  const [storePath, groupIdsCsv] = process.argv.slice(2);
  if (!storePath || !groupIdsCsv) {
    throw new Error("Usage: node query_store_range.js <storeDbPath> <groupIdsCsv>");
  }

  const groupIds = groupIdsCsv
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  if (groupIds.length === 0) {
    throw new Error("At least one group id is required.");
  }

  const db = new Database(storePath, { readonly: true, fileMustExist: true, timeout: 5000 });
  try {
    const stmt = db.prepare("SELECT MAX(end_unix) AS coverageEnd FROM scan_ranges WHERE group_id = ?");
    const ends = groupIds
      .map((groupId) => stmt.get(groupId)?.coverageEnd)
      .filter((value) => Number.isFinite(value) && value > 0);
    if (ends.length === 0) {
      process.stdout.write("coverageStart=none\n");
      process.exitCode = 2;
      return;
    }
    process.stdout.write(`coverageStart=${Math.min(...ends)}\n`);
  } finally {
    db.close();
  }
};

main();
