import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { IncomingDM } from './types.js';
import { compareMessageIds } from './routing.js';

export interface HostInput { id: string; botId: string; message: IncomingDM; state: 'received' | 'processing' | 'accepted' | 'failed' | 'uncertain'; control: boolean; generations: Record<string, number> | null; bindingEpoch: number | null }
/** An acknowledged platform input survives async permission probes and batch-reset barriers. */
export class HostInbox {
  private readonly db: DatabaseSync;
  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true }); this.db = new DatabaseSync(join(dataDir, 'host-inbox.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS inputs(id TEXT PRIMARY KEY,bot_id TEXT NOT NULL,value_json TEXT NOT NULL,
        control INTEGER NOT NULL,state TEXT NOT NULL,error TEXT,received_at TEXT NOT NULL,generations_json TEXT,binding_epoch INTEGER);
      CREATE TABLE IF NOT EXISTS cursors(bot_id TEXT NOT NULL,space_id TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(bot_id,space_id));
      UPDATE inputs SET state=CASE WHEN control=1 THEN 'uncertain' ELSE 'received' END WHERE state='processing';`);
  }
  capture(id: string, botId: string, message: IncomingDM, control: boolean, generations: Record<string, number> | null = null, bindingEpoch: number | null = null): boolean {
    // Interaction credentials never enter a journal. Their canonical receipt still deduplicates the operation.
    const value: IncomingDM = { id: message.id, userId: message.userId, channelId: message.channelId, text: message.text,
      attachments: message.attachments.map(a => ({ id: a.id, filename: a.filename, url: a.url, size: a.size,
        ...(a.content_type ? { content_type: a.content_type } : {}), ...(a.resourceKey ? { resourceKey: a.resourceKey } : {}), ...(a.messageId ? { messageId: a.messageId } : {}) })),
      ...(message.space ? { space: { ...message.space, mentionedUserIds: [...message.space.mentionedUserIds] } } : {}) };
    return Number(this.db.prepare("INSERT OR IGNORE INTO inputs(id,bot_id,value_json,control,state,received_at,generations_json,binding_epoch) VALUES(?,?,?,?,'received',?,?,?)")
      .run(id, botId, JSON.stringify(value), control ? 1 : 0, new Date().toISOString(), generations ? JSON.stringify(generations) : null, bindingEpoch).changes) === 1;
  }
  get(id: string): HostInput | null {
    const row = this.db.prepare('SELECT * FROM inputs WHERE id=?').get(id);
    return row ? { id: String(row.id), botId: String(row.bot_id), message: JSON.parse(String(row.value_json)), state: String(row.state) as HostInput['state'], control: !!row.control,
      generations: row.generations_json ? JSON.parse(String(row.generations_json)) : null, bindingEpoch: row.binding_epoch == null ? null : Number(row.binding_epoch) } : null;
  }
  pending(): HostInput[] { return this.db.prepare("SELECT id FROM inputs WHERE state='received' ORDER BY rowid").all().map(r => this.get(String(r.id))!); }
  uncertain(): HostInput[] { return this.db.prepare("SELECT id FROM inputs WHERE state='uncertain' ORDER BY rowid").all().map(r => this.get(String(r.id))!); }
  setState(id: string, state: HostInput['state'], error?: string): void { this.db.prepare('UPDATE inputs SET state=?,error=? WHERE id=?').run(state, error?.slice(0, 1000) ?? null, id); }
  cursor(botId: string, spaceId: string): string | undefined { const row = this.db.prepare('SELECT value FROM cursors WHERE bot_id=? AND space_id=?').get(botId, spaceId); return row ? String(row.value) : undefined; }
  saveCursor(botId: string, spaceId: string, value: string): void {
    const previous = this.cursor(botId, spaceId); if (previous && compareMessageIds(value, previous) < 0) return;
    this.db.prepare('INSERT INTO cursors(bot_id,space_id,value) VALUES(?,?,?) ON CONFLICT(bot_id,space_id) DO UPDATE SET value=excluded.value').run(botId, spaceId, value);
  }
  close(): void { this.db.close(); }
}
