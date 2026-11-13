import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import { ExecutorMessages, executorMessageHome, executorScope, executorTaskId, type ExecutorBinding } from '../src/executor-messages.js';
import { ExecutorMessenger } from '../src/controller/executor-messenger.js';
import { ControllerStore } from '../src/controller/store.js';
import { TaskRegistry } from '../src/tasks.js';
import { RemoteDaemon } from '../src/remote/daemon.js';
import { RemoteAgentAdapter } from '../src/remote/adapter.js';
import { requestRemoteHttp } from '../src/remote/client.js';
import type { ControllerWorker } from '../src/controller/runtime-types.js';
import { SessionManager } from '../src/manager.js';
import { SessionStore } from '../src/store.js';
import type { AgentAdapter, AgentTurn, BridgeConfig } from '../src/types.js';

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'executor-messages-')), userHome = join(root, 'user'), executor = join(root, 'executor');
  const binding: ExecutorBinding = { workerId: 'worker-a', scope: executorScope('bot-A|owner'), userId: 'bot-A|owner', title: '用户接手续聊', cwd: root, agent: 'codex', nativeId: 'native-a' };
  return { root, userHome, executor, binding };
}
test('offline send, restart, deduplication, reply and silent completion stay under the user directory', t => {
  const f = setup();
  let store = new ExecutorMessages(f.executor, f.userHome); store.bind(f.binding);
  t.after(() => { store.close(); rmSync(f.root, { recursive: true, force: true }); });
  const message = store.send('worker-a', '任意讨论内容，不预分类', 'message-a');
  assert.equal(message.state, 'queued'); assert.equal(store.send('worker-a', message.text, message.id).id, message.id);
  assert.throws(() => store.send('worker-a', '不同正文', message.id));
  assert.throws(() => store.send('unknown-worker', '不能猜路由', 'unknown'));
  store.close(); store = new ExecutorMessages(f.executor, f.userHome);
  assert.equal(store.pending(f.binding.scope).length, 1);
  assert.equal(store.pending(executorScope('bot-B|owner')).length, 0);
  assert.throws(() => store.update(executorScope('bot-B|owner'), message.id, 'handled', '串线'));
  assert.throws(() => store.bind({ ...f.binding, scope: executorScope('bot-B|owner'), userId: 'bot-B|owner' }));
  store.update(f.binding.scope, message.id, 'accepted');
  assert.equal(store.update(f.binding.scope, message.id, 'handled', '主控答复').reply, '主控答复');
  assert.equal(store.update(f.binding.scope, message.id, 'handled', '主控答复').reply, '主控答复');
  assert.throws(() => store.update(f.binding.scope, message.id, 'handled', '覆盖答复'));
  store.send('worker-a', '无需回话', 'silent'); store.update(f.binding.scope, 'silent', 'handled');
  assert.equal(store.get('silent')!.reply, null); assert.equal(store.pending(f.binding.scope).length, 0);
  assert(existsSync(join(executorMessageHome(f.executor, f.userHome), 'messages.sqlite')));
  assert(!existsSync(join(f.executor, '.local'))); assert(!existsSync(join(f.executor, 'messages.sqlite')));
});

test('registration-only crash resumes the durable message and keeps a full long Unicode body', () => {
  const f = setup(), path = join(f.root, 'tasks'); let registry = new TaskRegistry(path);
  const origin = { conversationId: 'parent', userId: f.binding.userId, channelId: 'dm', originMessageId: 'owner',
    nativeId: 'native', agent: 'codex' as const, cwd: f.root, purpose: 'executor-message' as const, executorMessageId: 'long', executorWorkerId: f.binding.workerId };
  try {
    const context = registry.createContext(origin);
    registry.register(JSON.parse(readFileSync(context.contextPath, 'utf8')), '执行助手发来的消息', executorTaskId('long'));
    registry.close(); registry = new TaskRegistry(path);
    const body = '讨论正文'.repeat(4000);
    const event = registry.enqueueExecutorMessage(origin, 'long', body);
    assert.equal(event.text, body); assert.equal(registry.queuedEvents().length, 1);
    assert.equal(registry.enqueueExecutorMessage(origin, 'long', body).id, event.id);
  } finally { registry.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test('recipient selection follows a dynamic active directory, explicit names and stable IDs without changing ownership', t => {
  const f = setup(), store = new ExecutorMessages(f.executor, f.userHome);
  t.after(() => { store.close(); rmSync(f.root, { recursive: true, force: true }); });
  const directoryId = 'd'.repeat(64);
  const alpha = { scope: f.binding.scope, botId: 'feishu:dynamic-a', userId: f.binding.userId, principalId: 'same-owner', aliases: ['Alpha'] };
  const beta = { scope: executorScope('bot-B|owner'), botId: 'discord:dynamic-b', userId: 'bot-B|owner', principalId: 'same-owner', aliases: ['Beta'] };
  store.registerDirectory(directoryId, [alpha, beta]); store.bind(f.binding);
  const cross = store.send(f.binding.workerId, '转交另一主控讨论', 'cross', 'beta');
  assert.equal(cross.recipient!.botId, beta.botId); assert.equal(cross.sender!.workerId, f.binding.workerId);
  assert.equal(store.binding(f.binding.workerId)!.scope, alpha.scope);
  assert.equal(store.pending(alpha.scope).length, 0); assert.equal(store.pending(beta.scope).length, 1);
  assert.throws(() => store.update(alpha.scope, cross.id, 'handled', '来源主控不能截获答复'));
  store.update(beta.scope, cross.id, 'handled', '目标主控答复');
  assert.equal(store.get(cross.id)!.reply, '目标主控答复');
  assert.equal(store.send(f.binding.workerId, '默认仍找原主控', 'default').recipient!.scope, alpha.scope);
  const bare = store.send(null, '普通CLI自由消息', 'bare', beta.botId);
  assert.equal(bare.workerId, null); assert.equal(bare.recipient!.scope, beta.scope);
  assert.throws(() => store.send(null, bare.text, bare.id, alpha.botId));
  store.registerDirectory(directoryId, [alpha, { ...beta, aliases: ['Renamed'] }]);
  assert.throws(() => store.send(null, '旧名不再有效', 'old-name', 'Beta'));
  assert.equal(store.send(null, '改名无需改代码', 'new-name', 'RENAMED').recipient!.scope, beta.scope);
  store.registerDirectory(directoryId, [alpha]);
  assert.equal(store.recipients().length, 1); assert.throws(() => store.send(null, '停用后不可新投递', 'inactive', beta.botId));
  store.registerDirectory(directoryId, [alpha, { ...beta, aliases: ['Alpha'] }]);
  assert.throws(() => store.send(null, '跨平台同名不猜选', 'ambiguous', 'Alpha'), /不唯一/);
  assert.equal(store.send(null, '用稳定ID消歧', 'qualified', beta.botId).recipient!.botId, beta.botId);
  store.registerDirectory(directoryId, [alpha, { ...beta, principalId: 'different-owner' }]);
  assert.throws(() => store.send(f.binding.workerId, '不能冒用其他负责人', 'other-owner', beta.botId));
});

test('an active controller with no previous workers receives and answers an ordinary CLI message', async () => {
  const f = setup(), controller = new ControllerStore(join(f.root, 'bridge')), registry = new TaskRegistry(join(f.root, 'tasks'));
  const daemon = new RemoteDaemon(f.executor, { version: 1, expectedHostname: hostname(), engines: { codex: { agentCommand: { command: process.execPath, args: [] }, defaultCwd: f.root } } }, { nativeSessionOptions: { userHome: f.userHome } });
  const sender = new ExecutorMessages(f.executor, f.userHome), userId = 'bot-no-workers|owner';
  const recipient = { scope: executorScope(userId), botId: 'feishu:newly-activated', userId, principalId: 'owner', aliases: ['Newly Activated'] };
  const target = { id: 'station', label: '工位', transport: 'ssh' as const, remoteRoot: f.executor, agent: 'codex' as const, agentCommand: { command: process.execPath, args: [] }, cwd: f.root };
  const messenger = new ExecutorMessenger(controller, registry, () => ({ executorMessages: (method, args) => daemon.handle(method, args) }), (worker, message, owner) => {
    assert.equal(worker, null); assert.equal(owner, userId);
    registry.enqueueExecutorMessage({ conversationId: 'new-current-parent', nativeId: 'current-native', userId, channelId: 'dm', originMessageId: 'owner-source', agent: 'codex', cwd: f.root, purpose: 'executor-message', executorMessageId: message.id }, message.id, message.text);
    return true;
  }, owner => owner === userId, async () => ({ directoryId: 'f'.repeat(64), userId, recipients: [recipient], targets: [target] }));
  try {
    await messenger.poll(); assert.equal(sender.recipients()[0]!.botId, recipient.botId);
    sender.send(null, '没有被桥派出过，也能点名联系', 'ordinary', 'Newly Activated');
    await messenger.poll(); assert.equal(sender.get('ordinary')!.state, 'accepted');
    await messenger.reply(userId, 'ordinary', '已收到普通CLI的讨论');
    assert.equal(sender.get('ordinary')!.reply, '已收到普通CLI的讨论');
    await assert.rejects(messenger.reply('different-owner', 'ordinary', '截获'));
  } finally { messenger.close(); sender.close(); controller.close(); registry.close(); await daemon.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test('manager routes an already queued message to the new controller and permits a silent decision', async () => {
  const f = setup(), dataDir = join(f.root, 'bot');
  const registry = new TaskRegistry(join(f.root, 'tasks')), sessions = new SessionStore(dataDir);
  const calls: AgentTurn[] = [], publicMessages: string[] = [], interruptions: string[] = [];
  const adapter: AgentAdapter = { async run(turn) { calls.push(turn); return { nativeId: turn.conversation.nativeId!, text: 'DONE', controlledOutput: true }; }, async interrupt(id) { interruptions.push(id); }, async close() {} };
  const config: BridgeConfig = { token: '', allowedUserIds: [f.binding.userId], defaultAgent: 'codex', workspace: f.root, controllerMode: true,
    proxyUrl: null, commands: { codex: { command: process.execPath, args: [] }, claude: { command: process.execPath, args: [] } }, dataDir, attachmentsDir: f.root, logsDir: f.root, maxImageBytes: 100 };
  const old = sessions.createConversation(f.binding.userId, 'codex', f.root, { controllerMode: true });
  sessions.saveNativeId(old.id, 'old-native'); sessions.setActive(f.binding.userId, old.id);
  sessions.addMessage({ id: 'real-owner-source', userId: f.binding.userId, channelId: 'dm', text: '调查此任务', imagePaths: [] }, old.id, 'completed');
  const manager = new SessionManager(config, { codex: adapter, claude: adapter }, { async sendText(_channel, text) { publicMessages.push(text); } }, { taskRegistry: registry, mergeDelayMs: 0 });
  const worker: ControllerWorker = { id: 'worker-a', agent: 'claude', model: null, actualModel: null, effort: null, title: '用户接手的助手', cwd: f.root,
    nativeId: 'assistant-native', imagePaths: [], wakeAllowed: true, createdAt: '', updatedAt: '', ownership: 'user',
    origin: { conversationId: old.id, userId: f.binding.userId, channelId: 'dm', originMessageId: 'real-owner-source', nativeId: 'old-native', agent: 'codex', cwd: f.root } };
  try {
    assert(manager.acceptExecutorMessage(worker, { id: 'ask', workerId: 'worker-a', text: '请判断这次对齐', state: 'queued', reply: null, createdAt: '' }));
    registry.cancelConversation(old.id);
    const current = sessions.createConversation(f.binding.userId, 'claude', f.root, { controllerMode: true });
    sessions.saveNativeId(current.id, 'new-native'); sessions.setActive(f.binding.userId, current.id);
    manager.completionAvailable();
    const event = registry.completionForTask(executorTaskId('ask'))!;
    const deadline = Date.now() + 3000;
    while (registry.eventState(event.id) !== 'delivered') { assert(Date.now() < deadline); await new Promise(done => setTimeout(done, 5)); }
    assert.equal(calls.length, 1); assert.equal(calls[0]!.conversation.id, current.id);
    assert.equal(calls[0]!.event?.kind, 'executor-message'); assert.match(calls[0]!.text, /请判断这次对齐/);
    assert.equal(calls[0]!.controllerRecovery, false); assert.equal(publicMessages.length, 0);
    assert.deepEqual(interruptions, []);
    const context = JSON.parse(readFileSync(calls[0]!.taskContextPath!, 'utf8'));
    const origin = registry.getContextOrigin(context, { allowClosed: true });
    assert.equal(sessions.getMessage(origin.originMessageId)!.conversationId, current.id, 'follow-up work must bind to the new controller');
    assert.equal(sessions.getMessage(origin.originMessageId)!.replyState, 'cancelled', 'internal relay must not create an unanswered platform message');
    assert(manager.acceptExecutorMessage(null, { id: 'ordinary-cli', workerId: null, text: '用户自己开的CLI也来讨论', recipient: { scope: executorScope(f.binding.userId), userId: f.binding.userId, botId: 'bot-current', principalId: 'owner', aliases: ['Current'] }, state: 'queued', reply: null, createdAt: '' }, f.binding.userId));
    manager.completionAvailable(); const bare = registry.completionForTask(executorTaskId('ordinary-cli'))!;
    while (registry.eventState(bare.id) !== 'delivered') { assert(Date.now() < deadline); await new Promise(done => setTimeout(done, 5)); }
    assert.equal(calls.length, 2); assert.equal(publicMessages.length, 0);
  } finally { await manager.close(); sessions.close(); registry.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test('real executor RPC, bridge journal restart and /new cancellation retain a message without duplicate wakes', async t => {
  const f = setup();
  const daemon = new RemoteDaemon(f.executor, { version: 1, expectedHostname: hostname(), engines: { codex: { agentCommand: { command: process.execPath, args: [] }, defaultCwd: f.root } } }, { nativeSessionOptions: { userHome: f.userHome } });
  let controller = new ControllerStore(join(f.root, 'bridge')), registry = new TaskRegistry(join(f.root, 'tasks'));
  const sender = new ExecutorMessages(f.executor, f.userHome);
  const worker: ControllerWorker = { id: f.binding.workerId, agent: 'codex', model: null, actualModel: null, effort: null, title: f.binding.title, cwd: f.root,
    nativeId: 'native-a', imagePaths: [], wakeAllowed: true, createdAt: '', updatedAt: '', ownership: 'user',
    origin: { conversationId: 'old-parent', userId: f.binding.userId, channelId: 'dm', originMessageId: 'owner-source', nativeId: 'old-native', agent: 'codex', cwd: f.root },
    target: { id: 'station', label: '工位', transport: 'ssh', remoteRoot: f.executor, agent: 'codex', agentCommand: { command: process.execPath, args: [] }, cwd: f.root } };
  controller.addWorker(worker);
  let activeParent = 'old-parent', wakes = 0;
  const peer = new RemoteAgentAdapter({ ...worker.target!, expectedHostname: hostname() }, {
    token: '', allowedUserIds: [f.binding.userId], defaultAgent: 'codex', workspace: f.root, proxyUrl: null,
    commands: { codex: { command: process.execPath, args: [] }, claude: { command: process.execPath, args: [] } },
    dataDir: join(f.root, 'adapter'), attachmentsDir: f.root, logsDir: f.root, maxImageBytes: 100,
  }, { clientFactory: () => ({ async request<T>(method: string, args: unknown): Promise<T> {
    const endpoint = JSON.parse(readFileSync(join(f.executor, '.local/remote/endpoint.json'), 'utf8'));
    return requestRemoteHttp<T>(endpoint.port, endpoint.token, method, args);
  }, async close() {} }) });
  const make = () => new ExecutorMessenger(controller, registry, () => peer, (w, m) => {
    assert(w);
    wakes++; registry.enqueueExecutorMessage({ ...w.origin, conversationId: activeParent, nativeId: 'current-native', purpose: 'executor-message', executorMessageId: m.id, executorWorkerId: w.id }, m.id, m.text); return true;
  }, userId => userId === f.binding.userId);
  let messenger = make();
  try {
    await daemon.listen();
    await messenger.bind([worker]); sender.send(worker.id, '请主控讨论这里怎么处理', 'discussion');
    // Bridge was offline; the user starts a new controller before it receives this message.
    activeParent = 'new-parent'; await messenger.poll();
    const event = registry.completionForTask(executorTaskId('discussion'))!;
    assert.equal(event.conversationId, 'new-parent'); assert.equal(sender.get('discussion')!.state, 'accepted');
    registry.cancelConversation('new-parent'); assert.equal(registry.completionForTask(executorTaskId('discussion'))!.wakeAllowed, true);
    await messenger.poll(); assert.equal(wakes, 1);
    messenger.close(); controller.close(); registry.close();
    controller = new ControllerStore(join(f.root, 'bridge')); registry = new TaskRegistry(join(f.root, 'tasks')); messenger = make();
    await messenger.poll(); assert.equal(wakes, 1, 'durable event must not be recreated');
    assert.throws(() => sender.update(executorScope('other-owner'), 'discussion', 'handled'));
    await assert.rejects(messenger.reply('other-owner', 'discussion', '不能串线'));
    await messenger.reply(f.binding.userId, 'discussion', '沿原目标继续');
    assert.equal(sender.get('discussion')!.reply, '沿原目标继续');
    sender.send(worker.id, '请静默处理', 'quiet'); await messenger.poll();
    const quiet = registry.completionForTask(executorTaskId('quiet'))!;
    assert(registry.claimEvent(quiet.id)); registry.markDelivered(quiet.id); await messenger.poll();
    assert.equal(sender.get('quiet')!.state, 'handled'); assert.equal(sender.get('quiet')!.reply, null);
    sender.send(worker.id, '运行时中断不得自动重做', 'uncertain'); await messenger.poll();
    const uncertain = registry.completionForTask(executorTaskId('uncertain'))!; registry.claimEvent(uncertain.id); registry.markUncertain(uncertain.id, 'exit unknown');
    await messenger.poll(); assert.equal(sender.get('uncertain')!.state, 'uncertain');
    const before = wakes; await messenger.poll(); assert.equal(wakes, before);
  } finally { messenger.close(); sender.close(); controller.close(); registry.close(); await peer.close(); await daemon.close(); rmSync(f.root, { recursive: true, force: true }); }
});
