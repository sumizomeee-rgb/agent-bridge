import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { SessionManager, type SessionManagerOptions } from '../src/manager.js';
import { SessionStore } from '../src/store.js';
import type { AgentAdapter, AgentResult, AgentTurn, BridgeConfig, EffortMetadata } from '../src/types.js';
import { ownTemporaryDirectory } from './temp-directory.js';

async function until(check: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!check()) { if (Date.now() >= deadline) throw new Error('condition timeout'); await delay(5); }
}
function fixture(t: TestContext, run: (turn: AgentTurn) => Promise<AgentResult>, options: SessionManagerOptions = {}) {
  const root = ownTemporaryDirectory(mkdtempSync(join(tmpdir(), 'bridge-delivery-metadata-')), 'bridge-delivery-metadata-');
  const config: BridgeConfig = { token: '', allowedUserIds: ['owner'], defaultAgent: 'claude', workspace: root,
    proxyUrl: null, commands: { codex: { command: 'fake', args: [] }, claude: { command: 'fake', args: [] } },
    dataDir: root, attachmentsDir: join(root, 'images'), logsDir: join(root, 'logs'), maxImageBytes: 100, controllerMode: true };
  const sent: Array<{ channel: string; text: string }> = [], marks: string[] = [];
  const adapter: AgentAdapter = { async run(turn) { turn.onNativeId?.('native-original'); turn.onModel?.('gateway-model'); return run(turn); }, async interrupt() {}, async close() {} };
  const manager = new SessionManager(config, { codex: adapter, claude: adapter }, {
    async sendText(channel, text) { sent.push({ channel, text }); }, async markReplyDelivered(messages) { marks.push(...messages.map(m => m.id)); },
  }, options);
  const store = new SessionStore(root);
  t.after(async () => { await manager.close(); store.close(); });
  return { manager, store, sent, marks, send: (id: string) => manager.handle({ id, userId: 'owner', channelId: 'owner-dm', text: '请到已授权群回复', imagePaths: [] }) };
}

test('explicit delivery preserves the real private source and does not complete it on a supplementary send', async t => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const sources: Array<{ id: string; channel: string; target?: string; finish: boolean }> = [];
  const f = fixture(t, async turn => {
    assert.deepEqual(turn.source, { messageId: 'source-one', userId: 'owner', channelId: 'owner-dm' });
    await turn.onPublicMessage!('补充私聊', [], 'supplement-one', 'private', false);
    await gate;
    await turn.onPublicMessage!('群内最终答复', [], 'final-one', 'group:verified:1:1', true);
    return { nativeId: 'native-original', text: 'DONE', controlledOutput: true };
  }, { async onControllerPublish(context, _text, _paths, target, _key, deliver) {
    sources.push({ id: context.source.messageId, channel: context.source.channelId, target, finish: context.finish });
    assert.equal(context.signal.aborted, false);
    await deliver(target === 'private' ? 'owner-dm' : 'verified-group');
  } });
  await f.send('source-one'); await until(() => f.sent.length === 1);
  assert.equal(f.marks.length, 0);
  assert.notEqual(f.store.getMessage('source-one')?.replyState, 'delivered');
  release(); await until(() => f.store.getMessage('source-one')?.state === 'completed');
  assert.deepEqual(f.sent.map(x => x.channel), ['owner-dm', 'verified-group']);
  assert.deepEqual(f.marks, ['source-one']);
  assert.deepEqual(sources, [
    { id: 'source-one', channel: 'owner-dm', target: 'private', finish: false },
    { id: 'source-one', channel: 'owner-dm', target: 'group:verified:1:1', finish: true },
  ]);
  assert.equal(f.store.getMessage('source-one')?.channelId, 'owner-dm');
  assert.ok(f.sent.every(x => x.text.startsWith('[Claude · gateway-model ·')));
});

test('canonical effort metadata reaches the reply header and a new turn cannot reuse its actual observation', async t => {
  let calls = 0;
  const f = fixture(t, async turn => {
    const actual = calls++ === 0 ? 'high' : null;
    const metadata: EffortMetadata = { requested: null, configuration: null, actual,
      capability: { status: 'unknown', levels: [], source: 'fixture-native-protocol', modelId: 'gateway-model' } };
    turn.onEffortMetadata?.(metadata);
    await turn.onPublicMessage!('完成', [], `reply-${calls}`);
    return { nativeId: 'native-original', text: 'DONE', controlledOutput: true };
  });
  await f.send('one'); await until(() => f.store.getMessage('one')?.state === 'completed');
  assert.match(f.sent[0]!.text, /gateway-model · 高 ·/);
  await f.send('two'); await until(() => f.store.getMessage('two')?.state === 'completed');
  assert.match(f.sent[1]!.text, /未回报/);
  assert.doesNotMatch(f.sent[1]!.text, / · 高 ·/);
  const id = f.store.getMessage('two')!.conversationId;
  assert.equal(f.store.getConversation(id!)!.actualEffort, null);
});

test('an explicit target is rejected when the runtime has no authorized delivery resolver', async t => {
  const f = fixture(t, async turn => {
    await assert.rejects(turn.onPublicMessage!('不能投递', [], 'target-missing', 'group:unknown:1:1'), /目标投递入口/);
    return { nativeId: 'native-original', text: 'DONE', controlledOutput: true };
  });
  await f.send('blocked'); await until(() => f.store.getMessage('blocked')?.state === 'completed');
  assert.equal(f.sent.length, 0);
});
