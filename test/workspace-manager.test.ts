import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager } from '../src/manager.js';
import { SessionStore } from '../src/store.js';
import { ControllerRuntime } from '../src/controller/runtime.js';
import { TaskRegistry } from '../src/tasks.js';
import type { AgentAdapter, AgentResult, AgentTurn, BridgeConfig, ReplyOptions } from '../src/types.js';

async function until(check: () => boolean) {
  const end = Date.now() + 5000;
  while (!check()) { assert.ok(Date.now() < end, 'workspace flow timed out'); await new Promise(resolve => setTimeout(resolve, 5)); }
}
function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
class Children implements AgentAdapter {
  async getModelInfo() { return { defaultModel: 'gpt-6.1-sol', models: [{ id: 'gpt-6.1-sol', displayName: 'Sol', supportedEfforts: ['low', 'medium', 'high', 'xhigh'] }] }; }
  turns: AgentTurn[] = [];
  pending = new Map<string, (result: AgentResult) => void>();
  async run(turn: AgentTurn): Promise<AgentResult> {
    this.turns.push(turn); turn.onNativeId?.('child-' + turn.conversation.id); turn.onReady?.();
    return new Promise(resolve => this.pending.set(turn.conversation.id, resolve));
  }
  finish(index: number, text = JSON.stringify({ continuation: '保留用户纠正：只调查，不自动续做旧任务。' })) {
    const turn = this.turns[index]!; const resolve = this.pending.get(turn.conversation.id); assert.ok(resolve);
    this.pending.delete(turn.conversation.id); resolve({ nativeId: 'child-' + turn.conversation.id, text });
  }
  async interrupt(id: string) { const pending = this.pending.get(id); if (pending) { this.pending.delete(id); pending({ nativeId: 'child-' + id, text: 'stopped' }); } }
  async close() { for (const id of this.pending.keys()) await this.interrupt(id); }
}
class Controller implements AgentAdapter {
  turns: AgentTurn[] = [];
  hook?: (turn: AgentTurn) => Promise<void>;
  async run(turn: AgentTurn): Promise<AgentResult> {
    this.turns.push(turn); const nativeId = turn.conversation.nativeId ?? 'parent-' + turn.conversation.id;
    turn.onNativeId?.(nativeId); turn.onModel?.('gpt-6.1-sol'); turn.onReasoningEffort?.('medium');
    await this.hook?.(turn);
    if (turn.event?.introductionRequested) await turn.onPublicMessage?.('工作区介绍已送达', [], 'intro-' + turn.conversation.id);
    else if (!turn.event) await turn.onPublicMessage?.('收到：' + turn.text, [], 'reply-' + this.turns.length);
    return { nativeId, text: 'DONE', controlledOutput: true };
  }
  async interrupt() {}
  async close() {}
}
function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'bridge-workspace-flow-'));
  const shared = join(root, 'shared'); mkdirSync(shared);
  writeFileSync(join(shared, 'README.md'), '# Shared bridge rules\nRules remain verbatim.\n');
  writeFileSync(join(shared, 'MEMORY.md'), '# Memory\n- 工位派工优先 Client／Lua，流程遵循 MyHaruSkills\n- 不擅自换模型\n');
  const config: BridgeConfig = { token: '', allowedUserIds: ['owner'], defaultAgent: 'codex', workspace: shared, contextWorkspace: shared, workingCwd: shared,
    controllerMode: true, dataDir: join(root, 'data'), attachmentsDir: join(root, 'attachments'), logsDir: join(root, 'logs'), proxyUrl: null,
    commands: { codex: { command: 'fake', args: [] }, claude: { command: 'fake', args: [] } }, maxImageBytes: 1024 };
  const registry = new TaskRegistry(config.dataDir), children = new Children(), controller = new Controller(), inspect = new SessionStore(config.dataDir);
  const replies: Array<{ text: string; channel: string }> = [], errors: unknown[] = [], states: string[] = [];
  let paused = false, now = Date.now(), failIntro = false;
  let manager: SessionManager, runtime: ControllerRuntime;
  const makeRuntime = () => new ControllerRuntime(config, { codex: children, claude: children }, registry, {
    onCompletion: () => { if (!paused) manager.completionAvailable(); }, onError: error => { errors.push(error); }, now: () => now, pollIntervalMs: 60000 });
  const makeManager = () => new SessionManager(config, { codex: controller, claude: controller }, {
    sendText: async (channel, text, _options?: ReplyOptions) => { if (failIntro && text.includes('工作区介绍已送达')) throw new Error('delivery unknown'); replies.push({ channel, text }); },
  }, { mergeDelayMs: 0, taskRegistry: registry,
    onInitializeWorkspace: turn => runtime.initializeWorkspace(turn), onInitializationError: (_c, error) => { errors.push(error); },
    onInitializationState: (_c, state) => { states.push(state); },
    onDetach: id => runtime.detachConversation(id), onStop: id => runtime.cancelConversation(id) });
  runtime = makeRuntime(); manager = makeManager();
  const f = { root, shared, config, registry, children, controller, inspect, replies, errors, states,
    get manager() { return manager; }, get runtime() { return runtime; },
    send: (id: string, text: string, userId = 'owner', channelId = 'dm') => manager.handle({ id, text, userId, channelId, imagePaths: [] }),
    pause(value = true) { paused = value; if (!value) manager.completionAvailable(); }, failIntro() { failIntro = true; },
    async ready() { await until(() => manager.isIdle() && states.includes('ready')); },
    advance(ms: number) { now += ms; },
    async restart() { await manager.close(); await runtime.close(); runtime = makeRuntime(); manager = makeManager(); await manager.recover(); await runtime.start(); },
  };
  t.after(async () => { await manager.close(); await runtime.close(); inspect.close(); registry.close(); rmSync(root, { recursive: true, force: true }); });
  return f;
}

test('普通 /new 直接载入文档，无初始化助手、无执行计数，介绍只发一次', async t => {
  const f = fixture(t); await f.send('new', '/new'); await f.ready();
  assert.equal(f.children.turns.length, 0); assert.equal(f.runtime.store.workers().length, 0);
  assert.equal(f.registry.activeCount(f.inspect.getActive('owner')!.id), 0);
  assert.equal(f.controller.turns.filter(turn => turn.event?.kind === 'workspace-context').length, 1);
  assert.equal(f.replies.filter(reply => reply.text.includes('工作区介绍已送达')).length, 1);
  await f.restart(); await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(f.children.turns.length, 0); assert.equal(f.replies.filter(reply => reply.text.includes('工作区介绍已送达')).length, 1);
});
test('首条普通消息及图片继续同一原生父，不把用户请求转交初始化助手', async t => {
  const f = fixture(t); await f.send('hello', '普通用户问题'); await f.ready();
  const parent = f.inspect.getActive('owner')!; await f.send('again', '继续问题'); await until(() => f.manager.isIdle());
  assert.equal(f.children.turns.length, 0); assert.equal(f.inspect.getActive('owner')!.nativeId, parent.nativeId);
  assert.deepEqual(f.controller.turns.filter(turn => !turn.event).map(turn => turn.text), ['普通用户问题', '继续问题']);
});
for (const argument of ['c', 'continue']) test(`/new ${argument} 只派一个历史助手，不让它压缩工作区规则`, async t => {
  const f = fixture(t); await f.send('old', '旧目标：只调查，不能重装'); await f.ready();
  const before = f.inspect.getActive('owner')!; await f.send('new', '/new ' + argument); await until(() => f.children.turns.length === 1);
  const parent = f.inspect.getActive('owner')!, child = f.children.turns[0]!;
  assert.notEqual(parent.id, before.id); assert.match(child.text, /只读桥提供的旧会话材料/);
  assert.match(child.text, /README.md 与 MEMORY.md 由桥原文载入/); assert.doesNotMatch(child.text, /目标600–800/);
  assert.deepEqual(child.imagePaths, []); assert.equal(child.taskContextPath, undefined);
  const source = JSON.parse(readFileSync(join(f.config.dataDir, 'session-handoffs', parent.id, 'source.json'), 'utf8'));
  assert.ok(source.messages.some((m: { text: string }) => m.text.includes('不能重装')));
  f.children.finish(0); await until(() => f.manager.isIdle() && f.inspect.workspaceNotice(parent.id)?.state === 'delivered');
  assert.equal(f.runtime.store.workers().length, 1); assert.equal(f.children.turns.length, 1);
  assert.ok(f.controller.turns.some(turn => turn.conversation.id === parent.id && turn.event?.text.includes('只调查')));
  await f.restart(); await new Promise(resolve => setTimeout(resolve, 25)); assert.equal(f.children.turns.length, 1);
});
test('没有旧父会话时拒绝 /new c，不新建或启动助手', async t => {
  const f = fixture(t); await f.send('new', '/new c'); assert.equal(f.inspect.getActive('owner'), null); assert.equal(f.children.turns.length, 0);
});
test('普通 /new 不需要默认助手可用，远端默认未设置也能载入规则', async t => {
  const f = fixture(t); f.runtime.store.setWorkerDefault('local', { kind: 'preset', presetId: 'unavailable', effort: null });
  await f.send('new', '/new'); await f.ready(); assert.equal(f.children.turns.length, 0); assert.deepEqual(f.errors, []);
});
test('缺失 Memory 明确报告未完整载入，不运行 LLM 补造、不反复重试', async t => {
  const f = fixture(t); unlinkSync(join(f.shared, 'MEMORY.md')); await f.send('new', '/new'); await until(() => f.manager.isIdle());
  assert.equal(f.children.turns.length, 0); assert.ok(!f.states.includes('ready'));
  assert.ok(f.controller.turns.some(turn => turn.event?.text.includes('MEMORY.md')));
  const count = f.controller.turns.filter(turn => turn.event?.kind === 'workspace-context').length;
  await f.send('next', '正常继续'); await until(() => f.manager.isIdle());
  assert.equal(f.controller.turns.filter(turn => turn.event?.kind === 'workspace-context').length, count);
});
test('旧父载入尚未完成时切换，新父不接受旧介绍或迟到载入结果', async t => {
  const f = fixture(t); let first = true;
  f.controller.hook = turn => {
    if (!first || turn.event?.kind !== 'workspace-context') return Promise.resolve();
    first = false;
    return new Promise<void>(resolve => turn.signal.addEventListener('abort', () => resolve(), { once: true }));
  };
  await f.send('first', '/new'); await until(() => f.controller.turns.length === 1);
  const previous = f.inspect.getActive('owner')!; await f.send('second', '/new'); await f.ready();
  const current = f.inspect.getActive('owner')!; assert.notEqual(current.id, previous.id);
  assert.equal(f.controller.turns.filter(turn => turn.conversation.id === current.id).length, 1);
  assert.equal(f.replies.filter(reply => reply.text.includes('工作区介绍已送达')).length, 1); assert.equal(f.children.turns.length, 0);
});

test('真实用户消息在载入介绍执行期间到达，串行续接同一父会话', async t => {
  const f = fixture(t), g = gate(); f.controller.hook = turn => turn.event?.kind === 'workspace-context' ? g.promise : Promise.resolve();
  await f.send('new', '/new'); await until(() => f.controller.turns.length === 1);
  await f.send('question', '我现在问的问题'); g.release(); await f.ready();
  assert.equal(f.controller.turns.filter(turn => !turn.event).length, 1);
  assert.equal(new Set(f.controller.turns.map(turn => turn.conversation.id)).size, 1); assert.equal(f.children.turns.length, 0);
});
test('介绍投递未知不自动重发或重新运行主控，重启保留未知事实', async t => {
  const f = fixture(t); f.failIntro(); await f.send('new', '/new'); await until(() => f.manager.isIdle());
  const attempts = f.controller.turns.length; await f.restart(); await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(f.controller.turns.length, attempts); assert.equal(f.children.turns.length, 0);
});
test('主动 /cwd 选择工程目录后，/new 与 /new c 都保留它，规则仍来自共享工作区', async t => {
  const f = fixture(t), project = join(f.root, 'project'); mkdirSync(project);
  await f.send('cwd', '/cwd ' + project); await f.ready(); assert.equal(f.inspect.getActive('owner')!.cwdExplicit, true);
  await f.send('new', '/new'); await until(() => f.manager.isIdle()); assert.equal(f.inspect.getActive('owner')!.cwd, project);
  await f.send('continue', '/new c'); await until(() => f.children.turns.length === 1);
  assert.equal(f.inspect.getActive('owner')!.cwd, project); assert.equal(f.children.turns[0]!.conversation.cwd, f.shared);
  f.children.finish(0); await until(() => f.manager.isIdle());
});
for (const command of ['/new', '/new c']) for (const explicit of [false, true]) test(`统一工作区后旧默认目录迁移，明确 /cwd 的旧路径保留：${command} explicit=${explicit}`, async t => {
  const f = fixture(t), legacy = join(f.root, 'legacy'); mkdirSync(legacy); f.config.legacyWorkspace = legacy;
  const old = f.inspect.createConversation('owner', 'codex', legacy, { controllerMode: true, cwdExplicit: explicit }); f.inspect.setActive('owner', old.id); f.inspect.setModel(old.id, 'gpt-6.1-sol');
  await f.send('new', command);
  if (command === '/new c') { await until(() => f.children.turns.length === 1); f.children.finish(0); }
  await f.ready();
  assert.equal(f.inspect.getActive('owner')!.cwd, explicit ? legacy : f.shared);
  assert.equal(f.inspect.getConversation(old.id)!.cwd, legacy, 'historical session remains unchanged');
});
test('未登记用户不能读取共享规则或启动历史续接', async t => {
  const f = fixture(t); await f.send('bad', '/new c', 'stranger'); assert.equal(f.children.turns.length, 0); assert.equal(f.controller.turns.length, 0);
});
test('不同入口的历史回执不能作为当前父会话的载入证明', async t => {
  const f = fixture(t); await f.send('old', '旧问题'); await f.ready(); await f.send('new', '/new continue'); await until(() => f.children.turns.length === 1);
  const parent = f.inspect.getActive('owner')!; f.children.finish(0); await until(() => f.manager.isIdle());
  const source = f.runtime.store.jobs().find(job => job.origin.conversationId === parent.id)!;
  assert.equal(source.origin.channelId, 'dm'); assert.ok(f.replies.every(reply => reply.channel === 'dm'));
});
for (const command of ['/new', '/new c', '/cwd']) test(`${command} 取消旧定时，已结束普通任务不会被自动重派`, async t => {
  const f = fixture(t); await f.send('old', '旧问题'); await f.ready(); const old = f.inspect.getActive('owner')!;
  const c = f.registry.createContext({ conversationId: old.id, userId: 'owner', channelId: 'dm', originMessageId: 'old', agent: old.agent, nativeId: old.nativeId, cwd: old.cwd });
  const turn: AgentTurn = { conversation: old, taskContextPath: c.contextPath, text: '', imagePaths: [], signal: new AbortController().signal, onProgress() {} };
  await f.runtime.invoke(turn, 'bridge_schedule_controller', { afterSeconds: 60, text: '不能复活的旧提醒' }); f.registry.closeContext(c.contextId);
  await f.send('reset', command === '/cwd' ? '/cwd ' + f.shared : command);
  if (command === '/new c') { await until(() => f.children.turns.length === 1); f.children.finish(0); }
  await until(() => f.manager.isIdle()); f.advance(120000); await f.runtime.poll();
  assert.equal(f.runtime.store.schedules()[0]!.status, 'cancelled'); assert.equal(f.children.turns.length, command === '/new c' ? 1 : 0);
});
test('新旧目录重启后保留 cwdExplicit，不因配置迁移覆盖用户指定工程', async t => {
  const f = fixture(t), legacy = join(f.root, 'legacy'); mkdirSync(legacy); f.config.legacyWorkspace = legacy;
  await f.send('cwd', '/cwd ' + legacy); await f.ready(); await f.restart(); await f.send('new', '/new'); await until(() => f.manager.isIdle());
  assert.equal(f.inspect.getActive('owner')!.cwd, legacy); assert.equal(f.inspect.getActive('owner')!.cwdExplicit, true);
});
