[CmdletBinding()]
param()

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

$toolRoot = Split-Path -Parent $PSScriptRoot

# Friendly check instead of a raw "node is not recognized" flash-and-close.
if ($null -eq (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host '没有找到 Node.js。' -ForegroundColor Red
    Write-Host '请先到 https://nodejs.org 安装 Node.js 18 或更新版本，然后重新双击启动。'
    Read-Host '按回车键关闭'
    return
}

Push-Location $toolRoot
try {
    # First run (or a freshly unzipped release): install dependencies once so the
    # console can start without the user touching a terminal.
    if (-not (Test-Path -LiteralPath (Join-Path $toolRoot 'node_modules'))) {
        Write-Host '首次启动：正在安装依赖（npm install），可能需要一两分钟…' -ForegroundColor Cyan
        npm install
        if ($LASTEXITCODE -ne 0) {
            Write-Host 'npm install 失败。请检查网络连接和 Node.js 安装后重新启动。' -ForegroundColor Red
            Read-Host '按回车键关闭'
            return
        }
    }

    node "$toolRoot\src\server\control_center.js"
} finally {
    Pop-Location
}
