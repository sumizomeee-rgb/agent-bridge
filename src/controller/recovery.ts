import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { TaskOrigin } from '../tasks.js';

export const recoveryDelayMs = 30_000;
export const recoveryLimit = 2;
export interface ControllerRecovery {
  id: string; origin: TaskOrigin; triggerId: string; attempts: number; dueAt: number;
  state: 'pending' | 'queued' | 'running' | 'done' | 'cancelled' | 'exhausted';
  taskId?: string;
}
export function recoveryTaskId(id: string, attempt: number): string {
  const hash = createHash('sha256').update(`controller-recovery:${id}:${attempt}`).digest('hex');
  return `${hash.slice(0,8)}-${hash.slice(8,12)}-${hash.slice(12,16)}-${hash.slice(16,20)}-${hash.slice(20,32)}`;
}
/** One bounded recovery chain per failed turn, stored with the Bot's session data. */
export class ControllerRecoveryJournal {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS controller_recoveries(id TEXT PRIMARY KEY,value_json TEXT NOT NULL)`);
  }
  get(id: string): ControllerRecovery | null {
    const row = this.db.prepare('SELECT value_json FROM controller_recoveries WHERE id=?').get(id);
    return row ? JSON.parse(String(row.value_json)) : null;
  }
  private save(value: ControllerRecovery): void {
    this.db.prepare('INSERT INTO controller_recoveries VALUES(?,?) ON CONFLICT(id) DO UPDATE SET value_json=excluded.value_json').run(value.id, JSON.stringify(value));
  }
  active(): ControllerRecovery[] {
    return this.db.prepare("SELECT value_json FROM controller_recoveries WHERE json_extract(value_json,'$.state') IN ('pending','queued','running')").all()
      .map(row => JSON.parse(String(row.value_json)));
  }
  schedule(origin: TaskOrigin, triggerId: string, now: number): ControllerRecovery {
    const id = createHash('sha256').update(triggerId).digest('hex'), old = this.get(id);
    if (old) return old;
    this.cancelConversation(origin.conversationId);
    const value: ControllerRecovery = { id, origin, triggerId, attempts: 0, dueAt: now + recoveryDelayMs, state: 'pending' };
    this.save(value); return value;
  }
  queue(id: string, now: number): ControllerRecovery | null {
    const value = this.get(id);
    if (!value || value.state !== 'pending' || value.dueAt > now || value.attempts >= recoveryLimit) return null;
    value.attempts++; value.taskId = recoveryTaskId(id, value.attempts); value.state = 'queued'; this.save(value); return value;
  }
  valid(id: string | undefined, taskId: string): ControllerRecovery | null {
    const value = id ? this.get(id) : null;
    return value && ['queued','running'].includes(value.state) && value.taskId === taskId ? value : null;
  }
  start(id: string, taskId: string): boolean {
    const value = this.valid(id, taskId); if (!value || value.state !== 'queued') return false;
    value.state = 'running'; this.save(value); return true;
  }
  finish(id: string, taskId: string, success: boolean, retryable: boolean, now: number): void {
    const value = this.valid(id, taskId); if (!value) return;
    value.state = success ? 'done' : retryable && value.attempts < recoveryLimit ? 'pending' : 'exhausted';
    value.dueAt = now + recoveryDelayMs; this.save(value);
  }
  completeSource(conversationId: string, sourceId: string): void {
    for (const value of this.active()) if (value.origin.conversationId === conversationId && value.origin.originMessageId === sourceId) { value.state = 'done'; this.save(value); }
  }
  cancelConversation(conversationId: string): void {
    for (const value of this.active()) if (value.origin.conversationId === conversationId) { value.state = 'cancelled'; this.save(value); }
  }
  /** Queued work survives restart; an interrupted generation has unknown effects and is not replayed. */
  recover(now: number): void {
    for (const value of this.active()) if (value.state === 'running') this.finish(value.id, value.taskId!, false, false, now);
  }
}

export function retryableControllerFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const flags = error as Error & { deliveryUncertain?: boolean; publicationFailed?: boolean; processStillRunning?: boolean };
  if (error.name === 'AbortError' || flags.deliveryUncertain || flags.publicationFailed || flags.processStillRunning) return false;
  const message = error.message;
  if (/\b(400|401|403|404)\b|鉴权|凭据|权限|credential|unauthorized|invalid.{0,20}(model|schema|argument)/i.test(message)) return false;
  return /error_during_execution|\b(408|429|500|502|503|504)\b|ECONN|ETIMEDOUT|fetch failed|network|socket|timeout|超时|empty.{0,20}(response|content)|没有通过公开通道回复|尚未完成.*回复/i.test(message);
}
