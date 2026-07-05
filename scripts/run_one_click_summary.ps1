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
        throw 'No QQ group ids were provided. Pass -GroupIds "123,456" or -GroupListFile ".\groups.txt".'
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
            throw 'StartTime is required when EndTime is provided.'
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
        throw "No valid time range was provided. Pass -SinceHours, -Days, or -StartTime. DefaultDays=$DefaultDays"
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
        throw 'Config is missing llm settings. Add config.defaults.json llm.provider/baseUrl/model/apiKeyEnv/maxMessages/maxChars or pass LLM parameters explicitly.'
    }

    $llmConfig = $llmProperty.Value
    $providerConfig = $llmConfig.PSObject.Properties['provider']
    $baseUrlConfig = $llmConfig.PSObject.Properties['baseUrl']
    $modelConfig = $llmConfig.PSObject.Properties['model']
    $apiKeyEnvConfig = $llmConfig.PSObject.Properties['apiKeyEnv']
    $maxMessagesConfig = $llmConfig.PSObject.Properties['maxMessages']
    $maxCharsConfig = $llmConfig.PSObject.Properties['maxChars']

    $provider = if ([string]::IsNullOrWhiteSpace($RawProvider)) { [string]$providerConfig.Value } else { $RawProvider }
    if ([string]::IsNullOrWhiteSpace($provider)) {
        throw 'LLM provider is required when UseLlm is set.'
    }

    switch ($provider) {
        'deepseek' {
            $baseUrl = if ([string]::IsNullOrWhiteSpace($RawBaseUrl)) { [string]$baseUrlConfig.Value } else { $RawBaseUrl }
            $model = if ([string]::IsNullOrWhiteSpace($RawModel)) { [string]$modelConfig.Value } else { $RawModel }
            $apiKeyEnv = if ($null -eq $apiKeyEnvConfig -or [string]::IsNullOrWhiteSpace([string]$apiKeyEnvConfig.Value)) { 'DEEPSEEK_API_KEY' } else { [string]$apiKeyEnvConfig.Value }
            $maxMessages = if ($RawMaxMessages -gt 0) { $RawMaxMessages } else { [int]$maxMessagesConfig.Value }
            $maxChars = if ($RawMaxChars -gt 0) { $RawMaxChars } else { [int]$maxCharsConfig.Value }

            if ([string]::IsNullOrWhiteSpace($baseUrl)) {
                throw 'LLM baseUrl is required for provider deepseek.'
            }

            if ([string]::IsNullOrWhiteSpace($model)) {
                throw 'LLM model is required for provider deepseek.'
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
            throw "Unsupported LLM provider '$provider'. Supported providers: deepseek."
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
        throw "Refusing to remove clean-db because it is outside the run directory. RunDir=$runRoot Target=$target"
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
    throw 'Unread mode is not enabled yet because QQNT unread state has not been decoded reliably. Use -Mode time with -SinceHours, -Days, or -StartTime/-EndTime.'
}

if ($UseWatchlist.IsPresent) {
    $watchlistEntries = Get-WatchlistEntries -Config $config
    if (@($watchlistEntries).Length -eq 0) {
        throw 'The watchlist in config\defaults.json is empty. Run scripts\manage_watchlist.ps1 (menu option 4) to pick your groups first.'
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
$timeRange = Get-TimeRange `
    -RawStartTime $StartTime `
    -RawEndTime $EndTime `
    -RawSinceHours $SinceHours `
    -RawDays $Days `
    -DefaultDays ([int]$config.defaultDays)

if ([long]$timeRange.StartUnix -ge [long]$timeRange.EndUnix) {
    throw "Invalid time range. Start time must be earlier than end time. StartUnix=$($timeRange.StartUnix) EndUnix=$($timeRange.EndUnix)"
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
            Write-Warning "Skipping LLM topics for this run: $($_.Exception.Message)"
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
            throw "prepare-clean-dbs failed. ExitCode=$LASTEXITCODE RunDir=$runDir"
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
            throw "summarize-groups failed. ExitCode=$LASTEXITCODE RunDir=$runDir"
        }

        if ($effectiveExportMedia) {
            $defaultFormats = [string](Get-RunDefault -Config $config -Name 'mediaFormats' -Fallback 'jpg,jpeg,png,gif,webp,mp4,mov,avi,mkv')
            $formatsCsv = if ([string]::IsNullOrWhiteSpace($MediaFormats)) { $defaultFormats } else { $MediaFormats }
            npm run export-media -- `
                -RunDir $runDir `
                -NtDataDir ([string]$config.ntDataDir) `
                -FormatsCsv $formatsCsv
            if ($LASTEXITCODE -ne 0) {
                throw "export-media failed. ExitCode=$LASTEXITCODE RunDir=$runDir"
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
            throw "generate_digest_report failed. ExitCode=$LASTEXITCODE RunDir=$runDir"
        }
    } else {
        node (Join-Path $toolRoot 'src\generate_report.js') $analysisJson $messagesText $reportPath
        if ($LASTEXITCODE -ne 0) {
            throw "generate_report failed. ExitCode=$LASTEXITCODE AnalysisJson=$analysisJson"
        }
    }
    $cleanDbRemoved = if ($KeepCleanDb.IsPresent) { $false } else { Remove-GeneratedCleanDb -RunDir $runDir }
    $mediaDir = Join-Path $runDir 'media'
    $mediaManifest = Join-Path $mediaDir 'media-manifest.json'
    $reportCenter = Join-Path ([string]$config.reportsDir) 'index.html'
    node (Join-Path $toolRoot 'src\generate_report_center.js') $actualConfigPath $reportCenter
    if ($LASTEXITCODE -ne 0) {
        throw "generate_report_center failed. ExitCode=$LASTEXITCODE ReportCenter=$reportCenter"
    }

    Write-Output ''
    Write-Output 'DONE'
    Write-Output "Report center: $(ConvertTo-FileUrl -Path $reportCenter)"
    Write-Output "Open report HTML: $(ConvertTo-FileUrl -Path ($reportPath -replace '\.md$', '.html'))"
    Write-Output "Open report Markdown: $reportPath"
    Write-Output "Run folder: $runDir"
    if (Test-Path -LiteralPath $mediaManifest) {
        Write-Output "Media folder: $mediaDir"
        Write-Output "Media manifest: $mediaManifest"
    } else {
        Write-Output 'Media folder: not exported. Use -ExportMedia if you need local media files.'
    }
    Write-Output "Temporary clean-db removed: $cleanDbRemoved"
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
