import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import { SessionManager } from '../src/manager.js';
import { RestartService, type RestartOrigin } from '../src/restart.js';
import { SessionStore } from '../src/store.js';
import type { AgentAdapter, AgentResult, AgentTurn, BridgeConfig } from '../src/types.js';

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
async function until(check: () => boolean) {
  const end = Date.now() + 2000;
  while (!check()) { assert(Date.now() < end, 'restart command timed out'); await delay(5); }
}
const message = (id: string, text = '/restart', userId = 'owner') => ({ id, text, userId, channelId: 'dm', imagePaths: [] });
function fixture(t: TestContext, supervised = true) {
  const root = mkdtempSync(join(tmpdir(), 'bridge-restart-command-'));
  const turns: AgentTurn[] = [], replies: string[] = [], origins: RestartOrigin[] = [];
  const cli = deferred<AgentResult>();
  let deliver: () => Promise<void> = async () => {}, shutdowns = 0;
  const adapter: AgentAdapter = {
    async run(turn) { turns.push(turn); turn.onNativeId?.('native-parent'); return cli.promise; },
    async interrupt() {}, async close() {},
  };
  const config: BridgeConfig = { token: '', allowedUserIds: ['owner'], defaultAgent: 'codex', workspace: root, proxyUrl: null,
    commands: { codex: { command: 'fake', args: [] }, claude: { command: 'fake', args: [] } },
    dataDir: root, attachmentsDir: root, logsDir: root, maxImageBytes: 1024 };
  const manager: SessionManager = new SessionManager(config, { codex: adapter, claude: adapter },
    { async sendText(_channel, text) { replies.push(text); await deliver(); } },
    { mergeDelayMs: 0, onRequestRestart: origin => { origins.push(origin); return service.request(origin); } });
  const service: RestartService = new RestartService(root, { supervised, beginDrain: () => manager.beginDrain(), isIdle: () => manager.isIdle(),
    async shutdown() { shutdowns++; }, onPhase() {}, pollMs: 60_000 });
  const inspect = new SessionStore(root);
  t.after(async () => {
    cli.resolve({ nativeId: 'native-parent', text: 'done' }); service.close(); await manager.close(); inspect.close();
    assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert(basename(root).startsWith('bridge-restart-command-'));
    rmSync(root, { recursive: true, force: true });
  });
  return { manager, service, inspect, turns, replies, origins, cli, shutdowns: () => shutdowns, setDelivery: (fn: () => Promise<void>) => { deliver = fn; } };
}

test('/restart 无须新建会话或调用模型；回执完成后才允许退出，重复消息不再登记', async t => {
  const delivery = deferred<void>(); t.after(() => delivery.resolve());
  const f = fixture(t); f.setDelivery(() => delivery.promise);
  const pending = f.manager.handle(message('restart'));
  await until(() => f.replies.length === 1);
  assert.equal(f.service.journal.current()!.phase, 'draining');
  assert.equal(f.manager.isIdle(), false); await f.service.check(); assert.equal(f.shutdowns(), 0);
  assert.equal(f.inspect.getActive('owner'), null); assert.equal(f.turns.length, 0);
  delivery.resolve(); await pending; await f.manager.handle(message('restart'));
  assert.equal(f.origins.length, 1);
  assert.equal(f.origins[0]!.originMessageId, 'restart'); assert.equal(f.origins[0]!.nativeId, null);
  await f.service.check(); await f.service.check();
  assert.equal(f.shutdowns(), 1); assert.equal(f.inspect.getMessage('restart')!.state, 'completed');
});

test('/restart 等执行中的本轮结束，保留原会话和待处理消息，不启动下一轮', async t => {
  const f = fixture(t);
  await f.manager.handle(message('work', 'work')); await until(() => f.turns.length === 1);
  const parent = f.inspect.getActive('owner')!;
  await f.manager.handle(message('queued', 'next work'));
  await f.manager.handle(message('restart'));
  await f.service.check(); assert.equal(f.shutdowns(), 0);
  assert.equal(f.origins[0]!.conversationId, parent.id); assert.equal(f.origins[0]!.nativeId, 'native-parent');
  f.cli.resolve({ nativeId: 'native-parent', text: 'done' });
  await until(() => f.manager.isIdle()); await f.service.check();
  assert.equal(f.shutdowns(), 1); assert.equal(f.turns.length, 1);
  assert.equal(f.inspect.getActive('owner')!.id, parent.id);
  assert.equal(f.inspect.getMessage('queued')!.state, 'queued');
});

test('/restart 拒绝额外参数和未授权用户，不登记或调用模型', async t => {
  const f = fixture(t);
  await f.manager.handle(message('invalid', '/restart now'));
  await f.manager.handle(message('forbidden', '/restart', 'stranger'));
  assert.deepEqual(f.replies, ['用法：/restart']);
  assert.equal(f.origins.length, 0); assert.equal(f.service.journal.current(), null); assert.equal(f.turns.length, 0);
});

test('/restart 没有监督器时明确拒绝，桥仍可接受命令', async t => {
  const f = fixture(t, false);
  await f.manager.handle(message('restart'));
  assert.deepEqual(f.replies, ['当前桥未通过监督器启动，无法自动重启。']);
  assert.equal(f.service.isDraining(), false); await f.service.check(); assert.equal(f.shutdowns(), 0);
  assert.equal(f.inspect.getActive('owner'), null);
  await f.manager.handle(message('help', '/help'));
  assert.match(f.replies[1]!, /\/restart/);
});
