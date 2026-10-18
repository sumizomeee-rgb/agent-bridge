import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, dirname, resolve, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { setImmediate as nextImmediate } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import { HostRuntime } from '../src/host-runtime.js';
import { HostStore } from '../src/host-store.js';
import { ControllerStore } from '../src/controller/store.js';
import type { ControllerWorker, ControllerJobStatus } from '../src/controller/runtime-types.js';
import { SessionManager, type SessionManagerOptions } from '../src/manager.js';
import { SessionStore } from '../src/store.js';
import type { BotRuntime } from '../src/bot-runtime.js';
import type { HostSemanticMarker } from '../src/host-migration.js';
import type { HostConfig } from '../src/config.js';
import type { AgentAdapter, AgentTurn, BridgeConfig, IncomingDM, ReplyOptions } from '../src/types.js';
import type { DMHistoryOptions, DMHistoryPage } from '../src/ingress.js';
import { historyPage, type ConversationHistoryOptions, type ConversationHistoryPage } from '../src/group-history.js';
import { groupMessagePayloadHash, type GroupMentionView } from '../src/group-mentions.js';
import type { WorkerOverview } from '../src/overview.js';

test('current group envelope reports real broadcast recipients, internal speaker and non-authorizing compact evidence', async t => {
  const f = fixture(t); await f.activate();
  const seen: Array<{ botId: string; text: string; scene: any }> = [];
  f.run(async (botId, turn) => {
    seen.push({ botId, text: turn.text, scene: JSON.parse(turn.chatScene!) });
    if (botId === A && !turn.event) await f.host.invoke(A, turn, 'bridge_send_bot', { targetBotId: B, text: 'internal exact speaker' }, 'envelope-consult');
    if (turn.event && turn.text === 'internal exact speaker') {
      const targets: any = await f.host.invoke(botId, turn, 'bridge_delivery_targets', {});
      assert.equal(targets.defaultTargetId, null);
      await assert.rejects(turn.onPublicMessage!('not an implicit public reply'), /内部消息/);
    }
    await turn.onSilent?.();
  });
  const guest = f.message(A, 'envelope-guest', 'read-only guest evidence'); guest.userId = `${A}|outside-whitelist`;
  await f.host.receive(A, guest);
  await f.host.receive(A, f.message(A, 'envelope-owner', 'Teto please inspect', G1, [A])); await f.drain();
  const humans = seen.filter(value => value.text === 'Teto please inspect');
  assert.equal(humans.length, 2);
  for (const { scene } of humans) {
    assert.equal(scene.currentMessage.eventKind, 'human');
    assert.equal(scene.currentMessage.speaker.type, 'user');
    assert.deepEqual(scene.currentMessage.directRecipients.botIds, [A, B]);
    assert.equal(scene.currentMessage.authorization.freshOwnerInput, true);
    assert.equal(scene.currentMessage.defaultDelivery.area, 'group');
    assert.equal(scene.conversationEvidence.recent.some((record: any) => record.text === 'Teto please inspect'), false);
    assert.equal(scene.publicProgress.some((record: any) => record.text === 'Teto please inspect'), false);
    assert.equal(scene.conversationEvidence.recent[0].canAuthorize, false);
    assert.equal('unread' in scene.conversationEvidence, false);
  }
  const internal = seen.find(value => value.text === 'internal exact speaker')!.scene.currentMessage;
  assert.equal(internal.eventKind, 'consultation'); assert.equal(internal.speaker.botId, A);
  assert.equal(internal.visibility, 'internal'); assert.equal(internal.authorization.freshOwnerInput, false);
  assert.equal(internal.defaultDelivery.area, 'internal'); assert.equal(internal.defaultDelivery.targetBotId, A);
  assert.equal(internal.directRecipients, undefined);
});

test('same-group public collaboration completes the original delivery without a second acknowledgement', async t => {
  const f = fixture(t); await f.activate();
  let receipt: any;
  f.run(async (botId, turn) => {
    if (botId === A && !turn.event) {
      const targets: any = await f.host.invoke(A, turn, 'bridge_delivery_targets', {});
      receipt = await f.host.invoke(A, turn, 'bridge_start_collaboration', {
        targetBotId: B, targetId: targets.defaultTargetId, mode: 'public', text: 'A meaningful public question',
      }, 'same-group-question');
      assert.equal(receipt.completion.publicDeliveryComplete, true);
      await turn.onPublicDeliveryComplete!();
    } else await turn.onSilent?.();
  });
  const before = f.replies.length;
  await f.host.receive(A, f.message(A, 'same-group-source', 'Please discuss this together', G1, [A])); await f.drain();
  const delivered = f.replies.slice(before).filter(reply => reply.text.includes('A meaningful public question'));
  assert.equal(delivered.length, 1);
  const original = f.host.store.listEvents(A).find(event => event.kind === 'human')!;
  assert.equal(original.decision, 'published'); assert.equal(original.state, 'completed');
  const request = f.host.store.getCollaborationRequest(receipt.requestId)!;
  assert.equal(f.host.store.getRoot(request.rootId)!.replyTo.collaborationBudgetKey, original.rootId);
  assert.deepEqual(f.host.store.budgetSnapshot(original.rootId), f.host.store.budgetSnapshot(request.rootId));
  assert.equal(f.host.store.budgetSnapshot(original.rootId).used, 0);
  assert.equal(f.calls.filter(value => value.botId === B && value.turn.text === 'A meaningful public question').length, 1);
});

const A = 'feishu:cli_appa', B = 'feishu:cli_appb', P = 'person', Q = 'other-person';
const D1 = 'discord:111111111111111111', D2 = 'discord:222222222222222222';
const G1 = 'canonical-group-1', G2 = 'canonical-group-2';
type TurnHandler = (botId: string, turn: AgentTurn) => Promise<void>;
function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolveGate => { release = resolveGate; });
  return { promise, release };
}
async function eventual(check: () => boolean, label: string): Promise<void> {
  // Advance actual queued continuations; no timing assumptions or short sleeps.
  for (let tick = 0; tick < 3000; tick++) { if (check()) return; await nextImmediate(); }
  assert.fail(`No progress: ${label}`);
}
function fixture(t: TestContext, options: { initialized?: string[]; unowned?: string[]; run?: TurnHandler; platform?: 'feishu' | 'discord'; internalBotCommunicationEnabled?: boolean } = {}) {
  const path = mkdtempSync(join(tmpdir(), 'bridge-host-runtime-test-'));
  const platform = options.platform ?? 'feishu', ids = platform === 'feishu' ? [A, B] : [D1, D2], primary = ids[0]!;
  const ownerId = (index: number) => platform === 'feishu' ? `owner-${index}` : '333333333333333333';
  const otherId = (index: number) => platform === 'feishu' ? `other-${index}` : '444444444444444444';
  const configs = ids.map((botId, index): BridgeConfig => ({
    botId, platform, applicationId: botId.slice(platform.length + 1), scopePrefix: `${botId}|`,
    ...(options.unowned?.includes(botId) ? {} : { ownerPrincipalId: P }), ownerUserId: `${botId}|${ownerId(index)}`, profile: `test-${index}`,
    token: '', allowedUserIds: [`${botId}|${ownerId(index)}`, `${botId}|${otherId(index)}`], defaultAgent: 'codex',
    workspace: join(path, `workspace-${index}`), dataDir: join(path, `data-${index}`),
    attachmentsDir: join(path, `images-${index}`), logsDir: join(path, `logs-${index}`), proxyUrl: null,
    maxImageBytes: 1024, maxFileBytes: 4096, controllerMode: true, groupMode: true, internalBotCommunicationEnabled: options.internalBotCommunicationEnabled,
    commands: { codex: { command: 'fake', args: [] }, claude: { command: 'fake', args: [] } },
  }));
  const config: HostConfig = { version: 3, rootDataDir: join(path, 'host'), configs, internalBotCommunicationEnabled: options.internalBotCommunicationEnabled,
    principals: [{ id: P, accounts: Object.fromEntries(ids.map((id, index) => [id, ownerId(index)])) },
      { id: Q, accounts: Object.fromEntries(ids.map((id, index) => [id, otherId(index)])) }],
    spaces: [{ id: G1, accounts: Object.fromEntries(ids.map((id, index) => [id, platform === 'feishu' ? `oc_${index ? 'b' : 'a'}_group_1` : '555555555555555555'])) },
      { id: G2, accounts: Object.fromEntries(ids.map((id, index) => [id, platform === 'feishu' ? `oc_${index ? 'b' : 'a'}_group_2` : '666666666666666666'])) }],
  };
  const marker: HostSemanticMarker = { version: 3, status: 'complete', migrationId: 'test-only', migratedAt: '2026-10-17T00:00:00.000Z', bots: [] };
  const reports: string[] = [], replies: Array<{ botId: string; channel: string; text: string; options?: ReplyOptions }> = [];
  const calls: Array<{ botId: string; turn: AgentTurn }> = [];
  const host = new HostRuntime(config, marker, async () => ({ accepted: true }), line => reports.push(line));
  const managers = new Map<string, SessionManager>(), sessions = new Map<string, SessionStore>();
  const controllerStores = new Map<string, ControllerStore>();
  const hooks = new Map(configs.map(c => [c.botId!, host.hooks(c)]));
  const workerStopped = new Map<string, boolean>();
  const workerLists = new Map<string, WorkerOverview[]>();
  const workerQueries: Array<{ botId: string; conversationId: string; scope: string }> = [];
  const workerReads = new Map<string, () => Promise<void>>();
  const groupChecks = new Map<string, () => Promise<boolean>>();
  const downloads = new Map<string, () => Promise<string[]>>();
  const conversationHistories = new Map<string, (raw: string, options: ConversationHistoryOptions) => Promise<ConversationHistoryPage>>();
  const histories = new Map<string, (raw: string, options: DMHistoryOptions) => Promise<DMHistoryPage>>();
  const stoppedProofs = new Map<string, boolean>();
  const mentionViews = new Map<string, (raw: string, id: string) => Promise<GroupMentionView>>();
  const humanMentions = new Set<string>(), mentionReads: string[] = [];
  const originals = new Map<string, IncomingDM>();
  const ownedGates: ReturnType<typeof gate>[] = [];
  let handler: TurnHandler = options.run ?? (async (_botId, turn) => {
    if (turn.groupContext) await turn.onSilent?.(); else await turn.onPublicMessage?.('private fixture ready');
  });
  let closed = false;
  const sourceIds = new Map<string, string>();
  for (const c of configs) {
    const botId = c.botId!, hook = hooks.get(botId)!;
    const adapter: AgentAdapter = {
      async run(turn) {
        calls.push({ botId, turn });
        if (calls.length > 80) throw new Error('test guard: automatic discussion failed to terminate');
        await handler(botId, turn);
        return { nativeId: turn.conversation.nativeId ?? `native-${botId}`, text: '', controlledOutput: true };
      }, async interrupt() {}, async close() {}, async confirmStopped() { return true; },
    };
    const manager = new SessionManager(c, { codex: adapter, claude: adapter }, {
      async sendText(channel, text, replyOptions) { replies.push({ botId, channel, text, options: replyOptions }); },
    }, { ...hook.manager, authorizeUser: user => hook.authorize(user, ''), mergeDelayMs: 0,
      onListWorkers: async (conversation, scope) => {
        workerQueries.push({ botId, conversationId: conversation.id, scope });
        await workerReads.get(botId)?.(); return workerLists.get(botId) ?? [];
      },
    } as SessionManagerOptions);
    managers.set(botId, manager);
    const inspect = new SessionStore(c.dataDir); sessions.set(botId, inspect);
    const transport = {
      botUser: { id: `platform-${botId}`, username: botId },
      async getGroupInfo(_raw: string) { return { spaceId: _raw, botIsMember: true }; },
      async getGroupMember(_raw: string, ownerId: string) {
        const permitted = await (groupChecks.get(botId)?.() ?? Promise.resolve(true));
        return permitted ? { id: ownerId, idType: 'open_id' as const, ...(humanMentions.has(ownerId) ? { isBot: false } : {}) } : null;
      },
      async readGroupMentionView(raw: string, id: string): Promise<GroupMentionView> {
        mentionReads.push(botId);
        if (mentionViews.has(botId)) return mentionViews.get(botId)!(raw, id);
        const original = originals.get(id); if (!original) throw new Error('test original missing');
        return { messageId: id.split('|')[1]!, createTime: id.split('|')[0]!, spaceId: raw,
          senderId: c.ownerUserId!.slice(c.scopePrefix!.length), payloadHash: groupMessagePayloadHash(original),
          mentions: original.space!.mentionedUserIds.map((id, index) => ({ key: `@_user_${index + 1}`, id })) };
      },
      async sendText(channel: string, text: string, replyOptions?: ReplyOptions) { replies.push({ botId, channel, text, options: replyOptions }); },
      async sendInteractionText(_interaction: unknown, text: string, options?: ReplyOptions) { replies.push({ botId, channel: 'interaction', text, options }); },
      async syncGroupSlashCommands() {}, async readGroupHistory(raw: string, historyOptions: DMHistoryOptions) {
        return histories.get(botId)?.(raw, historyOptions) ?? { messages: [], hasMore: false, oldestId: null, newestId: null };
      },
      async readConversationHistory(raw: string, options: ConversationHistoryOptions) { return conversationHistories.get(botId)?.(raw, options) ?? historyPage(raw, options, [], false); },
      async downloadImages(_original: IncomingDM) { return downloads.get(botId)?.() ?? []; },
      isIdle() { return true; },
    };
    const controllerStore = new ControllerStore(c.dataDir); controllerStores.set(botId, controllerStore);
    const bot = { config: c, manager, transport,
      controller: { queryWorkerOverview: () => [], isWorkerStopped: (workerId: string) => workerStopped.get(`${botId}/${workerId}`) === true,
        store: controllerStore },
      beginDrain() { manager.beginDrain(); }, isIdle() { return manager.isIdle(); }, isReady() { return true; },
      async confirmControllerStopped() { return stoppedProofs.get(botId) ?? true; },
      async send(channel: string, text: string, replyOptions?: ReplyOptions) {
        if (!host.allowDelivery(botId, channel)) throw new Error('destination unavailable');
        await transport.sendText(channel, text, replyOptions);
      }, async close() { await manager.close(); },
    } as unknown as BotRuntime;
    host.attach(bot);
    if ((options.initialized ?? ids).includes(botId)) {
      const conversation = inspect.createConversation(c.ownerUserId!, 'codex', c.workspace, { controllerMode: true });
      inspect.saveNativeId(conversation.id, `native-${botId}`);
      host.store.setController(botId, P, { conversationId: conversation.id, generation: 1, agent: 'codex', nativeId: `native-${botId}` }, 0);
    }
  }
  const close = async () => {
    if (closed) return; closed = true; for (const wait of ownedGates) wait.release();
    await host.close(); for (const inspect of sessions.values()) inspect.close();
    for (const controllerStore of controllerStores.values()) controllerStore.close();
  };
  t.after(async () => {
    await close(); assert.equal(dirname(resolve(path)), resolve(tmpdir())); assert(basename(path).startsWith('bridge-host-runtime-test-'));
    rmSync(path, { recursive: true, force: true });
  });
  function message(botId: string, externalId: string, text: string, spaceId = G1, mentions: string[] = []): IncomingDM {
    const c = configs.find(item => item.botId === botId)!, raw = config.spaces.find(s => s.id === spaceId)!.accounts[botId]!;
    if (!sourceIds.has(externalId)) sourceIds.set(externalId, platform === 'feishu'
      ? `${1792180000000 + sourceIds.size}|om_${externalId.replace(/[^A-Za-z0-9_-]/g, '_')}` : String(1792180000000000000n + BigInt(sourceIds.size)));
    const result = { id: `${c.scopePrefix}${sourceIds.get(externalId)!}`, userId: c.ownerUserId!, channelId: `${c.scopePrefix}${raw}`, text,
      attachments: [], space: { kind: 'group', spaceId: raw, mentionedUserIds: mentions.map(id => `platform-${id}`) } };
    originals.set(sourceIds.get(externalId)!, result as IncomingDM);
    return result as IncomingDM;
  }
  const activate = async (spaceId = G1) => {
    await host.receive(primary, message(primary, `activate-${spaceId}`, '/group start', spaceId, [primary]));
    assert.equal(host.store.getGroup(spaceId)?.enabled, true);
  };
  const drain = async () => {
    await eventual(() => host.isIdle() && !host.store.listEvents().some(e => ['queued', 'reserved', 'running'].includes(e.state)), 'host and all managed native turns idle');
    await nextImmediate();
  };
  function registerExecution(botId: string, turn: AgentTurn, callId: string, workerId: string, status: ControllerJobStatus = 'running', ownership: 'bridge' | 'user' = 'bridge') {
    const store = controllerStores.get(botId)!, callKey = turn.conversation.id + ':' + callId;
    const previous = store.readCallReceipt(callKey); if (previous !== undefined) return previous as { workerId: string; status: string };
    const now = new Date().toISOString(), origin = { conversationId: turn.conversation.id, userId: turn.conversation.userId,
      agent: turn.conversation.agent, nativeId: turn.conversation.nativeId, cwd: turn.conversation.cwd,
      channelId: turn.source?.channelId ?? turn.groupContext!.originChannelId, originMessageId: turn.source?.messageId ?? turn.groupContext!.eventId,
      groupContext: turn.groupContext };
    const worker: ControllerWorker = { id: workerId, origin, agent: 'codex', model: null, actualModel: null, effort: null,
      cwd: turn.conversation.cwd, title: 'fixture execution', nativeId: 'native-' + workerId, imagePaths: [], ownership,
      wakeAllowed: true, createdAt: now, updatedAt: now };
    const receipt = { workerId, status: status === 'running' ? 'started' : status };
    store.transaction(() => {
      store.addWorker(worker);
      store.addJob({ id: 'job-' + callId, workerId, origin, prompt: 'fixture task', imagePaths: [], status,
        taskId: null, result: null, cancelReason: null, createdAt: now, updatedAt: now });
      store.saveCall(callKey, 'fixture-' + callId, receipt);
    });
    return receipt;
  }
  return { path, host, config, configs, managers, sessions, controllerStores, registerExecution, hooks, replies, calls, reports, workerStopped, workerLists, workerQueries, workerReads, groupChecks, downloads, histories, conversationHistories, stoppedProofs, ids,
    message, activate, drain, close, mentionViews, humanMentions, mentionReads, originals, run: (next: TurnHandler) => { handler = next; },
    gate: () => { const wait = gate(); ownedGates.push(wait); return wait; } };
}

async function holdSceneTurns(f: ReturnType<typeof fixture>, id: string) {
  const wait = f.gate(), turns = new Map<string, AgentTurn>();
  f.run(async (botId, turn) => {
    if (!turn.event) { turns.set(botId, turn); await wait.promise; }
    await turn.onSilent?.();
  });
  await f.host.receive(A, f.message(A, id, '主人授权：检查当前任务', G1));
  await eventual(() => turns.has(A) && turns.has(B), 'both controllers received the same owner input');
  return { turns, release: wait.release };
}

test('automatic group dispatch needs no claim, replays one atomic receipt and closes only after actual worker stop', { timeout: 10000 }, async t => {
  const f = fixture(t); await f.activate(); const held = await holdSceneTurns(f, 'auto-dispatch-owner'), turn = held.turns.get(A)!;
  let registrations = 0;
  const delegate = async (input: Record<string, unknown>) => {
    assert.equal('workId' in input, false); assert.equal('resources' in input, false);
    if (f.controllerStores.get(A)!.readCallReceipt(turn.conversation.id + ':auto-once') === undefined) registrations++;
    return f.registerExecution(A, turn, 'auto-once', 'auto-worker');
  };
  const args = { title: '检查私聊', prompt: '只读检查', resources: ['browser:shared'] };
  const first: any = await f.host.invoke(A, turn, 'bridge_start_worker', args, 'auto-once', delegate);
  const task = f.host.store.getTaskForWorker(A, first.workerId)!;
  assert.match(task.id, /^auto-work:/); assert.equal(task.rootId, turn.groupContext!.rootId); assert.equal(task.state, 'active');
  assert.equal(f.host.store.getAutomaticDispatch(task.id)!.callId, 'auto-once');
  assert.deepEqual(await f.host.invoke(A, turn, 'bridge_start_worker', args, 'auto-once', delegate), first);
  assert.equal(registrations, 1); assert.equal(f.controllerStores.get(A)!.workers().length, 1); assert.equal(f.controllerStores.get(A)!.jobs().length, 1);
  f.controllerStores.get(A)!.setJob('job-auto-once', 'completed', { result: '检查完毕' });
  f.hooks.get(A)!.onExecutionSettled!(); assert.equal(f.host.store.getTask(task.id)!.state, 'active');
  f.workerStopped.set(`${A}/auto-worker`, true); f.hooks.get(A)!.onExecutionSettled!();
  assert.equal(f.host.store.getTask(task.id)!.state, 'completed'); assert.ok(f.host.store.getTask(task.id)!.executionStoppedProof);
  assert.equal(f.host.store.claimTask({ id: 'resource-after-real-stop', rootId: turn.groupContext!.rootId, botId: B, generation: 1,
    title: '可使用已释放资源', resources: ['browser:shared'] }).claimed, true);
  held.release(); await f.drain();
});

test('prepared automatic dispatch is visible before its worker receipt and forces only one durable same-root scene refresh', { timeout: 10000 }, async t => {
  const f = fixture(t); await f.activate(); const held = await holdSceneTurns(f, 'auto-preparing-owner');
  const a = held.turns.get(A)!, b = held.turns.get(B)!, dispatch = f.gate();
  const pending = f.host.invoke(A, a, 'bridge_start_worker', { title: '先开始的私聊检查', prompt: '只读检查' }, 'preparing', async () => {
    await dispatch.promise; return f.registerExecution(A, a, 'preparing', 'prepared-worker');
  });
  await eventual(() => f.host.store.listTasks().length === 1, 'automatic preparation is durable before worker receipt');
  assert.equal(f.controllerStores.get(A)!.workers().length, 0);
  const refresh = await b.onSceneCheck!({ name: 'bridge_start_worker', args: {}, callId: 'late-plan' });
  assert.equal(refresh.refreshRequired, true); const scene = JSON.parse(refresh.scene!);
  assert.equal(scene.newAuthorization, false); assert.ok(scene.updates.some((update: any) => update.kind === 'dispatch' && /准备/.test(update.text)));
  assert.ok(scene.updates.every((update: any) => update.canAuthorize === false));
  const reopened = new HostStore(f.config.rootDataDir);
  try { assert.equal(reopened.consumeSceneRefresh(b.groupContext!.rootId, B), false); }
  finally { reopened.close(); }
  dispatch.release(); await pending;
  assert.equal((await b.onSceneCheck!({ name: 'bridge_start_worker', args: {}, callId: 'after-refresh' })).refreshRequired, false);
  held.release(); await f.drain();
});

test('non-owner observer messages stay readable without advancing scene or consuming reassessment', { timeout: 10000 }, async t => {
  const f = fixture(t); await f.activate(); const held = await holdSceneTurns(f, 'nonowner-scene-owner'), turn = held.turns.get(B)!;
  const beforeEvents = f.host.store.listEvents().length, beforeCursor = f.host.store.sceneCursor(G1, B);
  const guest = f.message(A, 'scene-guest-update', '群友补充的现场事实'); guest.userId = `${A}|outside-whitelist`;
  await f.host.receive(A, guest);
  assert.equal(f.host.store.sceneCursor(G1, B), beforeCursor);
  assert.equal((await turn.onSceneCheck!({ name: 'bridge_send_message', args: {}, callId: 'guest-refresh' })).refreshRequired, false);
  const guest2 = f.message(A, 'scene-guest-more', '第二条事实'); guest2.userId = `${A}|outside-whitelist`; await f.host.receive(A, guest2);
  assert.equal(f.host.store.sceneCursor(G1, B), beforeCursor);
  assert.equal((await turn.onSceneCheck!({ name: 'bridge_send_message', args: {}, callId: 'guest-second-refresh' })).refreshRequired, false);
  assert.equal(f.host.store.listEvents().length, beforeEvents, 'observer facts do not enqueue controller turns');
  const context: any = await f.host.invoke(B, turn, 'bridge_group_context', {});
  for (const text of ['群友补充的现场事实', '第二条事实']) {
    assert.ok(context.conversationEvidence.recent.some((record: any) => record.text === text && record.canAuthorize === false));
    assert.ok(f.host.store.readContext(G1, B).recent.some(record => record.text === text && record.canAuthorize === false));
  }
  const a = held.turns.get(A)!;
  await f.host.invoke(A, a, 'bridge_start_worker', { title: '登记 Bot 的真实执行进展', prompt: '只读检查' }, 'known-bot-after-guests', async () =>
    f.registerExecution(A, a, 'known-bot-after-guests', 'known-bot-scene-worker'));
  const refresh = await turn.onSceneCheck!({ name: 'bridge_send_message', args: {}, callId: 'known-bot-refresh' });
  assert.equal(refresh.refreshRequired, true, 'observer messages must leave the one refresh available for registered Bot progress');
  const scene = JSON.parse(refresh.scene!);
  assert.equal(scene.originalRootId, turn.groupContext!.rootId); assert.equal(scene.originalPrincipalId, P); assert.equal(scene.newAuthorization, false);
  assert.ok(scene.updates.some((update: any) => update.kind === 'dispatch' && update.sourceBotId === A));
  assert.ok(scene.updates.every((update: any) => update.canAuthorize === false));
  assert.equal(scene.updates.some((update: any) => update.text === '群友补充的现场事实' || update.text === '第二条事实'), false);
  const reopened = new HostStore(f.config.rootDataDir);
  try { assert.equal(reopened.consumeSceneRefresh(turn.groupContext!.rootId, B), false); }
  finally { reopened.close(); }
  held.release(); await f.drain();

  const next = await holdSceneTurns(f, 'next-owner-scene-request'), nextB = next.turns.get(B)!;
  assert.notEqual(nextB.groupContext!.rootId, turn.groupContext!.rootId);
  assert.equal((await nextB.onSceneCheck!({ name: 'bridge_send_message', args: {}, callId: 'next-initial-check' })).refreshRequired, false,
    'previous request progress is initial context rather than a new stale-scene signal');
  await next.turns.get(A)!.onPublicMessage!('新一条主人请求下的 Bot 公开进展', [], 'next-known-bot-public', undefined, false);
  assert.equal((await nextB.onSceneCheck!({ name: 'bridge_send_message', args: {}, callId: 'next-public-refresh' })).refreshRequired, true,
    'a new owner request receives its own once-only reassessment budget');
  next.release(); await f.drain();
});

test('legacy claimed work uses automatic dispatch reconciliation and cannot reopen a user-owned worker', { timeout: 10000 }, async t => {
  const f = fixture(t); await f.activate(); const held = await holdSceneTurns(f, 'legacy-auto-owner'), turn = held.turns.get(A)!;
  await f.host.invoke(A, turn, 'bridge_claim_work', { taskId: 'legacy-worker-work', title: '旧会话已登记任务', resources: ['legacy:resource'] });
  await f.host.invoke(A, turn, 'bridge_start_worker', { workId: 'legacy-worker-work', title: '继续兼容', prompt: '按原任务执行' }, 'legacy-auto', async () =>
    f.registerExecution(A, turn, 'legacy-auto', 'legacy-user-worker', 'running', 'user'));
  assert.equal(f.host.store.getAutomaticDispatch('legacy-worker-work')!.callId, 'legacy-auto');
  f.controllerStores.get(A)!.setJob('job-legacy-auto', 'completed'); f.workerStopped.set(`${A}/legacy-user-worker`, true); f.hooks.get(A)!.onExecutionSettled!();
  assert.equal(f.host.store.getTask('legacy-worker-work')!.state, 'completed');
  await turn.onSceneCheck!({ name: 'bridge_continue_worker', args: {}, callId: 'ack-completed' });
  let delegated = false;
  await assert.rejects(f.host.invoke(A, turn, 'bridge_continue_worker', { workerId: 'legacy-user-worker', prompt: '不得自动接管用户会话' }, 'user-owned-continue', async () => {
    delegated = true; return {};
  }), /用户|user|所有权|归属|不可续接|不能.*续/);
  assert.equal(delegated, false); assert.equal(f.host.store.getTask('legacy-worker-work')!.state, 'completed');
  assert.equal(f.host.store.claimTask({ id: 'legacy-resource-stays-released', rootId: turn.groupContext!.rootId, botId: B, generation: 1,
    title: '资源不被失败续接重新占用', resources: ['legacy:resource'] }).claimed, true);
  held.release(); await f.drain();
});

test('concurrent worker continuations retain the automatic task until every admitted dispatch settles', { timeout: 10000 }, async t => {
  const f = fixture(t); await f.activate(); const held = await holdSceneTurns(f, 'parallel-continue-owner'), turn = held.turns.get(A)!;
  await f.host.invoke(A, turn, 'bridge_start_worker', { title: '原任务', prompt: '第一次执行' }, 'parallel-original', async () =>
    f.registerExecution(A, turn, 'parallel-original', 'parallel-worker'));
  const task = f.host.store.getTaskForWorker(A, 'parallel-worker')!;
  f.controllerStores.get(A)!.setJob('job-parallel-original', 'completed'); f.workerStopped.set(`${A}/parallel-worker`, true); f.hooks.get(A)!.onExecutionSettled!();
  assert.equal(f.host.store.getTask(task.id)!.state, 'completed');
  await turn.onSceneCheck!({ name: 'bridge_continue_worker', args: {}, callId: 'ack-original-end' });
  const first = f.gate(), second = f.gate(); let entered = 0;
  const continueTask = (callId: string, wait: ReturnType<typeof gate>) => f.host.invoke(A, turn, 'bridge_continue_worker', { workerId: 'parallel-worker', prompt: '补充任务' }, callId, async () => {
    entered++; await wait.promise; const receipt = { workerId: 'parallel-worker', status: 'delivered' };
    f.controllerStores.get(A)!.saveCall(turn.conversation.id + ':' + callId, 'fixture-' + callId, receipt); return receipt;
  });
  const one = continueTask('parallel-one', first), two = continueTask('parallel-two', second);
  await eventual(() => entered === 2, 'both continuations admitted'); assert.equal(f.host.store.getTask(task.id)!.state, 'active');
  first.release(); await one; f.hooks.get(A)!.onExecutionSettled!();
  assert.equal(f.host.store.getTask(task.id)!.state, 'active');
  second.release(); await two; f.hooks.get(A)!.onExecutionSettled!();
  assert.equal(f.host.store.getTask(task.id)!.state, 'completed'); assert.equal(f.host.store.getTask(task.id)!.rootId, task.rootId);
  assert.deepEqual(f.host.store.taskWorkers(task.id), [{ botId: A, workerId: 'parallel-worker' }]);
  held.release(); await f.drain();
});

test('a failed parallel continuation cannot finish or release work while another admitted continuation has no receipt yet', { timeout: 10000 }, async t => {
  const f = fixture(t); await f.activate(); const held = await holdSceneTurns(f, 'parallel-failure-owner'), turn = held.turns.get(A)!;
  await f.host.invoke(A, turn, 'bridge_start_worker', { title: '原始资源任务', prompt: '第一次执行', resources: ['parallel-failure:shared'] }, 'failure-original', async () =>
    f.registerExecution(A, turn, 'failure-original', 'failure-worker'));
  const task = f.host.store.getTaskForWorker(A, 'failure-worker')!, controller = f.controllerStores.get(A)!;
  controller.setJob('job-failure-original', 'completed'); f.workerStopped.set(`${A}/failure-worker`, true); f.hooks.get(A)!.onExecutionSettled!();
  assert.equal(f.host.store.getTask(task.id)!.state, 'completed');
  await turn.onSceneCheck!({ name: 'bridge_continue_worker', args: {}, callId: 'ack-before-parallel-failure' });
  const failing = f.gate(), succeeding = f.gate(); let entered = 0;
  const first = f.host.invoke(A, turn, 'bridge_continue_worker', { workerId: 'failure-worker', prompt: '第一个续接失败' }, 'failure-first', async () => {
    entered++; await failing.promise; throw new Error('expected first continuation failure');
  });
  const rejected = assert.rejects(first, /expected first continuation failure/);
  const second = f.host.invoke(A, turn, 'bridge_continue_worker', { workerId: 'failure-worker', prompt: '第二个续接尚在校验' }, 'failure-second', async () => {
    entered++; await succeeding.promise;
    const now = new Date().toISOString(), worker = controller.getWorker('failure-worker')!, receipt = { workerId: worker.id, status: 'queued' };
    controller.transaction(() => {
      controller.addJob({ id: 'job-failure-second', workerId: worker.id, origin: worker.origin, prompt: '正常登记的第二个续接', imagePaths: [], status: 'running',
        taskId: null, result: null, cancelReason: null, createdAt: now, updatedAt: now });
      controller.saveCall(turn.conversation.id + ':failure-second', 'fixture-failure-second', receipt);
    });
    f.workerStopped.set(`${A}/failure-worker`, false); return receipt;
  });
  await eventual(() => entered === 2, 'both continuation delegates entered before either has a new receipt');
  failing.release(); await rejected;
  assert.equal(controller.readCallReceipt(turn.conversation.id + ':failure-second'), undefined);
  assert.equal(f.host.store.getTask(task.id)!.state, 'active', 'one failed delegate must not finish another pending continuation');
  assert.throws(() => f.host.store.claimTask({ id: 'parallel-failure-cannot-steal', rootId: turn.groupContext!.rootId, botId: B, generation: 1,
    title: '资源仍被尚未登记完的续接持有', resources: ['parallel-failure:shared'] }), /Resource/);
  succeeding.release(); assert.equal((await second as { workerId: string }).workerId, 'failure-worker');
  assert.equal(f.host.store.getTask(task.id)!.state, 'active');
  assert.deepEqual(f.host.store.taskWorkers(task.id), [{ botId: A, workerId: 'failure-worker' }]);
  controller.setJob('job-failure-second', 'completed'); f.workerStopped.set(`${A}/failure-worker`, true); f.hooks.get(A)!.onExecutionSettled!();
  assert.equal(f.host.store.getTask(task.id)!.state, 'completed');
  assert.equal(f.host.store.claimTask({ id: 'parallel-failure-resource-released', rootId: turn.groupContext!.rootId, botId: B, generation: 1,
    title: '最后一个执行真正结束后资源可用', resources: ['parallel-failure:shared'] }).claimed, true);
  held.release(); await f.drain();
});

function scopedView(f: ReturnType<typeof fixture>, botId: string, source: IncomingDM, mentions: GroupMentionView['mentions']): GroupMentionView {
  const sourceConfig = f.configs.find(c => source.id.startsWith(c.scopePrefix!))!;
  const rawId = source.id.slice(sourceConfig.scopePrefix!.length), c = f.configs.find(c => c.botId === botId)!;
  const space = f.config.spaces.find(s => s.accounts[sourceConfig.botId!] === source.space!.spaceId)!;
  return { messageId: rawId.split('|')[1]!, createTime: rawId.split('|')[0]!, spaceId: space.accounts[botId]!,
    senderId: c.ownerUserId!.slice(c.scopePrefix!.length), payloadHash: groupMessagePayloadHash(source), mentions };
}
function crossAppMention(f: ReturnType<typeof fixture>, source: IncomingDM, repeat = false): void {
  source.space!.mentionedUserIds = ['ou_b_in_receiver_namespace'];
  const keys = repeat ? ['@_user_1', '@_user_2'] : ['@_user_1'];
  f.mentionViews.set(A, async () => scopedView(f, A, source, keys.map(key => ({ key, id: 'ou_b_in_receiver_namespace' }))));
  f.mentionViews.set(B, async () => scopedView(f, B, source, keys.map(key => ({ key, id: `platform-${B}` }))));
}

function overviewWorker(id: string, title: string): WorkerOverview {
  return { workerId: id, conversationId: 'fixture-conversation', conversationTitle: 'private controller title', targetId: 'local', targetLabel: '桥电脑',
    agent: 'codex', title, model: 'gpt-6.1-sol', effort: 'medium', nativeId: `native-${id}`,
    status: 'running', running: true, queued: 0, startedAt: null };
}

test('group workers reuses each Bot private current overview and presentation without host task aggregation or ANSI', async t => {
  const f = fixture(t); await f.activate();
  f.workerLists.set(A, [overviewWorker('worker-a', 'A normal private-origin worker')]);
  f.workerLists.set(B, [overviewWorker('worker-b', 'B own worker')]);
  const privateViews = new Map<string, ReplyOptions['presentation']>();
  for (const [index, botId] of [A, B].entries()) {
    await f.managers.get(botId)!.handle({ id: 'dm-overview-' + botId, userId: f.configs[index]!.ownerUserId!,
      channelId: `${botId}|oc_private_overview`, text: '/workers', imagePaths: [] });
    privateViews.set(botId, f.replies.at(-1)!.options?.presentation);
  }
  const start = f.replies.length;
  await f.host.receive(A, f.message(A, 'group-overview', '/workers')); await f.drain();
  const replies = f.replies.slice(start);
  assert.deepEqual(replies.map(value => value.botId).sort(), [A, B]);
  for (const reply of replies) {
    assert.deepEqual(reply.options?.presentation, privateViews.get(reply.botId));
    assert.match(reply.options!.presentation!.title, /^当前对话的直属助手/);
    assert.doesNotMatch(reply.text, /群协作任务|\u001b|```ansi|private controller title/);
    assert.ok(reply.channel.includes('_group_1'));
  }
  assert.equal(f.workerQueries.every(query => query.scope === 'current'), true);
  assert.equal(f.calls.length, 0);
  assert.equal(f.host.store.listEvents().length, 0);
});

test('group workers real mention selects only that Bot and uses private history all details options', async t => {
  const f = fixture(t); await f.activate();
  f.workerLists.set(A, [{ ...overviewWorker('ended-a', 'A finished worker'), running: false, status: 'completed', endedAt: '2026-10-17T12:00:00Z' }]);
  const start = f.replies.length;
  await f.host.receive(A, f.message(A, 'group-history-options', '/workers history all details', G1, [A])); await f.drain();
  const replies = f.replies.slice(start);
  assert.equal(replies.length, 1); assert.equal(replies[0]!.botId, A);
  assert.match(replies[0]!.options!.presentation!.title, /历史助手 · 共1个/);
  assert.match(replies[0]!.text, /workerId：ended-a/);
  assert.doesNotMatch(replies[0]!.text, /private controller title/);
  assert.equal(f.workerQueries.at(-1)!.scope, 'all'); assert.equal(f.calls.length, 0);
});

test('group workers revalidates the binding after querying and does not publish across a concurrent group stop', async t => {
  const f = fixture(t); await f.activate(); const wait = f.gate();
  f.workerLists.set(A, [overviewWorker('blocked-a', 'must not publish after group stop')]);
  f.workerReads.set(A, async () => { await wait.promise; });
  const start = f.replies.length;
  const query = f.host.receive(A, f.message(A, 'group-workers-stop-race', '/workers', G1, [A]));
  await eventual(() => f.workerQueries.length === 1, 'worker lookup started');
  f.host.store.stopGroup(G1, P, 'stop while querying'); wait.release(); await query; await f.drain();
  assert.equal(f.replies.slice(start).some(reply => reply.text.includes('must not publish after group stop')), false);
  assert.equal(f.calls.length, 0);
});

test('group workers does not initialize an uninitialized member or query a different Bot owner', async t => {
  const f = fixture(t, { initialized: [A], unowned: [B] }); await f.activate();
  const initial = f.host.store.getController(A)!.conversationId, start = f.replies.length;
  await f.host.receive(A, f.message(A, 'group-workers-uninitialized', '/workers')); await f.drain();
  assert.equal(f.host.store.getController(A)!.conversationId, initial);
  assert.equal(f.host.store.getController(B), null);
  assert.equal(f.host.store.getBot(B)!.ownerPrincipalId, null);
  assert.deepEqual(f.workerQueries.map(query => query.botId), [A]);
  assert.equal(f.replies.slice(start).some(reply => reply.botId === B && reply.text.includes('未初始化')), true);
  assert.equal(f.calls.length, 0);
});

test('Discord group workers completes the selected app interaction with the shared structured overview', async t => {
  const f = fixture(t, { platform: 'discord' }); await f.activate();
  f.workerLists.set(D1, [overviewWorker('discord-worker', 'Discord own worker')]);
  const message = f.message(D1, 'native-workers', '/workers', G1, [D1]);
  message.interaction = { id: 'workers-interaction', token: 'fake-token', applicationId: '111111111111111111' };
  const start = f.replies.length;
  await f.host.receive(D1, message); await f.drain();
  const replies = f.replies.slice(start);
  assert.equal(replies.length, 1); assert.equal(replies[0]!.botId, D1); assert.equal(replies[0]!.channel, 'interaction');
  assert.equal(replies[0]!.options?.presentation?.purpose, 'overview');
  assert.match(replies[0]!.text, /Discord own worker/); assert.equal(f.calls.length, 0);
});

test('group workers rechecks platform membership after the asynchronous lookup before exposing data', async t => {
  const f = fixture(t); await f.activate();
  f.workerLists.set(A, [overviewWorker('revoked-worker', 'must not expose after owner left')]);
  f.workerReads.set(A, async () => { f.groupChecks.set(A, async () => false); });
  const start = f.replies.length;
  await f.host.receive(A, f.message(A, 'workers-membership-revoked', '/workers', G1, [A])); await f.drain();
  assert.equal(f.replies.slice(start).some(reply => reply.text.includes('must not expose after owner left')), false);
  assert.equal(f.host.store.getGroup(G1)!.enabled, false); assert.equal(f.calls.length, 0);
});

test('group workers hides internal consultations and their worker-result descendants within an ordinary public root', async t => {
  const f = fixture(t); await f.activate(); let internal: NonNullable<AgentTurn['groupContext']> | undefined;
  let descendant: NonNullable<AgentTurn['groupContext']> | undefined;
  f.run(async (botId, turn) => {
    if (botId === A && !turn.event) await f.host.invoke(A, turn, 'bridge_send_bot', { targetBotId: B, text: 'internal worker question' }, 'internal-worker-question');
    if (botId === B && turn.text === 'internal worker question') internal = turn.groupContext;
    if (botId === B && turn.text === 'internal worker result') {
      descendant = turn.groupContext;
      assert.equal(JSON.parse(turn.chatScene!).currentMessage.visibility, 'internal');
      assert.equal(JSON.parse(turn.chatScene!).currentMessage.defaultDelivery.area, 'internal');
    }
    await turn.onSilent?.();
  });
  await f.host.receive(A, f.message(A, 'owner-internal-work', 'discuss this')); await f.drain();
  assert.ok(internal); assert.equal(f.host.store.getRoot(internal.rootId)!.replyTo.collaborationMode, undefined);
  f.host.store.enqueueEvent({ id: 'internal-worker-result', rootId: internal.rootId, botId: B, generation: internal.generation,
    kind: 'assistant-result', causeEventId: internal.eventId, payload: { text: 'internal worker result', eventKind: 'worker-result' } });
  await f.host.pump(); await f.drain(); assert.ok(descendant);
  f.workerLists.set(B, [overviewWorker('internal-child', 'private internal title'), overviewWorker('public-child', 'visible normal worker')]);
  (f.host.bots.get(B)!.controller!.store as unknown as { workers: () => unknown[] }).workers = () => [
    { id: 'internal-child', origin: { groupContext: descendant } }, { id: 'public-child', origin: {} },
  ];
  const start = f.replies.length;
  await f.host.receive(A, f.message(A, 'workers-public-root-internal-child', '/workers all details')); await f.drain();
  const reply = f.replies.slice(start).find(value => value.botId === B)!;
  assert.match(reply.text, /visible normal worker/); assert.doesNotMatch(reply.text, /private internal title|internal-child/);
  const c = f.configs.find(config => config.botId === B)!;
  await f.managers.get(B)!.handle({ id: 'internal-worker-private-overview', userId: c.ownerUserId!, channelId: `${B}|oc_private_worker`, text: '/workers all details', imagePaths: [] });
  assert.match(f.replies.at(-1)!.text, /private internal title/);
});

test('Feishu receiver broadcasts ordinary scoped mentions once to all ready members without app-view reads', async t => {
  const f = fixture(t); await f.activate();
  const source = f.message(A, 'cross-app-mention', 'only B initially', G1, [B]); crossAppMention(f, source, true);
  await f.host.receive(B, f.message(B, 'cross-app-mention', 'only B initially', G1, [B]));
  await f.host.receive(A, source); await f.host.receive(A, source); await f.drain();
  assert.deepEqual(f.calls.map(c => c.botId).sort(), [A, B]);
  assert.deepEqual(f.host.store.getRoot(f.host.store.listEvents()[0]!.rootId)!.targetBotIds.sort(), [A, B]);
  assert.equal(f.mentionReads.length, 0);
});

test('unmentioned, receiver-own and positively verified human mentions retain ordinary semantics without app-view reads', async t => {
  const f = fixture(t); await f.activate();
  await f.host.receive(A, f.message(A, 'no-mention-fast', 'ordinary all')); await f.drain();
  await f.host.receive(A, f.message(A, 'own-mention-fast', 'only self', G1, [A])); await f.drain();
  const human = f.message(A, 'human-mention-fast', 'ordinary human reference'); human.space!.mentionedUserIds = ['ou_real_human'];
  f.humanMentions.add('ou_real_human'); await f.host.receive(A, human); await f.drain();
  assert.deepEqual(f.calls.filter(c => c.turn.text === 'ordinary all').map(c => c.botId).sort(), [A, B]);
  assert.deepEqual(f.calls.filter(c => c.turn.text === 'only self').map(c => c.botId).sort(), [A, B]);
  assert.deepEqual(f.calls.filter(c => c.turn.text === 'ordinary human reference').map(c => c.botId).sort(), [A, B]);
  assert.equal(f.mentionReads.length, 0);
});

for (const mismatch of ['message', 'time', 'space', 'author', 'payload', 'token', 'unavailable', 'scoped-id-collision']) test(`Feishu control unknown mention fails closed for ${mismatch}, never expands routing by display name`, async t => {
  const f = fixture(t); await f.activate();
  const source = f.message(A, 'bad-' + mismatch, '/status'); crossAppMention(f, source);
  if (mismatch === 'scoped-id-collision') source.space!.mentionedUserIds = [`platform-${B}`];
  f.mentionViews.set(A, async () => scopedView(f, A, source, [{ key: '@_user_1', id: source.space!.mentionedUserIds[0]! }]));
  f.mentionViews.set(B, async () => {
    if (mismatch === 'unavailable') throw new Error('app unavailable');
    const view = scopedView(f, B, source, [{ key: '@_user_1', id: `platform-${B}` }]);
    if (mismatch === 'message') view.messageId = 'om_another';
    if (mismatch === 'time') view.createTime = '1792189999999';
    if (mismatch === 'space') view.spaceId = 'oc_another';
    if (mismatch === 'author') view.senderId = 'not-this-principal';
    if (mismatch === 'payload') view.payloadHash = 'different';
    if (mismatch === 'token') view.mentions[0]!.key = '@_user_99';
    if (mismatch === 'scoped-id-collision') view.mentions[0]!.id = 'ou_someone_else';
    return view;
  });
  await f.host.receive(A, source); await f.drain();
  assert.equal(f.calls.length, 0); assert.equal(f.host.store.listEvents().length, 0);
  assert(f.replies.some(r => /提及.*无法可靠核对/.test(r.text)));
  assert(f.reports.some(r => /GROUP_MENTION_UNVERIFIED/.test(r)));
});

test('a slow membership check preserves durable broadcast input order for each Bot', async t => {
  const f = fixture(t); await f.activate(); const wait = f.gate();
  const source = f.message(A, 'slow-mention', 'first scoped B'); crossAppMention(f, source);
  let entered = false; f.groupChecks.set(A, async () => { entered = true; await wait.promise; return true; });
  const first = f.host.receive(A, source);
  await eventual(() => entered, 'slow first membership proof entered');
  const second = f.host.receive(A, f.message(A, 'later-fast-input', 'second ordinary'));
  await eventual(() => f.host.inbox.pending().some(input => input.message.text === 'second ordinary'), 'later input durably received while the first is processing its proof');
  assert.equal(f.host.inbox.pending().length, 1, 'pending() excludes the first input already in processing state');
  assert.equal(f.calls.length, 0); wait.release(); await Promise.all([first, second]); await f.drain();
  assert.deepEqual(f.calls.filter(c => c.botId === B).map(c => c.turn.text), ['first scoped B', 'second ordinary']);
  assert.deepEqual(f.calls.filter(c => c.botId === A).map(c => c.turn.text), ['first scoped B', 'second ordinary']);
});

for (const change of ['new-generation', 'stop-start']) test(`a pending broadcast cannot move an old human input across ${change}`, async t => {
  const f = fixture(t); await f.activate(); const wait = f.gate();
  const source = f.message(A, 'proof-race-' + change, 'do not cross reset'); crossAppMention(f, source);
  let entered = false; f.groupChecks.set(A, async () => { entered = true; await wait.promise; return true; });
  const receiving = f.host.receive(A, source); await eventual(() => entered, 'membership proof is awaiting API');
  if (change === 'stop-start') {
    f.host.store.stopGroup(G1, P); f.host.store.startGroup({ spaceId: G1, principalId: P, receiverBotId: A, memberBotIds: [A, B] });
  } else {
    const c = f.configs[1]!, next = f.sessions.get(B)!.createConversation(c.ownerUserId!, 'codex', c.workspace, { controllerMode: true });
    f.host.store.setController(B, P, { conversationId: next.id, generation: 2, agent: 'codex', nativeId: null }, 1);
  }
  wait.release(); await receiving; await f.drain();
  assert.equal(f.calls.length, 0); assert.equal(f.host.store.listEvents().length, 0);
});

test('pending durable ordinary group input broadcasts on recovery without trusting scoped mention identity', async t => {
  const f = fixture(t); await f.activate(); const source = f.message(A, 'recover-scoped', 'recover only B'); crossAppMention(f, source);
  f.host.inbox.capture('durable-scoped-recovery', A, source, false, { [A]: 1, [B]: 1 }, f.host.store.getGroup(G1)!.epoch);
  assert.equal(f.mentionReads.length, 0); await f.host.recover(); await f.drain();
  assert.deepEqual(f.calls.map(c => c.botId).sort(), [A, B]); assert.equal(f.mentionReads.length, 0);
});

test('ordinary mentions of uninitialized members still reach ready peers without a control hint', async t => {
  const f = fixture(t, { initialized: [A] }); await f.activate(); f.replies.length = 0;
  await f.host.receive(A, f.message(A, 'partially-ready-broadcast', 'talk to B', G1, [B])); await f.drain();
  assert.deepEqual(f.calls.map(c => c.botId), [A]); assert.equal(f.mentionReads.length, 0);
  assert(!f.replies.some(r => /未初始化|未就绪/.test(r.text)));
});

for (const stale of ['partial-generation-snapshot', 'binding-revision']) test(`durable broadcast rejects ${stale} before creating model events`, async t => {
  const f = fixture(t); await f.activate();
  const source = f.message(A, 'stale-broadcast-' + stale, 'must not replay old subset', G1, [A]);
  const group = f.host.store.getGroup(G1)!;
  f.host.inbox.capture('stale-broadcast', A, source, false, stale === 'partial-generation-snapshot' ? { [A]: 1 } : { [A]: 1, [B]: 1 }, group.epoch, group.revision);
  if (stale === 'binding-revision') f.host.store.startGroup({ spaceId: G1, principalId: P, receiverBotId: B, memberBotIds: [A, B] });
  await f.host.recover(); await f.drain();
  assert.equal(f.calls.length, 0); assert.equal(f.host.store.listEvents().length, 0);
  assert.equal(f.mentionReads.length, 0);
});

test('pending control input re-proves its original scoped entities before execution', async t => {
  const f = fixture(t); await f.activate(); const source = f.message(A, 'recover-control-scoped', '/status', G1, [A, B]);
  source.space!.mentionedUserIds = [`platform-${A}`, 'ou_b_foreign'];
  f.mentionViews.set(A, async () => scopedView(f, A, source, [{ key: '@_user_1', id: `platform-${A}` }, { key: '@_user_2', id: 'ou_b_foreign' }]));
  f.mentionViews.set(B, async () => scopedView(f, B, source, [{ key: '@_user_1', id: 'ou_a_foreign' }, { key: '@_user_2', id: `platform-${B}` }]));
  f.host.inbox.capture('durable-control-proof', A, source, true, { [A]: 1, [B]: 1 }, f.host.store.getGroup(G1)!.epoch);
  await f.host.recover(); await f.drain();
  assert.equal(f.calls.length, 0); assert.deepEqual(f.mentionReads.sort(), [A, B].sort());
  assert.equal(f.host.inbox.get('durable-control-proof')!.state, 'accepted');
});

test('Discord ordinary mentions broadcast and never call the Feishu correlation API', async t => {
  const f = fixture(t, { platform: 'discord' }); await f.activate();
  await f.host.receive(D1, f.message(D1, 'discord-explicit-target', 'only D2', G1, [D2])); await f.drain();
  assert.deepEqual(f.calls.map(c => c.botId).sort(), [D1, D2]); assert.equal(f.mentionReads.length, 0);
});



test('private input queries authorized delivery regions and explicitly publishes to an owned active group without moving its source', { timeout: 10000 }, async t => {
  const f = fixture(t); await f.activate(); await f.activate(G2); f.configs[0]!.aliases = ['T', '主Bot'];
  const original = f.host.store.getController(A), owner = f.configs[0]!.ownerUserId!, dm = `${A}|oc_verified_owner_private`;
  let inspected: any;
  f.run(async (botId, turn) => {
    assert.equal(botId, A); inspected = await f.host.invoke(A, turn, 'bridge_delivery_targets', {});
    const target = inspected.targets.find((target: any) => target.spaceId === G1); assert.ok(target);
    await turn.onPublicMessage!('private source to selected group', [], 'dm-to-group', target.targetId, false);
    await turn.onPublicMessage!('已发到指定群。', [], 'dm-final');
  });
  await f.managers.get(A)!.handle({ id: `${A}|1792180000900|om_dm_choose_group`, userId: owner, channelId: dm, text: 'choose a group', imagePaths: [] }); await f.drain();
  assert.equal(inspected.defaultTargetId, 'private'); assert.deepEqual(inspected.aliases, ['T', '主Bot']); assert.equal(inspected.targets.length, 3);
  assert.equal(f.calls.length, 1); assert.equal(f.replies.filter(reply => reply.text.includes('private source to selected group'))[0]!.channel, `${A}|oc_a_group_1`);
  const delivery = f.host.store.listRoutedDeliveries()[0]!; assert.equal(delivery.source.channelId, dm); assert.equal(delivery.target.spaceId, G1); assert.equal(delivery.state, 'delivered');
  assert.equal(f.host.store.readPublic(G1, A).some(item => item.text === 'private source to selected group'), true);
  assert.deepEqual(f.host.store.getController(A), original); assert.equal(f.host.store.getRoot(f.host.store.readPublic(G1, A)[0]!.rootId)?.replyTo.channelId, dm);
});

for (const platform of ['feishu', 'discord'] as const) test(`${platform} draining permits only the running original private FINAL and keeps later inputs queued`, { timeout: 10000 }, async t => {
  const f = fixture(t, { platform }); await f.activate();
  const primary = f.ids[0]!, owner = f.configs[0]!.ownerUserId!, dm = `${primary}|owner-private-drain`;
  let checked = false;
  f.run(async (botId, turn) => {
    assert.equal(botId, primary); assert.equal(turn.groupContext, undefined);
    const regions = await f.host.invoke(primary, turn, 'bridge_delivery_targets', {}) as any;
    const group = regions.targets.find((target: any) => target.spaceId === G1)!;
    f.host.beginDrain();
    await assert.rejects(f.host.invoke(primary, turn, 'bridge_delivery_targets', {}), /暂停新增管理调用/);
    let dispatched = false;
    await assert.rejects(f.host.invoke(primary, turn, 'bridge_start_worker', { title: 'too late', prompt: 'must not run' }, 'drain-work', async () => { dispatched = true; }), /暂停新增管理调用/);
    assert.equal(dispatched, false);
    await assert.rejects(turn.onPublicMessage!('no supplement while draining', [], 'drain-supplement', undefined, false), /已停止/);
    await assert.rejects(turn.onPublicMessage!('no group final while draining', [], 'drain-group', group.targetId), /原私聊/);
    await f.managers.get(primary)!.handle({ id: 'private-after-drain', userId: owner, channelId: dm, text: 'next request', imagePaths: [] });
    await turn.onPublicMessage!('已安排重启，完成后继续。', [], 'drain-final'); checked = true;
  });
  await f.managers.get(primary)!.handle({ id: 'private-request-restart', userId: owner, channelId: dm, text: 'restart please', imagePaths: [] });
  await f.drain();
  assert.equal(checked, true);
  assert.equal(f.sessions.get(primary)!.getMessage('private-request-restart')!.replyState, 'delivered');
  assert.equal(f.sessions.get(primary)!.getMessage('private-after-drain')!.state, 'queued');
  assert.equal(f.replies.filter(reply => reply.text.includes('已安排重启')).length, 1);
  assert.equal(f.replies.some(reply => reply.text.includes('执行或回复失败')), false);
});

test('group input can supplement another owned group and owner DM then finish in its original group with unchanged task delivery', { timeout: 10000 }, async t => {
  const f = fixture(t); await f.activate(); await f.activate(G2); const owner = f.configs[0]!.ownerUserId!, dm = `${A}|oc_verified_owner_private`;
  await f.managers.get(A)!.handle({ id: `${A}|1792180000901|om_verified_dm`, userId: owner, channelId: dm, text: 'record this private address', imagePaths: [] }); await f.drain();
  f.configs[0]!.aliases = ['T']; f.configs[1]!.aliases = ['M'];
  f.run(async (botId, turn) => {
    if (botId === A && turn.text === 'route supplements') {
      const context = turn.groupContext!, scene = JSON.parse(context.scene); assert.deepEqual(scene.aliases, ['T']); assert.deepEqual(scene.memberIdentities.find((b: any) => b.botId === B).aliases, ['M']);
      const regions = await f.host.invoke(A, turn, 'bridge_delivery_targets', {}) as any;
      await f.host.invoke(A, turn, 'bridge_claim_work', { taskId: 'fixed-delivery-task', title: 'original group work' });
      const other = regions.targets.find((target: any) => target.spaceId === G2);
      await turn.onPublicMessage!('supplement to another group', [], 'to-other-group', other.targetId, false);
      await turn.onPublicMessage!('owner only supplemental detail', [], 'owner-detail', 'private', false);
      assert.equal(f.host.store.canProduceEffects(context.eventId), true);
      await turn.onPublicMessage!('final in original group', [], 'original-final');
      assert.equal(f.host.store.canProduceEffects(context.eventId), false);
    } else await turn.onSilent?.();
  });
  await f.host.receive(A, f.message(A, 'route-input', 'route supplements', G1, [A])); await f.drain();
  assert.equal(f.replies.find(reply => reply.text.includes('supplement to another group'))!.channel, `${A}|oc_a_group_2`);
  assert.equal(f.replies.find(reply => reply.text.includes('owner only supplemental detail'))!.channel, dm);
  assert.equal(f.replies.find(reply => reply.text.includes('final in original group'))!.channel, `${A}|oc_a_group_1`);
  assert.equal(f.host.store.getTask('fixed-delivery-task')?.replyTo.channelId, `${A}|oc_a_group_1`);
  assert.equal(f.host.store.readPublic(G1, A).some(item => item.text.includes('owner only')), false);
  assert.equal(f.host.store.readPublic(G1, A).some(item => item.text.includes('another group')), false);
  assert.deepEqual(f.host.store.readPublic(G2, A).map(item => item.text), ['supplement to another group']);
  assert.equal(f.calls.filter(call => call.turn.groupContext?.spaceId === G2).length, 0);
});

test('a private final selected from a group seals its event without publishing private content to any public log', { timeout: 10000 }, async t => {
  const f = fixture(t); await f.activate(); const owner = f.configs[0]!.ownerUserId!, dm = `${A}|oc_verified_owner_private`;
  await f.managers.get(A)!.handle({ id: `${A}|1792180000902|om_owner_dm`, userId: owner, channelId: dm, text: 'register private route', imagePaths: [] }); await f.drain();
  f.run(async (botId, turn) => {
    if (botId === A) { await turn.onPublicMessage!('private final only', [], 'private-final', 'private'); assert.equal(f.host.store.canProduceEffects(turn.groupContext!.eventId), false); }
    else await turn.onSilent?.();
  });
  await f.host.receive(A, f.message(A, 'private-final-input', 'please decide audience', G1, [A])); await f.drain();
  assert.equal(f.replies.find(reply => reply.text.includes('private final only'))!.channel, dm);
  assert.equal(f.host.store.readPublic(G1, A).some(item => item.text === 'private final only'), false);
  assert.equal(f.host.store.listEvents(A).at(-1)?.decision, 'published');
});

test('stale group target IDs and a target revoked during its live permission probe cannot send or change original work ownership', { timeout: 10000 }, async t => {
  const f = fixture(t); await f.activate(); await f.activate(G2);
  f.run(async (botId, turn) => {
    if (botId === A && turn.text === 'test target changes') {
      const regions = await f.host.invoke(A, turn, 'bridge_delivery_targets', {}) as any, selected = regions.targets.find((target: any) => target.spaceId === G2);
      const old = f.host.store.getGroup(G2)!; f.host.store.stopGroup(G2, P); f.host.store.startGroup({ spaceId: G2, principalId: P, receiverBotId: A, memberBotIds: old.memberBotIds });
      await assert.rejects(turn.onPublicMessage!('must not use stale target', [], 'stale-target', selected.targetId, false), /目标ID/);
      const refreshed = await f.host.invoke(A, turn, 'bridge_delivery_targets', {}) as any, target = refreshed.targets.find((target: any) => target.spaceId === G2);
      let probes = 0; f.groupChecks.set(A, async () => { if (++probes === 2) f.host.store.stopGroup(G2, P); return true; });
      await assert.rejects(turn.onPublicMessage!('must not reach revoked group', [], 'revoked-target', target.targetId, false), /disabled|改变|目标/);
      f.groupChecks.delete(A); await turn.onSilent?.();
    } else await turn.onSilent?.();
  });
  await f.host.receive(A, f.message(A, 'target-changes', 'test target changes', G1, [A])); await f.drain();
  assert.equal(f.replies.some(reply => reply.text.includes('must not')), false); assert.equal(f.host.store.listRoutedDeliveries().length, 0);
});

test('group activation preserves existing controllers; uninitialized members do not call an Agent', { timeout: 10000 }, async t => {
  const f = fixture(t, { initialized: [A] }); const before = f.host.store.getController(A);
  await f.activate();
  assert.deepEqual(f.host.store.getController(A), before); assert.equal(f.host.store.getController(B), null);
  assert.match(f.replies[0]!.text, /未初始化/);
  await f.host.receive(A, f.message(A, 'question', 'what is ready?')); await f.drain();
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0]!.botId, A);
  assert.equal(f.host.store.getController(B), null);
  assert.equal(f.host.store.listEvents()[0]?.state, 'silent');
});

test('explicitly targeting an uninitialized member gives a control hint instead of silently dropping the input', { timeout: 10000 }, async t => {
  const f = fixture(t, { initialized: [A] }); await f.activate();
  const prior = f.replies.length;
  await f.host.receive(A, f.message(A, 'ask-uninitialized-b', 'please help B', G1, [B])); await f.drain();
  assert.deepEqual(f.calls.map(c => c.botId), [A]);
  assert.equal(f.replies.length, prior);
});

test('only the owner and receiver admit ordinary messages; cross-app duplicate receipt runs each target once', { timeout: 10000 }, async t => {
  const f = fixture(t); await f.activate();
  const other = f.message(A, 'unauthorized', 'not the owner'); other.userId = `${A}|other-0`;
  await f.host.receive(A, other);
  await f.host.receive(B, f.message(B, 'same-platform-message', 'authorized root'));
  await f.host.receive(A, f.message(A, 'same-platform-message', 'authorized root'));
  await f.host.receive(A, f.message(A, 'same-platform-message', 'authorized root'));
  await f.drain();
  assert.deepEqual(f.calls.map(c => c.botId).sort(), [A, B]);
  assert.equal(new Set(f.host.store.listEvents().map(e => e.rootId)).size, 1);
  assert.equal(f.host.store.listEvents().every(e => e.state === 'silent'), true);
  assert.equal(f.host.store.listOutbox().length, 0);
  assert.equal(f.host.inbox.pending().length, 0);
  assert.equal(f.reports.some(line => line.startsWith('GROUP_INPUT_FAILED')), false);
});

test('shared controller fixes each group reply address despite another group and private chat activity', { timeout: 10000 }, async t => {
  const f = fixture(t); await f.activate(); await f.activate(G2);
  const wait = f.gate();
  f.run(async (_botId, turn) => {
    if (_botId !== A) { await turn.onSilent?.(); return; }
    if (turn.groupContext && turn.text === 'from first group') { await wait.promise; await turn.onPublicMessage!('first-group answer'); }
    else if (turn.groupContext && turn.text === 'from second group') await turn.onPublicMessage!('second-group answer');
    else await turn.onSilent?.();
  });
  await f.host.receive(A, f.message(A, 'first-question', 'from first group', G1, [A]));
  await eventual(() => f.calls.some(c => c.turn.text === 'from first group'), 'first group native started');
  await f.managers.get(A)!.handle({ id: 'private-input', userId: f.configs[0]!.ownerUserId!, channelId: `${A}|oc_private_owner`, text: 'private activity', imagePaths: [] });
  await f.host.receive(A, f.message(A, 'second-question', 'from second group', G2, [A]));
  wait.release(); await f.drain();
  const first = f.replies.find(r => r.text.includes('first-group answer'))!;
  const second = f.replies.find(r => r.text.includes('second-group answer'))!;
  assert.equal(first.channel, `${A}|oc_a_group_1`); assert.equal(second.channel, `${A}|oc_a_group_2`);
  const aGroupTurns = f.calls.filter(c => c.botId === A && c.turn.groupContext);
  assert.equal(new Set(aGroupTurns.map(c => c.turn.conversation.id)).size, 1);
});

test('public discussion gives each Bot eight acknowledged non-owner replies without cancelling received events', { timeout: 10000 }, async t => {
  const f = fixture(t); await f.activate();
  f.run(async (_botId, turn) => {
    try { await turn.onPublicMessage!(`public ${f.calls.length}`); }
    catch (error) {
      if (error && typeof error === 'object' && 'groupReplyPaused' in error) await turn.onSilent!();
      else throw error;
    }
  });
  await f.host.receive(A, f.message(A, 'discussion', 'independent opinions please')); await f.drain();
  const event = f.host.store.listEvents()[0]!, root = f.host.store.getRoot(event.rootId)!;
  assert.equal(root.automaticUsed, 0); assert.equal(root.automaticReserved, 0);
  for (const botId of [A, B]) assert.equal(f.host.store.publicReplySnapshot(botId, G1).count, 8);
  assert.equal(f.host.store.listEvents().some(value => value.error === 'root-budget-exhausted'), false);
  assert.ok(f.replies.filter(reply => reply.text.includes('连续回复非主人消息的可用次数已用完')).length >= 1);
  assert.ok(f.calls.length > 10);
});

test('public reply count ignores silence and duplicate owner delivery; only a new owner message in this group resets it', async t => {
  const f = fixture(t); await f.activate(); await f.activate(G2);
  const ownerMessage = f.message(A, 'reply-limit-owner', 'owner source');
  await f.host.receive(A, ownerMessage); await f.drain();
  const original = f.host.store.listEvents(A).find(value => value.kind === 'human')!;
  f.run(async (botId, turn) => {
    if (!turn.groupContext) { await turn.onPublicMessage!('private answer'); return; }
    if (botId === A && turn.text.startsWith('counted reply')) {
      await Promise.all([
        turn.onPublicMessage!('first paragraph', [], 'part-one:' + turn.groupContext.eventId, undefined, false),
        turn.onPublicMessage!('second paragraph', [], 'part-two:' + turn.groupContext.eventId, undefined, false),
      ]);
      await turn.onPublicMessage!('last paragraph', [], 'part-three:' + turn.groupContext.eventId, undefined, true);
    } else await turn.onSilent?.();
  });
  for (let i = 0; i < 2; i++) {
    f.host.store.enqueueEvent({ id: `counted-reply-${i}`, rootId: original.rootId, botId: A, generation: original.generation,
      kind: 'observation', sourceBotId: B, causeEventId: original.id, payload: { text: 'counted reply ' + i } });
    await f.host.pump(); await f.drain();
  }
  assert.equal(f.host.store.publicReplySnapshot(A, G1).count, 2);
  assert.equal(f.host.store.publicReplySnapshot(B, G1).count, 0);
  await f.host.receive(A, ownerMessage); await f.drain();
  assert.equal(f.host.store.publicReplySnapshot(A, G1).count, 2);
  await f.managers.get(A)!.handle({ id: 'private-no-public-reset', userId: f.configs[0]!.ownerUserId!, channelId: `${A}|oc_private_limit`, text: 'private owner input', imagePaths: [] }); await f.drain();
  assert.equal(f.host.store.publicReplySnapshot(A, G1).count, 2);
  await f.host.receive(A, f.message(A, 'other-group-owner-no-reset', 'other group owner input', G2)); await f.drain();
  assert.equal(f.host.store.publicReplySnapshot(A, G1).count, 2);
  const guest = f.message(A, 'guest-no-public-reset', 'guest'); guest.userId = `${A}|outside-whitelist`;
  await f.host.receive(A, guest); await f.drain();
  assert.equal(f.host.store.publicReplySnapshot(A, G1).count, 2);
  await f.host.receive(A, f.message(A, 'new-owner-public-reset', 'new owner message in same group')); await f.drain();
  assert.equal(f.host.store.publicReplySnapshot(A, G1).count, 0);
  assert.equal(f.host.store.publicReplySnapshot(B, G1).count, 0);
});

test('paused ordinary group input is durably captured but cancelled after a controller reset', { timeout: 10000 }, async t => {
  const f = fixture(t); await f.activate();
  const pause = f.hooks.get(A)!;
  pause.pauseGroup();
  await f.host.receive(A, f.message(A, 'while-paused', 'wait for the new controller', G1, [A]));
  assert.equal(f.host.inbox.pending().length, 1); assert.equal(f.calls.length, 0);
  const configA = f.configs[0]!, target = f.sessions.get(A)!.createConversation(configA.ownerUserId!, 'codex', configA.workspace, { controllerMode: true });
  f.host.store.setController(A, P, { conversationId: target.id, generation: 2, agent: 'codex', nativeId: null }, 1);
  pause.resumeGroup(); await f.drain();
  assert.equal(f.host.inbox.pending().length, 0); assert.equal(f.calls.length, 0);
  assert.equal(f.host.store.listEvents().length, 0);
});

test('failed batch preflight/preparation never reports all members reset or changes only one current pointer', { timeout: 10000 }, async t => {
  const f = fixture(t); await f.activate();
  const before = [A, B].map(id => f.host.store.getController(id));
  f.managers.get(B)!.prepareReset = async () => { throw new Error('verified scheduled execution cannot be stopped'); };
  await f.host.receive(A, f.message(A, 'failed-new', '/new', G1, [A]));
  assert.deepEqual([A, B].map(id => f.host.store.getController(id)), before);
  assert(f.replies.some(r => /命令未完成/.test(r.text)));
  assert(!f.replies.some(r => /已提交本群/.test(r.text)));
  const batch = f.host.store.listUnfinishedBatches()[0]!;
  assert.equal(batch.state, 'blocked'); assert.equal(batch.members[0]!.cancellation, 'confirmed'); assert.equal(batch.members[1]!.cancellation, 'blocked');
  await f.host.recover();
  assert.deepEqual([A, B].map(id => f.host.store.getController(id)), before);
  assert.equal(f.host.store.getBatchReset(batch.id)?.state, 'blocked');
  assert(f.reports.some(report => report.startsWith('HOST_RESET_RECONCILIATION_REQUIRED')));
});

test('program checks linked workers before handoff, ignores model proof, and keeps the original task address', { timeout: 10000 }, async t => {
  const f = fixture(t); await f.activate(); let refused = false;
  f.run(async (botId, turn) => {
    if (botId === A && !turn.groupContext!.eventKind) {
      let directDispatch = false;
      await f.host.invoke(A, turn, 'bridge_start_worker', { workId: 'not-claimed', title: 'direct task', prompt: 'authorized direct execution' }, 'direct', async input => {
        directDispatch = true; assert.equal('workId' in input, false); return f.registerExecution(A, turn, 'direct', 'direct-worker');
      });
      assert.equal(directDispatch, true); assert.equal(f.host.store.getTask('not-claimed'), null);
      assert.match(f.host.store.getTaskForWorker(A, 'direct-worker')!.id, /^auto-work:/);
      await f.host.invoke(A, turn, 'bridge_claim_work', { taskId: 'work', title: 'investigate' });
      await f.host.invoke(A, turn, 'bridge_start_worker', { workId: 'work', title: 'investigation', prompt: 'authorized child work' }, 'start', async input => {
        assert.equal('workId' in input, false); return { workerId: 'worker' };
      });
      await assert.rejects(f.host.invoke(A, turn, 'bridge_propose_handoff', { taskId: 'work', targetBotId: B, summary: 'handoff', proof: 'model claims stopped' }), /尚未确认停止/);
      refused = true; f.workerStopped.set(`${A}/worker`, true);
      await f.host.invoke(A, turn, 'bridge_propose_handoff', { taskId: 'work', targetBotId: B, summary: 'runtime verified stopped' });
    } else if (botId === B && turn.text.startsWith('交接提议')) {
      const handoff = f.host.store.listHandoffs('work')[0]!;
      await f.host.invoke(B, turn, 'bridge_accept_handoff', { handoffId: handoff.id });
      let oldWorkerContinued = false;
      await assert.rejects(f.host.invoke(B, turn, 'bridge_continue_worker', { workId: 'work', workerId: 'worker', prompt: 'do not hijack A child' }, 'bad-continue', async () => {
        oldWorkerContinued = true; return {};
      }), /不属于当前用户和父会话|助手不属于当前任务/);
      assert.equal(oldWorkerContinued, false);
    }
    await turn.onSilent?.();
  });
  await f.host.receive(A, f.message(A, 'handoff-root', 'please investigate', G1, [A])); await f.drain();
  assert.equal(refused, true); assert.equal(f.host.store.getTask('work')?.ownerBotId, B);
  assert.equal(f.host.store.getTask('work')?.state, 'active', 'accepted handoff waits for the new owner to dispatch');
  assert.equal(f.host.store.getTask('work')?.replyTo.channelId, `${A}|oc_a_group_1`);
  assert.deepEqual(f.host.store.taskWorkers('work'), [{ botId: A, workerId: 'worker' }]);
});

test('accepted handoff stays active until the new owner dispatches and then checks historical workers through their real Bots', { timeout: 10000 }, async t => {
  const f = fixture(t); await f.activate(); let accepted = false, completed = false;
  const taskId = 'handoff-auto-lifecycle';
  f.run(async (botId, turn) => {
    if (botId === A && !turn.event) {
      await f.host.invoke(A, turn, 'bridge_claim_work', { taskId, title: '交接后由 B 继续的任务', resources: ['handoff:shared-resource'] });
      await f.host.invoke(A, turn, 'bridge_start_worker', { workId: taskId, title: 'A 的原始执行', prompt: '第一阶段' }, 'handoff-first', async () =>
        f.registerExecution(A, turn, 'handoff-first', 'historical-a-worker'));
      f.controllerStores.get(A)!.setJob('job-handoff-first', 'cancelled'); f.workerStopped.set(`${A}/historical-a-worker`, true);
      await f.host.invoke(A, turn, 'bridge_propose_handoff', { taskId, targetBotId: B, summary: 'A 已停止，请 B 用自己的助手继续原任务' });
    } else if (botId === B && turn.text.startsWith('交接提议')) {
      const handoff = f.host.store.listHandoffs(taskId)[0]!;
      await f.host.invoke(B, turn, 'bridge_accept_handoff', { handoffId: handoff.id }); accepted = true;
      assert.equal(f.host.store.getTask(taskId)!.ownerBotId, B); assert.equal(f.host.store.getTask(taskId)!.state, 'active');
      f.hooks.get(B)!.onExecutionSettled!();
      assert.equal(f.host.store.getTask(taskId)!.state, 'active', 'A old journal cannot finish a newly accepted B task');
      let hijacked = false;
      await assert.rejects(f.host.invoke(B, turn, 'bridge_continue_worker', { workId: taskId, workerId: 'historical-a-worker', prompt: '不得操作 A 助手' }, 'handoff-hijack', async () => {
        hijacked = true; return {};
      }), /不属于当前用户和父会话|助手不属于当前任务/);
      assert.equal(hijacked, false);
      await f.host.invoke(B, turn, 'bridge_start_worker', { workId: taskId, title: 'B 的独立执行', prompt: '继续第二阶段' }, 'handoff-second', async () =>
        f.registerExecution(B, turn, 'handoff-second', 'current-b-worker'));
      assert.equal(f.host.store.getAutomaticDispatch(taskId)!.botId, B); assert.equal(f.host.store.getTask(taskId)!.state, 'active');
      assert.equal(f.workerStopped.has(`${B}/historical-a-worker`), false, 'B has no stop proof for A historical worker');
      f.controllerStores.get(B)!.setJob('job-handoff-second', 'completed'); f.workerStopped.set(`${B}/current-b-worker`, true);
      f.hooks.get(B)!.onExecutionSettled!();
      assert.equal(f.host.store.getTask(taskId)!.state, 'completed', 'new B completed receipt, rather than old A cancelled receipt, determines the outcome'); completed = true;
    }
    await turn.onSilent?.();
  });
  await f.host.receive(A, f.message(A, 'handoff-auto-lifecycle-owner', '按阶段协作检查', G1)); await f.drain();
  assert.equal(accepted, true); assert.equal(completed, true);
  assert.equal(f.host.store.getTask(taskId)!.ownerBotId, B); assert.equal(f.host.store.getTask(taskId)!.state, 'completed');
  assert.equal(f.host.store.getTask(taskId)!.replyTo.channelId, `${A}|oc_a_group_1`);
  assert.deepEqual(f.host.store.taskWorkers(taskId), [{ botId: A, workerId: 'historical-a-worker' }, { botId: B, workerId: 'current-b-worker' }]);
});

test('group stop retains authorized tasks/results and never redirects a late completion to another group', { timeout: 10000 }, async t => {
  const f = fixture(t); await f.activate();
  f.run(async (botId, turn) => {
    if (botId === A) await f.host.invoke(A, turn, 'bridge_claim_work', { taskId: 'retained', title: 'authorized work' });
    await turn.onSilent?.();
  });
  await f.host.receive(A, f.message(A, 'retained-root', 'start', G1, [A])); await f.drain();
  await f.host.receive(A, f.message(A, 'stop-space', '/group stop', G1, [A]));
  assert.equal(f.host.store.getTask('retained')?.state, 'active');
  assert.equal(f.host.store.getTask('retained')?.replyTo.channelId, `${A}|oc_a_group_1`);
  assert.equal(f.host.allowDelivery(A, `${A}|oc_a_group_1`), false);
  const hook = f.hooks.get(A)!.manager as SessionManagerOptions;
  const context = f.calls.find(c => c.botId === A)!.turn.groupContext!;
  const completion = { wakeAllowed: true, id: 'late-result', conversationId: f.host.store.getController(A)!.conversationId, groupContext: context, text: 'late result' };
  assert.equal(await hook.onGroupCompletion!(completion as never), 'retain');
  assert.equal(f.host.store.listEvents(A).length, 1);
});

test('membership failure before native start releases its reservation instead of permanently wedging the Bot', { timeout: 10000 }, async t => {
  const f = fixture(t); await f.activate(); let probes = 0;
  f.groupChecks.set(A, async () => { probes++; return probes === 1; }); // Admission succeeds, turn-time verification fails.
  await f.host.receive(A, f.message(A, 'revoked-before-start', 'permission changed', G1, [A]));
  await eventual(() => f.managers.get(A)!.isIdle(), 'failed pre-native check settled');
  await nextImmediate();
  assert.equal(f.host.store.listEvents(A).some(event => event.state === 'reserved'), false);
  assert.equal(f.calls.length, 0);
});

test('durable intake order survives a slower first permission probe and does not regress the history cursor', { timeout: 10000 }, async t => {
  const f = fixture(t); await f.activate(); const firstProbe = f.gate(); const entered = f.gate(); let probes = 0;
  f.groupChecks.set(A, async () => { if (++probes === 1) { entered.release(); await firstProbe.promise; } return true; });
  const first = f.host.receive(A, f.message(A, 'order-first', 'first received', G1, [A])); await entered.promise;
  const second = f.host.receive(A, f.message(A, 'order-second', 'second received', G1, [A]));
  await nextImmediate(); firstProbe.release(); await Promise.all([first, second]); await f.drain();
  for (const id of [A, B]) assert.deepEqual(f.calls.filter(c => c.botId === id).map(c => c.turn.text), ['first received', 'second received']);
  assert.equal(f.host.inbox.cursor(A, G1), f.message(A, 'order-second', '').id);
});

test('publish and silent decisions seal the host tool surface while waiting for native completion', { timeout: 10000 }, async t => {
  const f = fixture(t); await f.activate(); let lateWorkRejected = 0;
  f.run(async (botId, turn) => {
    if (botId === A) await turn.onPublicMessage!('only public reply');
    else await turn.onSilent!();
    await assert.rejects(f.host.invoke(botId, turn, 'bridge_claim_work', { taskId: `late-${botId}`, title: 'must never start' }), /轮次已结束|静默|冻结/);
    lateWorkRejected++;
  });
  await f.host.receive(A, f.message(A, 'seal', 'both participate')); await f.drain();
  assert(lateWorkRejected >= 2);
  assert.equal(f.host.store.listTasks().length, 0);
  assert.equal(f.replies.filter(r => r.text.includes('only public reply')).length, 1);
  assert(f.host.store.listEvents().every(event => event.nativeEnded));
});

test('successful group reset suppresses per-Bot introduction notices and keeps one aggregate receipt', { timeout: 10000 }, async t => {
  const f = fixture(t); await f.activate();
  await f.host.receive(A, f.message(A, 'successful-new', '/new', G1, [A]));
  for (const botId of [A, B]) {
    const conversation = f.host.store.getController(botId)!;
    assert.equal(conversation.generation, 2);
    assert.equal(f.sessions.get(botId)!.workspaceNotice(conversation.conversationId), null);
    assert.deepEqual(f.managers.get(botId)!.knownDMChannels(), []);
  }
  assert.equal(f.replies.filter(r => /已提交本群/.test(r.text)).length, 1);
});

test('any member private reset cancels an already received broadcast even when it only mentions A', { timeout: 10000 }, async t => {
  const f = fixture(t); await f.activate(); const wait = f.gate(), entered = f.gate(); let probes = 0;
  f.groupChecks.set(A, async () => { if (++probes === 1) { entered.release(); await wait.promise; } return true; });
  const delivery = f.host.receive(A, f.message(A, 'only-a-before-b-new', 'only A should handle this', G1, [A])); await entered.promise;
  const configB = f.configs[1]!, newB = f.sessions.get(B)!.createConversation(configB.ownerUserId!, 'codex', configB.workspace, { controllerMode: true });
  f.host.store.setController(B, P, { conversationId: newB.id, generation: 2, agent: 'codex', nativeId: null }, 1);
  wait.release(); await delivery; await f.drain();
  assert.equal(f.calls.length, 0);
});

test('input captured before a continuous backend switch follows its preserved controller rather than being cancelled', { timeout: 10000 }, async t => {
  const f = fixture(t); await f.activate(); const wait = f.gate(), entered = f.gate(); let probes = 0;
  f.groupChecks.set(A, async () => { if (++probes === 1) { entered.release(); await wait.promise; } return true; });
  const delivery = f.host.receive(A, f.message(A, 'before-agent-switch', 'preserve this received input', G1, [A])); await entered.promise;
  const configA = f.configs[0]!, newA = f.sessions.get(A)!.createConversation(configA.ownerUserId!, 'claude', configA.workspace, { controllerMode: true });
  f.host.store.replaceControllerForAgentSwitch(A, P, { conversationId: newA.id, generation: 2, agent: 'claude', nativeId: 'new-claude' }, 1);
  wait.release(); await delivery; await f.drain();
  assert.equal(f.calls.length, 2); const switched = f.calls.find(c => c.botId === A)!; assert.equal(switched.turn.conversation.agent, 'claude');
  assert.equal(switched.turn.groupContext!.generation, 2);
});

test('input captured in an old group epoch is cancelled after stop and reactivation even if native generations stay unchanged', { timeout: 10000 }, async t => {
  const f = fixture(t); await f.activate(); const wait = f.gate(), entered = f.gate(); let probes = 0;
  f.groupChecks.set(A, async () => { if (++probes === 1) { entered.release(); await wait.promise; } return true; });
  const delivery = f.host.receive(A, f.message(A, 'old-epoch-pending', 'do not replay after reactivation', G1, [A])); await entered.promise;
  f.host.store.stopGroup(G1, P);
  f.host.store.startGroup({ spaceId: G1, principalId: P, receiverBotId: A, memberBotIds: [A, B] });
  wait.release(); await delivery; await f.drain();
  assert.equal(f.host.store.getGroup(G1)?.epoch, 2); assert.equal(f.calls.length, 0);
});

test('one Bot retains durable intake order across two groups with different permission probe completion times', { timeout: 10000 }, async t => {
  const f = fixture(t); await f.activate(); await f.activate(G2); const wait = f.gate(), entered = f.gate(); let probes = 0;
  f.groupChecks.set(A, async () => { if (++probes === 1) { entered.release(); await wait.promise; } return true; });
  const first = f.host.receive(A, f.message(A, 'g1-first', 'first from G1', G1, [A])); await entered.promise;
  const second = f.host.receive(A, f.message(A, 'g2-second', 'second from G2', G2, [A]));
  await nextImmediate(); wait.release(); await Promise.all([first, second]); await f.drain();
  for (const id of [A, B]) assert.deepEqual(f.calls.filter(c => c.botId === id).map(call => call.turn.text), ['first from G1', 'second from G2']);
});

test('controller timer wakes share the original root budget while genuine worker completion remains deliverable', { timeout: 10000 }, async t => {
  const f = fixture(t); await f.activate();
  await f.host.receive(A, f.message(A, 'scheduled-root', 'authorized root', G1, [A])); await f.drain();
  const context = f.calls[0]!.turn.groupContext!, hook = f.hooks.get(A)!.manager as SessionManagerOptions;
  const common = { wakeAllowed: true, conversationId: f.host.store.getController(A)!.conversationId, groupContext: context, text: 'scheduled wake evidence' };
  for (let index = 0; index < 9; index++) {
    await hook.onGroupCompletion!({ ...common, id: `wake-${index}`, scheduleKind: 'controller' } as never);
    await f.drain();
  }
  assert.equal(f.host.store.getRoot(context.rootId)?.automaticUsed, 8);
  assert.equal(f.calls.filter(c => c.botId === A).length, 9); // Initial human participation plus eight charged timer wakes.
  await hook.onGroupCompletion!({ ...common, id: 'actual-worker-completion', scheduleKind: 'worker', text: 'completed result' } as never);
  await f.drain();
  assert.equal(f.calls.filter(c => c.botId === A).length, 10);
  assert.equal(f.calls.at(-1)?.turn.event?.kind, 'worker-result');
});

test('group controller events never become private history cursors on the next Bot startup', { timeout: 10000 }, async t => {
  const f = fixture(t); await f.activate();
  await f.host.receive(A, f.message(A, 'group-only', 'group input', G1, [A])); await f.drain();
  assert.equal(f.host.store.listEvents(A).length, 1);
  assert.deepEqual(f.managers.get(A)!.knownDMChannels(), []);
  assert.deepEqual(f.managers.get(B)!.knownDMChannels(), []);
});

test('removing the configured principal immediately stops new turns and old group delivery without transferring ownership', { timeout: 10000 }, async t => {
  const f = fixture(t); await f.activate();
  f.config.principals = f.config.principals.filter(principal => principal.id !== P);
  assert.equal(f.host.authorize(A, f.configs[0]!.ownerUserId!, 'try again'), false);
  assert.equal(f.host.store.getGroup(G1)?.enabled, false);
  assert.equal(f.host.store.getBot(A)?.ownerPrincipalId, P);
  assert.equal(f.host.allowDelivery(A, `${A}|oc_a_group_1`), false);
  await f.host.receive(B, f.message(B, 'revoked-owner', 'must not trigger')); await f.drain();
  assert.equal(f.calls.length, 0);
});

test('removing one loaded Bot account from its whitelist pauses the shared group but keeps all owners and native pointers', { timeout: 10000 }, async t => {
  const f = fixture(t); await f.activate();
  const before = [A, B].map(id => f.host.store.getController(id));
  f.configs[1]!.allowedUserIds = f.configs[1]!.allowedUserIds.filter(user => user !== f.configs[1]!.ownerUserId);
  assert.equal(f.host.allowDelivery(A, `${A}|oc_a_group_1`), false);
  assert.equal(f.host.store.getGroup(G1)?.enabled, false);
  assert.deepEqual([A, B].map(id => f.host.store.getController(id)), before);
  assert.equal(f.host.store.getBot(B)?.ownerPrincipalId, P);
});

test('restarting against a persisted group pauses revoked configuration before attaching or starting any Bot', { timeout: 10000 }, async t => {
  const f = fixture(t); await f.activate(); await f.close();
  const config: HostConfig = { ...f.config, configs: f.config.configs.map(value => ({ ...value, allowedUserIds: [] })) };
  const marker: HostSemanticMarker = { version: 3, status: 'complete', migrationId: 'restart-test', migratedAt: '', bots: [] };
  const reopened = new HostRuntime(config, marker, async () => ({}), () => {});
  try {
    assert.equal(reopened.store.getGroup(G1)?.enabled, false);
    assert.equal(reopened.store.getBot(A)?.ownerPrincipalId, P);
    assert.equal(reopened.store.getController(A)?.generation, 1);
  } finally { await reopened.close(); }
});

test('private supplements require a verified owner DM route, preserve task/group address, and never enter public history', { timeout: 10000 }, async t => {
  const f = fixture(t); await f.activate();
  f.run(async (botId, turn) => {
    if (botId === A && turn.groupContext) {
      await assert.rejects(f.host.invoke(A, turn, 'bridge_send_private', { principalId: P, text: 'no private route yet' }), /真实私聊登记/);
    }
    await turn.onSilent?.();
  });
  await f.host.receive(A, f.message(A, 'no-private-route', 'private route is missing', G1, [A])); await f.drain();
  const owner = f.configs[0]!.ownerUserId!, dmChannel = `${A}|oc_verified_owner_private`;
  await f.managers.get(A)!.handle({ id: `${A}|1792180000999|om_verified_private`, userId: owner, channelId: dmChannel,
    text: 'a real owner DM receipt', imagePaths: [] }); await f.drain();
  assert.equal(f.managers.get(A)!.knownDMChannels()[0]!.channelId, dmChannel);
  f.run(async (botId, turn) => {
    if (botId === A && turn.groupContext && !turn.groupContext.eventKind) {
      await assert.rejects(f.host.invoke(A, turn, 'bridge_send_private', { principalId: Q, text: 'must not leak to another principal' }), /负责人/);
      await f.host.invoke(A, turn, 'bridge_claim_work', { taskId: 'private-preserves-origin', title: 'original group task' });
      const args = { principalId: P, text: 'owner-only supplement secret' };
      await f.host.invoke(A, turn, 'bridge_send_private', args, 'private-send-id');
      await f.host.invoke(A, turn, 'bridge_send_private', args, 'private-send-id');
      await turn.onPublicMessage!('group progress remains public');
    } else await turn.onSilent?.();
  });
  await f.host.receive(A, f.message(A, 'send-private', 'send private supplement and public progress', G1, [A])); await f.drain();
  const privateReplies = f.replies.filter(reply => reply.text === 'owner-only supplement secret');
  assert.equal(privateReplies.length, 1); assert.equal(privateReplies[0]!.channel, dmChannel);
  const box = f.host.store.listOutbox().filter(item => item.audience === 'private');
  assert.equal(box.length, 1); assert.equal(box[0]!.state, 'delivered');
  assert.equal(box[0]!.replyTo.userId, 'owner-0');
  assert.equal(f.host.store.getTask('private-preserves-origin')?.replyTo.channelId, `${A}|oc_a_group_1`);
  assert.equal(f.host.store.getRoot(box[0]!.rootId)?.replyTo.channelId, `${A}|oc_a_group_1`);
  assert.equal(f.host.store.readPublic(G1, A).some(message => message.text.includes('owner-only supplement secret')), false);
  assert.equal(f.replies.find(reply => reply.text.includes('group progress remains public'))!.channel, `${A}|oc_a_group_1`);
});

test('Discord recovery walks before cursors without page tokens and admits buffered history in source order', { timeout: 10000 }, async t => {
  const f = fixture(t, { platform: 'discord' }); await f.activate();
  const first = f.message(D1, 'history-first', 'history first', G1, [D1]);
  const second = f.message(D1, 'history-second', 'history second', G1, [D1]);
  const third = f.message(D1, 'history-third', 'history third', G1, [D1]);
  const activation = f.message(D1, `activate-${G1}`, '/group start', G1, [D1]);
  const requestOptions: DMHistoryOptions[] = [];
  f.histories.set(D1, async (_raw, options) => {
    requestOptions.push(options);
    if (requestOptions.length === 1) return { messages: [third, second], oldestId: second.id, newestId: third.id, hasMore: true };
    return { messages: [first, activation], oldestId: activation.id, newestId: first.id, hasMore: true };
  });
  await f.host.recover(); await f.drain();
  for (const id of [D1, D2]) assert.deepEqual(f.calls.filter(c => c.botId === id).map(call => call.turn.text), ['history first', 'history second', 'history third']);
  assert.equal(requestOptions.length, 2); assert.equal(requestOptions[0]!.before, undefined);
  assert.equal(requestOptions[1]!.before, second.id);
  assert.equal(requestOptions.every(options => options.pageToken === undefined && options.after === undefined && options.since === undefined), true);
  assert.equal(f.host.inbox.cursor(D1, G1), third.id); assert.equal(f.host.store.getGroup(G1)?.enabled, true);
});

test('unverifiable Discord pagination pauses the binding and does not partially replay collected history', { timeout: 10000 }, async t => {
  const f = fixture(t, { platform: 'discord' }); await f.activate();
  const missingBoundary = f.message(D1, 'unverified-history', 'must not partly replay', G1, [D1]);
  f.histories.set(D1, async () => ({ messages: [missingBoundary], oldestId: null, newestId: missingBoundary.id, hasMore: true }));
  await f.host.recover(); await f.drain();
  assert.equal(f.calls.length, 0); assert.equal(f.host.store.getGroup(G1)?.enabled, false);
  assert(f.reports.some(report => report.startsWith('GROUP_RECOVERY_PAUSED')));
});

test('uncertain native work is never replayed; only program confirmation releases its Bot for a later real input', { timeout: 10000 }, async t => {
  const f = fixture(t); await f.activate();
  f.host.store.acceptRoot({ id: 'prior-root', sourceEventId: 'prior-receipt', spaceId: G1, principalId: P, targetBotIds: [A],
    replyTo: { botId: A, channelId: `${A}|oc_a_group_1`, spaceId: G1 } });
  f.host.store.enqueueEvent({ id: 'prior-native', rootId: 'prior-root', botId: A, generation: 1, kind: 'human', payload: { text: 'must not replay old inference' } });
  f.host.store.startEvent(f.host.store.claimNextEvent(A)!.id);
  f.host.store.recoverInFlight(); f.stoppedProofs.set(A, false);
  await f.host.recover();
  assert.equal(f.host.store.getEvent('prior-native')?.state, 'uncertain'); assert.equal(f.calls.filter(c => c.botId === A).length, 0);
  assert(f.reports.some(report => report.startsWith('HOST_NATIVE_STOP_UNCONFIRMED')));
  await f.host.receive(A, f.message(A, 'new-after-crash', 'a new real instruction', G1, [A]));
  assert.equal(f.calls.filter(c => c.botId === A).length, 0);
  f.stoppedProofs.set(A, true); await f.host.recover(); await f.drain();
  assert.equal(f.host.store.getEvent('prior-native')?.state, 'failed');
  for (const id of [A, B]) assert.deepEqual(f.calls.filter(c => c.botId === id).map(call => call.turn.text), ['a new real instruction']);
});

test('initialization callbacks update only the current controller readiness and status never mistakes a pointer for readiness', { timeout: 10000 }, async t => {
  const f = fixture(t); await f.activate(); const manager = f.managers.get(A)!, config = f.configs[0]!;
  const old = manager.currentConversation(config.ownerUserId!)!;
  const target = f.sessions.get(A)!.createConversation(config.ownerUserId!, 'codex', config.workspace, { controllerMode: true });
  const options = f.hooks.get(A)!.manager as SessionManagerOptions;
  options.binding!.setActive(config.ownerUserId!, target.id, 'reset');
  assert.equal(f.host.store.getBot(A)?.ready, false);
  await f.host.receive(A, f.message(A, 'status-pending-init', '/status', G1, [A]));
  assert.match(f.replies.at(-1)!.text.split('\n').find(line => line.startsWith(A))!, /未就绪/);
  await options.onInitializationState!(old, 'ready');
  assert.equal(f.host.store.getBot(A)?.ready, false);
  f.sessions.get(A)!.saveNativeId(target.id, 'confirmed-new-native');
  await options.onInitializationState!(f.sessions.get(A)!.getConversation(target.id)!, 'ready');
  assert.equal(f.host.store.getBot(A)?.ready, true);
  assert.equal(f.host.store.getController(A)?.nativeId, 'confirmed-new-native');
  await f.host.receive(A, f.message(A, 'start-after-init', '/group start', G1, [A]));
  assert.match(f.replies.at(-1)!.text.split('\n').find(line => line.startsWith(A))!, /已就绪/);
  await options.onInitializationState!(f.sessions.get(A)!.getConversation(target.id)!, 'request-failed');
  assert.equal(f.host.store.getBot(A)?.ready, false);
  assert.equal(f.host.store.getBot(B)?.ready, true);
});

test('recovery resumes only pending initialization in an already committed batch and never repeats reset or cancellation', { timeout: 10000 }, async t => {
  const f = fixture(t); await f.activate(); const operationId = 'committed-before-crash';
  const source = f.message(A, 'batch-committed-before-init', '/new', G1, [A]);
  f.host.inbox.capture(operationId, A, source, true, { [A]: 1, [B]: 1 }, 1);
  f.host.inbox.setState(operationId, 'uncertain');
  f.host.store.beginBatchReset({ id: operationId, principalId: P, spaceId: G1, botIds: [A, B] });
  for (const botId of [A, B]) {
    const config = f.configs.find(value => value.botId === botId)!;
    const target = f.sessions.get(botId)!.createConversation(config.ownerUserId!, 'codex', config.workspace, { controllerMode: true });
    f.host.store.recordBatchCancellation(operationId, botId, { confirmed: true, detail: 'old native/scheduled execution verified stopped before crash' });
    f.host.store.prepareBatchController(operationId, botId, { conversationId: target.id, generation: 2, agent: 'codex', nativeId: null });
  }
  f.host.store.commitBatchReset(operationId);
  const a = f.managers.get(A)!.currentConversation(f.configs[0]!.ownerUserId!)!;
  await (f.hooks.get(A)!.manager as SessionManagerOptions).onInitializationState!(a, 'ready');
  assert.equal(f.host.store.getBatchReset(operationId)?.state, 'initializing');
  const before = [A, B].map(id => f.host.store.getController(id));
  const initialized: string[] = [];
  for (const botId of [A, B]) {
    const manager = f.managers.get(botId)!, actual = manager.ensureCommittedResetInitialized.bind(manager);
    manager.prepareReset = async () => { assert.fail('committed reset must not prepare/cancel again'); };
    manager.ensureCommittedResetInitialized = async (target, command) => {
      initialized.push(botId); await actual(target, command);
      await (f.hooks.get(botId)!.manager as SessionManagerOptions).onInitializationState!(target, 'ready');
    };
  }
  await f.host.recover(); await f.drain();
  assert.deepEqual(initialized, [B]); assert.deepEqual([A, B].map(id => f.host.store.getController(id)), before);
  assert.equal(f.host.store.getBatchReset(operationId)?.state, 'completed');
  assert.equal(f.calls.length, 0); // Only initialization resume, never replay a human model turn.
  await f.host.recover(); assert.deepEqual(initialized, [B]);
  assert.equal(f.replies.filter(reply => /已提交本群/.test(reply.text)).length, 0);
});

test('a stalled A attachment download does not block two successive independent B roots or later pump cycles', { timeout: 10000 }, async t => {
  const f = fixture(t); await f.activate(); await f.activate(G2);
  f.host.store.startGroup({ spaceId: G1, principalId: P, receiverBotId: A, memberBotIds: [A] });
  f.host.store.startGroup({ spaceId: G2, principalId: P, receiverBotId: B, memberBotIds: [B] });
  const download = f.gate(), entered = f.gate();
  f.downloads.set(A, async () => { entered.release(); await download.promise; return []; });
  const image = f.message(A, 'stalled-a-image', 'A handles the image', G1, [A]);
  image.attachments = [{ id: 'image-reference', filename: 'image.png', url: '', size: 10, content_type: 'image/png',
    resourceKey: 'source-a-image-resource', messageId: 'om_stalled_image' }];
  await f.host.receive(A, image); await entered.promise;
  await f.host.receive(B, f.message(B, 'independent-b-one', 'B independent first root', G2, [B]));
  await eventual(() => f.calls.filter(call => call.botId === B).length === 1
    && f.host.store.listEvents(B).every(event => event.nativeEnded), 'B completes while A is still downloading');
  assert.equal(f.calls.filter(call => call.botId === A).length, 0);
  await f.host.receive(B, f.message(B, 'independent-b-two', 'B independent second root', G2, [B]));
  await eventual(() => f.calls.filter(call => call.botId === B).length === 2
    && f.host.store.listEvents(B).every(event => event.nativeEnded), 'later pump cycles also remain independent');
  assert.equal(f.calls.filter(call => call.botId === A).length, 0);
  assert.deepEqual(f.calls.filter(call => call.botId === B).map(call => call.turn.text), ['B independent first root', 'B independent second root']);
  download.release(); await f.drain();
  assert.equal(f.calls.filter(call => call.botId === A).length, 1);
});

test('failed group stop with an unavailable member leaves online members dispatchable', { timeout: 10000 }, async t => {
  const f = fixture(t); await f.activate(); const b = f.host.bots.get(B)!;
  f.host.bots.delete(B);
  await f.host.receive(A, f.message(A, 'stop-missing-b', '/stop', G1, [A]));
  assert.match(f.replies.at(-1)!.text, /未完成|离线/);
  f.host.bots.set(B, b);
  await f.host.receive(A, f.message(A, 'after-failed-stop', 'continue after failed control', G1, [A])); await f.drain();
  assert.deepEqual(f.calls.map(c => c.botId).sort(), [A, B]);
});

test('disabled completion wake retains the result after stop without reviving its group controller', { timeout: 10000 }, async t => {
  const f = fixture(t); await f.activate();
  await f.host.receive(A, f.message(A, 'before-late-cancel', 'authorized work', G1, [A])); await f.drain();
  await f.host.receive(A, f.message(A, 'actual-stop', '/stop', G1, [A])); await f.drain();
  const context = f.calls[0]!.turn.groupContext!, before = f.host.store.listEvents(A).length;
  const hook = f.hooks.get(A)!.manager as SessionManagerOptions;
  const result = await hook.onGroupCompletion!({ id: 'cancelled-late-result', wakeAllowed: false,
    conversationId: f.host.store.getController(A)!.conversationId, groupContext: context, text: 'late cancelled worker result' } as never);
  await f.drain(); assert.equal(result, 'retain'); assert.equal(f.host.store.listEvents(A).length, before); assert.equal(f.calls.filter(c => c.botId === A).length, 1);
});

test('turning group mode off pauses persisted bindings before Bot startup and does not transfer ownership', { timeout: 10000 }, async t => {
  const f = fixture(t); await f.activate(); const owner = f.host.store.getBot(A)!.ownerPrincipalId;
  await f.close(); f.configs[0]!.groupMode = false;
  const restored = new HostRuntime(f.config, { version: 3, status: 'complete', migrationId: 'already-v3', migratedAt: new Date().toISOString(), bots: [] }, async () => ({}), () => {});
  try { assert.equal(restored.store.getGroup(G1)?.enabled, false); assert.equal(restored.store.getBot(A)?.ownerPrincipalId, owner); }
  finally { await restored.close(); }
});

test('unknown prior native ownership blocks only that Bot before any manager startup', { timeout: 10000 }, async t => {
  const f = fixture(t); await f.activate();
  await f.host.receive(A, f.message(A, 'old-native-proof-root', 'old authorized context', G1, [A])); await f.drain();
  const context = f.calls[0]!.turn.groupContext!;
  f.host.store.enqueueEvent({ id: 'unfinished-proof', rootId: context.rootId, botId: A, generation: 1,
    kind: 'observation', sourceBotId: B, payload: { text: 'prior native work' } });
  f.host.store.claimNextEvent(A); f.host.store.startEvent('unfinished-proof'); f.host.store.recoverInFlight();
  f.host.bots.get(A)!.confirmControllerStopped = async () => false;
  await f.host.prepareRecoveryBots();
  assert.equal(f.host.failures.has(A), true); assert.equal(f.host.failures.has(B), false);
  assert.equal(f.host.store.getEvent('unfinished-proof')?.state, 'uncertain'); assert.equal(f.calls.filter(c => c.botId === A).length, 1);
});

test('startup recovery orders older history before a newer live receipt buffered during the history probe', { timeout: 10000 }, async t => {
  const f = fixture(t); await f.activate();
  const older = f.message(A, 'offline-gap-first', 'older outage input', G1, [A]);
  const live = f.message(A, 'live-during-startup', 'newer live input', G1, [A]);
  f.host.bots.get(A)!.transport.readGroupHistory = async () => ({ messages: [older], oldestId: older.id, newestId: older.id, hasMore: false });
  f.host.beginRecovery(); await f.host.receive(A, live); assert.equal(f.calls.length, 0);
  await f.host.recover(); await f.drain();
  for (const id of [A, B]) assert.deepEqual(f.calls.filter(c => c.botId === id).map(call => call.turn.text), ['older outage input', 'newer live input']);
});


test('active non-owner messages are durable evidence, never commands, authorization roots or model turns', async t => {
  const f = fixture(t); await f.activate();
  const source = f.message(A, 'observer-readonly', '/new', G1, [A]);
  source.userId = `${A}|outside-whitelist`;
  source.source = { messageId: source.id, userId: source.userId, channelId: source.channelId, authorType: 'user', authorName: 'Guest', time: '2026-10-17T12:00:00Z' };
  const before = f.replies.length;
  await f.host.receive(A, source); await f.host.receive(A, source); await f.drain();
  assert.equal(f.calls.length, 0); assert.equal(f.replies.length, before);
  assert.equal(f.host.store.listEvents().length, 0);
  const records = f.host.store.readContext(G1, A);
  assert.equal(records.recent.length, 1); assert.equal(records.recent[0]!.canAuthorize, false);
  assert.equal(records.recent[0]!.source.userId, source.userId); assert.equal(records.recent[0]!.source.authorName, 'Guest');
  assert.equal(records.recent[0]!.text, '/new'); assert.equal(f.host.store.getController(A)!.generation, 1);
  let scene: any;
  f.run(async (id, turn) => { if (id === A) scene = await f.host.invoke(A, turn, 'bridge_group_context', {}); await turn.onSilent?.(); });
  await f.host.receive(A, f.message(A, 'owner-after-observer', '了解一下群里情况')); await f.drain();
  assert.equal(scene.conversationEvidence.recent[0].source.userId, source.userId);
  assert.equal(scene.conversationEvidence.recent[0].canAuthorize, false);
  assert.equal(scene.conversationEvidence.recent.at(-1).canAuthorize, true);
});

test('inactive, unmapped and non-receiver observer messages do not become visible context', async t => {
  const f = fixture(t); const early = f.message(A, 'observer-before', 'before'); early.userId = `${A}|guest`;
  await f.host.receive(A, early); await f.activate();
  const duplicate = f.message(B, 'observer-other-receiver', 'other receiver'); duplicate.userId = `${B}|guest`;
  await f.host.receive(B, duplicate); await f.drain();
  assert.equal(f.host.store.readContext(G1, A).recent.length, 0);
});

test('observer membership proof cannot cross a group stop or binding replacement', async t => {
  const f = fixture(t); await f.activate(); const wait = f.gate();
  f.groupChecks.set(A, async () => { await wait.promise; return true; });
  const source = f.message(A, 'observer-stop-race', 'stale context'); source.userId = `${A}|guest`;
  const receiving = f.host.receive(A, source); await nextImmediate();
  f.host.store.stopGroup(G1, P, 'test stop'); wait.release(); await receiving; await f.drain();
  assert.equal(f.calls.length, 0); assert.equal(f.host.store.listEvents().length, 0);
  await f.host.receive(A, f.message(A, 'reactivate-after-observer-stop', '/group start', G1, [A]));
  assert.equal(f.host.store.getGroup(G1)?.enabled, true);
  assert.equal(f.host.store.readContext(G1, A).recent.length, 0);
});

test('private default scene sees active group observer evidence without granting its sender authority', async t => {
  const f = fixture(t); await f.activate();
  const source = f.message(A, 'observer-before-private', 'recent group discussion'); source.userId = `${A}|guest`;
  await f.host.receive(A, source); await f.drain();
  let scene: any;
  f.run(async (_id, turn) => { scene = JSON.parse(turn.chatScene!); await turn.onPublicMessage?.('seen'); });
  await f.managers.get(A)!.handle({ id: 'private-observer-question', userId: f.configs[0]!.ownerUserId!, channelId: `${A}|owner-dm`, text: '群里在聊什么', imagePaths: [] });
  await f.drain(); assert.equal(scene.records[0].text, source.text); assert.equal(scene.records[0].canAuthorize, false);
  assert.equal(scene.records[0].spaceId, G1); assert.equal(scene.audience, 'only this Bot owner in this private conversation');
});

test('history tool returns all authors as evidence with opaque pagination and no replay side effects', async t => {
  const f = fixture(t); await f.activate(); let first: any, second: any;
  const platformTokens: Array<string | undefined> = [];
  f.conversationHistories.set(A, async (raw, options) => {
    platformTokens.push(options.pageToken);
    return historyPage(raw, options, [{ id: options.pageToken ? 'older' : 'recent', author: { id: 'outside-whitelist', type: 'user' },
      time: options.pageToken ? '2026-10-16T12:00:00Z' : '2026-10-17T12:00:00Z', text: '/new do not execute', mentions: [], attachments: [] }], !options.pageToken, options.pageToken ? undefined : 'platform-secret-token');
  });
  f.run(async (id, turn) => {
    if (id === A) { first = await f.host.invoke(A, turn, 'bridge_read_group_history', {});
      second = await f.host.invoke(A, turn, 'bridge_read_group_history', { cursor: first.nextCursor }); }
    await turn.onSilent?.();
  });
  await f.host.receive(A, f.message(A, 'history-read', '看看前不久消息', G1, [A])); await f.drain();
  assert.equal(first.evidenceOnly, true); assert.equal(first.messages[0].author.id, 'outside-whitelist');
  assert.equal(first.pageToken, undefined); assert.notEqual(first.nextCursor, 'platform-secret-token');
  assert.equal(second.messages[0].id, 'older'); assert.deepEqual(platformTokens, [undefined, 'platform-secret-token']);
  assert.equal(f.host.store.listEvents().length, 2); assert.equal(f.host.store.getController(A)!.generation, 1);
});

test('history tool rejects changed binding and cross-Bot cursor reuse without platform access', async t => {
  const f = fixture(t); await f.activate(); let cursor: string; let accessed = 0;
  f.conversationHistories.set(A, async (raw, options) => { accessed++; return historyPage(raw, options, [], true, 'next-platform-token'); });
  f.run(async (id, turn) => {
    if (id === A) {
      const page: any = await f.host.invoke(A, turn, 'bridge_read_group_history', {}); cursor = page.nextCursor;
      await assert.rejects(() => f.host.invoke(A, turn, 'bridge_read_group_history', { cursor, startTime: '2026-01-01T00:00:00Z' }), /不能更改/);
      f.host.store.stopGroup(G1, P, 'test changed');
      await assert.rejects(() => f.host.invoke(A, turn, 'bridge_read_group_history', { cursor }));
    }
    await turn.onSilent?.();
  });
  await f.host.receive(A, f.message(A, 'history-binding', '历史', G1, [A])); await f.drain(); assert.equal(accessed, 1);
});


test('private default scene includes confirmed Bot group publications with separate sequence and unknown time evidence', async t => {
  const f = fixture(t); await f.activate();
  f.run(async (id, turn) => { if (id === A && turn.groupContext && turn.source?.original?.authorType !== 'system') await turn.onPublicMessage?.('Teto group progress'); else await turn.onSilent?.(); });
  await f.host.receive(A, f.message(A, 'publish-before-private', 'report progress', G1, [A])); await f.drain();
  let scene: any;
  f.run(async (_id, turn) => { scene = JSON.parse(turn.chatScene!); await turn.onPublicMessage?.('private received'); });
  await f.managers.get(A)!.handle({ id: 'private-after-publication', userId: f.configs[0]!.ownerUserId!, channelId: `${A}|owner-dm`, text: '群里进展', imagePaths: [] });
  await f.drain();
  assert.equal(scene.publicProgress[0].text, 'Teto group progress'); assert.equal(scene.publicProgress[0].authorBotId, A);
  assert.equal(scene.publicProgress[0].canAuthorize, false); assert.equal(scene.publicProgress[0].sequenceNamespace, 'host_public_log');
  assert.equal(scene.publicProgress[0].time, null); assert(scene.records.length + scene.publicProgress.length <= 40);
});


test('owner ordinary input broadcasts and preserves raw mention evidence without identity lookup', async t => {
  const f = fixture(t); await f.activate();
  const source = f.message(A, 'owner-route-failed-evidence', 'discuss this even if @ identity cannot resolve');
  source.space!.mentionedUserIds = ['unverified-outside-app-id'];
  f.mentionViews.set(A, async () => { throw new Error('mention proof unavailable'); });
  await f.host.receive(A, source); await f.drain();
  assert.equal(f.calls.length, 2); assert.equal(f.host.store.listEvents().length, 2); assert.equal(f.mentionReads.length, 0);
  const evidence = f.host.store.readContext(G1, A).recent;
  assert.equal(evidence.at(-1)!.text, source.text); assert.equal(evidence.at(-1)!.source.userId, source.userId);
  assert.equal(evidence.at(-1)!.source.mentionedUserIds[0], 'unverified-outside-app-id');
});


test('controller roster is queried on demand with activity, aliases and snapshot limits, without waking any Bot', async t => {
  const f = fixture(t); await f.activate(); f.configs[1]!.aliases = ['Miku'];
  let roster: any;
  f.run(async (id, turn) => {
    assert.equal(id, A); assert.ok(!turn.chatScene?.includes('controllerState'));
    roster = await f.host.invoke(A, turn, 'bridge_list_controllers', {});
    assert.equal(roster.controllers.find((c: any) => c.botId === A).controllerState, 'processing');
    assert.equal(roster.controllers.find((c: any) => c.botId === B).controllerState, 'idle');
    assert.deepEqual(roster.controllers.find((c: any) => c.botId === B).aliases, ['Miku']);
    assert.equal(roster.controllers.find((c: any) => c.botId === B).activeWorkers, 0);
    assert.equal(roster.controllers[0].gatewayAvailability, 'not probed');
    const page = await f.host.invoke(A, turn, 'bridge_list_controllers', { limit: 1 }) as any;
    assert.equal(page.controllers.length, 1); assert.equal(page.hasMore, true);
    await assert.rejects(f.host.invoke(A, turn, 'bridge_list_controllers', { limit: 51 }));
    await turn.onPublicMessage!('查询完成。');
  });
  await f.managers.get(A)!.handle({ id: 'roster-dm', userId: f.configs[0]!.ownerUserId!, channelId: `${A}|oc_roster_dm`, text: '查主控', imagePaths: [] });
  await f.drain(); assert.equal(f.calls.length, 1); assert.ok(roster.checkedAt); assert.equal(f.host.store.listEvents().length, 0);
});

test('disabled internal Bot communication rejects cached tools before writes while broadcast, silence and owned worker dispatch remain available', async t => {
  const f = fixture(t, { internalBotCommunicationEnabled: false }); await f.activate(); let dispatched = 0;
  const beforeControllers = [A, B].map(id => f.host.store.getController(id));
  f.run(async (id, turn) => {
    assert.equal(JSON.parse(turn.chatScene!).internalBotCommunicationEnabled, false);
    if (id === A) {
      const targets = await f.host.invoke(A, turn, 'bridge_delivery_targets', {}) as any;
      const before = { events: f.host.store.listEvents().map(event => event.id), outbox: f.host.store.listOutbox(),
        requests: f.host.store.listCollaborationRequests(), handoffs: f.host.store.listHandoffs(), tasks: f.host.store.listTasks(G1) };
      for (const [name, args] of [
        ['bridge_send_bot', { targetBotId: B, text: 'must stay unsent' }],
        ['bridge_start_collaboration', { targetId: targets.defaultTargetId, targetBotId: B, mode: 'internal', text: 'must not create a root' }],
        ['bridge_propose_handoff', { taskId: 'missing-task', targetBotId: B, summary: 'must not create a proposal' }],
        ['bridge_accept_handoff', { handoffId: 'missing-handoff' }],
      ] as const) await assert.rejects(f.host.invoke(A, turn, name, args), /后台.*关闭|内部.*关闭|internal.*disabled/i);
      assert.deepEqual({ events: f.host.store.listEvents().map(event => event.id), outbox: f.host.store.listOutbox(),
        requests: f.host.store.listCollaborationRequests(), handoffs: f.host.store.listHandoffs(), tasks: f.host.store.listTasks(G1) }, before);
      await f.host.invoke(A, turn, 'bridge_claim_work', { taskId: 'ordinary-work', title: 'work without a private Bot channel' });
      await f.host.invoke(A, turn, 'bridge_start_worker', { workId: 'ordinary-work', title: 'worker', prompt: 'authorized task' }, 'worker', async () => {
        dispatched++; return { workerId: 'ordinary-worker' };
      });
    }
    await turn.onSilent!();
  });
  await f.host.receive(A, f.message(A, 'internal-disabled-owner', 'Both Bots receive this even with @A', G1, [A])); await f.drain();
  assert.deepEqual(f.calls.map(call => call.botId).sort(), [A, B]);
  assert.equal(dispatched, 1); assert.equal(f.host.store.getTask('ordinary-work')?.ownerBotId, A);
  assert.deepEqual(f.host.store.taskWorkers('ordinary-work'), [{ botId: A, workerId: 'ordinary-worker' }]);
  assert.equal(f.host.store.listEvents().every(event => event.state === 'silent'), true);
  assert.deepEqual([A, B].map(id => f.host.store.getController(id)), beforeControllers);
});

test('disabled internal Bot communication retains public collaboration and its same-group completion receipt', async t => {
  const f = fixture(t, { internalBotCommunicationEnabled: false }); await f.activate(); let receipt: any;
  f.run(async (id, turn) => {
    if (id === A && !turn.event) {
      const targets = await f.host.invoke(A, turn, 'bridge_delivery_targets', {}) as any;
      receipt = await f.host.invoke(A, turn, 'bridge_start_collaboration', { targetBotId: B,
        targetId: targets.defaultTargetId, mode: 'public', text: 'Discuss this openly' }, 'public-with-internal-disabled');
      assert.equal(receipt.completion.publicDeliveryComplete, true); await turn.onPublicDeliveryComplete!();
    } else await turn.onSilent!();
  });
  await f.host.receive(A, f.message(A, 'public-while-internal-disabled', 'Please discuss this in the group')); await f.drain();
  assert.equal(f.host.store.getCollaborationRequest(receipt.requestId)?.mode, 'public');
  assert.equal(f.calls.filter(call => call.botId === B && call.turn.text === 'Discuss this openly').length, 1);
  assert.equal(f.replies.filter(reply => reply.text.includes('Discuss this openly')).length, 1);
});

test('disabled internal Bot communication cancels old direct and handoff queues but preserves public consultation, worker result and wake', async t => {
  const f = fixture(t, { internalBotCommunicationEnabled: false }); await f.activate();
  await f.host.receive(A, f.message(A, 'old-channel-root', 'previously authorized group work')); await f.drain();
  const origin = f.calls.find(call => call.botId === A)!.turn.groupContext!;
  const root = f.host.store.getRoot(origin.rootId)!;
  const internal = f.host.store.enqueueEvent({ id: 'old-direct-consultation', rootId: root.id, botId: B, generation: 1,
    kind: 'consultation', sourceBotId: A, causeEventId: origin.eventId, payload: { text: 'do not deliver private question', audience: 'internal named Bot only' } });
  assert.equal(f.host.store.claimNextEvent(B)?.id, internal.id); // A prior bridge may already have reserved this input.
  f.host.store.enqueueEvent({ id: 'old-handoff', rootId: root.id, botId: B, generation: 1,
    kind: 'handoff', sourceBotId: A, causeEventId: origin.eventId, payload: { text: 'do not deliver private handoff' } });
  f.host.store.acceptRoot({ id: 'old-internal-root', spaceId: G1, principalId: P, sourceEventId: 'old-private-owner-input', targetBotIds: [B],
    replyTo: { ...root.replyTo, collaborationMode: 'internal', initiatorBotId: A } });
  f.host.store.enqueueEvent({ id: 'old-internal-root-question', rootId: 'old-internal-root', botId: B, generation: 1,
    kind: 'consultation', sourceBotId: A, payload: { text: 'do not deliver internal root question' } });
  f.host.store.acceptRoot({ id: 'old-public-root', spaceId: G1, principalId: P, sourceEventId: 'old-public-owner-input', targetBotIds: [B],
    replyTo: { ...root.replyTo, collaborationMode: 'public', initiatorBotId: A } });
  f.host.store.enqueueEvent({ id: 'old-public-consultation', rootId: 'old-public-root', botId: B, generation: 1,
    kind: 'consultation', sourceBotId: A, payload: { text: 'keep public discussion', audience: 'public' } });
  f.host.store.enqueueEvent({ id: 'old-worker-result', rootId: root.id, botId: B, generation: 1,
    kind: 'assistant-result', causeEventId: internal.id, payload: { text: 'keep existing worker result', eventKind: 'worker-result' } });
  f.host.store.enqueueEvent({ id: 'old-wake', rootId: root.id, botId: B, generation: 1,
    kind: 'wake', payload: { text: 'keep existing wake', eventKind: 'wake' } });
  const before = f.calls.length;
  await f.host.pump(); await f.drain();
  for (const id of ['old-direct-consultation', 'old-handoff', 'old-internal-root-question']) assert.equal(f.host.store.getEvent(id)?.state, 'cancelled', id);
  assert.deepEqual(f.calls.slice(before).map(call => call.turn.text), ['keep public discussion', 'keep existing worker result', 'keep existing wake']);
  for (const id of ['old-public-consultation', 'old-worker-result', 'old-wake']) assert.equal(f.host.store.getEvent(id)?.state, 'silent', id);
});

test('disabling internal Bot communication cancels a pending handoff without cancelling its task or leaving the original owner unable to dispatch', async t => {
  const f = fixture(t, { internalBotCommunicationEnabled: false }); await f.activate();
  await f.host.receive(A, f.message(A, 'pending-handoff-root', 'authorized continuing work')); await f.drain();
  const rootId = f.calls.find(call => call.botId === A)!.turn.groupContext!.rootId;
  const task = f.host.store.claimTask({ id: 'handoff-retained-task', rootId, botId: A, generation: 1,
    title: 'continue after disabling private handoff', resources: ['browser:retained-profile'] }).task;
  f.host.store.confirmTaskExecutionStopped(task.id, A, 'previous execution confirmed stopped');
  f.host.store.proposeHandoff({ id: 'pending-before-switch-off', taskId: task.id, fromBotId: A, toBotId: B, summary: 'unaccepted old proposal' });
  assert.throws(() => f.host.store.markTaskExecutionActive(task.id, A), /pending handoff/);
  assert.throws(() => f.host.store.registerTaskWorker(task.id, A, 'replacement-worker'), /pending handoff/);
  await f.host.pump(); await f.drain();
  assert.equal(f.host.store.getHandoff('pending-before-switch-off')?.state, 'cancelled');
  const retained = f.host.store.getTask(task.id)!;
  assert.equal(retained.state, 'active'); assert.equal(retained.ownerBotId, A);
  assert.deepEqual(retained.resources, task.resources); assert.deepEqual(retained.replyTo, task.replyTo);
  assert.throws(() => f.host.store.claimTask({ id: 'other-task-cannot-take-resource', rootId, botId: B, generation: 1,
    title: 'resource remains owned', resources: ['browser:retained-profile'] }), /Resource .* is owned/);
  assert.doesNotThrow(() => f.host.store.markTaskExecutionActive(task.id, A));
  assert.doesNotThrow(() => f.host.store.registerTaskWorker(task.id, A, 'replacement-worker'));
  assert.deepEqual(f.host.store.taskWorkers(task.id), [{ botId: A, workerId: 'replacement-worker' }]);
  assert.equal(f.host.store.getTask(task.id)?.executionStoppedProof, null);
});

test('disabled internal Bot communication handles failed internal worker results and wakes without a public error or a new private consultation', async t => {
  const f = fixture(t, { internalBotCommunicationEnabled: false }); await f.activate();
  await f.host.receive(A, f.message(A, 'internal-error-root', 'previous authorization')); await f.drain();
  const origin = f.calls.find(call => call.botId === A)!.turn.groupContext!, root = f.host.store.getRoot(origin.rootId)!;
  f.host.store.acceptRoot({ id: 'failed-internal-root', spaceId: G1, principalId: P, sourceEventId: 'old-private-source', targetBotIds: [B],
    replyTo: { ...root.replyTo, collaborationMode: 'internal', initiatorBotId: A } });
  f.host.store.enqueueEvent({ id: 'internal-error-parent', rootId: root.id, botId: B, generation: 1,
    kind: 'consultation', sourceBotId: A, causeEventId: origin.eventId, payload: { text: 'old private consultation', audience: 'internal' } });
  f.host.store.enqueueEvent({ id: 'failed-internal-worker-result', rootId: 'failed-internal-root', botId: B, generation: 1,
    kind: 'assistant-result', payload: { text: 'internal worker result', eventKind: 'worker-result' } });
  f.host.store.enqueueEvent({ id: 'failed-internal-descendant-wake', rootId: root.id, botId: B, generation: 1,
    kind: 'wake', causeEventId: 'internal-error-parent', payload: { text: 'internal descendant wake', eventKind: 'wake' } });
  const handled: boolean[] = [], beforeReplies = f.replies.length, beforeCalls = f.calls.length;
  const consultations = f.host.store.listEvents().filter(event => event.kind === 'consultation').map(event => event.id);
  const errorHook = (f.hooks.get(B)!.manager as SessionManagerOptions).onGroupTurnError!;
  f.run(async (id, turn) => {
    assert.equal(id, B); handled.push(await errorHook(turn.groupContext!));
    throw new Error('PRIVATE_INTERNAL_FAILURE_MARKER: ' + turn.text);
  });
  await f.host.pump(); await f.drain();
  assert.deepEqual(handled, [true, true]);
  assert.deepEqual(f.calls.slice(beforeCalls).map(call => call.turn.text), ['internal worker result', 'internal descendant wake']);
  for (const id of ['failed-internal-worker-result', 'failed-internal-descendant-wake']) assert.equal(f.host.store.getEvent(id)?.state, 'failed', id);
  assert.equal(f.replies.slice(beforeReplies).some(reply => reply.text.includes('PRIVATE_INTERNAL_FAILURE_MARKER')), false);
  assert.deepEqual(f.host.store.listEvents().filter(event => event.kind === 'consultation').map(event => event.id), consultations);
});

test('private internal collaboration wakes the current target and returns internally, with no group leak or duplicate wake', async t => {
  const f = fixture(t); await f.activate(); const before = f.host.store.getController(B), dm = `${A}|oc_internal_dm`;
  const initialReplies = f.replies.length; let accepted: any;
  f.run(async (id, turn) => {
    if (id === A && !turn.groupContext) {
      const regions = await f.host.invoke(A, turn, 'bridge_delivery_targets', {}) as any;
      const args = { targetId: regions.targets.find((r: any) => r.spaceId === G1).targetId, targetBotId: B, mode: 'internal', text: '仅内部核对这个任务' };
      accepted = await f.host.invoke(A, turn, 'bridge_start_collaboration', args, 'internal-once');
      const duplicate = await f.host.invoke(A, turn, 'bridge_start_collaboration', args, 'internal-once') as any;
      assert.equal(duplicate.eventId, accepted.eventId); assert.equal(accepted.acceptedWork, false);
      await turn.onPublicMessage!('已登记内部核对。');
    } else if (id === B) {
      const scene = JSON.parse(turn.groupContext!.scene); assert.equal(scene.collaboration.mode, 'internal');
      assert.equal(turn.source?.original?.authorType, 'system');
      await assert.rejects(turn.onPublicMessage!('不得泄漏到群的内容'), /静默协作/);
      const regions = await f.host.invoke(B, turn, 'bridge_delivery_targets', {}) as any;
      await assert.rejects(turn.onPublicMessage!('不得通过显式群目标泄漏', [], 'leak', `group:${G1}:${f.host.store.getGroup(G1)!.epoch}:${f.host.store.getGroup(G1)!.revision}`), /静默协作/);
      await assert.rejects(f.host.invoke(B, turn, 'bridge_start_collaboration', { targetBotId: A, mode: 'public', text: '不能伪造新授权' }), /真实负责人/);
      await f.host.invoke(B, turn, 'bridge_send_bot', { targetBotId: A, text: '核对结果：可以继续' }, 'internal-answer');
      await turn.onSilent!();
    } else { await turn.onPublicMessage!('核对结果已汇总。'); }
  });
  await f.managers.get(A)!.handle({ id: 'start-internal', userId: f.configs[0]!.ownerUserId!, channelId: dm, text: '让另一个主控后台核对', imagePaths: [] });
  await f.drain();
  assert.deepEqual(f.host.store.getController(B), before);
  assert.equal(f.calls.filter(c => c.botId === B).length, 1);
  assert.equal(f.replies.slice(initialReplies).every(r => r.channel === dm), true, JSON.stringify(f.replies.slice(initialReplies)));
  assert.equal(f.host.store.readPublic(G1, A).length, 0);
  assert.equal(f.host.store.listCollaborationRequests().length, 1);
  assert.equal(f.host.store.getRoot(f.host.store.listEvents()[0]!.rootId)!.replyTo.sourceMessageId, 'start-internal');
});

test('private public collaboration announces before target execution and retains current controllers', async t => {
  const f = fixture(t); await f.activate(); const before = f.host.store.getController(B); let queued: any;
  f.run(async (id, turn) => {
    if (id === A && !turn.groupContext) {
      const targets = await f.host.invoke(A, turn, 'bridge_delivery_targets', {}) as any;
      queued = await f.host.invoke(A, turn, 'bridge_start_collaboration', { targetId: targets.targets.find((r: any) => r.spaceId === G1).targetId,
        targetBotId: B, mode: 'public', text: '请在这个群核对，私聊其他内容不公开' }, 'public-once');
      await turn.onPublicMessage!('已发出讨论并排队。');
    } else if (id === B) {
      const announcement = f.replies.find(r => r.botId === A && r.text.endsWith('\n\n请在这个群核对，私聊其他内容不公开'));
      assert.ok(announcement); assert.match(announcement.options!.repeatHeader!, /^\[Codex ·/);
      assert.equal(f.host.store.listRoutedDeliveries().find(delivery => delivery.target.kind === 'group')!.payload.text, '请在这个群核对，私聊其他内容不公开');
      assert.equal(JSON.parse(turn.groupContext!.scene).collaboration.mode, 'public');
      await turn.onPublicMessage!('群内核对答复。');
    } else await turn.onSilent?.();
  });
  await f.managers.get(A)!.handle({ id: 'start-public', userId: f.configs[0]!.ownerUserId!, channelId: `${A}|oc_public_dm`, text: '去群里讨论', imagePaths: [] });
  await f.drain(); assert.equal(queued.queued, true);
  assert.equal(f.replies.find(r => r.text.includes('群内核对答复'))!.channel, `${B}|oc_b_group_1`);
  assert.equal(f.calls.filter(c => c.botId === B).length, 1); assert.deepEqual(f.host.store.getController(B), before);
  assert.equal(f.host.store.listEvents().every(event => event.kind !== 'human'), true);
});

test('uncertain public announcement never wakes target or retries its platform send', async t => {
  const f = fixture(t); await f.activate(); let sends = 0;
  const manager = f.managers.get(A)!;
  const originalPublish = (manager as any).sink.sendText;
  (manager as any).sink.sendText = async (channel: string, ...rest: unknown[]) => {
    if (channel === `${A}|oc_a_group_1`) { sends++; throw new Error('platform acknowledgement unavailable'); }
    return originalPublish(channel, ...rest);
  };
  f.run(async (id, turn) => {
    assert.equal(id, A);
    const regions = await f.host.invoke(A, turn, 'bridge_delivery_targets', {}) as any;
    const args = { targetId: regions.targets.find((r: any) => r.spaceId === G1).targetId, targetBotId: B, mode: 'public', text: '可能发送但未确认' };
    await assert.rejects(f.host.invoke(A, turn, 'bridge_start_collaboration', args, 'uncertain'), /acknowledgement/);
    await assert.rejects(f.host.invoke(A, turn, 'bridge_start_collaboration', args, 'uncertain'), /未知/);
    await turn.onPublicMessage!('发起未确认，不能保证对方被唤醒。');
  });
  await f.managers.get(A)!.handle({ id: 'uncertain-start', userId: f.configs[0]!.ownerUserId!, channelId: `${A}|oc_failed_dm`, text: '发起讨论', imagePaths: [] });
  await f.drain(); assert.equal(sends, 1); assert.equal(f.host.store.listEvents().length, 0);
  assert.equal(f.host.store.listCollaborationRequests()[0]!.state, 'registered');
});

test('busy target collaboration is queued without interrupting or resetting its controller', async t => {
  const f = fixture(t); await f.activate(); const wait = f.gate(); let registered = false;
  f.run(async (id, turn) => {
    if (id === B && turn.text === '已有任务') { await wait.promise; await turn.onSilent!(); }
    else if (id === A && !turn.groupContext) {
      const roster = await f.host.invoke(A, turn, 'bridge_list_controllers', { botId: B }) as any;
      assert.equal(roster.controllers[0].controllerState, 'processing');
      const regions = await f.host.invoke(A, turn, 'bridge_delivery_targets', {}) as any;
      await f.host.invoke(A, turn, 'bridge_start_collaboration', { targetId: regions.targets.find((r: any) => r.spaceId === G1).targetId,
        targetBotId: B, mode: 'internal', text: '排队的新咨询' }); registered = true;
      await turn.onPublicMessage!('对方忙，咨询已排队。');
    } else await turn.onSilent?.();
  });
  await f.host.receive(A, f.message(A, 'busy-existing', '已有任务', G1, [B]));
  await eventual(() => f.calls.some(c => c.botId === B), 'target starts existing task');
  const before = f.host.store.getController(B);
  await f.managers.get(A)!.handle({ id: 'busy-private', userId: f.configs[0]!.ownerUserId!, channelId: `${A}|oc_busy_dm`, text: '内部咨询', imagePaths: [] });
  await eventual(() => registered, 'consultation registered');
  assert.equal(f.calls.filter(c => c.botId === B).length, 1);
  wait.release(); await f.drain(); assert.equal(f.calls.filter(c => c.botId === B).length, 2);
  assert.deepEqual(f.host.store.getController(B), before);
});

test('controller unavailable and stale group destinations reject before announcement or wake', async t => {
  const f = fixture(t); await f.activate();
  f.run(async (_id, turn) => {
    const regions = await f.host.invoke(A, turn, 'bridge_delivery_targets', {}) as any;
    const targetId = regions.targets.find((r: any) => r.spaceId === G1).targetId;
    f.host.store.setControllerReady(B, 1, false);
    await assert.rejects(f.host.invoke(A, turn, 'bridge_start_collaboration', { targetId, targetBotId: B, mode: 'public', text: '不应发送' }), /未就绪/);
    f.host.store.setControllerReady(B, 1, true); f.host.store.stopGroup(G1, P);
    await assert.rejects(f.host.invoke(A, turn, 'bridge_start_collaboration', { targetId, targetBotId: B, mode: 'public', text: '不应发送' }), /未激活/);
    await turn.onPublicMessage!('协作尚未发起。');
  });
  await f.managers.get(A)!.handle({ id: 'reject-start', userId: f.configs[0]!.ownerUserId!, channelId: `${A}|oc_reject_dm`, text: '讨论', imagePaths: [] });
  await f.drain(); assert.equal(f.host.store.listCollaborationRequests().length, 0); assert.equal(f.host.store.listEvents().length, 0);
});


test('internal target failure returns an honest failure to initiator without a public error message', async t => {
  const f = fixture(t); await f.activate(); const start = f.replies.length, dm = `${A}|oc_failure_private`;
  f.run(async (id, turn) => {
    if (id === B) throw new Error('private execution detail must not appear publicly');
    if (!turn.groupContext) {
      const targets = await f.host.invoke(A, turn, 'bridge_delivery_targets', {}) as any;
      await f.host.invoke(A, turn, 'bridge_start_collaboration', { targetId: targets.targets.find((x: any) => x.spaceId === G1).targetId,
        targetBotId: B, mode: 'internal', text: '后台验证' });
      await turn.onPublicMessage!('已排队。');
    } else {
      assert.match(turn.text, /失败/); await turn.onPublicMessage!('协作没有完成。');
    }
  });
  await f.managers.get(A)!.handle({ id: 'private-failure', userId: f.configs[0]!.ownerUserId!, channelId: dm, text: '内部核对', imagePaths: [] });
  await f.drain(); assert.equal(f.replies.slice(start).every(reply => reply.channel === dm), true);
  assert.equal(f.replies.some(reply => reply.text.includes('协作没有完成')), true);
  assert.equal(f.host.store.readPublic(G1, A).length, 0);
});

test('internal failure cannot send back to an origin group stopped during cross-group collaboration', async t => {
  const f = fixture(t); await f.activate(); await f.activate(G2); const start = f.replies.length;
  f.run(async (id, turn) => {
    if (id === A && turn.text === '从群一发起群二后台核对') {
      const targets = await f.host.invoke(A, turn, 'bridge_delivery_targets', {}) as any;
      await f.host.invoke(A, turn, 'bridge_start_collaboration', { targetId: targets.targets.find((x: any) => x.spaceId === G2).targetId,
        targetBotId: B, mode: 'internal', text: '跨群后台核对' });
      await turn.onSilent!(); f.host.store.stopGroup(G1, P);
    } else if (id === B && turn.groupContext?.eventKind === undefined) await turn.onSilent!();
    else if (id === B) throw new Error('target error');
    else throw new Error('initiator summary also failed');
  });
  await f.host.receive(A, f.message(A, 'cross-group-internal', '从群一发起群二后台核对', G1, [A]));
  await f.drain(); assert.equal(f.replies.slice(start).length, 0, JSON.stringify(f.replies.slice(start)));
});

test('internal mutual consultation stops at eight automatic turns and only notifies the original owner', async t => {
  const f = fixture(t); await f.activate(); const start = f.replies.length, dm = `${A}|oc_budget_private`;
  f.run(async (id, turn) => {
    if (!turn.groupContext) {
      const targets = await f.host.invoke(A, turn, 'bridge_delivery_targets', {}) as any;
      await f.host.invoke(A, turn, 'bridge_start_collaboration', { targetId: targets.targets.find((x: any) => x.spaceId === G1).targetId,
        targetBotId: B, mode: 'internal', text: '有界内部讨论' }); await turn.onPublicMessage!('已登记。');
    } else {
      await f.host.invoke(id, turn, 'bridge_send_bot', { targetBotId: id === A ? B : A, text: '继续内部交流' });
      await turn.onSilent!();
    }
  });
  await f.managers.get(A)!.handle({ id: 'private-budget', userId: f.configs[0]!.ownerUserId!, channelId: dm, text: '后台讨论', imagePaths: [] });
  await f.drain(); assert.equal(f.calls.length, 9);
  assert.equal(f.replies.slice(start).every(reply => reply.channel === dm), true);
  assert.equal(f.replies.filter(reply => reply.text.includes('内部协作已达到')).length, 1);
  assert.equal(f.host.store.readPublic(G1, A).length, 0);
});


test('internal task titles stay out of later public scenes and group worker listings', async t => {
  const f = fixture(t); await f.activate(); let publicScene: any;
  f.run(async (id, turn) => {
    if (!turn.groupContext) {
      const targets = await f.host.invoke(A, turn, 'bridge_delivery_targets', {}) as any;
      await f.host.invoke(A, turn, 'bridge_start_collaboration', { targetId: targets.targets.find((x: any) => x.spaceId === G1).targetId,
        targetBotId: B, mode: 'internal', text: '后台私密任务' }); await turn.onPublicMessage!('已登记。');
    } else if (id === B && JSON.parse(turn.groupContext.scene).collaboration?.mode === 'internal') {
      await f.host.invoke(B, turn, 'bridge_claim_work', { taskId: 'internal-private-task', title: '不应出现在群里的任务标题' });
      assert.equal((await f.host.invoke(B, turn, 'bridge_group_context', {}) as any).tasks.length, 1);
      await turn.onSilent!();
    } else { publicScene = JSON.parse(turn.groupContext.scene); await turn.onSilent!(); }
  });
  await f.managers.get(A)!.handle({ id: 'private-task-source', userId: f.configs[0]!.ownerUserId!, channelId: `${A}|oc_task_private`, text: '内部安排', imagePaths: [] }); await f.drain();
  assert.equal(f.host.store.listTasks(G1).length, 1);
  await f.host.receive(A, f.message(A, 'later-public-scene', '正常群消息', G1, [A])); await f.drain();
  assert.equal(publicScene.tasks.length, 0);
  const internalTurn = f.calls.find(call => call.botId === B && call.turn.groupContext && JSON.parse(call.turn.groupContext.scene).collaboration?.mode === 'internal')!.turn;
  f.workerLists.set(B, [overviewWorker('private-worker', '静默协作助手不可公开')]);
  (f.host.bots.get(B)!.controller!.store as unknown as { workers: () => unknown[] }).workers = () => [{ id: 'private-worker', origin: { groupContext: internalTurn.groupContext } }];
  await f.host.receive(A, f.message(A, 'public-worker-status', '/workers', G1, [A])); await f.drain();
  assert.equal(f.replies.some(reply => reply.channel === `${A}|oc_a_group_1` && reply.text.includes('不应出现在群里的任务标题')), false);
  const start = f.replies.length;
  await f.host.receive(A, f.message(A, 'public-worker-status-all', '/workers all details')); await f.drain();
  assert.equal(f.replies.slice(start).some(reply => /静默协作助手不可公开|private-worker|private controller title/.test(reply.text)), false);
});
