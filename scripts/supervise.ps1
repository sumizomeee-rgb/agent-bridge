$ErrorActionPreference = 'Continue'
$projectRoot = Split-Path -Parent $PSScriptRoot
$runtime = Join-Path $projectRoot '.local\runtime\win-x64\node.exe'
$entry = Join-Path $projectRoot 'dist\src\main.js'
$restartEntry = Join-Path $projectRoot 'dist\src\restart.js'
$dataDir = Join-Path $projectRoot '.local\data'
$logDir = Join-Path $projectRoot '.local\logs'
New-Item -ItemType Directory -Path $dataDir,$logDir -Force | Out-Null
$identityBytes = [Text.Encoding]::UTF8.GetBytes($projectRoot.ToLowerInvariant())
$identityHash = [Security.Cryptography.SHA256]::Create()
try { $supervisorIdentity = [BitConverter]::ToString($identityHash.ComputeHash($identityBytes)).Replace('-','') } finally { $identityHash.Dispose() }
$supervisorMutex = New-Object Threading.Mutex($false, "Global\DiscordAgentBridgeSupervisor-$supervisorIdentity")
$ownsSupervisor = $false
$previousSupervised = $env:BRIDGE_SUPERVISED
try {
    try { $ownsSupervisor = $supervisorMutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $ownsSupervisor = $true }
    if (!$ownsSupervisor) { exit 0 }
    $env:BRIDGE_SUPERVISED = '1'
    Set-Location $projectRoot
    while (!(Test-Path -LiteralPath (Join-Path $dataDir 'disabled'))) {
        & $runtime $entry 2>> (Join-Path $logDir 'startup-errors.log')
        $bridgeExit = $LASTEXITCODE
        if (Test-Path -LiteralPath $restartEntry) {
            & $runtime $restartEntry --supervisor-exit $dataDir $bridgeExit 2>> (Join-Path $logDir 'startup-errors.log')
        }
        if (Test-Path -LiteralPath (Join-Path $dataDir 'disabled')) { break }
        # 76 means an owned CLI has not been confirmed stopped. Do not retry.
        if ($bridgeExit -eq 76) { break }
        if ($bridgeExit -eq 75) { Start-Sleep -Milliseconds 500 } else { Start-Sleep -Seconds 5 }
    }
} finally {
    $env:BRIDGE_SUPERVISED = $previousSupervised
    if ($ownsSupervisor) { $supervisorMutex.ReleaseMutex() }
    $supervisorMutex.Dispose()
}
