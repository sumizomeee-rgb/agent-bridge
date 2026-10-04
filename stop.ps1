$ErrorActionPreference = 'Stop'
$dataDir = Join-Path $PSScriptRoot '.local\data'
New-Item -ItemType Directory -Path $dataDir -Force | Out-Null
Set-Content -LiteralPath (Join-Path $dataDir 'disabled') -Value 'Stopped by user' -Encoding ascii
Set-Content -LiteralPath (Join-Path $dataDir 'stop.request') -Value 'Stop' -Encoding ascii
$pidFile = Join-Path $dataDir 'bridge.pid.json'
for ($attempt = 0; $attempt -lt 15; $attempt++) {
    if (!(Test-Path -LiteralPath $pidFile)) { Write-Output 'Bridge stopped.'; exit 0 }
    Start-Sleep -Seconds 1
}
throw 'Graceful stop is still pending. Inspect .local/logs/bridge.log before forcing a stop.'
