const fs = require("node:fs");
const path = require("node:path");
const { openStore, ingestExport } = require("./message_store");

const parseArgs = (argv) => {
  if (argv.length !== 5) {
    throw new Error("Usage: node ingest_store.js <exportJson> <storeDbPath> <runId>");
  }

  return {
    exportJson: argv[2],
    storeDbPath: argv[3],
    runId: argv[4],
  };
};

const main = () => {
  const args = parseArgs(process.argv);
  const exportData = JSON.parse(fs.readFileSync(args.exportJson, "utf8"));
  const db = openStore(path.resolve(args.storeDbPath));
  try {
    const result = ingestExport(db, exportData, args.runId);
    console.log(`storeIngest inserted=${result.inserted} db=${args.storeDbPath}`);
  } finally {
    db.close();
  }
};

main();
