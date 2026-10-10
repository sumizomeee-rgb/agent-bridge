import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { SessionManager } from '../src/manager.js';
import { SessionStore } from '../src/store.js';
import type { AgentAdapter, AgentModelInfo, AgentResult, AgentTurn, BridgeConfig, SteerResult } from '../src/types.js';

async function until(check: () => boolean): Promise<void> { const end = Date.now() + 2000; while (!check()) { if (Date.now() > end) throw new Error('manager drain timeout'); await delay(5); } }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }

test('drain等当前CLI及正在投递的回复完成，排队新消息保持未执行，恢复仍续原生父', async t => {
  const root = mkdtempSync(join(tmpdir(), 'bridge-restart-manager-')); const turns: AgentTurn[] = [];
  const cli = deferred<AgentResult>(); const delivery = deferred<void>(); let replies = 0;
  const adapter: AgentAdapter = { async run(turn) { turns.push(turn); turn.onNativeId?.('full-native-id'); return cli.promise; }, async interrupt() {}, async close() {} };
  const config: BridgeConfig = { token: '', allowedUserIds: ['user'], defaultAgent: 'codex', workspace: root, proxyUrl: null,
    commands: { codex: { command: 'fake', args: [] }, claude: { command: 'fake', args: [] } }, dataDir: root, attachmentsDir: root, logsDir: root, maxImageBytes: 1024 };
  let manager = new SessionManager(config, { codex: adapter, claude: adapter }, { async sendText() { replies++; await delivery.promise; } }, { mergeDelayMs: 0 });
  const inspect = new SessionStore(root);
  t.after(async () => { await manager.close(); inspect.close(); assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert(basename(root).startsWith('bridge-restart-manager-')); rmSync(root, { recursive: true, force: true }); });
  await manager.handle({ id: 'first', userId: 'user', channelId: 'dm', text: 'first', imagePaths: [] }); await until(() => turns.length === 1);
  const parent = inspect.getActive('user')!; manager.beginDrain(); assert.equal(manager.isIdle(), false);
  await manager.handle({ id: 'second', userId: 'user', channelId: 'dm', text: 'second', imagePaths: [] });
  assert.equal(inspect.getMessage('second')!.state, 'queued'); assert.equal(turns.length, 1);
  cli.resolve({ nativeId: 'full-native-id', text: 'finished first' }); await until(() => replies === 1); assert.equal(manager.isIdle(), false, '投递未结束不可退出');
  delivery.resolve(); await until(() => manager.isIdle()); assert.equal(turns.length, 1); assert.equal(inspect.getMessage('first')!.replyState, 'delivered');
  await manager.close();
  const resumed: AgentAdapter = { async run(turn) { turns.push(turn); return { nativeId: 'full-native-id', text: 'second done' }; }, async interrupt() {}, async close() {} };
  manager = new SessionManager(config, { codex: resumed, claude: resumed }, { async sendText() { replies++; } }, { mergeDelayMs: 0 });
  await manager.recover(); await until(() => manager.isIdle() && turns.length === 2);
  assert.equal(turns[1]!.text, 'second'); assert.equal(turns[1]!.conversation.id, parent.id); assert.equal(turns[1]!.conversation.nativeId, 'full-native-id');
  assert.equal(replies, 2); assert.equal(inspect.getMessage('second')!.state, 'completed');
});

test('drain等待已经提交的补充确认完成，之后的新消息不再steer也不运行新轮次', async t => {
  const root = mkdtempSync(join(tmpdir(), 'bridge-restart-manager-')); const cli = deferred<AgentResult>(); const ack = deferred<SteerResult>();
  let running = 0; let steering = 0;
  const adapter: AgentAdapter = { async run(turn) { running++; turn.onNativeId?.('native-parent'); turn.onReady?.(); return cli.promise; },
    async steer() { steering++; return ack.promise; }, async interrupt() {}, async close() {} };
  const config: BridgeConfig = { token: '', allowedUserIds: ['user'], defaultAgent: 'codex', workspace: root, proxyUrl: null,
    commands: { codex: { command: 'fake', args: [] }, claude: { command: 'fake', args: [] } }, dataDir: root, attachmentsDir: root, logsDir: root, maxImageBytes: 1024 };
  const manager = new SessionManager(config, { codex: adapter, claude: adapter }, { async sendText() {} }, { mergeDelayMs: 0 }); const inspect = new SessionStore(root);
  t.after(async () => { cli.resolve({ nativeId: 'native-parent', text: 'done' }); ack.resolve({ status: 'accepted' }); await manager.close(); inspect.close();
    assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert(basename(root).startsWith('bridge-restart-manager-')); rmSync(root, { recursive: true, force: true }); });
  await manager.handle({ id: 'first', userId: 'user', channelId: 'dm', text: 'first', imagePaths: [] }); await until(() => running === 1);
  await manager.handle({ id: 'supplement', userId: 'user', channelId: 'dm', text: 'supplement', imagePaths: [] }); await until(() => steering === 1);
  manager.beginDrain(); cli.resolve({ nativeId: 'native-parent', text: 'done' }); await delay(10);
  assert.equal(manager.isIdle(), false, 'CLI完成仍须等已提交补充的结果');
  await manager.handle({ id: 'later', userId: 'user', channelId: 'dm', text: 'later', imagePaths: [] });
  ack.resolve({ status: 'accepted' }); await until(() => manager.isIdle());
  assert.equal(steering, 1); assert.equal(running, 1); assert.equal(inspect.getMessage('later')!.state, 'queued');
  assert.equal(inspect.getMessage('supplement')!.state, 'completed'); assert.equal(inspect.getMessage('supplement')!.replyState, 'delivered');
});

test('正在查询模型的CLI元数据与命令回复也占安全窗口，不被idle检查提前关闭', async t => {
  const root = mkdtempSync(join(tmpdir(), 'bridge-restart-manager-')); const info = deferred<AgentModelInfo>(); let inspecting = false;
  const adapter: AgentAdapter = { async run() { assert.fail('元数据查询不可生成聊天'); },
    async getModelInfo() { inspecting = true; return info.promise; }, async interrupt() {}, async close() {} };
  const config: BridgeConfig = { token: '', allowedUserIds: ['user'], defaultAgent: 'codex', workspace: root, proxyUrl: null,
    commands: { codex: { command: 'fake', args: [] }, claude: { command: 'fake', args: [] } }, dataDir: root, attachmentsDir: root, logsDir: root, maxImageBytes: 1024 };
  const replies: string[] = []; const manager = new SessionManager(config, { codex: adapter, claude: adapter }, { async sendText(_channel, text) { replies.push(text); } }, { mergeDelayMs: 0 });
  t.after(async () => { info.resolve({ models: [], defaultModel: null }); await manager.close(); assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert(basename(root).startsWith('bridge-restart-manager-')); rmSync(root, { recursive: true, force: true }); });
  const command = manager.handle({ id: 'models', userId: 'user', channelId: 'dm', text: '/models', imagePaths: [] }); await until(() => inspecting);
  manager.beginDrain(); assert.equal(manager.isIdle(), false); info.resolve({ models: [{ id: 'gpt-6.1-sol', displayName: 'Sol' }], defaultModel: 'gpt-6.1-sol' });
  await command; assert.equal(manager.isIdle(), true); assert.equal(replies.length, 1);
});
