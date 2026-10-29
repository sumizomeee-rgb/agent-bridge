import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SessionStore } from '../src/store.js';
import type { KnowledgeScope } from '../src/controller-knowledge.js';
import { ownTemporaryDirectory } from './temp-directory.js';

const scope: KnowledgeScope = { userId: 'owner', channelId: 'private' };
function fixture(t: TestContext) {
  const root = ownTemporaryDirectory(mkdtempSync(join(tmpdir(), 'bridge-knowledge-')), 'bridge-knowledge-');
  let store = new SessionStore(root);
  const sql = new DatabaseSync(store.path), old = store.createConversation('owner', 'codex', root), fresh = store.createConversation('owner', 'claude', root);
  let sequence = 0;
  const input = (text: string, options: { user?: string; channel?: string; conv?: string; group?: Record<string, unknown>; state?: string; time?: string } = {}) => {
    const id = 'm' + (++sequence), time = options.time ?? `2026-10-29T00:00:${String(sequence).padStart(2, '0')}.000Z`;
    sql.prepare('INSERT INTO inbox(id,user_id,channel_id,text,images_json,conversation_id,state,created_at,updated_at,group_json,source_json) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, options.user ?? 'owner', options.channel ?? 'private', text, '[]', options.conv ?? old.id, options.state ?? 'completed', time, time,
        options.group ? JSON.stringify(options.group) : null, JSON.stringify({ userId: options.group ? 'group-speaker' : 'owner', authorType: 'user', authorName: '真实发言者' }));
    return 'input:' + id;
  };
  const reply = (id: string, text: string, state = 'delivered') => {
    store.claimPublicMessage(id, old.id, 'native', 'private', id, text); store.finishPublicMessage(id, state as 'delivered');
    sql.prepare('UPDATE controller_public_messages SET created_at=? WHERE id=?').run('2026-10-29T00:00:02.500Z', id);
    return 'reply:' + id;
  };
  t.after(() => { sql.close(); store.close(); });
  return { root, sql, old, fresh, input, reply, get store() { return store; }, restart() { store.close(); store = new SessionStore(root); } };
}

test('中文历史跨 new 和后端检索，命中可读到后来纠正及确认送达回复，不混入失败投递/斜杠', t => {
  const f = fixture(t), first = f.input('取最近 20 个聊天'); f.input('纠正：先排除免打扰，再取最近 N 个', { conv: f.fresh.id });
  const delivered = f.reply('yes', '收到纠正，以最新要求为准'); f.reply('unknown', '未知送达的回复', 'uncertain'); f.input('/new c', { state: 'command' });
  const result = f.store.knowledge.search(scope, { query: '免打扰' });
  assert.equal(result.messages.length, 1); assert.equal(result.messages[0]!.conversationId, f.fresh.id);
  assert.equal(result.messages[0]!.speaker, 'user'); assert.equal(result.messages[0]!.authorName, '真实发言者');
  const around = f.store.knowledge.read(scope, { messageId: first });
  assert.deepEqual(around.messages.map(row => row.messageId), [first, result.messages[0]!.messageId, delivered]);
  assert.match(around.messages[1]!.text, /纠正/);
  assert.doesNotMatch(JSON.stringify(around), /未知送达|\/new c/);
});

test('历史按聊天、群空间和用户隔离；伪造 messageId/cursor/参数不能越界；Bot 数据库独立', t => {
  const f = fixture(t); const mine = f.input('仅我可见'); const otherUser = f.input('别人的私聊', { user: 'other' });
  const group = f.input('群中的原文', { channel: 'group', group: { spaceId: 'space' } });
  f.input('后台派工回执', { channel: 'group', group: { spaceId: 'space', eventKind: 'worker-result' } });
  f.input('旧群空间', { channel: 'group', group: { spaceId: 'other-space' } });
  assert.deepEqual(f.store.knowledge.search(scope, {}).messages.map(row => row.messageId), [mine]);
  const grouped = f.store.knowledge.search({ ...scope, channelId: 'group', spaceId: 'space' }, {});
  assert.equal(grouped.messages.length, 1); assert.equal(grouped.messages[0]!.messageId, group); assert.equal(grouped.messages[0]!.authorId, 'group-speaker');
  assert.throws(() => f.store.knowledge.read(scope, { messageId: otherUser }), /找不到/);
  assert.throws(() => f.store.knowledge.read(scope, { messageId: group }), /找不到/);
  assert.throws(() => f.store.knowledge.search(scope, { channelId: 'group' }), /参数/);
  const otherBot = fixture(t); assert.equal(otherBot.store.knowledge.search(scope, {}).messages.length, 0);
});

test('中文/时间/字面通配符与稳定分页；前后窗口、长消息继续读取明确覆盖范围', t => {
  const f = fixture(t); for (let n = 0; n < 12; n++) f.input('中文匹配 %_' + n);
  const page1 = f.store.knowledge.search(scope, { query: '%_', limit: 4 }); assert.equal(page1.hasMore, true);
  f.input('中文匹配 %_ 最新');
  const page2 = f.store.knowledge.search(scope, { query: '%_', limit: 4, cursor: page1.nextCursor });
  assert.equal(new Set([...page1.messages, ...page2.messages].map(row => row.messageId)).size, 8);
  assert.throws(() => f.store.knowledge.search({ ...scope, userId: 'other' }, { query: '%_', cursor: page1.nextCursor }), /游标/);
  assert.throws(() => f.store.knowledge.search(scope, { query: '另一条件', cursor: page1.nextCursor }), /游标/);
  const dated = f.store.knowledge.search(scope, { startTime: '2026-10-29T08:00:02+08:00', endTime: '2026-10-29T00:00:05Z' });
  assert.equal(dated.messages.length, 3);
  assert.throws(() => f.store.knowledge.search(scope, { startTime: 'yesterday' }), /时间/);
  assert.throws(() => f.store.knowledge.search(scope, { limit: 21 }), /整数/);
  const long = f.input('甲'.repeat(5000));
  const read = f.store.knowledge.read(scope, { messageId: long, before: 0, after: 0 }); assert.equal(read.messages[0]!.truncated, true);
  const rest = f.store.knowledge.read(scope, { messageId: long, before: 0, after: 0, textOffset: 4000 }); assert.equal(rest.messages[0]!.text.length, 1000);
  const window = f.store.knowledge.read(scope, { messageId: 'input:m1', after: 1, before: 0 }); assert.equal(window.hasMoreAfter, true);
  assert.equal(window.nextMessageId, 'input:m3');
});

test('清单跨 new、后端和重启保留；取消/暂停/替代不变，工单完成不自动把目标标完成', t => {
  const f = fixture(t);
  f.store.knowledge.update(scope, { changes: [{ id: 'goal', expectedVersion: 0, title: '交付真实目标', state: 'in_progress', requirements: '先排除免打扰', nextStep: '核验交付', workerIds: ['worker-finished'], jobIds: ['job-finished'] },
    ...['cancelled', 'paused', 'superseded'].map(state => ({ id: state, expectedVersion: 0, title: state, state }))] }, 'create');
  f.store.setActive('owner', f.fresh.id); f.restart();
  const saved = f.store.knowledge.list(scope, { id: 'goal' }).task!;
  assert.equal(saved.state, 'in_progress'); assert.equal(saved.requirements, '先排除免打扰'); assert.equal(saved.version, 1);
  assert.match(f.store.knowledge.summary(scope), /goal/); assert.match(f.store.knowledge.summary(scope), /paused/);
  assert.doesNotMatch(f.store.knowledge.summary(scope), /"id":"cancelled"|"id":"superseded"/);
  for (const state of ['cancelled', 'paused', 'superseded']) assert.equal(f.store.knowledge.list(scope, { id: state }).task!.state, state);
  assert.equal(f.store.knowledge.list({ ...scope, channelId: 'another' }, { id: 'goal' }).task, null);
  assert.equal(f.store.knowledge.list({ ...scope, spaceId: 'space' }, { id: 'goal' }).task, null);
  assert.equal(f.store.knowledge.list({ ...scope, userId: 'other' }, {}).tasks!.length, 0);
});

test('清单原子更新、重试幂等、版本冲突保护；后续纠正替换现行约定并保留审计', t => {
  const f = fixture(t), changes = { changes: [{ id: 'a', expectedVersion: 0, title: 'a', requirements: '旧约定' }] };
  const first = f.store.knowledge.update(scope, changes, 'same-call');
  assert.deepEqual(f.store.knowledge.update(scope, changes, 'same-call'), first);
  assert.equal(f.store.knowledge.list(scope, { id: 'a' }).task!.version, 1);
  assert.throws(() => f.store.knowledge.update(scope, { changes: [{ id: 'b', expectedVersion: 0, title: 'b' }, { id: 'a', expectedVersion: 0, title: '覆盖' }] }, 'conflict'), /已变化/);
  assert.equal(f.store.knowledge.list(scope, { id: 'b' }).task, null);
  f.store.knowledge.update(scope, { changes: [{ id: 'a', expectedVersion: 1, requirements: '用户后来纠正', evidenceIds: ['input:real-correction'] }] }, 'correct');
  const current = f.store.knowledge.list(scope, { id: 'a' }).task!;
  assert.equal(current.requirements, '用户后来纠正'); assert.equal(current.version, 2);
  assert.equal(Number(f.sql.prepare('SELECT count(*) AS n FROM controller_checklist_revisions').get()!.n), 2);
  assert.throws(() => f.store.knowledge.update(scope, { changes: [{ id: 'a', expectedVersion: 2, title: '不同内容' }] }, 'same-call'), /复用/);
  assert.throws(() => f.store.knowledge.update(scope, { changes: [{ id: 'x', expectedVersion: 0, title: 'x', state: 'invented' }] }, 'bad'), /状态/);
  assert.equal(f.store.knowledge.list(scope, { id: 'x' }).task, null);
});

test('清单结果受限且分页快照不受后来改动干扰，详情按需读取', async t => {
  const f = fixture(t);
  for (let n = 0; n < 3; n++) f.store.knowledge.update(scope, { changes: [{ id: 'task' + n, expectedVersion: 0, title: '任务' + n, remaining: '细节'.repeat(2000), nextStep: '推进'.repeat(900) }] }, 'batch' + n);
  const page1 = f.store.knowledge.list(scope, { limit: 1 });
  await new Promise(resolve => setTimeout(resolve, 5));
  f.store.knowledge.update(scope, { changes: [{ id: 'task0', expectedVersion: 1, state: 'done' }] }, 'finish');
  const page2 = f.store.knowledge.list(scope, { limit: 2, cursor: page1.nextCursor });
  assert.equal(new Set([...page1.tasks!, ...page2.tasks!].map(row => row.id)).size, 3);
  assert.equal(f.store.knowledge.list(scope, {}).tasks!.length, 2);
  assert.equal(f.store.knowledge.list(scope, { includeClosed: true }).tasks!.length, 3);
  assert.ok(f.store.knowledge.summary(scope).length < 6000);
  assert.ok(JSON.stringify(f.store.knowledge.list(scope, {})).length < 4000);
  assert.throws(() => f.store.knowledge.update(scope, { changes: [{ id: 'huge', expectedVersion: 0, title: 'x', nextStep: 'x'.repeat(2001) }] }, 'huge'), /2000/);
});
