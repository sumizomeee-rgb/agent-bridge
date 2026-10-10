import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

export type RestartPhase = 'draining' | 'stopping' | 'starting' | 'recovering' | 'ready' | 'failed' | 'cancelled';
export interface RestartOrigin { conversationId: string; userId: string; channelId: string; originMessageId: string; nativeId: string | null }
export interface RestartState { requestId: string; phase: RestartPhase; requestedAt: string; updatedAt: string; attempts: number; error: string | null }
export interface RestartReceipt { accepted: boolean; status: RestartPhase | 'supervisor_required'; requestId?: string; duplicate?: boolean }
const pending = new Set<RestartPhase>(['draining', 'stopping', 'starting', 'recovering']);

/** Separate durable control journal; it never mutates a conversation or creates a human message. */
export class RestartJournal {
  private readonly db: DatabaseSync;
  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(join(dataDir, 'restart.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS restart_state (singleton INTEGER PRIMARY KEY CHECK(singleton=1), request_id TEXT NOT NULL,
        phase TEXT NOT NULL, requested_at TEXT NOT NULL, updated_at TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, error TEXT);
      CREATE TABLE IF NOT EXISTS restart_requests (request_key TEXT PRIMARY KEY, request_id TEXT NOT NULL, phase TEXT NOT NULL, origin TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS restart_history (sequence INTEGER PRIMARY KEY AUTOINCREMENT, request_id TEXT NOT NULL,
        phase TEXT NOT NULL, at TEXT NOT NULL, error TEXT);
      CREATE TABLE IF NOT EXISTS supervisor_exits (sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        at TEXT NOT NULL, exit_code INTEGER NOT NULL, request_id TEXT);`);
  }
  current(): RestartState | null {
    const row = this.db.prepare('SELECT * FROM restart_state WHERE singleton=1').get();
    return row ? { requestId: String(row.request_id), phase: String(row.phase) as RestartPhase, requestedAt: String(row.requested_at),
      updatedAt: String(row.updated_at), attempts: Number(row.attempts), error: row.error == null ? null : String(row.error) } : null;
  }
  request(origin: RestartOrigin): RestartReceipt {
    for (const value of [origin.conversationId, origin.userId, origin.channelId, origin.originMessageId]) {
      if (typeof value !== 'string' || !value || value.length > 512 || /[\r\n\0]/.test(value)) throw new Error('重启请求来源无效');
    }
    if (origin.nativeId !== null && (typeof origin.nativeId !== 'string' || !origin.nativeId || origin.nativeId.length > 512)) throw new Error('重启父会话无效');
    const key = createHash('sha256').update(JSON.stringify([origin.conversationId, origin.userId, origin.channelId, origin.originMessageId])).digest('hex');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const prior = this.db.prepare('SELECT request_id,phase FROM restart_requests WHERE request_key=?').get(key);
      if (prior) { this.db.exec('COMMIT'); return { accepted: true, status: String(prior.phase) as RestartPhase, requestId: String(prior.request_id), duplicate: true }; }
      const active = this.current(); const reuse = active && pending.has(active.phase);
      const requestId = reuse ? active.requestId : randomUUID(); const phase = reuse ? active.phase : 'draining';
      this.db.prepare('INSERT INTO restart_requests(request_key,request_id,phase,origin) VALUES(?,?,?,?)')
        .run(key, requestId, phase, JSON.stringify(origin));
      if (!reuse) {
        const now = new Date().toISOString();
        this.db.prepare(`INSERT INTO restart_state(singleton,request_id,phase,requested_at,updated_at,attempts,error) VALUES(1,?,?,?,?,0,NULL)
          ON CONFLICT(singleton) DO UPDATE SET request_id=excluded.request_id,phase=excluded.phase,requested_at=excluded.requested_at,
          updated_at=excluded.updated_at,attempts=0,error=NULL`).run(requestId, phase, now, now);
        this.db.prepare('INSERT INTO restart_history(request_id,phase,at,error) VALUES(?,?,?,NULL)').run(requestId, phase, now);
      }
      this.db.exec('COMMIT'); return { accepted: true, status: phase, requestId, duplicate: !!reuse };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  mark(phase: RestartPhase, error: string | null = null): void {
    const state = this.current(); if (!state) return;
    const now = new Date().toISOString(); const detail = error?.slice(0, 2000) ?? null;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('UPDATE restart_state SET phase=?,updated_at=?,error=? WHERE singleton=1').run(phase, now, detail);
      this.db.prepare('UPDATE restart_requests SET phase=? WHERE request_id=?').run(phase, state.requestId);
      this.db.prepare('INSERT INTO restart_history(request_id,phase,at,error) VALUES(?,?,?,?)').run(state.requestId, phase, now, detail);
      this.db.exec('COMMIT');
    } catch (failure) { this.db.exec('ROLLBACK'); throw failure; }
  }
  beginRecovery(): boolean {
    const state = this.current(); if (!state || (!pending.has(state.phase) && state.phase !== 'failed')) return false;
    this.mark('recovering'); this.db.prepare('UPDATE restart_state SET attempts=attempts+1 WHERE singleton=1').run(); return true;
  }
  supervisorExited(code: number): void {
    const state = this.current();
    this.db.prepare('INSERT INTO supervisor_exits(at,exit_code,request_id) VALUES(?,?,?)')
      .run(new Date().toISOString(), code, state?.requestId ?? null);
    if (!state || !pending.has(state.phase)) return;
    if (code === 75 && state.phase === 'stopping') this.mark('starting');
    else this.mark('failed', `桥进程退出（${code}），尚未完成重启恢复。`);
  }
  close(): void { this.db.close(); }
}

export interface RestartServiceOptions {
  supervised: boolean;
  beginDrain: () => void;
  isIdle: () => boolean;
  shutdown: () => Promise<void>;
  onShutdownComplete?: (exitCode: 75 | 76) => void;
  presence: (phase: 'draining' | 'recovering' | 'idle' | 'failed') => void;
  pollMs?: number;
  onError?: (error: unknown) => void;
}

/** Requests return immediately; only the independent supervisor starts the next process. */
export class RestartService {
  readonly journal: RestartJournal;
  private timer?: NodeJS.Timeout;
  private draining = false;
  private stopping = false;
  private closed = false;
  private accepting = true;
  constructor(dataDir: string, private readonly options: RestartServiceOptions) { this.journal = new RestartJournal(dataDir); }
  isDraining(): boolean { return this.draining; }
  beginRecovery(): void { if (!this.closed && this.journal.beginRecovery()) this.options.presence('recovering'); }
  ready(): void {
    if (this.closed) return;
    if (this.journal.current()?.phase === 'recovering') this.journal.mark('ready');
    this.options.presence('idle');
  }
  failed(error: string): void { if (this.closed) return; if (this.journal.current() && this.journal.current()!.phase !== 'ready') this.journal.mark('failed', error); this.options.presence('failed'); }
  async request(origin: RestartOrigin): Promise<RestartReceipt> {
    if (this.closed || !this.accepting) return { accepted: false, status: 'cancelled' };
    if (!this.options.supervised) return { accepted: false, status: 'supervisor_required' };
    const result = this.journal.request(origin);
    if (result.status === 'draining' && !this.draining) {
      this.draining = true; this.options.beginDrain(); this.options.presence('draining');
      this.timer = setInterval(() => { void this.check().catch(error => this.options.onError?.(error)); }, this.options.pollMs ?? 500);
    }
    return result;
  }
  async check(): Promise<void> {
    if (this.closed || !this.draining || this.stopping || !this.options.isIdle()) return;
    this.stopping = true; clearInterval(this.timer); this.journal.mark('stopping');
    try { await this.options.shutdown(); }
    catch (error) {
      // Persist the failure before main closes this journal; 76 tells the
      // independent supervisor that another process must not be started.
      try { if (!this.closed) this.failed(String(error)); }
      finally { this.options.onShutdownComplete?.(76); }
      this.options.onError?.(error);
      return;
    }
    this.options.onShutdownComplete?.(75);
  }
  cancel(): void {
    if (this.closed) return;
    this.accepting = false; this.draining = false; clearInterval(this.timer);
    const state = this.journal.current(); if (state && pending.has(state.phase)) this.journal.mark('cancelled');
  }
  close(): void { if (this.closed) return; this.closed = true; clearInterval(this.timer); this.journal.close(); }
}

// The supervisor records exit failures without authenticating to Discord or sending messages.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv[2] === '--supervisor-exit') {
  const dataDir = process.argv[3]; const code = Number(process.argv[4]);
  if (!dataDir || !Number.isInteger(code)) throw new Error('Supervisor exit arguments are invalid');
  const journal = new RestartJournal(dataDir); try { journal.supervisorExited(code); } finally { journal.close(); }
}
