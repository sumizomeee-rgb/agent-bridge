param([switch]$StartNow)
$ErrorActionPreference = 'Stop'
$projectRoot = $PSScriptRoot
$pwsh = 'C:\Program Files\PowerShell\7\pwsh.exe'
if (!(Test-Path -LiteralPath $pwsh)) { throw 'PowerShell 7 is required.' }
$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$action = New-ScheduledTaskAction -Execute $pwsh -Argument ('-NoLogo -NoProfile -WindowStyle Hidden -File "' + (Join-Path $projectRoot 'scripts\supervise.ps1') + '"') -WorkingDirectory $projectRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName 'SumizomeDiscordAgentBridge' -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
if ($StartNow) { Start-ScheduledTask -TaskName 'SumizomeDiscordAgentBridge' }
Write-Output 'Startup task installed: SumizomeDiscordAgentBridge'
