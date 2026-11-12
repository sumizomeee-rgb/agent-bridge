import { execFile } from 'node:child_process';
import { cpus, freemem, hostname, totalmem, uptime } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import type { BridgePresentation } from './presentation.js';

interface ProcessSample {
  pid: number; name: string; started: string; cpuMs: number | null;
  privateBytes: number | null; workingSetBytes: number | null;
}
export interface HostProcess {
  pid: number; name: string; cpuPercent: number | null;
  privateBytes: number | null; workingSetBytes: number | null;
}
export interface HostSnapshot {
  hostname: string; sampledAt: string; logicalCpus: number; cpuPercent: number | null;
  totalBytes: number; availableBytes: number; uptimeSeconds: number;
  cpuTop: HostProcess[]; memoryTop: HostProcess[]; processError?: string;
}

// No command lines, environment, paths, credentials or permanent diagnostic files.
const windowsSample = String.raw`
$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
Add-Type @'
using System.Runtime.InteropServices;
public static class BridgeHostCpu {
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool GetSystemTimes(out long idle, out long kernel, out long user);
}
'@
function CpuTimes {
  $idle=0L; $kernel=0L; $user=0L
  if(![BridgeHostCpu]::GetSystemTimes([ref]$idle,[ref]$kernel,[ref]$user)){throw 'CPU counters unavailable'}
  [pscustomobject]@{idle=[double]$idle;total=([double]$kernel+[double]$user)}
}
$clock=[Diagnostics.Stopwatch]::StartNew()
function Snapshot {
  $start=$clock.Elapsed.TotalMilliseconds
  $rows=@(Get-CimInstance Win32_Process -Property ProcessId,Name,CreationDate,KernelModeTime,UserModeTime,PrivatePageCount,WorkingSetSize | ForEach-Object {
    if($_.ProcessId -gt 0 -and $_.ProcessId -ne $PID){
      [pscustomobject]@{pid=[int]$_.ProcessId;name=[string]$_.Name
        started=$(if($_.CreationDate){$_.CreationDate.ToUniversalTime().ToString('o')}else{''})
        cpuMs=$(if($null -ne $_.KernelModeTime -and $null -ne $_.UserModeTime){([double]$_.KernelModeTime+[double]$_.UserModeTime)/10000}else{$null})
        privateBytes=$(if($null -ne $_.PrivatePageCount){[double]$_.PrivatePageCount}else{$null})
        workingSetBytes=$(if($null -ne $_.WorkingSetSize){[double]$_.WorkingSetSize}else{$null})}
    }
  })
  [pscustomobject]@{at=($start+$clock.Elapsed.TotalMilliseconds)/2;rows=$rows}
}
$first=Snapshot; $cpuBefore=CpuTimes
Start-Sleep -Milliseconds 1000
$second=Snapshot; $cpuAfter=CpuTimes
[pscustomobject]@{before=$first.rows;after=$second.rows;elapsedMs=($second.at-$first.at);cpuBefore=$cpuBefore;cpuAfter=$cpuAfter} | ConvertTo-Json -Depth 4 -Compress
`;
const execute = promisify(execFile);
const number = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
function samples(value: unknown): ProcessSample[] {
  if (!Array.isArray(value)) throw new Error('invalid process samples');
  return value.filter((row): row is ProcessSample => row && typeof row === 'object' && Number.isInteger(row.pid) && row.pid > 0
    && typeof row.name === 'string' && typeof row.started === 'string'
    && (row.cpuMs === null || number(row.cpuMs)) && (row.privateBytes === null || number(row.privateBytes))
    && (row.workingSetBytes === null || number(row.workingSetBytes)));
}
export function rankHostProcesses(before: ProcessSample[], after: ProcessSample[], elapsedMs: number, logicalCpus: number) {
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0 || !Number.isInteger(logicalCpus) || logicalCpus < 1) throw new Error('invalid sampling interval');
  const previous = new Map(before.map(row => [row.pid, row]));
  const processes: HostProcess[] = after.filter(row => row.pid > 0).map(row => {
    const old = previous.get(row.pid);
    const cpuPercent = old && row.started && old.started === row.started && old.cpuMs !== null && row.cpuMs !== null && row.cpuMs >= old.cpuMs
      ? Math.min(100, (row.cpuMs - old.cpuMs) / elapsedMs / logicalCpus * 100) : null;
    return { pid: row.pid, name: row.name.replace(/[\p{Cc}\p{Cf}]/gu, ' ').slice(0, 80),
      cpuPercent, privateBytes: row.privateBytes, workingSetBytes: row.workingSetBytes };
  });
  return {
    cpuTop: processes.filter(row => row.cpuPercent !== null).sort((a, b) => b.cpuPercent! - a.cpuPercent! || a.pid - b.pid).slice(0, 5),
    memoryTop: processes.filter(row => row.privateBytes !== null).sort((a, b) => b.privateBytes! - a.privateBytes! || a.pid - b.pid).slice(0, 5),
  };
}
function cpuTotals() {
  return cpus().reduce((sum, cpu) => {
    sum.idle += cpu.times.idle;
    sum.total += Object.values(cpu.times).reduce((n, time) => n + time, 0);
    return sum;
  }, { idle: 0, total: 0 });
}
export function processorUsage(start: { idle: number; total: number }, end: { idle: number; total: number }): number | null {
  if (![start?.idle, start?.total, end?.idle, end?.total].every(number)) return null;
  const total = end.total - start.total, idle = end.idle - start.idle;
  return total > 0 && idle >= 0 && idle <= total ? (1 - idle / total) * 100 : null;
}
async function sampleHost(): Promise<HostSnapshot> {
  const logicalCpus = Math.max(1, cpus().length), start = cpuTotals();
  let lists: Pick<HostSnapshot, 'cpuTop' | 'memoryTop'> = { cpuTop: [], memoryTop: [] }, processError: string | undefined;
  let sampledCpu: number | null | undefined;
  await Promise.all([delay(1000), (async () => {
    if (process.platform !== 'win32') { processError = '此系统暂不支持进程榜单'; return; }
    try {
      const shell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      const { stdout } = await execute(shell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(windowsSample, 'utf16le').toString('base64')],
        { windowsHide: true, timeout: 15_000, maxBuffer: 2 * 1024 * 1024, encoding: 'utf8' });
      const data = JSON.parse(stdout.replace(/^\uFEFF/, '').trim());
      lists = rankHostProcesses(samples(data.before), samples(data.after), data.elapsedMs, logicalCpus);
      sampledCpu = processorUsage(data.cpuBefore, data.cpuAfter);
    } catch (error) {
      processError = (error as { killed?: boolean }).killed ? '进程采集超时，请稍后重试' : '进程采集失败，请稍后重试';
    }
  })()]);
  const end = cpuTotals();
  const totalBytes = totalmem();
  return { hostname: hostname(), sampledAt: new Date().toISOString(), logicalCpus,
    cpuPercent: sampledCpu === undefined ? processorUsage(start, end) : sampledCpu,
    totalBytes, availableBytes: Math.min(totalBytes, freemem()), uptimeSeconds: uptime(), ...lists, ...(processError ? { processError } : {}) };
}
// Concurrent Bot queries share one sample rather than spawn duplicate collectors.
let pending: Promise<HostSnapshot> | undefined;
export function collectHostSnapshot(): Promise<HostSnapshot> {
  if (!pending) pending = sampleHost().finally(() => { pending = undefined; });
  return pending;
}
function bytes(value: number | null): string {
  if (value === null) return '未知';
  return value >= 1024 ** 3 ? `${(value / 1024 ** 3).toFixed(2)} GiB` : `${(value / 1024 ** 2).toFixed(0)} MiB`;
}
function percent(value: number | null): string { return value === null ? '未知' : `${value.toFixed(1)}%`; }
export function hostStatusPresentation(s: HostSnapshot): BridgePresentation {
  const used = s.totalBytes - s.availableBytes, minutes = Math.floor(s.uptimeSeconds / 60);
  return { title: '桥电脑状态 · 即时快照', tone: s.processError ? 'warning' : 'info', purpose: 'status', blocks: [
    { kind: 'entry', text: `电脑：${s.hostname}\nCPU：${percent(s.cpuPercent)} · ${s.logicalCpus} 逻辑核\n物理内存：${bytes(used)} / ${bytes(s.totalBytes)}（${percent(s.totalBytes ? used / s.totalBytes * 100 : null)}）\n运行时长：${Math.floor(minutes / 1440)}天 ${Math.floor(minutes / 60) % 24}小时 ${minutes % 60}分\n采集时间：${new Date(s.sampledAt).toLocaleString('zh-CN', { hour12: false, timeZoneName: 'short' })}` },
    { kind: 'entry', text: 'CPU 前5 · 按整机全部逻辑核折算\n' + (s.cpuTop.map((p, i) => `${i + 1}. ${p.name} · PID ${p.pid} · ${percent(p.cpuPercent)}`).join('\n') || '暂无可用进程采样') },
    { kind: 'entry', text: '私有内存前5\n' + (s.memoryTop.map((p, i) => `${i + 1}. ${p.name} · PID ${p.pid}\n   私有 ${bytes(p.privateBytes)} · 工作集 ${bytes(p.workingSetBytes)}`).join('\n') || '暂无可用进程采样') },
    ...(s.processError ? [{ kind: 'entry' as const, text: s.processError }] : []),
  ], footer: 'CPU 为短时采样平均值；私有内存含可换出的提交内存，与物理工作集口径不同。仅查询，不调用模型。' };
}
