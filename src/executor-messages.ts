import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

export interface ControllerOwnerMigration { controllerId:string;botId:string;principalId:string;oldUserId:string;userId:string }
export interface ExecutorBinding { workerId: string; controllerId: string; scope: string; userId: string; title: string; cwd: string; agent: string; nativeId: string | null }
export interface ExecutorRecipient { scope: string; controllerId: string; botId?: string; userId: string; principalId: string; aliases: string[]; directoryId?: string }
export interface ExecutorMessage {
  id: string; workerId: string | null; text: string; createdAt: string;
  recipient?: ExecutorRecipient; sender?: ExecutorBinding;
  state: 'queued' | 'accepted' | 'handled' | 'uncertain'; reply: string | null;
}
export function executorScope(controllerId: string, userId: string): string { return createHash('sha256').update(JSON.stringify([controllerId,userId])).digest('hex'); }
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

function validController(value: unknown): value is string { return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(value); }
function validateRecipient(value: ExecutorRecipient): void {
  if (!value || !validController(value.controllerId) || typeof value.userId !== 'string' || !value.userId.trim()
    || value.scope !== executorScope(value.controllerId,value.userId) || value.botId !== undefined && (typeof value.botId !== 'string' || !value.botId.trim())
    || typeof value.principalId !== 'string' || !value.principalId.trim() || !Array.isArray(value.aliases)
    || value.aliases.length > 30 || value.aliases.some(alias => typeof alias !== 'string' || !alias.trim() || alias.length > 200)) throw new Error('主控目录登记无效。');
}
function validateOwnerMapping(value: ControllerOwnerMigration): void {
  if(!value||!validController(value.controllerId)||!validController(value.principalId)||typeof value.botId!=='string'
    || !/^(feishu:cli_[A-Za-z0-9]+|discord:[0-9]{15,22})$/.test(value.botId)||typeof value.oldUserId!=='string'
    || !value.oldUserId.startsWith(value.botId+'|')||value.oldUserId.length<=value.botId.length+1
    || value.userId!=='principal:'+value.principalId)throw new Error('明确的旧操作者迁移映射无效');
}
function assertOwnerRecipient(db:DatabaseSync,value:ExecutorRecipient):void {
  for(const row of db.prepare('SELECT value_json FROM executor_owner_mappings').all()) {
    const owner=JSON.parse(String(row.value_json)) as ControllerOwnerMigration;
    if(owner.controllerId===value.controllerId&&(owner.userId!==value.userId||owner.principalId!==value.principalId||value.botId!==undefined&&owner.botId!==value.botId))
      throw new Error('主控目录与已确认的操作者迁移映射冲突');
  }
}
/** Explicit v1 -> v2 transaction; only authenticated directory/owner registrations supply mappings. */
export function migrateExecutorMessageScopes(db: DatabaseSync): void {
  const version=db.prepare("SELECT value FROM executor_metadata WHERE key='scope-version'").get()?.value;
  if(version==='2')return;if(version!=='1')throw new Error('未知执行器通信schema版本，拒绝猜测迁移');
  const known = db.prepare('SELECT directory_id,recipients_json FROM executor_migration_directories').all().flatMap(row =>
    (JSON.parse(String(row.recipients_json)) as ExecutorRecipient[]).map(recipient => ({...recipient,directoryId:String(row.directory_id)})));
  const explicit = db.prepare('SELECT value_json FROM executor_owner_mappings').all().map(row=>JSON.parse(String(row.value_json)) as ControllerOwnerMigration);
  const mappings=new Map<string,ExecutorRecipient>(),oldUsers=new Map<string,string>(),owners:Record<string,string>={};
  const install=(oldScope:string,oldUser:string,next:ExecutorRecipient)=>{
    if(mappings.has(oldScope)&&mappings.get(oldScope)!.scope!==next.scope)throw new Error('旧操作者映射不唯一');
    if(owners[oldUser]&&owners[oldUser]!==next.userId)throw new Error('旧操作者映射不唯一');
    mappings.set(oldScope,next);oldUsers.set(oldScope,oldUser);owners[oldUser]=next.userId;
  };
  const explicitRecipient=(value:ControllerOwnerMigration,aliases:string[]=[]):ExecutorRecipient=>{
    const expected={controllerId:value.controllerId,botId:value.botId,principalId:value.principalId,userId:value.userId,scope:executorScope(value.controllerId,value.userId),aliases};
    const matches=known.filter(next=>next.controllerId===value.controllerId);
    for(const next of matches)if(next.scope!==expected.scope||next.botId!==expected.botId||next.principalId!==expected.principalId)throw new Error('明确迁移映射与已认证主控目录冲突');
    return matches[0]??expected;
  };
  for(const value of explicit)install(createHash('sha256').update(value.oldUserId).digest('hex'),value.oldUserId,explicitRecipient(value));
  for(const row of db.prepare('SELECT scope,value_json FROM recipients').all()){
    const old=JSON.parse(String(row.value_json));
    if(typeof old.userId!=='string'||typeof old.botId!=='string'||typeof old.principalId!=='string'||old.scope!==row.scope
      ||createHash('sha256').update(old.userId).digest('hex')!==row.scope)throw new Error('旧通信归属登记损坏；未猜测迁移。');
    const declared=explicit.find(value=>value.oldUserId===old.userId);
    if(declared){if(declared.botId!==old.botId||declared.principalId!==old.principalId)throw new Error('明确迁移映射与旧recipient身份冲突');
      install(String(row.scope),old.userId,explicitRecipient(declared,old.aliases??[]));continue;}
    const unique=new Map(known.filter(next=>next.botId===old.botId&&next.principalId===old.principalId).map(value=>[value.scope,value]));
    if(unique.size!==1)throw new Error('旧主控尚无唯一已认证的新目录映射：'+old.botId+'；等待对应目录注册。');
    install(String(row.scope),old.userId,[...unique.values()][0]!);
  }
  const converted=(value:Record<string,unknown>):Record<string,unknown>=>{
    if(value.userId!==oldUsers.get(String(value.scope)))throw new Error('旧助手操作者与明确归属映射不一致');
    const next=mappings.get(String(value.scope));if(!next)throw new Error('旧助手缺少明确的主控目录映射；保留原消息等待登记。');
    return{...value,controllerId:next.controllerId,scope:next.scope,userId:next.userId};
  };
  db.exec('BEGIN IMMEDIATE');
  try{
    for(const row of db.prepare('SELECT worker_id,scope,value_json FROM bindings').all()){
      const old=JSON.parse(String(row.value_json));if(old.scope!==row.scope)throw new Error('旧助手归属记录不一致');
      const next=converted(old);db.prepare('UPDATE bindings SET scope=?,value_json=? WHERE worker_id=?').run(String(next.scope),JSON.stringify(next),row.worker_id!);
    }
    for(const row of db.prepare('SELECT id,worker_id,target_scope,sender_json FROM messages').all()){
      const binding=row.worker_id?db.prepare('SELECT value_json FROM bindings WHERE worker_id=?').get(row.worker_id):undefined;
      const sender=row.sender_json?converted(JSON.parse(String(row.sender_json))):null;
      const target=row.target_scope?mappings.get(String(row.target_scope))?.scope:(binding?JSON.parse(String(binding.value_json)).scope:undefined);
      if(!target)throw new Error('旧消息目标无法由登记确认；未重投或丢弃。');
      db.prepare('UPDATE messages SET target_scope=?,sender_json=? WHERE id=?').run(target,sender?JSON.stringify(sender):null,row.id!);
    }
    db.exec('DELETE FROM recipients');
    for(const next of new Map([...mappings.values()].map(value=>[value.scope,value])).values())db.prepare('INSERT INTO recipients VALUES(?,?)').run(next.scope,JSON.stringify(next));
    db.prepare("INSERT INTO executor_metadata VALUES('owner-mappings',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(owners));
    db.prepare("INSERT INTO executor_metadata VALUES('scope-version','2') ON CONFLICT(key) DO UPDATE SET value='2'").run();db.exec('COMMIT');
  }catch(error){db.exec('ROLLBACK');throw error;}
}

/** Shared by the local command and executor transport. No daemon or bridge is needed to enqueue. */
export class ExecutorMessages {
  private readonly db: DatabaseSync;
  constructor(root: string, userHome = homedir()) {
    const home = executorMessageHome(root, userHome); mkdirSync(home, { recursive: true });
    this.db = new DatabaseSync(join(home, 'messages.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS executor_metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS executor_owner_mappings(old_user_id TEXT PRIMARY KEY,value_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS executor_migration_directories(directory_id TEXT PRIMARY KEY,recipients_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS bindings(worker_id TEXT PRIMARY KEY,scope TEXT NOT NULL,value_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS recipients(scope TEXT PRIMARY KEY,value_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY,worker_id TEXT NOT NULL,text TEXT NOT NULL,state TEXT NOT NULL,reply TEXT,created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS messages_pending ON messages(state,created_at);`);
    const columns = this.db.prepare('PRAGMA table_info(messages)').all().map(row => row.name);
    if (!columns.includes('target_scope')) this.db.exec('ALTER TABLE messages ADD COLUMN target_scope TEXT');
    if (!columns.includes('sender_json')) this.db.exec('ALTER TABLE messages ADD COLUMN sender_json TEXT');
    const count = ['bindings','recipients','messages'].reduce((total,table)=>total+Number(this.db.prepare('SELECT COUNT(*) AS n FROM '+table).get()!.n),0);
    this.db.prepare("INSERT OR IGNORE INTO executor_metadata VALUES('scope-version',?)").run(count===0?'2':'1');
  }
  close(): void { this.db.close(); }
  ownerMappings(): Record<string,string> { this.requireCurrent();const row=this.db.prepare("SELECT value FROM executor_metadata WHERE key='owner-mappings'").get();return row?JSON.parse(String(row.value)):{}; }
  private requireCurrent(): void { if(this.db.prepare("SELECT value FROM executor_metadata WHERE key='scope-version'").get()?.value!=='2')throw new Error('执行器通信归属待一次性迁移；等待桥的已认证目录注册，不使用旧归属。'); }
  registerOwnerMigrationMappings(values:ControllerOwnerMigration[]):void {
    if(!Array.isArray(values)||values.length>1000)throw new Error('操作者迁移批次无效');
    const declared=new Map<string,ControllerOwnerMigration>();
    for(const value of values){validateOwnerMapping(value);
      const known=[...this.db.prepare('SELECT value_json FROM executor_owner_mappings').all().map(row=>JSON.parse(String(row.value_json)) as ControllerOwnerMigration),...declared.values()];
      if(known.some(owner=>owner.controllerId===value.controllerId&&(owner.botId!==value.botId||owner.principalId!==value.principalId||owner.userId!==value.userId)))throw new Error('主控的明确操作者迁移映射冲突');
      const old=declared.get(value.oldUserId)??this.db.prepare('SELECT value_json FROM executor_owner_mappings WHERE old_user_id=?').get(value.oldUserId);
      const previous=old&&('value_json' in old?JSON.parse(String(old.value_json)):old);
      if(previous&&['controllerId','botId','principalId','userId'].some(key=>previous[key]!==value[key as keyof ControllerOwnerMigration]))throw new Error('旧操作者迁移映射冲突');
      for(const row of this.db.prepare('SELECT value_json FROM recipients').all()){
        const recipient=JSON.parse(String(row.value_json));if(recipient.controllerId===value.controllerId&&(recipient.userId!==value.userId||recipient.principalId!==value.principalId||recipient.botId!==undefined&&recipient.botId!==value.botId))throw new Error('迁移映射与当前主控目录冲突');
      }
      declared.set(value.oldUserId,value);
    }
    this.db.exec('BEGIN IMMEDIATE');try{for(const value of declared.values())this.db.prepare('INSERT OR IGNORE INTO executor_owner_mappings VALUES(?,?)').run(value.oldUserId,JSON.stringify(value));this.db.exec('COMMIT');}catch(error){this.db.exec('ROLLBACK');throw error;}
    migrateExecutorMessageScopes(this.db);
    const owners={...this.ownerMappings(),...Object.fromEntries(values.map(value=>[value.oldUserId,value.userId]))};
    this.db.prepare("INSERT INTO executor_metadata VALUES('owner-mappings',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(owners));
  }
  registerDirectory(directoryId: string, recipients: ExecutorRecipient[]): void {
    if (!/^[a-f0-9]{64}$/.test(directoryId) || !Array.isArray(recipients) || recipients.length > 100) throw new Error('动态主控目录无效。');
    for(const value of recipients){validateRecipient(value);assertOwnerRecipient(this.db,value);}
    if(new Set(recipients.map(value=>value.scope)).size!==recipients.length)throw new Error('动态主控目录归属重复');
    this.db.prepare('INSERT INTO executor_migration_directories VALUES(?,?) ON CONFLICT(directory_id) DO UPDATE SET recipients_json=excluded.recipients_json').run(directoryId,JSON.stringify(recipients));
    migrateExecutorMessageScopes(this.db);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const value of recipients) this.registerRecipient({ ...value, directoryId });
      const migratedIds=new Set(this.db.prepare('SELECT value_json FROM executor_owner_mappings').all().map(row=>JSON.parse(String(row.value_json)).controllerId));
      for (const old of this.recipients()) if ((old.directoryId === directoryId || old.directoryId === undefined && migratedIds.has(old.controllerId)) && !recipients.some(value => value.scope === old.scope))
        this.db.prepare('DELETE FROM recipients WHERE scope=?').run(old.scope);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  registerRecipient(value: ExecutorRecipient): void {
    this.requireCurrent();validateRecipient(value);assertOwnerRecipient(this.db,value);
    this.db.prepare('INSERT INTO recipients VALUES(?,?) ON CONFLICT(scope) DO UPDATE SET value_json=excluded.value_json').run(value.scope, JSON.stringify(value));
  }
  recipients(): ExecutorRecipient[] { this.requireCurrent(); return this.db.prepare('SELECT value_json FROM recipients ORDER BY scope').all().map(row => JSON.parse(String(row.value_json))); }
  private recipient(scope: string): ExecutorRecipient | undefined { return this.recipients().find(value => value.scope === scope); }
  private resolveRecipient(selector: string): ExecutorRecipient {
    const name = selector.trim().toLowerCase();
    const all = this.recipients(), exact = all.filter(value => value.controllerId.toLowerCase() === name || value.botId?.toLowerCase() === name);
    const matches = exact.length ? exact : all.filter(value => value.aliases.some(alias => alias.toLowerCase() === name));
    if (matches.length !== 1) throw new Error(matches.length ? `主控名称不唯一，请使用具体 controllerId：${matches.map(value => value.controllerId).join('、')}` : '未找到主控；先用 controllers 查看登记名称和 controllerId。');
    return matches[0]!;
  }
  bind(value: ExecutorBinding): void {
    this.requireCurrent();id(value.workerId);
    if (!/^[a-f0-9]{64}$/.test(value.scope) || !validController(value.controllerId) || value.scope !== executorScope(value.controllerId,value.userId) || !['codex', 'claude'].includes(value.agent)
      || typeof value.title !== 'string' || value.title.length > 2000 || typeof value.cwd !== 'string' || value.cwd.length > 8192
      || value.nativeId !== null && typeof value.nativeId !== 'string') throw new Error('会话归属无效。');
    const old = this.binding(value.workerId);
    if (old && (old.scope !== value.scope || old.userId !== value.userId || old.controllerId !== value.controllerId)) throw new Error('禁止将助手转绑到其他主控或用户。');
    this.db.prepare('INSERT INTO bindings VALUES(?,?,?) ON CONFLICT(worker_id) DO UPDATE SET value_json=excluded.value_json')
      .run(value.workerId, value.scope, JSON.stringify(value));
  }
  binding(workerId: string): ExecutorBinding | null {
    this.requireCurrent();
    const row = this.db.prepare('SELECT value_json FROM bindings WHERE worker_id=?').get(workerId);
    return row ? JSON.parse(String(row.value_json)) : null;
  }
  list(cwd?: string): ExecutorBinding[] {
    this.requireCurrent();
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
    this.requireCurrent();id(messageId); const r = this.db.prepare('SELECT * FROM messages WHERE id=?').get(messageId);
    const scope = r ? String(r.target_scope ?? '') : '';
    return r ? { id: String(r.id), workerId: r.worker_id ? String(r.worker_id) : null, text: String(r.text), state: r.state as ExecutorMessage['state'],
      ...(this.recipient(scope) ? { recipient: this.recipient(scope) } : {}), ...(r.sender_json ? { sender: JSON.parse(String(r.sender_json)) } : {}),
      reply: r.reply == null ? null : String(r.reply), createdAt: String(r.created_at) } : null;
  }
  pending(scope: string): ExecutorMessage[] {
    this.requireCurrent();return this.db.prepare("SELECT m.id FROM messages m WHERE m.target_scope=? AND m.state IN ('queued','accepted') ORDER BY m.rowid LIMIT 20")
      .all(scope).map(r => this.get(String(r.id))!);
  }
  update(scope: string, messageId: string, state: ExecutorMessage['state'], reply?: string): ExecutorMessage {
    const current = this.get(messageId);
    if (!current || this.db.prepare('SELECT target_scope FROM messages WHERE id=?').get(messageId)?.target_scope !== scope) throw new Error('消息不属于当前主控。');
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
