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
        throw "找不到源数据库: $SourcePath（请在设置页检查 QQ 数据库路径）"
    }

    # QQ 正在写库时可能拷到撕裂的副本，重试几次能显著降低概率。
    $maxAttempts = 3
    for ($attempt = 1; $attempt -le $maxAttempts; $attempt += 1) {
        node "$PSScriptRoot\..\src\copy_clean_db.js" $SourcePath $TargetPath 1024
        if ($LASTEXITCODE -eq 0) {
            return
        }
        if ($attempt -lt $maxAttempts) {
            Write-Warning "数据库副本拷贝失败（第 $attempt 次），2 秒后重试…"
            Start-Sleep -Seconds 2
        }
    }
    throw "数据库副本拷贝失败。Source=$SourcePath Target=$TargetPath ExitCode=$LASTEXITCODE"
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

    # 先拷 WAL 再拷主库：若两次拷贝之间 QQ 做了 checkpoint，被写回主库的页会出现
    # 在稍后拷的主库副本里，旧 WAL 副本重放的只是相同内容（无害）；反过来先拷主库，
    # 这些页会两边都没有，等于悄悄丢掉最近几分钟的消息。
    Copy-SidecarIfPresent -SourcePath (Join-Path $NtDbDir "$SourceName-wal") -TargetPath (Join-Path $CleanDir "$TargetName-wal")
    Copy-SidecarIfPresent -SourcePath (Join-Path $NtDbDir "$SourceName-shm") -TargetPath (Join-Path $CleanDir "$TargetName-shm")
    Copy-CleanDb -SourcePath (Join-Path $NtDbDir $SourceName) -TargetPath (Join-Path $CleanDir $TargetName)
}

$cleanDir = Join-Path $RunDir 'clean-db'
New-Item -ItemType Directory -Force -Path $cleanDir | Out-Null

Copy-DatabaseSet -NtDbDir $NtDbDir -SourceName 'nt_msg.db' -TargetName 'nt_msg.clean.db' -CleanDir $cleanDir
Copy-DatabaseSet -NtDbDir $NtDbDir -SourceName 'group_info.db' -TargetName 'group_info.clean.db' -CleanDir $cleanDir

Write-Output "cleanDir=$cleanDir"
