import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { AgentName, BridgeMessage, Conversation } from './types.js';

export type InboxState = 'command' | 'queued' | 'steering' | 'uncertain' | 'running' | 'completed' | 'cancelled' | 'interrupted' | 'failed';
export interface InboxItem extends BridgeMessage {
  conversationId: string | null;
  state: InboxState;
  replyState: 'pending' | 'delivered' | 'failed' | 'cancelled' | null;
}
export interface DeliveredReply {
  conversationId: string;
  agent: AgentName;
  nativeId: string;
}

type Row = Record<string, string | number | bigint | Uint8Array | null>;
function conversation(row: Row): Conversation {
  return {
    id: String(row.id), userId: String(row.user_id), agent: String(row.agent) as AgentName,
    nativeId: row.native_id === null ? null : String(row.native_id), title: String(row.title),
    model: row.model == null ? null : String(row.model), actualModel: row.actual_model == null ? null : String(row.actual_model),
    effort: row.effort == null ? null : String(row.effort),
    actualEffort: row.actual_effort == null ? null : String(row.actual_effort),
    cwd: String(row.cwd), createdAt: String(row.created_at), updatedAt: String(row.updated_at),
    controllerMode: Number(row.controller_mode ?? 0) === 1, contextSeed: row.context_seed == null ? null : String(row.context_seed),
  };
}
function inbox(row: Row): InboxItem {
  return {
    id: String(row.id), userId: String(row.user_id), channelId: String(row.channel_id),
    text: String(row.text), imagePaths: JSON.parse(String(row.images_json)) as string[],
    conversationId: row.conversation_id === null ? null : String(row.conversation_id),
    state: String(row.state) as InboxState,
    replyState: row.reply_state == null ? null : String(row.reply_state) as InboxItem['replyState'],
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
      CREATE TABLE IF NOT EXISTS controller_public_messages (
        id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, native_id TEXT NOT NULL,
        channel_id TEXT NOT NULL, content_hash TEXT NOT NULL, state TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS delivered_replies (
        user_id TEXT NOT NULL, channel_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL REFERENCES conversations(id),
        agent TEXT NOT NULL, native_id TEXT NOT NULL, delivered_at TEXT NOT NULL,
        PRIMARY KEY (user_id, channel_id)
      );
    `);
    // Existing deployments keep native sessions, inbox, and active bindings.
    const columns = new Set(this.db.prepare('PRAGMA table_info(conversations)').all().map(row => String(row.name)));
    if (!columns.has('model')) this.db.exec('ALTER TABLE conversations ADD COLUMN model TEXT');
    if (!columns.has('actual_model')) this.db.exec('ALTER TABLE conversations ADD COLUMN actual_model TEXT');
    if (!columns.has('effort')) this.db.exec('ALTER TABLE conversations ADD COLUMN effort TEXT');
    if (!columns.has('actual_effort')) this.db.exec('ALTER TABLE conversations ADD COLUMN actual_effort TEXT');
    if (!columns.has('controller_mode')) this.db.exec('ALTER TABLE conversations ADD COLUMN controller_mode INTEGER NOT NULL DEFAULT 0');
    if (!columns.has('context_seed')) this.db.exec('ALTER TABLE conversations ADD COLUMN context_seed TEXT');
    const inboxColumns = new Set(this.db.prepare('PRAGMA table_info(inbox)').all().map(row => String(row.name)));
    if (!inboxColumns.has('reply_state')) this.db.exec('ALTER TABLE inbox ADD COLUMN reply_state TEXT');
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

  /** Last persisted human message per known DM, used only to seed ingress recovery. */
  knownChannels(): Array<{ userId: string; channelId: string; cursor: string }> {
    const channels = new Map<string, { userId: string; channelId: string; cursor: string }>();
    for (const row of this.db.prepare('SELECT user_id,channel_id,id FROM inbox ORDER BY sequence').all()) {
      channels.set(`${row.user_id}:${row.channel_id}`, {
        userId: String(row.user_id), channelId: String(row.channel_id), cursor: String(row.id),
      });
    }
    return [...channels.values()];
  }

  claimPublicMessage(id: string, conversationId: string, nativeId: string, channelId: string,
    contentHash: string): 'send' | 'delivered' | 'uncertain' {
    const previous = this.db.prepare('SELECT * FROM controller_public_messages WHERE id=?').get(id);
    if (previous) {
      if (previous.conversation_id !== conversationId || previous.native_id !== nativeId
        || previous.channel_id !== channelId || previous.content_hash !== contentHash) {
        throw new Error('公开消息调用标识被复用于不同内容或会话');
      }
      return previous.state === 'delivered' ? 'delivered' : 'uncertain';
    }
    const now = new Date().toISOString();
    this.db.prepare(`INSERT INTO controller_public_messages
      (id,conversation_id,native_id,channel_id,content_hash,state,created_at,updated_at)
      VALUES (?,?,?,?,?,'pending',?,?)`).run(id, conversationId, nativeId, channelId, contentHash, now, now);
    return 'send';
  }
  finishPublicMessage(id: string, state: 'delivered' | 'uncertain'): void {
    this.db.prepare('UPDATE controller_public_messages SET state=?,updated_at=? WHERE id=?')
      .run(state, new Date().toISOString(), id);
  }

  recentUserContext(conversationId: string): string {
    const rows = this.db.prepare(`SELECT text FROM inbox WHERE conversation_id=? AND state='completed' ORDER BY sequence DESC LIMIT 16`).all(conversationId);
    return rows.reverse().map(row => String(row.text).slice(0, 1600)).join('\n\n');
  }
  rebindQueued(oldId: string, newId: string): void {
    this.db.prepare("UPDATE inbox SET conversation_id=?,updated_at=? WHERE conversation_id=? AND state='queued'")
      .run(newId, new Date().toISOString(), oldId);
  }
  createConversation(userId: string, agent: AgentName, cwd: string, options: { controllerMode?: boolean; contextSeed?: string } = {}): Conversation {
    const now = new Date().toISOString();
    const item: Conversation = {
      id: randomUUID(), userId, agent, nativeId: null, model: null, actualModel: null, actualEffort: null,
      title: '新会话', cwd, createdAt: now, updatedAt: now, controllerMode: options.controllerMode === true, contextSeed: options.contextSeed ?? null,
    };
    this.db.prepare(`INSERT INTO conversations
      (id, user_id, agent, native_id, title, cwd, created_at, updated_at, controller_mode, context_seed)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      item.id, userId, agent, null, item.title, cwd, now, now, item.controllerMode ? 1 : 0, item.contextSeed ?? null,
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

  latestAgentConversation(userId: string, agent: AgentName, cwd: string, controllerMode?: boolean): Conversation | null {
    const modeFilter = controllerMode === undefined ? '' : ' AND controller_mode = ?';
    const row = this.db.prepare(`SELECT * FROM conversations WHERE user_id = ? AND agent = ? AND cwd = ?${modeFilter}
      ORDER BY updated_at DESC, rowid DESC LIMIT 1`).get(userId, agent, cwd, ...(controllerMode === undefined ? [] : [controllerMode ? 1 : 0]));
    return row ? conversation(row) : null;
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

  setModel(id: string, model: string): void {
    this.db.prepare('UPDATE conversations SET model = ?, updated_at = ? WHERE id = ?')
      .run(model, new Date().toISOString(), id);
  }

  setEffort(id: string, effort: string | null): void {
    this.db.prepare('UPDATE conversations SET effort = ?, actual_effort = NULL, updated_at = ? WHERE id = ?')
      .run(effort, new Date().toISOString(), id);
  }

  saveActualModel(id: string, model: string): void {
    this.db.prepare('UPDATE conversations SET actual_model = ?, updated_at = ? WHERE id = ?')
      .run(model, new Date().toISOString(), id);
  }

  saveActualEffort(id: string, effort: string | null): void {
    this.db.prepare('UPDATE conversations SET actual_effort = ?, updated_at = ? WHERE id = ?')
      .run(effort, new Date().toISOString(), id);
  }

  getLastDelivery(userId: string, channelId: string): DeliveredReply | null {
    const row = this.db.prepare('SELECT conversation_id, agent, native_id FROM delivered_replies WHERE user_id = ? AND channel_id = ?')
      .get(userId, channelId);
    return row ? { conversationId: String(row.conversation_id), agent: String(row.agent) as AgentName, nativeId: String(row.native_id) } : null;
  }

  saveDelivery(userId: string, channelId: string, reply: DeliveredReply): void {
    this.db.prepare(`INSERT INTO delivered_replies (user_id, channel_id, conversation_id, agent, native_id, delivered_at)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(user_id, channel_id) DO UPDATE SET
      conversation_id = excluded.conversation_id, agent = excluded.agent,
      native_id = excluded.native_id, delivered_at = excluded.delivered_at`)
      .run(userId, channelId, reply.conversationId, reply.agent, reply.nativeId, new Date().toISOString());
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

  queuedBatch(conversationId: string): InboxItem[] {
    return this.db.prepare("SELECT * FROM inbox WHERE conversation_id = ? AND state = 'queued' ORDER BY sequence")
      .all(conversationId).map(inbox);
  }

  latestMessage(conversationId: string): InboxItem | null {
    const row = this.db.prepare('SELECT * FROM inbox WHERE conversation_id = ? ORDER BY sequence DESC LIMIT 1').get(conversationId);
    return row ? inbox(row) : null;
  }

  setReplyState(ids: string[], state: InboxItem['replyState']): void {
    const update = this.db.prepare('UPDATE inbox SET reply_state = ?, updated_at = ? WHERE id = ?');
    for (const id of ids) update.run(state, new Date().toISOString(), id);
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
      WHERE conversation_id = ? AND state IN ('queued', 'running', 'steering')`)
      .run(new Date().toISOString(), conversationId).changes);
  }

  pendingCount(conversationId: string): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS total FROM inbox
      WHERE conversation_id = ? AND state = 'queued'`).get(conversationId);
    return Number(row?.total ?? 0);
  }

  unfinishedReplies(): InboxItem[] {
    const items = this.db.prepare("SELECT * FROM inbox WHERE state = 'completed' AND reply_state = 'pending' ORDER BY sequence")
      .all().map(inbox);
    for (const item of items) this.setReplyState([item.id], 'failed');
    return items;
  }

  interruptRunning(): InboxItem[] {
    const items = this.db.prepare("SELECT * FROM inbox WHERE state IN ('running', 'steering') ORDER BY sequence").all().map(inbox);
    this.db.prepare("UPDATE inbox SET state = 'interrupted', updated_at = ? WHERE state IN ('running', 'steering')")
      .run(new Date().toISOString());
    return items;
  }

  queuedConversations(): string[] {
    return this.db.prepare("SELECT DISTINCT conversation_id FROM inbox WHERE state = 'queued'")
      .all().map(row => String(row.conversation_id));
  }

  close(): void { this.db.close(); }
}
