[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$RunDir,

    [Parameter(Mandatory = $true)]
    [string]$GroupId,

    [Parameter(Mandatory = $true)]
    [int]$Days,

    [Parameter(Mandatory = $true)]
    [int]$ScanLimit
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

if ($Days -le 0) {
    throw "Days 无效，必须大于 0。Days=$Days"
}

$now = [DateTimeOffset]::Now
$startUnix = $now.AddDays(-1 * $Days).ToUnixTimeSeconds()
$endUnix = $now.ToUnixTimeSeconds()

& "$PSScriptRoot\summarize_groups.ps1" `
    -RunDir $RunDir `
    -GroupIdsCsv $GroupId `
    -StartUnix $startUnix `
    -EndUnix $endUnix `
    -ScanLimit $ScanLimit
