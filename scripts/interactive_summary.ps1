[CmdletBinding()]
param()

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

. "$PSScriptRoot\common.ps1"

$toolRoot = Split-Path -Parent $PSScriptRoot
$configPath = Join-Path $toolRoot 'config\defaults.json'

function Read-RequiredText {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Prompt
    )

    $value = Read-Host -Prompt $Prompt
    if ([string]::IsNullOrWhiteSpace($value)) {
        throw "必填内容不能为空: $Prompt"
    }

    $value.Trim()
}

function Get-TimeRangeArgs {
    $rangeArgs = @{}
    # Write-Host keeps prompts out of the function's return value (the splat hashtable).
    Write-Host ''
    Write-Host '时间范围: 1=最近 N 小时  2=最近 N 天  3=自定义起止时间'
    $rangeChoice = (Read-Host -Prompt '选择 1/2/3 (回车默认 1)').Trim()
    if ([string]::IsNullOrWhiteSpace($rangeChoice)) {
        $rangeChoice = '1'
    }

    switch ($rangeChoice) {
        '1' {
            $hoursText = Read-RequiredText -Prompt '最近多少小时? 例如 24'
            $rangeArgs.SinceHours = [int]$hoursText
        }
        '2' {
            $daysText = Read-RequiredText -Prompt '最近多少天? 例如 3'
            $rangeArgs.Days = [int]$daysText
        }
        '3' {
            $startTime = Read-RequiredText -Prompt '开始时间, 例如 2026-07-02 18:30:00'
            $endTime = (Read-Host -Prompt '结束时间, 留空表示现在').Trim()
            $rangeArgs.StartTime = $startTime
            if (-not [string]::IsNullOrWhiteSpace($endTime)) {
                $rangeArgs.EndTime = $endTime
            }
        }
        default {
            throw "无法识别的选项 '$rangeChoice'，请输入 1、2 或 3。"
        }
    }

    $rangeArgs
}

function Test-WatchlistReady {
    # Write-Host / Out-Host keep messages and child-script output out of the boolean return value.
    $config = Read-ToolkitConfig -Path $configPath
    $entries = @(Get-WatchlistEntries -Config $config)
    if (@($entries).Length -gt 0) {
        Write-Host ''
        Write-Host "关注群 ($(@($entries).Length) 个): $(@($entries | ForEach-Object { if ($_.name) { $_.name } else { $_.groupId } }) -join ', ')"
        return $true
    }

    Write-Host ''
    Write-Host '关注群列表还是空的, 先选择要关注的群。'
    & "$PSScriptRoot\manage_watchlist.ps1" -ConfigPath $configPath | Out-Host
    $config = Read-ToolkitConfig -Path $configPath
    $entries = @(Get-WatchlistEntries -Config $config)
    if (@($entries).Length -eq 0) {
        Write-Host '关注群列表仍然是空的, 已取消本次总结。'
        return $false
    }

    $true
}

$config = Read-ToolkitConfig -Path $configPath
$defaultHours = [int](Get-RunDefault -Config $config -Name 'sinceHours' -Fallback 24)

Write-Output ''
Write-Output 'QQ 消息总结'
Write-Output "1. 一键总结关注群 (最近 $defaultHours 小时, 回车默认)"
Write-Output '2. 关注群 + 自定义时间'
Write-Output '3. 指定群号 + 自定义时间'
Write-Output '4. 管理关注群'
Write-Output '5. 列出所有群'
Write-Output '6. 保存 DeepSeek API key'
Write-Output '7. 打开报告中心'
Write-Output '8. 清理生成的临时数据'
Write-Output ''

$choice = (Read-Host -Prompt '选择 1-8 (回车默认 1)').Trim()
if ([string]::IsNullOrWhiteSpace($choice)) {
    $choice = '1'
}

switch ($choice) {
    '1' {
        if (-not (Test-WatchlistReady)) {
            return
        }
        & "$PSScriptRoot\run_one_click_summary.ps1" -UseWatchlist
    }
    '2' {
        if (-not (Test-WatchlistReady)) {
            return
        }
        $rangeArgs = Get-TimeRangeArgs
        & "$PSScriptRoot\run_one_click_summary.ps1" -UseWatchlist @rangeArgs
    }
    '3' {
        $groupText = Read-RequiredText -Prompt '输入 QQ 群号, 可逗号分隔, 例如 123456,789012'
        $rangeArgs = Get-TimeRangeArgs
        & "$PSScriptRoot\run_one_click_summary.ps1" -GroupIds @($groupText) @rangeArgs
    }
    '4' {
        & "$PSScriptRoot\manage_watchlist.ps1" -ConfigPath $configPath
    }
    '5' {
        & "$PSScriptRoot\list_groups.ps1"
    }
    '6' {
        & "$PSScriptRoot\save_llm_key.ps1" -Provider deepseek
    }
    '7' {
        & "$PSScriptRoot\open_report_center.ps1"
    }
    '8' {
        & "$PSScriptRoot\cleanup_generated_data.ps1"
    }
    default {
        throw "无法识别的选项 '$choice'，请输入 1-8。"
    }
}
