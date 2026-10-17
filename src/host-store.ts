import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import type { AgentName, BridgePlatform } from './types.js';

type Row = Record<string, string | number | bigint | Uint8Array | null>;
// Readable bystander history, including legacy scene rows, does not trigger reassessment.
const sceneRefreshEligible = `(kind<>'context' OR EXISTS (SELECT 1 FROM host_context_records c
  WHERE host_scene_log.id='context:'||c.id AND c.space_id=host_scene_log.space_id
    AND c.epoch=host_scene_log.epoch AND c.can_authorize=1))`;
export type HostReplyAddress = Readonly<Record<string, string>>;
export class HostStateError extends Error {
  constructor(readonly code: 'not-found' | 'conflict' | 'forbidden' | 'stale' | 'blocked' | 'public-reply-limit', message: string) {
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
export interface HostCollaborationRequest {
  id: string; rootId: string; sourceBotId: string; targetBotId: string; text: string;
  mode: 'internal' | 'public'; state: 'registered' | 'queued'; eventId: string;
}
type EnqueueEventInput = { id: string; logicalId?: string; rootId: string; botId: string; generation: number; kind: HostEventKind;
  payload: unknown; publicCursor?: number; causeEventId?: string; sourceBotId?: string; coalesce?: boolean };
export interface HostContextRecord {
  sequence: number; id: string; spaceId: string; epoch: number; receivedAt: string;
  source: { botId: string; messageId: string; userId: string; channelId: string; authorType: string; textTruncated?: true; authorName?: string; time?: string; mentionedUserIds: string[]; replyToMessageId?: string };
  text: string; attachments: unknown[]; canAuthorize: boolean;
}
export interface HostPublicMessage {
  sequence: number; id: string; rootId: string; spaceId: string; epoch: number;
  authorBotId: string | null; principalId: string; text: string; attachments: unknown[];
}
export interface HostSceneUpdate {
  sequence: number; id: string; spaceId: string; epoch: number;
  kind: 'public' | 'context' | 'dispatch' | 'completion'; sourceBotId: string | null;
  text: string; taskId?: string; canAuthorize: false; textTruncated?: true;
  source: { type: 'bot-public' | 'human-public' | 'group-evidence' | 'bridge-execution';
    messageId?: string; authorType?: string; userId?: string; authorName?: string };
}
export interface HostSceneUpdates {
  cursor: number; updates: HostSceneUpdate[]; total: number; truncated: boolean;
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
export interface HostAutomaticDispatch {
  taskId: string; botId: string; conversationId: string; callId: string;
  toolName: 'bridge_start_worker' | 'bridge_continue_worker' | 'bridge_schedule_worker';
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
      CREATE TABLE IF NOT EXISTS host_public_reply_windows(
        space_id TEXT NOT NULL, epoch INTEGER NOT NULL, window INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(space_id,epoch));
      CREATE TABLE IF NOT EXISTS host_public_reply_owner_receipts(
        space_id TEXT NOT NULL, epoch INTEGER NOT NULL, receipt_id TEXT NOT NULL,
        PRIMARY KEY(space_id,epoch,receipt_id));
      CREATE TABLE IF NOT EXISTS host_public_reply_notices(
        bot_id TEXT NOT NULL, space_id TEXT NOT NULL, epoch INTEGER NOT NULL, window INTEGER NOT NULL,
        PRIMARY KEY(bot_id,space_id,epoch,window));
      CREATE TABLE IF NOT EXISTS host_public_reply_counts(
        bot_id TEXT NOT NULL, space_id TEXT NOT NULL, epoch INTEGER NOT NULL, window INTEGER NOT NULL, count INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(bot_id,space_id,epoch));
      CREATE TABLE IF NOT EXISTS host_public_reply_reservations(
        id TEXT PRIMARY KEY, event_id TEXT NOT NULL, bot_id TEXT NOT NULL, space_id TEXT NOT NULL, epoch INTEGER NOT NULL,
        window INTEGER NOT NULL, state TEXT NOT NULL, UNIQUE(event_id,space_id,epoch));
      CREATE TABLE IF NOT EXISTS host_collaboration_requests(
        id TEXT PRIMARY KEY, root_id TEXT NOT NULL REFERENCES host_roots(id), payload_json TEXT NOT NULL,
        state TEXT NOT NULL, event_id TEXT NOT NULL);
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
      CREATE TABLE IF NOT EXISTS host_scene_log(
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,space_id TEXT NOT NULL,epoch INTEGER NOT NULL,
        kind TEXT NOT NULL,source_bot_id TEXT,text TEXT NOT NULL,task_id TEXT,source_json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS host_scene_space ON host_scene_log(space_id,epoch,sequence);
      CREATE TABLE IF NOT EXISTS host_scene_refreshes(
        causal_key TEXT NOT NULL,bot_id TEXT NOT NULL,principal_id TEXT NOT NULL,space_id TEXT NOT NULL,epoch INTEGER NOT NULL,
        PRIMARY KEY(causal_key,bot_id));
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
      CREATE TABLE IF NOT EXISTS host_automatic_dispatches(
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,task_id TEXT NOT NULL REFERENCES host_tasks(id),
        bot_id TEXT NOT NULL,conversation_id TEXT NOT NULL,call_id TEXT NOT NULL,tool_name TEXT NOT NULL,
        UNIQUE(task_id,conversation_id,call_id));
      CREATE UNIQUE INDEX IF NOT EXISTS host_automatic_dispatch_call ON host_automatic_dispatches(bot_id,conversation_id,call_id);
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
  private assertCollaborationRoot(source: HostRoot, sourceBotId?: string): void {
    const mode = source.replyTo.collaborationMode;
    if (mode === undefined) return;
    if (mode !== 'internal' && mode !== 'public') throw new HostStateError('conflict', 'Unknown collaboration mode');
    const initiator = source.replyTo.initiatorBotId;
    if (!initiator) throw new HostStateError('conflict', 'Collaboration initiator is missing');
    const binding = this.assertMember(source.spaceId, initiator, source.principalId, source.epoch);
    if (binding.revision !== source.revision) throw new HostStateError('stale', 'Collaboration group revision changed');
    for (const id of new Set([initiator, ...(sourceBotId ? [sourceBotId] : [])])) {
      this.assertMember(source.spaceId, id, source.principalId, source.epoch);
      const current = this.assertCurrent(id, source.generations[id] ?? 0);
      if (current.ownerPrincipalId !== source.principalId) throw new HostStateError('forbidden', 'Collaboration bot owner changed');
      if (!current.ready) throw new HostStateError('blocked', 'Collaboration controller initialization is incomplete');
    }
  }
  private validateEvent(value: HostEvent): HostRoot {
    const source = this.mustRoot(value.rootId);
    this.assertCollaborationRoot(source, value.sourceBotId ?? undefined);
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
  getCollaborationRequest(id: string): HostCollaborationRequest | null {
    const row = this.one('SELECT * FROM host_collaboration_requests WHERE id=?', id);
    return row ? { ...parse<Omit<HostCollaborationRequest, 'state' | 'eventId'>>(row.payload_json),
      state: String(row.state) as HostCollaborationRequest['state'], eventId: String(row.event_id) } : null;
  }
  listCollaborationRequests(rootId?: string): HostCollaborationRequest[] {
    return this.rows(`SELECT id FROM host_collaboration_requests ${rootId === undefined ? '' : 'WHERE root_id=?'} ORDER BY rowid`,
      ...(rootId === undefined ? [] : [rootId])).map(row => this.getCollaborationRequest(String(row.id))!);
  }
  registerCollaborationRequest(input: Omit<HostCollaborationRequest, 'state' | 'eventId'>): HostCollaborationRequest {
    return this.atomic(() => {
      required(input.id, 'collaboration id'); required(input.text, 'collaboration text');
      if (input.mode !== 'internal' && input.mode !== 'public') throw new HostStateError('conflict', 'Unknown collaboration mode');
      if (input.sourceBotId === input.targetBotId) throw new HostStateError('forbidden', 'Bots cannot collaborate with themselves');
      const previous = this.getCollaborationRequest(input.id);
      const payload = { id: input.id, rootId: input.rootId, sourceBotId: input.sourceBotId, targetBotId: input.targetBotId, text: input.text, mode: input.mode };
      if (previous && !same({ id: previous.id, rootId: previous.rootId, sourceBotId: previous.sourceBotId,
        targetBotId: previous.targetBotId, text: previous.text, mode: previous.mode }, payload)) throw new HostStateError('conflict', 'Collaboration ID reused with changed parameters');
      const source = this.mustRoot(input.rootId);
      if (source.replyTo.collaborationMode !== input.mode || source.replyTo.initiatorBotId !== input.sourceBotId)
        throw new HostStateError('forbidden', 'Collaboration metadata differs from authorization root');
      this.assertCollaborationRoot(source, input.sourceBotId);
      for (const id of [input.sourceBotId, input.targetBotId]) {
        this.assertMember(source.spaceId, id, source.principalId, source.epoch);
        const current = this.assertCurrent(id, source.generations[id] ?? 0);
        if (current.ownerPrincipalId !== source.principalId) throw new HostStateError('forbidden', 'Collaboration requires the same owner');
        if (!current.ready) throw new HostStateError('blocked', 'Collaboration controller initialization is incomplete');
      }
      if (previous) return previous;
      this.run("INSERT INTO host_collaboration_requests(id,root_id,payload_json,state,event_id) VALUES (?,?,?,'registered',?)",
        input.id, input.rootId, JSON.stringify(payload), 'collaboration:' + input.id);
      return this.getCollaborationRequest(input.id)!;
    });
  }
  queueCollaborationRequest(id: string): { request: HostCollaborationRequest; event: HostEvent } {
    return this.atomic(() => {
      const request = this.getCollaborationRequest(id);
      if (!request) throw new HostStateError('not-found', 'Unknown collaboration request');
      if (request.state === 'queued') return { request, event: this.mustEvent(request.eventId) };
      const source = this.mustRoot(request.rootId);
      this.assertCollaborationRoot(source, request.sourceBotId);
      const target = this.assertCurrent(request.targetBotId, source.generations[request.targetBotId] ?? 0);
      if (!target.ready) throw new HostStateError('blocked', 'Collaboration target initialization is incomplete');
      const event = this.enqueueEventInner({ id: request.eventId, rootId: request.rootId, botId: request.targetBotId,
        generation: source.generations[request.targetBotId]!, kind: 'consultation', sourceBotId: request.sourceBotId,
        causeEventId: source.sourceEventId, payload: { text: request.text, audience: request.mode } });
      this.run("UPDATE host_collaboration_requests SET state='queued' WHERE id=?", id);
      return { request: this.getCollaborationRequest(id)!, event };
    });
  }
  private budgetRoots(source: HostRoot): HostRoot[] {
    const key = source.replyTo.collaborationBudgetKey ?? source.id;
    // Include the original human root even when it predates the shared-budget field.
    return this.rows("SELECT * FROM host_roots WHERE principal_id=? AND (id=? OR json_extract(reply_json,'$.collaborationBudgetKey')=?)",
      source.principalId, key, key).map(root);
  }
  budgetSnapshot(rootId: string): { limit: number; used: number; reserved: number } {
    const values = this.budgetRoots(this.mustRoot(rootId));
    return { limit: Math.min(...values.map(value => value.automaticLimit)),
      used: values.reduce((sum, value) => sum + value.automaticUsed, 0),
      reserved: values.reduce((sum, value) => sum + value.automaticReserved, 0) };
  }
  claimBudgetExhaustionNotice(rootId: string): boolean {
    return this.atomic(() => {
      const source = this.mustRoot(rootId), values = this.budgetRoots(source);
      const budget = this.budgetSnapshot(rootId);
      if (budget.used + budget.reserved < budget.limit || values.some(value => value.exhaustionNotified)) return false;
      for (const value of values) this.run('UPDATE host_roots SET exhaustion_notified=1 WHERE id=?', value.id);
      return true;
    });
  }
  enqueueEvent(input: EnqueueEventInput): HostEvent {
    return this.atomic(() => this.enqueueEventInner(input));
  }
  private enqueueEventInner(input: EnqueueEventInput): HostEvent {
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
    this.assertCollaborationRoot(source, input.sourceBotId);
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
      if (automatic && this.publicReplyClass(id) === 'public-auto') this.run('UPDATE host_events SET automatic=0 WHERE id=?', id);
      if (initial) this.run('INSERT INTO host_initial_participation(root_id,bot_id,event_id) VALUES (?,?,?)', source.id, input.botId, id);
    }
    this.run('INSERT INTO host_deliveries(logical_id,bot_id,generation,event_id) VALUES (?,?,?,?)', logicalId, input.botId, input.generation, id);
    return this.mustEvent(id);
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
        const budget = this.budgetSnapshot(source.id);
        if (this.usesRootBudget(value) && budget.used + budget.reserved >= budget.limit) {
          this.cancelEventInner(value.id, 'root-budget-exhausted'); continue;
        }
        if (this.usesRootBudget(value)) this.run('UPDATE host_roots SET auto_reserved=auto_reserved+1 WHERE id=?', source.id);
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
      if (this.usesRootBudget(value)) this.run('UPDATE host_roots SET auto_reserved=auto_reserved-1,auto_used=auto_used+1 WHERE id=? AND auto_reserved>0', value.rootId);
      this.run("UPDATE host_events SET state='running' WHERE id=?", id);
      return this.mustEvent(id);
    });
  }
  publicReplyClass(eventId: string): 'public-auto' | 'internal' | 'owner' | 'worker-result' | 'wake' {
    const value = this.mustEvent(eventId), source = this.mustRoot(value.rootId);
    if (value.kind === 'human') return 'owner';
    if (source.replyTo.collaborationMode === 'internal') return 'internal';
    if (value.kind === 'observation') return 'public-auto';
    if (value.kind === 'consultation') return (value.payload as { audience?: string } | null)?.audience === 'public' ? 'public-auto' : 'internal';
    if (value.kind === 'handoff') return 'internal';
    let ancestor: HostEvent | null = value;
    const seen = new Set<string>();
    while (ancestor && !seen.has(ancestor.id)) {
      seen.add(ancestor.id);
      const payload = ancestor.payload as { audience?: string } | null;
      if (ancestor.kind === 'handoff' || ancestor.kind === 'consultation' && payload?.audience !== 'public') return 'internal';
      ancestor = ancestor.causeEventId ? this.getEvent(ancestor.causeEventId) : null;
    }
    if (value.kind === 'assistant-result') return 'worker-result';
    if (value.kind === 'wake') return 'wake';
    return 'public-auto';
  }
  private usesRootBudget(value: HostEvent): boolean { return value.automatic && this.publicReplyClass(value.id) !== 'public-auto'; }
  private publicReplyWindow(spaceId: string, epoch: number): number {
    return Number(this.one('SELECT window FROM host_public_reply_windows WHERE space_id=? AND epoch=?', spaceId, epoch)?.window ?? 0);
  }
  publicReplySnapshot(botId: string, spaceId: string): { limit: number; count: number; reserved: number; remaining: number; window: number; epoch: number } {
    const group = this.getGroup(spaceId); if (!group) throw new HostStateError('not-found', 'Unknown public reply group');
    this.assertMember(spaceId, botId, group.principalId, group.epoch);
    const window = this.publicReplyWindow(spaceId, group.epoch);
    const count = Number(this.one('SELECT count FROM host_public_reply_counts WHERE bot_id=? AND space_id=? AND epoch=? AND window=?', botId, spaceId, group.epoch, window)?.count ?? 0);
    const reserved = Number(this.one("SELECT COUNT(*) AS n FROM host_public_reply_reservations WHERE bot_id=? AND space_id=? AND epoch=? AND window=? AND state IN ('reserved','uncertain')", botId, spaceId, group.epoch, window)!.n);
    return { limit: 8, count, reserved, remaining: Math.max(0, 8 - count - reserved), window, epoch: group.epoch };
  }
  claimPublicReplyLimitNotice(botId: string, spaceId: string): boolean {
    return this.atomic(() => {
      const snapshot = this.publicReplySnapshot(botId, spaceId);
      if (snapshot.remaining || this.one('SELECT 1 FROM host_public_reply_notices WHERE bot_id=? AND space_id=? AND epoch=? AND window=?', botId, spaceId, snapshot.epoch, snapshot.window)) return false;
      this.run('INSERT INTO host_public_reply_notices(bot_id,space_id,epoch,window) VALUES(?,?,?,?)', botId, spaceId, snapshot.epoch, snapshot.window);
      return true;
    });
  }
  resetPublicReplies(spaceId: string, principalId: string, receiptId: string, epoch: number): boolean {
    return this.atomic(() => {
      required(receiptId, 'Owner input receipt');
      const group = this.getGroup(spaceId);
      if (!group?.enabled || group.principalId !== principalId || group.epoch !== epoch) throw new HostStateError('stale', 'Owner input group changed');
      if (this.one('SELECT 1 FROM host_public_reply_owner_receipts WHERE space_id=? AND epoch=? AND receipt_id=?', spaceId, epoch, receiptId)) return false;
      this.run('INSERT INTO host_public_reply_owner_receipts(space_id,epoch,receipt_id) VALUES(?,?,?)', spaceId, epoch, receiptId);
      this.run('INSERT INTO host_public_reply_windows(space_id,epoch,window) VALUES(?,?,1) ON CONFLICT(space_id,epoch) DO UPDATE SET window=window+1', spaceId, epoch);
      return true;
    });
  }
  reservePublicReply(eventId: string, targetSpaceId: string): { applicable: boolean; reservationId: string | null; alreadyCounted: boolean } {
    return this.atomic(() => {
      const value = this.mustEvent(eventId);
      if (this.publicReplyClass(eventId) !== 'public-auto') return { applicable: false, reservationId: null, alreadyCounted: false };
      const source = this.validateEvent(value), group = this.getGroup(targetSpaceId);
      if (value.state !== 'running' || value.nativeEnded || !group?.enabled) throw new HostStateError('blocked', 'Public reply turn is not current');
      this.assertMember(targetSpaceId, value.botId, source.principalId, group.epoch);
      const old = this.one('SELECT * FROM host_public_reply_reservations WHERE event_id=? AND space_id=? AND epoch=?', eventId, targetSpaceId, group.epoch);
      if (old && old.state === 'confirmed') return { applicable: true, reservationId: String(old.id), alreadyCounted: true };
      if (old && old.state !== 'released') throw new HostStateError('blocked', 'Public reply already reserved or delivery is unknown');
      const snapshot = this.publicReplySnapshot(value.botId, targetSpaceId);
      if (!snapshot.remaining) throw new HostStateError('public-reply-limit', 'Public non-owner reply limit reached; receive context or stay silent until a new owner message');
      // A released reservation may be retried only within the same owner-input window.
      if (old && Number(old.window) !== snapshot.window) throw new HostStateError('stale', 'Old reply reservation cannot cross a new owner input');
      const id = old ? String(old.id) : JSON.stringify([eventId, targetSpaceId, group.epoch]);
      if (old) this.run("UPDATE host_public_reply_reservations SET state='reserved' WHERE id=?", id);
      else this.run("INSERT INTO host_public_reply_reservations(id,event_id,bot_id,space_id,epoch,window,state) VALUES(?,?,?,?,?,?,'reserved')", id, eventId, value.botId, targetSpaceId, group.epoch, snapshot.window);
      return { applicable: true, reservationId: id, alreadyCounted: false };
    });
  }
  finishPublicReply(reservationId: string, outcome: 'confirmed' | 'released' | 'uncertain'): void {
    this.atomic(() => {
      const row = this.one('SELECT * FROM host_public_reply_reservations WHERE id=?', reservationId);
      if (!row) throw new HostStateError('not-found', 'Unknown public reply reservation');
      if (row.state === outcome || row.state === 'confirmed') return;
      if (row.state === 'released') throw new HostStateError('conflict', 'Released public reply was not sent');
      if (row.state === 'uncertain' && outcome !== 'confirmed') throw new HostStateError('blocked', 'Unknown public delivery cannot be released without proof');
      this.run('UPDATE host_public_reply_reservations SET state=? WHERE id=?', outcome, reservationId);
      if (outcome !== 'confirmed' || this.publicReplyWindow(String(row.space_id), Number(row.epoch)) !== Number(row.window)) return;
      this.run('INSERT INTO host_public_reply_counts(bot_id,space_id,epoch,window,count) VALUES(?,?,?,?,1) ON CONFLICT(bot_id,space_id,epoch) DO UPDATE SET window=excluded.window,count=CASE WHEN window=excluded.window THEN count+1 ELSE 1 END', String(row.bot_id), String(row.space_id), Number(row.epoch), Number(row.window));
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
      if (input.canAuthorize) this.appendSceneInner({ id: 'context:' + input.id, spaceId: input.spaceId, epoch: input.epoch,
        kind: 'context', sourceBotId: null, text: input.text,
        source: { type: 'group-evidence', messageId: input.source.messageId, authorType: input.source.authorType,
          userId: input.source.userId, ...(input.source.authorName ? { authorName: input.source.authorName } : {}) } });
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

  private appendSceneInner(input: Omit<HostSceneUpdate, 'sequence' | 'canAuthorize' | 'textTruncated'>): HostSceneUpdate {
    const previous = this.one('SELECT * FROM host_scene_log WHERE id=?', input.id);
    if (previous) {
      if (previous.space_id !== input.spaceId || Number(previous.epoch) !== input.epoch || previous.kind !== input.kind
        || previous.source_bot_id !== input.sourceBotId || previous.text !== input.text || previous.task_id !== (input.taskId ?? null)
        || !same(parse<unknown>(previous.source_json), input.source)) throw new HostStateError('conflict', 'Scene change identity reused');
      return this.sceneUpdate(previous);
    }
    this.run('INSERT INTO host_scene_log(id,space_id,epoch,kind,source_bot_id,text,task_id,source_json) VALUES(?,?,?,?,?,?,?,?)',
      input.id, input.spaceId, input.epoch, input.kind, input.sourceBotId, input.text, input.taskId ?? null, JSON.stringify(input.source));
    return this.sceneUpdate(this.one('SELECT * FROM host_scene_log WHERE id=?', input.id)!);
  }
  private appendPublicSceneInner(id: string, spaceId: string, epoch: number, sourceBotId: string | null, text: string): void {
    this.appendSceneInner({ id: 'public:' + id, spaceId, epoch, kind: 'public', sourceBotId, text,
      source: { type: sourceBotId === null ? 'human-public' : 'bot-public', messageId: id } });
  }
  private sceneUpdate(row: Row): HostSceneUpdate {
    const text = String(row.text), bounded = text.slice(0, 1600);
    return { sequence: Number(row.sequence), id: String(row.id), spaceId: String(row.space_id), epoch: Number(row.epoch),
      kind: String(row.kind) as HostSceneUpdate['kind'], sourceBotId: row.source_bot_id === null ? null : String(row.source_bot_id),
      text: bounded, ...(text.length > bounded.length ? { textTruncated: true as const } : {}),
      ...(row.task_id === null ? {} : { taskId: String(row.task_id) }),
      source: parse<HostSceneUpdate['source']>(row.source_json), canAuthorize: false };
  }
  /** Only public execution facts belong here; private consultations never become group evidence. */
  appendSceneProgress(input: { id: string; spaceId: string; epoch: number; botId: string;
    kind: 'dispatch' | 'completion'; text: string; taskId?: string }): HostSceneUpdate {
    return this.atomic(() => {
      required(input.id, 'Scene progress id');
      if (input.kind !== 'dispatch' && input.kind !== 'completion') throw new HostStateError('conflict', 'Unknown execution scene change');
      const group = this.getGroup(input.spaceId); if (!group) throw new HostStateError('not-found', 'Unknown group');
      this.assertMember(input.spaceId, input.botId, group.principalId, input.epoch);
      if (input.taskId) {
        const value = this.getTask(input.taskId); if (!value) throw new HostStateError('not-found', 'Unknown scene task');
        const source = this.mustRoot(value.rootId);
        if (value.ownerBotId !== input.botId || value.spaceId !== input.spaceId || source.epoch !== input.epoch)
          throw new HostStateError('forbidden', 'Execution scene change belongs to another task owner or group');
        if (source.replyTo.collaborationMode === 'internal') throw new HostStateError('forbidden', 'Private task cannot enter the public scene');
      }
      return this.appendSceneInner({ id: 'progress:' + input.id, spaceId: input.spaceId, epoch: input.epoch, kind: input.kind,
        sourceBotId: input.botId, text: input.text, ...(input.taskId ? { taskId: input.taskId } : {}), source: { type: 'bridge-execution' } });
    });
  }
  private sceneCursorInner(spaceId: string, epoch: number): number {
    return Number(this.one(`SELECT MAX(sequence) AS cursor FROM host_scene_log WHERE space_id=? AND epoch=? AND ${sceneRefreshEligible}`, spaceId, epoch)?.cursor ?? 0);
  }
  sceneCursor(spaceId: string, botId: string): number {
    const group = this.getGroup(spaceId); if (!group) throw new HostStateError('not-found', 'Unknown group');
    this.assertMember(spaceId, botId, group.principalId, group.epoch);
    return this.sceneCursorInner(spaceId, group.epoch);
  }
  readSceneUpdates(spaceId: string, botId: string, after: number, limit = 20): HostSceneUpdates {
    return this.atomic(() => {
      const group = this.getGroup(spaceId); if (!group) throw new HostStateError('not-found', 'Unknown group');
      this.assertMember(spaceId, botId, group.principalId, group.epoch);
      if (!Number.isSafeInteger(after) || after < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100)
        throw new HostStateError('conflict', 'Scene cursor must be nonnegative and limit must be 1..100');
      const cursor = this.sceneCursorInner(spaceId, group.epoch);
      // Own synchronous effects were already known to this controller. An asynchronous completion was not.
      const where = `space_id=? AND epoch=? AND sequence>? AND ${sceneRefreshEligible} AND NOT (source_bot_id IS ? AND kind IN ('public','dispatch'))`;
      const args: SQLInputValue[] = [spaceId, group.epoch, after, botId];
      const total = Number(this.one(`SELECT COUNT(*) AS n FROM host_scene_log WHERE ${where}`, ...args)!.n);
      const updates = this.rows(`SELECT * FROM (SELECT * FROM host_scene_log WHERE ${where} ORDER BY sequence DESC LIMIT ?) ORDER BY sequence`,
        ...args, limit).map(row => this.sceneUpdate(row));
      return { cursor, updates, total, truncated: total > updates.length || updates.some(value => value.textTruncated) };
    });
  }
  /** One extra model judgment per Bot and original owner request, shared by derived collaboration roots. */
  consumeSceneRefresh(rootId: string, botId: string): boolean {
    return this.atomic(() => {
      const source = this.mustRoot(rootId);
      this.assertCollaborationRoot(source);
      this.assertMember(source.spaceId, botId, source.principalId, source.epoch);
      this.assertCurrent(botId, source.generations[botId] ?? 0);
      const key = source.replyTo.collaborationBudgetKey ?? source.id;
      const original = this.getRoot(key);
      if (original && original.principalId !== source.principalId)
        throw new HostStateError('forbidden', 'Scene refresh causal key belongs to another authorization');
      const previous = this.one('SELECT * FROM host_scene_refreshes WHERE causal_key=? AND bot_id=?', key, botId);
      if (previous && previous.principal_id !== source.principalId)
        throw new HostStateError('forbidden', 'Scene refresh budget cannot cross group authorization');
      return this.run('INSERT OR IGNORE INTO host_scene_refreshes(causal_key,bot_id,principal_id,space_id,epoch) VALUES(?,?,?,?,?)',
        key, botId, source.principalId, source.spaceId, source.epoch) === 1;
    });
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
      this.appendPublicSceneInner(input.id, source.spaceId, source.epoch, input.authorBotId ?? null, input.text);
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
      this.appendPublicSceneInner(messageId, source.spaceId, source.epoch, delivery.botId, text);
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
      this.appendPublicSceneInner(publicId, target.spaceId!, target.epoch!, source.botId, delivery.payload.text);
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

  claimTask(input: { id: string; rootId: string; botId: string; generation: number; title: string; resources?: readonly string[];
    automaticDispatch?: Omit<HostAutomaticDispatch, 'taskId' | 'botId'> }): { claimed: boolean; task: HostTask } {
    return this.atomic(() => {
      const source = this.mustRoot(input.rootId);
      this.assertMember(source.spaceId, input.botId, source.principalId, source.epoch);
      this.assertCurrent(input.botId, input.generation);
      if (source.generations[input.botId] !== input.generation) throw new HostStateError('stale', 'Old root cannot authorize work in a new controller generation');
      if (this.one('SELECT 1 FROM host_control_locks WHERE bot_id=?', input.botId)) throw new HostStateError('blocked', 'Bot control operation is frozen');
      const previous = this.getTask(input.id);
      if (previous) {
        if (previous.rootId !== input.rootId) throw new HostStateError('conflict', 'Task identity cannot cross root authorization');
        if (input.automaticDispatch) this.registerAutomaticDispatchInner({ ...input.automaticDispatch, taskId: input.id, botId: input.botId });
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
      if (input.automaticDispatch) this.registerAutomaticDispatchInner({ ...input.automaticDispatch, taskId: input.id, botId: input.botId });
      return { claimed: true, task: this.getTask(input.id)! };
    });
  }
  getTask(id: string): HostTask | null { const row = this.one('SELECT * FROM host_tasks WHERE id=?', id); return row ? task(row) : null; }
  listTasks(spaceId?: string): HostTask[] { return this.rows(`SELECT * FROM host_tasks ${spaceId ? 'WHERE space_id=?' : ''} ORDER BY rowid`, ...(spaceId ? [spaceId] : [])).map(task); }
  registerAutomaticDispatch(input: HostAutomaticDispatch): HostAutomaticDispatch {
    return this.atomic(() => this.registerAutomaticDispatchInner(input));
  }
  private registerAutomaticDispatchInner(input: HostAutomaticDispatch): HostAutomaticDispatch {
      required(input.conversationId, 'Automatic dispatch conversation'); required(input.callId, 'Automatic dispatch call id');
      if (!['bridge_start_worker', 'bridge_continue_worker', 'bridge_schedule_worker'].includes(input.toolName))
        throw new HostStateError('conflict', 'Unknown automatic dispatch tool');
      const value = this.getTask(input.taskId);
      if (!value || value.ownerBotId !== input.botId)
        throw new HostStateError('forbidden', 'Automatic dispatch does not belong to this bot task');
      const sameCall = this.one('SELECT task_id FROM host_automatic_dispatches WHERE bot_id=? AND conversation_id=? AND call_id=?',
        input.botId, input.conversationId, input.callId);
      if (sameCall && sameCall.task_id !== input.taskId) throw new HostStateError('conflict', 'Automatic dispatch call belongs to another task');
      const previous = this.one('SELECT * FROM host_automatic_dispatches WHERE task_id=? AND conversation_id=? AND call_id=?',
        input.taskId, input.conversationId, input.callId);
      if (previous) {
        if (previous.bot_id !== input.botId || previous.tool_name !== input.toolName)
          throw new HostStateError('conflict', 'Automatic dispatch identity reused');
        return { taskId: input.taskId, botId: input.botId, conversationId: input.conversationId, callId: input.callId, toolName: input.toolName };
      }
      if (value.state !== 'active') throw new HostStateError('blocked', 'Automatic dispatch task is not active');
      const source = this.mustRoot(value.rootId);
      this.assertMember(source.spaceId, input.botId, source.principalId, source.epoch);
      const current = this.assertCurrent(input.botId, value.generation);
      if (current.controller!.conversationId !== input.conversationId) throw new HostStateError('stale', 'Automatic dispatch conversation changed');
      this.run('INSERT INTO host_automatic_dispatches(task_id,bot_id,conversation_id,call_id,tool_name) VALUES(?,?,?,?,?)',
        input.taskId, input.botId, input.conversationId, input.callId, input.toolName);
      return { taskId: input.taskId, botId: input.botId, conversationId: input.conversationId, callId: input.callId, toolName: input.toolName };
  }
  getAutomaticDispatch(taskId: string): HostAutomaticDispatch | null {
    const row = this.one('SELECT * FROM host_automatic_dispatches WHERE task_id=? ORDER BY sequence DESC LIMIT 1', taskId);
    return row ? { taskId: String(row.task_id), botId: String(row.bot_id), conversationId: String(row.conversation_id),
      callId: String(row.call_id), toolName: String(row.tool_name) as HostAutomaticDispatch['toolName'] } : null;
  }
  listAutomaticDispatches(taskId: string): HostAutomaticDispatch[] {
    return this.rows('SELECT * FROM host_automatic_dispatches WHERE task_id=? ORDER BY sequence', taskId)
      .map(row => ({ taskId: String(row.task_id), botId: String(row.bot_id), conversationId: String(row.conversation_id),
        callId: String(row.call_id), toolName: String(row.tool_name) as HostAutomaticDispatch['toolName'] }));
  }
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
  /** Continue an existing assistant without replacing its original task authority or reply address. */
  reopenTaskForContinuation(taskId: string, botId: string, generation: number, rootId: string): HostTask {
    return this.atomic(() => {
      const value = this.getTask(taskId); if (!value) throw new HostStateError('not-found', 'Unknown continuation task');
      if (value.ownerBotId !== botId) throw new HostStateError('forbidden', 'Continuation task belongs to another bot');
      const original = this.mustRoot(value.rootId), source = this.mustRoot(rootId);
      if (source.principalId !== original.principalId || source.spaceId !== value.spaceId)
        throw new HostStateError('forbidden', 'Continuation cannot widen the original task authorization');
      if (source.epoch !== original.epoch) throw new HostStateError('stale', 'Continuation cannot cross group activation epochs');
      this.assertCollaborationRoot(source);
      this.assertMember(source.spaceId, botId, source.principalId, source.epoch);
      const current = this.assertCurrent(botId, generation);
      if (source.generations[botId] !== generation) throw new HostStateError('stale', 'Continuation root has another controller generation');
      if (current.ownerPrincipalId !== source.principalId) throw new HostStateError('forbidden', 'Continuation owner changed');
      if (!current.ready) throw new HostStateError('blocked', 'Continuation controller is not ready');
      if (this.one('SELECT 1 FROM host_control_locks WHERE bot_id=?', botId)) throw new HostStateError('blocked', 'Bot control operation is frozen');
      if (this.one("SELECT 1 FROM host_handoffs WHERE task_id=? AND state='proposed'", taskId))
        throw new HostStateError('blocked', 'Resolve pending handoff before continuing execution');
      if (value.state === 'active') {
        if (value.generation !== generation) throw new HostStateError('stale', 'Active task belongs to another controller generation');
        return value;
      }
      if (!value.executionStoppedProof?.trim()) throw new HostStateError('blocked', 'Previous execution has not been confirmed stopped');
      for (const resource of value.resources) {
        const owner = this.one('SELECT task_id FROM host_resource_claims WHERE resource=?', resource);
        if (owner && owner.task_id !== taskId) throw new HostStateError('blocked', `Resource ${resource} is owned by task ${owner.task_id}`);
      }
      for (const resource of value.resources) this.run('INSERT OR IGNORE INTO host_resource_claims(resource,task_id) VALUES (?,?)', resource, taskId);
      this.run("UPDATE host_tasks SET state='active',generation=?,stopped_proof=NULL WHERE id=?", generation, taskId);
      return this.getTask(taskId)!;
    });
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
      this.run("UPDATE host_public_reply_reservations SET state='uncertain' WHERE state='reserved'");
      const uncertainSends = this.run("UPDATE host_outbox SET state='uncertain',evidence='host-restarted-during-send' WHERE state='sending'")
        + this.run("UPDATE host_routed_outbox SET state='uncertain',evidence='host-restarted-during-send' WHERE state='sending'");
      const blockedBatches = this.run("UPDATE host_batches SET state='blocked',error='host-restarted-during-cancellation-or-preparation; reconcile external effects' WHERE state IN ('frozen','cancelling','prepared')");
      return { uncertainEvents, requeuedReservations: reservations.length, uncertainSends, blockedBatches };
    });
  }
}
