param([switch]$Drain, [ValidateRange(1,86400)][int]$WaitSeconds = 15)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'scripts\paths.ps1')
New-Item -ItemType Directory -Path $dataDir -Force | Out-Null
$pidFile = Join-Path $dataDir 'bridge.pid.json'
if ($Drain -and (Test-Path -LiteralPath $pidFile)) {
    $proof = Get-Content -LiteralPath $pidFile -Raw | ConvertFrom-Json
    if ($proof.drainStopVersion -ne 1) { throw 'Running host does not support maintenance drain. No stop requested.' }
}
Set-Content -LiteralPath (Join-Path $dataDir 'disabled') -Value 'Stopped by user' -Encoding ascii
$request = if ($Drain) { 'drain-stop.request' } else { 'stop.request' }
Set-Content -LiteralPath (Join-Path $dataDir $request) -Value 'Stop' -Encoding ascii
for ($attempt = 0; $attempt -lt $WaitSeconds; $attempt++) {
    if (!(Test-Path -LiteralPath $pidFile)) { Write-Output 'Bridge stopped.'; exit 0 }
    Start-Sleep -Seconds 1
}
throw 'Stop remains pending; no forced termination. For maintenance drain, the host stays paused until current work finishes. Inspect the selected Profile logs.'
