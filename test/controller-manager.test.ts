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
function fixture(t: TestContext, run: (turn: AgentTurn) => Promise<AgentResult>) {
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
    async sendText(_channel, text, options) { replies.push({ text, ...(options ? { options } : {}) }); },
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

test('same native public tool delivery key cannot publish twice', async t => {
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
