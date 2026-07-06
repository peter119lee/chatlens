[CmdletBinding()]
param(
    [Parameter(Mandatory = $false)]
    [string]$ConfigPath,

    [Parameter(Mandatory = $false)]
    [ValidateSet('time', 'unread')]
    [string]$Mode,

    [Parameter(Mandatory = $false)]
    [string[]]$GroupIds,

    [Parameter(Mandatory = $false)]
    [string]$GroupListFile,

    [Parameter(Mandatory = $false)]
    [switch]$UseWatchlist,

    [Parameter(Mandatory = $false)]
    [int]$Days,

    [Parameter(Mandatory = $false)]
    [int]$SinceHours,

    [Parameter(Mandatory = $false)]
    [string]$StartTime,

    [Parameter(Mandatory = $false)]
    [string]$EndTime,

    # 从消息库 scan_ranges 的记录点续扫（定时任务用，停机多久都不漏）。
    [Parameter(Mandatory = $false)]
    [switch]$SinceLastRecord,

    [Parameter(Mandatory = $false)]
    [int]$ScanLimit,

    [Parameter(Mandatory = $false)]
    [switch]$ExportMedia,

    [Parameter(Mandatory = $false)]
    [string]$MediaFormats,

    [Parameter(Mandatory = $false)]
    [switch]$UseLlm,

    [Parameter(Mandatory = $false)]
    [string]$LlmProvider,

    [Parameter(Mandatory = $false)]
    [string]$LlmBaseUrl,

    [Parameter(Mandatory = $false)]
    [string]$LlmModel,

    [Parameter(Mandatory = $false)]
    [int]$LlmMaxMessages,

    [Parameter(Mandatory = $false)]
    [int]$LlmMaxChars,

    [Parameter(Mandatory = $false)]
    [switch]$KeepCleanDb,

    [Parameter(Mandatory = $false)]
    [switch]$OpenReport,

    # Presence-only override for hosts that cannot pass -OpenReport:$false (powershell -File).
    [Parameter(Mandatory = $false)]
    [switch]$NoOpenReport
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

. "$PSScriptRoot\common.ps1"

function Get-SelectedGroupIds {
    param(
        [Parameter(Mandatory = $false)]
        [AllowNull()]
        [AllowEmptyString()]
        [AllowEmptyCollection()]
        [string[]]$RawGroupIds,

        [Parameter(Mandatory = $false)]
        [string]$RawGroupListFile,

        [Parameter(Mandatory = $true)]
        [AllowNull()]
        [object]$Config
    )

    $rawValues = if ($null -eq $RawGroupIds) { @() } else { @($RawGroupIds) }
    $values = @(ConvertTo-GroupIdList -Values $rawValues)

    if (-not [string]::IsNullOrWhiteSpace($RawGroupListFile)) {
        $values += Read-GroupIdListFile -Path $RawGroupListFile
    }

    if (@($values).Length -eq 0 -and $null -ne $Config.defaultGroupIds) {
        $values += ConvertTo-GroupIdList -Values @($Config.defaultGroupIds)
    }

    $selected = ConvertTo-GroupIdList -Values $values
    if (@($selected).Length -eq 0) {
        throw '没有可用的群号。请传 -GroupIds "123,456"、-GroupListFile ".\groups.txt"，或使用 -UseWatchlist。'
    }

    @($selected)
}

function Get-TimeRange {
    param(
        [Parameter(Mandatory = $false)]
        [string]$RawStartTime,

        [Parameter(Mandatory = $false)]
        [string]$RawEndTime,

        [Parameter(Mandatory = $true)]
        [int]$RawSinceHours,

        [Parameter(Mandatory = $true)]
        [int]$RawDays,

        [Parameter(Mandatory = $true)]
        [int]$DefaultDays
    )

    $now = [DateTimeOffset]::Now

    if (-not [string]::IsNullOrWhiteSpace($RawStartTime) -or -not [string]::IsNullOrWhiteSpace($RawEndTime)) {
        if ([string]::IsNullOrWhiteSpace($RawStartTime)) {
            throw '提供了结束时间时必须同时提供开始时间（-StartTime）。'
        }

        $startUnix = ConvertTo-UnixTimeFromLocalText -Text $RawStartTime
        $endUnix = if ([string]::IsNullOrWhiteSpace($RawEndTime)) {
            $now.ToUnixTimeSeconds()
        } else {
            ConvertTo-UnixTimeFromLocalText -Text $RawEndTime
        }

        return [pscustomobject]@{
            StartUnix = $startUnix
            EndUnix = $endUnix
            Label = 'custom'
        }
    }

    if ($RawSinceHours -gt 0) {
        return [pscustomobject]@{
            StartUnix = $now.AddHours(-1 * $RawSinceHours).ToUnixTimeSeconds()
            EndUnix = $now.ToUnixTimeSeconds()
            Label = "last-${RawSinceHours}h"
        }
    }

    $actualDays = if ($RawDays -gt 0) { $RawDays } else { $DefaultDays }
    if ($actualDays -le 0) {
        throw "没有有效的时间范围。请传 -SinceHours、-Days 或 -StartTime。DefaultDays=$DefaultDays"
    }

    [pscustomobject]@{
        StartUnix = $now.AddDays(-1 * $actualDays).ToUnixTimeSeconds()
        EndUnix = $now.ToUnixTimeSeconds()
        Label = "last-${actualDays}d"
    }
}

function Get-RunId {
    param(
        [Parameter(Mandatory = $true)]
        [string[]]$SelectedGroupIds,

        [Parameter(Mandatory = $true)]
        [string]$ActualMode,

        [Parameter(Mandatory = $true)]
        [string]$RangeLabel
    )

    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $groupHash = Get-ShortStableHash -Text (Join-GroupIdsCsv -GroupIds $SelectedGroupIds)
    "qq-$ActualMode-$RangeLabel-$groupHash-$stamp"
}

function Get-LlmOptions {
    param(
        [Parameter(Mandatory = $true)]
        [AllowNull()]
        [object]$Config,

        [Parameter(Mandatory = $false)]
        [string]$RawProvider,

        [Parameter(Mandatory = $false)]
        [string]$RawBaseUrl,

        [Parameter(Mandatory = $false)]
        [string]$RawModel,

        [Parameter(Mandatory = $true)]
        [int]$RawMaxMessages,

        [Parameter(Mandatory = $true)]
        [int]$RawMaxChars
    )

    $llmProperty = $Config.PSObject.Properties['llm']
    if ($null -eq $llmProperty) {
        throw '配置缺少 llm 设置。请在 config\defaults.json 补充 llm.provider/baseUrl/model/apiKeyEnv/maxMessages/maxChars，或显式传 LLM 参数。'
    }

    $llmConfig = $llmProperty.Value
    $providerConfig = $llmConfig.PSObject.Properties['provider']
    $baseUrlConfig = $llmConfig.PSObject.Properties['baseUrl']
    $modelConfig = $llmConfig.PSObject.Properties['model']
    $apiKeyEnvConfig = $llmConfig.PSObject.Properties['apiKeyEnv']
    $maxMessagesConfig = $llmConfig.PSObject.Properties['maxMessages']
    $maxCharsConfig = $llmConfig.PSObject.Properties['maxChars']

    $provider = if (-not [string]::IsNullOrWhiteSpace($RawProvider)) { $RawProvider } elseif ($null -ne $providerConfig) { [string]$providerConfig.Value } else { '' }
    if ([string]::IsNullOrWhiteSpace($provider)) {
        throw '启用 UseLlm 时必须提供 LLM provider。'
    }

    switch ($provider) {
        'deepseek' {
            $baseUrl = if (-not [string]::IsNullOrWhiteSpace($RawBaseUrl)) { $RawBaseUrl } elseif ($null -ne $baseUrlConfig) { [string]$baseUrlConfig.Value } else { '' }
            $model = if (-not [string]::IsNullOrWhiteSpace($RawModel)) { $RawModel } elseif ($null -ne $modelConfig) { [string]$modelConfig.Value } else { '' }
            $apiKeyEnv = if ($null -eq $apiKeyEnvConfig -or [string]::IsNullOrWhiteSpace([string]$apiKeyEnvConfig.Value)) { 'DEEPSEEK_API_KEY' } else { [string]$apiKeyEnvConfig.Value }
            $maxMessages = if ($RawMaxMessages -gt 0) { $RawMaxMessages } elseif ($null -ne $maxMessagesConfig) { [int]$maxMessagesConfig.Value } else { 400 }
            $maxChars = if ($RawMaxChars -gt 0) { $RawMaxChars } elseif ($null -ne $maxCharsConfig) { [int]$maxCharsConfig.Value } else { 50000 }

            if ([string]::IsNullOrWhiteSpace($baseUrl)) {
                throw 'provider 为 deepseek 时必须提供 LLM baseUrl。'
            }

            if ([string]::IsNullOrWhiteSpace($model)) {
                throw 'provider 为 deepseek 时必须提供 LLM model。'
            }

            $configuredApiKey = [System.Environment]::GetEnvironmentVariable($apiKeyEnv, 'Process')
            if ([string]::IsNullOrWhiteSpace($configuredApiKey)) {
                [System.Environment]::SetEnvironmentVariable(
                    $apiKeyEnv,
                    (Read-SavedSecret -FileName 'deepseek-api-key.dpapi' -SecretName 'DeepSeek API key'),
                    'Process'
                )
            }

            return [pscustomobject]@{
                Provider = $provider
                BaseUrl = $baseUrl
                Model = $model
                ApiKeyEnv = $apiKeyEnv
                PreviousApiKeyValue = $configuredApiKey
                MaxMessages = $maxMessages
                MaxChars = $maxChars
            }
        }
        default {
            throw "不支持的 LLM 提供商 '$provider'。目前支持: deepseek。"
        }
    }
}

function Remove-GeneratedCleanDb {
    param(
        [Parameter(Mandatory = $true)]
        [string]$RunDir
    )

    $cleanDb = Join-Path $RunDir 'clean-db'
    if (-not (Test-Path -LiteralPath $cleanDb)) {
        return $false
    }

    $runRoot = (Resolve-Path -LiteralPath $RunDir).Path
    $target = (Resolve-Path -LiteralPath $cleanDb).Path
    $expectedPrefix = $runRoot.TrimEnd('\') + '\'
    if (-not $target.StartsWith($expectedPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "拒绝删除 run 目录之外的 clean-db。RunDir=$runRoot Target=$target"
    }

    Remove-Item -LiteralPath $target -Recurse -Force
    $true
}

function ConvertTo-FileUrl {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    $fullPath = [System.IO.Path]::GetFullPath($Path)
    'file:///' + ($fullPath -replace '\\', '/')
}

$toolRoot = Split-Path -Parent $PSScriptRoot
$actualConfigPath = if ([string]::IsNullOrWhiteSpace($ConfigPath)) {
    Join-Path $toolRoot 'config\defaults.json'
} else {
    $ConfigPath
}

$config = Read-ToolkitConfig -Path $actualConfigPath
$actualMode = if ([string]::IsNullOrWhiteSpace($Mode)) { 'time' } else { $Mode }
if ($actualMode -eq 'unread') {
    throw '未读模式暂不可用（QQNT 的未读状态还没有可靠解码方式）。请用 -SinceHours、-Days 或 -StartTime/-EndTime 按时间范围总结。'
}

if ($UseWatchlist.IsPresent) {
    $watchlistEntries = Get-WatchlistEntries -Config $config
    if (@($watchlistEntries).Length -eq 0) {
        throw '关注群列表为空。请先在控制台「关注群」页添加，或运行 scripts\manage_watchlist.ps1 选择群。'
    }
    $GroupIds = @($watchlistEntries | ForEach-Object { $_.groupId })
}

# Switches fall back to config runDefaults when the caller did not pass them explicitly.
$useLlmExplicit = $PSBoundParameters.ContainsKey('UseLlm')
$effectiveUseLlm = if ($useLlmExplicit) { $UseLlm.IsPresent } else { [bool](Get-RunDefault -Config $config -Name 'useLlm' -Fallback $false) }
$effectiveExportMedia = if ($PSBoundParameters.ContainsKey('ExportMedia')) { $ExportMedia.IsPresent } else { [bool](Get-RunDefault -Config $config -Name 'exportMedia' -Fallback $false) }
$effectiveOpenReport = if ($NoOpenReport.IsPresent) { $false } elseif ($PSBoundParameters.ContainsKey('OpenReport')) { $OpenReport.IsPresent } else { [bool](Get-RunDefault -Config $config -Name 'openReport' -Fallback $false) }

$hasExplicitTimeRange = $PSBoundParameters.ContainsKey('SinceHours') -or $PSBoundParameters.ContainsKey('Days') -or $PSBoundParameters.ContainsKey('StartTime') -or $PSBoundParameters.ContainsKey('EndTime')
if (-not $hasExplicitTimeRange) {
    $defaultSinceHours = [int](Get-RunDefault -Config $config -Name 'sinceHours' -Fallback 0)
    if ($defaultSinceHours -gt 0) {
        $SinceHours = $defaultSinceHours
    }
}

$selectedGroupIds = Get-SelectedGroupIds -RawGroupIds $GroupIds -RawGroupListFile $GroupListFile -Config $config
$actualScanLimit = if ($ScanLimit -gt 0) { $ScanLimit } else { [int]$config.defaultScanLimit }

$timeRange = $null
if ($SinceLastRecord.IsPresent -and -not $hasExplicitTimeRange) {
    # 从消息库的扫描记录续扫（重叠 10 分钟去重，上限回看 30 天）；没有记录时回退最近 26 小时。
    $storeDb = Join-Path $toolRoot 'store\messages.db'
    $coverageStart = $null
    if (Test-Path -LiteralPath $storeDb) {
        $coverageOutput = node (Join-Path $toolRoot 'src\query_store_range.js') $storeDb (Join-GroupIdsCsv -GroupIds $selectedGroupIds)
        if ($LASTEXITCODE -eq 0) {
            $joined = ($coverageOutput | Out-String)
            if ($joined -match 'coverageStart=(\d+)') {
                $coverageStart = [long]$Matches[1]
            }
        }
    }
    $nowUnix = [DateTimeOffset]::Now.ToUnixTimeSeconds()
    if ($null -ne $coverageStart) {
        $minStart = $nowUnix - 30 * 24 * 3600
        if ($coverageStart -lt $minStart) { $coverageStart = $minStart }
        $timeRange = [pscustomobject]@{
            StartUnix = $coverageStart - 600
            EndUnix = $nowUnix
            Label = 'since-store'
        }
        Write-Host '本次从上次记录点继续扫描（重叠 10 分钟用于去重）。'
    } else {
        Write-Warning '还没有本地扫描记录可作起点，本次改用最近 26 小时。'
        $SinceHours = 26
    }
}
if ($null -eq $timeRange) {
    $timeRange = Get-TimeRange `
        -RawStartTime $StartTime `
        -RawEndTime $EndTime `
        -RawSinceHours $SinceHours `
        -RawDays $Days `
        -DefaultDays ([int]$config.defaultDays)
}

if ([long]$timeRange.StartUnix -ge [long]$timeRange.EndUnix) {
    throw "时间范围无效：开始时间必须早于结束时间。StartUnix=$($timeRange.StartUnix) EndUnix=$($timeRange.EndUnix)"
}

$runId = Get-RunId -SelectedGroupIds $selectedGroupIds -ActualMode $actualMode -RangeLabel ([string]$timeRange.Label)
$runDir = Join-Path ([string]$config.runsDir) $runId
$reportPath = Join-Path ([string]$config.reportsDir) "$runId.md"
$oldKey = $env:NTQQ_DB_KEY
$oldDeepSeekKey = $env:DEEPSEEK_API_KEY
$oldLlmApiKeyEnvName = $null
$oldLlmApiKeyValue = $null

try {
    $env:NTQQ_DB_KEY = Read-SavedNtqqKey
    $llmOptions = $null
    if ($effectiveUseLlm) {
        try {
            $llmOptions = Get-LlmOptions `
                -Config $config `
                -RawProvider $LlmProvider `
                -RawBaseUrl $LlmBaseUrl `
                -RawModel $LlmModel `
                -RawMaxMessages $LlmMaxMessages `
                -RawMaxChars $LlmMaxChars
        } catch {
            if ($useLlmExplicit) {
                throw
            }
            # LLM comes from config defaults here; a missing key should not block the whole run.
            Write-Warning "本次跳过 AI 总结（$($_.Exception.Message)），报告将使用本地分组。"
        }
    }
    if ($null -ne $llmOptions) {
        $oldLlmApiKeyEnvName = [string]$llmOptions.ApiKeyEnv
        $oldLlmApiKeyValue = $llmOptions.PreviousApiKeyValue
    }

    Push-Location $toolRoot
    try {
        $ntDbDir = [string]$config.ntDbDir
        npm run prepare-clean-dbs -- -NtDbDir $ntDbDir -RunDir $runDir
        if ($LASTEXITCODE -ne 0) {
            throw "复制数据库副本失败（ExitCode=$LASTEXITCODE）。请确认设置页的 QQ 数据库路径正确、磁盘空间充足。"
        }

        $storeRetentionDays = 3
        $storeProperty = $config.PSObject.Properties['store']
        if ($null -ne $storeProperty -and $null -ne $storeProperty.Value) {
            $retentionProperty = $storeProperty.Value.PSObject.Properties['retentionDays']
            if ($null -ne $retentionProperty -and [int]$retentionProperty.Value -gt 0) {
                $storeRetentionDays = [int]$retentionProperty.Value
            }
        }

        $summaryArgs = @{
            RunDir = $runDir
            GroupIdsCsv = (Join-GroupIdsCsv -GroupIds $selectedGroupIds)
            StartUnix = ([long]$timeRange.StartUnix)
            EndUnix = ([long]$timeRange.EndUnix)
            ScanLimit = $actualScanLimit
            StoreDbPath = (Join-Path $toolRoot 'store\messages.db')
            StoreRetentionDays = $storeRetentionDays
        }
        if ($null -ne $llmOptions) {
            $summaryArgs.UseLlm = $true
            $summaryArgs.LlmBaseUrl = [string]$llmOptions.BaseUrl
            $summaryArgs.LlmModel = [string]$llmOptions.Model
            $summaryArgs.LlmApiKeyEnv = [string]$llmOptions.ApiKeyEnv
            $summaryArgs.LlmMaxMessages = [int]$llmOptions.MaxMessages
            $summaryArgs.LlmMaxChars = [int]$llmOptions.MaxChars
            if (-not $useLlmExplicit) {
                # LLM came from config defaults: a runtime LLM failure degrades to local topics instead of aborting.
                $summaryArgs.LlmOptional = $true
            }
        }

        & "$PSScriptRoot\summarize_groups.ps1" @summaryArgs
        if ($LASTEXITCODE -ne 0) {
            throw "导出与分析失败（ExitCode=$LASTEXITCODE）。RunDir=$runDir"
        }

        if ($effectiveExportMedia) {
            # 媒体导出是可降级步骤：nt_data 未配置/不存在或导出失败时警告后继续出报告，
            # 不再让整个运行失败（新用户首跑最常见的坑）。
            $ntDataDirValue = ''
            $ntDataProperty = $config.PSObject.Properties['ntDataDir']
            if ($null -ne $ntDataProperty -and $null -ne $ntDataProperty.Value) {
                $ntDataDirValue = [string]$ntDataProperty.Value
            }
            if ([string]::IsNullOrWhiteSpace($ntDataDirValue) -or -not (Test-Path -LiteralPath $ntDataDirValue)) {
                Write-Warning '未配置或找不到 nt_data 目录，本次跳过媒体导出（报告不受影响）。可在设置页填写 QQ 数据库路径。'
            } else {
                $defaultFormats = [string](Get-RunDefault -Config $config -Name 'mediaFormats' -Fallback 'jpg,jpeg,png,gif,webp,mp4,mov,avi,mkv')
                $formatsCsv = if ([string]::IsNullOrWhiteSpace($MediaFormats)) { $defaultFormats } else { $MediaFormats }
                npm run export-media -- `
                    -RunDir $runDir `
                    -NtDataDir $ntDataDirValue `
                    -FormatsCsv $formatsCsv
                if ($LASTEXITCODE -ne 0) {
                    Write-Warning "媒体导出失败（ExitCode=$LASTEXITCODE），本次报告将没有本地媒体预览，其余不受影响。"
                }
            }
        }
    } finally {
        Pop-Location
    }

    $analysisJson = Join-Path $runDir 'analysis\analysis.json'
    $messagesText = Join-Path $runDir 'analysis\messages-clean.txt'

    if (Test-Path -LiteralPath (Join-Path $runDir 'analysis\groups')) {
        node (Join-Path $toolRoot 'src\generate_digest_report.js') $runDir $reportPath
        if ($LASTEXITCODE -ne 0) {
            throw "生成多群摘要报告失败（ExitCode=$LASTEXITCODE）。RunDir=$runDir"
        }
    } else {
        node (Join-Path $toolRoot 'src\generate_report.js') $analysisJson $messagesText $reportPath
        if ($LASTEXITCODE -ne 0) {
            throw "生成报告失败（ExitCode=$LASTEXITCODE）。AnalysisJson=$analysisJson"
        }
    }
    $cleanDbRemoved = if ($KeepCleanDb.IsPresent) { $false } else { Remove-GeneratedCleanDb -RunDir $runDir }
    $mediaDir = Join-Path $runDir 'media'
    $mediaManifest = Join-Path $mediaDir 'media-manifest.json'
    $reportCenter = Join-Path ([string]$config.reportsDir) 'index.html'
    node (Join-Path $toolRoot 'src\generate_report_center.js') $actualConfigPath $reportCenter
    if ($LASTEXITCODE -ne 0) {
        throw "生成报告中心失败（ExitCode=$LASTEXITCODE）。ReportCenter=$reportCenter"
    }

    Write-Output ''
    Write-Output '完成'
    Write-Output "报告中心: $(ConvertTo-FileUrl -Path $reportCenter)"
    Write-Output "HTML 报告: $(ConvertTo-FileUrl -Path ($reportPath -replace '\.md$', '.html'))"
    Write-Output "Markdown 报告: $reportPath"
    Write-Output "运行文件夹: $runDir"
    if (Test-Path -LiteralPath $mediaManifest) {
        Write-Output "媒体文件夹: $mediaDir"
        Write-Output "媒体清单: $mediaManifest"
    } else {
        Write-Output '媒体：本次未导出本地媒体文件（需要时在运行页或 -ExportMedia 开启）。'
    }
    Write-Output "临时数据库副本已删除: $cleanDbRemoved"
    Write-Output ''
    Write-Output "runDir=$runDir"
    Write-Output "reportPath=$reportPath"
    Write-Output "htmlPath=$($reportPath -replace '\.md$', '.html')"
    Write-Output "messagesText=$messagesText"
    Write-Output "groupIds=$(Join-GroupIdsCsv -GroupIds $selectedGroupIds)"
    Write-Output "mode=$actualMode"
    Write-Output "startUnix=$($timeRange.StartUnix)"
    Write-Output "endUnix=$($timeRange.EndUnix)"
    if ($null -ne $llmOptions) {
        Write-Output "llmProvider=$($llmOptions.Provider)"
        Write-Output "llmModel=$($llmOptions.Model)"
        Write-Output "llmSummary=$(Join-Path $runDir 'analysis\llm-summary.json')"
    }
    if ($effectiveExportMedia) {
        Write-Output "mediaDir=$mediaDir"
    }

    if ($effectiveOpenReport) {
        $reportHtmlPath = $reportPath -replace '\.md$', '.html'
        $openTarget = if (Test-Path -LiteralPath $reportHtmlPath) { $reportHtmlPath } else { $reportPath }
        Start-Process -FilePath $openTarget | Out-Null
    }
} finally {
    $env:NTQQ_DB_KEY = $oldKey
    $env:DEEPSEEK_API_KEY = $oldDeepSeekKey
    if (-not [string]::IsNullOrWhiteSpace($oldLlmApiKeyEnvName)) {
        [System.Environment]::SetEnvironmentVariable($oldLlmApiKeyEnvName, $oldLlmApiKeyValue, 'Process')
    }
}
