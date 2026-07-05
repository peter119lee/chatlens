[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$NtDbDir,

    [Parameter(Mandatory = $true)]
    [string]$RunDir
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

function Copy-CleanDb {
    param(
        [Parameter(Mandatory = $true)]
        [string]$SourcePath,

        [Parameter(Mandatory = $true)]
        [string]$TargetPath
    )

    if (-not (Test-Path -LiteralPath $SourcePath)) {
        throw "Missing source database: $SourcePath"
    }

    node "$PSScriptRoot\..\src\copy_clean_db.js" $SourcePath $TargetPath 1024
    if ($LASTEXITCODE -ne 0) {
        throw "copy_clean_db failed. Source=$SourcePath Target=$TargetPath ExitCode=$LASTEXITCODE"
    }
}

function Copy-SidecarIfPresent {
    param(
        [Parameter(Mandatory = $true)]
        [string]$SourcePath,

        [Parameter(Mandatory = $true)]
        [string]$TargetPath
    )

    if (Test-Path -LiteralPath $SourcePath) {
        Copy-Item -LiteralPath $SourcePath -Destination $TargetPath -Force
    }
}

function Copy-DatabaseSet {
    param(
        [Parameter(Mandatory = $true)]
        [string]$NtDbDir,

        [Parameter(Mandatory = $true)]
        [string]$SourceName,

        [Parameter(Mandatory = $true)]
        [string]$TargetName,

        [Parameter(Mandatory = $true)]
        [string]$CleanDir
    )

    Copy-CleanDb -SourcePath (Join-Path $NtDbDir $SourceName) -TargetPath (Join-Path $CleanDir $TargetName)
    Copy-SidecarIfPresent -SourcePath (Join-Path $NtDbDir "$SourceName-wal") -TargetPath (Join-Path $CleanDir "$TargetName-wal")
    Copy-SidecarIfPresent -SourcePath (Join-Path $NtDbDir "$SourceName-shm") -TargetPath (Join-Path $CleanDir "$TargetName-shm")
}

$cleanDir = Join-Path $RunDir 'clean-db'
New-Item -ItemType Directory -Force -Path $cleanDir | Out-Null

Copy-DatabaseSet -NtDbDir $NtDbDir -SourceName 'nt_msg.db' -TargetName 'nt_msg.clean.db' -CleanDir $cleanDir
Copy-DatabaseSet -NtDbDir $NtDbDir -SourceName 'group_info.db' -TargetName 'group_info.clean.db' -CleanDir $cleanDir

Write-Output "cleanDir=$cleanDir"
