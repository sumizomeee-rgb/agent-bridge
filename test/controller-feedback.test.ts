import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test, { type TestContext } from 'node:test';
import { SessionManager } from '../src/manager.js';
import { SessionStore } from '../src/store.js';
import { TaskRegistry } from '../src/tasks.js';
import { MetadataProbeError } from '../src/agents/metadata.js';
import type { AgentAdapter, AgentResult, AgentTurn, BridgeConfig } from '../src/types.js';
import type { BridgeFeedback, FeedbackScope } from '../src/controller-feedback.js';
import { ownTemporaryDirectory } from './temp-directory.js';

async function until(check: () => boolean) {
  const end = Date.now() + 5000;
  while (!check()) { assert.ok(Date.now() < end, '错误反馈状态未按预期推进'); await new Promise(resolve => setTimeout(resolve, 5)); }
}
function fixture(t: TestContext, run: (turn: AgentTurn) => Promise<AgentResult>) {
  const root = ownTemporaryDirectory(mkdtempSync(join(tmpdir(), 'bridge-feedback-')), 'bridge-feedback-');
  const config: BridgeConfig = { token: 'fixture-private-secret', allowedUserIds: ['owner'], defaultAgent: 'claude', controllerMode: true,
    workspace: root, dataDir: root, attachmentsDir: join(root, 'images'), logsDir: join(root, 'logs'), proxyUrl: null, maxImageBytes: 100,
    commands: { codex: { command: 'fake', args: [] }, claude: { command: 'fake', args: [] } } };
  const turns: AgentTurn[] = [], sent: string[] = [], registry = new TaskRegistry(join(root, 'tasks'));
  let failNotice = false;
  const adapter: AgentAdapter = { async run(turn) { turns.push(turn); turn.onNativeId?.(turn.conversation.nativeId ?? 'parent-native'); return run(turn); }, async interrupt() {}, async close() {} };
  const sink = { async sendText(_channel: string, text: string) { sent.push(text); if (failNotice && text.includes('【桥】')) throw new Error('platform receipt missing'); } };
  const options = { mergeDelayMs: 0, taskRegistry: registry };
  const f = { root, config, turns, sent, registry, options, store: new SessionStore(root), manager: new SessionManager(config, { codex: adapter, claude: adapter }, sink, options),
    send: (id: string, channelId = 'owner-dm') => f.manager.handle({ id, userId: 'owner', channelId, text: id, imagePaths: [] }),
    scope: (): FeedbackScope => ({ conversationId: f.store.getActive('owner')!.id, userId: 'owner', channelId: 'owner-dm', nativeId: 'parent-native' }),
    async restart() { await f.manager.close(); f.manager = new SessionManager(config, { codex: adapter, claude: adapter }, sink, options); await f.manager.recover(); },
    failNotices: () => { failNotice = true; } };
  t.after(async () => { await f.manager.close(); f.store.close(); registry.close(); });
  return f;
}
async function final(turn: AgentTurn): Promise<AgentResult> {
  await turn.onPublicMessage!('已核对已有结果，不重做原任务', [], 'final-' + turn.source!.messageId);
  return { nativeId: turn.conversation.nativeId ?? 'parent-native', text: '', controlledOutput: true };
}
function entry(scope: FeedbackScope, sourceId: string): Omit<BridgeFeedback, 'id' | 'createdAt' | 'controllerState' | 'userState'> {
  return { ...scope, sourceId, code: 'summaryFailed', stage: 'summary', reason: '汇总中断', resultKnown: false, workerResultKnown: true, processStopped: true, deliveryState: 'not-attempted' };
}

test('主控失败不自我唤醒；下一轮收到脱敏回执，成功后独立确认主控接收', async t => {
  const f = fixture(t, async turn => {
    if (turn.source!.messageId === 'failed') throw new Error('provider failure fixture-private-secret');
    if (turn.source!.messageId === 'next') {
      assert.equal(turn.bridgeFeedback!.records.length, 1);
      const record = turn.bridgeFeedback!.records[0]!;
      assert.equal(record.userState, 'delivered'); assert.equal(record.controllerState, 'pending');
      assert.equal(record.resultKnown, false); assert.equal(record.processStopped, null);
      assert.doesNotMatch(JSON.stringify(record), /fixture-private-secret/);
      assert.deepEqual(turn.onReadBridgeFeedback!({ id: record.id }).records, [record]);
    } else assert.equal(turn.bridgeFeedback!.records.length, 0);
    return final(turn);
  });
  await f.send('failed'); await until(() => f.store.getMessage('failed')?.state === 'failed');
  await until(() => f.store.feedback.read(f.scope()).records[0]?.userState === 'delivered');
  await new Promise(resolve => setTimeout(resolve, 30)); assert.equal(f.turns.length, 1);
  await f.send('next'); await until(() => f.store.getMessage('next')?.replyState === 'delivered');
  await until(() => f.store.feedback.read(f.scope()).records.length === 0);
  assert.equal(f.store.feedback.read(f.scope(), { includeDelivered: true }).records[0]!.controllerState, 'delivered');
  await f.send('third'); await until(() => f.store.getMessage('third')?.state === 'completed');
});

test('用户通知回执丢失与主控接收独立；重启不重发未知通知，也不重放失败回合', async t => {
  const f = fixture(t, async turn => {
    if (turn.source!.messageId === 'failed') throw new MetadataProbeError(new Error('no model turn'), true);
    assert.equal(turn.bridgeFeedback!.records[0]!.userState, 'uncertain');
    assert.equal(turn.bridgeFeedback!.records[0]!.stage, 'preparation');
    assert.equal(turn.bridgeFeedback!.records[0]!.deliveryState, 'not-attempted');
    return final(turn);
  });
  f.failNotices(); await f.send('failed');
  await until(() => f.store.feedback.read(f.scope()).records[0]?.userState === 'uncertain');
  const sent = f.sent.length; await f.restart(); assert.equal(f.sent.length, sent); assert.equal(f.turns.length, 1);
  await f.send('next'); await until(() => f.store.feedback.read(f.scope()).records.length === 0);
  assert.equal(f.store.feedback.read(f.scope(), { includeDelivered: true }).records[0]!.userState, 'uncertain');
});

test('主控再次中断不确认先前反馈；后续成功一轮才确认，不创建错误自唤醒循环', async t => {
  const f = fixture(t, async turn => {
    if (turn.source!.messageId !== 'recover') throw new Error('model unavailable');
    assert.equal(turn.bridgeFeedback!.records.length, 2); return final(turn);
  });
  await f.send('one'); await until(() => f.store.getMessage('one')?.state === 'failed');
  await f.send('two'); await until(() => f.store.getMessage('two')?.state === 'failed');
  assert.equal(f.store.feedback.read(f.scope()).records.length, 2); assert.equal(f.turns.length, 2);
  await f.send('recover'); await until(() => f.store.feedback.read(f.scope()).records.length === 0);
});

test('回执按会话、账号、聊天、原生会话及群代次隔离；错误范围不能确认他处记录', async t => {
  const f = fixture(t, final); await f.send('setup'); await until(() => f.store.getMessage('setup')?.state === 'completed');
  const scope = f.scope(), record = f.store.feedback.record(entry(scope, 'private-error'), false);
  for (const other of [{ ...scope, conversationId: 'new-controller' }, { ...scope, userId: 'other' }, { ...scope, channelId: 'group-channel' }, { ...scope, nativeId: 'replacement-native' },
    { ...scope, group: { spaceId: 'group', generation: 1, bindingEpoch: 1 } }]) {
    assert.equal(f.store.feedback.read(other).records.length, 0);
    f.store.feedback.deliveredToController(other, [record.id]);
  }
  assert.equal(f.store.feedback.read(scope).records.length, 1);
  const group = { ...scope, channelId: 'group-channel', group: { spaceId: 'group', generation: 1, bindingEpoch: 1 } };
  f.store.feedback.record(entry(group, 'group-error'), false);
  assert.equal(f.store.feedback.read({ ...group, group: { ...group.group, generation: 2 } }).records.length, 0);
  assert.equal(f.store.feedback.read({ ...group, group: { ...group.group, bindingEpoch: 2 } }).records.length, 0);
  const replacement = f.store.createConversation('owner', 'claude', f.root, { controllerMode: true }); f.store.setActive('owner', replacement.id);
  await f.send('new-controller'); await until(() => f.store.getMessage('new-controller')?.state === 'completed');
  assert.equal(f.turns.at(-1)!.bridgeFeedback!.records.length, 0);
});

test('每轮注入有界，主控可按需查询剩余记录；稳定ID同时防止重复用户通知', async t => {
  const f = fixture(t, async turn => {
    if (turn.source!.messageId === 'read') {
      assert.equal(turn.bridgeFeedback!.records.length, 8); assert.equal(turn.bridgeFeedback!.remaining, 1);
      assert.equal(turn.onReadBridgeFeedback!({ limit: 20 }).records.length, 9);
    }
    return final(turn);
  });
  await f.send('setup'); await until(() => f.store.getMessage('setup')?.state === 'completed');
  for (let i = 0; i < 9; i++) { const a = f.store.feedback.record(entry(f.scope(), 'error-' + i), true); assert.equal(f.store.feedback.record(entry(f.scope(), 'error-' + i), true).id, a.id); }
  await f.send('read'); await until(() => f.store.feedback.read(f.scope()).records.length === 0);
});

test('助手已完成但汇总失败，反馈保留两者区别；下一用户回合不重放原结果事件', async t => {
  const f = fixture(t, async turn => {
    if (turn.event) throw new Error('summary at capacity');
    if (turn.source!.messageId === 'review') {
      const record = turn.bridgeFeedback!.records[0]!;
      assert.equal(record.workerResultKnown, true); assert.equal(record.resultKnown, false); assert.equal(record.code, 'summaryFailed');
    }
    return final(turn);
  });
  await f.send('setup'); await until(() => f.store.getMessage('setup')?.state === 'completed');
  const scope = f.scope();
  const context = f.registry.createContext({ ...scope, agent: 'claude', cwd: f.root, originMessageId: 'setup' });
  const { readFileSync } = await import('node:fs');
  const task = f.registry.register(JSON.parse(readFileSync(context.contextPath, 'utf8')), '已完成的助手任务');
  f.registry.acceptObservedResult(task.taskId, 'completed', '已有结果'); f.manager.completionAvailable();
  await until(() => f.store.feedback.read(scope).records.length === 1);
  assert.equal(f.turns.length, 2); assert.equal(f.registry.queuedEvents().length, 0);
  await f.send('review'); await until(() => f.store.feedback.read(scope).records.length === 0);
  assert.equal(f.turns.length, 3);
});

test('重启恢复仅保存中断反馈和发送短通知，不自动再次提交原消息', async t => {
  const f = fixture(t, final), target = f.store.createConversation('owner', 'claude', f.root, { controllerMode: true });
  f.store.setActive('owner', target.id); f.store.saveNativeId(target.id, 'parent-native');
  f.store.addMessage({ id: 'interrupted', userId: 'owner', channelId: 'owner-dm', text: '原请求', imagePaths: [] }, target.id, 'running');
  await f.manager.recover(); assert.equal(f.turns.length, 0);
  assert.equal(f.store.feedback.read(f.scope()).records[0]!.stage, 'interrupted');
  assert.equal(f.store.feedback.read(f.scope()).records[0]!.userState, 'delivered');
  await f.send('next'); await until(() => f.store.feedback.read(f.scope()).records.length === 0);
});

test('输入准备失败只记录程序回执，原消息不伪装成已经提交给模型的用户输入', async t => {
  const f = fixture(t, final); await f.send('setup'); await until(() => f.store.getMessage('setup')?.state === 'completed');
  let notices = 0;
  await f.manager.reportInputFailure({ id: 'download-failed', userId: 'owner', channelId: 'owner-dm', text: '含附件的原消息', imagePaths: [] },
    new Error('attachment download failed'), true, async () => { notices++; });
  assert.equal(notices, 1); assert.equal(f.turns.length, 1); assert.equal(f.store.getMessage('download-failed'), null);
  const record = f.store.feedback.read(f.scope()).records[0]!;
  assert.equal(record.stage, 'input'); assert.equal(record.deliveryState, 'not-attempted'); assert.equal(record.userState, 'delivered');
  await f.send('review-input'); await until(() => f.store.feedback.read(f.scope()).records.length === 0);
  assert.equal(f.turns.at(-1)!.bridgeFeedback!.records[0]!.sourceId, 'download-failed');
});

test('斜杠命令失败保留原回复入口，同时为现有主控记录错误，不另发一份红框', async t => {
  const f = fixture(t, final); await f.send('setup'); await until(() => f.store.getMessage('setup')?.state === 'completed');
  Object.assign(f.options, { onRequestRestart: async () => { throw new Error('restart preparation failed'); } });
  const sent = f.sent.length;
  await f.manager.handle({ id: 'command-error', userId: 'owner', channelId: 'owner-dm', text: '/restart', imagePaths: [] });
  assert.equal(f.store.getMessage('command-error')?.state, 'failed'); assert.equal(f.sent.length, sent + 1);
  assert.equal(f.store.feedback.read(f.scope()).records[0]!.stage, 'command');
  assert.equal(f.store.feedback.read(f.scope()).records[0]!.userState, 'delivered');
  await f.send('review-command'); await until(() => f.store.feedback.read(f.scope()).records.length === 0);
});
