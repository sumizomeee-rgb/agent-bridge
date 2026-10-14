param([switch]$StartNow, [string]$Profile)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'scripts\paths.ps1')
$selectedProfile = Resolve-BridgeProfile $Profile ''
$pwsh = 'C:\Program Files\PowerShell\7\pwsh.exe'
if (!(Test-Path -LiteralPath $pwsh)) { throw 'PowerShell 7 is required.' }
$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$action = New-ScheduledTaskAction -Execute $pwsh -Argument ('-NoLogo -NoProfile -WindowStyle Hidden -File "' + (Join-Path $bridgeRoot 'scripts\supervise.ps1') + '" -Profile "' + $selectedProfile + '"') -WorkingDirectory $bridgeRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName 'SumizomeAgentBridge' -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
if ($StartNow) {
    $disabled = Join-Path $dataDir 'disabled'
    if (Test-Path -LiteralPath $disabled) { Remove-Item -LiteralPath $disabled }
    Start-ScheduledTask -TaskName 'SumizomeAgentBridge'
}
Write-Output ('Startup task installed: SumizomeAgentBridge (' + $selectedProfile + ')')
