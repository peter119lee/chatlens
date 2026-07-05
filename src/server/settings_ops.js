const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const state = require("./toolkit_state");

const SECRET_DIR = path.join(process.env.APPDATA ?? "", "QQSummaryTools");
const SECRET_FILES = {
  ntqqKey: "ntqq-db-key.dpapi",
  llmKey: "deepseek-api-key.dpapi",
};
const BASE_URL_PATTERN = /^https?:\/\/[\w.-]+(?::\d+)?(?:\/[\w./-]*)?$/u;
const MODEL_NAME_PATTERN = /^[\w.:/-]{1,64}$/u;

const runPowershell = (commandText, stdinText) =>
  new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-EncodedCommand",
      Buffer.from(commandText, "utf16le").toString("base64"),
    ], { windowsHide: true });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        const lastLine = stderr.trim().split(/\r?\n/u).filter((line) => line.trim().length > 0).at(-1) ?? "";
        reject(new Error(lastLine.slice(0, 300) || `PowerShell 退出码 ${code}`));
      }
    });
    if (typeof stdinText === "string") {
      child.stdin.write(stdinText, "utf8");
    }
    child.stdin.end();
  });

const getSettingsStatus = () => {
  const config = state.loadConfig();
  return {
    ntqqKeySaved: fs.existsSync(path.join(SECRET_DIR, SECRET_FILES.ntqqKey)),
    llmKeySaved: fs.existsSync(path.join(SECRET_DIR, SECRET_FILES.llmKey)),
    ntDbDir: config.ntDbDir ?? "",
    ntDataDir: config.ntDataDir ?? "",
    llm: {
      baseUrl: config.llm?.baseUrl ?? "",
      model: config.llm?.model ?? "",
    },
  };
};

// The secret travels via stdin only — never on a command line, never in a log.
const saveSecret = async (which, secretValue) => {
  const fileName = SECRET_FILES[which];
  if (fileName === undefined) {
    throw new Error(`未知的密钥类型: ${which}`);
  }
  const secret = String(secretValue ?? "").trim();
  if (secret.length < 8 || secret.length > 512) {
    throw new Error("密钥长度不合理（应为 8-512 个字符）。");
  }

  const command = [
    "$ErrorActionPreference = 'Stop'",
    "$plain = [Console]::In.ReadToEnd().Trim()",
    "if ($plain.Length -lt 8) { throw 'Secret from stdin is empty.' }",
    "$secure = ConvertTo-SecureString -String $plain -AsPlainText -Force",
    "$encrypted = ConvertFrom-SecureString -SecureString $secure",
    "$dir = Join-Path $env:APPDATA 'QQSummaryTools'",
    "New-Item -ItemType Directory -Force -Path $dir | Out-Null",
    `Set-Content -LiteralPath (Join-Path $dir '${fileName}') -Value $encrypted -Encoding ASCII`,
    "exit 0",
  ].join("\n");
  await runPowershell(command, secret);
};

// Lists model ids from any OpenAI-compatible endpoint. The API key stays inside
// the PowerShell process (read from DPAPI); only model ids come back on stdout.
const fetchLlmModels = async (baseUrl) => {
  const trimmed = String(baseUrl ?? "").trim().replace(/\/+$/u, "");
  if (!BASE_URL_PATTERN.test(trimmed)) {
    throw new Error("baseUrl 格式不对，应类似 https://api.deepseek.com");
  }
  if (!fs.existsSync(path.join(SECRET_DIR, SECRET_FILES.llmKey))) {
    throw new Error("先在上方保存 LLM API key，再获取模型列表。");
  }

  const commonPs = path.join(state.toolRoot, "scripts", "common.ps1");
  const command = [
    "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
    "$ErrorActionPreference = 'Stop'",
    `. '${commonPs}'`,
    "$key = Read-SavedSecret -FileName 'deepseek-api-key.dpapi' -SecretName 'LLM API key'",
    `$resp = Invoke-RestMethod -Uri '${trimmed}/models' -Headers @{ Authorization = \"Bearer $key\" } -TimeoutSec 30`,
    "$items = if ($null -ne $resp.PSObject.Properties['data']) { $resp.data } else { $resp }",
    "foreach ($m in @($items)) { if ($null -ne $m.PSObject.Properties['id']) { Write-Output $m.id } }",
    "exit 0",
  ].join("\n");

  const output = await runPowershell(command);
  const models = [...new Set(
    output.split(/\r?\n/u).map((line) => line.trim()).filter((line) => MODEL_NAME_PATTERN.test(line)),
  )];
  if (models.length === 0) {
    throw new Error("该地址没有返回模型列表（检查 baseUrl 与 API key）。");
  }
  return models;
};

const saveConfigPatch = (patch) => {
  const config = state.loadConfig();
  const next = { ...config, ...patch };
  fs.writeFileSync(state.configPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
};

const saveLlmConfig = ({ baseUrl, model }) => {
  const trimmedUrl = String(baseUrl ?? "").trim().replace(/\/+$/u, "");
  const trimmedModel = String(model ?? "").trim();
  if (!BASE_URL_PATTERN.test(trimmedUrl)) {
    throw new Error("baseUrl 格式不对。");
  }
  if (!MODEL_NAME_PATTERN.test(trimmedModel)) {
    throw new Error("模型名格式不对。");
  }
  const config = state.loadConfig();
  saveConfigPatch({ llm: { ...(config.llm ?? {}), provider: "deepseek", baseUrl: trimmedUrl, model: trimmedModel } });
  return { baseUrl: trimmedUrl, model: trimmedModel };
};

const saveQqPaths = ({ ntDbDir, ntDataDir }) => {
  const dbDir = String(ntDbDir ?? "").trim();
  const dataDir = String(ntDataDir ?? "").trim();
  if (dbDir.length === 0) {
    throw new Error("nt_db 目录不能为空。");
  }
  saveConfigPatch({ ntDbDir: dbDir, ntDataDir: dataDir });
  return {
    ntDbDir: dbDir,
    ntDataDir: dataDir,
    ntDbDirExists: fs.existsSync(dbDir),
    ntDataDirExists: dataDir.length === 0 || fs.existsSync(dataDir),
  };
};

// Best-effort scan of the default QQNT data locations for this Windows user.
const detectQqPaths = () => {
  const candidates = [];
  const roots = [
    path.join(os.homedir(), "Documents", "Tencent Files"),
    path.join(os.homedir(), "Documents", "Tencent Files", "Tencent Files"),
  ];
  for (const root of roots) {
    if (!fs.existsSync(root)) {
      continue;
    }
    let entries;
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^\d{5,}$/u.test(entry.name)) {
        continue;
      }
      const ntDbDir = path.join(root, entry.name, "nt_qq", "nt_db");
      if (fs.existsSync(ntDbDir)) {
        candidates.push({
          qq: entry.name,
          ntDbDir,
          ntDataDir: path.join(root, entry.name, "nt_qq", "nt_data"),
        });
      }
    }
  }
  return candidates;
};

module.exports = {
  getSettingsStatus,
  saveSecret,
  fetchLlmModels,
  saveLlmConfig,
  saveQqPaths,
  detectQqPaths,
};
