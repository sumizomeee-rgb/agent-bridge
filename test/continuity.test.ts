import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { SessionManager } from '../src/manager.js';
import { SessionStore } from '../src/store.js';
import { OrderedInbox } from '../src/inbox.js';
import type { AgentAdapter, AgentResult, AgentSupplement, AgentTurn, BridgeConfig, BridgeMessage, SteerResult } from '../src/types.js';

function gate<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}
async function waitFor(predicate: () => boolean) {
  const end = Date.now() + 3000;
  while (!predicate()) { if (Date.now() > end) throw new Error('等待超时'); await delay(5); }
}
class Adapter implements AgentAdapter {
  calls: AgentTurn[] = [];
  turns: ReturnType<typeof gate<AgentResult>>[] = [];
  supplements: AgentSupplement[] = [];
  steering: ReturnType<typeof gate<SteerResult>>[] = [];
  ready = true;
  async run(turn: AgentTurn) {
    this.calls.push(turn);
    turn.onNativeId?.('native-test');
    const result = gate<AgentResult>();
    this.turns.push(result);
    if (this.ready) turn.onReady?.();
    return result.promise;
  }
  async steer(_id: string, message: AgentSupplement) {
    this.supplements.push(message);
    const result = gate<SteerResult>();
    this.steering.push(result);
    return result.promise;
  }
  finish(index = 0) { this.turns[index]!.resolve({ nativeId: 'native-test', text: '完成' }); }
  async interrupt() { for (const turn of this.turns) turn.reject(new Error('cancelled')); }
  async close() {
    for (const turn of this.turns) turn.resolve({ nativeId: 'native-test', text: '关闭' });
    for (const result of this.steering) result.resolve({ status: 'uncertain', reason: '关闭' });
  }
}
function fixture(t: TestContext, options: { mergeDelayMs?: number } = { mergeDelayMs: 20 }, support = true) {
  const root = mkdtempSync(join(tmpdir(), 'bridge-continuity-'));
  const config: BridgeConfig = { token: '', allowedUserIds: ['u'], defaultAgent: 'codex', workspace: root,
    proxyUrl: null, commands: { codex: { command: 'fake', args: [] }, claude: { command: 'fake', args: [] } },
    dataDir: join(root, 'data'), attachmentsDir: join(root, 'images'), logsDir: join(root, 'logs'), maxImageBytes: 100 };
  const adapter = new Adapter();
  const replies: string[] = [];
  const backend: AgentAdapter = support ? adapter : { run: turn => adapter.run(turn), interrupt: () => adapter.interrupt(), close: () => adapter.close() };
  const sink = { sendText: async (_channel: string, text: string) => { replies.push(text); } };
  const manager = new SessionManager(config, { codex: backend, claude: backend }, sink, options);
  const store = new SessionStore(config.dataDir);
  t.after(async () => { await manager.close(); store.close(); rmSync(root, { recursive: true, force: true }); });
  const message = (id: string, text = id, imagePaths: string[] = []): BridgeMessage => ({ id, text, imagePaths, userId: 'u', channelId: 'dm' });
  return { root, config, adapter, replies, manager, store, message, sink };
}

test('默认约一秒合并窗口，原始 ID 全部持久化，图片文字交错顺序保留', async t => {
  const f = fixture(t, {});
  await f.manager.handle(f.message('a', '文字一', ['image-a']));
  await delay(80);
  await f.manager.handle(f.message('b', '', ['image-b']));
  await f.manager.handle(f.message('c', '文字三'));
  await f.manager.handle(f.message('b', '重复'));
  assert.equal(f.adapter.calls.length, 0);
  assert.equal(f.store.getMessage('b')?.state, 'queued');
  await waitFor(() => f.adapter.calls.length === 1);
  assert.deepEqual(f.adapter.calls[0]!.input, [
    { type: 'text', text: '文字一' }, { type: 'localImage', path: 'image-a' },
    { type: 'localImage', path: 'image-b' }, { type: 'text', text: '文字三' },
  ]);
  f.adapter.finish();
  await waitFor(() => f.store.getMessage('c')?.replyState === 'delivered');
  for (const id of ['a', 'b', 'c']) assert.equal(f.store.getMessage(id)?.state, 'completed');
  assert.equal(f.adapter.calls.length, 1);
});

test('执行中补充在当前轮收到，确认前持久化 steering；去重及反馈节流', async t => {
  const f = fixture(t);
  await f.manager.handle(f.message('a'));
  await waitFor(() => f.adapter.calls.length === 1);
  await f.manager.handle(f.message('b', '补充', ['image']));
  await waitFor(() => f.adapter.supplements.length === 1);
  assert.equal(f.store.getMessage('b')?.state, 'steering');
  f.adapter.steering[0]!.resolve({ status: 'accepted' });
  await waitFor(() => f.store.getMessage('b')?.state === 'running');
  await f.manager.handle(f.message('b'));
  await f.manager.handle(f.message('c'));
  await waitFor(() => f.adapter.supplements.length === 2);
  f.adapter.steering[1]!.resolve({ status: 'accepted' });
  await waitFor(() => f.store.getMessage('c')?.state === 'running');
  assert.deepEqual(f.adapter.supplements[0]!.input, [{ type: 'text', text: '补充' }, { type: 'localImage', path: 'image' }]);
  assert.equal(f.replies.filter(text => text.includes('已收到')).length, 1);
  f.adapter.finish();
  await waitFor(() => f.store.getMessage('c')?.state === 'completed');
  assert.equal(f.adapter.calls.length, 1);
});

for (const status of ['accepted', 'queued', 'uncertain'] as const) {
  test(`完成竞态：在途 steer ${status} 不重复或丢失`, async t => {
    const f = fixture(t);
    await f.manager.handle(f.message('a'));
    await waitFor(() => f.adapter.calls.length === 1);
    await f.manager.handle(f.message('b'));
    await waitFor(() => f.adapter.steering.length === 1);
    f.adapter.finish();
    await delay(30);
    assert.equal(f.store.getMessage('a')?.state, 'completed');
    assert.equal(f.store.getMessage('a')?.replyState, 'pending');
    f.adapter.steering[0]!.resolve(status === 'uncertain' ? { status, reason: '超时' } : { status });
    if (status === 'queued') {
      await waitFor(() => f.adapter.calls.length === 2);
      assert.equal(f.adapter.calls[1]!.text, 'b');
      f.adapter.finish(1);
    }
    await waitFor(() => f.store.getMessage('a')?.replyState === 'delivered');
    if (status === 'queued') await waitFor(() => f.store.getMessage('b')?.state === 'completed');
    assert.equal(f.adapter.calls.length, status === 'queued' ? 2 : 1);
    assert.equal(f.store.getMessage('b')?.state, status === 'uncertain' ? 'uncertain' : 'completed');
  });
}

test('准备中消息在 Codex ready 后补入；拒绝后的后续消息只排队', async t => {
  const f = fixture(t);
  f.adapter.ready = false;
  await f.manager.handle(f.message('a'));
  await waitFor(() => f.adapter.calls.length === 1);
  await f.manager.handle(f.message('b'));
  assert.equal(f.adapter.steering.length, 0);
  f.adapter.calls[0]!.onReady?.();
  await waitFor(() => f.adapter.steering.length === 1);
  f.adapter.steering[0]!.resolve({ status: 'queued' });
  await waitFor(() => f.store.getMessage('b')?.state === 'queued');
  await f.manager.handle(f.message('c'));
  assert.equal(f.adapter.steering.length, 1);
  f.adapter.finish();
  await waitFor(() => f.adapter.calls.length === 2);
  assert.equal(f.adapter.calls[1]!.text, 'b\n\nc');
  f.adapter.finish(1);
});

for (const command of ['/stop', '/new', '/cwd .']) {
  test(`${command} 在途补充及时取消，迟到接受和旧结果不串会话`, async t => {
    const f = fixture(t);
    await f.manager.handle(f.message('a'));
    await waitFor(() => f.adapter.calls.length === 1);
    const revision = f.manager.revision('u');
    await f.manager.handle(f.message('b'));
    await waitFor(() => f.adapter.steering.length === 1);
    await f.manager.handle(f.message('command', command));
    assert.equal(f.adapter.calls[0]!.signal.aborted, true);
    assert.equal(f.manager.revision('u'), revision + 1);
    assert.equal(f.store.getMessage('b')?.state, 'cancelled');
    f.adapter.steering[0]!.resolve({ status: 'accepted' });
    await delay(30);
    assert.equal(f.store.getMessage('b')?.state, 'cancelled');
    assert.ok(!f.replies.some(text => text.includes('已交给')));
    assert.equal(f.adapter.calls.length, 1);
  });
}

test('不支持补充的后端可靠排队并轻量提示，不丢图片', async t => {
  const f = fixture(t, { mergeDelayMs: 20 }, false);
  await f.manager.handle(f.message('a'));
  await waitFor(() => f.adapter.calls.length === 1);
  await f.manager.handle(f.message('b', '', ['image-b']));
  await f.manager.handle(f.message('c'));
  assert.equal(f.replies.length, 1);
  assert.match(f.replies[0]!, /后端.*本轮结束/);
  f.adapter.finish();
  await waitFor(() => f.adapter.calls.length === 2);
  assert.deepEqual(f.adapter.calls[1]!.input, [{ type: 'localImage', path: 'image-b' }, { type: 'text', text: 'c' }]);
  f.adapter.finish(1);
});

test('重启不重放 running、steering、uncertain 或 completed 未投递消息；保留原 ID 去重', async t => {
  const f = fixture(t);
  await f.manager.close();
  const conversation = f.store.createConversation('u', 'codex', f.root);
  f.store.setActive('u', conversation.id);
  for (const state of ['running', 'steering', 'uncertain', 'completed'] as const) {
    f.store.addMessage(f.message(state), conversation.id, state);
  }
  f.store.setReplyState(['completed'], 'pending');
  const recovered = new SessionManager(f.config, { codex: f.adapter, claude: f.adapter }, f.sink, { mergeDelayMs: 20 });
  try {
    await recovered.recover();
    await delay(50);
    assert.equal(f.adapter.calls.length, 0);
    assert.equal(f.store.getMessage('steering')?.state, 'interrupted');
    assert.equal(f.store.getMessage('completed')?.state, 'completed');
    assert.equal(f.store.getMessage('completed')?.replyState, 'failed');
    assert.equal(f.replies.length, 1);
    for (const id of ['running', 'steering', 'uncertain', 'completed']) {
      await recovered.handle(f.message(id));
      assert.equal(recovered.hasMessage(id), true);
    }
    assert.equal(f.adapter.calls.length, 0);
  } finally { await recovered.close(); }
});

test('投递失败不重做原消息及已接受补充，执行和投递状态分开', async t => {
  const f = fixture(t);
  f.sink.sendText = async () => { throw new Error('Discord offline'); };
  await f.manager.handle(f.message('a'));
  await waitFor(() => f.adapter.calls.length === 1);
  await f.manager.handle(f.message('b'));
  await waitFor(() => f.adapter.steering.length === 1);
  f.adapter.steering[0]!.resolve({ status: 'accepted' });
  await waitFor(() => f.store.getMessage('b')?.state === 'running');
  f.adapter.finish();
  await waitFor(() => f.store.getMessage('b')?.replyState === 'failed');
  await f.manager.handle(f.message('b'));
  assert.equal(f.store.getMessage('b')?.state, 'completed');
  assert.equal(f.adapter.calls.length, 1);
});

test('慢附件前的控制命令越过准备链，旧附件持久化取消；后续消息按新绑定处理', async t => {
  const f = fixture(t);
  const preparation = gate<void>();
  const inbox = new OrderedInbox<BridgeMessage & { revision: number }>(m => m.userId, async m => {
    if (m.id === 'image') await preparation.promise;
    if (m.text[0] !== '/' && m.revision !== f.manager.revision(m.userId)) f.manager.discard(m);
    else await f.manager.handle(m);
  });
  const old = inbox.handle({ ...f.message('image', '', ['old-image']), revision: 0 });
  await delay(10);
  await inbox.handle({ ...f.message('stop', '/stop'), revision: 0 }, true);
  // 即使尚无 Agent 会话，控制命令也使准备中的消息失效。
  assert.equal(f.manager.revision('u'), 1);
  const fresh = inbox.handle({ ...f.message('fresh'), revision: 1 });
  preparation.resolve();
  await Promise.all([old, fresh]);
  await waitFor(() => f.adapter.calls.length === 1);
  assert.equal(f.store.getMessage('image')?.state, 'cancelled');
  assert.equal(f.adapter.calls[0]!.text, 'fresh');
  f.adapter.finish();
});

test('控制命令结束后旧准备仍未完成：新消息不能越过准备 barrier', async () => {
  const slow = gate<void>();
  const events: string[] = [];
  const inbox = new OrderedInbox<string>(() => 'u', async text => {
    if (text === 'slow') await slow.promise;
    events.push(text);
  });
  const old = inbox.handle('slow');
  await delay(10);
  await inbox.handle('stop', true);
  const fresh = inbox.handle('fresh');
  await delay(10);
  assert.deepEqual(events, ['stop']);
  slow.resolve();
  await Promise.all([old, fresh]);
  assert.deepEqual(events, ['stop', 'slow', 'fresh']);
});

test('模型完成后等待 steer 确认时停止，保留 completed 并取消投递', async t => {
  const f = fixture(t);
  await f.manager.handle(f.message('a'));
  await waitFor(() => f.adapter.calls.length === 1);
  await f.manager.handle(f.message('b'));
  await waitFor(() => f.adapter.steering.length === 1);
  f.adapter.finish();
  await waitFor(() => f.store.getMessage('a')?.state === 'completed');
  await f.manager.handle(f.message('stop', '/stop'));
  f.adapter.steering[0]!.resolve({ status: 'accepted' });
  await delay(20);
  assert.equal(f.store.getMessage('a')?.state, 'completed');
  assert.equal(f.store.getMessage('a')?.replyState, 'cancelled');
  assert.equal(f.store.getMessage('b')?.state, 'cancelled');
  assert.equal(f.adapter.calls.length, 1);
});

test('/agent waits for an in-flight supplement to settle and preserves accepted input in the latest handoff', async t => {
  const f = fixture(t);
  await f.manager.handle(f.message('a', 'first goal')); await waitFor(() => f.adapter.calls.length === 1);
  await f.manager.handle(f.message('b', 'latest correction')); await waitFor(() => f.adapter.steering.length === 1);
  const switching = f.manager.handle(f.message('switch', '/agent claude')); await delay(0); assert.equal(f.adapter.calls[0]!.signal.aborted, false);
  f.adapter.finish(); f.adapter.steering[0]!.resolve({ status: 'accepted' }); await switching;
  assert.equal(f.store.getMessage('b')?.state, 'completed'); assert.equal(f.store.getActive('u')?.agent, 'claude'); assert.match(f.store.getActive('u')!.contextSeed!, /latest correction/); assert.equal(f.adapter.calls.length, 1);
});