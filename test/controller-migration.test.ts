import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { SessionManager } from '../src/manager.js';
import { SessionStore } from '../src/store.js';
import type { AgentAdapter, AgentTurn, BridgeConfig } from '../src/types.js';

for (const enabled of [true, false]) test(`mode migration ${enabled ? 'enable' : 'rollback'} preserves old history and moves pending input once`, async t => {
  const root = mkdtempSync(join(tmpdir(), 'bridge-mode-migration-'));
  const config: BridgeConfig = { token: '', allowedUserIds: ['user'], defaultAgent: 'codex', workspace: root,
    proxyUrl: null, commands: { codex: { command: 'fake', args: [] }, claude: { command: 'fake', args: [] } },
    dataDir: join(root, 'data'), attachmentsDir: join(root, 'images'), logsDir: join(root, 'logs'),
    maxImageBytes: 1024, controllerMode: enabled };
  const store = new SessionStore(config.dataDir);
  const previous = store.createConversation('user', 'codex', root, { controllerMode: !enabled });
  store.setActive('user', previous.id); store.saveNativeId(previous.id, 'legacy-native');
  store.setModel(previous.id, 'selected-model');
  store.addMessage({ id: 'history', userId: 'user', channelId: 'dm', text: '我给你取名小桥', imagePaths: [] }, previous.id, 'completed');
  store.setReplyState(['history'], 'delivered');
  store.addMessage({ id: 'pending', userId: 'user', channelId: 'dm', text: '继续上次的任务', imagePaths: [] }, previous.id, 'queued');
  const calls: AgentTurn[] = [];
  const adapter: AgentAdapter = { async run(turn) {
    calls.push(turn); assert.equal(turn.conversation.nativeId, null);
    turn.onNativeId?.('new-native'); await turn.onPublicMessage!('收到', [], 'migrated');
    return { nativeId: 'new-native', text: '', controlledOutput: true };
  }, async interrupt() {}, async close() {} };
  const manager = new SessionManager(config, { codex: adapter, claude: adapter }, { async sendText() {} });
  t.after(async () => { await manager.close(); store.close(); rmSync(root, { recursive: true, force: true }); });
  await manager.recover();
  const deadline = Date.now() + 5000;
  while (store.getMessage('pending')?.state !== 'completed') {
    if (Date.now() > deadline) throw new Error('migration timeout'); await delay(5);
  }
  const active = store.getActive('user')!;
  assert.notEqual(active.id, previous.id); assert.equal(active.controllerMode, enabled);
  assert.equal(active.model, 'selected-model'); assert.equal(active.nativeId, 'new-native');
  assert.equal(store.getConversation(previous.id)?.nativeId, 'legacy-native');
  assert.equal(store.getMessage('history')?.conversationId, previous.id);
  assert.equal(store.getMessage('pending')?.conversationId, active.id);
  assert.equal(calls.length, 1); assert.match(calls[0]!.text, /不是新的用户指令或授权/);
  assert.match(calls[0]!.text, /小桥/); assert.match(calls[0]!.text, /继续上次/);
  await manager.recover(); await delay(15); assert.equal(calls.length, 1);
});
