[CmdletBinding()]
param(
    [Parameter(Mandatory = $false)]
    [string[]]$Paths,

    [Parameter(Mandatory = $false)]
    [string]$PathListFile
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

if (($null -eq $Paths -or $Paths.Count -eq 0) -and [string]::IsNullOrWhiteSpace($PathListFile)) {
    throw 'Provide either -Paths or -PathListFile.'
}

$resolvedPaths = if (-not [string]::IsNullOrWhiteSpace($PathListFile)) {
    if (-not (Test-Path -LiteralPath $PathListFile)) {
        throw "Path list file does not exist: $PathListFile"
    }
    Get-Content -LiteralPath $PathListFile | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
} else {
    $Paths
}

foreach ($path in $resolvedPaths) {
    if (-not (Test-Path -LiteralPath $path)) {
        [pscustomobject]@{
            Path = $path
            Exists = $false
            Files = 0
            SizeMB = 0
            LastWriteTime = $null
        }
        continue
    }

    $item = Get-Item -LiteralPath $path
    $files = @(Get-ChildItem -LiteralPath $path -Recurse -Force -File -ErrorAction SilentlyContinue)
    $size = if ($files.Count -eq 0) {
        0
    } else {
        ($files | Measure-Object -Property Length -Sum).Sum
    }

    [pscustomobject]@{
        Path = $path
        Exists = $true
        Files = $files.Count
        SizeMB = [math]::Round(($size / 1MB), 2)
        LastWriteTime = $item.LastWriteTime
    }
}
