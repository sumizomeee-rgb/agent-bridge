import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { rebindTaskOrigin } from '../tasks.js';
import type { Conversation } from '../types.js';
import type { ControllerJob, ControllerJobStatus, ControllerSchedule, ControllerSupplement, ControllerWorker } from './runtime-types.js';

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
function schedule(row: Row): ControllerSchedule {
  return { ...JSON.parse(String(row.value_json)) as ControllerSchedule, status: String(row.status) as ControllerSchedule['status'],
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
      CREATE TABLE IF NOT EXISTS controller_schedules (
        id TEXT PRIMARY KEY, parent_id TEXT NOT NULL, status TEXT NOT NULL, due_at TEXT NOT NULL, task_id TEXT, value_json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS controller_schedule_due ON controller_schedules(status,due_at);
      CREATE TABLE IF NOT EXISTS controller_supplements (
        id TEXT PRIMARY KEY, worker_id TEXT NOT NULL, job_id TEXT NOT NULL, value_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS controller_paused_parents (id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS controller_parent_rebindings (source_id TEXT PRIMARY KEY, target_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS controller_calls (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, result_json TEXT NOT NULL);`);
    // Convert the former wake-only table once, then retire it. There is no old API or dual write path.
    if (this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='controller_wakes'").get()) {
      this.transaction(() => {
        for (const row of this.db.prepare('SELECT * FROM controller_wakes').all()) {
          const old = JSON.parse(String(row.value_json));
          const value: ControllerSchedule = { ...old, kind: 'controller', title: '主控自唤醒',
            origin: { ...old.origin, purpose: 'schedule', scheduleKind: 'controller' },
            status: (row.status === 'fired' ? 'triggered' : row.status === 'firing' ? 'dispatching' : String(row.status)) as ControllerSchedule['status'],
            taskId: row.task_id ? String(row.task_id) : null, updatedAt: old.createdAt };
          this.addSchedule(value);
        }
        this.db.exec('DROP TABLE controller_wakes');
      });
    }
  }
  close(): void { this.db.close(); }
  pauseConversation(id: string): void { this.db.prepare('INSERT OR IGNORE INTO controller_paused_parents (id) VALUES (?)').run(id); }
  resumeConversation(id: string): void { this.db.prepare('DELETE FROM controller_paused_parents WHERE id=?').run(id); }
  isConversationPaused(id: string): boolean { return this.db.prepare('SELECT 1 FROM controller_paused_parents WHERE id=?').get(id) !== undefined; }
  /** One local transaction, replayable independently of TaskRegistry's journal. */
  rebindConversation(source: Conversation, target: Conversation): void {
    const identity = JSON.stringify({ id: target.id, userId: target.userId, agent: target.agent, nativeId: target.nativeId, cwd: target.cwd });
    const previous = this.db.prepare('SELECT target_json FROM controller_parent_rebindings WHERE source_id=?').get(source.id);
    if (previous && previous.target_json !== identity) throw new Error('执行服务父会话已重绑到其他目标。');
    rebindTaskOrigin({ conversationId: source.id, userId: source.userId, agent: source.agent, nativeId: source.nativeId, cwd: source.cwd, channelId: 'validation', originMessageId: 'validation' }, source, target);
    this.transaction(() => {
      for (const worker of this.workers()) if (worker.origin.conversationId === source.id) {
        worker.origin = rebindTaskOrigin(worker.origin, source, target);
        this.db.prepare('UPDATE controller_workers SET parent_id=?,value_json=? WHERE id=?').run(target.id, JSON.stringify(worker), worker.id);
      }
      for (const value of this.jobs()) if (value.origin.conversationId === source.id) {
        value.origin = rebindTaskOrigin(value.origin, source, target);
        this.db.prepare('UPDATE controller_jobs SET value_json=? WHERE id=?').run(JSON.stringify(value), value.id);
      }
      for (const value of this.supplements()) if (value.origin.conversationId === source.id) {
        value.origin = rebindTaskOrigin(value.origin, source, target); this.saveSupplement(value);
      }
      for (const value of this.schedules()) if (value.origin.conversationId === source.id) {
        value.origin = rebindTaskOrigin(value.origin, source, target);
        if (value.worker) value.worker.origin = rebindTaskOrigin(value.worker.origin, source, target);
        if (value.job) value.job.origin = rebindTaskOrigin(value.job.origin, source, target);
        this.db.prepare('UPDATE controller_schedules SET parent_id=?,value_json=? WHERE id=?').run(target.id, JSON.stringify(value), value.id);
      }
      this.db.prepare('INSERT OR IGNORE INTO controller_parent_rebindings (source_id,target_json) VALUES (?,?)').run(source.id, identity);
    });
  }
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
  /** 宿主只读核对：持久回执与 worker/job 在同一事务提交，缺失不能假称已派发。 */
  readCallReceipt(id: string): unknown | undefined {
    const row = this.db.prepare('SELECT result_json FROM controller_calls WHERE id=?').get(id);
    return row ? JSON.parse(String(row.result_json)) : undefined;
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
  removeUnclaimedWorker(id: string): void {
    const value = this.getWorker(id);
    if (!value || value.adoption?.status !== 'pending' || this.jobs(id).length) throw new Error('不能移除已有任务或已接管的会话登记');
    this.db.prepare('DELETE FROM controller_workers WHERE id=?').run(id);
  }
  saveWorker(value: ControllerWorker): void {
    this.db.prepare('UPDATE controller_workers SET value_json=? WHERE id=?').run(JSON.stringify(value), value.id);
  }
  /** Only an explicit cancellation may call this; no report, reconciliation lock or job status is discarded. */
  archiveStoppedWorker(id: string, reason: string): ControllerWorker | null {
    if (!reason.trim()) throw new Error('归档原因不能为空');
    return this.transaction(() => {
      const value = this.getWorker(id), jobs = this.jobs(id);
      const uncertain = jobs.filter(job => job.status === 'uncertain');
      if (!value?.blocked || value.ownership === 'user' || value.supersededBy || value.handoffPending || value.adoption?.status === 'pending'
        || jobs.some(job => job.status === 'queued' || job.status === 'running') || !uncertain.length
        || uncertain.some(job => job.processStopped !== true)) return null;
      if (value.archivedAt) return value;
      value.archivedAt = new Date().toISOString(); value.archiveReason = reason.trim(); value.updatedAt = value.archivedAt;
      this.saveWorker(value); return value;
    });
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
  setJob(id: string, status: ControllerJobStatus, update: { taskId?: string; result?: string; cancelReason?: string; wakeAllowed?: boolean; startedAt?: string; nativeResult?: ControllerJob['nativeResult']; processStopped?: boolean } = {}): void {
    const current = this.getJob(id); if (!current) throw new Error('子任务不存在');
    const value = { ...current, status, taskId: update.taskId ?? current.taskId, result: update.result ?? current.result,
      cancelReason: update.cancelReason ?? current.cancelReason, wakeAllowed: update.wakeAllowed ?? current.wakeAllowed,
      ...(update.nativeResult ? { nativeResult: update.nativeResult } : {}),
      ...(update.processStopped !== undefined ? { processStopped: update.processStopped } : {}),
      ...(status === 'running' && current.status === 'queued' && !current.startedAt ? { startedAt: update.startedAt ?? new Date().toISOString() } : {}),
      updatedAt: new Date().toISOString() };
    this.db.prepare('UPDATE controller_jobs SET status=?,task_id=?,result=?,cancel_reason=?,value_json=? WHERE id=?')
      .run(value.status, value.taskId, value.result, value.cancelReason, JSON.stringify(value), id);
  }
  saveJobProgress(id: string, progress: ControllerJob['progress']): void {
    const current = this.getJob(id); if (!current || current.status !== 'running') return;
    this.db.prepare('UPDATE controller_jobs SET value_json=? WHERE id=?').run(JSON.stringify({ ...current, progress }), id);
  }
  markToolStall(id: string, toolKey: string): boolean {
    const current = this.getJob(id);
    if (!current || current.status !== 'running' || current.cancelReason || current.wakeAllowed === false || current.stallNotices?.includes(toolKey)) return false;
    this.db.prepare('UPDATE controller_jobs SET value_json=? WHERE id=?')
      .run(JSON.stringify({ ...current, stallNotices: [...(current.stallNotices ?? []), toolKey] }), id);
    return true;
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
  addSchedule(value: ControllerSchedule): void {
    this.db.prepare('INSERT INTO controller_schedules (id,parent_id,status,due_at,task_id,value_json) VALUES (?,?,?,?,?,?)')
      .run(value.id, value.origin.conversationId, value.status, value.dueAt, value.taskId, JSON.stringify(value));
  }
  getSchedule(id: string): ControllerSchedule | null {
    const row = this.db.prepare('SELECT * FROM controller_schedules WHERE id=?').get(id); return row ? schedule(row) : null;
  }
  schedules(): ControllerSchedule[] {
    return this.db.prepare('SELECT * FROM controller_schedules ORDER BY due_at,rowid').all().map(schedule);
  }
  saveSchedule(value: ControllerSchedule): void {
    this.db.prepare('UPDATE controller_schedules SET status=?,due_at=?,task_id=?,value_json=? WHERE id=?')
      .run(value.status, value.dueAt, value.taskId, JSON.stringify(value), value.id);
  }
}
