import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import { SessionManager } from '../src/manager.js';
import { SessionStore } from '../src/store.js';
import type { AgentAdapter, AgentResult, AgentTurn, BridgeConfig, ReplyOptions } from '../src/types.js';

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error('condition timeout'); await delay(5); }
}
function fixture(t: TestContext, run: (turn: AgentTurn) => Promise<AgentResult>, sending?: (text: string) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), 'bridge-controller-manager-'));
  const config: BridgeConfig = { token: '', allowedUserIds: ['user'], defaultAgent: 'codex', workspace: root,
    proxyUrl: null, commands: { codex: { command: 'fake', args: [] }, claude: { command: 'fake', args: [] } },
    dataDir: join(root, 'data'), attachmentsDir: join(root, 'images'), logsDir: join(root, 'logs'),
    maxImageBytes: 1024, maxFileBytes: 4096, controllerMode: true };
  const replies: Array<{ text: string; options?: ReplyOptions }> = [];
  const marks: string[] = [];
  const calls: string[] = [];
  let steering = 0;
  const adapter: AgentAdapter = { async run(turn) {
    calls.push(turn.text); turn.onNativeId?.('controller-native'); turn.onModel?.('gpt-6.1-sol');
    turn.onReasoningEffort?.('medium'); turn.onReady?.(); return run(turn);
  }, async steer() { steering++; return { status: 'accepted' }; }, async interrupt() {}, async close() {} };
  const manager = new SessionManager(config, { codex: adapter, claude: adapter }, {
    async sendText(_channel, text, options) { replies.push({ text, ...(options ? { options } : {}) }); await sending?.(text); },
    async markReplyDelivered(messages) { marks.push(...messages.map(x => x.id)); },
  });
  const inspect = new SessionStore(config.dataDir);
  t.after(async () => { await manager.close(); inspect.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, manager, replies, marks, calls, inspect, steering: () => steering,
    send: (id: string, text: string) => manager.handle({ id, text, userId: 'user', channelId: 'dm', imagePaths: [] }) };
}

test('controller publishes ACK before finishing, hides internal final, and does not duplicate ACK', async t => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const f = fixture(t, async turn => {
    await turn.onPublicMessage!('我现在查一下。', [], 'ack-one'); await gate;
    return { nativeId: 'controller-native', text: 'INTERNAL: start worker JSON', controlledOutput: true };
  });
  await f.send('one', '查看温度');
  await until(() => f.replies.length === 1);
  assert.equal(f.inspect.getMessage('one')?.state, 'running');
  assert.match(f.replies[0]!.text, /^\[Codex · 6\.1-sol · 中 · tive\]/);
  release(); await until(() => f.inspect.getMessage('one')?.state === 'completed'); await delay(20);
  assert.equal(f.replies.length, 1); assert.ok(!f.replies.some(x => x.text.includes('INTERNAL')));
  assert.equal(f.inspect.getMessage('one')?.replyState, 'delivered');
});

test('coordinating turns keep every message FIFO instead of merging or steering', async t => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const f = fixture(t, async turn => {
    if (turn.text === 'first') await gate;
    await turn.onPublicMessage!(turn.text, [], 'public-' + turn.text);
    return { nativeId: 'controller-native', text: '', controlledOutput: true };
  });
  await f.send('one', 'first'); await until(() => f.calls.length === 1);
  await f.send('two', 'second'); await f.send('three', 'third');
  release(); await until(() => f.inspect.getMessage('three')?.replyState === 'delivered');
  assert.deepEqual(f.calls, ['first', 'second', 'third']); assert.equal(f.steering(), 0);
  assert.equal(f.replies.length, 3);
});

test('an ordinary absolute file citation stays prose; only explicit paths attach files', async t => {
  let path = '';
  const f = fixture(t, async turn => {
    await turn.onPublicMessage!(`[导航](<${path}>)`, [], 'citation');
    await turn.onPublicMessage!('报告已附上。', [path], 'attachment');
    return { nativeId: 'controller-native', text: '', controlledOutput: true };
  });
  path = join(f.root, 'report.txt'); writeFileSync(path, 'ordinary report');
  await f.send('one', '给我报告'); await until(() => f.inspect.getMessage('one')?.state === 'completed'); await delay(20);
  assert.equal(f.replies.length, 2); assert.equal(f.replies[0]!.options?.files, undefined);
  assert.equal(f.replies[1]!.options?.files?.[0]?.filename, 'report.txt');
});

test('controller prose paths and image Markdown do not upload; explicit images render as images', async t => {
  let path = '';
  const f = fixture(t, async turn => {
    await turn.onPublicMessage!(`截图在 ${path}，![截图](<${path}>)`, [], 'prose');
    await turn.onPublicMessage!('当前页面如下。', [path], 'image');
    return { nativeId: 'controller-native', text: '', controlledOutput: true };
  });
  path = join(f.root, 'page.png');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aU1kAAAAASUVORK5CYII=', 'base64');
  writeFileSync(path, png);
  await f.send('one', '展示页面'); await until(() => f.inspect.getMessage('one')?.state === 'completed');
  assert.equal(f.replies.length, 2);
  assert.equal(f.replies[0]!.options?.images, undefined); assert.equal(f.replies[0]!.options?.files, undefined);
  assert.equal(f.replies[1]!.options?.files, undefined);
  assert.equal(f.replies[1]!.options?.images?.[0]?.contentType, 'image/png');
  assert.deepEqual(Buffer.from(f.replies[1]!.options!.images![0]!.data), png);
});

test('same native public tool delivery key cannot publish twice' , async t => {
  const f = fixture(t, async turn => {
    await turn.onPublicMessage!('只发一次', [], 'same-key');
    await turn.onPublicMessage!('只发一次', [], 'same-key');
    return { nativeId: 'controller-native', text: '', controlledOutput: true };
  });
  await f.send('one', 'hi'); await until(() => f.inspect.getMessage('one')?.state === 'completed'); await delay(20);
  assert.equal(f.replies.length, 1);
});

test('public-message ledger survives reopen and does not retry uncertain delivery', t => {
  const root = mkdtempSync(join(tmpdir(), 'bridge-public-journal-'));
  let store = new SessionStore(root);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  assert.equal(store.claimPublicMessage('key', 'conversation', 'native', 'channel', 'hash'), 'send');
  store.close(); store = new SessionStore(root);
  assert.equal(store.claimPublicMessage('key', 'conversation', 'native', 'channel', 'hash'), 'uncertain');
  store.finishPublicMessage('key', 'delivered');
  assert.equal(store.claimPublicMessage('key', 'conversation', 'native', 'channel', 'hash'), 'delivered');
  assert.throws(() => store.claimPublicMessage('key', 'conversation', 'native', 'channel', 'changed'));
});

test('completed native report survives a process cleanup error without replay or losing a confirmed public reply', async t => {
  const f = fixture(t, async turn => {
    await turn.onPublicMessage!('已确认送达的结果', [], 'final-once');
    throw Object.assign(new Error('cleanup did not confirm exit'), { processStillRunning: true,
      nativeResult: { nativeId: 'controller-native', text: '完整报告，业务仍待验收', controlledOutput: true } });
  });
  await f.send('one', '继续核查');
  await until(() => f.replies.some(reply => reply.options?.presentation?.title === '【桥】退出待确认'));
  assert.equal(f.inspect.getMessage('one')?.state, 'completed');
  assert.equal(f.inspect.getMessage('one')?.replyState, 'delivered');
  assert.equal(f.inspect.turnResult('one')?.result.text, '完整报告，业务仍待验收');
  assert(f.inspect.turnResult('one')?.exitError);
  assert.equal(f.calls.length, 1);
  assert.equal(f.replies.filter(reply => reply.text.includes('已确认送达的结果')).length, 1);
  assert(f.replies[0]?.options?.deliveryKey?.includes('final-once'));
  const reopened = new SessionStore(join(f.root, 'data'));
  try { assert.equal(reopened.turnResult('one')?.result.text, '完整报告，业务仍待验收'); } finally { reopened.close(); }
});

test('main controller failures use a short structured bridge error and keep provider details out of public copy', async t => {
  const f = fixture(t, async () => { throw new Error('provider failure SECRET_DEBUG_DETAIL'); });
  await f.send('one', '执行任务');
  await until(() => f.replies.some(reply => reply.options?.presentation?.tone === 'error'));
  const notice = f.replies.find(reply => reply.options?.presentation?.tone === 'error')!;
  assert.match(notice.text, /【桥】/);
  assert(!notice.text.includes('SECRET_DEBUG_DETAIL'));
  assert(notice.text.length < 80);
  assert.equal(f.inspect.getMessage('one')?.state, 'failed');
});

test('stop during cleanup retains the completed report without publishing it into the cancelled turn', async t => {
  let reject!: (error: Error) => void;
  let nativeTurn: AgentTurn | undefined;
  const pending = new Promise<AgentResult>((_resolve, fail) => { reject = fail; });
  const f = fixture(t, async turn => { nativeTurn = turn; return pending; });
  await f.send('one', '执行');
  await until(() => !!nativeTurn);
  const stopping = f.send('stop', '/stop');
  await until(() => nativeTurn!.signal.aborted);
  reject(Object.assign(new Error('cleanup interrupted'), { processStillRunning: true,
    nativeResult: { nativeId: 'controller-native', text: '取消时仍须保存的报告' } }));
  await stopping;
  await until(() => !!f.inspect.turnResult('one'));
  assert.equal(f.inspect.turnResult('one')?.result.text, '取消时仍须保存的报告');
  assert(!f.replies.some(reply => reply.text.includes('取消时仍须保存的报告')));
  assert.equal(f.calls.length, 1);
});

test('an uncertain publication seals this turn even when a caller tries a new tool call ID', async t => {
  const f = fixture(t, async turn => {
    await assert.rejects(turn.onPublicMessage!('可能已送达', [], 'call-one', undefined, false),
      error => !!error && typeof error === 'object' && 'deliveryUncertain' in error);
    await assert.rejects(turn.onPublicMessage!('再次发送同一内容', [], 'call-two', undefined, false),
      error => !!error && typeof error === 'object' && 'deliveryUncertain' in error);
    return { nativeId: 'controller-native', text: '', controlledOutput: true };
  }, async text => { if (text.includes('可能已送达')) throw new TypeError('lost acknowledgement'); });
  await f.send('one', '执行');
  await until(() => f.inspect.getMessage('one')?.replyState === 'failed');
  assert.equal(f.replies.filter(reply => reply.text.includes('可能已送达')).length, 1);
  assert(!f.replies.some(reply => reply.text.includes('再次发送同一内容')));
  assert.equal(f.calls.length, 1);
});
