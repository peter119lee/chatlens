[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$PlanPath
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

. "$PSScriptRoot\common.ps1"

function Get-DatabaseSnapshotBytes {
    param(
        [Parameter(Mandatory = $true)]
        [string]$NtDbDir
    )

    $requiredFiles = @('nt_msg.db', 'group_info.db')
    foreach ($name in $requiredFiles) {
        $filePath = Join-Path $NtDbDir $name
        if (-not (Test-Path -LiteralPath $filePath)) {
            throw "补扫需要的 QQ 数据库不存在。Path=$filePath"
        }
    }

    $names = @(
        'nt_msg.db', 'nt_msg.db-wal', 'nt_msg.db-shm',
        'group_info.db', 'group_info.db-wal', 'group_info.db-shm'
    )
    [long]($names | ForEach-Object {
        $filePath = Join-Path $NtDbDir $_
        if (Test-Path -LiteralPath $filePath) {
            (Get-Item -LiteralPath $filePath).Length
        }
    } | Measure-Object -Sum).Sum
}

function Assert-RepairDiskSpace {
    param(
        [Parameter(Mandatory = $true)]
        [string]$TargetPath,

        [Parameter(Mandatory = $true)]
        [long]$SnapshotBytes
    )

    $driveRoot = [System.IO.Path]::GetPathRoot([System.IO.Path]::GetFullPath($TargetPath))
    $driveName = $driveRoot.TrimEnd('\').TrimEnd(':')
    $drive = Get-PSDrive -Name $driveName -ErrorAction Stop
    $headroomBytes = [long][math]::Max([long](4GB), [math]::Ceiling($SnapshotBytes * 0.1))
    $requiredBytes = $SnapshotBytes + $headroomBytes
    if ([long]$drive.Free -lt $requiredBytes) {
        $freeGb = [math]::Round([long]$drive.Free / 1GB, 2)
        $requiredGb = [math]::Round($requiredBytes / 1GB, 2)
        $snapshotGb = [math]::Round($SnapshotBytes / 1GB, 2)
        $headroomGb = [math]::Round($headroomBytes / 1GB, 2)
        throw "磁盘空间不足，未启动补扫。Drive=$driveRoot FreeGB=$freeGb RequiredGB=$requiredGb SnapshotGB=$snapshotGb HeadroomGB=$headroomGb"
    }
}

function Remove-RepairWorkDir {
    param(
        [Parameter(Mandatory = $true)]
        [string]$PlanRoot,

        [Parameter(Mandatory = $true)]
        [string]$WorkDir
    )

    $resolvedRoot = [System.IO.Path]::GetFullPath($PlanRoot).TrimEnd('\')
    $resolvedWork = [System.IO.Path]::GetFullPath($WorkDir)
    if (-not $resolvedWork.StartsWith("$resolvedRoot\", [System.StringComparison]::OrdinalIgnoreCase) -or -not $resolvedWork.EndsWith('.work')) {
        throw "拒绝删除补扫目录之外的路径。PlanRoot=$resolvedRoot WorkDir=$resolvedWork"
    }
    if (Test-Path -LiteralPath $resolvedWork) {
        Remove-Item -LiteralPath $resolvedWork -Recurse -Force
    }
}

$resolvedPlanPath = [System.IO.Path]::GetFullPath($PlanPath)
if (-not (Test-Path -LiteralPath $resolvedPlanPath)) {
    throw "找不到覆盖补扫计划。PlanPath=$resolvedPlanPath"
}
$plan = Get-Content -LiteralPath $resolvedPlanPath -Raw | ConvertFrom-Json
$planId = [string]$plan.planId
if ($planId -notmatch '^[a-f0-9]{24}$') {
    throw "覆盖补扫计划 ID 无效。PlanPath=$resolvedPlanPath PlanId=$planId"
}

$toolRoot = Split-Path -Parent $PSScriptRoot
$configPath = Join-Path $toolRoot 'config\defaults.json'
$config = Read-ToolkitConfig -Path $configPath
$ntDbDir = [string]$config.ntDbDir
if ([string]::IsNullOrWhiteSpace($ntDbDir)) {
    throw "配置缺少 ntDbDir，无法创建只读数据库副本。ConfigPath=$configPath"
}
$scanLimit = [int]$config.defaultScanLimit
if ($scanLimit -le 0) {
    throw "配置中的 defaultScanLimit 必须大于 0。Value=$scanLimit ConfigPath=$configPath"
}

$planRoot = Split-Path -Parent $resolvedPlanPath
$workDir = Join-Path $planRoot "$planId.work"
$statePath = Join-Path $planRoot "$planId.state.json"
$cleanDir = Join-Path $workDir 'clean-db'
$cleanMessageDb = Join-Path $cleanDir 'nt_msg.clean.db'
$cleanGroupDb = Join-Path $cleanDir 'group_info.clean.db'
$chunkDir = Join-Path $workDir 'chunks'
$storeDb = Join-Path $toolRoot 'store\messages.db'
$oldKey = $env:NTQQ_DB_KEY

try {
    [System.Diagnostics.Process]::GetCurrentProcess().PriorityClass = 'BelowNormal'
    $env:NTQQ_DB_KEY = Read-SavedNtqqKey
    Write-Output 'progress=coverage-copy-start'
    if ((Test-Path -LiteralPath $cleanMessageDb) -and (Test-Path -LiteralPath $cleanGroupDb)) {
        Write-Output "coverageSnapshot=reused path=$cleanDir"
    } else {
        Remove-RepairWorkDir -PlanRoot $planRoot -WorkDir $workDir
        New-Item -ItemType Directory -Force -Path $workDir | Out-Null
        $snapshotBytes = Get-DatabaseSnapshotBytes -NtDbDir $ntDbDir
        Assert-RepairDiskSpace -TargetPath $workDir -SnapshotBytes $snapshotBytes
        & "$PSScriptRoot\prepare_clean_dbs.ps1" -NtDbDir $ntDbDir -RunDir $workDir
        if ($LASTEXITCODE -ne 0) {
            throw "复制覆盖补扫数据库失败。ExitCode=$LASTEXITCODE PlanId=$planId WorkDir=$workDir"
        }
    }
    Write-Output 'progress=coverage-copy-done'

    Write-Output 'progress=coverage-repair-start'
    & node (Join-Path $toolRoot 'src\coverage_repair.js') `
        $resolvedPlanPath `
        $statePath `
        $cleanMessageDb `
        $cleanGroupDb `
        $storeDb `
        $scanLimit `
        $chunkDir
    if ($LASTEXITCODE -ne 0) {
        throw "覆盖补扫失败，可再次点击同一缺口继续。ExitCode=$LASTEXITCODE PlanId=$planId StatePath=$statePath WorkDir=$workDir"
    }

    Write-Output 'progress=coverage-cleanup-start'
    Remove-RepairWorkDir -PlanRoot $planRoot -WorkDir $workDir
    Write-Output 'progress=coverage-cleanup-done'
} finally {
    $env:NTQQ_DB_KEY = $oldKey
}
