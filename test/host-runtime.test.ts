import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, dirname, resolve, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { setImmediate as nextImmediate } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import { HostRuntime } from '../src/host-runtime.js';
import { SessionManager, type SessionManagerOptions } from '../src/manager.js';
import { SessionStore } from '../src/store.js';
import type { BotRuntime } from '../src/bot-runtime.js';
import type { HostSemanticMarker } from '../src/host-migration.js';
import type { HostConfig } from '../src/config.js';
import type { AgentAdapter, AgentTurn, BridgeConfig, IncomingDM, ReplyOptions } from '../src/types.js';
import type { DMHistoryOptions, DMHistoryPage } from '../src/ingress.js';
import { historyPage, type ConversationHistoryOptions, type ConversationHistoryPage } from '../src/group-history.js';
import { groupMessagePayloadHash, type GroupMentionView } from '../src/group-mentions.js';

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
function fixture(t: TestContext, options: { initialized?: string[]; run?: TurnHandler; platform?: 'feishu' | 'discord' } = {}) {
  const path = mkdtempSync(join(tmpdir(), 'bridge-host-runtime-test-'));
  const platform = options.platform ?? 'feishu', ids = platform === 'feishu' ? [A, B] : [D1, D2], primary = ids[0]!;
  const ownerId = (index: number) => platform === 'feishu' ? `owner-${index}` : '333333333333333333';
  const otherId = (index: number) => platform === 'feishu' ? `other-${index}` : '444444444444444444';
  const configs = ids.map((botId, index): BridgeConfig => ({
    botId, platform, applicationId: botId.slice(platform.length + 1), scopePrefix: `${botId}|`,
    ownerPrincipalId: P, ownerUserId: `${botId}|${ownerId(index)}`, profile: `test-${index}`,
    token: '', allowedUserIds: [`${botId}|${ownerId(index)}`, `${botId}|${otherId(index)}`], defaultAgent: 'codex',
    workspace: join(path, `workspace-${index}`), dataDir: join(path, `data-${index}`),
    attachmentsDir: join(path, `images-${index}`), logsDir: join(path, `logs-${index}`), proxyUrl: null,
    maxImageBytes: 1024, maxFileBytes: 4096, controllerMode: true, groupMode: true,
    commands: { codex: { command: 'fake', args: [] }, claude: { command: 'fake', args: [] } },
  }));
  const config: HostConfig = { version: 3, rootDataDir: join(path, 'host'), configs,
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
  const hooks = new Map(configs.map(c => [c.botId!, host.hooks(c)]));
  const workerStopped = new Map<string, boolean>();
  const groupChecks = new Map<string, () => Promise<boolean>>();
  const downloads = new Map<string, () => Promise<string[]>>();
  const conversationHistories = new Map<string, (raw: string, options: ConversationHistoryOptions) => Promise<ConversationHistoryPage>>();
  const histories = new Map<string, (raw: string, options: DMHistoryOptions) => Promise<DMHistoryPage>>();
  const stoppedProofs = new Map<string, boolean>();
  const mentionViews = new Map<string, (raw: string, id: string) => Promise<GroupMentionView>>();
  const humanMentions = new Set<string>(), mentionReads: string[] = [];
  const originals = new Map<string, IncomingDM>();
  const ownedGates: ReturnType<typeof gate>[] = [];
  let handler: TurnHandler = options.run ?? (async (_botId, turn) => { await turn.onSilent?.(); });
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
    }, { ...hook.manager, authorizeUser: user => hook.authorize(user, ''), mergeDelayMs: 0 } as SessionManagerOptions);
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
      async sendInteractionText(_interaction: unknown, text: string) { replies.push({ botId, channel: 'interaction', text }); },
      async syncGroupSlashCommands() {}, async readGroupHistory(raw: string, historyOptions: DMHistoryOptions) {
        return histories.get(botId)?.(raw, historyOptions) ?? { messages: [], hasMore: false, oldestId: null, newestId: null };
      },
      async readConversationHistory(raw: string, options: ConversationHistoryOptions) { return conversationHistories.get(botId)?.(raw, options) ?? historyPage(raw, options, [], false); },
      async downloadImages(_original: IncomingDM) { return downloads.get(botId)?.() ?? []; },
      isIdle() { return true; },
    };
    const bot = { config: c, manager, transport,
      controller: { isWorkerStopped: (workerId: string) => workerStopped.get(`${botId}/${workerId}`) === true,
        store: { workers: () => [] } },
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
  return { path, host, config, configs, managers, sessions, hooks, replies, calls, reports, workerStopped, groupChecks, downloads, histories, conversationHistories, stoppedProofs, ids,
    message, activate, drain, close, mentionViews, humanMentions, mentionReads, originals, run: (next: TurnHandler) => { handler = next; },
    gate: () => { const wait = gate(); ownedGates.push(wait); return wait; } };
}

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

test('Feishu receiver resolves repeated scoped @B tokens through original app views and submits only B initially', async t => {
  const f = fixture(t); await f.activate();
  const source = f.message(A, 'cross-app-mention', 'only B initially', G1, [B]); crossAppMention(f, source, true);
  await f.host.receive(B, f.message(B, 'cross-app-mention', 'only B initially', G1, [B]));
  await f.host.receive(A, source); await f.host.receive(A, source); await f.drain();
  assert.deepEqual(f.calls.map(c => c.botId), [B]);
  assert.deepEqual(f.host.store.getRoot(f.host.store.listEvents()[0]!.rootId)!.targetBotIds, [B]);
  assert.deepEqual(f.mentionReads.sort(), [A, B].sort());
});

test('unmentioned, receiver-own and positively verified human mentions retain ordinary semantics without app-view reads', async t => {
  const f = fixture(t); await f.activate();
  await f.host.receive(A, f.message(A, 'no-mention-fast', 'ordinary all')); await f.drain();
  await f.host.receive(A, f.message(A, 'own-mention-fast', 'only self', G1, [A])); await f.drain();
  const human = f.message(A, 'human-mention-fast', 'ordinary human reference'); human.space!.mentionedUserIds = ['ou_real_human'];
  f.humanMentions.add('ou_real_human'); await f.host.receive(A, human); await f.drain();
  assert.deepEqual(f.calls.filter(c => c.turn.text === 'ordinary all').map(c => c.botId).sort(), [A, B]);
  assert.deepEqual(f.calls.filter(c => c.turn.text === 'only self').map(c => c.botId), [A]);
  assert.deepEqual(f.calls.filter(c => c.turn.text === 'ordinary human reference').map(c => c.botId).sort(), [A, B]);
  assert.equal(f.mentionReads.length, 0);
});

for (const mismatch of ['message', 'time', 'space', 'author', 'payload', 'token', 'unavailable', 'scoped-id-collision']) test(`Feishu unknown mention fails closed for ${mismatch}, never expands fanout by display name`, async t => {
  const f = fixture(t); await f.activate();
  const source = f.message(A, 'bad-' + mismatch, 'Miku must not imply identity'); crossAppMention(f, source);
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
  assert(f.reports.some(r => /GROUP_INPUT_FAILED/.test(r)));
});

test('a slow scoped mention is durably captured before the later fast message and preserves each Bot input order', async t => {
  const f = fixture(t); await f.activate(); const wait = f.gate();
  const source = f.message(A, 'slow-mention', 'first scoped B'); crossAppMention(f, source);
  f.mentionViews.set(B, async () => { await wait.promise; return scopedView(f, B, source, [{ key: '@_user_1', id: `platform-${B}` }]); });
  const first = f.host.receive(A, source);
  await eventual(() => f.mentionReads.includes(B), 'slow first mention proof entered');
  const second = f.host.receive(A, f.message(A, 'later-fast-input', 'second ordinary'));
  await eventual(() => f.host.inbox.pending().some(input => input.message.text === 'second ordinary'), 'later input durably received while the first is processing its proof');
  assert.equal(f.host.inbox.pending().length, 1, 'pending() excludes the first input already in processing state');
  assert.equal(f.calls.length, 0); wait.release(); await Promise.all([first, second]); await f.drain();
  assert.deepEqual(f.calls.filter(c => c.botId === B).map(c => c.turn.text), ['first scoped B', 'second ordinary']);
  assert.deepEqual(f.calls.filter(c => c.botId === A).map(c => c.turn.text), ['second ordinary']);
});

for (const change of ['new-generation', 'stop-start']) test(`a pending scoped proof cannot move an old human input across ${change}`, async t => {
  const f = fixture(t); await f.activate(); const wait = f.gate();
  const source = f.message(A, 'proof-race-' + change, 'do not cross reset'); crossAppMention(f, source);
  f.mentionViews.set(B, async () => { await wait.promise; return scopedView(f, B, source, [{ key: '@_user_1', id: `platform-${B}` }]); });
  const receiving = f.host.receive(A, source); await eventual(() => f.mentionReads.includes(B), 'proof is awaiting API');
  if (change === 'stop-start') {
    f.host.store.stopGroup(G1, P); f.host.store.startGroup({ spaceId: G1, principalId: P, receiverBotId: A, memberBotIds: [A, B] });
  } else {
    const c = f.configs[1]!, next = f.sessions.get(B)!.createConversation(c.ownerUserId!, 'codex', c.workspace, { controllerMode: true });
    f.host.store.setController(B, P, { conversationId: next.id, generation: 2, agent: 'codex', nativeId: null }, 1);
  }
  wait.release(); await receiving; await f.drain();
  assert.equal(f.calls.length, 0); assert.equal(f.host.store.listEvents().length, 0);
});

test('pending durable group input re-proves scoped mentions on recovery instead of trusting old own-ID strings', async t => {
  const f = fixture(t); await f.activate(); const source = f.message(A, 'recover-scoped', 'recover only B'); crossAppMention(f, source);
  f.host.inbox.capture('durable-scoped-recovery', A, source, false, { [A]: 1, [B]: 1 }, f.host.store.getGroup(G1)!.epoch);
  assert.equal(f.mentionReads.length, 0); await f.host.recover(); await f.drain();
  assert.deepEqual(f.calls.map(c => c.botId), [B]); assert.deepEqual(f.mentionReads.sort(), [A, B].sort());
});

test('a new generation during the not-ready control hint cannot admit an old partially ready multi-mention', async t => {
  const f = fixture(t, { initialized: [A] }); await f.activate(); const wait = f.gate(); let entered = false;
  const transport = f.host.bots.get(A)!.transport, send = transport.sendText.bind(transport);
  transport.sendText = async (channel, text, options) => { if (/未初始化|未就绪/.test(text)) { entered = true; await wait.promise; } await send(channel, text, options); };
  const receiving = f.host.receive(A, f.message(A, 'not-ready-race', 'do not cross hint reset', G1, [A, B]));
  await eventual(() => entered, 'not-ready hint in flight');
  const c = f.configs[0]!, next = f.sessions.get(A)!.createConversation(c.ownerUserId!, 'codex', c.workspace, { controllerMode: true });
  f.host.store.setController(A, P, { conversationId: next.id, generation: 2, agent: 'codex', nativeId: null }, 1);
  wait.release(); await receiving; await f.drain(); assert.equal(f.calls.length, 0); assert.equal(f.host.store.listEvents().length, 0);
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

test('Discord global mention IDs keep direct routing and never call the Feishu correlation API', async t => {
  const f = fixture(t, { platform: 'discord' }); await f.activate();
  await f.host.receive(D1, f.message(D1, 'discord-explicit-target', 'only D2', G1, [D2])); await f.drain();
  assert.deepEqual(f.calls.map(c => c.botId), [D2]); assert.equal(f.mentionReads.length, 0);
});



test('private input queries authorized delivery regions and explicitly publishes to an owned active group without moving its source', { timeout: 10000 }, async t => {
  const f = fixture(t); await f.activate(); await f.activate(G2); f.configs[0]!.aliases = ['T', '主Bot'];
  const original = f.host.store.getController(A), owner = f.configs[0]!.ownerUserId!, dm = `${A}|oc_verified_owner_private`;
  let inspected: any;
  f.run(async (botId, turn) => {
    assert.equal(botId, A); inspected = await f.host.invoke(A, turn, 'bridge_delivery_targets', {});
    const target = inspected.targets.find((target: any) => target.spaceId === G1); assert.ok(target);
    await turn.onPublicMessage!('private source to selected group', [], 'dm-to-group', target.targetId);
  });
  await f.managers.get(A)!.handle({ id: `${A}|1792180000900|om_dm_choose_group`, userId: owner, channelId: dm, text: 'choose a group', imagePaths: [] }); await f.drain();
  assert.equal(inspected.defaultTargetId, 'private'); assert.deepEqual(inspected.aliases, ['T', '主Bot']); assert.equal(inspected.targets.length, 3);
  assert.equal(f.calls.length, 1); assert.equal(f.replies.filter(reply => reply.text.includes('private source to selected group'))[0]!.channel, `${A}|oc_a_group_1`);
  const delivery = f.host.store.listRoutedDeliveries()[0]!; assert.equal(delivery.source.channelId, dm); assert.equal(delivery.target.spaceId, G1); assert.equal(delivery.state, 'delivered');
  assert.equal(f.host.store.readPublic(G1, A).some(item => item.text === 'private source to selected group'), true);
  assert.deepEqual(f.host.store.getController(A), original); assert.equal(f.host.store.getRoot(f.host.store.readPublic(G1, A)[0]!.rootId)?.replyTo.channelId, dm);
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
  assert.equal(f.calls.length, 0);
  assert.equal(f.replies.length, prior + 1);
  assert.match(f.replies.at(-1)!.text, /未初始化|未就绪/);
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

test('automatic public discussion consumes the shared eight-turn budget and terminates without extra gateway calls', { timeout: 10000 }, async t => {
  const f = fixture(t); await f.activate();
  f.run(async (_botId, turn) => { await turn.onPublicMessage!(`public ${f.calls.length}`); });
  await f.host.receive(A, f.message(A, 'discussion', 'independent opinions please')); await f.drain();
  assert.equal(f.calls.length, 10); // Two free first turns plus eight automatic rounds.
  const event = f.host.store.listEvents()[0]!, root = f.host.store.getRoot(event.rootId)!;
  assert.equal(root.automaticUsed, 8); assert.equal(root.automaticReserved, 0);
  assert.equal(f.calls.filter(c => c.turn.groupContext?.eventKind === 'group-event').length, 8);
  assert.equal(f.replies.filter(reply => reply.text.includes('自动协作已达到')).length, 1);
});

test('a paused Bot holds accepted platform input durably until resume, then uses the current generation', { timeout: 10000 }, async t => {
  const f = fixture(t); await f.activate();
  const pause = f.hooks.get(A)!;
  pause.pauseGroup();
  await f.host.receive(A, f.message(A, 'while-paused', 'wait for the new controller', G1, [A]));
  assert.equal(f.host.inbox.pending().length, 1); assert.equal(f.calls.length, 0);
  const configA = f.configs[0]!, target = f.sessions.get(A)!.createConversation(configA.ownerUserId!, 'codex', configA.workspace, { controllerMode: true });
  f.host.store.setController(A, P, { conversationId: target.id, generation: 2, agent: 'codex', nativeId: null }, 1);
  pause.resumeGroup(); await eventual(() => f.calls.length === 1, 'resumed input reaches Agent'); await f.drain();
  assert.equal(f.host.inbox.pending().length, 0); assert.equal(f.calls[0]!.turn.groupContext?.generation, 2);
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
      let unauthorizedDispatch = false;
      await assert.rejects(f.host.invoke(A, turn, 'bridge_start_worker', { workId: 'not-claimed', title: 'unsafe', prompt: 'must not run' }, 'unsafe', async () => {
        unauthorizedDispatch = true; return { workerId: 'bad' };
      }), /先认领/);
      assert.equal(unauthorizedDispatch, false);
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
      }), /助手不属于当前任务/);
      assert.equal(oldWorkerContinued, false);
    }
    await turn.onSilent?.();
  });
  await f.host.receive(A, f.message(A, 'handoff-root', 'please investigate', G1, [A])); await f.drain();
  assert.equal(refused, true); assert.equal(f.host.store.getTask('work')?.ownerBotId, B);
  assert.equal(f.host.store.getTask('work')?.replyTo.channelId, `${A}|oc_a_group_1`);
  assert.deepEqual(f.host.store.taskWorkers('work'), [{ botId: A, workerId: 'worker' }]);
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
  assert.deepEqual(f.calls.map(c => c.turn.text), ['first received', 'second received']);
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

test('an unrelated member private reset does not cancel an already received message explicitly targeting A', { timeout: 10000 }, async t => {
  const f = fixture(t); await f.activate(); const wait = f.gate(), entered = f.gate(); let probes = 0;
  f.groupChecks.set(A, async () => { if (++probes === 1) { entered.release(); await wait.promise; } return true; });
  const delivery = f.host.receive(A, f.message(A, 'only-a-before-b-new', 'only A should handle this', G1, [A])); await entered.promise;
  const configB = f.configs[1]!, newB = f.sessions.get(B)!.createConversation(configB.ownerUserId!, 'codex', configB.workspace, { controllerMode: true });
  f.host.store.setController(B, P, { conversationId: newB.id, generation: 2, agent: 'codex', nativeId: null }, 1);
  wait.release(); await delivery; await f.drain();
  assert.deepEqual(f.calls.map(call => call.botId), [A]);
});

test('input captured before a continuous backend switch follows its preserved controller rather than being cancelled', { timeout: 10000 }, async t => {
  const f = fixture(t); await f.activate(); const wait = f.gate(), entered = f.gate(); let probes = 0;
  f.groupChecks.set(A, async () => { if (++probes === 1) { entered.release(); await wait.promise; } return true; });
  const delivery = f.host.receive(A, f.message(A, 'before-agent-switch', 'preserve this received input', G1, [A])); await entered.promise;
  const configA = f.configs[0]!, newA = f.sessions.get(A)!.createConversation(configA.ownerUserId!, 'claude', configA.workspace, { controllerMode: true });
  f.host.store.replaceControllerForAgentSwitch(A, P, { conversationId: newA.id, generation: 2, agent: 'claude', nativeId: 'new-claude' }, 1);
  wait.release(); await delivery; await f.drain();
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0]!.turn.conversation.agent, 'claude');
  assert.equal(f.calls[0]!.turn.groupContext!.generation, 2);
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
  assert.deepEqual(f.calls.map(call => call.turn.text), ['first from G1', 'second from G2']);
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
  assert.equal(f.calls.length, 9); // Initial human participation plus eight charged timer wakes.
  await hook.onGroupCompletion!({ ...common, id: 'actual-worker-completion', scheduleKind: 'worker', text: 'completed result' } as never);
  await f.drain();
  assert.equal(f.calls.length, 10);
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
  assert.deepEqual(f.calls.map(call => call.turn.text), ['history first', 'history second', 'history third']);
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
  assert.equal(f.host.store.getEvent('prior-native')?.state, 'uncertain'); assert.equal(f.calls.length, 0);
  assert(f.reports.some(report => report.startsWith('HOST_NATIVE_STOP_UNCONFIRMED')));
  await f.host.receive(A, f.message(A, 'new-after-crash', 'a new real instruction', G1, [A]));
  assert.equal(f.calls.length, 0);
  f.stoppedProofs.set(A, true); await f.host.recover(); await f.drain();
  assert.equal(f.host.store.getEvent('prior-native')?.state, 'failed');
  assert.deepEqual(f.calls.map(call => call.turn.text), ['a new real instruction']);
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
  const download = f.gate(), entered = f.gate();
  f.downloads.set(A, async () => { entered.release(); await download.promise; return []; });
  const image = f.message(A, 'stalled-a-image', 'A handles the image', G1, [A]);
  image.attachments = [{ id: 'image-reference', filename: 'image.png', url: '', size: 10, content_type: 'image/png',
    resourceKey: 'source-a-image-resource', messageId: 'om_stalled_image' }];
  await f.host.receive(A, image); await entered.promise;
  await f.host.receive(A, f.message(A, 'independent-b-one', 'B independent first root', G2, [B]));
  await eventual(() => f.calls.filter(call => call.botId === B).length === 1
    && f.host.store.listEvents(B).every(event => event.nativeEnded), 'B completes while A is still downloading');
  assert.equal(f.calls.filter(call => call.botId === A).length, 0);
  await f.host.receive(A, f.message(A, 'independent-b-two', 'B independent second root', G2, [B]));
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
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0]!.botId, A);
});

test('disabled completion wake retains the result after stop without reviving its group controller', { timeout: 10000 }, async t => {
  const f = fixture(t); await f.activate();
  await f.host.receive(A, f.message(A, 'before-late-cancel', 'authorized work', G1, [A])); await f.drain();
  await f.host.receive(A, f.message(A, 'actual-stop', '/stop', G1, [A])); await f.drain();
  const context = f.calls[0]!.turn.groupContext!, before = f.host.store.listEvents(A).length;
  const hook = f.hooks.get(A)!.manager as SessionManagerOptions;
  const result = await hook.onGroupCompletion!({ id: 'cancelled-late-result', wakeAllowed: false,
    conversationId: f.host.store.getController(A)!.conversationId, groupContext: context, text: 'late cancelled worker result' } as never);
  await f.drain(); assert.equal(result, 'retain'); assert.equal(f.host.store.listEvents(A).length, before); assert.equal(f.calls.length, 1);
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
  assert.equal(f.host.store.getEvent('unfinished-proof')?.state, 'uncertain'); assert.equal(f.calls.length, 1);
});

test('startup recovery orders older history before a newer live receipt buffered during the history probe', { timeout: 10000 }, async t => {
  const f = fixture(t); await f.activate();
  const older = f.message(A, 'offline-gap-first', 'older outage input', G1, [A]);
  const live = f.message(A, 'live-during-startup', 'newer live input', G1, [A]);
  f.host.bots.get(A)!.transport.readGroupHistory = async () => ({ messages: [older], oldestId: older.id, newestId: older.id, hasMore: false });
  f.host.beginRecovery(); await f.host.receive(A, live); assert.equal(f.calls.length, 0);
  await f.host.recover(); await f.drain();
  assert.deepEqual(f.calls.map(call => call.turn.text), ['older outage input', 'newer live input']);
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
  assert.equal(f.host.store.listEvents().length, 1); assert.equal(f.host.store.getController(A)!.generation, 1);
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


test('owner input remains conversation evidence when mention routing cannot be verified', async t => {
  const f = fixture(t); await f.activate();
  const source = f.message(A, 'owner-route-failed-evidence', 'discuss this even if @ identity cannot resolve');
  source.space!.mentionedUserIds = ['unverified-outside-app-id'];
  f.mentionViews.set(A, async () => { throw new Error('mention proof unavailable'); });
  await f.host.receive(A, source); await f.drain();
  assert.equal(f.calls.length, 0); assert.equal(f.host.store.listEvents().length, 0);
  const evidence = f.host.store.readContext(G1, A).recent;
  assert.equal(evidence.at(-1)!.text, source.text); assert.equal(evidence.at(-1)!.source.userId, source.userId);
  assert.equal(evidence.at(-1)!.source.mentionedUserIds[0], 'unverified-outside-app-id');
});
