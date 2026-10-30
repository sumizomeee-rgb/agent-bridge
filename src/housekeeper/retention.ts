import { spawn } from 'node:child_process';
import { constants, type BigIntStats } from 'node:fs';
import { lstat, open, opendir, realpath } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';

export const retentionDays = 10;
export const retentionIntervalMs = 24 * 60 * 60 * 1000;
export interface RetentionVersion { dev: string; ino: string; size: string; mtimeNs: string; ctimeNs: string }
export interface RetentionCandidate { root: string; path: string; version: RetentionVersion }
export interface RetentionOptions { now?: () => number; recycle?: (candidate: RetentionCandidate) => Promise<void> }
export interface RetentionSweep {
  root: string; scanned: number; eligible: number; recycled: number; skipped: number; failed: number;
  unsupported: boolean; truncated: boolean; errors: Array<{ path: string; reason: string }>;
}
const bounds = { entries: 4096, directories: 128, depth: 12, files: 64, fileBytes: 64 * 1024 * 1024, totalBytes: 64 * 1024 * 1024,
  scanMs: 15000, processMs: 30000, outputBytes: 512 * 1024 };
const comparable = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value;
const same = (left: string, right: string) => comparable(left) === comparable(right);
const textExtension = (path: string) => ['.md', '.txt', '.log'].includes(extname(path).toLowerCase());
const version = (info: BigIntStats): RetentionVersion => ({ dev: String(info.dev), ino: String(info.ino), size: String(info.size), mtimeNs: String(info.mtimeNs), ctimeNs: String(info.ctimeNs) });
const unchanged = (left: RetentionVersion, right: RetentionVersion) => (Object.keys(left) as Array<keyof RetentionVersion>).every(key => left[key] === right[key]);

/** Validate ancestors before following any name; an explicit root never grants permission through a junction. */
async function ordinaryPath(root: string, path: string, file = false): Promise<BigIntStats> {
  const inside = relative(root, path);
  if (inside === '..' || inside.startsWith('..' + sep) || isAbsolute(inside)) throw new Error('路径越过公开同步根目录。');
  let current = parse(path).root;
  const segments = path.slice(current.length).split(sep).filter(Boolean);
  let info = await lstat(current, { bigint: true });
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('根路径经过链接或非目录。');
  for (let index = 0; index < segments.length; index++) {
    current = join(current, segments[index]!); info = await lstat(current, { bigint: true });
    if (info.isSymbolicLink()) throw new Error('公开同步路径经过链接，已跳过。');
    if (index < segments.length - 1 || !file) {
      if (!info.isDirectory()) throw new Error('公开同步路径不是普通目录。');
      if ((same(current, root) || comparable(current).startsWith(comparable(root + sep))) && basename(current).startsWith('.')) throw new Error('隐藏目录不参与保留期清理。');
    } else if (!info.isFile()) throw new Error('待清理对象不是普通文件。');
  }
  if (!same(await realpath(path), path)) throw new Error('公开同步路径发生重定向。');
  return info;
}

// Only constant script text is passed as a command. Every path and expected version arrives via UTF-8 stdin JSON.
const windowsScript = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
$root = [IO.Path]::GetFullPath([string]$request.root).TrimEnd([IO.Path]::DirectorySeparatorChar)
function Check-Path([string]$path) {
  $full = [IO.Path]::GetFullPath($path)
  if (-not ($full.Equals($root, [StringComparison]::OrdinalIgnoreCase) -or $full.StartsWith($root + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase))) { throw 'Path outside public root' }
  $current = $full
  while ($current) {
    $item = Get-Item -LiteralPath $current -Force -ErrorAction Stop
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Reparse point is excluded' }
    $inRoot = $current.Equals($root, [StringComparison]::OrdinalIgnoreCase) -or $current.StartsWith($root + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)
    if ($inRoot -and ((($item.Attributes -band [IO.FileAttributes]::Hidden) -ne 0) -or $item.Name.StartsWith('.'))) { throw 'Hidden path is excluded' }
    $parent = [IO.Directory]::GetParent($current)
    if ($null -eq $parent) { break }
    $current = $parent.FullName
  }
}
Check-Path $root
if ($request.operation -eq 'scan') {
  $files = New-Object 'System.Collections.Generic.List[string]'
  $queue = New-Object 'System.Collections.Generic.Queue[object]'
  $queue.Enqueue(@{ path = $root; depth = 0 })
  $watch = [Diagnostics.Stopwatch]::StartNew(); $scanned = 0; $directories = 0; $skipped = 0; $truncated = $false
  while ($queue.Count -gt 0) {
    if ($directories -ge $request.limits.directories -or $watch.ElapsedMilliseconds -ge $request.limits.scanMs) { $truncated = $true; break }
    $entry = $queue.Dequeue(); $directories++
    try {
      Check-Path $entry.path
      foreach ($item in (New-Object IO.DirectoryInfo($entry.path)).EnumerateFileSystemInfos()) {
        $scanned++
        if ($scanned -gt $request.limits.entries -or $files.Count -ge $request.limits.files -or $watch.ElapsedMilliseconds -ge $request.limits.scanMs) { $truncated = $true; break }
        if ($item.Name.StartsWith('.') -or (($item.Attributes -band ([IO.FileAttributes]::Hidden -bor [IO.FileAttributes]::ReparsePoint -bor [IO.FileAttributes]::System)) -ne 0)) { $skipped++; continue }
        if (($item.Attributes -band [IO.FileAttributes]::Directory) -ne 0) {
          if ($entry.depth -lt $request.limits.depth) { $queue.Enqueue(@{ path = $item.FullName; depth = $entry.depth + 1 }) } else { $skipped++ }
        } elseif (@('.md', '.txt', '.log') -contains $item.Extension.ToLowerInvariant()) {
          if ($item.LastWriteTimeUtc -lt [DateTimeOffset]::FromUnixTimeMilliseconds([long]$request.cutoff).UtcDateTime) { $files.Add($item.FullName) }
        }
      }
    } catch { $skipped++ }
    if ($truncated) { break }
  }
  @{ files = @($files.ToArray()); scanned = $scanned; skipped = $skipped; truncated = $truncated } | ConvertTo-Json -Depth 5 -Compress
  exit
}
if ($request.operation -ne 'recycle') { throw 'Unknown retention operation' }
Add-Type -AssemblyName Microsoft.VisualBasic
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Text;
using System.Globalization;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class BridgeRetentionFileVersion {
  [StructLayout(LayoutKind.Sequential)] struct Info { public uint Attributes; public System.Runtime.InteropServices.ComTypes.FILETIME Created, Accessed, Written; public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow; }
  [StructLayout(LayoutKind.Sequential)] struct Basic { public long Created, Accessed, Written, Changed; public uint Attributes; }
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle handle, out Info info);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetFileInformationByHandleEx(SafeFileHandle handle, int kind, out Basic info, uint size);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern uint GetFinalPathNameByHandle(SafeFileHandle handle, StringBuilder path, uint length, uint flags);
  public static string[] Read(string path) {
    using (var file = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete)) {
      Info info; Basic basic; var final = new StringBuilder(32768);
      if (!GetFileInformationByHandle(file.SafeFileHandle, out info) || !GetFileInformationByHandleEx(file.SafeFileHandle, 0, out basic, (uint)Marshal.SizeOf(typeof(Basic))) || GetFinalPathNameByHandle(file.SafeFileHandle, final, (uint)final.Capacity, 0) == 0) throw new IOException("Cannot verify file version");
      if ((info.Attributes & (2u | 4u | 16u | 1024u)) != 0) throw new IOException("File type or attributes changed");
      string actual = final.ToString();
      if (actual.StartsWith(@"\\?\UNC\")) actual = @"\\" + actual.Substring(8); else if (actual.StartsWith(@"\\?\")) actual = actual.Substring(4);
      if (!String.Equals(Path.GetFullPath(path), actual, StringComparison.OrdinalIgnoreCase)) throw new IOException("File path redirected");
      return new [] { info.Volume.ToString(CultureInfo.InvariantCulture), (((ulong)info.IndexHigh << 32) | info.IndexLow).ToString(CultureInfo.InvariantCulture), file.Length.ToString(CultureInfo.InvariantCulture), checked((basic.Written - 116444736000000000L) * 100).ToString(CultureInfo.InvariantCulture), checked((basic.Changed - 116444736000000000L) * 100).ToString(CultureInfo.InvariantCulture) };
    }
  }
}
'@ | Out-Null
$results = @()
foreach ($candidate in $request.files) {
  $path = [string]$candidate.path
  try {
    Check-Path $path
    $actual = [BridgeRetentionFileVersion]::Read($path)
    $expected = @([string]$candidate.version.dev, [string]$candidate.version.ino, [string]$candidate.version.size, [string]$candidate.version.mtimeNs, [string]$candidate.version.ctimeNs)
    $equal = $true
    for ($index = 0; $index -lt 5; $index++) { if ($actual[$index] -ne $expected[$index]) { $equal = $false; break } }
    if (-not $equal) { $results += @{ path = $path; status = 'skipped' }; continue }
    [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($path, [Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs, [Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin, [Microsoft.VisualBasic.FileIO.UICancelOption]::ThrowException)
    $results += @{ path = $path; status = 'recycled' }
  } catch { $results += @{ path = $path; status = 'failed'; reason = $_.Exception.Message } }
}
@{ results = @($results) } | ConvertTo-Json -Depth 6 -Compress
`;

async function windowsRequest(input: unknown, signal?: AbortSignal): Promise<unknown> {
  const executable = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return new Promise((accept, reject) => {
    if (signal?.aborted) { reject(new Error('保留期清理已停止。')); return; }
    const child = spawn(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', windowsScript],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const output: Buffer[] = []; let length = 0, failed = '', settled = false, stopTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: Error, value?: unknown) => {
      if (settled) return; settled = true; clearTimeout(timer); clearTimeout(stopTimer); signal?.removeEventListener('abort', abort);
      if (error) reject(error); else accept(value);
    };
    const stop = (reason: string) => {
      failed = reason; child.kill();
      stopTimer ??= setTimeout(() => finish(new Error(reason)), 3000); stopTimer.unref();
    };
    const abort = () => stop('保留期清理已停止；未降级删除，正在移动的文件结果可能需核对。');
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => stop('原生回收站操作超时，未降级删除；部分结果可能需核对。'), bounds.processMs);
    timer.unref();
    child.on('error', error => finish(error));
    child.stdout.on('data', (bytes: Buffer) => { length += bytes.length; if (length > bounds.outputBytes) stop('原生回收站回执超过上限。'); else output.push(bytes); });
    child.stderr.on('data', (bytes: Buffer) => { if (!failed) failed = bytes.toString('utf8').slice(0, 600); });
    child.on('close', code => {
      if (failed || code !== 0) { finish(new Error(failed || '原生回收站检查失败。')); return; }
      try { finish(undefined, JSON.parse(Buffer.concat(output).toString('utf8').replace(/^\uFEFF/, ''))); }
      catch { finish(new Error('原生回收站未返回有效结构化回执。')); }
    });
    child.stdin.on('error', () => {}); child.stdin.end(JSON.stringify(input));
  });
}

async function collect(root: string, cutoff: number, result: RetentionSweep, signal?: AbortSignal): Promise<string[]> {
  if (process.platform === 'win32') {
    const value = await windowsRequest({ operation: 'scan', root, cutoff, limits: bounds }, signal) as { files: string[]; scanned: number; skipped: number; truncated: boolean };
    if (!Array.isArray(value.files) || value.files.length > bounds.files || value.files.some(path => typeof path !== 'string' || !isAbsolute(path))) throw new Error('原生目录扫描回执无效。');
    result.scanned = value.scanned; result.skipped += value.skipped; result.truncated = value.truncated;
    return value.files.sort();
  }
  const queue = [{ path: root, depth: 0 }], paths: string[] = [], began = performance.now(); let directories = 0;
  while (queue.length) {
    signal?.throwIfAborted();
    if (++directories > bounds.directories || performance.now() - began > bounds.scanMs) { result.truncated = true; break; }
    const directory = queue.shift()!;
    await ordinaryPath(root, directory.path);
    const entries = await opendir(directory.path);
    for await (const entry of entries) {
      signal?.throwIfAborted();
      if (++result.scanned > bounds.entries || paths.length >= bounds.files || performance.now() - began > bounds.scanMs) { result.truncated = true; break; }
      if (entry.name.startsWith('.') || entry.isSymbolicLink()) { result.skipped++; continue; }
      const path = join(directory.path, entry.name);
      if (entry.isDirectory()) { if (directory.depth < bounds.depth) queue.push({ path, depth: directory.depth + 1 }); else result.skipped++; }
      else if (entry.isFile() && textExtension(path) && (await lstat(path)).mtimeMs < cutoff) paths.push(path);
    }
    if (result.truncated) break;
  }
  return paths.sort();
}

async function utf8File(candidate: RetentionCandidate, signal?: AbortSignal): Promise<boolean> {
  signal?.throwIfAborted();
  const handle = await open(candidate.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat({ bigint: true }); if (!before.isFile() || !unchanged(version(before), candidate.version)) return false;
    const decoder = new TextDecoder('utf-8', { fatal: true }), bytes = Buffer.alloc(65536); let read = 0;
    for (;;) {
      signal?.throwIfAborted();
      const chunk = await handle.read(bytes, 0, bytes.length, null); if (!chunk.bytesRead) break;
      read += chunk.bytesRead; if (read > bounds.fileBytes || bytes.subarray(0, chunk.bytesRead).includes(0)) return false;
      decoder.decode(bytes.subarray(0, chunk.bytesRead), { stream: true });
    }
    decoder.decode(); return unchanged(version(await handle.stat({ bigint: true })), candidate.version);
  } catch (error) { if (error instanceof TypeError) return false; throw error; }
  finally { await handle.close(); }
}

/** Public copied text only. Producer databases, JSON manifests, credentials and binary files are never candidates. */
export function sweepTransactionFiles(inputRoot: string, options: RetentionOptions = {}): Promise<RetentionSweep> {
  return sweep(inputRoot, options);
}

async function sweep(inputRoot: string, options: RetentionOptions, signal?: AbortSignal): Promise<RetentionSweep> {
  const root = resolve(inputRoot), result: RetentionSweep = { root, scanned: 0, eligible: 0, recycled: 0, skipped: 0, failed: 0, unsupported: false, truncated: false, errors: [] };
  const failure = (path: string, error: unknown) => { result.failed++; if (result.errors.length < 16) result.errors.push({ path, reason: String(error instanceof Error ? error.message : error).slice(0, 300) }); };
  if (!options.recycle && process.platform !== 'win32') { result.unsupported = true; result.skipped++; return result; }
  try {
    signal?.throwIfAborted();
    const now = options.now?.() ?? Date.now(), cutoff = now - retentionDays * retentionIntervalMs;
    if (!Number.isFinite(now)) throw new Error('清理时间无效。');
    const cutoffNs = BigInt(Math.trunc(cutoff)) * 1000000n;
    if (same(root, parse(root).root)) throw new Error('卷根目录不能作为公开同步正文目录。');
    await ordinaryPath(root, root);
    const paths = await collect(root, cutoff, result, signal), batch: RetentionCandidate[] = [], candidates: RetentionCandidate[] = [];
    let bytes = 0; const began = performance.now();
    for (const path of paths) {
      signal?.throwIfAborted();
      try {
        const info = await ordinaryPath(root, path, true);
        if (!textExtension(path) || basename(path).startsWith('.') || info.mtimeNs >= cutoffNs) { result.skipped++; continue; }
        if (info.size > BigInt(bounds.fileBytes)) {
          result.skipped++; result.truncated = true;
          if (result.errors.length < 16) result.errors.push({ path, reason: '正文超过单文件 64MiB 上限，保留待处理。' });
          continue;
        }
        candidates.push({ root, path, version: version(info) });
      } catch (error) { failure(path, error); }
    }
    for (const candidate of candidates) {
      signal?.throwIfAborted();
      const path = candidate.path;
      if (performance.now() - began > bounds.scanMs) { result.truncated = true; break; }
      try {
        const info = await ordinaryPath(root, path, true);
        if (!unchanged(version(info), candidate.version) || info.mtimeNs >= cutoffNs) { result.skipped++; continue; }
        bytes += Number(info.size); if (bytes > bounds.totalBytes) { result.truncated = true; break; }
        result.eligible++;
        if (!await utf8File(candidate, signal)) { result.skipped++; continue; }
        if (!unchanged(version(await ordinaryPath(root, path, true)), candidate.version)) { result.skipped++; continue; }
        if (options.recycle) { await injectedRecycle(options.recycle, candidate, signal); result.recycled++; }
        else batch.push(candidate);
      } catch (error) { failure(path, error); }
    }
    if (batch.length) {
      const response = await windowsRequest({ operation: 'recycle', root, files: batch }, signal) as { results: Array<{ path: string; status: string; reason?: string }> };
      if (!Array.isArray(response.results) || response.results.length !== batch.length || response.results.some((item, index) => item.path !== batch[index]?.path)) throw new Error('原生回收站文件回执不完整。');
      for (const item of response.results) {
        if (item.status === 'recycled') result.recycled++;
        else if (item.status === 'skipped') result.skipped++;
        else failure(item.path, new Error(item.reason ?? '回收失败，未降级删除。'));
      }
    }
  } catch (error) {
    if (signal?.aborted || (error as NodeJS.ErrnoException).code === 'ENOENT') result.skipped++;
    else failure(root, error);
  }
  return result;
}

function injectedRecycle(recycle: NonNullable<RetentionOptions['recycle']>, candidate: RetentionCandidate, signal?: AbortSignal): Promise<void> {
  return new Promise((accept, reject) => {
    let settled = false;
    const finish = (error?: unknown) => {
      if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', stop);
      if (error) reject(error); else accept();
    };
    const stop = () => finish(new Error('保留期清理已停止。'));
    const timer = setTimeout(() => finish(new Error('回收接口超时，未降级删除。')), bounds.processMs); timer.unref();
    signal?.addEventListener('abort', stop, { once: true });
    Promise.resolve().then(() => { signal?.throwIfAborted(); return recycle(candidate); }).then(() => finish(), finish);
  });
}

/** Independent of the housekeeper switch and LLM: one bounded startup check, then one per day. */
export class TransactionRetentionService {
  private readonly roots: string[];
  private timer?: ReturnType<typeof setTimeout>;
  private pending?: Promise<void>;
  private started = false;
  private closed = false;
  private readonly abort = new AbortController();
  constructor(roots: string[], private readonly onLog: (message: string) => void, private readonly options: RetentionOptions = {}) {
    this.roots = [...new Map(roots.map(path => { const absolute = resolve(path); return [comparable(absolute), absolute]; })).values()];
  }
  start(): void {
    if (this.started || this.closed) return; this.started = true;
    void this.run();
  }
  private run(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.pending) return this.pending;
    let continueBatch = false;
    const work = (async () => {
      for (const root of this.roots) {
        if (this.closed) break;
        const result = await sweep(root, this.options, this.abort.signal);
        continueBatch ||= result.truncated && result.recycled > 0;
        try { this.onLog('TRANSACTION_RETENTION ' + JSON.stringify(result)); } catch { /* A logger cannot change cleanup results. */ }
      }
    })();
    this.pending = work; void work.finally(() => {
      if (this.pending === work) this.pending = undefined;
      if (!this.closed) { this.timer = setTimeout(() => { void this.run(); }, continueBatch ? 1000 : retentionIntervalMs); this.timer.unref(); }
    }).catch(() => undefined);
    return work;
  }
  async close(): Promise<void> { this.closed = true; clearTimeout(this.timer); this.abort.abort(); await this.pending; }
}
