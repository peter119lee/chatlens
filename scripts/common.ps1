function Read-ToolkitConfig {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    if (-not (Test-Path -LiteralPath $Path)) {
        $examplePath = Join-Path (Split-Path -Parent $Path) 'defaults.example.json'
        if (Test-Path -LiteralPath $examplePath) {
            Copy-Item -LiteralPath $examplePath -Destination $Path
        } else {
            throw "配置文件不存在: $Path"
        }
    }

    $config = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json

    $toolkitRoot = Split-Path -Parent (Split-Path -Parent $Path)
    foreach ($dirName in @('runsDir', 'reportsDir')) {
        $dirProperty = $config.PSObject.Properties[$dirName]
        if ($null -ne $dirProperty -and -not [string]::IsNullOrWhiteSpace([string]$dirProperty.Value)) {
            if (-not [System.IO.Path]::IsPathRooted([string]$dirProperty.Value)) {
                $dirProperty.Value = Join-Path $toolkitRoot ([string]$dirProperty.Value)
            }
        }
    }

    $config
}

function Save-ToolkitConfig {
    param(
        [Parameter(Mandatory = $true)]
        [object]$Config,

        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    $json = $Config | ConvertTo-Json -Depth 12
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($Path, ($json + "`n"), $utf8NoBom)
}

function Get-WatchlistEntries {
    param(
        [Parameter(Mandatory = $true)]
        [AllowNull()]
        [object]$Config
    )

    $watchlistProperty = $Config.PSObject.Properties['watchlist']
    if ($null -eq $watchlistProperty -or $null -eq $watchlistProperty.Value) {
        return @()
    }

    $entries = @()
    foreach ($item in @($watchlistProperty.Value)) {
        if ($null -eq $item) {
            continue
        }

        if ($item -is [string]) {
            $groupId = $item.Trim()
            $name = ''
        } else {
            $groupIdProperty = $item.PSObject.Properties['groupId']
            if ($null -eq $groupIdProperty) {
                continue
            }
            $groupId = ([string]$groupIdProperty.Value).Trim()
            $nameProperty = $item.PSObject.Properties['name']
            $name = if ($null -eq $nameProperty -or $null -eq $nameProperty.Value) { '' } else { [string]$nameProperty.Value }
        }

        if ($groupId -match '^\d+$') {
            $entries += [pscustomobject]@{
                groupId = $groupId
                name = $name
            }
        }
    }

    @($entries)
}

function Get-RunDefault {
    param(
        [Parameter(Mandatory = $true)]
        [AllowNull()]
        [object]$Config,

        [Parameter(Mandatory = $true)]
        [string]$Name,

        [Parameter(Mandatory = $false)]
        [AllowNull()]
        [object]$Fallback
    )

    $runDefaultsProperty = $Config.PSObject.Properties['runDefaults']
    if ($null -eq $runDefaultsProperty -or $null -eq $runDefaultsProperty.Value) {
        return $Fallback
    }

    $valueProperty = $runDefaultsProperty.Value.PSObject.Properties[$Name]
    if ($null -eq $valueProperty -or $null -eq $valueProperty.Value) {
        return $Fallback
    }

    $valueProperty.Value
}

function Read-SavedNtqqKey {
    param()

    $secretPath = Join-Path (Join-Path $env:APPDATA 'QQSummaryTools') 'ntqq-db-key.dpapi'
    if (-not (Test-Path -LiteralPath $secretPath)) {
        throw "没有找到已保存的 NTQQ 数据库密钥。请先在控制台设置页保存，或运行 scripts\save_key.ps1: $secretPath"
    }

    $encrypted = (Get-Content -LiteralPath $secretPath -Raw).Trim()
    $secure = ConvertTo-SecureString -String $encrypted
    $credential = New-Object System.Management.Automation.PSCredential('ntqq', $secure)
    $credential.GetNetworkCredential().Password
}

function Read-SavedSecret {
    param(
        [Parameter(Mandatory = $true)]
        [string]$FileName,

        [Parameter(Mandatory = $true)]
        [string]$SecretName
    )

    $secretPath = Join-Path (Join-Path $env:APPDATA 'QQSummaryTools') $FileName
    if (-not (Test-Path -LiteralPath $secretPath)) {
        throw "没有找到 $SecretName。请先保存: $secretPath"
    }

    $encrypted = (Get-Content -LiteralPath $secretPath -Raw).Trim()
    $secure = ConvertTo-SecureString -String $encrypted
    $credential = New-Object System.Management.Automation.PSCredential($SecretName, $secure)
    $credential.GetNetworkCredential().Password
}

function Save-Secret {
    param(
        [Parameter(Mandatory = $true)]
        [System.Security.SecureString]$Secret,

        [Parameter(Mandatory = $true)]
        [string]$FileName
    )

    $secretDir = Join-Path $env:APPDATA 'QQSummaryTools'
    $secretPath = Join-Path $secretDir $FileName
    $encrypted = ConvertFrom-SecureString -SecureString $Secret

    New-Item -ItemType Directory -Force -Path $secretDir | Out-Null
    Set-Content -LiteralPath $secretPath -Value $encrypted -Encoding ASCII

    $secretPath
}

function ConvertTo-GroupIdList {
    param(
        [Parameter(Mandatory = $false)]
        [AllowNull()]
        [AllowEmptyString()]
        [AllowEmptyCollection()]
        [string[]]$Values
    )

    $groupIds = New-Object System.Collections.Generic.List[string]
    $seen = New-Object 'System.Collections.Generic.HashSet[string]'
    $actualValues = if ($null -eq $Values) { @() } else { @($Values) }

    foreach ($value in $actualValues) {
        if ([string]::IsNullOrWhiteSpace($value)) {
            continue
        }

        $parts = [regex]::Split($value, '[,;，；\s]+')
        foreach ($part in $parts) {
            $groupId = $part.Trim()
            if ([string]::IsNullOrWhiteSpace($groupId)) {
                continue
            }

            if ($groupId -notmatch '^\d+$') {
                throw "无效的 QQ 群号 '$groupId'：群号只能是数字。"
            }

            if ($seen.Add($groupId)) {
                $groupIds.Add($groupId) | Out-Null
            }
        }
    }

    @($groupIds.ToArray())
}

function Read-GroupIdListFile {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    if (-not (Test-Path -LiteralPath $Path)) {
        throw "群号列表文件不存在: $Path"
    }

    $values = @()
    foreach ($line in Get-Content -LiteralPath $Path) {
        $text = ($line -replace '#.*$', '').Trim()
        if (-not [string]::IsNullOrWhiteSpace($text)) {
            $values += $text
        }
    }

    ConvertTo-GroupIdList -Values $values
}

function Join-GroupIdsCsv {
    param(
        [Parameter(Mandatory = $false)]
        [AllowNull()]
        [AllowEmptyString()]
        [AllowEmptyCollection()]
        [string[]]$GroupIds
    )

    $actualGroupIds = if ($null -eq $GroupIds) { @() } else { @($GroupIds) }
    ($actualGroupIds -join ',')
}

function ConvertTo-UnixTimeFromLocalText {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Text
    )

    # 界面与报告展示的时间一律是北京时间 (UTC+8)：不带时区的输入也按北京时间解析，
    # 显式带偏移（+08:00 / Z）时按其解析。以前的 AssumeLocal 在非东八区机器上会把
    # 扫描窗口整体平移数小时，导致消息缺失甚至范围无效。
    try {
        $trimmed = $Text.Trim()
        if ($trimmed -match '(?:Z|[+-]\d{2}:?\d{2})\s*$') {
            $parsed = [DateTimeOffset]::Parse($trimmed, [System.Globalization.CultureInfo]::InvariantCulture)
        } else {
            $naive = [datetime]::Parse($trimmed, [System.Globalization.CultureInfo]::InvariantCulture, [System.Globalization.DateTimeStyles]::None)
            $naive = [datetime]::SpecifyKind($naive, [System.DateTimeKind]::Unspecified)
            $parsed = New-Object System.DateTimeOffset($naive, [TimeSpan]::FromHours(8))
        }
        $parsed.ToUnixTimeSeconds()
    } catch {
        throw "无法解析时间 '$Text'。请使用北京时间，例如 2026-07-02 18:30，或带时区写法 2026-07-02T18:30:00+08:00。"
    }
}

function Get-ShortStableHash {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Text
    )

    $sha1 = [System.Security.Cryptography.SHA1]::Create()
    try {
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($Text)
        $hashBytes = $sha1.ComputeHash($bytes)
        ([BitConverter]::ToString($hashBytes) -replace '-', '').Substring(0, 12).ToLowerInvariant()
    } finally {
        $sha1.Dispose()
    }
}
