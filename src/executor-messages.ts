import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

export interface ExecutorBinding { workerId: string; scope: string; userId: string; title: string; cwd: string; agent: string; nativeId: string | null }
export interface ExecutorRecipient { scope: string; botId: string; userId: string; principalId: string; aliases: string[]; directoryId?: string }
export interface ExecutorMessage {
  id: string; workerId: string | null; text: string; createdAt: string;
  recipient?: ExecutorRecipient; sender?: ExecutorBinding;
  state: 'queued' | 'accepted' | 'handled' | 'uncertain'; reply: string | null;
}
export function executorScope(userId: string): string { return createHash('sha256').update(userId).digest('hex'); }
export function executorTaskId(messageId: string): string {
  const hash = createHash('sha256').update('executor-message:' + messageId).digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
}
export function executorMessageHome(root: string, userHome = homedir()): string {
  const path = resolve(root), key = createHash('sha256').update(process.platform === 'win32' ? path.toLowerCase() : path).digest('hex').slice(0, 24);
  return join(userHome, '.agent-bridge', 'executors', key);
}
export function executorMessageRequest(store: ExecutorMessages, method: string, args: Record<string, unknown>): unknown {
  if (method === 'messages/directory') { store.registerDirectory(args.directoryId as string, args.recipients as ExecutorRecipient[]); return { registered: true }; }
  if (method === 'messages/recipient') { store.registerRecipient(args.recipient as ExecutorRecipient); return { registered: true }; }
  if (method === 'messages/bind') {
    if (!Array.isArray(args.bindings) || args.bindings.length > 200) throw new Error('绑定批次无效。');
    for (const value of args.bindings) store.bind(value as ExecutorBinding);
    return { registered: args.bindings.length };
  }
  if (typeof args.scope !== 'string' || !/^[a-f0-9]{64}$/.test(args.scope)) throw new Error('通信归属无效。');
  if (method === 'messages/pending') return store.pending(args.scope);
  if (method === 'messages/update') return store.update(args.scope, args.id as string, args.state as ExecutorMessage['state'], args.reply as string | undefined);
  throw new Error('未知通信方法。');
}
function id(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(value)) throw new Error('消息或助手 ID 无效。');
}
function body(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > 16_000 || value.includes('\0')) throw new Error('消息正文须为 1～16000 字符。');
}
/** Shared by the local command and executor transport. No daemon or bridge is needed to enqueue. */
export class ExecutorMessages {
  private readonly db: DatabaseSync;
  constructor(root: string, userHome = homedir()) {
    const home = executorMessageHome(root, userHome); mkdirSync(home, { recursive: true });
    this.db = new DatabaseSync(join(home, 'messages.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS bindings(worker_id TEXT PRIMARY KEY,scope TEXT NOT NULL,value_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS recipients(scope TEXT PRIMARY KEY,value_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY,worker_id TEXT NOT NULL,text TEXT NOT NULL,state TEXT NOT NULL,reply TEXT,created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS messages_pending ON messages(state,created_at);`);
    const columns = this.db.prepare('PRAGMA table_info(messages)').all().map(row => row.name);
    if (!columns.includes('target_scope')) this.db.exec('ALTER TABLE messages ADD COLUMN target_scope TEXT');
    if (!columns.includes('sender_json')) this.db.exec('ALTER TABLE messages ADD COLUMN sender_json TEXT');
  }
  close(): void { this.db.close(); }
  registerDirectory(directoryId: string, recipients: ExecutorRecipient[]): void {
    if (!/^[a-f0-9]{64}$/.test(directoryId) || !Array.isArray(recipients) || recipients.length > 100) throw new Error('动态主控目录无效。');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const value of recipients) this.registerRecipient({ ...value, directoryId });
      for (const old of this.recipients()) if (old.directoryId === directoryId && !recipients.some(value => value.scope === old.scope))
        this.db.prepare('DELETE FROM recipients WHERE scope=?').run(old.scope);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  registerRecipient(value: ExecutorRecipient): void {
    if (!value || value.scope !== executorScope(value.userId) || typeof value.botId !== 'string' || !value.botId.trim()
      || typeof value.principalId !== 'string' || !value.principalId.trim() || !Array.isArray(value.aliases)
      || value.aliases.length > 30 || value.aliases.some(alias => typeof alias !== 'string' || !alias.trim() || alias.length > 200)) throw new Error('主控目录登记无效。');
    this.db.prepare('INSERT INTO recipients VALUES(?,?) ON CONFLICT(scope) DO UPDATE SET value_json=excluded.value_json').run(value.scope, JSON.stringify(value));
  }
  recipients(): ExecutorRecipient[] { return this.db.prepare('SELECT value_json FROM recipients ORDER BY scope').all().map(row => JSON.parse(String(row.value_json))); }
  private recipient(scope: string): ExecutorRecipient | undefined { return this.recipients().find(value => value.scope === scope); }
  private resolveRecipient(selector: string): ExecutorRecipient {
    const name = selector.trim().toLowerCase();
    const all = this.recipients(), exact = all.filter(value => value.botId.toLowerCase() === name);
    const matches = exact.length ? exact : all.filter(value => value.aliases.some(alias => alias.toLowerCase() === name));
    if (matches.length !== 1) throw new Error(matches.length ? `主控名称不唯一，请使用具体 botId：${matches.map(value => value.botId).join('、')}` : '未找到主控；先用 controllers 查看登记名称和 botId。');
    return matches[0]!;
  }
  bind(value: ExecutorBinding): void {
    id(value.workerId);
    if (!/^[a-f0-9]{64}$/.test(value.scope) || value.scope !== executorScope(value.userId) || !['codex', 'claude'].includes(value.agent)
      || typeof value.title !== 'string' || value.title.length > 2000 || typeof value.cwd !== 'string' || value.cwd.length > 8192
      || value.nativeId !== null && typeof value.nativeId !== 'string') throw new Error('会话归属无效。');
    const old = this.binding(value.workerId);
    if (old && (old.scope !== value.scope || old.userId !== value.userId)) throw new Error('禁止将助手转绑到其他 Bot 或用户。');
    this.db.prepare('INSERT INTO bindings VALUES(?,?,?) ON CONFLICT(worker_id) DO UPDATE SET value_json=excluded.value_json')
      .run(value.workerId, value.scope, JSON.stringify(value));
  }
  binding(workerId: string): ExecutorBinding | null {
    const row = this.db.prepare('SELECT value_json FROM bindings WHERE worker_id=?').get(workerId);
    return row ? JSON.parse(String(row.value_json)) : null;
  }
  list(cwd?: string): ExecutorBinding[] {
    return this.db.prepare('SELECT value_json FROM bindings ORDER BY rowid DESC LIMIT 200').all()
      .map(row => JSON.parse(String(row.value_json)) as ExecutorBinding)
      .filter(value => !cwd || (process.platform === 'win32' ? value.cwd.toLowerCase() === cwd.toLowerCase() : value.cwd === cwd));
  }
  send(workerId: string | null, text: string, messageId: string = randomUUID(), to?: string): ExecutorMessage {
    if (workerId !== null) id(workerId); id(messageId); body(text);
    const sender = workerId ? this.binding(workerId) : null;
    if (workerId && !sender) throw new Error('此助手尚未登记主控归属；先 list 查找真实会话，不猜选 Bot。');
    if (!sender && !to) throw new Error('普通 CLI 会话需用 --to 指定主控；已登记助手可用 --worker 默认找所属主控。');
    const target = to ? this.resolveRecipient(to) : this.recipient(sender!.scope);
    if (sender && target) {
      const owner = this.recipient(sender.scope);
      if (!owner && sender.scope !== target.scope || owner && owner.principalId !== target.principalId) throw new Error('不能向另一位负责人的主控投递。');
    }
    const scope = target?.scope ?? sender!.scope;
    const old = this.get(messageId);
    if (old) {
      if (old.workerId !== workerId || old.text !== text || (old.recipient?.scope ?? this.binding(old.workerId!)?.scope) !== scope) throw new Error('消息 ID 已用于不同内容或目标。');
      return old;
    }
    const createdAt = new Date().toISOString();
    this.db.prepare("INSERT OR IGNORE INTO messages(id,worker_id,text,state,reply,created_at,target_scope,sender_json) VALUES(?,?,?,'queued',NULL,?,?,?)")
      .run(messageId, workerId ?? '', text, createdAt, scope, sender ? JSON.stringify(sender) : null);
    const saved = this.get(messageId)!;
    if (saved.workerId !== workerId || saved.text !== text || (saved.recipient?.scope ?? this.binding(saved.workerId!)?.scope) !== scope) throw new Error('消息 ID 已用于不同内容或目标。');
    return saved;
  }
  get(messageId: string): ExecutorMessage | null {
    id(messageId); const r = this.db.prepare('SELECT * FROM messages WHERE id=?').get(messageId);
    const scope = r ? String(r.target_scope ?? this.binding(String(r.worker_id))?.scope ?? '') : '';
    return r ? { id: String(r.id), workerId: r.worker_id ? String(r.worker_id) : null, text: String(r.text), state: r.state as ExecutorMessage['state'],
      ...(this.recipient(scope) ? { recipient: this.recipient(scope) } : {}), ...(r.sender_json ? { sender: JSON.parse(String(r.sender_json)) } : {}),
      reply: r.reply == null ? null : String(r.reply), createdAt: String(r.created_at) } : null;
  }
  pending(scope: string): ExecutorMessage[] {
    return this.db.prepare("SELECT m.id FROM messages m LEFT JOIN bindings b ON b.worker_id=m.worker_id WHERE COALESCE(m.target_scope,b.scope)=? AND m.state IN ('queued','accepted') ORDER BY m.rowid LIMIT 20")
      .all(scope).map(r => this.get(String(r.id))!);
  }
  update(scope: string, messageId: string, state: ExecutorMessage['state'], reply?: string): ExecutorMessage {
    const current = this.get(messageId);
    if (!current || (current.recipient?.scope ?? (current.workerId ? this.binding(current.workerId)?.scope : undefined)) !== scope) throw new Error('消息不属于当前主控。');
    if (!['accepted', 'handled', 'uncertain'].includes(state)) throw new Error('消息状态无效。');
    if (reply !== undefined) body(reply);
    if (current.reply !== null && reply !== undefined && current.reply !== reply) throw new Error('消息已有不同答复，禁止覆盖。');
    if (current.state === 'handled' || current.state === 'uncertain') {
      if (reply !== undefined && current.reply !== reply) throw new Error('消息已经结束。');
      return current;
    }
    this.db.prepare('UPDATE messages SET state=?,reply=COALESCE(?,reply) WHERE id=?').run(state, reply ?? null, messageId);
    return this.get(messageId)!;
  }
}
