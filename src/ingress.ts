import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { OrderedInbox } from './inbox.js';
import type { DiscordAttachment, IncomingDM } from './types.js';

export interface DMHistoryOptions { after?: string; before?: string; limit?: number }
export interface DMHistoryPage {
  /** Authorized ordinary DMs only; pagination boundaries include bot messages too. */
  messages: IncomingDM[];
  oldestId: string | null;
  newestId: string | null;
  hasMore: boolean;
}
export type DMHistoryReader = (channelId: string, options: DMHistoryOptions) => Promise<DMHistoryPage>;
export interface IngressChannel { userId: string; channelId: string; cursor: string }
export interface DurableIngressOptions {
  allowedUserIds: string[];
  handle: (message: IncomingDM) => Promise<void>;
  /** Stamp scope/cancellation revision before entering the ordered preparation queue. */
  onQueued?: (message: IncomingDM, replayOnly: boolean) => void;
  /** Any state already durably accepted by SessionManager, including uncertain delivery. */
  hasMessage: (id: string) => boolean;
  isImmediate?: (message: IncomingDM) => boolean;
  onError?: (message: IncomingDM, error: unknown) => void;
  maxRecoveryPages?: number;
  pageSize?: number;
}
export type IngressState = 'received' | 'processing' | 'accepted' | 'failed';
interface IngressRow extends IncomingDM { state: IngressState; sequence: number }
const isSnowflake = (value: unknown): value is string => typeof value === 'string' && /^\d{1,20}$/.test(value);
const later = (left: string, right: string): string => BigInt(left) >= BigInt(right) ? left : right;
const control = (message: IncomingDM): boolean =>
  /^(?:\/(?:stop|new|cwd)(?:\s|$)|\/agent\s+\S|new\s+chat$|新会话$|新聊天$)/i.test(message.text.trim());

/**
 * Journal raw ordinary messages before attachment downloads or model execution.
 * The history cursor records a reconciled prefix, not merely the newest Gateway ID.
 * Interaction tokens intentionally have no representation in this database.
 */
export class DurableIngress {
  readonly path: string;
  private readonly db: DatabaseSync;
  private readonly users: Set<string>;
  private readonly inbox: OrderedInbox<IncomingDM>;
  private readonly jobs = new Map<string, Promise<void>>();
  private readonly stampedControls = new Set<string>();
  private readonly interactions = new Map<string, { message: IncomingDM; promise: Promise<void>;
    resolve: () => void; reject: (error: unknown) => void }>();
  private started = false;
  private closed = false;
  private recoveryBlocked = false;
  private recovering: Promise<void> | undefined;

  constructor(dataDir: string, private readonly options: DurableIngressOptions) {
    mkdirSync(dataDir, { recursive: true });
    this.path = join(dataDir, 'ingress.sqlite');
    this.db = new DatabaseSync(this.path);
    this.users = new Set(options.allowedUserIds);
    const pageSize = options.pageSize ?? 100;
    const maxPages = options.maxRecoveryPages ?? 25;
    if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100 ||
        !Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 1000) {
      this.db.close();
      throw new Error('收件补取页数或页面大小无效。');
    }
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS channels (
        channel_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, cursor TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE, user_id TEXT NOT NULL, channel_id TEXT NOT NULL,
        text TEXT NOT NULL, attachments_json TEXT NOT NULL,
        is_control INTEGER NOT NULL DEFAULT 0, is_interaction INTEGER NOT NULL DEFAULT 0,
        state TEXT NOT NULL, received_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS ingress_pending ON messages(state, sequence);
      UPDATE messages SET state = 'received' WHERE state = 'processing';
    `);
    const columns = new Set(this.db.prepare('PRAGMA table_info(messages)').all().map(row => String(row.name)));
    if (!columns.has('is_control')) {
      this.db.exec('ALTER TABLE messages ADD COLUMN is_control INTEGER NOT NULL DEFAULT 0');
      for (const row of this.db.prepare('SELECT id FROM messages').all()) {
        const message = this.getMessage(String(row.id))!;
        if ((this.options.isImmediate ?? control)(message)) this.db.prepare('UPDATE messages SET is_control=1 WHERE id=?').run(message.id);
      }
    }
    if (!columns.has('is_interaction')) this.db.exec('ALTER TABLE messages ADD COLUMN is_interaction INTEGER NOT NULL DEFAULT 0');
    this.inbox = new OrderedInbox(message => message.userId, async message => {
      if (this.closed) return;
      if (message.interaction) { await this.options.handle(message); return; }
      if (this.options.hasMessage(message.id)) { this.setState(message.id, 'accepted'); return; }
      this.setState(message.id, 'processing');
      try {
        await this.options.handle(message);
        if (!this.closed) this.setState(message.id, 'accepted');
      } catch (error) {
        if (!this.closed) {
          // SessionManager owns recovery once it has accepted the message. Never rerun
          // an uncertain model request or reply because ingress preparation rejected.
          this.setState(message.id, this.options.hasMessage(message.id) ? 'accepted' : 'failed');
          this.options.onError?.(message, error);
        }
      }
    });
  }

  /** Import only an existing trusted DM's latest persisted ID, never replay all history. */
  seedChannel(channel: IngressChannel): void {
    this.assertOpen();
    if (!this.users.has(channel.userId) || !isSnowflake(channel.channelId) || !isSnowflake(channel.cursor)) {
      throw new Error('已有私聊收件游标无效。');
    }
    const existing = this.db.prepare('SELECT user_id FROM channels WHERE channel_id = ?').get(channel.channelId);
    if (existing && existing.user_id !== channel.userId) throw new Error('私聊收件游标不属于当前用户。');
    this.db.prepare('INSERT OR IGNORE INTO channels(channel_id, user_id, cursor) VALUES (?, ?, ?)')
      .run(channel.channelId, channel.userId, channel.cursor);
  }

  knownChannels(): IngressChannel[] {
    this.assertOpen();
    return this.db.prepare('SELECT channel_id, user_id, cursor FROM channels ORDER BY channel_id').all()
      .filter(row => this.users.has(String(row.user_id)))
      .map(row => ({ channelId: String(row.channel_id), userId: String(row.user_id), cursor: String(row.cursor) }));
  }

  /** Synchronous Gateway hook. Throws before acknowledgement if journaling fails. */
  capture(message: IncomingDM): boolean {
    this.assertOpen();
    if (message.interaction) throw new Error('交互凭据不能写入持久收件箱。');
    if (!this.users.has(message.userId) || !isSnowflake(message.id) || !isSnowflake(message.channelId) ||
        typeof message.text !== 'string' || !Array.isArray(message.attachments)) return false;
    const channel = this.db.prepare('SELECT user_id, cursor FROM channels WHERE channel_id = ?').get(message.channelId);
    if (channel && channel.user_id !== message.userId) return false;
    // Copy only the declared attachment fields, never arbitrary transport metadata.
    const attachments: DiscordAttachment[] = message.attachments.map(item => ({
      id: item.id, filename: item.filename, url: item.url, size: item.size,
      ...(item.content_type === undefined ? {} : { content_type: item.content_type }),
    }));
    const now = new Date().toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT OR IGNORE INTO channels(channel_id, user_id, cursor) VALUES (?, ?, ?)')
        .run(message.channelId, message.userId, message.id);
      const result = this.db.prepare(`INSERT OR IGNORE INTO messages
        (id, user_id, channel_id, text, attachments_json, is_control, state, received_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'received', ?, ?)`).run(message.id, message.userId, message.channelId,
          message.text, JSON.stringify(attachments), (this.options.isImmediate ?? control)(message) ? 1 : 0, now, now);
      if (Number(result.changes) === 0) {
        // REST returns refreshed signed CDN URLs after an outage; keep the original text.
        this.db.prepare(`UPDATE messages SET attachments_json = ?, updated_at = ?
          WHERE id = ? AND state = 'received'`).run(JSON.stringify(attachments), now, message.id);
      }
      if (this.started && !this.recoveryBlocked && !this.recovering && channel) {
        this.db.prepare('UPDATE channels SET cursor = ? WHERE channel_id = ?')
          .run(later(String(channel.cursor), message.id), message.channelId);
      }
      this.db.exec('COMMIT');
      return Number(result.changes) === 1;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  /** Resolves on durable receipt; processing failures go to onError, not Gateway. */
  async receive(message: IncomingDM): Promise<void> {
    this.assertOpen();
    if (message.interaction) {
      if (!this.users.has(message.userId) || !isSnowflake(message.id) || !isSnowflake(message.channelId)) {
        throw new Error('私聊交互不属于已授权用户。');
      }
      const pending = this.interactions.get(message.id);
      if (pending) { await pending.promise; return; }
      const immediate = (this.options.isImmediate ?? control)(message);
      if (immediate) {
        const now = new Date().toISOString();
        // Discord has ACKed this interaction. Persist only its cancellation boundary,
        // never its credentials or an executable command to replay after a restart.
        this.db.prepare(`INSERT OR IGNORE INTO messages
          (id,user_id,channel_id,text,attachments_json,is_control,is_interaction,state,received_at,updated_at)
          VALUES (?,?,?,?, '[]',1,1,'accepted',?,?)`).run(message.id, message.userId, message.channelId, message.text, now, now);
      }
      let resolve!: () => void;
      let reject!: (error: unknown) => void;
      const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
      this.interactions.set(message.id, { message, promise, resolve, reject });
      this.kick();
      await promise;
      return;
    }
    this.capture(message);
    this.kick();
  }

  /** Call after SessionManager.recover(); live input received during startup stays journaled. */
  start(): void { this.assertOpen(); this.started = true; this.kick(); }

  /** READY/RESUMED hook; new live input is journaled while older gaps are fetched. */
  recover(reader: DMHistoryReader): Promise<void> {
    this.assertOpen();
    if (this.recovering) return this.recovering;
    this.recoveryBlocked = true;
    const work = this.reconcile(reader);
    this.recovering = work;
    void work.then(() => {
      this.recovering = undefined;
      this.recoveryBlocked = false;
      this.kick();
    }, () => { this.recovering = undefined; /* fail closed; a later READY can retry */ });
    return work;
  }

  getMessage(id: string): IngressRow | null {
    this.assertOpen();
    const row = this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id);
    return row ? { id: String(row.id), userId: String(row.user_id), channelId: String(row.channel_id),
      text: String(row.text), attachments: JSON.parse(String(row.attachments_json)) as DiscordAttachment[],
      state: String(row.state) as IngressState, sequence: Number(row.sequence) } : null;
  }

  async whenIdle(): Promise<void> { while (this.jobs.size) await Promise.allSettled([...this.jobs.values()]); }

  /** Stop accepting input; unfinished preparation remains recoverable on the next startup. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.interactions.values()) pending.reject(new Error('持久收件箱已关闭。'));
    this.interactions.clear();
    await this.recovering?.catch(() => undefined);
    this.db.close();
  }

  private async reconcile(reader: DMHistoryReader): Promise<void> {
    const limit = this.options.pageSize ?? 100;
    const maxPages = this.options.maxRecoveryPages ?? 25;
    // Snapshot old cursors before any REST call. Gateway messages cannot move them here.
    for (const channel of this.knownChannels()) {
      let before: string | undefined;
      let high = channel.cursor;
      let complete = false;
      for (let pageNumber = 0; pageNumber < maxPages; pageNumber++) {
        if (this.closed) return;
        // Start at the newest page, then walk backwards to the known cursor.
        // Discord's `after` pagination advances from the earliest matching page.
        const page = await reader(channel.channelId, { limit, ...(before ? { before } : {}) });
        if (this.closed) return;
        if ((page.oldestId !== null && !isSnowflake(page.oldestId)) ||
            (page.newestId !== null && !isSnowflake(page.newestId)) ||
            (page.hasMore && page.oldestId === null)) throw new Error('Discord 历史分页边界无效。');
        if (page.newestId) high = later(high, page.newestId);
        for (const message of page.messages) {
          if (message.channelId !== channel.channelId || message.userId !== channel.userId || message.interaction ||
              !isSnowflake(message.id) || BigInt(message.id) <= BigInt(channel.cursor)) continue;
          this.capture(message);
        }
        if (!page.hasMore || (page.oldestId !== null && BigInt(page.oldestId) <= BigInt(channel.cursor))) {
          complete = true; break;
        }
        if (before && page.oldestId !== null && BigInt(page.oldestId) >= BigInt(before)) {
          throw new Error('Discord 历史分页没有前进，收件游标已保留。');
        }
        before = page.oldestId ?? undefined;
      }
      if (!complete) throw new Error('Discord 停机期间消息超过补取页数，收件游标已保留。');
      const newest = this.db.prepare(`SELECT id FROM messages WHERE channel_id = ? AND is_interaction = 0
        ORDER BY length(id) DESC, id DESC LIMIT 1`).get(channel.channelId);
      if (newest) high = later(high, String(newest.id));
      this.db.prepare('UPDATE channels SET cursor = ? WHERE channel_id = ?').run(high, channel.channelId);
    }
  }

  private kick(): void {
    if (!this.started || this.closed || this.recoveryBlocked || this.recovering) return;
    const rows = this.db.prepare(`SELECT id,state,is_control FROM messages WHERE state = 'received' OR is_control = 1`).all();
    const entries = new Map(rows.map(row => [String(row.id), row]));
    for (const [id, pending] of this.interactions) if (!entries.has(id)) {
      entries.set(id, { id, state: 'memory', is_control: (this.options.isImmediate ?? control)(pending.message) ? 1 : 0 });
    }
    const ordered = [...entries.values()].sort((left, right) => BigInt(String(left.id)) < BigInt(String(right.id)) ? -1 :
      BigInt(String(left.id)) > BigInt(String(right.id)) ? 1 : 0);
    for (const row of ordered) {
      const id = String(row.id);
      const pending = this.interactions.get(id);
      if (pending) {
        if (this.jobs.has(id)) continue;
        this.options.onQueued?.(pending.message, false);
        const immediate = (this.options.isImmediate ?? control)(pending.message);
        if (immediate) this.stampedControls.add(id);
        const job = this.inbox.handle(pending.message, immediate);
        this.jobs.set(id, job);
        void job.then(pending.resolve, pending.reject).finally(() => {
          this.interactions.delete(id);
          if (this.jobs.get(id) === job) this.jobs.delete(id);
        }).catch(() => undefined);
        continue;
      }
      const isControl = Number(row.is_control) === 1;
      if (row.state !== 'received' && (!isControl || this.stampedControls.has(id))) continue;
      if (this.jobs.has(id) && (!isControl || this.stampedControls.has(id))) continue;
      const message = this.getMessage(id)!;
      if (!this.users.has(message.userId)) continue;
      const admitted = this.options.hasMessage(id);
      if (isControl && !this.stampedControls.has(id)) {
        this.options.onQueued?.(message, row.state !== 'received' || admitted);
        this.stampedControls.add(id);
      }
      if (row.state !== 'received') continue;
      if (admitted) { this.setState(id, 'accepted'); continue; }
      if (!isControl) this.options.onQueued?.(message, false);
      const job = this.inbox.handle(message, (this.options.isImmediate ?? control)(message));
      this.jobs.set(id, job);
      void job.finally(() => { if (this.jobs.get(id) === job) this.jobs.delete(id); }).catch(() => undefined);
    }
  }

  private setState(id: string, state: IngressState): void {
    this.db.prepare('UPDATE messages SET state = ?, updated_at = ? WHERE id = ?')
      .run(state, new Date().toISOString(), id);
  }
  private assertOpen(): void { if (this.closed) throw new Error('持久收件箱已关闭。'); }
}
