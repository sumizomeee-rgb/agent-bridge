import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { AgentName, BridgeMessage, Conversation } from './types.js';

export type InboxState = 'command' | 'queued' | 'running' | 'completed' | 'cancelled' | 'interrupted' | 'failed';
export interface InboxItem extends BridgeMessage {
  conversationId: string | null;
  state: InboxState;
}

type Row = Record<string, string | number | bigint | Uint8Array | null>;
function conversation(row: Row): Conversation {
  return {
    id: String(row.id), userId: String(row.user_id), agent: String(row.agent) as AgentName,
    nativeId: row.native_id === null ? null : String(row.native_id), title: String(row.title),
    cwd: String(row.cwd), createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  };
}
function inbox(row: Row): InboxItem {
  return {
    id: String(row.id), userId: String(row.user_id), channelId: String(row.channel_id),
    text: String(row.text), imagePaths: JSON.parse(String(row.images_json)) as string[],
    conversationId: row.conversation_id === null ? null : String(row.conversation_id),
    state: String(row.state) as InboxState,
  };
}

export class SessionStore {
  readonly path: string;
  private readonly db: DatabaseSync;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.path = join(dataDir, 'bridge.sqlite');
    this.db = new DatabaseSync(this.path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL, agent TEXT NOT NULL,
        native_id TEXT, title TEXT NOT NULL, cwd TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS active_conversations (
        user_id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id)
      );
      CREATE TABLE IF NOT EXISTS inbox (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE, user_id TEXT NOT NULL, channel_id TEXT NOT NULL,
        text TEXT NOT NULL, images_json TEXT NOT NULL,
        conversation_id TEXT REFERENCES conversations(id), state TEXT NOT NULL,
        error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS inbox_queue ON inbox(conversation_id, state, sequence);
      CREATE INDEX IF NOT EXISTS conversations_user ON conversations(user_id, updated_at);
    `);
  }

  hasMessage(id: string): boolean {
    return this.db.prepare('SELECT 1 FROM inbox WHERE id = ?').get(id) !== undefined;
  }

  addMessage(message: BridgeMessage, conversationId: string | null, state: InboxState): boolean {
    const now = new Date().toISOString();
    const result = this.db.prepare(`INSERT OR IGNORE INTO inbox
      (id, user_id, channel_id, text, images_json, conversation_id, state, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      message.id, message.userId, message.channelId, message.text,
      JSON.stringify(message.imagePaths), conversationId, state, now, now,
    );
    return Number(result.changes) === 1;
  }

  createConversation(userId: string, agent: AgentName, cwd: string): Conversation {
    const now = new Date().toISOString();
    const item: Conversation = {
      id: randomUUID(), userId, agent, nativeId: null,
      title: '新会话', cwd, createdAt: now, updatedAt: now,
    };
    this.db.prepare(`INSERT INTO conversations
      (id, user_id, agent, native_id, title, cwd, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      item.id, userId, agent, null, item.title, cwd, now, now,
    );
    return item;
  }

  getConversation(id: string): Conversation | null {
    const row = this.db.prepare('SELECT * FROM conversations WHERE id = ?').get(id);
    return row ? conversation(row) : null;
  }

  listConversations(userId: string, limit = 20): Conversation[] {
    return this.db.prepare(`SELECT * FROM conversations WHERE user_id = ?
      ORDER BY updated_at DESC, rowid DESC LIMIT ?`).all(userId, limit).map(conversation);
  }

  findConversations(userId: string, id: string): Conversation[] {
    if (!/^[a-f0-9-]+$/i.test(id)) return [];
    return this.db.prepare(`SELECT * FROM conversations WHERE user_id = ?
      AND (id = ? OR id LIKE ?) ORDER BY created_at`).all(userId, id, `${id}%`).map(conversation);
  }

  getActive(userId: string): Conversation | null {
    const row = this.db.prepare(`SELECT c.* FROM conversations c
      JOIN active_conversations a ON a.conversation_id = c.id WHERE a.user_id = ?`).get(userId);
    return row ? conversation(row) : null;
  }

  setActive(userId: string, conversationId: string): void {
    const target = this.getConversation(conversationId);
    if (!target || target.userId !== userId) throw new Error('会话不属于当前用户');
    this.db.prepare(`INSERT INTO active_conversations (user_id, conversation_id) VALUES (?, ?)
      ON CONFLICT(user_id) DO UPDATE SET conversation_id = excluded.conversation_id`).run(userId, conversationId);
  }

  saveNativeId(id: string, nativeId: string): void {
    this.db.prepare('UPDATE conversations SET native_id = ?, updated_at = ? WHERE id = ?')
      .run(nativeId, new Date().toISOString(), id);
  }

  nameConversation(id: string, text: string): void {
    const title = text.trim().replace(/\s+/g, ' ').slice(0, 70) || '图片会话';
    this.db.prepare(`UPDATE conversations SET title = ?, updated_at = ?
      WHERE id = ? AND title = '新会话'`).run(title, new Date().toISOString(), id);
  }

  nextQueued(conversationId: string): InboxItem | null {
    const row = this.db.prepare(`SELECT * FROM inbox WHERE conversation_id = ?
      AND state = 'queued' ORDER BY sequence LIMIT 1`).get(conversationId);
    return row ? inbox(row) : null;
  }

  getMessage(id: string): InboxItem | null {
    const row = this.db.prepare('SELECT * FROM inbox WHERE id = ?').get(id);
    return row ? inbox(row) : null;
  }

  setState(id: string, state: InboxState, error: string | null = null): void {
    this.db.prepare('UPDATE inbox SET state = ?, error = ?, updated_at = ? WHERE id = ?')
      .run(state, error, new Date().toISOString(), id);
  }

  cancelPending(conversationId: string): number {
    return Number(this.db.prepare(`UPDATE inbox SET state = 'cancelled', updated_at = ?
      WHERE conversation_id = ? AND state IN ('queued', 'running')`)
      .run(new Date().toISOString(), conversationId).changes);
  }

  pendingCount(conversationId: string): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS total FROM inbox
      WHERE conversation_id = ? AND state = 'queued'`).get(conversationId);
    return Number(row?.total ?? 0);
  }

  interruptRunning(): InboxItem[] {
    const items = this.db.prepare("SELECT * FROM inbox WHERE state = 'running' ORDER BY sequence").all().map(inbox);
    this.db.prepare("UPDATE inbox SET state = 'interrupted', updated_at = ? WHERE state = 'running'")
      .run(new Date().toISOString());
    return items;
  }

  queuedConversations(): string[] {
    return this.db.prepare("SELECT DISTINCT conversation_id FROM inbox WHERE state = 'queued'")
      .all().map(row => String(row.conversation_id));
  }

  close(): void { this.db.close(); }
}
