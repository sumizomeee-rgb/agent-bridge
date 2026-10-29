param([Parameter(Mandatory=$true)][string]$Root,[Parameter(Mandatory=$true)][string]$NodePath,
 [Parameter(Mandatory=$true)][string]$ExpectedHostname,[Parameter(Mandatory=$true)][string]$Release,[Parameter(Mandatory=$true)][string]$ArchiveHash)
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';$env:NODE_NO_WARNINGS='1'
if([Environment]::MachineName -ine $ExpectedHostname){throw 'Wrong executor hostname'}
if($Release -notmatch '^[a-f0-9]{64}$' -or $ArchiveHash -notmatch '^[a-f0-9]{64}$'){throw 'Invalid release identity'}
$resolvedRoot=[IO.Path]::GetFullPath($Root);$data=Join-Path $resolvedRoot '.local\remote'
$mutex=New-Object Threading.Mutex($false,('Local\AgentExecutorUpdate-'+$resolvedRoot.ToLower().GetHashCode()))
$owned=$false;$leased=$false;$switched=$false;$lease=[guid]::NewGuid().ToString('N')
try {
 $owned=$mutex.WaitOne(0);if(!$owned){@{state='busy';reason='Another executor update is in progress'}|ConvertTo-Json -Compress;return}
 $helper=Join-Path $PSScriptRoot 'remote-update-helper.mjs'
 function Probe { $text=& $NodePath $helper inspect $resolvedRoot $ExpectedHostname;if($LASTEXITCODE -ne 0){throw 'Cannot verify executor state'};$text|ConvertFrom-Json }
 $probe=Probe
 if($probe.online -and $probe.release -eq $Release){@{state='ready';release=$Release}|ConvertTo-Json -Compress;return}
 if(!$probe.idle){@{state='busy';reason='Waiting for active or unconfirmed work; automatic retry pending'}|ConvertTo-Json -Compress;return}
 $archive=Join-Path $PSScriptRoot 'runtime.tgz'
 if((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ine $ArchiveHash){throw 'Archive checksum mismatch'}
 $candidate=Join-Path $data ('releases\'+$Release)
 # Only an immutable, checked release directory receives extracted program files.
 $entries=@(& tar -tzf $archive|ForEach-Object {$_ -replace '^\./',''});if($LASTEXITCODE -ne 0){throw 'Cannot list release archive'}
 if($entries | Where-Object {$_ -and ($_ -match '(^[/\\]|^[A-Za-z]:|(^|[/\\])\.\.([/\\]|$))' -or $_ -notmatch '^(dist/|harness/|node_modules/|scripts/|package.json$|release.json$)')}){throw 'Unsafe archive entries'}
 New-Item -ItemType Directory -Force -Path $candidate|Out-Null
 & tar -xzf $archive -C $candidate;if($LASTEXITCODE -ne 0){throw 'Release extraction failed'}
 & $NodePath $helper verify $resolvedRoot $ExpectedHostname $Release|Out-Null;if($LASTEXITCODE -ne 0){throw 'Release verification failed'}
 $tasks=@(Get-ScheduledTask|Where-Object {($_.Actions.Arguments -join ' ') -like ('*'+$resolvedRoot+'*start-remote-agent.ps1*') -or (($_.Actions.Arguments -join ' ') -like ('*start-remote-agent.ps1*') -and ($_.Actions.Arguments -join ' ') -like ('*'+$resolvedRoot+'*'))})
 if($tasks.Count -ne 1){throw 'Executor logon task is missing or ambiguous'}
 $task=$tasks[0]
 if($probe.maintenance){
  $answer=& $NodePath $helper prepare $resolvedRoot $ExpectedHostname $lease|ConvertFrom-Json
  if($LASTEXITCODE -ne 0 -or !$answer.ready){@{state='busy';reason='Executor busy; automatic retry pending'}|ConvertTo-Json -Compress;return};$leased=$true
 }
 # Old executors lack maintenance RPC. Upgrade only with an idle journal and no child CLI.
 $daemons=@(Get-CimInstance Win32_Process|Where-Object {$_.ExecutablePath -eq $NodePath -and $_.CommandLine -like ('*'+$resolvedRoot+'*remote*cli.js*') -and $_.CommandLine -like '*--serve*'})
 if($daemons.Count -gt 1){throw 'Ambiguous executor processes'}
 if(!$probe.maintenance -and $daemons.Count -eq 1){
  $before=$daemons[0];$check=Probe
  $children=@(Get-CimInstance Win32_Process -Filter ('ParentProcessId='+$before.ProcessId)|Where-Object {$_.ExecutablePath -ine (Join-Path $env:SystemRoot 'System32\conhost.exe')})
  if(!$check.idle -or $children.Count){@{state='busy';reason='Legacy executor still owns native operations; automatic retry pending'}|ConvertTo-Json -Compress;return}
 }
 $pointer=Join-Path $data 'active-release.json';$previous=if(Test-Path -LiteralPath $pointer){[IO.File]::ReadAllText($pointer)}else{$null}
 $launcher=Join-Path $resolvedRoot 'scripts\start-remote-agent.ps1'
 $oldLauncher=[IO.File]::ReadAllBytes($launcher)
 Copy-Item -LiteralPath (Join-Path $candidate 'scripts\start-remote-agent.ps1') -Destination $launcher -Force
 $temporary=$pointer+'.'+$lease+'.tmp'
 [IO.File]::WriteAllText($temporary,(@{version=1;id=$Release;path=$candidate}|ConvertTo-Json -Compress),(New-Object Text.UTF8Encoding($false)))
 if(Test-Path -LiteralPath $pointer){[IO.File]::Replace($temporary,$pointer,($pointer+'.previous'))}else{[IO.File]::Move($temporary,$pointer)};$switched=$true
 if($leased){& $NodePath $helper stop $resolvedRoot $ExpectedHostname $lease|Out-Null;if($LASTEXITCODE -ne 0){throw 'Graceful executor stop failed'}}
 elseif($daemons.Count -eq 1){
  $current=Get-CimInstance Win32_Process -Filter ('ProcessId='+$before.ProcessId)
  if(!$current -or $current.CreationDate -ne $before.CreationDate -or $current.CommandLine -ne $before.CommandLine){throw 'Legacy executor process identity changed'}
  # Stop only this proven-idle daemon, never its process tree or any worker.
  Stop-Process -Id $before.ProcessId -ErrorAction Stop
 }
 # An old launcher may still be waiting on Start-Process -Wait's descendant job.
 # Only recycle that exact launcher when the daemon is offline and its journal is idle.
 function Recover-IdleLauncher {
  $check=Probe;if($check.online -or !$check.idle){return}
  $all=@(Get-CimInstance Win32_Process)
  $supervisors=@($all|Where-Object {$_.Name -ieq 'powershell.exe' -and $_.CommandLine -like ('*'+$launcher+'*') -and $_.CommandLine -like ('*'+$resolvedRoot+'*')})
  if($supervisors.Count -gt 1){throw 'Ambiguous executor launchers'}
  if($supervisors.Count -eq 1){
   $supervisor=$supervisors[0]
   $children=@($all|Where-Object {$_.ParentProcessId -eq $supervisor.ProcessId -and $_.Name -ine 'conhost.exe'})
   if($children.Count){return}
   $current=Get-CimInstance Win32_Process -Filter ('ProcessId='+$supervisor.ProcessId)
   if(!$current -or $current.CreationDate -ne $supervisor.CreationDate -or $current.CommandLine -ne $supervisor.CommandLine){throw 'Executor launcher identity changed'}
   Stop-Process -Id $supervisor.ProcessId -ErrorAction Stop
   Start-Sleep -Milliseconds 300
  }
  if((Get-ScheduledTask -TaskName $task.TaskName -TaskPath $task.TaskPath).State -ne 'Running'){Start-ScheduledTask -TaskName $task.TaskName -TaskPath $task.TaskPath}
 }
 $deadline=[DateTime]::UtcNow.AddSeconds(35)
 for($attempt=0;[DateTime]::UtcNow -lt $deadline;$attempt++){
  Start-Sleep -Seconds 1
  if($attempt -eq 2){Recover-IdleLauncher}
  if((Get-ScheduledTask -TaskName $task.TaskName -TaskPath $task.TaskPath).State -ne 'Running'){Start-ScheduledTask -TaskName $task.TaskName -TaskPath $task.TaskPath}
  $ready=Probe;if($ready.online -and $ready.release -eq $Release){@{state='ready';release=$Release}|ConvertTo-Json -Compress;return}
 }
 throw 'New executor did not become ready'
} catch {
 if($switched){
  if($null -eq $previous){Remove-Item -LiteralPath $pointer -ErrorAction SilentlyContinue}else{[IO.File]::WriteAllText($pointer,$previous)}
  [IO.File]::WriteAllBytes($launcher,$oldLauncher)
  # The update supervisor retries the restored pointer; never kill a new process that may own work.
  if((Get-ScheduledTask -TaskName $task.TaskName -TaskPath $task.TaskPath).State -ne 'Running'){Start-ScheduledTask -TaskName $task.TaskName -TaskPath $task.TaskPath}
 }
 throw
} finally {
 if($leased){& $NodePath $helper cancel $resolvedRoot $ExpectedHostname $lease 2>$null|Out-Null}
 if($owned){$mutex.ReleaseMutex()};$mutex.Dispose()
}
