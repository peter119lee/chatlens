[CmdletBinding()]
param(
    [Parameter(Mandatory = $false)]
    [string]$ConfigPath,

    [Parameter(Mandatory = $false)]
    [string]$Add,

    [Parameter(Mandatory = $false)]
    [string]$Remove,

    [Parameter(Mandatory = $false)]
    [switch]$Clear,

    [Parameter(Mandatory = $false)]
    [switch]$List
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

function Get-KnownGroups {
    param(
        [Parameter(Mandatory = $true)]
        [object]$Config
    )

    $reportsDir = [string]$Config.reportsDir
    if (-not (Test-Path -LiteralPath $reportsDir)) {
        return @()
    }

    $latestList = Get-ChildItem -LiteralPath $reportsDir -Filter 'group-list-*.txt' |
        Sort-Object LastWriteTime -Descending |
        Select-Object -First 1
    if ($null -eq $latestList) {
        return @()
    }

    $groups = @()
    foreach ($line in Get-Content -LiteralPath $latestList.FullName -Encoding UTF8) {
        $parts = $line -split "`t", 2
        if ($parts.Count -ge 1 -and $parts[0].Trim() -match '^\d+$') {
            $groups += [pscustomobject]@{
                groupId = $parts[0].Trim()
                name = if ($parts.Count -ge 2) { $parts[1].Trim() } else { '' }
            }
        }
    }

    @($groups)
}

function Show-Watchlist {
    param(
        [Parameter(Mandatory = $true)]
        [AllowEmptyCollection()]
        [object[]]$Entries
    )

    Write-Output ''
    if (@($Entries).Length -eq 0) {
        Write-Output 'Watchlist is empty. 当前没有关注的群。'
        return
    }

    Write-Output "当前关注群 ($(@($Entries).Length) 个):"
    foreach ($entry in $Entries) {
        Write-Output "  $($entry.groupId)  $($entry.name)"
    }
}

function Save-Watchlist {
    param(
        [Parameter(Mandatory = $true)]
        [object]$Config,

        [Parameter(Mandatory = $true)]
        [AllowEmptyCollection()]
        [object[]]$Entries,

        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    $value = @($Entries | ForEach-Object { [pscustomobject]@{ groupId = $_.groupId; name = $_.name } })
    if ($null -eq $Config.PSObject.Properties['watchlist']) {
        $Config | Add-Member -MemberType NoteProperty -Name 'watchlist' -Value $value
    } else {
        $Config.watchlist = $value
    }

    Save-ToolkitConfig -Config $Config -Path $Path
    Write-Output "已保存关注群到 $Path"
}

function Resolve-GroupName {
    param(
        [Parameter(Mandatory = $true)]
        [string]$GroupId,

        [Parameter(Mandatory = $true)]
        [AllowEmptyCollection()]
        [object[]]$KnownGroups
    )

    $known = @($KnownGroups | Where-Object { $_.groupId -eq $GroupId })
    if (@($known).Length -gt 0) {
        return [string]$known[0].name
    }

    ''
}

function Add-WatchlistEntries {
    param(
        [Parameter(Mandatory = $true)]
        [AllowEmptyCollection()]
        [object[]]$Entries,

        [Parameter(Mandatory = $true)]
        [string[]]$GroupIds,

        [Parameter(Mandatory = $true)]
        [AllowEmptyCollection()]
        [object[]]$KnownGroups
    )

    $result = @($Entries)
    foreach ($groupId in $GroupIds) {
        if (@($result | Where-Object { $_.groupId -eq $groupId }).Length -gt 0) {
            # Write-Host keeps user feedback out of the function's return value.
            Write-Host "已在关注列表中: $groupId"
            continue
        }

        $name = Resolve-GroupName -GroupId $groupId -KnownGroups $KnownGroups
        $result += [pscustomobject]@{
            groupId = $groupId
            name = $name
        }
        Write-Host "已添加: $groupId $name"
    }

    @($result)
}

function Remove-WatchlistEntries {
    param(
        [Parameter(Mandatory = $true)]
        [AllowEmptyCollection()]
        [object[]]$Entries,

        [Parameter(Mandatory = $true)]
        [string[]]$GroupIds
    )

    $result = @($Entries | Where-Object { $GroupIds -notcontains $_.groupId })
    foreach ($groupId in $GroupIds) {
        if (@($Entries | Where-Object { $_.groupId -eq $groupId }).Length -gt 0) {
            Write-Host "已移除: $groupId"
        } else {
            Write-Host "不在关注列表中: $groupId"
        }
    }

    @($result)
}

$entries = @(Get-WatchlistEntries -Config $config)
$knownGroups = @(Get-KnownGroups -Config $config)

if ($List.IsPresent) {
    Show-Watchlist -Entries $entries
    return
}

if ($Clear.IsPresent -or -not [string]::IsNullOrWhiteSpace($Add) -or -not [string]::IsNullOrWhiteSpace($Remove)) {
    if ($Clear.IsPresent) {
        $entries = @()
        Write-Output '已清空关注列表。'
    }
    if (-not [string]::IsNullOrWhiteSpace($Remove)) {
        $entries = Remove-WatchlistEntries -Entries $entries -GroupIds (ConvertTo-GroupIdList -Values @($Remove))
    }
    if (-not [string]::IsNullOrWhiteSpace($Add)) {
        $entries = Add-WatchlistEntries -Entries $entries -GroupIds (ConvertTo-GroupIdList -Values @($Add)) -KnownGroups $knownGroups
    }

    Save-Watchlist -Config $config -Entries $entries -Path $actualConfigPath
    Show-Watchlist -Entries $entries
    return
}

# Interactive mode

if (@($knownGroups).Length -eq 0) {
    Write-Output ''
    Write-Output '还没有群列表缓存。要读取一次 QQ 群列表吗?(会复制一份本地数据库, 需要一点时间)'
    $answer = (Read-Host -Prompt '生成群列表? y/N').Trim()
    if ($answer -match '(?i)^y(?:es)?$') {
        & "$PSScriptRoot\list_groups.ps1" -ConfigPath $actualConfigPath
        $knownGroups = @(Get-KnownGroups -Config $config)
    }
}

if (@($knownGroups).Length -gt 0) {
    Write-Output ''
    Write-Output "可选群列表 (共 $(@($knownGroups).Length) 个):"
    $watchIds = @($entries | ForEach-Object { $_.groupId })
    for ($index = 0; $index -lt @($knownGroups).Length; $index += 1) {
        $group = $knownGroups[$index]
        $marker = if ($watchIds -contains $group.groupId) { '*' } else { ' ' }
        Write-Output ("{0,4}. {1} {2}  {3}" -f ($index + 1), $marker, $group.groupId, $group.name)
    }
    Write-Output '(* = 已在关注列表中)'
}

Show-Watchlist -Entries $entries

Write-Output ''
Write-Output '操作说明:'
Write-Output '  输入列表编号或群号添加, 可用逗号分隔, 例如: 3,15 或 123456789'
Write-Output '  r 群号   移除, 例如: r 123456789'
Write-Output '  q        保存并退出'

$didChange = $false
while ($true) {
    $inputText = (Read-Host -Prompt '添加/移除/退出').Trim()
    if ([string]::IsNullOrWhiteSpace($inputText)) {
        continue
    }

    if ($inputText -match '(?i)^q(?:uit)?$') {
        break
    }

    if ($inputText -match '(?i)^r\s+(.+)$') {
        $entries = Remove-WatchlistEntries -Entries $entries -GroupIds (ConvertTo-GroupIdList -Values @($Matches[1]))
        $didChange = $true
        continue
    }

    $tokens = [regex]::Split($inputText, '[,;，；\s]+') | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
    $groupIds = @()
    $hasError = $false
    foreach ($token in $tokens) {
        if ($token -notmatch '^\d+$') {
            Write-Output "无法识别的输入: $token"
            $hasError = $true
            continue
        }

        $numericValue = [long]$token
        if ($numericValue -ge 1 -and $numericValue -le @($knownGroups).Length -and $token.Length -le 4) {
            $groupIds += $knownGroups[$numericValue - 1].groupId
        } else {
            $groupIds += $token
        }
    }

    if (-not $hasError -and @($groupIds).Length -eq 0) {
        continue
    }

    if (@($groupIds).Length -gt 0) {
        $entries = Add-WatchlistEntries -Entries $entries -GroupIds $groupIds -KnownGroups $knownGroups
        $didChange = $true
    }
}

if ($didChange) {
    Save-Watchlist -Config $config -Entries $entries -Path $actualConfigPath
}
Show-Watchlist -Entries $entries
