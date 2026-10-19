import type { AgentCommand, AgentName } from './types.js';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, openSync, closeSync, readSync, readdirSync, realpathSync, statSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { parse as parseToml } from 'smol-toml';

export interface NativeSessionRef { agent: AgentName; profile: 'default'; nativeId: string }
export interface NativeSessionQuery { agent: AgentName; userId: string; cwd?: string; cursor?: string; limit?: number; query?: string }
export interface NativeSessionOwnership { userId: string; workerId: string; state: 'bridge' | 'user'; revision: number }
export interface NativeSessionSummary {
  ref: NativeSessionRef; nativeId: string; profile: 'default'; cwd: string; title: string;
  model: string | null; effort: string | null; provider: string | null; revision: string;
  actualModel?: string | null; recordedCliVersion?: string | null;
  validation?: { provider: 'provider-id-only' | 'not-recorded'; inference: 'not-tested'; cli: 'entry-present' | 'not-checked' };
  health: 'healthy' | 'busy' | 'unknown' | 'incompatible'; busyEvidence: string[];
  ownership?: NativeSessionOwnership; reason?: string;
}
export interface NativeSessionPage { sessions: NativeSessionSummary[]; nextCursor: string | null }
export interface NativeSessionRead extends NativeSessionSummary { messages: Array<{ role: 'user' | 'assistant'; text: string }>; truncated: boolean }
export interface NativeSessionAdoption extends NativeSessionSummary {
  workerId: string; userId: string; adoptionId: string; status: 'adopted'; leaseRevision: number;
}
export interface NativeSessionAdoptArgs { ref: NativeSessionRef; workerId: string; adoptionId: string; expectedRevision: string }
export interface NativeSessionReadOptions { limit?: number }
export type NativeEngineRegistration = Partial<Record<AgentName, { agentCommand: AgentCommand; defaultCwd: string }>>;
export interface NativeBusyEvidence { status: 'clear' | 'busy' | 'unknown'; evidence: string[] }
export class NativeAdoptionRejectedError extends Error {
  readonly code = 'NATIVE_ADOPTION_REJECTED'; readonly definitive = true; readonly adoptionRejected = true;
  constructor(message: string) { super(message); this.name = 'NativeAdoptionRejectedError'; }
}

export interface NativeLegacyOwnership extends NativeSessionOwnership { busy: boolean; blocked: boolean; cwd: string }
interface LeaseRow extends NativeSessionOwnership { adopted: boolean }
interface RecordInfo { ref: NativeSessionRef; path: string; cwd: string; title: string; model: string | null; actualModel?: string | null; effort: string | null; provider: string | null; version?: string }
const idPattern = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/;
// Host-scoped principals contain a pipe; native session IDs never do.
const userIdPattern = /^[A-Za-z0-9][A-Za-z0-9_.:|\-]{0,199}$/;
function validRef(ref: NativeSessionRef): void {
  if (!ref || !['codex', 'claude'].includes(ref.agent) || ref.profile !== 'default' || !idPattern.test(ref.nativeId)) throw new Error('原生会话引用无效。');
}
function key(ref: NativeSessionRef): string { validRef(ref); return `${ref.agent}:${ref.profile}:${ref.nativeId}`; }
function compact(value: unknown, limit = 240): string {
  if (typeof value !== 'string') return '';
  const text = value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, ''); let end = Math.min(text.length, limit);
  if (end > 0 && end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]!) && /[\uDC00-\uDFFF]/.test(text[end]!)) end--;
  return text.slice(0, end);
}
function fingerprint(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function plain(value: unknown): value is Record<string, any> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
export function windowsPath(path: string): string {
  if (process.platform !== 'win32') return path;
  if (/^\\\\\?\\UNC\\/i.test(path)) return '\\\\' + path.slice(8);
  return /^\\\\\?\\[A-Za-z]:\\/.test(path) ? path.slice(4) : path;
}

/** One target-native journal: leases and reverse handoffs survive bridge reconnects. */
export class NativeSessionLeaseStore {
  private readonly db: DatabaseSync;
  private readonly own: boolean;
  private closed = false;
  constructor(path: string, db?: DatabaseSync) {
    if (!db) mkdirSync(dirname(path), { recursive: true });
    this.own = !db; this.db = db ?? new DatabaseSync(path);
    this.db.exec(`CREATE TABLE IF NOT EXISTS native_session_leases (
      ref TEXT PRIMARY KEY,user_id TEXT NOT NULL,worker_id TEXT NOT NULL,state TEXT NOT NULL,revision INTEGER NOT NULL,adopted INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS native_session_adoptions (id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,result_json TEXT NOT NULL);`);
  }
  get(ref: NativeSessionRef): LeaseRow | null {
    const row = this.db.prepare('SELECT * FROM native_session_leases WHERE ref=?').get(key(ref));
    return row ? { userId: String(row.user_id), workerId: String(row.worker_id), state: row.state === 'user' ? 'user' : 'bridge', revision: Number(row.revision), adopted: Number(row.adopted) === 1 } : null;
  }
  previous(adoptionId: string, hash: string): NativeSessionAdoption | null {
    const row = this.db.prepare('SELECT * FROM native_session_adoptions WHERE id=?').get(adoptionId);
    if (!row) return null;
    if (row.fingerprint !== hash) throw new NativeAdoptionRejectedError('相同接管编号的内容或用户不一致。');
    const result = JSON.parse(String(row.result_json)) as NativeSessionAdoption;
    const lease = this.get(result.ref);
    if (!lease || lease.userId !== result.userId || lease.workerId !== result.workerId || lease.state !== 'bridge' || lease.revision !== result.leaseRevision) throw new NativeAdoptionRejectedError('此前接管回执已被后续交接或接管取代，不能宣称仍持有原会话。');
    return result;
  }
  claim(info: NativeSessionSummary, userId: string, args: NativeSessionAdoptArgs,
    legacy: NativeLegacyOwnership | null, rebind?: () => void): NativeSessionAdoption {
    const hash = fingerprint({ userId, ...args }); const saved = this.previous(args.adoptionId, hash); if (saved) return saved;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const old = this.get(args.ref);
      if ((old?.revision ?? 0) !== (info.ownership?.revision ?? 0)) throw new Error('原生会话持有登记在检查后发生变化，未接管。');
      if (old && old.userId !== userId || legacy && legacy.userId !== userId) throw new Error('此原生会话属于其他用户，不能接管。');
      if (legacy?.busy || legacy?.blocked) throw new Error('旧桥任务仍在执行或结果未知，不能接管。');
      const revision = (old?.revision ?? 0) + 1;
      rebind?.();
      this.db.prepare(`INSERT INTO native_session_leases VALUES(?,?,?,?,?,1) ON CONFLICT(ref) DO UPDATE SET
        user_id=excluded.user_id,worker_id=excluded.worker_id,state='bridge',revision=excluded.revision,adopted=1`).run(key(args.ref), userId, args.workerId, 'bridge', revision);
      const result: NativeSessionAdoption = { ...info, workerId: args.workerId, userId, adoptionId: args.adoptionId,
        status: 'adopted', leaseRevision: revision, ownership: { userId, workerId: args.workerId, state: 'bridge', revision } };
      this.db.prepare('INSERT INTO native_session_adoptions VALUES(?,?,?)').run(args.adoptionId, hash, JSON.stringify(result));
      this.db.exec('COMMIT'); return result;
    } catch (error) { this.db.exec('ROLLBACK'); throw new NativeAdoptionRejectedError(error instanceof Error ? error.message : '接管事务已回滚，未领取会话。'); }
  }
  bind(ref: NativeSessionRef, userId: string, workerId: string): void {
    const old = this.get(ref);
    if (old && (old.userId !== userId || old.workerId !== workerId || old.state !== 'bridge')) throw new Error('原生会话持有者已改变或交给用户，不能并发续接。');
    if (!old) this.db.prepare('INSERT INTO native_session_leases VALUES(?,?,?,?,1,0)').run(key(ref), userId, workerId, 'bridge');
  }
  release(ref: NativeSessionRef): void { this.db.prepare("UPDATE native_session_leases SET state='user',revision=revision+1 WHERE ref=?").run(key(ref)); }
  close(): void { if (this.own && !this.closed) this.db.close(); this.closed = true; }
}

/** Restart Manager only enumerates holders of this exact validated transcript; it never stops them. */
export async function probeNativeFileHolders(path: string): Promise<NativeBusyEvidence> {
  if (process.platform !== 'win32') return { status: 'unknown', evidence: ['当前平台尚未实现精确会话文件持有者检查。'] };
  const literal = `'${path.replaceAll("'", "''")}'`;
  const script = `$ErrorActionPreference='Stop';[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public static class NativeSessionRM {
 [StructLayout(LayoutKind.Sequential)] public struct UNIQUE { public uint pid; public System.Runtime.InteropServices.ComTypes.FILETIME start; }
 [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] public struct INFO { public UNIQUE process; [MarshalAs(UnmanagedType.ByValTStr,SizeConst=256)] public string app; [MarshalAs(UnmanagedType.ByValTStr,SizeConst=64)] public string service; public uint type; public uint status; public uint session; [MarshalAs(UnmanagedType.Bool)] public bool restartable; }
 [DllImport("rstrtmgr.dll",CharSet=CharSet.Unicode)] public static extern int RmStartSession(out uint handle,uint flags,string key);
 [DllImport("rstrtmgr.dll",CharSet=CharSet.Unicode)] public static extern int RmRegisterResources(uint handle,uint files,string[] paths,uint apps,IntPtr processes,uint services,IntPtr names);
 [DllImport("rstrtmgr.dll",CharSet=CharSet.Unicode)] public static extern int RmGetList(uint handle,out uint needed,ref uint count,[In,Out] INFO[] list,ref uint reasons);
 [DllImport("rstrtmgr.dll")] public static extern int RmEndSession(uint handle);
}
'@
[uint32]$handle=0;$rc=[NativeSessionRM]::RmStartSession([ref]$handle,0,[Guid]::NewGuid().ToString('N'));if($rc -ne 0){throw "RM start $rc"}
try{$rc=[NativeSessionRM]::RmRegisterResources($handle,1,[string[]]@(${literal}),0,[IntPtr]::Zero,0,[IntPtr]::Zero);if($rc -ne 0){throw "RM register $rc"}
[uint32]$needed=0;[uint32]$count=0;[uint32]$reasons=0;$rc=[NativeSessionRM]::RmGetList($handle,[ref]$needed,[ref]$count,$null,[ref]$reasons)
if($rc -eq 0 -and $needed -eq 0){[Console]::Write('{"status":"clear","evidence":[]}');exit}
if($rc -ne 234){throw "RM list $rc"};$list=[NativeSessionRM+INFO[]]::new($needed);$count=$needed;$rc=[NativeSessionRM]::RmGetList($handle,[ref]$needed,[ref]$count,$list,[ref]$reasons);if($rc -ne 0){throw "RM enumerate $rc"}
$pids=@($list|Select-Object -First $count|ForEach-Object{$_.process.pid});[Console]::Write((@{status='busy';evidence=@($pids|ForEach-Object{"会话文件仍被进程 PID $_ 持有。"})}|ConvertTo-Json -Compress))
}finally{[void][NativeSessionRM]::RmEndSession($handle)}`;
  return new Promise(resolveValue => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    let output = ''; let ended = false;
    const finish = (value: NativeBusyEvidence) => { if (ended) return; ended = true; clearTimeout(timer); resolveValue(value); };
    const timer = setTimeout(() => { child.kill(); finish({ status: 'unknown', evidence: ['精确会话文件持有者检查超时，未接管。'] }); }, 12_000);
    child.stdout.on('data', part => { if (output.length < 32_000) output += String(part); });
    child.once('error', () => finish({ status: 'unknown', evidence: ['无法启动精确会话文件检查，未接管。'] }));
    child.once('close', code => {
      try { const result = JSON.parse(output); if (code !== 0 || !['clear', 'busy'].includes(result.status) || !Array.isArray(result.evidence)) throw new Error(); finish(result); }
      catch { finish({ status: 'unknown', evidence: ['无法确认精确会话文件持有者，未接管。'] }); }
    });
  });
}

export interface NativeSessionServiceOptions {
  env?: NodeJS.ProcessEnv; userHome?: string; leaseStore?: NativeSessionLeaseStore;
  busyProbe?: (path: string) => Promise<NativeBusyEvidence>;
  legacyOwnership?: (ref: NativeSessionRef) => NativeLegacyOwnership | null;
  rebind?: (ref: NativeSessionRef, userId: string, workerId: string, cwd: string) => void;
}
export class NativeSessionService {
  readonly leases: NativeSessionLeaseStore;
  private readonly adopting = new Map<string, { hash: string; promise: Promise<NativeSessionAdoption> }>();
  private readonly homes: Record<AgentName, string>;
  constructor(readonly dataDir: string, private readonly engines: NativeEngineRegistration, private readonly options: NativeSessionServiceOptions = {}) {
    const env = options.env ?? process.env, home = options.userHome ?? homedir();
    this.homes = { codex: resolve(env.CODEX_HOME ?? join(home, '.codex')), claude: resolve(env.CLAUDE_CONFIG_DIR ?? join(home, '.claude')) };
    this.leases = options.leaseStore ?? new NativeSessionLeaseStore(join(dataDir, 'native-session-leases.sqlite'));
  }
  private legacy(ref: NativeSessionRef, adopting?: { workerId: string; adoptionId: string; userId: string }, runOwner?: { workerId: string; userId: string }): NativeLegacyOwnership | null {
    if (this.options.legacyOwnership) return this.options.legacyOwnership(ref);
    const path = join(this.dataDir, 'controller.sqlite'); if (!existsSync(path)) return null;
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='controller_workers'").get()) return null;
      for (const row of db.prepare('SELECT value_json FROM controller_workers').all()) {
        const worker = JSON.parse(String(row.value_json));
        if (worker.agent !== ref.agent || worker.nativeId !== ref.nativeId || worker.target?.transport === 'ssh') continue;
        if (adopting && worker.id === adopting.workerId && worker.origin.userId === adopting.userId && worker.adoption?.id === adopting.adoptionId && worker.adoption.status === 'pending') continue;
        const jobs = db.prepare('SELECT status FROM controller_jobs WHERE worker_id=?').all(worker.id);
        return { userId: worker.origin.userId, workerId: worker.id, state: worker.ownership === 'user' ? 'user' : 'bridge', revision: 0,
          cwd: worker.cwd, busy: !(runOwner?.workerId === worker.id && runOwner?.userId === worker.origin.userId) && jobs.some(job => ['queued', 'running'].includes(String(job.status))), blocked: worker.blocked === true || jobs.some(job => job.status === 'uncertain') };
      }
      return null;
    } finally { db.close(); }
  }
  private checkedPath(path: string, agent: AgentName): string {
    const normalized = windowsPath(path);
    const home = realpathSync(windowsPath(this.homes[agent])); const actual = realpathSync(normalized); const rel = relative(home, actual);
    if (!isAbsolute(normalized) || rel.startsWith('..') || isAbsolute(rel) || lstatSync(normalized).isSymbolicLink() || !statSync(actual).isFile()) throw new Error('原生会话记录不在可信用户 profile 内。');
    return actual;
  }
  private slices(path: string, tailLimit = 1024 * 1024): { head: Record<string, any>[]; tail: Record<string, any>[]; bytes: number; mtime: number; partial: boolean } {
    const stat = statSync(path), fd = openSync(path, 'r');
    try {
      const size = Math.min(stat.size, tailLimit), headSize = Math.min(stat.size, 64 * 1024);
      const head = Buffer.alloc(headSize), tail = Buffer.alloc(size);
      readSync(fd, head, 0, headSize, 0); readSync(fd, tail, 0, size, stat.size - size);
      const parse = (text: string) => {
        let partial = false;
        const records = text.replace(/^\uFEFF/, '').split('\n').flatMap(line => {
          if (!line.trim()) return [];
          try { const value = JSON.parse(line); return plain(value) ? [value] : []; } catch { partial = true; return []; }
        });
        return { records, partial };
      };
      const tailData = parse(tail.toString('utf8'));
      return { head: parse(head.toString('utf8')).records, tail: tailData.records, bytes: stat.size, mtime: stat.mtimeMs, partial: stat.size > size || tailData.partial };
    } finally { closeSync(fd); }
  }
  private codexRecords(): RecordInfo[] {
    const home = this.homes.codex; if (!existsSync(home)) return [];
    const paths = readdirSync(home).filter(name => /^state_\d+\.sqlite$/.test(name)).sort((a, b) => Number(b.match(/\d+/)![0]) - Number(a.match(/\d+/)![0]));
    if (!paths.length) throw new Error('当前 Codex profile 缺少原生会话索引，请由 CLI 更新索引后再发现会话。');
    const db = new DatabaseSync(join(home, paths[0]!), { readOnly: true });
    try {
      const columns = new Set(db.prepare('PRAGMA table_info(threads)').all().map(row => String(row.name)));
      if (!['id', 'rollout_path', 'cwd', 'model_provider'].every(column => columns.has(column))) throw new Error('当前 Codex 索引版本尚不支持安全发现。');
      return db.prepare('SELECT * FROM threads WHERE archived=0 ORDER BY updated_at DESC LIMIT 2000').all().flatMap(row => {
        if (!idPattern.test(String(row.id))) return [];
        return [{ ref: { agent: 'codex' as const, profile: 'default' as const, nativeId: String(row.id) }, path: String(row.rollout_path), cwd: windowsPath(String(row.cwd)), title: compact(row.name || row.title || row.first_user_message, 160), model: typeof row.model === 'string' ? row.model : null, effort: typeof row.reasoning_effort === 'string' ? row.reasoning_effort : null, provider: typeof row.model_provider === 'string' ? row.model_provider : null, version: typeof row.cli_version === 'string' ? row.cli_version : undefined }];
      });
    } finally { db.close(); }
  }
  private claudeRecords(): RecordInfo[] {
    const root = join(this.homes.claude, 'projects'); if (!existsSync(root)) return [];
    const records: RecordInfo[] = [];
    for (const directory of readdirSync(root, { withFileTypes: true }).slice(0, 1000)) {
      if (!directory.isDirectory() || directory.isSymbolicLink()) continue;
      const base = join(root, directory.name);
      for (const file of readdirSync(base, { withFileTypes: true }).slice(0, 2000)) {
        if (!file.isFile() || file.isSymbolicLink() || !/^[a-f0-9-]{36}\.jsonl$/i.test(file.name)) continue;
        const path = this.checkedPath(join(base, file.name), 'claude'); const data = this.slices(path, 64 * 1024);
        const values = [...data.head, ...data.tail].filter(value => value.isSidechain !== true), first = values.find(value => typeof value.sessionId === 'string' && typeof value.cwd === 'string');
        if (!first || first.sessionId !== file.name.slice(0, -6)) continue;
        const lastModel = values.filter(value => typeof value.message?.model === 'string').at(-1)?.message.model;
        const prompt = values.find(value => value.type === 'user' && typeof value.message?.content === 'string')?.message.content;
        records.push({ ref: { agent: 'claude', profile: 'default', nativeId: first.sessionId }, path, cwd: first.cwd,
          title: compact(values.filter(value => value.type === 'custom-title').at(-1)?.customTitle || prompt || first.sessionId, 160), model: null, actualModel: typeof lastModel === 'string' ? lastModel : null,
          effort: null, provider: null, version: typeof first.version === 'string' ? first.version : undefined });
        if (records.length >= 2000) return records;
      }
    }
    return records.sort((a, b) => statSync(b.path).mtimeMs - statSync(a.path).mtimeMs);
  }
  private records(agent: AgentName): RecordInfo[] { if (!this.engines[agent]) throw new Error('此电脑未登记所选引擎。'); return agent === 'codex' ? this.codexRecords() : this.claudeRecords(); }
  async list(query: NativeSessionQuery): Promise<NativeSessionPage> {
    if (typeof query.userId !== 'string' || !userIdPattern.test(query.userId)) throw new Error('用户编号无效。');
    if (query.limit !== undefined && (!Number.isSafeInteger(query.limit) || query.limit < 1) || query.cwd !== undefined && (typeof query.cwd !== 'string' || !isAbsolute(query.cwd)) || query.query !== undefined && (typeof query.query !== 'string' || query.query.length > 240)) throw new Error('原生会话查询参数无效。');
    const limit = Math.min(50, Math.max(1, query.limit ?? 20));
    const offset = query.cursor ? Number(query.cursor) : 0; if (!Number.isSafeInteger(offset) || offset < 0 || offset > 2000) throw new Error('会话分页游标无效。');
    const rows = this.records(query.agent).filter(row => (!query.cwd || resolve(row.cwd) === resolve(query.cwd)) && (!query.query || `${row.title} ${row.ref.nativeId}`.includes(query.query)));
    const page: NativeSessionSummary[] = [];
    for (const info of rows.slice(offset, offset + limit)) {
      try { const { messages: _messages, truncated: _truncated, ...summary } = await this.inspect(info, query.userId, false); if (!summary.ownership || summary.ownership.userId === query.userId) page.push(summary); } catch { /* Corrupt/unreadable records are not advertised as adoptable. */ }
    }
    return { sessions: page, nextCursor: offset + limit < rows.length ? String(offset + limit) : null };
  }
  private async inspect(info: RecordInfo, userId: string, probe: boolean, adopting?: { workerId: string; adoptionId: string; userId: string }, runOwner?: { workerId: string; userId: string }): Promise<NativeSessionRead> {
    const path = this.checkedPath(info.path, info.ref.agent), data = this.slices(path);
    const lease = this.leases.get(info.ref), legacy = this.legacy(info.ref, adopting, runOwner);
    if (lease && lease.userId !== userId || legacy && legacy.userId !== userId) throw new Error('原生会话属于其他用户，不能读取。');
    const ownership = lease ?? legacy ?? undefined;
    let health: NativeSessionSummary['health'] = 'unknown', reason = '仅发现历史记录，尚未核验当前持有者。';
    const messages: NativeSessionRead['messages'] = [];
    let clippedMessages = false;
    const addMessage = (role: 'user' | 'assistant', text: string) => {
      const clean = compact(text, Number.MAX_SAFE_INTEGER), clipped = compact(clean, 3000);
      clippedMessages ||= clipped.length < clean.length;
      messages.push({ role, text: clipped });
    };
    let terminal = false;
    if (info.ref.agent === 'codex') {
      const meta = data.head.find(row => row.type === 'session_meta')?.payload;
      if (!meta || meta.id !== info.ref.nativeId) throw new Error('Codex 索引与真实会话编号不匹配。');
      const context = data.tail.filter(row => row.type === 'turn_context').at(-1)?.payload;
      info = { ...info, cwd: windowsPath(context?.cwd ?? meta.cwd ?? info.cwd), model: context?.model ?? info.model, effort: context?.effort ?? info.effort };
      const event = data.tail.filter(row => row.type === 'event_msg' && ['task_started', 'task_complete', 'turn_aborted'].includes(row.payload?.type)).at(-1)?.payload;
      terminal = event?.type === 'task_complete' || event?.type === 'turn_aborted';
      for (const row of data.tail) if (row.type === 'response_item' && row.payload?.type === 'message' && ['user', 'assistant'].includes(row.payload.role)) {
        const text = Array.isArray(row.payload.content) ? row.payload.content.map((block: any) => typeof block.text === 'string' ? block.text : '').join('\n') : '';
        if (text) addMessage(row.payload.role, text);
      }
    } else {
      const last = data.tail.filter(row => ['user', 'assistant'].includes(row.type) && !row.isSidechain).at(-1);
      terminal = last?.type === 'assistant' && ['end_turn', 'stop_sequence'].includes(last.message?.stop_reason);
      for (const row of data.tail) if (['user', 'assistant'].includes(row.type) && !row.isSidechain) {
        const content = row.message?.content; const text = typeof content === 'string' ? content : Array.isArray(content) ? content.filter((block: any) => block.type === 'text').map((block: any) => block.text ?? '').join('\n') : '';
        if (text) addMessage(row.type, text);
      }
    }
    let busyEvidence: string[] = [];
    const command = this.engines[info.ref.agent]!.agentCommand;
    const cliPresent = isAbsolute(command.command) && existsSync(command.command) && command.args.filter(arg => isAbsolute(arg) && /\.(?:js|mjs|cjs)$/i.test(arg)).every(arg => existsSync(arg));
    if (legacy?.busy) { health = 'busy'; reason = '桥已登记的原会话仍有活动或排队任务。'; }
    else if (legacy?.blocked) { health = 'incompatible'; reason = '旧桥登记有未确认操作或交接，未自动清除。'; }
    else if (!isAbsolute(info.cwd) || !existsSync(info.cwd) || !statSync(info.cwd).isDirectory()) { health = 'incompatible'; reason = '原生会话工作目录当前不可用。'; }
    else if (!terminal) { reason = '未找到可靠的原生轮次终态，可能执行中或曾中断，未接管。'; }
    else if (!cliPresent) { health = 'incompatible'; reason = '登记的原生 CLI 入口不可用，未接管。'; }
    else if (probe) {
      const busy = await (this.options.busyProbe ?? probeNativeFileHolders)(path); busyEvidence = busy.evidence;
      health = busy.status === 'clear' ? 'healthy' : busy.status === 'busy' ? 'busy' : 'unknown'; reason = health === 'healthy' ? '' : '原会话持有者尚未释放或无法确认。';
    }
    if (info.ref.agent === 'codex') {
      const configPath = join(this.homes.codex, 'config.toml');
      let provider: unknown = 'openai';
      try { if (existsSync(configPath)) provider = parseToml(readFileSync(configPath, 'utf8')).model_provider ?? 'openai'; }
      catch { throw new Error('当前 Codex 供应商配置无法安全读取；未修改配置。'); }
      if (info.provider && provider !== info.provider) { health = 'incompatible'; reason = '会话记录的供应商与当前用户 CLI 配置不同；未修改路由或另开会话。'; }
    }
    const revision = fingerprint({ id: info.ref.nativeId, agent: info.ref.agent, bytes: data.bytes, mtime: data.mtime, cwd: info.cwd, model: info.model, effort: info.effort, provider: info.provider, leaseRevision: lease?.revision ?? 0 });
    let budget = 32 * 1024; const boundedMessages: NativeSessionRead['messages'] = [];
    for (const message of messages.slice(-20).reverse()) {
      const raw = Buffer.from(message.text); if (budget <= 0) break;
      let end = Math.min(raw.length, budget);
      if (end < raw.length) { clippedMessages = true; while (end > 0 && (raw[end]! & 0xc0) === 0x80) end--; }
      const text = raw.length <= budget ? message.text : raw.subarray(0, end).toString('utf8');
      budget -= Buffer.byteLength(text); boundedMessages.unshift({ ...message, text });
    }
    return { ref: info.ref, nativeId: info.ref.nativeId, profile: 'default', cwd: info.cwd, title: info.title, model: info.model, actualModel: info.actualModel ?? null, effort: info.effort, provider: info.provider, recordedCliVersion: info.version ?? null,
      validation: { provider: info.provider ? 'provider-id-only' : 'not-recorded', inference: 'not-tested', cli: cliPresent ? 'entry-present' : 'not-checked' },
      revision, health, busyEvidence, ...(ownership ? { ownership: { userId: ownership.userId, workerId: ownership.workerId, state: ownership.state, revision: ownership.revision } } : {}), ...(reason ? { reason } : {}), messages: boundedMessages, truncated: data.partial || clippedMessages || messages.length > boundedMessages.length || budget === 0 };
  }
  async read(userId: string, ref: NativeSessionRef, options: NativeSessionReadOptions = {}): Promise<NativeSessionRead> {
    validRef(ref); const info = this.records(ref.agent).find(item => item.ref.nativeId === ref.nativeId); if (!info) throw new Error('原生会话未在此用户可信 profile 中找到。');
    const result = await this.inspect(info, userId, true); const limit = Math.min(20, Math.max(1, options.limit ?? 10));
    return { ...result, messages: result.messages.slice(-limit), truncated: result.truncated || result.messages.length > limit };
  }
  adopt(userId: string, args: NativeSessionAdoptArgs): Promise<NativeSessionAdoption> {
    const operation = args?.adoptionId, hash = fingerprint({ userId, ...args });
    if (typeof operation !== 'string') return Promise.reject(new NativeAdoptionRejectedError('接管编号无效。'));
    const pending = this.adopting.get(operation);
    if (pending) return pending.hash === hash ? pending.promise : Promise.reject(new NativeAdoptionRejectedError('同一接管编号的用户或参数冲突。'));
    const promise = this.adoptOnce(userId, args).finally(() => this.adopting.delete(operation));
    this.adopting.set(operation, { hash, promise }); return promise;
  }
  private async adoptOnce(userId: string, args: NativeSessionAdoptArgs): Promise<NativeSessionAdoption> {
    let verifiedNoReceipt = false, claiming = false;
    try {
    if (typeof userId !== 'string' || !userIdPattern.test(userId) || !idPattern.test(args.workerId) || !idPattern.test(args.adoptionId)) throw new Error('接管来源编号无效。');
    validRef(args.ref); const hash = fingerprint({ userId, ...args }), saved = this.leases.previous(args.adoptionId, hash); if (saved) return saved;
    verifiedNoReceipt = true;
    const record = this.records(args.ref.agent).find(item => item.ref.nativeId === args.ref.nativeId); if (!record) throw new Error('原生会话未在可信 profile 中找到。');
    const adopting = { workerId: args.workerId, adoptionId: args.adoptionId, userId };
    const info = await this.inspect(record, userId, true, adopting);
    if (info.revision !== args.expectedRevision) throw new Error('原生会话在检查后发生变化，请重新读取状态；未接管。');
    if (info.health !== 'healthy') throw new Error(`原生会话尚不能接管：${info.reason ?? info.health}`);
    const current = await this.inspect(record, userId, true, adopting);
    if (current.revision !== info.revision || current.health !== 'healthy') throw new Error('原生会话在准备接管时再次发生变化，未接管。');
    const { messages: _messages, truncated: _truncated, ...summary } = current;
    claiming = true;
    return this.leases.claim(summary, userId, args, this.legacy(args.ref, adopting), this.options.rebind ? () => this.options.rebind!(args.ref, userId, args.workerId, current.cwd) : undefined);
    } catch (error) {
      if (error instanceof NativeAdoptionRejectedError) throw error;
      if (claiming || !verifiedNoReceipt) throw error;
      throw new NativeAdoptionRejectedError(error instanceof Error ? error.message : '原生会话接管前检查失败，未领取会话。');
    }
  }
  async assertRunOwnership(ref: NativeSessionRef, userId: string, workerId: string): Promise<void> {
    const lease = this.leases.get(ref); if (!lease) return;
    if (lease.userId !== userId || lease.workerId !== workerId || lease.state !== 'bridge') throw new Error('原生会话已经交给用户或由另一 worker 持有，未续接。');
    if (lease.adopted) { const record = this.records(ref.agent).find(item => item.ref.nativeId === ref.nativeId); if (!record) throw new Error('接管会话记录已不可用，未续接。'); const info = await this.inspect(record, userId, true, undefined, { workerId, userId }); if (info.health !== 'healthy') throw new Error(`接管会话当前仍有持有者或未知状态，未续接：${info.reason ?? info.health}`); }
  }
  bindRunOwnership(ref: NativeSessionRef, userId: string, workerId: string): void {
    if (!this.leases.get(ref)) { const old = this.legacy(ref); if (old && (old.userId !== userId || old.workerId !== workerId || old.state !== 'bridge')) throw new Error('旧会话已交给用户或另一 worker，必须显式接管。'); }
    this.leases.bind(ref, userId, workerId);
  }
  close(): void { this.leases.close(); }
}
