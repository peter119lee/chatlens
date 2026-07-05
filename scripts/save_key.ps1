[CmdletBinding()]
param()

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

function Save-ManualKey {
    param()

    $secretDir = Join-Path $env:APPDATA 'QQSummaryTools'
    $secretPath = Join-Path $secretDir 'ntqq-db-key.dpapi'

    $secure = Read-Host -Prompt 'Paste NTQQ_DB_KEY for this Windows user' -AsSecureString
    $encrypted = ConvertFrom-SecureString -SecureString $secure

    New-Item -ItemType Directory -Force -Path $secretDir | Out-Null
    Set-Content -LiteralPath $secretPath -Value $encrypted -Encoding ASCII

    Write-Output "saved=$secretPath"
}

Write-Output ''
Write-Output 'Save QQNT DB key'
Write-Output '1. Auto-detect from existing memory-candidates.txt'
Write-Output '2. Paste NTQQ_DB_KEY manually'
Write-Output ''

$choice = Read-Host -Prompt 'Choose 1/2'

switch ($choice) {
    '1' {
        & "$PSScriptRoot\save_key_from_candidates.ps1"
    }
    '2' {
        Save-ManualKey
    }
    default {
        throw "Unknown choice '$choice'. Choose 1 or 2."
    }
}
