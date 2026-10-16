import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { SessionManager, type SessionManagerOptions } from '../src/manager.js';
import { SessionStore } from '../src/store.js';
import { TaskRegistry } from '../src/tasks.js';
import { HostStore } from '../src/host-store.js';
import type { AgentAdapter, AgentTurn, BridgeConfig, BridgeMessage } from '../src/types.js';

function msg(id: string, text: string, channelId = 'dm'): BridgeMessage { return { id, userId: 'owner', channelId, text, imagePaths: [] }; }
function group(eventId: string): NonNullable<AgentTurn['groupContext']> { return { eventId, rootId: 'root', botId: 'feishu:cli_test', spaceId: 'room', generation: 1, bindingEpoch: 1, originChannelId: 'group-address', principalId: 'me', scene: 'stale' }; }
async function eventually(check: () => boolean): Promise<void> { const deadline = Date.now() + 3000; while (!check()) { if (Date.now() > deadline) throw new Error('测试条件未满足'); await setTimeout(5); } }
function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'bridge-manager-host-')); const execution = join(root, 'execution'), workspace = join(root, 'context'); mkdirSync(execution); mkdirSync(workspace);
  const config: BridgeConfig = { token: '', allowedUserIds: ['owner', 'other'], defaultAgent: 'codex', controllerMode: true, workspace, contextWorkspace: workspace, workingCwd: execution,
    dataDir: join(root, 'data'), attachmentsDir: join(root, 'attachments'), logsDir: join(root, 'logs'), proxyUrl: null, commands: { codex: { command: 'fake', args: [] }, claude: { command: 'fake', args: [] } }, maxImageBytes: 100 };
  const calls: AgentTurn[] = [], replies: Array<{ channel: string; text: string }> = [], interrupted: string[] = [];
  const adapter: AgentAdapter = { async run(turn) { calls.push(turn); const nativeId = turn.conversation.nativeId ?? `native-${turn.conversation.agent}-${turn.conversation.id}`; turn.onNativeId?.(nativeId); return { nativeId, text: '', controlledOutput: true }; }, async interrupt(id) { interrupted.push(id); }, async close() {} };
  const closeLater: Array<() => void> = [];
  let manager = new SessionManager(config, { codex: adapter, claude: adapter }, { async sendText(channel, text) { replies.push({ channel, text }); } }, { mergeDelayMs: 0 });
  const create = async (options: SessionManagerOptions = {}, override: AgentAdapter = adapter) => { await manager.close(); manager = new SessionManager(config, { codex: override, claude: override }, { async sendText(channel, text) { replies.push({ channel, text }); } }, { mergeDelayMs: 0, ...options }); return manager; };
  t.after(async () => { await manager.close(); for (const close of closeLater) close(); rmSync(root, { recursive: true, force: true }); });
  return { root, config, calls, replies, interrupted, adapter, create, closeLater, get manager() { return manager; } };
}

test('binding and owner authorization isolate a single bot and keep execution cwd out of context workspace', async t => {
  const f = fixture(t); let active: string | null = null; const writes: string[] = [];
  const manager = await f.create({ binding: { getActive: user => user === 'owner' ? active : null, setActive(user, id) { assert.equal(user, 'owner'); active = id; writes.push(id); } }, authorizeUser: user => user === 'owner' });
  await manager.handle({ ...msg('other', 'no'), userId: 'other' }); assert.equal(manager.currentConversation('other'), null); assert.equal(f.calls.length, 0);
  await manager.handle(msg('one', 'hello')); await eventually(() => f.calls.length === 1); assert.equal(f.calls[0]?.conversation.cwd, f.config.workingCwd); assert.equal(writes.length, 1);
  const old = manager.currentConversation('owner')!; const target = await manager.prepareReset('owner'); assert.equal(manager.currentConversation('owner')?.id, old.id); assert.notEqual(target.id, old.id);
  // Host batch transaction can install the binding before the local manager commits its side.
  active = target.id; manager.commitPreparedReset(target, msg('reset', '/new'), false); manager.commitPreparedReset(target, msg('reset', '/new'), false); assert.equal(writes.length, 1); assert.equal(manager.currentConversation('owner')?.id, target.id);
});

test('group turns refresh their scene, publish exactly once to the frozen route and record explicit silence', async t => {
  const f = fixture(t), outcomes: string[] = [], contexts: string[] = []; let mode: 'public' | 'silent' = 'public', publishCount = 0;
  const adapter: AgentAdapter = { ...f.adapter, async run(turn) { f.calls.push(turn); const nativeId = turn.conversation.nativeId ?? 'native-group'; turn.onNativeId?.(nativeId); contexts.push(turn.groupContext!.scene); if (mode === 'public') await turn.onPublicMessage?.('group answer', [], 'stable-public'); else await turn.onSilent?.(); return { nativeId, text: 'DONE', controlledOutput: true }; } };
  const manager = await f.create({ onGroupTurnStart: async context => `fresh:${context.eventId}`, onGroupTurnFinished: async (_context, outcome) => { outcomes.push(outcome); }, onGroupSilent: async () => {}, onGroupPublish: async (context, text, _paths, deliver) => { assert.equal(context.originChannelId, 'group-address'); assert.equal(text, 'group answer'); publishCount++; await deliver(); } }, adapter);
  await manager.handle({ ...msg('g1', 'hello group', 'group-address'), groupContext: group('g1') }); await eventually(() => outcomes.length === 1); assert.deepEqual(contexts, ['fresh:g1']); assert.equal(publishCount, 1); assert.equal(f.replies.length, 1); assert.equal(f.replies[0]?.channel, 'group-address');
  mode = 'silent'; await manager.handle({ ...msg('g2', 'nothing to add', 'group-address'), groupContext: group('g2') }); await eventually(() => outcomes.length === 2); assert.deepEqual(outcomes, ['completed', 'silent']); assert.equal(f.replies.length, 1);
});

test('host-event kind persists through inbox recovery and command-looking content never resets the controller', async t => {
  const f = fixture(t); let manager = await f.create(); await manager.handle(msg('human', 'goal')); await eventually(() => f.calls.length === 1); const old = manager.currentConversation('owner')!;
  manager.beginDrain(); await manager.handleHostEvent({ ...msg('internal', '/new', 'group-address'), groupContext: group('internal') }, 'worker-result'); assert.equal(manager.currentConversation('owner')?.id, old.id);
  manager = await f.create({ onGroupTurnStart: async () => 'fresh', onGroupTurnFinished: async () => {} }); await manager.recover(); assert.equal(f.calls.length, 1); await manager.resumeHostEvent(manager.storedHostEvent('internal')!); await eventually(() => f.calls.length === 2);
  assert.equal(f.calls[1]?.conversation.id, old.id); assert.equal(f.calls[1]?.event?.kind, 'worker-result'); assert.equal(f.calls[1]?.groupContext?.eventKind, 'worker-result');
});

test('real agent switch prepares the target without authority, retains latest context and leaves ordinary lifecycle intact', async t => {
  const f = fixture(t), phases: string[] = []; let manager: SessionManager; let sourceId = '';
  manager = await f.create({ onPrepareSwitch: async (source, target, _channel, prompt) => { phases.push('summary'); assert.equal(manager.currentConversation('owner')?.id, source.id); assert.match(prompt, /普通助手和定时计划保持原样/); assert.notEqual(target.agent, source.agent); return { contextSeed: 'latest complete goal and correction' }; }, onRebindSwitch: async (source, target) => { phases.push('rebind'); assert.equal(source.id, sourceId); assert.ok(target.nativeId); assert.equal(manager.currentConversation('owner')?.id, source.id); }, onPauseSwitch: async () => { phases.push('pause'); }, onResumeSwitch: async () => { phases.push('resume'); }, onDetach: async () => { throw new Error('switch must not cancel scheduled workers'); } });
  await manager.handle(msg('human', 'goal')); await eventually(() => f.calls.length === 1); sourceId = manager.currentConversation('owner')!.id; const before = f.calls.length;
  await manager.handle(msg('choose-current', '/agent codex')); assert.equal(f.calls.length, before); assert.deepEqual(phases, []);
  await manager.handle(msg('switch', '/agent claude')); const target = manager.currentConversation('owner')!; assert.equal(target.agent, 'claude'); assert.notEqual(target.id, sourceId); assert.match(target.contextSeed!, /latest complete goal/); assert.equal(f.calls[1]?.preparing, true); assert.equal(f.calls[1]?.taskContextPath, undefined); assert.ok(target.nativeId?.startsWith('native-claude'));
  assert.deepEqual(phases.slice(0, 3), ['pause', 'summary', 'rebind']); const files = readdirSync(join(f.config.dataDir, 'agent-switches')); const journal = JSON.parse(readFileSync(join(f.config.dataDir, 'agent-switches', files[0]!), 'utf8')); assert.equal(journal.phase, 'committed');
});

test('failed target bootstrap preserves the active controller and records the failed preparation', async t => {
  const f = fixture(t); const adapter: AgentAdapter = { ...f.adapter, async run(turn) { if (turn.preparing) throw new Error('gateway unavailable'); return f.adapter.run(turn); } };
  const manager = await f.create({ onPrepareSwitch: async () => ({ contextSeed: 'summary' }), onRebindSwitch: async () => { throw new Error('must not commit'); } }, adapter);
  await manager.handle(msg('human', 'goal')); await eventually(() => f.calls.length === 1); const old = manager.currentConversation('owner')!; await manager.handle(msg('switch-fail', '/agent claude')); assert.equal(manager.currentConversation('owner')?.id, old.id); assert.match(f.replies.at(-1)!.text, /gateway unavailable/);
  const file = readdirSync(join(f.config.dataDir, 'agent-switches'))[0]!; assert.equal(JSON.parse(readFileSync(join(f.config.dataDir, 'agent-switches', file), 'utf8')).phase, 'failed');
});

test('interrupted switch commit rebinds idempotently on recovery without another model call', async t => {
  const f = fixture(t); let rebinds = 0; let manager = await f.create({ onPrepareSwitch: async () => ({ contextSeed: 'summary' }), onRebindSwitch: async () => { rebinds++; throw new Error('simulated crash after partial rebind'); } });
  await manager.handle(msg('human', 'goal')); await eventually(() => f.calls.length === 1); const old = manager.currentConversation('owner')!; await manager.handle(msg('switch-crash', '/agent claude')); assert.equal(manager.currentConversation('owner')?.id, old.id); assert.equal(f.calls.length, 2);
  await assert.rejects(manager.handle(msg('blocked', 'cannot run until commit recovered')), /提交尚待核对/);
  manager = await f.create({ onRebindSwitch: async () => { rebinds++; } }); await manager.recover(); assert.equal(rebinds, 2); assert.equal(f.calls.length, 2); assert.equal(manager.currentConversation('owner')?.agent, 'claude');
  const file = readdirSync(join(f.config.dataDir, 'agent-switches'))[0]!; assert.equal(JSON.parse(readFileSync(join(f.config.dataDir, 'agent-switches', file), 'utf8')).phase, 'committed');
});

test('new selects saved target backend preferences and preserves them after the next reset', async t => {
  const f = fixture(t); const manager = await f.create({ onPrepareSwitch: async () => ({ contextSeed: 'summary' }), onRebindSwitch: async () => {} }); await manager.handle(msg('human', 'goal')); await eventually(() => f.calls.length === 1);
  const store = new SessionStore(f.config.dataDir); const preference = store.createConversation('owner', 'claude', f.config.workingCwd!); store.setModel(preference.id, 'user-claude-model'); store.setEffort(preference.id, 'high'); store.savePreferences(store.getConversation(preference.id)!); store.close();
  await manager.handle(msg('switch', '/agent claude')); assert.equal(manager.currentConversation('owner')?.model, 'user-claude-model'); assert.equal(manager.currentConversation('owner')?.effort, 'high'); await manager.handle(msg('new', '/new')); assert.equal(manager.currentConversation('owner')?.model, 'user-claude-model'); assert.equal(manager.currentConversation('owner')?.effort, 'high');
});
test('group task results are retained through the host callback without replaying the old group event', async t => {
  const f = fixture(t), registry = new TaskRegistry(f.config.dataDir); f.closeLater.push(() => registry.close()); let forwarded = 0;
  const manager = await f.create({ taskRegistry: registry, onGroupTurnStart: async () => 'fresh', onGroupTurnFinished: async () => {}, onGroupCompletion: async event => { forwarded++; assert.equal(event.groupContext?.eventId, 'human-group'); return 'retain'; } });
  await manager.handle({ ...msg('human-group', 'goal', 'group-address'), groupContext: group('human-group') }); await eventually(() => f.calls.length === 1 && manager.isIdle());
  const conversation = manager.currentConversation('owner')!; const context = registry.createContext({ conversationId: conversation.id, userId: conversation.userId, channelId: 'group-address', originMessageId: 'human-group', nativeId: conversation.nativeId, agent: conversation.agent, cwd: conversation.cwd, groupContext: group('human-group') });
  const task = registry.register(JSON.parse(readFileSync(context.contextPath, 'utf8')), 'late result'); registry.acceptObservedResult(task.taskId, 'completed', 'stored evidence'); manager.completionAvailable(); await eventually(() => forwarded === 1 && registry.queuedEvents().length === 0);
  assert.equal(f.calls.length, 1); assert.equal(f.replies.length, 0); assert.equal(registry.activeCount(conversation.id), 0);
});

test('workspace readiness is reported only after the main controller actually accepts its context', async t => {
  const f = fixture(t), registry = new TaskRegistry(f.config.dataDir); f.closeLater.push(() => registry.close()); const states: string[] = []; let finishLoad!: () => void;
  const adapter: AgentAdapter = { ...f.adapter, async run(turn) { if (turn.event?.kind === 'workspace-context') await new Promise<void>(resolve => { finishLoad = resolve; }); return f.adapter.run(turn); } };
  const manager = await f.create({ taskRegistry: registry, onInitializationState: async (_conversation, outcome) => { states.push(outcome); } }, adapter);
  await manager.handle(msg('human', 'goal')); await eventually(() => f.calls.length === 1 && manager.isIdle()); const conversation = manager.currentConversation('owner')!;
  const context = registry.createContext({ conversationId: conversation.id, userId: conversation.userId, channelId: 'dm', originMessageId: 'human', nativeId: conversation.nativeId, agent: conversation.agent, cwd: conversation.cwd, purpose: 'workspace-context' }); const task = registry.register(JSON.parse(readFileSync(context.contextPath, 'utf8')), 'read workspace'); registry.acceptObservedResult(task.taskId, 'completed', 'workspace read succeeded'); manager.completionAvailable(); await eventually(() => !!finishLoad);
  assert.deepEqual(states, []); finishLoad(); await eventually(() => states.length === 1); assert.deepEqual(states, ['ready']);
});

test('failed reset preparation releases the barrier while preserving the original active binding', async t => {
  const f = fixture(t); const manager = await f.create({ onDetach: async () => { throw new Error('scheduled worker not confirmed stopped'); } }); await manager.handle(msg('human', 'goal')); await eventually(() => f.calls.length === 1 && manager.isIdle()); const source = manager.currentConversation('owner')!;
  await assert.rejects(manager.prepareReset('owner'), /not confirmed stopped/); assert.equal(manager.currentConversation('owner')?.id, source.id); await manager.handle(msg('after-failure', 'continue existing')); await eventually(() => f.calls.length === 2); assert.equal(f.calls[1]?.conversation.id, source.id);
});
test('batch reset suppresses per-bot introductions while still loading workspace context and reporting readiness', async t => {
  const f = fixture(t), registry = new TaskRegistry(f.config.dataDir); f.closeLater.push(() => registry.close()); const states: string[] = [];
  const manager = await f.create({ taskRegistry: registry, onInitializationState: async (_conversation, outcome) => { states.push(outcome); }, onInitializeWorkspace: async turn => {
    const context = JSON.parse(readFileSync(turn.taskContextPath!, 'utf8')); const origin = registry.getContextOrigin(context); const investigation = registry.createContext({ ...origin, purpose: 'workspace-context' }); const task = registry.register(JSON.parse(readFileSync(investigation.contextPath, 'utf8')), 'read group workspace'); registry.acceptObservedResult(task.taskId, 'completed', 'loaded workspace'); registry.closeContext(investigation.contextId);
  } });
  const target = await manager.prepareReset('owner'); manager.commitPreparedReset(target, msg('group-new', '/new', 'group-address'), true, true);
  await eventually(() => states.length === 1); assert.deepEqual(states, ['ready']); assert.equal(f.replies.length, 0); assert.equal(f.calls.length, 1); assert.equal(f.calls[0]?.event?.kind, 'workspace-context'); assert.equal(f.calls[0]?.event?.introductionRequested, false);
});
test('agent switch rebinds an existing private worker result to the new native controller and keeps its source chain', async t => {
  const f = fixture(t), registry = new TaskRegistry(f.config.dataDir); f.closeLater.push(() => registry.close());
  const manager = await f.create({ taskRegistry: registry, onPrepareSwitch: async () => ({ contextSeed: 'current delegated goal' }), onRebindSwitch: (source, target) => registry.rebindConversation(source, target) });
  await manager.handle(msg('human', 'delegate this goal')); await eventually(() => f.calls.length === 1 && manager.isIdle()); const source = manager.currentConversation('owner')!;
  const context = registry.createContext({ conversationId: source.id, userId: source.userId, channelId: 'dm', originMessageId: 'human', nativeId: source.nativeId, agent: source.agent, cwd: source.cwd }); const task = registry.register(JSON.parse(readFileSync(context.contextPath, 'utf8')), 'preserved worker'); registry.closeContext(context.contextId);
  await manager.handle(msg('switch', '/agent claude')); const target = manager.currentConversation('owner')!; assert.equal(registry.activeCount(target.id), 1); assert.equal(registry.activeCount(source.id), 0);
  registry.acceptObservedResult(task.taskId, 'completed', 'actual worker result'); const event = registry.getNextEvent()!; assert.equal(event.wakeAllowed, true); assert.equal(event.conversationId, target.id); assert.equal(event.reboundFrom?.[0]?.conversationId, source.id);
  manager.completionAvailable(); await eventually(() => registry.eventState(event.id) === 'delivered'); assert.equal(f.calls.length, 3); assert.equal(f.calls[2]?.event?.kind, 'worker-result'); assert.equal(f.calls[2]?.conversation.id, target.id);
});
test('committed batch initialization recovers a member never locally initialized, then replays readiness without another model', async t => {
  const f = fixture(t), registry = new TaskRegistry(f.config.dataDir); f.closeLater.push(() => registry.close()); let investigations = 0, readiness = 0, cancellations = 0;
  const options: SessionManagerOptions = { taskRegistry: registry, onDetach: async () => { cancellations++; }, onInitializationState: async (_conversation, outcome) => { if (outcome === 'ready') readiness++; }, onInitializeWorkspace: async turn => {
    investigations++; const origin = registry.getContextOrigin(JSON.parse(readFileSync(turn.taskContextPath!, 'utf8'))); const context = registry.createContext({ ...origin, purpose: 'workspace-context' }); const task = registry.register(JSON.parse(readFileSync(context.contextPath, 'utf8')), 'recovered initialization'); registry.acceptObservedResult(task.taskId, 'completed', 'workspace loaded'); registry.closeContext(context.contextId);
  } };
  let manager = await f.create(options); const store = new SessionStore(f.config.dataDir); const committed = store.createConversation('owner', 'codex', f.config.workingCwd!, { controllerMode: true }); store.setActive('owner', committed.id); store.close();
  const source = msg('committed-group-new', '/new', 'group-address'); await manager.ensureCommittedResetInitialized(committed, source); await eventually(() => readiness === 1 && manager.isIdle()); assert.equal(investigations, 1); assert.equal(f.calls.length, 1); assert.equal(f.replies.length, 0); assert.equal(cancellations, 0);
  manager = await f.create(options); await manager.recover(); await manager.ensureCommittedResetInitialized(manager.conversationById(committed.id)!, source); assert.equal(readiness, 2); assert.equal(investigations, 1); assert.equal(f.calls.length, 1); assert.equal(cancellations, 0); assert.equal(manager.currentConversation('owner')?.id, committed.id);
});

test('pending committed initialization reuses a registered read task across manager recovery and waits for real native acceptance', async t => {
  const f = fixture(t), registry = new TaskRegistry(f.config.dataDir); f.closeLater.push(() => registry.close()); let taskId: string | undefined, investigations = 0, ready = false;
  const options: SessionManagerOptions = { taskRegistry: registry, onInitializationState: async (_conversation, outcome) => { ready = outcome === 'ready'; }, onInitializeWorkspace: async turn => {
    if (taskId) return; investigations++; const origin = registry.getContextOrigin(JSON.parse(readFileSync(turn.taskContextPath!, 'utf8'))); const context = registry.createContext({ ...origin, purpose: 'workspace-context' }); const task = registry.register(JSON.parse(readFileSync(context.contextPath, 'utf8')), 'existing read task'); taskId = task.taskId; registry.closeContext(context.contextId);
  } };
  let manager = await f.create(options); const committed = await manager.prepareReset('owner'); manager.commitPreparedReset(committed, msg('pending-group-new', '/new', 'group-address'), true, true); await eventually(() => !!taskId && manager.isIdle()); assert.equal(ready, false); assert.equal(f.calls.length, 0);
  manager = await f.create(options); await manager.recover(); await manager.ensureCommittedResetInitialized(committed, msg('pending-group-new', '/new', 'group-address')); assert.equal(investigations, 1); assert.equal(ready, false);
  registry.acceptObservedResult(taskId!, 'completed', 'existing result'); manager.completionAvailable(); await eventually(() => ready && manager.isIdle()); assert.equal(investigations, 1); assert.equal(f.calls.length, 1); assert.equal(f.replies.length, 0);
});

test('a prepared but uncommitted reset is blocked and never cancelled or committed by the recovery API', async t => {
  const f = fixture(t); let investigations = 0, cancelled = 0; const manager = await f.create({ onInitializeWorkspace: async () => { investigations++; }, onDetach: async () => { cancelled++; } }); await manager.handle(msg('human', 'goal')); await eventually(() => f.calls.length === 1 && manager.isIdle()); const previous = manager.currentConversation('owner')!;
  const store = new SessionStore(f.config.dataDir), uncommitted = store.createConversation('owner', 'codex', previous.cwd, { controllerMode: true }); store.close();
  await assert.rejects(manager.ensureCommittedResetInitialized(uncommitted, msg('uncommitted-new', '/new', 'group-address')), /已提交的当前主控/); assert.equal(manager.currentConversation('owner')?.id, previous.id); assert.equal(investigations, 0); assert.equal(cancelled, 0); assert.equal(f.calls.length, 1);
});

test('durable readiness survives a host callback failure and can be replayed without reloading the native context', async t => {
  const f = fixture(t), registry = new TaskRegistry(f.config.dataDir); f.closeLater.push(() => registry.close()); let investigations = 0, callbacks = 0;
  const onInitializeWorkspace: NonNullable<SessionManagerOptions['onInitializeWorkspace']> = async turn => { investigations++; const origin = registry.getContextOrigin(JSON.parse(readFileSync(turn.taskContextPath!, 'utf8'))); const context = registry.createContext({ ...origin, purpose: 'workspace-context' }); const task = registry.register(JSON.parse(readFileSync(context.contextPath, 'utf8')), 'loaded once'); registry.acceptObservedResult(task.taskId, 'completed', 'valid context'); registry.closeContext(context.contextId); };
  let manager = await f.create({ taskRegistry: registry, onInitializeWorkspace, onInitializationState: async () => { throw new Error('host journal unavailable'); } }); const target = await manager.prepareReset('owner'), source = msg('callback-crash', '/new', 'group-address'); manager.commitPreparedReset(target, source, true, true); await eventually(() => f.calls.length === 1 && manager.isIdle());
  const journal = JSON.parse(readFileSync(join(f.config.dataDir, 'workspace-initialization', target.id + '.json'), 'utf8')); assert.equal(journal.outcome, 'ready');
  manager = await f.create({ taskRegistry: registry, onInitializeWorkspace, onInitializationState: async (_conversation, outcome) => { assert.equal(outcome, 'ready'); callbacks++; } }); await manager.ensureCommittedResetInitialized(manager.conversationById(target.id)!, source); assert.equal(callbacks, 1); assert.equal(investigations, 1); assert.equal(f.calls.length, 1);
});
async function restartQueue(t: TestContext, direct = false) {
  const f = fixture(t); f.config.controllerMode = !direct;
  const hostPath = join(f.root, 'host'), botId = 'feishu:cli_test'; let host = new HostStore(hostPath);
  const local = new SessionStore(f.config.dataDir), target = local.createConversation('owner', 'codex', f.config.workingCwd!, { controllerMode: !direct }); local.saveNativeId(target.id, 'native-existing'); local.close();
  host.registerBot({ botId, platform: 'feishu', applicationId: 'cli_test' }); host.mapPrincipal({ principalId: 'me', botId, platformUserId: 'owner', proof: 'explicit test owner mapping' }); host.claimOwner(botId, 'me');
  host.mapSpace({ botId, platformSpaceId: 'group-address', spaceId: 'room', proof: 'explicit test group mapping' });
  host.setController(botId, 'me', { conversationId: target.id, generation: 1, agent: 'codex', nativeId: 'native-existing' }, 0);
  host.startGroup({ spaceId: 'room', principalId: 'me', receiverBotId: botId, memberBotIds: [botId] });
  host.acceptRoot({ id: 'root', spaceId: 'room', principalId: 'me', sourceEventId: 'source', targetBotIds: [botId], replyTo: { channelId: 'group-address' } });
  host.enqueueEvent({ id: 'queued-group', rootId: 'root', botId, generation: 1, kind: 'human', payload: { text: 'group goal' } }); assert.equal(host.claimNextEvent(botId)?.id, 'queued-group');
  f.closeLater.push(() => host.close());
  const options: SessionManagerOptions = { mergeDelayMs: direct ? 20 : 0, binding: { getActive: user => user === 'owner' ? host.getController(botId)?.conversationId ?? null : null, setActive() { throw new Error('queue recovery must never create a controller'); } },
    onGroupTurnStart: async context => { host.startEvent(context.eventId); return 'host confirmed scene'; }, onGroupTurnFinished: async (context, outcome) => host.finishEvent(context.eventId, outcome) };
  let manager = await f.create(options); manager.beginDrain();
  const event = { ...msg('queued-group', 'group goal', 'group-address'), groupContext: group('queued-group') };
  return { f, options, event, target, botId, get host() { return host; }, get manager() { return manager; },
    async restart() { manager = await f.create(options); host.close(); host = new HostStore(hostPath); host.recoverInFlight(); await manager.recover(); return manager; } };
}

for (const direct of [false, true]) test(`restart preserves the DM/group FIFO barrier until a fresh host reservation (${direct ? 'direct batching' : 'controller'})`, async t => {
  const r = await restartQueue(t, direct);
  await r.manager.handle(msg('dm-before', 'before group')); await r.manager.handle(r.event); await r.manager.handle(msg('dm-after', 'after group'));
  const manager = await r.restart(); await eventually(() => r.f.calls.length === 1 && manager.isIdle());
  assert.equal(r.f.calls[0]?.text, 'before group'); assert.equal(r.host.getEvent('queued-group')?.state, 'queued');
  await manager.handle(r.event); await setTimeout(30); assert.equal(r.f.calls.length, 1); assert.equal(manager.storedHostEvent(r.event.id)?.text, 'group goal');
  assert.equal(r.host.claimNextEvent(r.botId)?.id, 'queued-group'); const resumed = await manager.resumeHostEvent(r.event); assert.equal(resumed.status, 'queued');
  await eventually(() => r.f.calls.length === 3 && manager.isIdle()); assert.deepEqual(r.f.calls.map(call => call.text), ['before group', 'group goal', 'after group']); assert.equal(r.host.getEvent('queued-group')?.state, 'completed');
  assert.equal((await manager.resumeHostEvent(r.event)).status, 'terminal'); assert.equal(r.f.calls.length, 3);
});

test('cancelling a durable host queue barrier releases following DM without replaying the group', async t => {
  const r = await restartQueue(t); await r.manager.handle(r.event); await r.manager.handle(msg('dm-after', 'private follow-up')); const manager = await r.restart();
  await setTimeout(20); assert.equal(r.f.calls.length, 0); r.host.cancelEvent(r.event.id, 'group stopped'); assert.equal(manager.cancelHostEvent(r.event.id, 'group stopped'), true);
  await eventually(() => r.f.calls.length === 1 && manager.isIdle()); assert.equal(r.f.calls[0]?.text, 'private follow-up'); assert.equal(manager.cancelHostEvent(r.event.id), false); assert.equal((await manager.resumeHostEvent(r.event)).state, 'cancelled');
});

test('only explicit continuous host rebinding may update the queued generation and immutable routes stay fixed', async t => {
  const r = await restartQueue(t); await r.manager.handle(r.event);
  const local = new SessionStore(r.f.config.dataDir), target = local.createConversation('owner', 'claude', r.target.cwd, { controllerMode: true }); local.saveNativeId(target.id, 'native-new'); local.rebindQueued(r.target.id, target.id); local.close();
  r.host.replaceControllerForAgentSwitch(r.botId, 'me', { conversationId: target.id, generation: 2, agent: 'claude', nativeId: 'native-new' }, 1);
  const manager = await r.restart(); assert.equal(r.host.claimNextEvent(r.botId)?.generation, 2); const rebound = { ...r.event, groupContext: { ...r.event.groupContext, generation: 2, scene: 'new scene' } };
  await assert.rejects(manager.resumeHostEvent(rebound), /代次/); await assert.rejects(manager.resumeHostEvent({ ...rebound, groupContext: { ...rebound.groupContext, spaceId: 'another-room' } }, { allowContinuousRebind: true }), /路由/); assert.equal(r.f.calls.length, 0);
  await manager.resumeHostEvent(rebound, { allowContinuousRebind: true }); await eventually(() => r.f.calls.length === 1 && manager.isIdle()); assert.equal(r.f.calls[0]?.conversation.id, target.id); assert.equal(r.f.calls[0]?.groupContext?.generation, 2); assert.equal(r.host.getEvent(r.event.id)?.state, 'completed');
});

test('uncertain durable group work is retained and cannot be resumed or queue-cancelled as a new turn', async t => {
  const r = await restartQueue(t); await r.manager.handle(r.event); const local = new SessionStore(r.f.config.dataDir); local.setState(r.event.id, 'uncertain'); local.close(); r.host.startEvent(r.event.id);
  const manager = await r.restart(); assert.equal(r.host.getEvent(r.event.id)?.state, 'uncertain'); assert.equal(r.host.claimNextEvent(r.botId), null); const result = await manager.resumeHostEvent(r.event); assert.deepEqual(result, { status: 'terminal', state: 'uncertain' }); assert.equal(manager.cancelHostEvent(r.event.id), false); await setTimeout(20); assert.equal(r.f.calls.length, 0);
});

test('a stopped group worker result is consumed as retained history without asking the host to wake a controller', async t => {
  const f = fixture(t), registry = new TaskRegistry(f.config.dataDir); f.closeLater.push(() => registry.close()); let forwarded = 0;
  const manager = await f.create({ taskRegistry: registry, onGroupTurnStart: async () => 'scene', onGroupCompletion: async () => { forwarded++; return 'queued'; } });
  await manager.handle({ ...msg('stopped-group', 'delegate', 'group-address'), groupContext: group('stopped-group') }); await eventually(() => f.calls.length === 1 && manager.isIdle());
  const source = manager.currentConversation('owner')!, context = registry.createContext({ conversationId: source.id, userId: source.userId, channelId: 'group-address', originMessageId: 'stopped-group', nativeId: source.nativeId, agent: source.agent, cwd: source.cwd, groupContext: group('stopped-group') });
  const task = registry.register(JSON.parse(readFileSync(context.contextPath, 'utf8')), 'stopped worker'); registry.cancelConversation(source.id); registry.acceptObservedResult(task.taskId, 'completed', 'saved late result'); const event = registry.getNextEvent()!; assert.equal(event.wakeAllowed, false);
  manager.completionAvailable(); await eventually(() => registry.eventState(event.id) === 'delivered'); assert.equal(forwarded, 0); assert.equal(f.calls.length, 1); assert.equal(f.replies.length, 0); assert.match(event.text, /saved late result/); assert.equal(registry.getTask(task.taskId)?.status, 'completed');
});
