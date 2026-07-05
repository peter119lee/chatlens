const fs = require("node:fs");
const path = require("node:path");
const { openStore, ingestExport } = require("./message_store");

const parseArgs = (argv) => {
  if (argv.length !== 6) {
    throw new Error("Usage: node ingest_store.js <exportJson> <storeDbPath> <retentionDays> <runId>");
  }

  const retentionDays = Number.parseInt(argv[4], 10);
  if (!Number.isInteger(retentionDays) || retentionDays <= 0) {
    throw new Error(`Invalid retentionDays: ${argv[4]}`);
  }

  return {
    exportJson: argv[2],
    storeDbPath: argv[3],
    retentionDays,
    runId: argv[5],
  };
};

const main = () => {
  const args = parseArgs(process.argv);
  const exportData = JSON.parse(fs.readFileSync(args.exportJson, "utf8"));
  const db = openStore(path.resolve(args.storeDbPath));
  try {
    const result = ingestExport(db, exportData, args.runId, args.retentionDays);
    console.log(
      `storeIngest inserted=${result.inserted} prunedMessages=${result.prunedMessages} db=${args.storeDbPath}`,
    );
  } finally {
    db.close();
  }
};

main();
