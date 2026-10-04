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
  const f = { root, config, codex, claude, sink, manager: new SessionManager(config, { codex, claude }, sink) };
  t.after(async () => { await f.manager.close(); rmSync(root, { recursive: true, force: true }); });
  return f;
}

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
  f.manager = new SessionManager(f.config, { codex, claude }, f.sink);
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
  await waitFor(() => f.codex.calls.length === 2);
  assert.equal(old.signal.aborted, true);
  assert.notEqual(f.codex.calls[1]!.conversation.id, old.conversation.id);
  assert.equal(f.codex.calls[1]!.conversation.nativeId, null);
  old.onProgress('stale progress');
  f.codex.finish(0, 'stale result');
  f.codex.finish(1, 'fresh result');
  await waitFor(() => f.sink.replies.some(item => item.text.includes('fresh result')));
  assert.ok(f.codex.interrupts.includes(old.conversation.id));
  assert.ok(f.sink.replies.every(item => !item.text.includes('stale')));
  assert.deepEqual(f.codex.calls.map(item => item.text), ['old work', 'fresh work']);
  const db = new SessionStore(f.config.dataDir);
  try { assert.equal(db.getMessage('queued')!.state, 'cancelled'); }
  finally { db.close(); }
});

test('切换 backend 创建独立会话，短 ID 可恢复原 backend 上下文', async t => {
  const f = fixture(t);
  await f.manager.handle(message('codex-start', 'codex context'));
  await waitFor(() => f.sink.replies.length === 1);
  const codexId = f.codex.calls[0]!.conversation.id;
  await f.manager.handle(message('agent', '/agent claude'));
  await f.manager.handle(message('claude-start', 'claude context'));
  await waitFor(() => f.claude.calls.length === 1);
  assert.notEqual(f.claude.calls[0]!.conversation.id, codexId);
  assert.equal(f.claude.calls[0]!.conversation.nativeId, null);
  await f.manager.handle(message('resume', `/resume ${codexId.slice(0, 8)}`));
  await f.manager.handle(message('codex-again', 'codex again'));
  await waitFor(() => f.codex.calls.length === 2);
  assert.equal(f.codex.calls[1]!.conversation.id, codexId);
  assert.equal(f.codex.calls[1]!.conversation.nativeId, `codex-${codexId}`);
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
  assert.match(f.sink.replies.at(-1)!.text, /没有找到自己的/);
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

test('不唯一的短 ID 要求更长 ID，不会切换会话', async t => {
  const f = fixture(t);
  await f.manager.close();
  const db = new SessionStore(f.config.dataDir);
  const groups = new Map<string, string[]>();
  let originalId = '';
  for (let i = 0; i < 17; i++) {
    const item = db.createConversation('u1', 'codex', f.root);
    originalId = item.id;
    const prefix = item.id[0]!;
    groups.set(prefix, [...(groups.get(prefix) ?? []), item.id]);
  }
  db.setActive('u1', originalId);
  const ambiguous = [...groups.entries()].find(([, ids]) => ids.length > 1)![0];
  db.close();
  f.manager = new SessionManager(f.config, { codex: f.codex, claude: f.claude }, f.sink);
  await f.manager.handle(message('ambiguous', `/resume ${ambiguous}`));
  assert.match(f.sink.replies.at(-1)!.text, /对应多个会话/);
  const inspect = new SessionStore(f.config.dataDir);
  try { assert.equal(inspect.getActive('u1')!.id, originalId); }
  finally { inspect.close(); }
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

test('忙中切换 Agent 取消旧任务和队列，旧结果不发到新 Agent 会话', async t => {
  const f = fixture(t, false);
  await f.manager.handle(message('old-agent-running', 'old'));
  await waitFor(() => f.codex.calls.length === 1);
  await f.manager.handle(message('old-agent-queued', 'discard'));
  await f.manager.handle(message('switch-busy-agent', '/agent claude'));
  assert.equal(f.codex.calls[0]!.signal.aborted, true);
  await f.manager.handle(message('new-agent-running', 'fresh'));
  await waitFor(() => f.claude.calls.length === 1);
  f.codex.finish(0, 'stale old agent answer');
  f.claude.finish(0, 'fresh Claude answer');
  await waitFor(() => f.sink.replies.some(reply => reply.text.endsWith('\n\nfresh Claude answer')));
  assert(f.sink.replies.every(reply => !reply.text.includes('stale old agent answer')));
  assert.equal(f.codex.calls.length, 1);
  const reply = f.sink.replies.at(-1)!.text;
  assert.match(reply, /^\[Claude Code ·/);
  assert(!reply.includes('✅'));
});
