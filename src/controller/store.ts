import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ControllerJob, ControllerJobStatus, ControllerSupplement, ControllerWake, ControllerWorker } from './runtime-types.js';

type Row = Record<string, string | number | bigint | Uint8Array | null>;
function worker(row: Row): ControllerWorker {
  const value = JSON.parse(String(row.value_json)) as ControllerWorker;
  return { ...value, ownership: value.ownership ?? 'bridge' };
}
function job(row: Row): ControllerJob {
  const value = JSON.parse(String(row.value_json)) as ControllerJob;
  return { ...value, status: String(row.status) as ControllerJobStatus, taskId: row.task_id ? String(row.task_id) : null,
    result: row.result == null ? null : String(row.result), cancelReason: row.cancel_reason == null ? null : String(row.cancel_reason) };
}
function wake(row: Row): ControllerWake {
  return { ...JSON.parse(String(row.value_json)) as ControllerWake, status: String(row.status) as ControllerWake['status'],
    taskId: row.task_id ? String(row.task_id) : null };
}

/** Separate durable execution queue; no Discord credentials or image bytes are stored here. */
export class ControllerStore {
  readonly path: string;
  private readonly db: DatabaseSync;
  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.path = join(dataDir, 'controller.sqlite');
    this.db = new DatabaseSync(this.path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS controller_workers (id TEXT PRIMARY KEY, parent_id TEXT NOT NULL, value_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS controller_jobs (
        id TEXT PRIMARY KEY, worker_id TEXT NOT NULL, status TEXT NOT NULL, task_id TEXT, result TEXT,
        cancel_reason TEXT, value_json TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS controller_job_queue ON controller_jobs(worker_id,status,created_at);
      CREATE TABLE IF NOT EXISTS controller_wakes (
        id TEXT PRIMARY KEY, parent_id TEXT NOT NULL, status TEXT NOT NULL, due_at TEXT NOT NULL, task_id TEXT, value_json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS controller_wake_due ON controller_wakes(status,due_at);
      CREATE TABLE IF NOT EXISTS controller_supplements (
        id TEXT PRIMARY KEY, worker_id TEXT NOT NULL, job_id TEXT NOT NULL, value_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS controller_calls (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, result_json TEXT NOT NULL);`);
  }
  close(): void { this.db.close(); }
  transaction<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = operation(); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  getCall(id: string, fingerprint: string): unknown | undefined {
    const row = this.db.prepare('SELECT * FROM controller_calls WHERE id=?').get(id);
    if (!row) return undefined;
    if (String(row.fingerprint) !== fingerprint) throw new Error('重复工具调用的参数发生变化，拒绝再次派发');
    return JSON.parse(String(row.result_json));
  }
  getWorkspaceInitialization(conversationId: string): unknown | undefined {
    return this.getCall(`workspace-context:${conversationId}`, 'workspace-context-once');
  }
  saveWorkspaceInitialization(conversationId: string, result: unknown): void {
    this.saveCall(`workspace-context:${conversationId}`, 'workspace-context-once', result);
  }
  saveCall(id: string, fingerprint: string, result: unknown): void {
    this.db.prepare('INSERT INTO controller_calls (id,fingerprint,result_json) VALUES (?,?,?)').run(id, fingerprint, JSON.stringify(result));
  }
  updateCall(id: string, result: unknown): void {
    this.db.prepare('UPDATE controller_calls SET result_json=? WHERE id=?').run(JSON.stringify(result), id);
  }
  addWorker(value: ControllerWorker): void {
    this.db.prepare('INSERT INTO controller_workers (id,parent_id,value_json) VALUES (?,?,?)')
      .run(value.id, value.origin.conversationId, JSON.stringify(value));
  }
  saveWorker(value: ControllerWorker): void {
    this.db.prepare('UPDATE controller_workers SET value_json=? WHERE id=?').run(JSON.stringify(value), value.id);
  }
  getWorker(id: string): ControllerWorker | null {
    const row = this.db.prepare('SELECT * FROM controller_workers WHERE id=?').get(id); return row ? worker(row) : null;
  }
  workers(parentId?: string): ControllerWorker[] {
    const rows = parentId ? this.db.prepare('SELECT * FROM controller_workers WHERE parent_id=? ORDER BY rowid').all(parentId)
      : this.db.prepare('SELECT * FROM controller_workers ORDER BY rowid').all();
    return rows.map(worker);
  }
  addJob(value: ControllerJob): void {
    this.db.prepare('INSERT INTO controller_jobs (id,worker_id,status,task_id,result,cancel_reason,value_json,created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(value.id, value.workerId, value.status, value.taskId, value.result, value.cancelReason, JSON.stringify(value), value.createdAt);
  }
  getJob(id: string): ControllerJob | null {
    const row = this.db.prepare('SELECT * FROM controller_jobs WHERE id=?').get(id); return row ? job(row) : null;
  }
  jobs(workerId?: string): ControllerJob[] {
    const rows = workerId ? this.db.prepare('SELECT * FROM controller_jobs WHERE worker_id=? ORDER BY created_at,rowid').all(workerId)
      : this.db.prepare('SELECT * FROM controller_jobs ORDER BY created_at,rowid').all();
    return rows.map(job);
  }
  nextJob(workerId: string): ControllerJob | null {
    const row = this.db.prepare("SELECT * FROM controller_jobs WHERE worker_id=? AND status='queued' ORDER BY created_at,rowid LIMIT 1").get(workerId);
    return row ? job(row) : null;
  }
  setJob(id: string, status: ControllerJobStatus, update: { taskId?: string; result?: string; cancelReason?: string; wakeAllowed?: boolean } = {}): void {
    const current = this.getJob(id); if (!current) throw new Error('子任务不存在');
    const value = { ...current, status, taskId: update.taskId ?? current.taskId, result: update.result ?? current.result,
      cancelReason: update.cancelReason ?? current.cancelReason, wakeAllowed: update.wakeAllowed ?? current.wakeAllowed,
      updatedAt: new Date().toISOString() };
    this.db.prepare('UPDATE controller_jobs SET status=?,task_id=?,result=?,cancel_reason=?,value_json=? WHERE id=?')
      .run(value.status, value.taskId, value.result, value.cancelReason, JSON.stringify(value), id);
  }
  saveSupplement(value: ControllerSupplement): void {
    this.db.prepare('INSERT INTO controller_supplements (id,worker_id,job_id,value_json) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET value_json=excluded.value_json')
      .run(value.id, value.workerId, value.jobId, JSON.stringify(value));
  }
  supplements(jobId?: string): ControllerSupplement[] {
    const rows = jobId ? this.db.prepare('SELECT value_json FROM controller_supplements WHERE job_id=? ORDER BY rowid').all(jobId)
      : this.db.prepare('SELECT value_json FROM controller_supplements ORDER BY rowid').all();
    return rows.map(row => JSON.parse(String(row.value_json)) as ControllerSupplement);
  }
  addWake(value: ControllerWake): void {
    this.db.prepare('INSERT INTO controller_wakes (id,parent_id,status,due_at,task_id,value_json) VALUES (?,?,?,?,?,?)')
      .run(value.id, value.origin.conversationId, value.status, value.dueAt, value.taskId, JSON.stringify(value));
  }
  getWake(id: string): ControllerWake | null {
    const row = this.db.prepare('SELECT * FROM controller_wakes WHERE id=?').get(id); return row ? wake(row) : null;
  }
  wakes(parentId?: string): ControllerWake[] {
    const rows = parentId ? this.db.prepare('SELECT * FROM controller_wakes WHERE parent_id=? ORDER BY due_at,rowid').all(parentId)
      : this.db.prepare('SELECT * FROM controller_wakes ORDER BY due_at,rowid').all();
    return rows.map(wake);
  }
  setWake(id: string, status: ControllerWake['status'], taskId?: string): void {
    this.db.prepare('UPDATE controller_wakes SET status=?,task_id=COALESCE(?,task_id) WHERE id=?').run(status, taskId ?? null, id);
  }
}
