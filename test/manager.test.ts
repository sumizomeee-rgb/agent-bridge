import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { SessionManager } from '../src/manager.js';
import { SessionStore } from '../src/store.js';
import type { AgentAdapter, AgentName, AgentResult, AgentTurn, BridgeConfig, BridgeMessage, ReplySink } from '../src/types.js';

class FakeAdapter implements AgentAdapter {
  readonly calls: AgentTurn[] = [];
  readonly interrupts: string[] = [];
  readonly pending: Array<{ turn: AgentTurn; resolve: (result: AgentResult) => void; reject: (error: Error) => void }> = [];
  constructor(readonly name: AgentName, private readonly auto = true) {}
  async run(turn: AgentTurn): Promise<AgentResult> {
    this.calls.push(turn);
    turn.onNativeId?.(`${this.name}-${turn.conversation.id}`);
    if (this.auto) return this.result(turn);
    return new Promise<AgentResult>((resolve, reject) => this.pending.push({ turn, resolve, reject }));
  }
  result(turn: AgentTurn, text = `reply:${turn.text}`): AgentResult {
    return { nativeId: `${this.name}-${turn.conversation.id}`, text };
  }
  finish(index: number, text?: string): void {
    const item = this.pending[index]!;
    item.resolve(this.result(item.turn, text));
  }
  async interrupt(id: string): Promise<void> { this.interrupts.push(id); }
  async close(): Promise<void> { for (const item of this.pending) item.resolve(this.result(item.turn)); }
}
class FakeSink implements ReplySink {
  readonly replies: Array<{ channelId: string; text: string }> = [];
  async sendText(channelId: string, text: string): Promise<void> { this.replies.push({ channelId, text }); }
}
async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('等待测试条件超时');
    await setTimeout(5);
  }
}
function message(id: string, text: string, userId = 'u1', imagePaths: string[] = []): BridgeMessage {
  return { id, userId, channelId: `dm-${userId}`, text, imagePaths };
}
function fixture(t: TestContext, auto = true) {
  const root = mkdtempSync(join(tmpdir(), 'discord-bridge-manager-'));
  const config: BridgeConfig = {
    token: '', allowedUserIds: ['u1', 'u2'], defaultAgent: 'codex', workspace: root,
    proxyUrl: null, commands: { codex: { command: 'fake', args: [] }, claude: { command: 'fake', args: [] } },
    dataDir: join(root, 'data'), attachmentsDir: join(root, 'images'), logsDir: join(root, 'logs'), maxImageBytes: 100,
  };
  const codex = new FakeAdapter('codex', auto);
  const claude = new FakeAdapter('claude', auto);
  const sink = new FakeSink();
  const f = { root, config, codex, claude, sink, manager: new SessionManager(config, { codex, claude }, sink, { mergeDelayMs: 0 }) };
  t.after(async () => { await f.manager.close(); rmSync(root, { recursive: true, force: true }); });
  return f;
}

test('回复全部送达并持久化后，合并及 accepted 补充的原始消息只标完成一次', async t => {
  t.after(() => inspect.close());
  const f = fixture(t, false);
  await f.manager.close();
  const completions: Array<Pick<BridgeMessage, 'id' | 'channelId'>[]> = [];
  let release!: () => void;
  const delivery = new Promise<void>(resolve => { release = resolve; });
  let deliveryStarted = false;
  const inspect = new SessionStore(f.config.dataDir);
  const adapter: AgentAdapter = {
    run(turn) { const result = f.codex.run(turn); turn.onReady?.(); return result; },
    async steer() { return { status: 'accepted' }; },
    interrupt: id => f.codex.interrupt(id),
    close: () => f.codex.close(),
  };
  f.manager = new SessionManager(f.config, { codex: adapter, claude: f.claude }, {
    async sendText(channelId, text) {
      if (text.startsWith('[Codex')) { deliveryStarted = true; await delivery; }
      await f.sink.sendText(channelId, text);
    },
    async markReplyDelivered(messages) {
      for (const item of messages) assert.equal(inspect.getMessage(item.id)?.replyState, 'delivered');
      assert.equal(inspect.getLastDelivery('u1', 'first-channel')?.nativeId, f.codex.result(f.codex.calls[0]!).nativeId);
      completions.push(messages);
    },
  }, { mergeDelayMs: 20 });
  await f.manager.handle({ ...message('merged-a', 'first'), channelId: 'first-channel' });
  await f.manager.handle({ ...message('merged-b', 'second'), channelId: 'second-channel' });
  await waitFor(() => f.codex.calls.length === 1);
  await f.manager.handle({ ...message('accepted-c', 'supplement'), channelId: 'third-channel' });
  await waitFor(() => inspect.getMessage('accepted-c')?.state === 'running');
  assert.equal(completions.length, 0);
  f.codex.finish(0);
  await waitFor(() => deliveryStarted);
  assert.equal(inspect.getMessage('merged-a')?.state, 'completed');
  assert.equal(inspect.getMessage('accepted-c')?.replyState, 'pending');
  assert.equal(completions.length, 0);
  release();
  await waitFor(() => completions.length === 1);
  await f.manager.handle(message('merged-a', 'duplicate'));
  assert.deepEqual(completions.map(group => group.map(({ id, channelId }) => ({ id, channelId }))), [[
    { id: 'merged-a', channelId: 'first-channel' },
    { id: 'merged-b', channelId: 'second-channel' },
    { id: 'accepted-c', channelId: 'third-channel' },
  ]]);
  assert.equal(f.codex.calls.length, 1);
});

test('部分投递后失败的模型回复不标完成', async t => {
  const f = fixture(t);
  await f.manager.close();
  let completions = 0;
  f.manager = new SessionManager(f.config, { codex: f.codex, claude: f.claude }, {
    async sendText(channelId, text) {
      if (text.startsWith('[Codex')) {
        await f.sink.sendText(channelId, 'first chunk delivered');
        throw new Error('later chunk failed');
      }
      await f.sink.sendText(channelId, text);
    },
    async markReplyDelivered() { completions++; },
  }, { mergeDelayMs: 0 });
  await f.manager.handle(message('partial-reply', 'work'));
  await waitFor(() => f.sink.replies.some(item => item.text.includes('later chunk failed')));
  const inspect = new SessionStore(f.config.dataDir);
  try {
    assert.equal(inspect.getMessage('partial-reply')?.state, 'completed');
    assert.equal(inspect.getMessage('partial-reply')?.replyState, 'failed');
    assert.equal(inspect.getLastDelivery('u1', 'dm-u1'), null);
  } finally { inspect.close(); }
  assert.equal(completions, 0);
  assert.equal(f.codex.calls.length, 1);
});

for (const reaction of ['throw', 'reject', 'pending'] as const) {
  test(`完成 reaction ${reaction} 不改变成功投递，也不阻塞下一轮`, async t => {
    const f = fixture(t);
    await f.manager.close();
    const marked: string[][] = [];
    f.manager = new SessionManager(f.config, { codex: f.codex, claude: f.claude }, {
      sendText: (channelId, text) => f.sink.sendText(channelId, text),
      markReplyDelivered(messages) {
        marked.push(messages.map(item => item.id));
        if (reaction === 'throw') throw new Error('reaction threw');
        if (reaction === 'reject') return Promise.reject(new Error('reaction rejected'));
        return new Promise<void>(() => {});
      },
    }, { mergeDelayMs: 0 });
    await f.manager.handle(message('reaction-first', 'first'));
    await f.manager.handle(message('reaction-second', 'second'));
    await waitFor(() => marked.length === 2);
    const inspect = new SessionStore(f.config.dataDir);
    try {
      for (const id of ['reaction-first', 'reaction-second']) assert.equal(inspect.getMessage(id)?.replyState, 'delivered');
    } finally { inspect.close(); }
    assert.equal(f.codex.calls.length, 2);
    assert.deepEqual(marked, [['reaction-first'], ['reaction-second']]);
    assert.equal(f.sink.replies.filter(item => item.text.startsWith('[Codex')).length, 2);
    assert(f.sink.replies.every(item => !item.text.includes('失败')));
  });
}

test('没有文字或图片的提示回复送达后也标完成，不启动 Agent', async t => {
  const f = fixture(t);
  await f.manager.close();
  const marked: string[] = [];
  let release!: () => void;
  const delivery = new Promise<void>(resolve => { release = resolve; });
  let started = false;
  f.manager = new SessionManager(f.config, { codex: f.codex, claude: f.claude }, {
    async sendText(channelId, text) { started = true; await delivery; await f.sink.sendText(channelId, text); },
    async markReplyDelivered(messages) { marked.push(...messages.map(item => item.id)); },
  });
  const handling = f.manager.handle(message('empty-message', ''));
  await waitFor(() => started);
  assert.deepEqual(marked, []);
  release();
  await handling;
  await waitFor(() => marked.length === 1);
  assert.deepEqual(marked, ['empty-message']);
  assert.equal(f.codex.calls.length + f.claude.calls.length, 0);
});

test('文字命令回复成功后才标完成，命令失败不标完成', async t => {
  const f = fixture(t);
  await f.manager.close();
  const completed: string[] = [];
  let release!: () => void;
  const delivery = new Promise<void>(resolve => { release = resolve; });
  let deliveryStarted = false;
  f.manager = new SessionManager(f.config, { codex: f.codex, claude: f.claude }, {
    async sendText(channelId, text) {
      if (!text.startsWith('命令失败')) { deliveryStarted = true; await delivery; }
      await f.sink.sendText(channelId, text);
    },
    async markReplyDelivered(messages) { completed.push(...messages.map(item => item.id)); },
  });
  const command = f.manager.handle(message('command-success', '/help'));
  await waitFor(() => deliveryStarted);
  assert.deepEqual(completed, []);
  release();
  await command;
  await waitFor(() => completed.length === 1);
  await f.manager.handle(message('command-failed', `/cwd ${join(f.root, 'missing-directory')}`));
  assert.deepEqual(completed, ['command-success']);
  const inspect = new SessionStore(f.config.dataDir);
  try { assert.equal(inspect.getMessage('command-failed')?.state, 'failed'); }
  finally { inspect.close(); }
  assert.equal(f.codex.calls.length, 0);
});

test('uncertain 补充不随已送达的主消息标完成', async t => {
  const f = fixture(t, false);
  await f.manager.close();
  const marked: string[][] = [];
  const adapter: AgentAdapter = {
    run(turn) { const result = f.codex.run(turn); turn.onReady?.(); return result; },
    async steer() { return { status: 'uncertain', reason: 'timeout' }; },
    interrupt: id => f.codex.interrupt(id),
    close: () => f.codex.close(),
  };
  f.manager = new SessionManager(f.config, { codex: adapter, claude: f.claude }, {
    sendText: (channelId, text) => f.sink.sendText(channelId, text),
    async markReplyDelivered(messages) { marked.push(messages.map(item => item.id)); },
  }, { mergeDelayMs: 0 });
  await f.manager.handle(message('main-delivery', 'first'));
  await waitFor(() => f.codex.calls.length === 1);
  await f.manager.handle(message('uncertain-supplement', 'supplement'));
  const inspect = new SessionStore(f.config.dataDir);
  try {
    await waitFor(() => inspect.getMessage('uncertain-supplement')?.state === 'uncertain');
    f.codex.finish(0);
    await waitFor(() => marked.length === 1);
    assert.deepEqual(marked, [['main-delivery']]);
    assert.equal(inspect.getMessage('uncertain-supplement')?.replyState, null);
  } finally { inspect.close(); }
});

test('模型已完成但投递期间取消，不标原始消息完成', async t => {
  const f = fixture(t);
  await f.manager.close();
  const marked: string[][] = [];
  let release!: () => void;
  const delivery = new Promise<void>(resolve => { release = resolve; });
  let deliveryStarted = false;
  f.manager = new SessionManager(f.config, { codex: f.codex, claude: f.claude }, {
    async sendText(channelId, text) {
      if (text.startsWith('[Codex')) { deliveryStarted = true; await delivery; }
      await f.sink.sendText(channelId, text);
    },
    async markReplyDelivered(messages) { marked.push(messages.map(item => item.id)); },
  }, { mergeDelayMs: 0 });
  await f.manager.handle(message('cancelled-delivery', 'work'));
  await waitFor(() => deliveryStarted);
  await f.manager.handle(message('stop-delivery', '/stop'));
  release();
  const inspect = new SessionStore(f.config.dataDir);
  try {
    await waitFor(() => inspect.getMessage('cancelled-delivery')?.replyState === 'cancelled');
    assert.equal(inspect.getLastDelivery('u1', 'dm-u1'), null);
  } finally { inspect.close(); }
  assert.deepEqual(marked, [['stop-delivery']]);
});

test('普通消息和图片持续同一会话，重复消息不会重复执行', async t => {
  const f = fixture(t);
  const first = message('first', 'hello', 'u1', [join(f.root, 'one.png')]);
  await f.manager.handle(first);
  await waitFor(() => f.sink.replies.length === 1);
  await f.manager.handle(first);
  await f.manager.handle(message('second', '继续'));
  await waitFor(() => f.sink.replies.length === 2);
  assert.equal(f.codex.calls.length, 2);
  assert.deepEqual(f.codex.calls[0]!.imagePaths, first.imagePaths);
  assert.equal(f.codex.calls[1]!.conversation.id, f.codex.calls[0]!.conversation.id);
  assert.equal(f.codex.calls[1]!.conversation.nativeId, `codex-${f.codex.calls[0]!.conversation.id}`);
  assert.ok(f.sink.replies.every(item => item.channelId === 'dm-u1'));
});

test('同一会话严格串行，后一条使用上一条持久化的 nativeId', async t => {
  const f = fixture(t, false);
  await f.manager.handle(message('a', 'first'));
  await f.manager.handle(message('b', 'second'));
  await waitFor(() => f.codex.calls.length === 1);
  const inspect = new SessionStore(f.config.dataDir);
  try {
    assert.equal(inspect.getConversation(f.codex.calls[0]!.conversation.id)!.nativeId,
      `codex-${f.codex.calls[0]!.conversation.id}`);
  } finally { inspect.close(); }
  await f.manager.handle(message('status', '/status'));
  assert.match(f.sink.replies.at(-1)!.text, /正在执行；排队 1 条/);
  f.codex.finish(0);
  await waitFor(() => f.codex.calls.length === 2);
  assert.equal(f.codex.calls[1]!.text, 'second');
  assert.equal(f.codex.calls[1]!.conversation.nativeId, `codex-${f.codex.calls[0]!.conversation.id}`);
  f.codex.finish(1);
  await waitFor(() => f.sink.replies.some(item => item.text.includes('reply:second')));
});

test('重启恢复 active binding、nativeId 和去重记录', async t => {
  const f = fixture(t);
  await f.manager.handle(message('before', 'before restart'));
  await waitFor(() => f.codex.calls.length === 1 && f.sink.replies.length === 1);
  const old = f.codex.calls[0]!.conversation;
  await f.manager.close();
  const codex = new FakeAdapter('codex');
  const claude = new FakeAdapter('claude');
  f.manager = new SessionManager(f.config, { codex, claude }, f.sink, { mergeDelayMs: 0 });
  await f.manager.recover();
  assert.equal(f.manager.hasMessage('before'), true);
  await f.manager.handle(message('before', 'duplicate'));
  await f.manager.handle(message('after', 'after restart'));
  await waitFor(() => codex.calls.length === 1);
  assert.equal(codex.calls[0]!.conversation.id, old.id);
  assert.equal(codex.calls[0]!.conversation.nativeId, `codex-${old.id}`);
  assert.equal(codex.calls[0]!.text, 'after restart');
});

test('new chat 取消旧队列，迟到结果和进度不会回复新会话', async t => {
  const f = fixture(t, false);
  await f.manager.handle(message('old', 'old work'));
  await f.manager.handle(message('queued', 'must not run'));
  await waitFor(() => f.codex.calls.length === 1);
  const old = f.codex.calls[0]!;
  await f.manager.handle(message('new-command', 'new chat'));
  await f.manager.handle(message('fresh', 'fresh work'));
  assert.equal(f.codex.calls.length, 1, '新会话等待旧 CLI 退出，不并行启动同用户 turn');
  f.codex.finish(0, 'stale result');
  await waitFor(() => f.codex.calls.length === 2);
  assert.equal(old.signal.aborted, true);
  assert.notEqual(f.codex.calls[1]!.conversation.id, old.conversation.id);
  assert.equal(f.codex.calls[1]!.conversation.nativeId, null);
  old.onProgress('stale progress');
  f.codex.finish(1, 'fresh result');
  await waitFor(() => f.sink.replies.some(item => item.text.includes('fresh result')));
  assert.ok(f.codex.interrupts.includes(old.conversation.id));
  assert.ok(f.sink.replies.every(item => !item.text.includes('stale')));
  assert.deepEqual(f.codex.calls.map(item => item.text), ['old work', 'fresh work']);
  const db = new SessionStore(f.config.dataDir);
  try { assert.equal(db.getMessage('queued')!.state, 'cancelled'); }
  finally { db.close(); }
});

test('/agent 来回切换始终交接最新上下文，不恢复旧后端分支', async t => {
  const f = fixture(t);
  await f.manager.handle(message('codex-start', 'codex context'));
  await waitFor(() => f.sink.replies.length === 1);
  const codexId = f.codex.calls[0]!.conversation.id;
  await f.manager.handle(message('agent', '/agent claude'));
  await f.manager.handle(message('claude-start', 'claude context'));
  await waitFor(() => f.claude.calls.length === 1);
  assert.notEqual(f.claude.calls[0]!.conversation.id, codexId);
  assert.equal(f.claude.calls[0]!.conversation.nativeId, null);
  await f.manager.handle(message('switch-back', '/agent codex'));
  await f.manager.handle(message('codex-again', 'codex again'));
  await waitFor(() => f.codex.calls.length === 2);
  assert.notEqual(f.codex.calls[1]!.conversation.id, codexId);
  assert.equal(f.codex.calls[1]!.conversation.nativeId, null);
  assert.match(f.codex.calls[1]!.conversation.contextSeed!, /claude context/);
  assert.match(f.codex.calls[1]!.conversation.contextSeed!, /codex context/);
  assert.equal(f.claude.calls.length, 1);
});

test('会话列表和恢复按用户隔离，白名单之外不会执行', async t => {
  const f = fixture(t);
  await f.manager.handle(message('one', 'private-one', 'u1'));
  await f.manager.handle(message('two', 'private-two', 'u2'));
  await waitFor(() => f.codex.calls.length === 2 && f.sink.replies.length === 2);
  const u1 = f.codex.calls.find(item => item.conversation.userId === 'u1')!;
  const u2 = f.codex.calls.find(item => item.conversation.userId === 'u2')!;
  assert.notEqual(u1.conversation.id, u2.conversation.id);
  await f.manager.handle(message('steal', `/resume ${u1.conversation.id}`, 'u2'));
  assert.match(f.sink.replies.at(-1)!.text, /未知命令/);
  const inspect = new SessionStore(f.config.dataDir);
  try { assert.equal(inspect.getActive('u2')!.id, u2.conversation.id); }
  finally { inspect.close(); }
  await f.manager.handle(message('list', '/chats', 'u2'));
  assert.ok(f.sink.replies.at(-1)!.text.includes('private-two'));
  assert.ok(!f.sink.replies.at(-1)!.text.includes('private-one'));
  await f.manager.handle(message('unauthorized', 'run', 'stranger'));
  assert.equal(f.manager.hasMessage('unauthorized'), false);
  assert.equal(f.codex.calls.length, 2);
});

test('崩溃后的 running 不会自动重做，queued 按保存的会话继续', async t => {
  const f = fixture(t);
  await f.manager.close();
  const db = new SessionStore(f.config.dataDir);
  const session = db.createConversation('u1', 'codex', f.root);
  db.setActive('u1', session.id);
  db.saveNativeId(session.id, 'native-before-crash');
  db.addMessage(message('crashed', 'already changed files'), session.id, 'running');
  db.addMessage(message('waiting', 'queued after crash', 'u1', [join(f.root, 'saved.png')]), session.id, 'queued');
  db.close();
  const codex = new FakeAdapter('codex', false);
  f.manager = new SessionManager(f.config, { codex, claude: new FakeAdapter('claude') }, f.sink);
  await f.manager.recover();
  await f.manager.recover();
  await waitFor(() => codex.calls.length === 1);
  assert.equal(codex.calls[0]!.text, 'queued after crash');
  assert.equal(codex.calls[0]!.conversation.nativeId, 'native-before-crash');
  assert.deepEqual(codex.calls[0]!.imagePaths, [join(f.root, 'saved.png')]);
  assert.equal(f.sink.replies.filter(item => item.text.includes('未自动重做')).length, 1);
  const inspect = new SessionStore(f.config.dataDir);
  try { assert.equal(inspect.getMessage('crashed')!.state, 'interrupted'); }
  finally { inspect.close(); }
  codex.finish(0);
  await waitFor(() => f.sink.replies.some(item => item.text.includes('reply:queued after crash')));
});

test('/stop 清空队列但保留会话和已及时保存的 nativeId', async t => {
  const f = fixture(t, false);
  await f.manager.handle(message('old', 'old'));
  await f.manager.handle(message('discard', 'discard'));
  await waitFor(() => f.codex.calls.length === 1);
  const first = f.codex.calls[0]!;
  await f.manager.handle(message('stop', '/stop'));
  f.codex.finish(0, 'cancelled result');
  await f.manager.handle(message('next', 'continue after stop'));
  await waitFor(() => f.codex.calls.length === 2);
  assert.equal(f.codex.calls[1]!.conversation.id, first.conversation.id);
  assert.equal(f.codex.calls[1]!.conversation.nativeId, `codex-${first.conversation.id}`);
  f.codex.finish(1);
  await waitFor(() => f.sink.replies.some(item => item.text.includes('reply:continue after stop')));
  assert.ok(f.sink.replies.every(item => !item.text.includes('cancelled result')));
  assert.equal(f.codex.calls.length, 2);
});

test('/cwd 新建会话，已有会话目录保持原值', async t => {
  const f = fixture(t);
  const other = join(f.root, 'other workspace');
  mkdirSync(other);
  await f.manager.handle(message('first', 'original'));
  await waitFor(() => f.codex.calls.length === 1 && f.sink.replies.length === 1);
  await f.manager.handle(message('cwd', `/cwd "${other}"`));
  await f.manager.handle(message('next', 'in new directory'));
  await waitFor(() => f.codex.calls.length === 2);
  assert.equal(f.codex.calls[0]!.conversation.cwd, f.root);
  assert.equal(f.codex.calls[1]!.conversation.cwd, other);
  assert.notEqual(f.codex.calls[0]!.conversation.id, f.codex.calls[1]!.conversation.id);
});

test('已失败的模型任务不重放，用户可以手动继续', async t => {
  const f = fixture(t, false);
  await f.manager.handle(message('fails', 'fails'));
  await waitFor(() => f.codex.calls.length === 1);
  f.codex.pending[0]!.reject(new Error('fake failure'));
  await waitFor(() => f.sink.replies.some(item => item.text.includes('fake failure')));
  await f.manager.handle(message('fails', 'duplicate'));
  await f.manager.handle(message('retry-explicit', 'user explicitly continues'));
  await waitFor(() => f.codex.calls.length === 2);
  assert.deepEqual(f.codex.calls.map(item => item.text), ['fails', 'user explicitly continues']);
  f.codex.finish(1);
  await waitFor(() => f.sink.replies.some(item => item.text.includes('reply:user explicitly continues')));
});

test('恢复时移出白名单的用户不能执行旧 queued', async t => {
  const f = fixture(t);
  await f.manager.close();
  const db = new SessionStore(f.config.dataDir);
  const session = db.createConversation('u2', 'codex', f.root);
  db.setActive('u2', session.id);
  db.addMessage(message('removed-user', 'must not execute', 'u2'), session.id, 'queued');
  db.close();
  f.manager = new SessionManager({ ...f.config, allowedUserIds: ['u1'] }, { codex: f.codex, claude: f.claude }, f.sink);
  await f.manager.recover();
  const inspect = new SessionStore(f.config.dataDir);
  try { await waitFor(() => inspect.getMessage('removed-user')!.state === 'cancelled'); }
  finally { inspect.close(); }
  assert.equal(f.codex.calls.length, 0);
});

test('恢复通知发送失败不阻止安全排队任务继续', async t => {
  const f = fixture(t);
  await f.manager.close();
  const db = new SessionStore(f.config.dataDir);
  const session = db.createConversation('u1', 'codex', f.root);
  db.setActive('u1', session.id);
  db.addMessage(message('crashed', 'crashed'), session.id, 'running');
  db.addMessage(message('queued', 'safe queued'), session.id, 'queued');
  db.close();
  const sink: ReplySink = {
    async sendText(channelId, text) {
      if (text.includes('未自动重做')) throw new Error('temporary reply error');
      await f.sink.sendText(channelId, text);
    },
  };
  f.manager = new SessionManager(f.config, { codex: f.codex, claude: f.claude }, sink);
  await f.manager.recover();
  await waitFor(() => f.sink.replies.length === 1);
  assert.deepEqual(f.codex.calls.map(item => item.text), ['safe queued']);
});

test('旧 /resume 的完整、短、原生和无效 ID 都被拒绝，不改绑定或启动适配器', async t => {
  const f = fixture(t);
  await f.manager.close();
  const db = new SessionStore(f.config.dataDir);
  const original = db.createConversation('u1', 'codex', f.root);
  const historical = db.createConversation('u1', 'claude', f.root);
  db.saveNativeId(original.id, 'native-current');
  db.saveNativeId(historical.id, 'native-historical');
  db.setActive('u1', original.id);
  db.addMessage(message('historical-queued', 'must not execute'), historical.id, 'queued');
  db.close();
  f.manager = new SessionManager(f.config, { codex: f.codex, claude: f.claude }, f.sink);
  const argumentsToReject = ['', historical.id, historical.id.slice(0, 8), 'native-historical', original.id, 'invalid-id', 'claude'];
  for (const [index, argument] of argumentsToReject.entries()) {
    await f.manager.handle(message(`disabled-resume-${index}`, `/resume ${argument}`));
    assert.match(f.sink.replies.at(-1)!.text, /未知命令/);
    const inspect = new SessionStore(f.config.dataDir);
    try {
      assert.equal(inspect.getActive('u1')!.id, original.id);
      assert.equal(inspect.getActive('u1')!.nativeId, 'native-current');
      assert.equal(inspect.getMessage('historical-queued')!.state, 'queued');
    } finally { inspect.close(); }
  }
  assert.equal(f.codex.calls.length, 0);
  assert.equal(f.claude.calls.length, 0);
  assert.deepEqual(f.codex.interrupts, []);
  await f.manager.handle(message('readonly-chats', '/chats'));
  assert.match(f.sink.replies.at(-1)!.text, new RegExp(original.id.slice(0, 8)));
  assert.match(f.sink.replies.at(-1)!.text, new RegExp(historical.id.slice(0, 8)));
  assert.equal(f.codex.calls.length + f.claude.calls.length, 0);
  await f.manager.handle(message('current-help', '/help'));
  assert(!f.sink.replies.at(-1)!.text.includes('/resume'));
  await f.manager.handle(message('current-agent-menu', '/agent'));
  assert(!f.sink.replies.at(-1)!.text.includes('/resume'));
});

test('关闭桥时未完成的命令回复不会访问已关闭的数据库', async t => {
  const f = fixture(t);
  await f.manager.close();
  let release!: () => void;
  const reply = new Promise<void>(resolve => { release = resolve; });
  f.manager = new SessionManager(f.config, { codex: f.codex, claude: f.claude }, {
    async sendText() { await reply; },
  });
  const command = f.manager.handle(message('new-in-flight', '/new'));
  await f.manager.close();
  release();
  await command;
  const inspect = new SessionStore(f.config.dataDir);
  try {
    assert.equal(inspect.hasMessage('new-in-flight'), true);
    assert.equal(inspect.getActive('u1')!.agent, 'codex');
  } finally { inspect.close(); }
});

test('忙中选择当前 Agent 不取消运行或排队任务，随后继续同一原生会话', async t => {
  const f = fixture(t, false);
  await f.manager.handle(message('running-current', 'running'));
  await waitFor(() => f.codex.calls.length === 1);
  await f.manager.handle(message('queued-current', 'queued'));
  const running = f.codex.calls[0]!;
  await f.manager.handle(message('choose-current', '/agent codex'));
  assert.match(f.sink.replies.at(-1)!.text, /继续原会话/);
  assert.equal(running.signal.aborted, false);
  const inspect = new SessionStore(f.config.dataDir);
  try {
    assert.equal(inspect.getActive('u1')!.id, running.conversation.id);
    assert.equal(inspect.pendingCount(running.conversation.id), 1);
  } finally { inspect.close(); }
  f.codex.finish(0);
  await waitFor(() => f.codex.calls.length === 2);
  assert.equal(f.codex.calls[1]!.conversation.id, running.conversation.id);
  f.codex.finish(1);
  await waitFor(() => f.sink.replies.some(reply => reply.text.endsWith('\n\nreply:queued')));
});

test('忙中切换 Agent 等待当前轮安全结束，排队输入交给最新主控', async t => {
  const f = fixture(t, false);
  await f.manager.handle(message('old-agent-running', 'old'));
  await waitFor(() => f.codex.calls.length === 1);
  await f.manager.handle(message('old-agent-queued', 'carry-forward'));
  const switching = f.manager.handle(message('switch-busy-agent', '/agent claude'));
  await setTimeout(0);
  assert.equal(f.codex.calls[0]!.signal.aborted, false);
  assert.equal(f.claude.calls.length, 0);
  f.codex.finish(0, 'safe old answer');
  await switching;
  await waitFor(() => f.claude.calls.length === 1);
  assert.match(f.claude.calls[0]!.text, /carry-forward/);
  f.claude.finish(0, 'fresh Claude answer');
  await waitFor(() => f.sink.replies.some(reply => reply.text.endsWith('\n\nfresh Claude answer')));
  assert(f.sink.replies.some(reply => reply.text.endsWith('\n\nsafe old answer')));
  assert.equal(f.codex.calls.length, 1);
});

test('merged and steered inputs retain each real source instead of relabeling the batch as its last sender', async t => {
  const f = fixture(t, false); await f.manager.close();
  const steered: Parameters<NonNullable<AgentAdapter['steer']>>[1][] = [];
  const adapter: AgentAdapter = { run: turn => { const pending = f.codex.run(turn); turn.onReady?.(); return pending; },
    steer: async (_id, input) => { steered.push(input); return { status: 'accepted' }; }, interrupt: id => f.codex.interrupt(id), close: () => f.codex.close() };
  f.manager = new SessionManager(f.config, { codex: adapter, claude: f.claude }, f.sink, { mergeDelayMs: 20 });
  const first = { ...message('label-a', '第一个输入'), source: { messageId: 'real-a', userId: 'actual-a', channelId: 'origin-a', authorType: 'user' as const, time: '2026-10-17T10:00:00Z' } };
  const second = { ...message('label-b', '第二个输入'), source: { messageId: 'real-b', userId: 'actual-b', channelId: 'origin-b', authorType: 'user' as const } };
  await f.manager.handle(first); await f.manager.handle(second);
  await waitFor(() => f.codex.calls.length === 1);
  const main = f.codex.calls[0]!;
  assert.equal(main.source?.userId, 'u1'); assert.deepEqual(main.source?.original, first.source);
  const blocks = main.input!.filter(item => item.type === 'text').map(item => item.text);
  assert.match(blocks[0]!, /actual-a/); assert.equal(blocks[1], '第一个输入'); assert.match(blocks[2]!, /actual-b/); assert.equal(blocks[3], '第二个输入');
  const third = { ...message('label-c', '补充'), source: { messageId: 'real-c', userId: 'actual-c', channelId: 'origin-c', authorType: 'user' as const } };
  await f.manager.handle(third); await waitFor(() => steered.length === 1);
  assert.deepEqual(steered[0]!.source?.original, third.source); assert.equal(steered[0]!.source?.channelId, 'dm-u1');
  assert.match(JSON.stringify(steered[0]!.input), /actual-c/); assert.doesNotMatch(JSON.stringify(steered[0]!.input), /actual-a|actual-b/);
  f.codex.finish(0); await waitFor(() => f.sink.replies.some(item => item.text.startsWith('[Codex')));
});

test('private turns automatically receive active-group scene while keeping native continuity and original reply address', async t => {
  const f = fixture(t); await f.manager.close();
  const seen: { source: NonNullable<AgentTurn['source']>; nativeId: string | null }[] = [];
  f.manager = new SessionManager(f.config, { codex: f.codex, claude: f.claude }, f.sink, { mergeDelayMs: 0,
    onConversationScene: async (conversation, source, signal) => { assert.equal(signal.aborted, false); seen.push({ source, nativeId: conversation.nativeId }); return JSON.stringify({ groups: [{ spaceId: 'g', recent: [{ author: 'non-owner', text: '讨论材料' }] }] }); },
  });
  await f.manager.handle(message('scene-private-1', '那个群在聊什么'));
  await waitFor(() => f.sink.replies.length === 1);
  await f.manager.handle(message('scene-private-2', '继续'));
  await waitFor(() => f.sink.replies.length === 2);
  assert.equal(seen.length, 2); assert.equal(seen[0]!.source.channelId, 'dm-u1');
  assert.equal(seen[0]!.nativeId, null); assert.equal(seen[1]!.nativeId, f.codex.result(f.codex.calls[0]!).nativeId);
  assert.match(f.codex.calls[0]!.chatScene!, /non-owner/); assert.match(f.codex.calls[1]!.chatScene!, /讨论材料/);
  assert.equal(f.codex.calls[0]!.conversation.id, f.codex.calls[1]!.conversation.id);
  assert.ok(f.sink.replies.every(item => item.channelId === 'dm-u1'));
});

test('scene acquisition cannot dispatch a stale controller turn after shutdown', async t => {
  const f = fixture(t); await f.manager.close();
  let release!: (scene: string) => void, acquiring = false;
  const scene = new Promise<string>(resolve => { release = resolve; });
  f.manager = new SessionManager(f.config, { codex: f.codex, claude: f.claude }, f.sink, { mergeDelayMs: 0,
    onConversationScene: async () => { acquiring = true; return scene; },
  });
  await f.manager.handle(message('scene-cancel', '了解当前群'));
  await waitFor(() => acquiring);
  const closing = f.manager.close(); release('{"groups":[]}'); await closing;
  assert.equal(f.codex.calls.length, 0);
});
