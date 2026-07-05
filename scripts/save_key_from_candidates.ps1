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
$defaultCandidatePath = 'C:\Users\User\Documents\Codex\2026-07-02\i-a\work\qq-summarizer\data\memory-candidates.txt'
$defaultCleanDatabasePath = 'C:\Users\User\Documents\Codex\2026-07-02\i-a\work\qq-summarizer\data\nt_msg.clean.db'
$actualCandidatePath = if ([string]::IsNullOrWhiteSpace($CandidatePath)) {
    $defaultCandidatePath
} else {
    $CandidatePath
}

if (-not (Test-Path -LiteralPath $actualCandidatePath)) {
    throw "Candidate file does not exist: $actualCandidatePath"
}

$actualDatabasePath = if ([string]::IsNullOrWhiteSpace($DatabasePath)) {
    $defaultCleanDatabasePath
} else {
    $DatabasePath
}

if (-not (Test-Path -LiteralPath $actualDatabasePath)) {
    throw "Clean QQNT database does not exist: $actualDatabasePath. Run prepare_clean_dbs.ps1 first, then pass -DatabasePath to the generated nt_msg.clean.db."
}

$secretDir = Join-Path $env:APPDATA 'QQSummaryTools'
$secretPath = Join-Path $secretDir 'ntqq-db-key.dpapi'

node (Join-Path $toolRoot 'src\save_key_from_candidates.js') $actualDatabasePath $actualCandidatePath $secretPath
if ($LASTEXITCODE -ne 0) {
    throw "Failed to find and save a usable NTQQ DB key from candidates. CandidatePath=$actualCandidatePath DatabasePath=$actualDatabasePath ExitCode=$LASTEXITCODE"
}
