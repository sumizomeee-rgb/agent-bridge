param([int]$ProxyPort = 0, [switch]$Check, [string]$Profile, [ValidateSet('discord','feishu')][string]$Platform)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'scripts\paths.ps1')
$selectedProfile = Resolve-BridgeProfile $Profile $Platform
$runtime = Join-Path $bridgeRoot '.local\runtime\win-x64\node.exe'
$entry = Join-Path $bridgeRoot 'dist\src\main.js'
if (!(Test-Path -LiteralPath $runtime) -or !(Test-Path -LiteralPath $entry)) { throw 'Project runtime or build is missing. Restore .local/runtime and run npm run build.' }
$disabled = Join-Path $dataDir 'disabled'
if (!$Check -and (Test-Path -LiteralPath $disabled)) { Remove-Item -LiteralPath $disabled }
$bridgeArgs = @($entry, '--profile', $selectedProfile)
if ($ProxyPort -ne 0) { $bridgeArgs += @('--proxy-port', $ProxyPort.ToString()) }
if ($Check) { $bridgeArgs += '--check' }
Push-Location $bridgeRoot
try { & $runtime @bridgeArgs; $bridgeExit = $LASTEXITCODE } finally { Pop-Location }
exit $bridgeExit
