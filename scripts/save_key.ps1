[CmdletBinding()]
param()

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

function Save-ManualKey {
    param()

    $secretDir = Join-Path $env:APPDATA 'QQSummaryTools'
    $secretPath = Join-Path $secretDir 'ntqq-db-key.dpapi'

    $secure = Read-Host -Prompt '粘贴 NTQQ_DB_KEY（只会加密保存在当前 Windows 用户下）' -AsSecureString
    $encrypted = ConvertFrom-SecureString -SecureString $secure

    New-Item -ItemType Directory -Force -Path $secretDir | Out-Null
    Set-Content -LiteralPath $secretPath -Value $encrypted -Encoding ASCII

    Write-Output "saved=$secretPath"
}

Write-Output ''
Write-Output '保存 QQNT 数据库密钥'
Write-Output '1. 从已有的 memory-candidates.txt 自动检测'
Write-Output '2. 手动粘贴 NTQQ_DB_KEY'
Write-Output ''

$choice = Read-Host -Prompt '选择 1/2'

switch ($choice) {
    '1' {
        & "$PSScriptRoot\save_key_from_candidates.ps1"
    }
    '2' {
        Save-ManualKey
    }
    default {
        throw "无法识别的选项 '$choice'，请输入 1 或 2。"
    }
}
