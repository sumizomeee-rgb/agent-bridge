import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { RemoteDispatch, RemoteJob } from './types.js';

export interface ProcessRecord { dispatchId: string; pid: number; identity: string | null; closed: boolean }
export function fingerprint(value: unknown): string {
  const canonical = (item: unknown): unknown => Array.isArray(item) ? item.map(canonical)
    : item && typeof item === 'object' ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)).map(([key, val]) => [key, canonical(val)])) : item;
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}
export class RemoteStore {
  readonly db: DatabaseSync;
  constructor(directory: string) {
    mkdirSync(directory, { recursive: true });
    this.db = new DatabaseSync(join(directory, 'controller.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,worker TEXT NOT NULL,fingerprint TEXT NOT NULL,request TEXT NOT NULL,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS receipts(id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,result TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY,worker TEXT NOT NULL,agent TEXT NOT NULL,cwd TEXT NOT NULL,ownership TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS processes(job TEXT NOT NULL,pid INTEGER NOT NULL,identity TEXT,closed INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(job,pid));`);
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
  session(nativeId: string): { worker: string; agent: string; cwd: string; ownership: string } | null {
    return this.db.prepare('SELECT worker,agent,cwd,ownership FROM sessions WHERE id=?').get(nativeId) as { worker: string; agent: string; cwd: string; ownership: string } | undefined ?? null;
  }
  bindSession(nativeId: string, worker: string, agent: string, cwd: string): void {
    const old = this.session(nativeId);
    if (old && (old.worker !== worker || old.agent !== agent || old.cwd !== cwd || old.ownership !== 'bridge')) throw new Error('原生会话归属不符或已经交给用户。');
    this.db.prepare("INSERT INTO sessions VALUES(?,?,?,?,'bridge') ON CONFLICT(id) DO NOTHING").run(nativeId, worker, agent, cwd);
  }
  handoff(nativeId: string): void { this.db.prepare("UPDATE sessions SET ownership='user' WHERE id=?").run(nativeId); }
  process(record: ProcessRecord): void {
    this.db.prepare('INSERT INTO processes VALUES(?,?,?,?) ON CONFLICT(job,pid) DO UPDATE SET identity=excluded.identity,closed=excluded.closed').run(record.dispatchId, record.pid, record.identity, record.closed ? 1 : 0);
  }
  processes(job: string): ProcessRecord[] {
    return (this.db.prepare('SELECT * FROM processes WHERE job=? AND closed=0').all(job) as { job: string; pid: number; identity: string | null; closed: number }[])
      .map(row => ({ dispatchId: row.job, pid: row.pid, identity: row.identity, closed: row.closed === 1 }));
  }
  close(): void { this.db.close(); }
}
