const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const state = require("./toolkit_state");
const { quotePs } = require("./run_jobs");
const packageInfo = require("../../package.json");

const SECRET_DIR = path.join(process.env.APPDATA ?? "", "QQSummaryTools");
const SECRET_FILES = {
  ntqqKey: "ntqq-db-key.dpapi",
  llmKey: "deepseek-api-key.dpapi",
};
const BASE_URL_PATTERN = /^https?:\/\/[\w.-]+(?::\d+)?(?:\/[\w./-]*)?$/u;
const MODEL_NAME_PATTERN = /^[\w.:/-]{1,64}$/u;
// Absolute Windows directory without quote-breaking or illegal path characters —
// these values later travel through PowerShell/npm command lines.
const WINDOWS_DIR_PATTERN = /^[A-Za-z]:[\\/][^"<>|]*$/u;
const hasControlChar = (value) => [...String(value)].some((ch) => ch.codePointAt(0) < 32);

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
  const retentionDays = Number(config.store?.retentionDays);
  return {
    version: packageInfo.version,
    ntqqKeySaved: fs.existsSync(path.join(SECRET_DIR, SECRET_FILES.ntqqKey)),
    llmKeySaved: fs.existsSync(path.join(SECRET_DIR, SECRET_FILES.llmKey)),
    ntDbDir: config.ntDbDir ?? "",
    ntDataDir: config.ntDataDir ?? "",
    store: {
      retentionDays: Number.isFinite(retentionDays) && retentionDays > 0 ? retentionDays : 30,
    },
    llm: {
      baseUrl: config.llm?.baseUrl ?? "",
      model: config.llm?.model ?? "",
    },
  };
};

const saveStoreConfig = ({ retentionDays }) => {
  const days = Number.parseInt(retentionDays, 10);
  if (!Number.isInteger(days) || days < 1 || days > 365) {
    throw new Error("保留天数应为 1-365 的整数。");
  }
  const config = state.loadRawConfig();
  saveConfigPatch({ store: { ...(config.store ?? {}), retentionDays: days } });
  return { retentionDays: days };
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
// Always fetches from the base URL already persisted in config: the stored key
// must never be sent to a caller-supplied URL.
const fetchLlmModels = async () => {
  const config = state.loadConfig();
  const trimmed = String(config.llm?.baseUrl ?? "").trim().replace(/\/+$/u, "");
  if (!BASE_URL_PATTERN.test(trimmed)) {
    throw new Error("先保存 LLM 配置（API 地址），再获取模型列表。");
  }
  if (!fs.existsSync(path.join(SECRET_DIR, SECRET_FILES.llmKey))) {
    throw new Error("先在上方保存 LLM API key，再获取模型列表。");
  }

  const commonPs = path.join(state.toolRoot, "scripts", "common.ps1");
  const command = [
    "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
    "$ErrorActionPreference = 'Stop'",
    `. ${quotePs(commonPs)}`,
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

// Patch against the raw on-disk config and write atomically (via toolkit_state)
// so relative dirs stay relative and concurrent readers never see a torn file.
const saveConfigPatch = (patch) => {
  state.writeConfig({ ...state.loadRawConfig(), ...patch });
};

const saveLlmConfig = ({ baseUrl, model }) => {
  const trimmedUrl = String(baseUrl ?? "").trim().replace(/\/+$/u, "");
  const trimmedModel = String(model ?? "").trim();
  if (!BASE_URL_PATTERN.test(trimmedUrl)) {
    throw new Error("baseUrl 格式不对，应类似 https://api.deepseek.com");
  }
  const config = state.loadRawConfig();
  // An empty model keeps the previously saved one, so the base URL can be
  // saved (and models listed) before a model has been picked.
  const nextModel = trimmedModel.length > 0 ? trimmedModel : String(config.llm?.model ?? "");
  if (nextModel.length > 0 && !MODEL_NAME_PATTERN.test(nextModel)) {
    throw new Error("模型名格式不对。");
  }
  saveConfigPatch({ llm: { ...(config.llm ?? {}), provider: "deepseek", baseUrl: trimmedUrl, model: nextModel } });
  return { baseUrl: trimmedUrl, model: nextModel };
};

const saveQqPaths = ({ ntDbDir, ntDataDir }) => {
  const dbDir = String(ntDbDir ?? "").trim();
  const dataDir = String(ntDataDir ?? "").trim();
  if (dbDir.length === 0) {
    throw new Error("nt_db 目录不能为空。");
  }
  if (!WINDOWS_DIR_PATTERN.test(dbDir) || hasControlChar(dbDir)) {
    throw new Error("nt_db 目录应为绝对路径（例如 C:\\...\\nt_qq\\nt_db），且不能包含 \" < > | 字符。");
  }
  if (dataDir.length > 0 && (!WINDOWS_DIR_PATTERN.test(dataDir) || hasControlChar(dataDir))) {
    throw new Error("nt_data 目录应为绝对路径，且不能包含 \" < > | 字符。");
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
// QQ defaults to Documents\Tencent Files, but the storage location is
// user-configurable — also probe <drive>:\Tencent Files on every drive letter
// (each base plus its nested "Tencent Files\Tencent Files" layout).
const detectQqPaths = () => {
  const candidates = [];
  const bases = [
    path.join(os.homedir(), "Documents", "Tencent Files"),
    // OneDrive-redirected Documents (common on consumer Windows installs)
    // lives outside os.homedir()/Documents and used to defeat auto-detection.
    ...(process.env.OneDrive ? [path.join(process.env.OneDrive, "Documents", "Tencent Files")] : []),
    path.join(os.homedir(), "OneDrive", "Documents", "Tencent Files"),
  ];
  for (let code = 67; code <= 90; code += 1) {
    bases.push(`${String.fromCharCode(code)}:\\Tencent Files`);
  }
  const roots = [];
  for (const base of bases) {
    roots.push(base, path.join(base, "Tencent Files"));
  }
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
      if (fs.existsSync(ntDbDir) && !candidates.some((candidate) => candidate.ntDbDir === ntDbDir)) {
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
  saveStoreConfig,
  saveSecret,
  fetchLlmModels,
  saveLlmConfig,
  saveQqPaths,
  detectQqPaths,
};
