[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$RunDir,

    [Parameter(Mandatory = $true)]
    [string]$GroupIdsCsv,

    [Parameter(Mandatory = $true)]
    [long]$StartUnix,

    [Parameter(Mandatory = $true)]
    [long]$EndUnix,

    [Parameter(Mandatory = $true)]
    [int]$ScanLimit,

    [Parameter(Mandatory = $false)]
    [switch]$UseLlm,

    [Parameter(Mandatory = $false)]
    [string]$LlmBaseUrl,

    [Parameter(Mandatory = $false)]
    [string]$LlmModel,

    [Parameter(Mandatory = $false)]
    [string]$LlmApiKeyEnv,

    [Parameter(Mandatory = $false)]
    [int]$LlmMaxMessages,

    [Parameter(Mandatory = $false)]
    [int]$LlmMaxChars,

    [Parameter(Mandatory = $false)]
    [switch]$LlmOptional,

    [Parameter(Mandatory = $false)]
    [string]$StoreDbPath,

    [Parameter(Mandatory = $false)]
    [int]$StoreRetentionDays
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

. "$PSScriptRoot\common.ps1"

if ([string]::IsNullOrWhiteSpace($env:NTQQ_DB_KEY)) {
    throw 'Missing NTQQ_DB_KEY environment variable in this PowerShell session.'
}

$groupIds = ConvertTo-GroupIdList -Values @($GroupIdsCsv)
if (@($groupIds).Length -eq 0) {
    throw 'At least one QQ group id is required.'
}

if ($StartUnix -ge $EndUnix) {
    throw "Invalid time range. StartUnix must be earlier than EndUnix. StartUnix=$StartUnix EndUnix=$EndUnix"
}

if ($ScanLimit -le 0) {
    throw "Invalid ScanLimit. It must be greater than zero. ScanLimit=$ScanLimit"
}

$cleanDir = Join-Path $RunDir 'clean-db'
$exportDir = Join-Path $RunDir 'exports'
$analysisDir = Join-Path $RunDir 'analysis'
New-Item -ItemType Directory -Force -Path $exportDir, $analysisDir | Out-Null

$normalizedGroupIdsCsv = Join-GroupIdsCsv -GroupIds $groupIds
$groupHash = Get-ShortStableHash -Text $normalizedGroupIdsCsv
$exportPath = Join-Path $exportDir "groups_${groupHash}_${StartUnix}_${EndUnix}.json"

node "$PSScriptRoot\..\src\export_group_recent.js" `
    (Join-Path $cleanDir 'nt_msg.clean.db') `
    (Join-Path $cleanDir 'group_info.clean.db') `
    $normalizedGroupIdsCsv `
    $StartUnix `
    $EndUnix `
    $exportPath `
    $ScanLimit
if ($LASTEXITCODE -ne 0) {
    throw "export_group_recent failed. ExitCode=$LASTEXITCODE ExportPath=$exportPath"
}
# progress= lines are machine-readable stage markers for the control-center UI.
Write-Host "progress=export-done"

if (-not [string]::IsNullOrWhiteSpace($StoreDbPath)) {
    $retention = if ($StoreRetentionDays -gt 0) { $StoreRetentionDays } else { 3 }
    $runId = Split-Path $RunDir -Leaf
    node "$PSScriptRoot\..\src\ingest_store.js" $exportPath $StoreDbPath $retention $runId | Out-Host
    if ($LASTEXITCODE -ne 0) {
        # The message store is a convenience cache; a failed ingest should not kill the run.
        Write-Warning "Message store ingest failed (ExitCode=$LASTEXITCODE). Reports are unaffected."
    }
    Write-Host "progress=store-done"
}

node "$PSScriptRoot\..\src\analyze_export.js" $exportPath $analysisDir
if ($LASTEXITCODE -ne 0) {
    throw "analyze_export failed. ExitCode=$LASTEXITCODE ExportPath=$exportPath AnalysisDir=$analysisDir"
}
Write-Host "progress=analyze-done"

if ($UseLlm.IsPresent) {
    if ([string]::IsNullOrWhiteSpace($LlmBaseUrl)) {
        throw 'LlmBaseUrl is required when UseLlm is set.'
    }

    if ([string]::IsNullOrWhiteSpace($LlmModel)) {
        throw 'LlmModel is required when UseLlm is set.'
    }

    if ([string]::IsNullOrWhiteSpace($LlmApiKeyEnv)) {
        throw 'LlmApiKeyEnv is required when UseLlm is set.'
    }
}

$actualMaxMessages = if ($LlmMaxMessages -gt 0) { $LlmMaxMessages } else { 400 }
$actualMaxChars = if ($LlmMaxChars -gt 0) { $LlmMaxChars } else { 50000 }

function Invoke-LlmAdapter {
    param(
        [Parameter(Mandatory = $true)]
        [string]$TargetAnalysisDir
    )

    # Out-Host keeps node's stdout visible without polluting the function's return value.
    node "$PSScriptRoot\..\src\llm_adapter.js" `
        (Join-Path $TargetAnalysisDir 'analysis.json') `
        (Join-Path $TargetAnalysisDir 'messages.json') `
        (Join-Path $TargetAnalysisDir 'llm-summary.json') `
        $LlmBaseUrl `
        $LlmModel `
        $LlmApiKeyEnv `
        $actualMaxMessages `
        $actualMaxChars | Out-Host
    $LASTEXITCODE
}

if (@($groupIds).Length -gt 1) {
    # Digest mode: one analysis + one LLM summary per group, so topics never mix across groups.
    foreach ($groupId in $groupIds) {
        Write-Host "progress=group-start:$groupId"
        $groupAnalysisDir = Join-Path (Join-Path $analysisDir 'groups') $groupId
        New-Item -ItemType Directory -Force -Path $groupAnalysisDir | Out-Null

        node "$PSScriptRoot\..\src\analyze_export.js" $exportPath $groupAnalysisDir $groupId | Out-Null
        if ($LASTEXITCODE -ne 0) {
            throw "analyze_export failed for group $groupId. ExitCode=$LASTEXITCODE AnalysisDir=$groupAnalysisDir"
        }

        if ($UseLlm.IsPresent) {
            $llmExitCode = Invoke-LlmAdapter -TargetAnalysisDir $groupAnalysisDir
            if ($llmExitCode -ne 0) {
                Write-Warning "LLM summary failed for group $groupId (ExitCode=$llmExitCode). The digest will fall back to local topics for this group."
                Write-Host "progress=group-llm-failed:$groupId"
            } else {
                Write-Host "progress=group-llm-done:$groupId"
            }
        } else {
            Write-Host "progress=group-llm-done:$groupId"
        }
    }
} elseif ($UseLlm.IsPresent) {
    Write-Host "progress=llm-start"
    $llmExitCode = Invoke-LlmAdapter -TargetAnalysisDir $analysisDir
    if ($llmExitCode -ne 0) {
        if ($LlmOptional.IsPresent) {
            Write-Warning "LLM summary failed (ExitCode=$llmExitCode). The report will fall back to local topics."
            Write-Host "progress=llm-failed"
        } else {
            throw "llm_adapter failed. ExitCode=$llmExitCode AnalysisDir=$analysisDir"
        }
    } else {
        Write-Host "progress=llm-done"
    }
}

Write-Output "exportPath=$exportPath"
Write-Output "analysisDir=$analysisDir"

# Callers check $LASTEXITCODE, which would otherwise hold the exit code of the
# last node call inside this script (possibly a tolerated per-group LLM failure).
exit 0
