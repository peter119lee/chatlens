[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$RunDir,

    [Parameter(Mandatory = $true)]
    [string]$NtDataDir,

    [Parameter(Mandatory = $true)]
    [string]$FormatsCsv
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

$mediaMessagesJson = Join-Path $RunDir 'analysis\media-messages.json'
if (-not (Test-Path -LiteralPath $mediaMessagesJson)) {
    throw "Media messages file does not exist: $mediaMessagesJson"
}

if (-not (Test-Path -LiteralPath $NtDataDir)) {
    throw "QQNT nt_data directory does not exist: $NtDataDir"
}

$mediaDir = Join-Path $RunDir 'media'
node "$PSScriptRoot\..\src\export_media_files.js" $mediaMessagesJson $NtDataDir $mediaDir $FormatsCsv
if ($LASTEXITCODE -ne 0) {
    throw "Media export failed. RunDir=$RunDir NtDataDir=$NtDataDir FormatsCsv=$FormatsCsv ExitCode=$LASTEXITCODE"
}
