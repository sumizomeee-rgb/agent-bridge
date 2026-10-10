import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import { SessionManager } from '../src/manager.js';
import { SessionStore } from '../src/store.js';
import { ControllerRuntime } from '../src/controller/runtime.js';
import { TaskRegistry, type TaskContextFile } from '../src/tasks.js';
import type { AgentAdapter, AgentResult, AgentTurn, BridgeConfig, ReplyOptions } from '../src/types.js';

class Children implements AgentAdapter {
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
  const replies: Array<{ text: string; options?: ReplyOptions }> = [];
  const counts: Array<{ id: string; count: number }> = [];
  const initializations: AgentTurn[] = []; const errors: unknown[] = [];
  let manager!: SessionManager; let runtime!: ControllerRuntime;
  const callbacks = { onCompletion: () => manager.completionAvailable(),
    onCountChanged: (id: string) => manager.refreshTaskCounts(id), onError: (error: unknown) => errors.push(error), pollIntervalMs: 60000 };
  const makeRuntime = () => new ControllerRuntime(config, { codex: children, claude: children }, registry, callbacks);
  const makeManager = () => new SessionManager(config, { codex: controller, claude: controller }, {
    async sendText(_channel, text, options) { replies.push({ text, options }); },
    async setTaskCount(message, count) { counts.push({ id: message.id, count }); },
  }, { mergeDelayMs: 0, taskRegistry: registry,
    onInitializeWorkspace: turn => { initializations.push(turn); return runtime.initializeWorkspace(turn); },
    onInitializationError: (_conversation, error) => errors.push(error),
    onDetach: id => runtime.detachConversation(id), onStop: id => runtime.cancelConversation(id) });
  runtime = makeRuntime(); manager = makeManager();
  const inspect = new SessionStore(config.dataDir);
  const f = { root, config, registry, children, controller, replies, counts, initializations, errors, inspect,
    get manager() { return manager; }, get runtime() { return runtime; },
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
  await until(() => f.counts.some(item => item.id === 'first' && item.count === 1));
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
  await until(() => f.counts.filter(item => item.id === 'second').at(-1)?.count === 0);
  assert.deepEqual(f.errors, []);
});

test('用户本机初始化入口通过独立事件载入；/new 重读、/cwd 换入口、续聊去重（模拟只读子 Agent）', async t => {
  const f = fixture(t);
  const other = join(f.root, 'other'); mkdirSync(other);
  writeFileSync(join(f.root, 'AGENTS.md'), '初始化按 README.md 的用户入口和范围读取。');
  writeFileSync(join(f.root, 'README.md'), '初始化入口：context-a.md\n回传要求：只返回指定文件的执行规范。');
  writeFileSync(join(f.root, 'context-a.md'), 'WORKSPACE_POLICY_A');
  writeFileSync(join(other, 'AGENTS.md'), '初始化按 README.md 的用户入口和范围读取。');
  writeFileSync(join(other, 'README.md'), '初始化入口：context-b.md\n回传要求：只返回指定文件的执行规范。');
  writeFileSync(join(other, 'context-b.md'), 'WORKSPACE_POLICY_B');
  const reads: string[] = [];
  // Simulate the child's read tools; the bridge supplies a generic entry contract, not a file parser.
  f.children.onRun = turn => {
    assert.match(turn.text, /遵循其中定义的初始化入口、只读范围和回传要求/);
    assert(!/WORKSPACE_POLICY_[AB]/.test(turn.text));
    const cwd = turn.conversation.cwd;
    readFileSync(join(cwd, 'AGENTS.md'), 'utf8');
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
  assert.match(f.controller.turns[3]!.event!.text, /WORKSPACE_POLICY_B/);
  assert.deepEqual(reads, [join(f.root, 'context-a.md'), join(f.root, 'context-a.md'), join(other, 'context-b.md')]);
  assert.equal(f.runtime.store.workers().length, 3);
  assert.deepEqual(f.errors, []);
});

test('/new 立即派背景任务；没有隐式用户话，初始化回传可静默建立原生父', async t => {
  const f = fixture(t);
  await f.send('new', '/new');
  await until(() => f.children.turns.length === 1);
  assert.equal(f.controller.turns.length, 0);
  assert.equal(f.inspect.getMessage('new')?.conversationId, null);
  assert.equal(f.initializations[0]!.conversation.nativeId, null);
  await until(() => f.counts.some(item => item.id === 'new' && item.count === 1));
  f.controller.uncontrolledContext = true;
  f.children.finish(0);
  await until(() => f.controller.turns.length === 1 && f.inspect.getActive('user')!.nativeId !== null);
  const native = f.inspect.getActive('user')!.nativeId;
  assert.equal(f.controller.turns[0]!.event?.kind, 'workspace-context');
  assert.equal(f.controller.turns[0]!.conversation.nativeId, null);
  assert.equal(f.controller.turns[0]!.taskContextPath, undefined, '未有真实 human 时不给初始化回执额外派工能力');
  assert.equal(f.replies.length, 1, '没有显式发送，fallback保持静默');
  assert(!f.replies.some(item => /UNSOLICITED|看看/.test(item.text)));
  await f.send('hello', '你好'); await until(() => f.controller.turns.length === 2 && f.replies.length === 2);
  assert.equal(f.controller.turns[1]!.conversation.nativeId, native);
  assert.equal(f.controller.turns[1]!.text, '你好');
  assert.equal(f.children.turns.length, 1);
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
  assert.equal(f.replies.length, 2, 'init 结果不会自动公开');
  const followup = f.children.turns.findIndex(turn => turn.text.includes('RELATED_HUMAN_FOLLOWUP'));
  f.children.finish(followup, 'RELATED_FOLLOWUP_RESULT');
  await until(() => f.controller.turns.length === 3 && f.registry.queuedEvents().length === 0 && f.replies.length === 3);
  assert.equal(f.controller.turns[2]!.event!.kind, 'worker-result');
  assert.equal(f.controller.turns[2]!.conversation.nativeId, parent.nativeId);
  assert.match(f.replies[2]!.text, /普通任务结果/);
  assert.equal(f.runtime.store.jobs().filter(job => job.origin.purpose === undefined)[0]!.status, 'completed');
  assert.deepEqual(f.inspect.getMessage('human-question'), before);
  assert.equal(f.inspect.latestMessage(parent.id)!.id, 'human-question');
  assert.equal(f.initializations.length, 1); assert.equal(f.children.turns.length, 2);
});

test('/cwd 和新建 Agent 会话各派一次，恢复已有会话不重新调查', async t => {
  const f = fixture(t); const other = join(f.root, 'other'); mkdirSync(other);
  await f.send('new', '/new'); await until(() => f.children.turns.length === 1);
  f.children.finish(0); await until(() => f.controller.turns.length === 1);
  await f.send('cwd', `/cwd "${other}"`); await until(() => f.children.turns.length === 2);
  assert.equal(f.children.turns[1]!.conversation.cwd, other);
  f.children.finish(1); await until(() => f.controller.turns.length === 2);
  await f.send('agent', '/agent claude'); await until(() => f.children.turns.length === 3);
  assert.equal(f.children.turns[2]!.conversation.agent, 'claude');
  assert.equal(f.children.turns[2]!.conversation.cwd, other);
  f.children.finish(2); await until(() => f.controller.turns.length === 3);
  await f.send('restore', '/agent codex'); await delay(30);
  assert.equal(f.children.turns.length, 3);
  assert.equal(f.runtime.store.workers().length, 3);
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

test('初始化子任务失败保存事实并交回原父，保持静默且不会自动反复重派', async t => {
  const f = fixture(t);
  await f.send('new', '/new'); await until(() => f.children.turns.length === 1);
  f.children.fail(0); await until(() => f.controller.turns.length === 1 && f.registry.queuedEvents().length === 0);
  const result = f.controller.turns[0]!;
  assert.match(result.event!.text, /failed/); assert.match(result.event!.text, /workspace read denied/);
  assert.equal(f.runtime.store.jobs()[0]!.status, 'failed');
  assert.equal(f.replies.length, 1); assert.equal(f.registry.activeCount(result.conversation.id), 0);
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
  assert.equal(f.replies.length, 2);
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
