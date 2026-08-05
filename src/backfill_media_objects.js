"use strict";

const path = require("node:path");
const { backfillMissingMediaObjects } = require("./media_object_store");

const parseArgs = (argv) => {
  if (argv.length !== 3) {
    throw new Error("Usage: node backfill_media_objects.js <toolkitRoot>");
  }
  const toolRoot = path.resolve(argv[2]);
  return {
    toolRoot,
    runsDir: path.join(toolRoot, "runs"),
    objectDir: path.join(toolRoot, "store", "media-objects"),
    knowledgeStorePath: path.join(toolRoot, "store", "knowledge.db"),
  };
};

const main = () => {
  const result = backfillMissingMediaObjects(parseArgs(process.argv));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
};

if (require.main === module) {
  main();
}

module.exports = { parseArgs };
