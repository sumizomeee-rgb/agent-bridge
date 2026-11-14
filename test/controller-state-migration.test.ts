import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { SessionStore } from '../src/store.js';
import { ControllerKnowledgeJournal } from '../src/controller-knowledge.js';
import { ControllerFeedbackJournal } from '../src/controller-feedback.js';
import { DispatchFailureJournal, type DispatchFailureScope } from '../src/dispatch-failures.js';
import { prepareControllerStateMigration } from '../src/controller-state-migration.js';

const oldUser = 'feishu:cli_test|ou_owner', newUser = 'principal:owner', channelId = 'feishu:cli_test|oc_private';
const hash = (userId: string, channel: string, spaceId?: string) => createHash('sha256').update(JSON.stringify([userId, channel, spaceId ?? null])).digest('hex');
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'bridge-state-migration-'));
  const store = new SessionStore(root), conversation = store.createConversation(oldUser, 'codex', root);
  store.addMessage({ id: 'input', userId: oldUser, channelId, text: '原始任务', imagePaths: [], source: { messageId: 'input', userId: oldUser, channelId, authorType: 'user' } }, conversation.id, 'completed');
  const db = new DatabaseSync(store.path);
  return { root, store, db, conversation, close() { db.close(); store.close(); rmSync(root, { recursive: true, force: true }); } };
}
function ordinaryOwnerRewrite(db: DatabaseSync) {
  db.prepare('UPDATE conversations SET user_id=? WHERE user_id=?').run(newUser, oldUser);
  db.prepare('UPDATE inbox SET user_id=? WHERE user_id=?').run(newUser, oldUser);
  for (const row of db.prepare('SELECT id,value_json FROM dispatch_failures').all()) {
    const value = JSON.parse(String(row.value_json)); value.userId = newUser; value.origin.userId = newUser;
    db.prepare('UPDATE dispatch_failures SET value_json=? WHERE id=?').run(JSON.stringify(value), row.id!);
  }
  for (const row of db.prepare('SELECT id,payload_json FROM controller_feedback').all()) {
    const value = JSON.parse(String(row.payload_json)); value.userId = newUser;
    db.prepare('UPDATE controller_feedback SET user_id=?,payload_json=? WHERE id=?').run(newUser, JSON.stringify(value), row.id!);
  }
}

test('离线迁移重建私聊和群任务hash，保留修订、原始来源与调用幂等回执', () => {
  const f = fixture();
  try {
    const knowledge = new ControllerKnowledgeJournal(f.db), scope = { userId: oldUser, channelId };
    const first = { changes: [{ id: 'goal', expectedVersion: 0, title: '原目标', state: 'in_progress' }] };
    const callId = 'original-call:' + oldUser;
    const receipt = knowledge.update(scope, first, callId);
    knowledge.update(scope, { changes: [{ id: 'goal', expectedVersion: 1, nextStep: '继续验收' }] }, 'second-call');
    const groupChannel = 'feishu:cli_test|oc_group', spaceId = 'canonical-group';
    f.store.addMessage({ id: 'group', userId: oldUser, channelId: groupChannel, text: '群目标', imagePaths: [], groupContext: {
      botId: 'feishu:cli_test', eventId: 'event', rootId: 'root', spaceId, principalId: 'owner', generation: 1, bindingEpoch: 1, originChannelId: groupChannel, scene: '' } }, f.conversation.id, 'completed');
    knowledge.update({ userId: oldUser, channelId: groupChannel, spaceId }, { changes: [{ id: 'group-goal', expectedVersion: 0, title: '群任务' }] }, 'group-call');
    const before = f.db.prepare('SELECT call_id,fingerprint,result_json FROM controller_knowledge_calls ORDER BY call_id').all();
    f.db.exec('BEGIN IMMEDIATE');
    const migration = prepareControllerStateMigration(f.db, { [oldUser]: newUser }); ordinaryOwnerRewrite(f.db);
    assert.deepEqual(migration.apply(), { knowledgeScopes: 2, dispatchScopes: 0, feedbackRows: 0 }); f.db.exec('COMMIT');
    assert.equal((knowledge.list({ ...scope, userId: newUser }, { id: 'goal' }).task as { version: number }).version, 2);
    assert.equal(knowledge.list({ userId: newUser, channelId: groupChannel, spaceId }, {}).tasks!.length, 1);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM controller_checklist_revisions').get()!.n, 3);
    assert.deepEqual(f.db.prepare('SELECT call_id,fingerprint,result_json FROM controller_knowledge_calls ORDER BY call_id').all(), before);
    assert.deepEqual(knowledge.update({ ...scope, userId: newUser }, first, callId), receipt, '旧调用重放只返回原回执，不重做修改');
    assert.equal((knowledge.list({ ...scope, userId: newUser }, { id: 'goal' }).task as { version: number }).version, 2);
    assert.equal(JSON.parse(String(f.db.prepare("SELECT source_json FROM inbox WHERE id='input'").get()!.source_json)).userId, oldUser);
    assert.equal(prepareControllerStateMigration(f.db, { [oldUser]: newUser }).apply().knowledgeScopes, 0, '已迁移范围不再次重写');
  } finally { f.close(); }
});

test('失败红点索引随owner变更恢复可查询和点掉，反馈与全部ID保持幂等', () => {
  const f = fixture();
  try {
    const failures = new DispatchFailureJournal(f.db), feedback = new ControllerFeedbackJournal(f.db);
    const scope: DispatchFailureScope = { botId: 'feishu:cli_test', conversationId: f.conversation.id, userId: oldUser, channelId, nativeId: 'native', groupKey: '' };
    const failed = failures.record(scope, { conversationId: f.conversation.id, userId: oldUser, channelId, nativeId: 'native', agent: 'codex', cwd: f.root, originMessageId: 'input' }, 'input', 'call:' + oldUser, 'bridge_start_worker', '派工', '失败', 1);
    const notice = feedback.record({ conversationId: f.conversation.id, userId: oldUser, channelId, nativeId: 'native', sourceId: 'input', code: 'controllerFailed', stage: 'execution', reason: 'failed', resultKnown: false, processStopped: true, deliveryState: 'not-delivered' }, true);
    f.db.exec('BEGIN'); const migration = prepareControllerStateMigration(f.db, { [oldUser]: newUser }); ordinaryOwnerRewrite(f.db);
    assert.deepEqual(migration.apply(), { knowledgeScopes: 0, dispatchScopes: 1, feedbackRows: 1 }); f.db.exec('COMMIT');
    const nextScope = { ...scope, userId: newUser };
    assert.equal(failures.read(nextScope).records[0]!.id, failed.id); assert.equal(failures.get(failed.id)!.callId, failed.callId);
    assert.deepEqual(failures.ack(nextScope, failed.id, '已处理', 2), { id: failed.id, handled: true });
    assert.equal(failures.read(nextScope).records.length, 0);
    const feedbackScope = { conversationId: f.conversation.id, userId: newUser, channelId, nativeId: 'native' };
    assert.equal(feedback.read(feedbackScope).records[0]!.id, notice.id);
    feedback.deliveredToController(feedbackScope, [notice.id]); assert.equal(feedback.read(feedbackScope).records.length, 0);
    assert.equal(feedback.record({ ...feedbackScope, sourceId: 'input', code: 'controllerFailed', stage: 'execution', reason: 'again', resultKnown: false, processStopped: true, deliveryState: 'not-delivered' }, true).id, notice.id);
  } finally { f.close(); }
});

test('旧scope无法由保存来源解释时阻断，不写入任何迁移', () => {
  const f = fixture();
  try {
    f.store.knowledge.update({ userId: oldUser, channelId: 'missing-route' }, { changes: [{ id: 'orphan', expectedVersion: 0, title: '不能丢弃' }] }, 'orphan-call');
    const before = f.db.prepare('SELECT * FROM controller_checklist').all();
    assert.throws(() => prepareControllerStateMigration(f.db, { [oldUser]: newUser }), /无法解释旧任务清单范围/);
    assert.deepEqual(f.db.prepare('SELECT * FROM controller_checklist').all(), before);
  } finally { f.close(); }
});

test('两个旧范围合并到同一新主键时阻断，不能覆盖任务或去重回执', () => {
  const f = fixture();
  try {
    const secondUser = 'feishu:cli_other|ou_owner';
    const other = f.store.createConversation(secondUser, 'codex', f.root);
    f.store.addMessage({ id: 'other-input', userId: secondUser, channelId, text: 'other', imagePaths: [] }, other.id, 'completed');
    for (const userId of [oldUser, secondUser]) f.store.knowledge.update({ userId, channelId }, { changes: [{ id: 'same-id', expectedVersion: 0, title: userId }] }, 'same-call');
    assert.throws(() => prepareControllerStateMigration(f.db, { [oldUser]: newUser, [secondUser]: newUser }), /主键冲突/);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM controller_checklist').get()!.n, 2);
    assert.equal(f.db.prepare('SELECT scope FROM controller_checklist WHERE scope=?').get(hash(oldUser, channelId))!.scope, hash(oldUser, channelId));
  } finally { f.close(); }
});

test('apply验证失败会回滚本次scope重建，调用者可整体回滚generic字段迁移', () => {
  const f = fixture();
  try {
    f.store.knowledge.update({ userId: oldUser, channelId }, { changes: [{ id: 'goal', expectedVersion: 0, title: '原目标' }] }, 'call');
    const failure = f.store.dispatchFailures.record({ botId: 'feishu:cli_test', conversationId: f.conversation.id, userId: oldUser, channelId, nativeId: null, groupKey: '' },
      { conversationId: f.conversation.id, userId: oldUser, channelId, nativeId: null, agent: 'codex', cwd: f.root, originMessageId: 'input' }, 'input', 'call', 'bridge_start_worker', 'dispatch', 'failure', 1);
    f.db.exec('BEGIN'); const migration = prepareControllerStateMigration(f.db, { [oldUser]: newUser });
    assert.throws(() => migration.apply(), /负责人字段迁移后重建/);
    assert.equal(f.db.prepare('SELECT scope FROM controller_checklist').get()!.scope, hash(oldUser, channelId));
    assert.equal(f.store.dispatchFailures.get(failure.id)!.userId, oldUser); f.db.exec('ROLLBACK');
  } finally { f.close(); }
});
