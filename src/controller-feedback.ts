import { harnessText } from './harness.js';
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { BridgeNoticeCode } from './notices.js';

export interface FeedbackScope {
  conversationId: string; userId: string; channelId: string; nativeId: string | null;
  group?: { spaceId: string; generation: number; bindingEpoch: number };
}
export interface BridgeFeedback extends FeedbackScope {
  id: string; sourceId: string; code: BridgeNoticeCode; stage: string; reason: string;
  taskTitle?: string; taskId?: string; workerId?: string; jobId?: string; supplementId?: string;
  resultKnown: boolean; workerResultKnown?: boolean; processStopped: boolean | null;
  deliveryState: 'not-attempted' | 'not-delivered' | 'confirmed' | 'uncertain' | 'unknown';
  createdAt: string;
  userState: 'none' | 'pending' | 'sending' | 'delivered' | 'uncertain';
  controllerState: 'pending' | 'delivered';
  /** User-only notices are excluded even from explicit/includeDelivered controller reads. */
  audience?: 'user-only';
}
export interface FeedbackRead { id?: string; includeDelivered?: boolean; limit?: number }
export interface FeedbackBatch { records: BridgeFeedback[]; remaining: number }
export const FEEDBACK_RULE = harnessText('controller.feedback_rule');

/** 复用本 Bot 的会话数据库；两条接收链路独立记账，不创建模型唤醒事件。 */
export class ControllerFeedbackJournal {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS controller_feedback (
      id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, user_id TEXT NOT NULL,
      channel_id TEXT NOT NULL, native_id TEXT, group_key TEXT NOT NULL,
      payload_json TEXT NOT NULL, controller_state TEXT NOT NULL DEFAULT 'pending',
      user_state TEXT NOT NULL, created_at TEXT NOT NULL
    ); CREATE INDEX IF NOT EXISTS controller_feedback_scope
      ON controller_feedback(conversation_id,user_id,channel_id,controller_state,created_at);`);
  }
  private groupKey(scope: FeedbackScope): string {
    return scope.group ? JSON.stringify([scope.group.spaceId, scope.group.generation, scope.group.bindingEpoch]) : '';
  }
  record(input: Omit<BridgeFeedback, 'id' | 'createdAt' | 'controllerState' | 'userState'>, notifyUser: boolean): BridgeFeedback {
    const id = createHash('sha256').update(JSON.stringify([input.conversationId, input.channelId, input.sourceId])).digest('hex');
    const now = new Date().toISOString();
    const payload = { ...input, id, reason: input.reason.slice(0, 1800), ...(input.taskTitle ? { taskTitle: [...input.taskTitle.replace(/[\p{Cc}\p{Cf}]/gu, ' ')].slice(0, 80).join('') } : {}), createdAt: now };
    this.db.prepare(`INSERT OR IGNORE INTO controller_feedback
      (id,conversation_id,user_id,channel_id,native_id,group_key,payload_json,user_state,created_at) VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(id, input.conversationId, input.userId, input.channelId, input.nativeId, this.groupKey(input), JSON.stringify(payload), notifyUser ? 'pending' : 'none', now);
    return this.row(this.db.prepare('SELECT * FROM controller_feedback WHERE id=?').get(id)!);
  }
  private row(row: Record<string, unknown>): BridgeFeedback {
    return { ...JSON.parse(String(row.payload_json)), controllerState: row.controller_state, userState: row.user_state } as BridgeFeedback;
  }
  read(scope: FeedbackScope, options: FeedbackRead = {}): FeedbackBatch {
    const limit = Math.max(1, Math.min(20, Math.floor(options.limit ?? 8)));
    const filter = `conversation_id=? AND user_id=? AND channel_id=? AND group_key=? AND (native_id IS NULL OR native_id=?)`
      + " AND coalesce(json_extract(payload_json,'$.audience'),'both')!='user-only'"
      + (options.includeDelivered ? '' : " AND controller_state='pending'") + (options.id ? ' AND id=?' : '');
    const values = [scope.conversationId, scope.userId, scope.channelId, this.groupKey(scope), scope.nativeId, ...(options.id ? [options.id] : [])];
    const rows = this.db.prepare(`SELECT * FROM controller_feedback WHERE ${filter} ORDER BY created_at,rowid LIMIT ?`).all(...values, limit);
    const count = Number(this.db.prepare(`SELECT count(*) n FROM controller_feedback WHERE ${filter}`).get(...values)!.n);
    return { records: rows.map(row => this.row(row)), remaining: count - rows.length };
  }
  deliveredToController(scope: FeedbackScope, ids: string[]): void {
    const update = this.db.prepare(`UPDATE controller_feedback SET controller_state='delivered'
      WHERE id=? AND conversation_id=? AND user_id=? AND channel_id=? AND group_key=? AND (native_id IS NULL OR native_id=?)`);
    for (const id of ids) update.run(id, scope.conversationId, scope.userId, scope.channelId, this.groupKey(scope), scope.nativeId);
  }
  recoverNotices(): void { this.db.prepare("UPDATE controller_feedback SET user_state='uncertain' WHERE user_state='sending'").run(); }
  pendingNotices(): BridgeFeedback[] {
    return this.db.prepare("SELECT * FROM controller_feedback WHERE user_state='pending' ORDER BY created_at,rowid LIMIT 100").all().map(row => this.row(row));
  }
  claimNotice(id: string): boolean {
    return Number(this.db.prepare("UPDATE controller_feedback SET user_state='sending' WHERE id=? AND user_state='pending'").run(id).changes) === 1;
  }
  finishNotice(id: string, state: 'delivered' | 'uncertain'): void {
    this.db.prepare("UPDATE controller_feedback SET user_state=? WHERE id=? AND user_state='sending'").run(state, id);
  }
}
