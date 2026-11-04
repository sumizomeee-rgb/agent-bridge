import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { AgentCommand } from '../types.js';

/** Completed turns only: stop owned CLI handles, never a process tree or a business child. */
export async function stopCompletedCli(child: ChildProcessWithoutNullStreams, command: AgentCommand): Promise<{ stopped: boolean; authorized: boolean; reason?: string }> {
  const live = () => child.exitCode === null && child.signalCode === null;
  if (!child.pid || !live()) return { stopped: !live(), authorized: false };
  if (process.platform !== 'win32') {
    // Native CLIs handle SIGTERM; arbitrary launchers cannot prove their child exited.
    // No validated descendant/ownership probe is implemented for POSIX yet.
    return { stopped: false, authorized: false, reason: '当前平台未验证安全 CLI 收尾' };
  }
  const executable = basename(command.command).toLowerCase();
  const launcher = executable === 'node.exe' && command.args.some(arg => /[\\/]bin[\\/]codex\.js$/i.test(arg));
  if (!launcher && !['codex.exe', 'claude.exe', 'node.exe'].includes(executable)) return { stopped: false, authorized: false, reason: '未识别的 CLI 启动器' };
  const modern = join(process.env.ProgramFiles ?? 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe');
  const script = `$ErrorActionPreference='Stop';$root=$null;$owned=@()
try {
 $root=[Diagnostics.Process]::GetProcessById(${child.pid});$null=$root.Handle
 $children=@(Get-CimInstance Win32_Process -Filter 'ParentProcessId=${child.pid}' | Where-Object {$_.Name -ine 'conhost.exe'})
 ${launcher ? "if($children.Count -ne 1 -or $children[0].Name -ine 'codex.exe'){throw ('Unrecognized Codex launcher child: '+$children.Count+' / '+($children.Name -join ','))}; $native=[Diagnostics.Process]::GetProcessById([int]$children[0].ProcessId);$null=$native.Handle;$owned=@($native);if($native.HasExited -or [Math]::Abs(($native.StartTime.ToUniversalTime()-([datetime]$children[0].CreationDate).ToUniversalTime()).TotalMilliseconds) -gt 1){throw 'Child identity changed'}" : executable === 'node.exe' ? "if($children.Count -ne 0){throw 'Unrecognized Node launcher children'}" : ''}
 $cli=${launcher ? '$native' : '$root'};$cliPid=$cli.Id
 $dependents=@(Get-CimInstance Win32_Process -Filter ('ParentProcessId='+$cliPid) | Where-Object {$_.Name -ine 'conhost.exe'})
 $auxiliary=@()
 foreach($item in $dependents){
  $codeHost=$item.Name -ieq 'codex-code-mode-host.exe' -and [IO.Path]::GetDirectoryName($item.ExecutablePath) -ieq [IO.Path]::GetDirectoryName($cli.MainModule.FileName)
  $nodeRepl=$item.Name -ieq 'node_repl.exe' -and $item.ExecutablePath -like ([IO.Path]::Combine($env:LOCALAPPDATA,'OpenAI','Codex','runtimes','cua_node','*','bin','node_repl.exe'))
  if($cli.ProcessName -ine 'codex' -or (-not $codeHost -and -not $nodeRepl)){throw 'CLI still owns child processes; preserved for controller review'}
  $held=[Diagnostics.Process]::GetProcessById([int]$item.ProcessId);$null=$held.Handle;$auxiliary+=@($held);$owned=@($held)+$owned
  if($held.HasExited -or [Math]::Abs(($held.StartTime.ToUniversalTime()-([datetime]$item.CreationDate).ToUniversalTime()).TotalMilliseconds) -gt 1){throw 'Auxiliary identity changed'}
 }
 if($auxiliary.Count -gt 0){
  $filter=($auxiliary|ForEach-Object{'ParentProcessId='+$_.Id}) -join ' OR '
  $other=@(Get-CimInstance Win32_Process -Filter $filter | Where-Object {$_.Name -ine 'conhost.exe'})
  if($other.Count -ne 0){throw 'CLI auxiliary still owns child processes; preserved for controller review'}
 }
 if($root.HasExited){throw 'Root already exited'}
 [Console]::Out.WriteLine('READY')
 if([Console]::ReadLine() -ne 'STOP' -or $root.HasExited){exit}
 foreach($item in $owned){if(-not $item.HasExited){$item.Kill()};if(-not $item.WaitForExit(3000)){throw 'CLI did not exit'}}
 ${launcher ? "if(-not $root.WaitForExit(3000)){throw 'Launcher did not exit after native CLI stopped'}" : "if(-not $root.HasExited){$root.Kill()};if(-not $root.WaitForExit(3000)){throw 'CLI did not exit'}"}
 [Console]::Out.WriteLine('STOPPED')
}catch{[Console]::Out.WriteLine('FAILED:'+ $_.Exception.Message)}
finally{foreach($item in $owned){$item.Dispose()};if($root){$root.Dispose()}}`;
  const helper = spawn(existsSync(modern) ? modern : 'powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
  let authorized = false, stopped = false, open = true, buffer = '', failure = '';
  helper.stdin.on('error', () => {}); helper.stderr.on('data', () => {});
  helper.stdout.setEncoding('utf8');
  helper.stdout.on('data', (part: string) => {
    buffer += part; let at: number;
    while ((at = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, at).trim(); buffer = buffer.slice(at + 1);
      if (line === 'READY') { authorized = open && live(); helper.stdin.end(authorized ? 'STOP\n' : 'SKIP\n'); }
      if (line === 'STOPPED' && authorized) stopped = true;
      if (line.startsWith('FAILED:')) failure = line.slice(7, 300);
    }
    if (buffer.length > 128) buffer = '';
  });
  return await new Promise(resolve => {
    const timer = setTimeout(() => { open = false; helper.stdin.end(); helper.kill(); resolve({ stopped: false, authorized, reason: 'CLI 收尾检查超时' }); }, 20000);
    const finish = () => { open = false; clearTimeout(timer); resolve({ stopped, authorized, ...(failure ? { reason: failure } : {}) }); };
    helper.once('error', finish); helper.once('close', finish);
  });
}
