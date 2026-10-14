$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'scripts\paths.ps1')
New-Item -ItemType Directory -Path $dataDir -Force | Out-Null
Set-Content -LiteralPath (Join-Path $dataDir 'disabled') -Value 'Stopped by user' -Encoding ascii
Set-Content -LiteralPath (Join-Path $dataDir 'stop.request') -Value 'Stop' -Encoding ascii
$pidFile = Join-Path $dataDir 'bridge.pid.json'
for ($attempt = 0; $attempt -lt 15; $attempt++) {
    if (!(Test-Path -LiteralPath $pidFile)) { Write-Output 'Bridge stopped.'; exit 0 }
    Start-Sleep -Seconds 1
}
throw 'Graceful stop is still pending. Inspect the selected Profile logs before forcing a stop.'
