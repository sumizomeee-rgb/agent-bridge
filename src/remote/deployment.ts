import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, lstatSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { projectRoot } from '../config.js';
import type { ExecutionTargetBinding } from './types.js';
import { deployPresets } from '../presets/deployment.js';

export interface DeploymentResult { state: 'ready' | 'busy' | 'offline' | 'configuration-error'; release?: string; reason?: string; presetCount?: number }
export interface ExecutorRelease { id: string; archive: string; sha256: string; helper: string; installer: string; launcher: string }
const hash = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
export function executorKey(target: ExecutionTargetBinding): string {
  return JSON.stringify([resolve(target.sshConfig!), target.alias, target.expectedHostname?.toLowerCase(), target.remoteRoot?.replaceAll('\\', '/').toLowerCase()]);
}
export function command(executable: string, args: string[], cwd: string, timeout = 90_000): Promise<string> {
  return new Promise((done, fail) => execFile(executable, args, { cwd, windowsHide: true, timeout, maxBuffer: 512 * 1024 }, (error, stdout, stderr) => {
    // Do not expose command arguments, SSH diagnostics or connection credentials in status messages.
    if (error) fail(Object.assign(new Error(`执行器更新命令未完成：${executable} (${error.code ?? 'failed'})`), { detail: stderr.slice(0, 3000) })); else done(stdout.trim());
  }));
}
export function executorRelease(root = projectRoot): Promise<ExecutorRelease> {
  const files = new Map<string, string>();
  const collect = (directory: string): void => {
    for (const name of readdirSync(join(root, directory)).sort()) {
      const path = join(directory, name), info = lstatSync(join(root, path));
      if (info.isSymbolicLink()) throw new Error('执行器发布文件不能包含符号链接。');
      if (info.isDirectory()) collect(path); else if (info.isFile()) files.set(path.replaceAll('\\', '/'), hash(readFileSync(join(root, path))));
    }
  };
  collect('dist/src');
  // Include the dependencies reachable from the executor, not platform credentials or user files.
  const packages = new Set<string>();
  const include = (name: string): void => {
    if (packages.has(name)) return; packages.add(name);
    if (!/^(@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/i.test(name)) throw new Error('执行器依赖名称无效。');
    const directory = 'node_modules/' + name, pkg = JSON.parse(readFileSync(join(root, directory, 'package.json'), 'utf8'));
    collect(directory); for (const child of Object.keys(pkg.dependencies ?? {})) include(child);
  };
  for (const name of ['smol-toml', 'ws', 'https-proxy-agent', 'undici']) include(name);
  for (const path of ['package.json', 'scripts/start-remote-agent.ps1', 'scripts/remote-update-helper.mjs', 'scripts/update-remote-agent.ps1'])
    files.set(path, hash(readFileSync(join(root, path))));
  const entries = Object.fromEntries([...files].sort(([a], [b]) => a.localeCompare(b)));
  const id = hash(JSON.stringify(entries)), directory = join(root, '.local', 'executor-releases', id);
  const archive = join(directory, 'runtime.tgz'); mkdirSync(directory, { recursive: true });
  const helper = join(root, 'scripts/remote-update-helper.mjs'), installer = join(root, 'scripts/update-remote-agent.ps1'), launcher = join(root, 'scripts/start-remote-agent.ps1');
  if (existsSync(archive)) return Promise.resolve({ id, archive, sha256: hash(readFileSync(archive)), helper, installer, launcher });
  const payload = join(directory, 'payload'); mkdirSync(payload, { recursive: true });
  for (const name of files.keys()) { const target = join(payload, name); mkdirSync(dirname(target), { recursive: true }); copyFileSync(join(root, name), target); }
  writeFileSync(join(payload, 'release.json'), JSON.stringify({ version: 1, id, files: entries }));
  const temporary = archive + '.tmp';
  return command('tar', ['-czf', temporary, '-C', payload, '.'], root).then(() => {
    renameSync(temporary, archive); return { id, archive, sha256: hash(readFileSync(archive)), helper, installer, launcher };
  });
}
export function ps(value: string): string { return "'" + value.replaceAll("'", "''") + "'"; }
export function remotePowerShell(target: ExecutionTargetBinding, script: string, cwd: string): Promise<string> {
  return command('ssh', ['-F', target.sshConfig!, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', target.alias!,
    'powershell', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from("$ProgressPreference='SilentlyContinue';$ErrorActionPreference='Stop';" + script, 'utf16le').toString('base64')], cwd);
}
export async function deployExecutor(target: ExecutionTargetBinding, release: ExecutorRelease, cwd: string): Promise<DeploymentResult> {
  if (!/^[A-Za-z]:[\\/]/.test(target.remoteRoot!)) throw new Error('自动执行器更新目前支持已登记的 Windows 目标。');
  const stage = target.remoteRoot!.replaceAll('\\', '/') + '/.local/remote/updates/' + release.id;
  // An inexpensive remote probe avoids re-uploading an already running release on every bridge restart.
  const probe = await remotePowerShell(target, `$p=Join-Path ${ps(target.remoteRoot!)} '.local/remote/active-release.json';if(Test-Path -LiteralPath $p){$r=Get-Content -LiteralPath $p -Raw -Encoding UTF8|ConvertFrom-Json;if($r.id -eq ${ps(release.id)}){& ${ps(target.nodePath!)} (Join-Path $r.path 'scripts/remote-update-helper.mjs') hello ${ps(target.remoteRoot!)} ${ps(target.expectedHostname!)};exit $LASTEXITCODE}};Write-Output 'NEEDS_UPDATE'`, cwd);
  if (probe !== 'NEEDS_UPDATE') {
    const result = JSON.parse(probe); if (result.release === release.id) return { state: 'ready', release: release.id };
  }
  await remotePowerShell(target, `if([Environment]::MachineName -ine ${ps(target.expectedHostname!)}){throw 'Wrong target'};New-Item -ItemType Directory -Force -Path ${ps(stage)}|Out-Null`, cwd);
  await command('scp', ['-q', '-F', target.sshConfig!, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8',
    release.archive, release.installer, release.helper, `${target.alias}:${stage}/`], cwd);
  const output = await remotePowerShell(target, `& ${ps(stage + '/update-remote-agent.ps1')} -Root ${ps(target.remoteRoot!)} -NodePath ${ps(target.nodePath!)} -ExpectedHostname ${ps(target.expectedHostname!)} -Release ${ps(release.id)} -ArchiveHash ${ps(release.sha256)}`, cwd);
  const result = JSON.parse(output) as DeploymentResult;
  if (!['ready', 'busy'].includes(result.state)) throw new Error('执行器更新没有返回可核对结果。');
  return result;
}

/** One flight per execution root across every Bot and all dispatch/probe paths. */
export class RemoteDeploymentService {
  private readonly flights = new Map<string, Promise<DeploymentResult>>();
  private readonly recent = new Map<string, { at: number; result: DeploymentResult }>();
  private readonly states = new Map<string, string>();
  private release?: Promise<ExecutorRelease>;
  private closed = false;
  constructor(private readonly list: () => Promise<Array<{ target: ExecutionTargetBinding; cwd: string }>>,
    private readonly log: (text: string) => void, private readonly deploy = deployExecutor, private readonly build = executorRelease,
    private readonly now = Date.now, private readonly configure = deployPresets) {}
  ensure(target: ExecutionTargetBinding, cwd: string): Promise<DeploymentResult> {
    if (this.closed) return Promise.resolve({ state: 'offline', reason: '宿主正在关闭' });
    const key = executorKey(target) + ':' + resolve(cwd), running = this.flights.get(key); if (running) return running;
    const cached = this.recent.get(key);
    if (cached && this.now() - cached.at < (cached.result.state === 'ready' ? 30_000 : 10_000)) return Promise.resolve(cached.result);
    const flight = Promise.resolve().then(async () => {
      this.release ??= this.build();
      let result: DeploymentResult;
      try { result = await this.deploy(target, await this.release, cwd); }
      catch (error) { this.release = undefined; result = { state: 'offline', reason: error instanceof Error ? error.message : '更新未完成' }; }
      if (result.state === 'ready') {
        try { result = { ...result, presetCount: await this.configure(target, cwd) }; }
        catch { result = { state: 'configuration-error', release: result.release, reason: '工作区预设自动准备未完成，未报告预设就绪' }; }
      }
      this.recent.set(key, { at: this.now(), result });
      const state = JSON.stringify(result);
      if (this.states.get(key) !== state) { this.states.set(key, state); this.log(`EXECUTOR_UPDATE target=${target.id} state=${result.state} release=${result.release ?? '-'}${result.presetCount !== undefined ? ' presets=' + result.presetCount : ''}${result.reason ? ' reason=' + result.reason : ''}`); }
      return result;
    }).finally(() => this.flights.delete(key));
    this.flights.set(key, flight); return flight;
  }
  async check(): Promise<void> {
    if (this.closed) return;
    try { await Promise.all((await this.list()).map(({ target, cwd }) => this.ensure(target, cwd))); }
    catch { this.log('EXECUTOR_UPDATE registry-unavailable'); }
  }
  start(): void { void this.check(); }
  async close(): Promise<void> { this.closed = true; await Promise.allSettled([...this.flights.values()]); }
}
