import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { AgentName, AgentResult, BridgeMessage, Conversation } from './types.js';
import { validMessageId } from './routing.js';
import { parseCommand } from './commands.js';

export type InboxState = 'command' | 'queued' | 'steering' | 'uncertain' | 'running' | 'completed' | 'cancelled' | 'interrupted' | 'failed';
export interface InboxItem extends BridgeMessage {
  conversationId: string | null;
  state: InboxState;
  replyState: 'pending' | 'delivered' | 'failed' | 'cancelled' | null;
}
export interface PrivateInputBatch {
  rootId: string; conversationId: string; userId: string; channelId: string;
  version: number; refreshUsed: boolean; messages: InboxItem[];
}
export interface DeliveredReply {
  conversationId: string;
  agent: AgentName;
  nativeId: string;
}

export type WorkspaceNoticeOutcome = 'ready' | 'read-failed' | 'read-cancelled' | 'load-failed' | 'request-failed' | 'introduction-failed' | 'unknown';
export interface WorkspaceNotice { conversationId: string; userId: string; channelId: string; sourceMessageId: string;
  outcome: WorkspaceNoticeOutcome | null; state: 'waiting' | 'sending' | 'delivered' | 'uncertain' | 'cancelled' }

type Row = Record<string, string | number | bigint | Uint8Array | null>;
function conversation(row: Row): Conversation {
  return {
    id: String(row.id), userId: String(row.user_id), agent: String(row.agent) as AgentName,
    nativeId: row.native_id === null ? null : String(row.native_id), title: String(row.title),
    model: row.model == null ? null : String(row.model), ...(row.model_policy === 'cli-default' ? { modelPolicy: 'cli-default' as const } : {}), actualModel: row.actual_model == null ? null : String(row.actual_model),
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
    ...(row.source_json ? { source: JSON.parse(String(row.source_json)) as BridgeMessage['source'] } : {}),
    ...(row.group_json ? { groupContext: JSON.parse(String(row.group_json)) as BridgeMessage['groupContext'] } : {}),
    conversationId: row.conversation_id === null ? null : String(row.conversation_id),
    state: String(row.state) as InboxState,
    replyState: row.reply_state == null ? null : String(row.reply_state) as InboxItem['replyState'],
  };
}

export interface ControllerBinding {
  getActive(userId: string): string | null;
  setActive(userId: string, conversationId: string, reason?: 'reset' | 'agent-switch'): void;
}
export class SessionStore {
  readonly path: string;
  private readonly db: DatabaseSync;

  constructor(dataDir: string, private readonly binding?: ControllerBinding) {
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
      CREATE TABLE IF NOT EXISTS turn_results (
        source_id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, native_id TEXT NOT NULL,
        result_json TEXT NOT NULL, exit_error TEXT, saved_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS workspace_initialization_notices (
        conversation_id TEXT PRIMARY KEY REFERENCES conversations(id), user_id TEXT NOT NULL,
        channel_id TEXT NOT NULL, source_message_id TEXT NOT NULL, outcome TEXT,
        state TEXT NOT NULL DEFAULT 'waiting', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS private_input_boundaries (
        user_id TEXT PRIMARY KEY, version INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS private_input_barriers (
        user_id TEXT NOT NULL, id TEXT NOT NULL, PRIMARY KEY(user_id,id)
      );
      CREATE TABLE IF NOT EXISTS private_input_arrivals (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL, channel_id TEXT NOT NULL, boundary INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS private_input_arrivals_user ON private_input_arrivals(user_id);
      CREATE TABLE IF NOT EXISTS private_input_batches (
        root_id TEXT PRIMARY KEY REFERENCES inbox(id), conversation_id TEXT NOT NULL REFERENCES conversations(id),
        user_id TEXT NOT NULL, channel_id TEXT NOT NULL, version INTEGER NOT NULL,
        boundary INTEGER NOT NULL, refresh_used INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS private_input_batch_members (
        root_id TEXT NOT NULL REFERENCES private_input_batches(root_id), message_id TEXT NOT NULL UNIQUE REFERENCES inbox(id),
        PRIMARY KEY(root_id,message_id)
      );
      CREATE TABLE IF NOT EXISTS bot_preferences (
        agent TEXT PRIMARY KEY, model TEXT, model_policy TEXT, effort TEXT
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
    if (!columns.has('model_policy')) this.db.exec('ALTER TABLE conversations ADD COLUMN model_policy TEXT');
    if (!columns.has('actual_model')) this.db.exec('ALTER TABLE conversations ADD COLUMN actual_model TEXT');
    if (!columns.has('effort')) this.db.exec('ALTER TABLE conversations ADD COLUMN effort TEXT');
    if (!columns.has('actual_effort')) this.db.exec('ALTER TABLE conversations ADD COLUMN actual_effort TEXT');
    if (!columns.has('controller_mode')) this.db.exec('ALTER TABLE conversations ADD COLUMN controller_mode INTEGER NOT NULL DEFAULT 0');
    if (!columns.has('context_seed')) this.db.exec('ALTER TABLE conversations ADD COLUMN context_seed TEXT');
    const inboxColumns = new Set(this.db.prepare('PRAGMA table_info(inbox)').all().map(row => String(row.name)));
    if (!inboxColumns.has('group_json')) this.db.exec('ALTER TABLE inbox ADD COLUMN group_json TEXT');
    if (!inboxColumns.has('source_json')) this.db.exec('ALTER TABLE inbox ADD COLUMN source_json TEXT');
    if (!inboxColumns.has('reply_state')) this.db.exec('ALTER TABLE inbox ADD COLUMN reply_state TEXT');
    const publicColumns = new Set(this.db.prepare('PRAGMA table_info(controller_public_messages)').all().map(row => String(row.name)));
    if (!publicColumns.has('text')) this.db.exec('ALTER TABLE controller_public_messages ADD COLUMN text TEXT');
    if (!publicColumns.has('error')) this.db.exec('ALTER TABLE controller_public_messages ADD COLUMN error TEXT');
  }

  hasMessage(id: string): boolean {
    return this.db.prepare('SELECT 1 FROM inbox WHERE id = ?').get(id) !== undefined;
  }

  addMessage(message: BridgeMessage, conversationId: string | null, state: InboxState): boolean {
    return this.privateInputAtomic(() => {
      const now = new Date().toISOString();
      const result = this.db.prepare(`INSERT OR IGNORE INTO inbox
        (id, user_id, channel_id, text, images_json, conversation_id, state, created_at, updated_at, group_json, source_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        message.id, message.userId, message.channelId, message.text,
        JSON.stringify(message.imagePaths), conversationId, state, now, now, message.groupContext ? JSON.stringify(message.groupContext) : null,
        message.source ? JSON.stringify(message.source) : null,
      );
      const inserted = Number(result.changes) === 1;
      if (inserted && state !== 'command' && this.ordinaryPrivateInput(message)) this.notePrivateInputArrivalInner(message);
      return inserted;
    });
  }

  private privateInputAtomic<T>(action: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = action(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  private ordinaryPrivateInput(value: Pick<BridgeMessage, 'groupContext' | 'source' | 'text'>): boolean {
    return !value.groupContext && !value.source?.space && !parseCommand(value.text)
      && (value.source?.authorType === undefined || value.source.authorType === 'user');
  }
  private validPrivateRoot(row: Row | undefined): row is Row {
    if (!row || row.state !== 'running' || row.conversation_id === null) return false;
    const value = inbox(row), active = this.getActive(value.userId);
    return this.ordinaryPrivateInput(value) && active?.id === value.conversationId && active.userId === value.userId;
  }
  private privateBoundary(userId: string): number {
    return Number(this.db.prepare('SELECT version FROM private_input_boundaries WHERE user_id=?').get(userId)?.version ?? 0);
  }
  /** The root and every fresh owner message retain their original source and reply obligations. */
  startPrivateBatch(rootId: string): { version: number; messages: InboxItem[] } {
    return this.privateInputAtomic(() => {
      const row = this.db.prepare('SELECT * FROM inbox WHERE id=?').get(rootId);
      if (!this.validPrivateRoot(row)) throw new Error('私聊批次需要当前用户、当前会话的普通运行中输入');
      const value = inbox(row), previous = this.db.prepare('SELECT * FROM private_input_batches WHERE root_id=?').get(rootId);
      if (previous) {
        if (previous.conversation_id !== value.conversationId || previous.user_id !== value.userId || previous.channel_id !== value.channelId)
          throw new Error('私聊批次原始输入绑定已改变');
      } else {
        if (this.db.prepare('SELECT 1 FROM private_input_batch_members WHERE message_id=?').get(rootId))
          throw new Error('此私聊输入已属于另一批次');
        const arrival = this.db.prepare('SELECT * FROM private_input_arrivals WHERE id=?').get(rootId);
        if (arrival && (arrival.user_id !== value.userId || arrival.channel_id !== value.channelId))
          throw new Error('私聊原始到达绑定已改变');
        this.db.prepare(`INSERT INTO private_input_batches(root_id,conversation_id,user_id,channel_id,version,boundary)
          VALUES(?,?,?,?,?,?)`).run(rootId, value.conversationId!, value.userId, value.channelId, Number(row.sequence), Number(arrival?.boundary ?? 0));
        this.db.prepare('INSERT INTO private_input_batch_members(root_id,message_id) VALUES(?,?)').run(rootId, rootId);
      }
      const batch = this.privateBatch(rootId)!;
      return { version: batch.version, messages: batch.messages };
    });
  }
  /** Arrival barriers are durable even before attachment preparation or command persistence finishes. */
  markPrivateInputBarrier(userId: string, id: string): void {
    if (!userId.trim() || !id.trim()) throw new Error('私聊边界需要有效用户和输入编号');
    this.privateInputAtomic(() => this.markPrivateInputBarrierInner(userId, id));
  }
  private markPrivateInputBarrierInner(userId: string, id: string): void {
    const added = this.db.prepare('INSERT OR IGNORE INTO private_input_barriers(user_id,id) VALUES(?,?)').run(userId, id);
    if (Number(added.changes) === 1) this.db.prepare(`INSERT INTO private_input_boundaries(user_id,version) VALUES(?,1)
      ON CONFLICT(user_id) DO UPDATE SET version=version+1`).run(userId);
  }
  /** Freeze private input order before an asynchronous attachment preparation can overtake a boundary. */
  notePrivateInputArrival(message: Pick<BridgeMessage, 'id' | 'userId' | 'channelId'>): void {
    if (!message.id.trim() || !message.userId.trim() || !message.channelId.trim()) throw new Error('私聊到达登记需要有效输入、用户和聊天编号');
    this.privateInputAtomic(() => this.notePrivateInputArrivalInner(message));
  }
  private notePrivateInputArrivalInner(message: Pick<BridgeMessage, 'id' | 'userId' | 'channelId'>): void {
    const previous = this.db.prepare('SELECT * FROM private_input_arrivals WHERE id=?').get(message.id);
    if (previous) {
      if (previous.user_id !== message.userId || previous.channel_id !== message.channelId) throw new Error('私聊原始到达编号被复用于其他用户或聊天');
      return;
    }
    const last = this.db.prepare('SELECT channel_id FROM private_input_arrivals WHERE user_id=? ORDER BY rowid DESC LIMIT 1').get(message.userId);
    if (last && last.channel_id !== message.channelId) this.markPrivateInputBarrierInner(message.userId, 'private-channel-switch:' + message.id);
    this.db.prepare('INSERT INTO private_input_arrivals(id,user_id,channel_id,boundary) VALUES(?,?,?,?)')
      .run(message.id, message.userId, message.channelId, this.privateBoundary(message.userId));
  }
  privateBatch(rootId: string): PrivateInputBatch | null {
    const row = this.db.prepare('SELECT * FROM private_input_batches WHERE root_id=?').get(rootId);
    if (!row) return null;
    const messages = this.db.prepare(`SELECT i.* FROM inbox i JOIN private_input_batch_members m ON m.message_id=i.id
      WHERE m.root_id=? ORDER BY i.sequence`).all(rootId).map(inbox);
    return { rootId: String(row.root_id), conversationId: String(row.conversation_id), userId: String(row.user_id),
      channelId: String(row.channel_id), version: Number(row.version), refreshUsed: Number(row.refresh_used) === 1, messages };
  }
  /** Claim one strictly contiguous, bounded set of fresh owner inputs; never skip an intervening boundary. */
  claimPrivateRefresh(rootId: string, limit = 20, maxChars = 12000): { version: number; messages: InboxItem[] } | null {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(maxChars) || maxChars < 1 || maxChars > 1_000_000)
      throw new Error('私聊补充输入数量或字数上限无效');
    return this.privateInputAtomic(() => {
      const row = this.db.prepare('SELECT * FROM inbox WHERE id=?').get(rootId);
      if (!this.validPrivateRoot(row)) return null;
      const batch = this.db.prepare('SELECT * FROM private_input_batches WHERE root_id=?').get(rootId);
      if (!batch || Number(batch.refresh_used) === 1 || batch.conversation_id !== row.conversation_id || batch.user_id !== row.user_id
        || batch.channel_id !== row.channel_id || Number(batch.boundary) !== this.privateBoundary(String(row.user_id))) return null;
      const rows = this.db.prepare('SELECT * FROM inbox WHERE user_id=? AND sequence>? ORDER BY sequence LIMIT ?')
        .all(String(row.user_id), Number(row.sequence), limit);
      const messages: InboxItem[] = []; let chars = 0, version = Number(batch.version);
      for (const candidate of rows) {
        const value = inbox(candidate);
        if (value.conversationId !== row.conversation_id || value.channelId !== row.channel_id || value.state !== 'queued'
          || !this.ordinaryPrivateInput(value) || chars + value.text.length > maxChars) break;
        messages.push(value); chars += value.text.length; version = Number(candidate.sequence);
      }
      if (!messages.length) return null;
      const now = new Date().toISOString();
      for (const value of messages) {
        const changed = this.db.prepare("UPDATE inbox SET state='running',updated_at=? WHERE id=? AND state='queued'").run(now, value.id);
        if (Number(changed.changes) !== 1) throw new Error('私聊补充输入领取状态已改变');
        this.db.prepare('INSERT INTO private_input_batch_members(root_id,message_id) VALUES(?,?)').run(rootId, value.id);
        value.state = 'running';
      }
      this.db.prepare('UPDATE private_input_batches SET version=?,refresh_used=1 WHERE root_id=?').run(version, rootId);
      return { version, messages };
    });
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

  /** Only genuine platform DM inputs can seed the platform history journal. */
  knownDMChannels(): Array<{ userId: string; channelId: string; cursor: string }> {
    const channels = new Map<string, { userId: string; channelId: string; cursor: string }>();
    for (const row of this.db.prepare('SELECT user_id,channel_id,id FROM inbox WHERE group_json IS NULL ORDER BY sequence').all()) {
      if (!validMessageId(String(row.id))) continue;
      const route = { userId: String(row.user_id), channelId: String(row.channel_id), cursor: String(row.id) };
      channels.set(JSON.stringify([route.userId, route.channelId]), route);
    }
    return [...channels.values()];
  }

  /** Only a trusted host can reauthorize an already queued group event after a continuous switch. */
  updateQueuedGroupContext(id: string, conversationId: string, context: NonNullable<BridgeMessage['groupContext']>): boolean {
    return Number(this.db.prepare("UPDATE inbox SET group_json=? WHERE id=? AND conversation_id=? AND state='queued'").run(JSON.stringify(context), id, conversationId).changes) === 1;
  }

  claimPublicMessage(id: string, conversationId: string, nativeId: string, channelId: string,
    contentHash: string, text?: string): 'send' | 'delivered' | 'rejected' | 'uncertain' {
    const previous = this.db.prepare('SELECT * FROM controller_public_messages WHERE id=?').get(id);
    if (previous) {
      if (previous.conversation_id !== conversationId || previous.native_id !== nativeId
        || previous.channel_id !== channelId || previous.content_hash !== contentHash) {
        throw new Error('公开消息调用标识被复用于不同内容或会话');
      }
      return previous.state === 'delivered' ? 'delivered' : previous.state === 'rejected' ? 'rejected' : 'uncertain';
    }
    const now = new Date().toISOString();
    this.db.prepare(`INSERT INTO controller_public_messages
      (id,conversation_id,native_id,channel_id,content_hash,text,state,created_at,updated_at)
      VALUES (?,?,?,?,?,?,'pending',?,?)`).run(id, conversationId, nativeId, channelId, contentHash, text ?? null, now, now);
    return 'send';
  }
  finishPublicMessage(id: string, state: 'delivered' | 'rejected' | 'uncertain', error: string | null = null): void {
    this.db.prepare('UPDATE controller_public_messages SET state=?,error=?,updated_at=? WHERE id=?')
      .run(state, error, new Date().toISOString(), id);
  }

  /** Native completion and process cleanup are independent facts; neither triggers a replay. */
  saveTurnResult(sourceId: string, conversationId: string, result: AgentResult, exitError: string | null = result.postDeliveryError ?? null): void {
    this.db.prepare(`INSERT INTO turn_results(source_id,conversation_id,native_id,result_json,exit_error,saved_at)
      VALUES(?,?,?,?,?,?) ON CONFLICT(source_id) DO UPDATE SET result_json=excluded.result_json,
      exit_error=excluded.exit_error,saved_at=excluded.saved_at WHERE turn_results.conversation_id=excluded.conversation_id
      AND turn_results.native_id=excluded.native_id`).run(sourceId, conversationId, result.nativeId, JSON.stringify(result), exitError, new Date().toISOString());
  }
  turnResult(sourceId: string): { result: AgentResult; exitError: string | null } | null {
    const row = this.db.prepare('SELECT result_json,exit_error FROM turn_results WHERE source_id=?').get(sourceId);
    return row ? { result: JSON.parse(String(row.result_json)) as AgentResult, exitError: row.exit_error == null ? null : String(row.exit_error) } : null;
  }

  /** Genuine inputs and confirmed public replies, confined to this user's exact conversation and chat. */
  handoffHistory(conversationId: string, userId: string, channelId?: string): Array<{ role: 'user' | 'assistant'; text: string; at: string; state: string }> {
    const owner = this.getConversation(conversationId);
    if (!owner || owner.userId !== userId) throw new Error('不能读取其他用户的会话。');
    const channelFilter = channelId === undefined ? '' : ' AND channel_id=?';
    const bindings = channelId === undefined ? [conversationId, userId] : [conversationId, userId, channelId];
    const inputs = this.db.prepare(`SELECT text,created_at,state FROM inbox WHERE id IN (
      SELECT id FROM (SELECT id FROM inbox WHERE conversation_id=? AND user_id=?${channelFilter} ORDER BY sequence LIMIT 2)
      UNION SELECT id FROM (SELECT id FROM inbox WHERE conversation_id=? AND user_id=?${channelFilter} ORDER BY sequence DESC LIMIT 160)
    ) ORDER BY sequence`).all(...bindings, ...bindings);
    const replies = this.db.prepare(`SELECT text,created_at,state FROM controller_public_messages
      WHERE conversation_id=?${channelId === undefined ? '' : ' AND channel_id=?'} AND state='delivered' AND text IS NOT NULL ORDER BY created_at DESC LIMIT 160`).all(conversationId, ...(channelId === undefined ? [] : [channelId]));
    return [...inputs.map(row => ({ role: 'user' as const, text: String(row.text), at: String(row.created_at), state: String(row.state) })),
      ...replies.map(row => ({ role: 'assistant' as const, text: String(row.text), at: String(row.created_at), state: String(row.state) }))]
      .sort((a, b) => a.at.localeCompare(b.at));
  }

  requestWorkspaceNotice(conversationId: string, message: BridgeMessage): void {
    const now = new Date().toISOString();
    this.db.prepare(`INSERT INTO workspace_initialization_notices
      (conversation_id,user_id,channel_id,source_message_id,created_at,updated_at) VALUES(?,?,?,?,?,?)`)
      .run(conversationId, message.userId, message.channelId, message.id, now, now);
  }
  workspaceNotice(conversationId: string): WorkspaceNotice | null {
    const row = this.db.prepare('SELECT * FROM workspace_initialization_notices WHERE conversation_id=?').get(conversationId);
    return row ? { conversationId: String(row.conversation_id), userId: String(row.user_id), channelId: String(row.channel_id),
      sourceMessageId: String(row.source_message_id), outcome: row.outcome == null ? null : String(row.outcome) as WorkspaceNoticeOutcome,
      state: String(row.state) as WorkspaceNotice['state'] } : null;
  }
  prepareWorkspaceNotice(conversationId: string, outcome: WorkspaceNoticeOutcome): void {
    this.db.prepare("UPDATE workspace_initialization_notices SET outcome=?,updated_at=? WHERE conversation_id=? AND state='waiting' AND outcome IS NULL")
      .run(outcome, new Date().toISOString(), conversationId);
  }
  claimWorkspaceNotice(notice: WorkspaceNotice): boolean {
    return Number(this.db.prepare(`UPDATE workspace_initialization_notices SET state='sending',updated_at=?
      WHERE conversation_id=? AND user_id=? AND channel_id=? AND source_message_id=? AND state='waiting' AND outcome=?`)
      .run(new Date().toISOString(), notice.conversationId, notice.userId, notice.channelId, notice.sourceMessageId, notice.outcome).changes) === 1;
  }
  finishWorkspaceNotice(conversationId: string, state: 'delivered' | 'uncertain'): void {
    this.db.prepare("UPDATE workspace_initialization_notices SET state=?,updated_at=? WHERE conversation_id=? AND state IN ('sending','uncertain')")
      .run(state, new Date().toISOString(), conversationId);
  }
  cancelWorkspaceNotice(conversationId: string): void {
    this.db.prepare(`UPDATE workspace_initialization_notices SET state=CASE WHEN state='sending' THEN 'uncertain' ELSE 'cancelled' END,
      updated_at=? WHERE conversation_id=? AND state IN ('waiting','sending')`).run(new Date().toISOString(), conversationId);
  }
  recoverWorkspaceNotices(users?: string[]): string[] {
    const rows = this.db.prepare("SELECT * FROM workspace_initialization_notices WHERE state IN ('sending','waiting')").all().filter(row => !users || users.includes(String(row.user_id)));
    for (const row of rows) if (row.state === 'sending') this.db.prepare("UPDATE workspace_initialization_notices SET state='uncertain',updated_at=? WHERE conversation_id=?").run(new Date().toISOString(), row.conversation_id!);
    return rows.filter(row => row.state === 'waiting' && row.outcome != null).map(row => String(row.conversation_id));
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

  getActive(userId: string): Conversation | null {
    if (this.binding) { const id = this.binding.getActive(userId); return id ? this.getConversation(id) : null; }
    // Unbound stores are used by offline legacy migration and standalone tests only.
    if (!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='active_conversations'").get()) return null;
    const row = this.db.prepare(`SELECT c.* FROM conversations c
      JOIN active_conversations a ON a.conversation_id = c.id WHERE a.user_id = ?`).get(userId);
    return row ? conversation(row) : null;
  }

  setActive(userId: string, conversationId: string, reason: 'reset' | 'agent-switch' = 'reset'): void {
    const target = this.getConversation(conversationId);
    if (!target || target.userId !== userId) throw new Error('会话不属于当前用户');
    if (this.binding) { this.binding.setActive(userId, conversationId, reason); return; }
    this.db.exec('CREATE TABLE IF NOT EXISTS active_conversations (user_id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id))');
    this.db.prepare(`INSERT INTO active_conversations (user_id, conversation_id) VALUES (?, ?)
      ON CONFLICT(user_id) DO UPDATE SET conversation_id = excluded.conversation_id`).run(userId, conversationId);
  }

  savePreferences(item: Conversation): void {
    this.db.prepare(`INSERT INTO bot_preferences(agent,model,model_policy,effort) VALUES(?,?,?,?)
      ON CONFLICT(agent) DO UPDATE SET model=excluded.model,model_policy=excluded.model_policy,effort=excluded.effort`)
      .run(item.agent, item.model ?? null, item.modelPolicy ?? null, item.effort ?? null);
  }
  preferences(agent: AgentName): { model: string | null; modelPolicy?: 'cli-default'; effort: string | null } | null {
    const row = this.db.prepare('SELECT * FROM bot_preferences WHERE agent=?').get(agent);
    return row ? { model: row.model == null ? null : String(row.model), effort: row.effort == null ? null : String(row.effort),
      ...(row.model_policy === 'cli-default' ? { modelPolicy: 'cli-default' as const } : {}) } : null;
  }
  saveContextSeed(id: string, contextSeed: string): void {
    this.db.prepare('UPDATE conversations SET context_seed=?,updated_at=? WHERE id=?').run(contextSeed, new Date().toISOString(), id);
  }
  saveNativeId(id: string, nativeId: string): void {
    this.db.prepare('UPDATE conversations SET native_id = ?, updated_at = ? WHERE id = ?')
      .run(nativeId, new Date().toISOString(), id);
  }

  setModel(id: string, model: string | null): void {
    this.db.prepare('UPDATE conversations SET model = ?, model_policy = ?, updated_at = ? WHERE id = ?')
      .run(model, model === null ? 'cli-default' : null, new Date().toISOString(), id);
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

  unfinishedReplies(users?: string[]): InboxItem[] {
    const items = this.db.prepare("SELECT * FROM inbox WHERE state = 'completed' AND reply_state = 'pending' ORDER BY sequence")
      .all().map(inbox).filter(item => !users || users.includes(item.userId));
    for (const item of items) this.setReplyState([item.id], 'failed');
    return items;
  }

  interruptRunning(users?: string[]): InboxItem[] {
    const items = this.db.prepare("SELECT * FROM inbox WHERE state IN ('running', 'steering') ORDER BY sequence").all().map(inbox).filter(item => !users || users.includes(item.userId));
    for (const item of items) this.setState(item.id, 'interrupted');
    return items;
  }

  queuedConversations(): string[] {
    return this.db.prepare("SELECT DISTINCT conversation_id FROM inbox WHERE state = 'queued'")
      .all().map(row => String(row.conversation_id));
  }

  close(): void { this.db.close(); }
}
