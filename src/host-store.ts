import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import type { AgentName, BridgePlatform } from './types.js';

type Row = Record<string, string | number | bigint | Uint8Array | null>;
export type HostReplyAddress = Readonly<Record<string, string>>;
export class HostStateError extends Error {
  constructor(readonly code: 'not-found' | 'conflict' | 'forbidden' | 'stale' | 'blocked', message: string) {
    super(message); this.name = 'HostStateError';
  }
}
export interface HostController {
  conversationId: string; generation: number; agent: AgentName; nativeId: string | null;
  model?: string | null; effort?: string | null;
}
export interface HostBot {
  botId: string; platform: BridgePlatform; applicationId: string; ownerPrincipalId: string | null;
  controller: HostController | null; ready: boolean;
}
export interface HostGroup {
  spaceId: string; principalId: string; receiverBotId: string; memberBotIds: string[];
  epoch: number; revision: number; enabled: boolean; pauseReason: string | null;
}
export interface HostRoot {
  id: string; spaceId: string; principalId: string; sourceEventId: string;
  targetBotIds: string[]; generations: Record<string, number>; replyTo: HostReplyAddress;
  epoch: number; revision: number; automaticLimit: number; automaticUsed: number; automaticReserved: number;
  exhaustionNotified: boolean;
}
export type HostEventKind = 'human' | 'observation' | 'consultation' | 'handoff' | 'assistant-result' | 'wake';
export type HostEventState = 'queued' | 'reserved' | 'running' | 'completed' | 'silent' | 'failed' | 'cancelled' | 'uncertain';
export interface HostEvent {
  id: string; sequence: number; logicalId: string; rootId: string; botId: string; generation: number;
  kind: HostEventKind; state: HostEventState; payload: unknown; publicCursor: number;
  initial: boolean; automatic: boolean; decision: 'published' | 'silent' | null; nativeEnded: boolean;
  causeEventId: string | null; sourceBotId: string | null; error: string | null;
}
export interface HostContextRecord {
  sequence: number; id: string; spaceId: string; epoch: number; receivedAt: string;
  source: { botId: string; messageId: string; userId: string; channelId: string; authorType: string; textTruncated?: true; authorName?: string; time?: string; mentionedUserIds: string[]; replyToMessageId?: string };
  text: string; attachments: unknown[]; canAuthorize: boolean;
}
export interface HostPublicMessage {
  sequence: number; id: string; rootId: string; spaceId: string; epoch: number;
  authorBotId: string | null; principalId: string; text: string; attachments: unknown[];
}
export interface HostOutbox {
  id: string; eventId: string; botId: string; generation: number; rootId: string;
  audience: 'group' | 'direct' | 'private'; targetBotIds: string[]; replyTo: HostReplyAddress;
  payload: unknown; state: 'registered' | 'sending' | 'delivered' | 'uncertain' | 'rejected';
  evidence: string | null;
}
export interface RoutedDeliverySource {
  botId: string; principalId: string; conversationId: string; generation: number;
  messageId: string; userId: string; channelId: string;
  eventId?: string; rootId?: string; spaceId?: string; bindingEpoch?: number;
}
export interface RoutedDeliveryTarget {
  id: string; kind: 'private' | 'group'; botId: string; principalId: string; channelId: string;
  userId?: string; spaceId?: string; epoch?: number; revision?: number;
}
export interface RoutedDelivery {
  id: string; source: RoutedDeliverySource; target: RoutedDeliveryTarget; payload: { text: string; paths: string[] };
  state: 'registered' | 'sending' | 'delivered' | 'uncertain' | 'rejected'; evidence: string | null;
}
export interface HostTask {
  id: string; rootId: string; spaceId: string; ownerBotId: string; generation: number;
  title: string; resources: string[]; replyTo: HostReplyAddress;
  state: 'active' | 'completed' | 'cancelled'; executionStoppedProof: string | null;
}
export interface HostHandoff {
  id: string; taskId: string; fromBotId: string; toBotId: string; fromGeneration: number; toGeneration: number;
  state: 'proposed' | 'accepted' | 'rejected' | 'cancelled'; summary: string; evidence: string | null;
}
export interface HostBatchMember {
  botId: string; previousGeneration: number; cancellation: 'pending' | 'confirmed' | 'blocked';
  cancellationDetail: string | null; prepared: HostController | null;
  initialization: 'pending' | 'ready' | 'failed'; initializationDetail: string | null;
}
export interface HostBatchReset {
  id: string; principalId: string; spaceId: string | null;
  state: 'frozen' | 'cancelling' | 'prepared' | 'committed' | 'initializing' | 'completed' | 'blocked' | 'cancelled';
  epoch: number | null; revision: number | null; members: HostBatchMember[]; error: string | null;
}
export interface HostControllerSwitch {
  id: string; botId: string; fromController: HostController; toController: HostController;
}

const parse = <T>(value: Row[string] | undefined): T => JSON.parse(String(value)) as T;
const sorted = (items: readonly string[]): string[] => [...new Set(items)].sort();
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
function required(value: string, label: string): void {
  if (!value.trim()) throw new HostStateError('conflict', `${label} must not be empty`);
}
function bot(row: Row): HostBot {
  return { botId: String(row.bot_id), platform: String(row.platform) as BridgePlatform,
    applicationId: String(row.application_id), ownerPrincipalId: row.owner_id === null ? null : String(row.owner_id),
    controller: row.controller_json === null ? null : parse<HostController>(row.controller_json), ready: Number(row.ready) === 1 };
}
function group(row: Row): HostGroup {
  return { spaceId: String(row.space_id), principalId: String(row.principal_id), receiverBotId: String(row.receiver_bot_id),
    memberBotIds: parse<string[]>(row.members_json), epoch: Number(row.epoch), revision: Number(row.revision),
    enabled: Number(row.enabled) === 1, pauseReason: row.pause_reason === null ? null : String(row.pause_reason) };
}
function root(row: Row): HostRoot {
  return { id: String(row.id), spaceId: String(row.space_id), principalId: String(row.principal_id), sourceEventId: String(row.source_event_id),
    targetBotIds: parse<string[]>(row.targets_json), generations: parse<Record<string, number>>(row.generations_json),
    replyTo: parse<HostReplyAddress>(row.reply_json), epoch: Number(row.epoch), revision: Number(row.revision),
    automaticLimit: Number(row.auto_limit), automaticUsed: Number(row.auto_used), automaticReserved: Number(row.auto_reserved),
    exhaustionNotified: Number(row.exhaustion_notified) === 1 };
}
function event(row: Row): HostEvent {
  return { id: String(row.id), sequence: Number(row.sequence), logicalId: String(row.logical_id), rootId: String(row.root_id),
    botId: String(row.bot_id), generation: Number(row.generation), kind: String(row.kind) as HostEventKind,
    state: String(row.state) as HostEventState, payload: parse<unknown>(row.payload_json), publicCursor: Number(row.public_cursor),
    initial: Number(row.initial) === 1, automatic: Number(row.automatic) === 1,
    decision: row.decision === null ? null : String(row.decision) as HostEvent['decision'], nativeEnded: Number(row.native_ended) === 1,
    causeEventId: row.cause_event_id === null ? null : String(row.cause_event_id),
    sourceBotId: row.source_bot_id === null ? null : String(row.source_bot_id), error: row.error === null ? null : String(row.error) };
}
function outbox(row: Row): HostOutbox {
  return { id: String(row.id), eventId: String(row.event_id), botId: String(row.bot_id), generation: Number(row.generation),
    rootId: String(row.root_id), audience: String(row.audience) as HostOutbox['audience'], targetBotIds: parse<string[]>(row.targets_json),
    replyTo: parse<HostReplyAddress>(row.reply_json), payload: parse<unknown>(row.payload_json),
    state: String(row.state) as HostOutbox['state'], evidence: row.evidence === null ? null : String(row.evidence) };
}
function task(row: Row): HostTask {
  return { id: String(row.id), rootId: String(row.root_id), spaceId: String(row.space_id), ownerBotId: String(row.owner_bot_id),
    generation: Number(row.generation), title: String(row.title), resources: parse<string[]>(row.resources_json),
    replyTo: parse<HostReplyAddress>(row.reply_json), state: String(row.state) as HostTask['state'],
    executionStoppedProof: row.stopped_proof === null ? null : String(row.stopped_proof) };
}
function handoff(row: Row): HostHandoff {
  return { id: String(row.id), taskId: String(row.task_id), fromBotId: String(row.from_bot_id), toBotId: String(row.to_bot_id),
    fromGeneration: Number(row.from_generation), toGeneration: Number(row.to_generation), state: String(row.state) as HostHandoff['state'],
    summary: String(row.summary), evidence: row.evidence === null ? null : String(row.evidence) };
}

/** Host authority. Bot databases keep historical sessions, but never another current pointer. */
export class HostStore {
  readonly path: string;
  private readonly db: DatabaseSync;
  private closed = false;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.path = join(dataDir, 'host.sqlite');
    this.db = new DatabaseSync(this.path);
    this.db.exec(`
      PRAGMA busy_timeout=5000;
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
      PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS host_principals(id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE IF NOT EXISTS host_bots(
        bot_id TEXT PRIMARY KEY, platform TEXT NOT NULL, application_id TEXT NOT NULL,
        owner_id TEXT REFERENCES host_principals(id), controller_json TEXT, ready INTEGER NOT NULL DEFAULT 0,
        UNIQUE(platform,application_id));
      CREATE TABLE IF NOT EXISTS host_principal_maps(
        bot_id TEXT NOT NULL REFERENCES host_bots(bot_id), platform_user_id TEXT NOT NULL,
        principal_id TEXT NOT NULL REFERENCES host_principals(id), proof TEXT NOT NULL,
        PRIMARY KEY(bot_id,platform_user_id), UNIQUE(bot_id,principal_id));
      CREATE TABLE IF NOT EXISTS host_space_maps(
        bot_id TEXT NOT NULL REFERENCES host_bots(bot_id), platform_space_id TEXT NOT NULL,
        space_id TEXT NOT NULL, proof TEXT NOT NULL, PRIMARY KEY(bot_id,platform_space_id), UNIQUE(bot_id,space_id));
      CREATE TABLE IF NOT EXISTS host_groups(
        space_id TEXT PRIMARY KEY, principal_id TEXT NOT NULL REFERENCES host_principals(id),
        receiver_bot_id TEXT NOT NULL REFERENCES host_bots(bot_id), members_json TEXT NOT NULL,
        epoch INTEGER NOT NULL, revision INTEGER NOT NULL, enabled INTEGER NOT NULL, pause_reason TEXT);
      CREATE TABLE IF NOT EXISTS host_ingress(
        id TEXT PRIMARY KEY, space_id TEXT NOT NULL, receiver_bot_id TEXT NOT NULL, payload_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS host_roots(
        id TEXT PRIMARY KEY, space_id TEXT NOT NULL REFERENCES host_groups(space_id), principal_id TEXT NOT NULL,
        source_event_id TEXT NOT NULL, targets_json TEXT NOT NULL, generations_json TEXT NOT NULL, reply_json TEXT NOT NULL,
        epoch INTEGER NOT NULL, revision INTEGER NOT NULL, auto_limit INTEGER NOT NULL,
        auto_used INTEGER NOT NULL DEFAULT 0, auto_reserved INTEGER NOT NULL DEFAULT 0,
        exhaustion_notified INTEGER NOT NULL DEFAULT 0, UNIQUE(space_id,source_event_id));
      CREATE TABLE IF NOT EXISTS host_events(
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, logical_id TEXT NOT NULL,
        root_id TEXT NOT NULL REFERENCES host_roots(id), bot_id TEXT NOT NULL REFERENCES host_bots(bot_id),
        generation INTEGER NOT NULL, kind TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'queued', payload_json TEXT NOT NULL,
        public_cursor INTEGER NOT NULL DEFAULT 0, initial INTEGER NOT NULL, automatic INTEGER NOT NULL,
        decision TEXT, native_ended INTEGER NOT NULL DEFAULT 0, cause_event_id TEXT, source_bot_id TEXT, error TEXT);
      CREATE INDEX IF NOT EXISTS host_event_queue ON host_events(bot_id,state,sequence);
      CREATE UNIQUE INDEX IF NOT EXISTS host_event_slot ON host_events(bot_id) WHERE state IN ('reserved','running','uncertain');
      CREATE TABLE IF NOT EXISTS host_deliveries(
        logical_id TEXT NOT NULL, bot_id TEXT NOT NULL, generation INTEGER NOT NULL,
        event_id TEXT NOT NULL REFERENCES host_events(id), PRIMARY KEY(logical_id,bot_id,generation));
      CREATE TABLE IF NOT EXISTS host_initial_participation(
        root_id TEXT NOT NULL REFERENCES host_roots(id), bot_id TEXT NOT NULL, event_id TEXT NOT NULL UNIQUE,
        PRIMARY KEY(root_id,bot_id));
      CREATE TABLE IF NOT EXISTS host_public_log(
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, root_id TEXT NOT NULL REFERENCES host_roots(id),
        space_id TEXT NOT NULL, epoch INTEGER NOT NULL, author_bot_id TEXT, principal_id TEXT NOT NULL,
        text TEXT NOT NULL, attachments_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS host_context_records(
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,space_id TEXT NOT NULL,epoch INTEGER NOT NULL,
        source_json TEXT NOT NULL,text TEXT NOT NULL,attachments_json TEXT NOT NULL,can_authorize INTEGER NOT NULL,received_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS host_context_cursors(
        bot_id TEXT NOT NULL,space_id TEXT NOT NULL,epoch INTEGER NOT NULL,cursor INTEGER NOT NULL,PRIMARY KEY(bot_id,space_id,epoch));
      CREATE TABLE IF NOT EXISTS host_public_cursors(
        bot_id TEXT NOT NULL, space_id TEXT NOT NULL, epoch INTEGER NOT NULL, cursor INTEGER NOT NULL,
        PRIMARY KEY(bot_id,space_id,epoch));
      CREATE TABLE IF NOT EXISTS host_outbox(
        id TEXT PRIMARY KEY, event_id TEXT NOT NULL REFERENCES host_events(id), bot_id TEXT NOT NULL, generation INTEGER NOT NULL,
        root_id TEXT NOT NULL, audience TEXT NOT NULL, targets_json TEXT NOT NULL, reply_json TEXT NOT NULL,
        payload_json TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'registered', evidence TEXT);
      CREATE TABLE IF NOT EXISTS host_routed_outbox(
        id TEXT PRIMARY KEY, source_json TEXT NOT NULL, target_json TEXT NOT NULL, payload_json TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'registered', evidence TEXT);
      CREATE TABLE IF NOT EXISTS host_tasks(
        id TEXT PRIMARY KEY, root_id TEXT NOT NULL REFERENCES host_roots(id), space_id TEXT NOT NULL,
        owner_bot_id TEXT NOT NULL, generation INTEGER NOT NULL, title TEXT NOT NULL,
        resources_json TEXT NOT NULL, reply_json TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'active', stopped_proof TEXT);
      CREATE TABLE IF NOT EXISTS host_resource_claims(resource TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES host_tasks(id));
      CREATE TABLE IF NOT EXISTS host_task_workers(
        bot_id TEXT NOT NULL REFERENCES host_bots(bot_id), worker_id TEXT NOT NULL,
        task_id TEXT NOT NULL REFERENCES host_tasks(id), PRIMARY KEY(bot_id,worker_id));
      CREATE TABLE IF NOT EXISTS host_handoffs(
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES host_tasks(id), from_bot_id TEXT NOT NULL, to_bot_id TEXT NOT NULL,
        from_generation INTEGER NOT NULL, to_generation INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'proposed',
        summary TEXT NOT NULL, evidence TEXT);
      CREATE UNIQUE INDEX IF NOT EXISTS host_pending_handoff ON host_handoffs(task_id) WHERE state='proposed';
      CREATE TABLE IF NOT EXISTS host_batches(
        id TEXT PRIMARY KEY, principal_id TEXT NOT NULL, space_id TEXT, epoch INTEGER, revision INTEGER,
        state TEXT NOT NULL DEFAULT 'frozen', error TEXT);
      CREATE TABLE IF NOT EXISTS host_batch_members(
        operation_id TEXT NOT NULL REFERENCES host_batches(id), bot_id TEXT NOT NULL REFERENCES host_bots(bot_id),
        previous_generation INTEGER NOT NULL, cancellation TEXT NOT NULL DEFAULT 'pending', cancellation_detail TEXT,
        prepared_json TEXT, initialization TEXT NOT NULL DEFAULT 'pending', initialization_detail TEXT,
        PRIMARY KEY(operation_id,bot_id));
      CREATE TABLE IF NOT EXISTS host_control_locks(bot_id TEXT PRIMARY KEY, operation_id TEXT NOT NULL REFERENCES host_batches(id));
      CREATE TABLE IF NOT EXISTS host_controller_switches(
        id TEXT PRIMARY KEY, bot_id TEXT NOT NULL REFERENCES host_bots(bot_id), from_json TEXT NOT NULL, to_json TEXT NOT NULL);
    `);
  }

  close(): void { if (!this.closed) { this.db.close(); this.closed = true; } }
  private one(sql: string, ...args: SQLInputValue[]): Row | undefined { return this.db.prepare(sql).get(...args); }
  private rows(sql: string, ...args: SQLInputValue[]): Row[] { return this.db.prepare(sql).all(...args); }
  private run(sql: string, ...args: SQLInputValue[]): number { return Number(this.db.prepare(sql).run(...args).changes); }
  private atomic<T>(action: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = action(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  private mustBot(botId: string): HostBot {
    const value = this.getBot(botId); if (!value) throw new HostStateError('not-found', `Unknown bot: ${botId}`); return value;
  }
  private mustRoot(rootId: string): HostRoot {
    const value = this.getRoot(rootId); if (!value) throw new HostStateError('not-found', `Unknown root: ${rootId}`); return value;
  }
  private mustEvent(id: string): HostEvent {
    const value = this.getEvent(id); if (!value) throw new HostStateError('not-found', `Unknown event: ${id}`); return value;
  }
  private assertPrincipal(principalId: string): void {
    if (!this.one('SELECT 1 FROM host_principals WHERE id=? AND enabled=1', principalId)) {
      throw new HostStateError('forbidden', 'Principal is unknown or revoked');
    }
  }
  private assertMapped(botId: string, principalId: string): void {
    this.assertPrincipal(principalId);
    if (!this.one('SELECT 1 FROM host_principal_maps WHERE bot_id=? AND principal_id=?', botId, principalId)) {
      throw new HostStateError('forbidden', `Principal has no verified account mapping for ${botId}`);
    }
  }
  private assertMember(spaceId: string, botId: string, principalId: string, epoch?: number): HostGroup {
    this.assertMapped(botId, principalId);
    const value = this.getGroup(spaceId);
    if (!value?.enabled || value.principalId !== principalId || !value.memberBotIds.includes(botId)) {
      throw new HostStateError('forbidden', 'Group is disabled or bot/principal is no longer a member');
    }
    if (epoch !== undefined && value.epoch !== epoch) throw new HostStateError('stale', 'Group binding epoch changed');
    const owner = this.mustBot(botId).ownerPrincipalId;
    if (owner !== null && owner !== principalId) throw new HostStateError('forbidden', 'Bot belongs to another principal');
    return value;
  }
  private assertCurrent(botId: string, generation: number): HostBot {
    const value = this.mustBot(botId);
    if (!value.controller || value.controller.generation !== generation) throw new HostStateError('stale', 'Controller generation changed');
    return value;
  }
  private validateEvent(value: HostEvent): HostRoot {
    const source = this.mustRoot(value.rootId);
    this.assertMember(source.spaceId, value.botId, source.principalId, source.epoch);
    const current = this.assertCurrent(value.botId, value.generation);
    if (!current.ready) throw new HostStateError('blocked', 'Controller initialization is incomplete');
    if (value.sourceBotId) this.assertMember(source.spaceId, value.sourceBotId, source.principalId, source.epoch);
    return source;
  }

  registerBot(input: { botId: string; platform: BridgePlatform; applicationId: string; ownerPrincipalId?: string }): HostBot {
    required(input.botId, 'botId'); required(input.applicationId, 'applicationId');
    if (input.botId !== `${input.platform}:${input.applicationId}`) throw new HostStateError('conflict', 'botId must contain the verified platform/application identity');
    return this.atomic(() => {
      const previous = this.getBot(input.botId);
      if (previous && (previous.platform !== input.platform || previous.applicationId !== input.applicationId)) {
        throw new HostStateError('conflict', 'Registered bot identity cannot change');
      }
      if (input.ownerPrincipalId) this.run('INSERT OR IGNORE INTO host_principals(id) VALUES (?)', input.ownerPrincipalId);
      if (previous?.ownerPrincipalId && input.ownerPrincipalId && previous.ownerPrincipalId !== input.ownerPrincipalId) {
        throw new HostStateError('forbidden', 'Bot owner cannot be transferred');
      }
      if (!previous) this.run('INSERT INTO host_bots(bot_id,platform,application_id,owner_id) VALUES (?,?,?,?)',
        input.botId, input.platform, input.applicationId, input.ownerPrincipalId ?? null);
      else if (input.ownerPrincipalId && !previous.ownerPrincipalId) this.run('UPDATE host_bots SET owner_id=? WHERE bot_id=?', input.ownerPrincipalId, input.botId);
      return this.mustBot(input.botId);
    });
  }
  mapPrincipal(input: { principalId: string; botId: string; platformUserId: string; proof: string }): void {
    required(input.principalId, 'principalId'); required(input.platformUserId, 'platformUserId'); required(input.proof, 'Mapping proof');
    this.atomic(() => {
      this.mustBot(input.botId);
      this.run('INSERT OR IGNORE INTO host_principals(id) VALUES (?)', input.principalId);
      const existing = this.one('SELECT * FROM host_principal_maps WHERE bot_id=? AND (platform_user_id=? OR principal_id=?)', input.botId, input.platformUserId, input.principalId);
      if (existing && (existing.platform_user_id !== input.platformUserId || existing.principal_id !== input.principalId)) {
        throw new HostStateError('conflict', 'Principal mapping is immutable; names cannot establish equivalence');
      }
      this.run('INSERT OR IGNORE INTO host_principal_maps(bot_id,platform_user_id,principal_id,proof) VALUES (?,?,?,?)', input.botId, input.platformUserId, input.principalId, input.proof);
    });
  }
  resolvePrincipal(botId: string, platformUserId: string): string | null {
    const value = this.one(`SELECT m.principal_id FROM host_principal_maps m JOIN host_principals p ON p.id=m.principal_id
      WHERE m.bot_id=? AND m.platform_user_id=? AND p.enabled=1`, botId, platformUserId);
    return value ? String(value.principal_id) : null;
  }
  mapSpace(input: { botId: string; platformSpaceId: string; spaceId: string; proof: string }): void {
    required(input.platformSpaceId, 'platformSpaceId'); required(input.spaceId, 'spaceId'); required(input.proof, 'Mapping proof');
    this.atomic(() => {
      this.mustBot(input.botId);
      const previous = this.one('SELECT * FROM host_space_maps WHERE bot_id=? AND (platform_space_id=? OR space_id=?)', input.botId, input.platformSpaceId, input.spaceId);
      if (previous && (previous.space_id !== input.spaceId || previous.platform_space_id !== input.platformSpaceId)) throw new HostStateError('conflict', 'Space mapping is immutable');
      this.run('INSERT OR IGNORE INTO host_space_maps(bot_id,platform_space_id,space_id,proof) VALUES (?,?,?,?)', input.botId, input.platformSpaceId, input.spaceId, input.proof);
    });
  }
  resolveSpace(botId: string, platformSpaceId: string): string | null {
    const value = this.one('SELECT space_id FROM host_space_maps WHERE bot_id=? AND platform_space_id=?', botId, platformSpaceId);
    return value ? String(value.space_id) : null;
  }
  setPrincipalEnabled(principalId: string, enabled: boolean): void {
    this.atomic(() => {
      if (!this.run('UPDATE host_principals SET enabled=? WHERE id=?', Number(enabled), principalId)) throw new HostStateError('not-found', 'Unknown principal');
      if (!enabled) {
        for (const row of this.rows('SELECT space_id FROM host_groups WHERE principal_id=? AND enabled=1', principalId)) this.stopGroupInner(String(row.space_id), 'principal-revoked');
      }
    });
  }
  claimOwner(botId: string, principalId: string): HostBot {
    return this.atomic(() => {
      this.assertMapped(botId, principalId);
      const value = this.mustBot(botId);
      if (value.ownerPrincipalId && value.ownerPrincipalId !== principalId) throw new HostStateError('forbidden', 'Bot is already owned');
      this.run('UPDATE host_bots SET owner_id=? WHERE bot_id=? AND owner_id IS NULL', principalId, botId);
      return this.mustBot(botId);
    });
  }
  getBot(botId: string): HostBot | null { const row = this.one('SELECT * FROM host_bots WHERE bot_id=?', botId); return row ? bot(row) : null; }
  listBots(): HostBot[] { return this.rows('SELECT * FROM host_bots ORDER BY bot_id').map(bot); }
  getController(botId: string): HostController | null { return this.mustBot(botId).controller; }
  setController(botId: string, principalId: string, controller: HostController, expectedGeneration: number, ready = true): void {
    this.atomic(() => {
      this.assertMapped(botId, principalId);
      const value = this.mustBot(botId);
      if (value.ownerPrincipalId !== principalId) throw new HostStateError('forbidden', 'Claim owner before creating a controller');
      this.assertControllerChange(botId, controller, expectedGeneration);
      this.run('UPDATE host_bots SET controller_json=?,ready=? WHERE bot_id=?', JSON.stringify(controller), Number(ready), botId);
      this.invalidateGeneration(botId, expectedGeneration);
    });
  }
  /** Prepared backend changes preserve logical work; /new deliberately uses setController instead. */
  replaceControllerForAgentSwitch(botId: string, principalId: string, controller: HostController,
    expectedGeneration: number, operationId = `${botId}/${controller.conversationId}`): void {
    this.atomic(() => {
      this.assertMapped(botId, principalId);
      const prior = this.one('SELECT * FROM host_controller_switches WHERE id=?', operationId);
      if (prior) {
        if (prior.bot_id !== botId || !same(parse<HostController>(prior.to_json), controller)) throw new HostStateError('conflict', 'Agent switch operation identity reused');
        return;
      }
      const previous = this.mustBot(botId);
      if (previous.ownerPrincipalId !== principalId || !previous.controller) throw new HostStateError('forbidden', 'Agent switch requires the owned current controller');
      if (previous.controller.agent === controller.agent) throw new HostStateError('conflict', 'Selecting the current backend must preserve the native session');
      this.assertControllerChange(botId, controller, expectedGeneration);
      this.run('INSERT INTO host_controller_switches(id,bot_id,from_json,to_json) VALUES (?,?,?,?)', operationId, botId,
        JSON.stringify(previous.controller), JSON.stringify(controller));
      this.run('UPDATE host_bots SET controller_json=?,ready=1 WHERE bot_id=?', JSON.stringify(controller), botId);
      this.run("UPDATE host_events SET generation=? WHERE bot_id=? AND generation=? AND state IN ('queued','reserved')", controller.generation, botId, expectedGeneration);
      // Dedup aliases move with pending delivery, while completed historical events keep their original generation.
      this.run(`UPDATE host_deliveries SET generation=? WHERE bot_id=? AND generation=?
        AND event_id IN (SELECT id FROM host_events WHERE bot_id=? AND generation=? AND state IN ('queued','reserved'))`,
      controller.generation, botId, expectedGeneration, botId, controller.generation);
      for (const row of this.rows('SELECT id,generations_json FROM host_roots')) {
        const generations = parse<Record<string, number>>(row.generations_json);
        if (generations[botId] === expectedGeneration) {
          generations[botId] = controller.generation;
          this.run('UPDATE host_roots SET generations_json=? WHERE id=?', JSON.stringify(generations), String(row.id));
        }
      }
      this.run("UPDATE host_tasks SET generation=? WHERE owner_bot_id=? AND generation=? AND state='active'", controller.generation, botId, expectedGeneration);
      this.run("UPDATE host_handoffs SET from_generation=? WHERE from_bot_id=? AND from_generation=? AND state='proposed'", controller.generation, botId, expectedGeneration);
      this.run("UPDATE host_handoffs SET to_generation=? WHERE to_bot_id=? AND to_generation=? AND state='proposed'", controller.generation, botId, expectedGeneration);
      this.run("UPDATE host_outbox SET generation=? WHERE bot_id=? AND generation=? AND state='registered'", controller.generation, botId, expectedGeneration);
    });
  }
  listControllerSwitches(botId?: string): HostControllerSwitch[] {
    return this.rows(`SELECT * FROM host_controller_switches ${botId ? 'WHERE bot_id=?' : ''} ORDER BY rowid`, ...(botId ? [botId] : []))
      .map(row => ({ id: String(row.id), botId: String(row.bot_id), fromController: parse<HostController>(row.from_json), toController: parse<HostController>(row.to_json) }));
  }
  private assertControllerChange(botId: string, controller: HostController, expectedGeneration: number, operationId?: string): void {
    const current = this.mustBot(botId).controller;
    if ((current?.generation ?? 0) !== expectedGeneration || controller.generation !== expectedGeneration + 1) throw new HostStateError('stale', 'Controller update requires the next generation and a matching previous pointer');
    required(controller.conversationId, 'conversationId');
    const lock = this.one('SELECT operation_id FROM host_control_locks WHERE bot_id=?', botId);
    if (lock && lock.operation_id !== operationId) throw new HostStateError('blocked', 'Bot has a pending control operation');
    if (this.one("SELECT 1 FROM host_events WHERE bot_id=? AND state IN ('running','uncertain')", botId)) throw new HostStateError('blocked', 'Old native turn has not safely ended');
  }
  updateControllerNativeId(botId: string, generation: number, nativeId: string): void {
    this.atomic(() => {
      const current = this.assertCurrent(botId, generation).controller!;
      this.run('UPDATE host_bots SET controller_json=? WHERE bot_id=?', JSON.stringify({ ...current, nativeId }), botId);
    });
  }
  setControllerReady(botId: string, generation: number, ready: boolean): void {
    this.atomic(() => { this.assertCurrent(botId, generation); this.run('UPDATE host_bots SET ready=? WHERE bot_id=?', Number(ready), botId); });
  }

  startGroup(input: { spaceId: string; principalId: string; receiverBotId: string; memberBotIds: readonly string[]; requireInitializedReceiver?: boolean }): HostGroup {
    return this.atomic(() => {
      const members = sorted(input.memberBotIds);
      if (!members.length || !members.includes(input.receiverBotId)) throw new HostStateError('conflict', 'Receiver must belong to the explicit member snapshot');
      const platform = this.mustBot(input.receiverBotId).platform;
      for (const id of members) {
        this.assertMapped(id, input.principalId);
        const value = this.mustBot(id);
        if (value.platform !== platform) throw new HostStateError('conflict', 'A work group cannot mix platform identities');
        if (value.ownerPrincipalId && value.ownerPrincipalId !== input.principalId) throw new HostStateError('forbidden', 'Group contains a bot owned by another principal');
        if (!this.one('SELECT 1 FROM host_space_maps WHERE bot_id=? AND space_id=?', id, input.spaceId)) throw new HostStateError('forbidden', 'Group membership/address has no verified mapping');
      }
      const receiver = this.mustBot(input.receiverBotId);
      if (input.requireInitializedReceiver !== false && !receiver.controller) throw new HostStateError('blocked', 'Receiver is not initialized');
      const old = this.getGroup(input.spaceId);
      if (old && old.principalId !== input.principalId) throw new HostStateError('forbidden', 'Group owner cannot be transferred');
      if (old?.enabled && old.receiverBotId === input.receiverBotId && same(old.memberBotIds, members)) return old;
      const epoch = old ? old.epoch + Number(!old.enabled) : 1;
      const revision = old?.enabled ? old.revision + 1 : 1;
      this.run(`INSERT INTO host_groups(space_id,principal_id,receiver_bot_id,members_json,epoch,revision,enabled,pause_reason)
        VALUES (?,?,?,?,?,?,1,NULL) ON CONFLICT(space_id) DO UPDATE SET receiver_bot_id=excluded.receiver_bot_id,
        members_json=excluded.members_json,epoch=excluded.epoch,revision=excluded.revision,enabled=1,pause_reason=NULL`,
      input.spaceId, input.principalId, input.receiverBotId, JSON.stringify(members), epoch, revision);
      if (old?.enabled) for (const id of old.memberBotIds.filter(id => !members.includes(id))) this.revokeMemberInner(input.spaceId, id);
      return this.getGroup(input.spaceId)!;
    });
  }
  getGroup(spaceId: string): HostGroup | null { const row = this.one('SELECT * FROM host_groups WHERE space_id=?', spaceId); return row ? group(row) : null; }
  listGroups(botId?: string): HostGroup[] {
    const groups = this.rows('SELECT * FROM host_groups ORDER BY space_id').map(group);
    return botId ? groups.filter(item => item.memberBotIds.includes(botId)) : groups;
  }
  stopGroup(spaceId: string, principalId: string, reason = 'stopped'): HostGroup {
    return this.atomic(() => {
      this.assertPrincipal(principalId);
      const value = this.getGroup(spaceId);
      if (!value || value.principalId !== principalId) throw new HostStateError('forbidden', 'Only the group owner can stop it');
      this.stopGroupInner(spaceId, reason); return this.getGroup(spaceId)!;
    });
  }
  private stopGroupInner(spaceId: string, reason: string): void {
    this.run('UPDATE host_groups SET enabled=0,pause_reason=? WHERE space_id=?', reason, spaceId);
    for (const row of this.rows("SELECT e.id FROM host_events e JOIN host_roots r ON r.id=e.root_id WHERE r.space_id=? AND e.state IN ('queued','reserved')", spaceId)) this.cancelEventInner(String(row.id), reason);
    this.run("UPDATE host_handoffs SET state='cancelled',evidence=? WHERE state='proposed' AND task_id IN (SELECT id FROM host_tasks WHERE space_id=?)", reason, spaceId);
    this.run("UPDATE host_outbox SET state='rejected',evidence=? WHERE state='registered' AND root_id IN (SELECT id FROM host_roots WHERE space_id=?)", reason, spaceId);
  }
  private revokeMemberInner(spaceId: string, botId: string): void {
    for (const row of this.rows("SELECT e.id FROM host_events e JOIN host_roots r ON r.id=e.root_id WHERE r.space_id=? AND e.bot_id=? AND e.state IN ('queued','reserved')", spaceId, botId)) this.cancelEventInner(String(row.id), 'member-removed');
    this.run("UPDATE host_handoffs SET state='cancelled',evidence='member-removed' WHERE state='proposed' AND (from_bot_id=? OR to_bot_id=?) AND task_id IN (SELECT id FROM host_tasks WHERE space_id=?)", botId, botId, spaceId);
  }

  claimIngress(input: { id: string; spaceId: string; receiverBotId: string; payload: unknown }): boolean {
    return this.atomic(() => {
      const value = this.getGroup(input.spaceId);
      if (!value?.enabled || value.receiverBotId !== input.receiverBotId) throw new HostStateError('forbidden', 'Only the current receiver supplies authoritative group input');
      this.assertPrincipal(value.principalId);
      const previous = this.one('SELECT * FROM host_ingress WHERE id=?', input.id);
      const payload = JSON.stringify(input.payload);
      if (previous) {
        if (previous.space_id !== input.spaceId || previous.payload_json !== payload) throw new HostStateError('conflict', 'Ingress ID reused for another payload');
        return false;
      }
      this.run('INSERT INTO host_ingress(id,space_id,receiver_bot_id,payload_json) VALUES (?,?,?,?)', input.id, input.spaceId, input.receiverBotId, payload);
      return true;
    });
  }
  acceptRoot(input: { id: string; spaceId: string; principalId: string; sourceEventId: string; targetBotIds: readonly string[]; replyTo: HostReplyAddress; automaticLimit?: number }): HostRoot {
    return this.atomic(() => {
      const targets = sorted(input.targetBotIds);
      const previous = this.one('SELECT * FROM host_roots WHERE id=? OR (space_id=? AND source_event_id=?)', input.id, input.spaceId, input.sourceEventId);
      if (previous) {
        const old = root(previous);
        if (old.id !== input.id || old.spaceId !== input.spaceId || old.principalId !== input.principalId || old.sourceEventId !== input.sourceEventId || !same(old.targetBotIds, targets) || !same(old.replyTo, input.replyTo)) throw new HostStateError('conflict', 'Root event identity cannot be reused');
        return old;
      }
      if (!targets.length) throw new HostStateError('conflict', 'Human root must have explicit targets');
      const generations: Record<string, number> = {};
      let binding: HostGroup | undefined;
      for (const id of targets) {
        binding = this.assertMember(input.spaceId, id, input.principalId);
        const value = this.mustBot(id);
        if (!value.ready || !value.controller || value.ownerPrincipalId !== input.principalId) throw new HostStateError('blocked', 'All root targets must be owned and ready');
        generations[id] = value.controller.generation;
      }
      // A later collaborator is also frozen to this human authorization's generation.
      for (const id of binding!.memberBotIds) generations[id] = this.mustBot(id).controller?.generation ?? 0;
      const limit = input.automaticLimit ?? 8;
      if (!Number.isInteger(limit) || limit < 0 || limit > 64) throw new HostStateError('conflict', 'Automatic root budget must be between 0 and 64');
      this.run(`INSERT INTO host_roots(id,space_id,principal_id,source_event_id,targets_json,generations_json,reply_json,epoch,revision,auto_limit)
        VALUES (?,?,?,?,?,?,?,?,?,?)`, input.id, input.spaceId, input.principalId, input.sourceEventId,
      JSON.stringify(targets), JSON.stringify(generations), JSON.stringify(input.replyTo), binding!.epoch, binding!.revision, limit);
      return this.mustRoot(input.id);
    });
  }
  getRoot(id: string): HostRoot | null { const row = this.one('SELECT * FROM host_roots WHERE id=?', id); return row ? root(row) : null; }
  claimBudgetExhaustionNotice(rootId: string): boolean {
    return this.atomic(() => this.run('UPDATE host_roots SET exhaustion_notified=1 WHERE id=? AND exhaustion_notified=0 AND auto_used+auto_reserved>=auto_limit', rootId) === 1);
  }
  enqueueEvent(input: { id: string; logicalId?: string; rootId: string; botId: string; generation: number; kind: HostEventKind;
    payload: unknown; publicCursor?: number; causeEventId?: string; sourceBotId?: string; coalesce?: boolean }): HostEvent {
    return this.atomic(() => {
      const logicalId = input.logicalId ?? input.id;
      const prior = this.one('SELECT event_id FROM host_deliveries WHERE logical_id=? AND bot_id=? AND generation=?', logicalId, input.botId, input.generation);
      if (prior) {
        const old = this.mustEvent(String(prior.event_id));
        if (old.rootId !== input.rootId) throw new HostStateError('conflict', 'Logical delivery reused across roots');
        return old;
      }
      const existing = this.getEvent(input.id);
      if (existing) throw new HostStateError('conflict', 'Event ID reused for another delivery');
      const source = this.mustRoot(input.rootId);
      this.assertMember(source.spaceId, input.botId, source.principalId, source.epoch);
      this.assertCurrent(input.botId, input.generation);
      if (source.generations[input.botId] !== input.generation) throw new HostStateError('stale', 'Old human root cannot wake a new controller or newly added member');
      if (input.sourceBotId) {
        this.assertMember(source.spaceId, input.sourceBotId, source.principalId, source.epoch);
        if (input.sourceBotId === input.botId) throw new HostStateError('forbidden', 'Bots cannot wake themselves through collaboration');
      }
      const initial = input.kind === 'human';
      const automatic = !initial && input.kind !== 'assistant-result';
      if (initial && !source.targetBotIds.includes(input.botId)) throw new HostStateError('forbidden', 'Bot is not a first-participation target');
      if (initial && this.one('SELECT 1 FROM host_initial_participation WHERE root_id=? AND bot_id=?', source.id, input.botId)) throw new HostStateError('conflict', 'Human root already has this bot participation');
      // Observation is replaceable; consultation/handoff bodies are independent obligations.
      const queued = input.coalesce !== false && input.kind === 'observation'
        ? this.one("SELECT * FROM host_events WHERE root_id=? AND bot_id=? AND generation=? AND kind='observation' AND state='queued' ORDER BY sequence LIMIT 1", source.id, input.botId, input.generation) : undefined;
      const id = queued ? String(queued.id) : input.id;
      if (queued) {
        const oldPayload = parse<unknown>(queued.payload_json);
        this.run('UPDATE host_events SET payload_json=?,public_cursor=MAX(public_cursor,?) WHERE id=?',
          JSON.stringify({ updates: [...(typeof oldPayload === 'object' && oldPayload !== null && 'updates' in oldPayload && Array.isArray(oldPayload.updates) ? oldPayload.updates : [oldPayload]), input.payload].slice(-40) }), input.publicCursor ?? 0, id);
      } else {
        this.run(`INSERT INTO host_events(id,logical_id,root_id,bot_id,generation,kind,payload_json,public_cursor,initial,automatic,cause_event_id,source_bot_id)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, id, logicalId, source.id, input.botId, input.generation, input.kind,
        JSON.stringify(input.payload), input.publicCursor ?? 0, Number(initial), Number(automatic), input.causeEventId ?? null, input.sourceBotId ?? null);
        if (initial) this.run('INSERT INTO host_initial_participation(root_id,bot_id,event_id) VALUES (?,?,?)', source.id, input.botId, id);
      }
      this.run('INSERT INTO host_deliveries(logical_id,bot_id,generation,event_id) VALUES (?,?,?,?)', logicalId, input.botId, input.generation, id);
      return this.mustEvent(id);
    });
  }
  getEvent(id: string): HostEvent | null { const row = this.one('SELECT * FROM host_events WHERE id=?', id); return row ? event(row) : null; }
  listEvents(botId?: string): HostEvent[] { return this.rows(`SELECT * FROM host_events ${botId ? 'WHERE bot_id=?' : ''} ORDER BY sequence`, ...(botId ? [botId] : [])).map(event); }
  claimNextEvent(botId: string): HostEvent | null {
    return this.atomic(() => {
      if (this.one('SELECT 1 FROM host_control_locks WHERE bot_id=?', botId) || this.one("SELECT 1 FROM host_events WHERE bot_id=? AND state IN ('reserved','running','uncertain')", botId)) return null;
      // Human inputs cannot be starved by an automatic discussion backlog.
      const pending = this.rows("SELECT * FROM host_events WHERE bot_id=? AND state='queued' ORDER BY initial DESC,sequence", botId);
      for (const row of pending) {
        const value = event(row);
        let source: HostRoot;
        try { source = this.validateEvent(value); }
        catch (error) {
          if (error instanceof HostStateError && error.code === 'blocked') continue;
          if (!(error instanceof HostStateError)) throw error;
          this.cancelEventInner(value.id, error.message); continue;
        }
        if (value.automatic && source.automaticUsed + source.automaticReserved >= source.automaticLimit) {
          this.cancelEventInner(value.id, 'root-budget-exhausted'); continue;
        }
        if (value.automatic) this.run('UPDATE host_roots SET auto_reserved=auto_reserved+1 WHERE id=?', source.id);
        this.run("UPDATE host_events SET state='reserved' WHERE id=?", value.id);
        return this.mustEvent(value.id);
      }
      return null;
    });
  }
  startEvent(id: string): HostEvent {
    return this.atomic(() => {
      const value = this.mustEvent(id);
      if (value.state !== 'reserved') throw new HostStateError('conflict', 'Event is not reserved');
      this.validateEvent(value);
      if (this.one('SELECT 1 FROM host_control_locks WHERE bot_id=?', value.botId)) throw new HostStateError('blocked', 'Controller is frozen');
      if (value.automatic) this.run('UPDATE host_roots SET auto_reserved=auto_reserved-1,auto_used=auto_used+1 WHERE id=? AND auto_reserved>0', value.rootId);
      this.run("UPDATE host_events SET state='running' WHERE id=?", id);
      return this.mustEvent(id);
    });
  }
  markEventDecision(id: string, decision: 'published' | 'silent'): void {
    this.atomic(() => {
      const value = this.mustEvent(id);
      if (value.state !== 'running' || value.nativeEnded || (value.decision && value.decision !== decision)) throw new HostStateError('conflict', 'Native turn is closed or decision conflicts');
      this.run('UPDATE host_events SET decision=? WHERE id=?', decision, id);
    });
  }
  canProduceEffects(id: string): boolean {
    const value = this.mustEvent(id);
    if (value.state !== 'running' || value.decision || value.nativeEnded) return false;
    try { this.validateEvent(value); return !this.one('SELECT 1 FROM host_control_locks WHERE bot_id=?', value.botId); }
    catch (error) { if (error instanceof HostStateError) return false; throw error; }
  }
  finishEvent(id: string, outcome: 'completed' | 'silent' | 'failed', error?: string): void {
    this.atomic(() => {
      const value = this.mustEvent(id);
      if (value.state === outcome && value.nativeEnded) return;
      if (value.state !== 'running' && value.state !== 'uncertain') throw new HostStateError('conflict', 'Only a started native turn can finish');
      if (value.decision === 'silent' && outcome === 'completed') outcome = 'silent';
      this.run('UPDATE host_events SET state=?,decision=?,native_ended=1,error=? WHERE id=?', outcome,
        outcome === 'silent' ? 'silent' : value.decision, error ?? null, id);
      if (value.publicCursor) this.ackPublicCursorInner(value.botId, this.mustRoot(value.rootId), value.publicCursor);
    });
  }
  cancelQueuedEvents(botId: string, reason: string): number {
    return this.atomic(() => {
      const values = this.rows("SELECT id FROM host_events WHERE bot_id=? AND state IN ('queued','reserved')", botId);
      for (const row of values) this.cancelEventInner(String(row.id), reason);
      return values.length;
    });
  }
  cancelEvent(id: string, reason: string): void {
    this.atomic(() => {
      const value = this.mustEvent(id);
      if (!['queued', 'reserved', 'cancelled'].includes(value.state)) throw new HostStateError('blocked', 'Started native execution needs verified termination, not queue cancellation');
      this.cancelEventInner(id, reason);
    });
  }
  private cancelEventInner(id: string, reason: string): void {
    const value = this.mustEvent(id);
    if (!['queued', 'reserved'].includes(value.state)) return;
    if (value.state === 'reserved' && value.automatic) this.run('UPDATE host_roots SET auto_reserved=auto_reserved-1 WHERE id=? AND auto_reserved>0', value.rootId);
    this.run("UPDATE host_events SET state='cancelled',error=? WHERE id=?", reason, id);
  }
  private invalidateGeneration(botId: string, generation: number): void {
    for (const row of this.rows("SELECT id FROM host_events WHERE bot_id=? AND generation<=? AND state IN ('queued','reserved')", botId, generation)) this.cancelEventInner(String(row.id), 'generation-replaced');
    this.run("UPDATE host_handoffs SET state='cancelled',evidence='generation-replaced' WHERE state='proposed' AND (from_bot_id=? OR to_bot_id=?)", botId, botId);
    this.run("UPDATE host_outbox SET state='rejected',evidence='generation-replaced' WHERE bot_id=? AND generation<=? AND state='registered'", botId, generation);
  }

  /** Evidence has no authorization root and cannot enqueue work or grant an owner identity. */
  appendContext(input: Omit<HostContextRecord, 'sequence' | 'receivedAt'> & { receiverBotId: string; principalId: string; revision: number }): HostContextRecord {
    return this.atomic(() => {
      const group = this.assertMember(input.spaceId, input.receiverBotId, input.principalId, input.epoch);
      if (group.revision !== input.revision) throw new HostStateError('stale', 'Context binding changed');
      const value = { source: input.source, text: input.text, attachments: input.attachments, canAuthorize: input.canAuthorize };
      const previous = this.one('SELECT * FROM host_context_records WHERE id=?', input.id);
      if (previous) {
        if (previous.space_id !== input.spaceId || Number(previous.epoch) !== input.epoch
          || !same(parse<unknown>(previous.source_json), value.source) || previous.text !== input.text
          || !same(parse<unknown>(previous.attachments_json), value.attachments) || !!previous.can_authorize !== value.canAuthorize)
          throw new HostStateError('conflict', 'Context message identity reused');
      } else this.run('INSERT INTO host_context_records(id,space_id,epoch,source_json,text,attachments_json,can_authorize,received_at) VALUES(?,?,?,?,?,?,?,?)',
        input.id, input.spaceId, input.epoch, JSON.stringify(value.source), input.text, JSON.stringify(value.attachments), Number(value.canAuthorize), new Date().toISOString());
      return this.contextRecord(this.one('SELECT * FROM host_context_records WHERE id=?', input.id)!);
    });
  }
  private contextRecord(row: Row): HostContextRecord {
    return { sequence: Number(row.sequence), id: String(row.id), spaceId: String(row.space_id), epoch: Number(row.epoch),
      receivedAt: String(row.received_at), source: parse<HostContextRecord['source']>(row.source_json), text: String(row.text),
      attachments: parse<unknown[]>(row.attachments_json), canAuthorize: !!row.can_authorize };
  }
  readContext(spaceId: string, botId: string, limit = 40): { recent: HostContextRecord[]; unread: HostContextRecord[]; unreadCount: number; truncated: boolean } {
    const group = this.getGroup(spaceId); if (!group) throw new HostStateError('not-found', 'Unknown group');
    this.assertMember(spaceId, botId, group.principalId, group.epoch);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new HostStateError('conflict', 'Context limit must be 1..100');
    const cursor = Number(this.one('SELECT cursor FROM host_context_cursors WHERE bot_id=? AND space_id=? AND epoch=?', botId, spaceId, group.epoch)?.cursor ?? 0);
    const recent = this.rows('SELECT * FROM (SELECT * FROM host_context_records WHERE space_id=? AND epoch=? ORDER BY sequence DESC LIMIT ?) ORDER BY sequence', spaceId, group.epoch, limit).map(r => this.contextRecord(r));
    const unreadCount = Number(this.one('SELECT COUNT(*) AS n FROM host_context_records WHERE space_id=? AND epoch=? AND sequence>?', spaceId, group.epoch, cursor)!.n);
    return { recent, unread: recent.filter(r => r.sequence > cursor), unreadCount, truncated: unreadCount > recent.filter(r => r.sequence > cursor).length };
  }
  ackContext(botId: string, spaceId: string, epoch: number, cursor: number): void {
    const group = this.getGroup(spaceId); if (!group || group.epoch !== epoch) throw new HostStateError('stale', 'Context epoch changed');
    this.assertMember(spaceId, botId, group.principalId, epoch);
    this.run('INSERT INTO host_context_cursors(bot_id,space_id,epoch,cursor) VALUES(?,?,?,?) ON CONFLICT(bot_id,space_id,epoch) DO UPDATE SET cursor=MAX(cursor,excluded.cursor)', botId, spaceId, epoch, cursor);
  }

  appendPublic(input: { id: string; rootId: string; authorBotId?: string; principalId: string; text: string; attachments?: unknown[] }): HostPublicMessage {
    return this.atomic(() => {
      const source = this.mustRoot(input.rootId);
      if (source.principalId !== input.principalId) throw new HostStateError('forbidden', 'Public record principal differs from authorization');
      this.assertMember(source.spaceId, input.authorBotId ?? source.targetBotIds[0]!, input.principalId, source.epoch);
      const old = this.one('SELECT * FROM host_public_log WHERE id=?', input.id);
      if (old) {
        if (old.root_id !== input.rootId || old.author_bot_id !== (input.authorBotId ?? null) || old.text !== input.text || !same(parse<unknown[]>(old.attachments_json), input.attachments ?? [])) throw new HostStateError('conflict', 'Public message identity reused');
      } else this.run('INSERT INTO host_public_log(id,root_id,space_id,epoch,author_bot_id,principal_id,text,attachments_json) VALUES (?,?,?,?,?,?,?,?)',
        input.id, source.id, source.spaceId, source.epoch, input.authorBotId ?? null, input.principalId, input.text, JSON.stringify(input.attachments ?? []));
      return this.publicMessage(this.one('SELECT * FROM host_public_log WHERE id=?', input.id)!);
    });
  }
  /** A send already in flight can complete after stop/revocation; preserve that fact without reopening permission. */
  appendDeliveredPublic(outboxId: string, messageId: string, text: string, attachments: unknown[] = []): HostPublicMessage {
    return this.atomic(() => {
      const delivery = this.getOutbox(outboxId);
      if (!delivery || delivery.state !== 'delivered' || delivery.audience !== 'group') throw new HostStateError('forbidden', 'A delivered public outbox is required');
      const source = this.mustRoot(delivery.rootId);
      const previous = this.one('SELECT * FROM host_public_log WHERE id=?', messageId);
      if (previous) {
        if (previous.root_id !== source.id || previous.author_bot_id !== delivery.botId || previous.text !== text || !same(parse<unknown[]>(previous.attachments_json), attachments)) throw new HostStateError('conflict', 'Public message identity reused');
      } else this.run('INSERT INTO host_public_log(id,root_id,space_id,epoch,author_bot_id,principal_id,text,attachments_json) VALUES (?,?,?,?,?,?,?,?)',
        messageId, source.id, source.spaceId, source.epoch, delivery.botId, source.principalId, text, JSON.stringify(attachments));
      return this.publicMessage(this.one('SELECT * FROM host_public_log WHERE id=?', messageId)!);
    });
  }
  private publicMessage(row: Row): HostPublicMessage {
    return { sequence: Number(row.sequence), id: String(row.id), rootId: String(row.root_id), spaceId: String(row.space_id), epoch: Number(row.epoch),
      authorBotId: row.author_bot_id === null ? null : String(row.author_bot_id), principalId: String(row.principal_id), text: String(row.text), attachments: parse<unknown[]>(row.attachments_json) };
  }
  readPublic(spaceId: string, botId: string, after = 0, limit = 40): HostPublicMessage[] {
    const value = this.getGroup(spaceId);
    if (!value) throw new HostStateError('not-found', 'Unknown group');
    this.assertMember(spaceId, botId, value.principalId, value.epoch);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new HostStateError('conflict', 'Public record limit must be 1..200');
    return this.rows('SELECT * FROM (SELECT * FROM host_public_log WHERE space_id=? AND epoch=? AND sequence>? ORDER BY sequence DESC LIMIT ?) ORDER BY sequence', spaceId, value.epoch, after, limit).map(row => this.publicMessage(row));
  }
  getPublicCursor(botId: string, spaceId: string): number {
    const value = this.getGroup(spaceId); if (!value) return 0;
    return Number(this.one('SELECT cursor FROM host_public_cursors WHERE bot_id=? AND space_id=? AND epoch=?', botId, spaceId, value.epoch)?.cursor ?? 0);
  }
  private ackPublicCursorInner(botId: string, source: HostRoot, cursor: number): void {
    this.run(`INSERT INTO host_public_cursors(bot_id,space_id,epoch,cursor) VALUES (?,?,?,?)
      ON CONFLICT(bot_id,space_id,epoch) DO UPDATE SET cursor=MAX(cursor,excluded.cursor)`, botId, source.spaceId, source.epoch, cursor);
  }

  private routedDelivery(row: Row): RoutedDelivery {
    return { id: String(row.id), source: parse<RoutedDeliverySource>(row.source_json), target: parse<RoutedDeliveryTarget>(row.target_json),
      payload: parse<RoutedDelivery['payload']>(row.payload_json), state: String(row.state) as RoutedDelivery['state'], evidence: row.evidence == null ? null : String(row.evidence) };
  }
  getRoutedDelivery(id: string): RoutedDelivery | null { const row = this.one('SELECT * FROM host_routed_outbox WHERE id=?', id); return row ? this.routedDelivery(row) : null; }
  listRoutedDeliveries(): RoutedDelivery[] { return this.rows('SELECT * FROM host_routed_outbox ORDER BY rowid').map(row => this.routedDelivery(row)); }
  private assertRoutedDelivery(source: RoutedDeliverySource, target: RoutedDeliveryTarget): void {
    this.assertMapped(source.botId, source.principalId);
    const bot = this.assertCurrent(source.botId, source.generation);
    if (bot.ownerPrincipalId !== source.principalId || bot.controller?.conversationId !== source.conversationId
      || source.userId !== source.botId + '|' + this.principalAccount(source.botId, source.principalId)
      || !source.channelId.startsWith(source.botId + '|') || target.botId !== source.botId || target.principalId !== source.principalId
      || !target.channelId.startsWith(source.botId + '|')) throw new HostStateError('forbidden', '投递主体、来源或目标身份不匹配');
    if (this.one('SELECT 1 FROM host_control_locks WHERE bot_id=?', source.botId)) throw new HostStateError('blocked', '控制操作已冻结，不能开始新发送');
    if (source.eventId) {
      const event = this.mustEvent(source.eventId), root = this.mustRoot(event.rootId);
      if (event.botId !== source.botId || event.generation !== source.generation || root.id !== source.rootId || root.spaceId !== source.spaceId
        || root.epoch !== source.bindingEpoch || root.principalId !== source.principalId || !this.canProduceEffects(event.id)) throw new HostStateError('stale', '原群输入已结束、停用或失权');
    } else if (source.rootId || source.spaceId || source.bindingEpoch != null) throw new HostStateError('forbidden', '私聊来源不能伪装成群事件');
    if (target.kind === 'group') {
      const binding = this.assertMember(target.spaceId!, source.botId, source.principalId, target.epoch);
      if (!bot.ready || binding.revision !== target.revision || this.resolveSpace(source.botId, target.channelId.slice(source.botId.length + 1)) !== target.spaceId) throw new HostStateError('stale', '目标群或当前主控已改变');
    } else if (target.kind !== 'private' || target.userId !== this.principalAccount(source.botId, source.principalId)
      || this.resolveSpace(source.botId, target.channelId.slice(source.botId.length + 1))) throw new HostStateError('forbidden', '私聊目标不是本 Bot 负责人真实私聊地址');
  }
  private principalAccount(botId: string, principalId: string): string | null {
    const row = this.one('SELECT platform_user_id FROM host_principal_maps WHERE bot_id=? AND principal_id=?', botId, principalId);
    return row ? String(row.platform_user_id) : null;
  }
  registerRoutedDelivery(input: { id: string; source: RoutedDeliverySource; target: RoutedDeliveryTarget; payload: RoutedDelivery['payload'] }): RoutedDelivery {
    return this.atomic(() => {
      const previous = this.getRoutedDelivery(input.id);
      if (previous) {
        if (!same(previous.source, input.source) || !same(previous.target, input.target) || !same(previous.payload, input.payload)) throw new HostStateError('conflict', '投递调用标识被不同来源、目标或内容复用');
        return previous;
      }
      const unresolved = this.rows("SELECT * FROM host_routed_outbox WHERE state IN ('sending','uncertain')").map(row => this.routedDelivery(row));
      if (unresolved.some(value => value.source.botId === input.source.botId && value.source.conversationId === input.source.conversationId && value.source.messageId === input.source.messageId)) throw new HostStateError('blocked', '本输入已有发送中或结果未知的投递，不能换调用ID重发');
      this.assertRoutedDelivery(input.source, input.target);
      this.run('INSERT INTO host_routed_outbox(id,source_json,target_json,payload_json) VALUES (?,?,?,?)', input.id, JSON.stringify(input.source), JSON.stringify(input.target), JSON.stringify(input.payload));
      return this.getRoutedDelivery(input.id)!;
    });
  }
  beginRoutedDelivery(id: string): RoutedDelivery | null {
    return this.atomic(() => {
      const value = this.getRoutedDelivery(id); if (!value) throw new HostStateError('not-found', '投递记录不存在');
      if (value.state !== 'registered') return null;
      try { this.assertRoutedDelivery(value.source, value.target); }
      catch (error) { if (!(error instanceof HostStateError)) throw error; this.run("UPDATE host_routed_outbox SET state='rejected',evidence=? WHERE id=?", error.message, id); return null; }
      this.run("UPDATE host_routed_outbox SET state='sending' WHERE id=?", id); return this.getRoutedDelivery(id)!;
    });
  }
  finishRoutedDelivery(id: string, state: 'delivered' | 'uncertain', evidence: string): void {
    this.atomic(() => {
      const value = this.getRoutedDelivery(id); if (!value || value.state !== 'sending') throw new HostStateError('conflict', '只有实际开始的发送可以登记结果');
      this.run('UPDATE host_routed_outbox SET state=?,evidence=? WHERE id=?', state, evidence, id);
    });
  }
  appendRoutedPublic(id: string): HostPublicMessage | null {
    return this.atomic(() => {
      const delivery = this.getRoutedDelivery(id); if (!delivery || delivery.state !== 'delivered') throw new HostStateError('blocked', '未确认送达不能写入公开记录');
      if (delivery.target.kind !== 'group') return null;
      const publicId = 'routed:' + id, previous = this.one('SELECT * FROM host_public_log WHERE id=?', publicId);
      if (previous) return this.publicMessage(previous);
      const source = delivery.source, target = delivery.target;
      let rootId = source.rootId;
      if (!rootId) {
        // 仅为实际公开投递保存原私聊来源；不创建参与事件，不伪造真人群输入或自动预算。
        rootId = 'delivery-source:' + id;
        this.run(`INSERT INTO host_roots(id,space_id,principal_id,source_event_id,targets_json,generations_json,reply_json,epoch,revision,auto_limit)
          VALUES (?,?,?,?,?,?,?,?,?,0)`, rootId, target.spaceId!, source.principalId, rootId, JSON.stringify([source.botId]),
        JSON.stringify({ [source.botId]: source.generation }), JSON.stringify({ botId: source.botId, channelId: source.channelId, sourceMessageId: source.messageId }), target.epoch!, target.revision!);
      }
      this.run('INSERT INTO host_public_log(id,root_id,space_id,epoch,author_bot_id,principal_id,text,attachments_json) VALUES (?,?,?,?,?,?,?,?)',
        publicId, rootId, target.spaceId!, target.epoch!, source.botId, source.principalId, delivery.payload.text,
        JSON.stringify(delivery.payload.paths.map(path => ({ sourceBotId: source.botId, path }))));
      return this.publicMessage(this.one('SELECT * FROM host_public_log WHERE id=?', publicId)!);
    });
  }

  registerOutbox(input: { id: string; eventId: string; audience: HostOutbox['audience']; targetBotIds?: readonly string[]; replyTo?: HostReplyAddress; payload: unknown }): HostOutbox {
    return this.atomic(() => {
      const value = this.mustEvent(input.eventId);
      const targets = sorted(input.targetBotIds ?? []);
      const source = this.mustRoot(value.rootId);
      const address = input.replyTo ?? source.replyTo;
      const previous = this.getOutbox(input.id);
      if (previous) {
        if (previous.eventId !== input.eventId || previous.audience !== input.audience || !same(previous.targetBotIds, targets) || !same(previous.payload, input.payload) || !same(previous.replyTo, address)) throw new HostStateError('conflict', 'Outbox ID reused with changed audience or content');
        return previous;
      }
      if (!this.canProduceEffects(value.id)) throw new HostStateError('blocked', 'Turn is closed, stale, or frozen');
      for (const target of targets) this.assertMember(source.spaceId, target, source.principalId, source.epoch);
      if (input.audience === 'direct' && (!targets.length || targets.includes(value.botId))) throw new HostStateError('forbidden', 'Direct collaboration needs other explicit members');
      if (input.audience !== 'private' && !same(address, source.replyTo)) throw new HostStateError('forbidden', 'Group/direct delivery retains the original address');
      if (input.audience === 'private') {
        const mapped = address.botId && address.userId ? this.resolvePrincipal(address.botId, address.userId) : null;
        if (address.botId !== value.botId || mapped !== source.principalId) throw new HostStateError('forbidden', 'Private recipient is not the verified owner account');
      }
      this.run(`INSERT INTO host_outbox(id,event_id,bot_id,generation,root_id,audience,targets_json,reply_json,payload_json)
        VALUES (?,?,?,?,?,?,?,?,?)`, input.id, value.id, value.botId, value.generation, value.rootId, input.audience,
      JSON.stringify(targets), JSON.stringify(address), JSON.stringify(input.payload));
      return this.getOutbox(input.id)!;
    });
  }
  getOutbox(id: string): HostOutbox | null { const row = this.one('SELECT * FROM host_outbox WHERE id=?', id); return row ? outbox(row) : null; }
  listOutbox(): HostOutbox[] { return this.rows('SELECT * FROM host_outbox ORDER BY rowid').map(outbox); }
  beginOutboxSend(id: string): HostOutbox | null {
    return this.atomic(() => {
      const value = this.getOutbox(id); if (!value) throw new HostStateError('not-found', 'Unknown outbox');
      if (value.state !== 'registered') return null;
      try {
        const nativeEvent = this.mustEvent(value.eventId);
        const source = this.mustRoot(value.rootId);
        this.assertMember(source.spaceId, value.botId, source.principalId, source.epoch);
        if (!this.assertCurrent(value.botId, value.generation).ready) throw new HostStateError('blocked', 'Controller is not ready');
        if (nativeEvent.decision === 'silent' || ['cancelled', 'failed', 'uncertain'].includes(nativeEvent.state)) {
          throw new HostStateError('blocked', 'Silent, failed, or unreconciled native turn cannot start a send');
        }
        if (this.one('SELECT 1 FROM host_control_locks WHERE bot_id=?', value.botId)) throw new HostStateError('blocked', 'Bot has a frozen control operation');
        for (const target of value.targetBotIds) this.assertMember(source.spaceId, target, source.principalId, source.epoch);
        if (value.audience === 'private' && this.resolvePrincipal(value.botId, value.replyTo.userId ?? '') !== source.principalId) {
          throw new HostStateError('forbidden', 'Private target authorization changed');
        }
      }
      catch (error) {
        if (!(error instanceof HostStateError)) throw error;
        this.run("UPDATE host_outbox SET state='rejected',evidence=? WHERE id=?", error.message, id); return null;
      }
      this.run("UPDATE host_outbox SET state='sending' WHERE id=?", id);
      return this.getOutbox(id)!;
    });
  }
  finishOutbox(id: string, state: 'delivered' | 'uncertain' | 'rejected', evidence?: string): void {
    this.atomic(() => {
      const value = this.getOutbox(id); if (!value) throw new HostStateError('not-found', 'Unknown outbox');
      if (value.state === state) return;
      if (value.state !== 'sending' && !(value.state === 'uncertain' && state === 'delivered' && evidence?.trim())) throw new HostStateError('conflict', 'Only an actual send or verified uncertain delivery can settle');
      this.run('UPDATE host_outbox SET state=?,evidence=? WHERE id=?', state, evidence ?? null, id);
    });
  }

  claimTask(input: { id: string; rootId: string; botId: string; generation: number; title: string; resources?: readonly string[] }): { claimed: boolean; task: HostTask } {
    return this.atomic(() => {
      const source = this.mustRoot(input.rootId);
      this.assertMember(source.spaceId, input.botId, source.principalId, source.epoch);
      this.assertCurrent(input.botId, input.generation);
      if (source.generations[input.botId] !== input.generation) throw new HostStateError('stale', 'Old root cannot authorize work in a new controller generation');
      if (this.one('SELECT 1 FROM host_control_locks WHERE bot_id=?', input.botId)) throw new HostStateError('blocked', 'Bot control operation is frozen');
      const previous = this.getTask(input.id);
      if (previous) {
        if (previous.rootId !== input.rootId) throw new HostStateError('conflict', 'Task identity cannot cross root authorization');
        return { claimed: false, task: previous };
      }
      const resources = sorted(input.resources ?? []);
      for (const resource of resources) {
        required(resource, 'Resource');
        const owner = this.one('SELECT task_id FROM host_resource_claims WHERE resource=?', resource);
        if (owner) throw new HostStateError('blocked', `Resource ${resource} is owned by task ${owner.task_id}`);
      }
      this.run('INSERT INTO host_tasks(id,root_id,space_id,owner_bot_id,generation,title,resources_json,reply_json) VALUES (?,?,?,?,?,?,?,?)',
        input.id, input.rootId, source.spaceId, input.botId, input.generation, input.title, JSON.stringify(resources), JSON.stringify(source.replyTo));
      for (const resource of resources) this.run('INSERT INTO host_resource_claims(resource,task_id) VALUES (?,?)', resource, input.id);
      return { claimed: true, task: this.getTask(input.id)! };
    });
  }
  getTask(id: string): HostTask | null { const row = this.one('SELECT * FROM host_tasks WHERE id=?', id); return row ? task(row) : null; }
  listTasks(spaceId?: string): HostTask[] { return this.rows(`SELECT * FROM host_tasks ${spaceId ? 'WHERE space_id=?' : ''} ORDER BY rowid`, ...(spaceId ? [spaceId] : [])).map(task); }
  registerTaskWorker(taskId: string, botId: string, workerId: string): void {
    required(workerId, 'workerId');
    this.atomic(() => {
      const value = this.ownedTask(taskId, botId);
      this.assertCurrent(botId, value.generation);
      const previous = this.one('SELECT task_id FROM host_task_workers WHERE bot_id=? AND worker_id=?', botId, workerId);
      if (previous && previous.task_id !== taskId) throw new HostStateError('conflict', 'Worker is already attached to a different task');
      if (!previous && this.one("SELECT 1 FROM host_handoffs WHERE task_id=? AND state='proposed'", taskId)) throw new HostStateError('blocked', 'Resolve pending handoff before starting another worker');
      this.run('INSERT OR IGNORE INTO host_task_workers(bot_id,worker_id,task_id) VALUES (?,?,?)', botId, workerId, taskId);
      if (!previous) this.run('UPDATE host_tasks SET stopped_proof=NULL WHERE id=?', taskId);
    });
  }
  taskWorkers(taskId: string): Array<{ botId: string; workerId: string }> {
    return this.rows('SELECT bot_id,worker_id FROM host_task_workers WHERE task_id=? ORDER BY bot_id,worker_id', taskId)
      .map(row => ({ botId: String(row.bot_id), workerId: String(row.worker_id) }));
  }
  getTaskForWorker(botId: string, workerId: string): HostTask | null {
    const row = this.one('SELECT t.* FROM host_tasks t JOIN host_task_workers w ON w.task_id=t.id WHERE w.bot_id=? AND w.worker_id=?', botId, workerId);
    return row ? task(row) : null;
  }
  private ownedTask(taskId: string, botId: string): HostTask {
    const value = this.getTask(taskId);
    if (!value || value.ownerBotId !== botId || value.state !== 'active') throw new HostStateError('forbidden', 'Bot does not own an active task');
    return value;
  }
  confirmTaskExecutionStopped(taskId: string, botId: string, proof: string): void {
    required(proof, 'Execution stop evidence');
    this.atomic(() => { this.ownedTask(taskId, botId); this.run('UPDATE host_tasks SET stopped_proof=? WHERE id=?', proof, taskId); });
  }
  markTaskExecutionActive(taskId: string, botId: string): void {
    this.atomic(() => {
      const value = this.ownedTask(taskId, botId); const source = this.mustRoot(value.rootId);
      this.assertMember(source.spaceId, botId, source.principalId, source.epoch); this.assertCurrent(botId, value.generation);
      if (this.one("SELECT 1 FROM host_handoffs WHERE task_id=? AND state='proposed'", taskId)) throw new HostStateError('blocked', 'Resolve pending handoff before restarting execution');
      this.run('UPDATE host_tasks SET stopped_proof=NULL WHERE id=?', taskId);
    });
  }
  finishTask(taskId: string, botId: string, outcome: 'completed' | 'cancelled', proof: string): void {
    required(proof, 'Execution completion/stop evidence');
    this.atomic(() => {
      this.ownedTask(taskId, botId);
      this.run('UPDATE host_tasks SET state=?,stopped_proof=? WHERE id=?', outcome, proof, taskId);
      this.run('DELETE FROM host_resource_claims WHERE task_id=?', taskId);
      this.run("UPDATE host_handoffs SET state='cancelled',evidence=? WHERE task_id=? AND state='proposed'", `task-${outcome}`, taskId);
    });
  }
  proposeHandoff(input: { id: string; taskId: string; fromBotId: string; toBotId: string; summary: string }): HostHandoff {
    return this.atomic(() => {
      if (input.fromBotId === input.toBotId) throw new HostStateError('conflict', 'Handoff target must differ from current owner');
      const value = this.ownedTask(input.taskId, input.fromBotId); const source = this.mustRoot(value.rootId);
      this.assertMember(source.spaceId, input.fromBotId, source.principalId, source.epoch);
      this.assertCurrent(input.fromBotId, value.generation);
      this.assertMember(source.spaceId, input.toBotId, source.principalId, source.epoch);
      const target = this.mustBot(input.toBotId);
      if (!target.ready || !target.controller) throw new HostStateError('blocked', 'Handoff target is not ready');
      const existing = this.getHandoff(input.id);
      if (existing) {
        if (existing.taskId !== input.taskId || existing.fromBotId !== input.fromBotId || existing.toBotId !== input.toBotId || existing.summary !== input.summary) throw new HostStateError('conflict', 'Handoff identity reused');
        return existing;
      }
      if (this.one("SELECT 1 FROM host_handoffs WHERE task_id=? AND state='proposed'", value.id)) throw new HostStateError('blocked', 'Task has a pending handoff');
      this.run('INSERT INTO host_handoffs(id,task_id,from_bot_id,to_bot_id,from_generation,to_generation,summary) VALUES (?,?,?,?,?,?,?)',
        input.id, value.id, value.ownerBotId, input.toBotId, value.generation, target.controller.generation, input.summary);
      return this.getHandoff(input.id)!;
    });
  }
  getHandoff(id: string): HostHandoff | null { const row = this.one('SELECT * FROM host_handoffs WHERE id=?', id); return row ? handoff(row) : null; }
  listHandoffs(taskId?: string): HostHandoff[] { return this.rows(`SELECT * FROM host_handoffs ${taskId ? 'WHERE task_id=?' : ''} ORDER BY rowid`, ...(taskId ? [taskId] : [])).map(handoff); }
  acceptHandoff(id: string, botId: string): HostTask {
    return this.atomic(() => {
      const value = this.getHandoff(id);
      if (!value || value.toBotId !== botId) throw new HostStateError('forbidden', 'Only the named target can accept handoff');
      if (value.state === 'accepted') return this.getTask(value.taskId)!;
      if (value.state !== 'proposed') throw new HostStateError('conflict', 'Handoff is closed');
      const work = this.ownedTask(value.taskId, value.fromBotId); const source = this.mustRoot(work.rootId);
      this.assertMember(source.spaceId, value.fromBotId, source.principalId, source.epoch);
      this.assertMember(source.spaceId, value.toBotId, source.principalId, source.epoch);
      this.assertCurrent(value.fromBotId, value.fromGeneration); const target = this.assertCurrent(botId, value.toGeneration);
      if (!target.ready) throw new HostStateError('blocked', 'Target is not ready');
      if (!work.executionStoppedProof) throw new HostStateError('blocked', 'Previous execution has not been confirmed stopped');
      this.run('UPDATE host_tasks SET owner_bot_id=?,generation=?,stopped_proof=NULL WHERE id=?', botId, value.toGeneration, work.id);
      this.run("UPDATE host_handoffs SET state='accepted',evidence=? WHERE id=?", work.executionStoppedProof, id);
      return this.getTask(work.id)!;
    });
  }
  closeHandoff(id: string, botId: string, state: 'rejected' | 'cancelled', evidence: string): void {
    this.atomic(() => {
      const value = this.getHandoff(id);
      if (!value || (state === 'rejected' ? value.toBotId : value.fromBotId) !== botId) throw new HostStateError('forbidden', 'Handoff actor is not authorized');
      if (value.state === state) return;
      if (value.state !== 'proposed') throw new HostStateError('conflict', 'Handoff is already closed');
      this.run('UPDATE host_handoffs SET state=?,evidence=? WHERE id=?', state, evidence, id);
    });
  }

  beginBatchReset(input: { id: string; principalId: string; botIds: readonly string[]; spaceId?: string }): HostBatchReset {
    return this.atomic(() => {
      const ids = sorted(input.botIds);
      if (!ids.length) throw new HostStateError('conflict', 'Batch must contain explicit bots');
      const existing = this.getBatchReset(input.id);
      if (existing) {
        if (existing.principalId !== input.principalId || existing.spaceId !== (input.spaceId ?? null) || !same(existing.members.map(item => item.botId), ids)) throw new HostStateError('conflict', 'Control operation ID reused');
        return existing;
      }
      const binding = input.spaceId ? this.getGroup(input.spaceId) : null;
      if (input.spaceId && (!binding?.enabled || !same(binding.memberBotIds, ids))) throw new HostStateError('conflict', 'Group reset requires the entire current explicit member snapshot');
      for (const id of ids) {
        this.assertMapped(id, input.principalId);
        const value = this.mustBot(id);
        if (value.ownerPrincipalId && value.ownerPrincipalId !== input.principalId) throw new HostStateError('forbidden', 'Reset cannot take over a bot');
        if (input.spaceId) this.assertMember(input.spaceId, id, input.principalId, binding!.epoch);
        if (this.one('SELECT 1 FROM host_control_locks WHERE bot_id=?', id)) throw new HostStateError('blocked', 'Overlapping control operation must finish first');
      }
      this.run('INSERT INTO host_batches(id,principal_id,space_id,epoch,revision) VALUES (?,?,?,?,?)', input.id, input.principalId, input.spaceId ?? null, binding?.epoch ?? null, binding?.revision ?? null);
      for (const id of ids) {
        this.run('UPDATE host_bots SET owner_id=? WHERE bot_id=? AND owner_id IS NULL', input.principalId, id);
        this.run('INSERT INTO host_batch_members(operation_id,bot_id,previous_generation) VALUES (?,?,?)', input.id, id, this.mustBot(id).controller?.generation ?? 0);
        this.run('INSERT INTO host_control_locks(bot_id,operation_id) VALUES (?,?)', id, input.id);
        // The intake boundary is durable before any cancellation outside SQLite.
        for (const row of this.rows("SELECT id FROM host_events WHERE bot_id=? AND state IN ('queued','reserved')", id)) this.cancelEventInner(String(row.id), 'reset-frozen');
      }
      return this.getBatchReset(input.id)!;
    });
  }
  getBatchReset(id: string): HostBatchReset | null {
    const row = this.one('SELECT * FROM host_batches WHERE id=?', id); if (!row) return null;
    return { id: String(row.id), principalId: String(row.principal_id), spaceId: row.space_id === null ? null : String(row.space_id),
      state: String(row.state) as HostBatchReset['state'], epoch: row.epoch === null ? null : Number(row.epoch), revision: row.revision === null ? null : Number(row.revision),
      error: row.error === null ? null : String(row.error), members: this.rows('SELECT * FROM host_batch_members WHERE operation_id=? ORDER BY bot_id', id).map(item => ({
        botId: String(item.bot_id), previousGeneration: Number(item.previous_generation), cancellation: String(item.cancellation) as HostBatchMember['cancellation'],
        cancellationDetail: item.cancellation_detail === null ? null : String(item.cancellation_detail), prepared: item.prepared_json === null ? null : parse<HostController>(item.prepared_json),
        initialization: String(item.initialization) as HostBatchMember['initialization'], initializationDetail: item.initialization_detail === null ? null : String(item.initialization_detail),
      })) };
  }
  listUnfinishedBatches(): HostBatchReset[] {
    return this.rows("SELECT id FROM host_batches WHERE state NOT IN ('completed','cancelled') ORDER BY rowid").map(row => this.getBatchReset(String(row.id))!);
  }
  private mutableBatch(id: string): HostBatchReset {
    const value = this.getBatchReset(id); if (!value) throw new HostStateError('not-found', 'Unknown control operation');
    if (['committed', 'initializing', 'completed', 'cancelled'].includes(value.state)) throw new HostStateError('conflict', 'Control operation is already committed or closed');
    return value;
  }
  recordBatchCancellation(id: string, botId: string, input: { confirmed: boolean; detail: string }): void {
    required(input.detail, 'Cancellation evidence');
    this.atomic(() => {
      const value = this.mutableBatch(id);
      const member = value.members.find(item => item.botId === botId); if (!member) throw new HostStateError('forbidden', 'Bot is not in reset snapshot');
      if (member.cancellation === 'confirmed' && !input.confirmed) throw new HostStateError('conflict', 'Confirmed cancellation cannot be undone');
      this.run('UPDATE host_batch_members SET cancellation=?,cancellation_detail=? WHERE operation_id=? AND bot_id=?', input.confirmed ? 'confirmed' : 'blocked', input.detail, id, botId);
      this.run('UPDATE host_batches SET state=?,error=? WHERE id=?', input.confirmed ? 'cancelling' : 'blocked', input.confirmed ? null : input.detail, id);
    });
  }
  prepareBatchController(id: string, botId: string, controller: HostController): void {
    this.atomic(() => {
      const value = this.mutableBatch(id);
      const member = value.members.find(item => item.botId === botId);
      if (!member || member.cancellation !== 'confirmed') throw new HostStateError('blocked', 'Confirm old scheduled execution stopped before preparing a controller');
      this.assertControllerChange(botId, controller, member.previousGeneration, id);
      if (member.prepared && !same(member.prepared, controller)) throw new HostStateError('conflict', 'Prepared controller identity is immutable');
      this.run('UPDATE host_batch_members SET prepared_json=? WHERE operation_id=? AND bot_id=?', JSON.stringify(controller), id, botId);
      const prepared = this.getBatchReset(id)!;
      this.run('UPDATE host_batches SET state=? WHERE id=?', prepared.members.every(item => item.prepared && item.cancellation === 'confirmed') ? 'prepared' : 'cancelling', id);
    });
  }
  commitBatchReset(id: string): HostBatchReset {
    return this.atomic(() => {
      const existing = this.getBatchReset(id); if (!existing) throw new HostStateError('not-found', 'Unknown control operation');
      if (['committed', 'initializing', 'completed'].includes(existing.state)) return existing;
      const value = this.mutableBatch(id);
      this.assertPrincipal(value.principalId);
      if (value.spaceId) {
        const current = this.getGroup(value.spaceId);
        if (!current?.enabled || current.epoch !== value.epoch || current.revision !== value.revision || !same(current.memberBotIds, value.members.map(item => item.botId))) throw new HostStateError('stale', 'Group changed during reset; reconcile the frozen operation');
      }
      for (const member of value.members) {
        this.assertMapped(member.botId, value.principalId);
        if (this.mustBot(member.botId).ownerPrincipalId !== value.principalId) throw new HostStateError('forbidden', 'Bot owner changed');
        if (member.cancellation !== 'confirmed' || !member.prepared) throw new HostStateError('blocked', 'Not every member is safely cancelled and prepared');
        this.assertControllerChange(member.botId, member.prepared, member.previousGeneration, id);
      }
      for (const member of value.members) {
        this.run('UPDATE host_bots SET controller_json=?,ready=0 WHERE bot_id=?', JSON.stringify(member.prepared), member.botId);
        this.invalidateGeneration(member.botId, member.previousGeneration);
      }
      this.run("UPDATE host_batches SET state='committed',error=NULL WHERE id=?", id);
      this.run('DELETE FROM host_control_locks WHERE operation_id=?', id);
      return this.getBatchReset(id)!;
    });
  }
  recordBatchInitialization(id: string, botId: string, input: { ready: boolean; detail: string }): HostBatchReset {
    return this.atomic(() => {
      const value = this.getBatchReset(id);
      if (!value || !['committed', 'initializing', 'completed'].includes(value.state)) throw new HostStateError('conflict', 'Commit the whole batch before initializing');
      const member = value.members.find(item => item.botId === botId); if (!member?.prepared) throw new HostStateError('forbidden', 'Bot is not in committed reset');
      this.assertCurrent(botId, member.prepared.generation);
      this.run('UPDATE host_batch_members SET initialization=?,initialization_detail=? WHERE operation_id=? AND bot_id=?', input.ready ? 'ready' : 'failed', input.detail, id, botId);
      this.run('UPDATE host_bots SET ready=? WHERE bot_id=?', Number(input.ready), botId);
      const updated = this.getBatchReset(id)!;
      this.run('UPDATE host_batches SET state=? WHERE id=?', updated.members.every(item => item.initialization !== 'pending') ? 'completed' : 'initializing', id);
      return this.getBatchReset(id)!;
    });
  }
  cancelBatchReset(id: string, evidence: string): void {
    required(evidence, 'Reconciliation evidence');
    this.atomic(() => {
      this.mutableBatch(id);
      this.run("UPDATE host_batches SET state='cancelled',error=? WHERE id=?", evidence, id);
      this.run('DELETE FROM host_control_locks WHERE operation_id=?', id);
    });
  }

  /** Run only after exclusive host ownership: a live peer must never be recovered. */
  recoverInFlight(): { uncertainEvents: number; requeuedReservations: number; uncertainSends: number; blockedBatches: number } {
    return this.atomic(() => {
      const reservations = this.rows("SELECT * FROM host_events WHERE state='reserved'");
      for (const row of reservations) {
        const value = event(row);
        if (value.automatic) this.run('UPDATE host_roots SET auto_reserved=auto_reserved-1 WHERE id=? AND auto_reserved>0', value.rootId);
        this.run("UPDATE host_events SET state='queued' WHERE id=?", value.id);
      }
      const uncertainEvents = this.run("UPDATE host_events SET state='uncertain',error='host-restarted-before-native-end' WHERE state='running'");
      const uncertainSends = this.run("UPDATE host_outbox SET state='uncertain',evidence='host-restarted-during-send' WHERE state='sending'")
        + this.run("UPDATE host_routed_outbox SET state='uncertain',evidence='host-restarted-during-send' WHERE state='sending'");
      const blockedBatches = this.run("UPDATE host_batches SET state='blocked',error='host-restarted-during-cancellation-or-preparation; reconcile external effects' WHERE state IN ('frozen','cancelling','prepared')");
      return { uncertainEvents, requeuedReservations: reservations.length, uncertainSends, blockedBatches };
    });
  }
}
