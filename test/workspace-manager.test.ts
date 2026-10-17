import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import { SessionManager } from '../src/manager.js';
import { SessionStore } from '../src/store.js';
import { ControllerRuntime } from '../src/controller/runtime.js';
import { SessionHandoffs } from '../src/controller/handoff.js';
import type { WorkCounts } from '../src/overview.js';
import { TaskRegistry, type TaskContextFile } from '../src/tasks.js';
import type { AgentAdapter, AgentResult, AgentTurn, BridgeConfig, ReplyOptions } from '../src/types.js';

class Children implements AgentAdapter {
  async getModelInfo() { return { source: 'offline-fixture', defaultModel: 'gpt-6.1-sol', models: [
    { id: 'gpt-6.1-sol', displayName: 'Fixture', supportedEfforts: ['medium'] },
  ] }; }
  readonly turns: AgentTurn[] = [];
  onRun?: (turn: AgentTurn) => void;
  readonly pending = new Map<string, { resolve: (value: AgentResult) => void; reject: (error: Error) => void }>();
  async run(turn: AgentTurn): Promise<AgentResult> {
    this.turns.push(turn); turn.onNativeId?.(`child-native-${turn.conversation.id}`);
    const result = new Promise<AgentResult>((resolve, reject) => { this.pending.set(turn.conversation.id, { resolve, reject }); });
    this.onRun?.(turn);
    return result;
  }
  finish(index: number, text = '已只读核对本机导航；Chrome 登录状态按 README 声明，未实际打开浏览器。'): void {
    const turn = this.turns[index]!; const result = this.pending.get(turn.conversation.id)!;
    this.pending.delete(turn.conversation.id); result.resolve({ nativeId: `child-native-${turn.conversation.id}`, text });
  }
  fail(index: number): void {
    const turn = this.turns[index]!; const result = this.pending.get(turn.conversation.id)!;
    this.pending.delete(turn.conversation.id); result.reject(new Error('workspace read denied'));
  }
  async interrupt(id: string): Promise<void> { this.pending.get(id)?.reject(new Error('child process stopped')); this.pending.delete(id); }
  async close(): Promise<void> { for (const id of this.pending.keys()) await this.interrupt(id); }
}

class Controller implements AgentAdapter {
  readonly turns: AgentTurn[] = [];
  readonly facts = new Map<string, string>();
  readonly gates = new Map<string, { promise: Promise<void>; release: () => void }>();
  uncontrolledContext = false;
  contextResultText = 'UNSOLICITED_FALLBACK';
  contextHook?: (turn: AgentTurn) => Promise<void>;
  replyText?: (turn: AgentTurn) => string;
  hook?: (turn: AgentTurn) => Promise<void>;
  hold(text: string): () => void {
    let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; });
    this.gates.set(text, { promise, release }); return release;
  }
  async run(turn: AgentTurn): Promise<AgentResult> {
    this.turns.push(turn);
    const nativeId = turn.conversation.nativeId ?? `parent-native-${turn.conversation.id}`;
    turn.onNativeId?.(nativeId); turn.onModel?.('gpt-6.1-sol'); turn.onReasoningEffort?.('medium');
    if (turn.event?.kind === 'workspace-context') {
      this.facts.set(nativeId, turn.event.text);
      await this.contextHook?.(turn);
      if (turn.event.introductionRequested && !this.uncontrolledContext) await turn.onPublicMessage?.(`你好，我是这个工作区的主控。我已了解入口文档，会依据已确认的能力协助你；实际模型与远端状态仍以运行结果为准。（会话 ${turn.conversation.id.slice(0, 8)}）`, [], `introduction-${turn.conversation.id}`);
      return { nativeId, text: this.uncontrolledContext ? this.contextResultText : 'DONE', controlledOutput: !this.uncontrolledContext };
    }
    await this.gates.get(turn.text)?.promise;
    await this.hook?.(turn);
    await turn.onPublicMessage?.(turn.event ? '普通任务结果。' : this.replyText?.(turn) ?? `收到：${turn.text}`, [], `public-${this.turns.length}`);
    return { nativeId, text: 'DONE', controlledOutput: true };
  }
  async interrupt(): Promise<void> { for (const gate of this.gates.values()) gate.release(); }
  async close(): Promise<void> { await this.interrupt(); }
}

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error('workspace manager test timed out'); await delay(5); }
}

function fixture(t: TestContext, controllerMode = true) {
  const root = mkdtempSync(join(tmpdir(), 'bridge-workspace-manager-'));
  const config: BridgeConfig = { token: '', allowedUserIds: ['user'], defaultAgent: 'codex', workspace: root,
    controllerMode, proxyUrl: null, commands: { codex: { command: 'fake', args: [] }, claude: { command: 'fake', args: [] } },
    dataDir: join(root, 'data'), attachmentsDir: join(root, 'images'), logsDir: join(root, 'logs'), maxImageBytes: 1024 };
  const registry = new TaskRegistry(join(root, 'tasks'));
  const children = new Children(); const controller = new Controller();
  const replies: Array<{ text: string; options?: ReplyOptions; channelId: string }> = [];
  const delivery: { beforeSend?: (channel: string, text: string, options?: ReplyOptions) => Promise<void>; failNotice?: boolean; noticeAttempts: number } = { noticeAttempts: 0 };
  let pauseCompletions = false;
  const counts: Array<{ id: string; count: number }> = [];
  const workCounts: WorkCounts[] = [];
  const initializations: AgentTurn[] = []; const errors: unknown[] = []; const initializationStates: string[] = [];
  let manager!: SessionManager; let runtime!: ControllerRuntime;
  const callbacks = { onCompletion: () => { if (!pauseCompletions) manager.completionAvailable(); },
    onCountChanged: (id: string) => manager.refreshTaskCounts(id), onWorkCountsChanged: (counts: WorkCounts) => { workCounts.push({ ...counts }); },
    onError: (error: unknown) => errors.push(error), pollIntervalMs: 60000 };
  const makeRuntime = () => new ControllerRuntime(config, { codex: children, claude: children }, registry, callbacks);
  const makeManager = () => new SessionManager(config, { codex: controller, claude: controller }, {
    async sendText(channelId, text, options) {
      const pending = delivery.beforeSend?.(channelId, text, options);
      if (pending) {
        let abort: (() => void) | undefined;
        try { await (options?.signal ? Promise.race([pending, new Promise<never>((_resolve, reject) => {
          abort = () => reject(new Error('send aborted')); options.signal!.addEventListener('abort', abort, { once: true });
          if (options.signal!.aborted) abort();
        })]) : pending); } finally { if (abort) options?.signal?.removeEventListener('abort', abort); }
      }
      if (options?.signal?.aborted) throw new Error('send aborted');
      if ((/^[✅⚠️]/u.test(text) || text.includes('你好，我是这个工作区的主控')) && text.includes('（会话 ')) {
        delivery.noticeAttempts++; if (delivery.failNotice) throw new Error('notification transport uncertain');
      }
      replies.push({ text, options, channelId });
    },
    async setTaskCount(message, count) { counts.push({ id: message.id, count }); },
  }, { mergeDelayMs: 0, taskRegistry: registry,
    onInitializeWorkspace: turn => { initializations.push(turn); return runtime.initializeWorkspace(turn); },
    onInitializationError: (_conversation, error) => errors.push(error),
    onInitializationState: (_conversation, outcome) => { initializationStates.push(outcome); },
    onPrepareSwitch: (source, target, channel, prompt, signal) => runtime.prepareAgentSwitch(source, target, channel, prompt, signal),
    onRebindSwitch: (source, target) => runtime.rebindConversation(source, target),
    onPauseSwitch: source => runtime.pauseConversation(source.id), onResumeSwitch: source => runtime.resumeConversation(source.id),
    onDetach: id => runtime.detachConversation(id), onStop: id => runtime.cancelConversation(id) });
  runtime = makeRuntime(); manager = makeManager();
  const inspect = new SessionStore(config.dataDir);
  const f = { root, config, registry, children, controller, replies, counts, workCounts, initializations, initializationStates, errors, inspect,
    get manager() { return manager; }, get runtime() { return runtime; }, delivery,
    pauseCompletions: () => { pauseCompletions = true; },
    send: (id: string, text: string, imagePaths: string[] = []) => manager.handle({ id, text, imagePaths, userId: 'user', channelId: 'dm' }),
    async restart() { await manager.close(); await runtime.close(); runtime = makeRuntime(); manager = makeManager(); await manager.recover(); await runtime.start(); },
  };
  t.after(async () => {
    await manager.close(); await runtime.close(); inspect.close(); registry.close();
    assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert(basename(root).startsWith('bridge-workspace-manager-'));
    rmSync(root, { recursive: true, force: true });
  });
  return f;
}

for (const resetCommand of ['/new', '/new continue']) {
test(`${resetCommand} cancels both plan kinds and stops a launched scheduled agent before initializing the new controller`, async t => {
  const f = fixture(t);
  f.controller.hook = async turn => {
    if (turn.text !== '安排后续') return;
    await f.runtime.invoke(turn, 'bridge_schedule_worker', { afterSeconds: 60, title: '已启动的定时任务', prompt: '核对' });
    await f.runtime.invoke(turn, 'bridge_schedule_worker', { afterSeconds: 120, title: '尚未触发', prompt: '以后核对' });
    await f.runtime.invoke(turn, 'bridge_schedule_controller', { afterSeconds: 120, text: '以后提醒' });
  };
  await f.send('schedule-source', '安排后续');
  await until(() => f.runtime.store.schedules().length === 3 && f.children.turns.length === 1 && f.inspect.getMessage('schedule-source')?.state === 'completed');
  f.children.finish(0); await until(() => f.controller.turns.some(turn => turn.event?.kind === 'workspace-context') && f.registry.queuedEvents().length === 0);
  const original = f.inspect.getActive('user')!;
  const plan = f.runtime.store.schedules().find(value => value.title === '已启动的定时任务')!;
  plan.dueAt = new Date(Date.now()-1000).toISOString(); f.runtime.store.saveSchedule(plan);
  await f.runtime.poll(); await until(() => f.children.turns.length === 2);
  const interrupt = f.children.interrupt.bind(f.children);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  f.children.interrupt = async id => { if (id === plan.worker!.id) await gate; await interrupt(id); };
  const resetting = f.send('reset-plans', resetCommand);
  await until(() => !!f.runtime.store.getJob(plan.job!.id)?.cancelReason);
  assert.equal(f.inspect.getActive('user')!.id, original.id);
  assert.ok(!f.replies.some(reply => reply.text.includes('新会话已创建')));
  await f.send('during-reset', '新会话继续这个问题');
  release(); await resetting; f.children.interrupt = interrupt;
  await until(() => f.children.turns.length === 3);
  assert.notEqual(f.inspect.getActive('user')!.id, original.id);
  assert.equal(f.children.pending.has(plan.worker!.id), false, 'scheduled process has exited before new initialization starts');
  assert.ok(f.runtime.store.schedules().every(value => value.status === 'cancelled'));
  for (const value of f.runtime.store.schedules()) { value.dueAt = new Date(Date.now()-1000).toISOString(); f.runtime.store.saveSchedule(value); }
  await f.runtime.poll();
  f.children.finish(2, resetCommand.includes('continue') ? JSON.stringify({ workspaceContext: '本机工作区', continuation: '旧定时已取消，真实消息在新会话继续。' }) : undefined);
  await until(() => f.controller.turns.filter(turn => turn.event?.kind === 'workspace-context').length === 2 && f.registry.queuedEvents().length === 0);
  assert.equal(f.controller.turns.filter(turn => ['wake', 'worker-result'].includes(turn.event?.kind ?? '')).length, 0);
  assert.equal(f.children.turns.length, 3, 'cancelled plans never launch later');
  await until(() => f.controller.turns.some(turn => turn.text === '新会话继续这个问题'));
  assert.equal(f.inspect.getMessage('during-reset')!.conversationId, f.inspect.getActive('user')!.id);
});

test(`${resetCommand} reports unconfirmed scheduled process termination and does not activate a new controller`, async t => {
  const f = fixture(t);
  f.controller.hook = async turn => {
    if (turn.text === '定时核查') await f.runtime.invoke(turn, 'bridge_schedule_worker', { afterSeconds: 60, title: '定时核查', prompt: '核对' });
  };
  await f.send('plan-source', '定时核查');
  await until(() => f.runtime.store.schedules().length === 1 && f.children.turns.length === 1 && f.inspect.getMessage('plan-source')?.state === 'completed');
  f.children.finish(0); await until(() => f.controller.turns.some(turn => turn.event?.kind === 'workspace-context') && f.registry.queuedEvents().length === 0);
  const original = f.inspect.getActive('user')!;
  const plan = f.runtime.store.schedules()[0]!; plan.dueAt = new Date(Date.now()-1000).toISOString(); f.runtime.store.saveSchedule(plan);
  await f.runtime.poll(); await until(() => f.children.turns.length === 2);
  const interrupt = f.children.interrupt.bind(f.children);
  f.children.interrupt = async id => {
    const error = Object.assign(new Error('termination unconfirmed'), { name: 'AgentProcessStopError', processStillRunning: true });
    f.children.pending.get(id)?.reject(error); f.children.pending.delete(id); throw error;
  };
  await f.send('failed-reset', resetCommand);
  await until(() => f.replies.some(reply => reply.text.includes('不能宣称全部停止')));
  assert.equal(f.inspect.getActive('user')!.id, original.id); assert.equal(f.children.turns.length, 2);
  assert.equal(f.runtime.store.getSchedule(plan.id)!.status, 'uncertain');
  f.children.interrupt = interrupt;
});
}

test('a scheduled result can immediately continue the same child while its completed run is settling', async t => {
  const f = fixture(t); let workerId = '', followed = false;
  f.controller.hook = async turn => {
    if (turn.text === '定时跟进') {
      const handle = await f.runtime.invoke(turn, 'bridge_schedule_worker', { afterSeconds: 60, title: '定时跟进', prompt: '核查' }) as { workerId: string };
      workerId = handle.workerId;
    } else if (turn.event?.kind === 'worker-result' && !followed) {
      followed = true;
      await f.runtime.invoke(turn, 'bridge_continue_worker', { workerId, prompt: '核实相关细节' });
    }
  };
  await f.send('follow-source', '定时跟进');
  await until(() => f.runtime.store.schedules().length === 1 && f.children.turns.length === 1 && f.inspect.getMessage('follow-source')?.state === 'completed');
  f.children.finish(0); await until(() => f.controller.turns.some(turn => turn.event?.kind === 'workspace-context') && f.registry.queuedEvents().length === 0);
  const plan = f.runtime.store.schedules()[0]!; plan.dueAt = new Date(Date.now()-1000).toISOString(); f.runtime.store.saveSchedule(plan);
  await f.runtime.poll(); await until(() => f.children.turns.length === 2);
  f.children.finish(1); await until(() => followed && f.children.turns.length === 3);
  assert.equal(f.children.turns[2]!.conversation.id, workerId);
  f.children.finish(2); await until(() => f.controller.turns.filter(turn => turn.event?.kind === 'worker-result').length === 2 && f.registry.queuedEvents().length === 0);
});

test('首条普通消息并行派只读初始化，真实任务计数且不改写用户文字或图片', async t => {
  const f = fixture(t); const image = join(f.root, 'user-picture.png');
  await f.send('first', 'USER_TEXT_IS_NOT_INITIALIZATION', [image]);
  await until(() => f.children.turns.length === 1 && f.controller.turns.length === 1 && f.replies.length === 1);
  assert.equal(f.initializations.length, 1);
  assert.equal(f.initializations[0]!.text, ''); assert.deepEqual(f.initializations[0]!.input, []);
  assert.deepEqual(f.initializations[0]!.imagePaths, []);
  assert.equal(f.controller.turns[0]!.text, 'USER_TEXT_IS_NOT_INITIALIZATION');
  assert.deepEqual(f.controller.turns[0]!.imagePaths, [image]);
  assert(!f.children.turns[0]!.text.includes('USER_TEXT_IS_NOT_INITIALIZATION'));
  assert.deepEqual(f.children.turns[0]!.imagePaths, []);
  const parent = f.inspect.getActive('user')!;
  assert.equal(f.registry.activeCount(parent.id), 1);
  await until(() => f.workCounts.at(-1)?.running === 1);
  assert.deepEqual(f.runtime.getGlobalWorkCounts(), { running: 1, queued: 0 });
  assert.deepEqual(f.counts, [], '初始化数量由全桥状态回报，不向原消息发送数字表情');
  await f.send('second', '我继续聊天');
  await until(() => f.replies.length === 2);
  assert.equal(f.children.turns.length, 1, '同一会话不重复调查');
  assert.equal(f.registry.activeCount(parent.id), 1, '聊天不等初始化完成');
  f.children.finish(0);
  await until(() => f.controller.turns.length === 3 && f.registry.queuedEvents().length === 0);
  const delivered = f.controller.turns[2]!;
  assert.equal(delivered.event?.kind, 'workspace-context');
  assert.equal(delivered.event?.toolName, 'bridge_workspace_context');
  assert.equal(delivered.conversation.nativeId, parent.nativeId);
  assert.equal(f.replies.length, 2, '自动调研完成不公开刷消息');
  await until(() => f.workCounts.at(-1)?.running === 0 && f.workCounts.at(-1)?.queued === 0);
  assert.deepEqual(f.runtime.getGlobalWorkCounts(), { running: 0, queued: 0 });
  assert.equal(f.registry.activeCount(parent.id), 0, '初始化完成后登记数量真实归零');
  assert.deepEqual(f.counts, [], '归零也不修改原消息数字表情');
  assert.deepEqual(f.errors, []);
});

test('用户本机初始化入口通过独立事件载入；/new 重读、/cwd 只换执行目录、续聊去重（模拟只读子 Agent）', async t => {
  const f = fixture(t);
  const other = join(f.root, 'other'); mkdirSync(other);
  writeFileSync(join(f.root, 'README.md'), '初始化入口：context-a.md\n回传要求：只返回指定文件的执行规范。');
  writeFileSync(join(f.root, 'context-a.md'), 'WORKSPACE_POLICY_A');
  writeFileSync(join(other, 'README.md'), '初始化入口：context-b.md\n回传要求：只返回指定文件的执行规范。');
  writeFileSync(join(other, 'context-b.md'), 'WORKSPACE_POLICY_B');
  const reads: string[] = [];
  // Simulate the child's read tools; the bridge supplies a generic entry contract, not a file parser.
  f.children.onRun = turn => {
    assert.match(turn.text, /遵循其中定义的初始化入口、只读范围和回传要求/);
    assert(!/WORKSPACE_POLICY_[AB]/.test(turn.text));
    const cwd = turn.conversation.cwd;
    const guide = readFileSync(join(cwd, 'README.md'), 'utf8');
    const entry = guide.match(/初始化入口：([^\r\n]+)/)![1]!;
    const selected = join(cwd, entry); reads.push(selected);
    f.children.finish(f.children.turns.indexOf(turn), readFileSync(selected, 'utf8'));
  };
  await f.send('new-a', '/new'); await until(() => f.controller.turns.length === 1);
  assert.equal(f.controller.turns[0]!.event?.kind, 'workspace-context');
  assert.match(f.controller.turns[0]!.event!.text, /WORKSPACE_POLICY_A/);
  await f.send('human', 'SIMPLE_HUMAN_REQUEST'); await until(() => f.controller.turns.length === 2);
  assert.equal(f.controller.turns[1]!.text, 'SIMPLE_HUMAN_REQUEST');
  assert.equal(reads.length, 1);
  writeFileSync(join(f.root, 'context-a.md'), 'WORKSPACE_POLICY_A_UPDATED');
  await f.send('new-a-again', '/new'); await until(() => f.controller.turns.length === 3);
  assert.match(f.controller.turns[2]!.event!.text, /WORKSPACE_POLICY_A_UPDATED/);
  await f.send('cwd-b', `/cwd "${other}"`); await until(() => f.controller.turns.length === 4);
  assert.match(f.controller.turns[3]!.event!.text, /WORKSPACE_POLICY_A_UPDATED/);
  assert.equal(f.inspect.getActive('user')!.cwd, other);
  assert.deepEqual(reads, [join(f.root, 'context-a.md'), join(f.root, 'context-a.md'), join(f.root, 'context-a.md')]);
  assert.equal(f.runtime.store.workers().length, 3);
  assert.deepEqual(f.errors, []);
});

test('/new 立即派背景任务；载入主控后只发送一次桥回执，不公开模型 fallback', async t => {
  const f = fixture(t);
  await f.send('new', '/new');
  await until(() => f.children.turns.length === 1);
  assert.equal(f.controller.turns.length, 0);
  assert.equal(f.inspect.getMessage('new')?.conversationId, null);
  assert.equal(f.initializations[0]!.conversation.nativeId, null);
  const parent = f.inspect.getActive('user')!;
  await until(() => f.workCounts.at(-1)?.running === 1);
  assert.equal(f.registry.activeCount(parent.id), 1, '/new 的初始化真实登记为运行子任务');
  assert.deepEqual(f.runtime.getGlobalWorkCounts(), { running: 1, queued: 0 });
  assert.deepEqual(f.counts, [], '/new 不发送数字表情计数');
  f.controller.uncontrolledContext = true;
  f.children.finish(0);
  await until(() => f.controller.turns.length === 1 && f.inspect.getActive('user')!.nativeId !== null);
  const native = f.inspect.getActive('user')!.nativeId;
  assert.equal(f.controller.turns[0]!.event?.kind, 'workspace-context');
  assert.equal(f.controller.turns[0]!.conversation.nativeId, null);
  assert.equal(f.controller.turns[0]!.taskContextPath, undefined, '未有真实 human 时不给初始化回执额外派工能力');
  await until(() => f.inspect.workspaceNotice(parent.id)?.state === 'delivered');
  assert.equal(f.replies.length, 2, '原命令确认与一条桥回执，模型 fallback 保持静默');
  assert.match(f.replies[1]!.text, /主控没有完成介绍/);
  assert(!f.replies.some(item => /UNSOLICITED|看看/.test(item.text)));
  await f.send('hello', '你好'); await until(() => f.controller.turns.length === 2 && f.replies.length === 3);
  assert.equal(f.controller.turns[1]!.conversation.nativeId, native);
  assert.equal(f.controller.turns[1]!.text, '你好');
  assert.equal(f.children.turns.length, 1);
  await until(() => f.workCounts.at(-1)?.running === 0 && f.workCounts.at(-1)?.queued === 0);
  assert.deepEqual(f.runtime.getGlobalWorkCounts(), { running: 0, queued: 0 });
  assert.equal(f.registry.activeCount(parent.id), 0, '/new 初始化回传后登记数量真实归零');
  assert.deepEqual(f.counts, []);
});

test('相关真实问题先获临时答复，初始化回执仅通过显式发送补答一次且仍属同原生父', async t => {
  const f = fixture(t); const question = '你了解工位上下文吗？';
  f.controller.replyText = () => '还在读取工作区导航，暂时未了解工位上下文。';
  f.controller.uncontrolledContext = true;
  f.controller.contextHook = async turn => {
    assert(f.controller.turns.some(previous => !previous.event && previous.text === question));
    assert.match(turn.event!.text, /WORKSTATION_FACTS/);
    await turn.onPublicMessage!('补充刚才的问题：已读到工位导航，工作细节以工位仓库 README 为准。', [], 'answer-prior-question');
    await turn.onPublicMessage!('补充刚才的问题：已读到工位导航，工作细节以工位仓库 README 为准。', [], 'answer-prior-question');
  };
  await f.send('question', question);
  await until(() => f.children.turns.length === 1 && f.replies.length === 1 && f.inspect.getMessage('question')?.state === 'completed');
  const parent = f.inspect.getActive('user')!; const before = f.inspect.getMessage('question');
  assert.match(f.replies[0]!.text, /暂时未了解/);
  f.children.finish(0, 'WORKSTATION_FACTS');
  await until(() => f.controller.turns.length === 2 && f.registry.queuedEvents().length === 0);
  assert.equal(f.replies.length, 2, '同一显式发送 key 只投递一份补答，不追加 fallback');
  assert.match(f.replies[1]!.text, /补充刚才的问题/);
  assert(!f.replies[1]!.text.includes('WORKSTATION_FACTS'));
  assert.deepEqual(f.controller.turns.map(turn => turn.event?.kind ?? turn.text), [question, 'workspace-context']);
  assert.equal(f.controller.turns[1]!.conversation.nativeId, parent.nativeId);
  assert.equal(f.inspect.getLastDelivery('user', 'dm')!.nativeId, parent.nativeId);
  assert.deepEqual(f.inspect.getMessage('question'), before, '补答不改写原 human 的处理或投递状态');
  assert.equal(f.inspect.latestMessage(parent.id)!.id, 'question');
  assert.equal(f.inspect.knownChannels()[0]!.cursor, 'question');
  assert.equal(f.inspect.pendingCount(parent.id), 0);
  assert.equal(f.initializations.length, 1); assert.equal(f.children.turns.length, 1);
});

test('无关普通问题之后初始化仍静默，未受控最终文字与附件声明不会自动公开', async t => {
  const f = fixture(t); const question = '今晚吃什么？'; const file = join(f.root, 'private-context.txt');
  writeFileSync(file, 'PRIVATE_CONTEXT_FACTS');
  f.controller.uncontrolledContext = true;
  f.controller.contextResultText = `UNSOLICITED_FALLBACK [附件](<${file}>)`;
  f.controller.contextHook = async turn => {
    assert.equal(f.controller.turns.filter(previous => !previous.event)[0]!.text, question);
    assert.match(turn.event!.text, /PRIVATE_CONTEXT_FACTS/);
    // This fake controller chooses no explicit publication for an unrelated human question.
  };
  await f.send('unrelated', question); await until(() => f.children.turns.length === 1 && f.replies.length === 1);
  const before = f.inspect.getMessage('unrelated');
  f.children.finish(0, 'PRIVATE_CONTEXT_FACTS');
  await until(() => f.controller.turns.length === 2 && f.registry.queuedEvents().length === 0);
  assert.equal(f.replies.length, 1);
  assert(!f.replies.some(reply => /PRIVATE_CONTEXT|UNSOLICITED/.test(reply.text)));
  assert(!f.replies.some(reply => reply.options?.images?.length || reply.options?.files?.length));
  assert.deepEqual(f.inspect.getMessage('unrelated'), before);
  assert.equal(f.inspect.knownChannels()[0]!.cursor, 'unrelated');
  assert.equal(f.children.turns.length, 1);
});

test('/new 后相关 human 问题驱动 init 轮普通工作，其来源与回执绑定真实 human 而非新会话命令', async t => {
  const f = fixture(t); const question = '按工位上下文继续核对我刚才的问题';
  f.controller.contextHook = async turn => {
    const context = JSON.parse(readFileSync(turn.taskContextPath!, 'utf8')) as TaskContextFile;
    const origin = f.registry.getContextOrigin(context);
    assert.equal(origin.originMessageId, 'human-question');
    assert.equal(origin.conversationId, turn.conversation.id);
    assert.equal(origin.nativeId, turn.conversation.nativeId);
    assert.equal(origin.purpose, undefined);
    await f.runtime.invoke(turn, 'bridge_start_worker', { title: '相关问题继续核对', prompt: 'RELATED_HUMAN_FOLLOWUP' }, 'followup-from-init');
  };
  await f.send('new', '/new'); await until(() => f.children.turns.length === 1);
  await f.send('human-question', question); await until(() => f.replies.length === 2);
  const parent = f.inspect.getActive('user')!; const before = f.inspect.getMessage('human-question');
  f.children.finish(0); await until(() => f.children.turns.length === 2 && f.controller.turns.length === 2);
  const ordinary = f.runtime.store.workers().find(worker => worker.origin.purpose === undefined)!;
  assert.equal(ordinary.title, '相关问题继续核对');
  assert.equal(ordinary.origin.originMessageId, 'human-question');
  assert.equal(ordinary.origin.nativeId, parent.nativeId);
  assert.equal(f.inspect.getMessage('new')!.conversationId, null);
  await until(() => f.inspect.workspaceNotice(parent.id)?.state === 'delivered');
  assert.equal(f.replies.length, 3, '只增加桥的载入回执，init 原始结果不自动公开');
  const followup = f.children.turns.findIndex(turn => turn.text.includes('RELATED_HUMAN_FOLLOWUP'));
  f.children.finish(followup, 'RELATED_FOLLOWUP_RESULT');
  await until(() => f.controller.turns.length === 3 && f.registry.queuedEvents().length === 0 && f.replies.length === 4);
  assert.equal(f.controller.turns[2]!.event!.kind, 'worker-result');
  assert.equal(f.controller.turns[2]!.conversation.nativeId, parent.nativeId);
  assert.match(f.replies[3]!.text, /普通任务结果/);
  assert.equal(f.runtime.store.jobs().filter(job => job.origin.purpose === undefined)[0]!.status, 'completed');
  assert.deepEqual(f.inspect.getMessage('human-question'), before);
  assert.equal(f.inspect.latestMessage(parent.id)!.id, 'human-question');
  assert.equal(f.initializations.length, 1); assert.equal(f.children.turns.length, 2);
});

test('/cwd 重新调查工作区，Agent 来回切换各自提炼最新主控而不恢复旧分支', async t => {
  const f = fixture(t); const other = join(f.root, 'other'); mkdirSync(other);
  await f.send('new', '/new'); await until(() => f.children.turns.length === 1);
  f.children.finish(0); await until(() => f.controller.turns.length === 1);
  await f.send('cwd', `/cwd "${other}"`); await until(() => f.children.turns.length === 2);
  assert.equal(f.children.turns[1]!.conversation.cwd, f.config.workspace);
  assert.equal(f.inspect.getActive('user')!.cwd, other);
  f.children.finish(1); await until(() => f.controller.turns.length === 2);
  const switching = f.send('agent', '/agent claude'); await until(() => f.children.turns.length === 3);
  assert.equal(f.children.turns[2]!.conversation.agent, 'claude');
  assert.equal(f.children.turns[2]!.conversation.cwd, f.config.workspace);
  assert.equal(f.children.turns[2]!.readOnly, true);
  f.children.finish(2, JSON.stringify({ workspaceContext: '只读工作区约定', continuation: '最新目标与纠正；普通助手和计划保持原样' })); await switching;
  const claude = f.inspect.getActive('user')!; assert.equal(f.controller.turns.length, 3); assert.equal(f.controller.turns[2]!.preparing, true);
  const switchingBack = f.send('restore', '/agent codex'); await until(() => f.children.turns.length === 4);
  f.children.finish(3, JSON.stringify({ workspaceContext: '工作区稳定约定', continuation: '从 Claude 最新进展向前续接' })); await switchingBack;
  assert.notEqual(f.inspect.getActive('user')!.id, claude.id);
  assert.equal(f.controller.turns.length, 4);
  assert.equal(f.runtime.store.workers().length, 2);
});

test('恢复无标记已有原生会话调查一次，完成标记跨重启保留不重复派发', async t => {
  const f = fixture(t);
  const parent = f.inspect.createConversation('user', 'codex', f.root, { controllerMode: true });
  f.inspect.setActive('user', parent.id); f.inspect.saveNativeId(parent.id, 'existing-production-native');
  f.inspect.addMessage({ id: 'existing', text: '已有真实聊天', imagePaths: [], userId: 'user', channelId: 'dm' }, parent.id, 'completed');
  f.inspect.setReplyState(['existing'], 'delivered');
  await f.manager.recover(); await until(() => f.children.turns.length === 1);
  assert.equal(f.runtime.store.workers()[0]!.origin.nativeId, 'existing-production-native');
  f.children.finish(0); await until(() => f.controller.turns.length === 1 && f.registry.queuedEvents().length === 0);
  assert.equal(f.controller.turns[0]!.conversation.nativeId, 'existing-production-native');
  assert.equal(f.replies.length, 0);
  await f.restart(); await delay(30);
  assert.equal(f.children.turns.length, 1); assert.equal(f.runtime.store.workers().length, 1);
  assert.equal(f.inspect.getActive('user')!.nativeId, 'existing-production-native');
});

test('初始化子任务失败保存事实并交回原父，桥只提示一次失败且不反复重派', async t => {
  const f = fixture(t);
  await f.send('new', '/new'); await until(() => f.children.turns.length === 1);
  f.children.fail(0); await until(() => f.controller.turns.length === 1 && f.registry.queuedEvents().length === 0);
  const result = f.controller.turns[0]!;
  assert.match(result.event!.text, /failed/); assert.match(result.event!.text, /workspace read denied/);
  assert.equal(f.runtime.store.jobs()[0]!.status, 'failed');
  await until(() => f.inspect.workspaceNotice(result.conversation.id)?.state === 'delivered');
  assert.equal(f.replies.length, 2); assert.match(f.replies[1]!.text, /读取失败/);
  assert.equal(f.registry.activeCount(result.conversation.id), 0);
  await f.send('ask', '上下文查完了吗'); await until(() => f.controller.turns.length === 2);
  assert.equal(f.controller.turns[1]!.conversation.nativeId, f.inspect.getActive('user')!.nativeId);
  assert(f.controller.facts.get(f.inspect.getActive('user')!.nativeId!)!.includes('workspace read denied'));
  assert.equal(f.children.turns.length, 1);
});

test('新会话期间旧初始化结果只保存，不刷旧结果也不送入新父上下文', async t => {
  const f = fixture(t);
  await f.send('old-new', '/new'); await until(() => f.children.turns.length === 1);
  const old = f.inspect.getActive('user')!;
  await f.send('fresh-new', '/new'); await until(() => f.children.turns.length === 2);
  const fresh = f.inspect.getActive('user')!;
  f.children.finish(0, 'OLD_CONTEXT_FACTS');
  await until(() => f.runtime.store.jobs()[0]!.status === 'completed' && f.registry.queuedEvents().length === 0);
  assert.equal(f.controller.turns.length, 0); assert.equal(f.replies.length, 2);
  assert.equal(f.inspect.getConversation(old.id)!.nativeId, null);
  f.children.finish(1, 'FRESH_CONTEXT_FACTS');
  await until(() => f.controller.turns.length === 1);
  assert.equal(f.controller.turns[0]!.conversation.id, fresh.id);
  assert.match(f.controller.turns[0]!.event!.text, /FRESH_CONTEXT_FACTS/);
  assert(!f.controller.turns[0]!.event!.text.includes('OLD_CONTEXT_FACTS'));
  await until(() => f.inspect.workspaceNotice(fresh.id)?.state === 'delivered');
  assert.equal(f.replies.length, 3); assert(f.replies[2]!.text.includes(fresh.id.slice(0, 8)));
  assert.equal(f.inspect.workspaceNotice(old.id)?.state, 'cancelled');
});

test('初始化完成不会抢占忙中的父，真实用户消息先于导航事实 turn', async t => {
  const f = fixture(t); const release = f.controller.hold('first');
  await f.send('first', 'first'); await until(() => f.controller.turns.length === 1 && f.children.turns.length === 1);
  f.children.finish(0); await until(() => f.registry.queuedEvents().length === 1);
  await f.send('second', 'second'); await delay(20);
  assert.equal(f.controller.turns.length, 1);
  release(); await until(() => f.controller.turns.length === 3);
  assert.deepEqual(f.controller.turns.map(turn => turn.event?.kind ?? turn.text), ['first', 'second', 'workspace-context']);
  assert.equal(f.replies.length, 2);
});

test('初始化purpose不污染普通聊天的调度能力及真实后台任务结果', async t => {
  const f = fixture(t); let dispatched = false;
  f.controller.hook = async turn => {
    if (dispatched || turn.event) return;
    dispatched = true;
    const context = JSON.parse(readFileSync(turn.taskContextPath!, 'utf8')) as TaskContextFile;
    assert.equal(f.registry.getContextOrigin(context).purpose, undefined);
    await f.runtime.invoke(turn, 'bridge_start_worker', { title: '真实用户任务', prompt: 'USER_AUTHORIZED_TASK' }, 'real-task');
  };
  await f.send('first', '执行真实任务'); await until(() => f.children.turns.length === 2 && f.replies.length === 1);
  const workspaceIndex = f.children.turns.findIndex(turn => !turn.text.includes('USER_AUTHORIZED_TASK'));
  const ordinaryIndex = f.children.turns.findIndex(turn => turn.text.includes('USER_AUTHORIZED_TASK'));
  f.children.finish(workspaceIndex); await until(() => f.controller.turns.some(turn => turn.event?.kind === 'workspace-context'));
  f.children.finish(ordinaryIndex, 'user task finished');
  await until(() => f.controller.turns.some(turn => turn.event?.kind === 'worker-result') && f.replies.length === 2);
  const workers = f.runtime.store.workers();
  assert.equal(workers.filter(worker => worker.origin.purpose === 'workspace-context').length, 1);
  assert.equal(workers.filter(worker => worker.origin.purpose === undefined).length, 1);
  assert.match(f.replies[1]!.text, /普通任务结果/);
});

test('初始化也拒绝属于其他父的普通message来源；恢复等待本父第一条消息', async t => {
  const f = fixture(t);
  const other = f.inspect.createConversation('user', 'codex', f.root, { controllerMode: true });
  f.inspect.addMessage({ id: 'other-message', text: '另一个父的普通消息', imagePaths: [], userId: 'user', channelId: 'dm' }, other.id, 'completed');
  const target = f.inspect.createConversation('user', 'codex', f.root, { controllerMode: true });
  f.inspect.setActive('user', target.id);
  await f.manager.recover(); await delay(20);
  assert.equal(f.children.turns.length, 0); assert.equal(f.initializations.length, 0);
  const created = f.registry.createContext({ conversationId: target.id, userId: 'user', channelId: 'dm', originMessageId: 'other-message',
    agent: 'codex', cwd: f.root, nativeId: null, purpose: 'workspace-context' });
  const context = JSON.parse(readFileSync(created.contextPath, 'utf8')) as TaskContextFile;
  const task = f.registry.register(context, 'corrupt origin'); f.registry.closeContext(created.contextId);
  f.registry.acceptObservedResult(task.taskId, 'completed', 'MUST_NOT_ENTER_OTHER_PARENT');
  const event = f.registry.getNextEvent()!; f.manager.completionAvailable();
  await until(() => f.registry.eventState(event.id) === 'uncertain');
  assert.equal(f.controller.turns.length, 0); assert.equal(f.replies.length, 0);
  await f.send('current', '本父真实消息'); await until(() => f.children.turns.length === 1);
  assert.equal(f.initializations[0]!.conversation.id, target.id);
});

test('直接模式保留原行为，不自动派上下文子 Agent', async t => {
  const f = fixture(t, false);
  await f.send('hello', '普通直接会话'); await until(() => f.controller.turns.length === 1 && f.replies.length === 1);
  assert.equal(f.initializations.length, 0); assert.equal(f.children.turns.length, 0);
  await f.send('new', '/new'); await delay(20);
  assert.equal(f.children.turns.length, 0); assert.equal(f.runtime.store.workers().length, 0);
});

test('初始化先建迁移后的父native时，历史摘要作为历史证据保留且下一条真实消息不重复注入', async t => {
  const f = fixture(t);
  const legacy = f.inspect.createConversation('user', 'codex', f.root, { controllerMode: false });
  f.inspect.setActive('user', legacy.id); f.inspect.saveNativeId(legacy.id, 'legacy-native');
  f.inspect.addMessage({ id: 'legacy-message', text: 'KEEP_MIGRATION_REFERENCE_TOKEN', imagePaths: [], userId: 'user', channelId: 'dm' }, legacy.id, 'completed');
  f.inspect.setReplyState(['legacy-message'], 'delivered');
  f.inspect.addMessage({ id: 'last-command', text: '/status', imagePaths: [], userId: 'user', channelId: 'dm' }, null, 'completed');
  await f.manager.recover(); await until(() => f.children.turns.length === 1);
  const migrated = f.inspect.getActive('user')!;
  assert.notEqual(migrated.id, legacy.id); assert.match(migrated.contextSeed!, /KEEP_MIGRATION_REFERENCE_TOKEN/);
  f.children.finish(0); await until(() => f.controller.turns.length === 1 && f.inspect.getActive('user')!.nativeId !== null);
  assert.match(f.controller.turns[0]!.event!.text, /KEEP_MIGRATION_REFERENCE_TOKEN/);
  assert.match(f.controller.turns[0]!.event!.text, /不是新的用户请求或授权/);
  assert(!f.children.turns[0]!.text.includes('KEEP_MIGRATION_REFERENCE_TOKEN'));
  await f.send('real-current', '真正的新消息'); await until(() => f.controller.turns.length === 2);
  assert.equal(f.controller.turns[1]!.text, '真正的新消息');
  assert(!JSON.stringify(f.controller.turns[1]!.input).includes('KEEP_MIGRATION_REFERENCE_TOKEN'));
});

test('回滚为直接模式后，旧初始化ordinary来源结果仍仅保存而不刷旧任务通知', async t => {
  const f = fixture(t);
  await f.send('first', '主控普通消息'); await until(() => f.children.turns.length === 1 && f.replies.length === 1);
  const old = f.inspect.getActive('user')!;
  f.config.controllerMode = false;
  await f.send('rollback', '直接模式消息'); await until(() => f.replies.length === 2);
  const current = f.inspect.getActive('user')!;
  assert.notEqual(current.id, old.id); assert.equal(Boolean(current.controllerMode), false);
  f.children.finish(0, 'LATE_OLD_WORKSPACE_CONTEXT');
  await until(() => f.runtime.store.jobs()[0]!.status === 'completed' && f.registry.queuedEvents().length === 0);
  assert.equal(f.controller.turns.length, 2);
  assert.equal(f.replies.length, 2);
  assert(!f.replies.some(reply => reply.text.includes('LATE_OLD_WORKSPACE_CONTEXT')));
  assert.equal(f.inspect.getActive('user')!.id, current.id);
});

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

function initializationReceipts(f: ReturnType<typeof fixture>) {
  return f.replies.filter(reply => (/^[✅⚠️]/u.test(reply.text) || reply.text.includes('你好，我是这个工作区的主控')) && reply.text.includes('（会话 '));
}

test('/new 子任务已结束但父上下文仍在载入时不提前宣布就绪', async t => {
  const f = fixture(t); const gate = deferred();
  f.controller.contextHook = () => gate.promise;
  await f.send('new', '/new'); await until(() => f.children.turns.length === 1);
  const parent = f.inspect.getActive('user')!;
  f.children.finish(0, 'PRIVATE_CONTEXT');
  await until(() => f.controller.turns.length === 1 && f.inspect.getActive('user')!.nativeId !== null);
  assert.equal(f.runtime.store.jobs()[0]!.status, 'completed');
  assert.equal(f.inspect.workspaceNotice(parent.id)!.outcome, null);
  assert.equal(initializationReceipts(f).length, 0);
  assert.equal(f.manager.isIdle(), false);
  const nativeId = f.inspect.getActive('user')!.nativeId;
  gate.release();
  await until(() => f.inspect.workspaceNotice(parent.id)!.state === 'delivered' && f.manager.isIdle());
  assert.equal(initializationReceipts(f).length, 1);
  assert.match(initializationReceipts(f)[0]!.text, /你好，我是这个工作区的主控/);
  assert.equal(f.controller.turns[0]!.event?.introductionRequested, true);
  assert(initializationReceipts(f)[0]!.options?.repeatHeader, '介绍通过主控正常公开回复链路带实际元数据');
  assert.match(initializationReceipts(f)[0]!.options!.repeatHeader!, /Codex · 6.1-sol · 中 ·/);
  assert.equal(f.replies[0]!.options?.presentation?.purpose, 'status', '新建回执使用系统卡片，不能伪造尚未回报的模型标题');
  assert.match(f.replies[0]!.options!.presentation!.title, /新会话已创建/);
  assert(!initializationReceipts(f)[0]!.text.includes('PRIVATE_CONTEXT'));
  assert.equal(f.inspect.getActive('user')!.nativeId, nativeId);
});

test('/new 的 ACK 发送未完成时即使极速初始化也先保存结果，再按 ACK→就绪顺序投递', async t => {
  const f = fixture(t); const ack = deferred();
  f.delivery.beforeSend = async (_channel, text) => { if (text.startsWith('已新建 ')) await ack.promise; };
  f.children.onRun = turn => f.children.finish(f.children.turns.indexOf(turn));
  const command = f.send('new-fast', '/new');
  await until(() => {
    const active = f.inspect.getActive('user');
    return Boolean(active && f.inspect.workspaceNotice(active.id)?.outcome === 'ready');
  });
  const parent = f.inspect.getActive('user')!;
  assert.equal(f.inspect.getMessage('new-fast')!.state, 'command');
  assert.equal(f.inspect.workspaceNotice(parent.id)!.state, 'waiting');
  assert.equal(f.delivery.noticeAttempts, 0);
  assert.equal(f.replies.length, 0);
  ack.release(); await command;
  await until(() => f.inspect.workspaceNotice(parent.id)!.state === 'delivered');
  assert.equal(f.replies.length, 2);
  assert.match(f.replies[0]!.text, /^已新建 /);
  assert.match(f.replies[1]!.text, /你好，我是这个工作区的主控/);
  assert.equal(f.controller.turns.length, 1);
});

test('初始化通知投递结果未知只记 uncertain，任务保持已消化且重启不重跑模型或重发', async t => {
  const f = fixture(t); f.delivery.failNotice = true;
  await f.send('new', '/new'); await until(() => f.children.turns.length === 1);
  const parent = f.inspect.getActive('user')!;
  f.children.finish(0); await until(() => f.manager.isIdle() && f.delivery.noticeAttempts === 1);
  assert.equal(f.inspect.workspaceNotice(parent.id)!.state, 'uncertain');
  assert.equal(f.inspect.workspaceNotice(parent.id)!.outcome, 'ready');
  assert.equal(f.runtime.store.jobs()[0]!.status, 'completed');
  assert.equal(f.registry.queuedEvents().length, 0);
  assert.equal(f.controller.turns.length, 1); assert.equal(initializationReceipts(f).length, 0);
  f.delivery.failNotice = false;
  f.manager.completionAvailable(); await f.restart(); await delay(30);
  assert.equal(f.delivery.noticeAttempts, 1); assert.equal(f.controller.turns.length, 1);
  assert.equal(f.children.turns.length, 1); assert.equal(initializationReceipts(f).length, 0);
  assert.equal(f.inspect.workspaceNotice(parent.id)!.state, 'uncertain');
});

test('成功初始化回执持久去重，重复完成检查和恢复均不再发送', async t => {
  const f = fixture(t);
  await f.send('new', '/new'); await until(() => f.children.turns.length === 1);
  const parent = f.inspect.getActive('user')!;
  f.children.finish(0); await until(() => f.inspect.workspaceNotice(parent.id)!.state === 'delivered' && f.manager.isIdle());
  const snapshot = f.inspect.workspaceNotice(parent.id)!;
  assert.equal(snapshot.sourceMessageId, 'new'); assert.equal(snapshot.userId, 'user'); assert.equal(snapshot.channelId, 'dm');
  f.manager.completionAvailable(); await f.manager.recover(); await f.restart(); await delay(30);
  assert.equal(f.delivery.noticeAttempts, 1); assert.equal(initializationReceipts(f).length, 1);
  assert.equal(f.controller.turns.length, 1); assert.equal(f.children.turns.length, 1);
  assert.deepEqual(f.inspect.workspaceNotice(parent.id), snapshot);
});

test('两个获准用户的 /new 初始化各只通知原发送者的 DM，不广播或串会话', async t => {
  const f = fixture(t); f.config.allowedUserIds.push('user-B');
  await f.send('new-A', '/new');
  await f.manager.handle({ id: 'new-B', text: '/new claude', imagePaths: [], userId: 'user-B', channelId: 'dm-B' });
  await until(() => f.children.turns.length === 2);
  const parentA = f.inspect.getActive('user')!; const parentB = f.inspect.getActive('user-B')!;
  const indexA = f.children.turns.findIndex(turn => turn.conversation.userId === 'user');
  const indexB = f.children.turns.findIndex(turn => turn.conversation.userId === 'user-B');
  f.children.finish(indexB, 'PRIVATE_B');
  await until(() => f.inspect.workspaceNotice(parentB.id)!.state === 'delivered');
  assert.equal(f.inspect.workspaceNotice(parentA.id)!.outcome, null);
  assert.deepEqual(initializationReceipts(f).map(reply => reply.channelId), ['dm-B']);
  f.children.finish(indexA, 'PRIVATE_A');
  await until(() => f.inspect.workspaceNotice(parentA.id)!.state === 'delivered');
  assert.deepEqual(initializationReceipts(f).map(reply => reply.channelId), ['dm-B', 'dm']);
  assert(initializationReceipts(f)[0]!.text.includes(parentB.id.slice(0, 8)));
  assert(initializationReceipts(f)[1]!.text.includes(parentA.id.slice(0, 8)));
  assert(!initializationReceipts(f).some(reply => /PRIVATE_[AB]/.test(reply.text)));
  const before = f.replies.length;
  await f.manager.handle({ id: 'outsider', text: '/new', imagePaths: [], userId: 'unauthorized', channelId: 'outsider-dm' });
  assert.equal(f.replies.length, before); assert.equal(f.inspect.getActive('unauthorized'), null);
});

for (const mismatch of ['user', 'channel'] as const) {
  test(`持久初始化通知的 ${mismatch} 与原 /new 来源不符时拒绝投递`, async t => {
    const f = fixture(t); f.config.allowedUserIds.push('user-B');
    f.runtime.initializeWorkspace = async () => undefined;
    await f.send('source-new', '/new');
    const target = f.inspect.createConversation('user', 'codex', f.root, { controllerMode: true });
    f.inspect.setActive('user', target.id);
    f.inspect.requestWorkspaceNotice(target.id, { id: 'source-new', text: '/new', imagePaths: [],
      userId: mismatch === 'user' ? 'user-B' : 'user', channelId: mismatch === 'channel' ? 'wrong-dm' : 'dm' });
    const registered = f.registry.createContext({ conversationId: target.id, userId: 'user', channelId: 'dm',
      originMessageId: 'source-new', nativeId: null, agent: 'codex', cwd: f.root, purpose: 'workspace-context' });
    const context = JSON.parse(readFileSync(registered.contextPath, 'utf8')) as TaskContextFile;
    const task = f.registry.register(context, '工作区上下文'); f.registry.closeContext(registered.contextId);
    f.registry.acceptObservedResult(task.taskId, 'completed', 'VALID_CONTEXT');
    f.manager.completionAvailable();
    await until(() => f.inspect.workspaceNotice(target.id)!.state === 'cancelled' && f.manager.isIdle());
    assert.equal(f.controller.turns.length, 1); assert.equal(f.delivery.noticeAttempts, 0);
    assert.equal(initializationReceipts(f).length, 0); assert.equal(f.replies.length, 1);
    assert.equal(f.replies[0]!.channelId, 'dm');
  });
}

for (const action of ['new', 'stop', 'close'] as const) {
  test(`初始化回执排队发送时 ${action} 取消在途回执，旧回执不落入后续对话`, async t => {
    const f = fixture(t); const gate = deferred(); let sendingSignal: AbortSignal | undefined;
    f.delivery.beforeSend = async (_channel, text, options) => {
      if (text.includes('你好，我是这个工作区的主控')) { sendingSignal = options?.signal; await gate.promise; }
    };
    await f.send('old-new', '/new'); await until(() => f.children.turns.length === 1);
    const parent = f.inspect.getActive('user')!;
    f.children.finish(0);
    await until(() => sendingSignal !== undefined && f.inspect.workspaceNotice(parent.id)!.state === 'sending');
    assert.equal(f.manager.isIdle(), false);
    if (action === 'close') await f.manager.close();
    else await f.send('cancel-command', action === 'new' ? '/new' : '/stop');
    assert.equal(sendingSignal!.aborted, true);
    gate.release();
    await until(() => f.inspect.workspaceNotice(parent.id)!.state === 'uncertain');
    assert.equal(initializationReceipts(f).length, 0);
    assert.equal(f.controller.turns.length, 1);
    assert.equal(f.runtime.store.jobs()[0]!.status, 'completed');
    assert.equal(f.registry.queuedEvents().length, 0);
    assert.equal(f.errors.length, 0, '明确取消不记录通知错误');
  });
}

test('初始派发请求抛错时一次性短报失败，不捏造上下文就绪', async t => {
  const f = fixture(t);
  f.runtime.initializeWorkspace = async () => { throw new Error('dispatch failed before registration'); };
  await f.send('new', '/new');
  const parent = f.inspect.getActive('user')!;
  await until(() => f.inspect.workspaceNotice(parent.id)!.state === 'delivered' && f.manager.isIdle());
  assert.equal(f.inspect.workspaceNotice(parent.id)!.outcome, 'request-failed');
  assert.equal(initializationReceipts(f).length, 1);
  assert.match(initializationReceipts(f)[0]!.text, /初始化请求未确认完成/);
  assert.equal(f.children.turns.length, 0); assert.equal(f.controller.turns.length, 0);
  assert.equal(f.initializations.length, 1); assert.equal(f.errors.length, 1);
});

test('子任务成功但父主控载入失败时只发载入失败回执，恢复不重复模型', async t => {
  const f = fixture(t);
  f.controller.contextHook = async () => { throw new Error('context turn incomplete'); };
  await f.send('new', '/new'); await until(() => f.children.turns.length === 1);
  const parent = f.inspect.getActive('user')!;
  f.children.finish(0); await until(() => f.inspect.workspaceNotice(parent.id)!.state === 'delivered' && f.manager.isIdle());
  assert.equal(f.inspect.workspaceNotice(parent.id)!.outcome, 'load-failed');
  assert.equal(initializationReceipts(f).length, 1);
  assert.match(initializationReceipts(f)[0]!.text, /未能载入主控/);
  assert(!initializationReceipts(f)[0]!.text.includes('已载入'));
  assert.equal(f.runtime.store.jobs()[0]!.status, 'completed');
  await f.restart(); await delay(30);
  assert.equal(f.controller.turns.length, 1); assert.equal(f.children.turns.length, 1);
  assert.equal(initializationReceipts(f).length, 1);
});

test('重启发现初始化事件处理中断时只报结果无法确认，不重放主控或子 Agent', async t => {
  const f = fixture(t); f.pauseCompletions();
  await f.send('new', '/new'); await until(() => f.children.turns.length === 1 && f.manager.isIdle());
  const parent = f.inspect.getActive('user')!;
  f.children.finish(0); await until(() => f.registry.queuedEvents().length === 1);
  const event = f.registry.queuedEvents()[0]!;
  assert.equal(f.registry.claimEvent(event.id), true);
  assert.equal(f.inspect.workspaceNotice(parent.id)!.outcome, null);
  await f.restart(); await delay(30);
  assert.equal(f.registry.eventState(event.id), 'uncertain');
  assert.equal(f.inspect.workspaceNotice(parent.id)!.state, 'delivered');
  assert.equal(f.inspect.workspaceNotice(parent.id)!.outcome, 'unknown');
  assert.equal(f.controller.turns.length, 0); assert.equal(f.children.turns.length, 1);
  assert.equal(initializationReceipts(f).length, 1);
  assert.match(initializationReceipts(f)[0]!.text, /结果无法确认/);
  assert(!initializationReceipts(f)[0]!.text.includes('已载入'));
});

test('/new continue freezes parent selection, uses one initializer, persists a bounded private handoff and survives restart without repeating', async t => {
  const f = fixture(t);
  await f.send('old-request', '目标：先调查，不能保留数据重装'); await until(() => f.children.turns.length === 1);
  f.children.finish(0); await until(() => f.manager.isIdle());
  const previous = f.inspect.getActive('user')!;
  assert.equal(previous.model ?? null, null); assert.equal(previous.actualModel, 'gpt-6.1-sol');
  const registered = f.registry.createContext({ conversationId: previous.id, userId: 'user', channelId: 'dm',
    originMessageId: 'old-request', nativeId: previous.nativeId, agent: 'codex', cwd: f.root });
  const scheduled = await f.runtime.invoke({ conversation: previous, taskContextPath: registered.contextPath,
    text: '', imagePaths: [], signal: new AbortController().signal, onProgress: () => {} },
    'bridge_schedule_controller', { afterSeconds: 60, text: '旧提醒' }) as { scheduleId: string };
  f.registry.closeContext(registered.contextId);
  await f.send('continue', '/new continue'); await until(() => f.children.turns.length === 2);
  const parent = f.inspect.getActive('user')!;
  assert.notEqual(parent.id, previous.id); assert.equal(parent.model, 'gpt-6.1-sol'); assert.equal(parent.effort, 'medium');
  assert.equal(f.runtime.store.getSchedule(scheduled.scheduleId)!.status, 'cancelled');
  assert.equal(f.children.turns[1]!.conversation.model, parent.model); assert.equal(f.children.turns[1]!.effort, parent.effort);
  assert.match(f.children.turns[1]!.text, /只启动这一个初始化助手/);
  const directory = join(f.config.dataDir, 'session-handoffs', parent.id);
  assert.match(readFileSync(join(directory, 'source.json'), 'utf8'), /不能保留数据重装/);
  assert.equal(f.replies.filter(reply => reply.text.includes('正在整理上一会话')).length, 1);
  f.children.finish(1, JSON.stringify({ workspaceContext: 'WORKSPACE_CONTEXT', continuation: '用户要求先调查；纠正：不能保留数据重装。仍需核实，禁止自动重派。' }));
  await until(() => f.manager.isIdle() && f.inspect.workspaceNotice(parent.id)!.state === 'delivered');
  const event = f.controller.turns.find(turn => turn.conversation.id === parent.id && turn.event);
  assert.ok(event); assert.match(event.text, /WORKSPACE_CONTEXT/); assert.match(event.text, /不能保留数据重装/);
  assert.match(event.text, /关键纠正和真正待办/);
  assert.match(readFileSync(join(directory, 'context.md'), 'utf8'), /不能保留数据重装/);
  await f.restart(); await delay(30);
  assert.equal(f.children.turns.length, 2);
  await f.send('fresh', '/new'); await until(() => f.children.turns.length === 3);
  assert(!f.children.turns[2]!.text.includes('source.json')); assert(!f.children.turns[2]!.text.includes('不能保留数据重装'));
});

test('/new continue without a prior controller does not switch, and malformed handoff never claims readiness', async t => {
  const f = fixture(t);
  await f.send('empty', '/new continue'); assert.equal(f.inspect.getActive('user'), null); assert.equal(f.children.turns.length, 0);
  await f.send('old', '授权的目标'); await until(() => f.children.turns.length === 1);
  f.children.finish(0); await until(() => f.manager.isIdle());
  await f.send('continue', '/new continue'); await until(() => f.children.turns.length === 2);
  const target = f.inspect.getActive('user')!;
  f.children.finish(1, 'INVALID_NOT_JSON');
  await until(() => f.manager.isIdle() && f.inspect.workspaceNotice(target.id)!.state === 'delivered');
  assert.equal(f.runtime.store.jobs().at(-1)!.status, 'failed');
  const manifest = JSON.parse(readFileSync(join(f.config.dataDir, 'session-handoffs', target.id, 'manifest.json'), 'utf8'));
  assert.equal(manifest.status, 'failed');
  const failure = f.controller.turns.filter(turn => turn.conversation.id === target.id);
  assert.equal(failure.length, 1); assert.equal(failure[0]!.event?.introductionRequested, false);
  assert.match(failure[0]!.text, /交接未完成/);
  assert.equal(f.inspect.workspaceNotice(target.id)!.outcome, 'read-failed');
});


for (const recorded of ['ready', 'missing', 'request-failed'] as const) {
  test(`completed private handoff with ${recorded} initialization journal follows the same native controller into a group and recovers readiness`, async t => {
    const f = fixture(t);
    await f.send('old-goal', 'Keep the confirmed goal'); await until(() => f.children.turns.length === 1);
    // Child completion is asynchronous; idle alone can precede its persisted completion and main-context acceptance.
    f.children.finish(0); await until(() => f.manager.isIdle() && f.initializationStates.length === 1);
    assert.deepEqual(f.initializationStates, ['ready']);
    await f.send('private-continue', '/new continue'); await until(() => f.children.turns.length === 2);
    f.children.finish(1, JSON.stringify({ workspaceContext: 'WORKSPACE', continuation: 'Keep the same confirmed goal.' }));
    await until(() => f.manager.isIdle() && f.inspect.workspaceNotice(f.inspect.getActive('user')!.id)?.state === 'delivered');
    const target = f.inspect.getActive('user')!, manifestPath = join(f.config.dataDir, 'session-handoffs', target.id, 'manifest.json');
    assert.equal(f.controller.turns.filter(turn => turn.event?.kind === 'workspace-context').length, 2, 'both original and continued controllers accepted their context before changing entrance');
    const manifest = readFileSync(manifestPath, 'utf8'), journalPath = join(f.config.dataDir, 'workspace-initialization', target.id + '.json');
    const legacyState = (phase: string) => {
      if (recorded === 'missing') renameSync(journalPath, journalPath + '.' + phase + '.fixture-saved');
      if (recorded === 'request-failed') {
        const journal = JSON.parse(readFileSync(journalPath, 'utf8'));
        writeFileSync(journalPath, JSON.stringify({ ...journal, sourceMessageId: 'new-group-input', channelId: 'group-address', outcome: 'request-failed' }));
      }
    };
    legacyState('before-group');
    await f.manager.handle({ id: 'new-group-input', text: 'Continue the same goal here', userId: 'user', channelId: 'group-address', imagePaths: [],
      groupContext: { eventId: 'group-event', rootId: 'group-root', botId: 'feishu:test', spaceId: 'test-space', generation: 1,
        bindingEpoch: 1, originChannelId: 'group-address', principalId: 'owner', scene: 'test group' } });
    await until(() => f.manager.isIdle() && f.inspect.getMessage('new-group-input')?.state === 'completed');
    const groupTurn = f.controller.turns.find(turn => turn.groupContext?.eventId === 'group-event');
    assert.ok(groupTurn, 'the new group input reaches the ordinary controller turn');
    assert.equal(groupTurn.conversation.id, target.id); assert.equal(groupTurn.conversation.nativeId, target.nativeId);
    assert.equal(f.children.turns.length, 2, 'a consumed handoff never launches another workspace reader');
    assert.equal(f.initializations.length, 2);
    assert.equal(f.controller.turns.filter(turn => turn.event?.kind === 'workspace-context').length, 2);
    assert.equal(f.inspect.getActive('user')?.id, target.id); assert.equal(f.inspect.getActive('user')?.nativeId, target.nativeId);
    assert.equal(readFileSync(manifestPath, 'utf8'), manifest, 'original private handoff remains unchanged');
    assert.deepEqual(f.errors, []); assert.ok(f.initializationStates.every(outcome => outcome === 'ready'));
    const restored = JSON.parse(readFileSync(journalPath, 'utf8'));
    assert.equal(restored.outcome, 'ready'); assert.equal(restored.sourceMessageId, 'private-continue'); assert.equal(restored.channelId, 'dm');
    // The newest stored source is now a group input. Recovery must still reconcile historical acceptance first.
    legacyState('before-restart'); f.initializationStates.length = 0;
    await f.restart(); await until(() => f.manager.isIdle());
    assert.deepEqual(f.initializationStates, ['ready']); assert.equal(f.children.turns.length, 2); assert.equal(f.initializations.length, 2);
    assert.equal(f.controller.turns.filter(turn => turn.event?.kind === 'workspace-context').length, 2);
    assert.equal(f.inspect.getActive('user')?.nativeId, target.nativeId);
    assert.equal(readFileSync(manifestPath, 'utf8'), manifest);
    const recovered = JSON.parse(readFileSync(journalPath, 'utf8'));
    assert.equal(recovered.outcome, 'ready'); assert.equal(recovered.sourceMessageId, 'private-continue'); assert.equal(recovered.nativeId, target.nativeId);
  });
}

test('an unfinished private handoff still rejects a different group entrance and never establishes readiness', async t => {
  const f = fixture(t), handoffs = new SessionHandoffs(f.config.dataDir);
  const previous = f.inspect.createConversation('user', 'codex', f.root, { controllerMode: true });
  const target = f.inspect.createConversation('user', 'codex', f.root, { controllerMode: true });
  handoffs.prepare(previous, target, 'dm', [], []);
  const source = { id: 'unfinished-private-continue', text: '/new continue', userId: 'user', channelId: 'dm', imagePaths: [] };
  f.inspect.addMessage(source, null, 'command'); f.inspect.setState(source.id, 'completed'); f.inspect.requestWorkspaceNotice(target.id, source); f.inspect.setActive('user', target.id);
  const manifestPath = join(f.config.dataDir, 'session-handoffs', target.id, 'manifest.json'), manifest = readFileSync(manifestPath, 'utf8');
  await f.manager.handle({ id: 'wrong-entrance', text: 'Do not bypass the pending handoff', userId: 'user', channelId: 'group-address', imagePaths: [],
    groupContext: { eventId: 'wrong-entrance', rootId: 'group-root', botId: 'feishu:test', spaceId: 'test-space', generation: 1,
      bindingEpoch: 1, originChannelId: 'group-address', principalId: 'owner', scene: 'test group' } });
  await until(() => f.manager.isIdle() && f.errors.length > 0);
  assert.match(String(f.errors[0]), /交接材料与当前用户、入口或会话不匹配/);
  assert.equal(f.children.turns.length, 0); assert.equal(f.initializations.length, 1);
  assert(!f.initializationStates.includes('ready')); assert.equal(readFileSync(manifestPath, 'utf8'), manifest);
  assert.equal(JSON.parse(readFileSync(join(f.config.dataDir, 'workspace-initialization', target.id + '.json'), 'utf8')).outcome, 'request-failed');
});
