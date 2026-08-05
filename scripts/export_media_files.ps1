[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$RunDir,

    [Parameter(Mandatory = $true)]
    [string]$NtDataDir,

    [Parameter(Mandatory = $true)]
    [string]$FormatsCsv,

    [Parameter(Mandatory = $true)]
    [string]$ObjectDir,

    [Parameter(Mandatory = $true)]
    [string]$KnowledgeDbPath,

    [Parameter(Mandatory = $true)]
    [string]$ToolRoot
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

# 媒体导出是可降级步骤：入参缺失时警告后跳过（exit 0），不拖垮整个运行。
$mediaMessagesJson = Join-Path $RunDir 'analysis\media-messages.json'
if (-not (Test-Path -LiteralPath $mediaMessagesJson)) {
    Write-Warning "找不到媒体消息清单，跳过媒体导出: $mediaMessagesJson"
    exit 0
}

if ([string]::IsNullOrWhiteSpace($NtDataDir) -or -not (Test-Path -LiteralPath $NtDataDir)) {
    Write-Warning "QQNT nt_data 目录不存在，跳过媒体导出: $NtDataDir"
    exit 0
}

$mediaDir = Join-Path $RunDir 'media'
node "$PSScriptRoot\..\src\export_media_files.js" `
    $mediaMessagesJson `
    $NtDataDir `
    $mediaDir `
    $FormatsCsv `
    $ObjectDir `
    $KnowledgeDbPath `
    $ToolRoot
if ($LASTEXITCODE -ne 0) {
    throw "媒体导出失败。RunDir=$RunDir NtDataDir=$NtDataDir ExitCode=$LASTEXITCODE"
}
