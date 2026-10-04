param([int]$ProxyPort = 0, [switch]$Check)
$ErrorActionPreference = 'Stop'
$projectRoot = $PSScriptRoot
$runtime = Join-Path $projectRoot '.local\runtime\win-x64\node.exe'
$entry = Join-Path $projectRoot 'dist\src\main.js'
if (!(Test-Path -LiteralPath $runtime) -or !(Test-Path -LiteralPath $entry)) {
    throw 'Project runtime or build is missing. Restore .local/runtime and run npm run build.'
}
$disabled = Join-Path $projectRoot '.local\data\disabled'
if (!$Check -and (Test-Path -LiteralPath $disabled)) { Remove-Item -LiteralPath $disabled }
$bridgeArgs = @($entry)
if ($ProxyPort -ne 0) { $bridgeArgs += @('--proxy-port', $ProxyPort.ToString()) }
if ($Check) { $bridgeArgs += '--check' }
Push-Location $projectRoot
try { & $runtime @bridgeArgs; $bridgeExit = $LASTEXITCODE } finally { Pop-Location }
exit $bridgeExit
