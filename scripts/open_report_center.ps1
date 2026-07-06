[CmdletBinding()]
param(
    [Parameter(Mandatory = $false)]
    [string]$ConfigPath
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
$outputHtml = Join-Path ([string]$config.reportsDir) 'index.html'

node (Join-Path $toolRoot 'src\generate_report_center.js') $actualConfigPath $outputHtml
if ($LASTEXITCODE -ne 0) {
    throw "生成报告中心失败（ExitCode=$LASTEXITCODE）。OutputHtml=$outputHtml"
}

Write-Output "reportCenter=$outputHtml"
Start-Process -FilePath $outputHtml | Out-Null
