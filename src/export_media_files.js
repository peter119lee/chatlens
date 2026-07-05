const fs = require("node:fs");
const path = require("node:path");

const parseArgs = (argv) => {
  if (argv.length !== 6) {
    throw new Error("Usage: node export_media_files.js <mediaMessagesJson> <ntDataDir> <outputDir> <formatsCsv>");
  }

  return {
    mediaMessagesJson: argv[2],
    ntDataDir: argv[3],
    outputDir: argv[4],
    formats: argv[5]
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter((value) => value.length > 0),
  };
};

const normalizePath = (value) => value.replaceAll("/", "\\").replace(/[^\p{L}\p{N}\p{P}\p{S}\s._:\\-]+/gu, "").trim();

const pathExists = (filePath) => {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
};

const getExtension = (filePath) => path.extname(filePath).toLowerCase().replace(".", "");

const getCandidateRoots = (ntDataDir) => ["Pic", "Video", "Emoji", "Ptt", "File"].map((name) => path.join(ntDataDir, name));

const walkFiles = (rootDir, visit) => {
  if (!fs.existsSync(rootDir)) {
    return;
  }

  const stack = [rootDir];
  while (stack.length > 0) {
    const current = stack.pop();
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(entryPath);
      } else if (entry.isFile()) {
        visit(entryPath);
      }
    }
  }
};

const buildMediaIndex = (ntDataDir) => {
  const roots = getCandidateRoots(ntDataDir);
  const byHash = new Map();
  const byFileName = new Map();

  for (const root of roots) {
    walkFiles(root, (filePath) => {
      const fileName = path.basename(filePath);
      const lowerFileName = fileName.toLowerCase();
      const hashMatch = lowerFileName.match(/[a-f0-9]{32}/u);
      if (hashMatch !== null) {
        const values = byHash.get(hashMatch[0]) ?? [];
        values.push(filePath);
        byHash.set(hashMatch[0], values);
      }

      const fileValues = byFileName.get(lowerFileName) ?? [];
      fileValues.push(filePath);
      byFileName.set(lowerFileName, fileValues);
    });
  }

  return { byHash, byFileName };
};

const pickBestCandidate = (candidates, formats) => {
  const existing = candidates.filter(pathExists);
  if (existing.length === 0) {
    return null;
  }

  const allowed = formats.length === 0 ? existing : existing.filter((filePath) => formats.includes(getExtension(filePath)));
  const pool = allowed.length > 0 ? allowed : existing;
  // Stat each candidate once, tolerating files QQ purges between the exists
  // check and here.
  const sized = [];
  for (const filePath of pool) {
    try {
      sized.push({ filePath, size: fs.statSync(filePath).size });
    } catch {
      // skip vanished candidate
    }
  }
  if (sized.length === 0) {
    return null;
  }
  return sized.sort((left, right) => right.size - left.size)[0].filePath;
};

const findSourcePath = (ref, index, formats) => {
  if (ref.localPath !== null && ref.localPath !== undefined) {
    const normalized = normalizePath(ref.localPath);
    if (pathExists(normalized)) {
      return normalized;
    }
  }

  if (ref.hash !== null && ref.hash !== undefined) {
    const hashCandidates = index.byHash.get(String(ref.hash).toLowerCase()) ?? [];
    const picked = pickBestCandidate(hashCandidates, formats);
    if (picked !== null) {
      return picked;
    }
  }

  if (ref.fileName !== null && ref.fileName !== undefined) {
    const nameCandidates = index.byFileName.get(String(ref.fileName).toLowerCase()) ?? [];
    const picked = pickBestCandidate(nameCandidates, formats);
    if (picked !== null) {
      return picked;
    }
  }

  return null;
};

const safeName = (value) => String(value).replace(/[^A-Za-z0-9_.-]+/gu, "_").slice(0, 120);

const copyMedia = (message, ref, sourcePath, outputDir, index) => {
  const extension = path.extname(sourcePath).toLowerCase();
  const groupPart = safeName(message.groupName || message.groupId || "group");
  const speakerPart = safeName(message.speaker || message.senderName || "speaker");
  const targetName = `${String(index).padStart(4, "0")}_${message.hkt.replace(/[-: ]/gu, "")}_${groupPart}_${speakerPart}${extension}`;
  const kindDir = ref.kind || "media";
  const targetPath = path.join(outputDir, kindDir, targetName);
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.copyFileSync(sourcePath, targetPath);
  return targetPath;
};

const main = () => {
  const args = parseArgs(process.argv);
  const mediaMessages = JSON.parse(fs.readFileSync(args.mediaMessagesJson, "utf8"));
  fs.mkdirSync(args.outputDir, { recursive: true });

  const index = buildMediaIndex(args.ntDataDir);
  const manifest = [];
  let copied = 0;
  let refIndex = 0;

  for (const message of mediaMessages) {
    for (const ref of message.mediaRefs ?? []) {
      refIndex += 1;
      const sourcePath = findSourcePath(ref, index, args.formats);
      const copiedPath = sourcePath === null ? null : copyMedia(message, ref, sourcePath, args.outputDir, refIndex);
      if (copiedPath !== null) {
        copied += 1;
      }

      manifest.push({
        rowId: message.rowId,
        hkt: message.hkt,
        groupId: message.groupId,
        groupName: message.groupName,
        speaker: message.speaker,
        kind: ref.kind,
        hash: ref.hash,
        fileName: ref.fileName,
        requestedExtension: ref.extension,
        sourcePath,
        copiedPath,
        url: ref.url,
      });
    }
  }

  const manifestPath = path.join(args.outputDir, "media-manifest.json");
  const manifestTextPath = path.join(args.outputDir, "media-manifest.txt");
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
  fs.writeFileSync(
    manifestTextPath,
    `${manifest
      .map((item) => `[${item.hkt}] [${item.kind}] ${item.groupName || item.groupId} ${item.speaker}: ${item.copiedPath ?? item.sourcePath ?? item.url ?? "NOT_FOUND"}`)
      .join("\n")}\n`,
    "utf8",
  );

  process.stdout.write(
    JSON.stringify(
      {
        outputDir: args.outputDir,
        manifestPath,
        manifestTextPath,
        refs: manifest.length,
        copied,
        missing: manifest.length - copied,
      },
      null,
      2,
    ),
  );
};

main();
