[CmdletBinding()]
param(
    [Parameter(Mandatory = $false)]
    [string]$ConfigPath,

    [Parameter(Mandatory = $false)]
    [switch]$DeleteRunsWithoutReports,

    [Parameter(Mandatory = $false)]
    [int]$DeleteRunsOlderThanDays
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

. "$PSScriptRoot\common.ps1"

function Get-DirectoryBytes {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    if (-not (Test-Path -LiteralPath $Path)) {
        return 0
    }

    [int64]((Get-ChildItem -LiteralPath $Path -Recurse -File -Force | Measure-Object Length -Sum).Sum)
}

function Remove-ChildDirectory {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ParentDir,

        [Parameter(Mandatory = $true)]
        [string]$ChildDir
    )

    $parent = (Resolve-Path -LiteralPath $ParentDir).Path
    $target = (Resolve-Path -LiteralPath $ChildDir).Path
    $expectedPrefix = $parent.TrimEnd('\') + '\'
    if (-not $target.StartsWith($expectedPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to remove directory outside parent. Parent=$parent Target=$target"
    }

    $bytes = Get-DirectoryBytes -Path $target
    Remove-Item -LiteralPath $target -Recurse -Force
    $bytes
}

$toolRoot = Split-Path -Parent $PSScriptRoot
$actualConfigPath = if ([string]::IsNullOrWhiteSpace($ConfigPath)) {
    Join-Path $toolRoot 'config\defaults.json'
} else {
    $ConfigPath
}

$config = Read-ToolkitConfig -Path $actualConfigPath
$runsDir = [string]$config.runsDir
$reportsDir = [string]$config.reportsDir

if (-not (Test-Path -LiteralPath $runsDir)) {
    Write-Output "runsDirMissing=$runsDir"
    return
}

$removedCleanDbBytes = [int64]0
$removedRunsBytes = [int64]0
$removedCleanDbCount = 0
$removedRunCount = 0
$cutoff = if ($DeleteRunsOlderThanDays -gt 0) { (Get-Date).AddDays(-1 * $DeleteRunsOlderThanDays) } else { $null }

foreach ($run in Get-ChildItem -LiteralPath $runsDir -Directory -Force) {
    $cleanDb = Join-Path $run.FullName 'clean-db'
    if (Test-Path -LiteralPath $cleanDb) {
        $removedCleanDbBytes += Remove-ChildDirectory -ParentDir $run.FullName -ChildDir $cleanDb
        $removedCleanDbCount += 1
    }

    $runId = $run.Name
    $htmlReport = Join-Path $reportsDir "$runId.html"
    $mdReport = Join-Path $reportsDir "$runId.md"
    $hasReport = (Test-Path -LiteralPath $htmlReport) -or (Test-Path -LiteralPath $mdReport)
    $olderThanCutoff = $null -ne $cutoff -and $run.LastWriteTime -lt $cutoff
    if (($DeleteRunsWithoutReports.IsPresent -and -not $hasReport) -or $olderThanCutoff) {
        $removedRunsBytes += Remove-ChildDirectory -ParentDir $runsDir -ChildDir $run.FullName
        $removedRunCount += 1
    }
}

Write-Output "removedCleanDbCount=$removedCleanDbCount"
Write-Output "removedCleanDbBytes=$removedCleanDbBytes"
Write-Output "removedRunCount=$removedRunCount"
Write-Output "removedRunBytes=$removedRunsBytes"
