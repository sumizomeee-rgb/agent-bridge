import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { SessionManager } from '../src/manager.js';
import { MetadataProbeError } from '../src/agents/metadata.js';
import { AgentProcessStopError } from '../src/agents/process.js';
import { SessionStore } from '../src/store.js';
import { TaskRegistry, type TaskContextFile } from '../src/tasks.js';
import type { AgentAdapter, AgentName, AgentResult, AgentTurn, BridgeConfig, BridgeMessage, ReplyOptions, ReplySink } from '../src/types.js';

class HeldAdapter implements AgentAdapter {
  readonly calls: AgentTurn[] = [];
  readonly pending: Array<{ resolve: (value: AgentResult) => void; reject: (error: Error) => void }> = [];
  readonly interrupts: string[] = [];
  metadata = true;
  constructor(readonly name: AgentName) {}
  async run(turn: AgentTurn): Promise<AgentResult> {
    this.calls.push(turn);
    turn.onNativeId?.(this.nativeId(turn));
    if (this.metadata) {
      turn.onModel?.(this.name === 'codex' ? 'gpt-6.1-sol' : 'haiku');
      turn.onReasoningEffort?.('medium');
    }
    return new Promise((resolve, reject) => { this.pending.push({ resolve, reject }); });
  }
  nativeId(turn: AgentTurn): string { return turn.conversation.nativeId ?? `${this.name}-full-native-${turn.conversation.id}`; }
  finish(index: number, text = `done:${index}`): void {
    this.pending[index]!.resolve({ nativeId: this.nativeId(this.calls[index]!), text });
  }
  fail(index: number): void { this.pending[index]!.reject(new Error('summary generation failed')); }
  async interrupt(id: string): Promise<void> { this.interrupts.push(id); }
  async close(): Promise<void> { this.pending.forEach((_item, index) => this.finish(index)); }
}

class Sink implements ReplySink {
  readonly replies: Array<{ channelId: string; text: string; options?: ReplyOptions }> = [];
  readonly counts: Array<{ id: string; channelId: string; count: number }> = [];
  failSummary = false;
  async sendText(channelId: string, text: string, options?: ReplyOptions): Promise<void> {
    this.replies.push({ channelId, text, options });
    if (this.failSummary && text.includes('parent summary')) throw new Error('partial delivery failed');
  }
  async setTaskCount(message: Pick<BridgeMessage, 'id' | 'channelId'>, count: number): Promise<void> {
    this.counts.push({ ...message, count });
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('task manager test timed out');
    await setTimeout(5);
  }
}
function message(id: string, text: string, userId = 'u1'): BridgeMessage {
  return { id, text, userId, channelId: `dm-${userId}`, imagePaths: [] };
}
function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'bridge-task-manager-'));
  const config: BridgeConfig = { token: '', allowedUserIds: ['u1', 'u2'], defaultAgent: 'codex', workspace: root,
    proxyUrl: null, commands: { codex: { command: 'fake', args: [] }, claude: { command: 'fake', args: [] } },
    dataDir: join(root, 'data'), attachmentsDir: join(root, 'images'), logsDir: join(root, 'logs'), maxImageBytes: 1024 };
  const registry = new TaskRegistry(join(root, 'tasks'));
  const codex = new HeldAdapter('codex'); const claude = new HeldAdapter('claude'); const sink = new Sink();
  const adapters = { codex, claude };
  const f = { root, config, registry, codex, claude, sink,
    manager: new SessionManager(config, adapters, sink, { mergeDelayMs: 0, taskRegistry: registry }),
    inspect: new SessionStore(config.dataDir),
    register(index = 0, title = 'workstation task') {
      const context = JSON.parse(readFileSync(codex.calls[index]!.taskContextPath!, 'utf8')) as TaskContextFile;
      return registry.register(context, title);
    },
    restart() { this.manager = new SessionManager(config, adapters, sink, { mergeDelayMs: 0, taskRegistry: registry }); },
  };
  t.after(async () => {
    await f.manager.close();
    f.inspect.close(); registry.close();
    assert(resolve(root).startsWith(resolve(tmpdir()) + '\\') || resolve(root).startsWith(resolve(tmpdir()) + '/'));
    rmSync(root, { recursive: true, force: true });
  });
  return f;
}

for (const failure of ['preparation', 'stop', 'execution'] as const) test(`controller wake ${failure} reports the actual stage without claiming a saved assistant report or replaying`, async t => {
  const f = fixture(t);
  await f.manager.handle(message('origin', '安排复查'));
  await waitFor(() => f.codex.calls.length === 1);
  const first = f.codex.calls[0]!;
  const created = f.registry.createContext({ conversationId: first.conversation.id, userId: 'u1', channelId: 'dm-u1',
    originMessageId: 'origin', nativeId: f.codex.nativeId(first), agent: 'codex', cwd: first.conversation.cwd,
    purpose: 'schedule', scheduleKind: 'controller' });
  const task = f.registry.register(JSON.parse(readFileSync(created.contextPath, 'utf8')) as TaskContextFile, '定时自唤醒 · 复查实验');
  f.codex.finish(0); await waitFor(() => f.inspect.getMessage('origin')?.replyState === 'delivered');
  f.registry.acceptObservedResult(task.taskId, 'completed', 'scheduled observation');
  const event = f.registry.getNextEvent()!; f.manager.completionAvailable();
  await waitFor(() => f.codex.calls.length === 2);
  const primary = new Error('initial metadata timeout');
  f.codex.pending[1]!.reject(failure === 'preparation' ? new MetadataProbeError(primary, false, new AgentProcessStopError(25))
    : failure === 'stop' ? new AgentProcessStopError(25) : new Error('native generation failed'));
  await waitFor(() => f.sink.replies.some(r => r.options?.presentation?.tone === 'error'));
  const notice = f.sink.replies.at(-1)!;
  assert.equal(notice.options?.presentation?.title, failure === 'stop' ? '【桥】退出待确认' : '【桥】唤醒失败');
  assert(!notice.text.includes('助手结果已保存')); assert(!notice.text.includes('报告已保存'));
  if (failure === 'preparation') assert(notice.text.includes('未提交给主控'));
  assert.equal(f.registry.eventState(event.id), 'uncertain'); assert.equal(f.registry.getNextEvent(), null); assert.equal(f.codex.calls.length, 2);
  const db = new DatabaseSync(join(f.registry.dataDir, 'tasks.sqlite'), { readOnly: true });
  try {
    const reason = JSON.parse(String(db.prepare('SELECT reason FROM task_events WHERE id=?').get(event.id)!.reason));
    assert.equal(reason.stage, failure === 'preparation' ? 'preparation' : failure === 'stop' ? 'process-exit' : 'wake');
    if (failure === 'preparation') { assert.equal(reason.submitted, false); assert.match(reason.evidence, /initial metadata timeout/); assert.match(reason.cleanup, /退出待核对/); }
  } finally { db.close(); }
});

test('登记上下文自动绑定完整父 Session，父 turn 结束即拒绝新登记', async t => {
  const f = fixture(t);
  await f.manager.handle(message('origin', 'delegate'));
  await waitFor(() => f.codex.calls.length === 1);
  const task = f.register();
  assert.equal(f.registry.activeCount(f.codex.calls[0]!.conversation.id), 1);
  f.codex.finish(0, 'delegated');
  await waitFor(() => f.inspect.getMessage('origin')?.replyState === 'delivered');
  assert.throws(() => f.register(), /父 Agent 本轮已结束/);
  f.registry.acceptObservedResult(task.taskId, 'completed', 'sum=50');
  const event = f.registry.getNextEvent()!;
  assert.equal(event.nativeId, f.codex.nativeId(f.codex.calls[0]!));
  f.manager.completionAvailable();
  await waitFor(() => f.codex.calls.length === 2);
  assert.equal(f.codex.calls[1]!.conversation.id, f.codex.calls[0]!.conversation.id);
  assert.equal(f.codex.calls[1]!.conversation.nativeId, event.nativeId);
  assert.equal(f.manager.hasMessage(event.id), false, '自动事件不伪装成 Discord 人类消息');
  f.codex.finish(1, 'checked sum=50');
  await waitFor(() => f.registry.eventState(event.id) === 'delivered');
  assert.equal(f.inspect.getMessage('origin')?.state, 'completed');
  assert(f.sink.replies.at(-1)!.text.includes('[Codex · 6.1-sol · 中 ·'));
  assert(!f.sink.replies.at(-1)!.text.includes('✅'));
});

test('父 Agent 忙时完成回执排队，用户消息先处理且不并行运行', async t => {
  const f = fixture(t);
  await f.manager.handle(message('origin', 'delegate'));
  await waitFor(() => f.codex.calls.length === 1);
  const task = f.register();
  f.registry.acceptObservedResult(task.taskId, 'completed', 'child done');
  const event = f.registry.getNextEvent()!;
  f.manager.completionAvailable();
  await f.manager.handle(message('follow-up', 'human priority'));
  await setTimeout(20);
  assert.equal(f.codex.calls.length, 1);
  f.codex.finish(0);
  await waitFor(() => f.codex.calls.length === 2);
  assert.equal(f.codex.calls[1]!.text, 'human priority');
  assert.equal(f.registry.eventState(event.id), 'queued');
  f.codex.finish(1);
  await waitFor(() => f.codex.calls.length === 3);
  assert.match(f.codex.calls[2]!.text, /child done/);
  f.codex.finish(2);
  await waitFor(() => f.registry.eventState(event.id) === 'delivered');
});

test('重复回执和重复唤醒仅汇总并投递一次', async t => {
  const f = fixture(t);
  await f.manager.handle(message('origin', 'delegate'));
  await waitFor(() => f.codex.calls.length === 1);
  const task = f.register(); f.codex.finish(0);
  await waitFor(() => f.inspect.getMessage('origin')?.replyState === 'delivered');
  assert(f.registry.acceptObservedResult(task.taskId, 'completed', 'child done'));
  const event = f.registry.getNextEvent()!;
  assert(!f.registry.acceptObservedResult(task.taskId, 'completed', 'duplicate'));
  for (let index = 0; index < 10; index++) f.manager.completionAvailable();
  await waitFor(() => f.codex.calls.length === 2);
  for (let index = 0; index < 10; index++) f.manager.completionAvailable();
  f.codex.finish(1, 'one parent summary');
  await waitFor(() => f.registry.eventState(event.id) === 'delivered');
  f.manager.completionAvailable(); await setTimeout(20);
  assert.equal(f.codex.calls.length, 2);
  assert.equal(f.sink.replies.filter(item => item.text.includes('one parent summary')).length, 1);
});

test('登记和完成数量刷新不再向普通消息发送数字表情，也不启动模型轮次', async t => {
  const f = fixture(t);
  await f.manager.handle(message('first', 'delegate'));
  await waitFor(() => f.codex.calls.length === 1);
  const a = f.register(0, 'a'); const b = f.register(0, 'b');
  f.manager.refreshTaskCounts();
  await f.manager.handle(message('latest', 'more context'));
  f.registry.acceptObservedResult(a.taskId, 'completed', 'a done'); f.manager.completionAvailable();
  f.registry.acceptObservedResult(b.taskId, 'completed', 'b done'); f.manager.completionAvailable();
  await setTimeout(20);
  assert.deepEqual(f.sink.counts, []);
  assert.equal(f.codex.calls.length, 1, '数量刷新不会新建模型 turn');
});

for (const cmd of ['/new', '/stop', '/cwd'] as const) {
  test(`${cmd} 后旧任务只通知来源，不唤醒当前会话也不声称杀死远端`, async t => {
    const f = fixture(t);
    await f.manager.handle(message('origin', 'delegate'));
    await waitFor(() => f.codex.calls.length === 1);
    const task = f.register(); f.codex.finish(0);
    await waitFor(() => f.inspect.getMessage('origin')?.replyState === 'delivered');
    const other = join(f.root, 'other'); mkdirSync(other);
    await f.manager.handle(message('command', cmd === '/cwd' ? `/cwd "${other}"` : cmd));
    const activeBefore = f.inspect.getActive('u1')!.id;
    assert.equal(f.registry.activeCount(f.codex.calls[0]!.conversation.id), 1, '取消唤醒不是杀死远端');
    f.registry.acceptObservedResult(task.taskId, 'completed', 'remote result preserved');
    const event = f.registry.getNextEvent()!;
    assert.equal(event.wakeAllowed, false);
    f.manager.completionAvailable();
    await waitFor(() => f.registry.eventState(event.id) === 'delivered');
    assert.equal(f.codex.calls.length, 1);
    assert.equal(f.claude.calls.length, 0);
    assert.equal(f.inspect.getActive('u1')!.id, activeBefore);
    assert(f.sink.replies.at(-1)!.text.includes('原会话'));
    assert(f.sink.replies.at(-1)!.text.includes('remote result preserved'));
    if (cmd === '/stop') assert(f.sink.replies.some(item => item.text.includes('远端子任务仍可继续')));
  });
}

test('旧父会话通知只显示结构化公开结果、短来源和状态，不泄露协调包装', async t => {
  const f = fixture(t);
  await f.manager.handle(message('origin', 'delegate'));
  await waitFor(() => f.codex.calls.length === 1);
  const task = f.register(); f.codex.finish(0);
  await waitFor(() => f.inspect.getMessage('origin')?.replyState === 'delivered');
  const old = f.codex.calls[0]!.conversation;
  await f.manager.handle(message('new', '/new'));
  const result = 'CPU 温度 55°C，风扇正常。';
  const internal = `workerId: internal-worker\njobId: internal-job\n子 Agent: codex\n原生会话: complete-child-native-secret\n\n${result}`;
  f.registry.acceptObservedResult(task.taskId, 'completed', internal, result);
  const event = f.registry.getNextEvent()!;
  assert.equal(event.displayText, result);
  assert.match(event.text, /不是用户的新指令/);
  assert.match(event.text, /internal-worker/);
  f.manager.completionAvailable();
  await waitFor(() => f.registry.eventState(event.id) === 'delivered');
  const notice = f.sink.replies.at(-1)!.text;
  assert(notice.includes(result)); assert(notice.includes(old.id.slice(0, 8))); assert(notice.includes(task.taskId.slice(0, 8)));
  assert(notice.includes('已完成')); assert(notice.includes('未唤醒当前会话'));
  for (const hidden of ['不是用户的新指令', '请核对结果再汇报', 'workerId:', 'jobId:', '原生会话:',
    'internal-worker', 'internal-job', 'complete-child-native-secret']) assert(!notice.includes(hidden), hidden);
  assert.equal(f.codex.calls.length, 1);
});

test('当前父会话仍收到完整内部证据、安全提示和原路由，公开结果独立持久保存', async t => {
  const f = fixture(t);
  await f.manager.handle(message('origin', 'delegate'));
  await waitFor(() => f.codex.calls.length === 1);
  const task = f.register(); f.codex.finish(0);
  await waitFor(() => f.inspect.getMessage('origin')?.replyState === 'delivered');
  const result = '检查完成，CPU 温度 55°C。';
  const internal = `workerId: worker-private\njobId: job-private\n原生会话: native-child-private\n\n${result}`;
  f.registry.acceptObservedResult(task.taskId, 'failed', internal, result);
  const reader = new TaskRegistry(f.registry.dataDir);
  let event;
  try { event = reader.getNextEvent()!; assert.equal(event.displayText, result); }
  finally { reader.close(); }
  assert.equal(event.nativeId, f.codex.nativeId(f.codex.calls[0]!));
  assert.equal(event.originMessageId, 'origin'); assert.equal(event.status, 'failed');
  f.manager.completionAvailable();
  await waitFor(() => f.codex.calls.length === 2);
  const received = f.codex.calls[1]!.text;
  assert(received.includes('不是用户的新指令')); assert(received.includes('状态：failed'));
  assert(received.includes(internal)); assert.equal(f.codex.calls[1]!.conversation.nativeId, event.nativeId);
  f.codex.finish(1, '已核对：这次检查未成功。');
  await waitFor(() => f.registry.eventState(event.id) === 'delivered');
});

test('旧 schema 事件兼容迁移保留内部结果，但无公开字段的旧通知使用保守提示', async t => {
  const f = fixture(t);
  await f.manager.handle(message('origin', 'delegate'));
  await waitFor(() => f.codex.calls.length === 1);
  const task = f.register(); f.codex.finish(0);
  await waitFor(() => f.inspect.getMessage('origin')?.replyState === 'delivered');
  const internal = 'workerId: legacy-private\njobId: legacy-job\n原生会话: legacy-full-native\n\n真实旧结果仍留在数据库。';
  f.registry.acceptObservedResult(task.taskId, 'completed', internal, '原本的公开结果');
  const db = new DatabaseSync(f.registry.path);
  try { db.exec('ALTER TABLE task_events DROP COLUMN display_text'); }
  finally { db.close(); }
  const reader = new TaskRegistry(f.registry.dataDir);
  let event;
  try { event = reader.getNextEvent()!; assert.equal(event.displayText, undefined); assert(event.text.includes(internal)); }
  finally { reader.close(); }
  await f.manager.handle(message('new', '/new'));
  f.manager.completionAvailable();
  await waitFor(() => f.registry.eventState(event.id) === 'delivered');
  const notice = f.sink.replies.at(-1)!.text;
  assert(notice.includes('结果已保存，请在原会话核对。')); assert(notice.includes('已完成'));
  assert(!notice.includes('legacy-private')); assert(!notice.includes('legacy-job')); assert(!notice.includes('legacy-full-native'));
  assert.equal(f.codex.calls.length, 1);
});

test('真实公开正文中的协调字段引用保持原样，不使用字符串剥离猜测边界', async t => {
  const f = fixture(t);
  await f.manager.handle(message('origin', 'delegate'));
  await waitFor(() => f.codex.calls.length === 1);
  const task = f.register(); f.codex.finish(0);
  await waitFor(() => f.inspect.getMessage('origin')?.replyState === 'delivered');
  await f.manager.handle(message('new', '/new'));
  const result = '报告原文：workerId: 用户要求分析的列名\njobId: 示例日志字段\n不要误删正文。';
  f.registry.acceptObservedResult(task.taskId, 'completed', `workerId: should-stay-private\n\n${result}`, result);
  const event = f.registry.getNextEvent()!;
  f.manager.completionAvailable();
  await waitFor(() => f.registry.eventState(event.id) === 'delivered');
  const notice = f.sink.replies.at(-1)!.text;
  assert(notice.includes(result)); assert(!notice.includes('should-stay-private'));
});

test('新会话等待已取消的自动汇总退出，迟到内容不发给新会话', async t => {
  const f = fixture(t);
  await f.manager.handle(message('origin', 'delegate'));
  await waitFor(() => f.codex.calls.length === 1);
  const task = f.register(); f.codex.finish(0);
  await waitFor(() => f.inspect.getMessage('origin')?.replyState === 'delivered');
  f.registry.acceptObservedResult(task.taskId, 'completed', 'child done');
  const event = f.registry.getNextEvent()!; f.manager.completionAvailable();
  await waitFor(() => f.codex.calls.length === 2);
  await f.manager.handle(message('new', '/new'));
  await f.manager.handle(message('fresh', 'fresh human'));
  assert(f.codex.calls[1]!.signal.aborted);
  assert.equal(f.codex.calls.length, 2);
  f.codex.finish(1, 'stale automatic summary');
  await waitFor(() => f.codex.calls.length === 3);
  assert.equal(f.codex.calls[2]!.text, 'fresh human');
  assert.equal(f.codex.calls[2]!.conversation.nativeId, null);
  assert(f.sink.replies.every(item => !item.text.includes('stale automatic summary')));
  assert.equal(f.registry.eventState(event.id), 'uncertain');
  f.codex.finish(2);
});

test('子任务失败仍交回原父 Session 核对，回执正文明确不是用户授权', async t => {
  const f = fixture(t);
  await f.manager.handle(message('origin', 'delegate'));
  await waitFor(() => f.codex.calls.length === 1);
  const task = f.register(); f.codex.finish(0);
  await waitFor(() => f.inspect.getMessage('origin')?.replyState === 'delivered');
  f.registry.acceptObservedResult(task.taskId, 'failed', 'remote exit code 1');
  const event = f.registry.getNextEvent()!; f.manager.completionAvailable();
  await waitFor(() => f.codex.calls.length === 2);
  assert.match(f.codex.calls[1]!.text, /不是用户的新指令或新授权/);
  assert.match(f.codex.calls[1]!.text, /failed/);
  assert.match(f.codex.calls[1]!.text, /remote exit code 1/);
  f.codex.finish(1, 'child failed; verified');
  await waitFor(() => f.registry.eventState(event.id) === 'delivered');
});

for (const failure of ['generation', 'delivery'] as const) {
  test(`${failure} 失败持久标记 uncertain，不自动重跑、重派或重复汇总`, async t => {
    const f = fixture(t);
    await f.manager.handle(message('origin', 'delegate'));
    await waitFor(() => f.codex.calls.length === 1);
    const task = f.register(); f.codex.finish(0);
    await waitFor(() => f.inspect.getMessage('origin')?.replyState === 'delivered');
    f.registry.acceptObservedResult(task.taskId, 'completed', 'child done');
    const event = f.registry.getNextEvent()!; f.manager.completionAvailable();
    await waitFor(() => f.codex.calls.length === 2);
    if (failure === 'generation') f.codex.fail(1);
    else { f.sink.failSummary = true; f.codex.finish(1, 'parent summary'); }
    await waitFor(() => f.sink.replies.some(item => item.options?.presentation?.title === (failure === 'delivery' ? '【桥】汇报发送待核对' : '【桥】汇总失败')));
    const failureNotice = f.sink.replies.find(item => item.options?.presentation?.tone === 'error')!;
    assert(failureNotice.text.length < 100, '程序提示保持简短');
    assert.equal(failureNotice.options?.presentation?.title, failure === 'delivery' ? '【桥】汇报发送待核对' : '【桥】汇总失败');
    if (failure === 'delivery') {
      assert.equal(f.inspect.turnResult(event.id)?.result.text, 'parent summary');
      assert(f.sink.replies.find(item => item.text.includes('parent summary'))?.options?.deliveryKey);
    }
    assert.equal(f.registry.eventState(event.id), 'uncertain');
    const notices = f.sink.replies.length;
    await f.manager.close(); f.restart(); await f.manager.recover();
    f.manager.completionAvailable(); await setTimeout(20);
    assert.equal(f.codex.calls.length, 2);
    assert.equal(f.sink.replies.length, notices, '已经发送的失败提示不因重启刷屏');
  });
}

test('重启补收 queued 回执并原父 Session 续接，未结束数量保留但不发送数字', async t => {
  const f = fixture(t);
  await f.manager.handle(message('latest', 'delegate'));
  await waitFor(() => f.codex.calls.length === 1);
  const finished = f.register(0, 'finished'); f.register(0, 'still running'); f.codex.finish(0);
  await waitFor(() => f.inspect.getMessage('latest')?.replyState === 'delivered');
  f.registry.acceptObservedResult(finished.taskId, 'completed', 'pending across restart');
  const event = f.registry.getNextEvent()!;
  await f.manager.close(); f.restart(); await f.manager.recover();
  await waitFor(() => f.codex.calls.length === 2);
  assert.equal(f.codex.calls[1]!.conversation.nativeId, event.nativeId);
  assert.equal(f.registry.activeCount(event.conversationId), 1);
  assert.deepEqual(f.sink.counts, []);
  f.codex.finish(1);
  await waitFor(() => f.registry.eventState(event.id) === 'delivered');
});

test('processing 状态重启仅提示结果未知一次，不重复生成模型回复', async t => {
  const f = fixture(t);
  await f.manager.handle(message('origin', 'delegate'));
  await waitFor(() => f.codex.calls.length === 1);
  const task = f.register(); f.codex.finish(0);
  await waitFor(() => f.inspect.getMessage('origin')?.replyState === 'delivered');
  f.registry.acceptObservedResult(task.taskId, 'completed', 'child done');
  const event = f.registry.getNextEvent()!; assert(f.registry.claimEvent(event.id));
  await f.manager.close(); f.restart(); await f.manager.recover();
  assert.equal(f.registry.eventState(event.id), 'uncertain');
  assert.equal(f.codex.calls.length, 1);
  assert.equal(f.sink.replies.filter(item => item.options?.presentation?.title === '【桥】汇总中断').length, 1);
  await f.manager.close(); f.restart(); await f.manager.recover();
  assert.equal(f.sink.replies.filter(item => item.options?.presentation?.title === '【桥】汇总中断').length, 1);
});

test('原生父 Session 改变则仅提示，不自动新建或污染新绑定', async t => {
  const f = fixture(t);
  await f.manager.handle(message('origin', 'delegate'));
  await waitFor(() => f.codex.calls.length === 1);
  const task = f.register(); f.codex.finish(0);
  await waitFor(() => f.inspect.getMessage('origin')?.replyState === 'delivered');
  f.registry.acceptObservedResult(task.taskId, 'completed', 'child done');
  const event = f.registry.getNextEvent()!;
  f.inspect.saveNativeId(event.conversationId, 'different-native-id');
  f.manager.completionAvailable();
  await waitFor(() => f.registry.eventState(event.id) === 'uncertain');
  assert.equal(f.codex.calls.length, 1);
  assert.equal(f.inspect.getConversation(event.conversationId)?.nativeId, 'different-native-id');
  assert(f.sink.replies.some(item => item.options?.presentation?.title === '【桥】汇总未执行'));
});

test('伪造用户/channel 的任务来源不能投递到其他用户私聊', async t => {
  const f = fixture(t);
  await f.manager.handle(message('origin', 'delegate'));
  await waitFor(() => f.codex.calls.length === 1);
  const task = f.register(); f.codex.finish(0);
  await waitFor(() => f.inspect.getMessage('origin')?.replyState === 'delivered');
  f.registry.acceptObservedResult(task.taskId, 'completed', 'private result');
  const event = f.registry.getNextEvent()!;
  const db = new DatabaseSync(f.registry.path);
  try {
    const origin = { ...event, userId: 'u2', channelId: 'dm-u2' };
    db.prepare('UPDATE task_events SET origin_json=? WHERE id=?').run(JSON.stringify(origin), event.id);
  } finally { db.close(); }
  f.manager.completionAvailable();
  await waitFor(() => f.registry.eventState(event.id) === 'uncertain');
  assert.equal(f.codex.calls.length, 1);
  assert(f.sink.replies.every(item => item.channelId !== 'dm-u2'));
});

test('后台汇总复用原模型和附件发送流程', async t => {
  const f = fixture(t);
  await f.manager.handle(message('origin', 'delegate'));
  await waitFor(() => f.codex.calls.length === 1);
  const task = f.register(); f.codex.finish(0);
  await waitFor(() => f.inspect.getMessage('origin')?.replyState === 'delivered');
  f.inspect.setModel(f.codex.calls[0]!.conversation.id, 'gpt-6.1-sol');
  f.registry.acceptObservedResult(task.taskId, 'completed', 'file done');
  const event = f.registry.getNextEvent()!; f.manager.completionAvailable();
  await waitFor(() => f.codex.calls.length === 2);
  assert.equal(f.codex.calls[1]!.conversation.model, 'gpt-6.1-sol');
  const file = join(f.root, 'report.txt'); writeFileSync(file, 'verified result');
  f.codex.finish(1, `[报告](<${file}>)`);
  await waitFor(() => f.registry.eventState(event.id) === 'delivered');
  const reply = f.sink.replies.at(-1)!;
  assert.equal(reply.options?.files?.[0]?.filename, 'report.txt');
  assert.equal(Buffer.from(reply.options!.files![0]!.data).toString(), 'verified result');
  assert.match(reply.text, /6\.1-sol · 中/);
});

test('后台汇总本轮未回报 metadata 时明确未回报，不拿历史值冒充本轮', async t => {
  const f = fixture(t);
  await f.manager.handle(message('origin', 'delegate'));
  await waitFor(() => f.codex.calls.length === 1);
  const task = f.register(); f.codex.finish(0);
  await waitFor(() => f.inspect.getMessage('origin')?.replyState === 'delivered');
  f.codex.metadata = false;
  f.registry.acceptObservedResult(task.taskId, 'completed', 'child done');
  const event = f.registry.getNextEvent()!; f.manager.completionAvailable();
  await waitFor(() => f.codex.calls.length === 2);
  f.codex.finish(1, 'checked');
  await waitFor(() => f.registry.eventState(event.id) === 'delivered');
  assert.match(f.sink.replies.at(-1)!.text, /模型未知 · CLI 默认 · 未回报/);
  assert.equal(f.inspect.getConversation(event.conversationId)?.actualModel, 'gpt-6.1-sol', '历史记录仍保留供 status');
});

test('恢复通知网络等待期间不能提前启动完成汇总并被标成上次 processing', async t => {
  const f = fixture(t);
  await f.manager.handle(message('origin', 'delegate'));
  await waitFor(() => f.codex.calls.length === 1);
  const task = f.register(); f.codex.finish(0);
  await waitFor(() => f.inspect.getMessage('origin')?.replyState === 'delivered');
  f.registry.acceptObservedResult(task.taskId, 'completed', 'child done');
  const event = f.registry.getNextEvent()!;
  f.inspect.addMessage(message('crashed-human', 'unfinished'), event.conversationId, 'running');
  await f.manager.close(); f.restart();
  const send = f.sink.sendText.bind(f.sink);
  let waiting = false;
  let release!: () => void;
  const delayed = new Promise<void>(resolve => { release = resolve; });
  f.sink.sendText = async (channelId, text, options) => {
    if (options?.presentation?.title === '【桥】本轮中断') { waiting = true; await delayed; }
    await send(channelId, text, options);
  };
  const recovering = f.manager.recover();
  await waitFor(() => waiting);
  f.manager.completionAvailable();
  await setTimeout(20);
  assert.equal(f.codex.calls.length, 1);
  assert.equal(f.registry.eventState(event.id), 'queued');
  release(); await recovering;
  await waitFor(() => f.codex.calls.length === 2);
  assert.equal(f.registry.eventState(event.id), 'processing');
  assert.doesNotThrow(() => f.register(1, 'fresh continuation task'), '恢复后新context保持可登记');
  f.codex.finish(1);
  await waitFor(() => f.registry.eventState(event.id) === 'delivered');
});
