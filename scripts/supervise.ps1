$ErrorActionPreference = 'Continue'
$projectRoot = Split-Path -Parent $PSScriptRoot
$runtime = Join-Path $projectRoot '.local\runtime\win-x64\node.exe'
$entry = Join-Path $projectRoot 'dist\src\main.js'
$dataDir = Join-Path $projectRoot '.local\data'
$logDir = Join-Path $projectRoot '.local\logs'
New-Item -ItemType Directory -Path $dataDir,$logDir -Force | Out-Null
Set-Location $projectRoot
while (!(Test-Path -LiteralPath (Join-Path $dataDir 'disabled'))) {
    & $runtime $entry 2>> (Join-Path $logDir 'startup-errors.log')
    if (Test-Path -LiteralPath (Join-Path $dataDir 'disabled')) { break }
    Start-Sleep -Seconds 5
}
