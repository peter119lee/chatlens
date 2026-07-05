[CmdletBinding()]
param()

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

$toolRoot = Split-Path -Parent $PSScriptRoot

# Friendly check instead of a raw "node is not recognized" flash-and-close.
if ($null -eq (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host 'Node.js was not found on PATH.' -ForegroundColor Red
    Write-Host 'Install Node.js 18+ from https://nodejs.org and run this again.'
    Read-Host 'Press Enter to close'
    return
}

Push-Location $toolRoot
try {
    # First run (or a freshly unzipped release): install dependencies once so the
    # console can start without the user touching a terminal.
    if (-not (Test-Path -LiteralPath (Join-Path $toolRoot 'node_modules'))) {
        Write-Host 'First run: installing dependencies (npm install). This can take a minute...' -ForegroundColor Cyan
        npm install
        if ($LASTEXITCODE -ne 0) {
            Write-Host 'npm install failed. Check your network connection and Node.js installation, then run this again.' -ForegroundColor Red
            Read-Host 'Press Enter to close'
            return
        }
    }

    node "$toolRoot\src\server\control_center.js"
} finally {
    Pop-Location
}
