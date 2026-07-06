const fs = require("node:fs");
const path = require("node:path");
const https = require("node:https");
const { spawn } = require("node:child_process");
const state = require("./toolkit_state");
const jobs = require("./run_jobs");
const packageInfo = require("../../package.json");

const GITHUB_REPO = "peter119lee/chatlens";
const USER_AGENT = `ChatLens/${packageInfo.version} (update-check)`;
const REQUEST_TIMEOUT_MS = 30000;
const MAX_REDIRECTS = 5;
const MAX_DOWNLOAD_BYTES = 200 * 1024 * 1024;

const httpRequest = (url, { asStream = false, redirectsLeft = MAX_REDIRECTS } = {}) =>
  new Promise((resolve, reject) => {
    const request = https.get(
      url,
      {
        headers: {
          "user-agent": USER_AGENT,
          accept: asStream ? "application/octet-stream" : "application/vnd.github+json",
        },
      },
      (response) => {
        const status = response.statusCode ?? 0;
        if (status >= 300 && status < 400 && typeof response.headers.location === "string") {
          response.resume();
          if (redirectsLeft <= 0) {
            reject(new Error("重定向次数过多。"));
            return;
          }
          resolve(httpRequest(new URL(response.headers.location, url).toString(), { asStream, redirectsLeft: redirectsLeft - 1 }));
          return;
        }
        if (status < 200 || status >= 300) {
          response.resume();
          reject(new Error(`GitHub 请求失败（HTTP ${status}）。`));
          return;
        }
        if (asStream) {
          resolve(response);
          return;
        }
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        response.on("error", reject);
      },
    );
    request.setTimeout(REQUEST_TIMEOUT_MS, () => request.destroy(new Error("GitHub 请求超时。")));
    request.on("error", (error) => reject(new Error(`无法连接 GitHub：${error.message}`)));
  });

const parseVersion = (value) =>
  String(value ?? "")
    .replace(/^v/iu, "")
    .split(".")
    .map((part) => Number.parseInt(part, 10) || 0);

const isNewerVersion = (candidate, current) => {
  const left = parseVersion(candidate);
  const right = parseVersion(current);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    if (a !== b) {
      return a > b;
    }
  }
  return false;
};

const checkUpdate = async () => {
  const body = await httpRequest(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`);
  let release;
  try {
    release = JSON.parse(body);
  } catch {
    throw new Error("GitHub 返回的内容无法解析。");
  }
  if (typeof release?.tag_name !== "string") {
    throw new Error("没有找到任何正式发布版本。");
  }
  const latestVersion = release.tag_name.replace(/^v/iu, "");
  return {
    currentVersion: packageInfo.version,
    latestVersion,
    hasUpdate: isNewerVersion(latestVersion, packageInfo.version),
    releaseName: release.name ?? release.tag_name,
    publishedAt: release.published_at ?? null,
    notes: String(release.body ?? "").slice(0, 4000),
    htmlUrl: release.html_url ?? `https://github.com/${GITHUB_REPO}/releases`,
    assets: (release.assets ?? []).map((asset) => ({
      name: String(asset.name ?? ""),
      size: asset.size ?? 0,
      downloadUrl: asset.browser_download_url ?? null,
    })),
  };
};

// Zero-setup bundles ship their own node\node.exe; source installs don't.
// Each flavor must update with its own zip (the bundle carries a matched
// node.exe + prebuilt better_sqlite3.node pair).
const isBundleInstall = () => fs.existsSync(path.join(state.toolRoot, "node", "node.exe"));

const pickAsset = (assets) => {
  const zips = assets.filter((asset) => /\.zip$/iu.test(asset.name) && typeof asset.downloadUrl === "string");
  if (isBundleInstall()) {
    return zips.find((asset) => /win-x64/iu.test(asset.name)) ?? null;
  }
  return zips.find((asset) => !/win-x64/iu.test(asset.name)) ?? zips[0] ?? null;
};

const downloadToFile = async (url, destination) => {
  const response = await httpRequest(url, { asStream: true });
  await new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destination);
    let bytes = 0;
    response.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_DOWNLOAD_BYTES) {
        response.destroy(new Error("下载的安装包超过大小上限。"));
      }
    });
    response.on("error", (error) => {
      file.destroy();
      fs.rmSync(destination, { force: true });
      reject(error);
    });
    file.on("error", reject);
    file.on("finish", resolve);
    response.pipe(file);
  });
};

// Windows PowerShell 5.1 updater: waits for this server to exit, unpacks the
// release zip over the install dir (release zips contain no user data — runs/
// reports/store/config\defaults.json are never inside), then relaunches.
const updaterScriptText = () =>
  [
    "[CmdletBinding()]",
    "param(",
    "    [Parameter(Mandatory = $true)][string]$ZipPath,",
    "    [Parameter(Mandatory = $true)][string]$InstallDir,",
    "    [Parameter(Mandatory = $true)][int]$ServerPid",
    ")",
    "$ErrorActionPreference = 'Stop'",
    "$logPath = Join-Path (Split-Path -Parent $ZipPath) 'update.log'",
    "function Write-Log([string]$Message) {",
    "    (\"[{0}] {1}\" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message) | Out-File -FilePath $logPath -Append -Encoding utf8",
    "}",
    "try {",
    "    Write-Log \"等待控制台进程退出 (PID=$ServerPid)\"",
    "    for ($i = 0; $i -lt 60; $i += 1) {",
    "        if ($null -eq (Get-Process -Id $ServerPid -ErrorAction SilentlyContinue)) { break }",
    "        Start-Sleep -Seconds 1",
    "    }",
    "    Start-Sleep -Seconds 1",
    "",
    "    $extractDir = Join-Path (Split-Path -Parent $ZipPath) 'extracted'",
    "    if (Test-Path -LiteralPath $extractDir) { Remove-Item -LiteralPath $extractDir -Recurse -Force }",
    "    Write-Log \"解压 $ZipPath\"",
    "    Expand-Archive -LiteralPath $ZipPath -DestinationPath $extractDir -Force",
    "",
    "    $sourceDir = $extractDir",
    "    $children = @(Get-ChildItem -LiteralPath $extractDir)",
    "    if ($children.Count -eq 1 -and $children[0].PSIsContainer) { $sourceDir = $children[0].FullName }",
    "",
    "    Write-Log \"覆盖安装到 $InstallDir\"",
    "    Copy-Item -Path (Join-Path $sourceDir '*') -Destination $InstallDir -Recurse -Force",
    "",
    "    Remove-Item -LiteralPath $extractDir -Recurse -Force",
    "    Remove-Item -LiteralPath $ZipPath -Force",
    "    Write-Log '更新完成，重新启动控制台。'",
    "",
    "    $launcher = Join-Path $InstallDir 'Start-QQ-Console.cmd'",
    "    if (Test-Path -LiteralPath $launcher) {",
    "        Start-Process -FilePath $launcher -WorkingDirectory $InstallDir",
    "    }",
    "} catch {",
    "    Write-Log ('更新失败: ' + $_.Exception.Message)",
    "}",
    "",
  ].join("\r\n");

const applyUpdate = async () => {
  if (jobs.jobSnapshot(0).job?.status === "running") {
    throw new Error("有任务正在运行，请等它完成后再更新。");
  }

  const info = await checkUpdate();
  if (!info.hasUpdate) {
    throw new Error(`当前已是最新版本（v${info.currentVersion}）。`);
  }
  const asset = pickAsset(info.assets);
  if (asset === null) {
    throw new Error("最新版本没有适用于本安装方式的 zip 安装包。");
  }

  const updateDir = path.join(state.toolRoot, "dist", "update");
  fs.mkdirSync(updateDir, { recursive: true });
  const zipPath = path.join(updateDir, asset.name);
  await downloadToFile(asset.downloadUrl, zipPath);

  // BOM so Windows PowerShell 5.1 reads the Chinese log strings correctly.
  const scriptPath = path.join(updateDir, "apply_update.ps1");
  fs.writeFileSync(scriptPath, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(updaterScriptText(), "utf8")]));

  const child = spawn("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    scriptPath,
    "-ZipPath",
    zipPath,
    "-InstallDir",
    state.toolRoot,
    "-ServerPid",
    String(process.pid),
  ], { detached: true, stdio: "ignore", windowsHide: true });
  child.unref();

  // Let the HTTP response flush, then exit so the updater can swap files.
  setTimeout(() => process.exit(0), 800);
  return { updating: true, targetVersion: info.latestVersion };
};

module.exports = { checkUpdate, applyUpdate };
