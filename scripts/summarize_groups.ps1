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
    [string]$KnowledgeDbPath,

    [Parameter(Mandatory = $false)]
    [string]$NtDataDir
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

. "$PSScriptRoot\common.ps1"

if ([string]::IsNullOrWhiteSpace($env:NTQQ_DB_KEY)) {
    throw '缺少 NTQQ_DB_KEY 环境变量。请先在控制台设置页保存 QQ 数据库密钥。'
}

$groupIds = ConvertTo-GroupIdList -Values @($GroupIdsCsv)
if (@($groupIds).Length -eq 0) {
    throw '至少需要一个 QQ 群号。'
}

if ($StartUnix -ge $EndUnix) {
    throw "时间范围无效：StartUnix 必须早于 EndUnix。StartUnix=$StartUnix EndUnix=$EndUnix"
}

if ($ScanLimit -le 0) {
    throw "ScanLimit 无效，必须大于 0。ScanLimit=$ScanLimit"
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
    throw "导出消息失败（ExitCode=$LASTEXITCODE）。ExportPath=$exportPath"
}
# progress= lines are machine-readable stage markers for the control-center UI.
Write-Host "progress=export-done"

if (-not [string]::IsNullOrWhiteSpace($StoreDbPath)) {
    $runId = Split-Path $RunDir -Leaf
    node "$PSScriptRoot\..\src\ingest_store.js" $exportPath $StoreDbPath $runId | Out-Host
    if ($LASTEXITCODE -ne 0) {
        # The message store is a convenience cache; a failed ingest should not kill the run.
        Write-Warning "消息库写入失败（ExitCode=$LASTEXITCODE），「消息」页可能缺这次的数据；报告不受影响。"
    }
    Write-Host "progress=store-done"
}

node "$PSScriptRoot\..\src\analyze_export.js" $exportPath $analysisDir
if ($LASTEXITCODE -ne 0) {
    throw "分析消息失败（ExitCode=$LASTEXITCODE）。ExportPath=$exportPath"
}
Write-Host "progress=analyze-done"

# Harvest AI generation parameters while the messages are still in the cache:
# this is the only moment both the image and the sender are available, because
# QQ evicts cached originals well before the chat history goes.
if (-not [string]::IsNullOrWhiteSpace($KnowledgeDbPath) -and -not [string]::IsNullOrWhiteSpace($NtDataDir)) {
    $mediaMessagesPath = Join-Path $analysisDir 'media-messages.json'
    if (Test-Path -LiteralPath $mediaMessagesPath) {
        node "$PSScriptRoot\..\src\harvest_run_media.js" $mediaMessagesPath $NtDataDir $KnowledgeDbPath $exportPath | Out-Host
        if ($LASTEXITCODE -ne 0) {
            # The knowledge base is an extra; never fail a summary run over it.
            Write-Warning "图片参数入库失败（ExitCode=$LASTEXITCODE），本次报告不受影响。"
        }
        Write-Host "progress=knowledge-done"
    }
}

if ($UseLlm.IsPresent) {
    if ([string]::IsNullOrWhiteSpace($LlmBaseUrl)) {
        throw '启用 UseLlm 时必须提供 LlmBaseUrl。'
    }

    if ([string]::IsNullOrWhiteSpace($LlmModel)) {
        throw '启用 UseLlm 时必须提供 LlmModel。'
    }

    if ([string]::IsNullOrWhiteSpace($LlmApiKeyEnv)) {
        throw '启用 UseLlm 时必须提供 LlmApiKeyEnv。'
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
            throw "分析群 $groupId 失败（ExitCode=$LASTEXITCODE）。AnalysisDir=$groupAnalysisDir"
        }

        if ($UseLlm.IsPresent) {
            $llmExitCode = Invoke-LlmAdapter -TargetAnalysisDir $groupAnalysisDir
            if ($llmExitCode -ne 0) {
                Write-Warning "群 $groupId 的 AI 总结失败（ExitCode=$llmExitCode），该群将使用本地分组。"
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
            Write-Warning "AI 总结失败（ExitCode=$llmExitCode），报告将使用本地分组。"
            Write-Host "progress=llm-failed"
        } else {
            throw "AI 总结失败（ExitCode=$llmExitCode）。AnalysisDir=$analysisDir"
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
