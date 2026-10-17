import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

type Row = Record<string, string | number | bigint | Uint8Array | null>;
export interface MigrationMachineObservation {
  machineIdSha256: string; lastBootAt: string; observedAt: string;
  matchingPids: number[]; unreadableAgentPids: number[];
}
/** 仅测试注入；CLI 始终查询真实本机系统，证明 JSON 不能提供探针。 */
export interface HostMigrationProofTestHooks { machineProbe?: (identifiers: string[]) => MigrationMachineObservation }
export interface StoppedExecutionProof {
  version: 1; kind: 'windows-local-codex-reboot'; observedAt: string;
  sourceDataDir: string; botId: string; jobId: string; workerId: string; taskId: string; nativeId: string;
  sourceRowsSha256: string;
  host: { machineIdSha256: string; lastBootAt: string };
  native: { path: string; sha256: string; turnId: string; startedAt: string; completedAt: string };
}
export interface VerifiedStoppedExecution {
  proof: StoppedExecutionProof; bytes: Buffer; proofSha256: string;
  verification: MigrationMachineObservation;
}
export interface MigrationProofSource { dataDir: string; botIds: string[] }
function fail(message: string): never { throw new Error('停止证明拒绝：' + message); }
function hash(value: Buffer | string): string { return createHash('sha256').update(value).digest('hex'); }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => JSON.stringify(key) + ':' + canonical(item)).join(',') + '}';
  return typeof value === 'bigint' ? JSON.stringify(String(value)) : JSON.stringify(value) ?? 'null';
}
function pathKey(path: string): string { const value = resolve(path); return process.platform === 'win32' ? value.toLowerCase() : value; }
function time(value: unknown): number { const result = typeof value === 'string' ? Date.parse(value) : NaN; if (!Number.isFinite(result)) fail('时间字段无效。'); return result; }
function json(value: unknown): any {
  try { return JSON.parse(String(value)); } catch { return fail('登记或证明 JSON 无效。'); }
}
function file(path: string, limit: number): Buffer {
  if (!isAbsolute(path) || pathKey(realpathSync(path)) !== pathKey(path)) fail('证据路径必须是无链接的本机绝对路径。');
  const stat = lstatSync(path); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit) fail('证据文件类型或大小无效。');
  const bytes = readFileSync(path); if (bytes.length > limit) fail('证据文件读取期间超过大小限制。'); return bytes;
}
function rows(source: MigrationProofSource, database: string, table: string): Row[] {
  const path = join(source.dataDir, database); if (!existsSync(path)) return [];
  const db = new DatabaseSync(path, { readOnly: true });
  try { return db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table) ? db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all() : []; }
  finally { db.close(); }
}
function includes(value: unknown, identifiers: string[]): boolean {
  if (typeof value === 'string') return identifiers.includes(value);
  if (Array.isArray(value)) return value.some(item => includes(item, identifiers));
  return !!value && typeof value === 'object' && Object.values(value).some(item => includes(item, identifiers));
}

/** 不向命令行传入凭据或聊天正文；系统可见性不足时拒绝证明。 */
function observeWindowsMachine(identifiers: string[]): MigrationMachineObservation {
  if (process.platform !== 'win32') fail('这类旧执行证明只支持原 Windows 本机核验。');
  const encodedIds = Buffer.from(JSON.stringify(identifiers)).toString('base64');
  const script = `$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$ids=ConvertFrom-Json ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedIds}')))
$os=Get-CimInstance Win32_OperatingSystem
$machine=(Get-ItemProperty -LiteralPath 'HKLM:\\SOFTWARE\\Microsoft\\Cryptography' -Name MachineGuid).MachineGuid
$proofMatchingPids=@(); $proofUnreadablePids=@()
foreach($p in Get-CimInstance Win32_Process) {
  if($p.ProcessId -eq $PID -or $p.ProcessId -eq ${process.pid}) { continue }
  if($p.Name -notmatch '^(node|codex|claude)(\\.exe)?$') { continue }
  if(!$p.CommandLine) { $proofUnreadablePids+= [int]$p.ProcessId }
  foreach($id in $ids) { if($p.CommandLine -and $p.CommandLine.IndexOf($id,[StringComparison]::OrdinalIgnoreCase) -ge 0) { $proofMatchingPids+=[int]$p.ProcessId; break } }
}
@{machine=$machine;lastBootAt=$os.LastBootUpTime.ToUniversalTime().ToString('o');observedAt=[DateTime]::UtcNow.ToString('o');matchingPids=@($proofMatchingPids);unreadableAgentPids=@($proofUnreadablePids)} | ConvertTo-Json -Compress`;
  const command = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  let observed: any;
  try { observed = json(execFileSync(command, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8', timeout: 30_000, maxBuffer: 256 * 1024, windowsHide: true })); }
  catch { return fail('无法现场取得 Windows 身份、重启时间与进程清单。'); }
  if (typeof observed.machine !== 'string' || !/^[a-f0-9-]{32,36}$/i.test(observed.machine)) fail('本机身份无效。');
  return { machineIdSha256: hash(observed.machine.toLowerCase()), lastBootAt: new Date(time(observed.lastBootAt)).toISOString(), observedAt: new Date(time(observed.observedAt)).toISOString(),
    matchingPids: observed.matchingPids, unreadableAgentPids: observed.unreadableAgentPids };
}
function sourceEvidence(source: MigrationProofSource, jobId: string) {
  const jobs = rows(source, 'controller.sqlite', 'controller_jobs'), row = jobs.find(row => row.id === jobId);
  if (!row || row.status !== 'uncertain') fail('只接受精确登记的 uncertain controller job，不能豁免 running 或不存在的记录。');
  const job = json(row.value_json), workerRow = rows(source, 'controller.sqlite', 'controller_workers').find(item => item.id === row.worker_id);
  if (!workerRow) fail('worker 登记缺失。'); const worker = json(workerRow.value_json);
  if (job.id !== row.id || job.workerId !== workerRow.id || job.status !== 'uncertain' || job.taskId !== row.task_id || job.result !== row.result
    || worker.id !== workerRow.id || worker.agent !== 'codex' || worker.blocked !== true || worker.ownership === 'user' || worker.handoffPending || worker.adoption?.status === 'pending'
    || worker.target && worker.target.transport !== 'local' || typeof worker.nativeId !== 'string' || !/^[a-zA-Z0-9-]{1,200}$/.test(worker.nativeId)) fail('不是已冻结的本机 Codex 执行，或登记字段不一致。');
  if (worker.target?.expectedHostname) fail('带远端主机预期的 target 不适用本机重启证明。');
  const botId = source.botIds.find(id => typeof job.origin?.userId === 'string' && job.origin.userId.startsWith(id + '|'));
  if (!botId || worker.origin?.userId !== job.origin.userId || worker.origin?.conversationId !== job.origin.conversationId || workerRow.parent_id !== job.origin.conversationId) fail('Bot、worker 或父会话归属不匹配。');
  const conversation = rows(source, 'bridge.sqlite', 'conversations').find(item => item.id === job.origin.conversationId);
  if (!conversation || conversation.user_id !== job.origin.userId) fail('原会话归属缺失。');
  const linkedJobs = jobs.filter(item => item.worker_id === workerRow.id);
  if (linkedJobs.some(item => item.id !== row.id && !['completed', 'failed', 'cancelled'].includes(String(item.status)))) fail('worker 仍有排队、执行或其他未知工作。');
  const linkedSchedules = rows(source, 'controller.sqlite', 'controller_schedules').filter(item => item.id === job.scheduleId || item.task_id === row.task_id || includes(json(item.value_json), [jobId, String(workerRow.id)]));
  if (linkedSchedules.some(item => ['pending', 'dispatching', 'running', 'uncertain'].includes(String(item.status)))) fail('关联计划仍可执行或停止未知。');
  const supplements = rows(source, 'controller.sqlite', 'controller_supplements').filter(item => item.worker_id === workerRow.id);
  if (supplements.some(item => ['pending', 'steering', 'uncertain'].includes(json(item.value_json).status))) fail('仍有未结束或未知补充。');
  const leases = rows(source, 'native-session-leases.sqlite', 'native_session_leases').filter(item => item.worker_id === workerRow.id || item.ref === 'codex:default:' + worker.nativeId);
  if (leases.length) fail('存在原生会话租约，本类旧执行证明不覆盖租约。');
  const task = rows(source, 'tasks.sqlite', 'tasks').find(item => item.id === row.task_id);
  if (!task || !['failed', 'cancelled'].includes(String(task.status)) || Number(task.wake_allowed) !== 0 || task.watch_json && task.watch_json !== 'null') fail('TaskRegistry 尚未失败/取消、仍可唤醒或存在回执监视器。');
  const context = rows(source, 'tasks.sqlite', 'task_contexts').find(item => item.id === task.context_id);
  if (!context || Number(context.open) !== 0 || Number(context.wake_allowed) !== 0) fail('原任务上下文仍开放或可唤醒。');
  for (const origin of [json(task.origin_json), json(context.origin_json)]) if (origin.userId !== job.origin.userId || origin.conversationId !== job.origin.conversationId) fail('TaskRegistry 来源与 job 不一致。');
  const events = rows(source, 'tasks.sqlite', 'task_events').filter(item => item.task_id === task.id), observations = rows(source, 'tasks.sqlite', 'task_observations').filter(item => item.task_id === task.id);
  if (!events.length || events.some(item => item.status !== task.status) || [...events, ...observations].some(item => !['delivered', 'cancelled'].includes(String(item.state)))) fail('完成或进展事件仍未封存，可能重新唤醒。');
  const ticketBytes = file(String(task.ticket_path), 64 * 1024), ticket = json(ticketBytes.toString('utf8'));
  const contextBytes = file(join(source.dataDir, 'contexts', String(context.id) + '.json'), 64 * 1024), contextFile = json(contextBytes.toString('utf8'));
  if (ticket.version !== 1 || ticket.taskId !== task.id || ticket.token !== task.token || contextFile.version !== 1 || contextFile.contextId !== context.id || contextFile.token !== context.token || pathKey(contextFile.registryDir) !== pathKey(source.dataDir)) fail('原凭据文件和登记不一致。');
  const created = time(job.startedAt ?? job.createdAt), ended = time(job.updatedAt);
  if (created > ended) fail('job 时间顺序无效。');
  return { job, worker, botId, taskId: String(task.id), created, ended,
    sourceRowsSha256: hash(canonical({ row, workerRow, conversation, linkedJobs, linkedSchedules, supplements, leases, task, context, events, observations, ticketSha256: hash(ticketBytes), contextSha256: hash(contextBytes) })) };
}
function nativeEvidence(path: string, expectedId: string, cwd: string, created: number, ended: number): StoppedExecutionProof['native'] {
  if (!basename(path).startsWith('rollout-') || !basename(path).endsWith('-' + expectedId + '.jsonl')) fail('原生记录文件名与 nativeId 不匹配。');
  const bytes = file(path, 64 * 1024 * 1024); let session = false, active: { turnId: string; startedAt: string } | undefined, last: StoppedExecutionProof['native'] | undefined;
  for (const line of bytes.toString('utf8').split(/\r?\n/).filter(Boolean)) {
    const entry = json(line), payload = entry.payload;
    if (entry.type === 'session_meta') {
      if (session || payload?.id !== expectedId || typeof payload.cwd !== 'string' || pathKey(payload.cwd) !== pathKey(cwd)) fail('原生会话身份或目录不匹配。'); session = true;
    }
    if (entry.type !== 'event_msg') continue;
    if (payload?.type === 'task_started') {
      if (!session || active || typeof payload.turn_id !== 'string' || !payload.turn_id) fail('原生开始事件不完整。');
      time(entry.timestamp); active = { turnId: payload.turn_id, startedAt: entry.timestamp };
    } else if (payload?.type === 'task_complete') {
      if (!active || active.turnId !== payload.turn_id || time(entry.timestamp) < time(active.startedAt)) fail('原生完成事件无法配对。');
      last = { path, sha256: hash(bytes), ...active, completedAt: entry.timestamp }; active = undefined;
    }
  }
  if (!session || active || !last || time(last.startedAt) < created || time(last.completedAt) > ended) fail('最后原生轮未完成或不属于此 job 时间范围。');
  return last;
}
function live(source: ReturnType<typeof sourceEvidence>, hooks: HostMigrationProofTestHooks): MigrationMachineObservation {
  const observation = (hooks.machineProbe ?? observeWindowsMachine)([source.job.id, source.worker.id, source.worker.nativeId]);
  if (!/^[a-f0-9]{64}$/.test(observation.machineIdSha256) || time(observation.lastBootAt) <= source.ended || time(observation.observedAt) < time(observation.lastBootAt)
    || Math.abs(Date.now() - time(observation.observedAt)) > 60_000 || !Array.isArray(observation.matchingPids) || !Array.isArray(observation.unreadableAgentPids)) fail('本机重启未晚于原执行，或现场时间/身份无效。');
  if (observation.matchingPids.length) fail(`仍有匹配原执行标识的 Agent 进程，PID: ${observation.matchingPids.join(',')}。`);
  if (observation.unreadableAgentPids.length) fail(`Agent 进程命令行不可读，需具备只读核验权限，PID: ${observation.unreadableAgentPids.join(',')}。`);
  return observation;
}
/** 只读生成器仅返回元信息和哈希，不返回凭据或原生消息正文。 */
export function inspectStoppedExecution(source: MigrationProofSource, jobId: string, nativePath: string, hooks: HostMigrationProofTestHooks = {}): StoppedExecutionProof {
  const evidence = sourceEvidence(source, jobId), verification = live(evidence, hooks);
  const native = nativeEvidence(nativePath, evidence.worker.nativeId, evidence.worker.cwd, evidence.created, evidence.ended);
  if (sourceEvidence(source, jobId).sourceRowsSha256 !== evidence.sourceRowsSha256) fail('现场核验期间源登记变化。');
  return { version: 1, kind: 'windows-local-codex-reboot', observedAt: verification.observedAt, sourceDataDir: resolve(source.dataDir), botId: evidence.botId, jobId,
    workerId: evidence.worker.id, taskId: evidence.taskId, nativeId: evidence.worker.nativeId, sourceRowsSha256: evidence.sourceRowsSha256,
    host: { machineIdSha256: verification.machineIdSha256, lastBootAt: verification.lastBootAt }, native };
}
function shape(value: any, keys: string[]): void {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length || keys.some(key => !(key in value))) fail('证明字段不完整或包含未知字段。');
}
/** 只接受精确证据；没有强制跳过开关，也不修写 uncertain 状态。 */
export function verifyStoppedExecutions(source: MigrationProofSource, paths: string[], hooks: HostMigrationProofTestHooks = {}): VerifiedStoppedExecution[] {
  const used = new Set<string>();
  return paths.map(path => {
    const bytes = file(resolve(path), 64 * 1024), proof = json(bytes.toString('utf8').replace(/^\uFEFF/, '')) as StoppedExecutionProof;
    shape(proof, ['version', 'kind', 'observedAt', 'sourceDataDir', 'botId', 'jobId', 'workerId', 'taskId', 'nativeId', 'sourceRowsSha256', 'host', 'native']);
    shape(proof.host, ['machineIdSha256', 'lastBootAt']); shape(proof.native, ['path', 'sha256', 'turnId', 'startedAt', 'completedAt']);
    if (proof.version !== 1 || proof.kind !== 'windows-local-codex-reboot' || typeof proof.jobId !== 'string' || !proof.jobId || !isAbsolute(proof.sourceDataDir) || pathKey(proof.sourceDataDir) !== pathKey(source.dataDir)) fail('证明类型或源目录不匹配。');
    if (used.has(proof.jobId)) fail('同一 job 的停止证明重复。'); used.add(proof.jobId);
    const actual = inspectStoppedExecution(source, proof.jobId, proof.native.path, hooks);
    if (proof.botId !== actual.botId || proof.workerId !== actual.workerId || proof.taskId !== actual.taskId || proof.nativeId !== actual.nativeId || proof.sourceRowsSha256 !== actual.sourceRowsSha256
      || canonical(proof.native) !== canonical(actual.native) || canonical(proof.host) !== canonical(actual.host) || time(proof.observedAt) > time(actual.observedAt) || time(proof.observedAt) < time(proof.host.lastBootAt)) fail('证明与当前登记、原生文件或本机身份/重启不匹配。');
    // 保存同一次现场核验时间；证明中自报的时间不能替代系统探针。
    return { proof, bytes, proofSha256: hash(bytes), verification: { ...actual.host, observedAt: actual.observedAt, matchingPids: [], unreadableAgentPids: [] } };
  });
}
