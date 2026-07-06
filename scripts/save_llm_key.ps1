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
        $secure = Read-Host -Prompt '粘贴 DeepSeek API key（只会加密保存在当前 Windows 用户下）' -AsSecureString
        $path = Save-Secret -Secret $secure -FileName 'deepseek-api-key.dpapi'
        Write-Output "saved=$path"
    }
    default {
        throw "不支持的 LLM 提供商 '$actualProvider'。"
    }
}
