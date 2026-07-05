[CmdletBinding()]
param(
    [Parameter(Mandatory = $false)]
    [string]$ConfigPath,

    [Parameter(Mandatory = $false)]
    [string]$OutputPath
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
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$runDir = Join-Path ([string]$config.runsDir) "list-groups-$stamp"
$actualOutputPath = if ([string]::IsNullOrWhiteSpace($OutputPath)) {
    Join-Path ([string]$config.reportsDir) "group-list-$stamp.txt"
} else {
    $OutputPath
}

$oldKey = $env:NTQQ_DB_KEY
try {
    $env:NTQQ_DB_KEY = Read-SavedNtqqKey
    Push-Location $toolRoot
    try {
        npm run prepare-clean-dbs -- -NtDbDir ([string]$config.ntDbDir) -RunDir $runDir
    } finally {
        Pop-Location
    }

    node (Join-Path $toolRoot 'src\list_groups.js') (Join-Path $runDir 'clean-db\group_info.clean.db') $actualOutputPath
    Write-Output ""
    Write-Output "runDir=$runDir"
    Write-Output "groupListPath=$actualOutputPath"
} finally {
    $env:NTQQ_DB_KEY = $oldKey
}
