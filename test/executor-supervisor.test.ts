import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { ownTemporaryDirectory } from './temp-directory.js';

function powershell(script: string): Promise<string> {
  return new Promise((done, fail) => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { windowsHide: true, timeout: 15000 }, (error, stdout, stderr) => error ? fail(new Error(stderr || String(error))) : done(stdout.trim())));
}
const windows = process.platform === 'win32';
test('the real launcher restarts a dead daemon while an old descendant is still alive', { skip: !windows, timeout: 20000 }, async () => {
  const root = ownTemporaryDirectory(mkdtempSync(join(tmpdir(), 'executor-supervisor-')), 'executor-supervisor-');
  mkdirSync(join(root, 'dist/src/remote'), { recursive: true }); mkdirSync(join(root, '.local/remote'), { recursive: true });
  writeFileSync(join(root, '.local/remote/config.json'), '{}');
  writeFileSync(join(root, 'dist/src/remote/cli.js'), `const fs=require('node:fs'),cp=require('node:child_process');const p=${JSON.stringify(root)};
fs.appendFileSync(p+'/starts','1');const child=cp.spawn(process.execPath,['-e','setTimeout(()=>{},120000)'],{stdio:'ignore',windowsHide:true,detached:true});
fs.appendFileSync(p+'/children',child.pid+'\\n');child.unref();setTimeout(()=>process.exit(0),300);`);
  const launcher = resolve('scripts/start-remote-agent.ps1').replaceAll("'", "''");
  const quotedRoot = root.replaceAll("'", "''"), node = process.execPath.replaceAll("'", "''");
  const output = await powershell(`$ErrorActionPreference='Stop';$r='${quotedRoot}';$p=$null;try{
    $args=@('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File','"${launcher}"','-Root','"${quotedRoot}"','-NodePath','"${node}"');
    $p=Start-Process powershell.exe -ArgumentList $args -PassThru -WindowStyle Hidden;
    $deadline=[DateTime]::UtcNow.AddSeconds(8);do{Start-Sleep -Milliseconds 150;if(Test-Path -LiteralPath ($r+'\\starts')){$count=([IO.File]::ReadAllText($r+'\\starts')).Length}else{$count=0}}while($count -lt 2 -and [DateTime]::UtcNow -lt $deadline);
    $alive=0;if(Test-Path -LiteralPath ($r+'\\children')){foreach($line in [IO.File]::ReadAllLines($r+'\\children')){if(Get-Process -Id ([int]$line) -ErrorAction SilentlyContinue){$alive++}}};@{starts=$count;childrenAlive=$alive}|ConvertTo-Json -Compress
  }finally{if($p){Stop-Process -Id $p.Id -ErrorAction SilentlyContinue};if(Test-Path -LiteralPath ($r+'\\children')){foreach($line in [IO.File]::ReadAllLines($r+'\\children')){Stop-Process -Id ([int]$line) -ErrorAction SilentlyContinue}}};exit 0`);
  const result = JSON.parse(output); assert(result.starts >= 2, 'daemon did not restart'); assert(result.childrenAlive >= 1, 'descendant did not remain alive during restart');
});

test('the updater recycles only a proven idle, offline, childless launcher; Running is insufficient', { skip: !windows }, async () => {
  const script = readFileSync(resolve('scripts/update-remote-agent.ps1'), 'utf8');
  const body = script.slice(script.indexOf(' function Recover-IdleLauncher {'), script.indexOf(' $deadline='));
  assert(body.includes('Stop-Process -Id $supervisor.ProcessId'));
  const output = await powershell(`$ErrorActionPreference='Stop';$launcher='E:\\Owned\\scripts\\start-remote-agent.ps1';$resolvedRoot='E:\\Owned';$task=@{TaskName='owned';TaskPath='\\'};
  function Start-Sleep {}
  function Probe {@{online=$script:online;idle=$script:idle}}
  function Get-CimInstance {param($ClassName,$Filter);if($Filter){return $script:current};$script:all}
  function Stop-Process {param($Id);$script:killed+=$Id}
  function Get-ScheduledTask {@{State=if($script:killed.Count){'Ready'}else{'Running'}}}
  function Start-ScheduledTask {$script:started++}
  ${body}
  $supervisor=[pscustomobject]@{Name='powershell.exe';ProcessId=17;ParentProcessId=2;CreationDate='same';CommandLine=$launcher+' -Root '+$resolvedRoot};$results=@();
  foreach($case in @('hung','online','busy','child','ambiguous','reused')){
    $script:killed=@();$script:started=0;$script:online=$case -eq 'online';$script:idle=$case -ne 'busy';$script:all=@($supervisor);$script:current=$supervisor;
    if($case -eq 'child'){$script:all+=@{Name='node.exe';ProcessId=18;ParentProcessId=17}};
    if($case -eq 'ambiguous'){$script:all+=$supervisor};if($case -eq 'reused'){$script:current=@{CreationDate='changed';CommandLine=$supervisor.CommandLine}};
    $rejected=$false;try{Recover-IdleLauncher}catch{$rejected=$true};$results+=@{case=$case;killed=$script:killed.Count;started=$script:started;rejected=$rejected}
  };ConvertTo-Json -Compress -InputObject $results`);
  const results = JSON.parse(output) as Array<{ case: string; killed: number; started: number; rejected: boolean }>;
  for (const item of results) {
    assert.equal(item.killed, item.case === 'hung' ? 1 : 0, item.case); assert.equal(item.started, item.case === 'hung' ? 1 : 0, item.case);
    assert.equal(item.rejected, ['ambiguous', 'reused'].includes(item.case), item.case);
  }
});
