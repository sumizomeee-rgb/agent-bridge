import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { RemoteDispatch, RemoteJob } from './types.js';
import { NativeSessionLeaseStore, type NativeLegacyOwnership, type NativeSessionRef } from '../native-sessions.js';

export interface ProcessRecord { dispatchId: string; pid: number; identity: string | null; closed: boolean }
export function fingerprint(value: unknown): string {
  const canonical = (item: unknown): unknown => Array.isArray(item) ? item.map(canonical)
    : item && typeof item === 'object' ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)).map(([key, val]) => [key, canonical(val)])) : item;
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}
export class RemoteStore {
  readonly db: DatabaseSync;
  readonly nativeLeases: NativeSessionLeaseStore;
  constructor(directory: string) {
    mkdirSync(directory, { recursive: true });
    this.db = new DatabaseSync(join(directory, 'controller.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,worker TEXT NOT NULL,fingerprint TEXT NOT NULL,request TEXT NOT NULL,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS receipts(id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,result TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY,worker TEXT NOT NULL,agent TEXT NOT NULL,cwd TEXT NOT NULL,ownership TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS processes(job TEXT NOT NULL,pid INTEGER NOT NULL,identity TEXT,closed INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(job,pid));`);
    const columns = new Set(this.db.prepare('PRAGMA table_info(sessions)').all().map(row => String(row.name)));
    if (!columns.has('user_id')) this.db.exec('ALTER TABLE sessions ADD COLUMN user_id TEXT');
    this.db.exec('CREATE TABLE IF NOT EXISTS controller_owner_migrations(old_user_id TEXT PRIMARY KEY,user_id TEXT NOT NULL)');
    this.nativeLeases = new NativeSessionLeaseStore(join(directory, 'controller.sqlite'), this.db);
  }
  /** Explicit host-owned identity migration; execution choices and handback state are unchanged. */
  migrateControllerOwners(mapping: Record<string, string>): { migrated: number; retiredAdoptions: number } {
    const entries = Object.entries(mapping);
    if (!entries.length) return { migrated: 0, retiredAdoptions: 0 };
    for (const [oldUser, user] of entries) {
      if (!/^[A-Za-z0-9][A-Za-z0-9_.:\-]{0,199}\|[A-Za-z0-9][A-Za-z0-9_.:\-]{0,199}$/.test(oldUser)
        || !/^principal:[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(user)) throw new Error('主控归属迁移映射无效。');
    }
    const user = (value: unknown): unknown => typeof value === 'string' && Object.hasOwn(mapping, value) ? mapping[value] : value;
    const adoptionHash = (value: Record<string, unknown>) => createHash('sha256').update(JSON.stringify({ userId: value.userId,
      ref: value.ref, workerId: value.workerId, adoptionId: value.adoptionId, expectedRevision: value.revision })).digest('hex');
    let migrated = 0, retiredAdoptions = 0;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const [oldUser, next] of entries) {
        const previous = this.db.prepare('SELECT user_id FROM controller_owner_migrations WHERE old_user_id=?').get(oldUser);
        if (previous && previous.user_id !== next) throw new Error('已确认的主控归属迁移映射冲突，未改变数据。');
      }
      const requests = this.db.prepare('SELECT id,worker,fingerprint,request,data FROM jobs').all().map(row => ({ row, request: JSON.parse(String(row.request)) as RemoteDispatch }));
      for (const { row, request } of requests) {
        if (user(request.userId) === request.userId) continue;
        if (fingerprint(request) !== row.fingerprint) throw new Error('旧派工指纹与保存请求不一致，未迁移。');
        const job = JSON.parse(String(row.data)) as RemoteJob;
        if (job.status === 'running' || job.stopped === false || job.result && job.stopped !== true)
          throw new Error('原用户仍有未确认退出的远端执行，不能在线迁移归属。');
      }
      for (const row of this.db.prepare('SELECT id,worker,user_id FROM sessions').all()) {
        const workerRequests = requests.filter(value => value.row.worker === row.worker);
        if (!(typeof row.user_id === 'string' && Object.hasOwn(mapping, row.user_id))
          && !(row.user_id == null && workerRequests.some(value => user(value.request.userId) !== value.request.userId))) continue;
        const owners = new Set(workerRequests.map(value => user(value.request.userId)));
        const next = row.user_id == null && owners.size === 1 ? [...owners][0] : user(row.user_id);
        if (next == null || typeof next !== 'string' || !next.startsWith('principal:')) continue;
        if (owners.size && (owners.size !== 1 || !owners.has(next))) throw new Error('旧会话与派工用户归属冲突，未迁移。');
        this.db.prepare('UPDATE sessions SET user_id=? WHERE id=?').run(next, row.id!);
      }
      for (const { row, request } of requests) {
        const next = user(request.userId); if (next === request.userId) continue;
        request.userId = String(next);
        this.db.prepare('UPDATE jobs SET request=?,fingerprint=? WHERE id=?').run(JSON.stringify(request), fingerprint(request), row.id!);
        migrated++;
      }
      for (const [oldUser, next] of entries) this.db.prepare('UPDATE native_session_leases SET user_id=? WHERE user_id=?').run(next, oldUser);
      for (const row of this.db.prepare('SELECT id,fingerprint,result_json FROM native_session_adoptions').all()) {
        const result = JSON.parse(String(row.result_json)) as Record<string, unknown>, next = user(result.userId);
        if (next === result.userId) continue;
        const proven = row.id === result.adoptionId && typeof result.workerId === 'string' && typeof result.revision === 'string'
          && !!result.ref && typeof result.ref === 'object' && adoptionHash(result) === row.fingerprint;
        result.userId = next;
        if (result.ownership && typeof result.ownership === 'object' && !Array.isArray(result.ownership)) {
          const ownership = result.ownership as Record<string, unknown>;
          if (user(ownership.userId) !== next) throw new Error('旧接管回执的用户归属冲突，未迁移。');
          ownership.userId = next;
        }
        let hash: string;
        if (proven) hash = adoptionHash(result);
        else {
          hash = 'owner-migration-unreplayable:' + String(row.fingerprint);
          result.ownerMigration = { version: 1, status: 'unreplayable', reason: 'Original adoption arguments cannot be proven from the saved receipt.' };
          retiredAdoptions++;
        }
        this.db.prepare('UPDATE native_session_adoptions SET fingerprint=?,result_json=? WHERE id=?').run(hash, JSON.stringify(result), row.id!);
      }
      for (const [oldUser, next] of entries) this.db.prepare('INSERT OR IGNORE INTO controller_owner_migrations VALUES (?,?)').run(oldUser, next);
      this.db.exec('COMMIT'); return { migrated, retiredAdoptions };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  jobs(): RemoteJob[] { return (this.db.prepare('SELECT data FROM jobs').all() as { data: string }[]).map(row => JSON.parse(row.data) as RemoteJob); }
  job(id: string): RemoteJob | null { const row = this.db.prepare('SELECT data FROM jobs WHERE id=?').get(id) as { data: string } | undefined; return row ? JSON.parse(row.data) as RemoteJob : null; }
  request(id: string): RemoteDispatch | null { const row = this.db.prepare('SELECT request FROM jobs WHERE id=?').get(id) as { request: string } | undefined; return row ? JSON.parse(row.request) as RemoteDispatch : null; }
  create(request: RemoteDispatch): { job: RemoteJob; created: boolean } {
    const hash = fingerprint(request);
    const old = this.db.prepare('SELECT fingerprint,data FROM jobs WHERE id=?').get(request.dispatchId) as { fingerprint: string; data: string } | undefined;
    if (old) {
      if (old.fingerprint !== hash) throw new Error('同一派发编号的内容冲突。');
      return { job: JSON.parse(old.data) as RemoteJob, created: false };
    }
    const now = new Date().toISOString();
    const job: RemoteJob = { dispatchId: request.dispatchId, workerId: request.workerId, status: 'running', nativeId: request.nativeId, ready: false, createdAt: now, updatedAt: now };
    this.db.prepare('INSERT INTO jobs VALUES(?,?,?,?,?)').run(request.dispatchId, request.workerId, hash, JSON.stringify(request), JSON.stringify(job));
    return { job, created: true };
  }
  update(id: string, patch: Partial<RemoteJob>): RemoteJob {
    const old = this.job(id); if (!old) throw new Error('远端任务不存在。');
    const next = { ...old, ...patch, dispatchId: old.dispatchId, workerId: old.workerId, updatedAt: new Date().toISOString() };
    this.db.prepare('UPDATE jobs SET data=? WHERE id=?').run(JSON.stringify(next), id); return next;
  }
  receipt(id: string, input: unknown): unknown | undefined {
    const row = this.db.prepare('SELECT fingerprint,result FROM receipts WHERE id=?').get(id) as { fingerprint: string; result: string } | undefined;
    if (!row) return undefined;
    if (row.fingerprint !== fingerprint(input)) throw new Error('同一补充编号的内容冲突。');
    return JSON.parse(row.result);
  }
  saveReceipt(id: string, input: unknown, result: unknown): void {
    this.db.prepare('INSERT INTO receipts VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET result=excluded.result').run(id, fingerprint(input), JSON.stringify(result));
  }
  session(nativeId: string): { worker: string; agent: string; cwd: string; ownership: string; userId: string | null } | null {
    const row = this.db.prepare('SELECT worker,agent,cwd,ownership,user_id FROM sessions WHERE id=?').get(nativeId);
    if (!row) return null;
    let userId = typeof row.user_id === 'string' && row.user_id ? row.user_id : null;
    if (!userId) {
      const users = new Set(this.db.prepare('SELECT request FROM jobs WHERE worker=?').all(String(row.worker)).map(item => JSON.parse(String(item.request)).userId).filter((value): value is string => typeof value === 'string' && !!value));
      if (users.size === 1) userId = [...users][0]!;
    }
    return { worker: String(row.worker), agent: String(row.agent), cwd: String(row.cwd), ownership: String(row.ownership), userId };
  }
  bindSession(nativeId: string, worker: string, agent: string, cwd: string, userId?: string): void {
    const old = this.session(nativeId);
    if (old && (old.worker !== worker || old.agent !== agent || old.cwd !== cwd || old.ownership !== 'bridge' || userId && old.userId && old.userId !== userId)) throw new Error('原生会话归属不符或已经交给用户。');
    if (userId && (agent === 'codex' || agent === 'claude')) this.nativeLeases.bind({ agent, profile: 'default', nativeId }, userId, worker);
    this.db.prepare("INSERT INTO sessions(id,worker,agent,cwd,ownership,user_id) VALUES(?,?,?,?,'bridge',?) ON CONFLICT(id) DO UPDATE SET user_id=COALESCE(sessions.user_id,excluded.user_id)").run(nativeId, worker, agent, cwd, userId ?? null);
  }
  nativeOwnership(ref: NativeSessionRef): NativeLegacyOwnership | null {
    const session = this.session(ref.nativeId); if (!session) return null;
    if (session.agent !== ref.agent) throw new Error('此原生编号已登记为另一引擎的会话。');
    const jobs = this.jobs().filter(job => job.workerId === session.worker);
    const request = jobs.toSorted((a, b) => b.createdAt.localeCompare(a.createdAt)).map(job => this.request(job.dispatchId)).find(Boolean);
    const execution = request ? { workerId: session.worker, model: request.model, effort: request.effort ?? null,
      ...(request.modelPolicy ? { modelPolicy: request.modelPolicy } : {}),
      ...(request.preset ? { preset: request.preset } : {}), ...(request.sessionVisibility ? { sessionVisibility: request.sessionVisibility } : {}) } : this.nativeLeases.execution(ref);
    return { userId: session.userId ?? 'unknown-owner', workerId: session.worker, state: session.ownership === 'user' ? 'user' : 'bridge', revision: 0, cwd: session.cwd,
      ...(execution ? { execution } : {}),
      busy: jobs.some(job => job.status === 'running' || ['completed', 'failed'].includes(job.status) && !!job.result && job.stopped !== true), blocked: jobs.some(job => job.status === 'uncertain') };
  }
  /** Called inside the native lease transaction after fresh file-holder/terminal checks. */
  adoptSession(ref: NativeSessionRef, userId: string, workerId: string, cwd: string): void {
    const old = this.nativeOwnership(ref);
    if (old && (old.userId !== userId || old.busy || old.blocked)) throw new Error('旧原生会话的用户、活动或未知状态不允许接管。');
    this.db.prepare("INSERT INTO sessions(id,worker,agent,cwd,ownership,user_id) VALUES(?,?,?,?,'bridge',?) ON CONFLICT(id) DO UPDATE SET worker=excluded.worker,agent=excluded.agent,cwd=excluded.cwd,ownership='bridge',user_id=excluded.user_id")
      .run(ref.nativeId, workerId, ref.agent, cwd, userId);
  }
  handoff(nativeId: string): void {
    const session = this.session(nativeId); if (!session) return;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare("UPDATE sessions SET ownership='user' WHERE id=?").run(nativeId);
      if (session.agent === 'codex' || session.agent === 'claude') this.nativeLeases.release({ agent: session.agent, profile: 'default', nativeId });
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  process(record: ProcessRecord): void {
    this.db.prepare('INSERT INTO processes VALUES(?,?,?,?) ON CONFLICT(job,pid) DO UPDATE SET identity=excluded.identity,closed=excluded.closed').run(record.dispatchId, record.pid, record.identity, record.closed ? 1 : 0);
  }
  processes(job: string): ProcessRecord[] {
    return (this.db.prepare('SELECT * FROM processes WHERE job=? AND closed=0').all(job) as { job: string; pid: number; identity: string | null; closed: number }[])
      .map(row => ({ dispatchId: row.job, pid: row.pid, identity: row.identity, closed: row.closed === 1 }));
  }
  /** Complete tracked history distinguishes confirmed exits from missing process evidence. */
  processRecords(job: string): ProcessRecord[] {
    return (this.db.prepare('SELECT * FROM processes WHERE job=?').all(job) as { job: string; pid: number; identity: string | null; closed: number }[])
      .map(row => ({ dispatchId: row.job, pid: row.pid, identity: row.identity, closed: row.closed === 1 }));
  }
  close(): void { this.db.close(); }
}
