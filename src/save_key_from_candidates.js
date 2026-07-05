const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const Database = require("better-sqlite3-multiple-ciphers");

const sqlQuote = (value) => `'${value.replaceAll("'", "''")}'`;

const databaseConfigs = [
  {
    name: "ntqq-hmac-sha1-kdf-sha512",
    pragmas: ["cipher='sqlcipher'", "legacy_page_size=4096", "kdf_iter=4000", "hmac_algorithm=0", "kdf_algorithm=2"],
  },
  {
    name: "ntqq-legacy4-overrides",
    pragmas: [
      "cipher='sqlcipher'",
      "legacy=4",
      "legacy_page_size=4096",
      "kdf_iter=4000",
      "hmac_algorithm=0",
      "kdf_algorithm=2",
    ],
  },
];

const parseArgs = (argv) => {
  if (argv.length !== 5) {
    throw new Error("Usage: node save_key_from_candidates.js <databasePath> <candidatePath> <secretPath>");
  }

  return {
    databasePath: argv[2],
    candidatePath: argv[3],
    secretPath: argv[4],
  };
};

const parseCandidates = (candidatePath) => {
  const values = fs
    .readFileSync(candidatePath, "utf8")
    .split(/\r?\n/u)
    .map((value) => value.trim())
    .filter((value) => value.length === 16 || value.length === 32);

  return [...new Set(values)];
};

const openWithKey = (databasePath, key, config) => {
  const db = new Database(databasePath, {
    readonly: true,
    fileMustExist: true,
    timeout: 5000,
  });

  try {
    for (const pragma of config.pragmas) {
      db.pragma(pragma);
    }
    db.pragma(`key=${sqlQuote(key)}`);
    db.pragma("query_only=ON");
    db.prepare("select count(*) as count from sqlite_master").get();
    return db;
  } catch {
    db.close();
    return null;
  }
};

const verifyKey = (databasePath, key) => {
  for (const config of databaseConfigs) {
    const db = openWithKey(databasePath, key, config);
    if (db !== null) {
      try {
        db.prepare("select name from sqlite_master where type = 'table' limit 1").get();
        return config.name;
      } finally {
        db.close();
      }
    }
  }

  return null;
};

const getSaveScript = () => `
$ErrorActionPreference = 'Stop'
$secretPath = $env:QQSUMMARYTOOLS_SECRET_PATH
if ([string]::IsNullOrWhiteSpace($secretPath)) {
  throw 'Missing QQSUMMARYTOOLS_SECRET_PATH.'
}

$plain = [Console]::In.ReadToEnd()
if ([string]::IsNullOrEmpty($plain)) {
  throw 'No key received on stdin.'
}

$secure = ConvertTo-SecureString -String $plain -AsPlainText -Force
$encrypted = ConvertFrom-SecureString -SecureString $secure
$secretDir = Split-Path -Parent $secretPath
New-Item -ItemType Directory -Force -Path $secretDir | Out-Null
Set-Content -LiteralPath $secretPath -Value $encrypted -Encoding ASCII
`;

const saveEncryptedKey = (secretPath, key) => {
  const encoded = Buffer.from(getSaveScript(), "utf16le").toString("base64");
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
    {
      input: key,
      encoding: "utf8",
      env: {
        ...process.env,
        QQSUMMARYTOOLS_SECRET_PATH: secretPath,
      },
      windowsHide: true,
    },
  );

  if (result.status !== 0) {
    const stderr = result.stderr.trim();
    throw new Error(`Failed to save encrypted key. ExitCode=${result.status} Stderr=${stderr}`);
  }
};

const findAndSaveKey = (args) => {
  const candidates = parseCandidates(args.candidatePath);
  let tested = 0;

  for (const candidate of candidates) {
    tested += 1;
    const configName = verifyKey(args.databasePath, candidate);
    if (configName !== null) {
      saveEncryptedKey(args.secretPath, candidate);
      return {
        saved: true,
        secretPath: args.secretPath,
        candidateCount: candidates.length,
        tested,
        configName,
      };
    }
  }

  return {
    saved: false,
    secretPath: args.secretPath,
    candidateCount: candidates.length,
    tested,
    configName: null,
  };
};

const main = () => {
  const args = parseArgs(process.argv);
  const result = findAndSaveKey(args);
  process.stdout.write(JSON.stringify(result, null, 2));
  if (!result.saved) {
    process.exitCode = 2;
  }
};

main();
