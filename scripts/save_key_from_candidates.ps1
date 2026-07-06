[CmdletBinding()]
param(
    [Parameter(Mandatory = $false)]
    [string]$ConfigPath,

    [Parameter(Mandatory = $false)]
    [string]$CandidatePath,

    [Parameter(Mandatory = $false)]
    [string]$DatabasePath
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

. "$PSScriptRoot\common.ps1"

$toolRoot = Split-Path -Parent $PSScriptRoot
$actualConfigPath = if ([string]::IsNullOrWhiteSpace($ConfigPath)) {
    Join-Path $toolRoot 'config\defaults.json'
} else {
    $ConfigPath
}

$config = Read-ToolkitConfig -Path $actualConfigPath
$actualCandidatePath = if ([string]::IsNullOrWhiteSpace($CandidatePath)) {
    throw '请传 -CandidatePath <memory-candidates.txt>（内存扫描导出的密钥候选文件）。若已知道密钥，请改用 save_key.ps1 选项 2 或网页控制台的设置页。'
} else {
    $CandidatePath
}

if (-not (Test-Path -LiteralPath $actualCandidatePath)) {
    throw "候选文件不存在: $actualCandidatePath"
}

$actualDatabasePath = if ([string]::IsNullOrWhiteSpace($DatabasePath)) {
    throw '请传 -DatabasePath <nt_msg.clean.db>（可先用 prepare_clean_dbs.ps1 生成）。'
} else {
    $DatabasePath
}

if (-not (Test-Path -LiteralPath $actualDatabasePath)) {
    throw "QQNT 数据库副本不存在: $actualDatabasePath。请先运行 prepare_clean_dbs.ps1，再把生成的 nt_msg.clean.db 传给 -DatabasePath。"
}

$secretDir = Join-Path $env:APPDATA 'QQSummaryTools'
$secretPath = Join-Path $secretDir 'ntqq-db-key.dpapi'

node (Join-Path $toolRoot 'src\save_key_from_candidates.js') $actualDatabasePath $actualCandidatePath $secretPath
if ($LASTEXITCODE -ne 0) {
    throw "没能从候选中找到可用的 NTQQ 数据库密钥。CandidatePath=$actualCandidatePath DatabasePath=$actualDatabasePath ExitCode=$LASTEXITCODE"
}
