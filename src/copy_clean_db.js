const fs = require("node:fs");
const path = require("node:path");

const copyWithoutPrefix = (sourcePath, targetPath, prefixBytes) => {
  if (!Number.isInteger(prefixBytes) || prefixBytes < 0) {
    throw new Error(`Invalid prefix byte count: ${prefixBytes}`);
  }

  fs.mkdirSync(path.dirname(targetPath), { recursive: true });

  const source = fs.openSync(sourcePath, "r");
  const target = fs.openSync(targetPath, "w");

  try {
    const stat = fs.fstatSync(source);
    if (stat.size <= prefixBytes) {
      throw new Error(`Source file is too small: path=${sourcePath} size=${stat.size} prefixBytes=${prefixBytes}`);
    }

    const bufferSize = 8 * 1024 * 1024;
    const buffer = Buffer.allocUnsafe(bufferSize);
    let position = prefixBytes;

    while (position < stat.size) {
      const bytesRead = fs.readSync(source, buffer, 0, Math.min(bufferSize, stat.size - position), position);
      if (bytesRead === 0) {
        throw new Error(`Unexpected EOF while copying: path=${sourcePath} position=${position}`);
      }
      fs.writeSync(target, buffer, 0, bytesRead);
      position += bytesRead;
    }
  } finally {
    fs.closeSync(target);
    fs.closeSync(source);
  }
};

const parseArgs = (argv) => {
  if (argv.length !== 5) {
    throw new Error("Usage: node copy_clean_db.js <sourcePath> <targetPath> <prefixBytes>");
  }

  return {
    sourcePath: argv[2],
    targetPath: argv[3],
    prefixBytes: Number.parseInt(argv[4], 10),
  };
};

const main = () => {
  const args = parseArgs(process.argv);
  copyWithoutPrefix(args.sourcePath, args.targetPath, args.prefixBytes);
};

main();
