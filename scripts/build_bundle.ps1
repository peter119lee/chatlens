# Builds the zero-setup Windows x64 release bundle: clean source + a bundled
# Node runtime + a trimmed node_modules, zipped so a user can unzip and run
# Start-QQ-Console.cmd with nothing else installed.
#
# The bundled node.exe and the prebuilt better_sqlite3.node MUST share an ABI,
# so this copies BOTH from a working install: the node.exe you point at and the
# node_modules that was installed with it. Run it from a checkout whose
# node_modules is installed and working (the console runs) with the same node.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\build_bundle.ps1 `
#     -Ref v0.0.1 -OutZip L:\out\chatlens-v0.0.1-win-x64.zip

[CmdletBinding()]
param(
    [string]$Ref = "HEAD",
    [string]$NodeExe = (Get-Command node).Source,
    # node_modules installed with the SAME node as -NodeExe (ABI must match the
    # prebuilt better_sqlite3.node). Defaults to this checkout's own install.
    [string]$NodeModulesDir = (Join-Path (Resolve-Path (Join-Path $PSScriptRoot "..")).Path 'node_modules'),
    [string]$OutZip = (Join-Path $PSScriptRoot "..\dist\chatlens-win-x64.zip")
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$toolRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$prefix = 'qqnt-readonly-summary-toolkit'
$work = Join-Path ([System.IO.Path]::GetTempPath()) ("bundle-" + [System.Guid]::NewGuid().ToString('N'))
$stage = Join-Path $work $prefix
New-Item -ItemType Directory -Force -Path $stage | Out-Null

try {
    # 1) Clean, tracked-only source at $Ref (honors .gitattributes -> CRLF launchers).
    Push-Location $toolRoot
    try {
        $tar = Join-Path $work 'src.tar'
        git archive --format=tar -o $tar $Ref
        if ($LASTEXITCODE -ne 0) { throw "git archive failed for ref '$Ref'." }
        tar -xf $tar -C $stage
        if ($LASTEXITCODE -ne 0) { throw "tar extract failed." }
    } finally {
        Pop-Location
    }

    # 2) Bundled Node runtime (node.exe is self-contained on Windows).
    New-Item -ItemType Directory -Force -Path (Join-Path $stage 'node') | Out-Null
    Copy-Item -LiteralPath $NodeExe -Destination (Join-Path $stage 'node\node.exe') -Force

    # 3) node_modules from the working install, then trim build-only artifacts.
    if (-not (Test-Path -LiteralPath $NodeModulesDir)) { throw "node_modules not found: $NodeModulesDir (run npm install first)." }
    $null = robocopy $NodeModulesDir (Join-Path $stage 'node_modules') /E /NFL /NDL /NJH /NJS /NP
    if ($LASTEXITCODE -ge 8) { throw "robocopy of node_modules failed (code $LASTEXITCODE)." }
    $bs = Join-Path $stage 'node_modules\better-sqlite3-multiple-ciphers'
    $binary = Join-Path $bs 'build\Release\better_sqlite3.node'
    if (-not (Test-Path -LiteralPath $binary)) { throw "prebuilt binary missing: $binary" }
    $tmpBin = Join-Path $work 'better_sqlite3.node'
    Copy-Item -LiteralPath $binary -Destination $tmpBin -Force
    Remove-Item -LiteralPath (Join-Path $bs 'build') -Recurse -Force
    New-Item -ItemType Directory -Force -Path (Join-Path $bs 'build\Release') | Out-Null
    Move-Item -LiteralPath $tmpBin -Destination $binary -Force
    foreach ($d in 'deps','src','docs') {
        $p = Join-Path $bs $d
        if (Test-Path -LiteralPath $p) { Remove-Item -LiteralPath $p -Recurse -Force }
    }

    # 4) Bundle launcher runs the bundled node directly (no system Node, no npm).
    $ascii = [System.Text.Encoding]::ASCII
    $cmd = "@echo off`r`nsetlocal`r`ncd /d `"%~dp0`"`r`n`".\node\node.exe`" `".\src\server\control_center.js`"`r`npause`r`n"
    [System.IO.File]::WriteAllText((Join-Path $stage 'Start-QQ-Console.cmd'), $cmd, $ascii)

    # 5) Zip with forward-slash entry names (spec-compliant across extractors).
    $outDir = Split-Path -Parent $OutZip
    if (-not (Test-Path -LiteralPath $outDir)) { New-Item -ItemType Directory -Force -Path $outDir | Out-Null }
    if (Test-Path -LiteralPath $OutZip) { Remove-Item -LiteralPath $OutZip -Force }
    $fs = [System.IO.File]::Open($OutZip, [System.IO.FileMode]::CreateNew)
    $archive = New-Object System.IO.Compression.ZipArchive($fs, [System.IO.Compression.ZipArchiveMode]::Create)
    try {
        $baseLen = $work.TrimEnd('\').Length + 1
        foreach ($f in (Get-ChildItem -LiteralPath $stage -Recurse -File -Force)) {
            $rel = $f.FullName.Substring($baseLen).Replace('\', '/')
            [void][System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, $f.FullName, $rel, [System.IO.Compression.CompressionLevel]::Optimal)
        }
    } finally {
        $archive.Dispose(); $fs.Dispose()
    }

    Write-Host ("bundle written: {0} ({1:N1} MB)" -f $OutZip, ((Get-Item $OutZip).Length / 1MB))
} finally {
    if (Test-Path -LiteralPath $work) { Remove-Item -LiteralPath $work -Recurse -Force }
}
