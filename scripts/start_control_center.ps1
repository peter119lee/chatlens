[CmdletBinding()]
param()

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

$toolRoot = Split-Path -Parent $PSScriptRoot
Push-Location $toolRoot
try {
    node "$toolRoot\src\server\control_center.js"
} finally {
    Pop-Location
}
