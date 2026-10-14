import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import type { BridgeConfig } from './types.js';

export type BridgeLifecyclePhase = 'draining' | 'recovering' | 'ready' | 'failed';
/** 平台共用生命周期文案；适配器只决定状态栏或卡片展示。 */
export const BRIDGE_LIFECYCLE_COPY = { ready: '已就绪', restart: '已重启', draining: '准备重启', recovering: '恢复中', failed: '重启失败', continuation: '可以继续。' } as const;
export interface BridgeLifecycleEvent {
  phase: BridgeLifecyclePhase;
  reason?: 'start' | 'restart';
  readyAt?: string;
  recipient?: { userId: string; channelId: string };
}
/** 就绪由主进程发布一次；连接重连不发布。尝试前落盘，失败不自动重发。 */
export class BridgeLifecycle {
  private readonly db: DatabaseSync;
  private readonly eventId = randomUUID();
  private published = false;
  private job?: Promise<void>;
  private closed = false;
  constructor(private readonly config: BridgeConfig, private readonly emit: (event: BridgeLifecycleEvent) => Promise<void>,
    private readonly lastContact: () => BridgeLifecycleEvent['recipient'], private readonly onError: (error: unknown) => void) {
    this.db = new DatabaseSync(join(config.dataDir, 'lifecycle.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS lifecycle_events(event_id TEXT PRIMARY KEY, scope TEXT NOT NULL, ready_at TEXT NOT NULL,
        reason TEXT NOT NULL, user_id TEXT, channel_id TEXT, delivery TEXT NOT NULL);`);
  }
  ready(): Promise<void> {
    if (this.closed) return Promise.resolve();
    return this.job ??= this.publishReady();
  }
  private async publishReady(): Promise<void> {
    if (this.published) return; this.published = true;
    const scope = this.config.scopePrefix!;
    const reason = this.db.prepare('SELECT 1 FROM lifecycle_events WHERE scope=? LIMIT 1').get(scope) ? 'restart' : 'start';
    const contact = this.lastContact();
    const recipient = contact && this.config.allowedUserIds.includes(contact.userId) && contact.channelId.startsWith(scope) ? contact : undefined;
    const readyAt = new Date().toISOString();
    this.db.prepare('INSERT INTO lifecycle_events VALUES(?,?,?,?,?,?,?)').run(this.eventId, scope, readyAt, reason,
      recipient?.userId ?? null, recipient?.channelId ?? null, 'attempted');
    try {
      await this.emit({ phase: 'ready', reason, readyAt, recipient });
      this.db.prepare('UPDATE lifecycle_events SET delivery=? WHERE event_id=?').run('delivered', this.eventId);
    } catch (error) {
      this.db.prepare('UPDATE lifecycle_events SET delivery=? WHERE event_id=?').run('uncertain', this.eventId); this.onError(error);
    }
  }
  async close(): Promise<void> {
    if (this.closed) return; this.closed = true;
    await this.job; this.db.close();
  }
}
