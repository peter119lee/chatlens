[CmdletBinding()]
param(
    [Parameter(Mandatory = $false)]
    [ValidateSet('deepseek')]
    [string]$Provider
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

. "$PSScriptRoot\common.ps1"

$actualProvider = if ([string]::IsNullOrWhiteSpace($Provider)) { 'deepseek' } else { $Provider }

switch ($actualProvider) {
    'deepseek' {
        $secure = Read-Host -Prompt 'Paste DeepSeek API key for this Windows user' -AsSecureString
        $path = Save-Secret -Secret $secure -FileName 'deepseek-api-key.dpapi'
        Write-Output "saved=$path"
    }
    default {
        throw "Unsupported provider '$actualProvider'."
    }
}
