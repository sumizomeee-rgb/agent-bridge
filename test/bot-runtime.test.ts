import test, { type TestContext } from 'node:test';
import { ownTemporaryDirectory } from './temp-directory.js';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { projectRoot } from '../src/config.js';
import { BotRuntime, type BotRuntimeDependencies, type BotRuntimeHooks, type BotTransport } from '../src/bot-runtime.js';
import { SessionStore } from '../src/store.js';
import type { TaskCompletionEvent } from '../src/tasks.js';
import type { PlatformTransport } from '../src/platform.js';
import type { BridgeLifecycleEvent } from '../src/lifecycle.js';
import type { AgentAdapter, AgentTurn, BridgeConfig, IncomingDM, ReplyOptions } from '../src/types.js';
import type { DMHistoryOptions, DMHistoryPage } from '../src/ingress.js';
import { acquireInstanceLock } from '../src/instance-lock.js';

const rawUser = '234567890123456789', rawChannel = '345678901234567890';
let serial = 0;
const tick = async () => new Promise<void>(resolve => setImmediate(resolve));
async function until(check: () => boolean) { for (let n = 0; n < 3000; n++) { if (check()) return; await tick(); } assert.fail('离线启动链路没有达到预期状态'); }

class LocalTransport implements BotTransport {
  botUser = { id: '999999999999999999', username: 'Offline Bot' };
  started = 0; closed = 0; menus = 0; failStart = false; failClose = false; failMenu = false;
  lifecycle: BridgeLifecycleEvent[] = []; histories: Array<{ channel: string; options: DMHistoryOptions }> = [];
  sent: Array<{ channel: string; text: string; options?: ReplyOptions }> = []; downloads: IncomingDM[] = [];
  history: DMHistoryPage = { messages: [], oldestId: null, newestId: null, hasMore: false };
  onStart?: () => Promise<void>;
  constructor(readonly config: BridgeConfig, readonly receive: (message: IncomingDM) => Promise<void>, readonly events: ConstructorParameters<typeof PlatformTransport>[2]) {}
  async verifyIdentity() { return this.config.applicationId!; }
  async start() { this.started++; if (this.failStart) throw new Error('离线成员'); await this.onStart?.(); await this.events.onReady(); }
  async close() { this.closed++; if (this.failClose) throw new Error('传输停止结果未知'); }
  isIdle() { return true; }
  async emit(message: IncomingDM) { this.events.onReceive(message); await this.receive(message); }
  async reconnect() { await this.events.onReady(); }
  async sendText(channel: string, text: string, options?: ReplyOptions) { this.sent.push({ channel, text, options }); }
  async sendInteractionText(_interaction: NonNullable<IncomingDM['interaction']>, text: string, options?: ReplyOptions) { this.sent.push({ channel: 'interaction', text, options }); }
  async readDMHistory(channel: string, options: DMHistoryOptions = {}) { this.histories.push({ channel, options }); return this.history; }
  async readConversationHistory(): Promise<never> { throw new Error('This lifecycle fixture does not read group history'); }
  async readGroupHistory() { assert.fail('群历史不能由Bot的DM恢复入口读取'); return this.history; }
  async getGroupInfo(spaceId: string) { return { spaceId, botIsMember: true }; }
  async listGroupMembers() { return { members: [], hasMore: false, verification: 'unknown' as const }; }
  async getGroupMember(_spaceId: string, userId: string) { return { id: userId, idType: 'discord' as const, isBot: false }; }
  async readGroupMentionView(): Promise<never> { throw new Error('Discord fixture does not use scoped mention correlation'); }
  async readForwardedContent(message: IncomingDM) { return message.forwarded; }
  async downloadImages(message: IncomingDM) { this.downloads.push(message); return []; }
  async markReplyDelivered() {} async setTaskCount() {} setWorkCounts() {}
  async onBridgeLifecycle(event: BridgeLifecycleEvent) { this.lifecycle.push(event); }
  async syncSlashCommands() { this.menus++; if (this.failMenu) throw new Error('菜单权限不足'); }
  async syncGroupSlashCommands() {}
  failureText() { return '消息准备失败'; }
}
class LocalAdapter implements AgentAdapter {
  turns: AgentTurn[] = []; closed = 0; stopProof: boolean | undefined;
  constructor(readonly controller = false) {}
  async getModelInfo() { return { defaultModel: 'offline-model', models: [{ id: 'offline-model', displayName: 'Offline' }] }; }
  async run(turn: AgentTurn) {
    this.turns.push(turn); const nativeId = turn.conversation.nativeId ?? `native-${turn.conversation.id}`; turn.onNativeId?.(nativeId);
    if (this.controller && (!turn.event || turn.event.introductionRequested)) await turn.onPublicMessage?.('离线测试回复');
    return { nativeId, text: this.controller ? '' : '已核对工作区入口与固定规则', ...(this.controller ? { controlledOutput: true } : {}) };
  }
  async interrupt() {} async close() { this.closed++; }
  async confirmStopped() { return this.stopProof === true; }
}
function setup(t: TestContext, options: { root?: string; appId?: string; controller?: boolean } = {}) {
  const root = options.root ?? ownTemporaryDirectory(mkdtempSync(join(tmpdir(), 'bridge-bot-runtime-')), 'bridge-bot-runtime-');
  const appId = options.appId ?? String(123456789012345678n + BigInt(++serial));
  const prefix = `discord:${appId}|`;
  const config: BridgeConfig = { botId: `discord:${appId}`, applicationId: appId, platform: 'discord', profile: `discord/offline${serial}`, scopePrefix: prefix,
    token: 'fixture-secret', allowedUserIds: [prefix + rawUser], externalAllowedUserIds: [rawUser], ownerUserId: prefix + rawUser,
    workspace: join(root, 'workspace'), contextWorkspace: join(root, 'workspace'), workingCwd: join(root, 'workspace'),
    dataDir: join(root, 'data'), logsDir: join(root, 'logs'), attachmentsDir: join(root, 'images'),
    defaultAgent: 'codex', defaultModels: { codex: 'offline-model', claude: 'offline-model' }, controllerMode: options.controller !== false,
    proxyUrl: null, commands: { codex: { command: process.execPath, args: [] }, claude: { command: process.execPath, args: [] } }, maxImageBytes: 100 };
  mkdirSync(config.workspace, { recursive: true }); writeFileSync(join(config.workspace, 'README.md'), '# Shared fixture'); writeFileSync(join(config.workspace, 'MEMORY.md'), '# Owner rules');
  const execution = { codex: new LocalAdapter(), claude: new LocalAdapter() }, controllers = { codex: new LocalAdapter(true), claude: new LocalAdapter(true) };
  const groups: IncomingDM[] = [], initialization: string[] = [], groupCompletions: TaskCompletionEvent[] = []; let ready = 0, reconnected = 0;
  let activeController: string | null = null;
  const hooks: BotRuntimeHooks = { authorize: user => user === config.ownerUserId, receiveGroup: async message => { groups.push(message); },
    manager: { binding: { getActive: user => user === config.ownerUserId ? activeController : null, setActive(user, id) { assert.equal(user, config.ownerUserId); activeController = id; } }, onInitializationState: (_conversation, outcome) => { initialization.push(outcome); }, onGroupCompletion: async event => { groupCompletions.push(event); return 'queued'; } },
    invoke: (_turn, _name, args, _id, delegate) => delegate(args), pauseGroup() {}, resumeGroup() {},
    requestRestart: async () => ({ accepted: false }), isDraining: () => false, allowDelivery: () => true,
    isGroupChannel: channel => channel.endsWith('|456789012345678901'),
    onReady: () => { ready++; }, onReconnect: async () => { reconnected++; } };
  let transport!: LocalTransport;
  const healthReport = (workspace = config.workspace) => ({ version: 1 as const, workspace, checkedAt: '2026-10-17', stale: false, scope: 'static-prerequisites' as const, items: [], total: 0, omitted: 0 });
  let controllerInvoke!: Parameters<NonNullable<BotRuntimeDependencies['createControllerAdapters']>>[3];
  const dependencies: BotRuntimeDependencies = {
    createTransport: (selected, receive, events) => transport = new LocalTransport(selected, receive, events),
    createExecutionAdapters: () => execution, createControllerAdapters: (_config, _env, _execution, invoke) => { controllerInvoke = invoke; return controllers; },
    createTargetCatalog: () => ({
      async listTargets() { return []; }, async resolveTarget(_workspace, id, agent, cwd) { return { id, agent, label: id, transport: 'local', cwd: cwd ?? config.workspace, agentCommand: config.commands[agent] }; },
      adapterFor: binding => execution[binding.agent], async handoff() { throw new Error('unused'); }, async computerOverview() { return []; }, async close() {},
    }),
    createHealth: () => ({ async refresh(workspace) { return healthReport(workspace); }, async query() { return healthReport(); }, startupSummary: () => 'HEALTH local only' }),
  };
  const bot = new BotRuntime(config, hooks, dependencies);
  t.after(async () => { await bot.close().catch(() => {}); });
  const message = (id: string, text: string, group = false): IncomingDM => ({ id: prefix + id, userId: config.ownerUserId!, channelId: prefix + (group ? '456789012345678901' : rawChannel), text, attachments: [],
    ...(group ? { space: { kind: 'group', spaceId: '456789012345678901', mentionedUserIds: ['999999999999999999'] } } : {}) });
  return { root, config, bot, transport, execution, controllers, hooks, dependencies, groups, initialization, groupCompletions, message,
    invoke: (turn: AgentTurn, name: string, args: Record<string, unknown>, id?: string) => controllerInvoke(turn, name, args, id),
    get ready() { return ready; }, get reconnected() { return reconnected; } };
}

test('真实 BotRuntime 管理入口贯通历史与持久清单，new 保留但不派工，旧轮次不能再修改', async t => {
  const f = setup(t); await f.bot.verify(); await f.bot.start();
  const originalRun = f.controllers.codex.run.bind(f.controllers.codex);
  let savedTurn: AgentTurn | undefined, recalled = false;
  f.controllers.codex.run = async turn => {
    if (!turn.event && turn.text.includes('记住原目标')) {
      savedTurn = turn;
      await f.invoke(turn, 'bridge_update_tasks', { changes: [{ id: 'goal', expectedVersion: 0, title: '真实 Bot 路径', state: 'in_progress', nextStep: '核对后来纠正', evidenceIds: ['input:' + turn.source!.messageId] }] }, 'save');
    }
    if (!turn.event && turn.text.includes('新会话查旧目标')) {
      assert.match(turn.taskChecklist!, /真实 Bot 路径/);
      const history = await f.invoke(turn, 'bridge_search_chat_history', { query: '记住原目标' }) as { messages: unknown[] };
      assert.equal(history.messages.length, 1);
      const task = await f.invoke(turn, 'bridge_list_tasks', { id: 'goal' }) as { task: { state: string } };
      assert.equal(task.task.state, 'in_progress'); recalled = true;
    }
    return originalRun(turn);
  };
  await f.transport.emit(f.message('100000000000000001', '记住原目标'));
  await until(() => !!savedTurn && f.transport.sent.some(message => message.text.includes('离线测试回复')));
  const first = f.bot.manager.currentConversation(f.config.ownerUserId!)!.id;
  const initialized = f.initialization.length;
  await f.transport.emit(f.message('100000000000000002', '/new'));
  await until(() => f.bot.manager.currentConversation(f.config.ownerUserId!)?.id !== first && f.initialization.length > initialized);
  assert.notEqual(f.bot.manager.currentConversation(f.config.ownerUserId!)!.id, first);
  const turns = f.controllers.codex.turns.length;
  await f.transport.emit(f.message('100000000000000004', '/tasks'));
  await until(() => f.transport.sent.some(message => message.text.includes('主控任务清单') && message.text.includes('真实 Bot 路径')));
  assert.equal(f.controllers.codex.turns.length, turns, '清单斜杠查询不能唤醒主控');
  assert.throws(() => f.bot.manager.invokeKnowledge(savedTurn!, 'bridge_update_tasks', { changes: [{ id: 'goal', expectedVersion: 1, state: 'done' }] }, 'stale'), /失效/);
  await f.transport.emit(f.message('100000000000000003', '新会话查旧目标'));
  await until(() => recalled);
  assert.equal(f.execution.codex.turns.length, 0); assert.equal(f.execution.claude.turns.length, 0);
});

test('真实 BotRuntime 文件工具直接读取桥电脑，不派工且拒绝失效轮次', async t => {
  const f = setup(t); await f.bot.verify(); await f.bot.start();
  const path = join(f.config.workspace, 'quick.txt'); writeFileSync(path, '桥电脑现有资料');
  const originalRun = f.controllers.codex.run.bind(f.controllers.codex); let savedTurn: AgentTurn | undefined, checked = false;
  f.controllers.codex.run = async turn => {
    if (!turn.event && turn.text.includes('快速核对')) {
      savedTurn = turn;
      const read = await f.invoke(turn, 'bridge_read_file', { path }) as { lines: Array<{ text: string }> };
      assert.equal(read.lines[0]!.text, '桥电脑现有资料');
      const list = await f.invoke(turn, 'bridge_list_directory', { path: f.config.workspace }) as { entries: Array<{ name: string }> };
      assert(list.entries.some(item => item.name === 'quick.txt')); checked = true;
    }
    return originalRun(turn);
  };
  await f.transport.emit(f.message('100000000000000001', '快速核对'));
  await until(() => checked && f.transport.sent.some(message => message.text.includes('离线测试回复')));
  assert.equal(f.execution.codex.turns.length, 0); assert.equal(f.execution.claude.turns.length, 0);
  const first = f.bot.manager.currentConversation(f.config.ownerUserId!)!.id;
  await f.transport.emit(f.message('100000000000000002', '/new'));
  await until(() => f.bot.manager.currentConversation(f.config.ownerUserId!)?.id !== first);
  await assert.rejects(f.invoke(savedTurn!, 'bridge_read_file', { path }), /失效/);
  assert.equal(readFileSync(path, 'utf8'), '桥电脑现有资料');
});

test('转发引用到达真实主控入口，历史斜杠不重建会话或重做初始化', async t => {
  const f = setup(t); await f.bot.verify(); await f.bot.start();
  await f.transport.emit(f.message('100000000000000001', '/new'));
  await until(() => f.initialization.includes('ready'));
  const before = f.bot.manager.currentConversation(f.config.ownerUserId!)!;
  const initialized = f.execution.codex.turns.length;
  const message = { ...f.message('100000000000000002', ''), forwarded: { status: 'complete' as const, notes: [],
    messages: [{ depth: 0, text: '/new\n这是转发原文', attachments: [] }] } };
  await f.transport.emit(message);
  await until(() => f.controllers.codex.turns.some(turn => turn.text.includes('这是转发原文')));
  const after = f.bot.manager.currentConversation(f.config.ownerUserId!)!;
  assert.equal(after.id, before.id); assert.equal(after.nativeId, before.nativeId);
  assert.equal(f.execution.codex.turns.length, initialized);
  assert.equal(f.bot.ingress.getMessage(message.id)!.text, '');
  assert(f.bot.ingress.getMessage(message.id)!.forwarded);
});

test('BotRuntime requires one host-owned controller binding before opening runtime resources', t => {
  const f = setup(t);
  assert.throws(() => new BotRuntime(f.config, { ...f.hooks, manager: {} } as BotRuntimeHooks, f.dependencies), /必须使用宿主的当前主控绑定/);
  const store = new SessionStore(f.config.dataDir);
  try { assert.equal(store.getActive(f.config.ownerUserId!), null); } finally { store.close(); }
});

test('真实BotRuntime离线初始化可走通执行助手→任务结果→主控与初始化状态回调', async t => {
  const f = setup(t); await f.bot.verify(); await f.bot.start();
  assert.equal(f.bot.isReady(), true); assert.equal(f.ready, 1); assert.equal(f.transport.menus, 1);
  await f.transport.emit(f.message('100000000000000001', '/new'));
  await until(() => f.initialization.includes('ready'));
  assert.equal(f.execution.codex.turns.length, 0); assert(f.controllers.codex.turns.some(turn => turn.event?.kind === 'workspace-context'));
  assert(f.transport.sent.some(message => message.text.includes('离线测试回复')));
  await f.bot.start(); assert.equal(f.transport.started, 1); assert.equal(f.transport.menus, 1);
});

test('首次连接前seed旧DM游标，停机补取与早到实时输入按平台顺序，群不会混进DM补取或最后联系人', async t => {
  const f = setup(t); const store = new SessionStore(f.config.dataDir);
  const c = store.createConversation(f.config.ownerUserId!, 'codex', f.config.workspace, { controllerMode: true }); f.hooks.manager.binding.setActive(c.userId, c.id); store.saveNativeId(c.id, 'existing-native');
  const old = f.message('100000000000000001', '旧消息'); store.addMessage({ ...old, imagePaths: [] }, c.id, 'completed');
  const group = f.message('100000000000000002', '群消息', true);
  store.addMessage({ ...group, imagePaths: [], groupContext: { eventId: 'old-event', rootId: 'old-root', botId: f.config.botId!, spaceId: group.space!.spaceId, generation: 1, bindingEpoch: 1, principalId: 'owner', originChannelId: group.channelId, scene: 'old group' } }, c.id, 'completed'); store.close();
  const missed = f.message('100000000000000003', '停机消息'), live = f.message('100000000000000004', '实时消息');
  f.transport.history = { messages: [missed], oldestId: missed.id, newestId: missed.id, hasMore: false };
  f.transport.onStart = () => f.transport.emit(live);
  await f.bot.verify(); await f.bot.start(); await f.bot.ingress.whenIdle();
  await until(() => f.controllers.codex.turns.some(turn => turn.text.includes('实时消息')));
  assert(f.transport.histories.length > 0); assert(f.transport.histories.every(query => query.channel === old.channelId));
  const human = f.controllers.codex.turns.filter(turn => !turn.event).map(turn => turn.text);
  assert(human.join('|').indexOf('停机消息') < human.join('|').indexOf('实时消息'));
  await f.transport.emit(group); assert.equal(f.groups.length, 1);
  await Promise.all([f.bot.publishReadyLifecycle(), f.bot.publishReadyLifecycle()]); await f.transport.reconnect();
  assert.equal(f.reconnected, 1); assert.equal(f.transport.lifecycle.filter(event => event.phase === 'ready').length, 1);
  assert.equal(f.transport.lifecycle.find(event => event.phase === 'ready')!.recipient?.channelId, old.channelId);
});

test('单Bot菜单注册失败不破坏启动；离线成员自清理不阻断另一个Bot', async t => {
  const failed = setup(t), healthy = setup(t); failed.transport.failStart = true; healthy.transport.failMenu = true;
  await failed.bot.verify(); await assert.rejects(failed.bot.start(), /离线成员/);
  assert.equal(failed.bot.isReady(), false); assert.equal(failed.transport.closed, 1); assert(failed.controllers.codex.closed > 0);
  await healthy.bot.verify(); await healthy.bot.start(); assert.equal(healthy.bot.isReady(), true);
  await healthy.transport.emit(healthy.message('100000000000000001', '/status')); await healthy.bot.ingress.whenIdle();
  assert(healthy.transport.sent.length > 0); assert.match(readFileSync(join(healthy.config.logsDir, 'bridge.log'), 'utf8'), /SLASH_COMMANDS_FAILED/);
});

test('Bot身份独占锁拒绝重复实例，失败实例关闭后仍不影响原实例；正常close确认释放锁', async t => {
  const first = setup(t), duplicate = setup(t, { appId: first.config.applicationId });
  await first.bot.verify(); await assert.rejects(duplicate.bot.verify()); assert.equal(duplicate.transport.closed, 1);
  assert.equal(first.transport.closed, 0); await first.bot.start(); assert.equal(first.bot.isReady(), true);
  await first.bot.close();
  const replacement = setup(t, { appId: first.config.applicationId }); await replacement.bot.verify();
});

test('close缓存同一失败Promise并继续关闭数据库与锁，不能第二次伪报成功', async t => {
  const f = setup(t); await f.bot.verify(); f.transport.failClose = true;
  const first = f.bot.close(), second = f.bot.close(); assert.equal(first, second);
  await assert.rejects(first, /停止结果未知/); await assert.rejects(f.bot.close(), /停止结果未知/);
  assert.equal(f.transport.closed, 1); assert.throws(() => f.bot.tasks.activeCount('closed'));
  const replacement = setup(t, { appId: f.config.applicationId }); await replacement.bot.verify();
});

test('主控停止证明只接受执行适配器程序证据，没有已知会话或仅恢复数据库都保持unknown', async t => {
  const f = setup(t); const store = new SessionStore(f.config.dataDir), conversation = store.createConversation(f.config.ownerUserId!, 'codex', f.config.workspace, { controllerMode: true }); store.close();
  assert.equal(await f.bot.confirmControllerStopped(conversation.id), false); assert.equal(await f.bot.confirmControllerStopped('unknown'), false);
  f.controllers.codex.stopProof = true; assert.equal(await f.bot.confirmControllerStopped(conversation.id), true);
  await f.bot.close(); assert.equal(await f.bot.confirmControllerStopped(conversation.id), false);
});

test('实际main --check完整加载v3启动集合而不访问网络、创建运行数据或争抢项目锁', async t => {
  const root = ownTemporaryDirectory(mkdtempSync(join(tmpdir(), 'bridge-main-check-')), 'bridge-main-check-'), configPath = join(root, 'config.json');
  const profiles = join(root, 'bots', 'feishu'); mkdirSync(profiles, { recursive: true });
  for (const name of ['a', 'b']) writeFileSync(join(profiles, `${name}.json`), JSON.stringify({ applicationId: `cli_offline${name}`, appSecret: 'fake-secret-never-output', allowedUserIds: [`ou_owner${name}`], network: { proxyPort: null } }));
  const dataDir = join(root, 'data'); writeFileSync(configPath, JSON.stringify({ version: 3, startupProfiles: ['feishu/a', 'feishu/b'], workspaceRoot: join(root, 'contexts'), dataDir,
    commands: { codex: { command: process.execPath, args: [] }, claude: { command: process.execPath, args: [] } } }));
  const lock = await acquireInstanceLock(projectRoot, root); t.after(() => new Promise<void>(resolve => lock.close(() => resolve())));
  const checked = spawnSync(process.execPath, [fileURLToPath(new URL('../src/main.js', import.meta.url)), '--check', '--config', configPath],
    { encoding: 'utf8', timeout: 10_000, windowsHide: true, env: { ...process.env, HTTP_PROXY: 'http://127.0.0.1:1', HTTPS_PROXY: 'http://127.0.0.1:1' } });
  assert.equal(checked.status, 0, checked.stderr); assert.match(checked.stdout, /CONFIG_OK.*bots=2.*feishu\/a,feishu\/b/);
  assert(!checked.stdout.includes('fake-secret')); assert.equal(existsSync(dataDir), false); assert.equal(existsSync(join(root, 'contexts')), false);
});


test('真实群执行助手结果经任务回调进入Host完成入口，保留冻结来源且不伪造真人消息', async t => {
  const f = setup(t); await f.bot.verify(); await f.bot.start();
  await f.transport.emit(f.message('100000000000000001', '/new')); await until(() => f.initialization.includes('ready'));
  const input = f.message('100000000000000002', '群工作', true), c = f.bot.manager.currentConversation(f.config.ownerUserId!)!;
  const groupContext: NonNullable<AgentTurn['groupContext']> = { eventId: 'host-event', rootId: 'root', botId: f.config.botId!, spaceId: input.space!.spaceId,
    generation: 1, bindingEpoch: 1, originChannelId: input.channelId, principalId: 'owner', scene: '授权群现场' };
  await f.bot.manager.handle({ ...input, imagePaths: [], groupContext }); await until(() => f.bot.manager.isIdle());
  const created = f.bot.tasks.createContext({ conversationId: c.id, userId: c.userId, agent: c.agent, nativeId: c.nativeId, cwd: c.cwd,
    channelId: input.channelId, originMessageId: input.id, groupContext });
  await f.bot.controller!.invoke({ conversation: c, text: '原工作', imagePaths: [], groupContext, taskContextPath: created.contextPath,
    signal: new AbortController().signal, onProgress() {} }, 'bridge_start_worker', { title: '群授权调查', prompt: '保持原目标' });
  await until(() => f.groupCompletions.length === 1);
  const result = f.groupCompletions[0]!; assert.deepEqual(result.groupContext, groupContext); assert.equal(result.channelId, input.channelId);
  const inspect = new SessionStore(f.config.dataDir); try { assert.equal(inspect.getMessage(result.id), null); } finally { inspect.close(); }
});

test('旧误登记群游标不会走DM历史或附件准备，也不成为启动私聊通知目标', async t => {
  const f = setup(t); const legacy = f.message('100000000000000001', '旧群消息', true);
  f.bot.ingress.capture(legacy); await f.bot.verify(); await f.bot.start(); await f.bot.ingress.whenIdle();
  assert.equal(f.transport.histories.length, 0); assert.equal(f.transport.downloads.length, 0); assert.equal(f.controllers.codex.turns.length, 0);
  await f.bot.publishReadyLifecycle(); assert.equal(f.transport.lifecycle.find(event => event.phase === 'ready')!.recipient, undefined);
});
