import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const FEISHU_RETRY_WINDOW_MS = 55 * 60 * 1000;
export interface FeishuOutboxPart { batch: string; index: number; uuid: string; payload: string; firstAttemptAt: number | null; attempts: number }
/** One frozen publication, with one UUID/receipt for every actual platform message. */
export class FeishuOutbox {
  private readonly db: DatabaseSync;
  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true }); this.db = new DatabaseSync(join(dataDir, 'feishu-outbox.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS batches(id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, fingerprint TEXT NOT NULL, state TEXT NOT NULL, created_at INTEGER NOT NULL, error TEXT);
      CREATE TABLE IF NOT EXISTS parts(batch_id TEXT NOT NULL, part_index INTEGER NOT NULL, uuid TEXT NOT NULL UNIQUE, payload TEXT NOT NULL,
        first_attempt_at INTEGER, attempts INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL, message_id TEXT, error TEXT, PRIMARY KEY(batch_id,part_index));`);
  }
  begin(channel: string, key: string, fingerprint: string): { id: string; delivered: boolean } {
    const id = createHash('sha256').update(JSON.stringify([channel, key])).digest('hex');
    const previous = this.db.prepare('SELECT fingerprint,state FROM batches WHERE id=?').get(id);
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new Error('飞书投递标识对应的内容已变化。');
      if (previous.state === 'delivered') return { id, delivered: true };
      throw new Error('飞书旧投递尚未确认，未自动重发。');
    }
    this.db.prepare('INSERT INTO batches(id,channel_id,fingerprint,state,created_at) VALUES(?,?,?,?,?)').run(id, channel, fingerprint, 'sending', Date.now());
    return { id, delivered: false };
  }
  register(batch: string, index: number, body: Record<string, unknown>): FeishuOutboxPart {
    const uuid = randomUUID(), payload = JSON.stringify({ ...body, uuid });
    this.db.prepare('INSERT INTO parts(batch_id,part_index,uuid,payload,state) VALUES(?,?,?,?,?)').run(batch, index, uuid, payload, 'pending');
    return { batch, index, uuid, payload, firstAttemptAt: null, attempts: 0 };
  }
  claim(part: FeishuOutboxPart, now = Date.now()): boolean {
    if (part.attempts >= 2 || (part.firstAttemptAt !== null && (now < part.firstAttemptAt || now - part.firstAttemptAt >= FEISHU_RETRY_WINDOW_MS))) return false;
    const first = part.firstAttemptAt ?? now;
    const updated = this.db.prepare("UPDATE parts SET first_attempt_at=?,attempts=attempts+1,state='sending' WHERE batch_id=? AND part_index=? AND attempts=? AND state IN ('pending','sending')")
      .run(first, part.batch, part.index, part.attempts);
    if (!updated.changes) return false;
    part.firstAttemptAt = first; part.attempts++; return true;
  }
  ack(part: FeishuOutboxPart, messageId?: string): void {
    this.db.prepare("UPDATE parts SET state='delivered',message_id=? WHERE batch_id=? AND part_index=?").run(messageId ?? null, part.batch, part.index);
  }
  fail(batch: string, evidence: string, part?: FeishuOutboxPart): void {
    if (part) this.db.prepare("UPDATE parts SET state='uncertain',error=? WHERE batch_id=? AND part_index=?").run(evidence, batch, part.index);
    this.db.prepare("UPDATE batches SET state='uncertain',error=? WHERE id=?").run(evidence, batch);
  }
  complete(batch: string): void { this.db.prepare("UPDATE batches SET state='delivered' WHERE id=?").run(batch); }
  close(): void { this.db.close(); }
}
