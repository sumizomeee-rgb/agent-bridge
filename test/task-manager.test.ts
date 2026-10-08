import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { SessionManager } from '../src/manager.js';
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

test('登记数量移到最新普通消息，完成回执逐个减到零', async t => {
  const f = fixture(t);
  await f.manager.handle(message('first', 'delegate'));
  await waitFor(() => f.codex.calls.length === 1);
  const a = f.register(0, 'a'); const b = f.register(0, 'b');
  f.manager.refreshTaskCounts();
  await waitFor(() => f.sink.counts.some(item => item.id === 'first' && item.count === 2));
  await f.manager.handle(message('latest', 'more context'));
  await waitFor(() => f.sink.counts.some(item => item.id === 'latest' && item.count === 2));
  assert.equal(f.sink.counts.filter(item => item.id === 'first').at(-1)!.count, 0);
  f.registry.acceptObservedResult(a.taskId, 'completed', 'a done'); f.manager.completionAvailable();
  await waitFor(() => f.sink.counts.filter(item => item.id === 'latest').at(-1)?.count === 1);
  f.registry.acceptObservedResult(b.taskId, 'completed', 'b done'); f.manager.completionAvailable();
  await waitFor(() => f.sink.counts.filter(item => item.id === 'latest').at(-1)?.count === 0);
  assert.equal(f.codex.calls.length, 1, '数量刷新不会新建模型 turn');
});

for (const cmd of ['/new', '/stop', '/agent claude', '/cwd'] as const) {
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
    await waitFor(() => f.sink.replies.some(item => item.text.includes('未自动重做或重新派发')));
    assert.equal(f.registry.eventState(event.id), 'uncertain');
    const notices = f.sink.replies.length;
    await f.manager.close(); f.restart(); await f.manager.recover();
    f.manager.completionAvailable(); await setTimeout(20);
    assert.equal(f.codex.calls.length, 2);
    assert.equal(f.sink.replies.length, notices, '已经发送的失败提示不因重启刷屏');
  });
}

test('重启补收 queued 回执，恢复最新用户消息计数并原父 Session 续接', async t => {
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
  await waitFor(() => f.sink.counts.filter(item => item.id === 'latest').at(-1)?.count === 1);
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
  assert.equal(f.sink.replies.filter(item => item.text.includes('上次汇总或发送结果未知')).length, 1);
  await f.manager.close(); f.restart(); await f.manager.recover();
  assert.equal(f.sink.replies.filter(item => item.text.includes('上次汇总或发送结果未知')).length, 1);
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
  assert(f.sink.replies.some(item => item.text.includes('父会话身份无法确认')));
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

test('后台汇总本轮未回报 metadata 时显示未知，不拿历史值冒充本轮', async t => {
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
  assert.match(f.sink.replies.at(-1)!.text, /模型未知 · 强度未知/);
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
    if (text.startsWith('会话 ') && text.includes('未自动重做')) { waiting = true; await delayed; }
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
