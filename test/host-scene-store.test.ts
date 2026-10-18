import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { HostStore, type HostController } from '../src/host-store.js';

const A = 'feishu:scene-a', B = 'feishu:scene-b', C = 'feishu:scene-c', P = 'owner', SPACE = 'scene-group';
const controller = (id: string): HostController => ({ conversationId: id + '-conversation', generation: 1, agent: 'codex', nativeId: null });
async function setup(t: TestContext) {
  const path = await mkdtemp(join(tmpdir(), 'bridge-scene-store-test-')), stores: HostStore[] = [];
  const open = () => { const value = new HostStore(path); stores.push(value); return value; };
  t.after(async () => { for (const value of stores) value.close(); await rm(path, { recursive: true, force: true }); });
  const store = open();
  for (const id of [A, B, C]) {
    store.registerBot({ botId: id, platform: 'feishu', applicationId: id.slice(7) });
    store.mapPrincipal({ botId: id, principalId: P, platformUserId: 'user-' + id, proof: 'verified owner' });
    store.mapSpace({ botId: id, platformSpaceId: 'native-' + id, spaceId: SPACE, proof: 'verified group' });
    store.claimOwner(id, P); store.setController(id, P, controller(id), 0);
  }
  store.startGroup({ spaceId: SPACE, principalId: P, receiverBotId: A, memberBotIds: [A, B] });
  store.acceptRoot({ id: 'root', sourceEventId: 'owner-message', spaceId: SPACE, principalId: P, targetBotIds: [A, B],
    replyTo: { platform: 'feishu', channelId: 'native-' + A, spaceId: SPACE } });
  return { store, open };
}
function progress(store: HostStore, id: string, botId = A, kind: 'dispatch' | 'completion' = 'dispatch') {
  return { id, spaceId: SPACE, epoch: store.getGroup(SPACE)!.epoch, botId, kind, text: id };
}

test('scene publication is durable, idempotent and ignores own known effects while retaining own asynchronous completion', async t => {
  const { store, open } = await setup(t);
  assert.equal(store.sceneCursor(SPACE, A), 0);
  const input = { id: 'miku-started', rootId: 'root', authorBotId: A, principalId: P, text: 'I will inspect the conversation' };
  store.appendPublic(input); const first = store.sceneCursor(SPACE, B);
  store.appendPublic(input); assert.equal(store.sceneCursor(SPACE, B), first);
  assert.throws(() => store.appendPublic({ ...input, text: 'different' }), /reused/);
  store.appendSceneProgress(progress(store, 'dispatch'));
  const completion = store.appendSceneProgress(progress(store, 'completed', A, 'completion'));
  assert.equal(store.appendSceneProgress(progress(store, 'completed', A, 'completion')).sequence, completion.sequence);
  assert.throws(() => store.appendSceneProgress({ ...progress(store, 'completed', A, 'completion'), text: 'different' }), /reused/);
  const own = store.readSceneUpdates(SPACE, A, 0), other = store.readSceneUpdates(SPACE, B, 0);
  assert.deepEqual(own.updates.map(value => value.kind), ['completion']);
  assert.deepEqual(other.updates.map(value => value.kind), ['public', 'dispatch', 'completion']);
  assert.equal(own.cursor, other.cursor); assert.equal(own.cursor, completion.sequence);
  assert(other.updates.every(value => value.canAuthorize === false));
  store.close(); const restored = open();
  assert.deepEqual(restored.readSceneUpdates(SPACE, B, first).updates.map(value => value.kind), ['dispatch', 'completion']);
});

test('an own public message advances the shared cursor without creating a reason to refresh its author', async t => {
  const { store } = await setup(t);
  store.appendPublic({ id: 'own', rootId: 'root', authorBotId: A, principalId: P, text: 'known own reply' });
  const result = store.readSceneUpdates(SPACE, A, 0);
  assert.deepEqual(result.updates, []); assert.equal(result.total, 0); assert(result.cursor > 0); assert.equal(result.truncated, false);
});

test('bystander context stays readable without advancing the reassessment version, authorizing work or enqueueing turns', async t => {
  const { store } = await setup(t), binding = store.getGroup(SPACE)!;
  const input = { id: 'bystander', spaceId: SPACE, epoch: binding.epoch, revision: binding.revision,
    principalId: P, receiverBotId: A,
    source: { botId: A, messageId: 'message-1', userId: 'non-owner', channelId: 'group-native', authorType: 'user',
      authorName: 'Another group member', mentionedUserIds: [] }, text: 'Additional evidence, not an instruction', attachments: [], canAuthorize: false };
  const cursor = store.sceneCursor(SPACE, A); store.appendContext(input);
  store.appendContext(input); assert.equal(store.sceneCursor(SPACE, A), cursor);
  const [record] = store.readContext(SPACE, A).recent;
  assert(record); assert.equal(record.source.userId, 'non-owner'); assert.equal(record.canAuthorize, false);
  assert.equal(record.text, input.text); assert.deepEqual(store.readSceneUpdates(SPACE, A, 0).updates, []);
  store.appendContext({ ...input, id: 'external-bot', source: { ...input.source, userId: 'external-bot', authorType: 'bot' } });
  assert.equal(store.sceneCursor(SPACE, A), cursor); assert.equal(store.readContext(SPACE, A).recent.length, 2);
  assert.deepEqual(store.listEvents(), []); assert.equal(store.listTasks().length, 0);
});

test('verified owner context advances reassessment while another member remains read-only history', async t => {
  const { store } = await setup(t), binding = store.getGroup(SPACE)!;
  const input = { id: 'owner-update', spaceId: SPACE, epoch: binding.epoch, revision: binding.revision,
    principalId: P, receiverBotId: A, source: { botId: A, messageId: 'owner-message-2', userId: 'user-' + A,
      channelId: 'native-' + A, authorType: 'user', mentionedUserIds: [] }, text: 'Owner follow-up', attachments: [], canAuthorize: true };
  store.appendContext(input); const cursor = store.sceneCursor(SPACE, B); assert(cursor > 0);
  store.appendContext({ ...input, id: 'guest-update', canAuthorize: false, text: 'Unrelated conversation',
    source: { ...input.source, userId: 'guest' } });
  assert.equal(store.sceneCursor(SPACE, B), cursor);
  const updates = store.readSceneUpdates(SPACE, B, 0);
  assert.deepEqual(updates.updates.map(value => value.text), ['Owner follow-up']);
  assert.equal(updates.total, 1); assert.equal(updates.truncated, false);
  assert.equal(updates.updates[0]!.canAuthorize, false); // Refresh evidence is never fresh authorization.
  assert.equal(store.readContext(SPACE, B).recent.length, 2);
});

test('owner controls and legacy control scene rows stay stored but outside default context, unread counts and refreshes', async t => {
  const { store, open } = await setup(t), binding = store.getGroup(SPACE)!;
  const input = { id: 'discussion', spaceId: SPACE, epoch: binding.epoch, revision: binding.revision,
    principalId: P, receiverBotId: A, source: { botId: A, messageId: 'discussion', userId: 'user-' + A,
      channelId: 'native-' + A, authorType: 'user', mentionedUserIds: [] }, text: '请解释 /workers 的用途', attachments: [], canAuthorize: true };
  store.appendContext(input); const cursor = store.sceneCursor(SPACE, B);
  store.appendContext({ ...input, id: 'guest-slash', text: '/workers', canAuthorize: false,
    source: { ...input.source, userId: 'guest' } });
  const legacy = new DatabaseSync(store.path);
  for (let index = 0; index < 25; index++) {
    const id = 'old-control-' + index, text = ['/workers', ' /STATUS ', '/unknown control', '新会话'][index % 4]!;
    store.appendContext({ ...input, id, text });
    legacy.prepare('INSERT INTO host_scene_log(id,space_id,epoch,kind,source_bot_id,text,source_json) VALUES(?,?,?,?,?,?,?)')
      .run('context:' + id, SPACE, binding.epoch, 'context', null, text, JSON.stringify({ type: 'group-evidence' }));
  }
  legacy.close();
  for (const reader of [store, open()]) {
    const context = reader.readContext(SPACE, B, 2);
    assert.deepEqual(context.recent.map(r => r.text), [input.text, '/workers']);
    assert.equal(context.unreadCount, 2); assert.equal(context.truncated, false);
    assert.equal(context.recent[1]!.canAuthorize, false, 'guest slash text remains read-only evidence');
    assert.equal(reader.sceneCursor(SPACE, B), cursor);
    assert.deepEqual(reader.readSceneUpdates(SPACE, B, cursor).updates, []);
    assert.deepEqual(reader.readSceneUpdates(SPACE, B, 0).updates.map(r => r.text), [input.text]);
  }
  const retained = new DatabaseSync(store.path, { readOnly: true });
  assert.equal(retained.prepare("SELECT COUNT(*) n FROM host_context_records WHERE id LIKE 'old-control-%'").get()!.n, 25);
  assert.equal(retained.prepare("SELECT COUNT(*) n FROM host_scene_log WHERE id LIKE 'context:old-control-%'").get()!.n, 25);
  retained.close();
});

test('legacy bystander scene rows remain stored but cannot advance the version or occupy refresh deltas after reopen', async t => {
  const { store, open } = await setup(t), binding = store.getGroup(SPACE)!;
  store.appendPublic({ id: 'bot-before-guest', rootId: 'root', authorBotId: A, principalId: P, text: 'Confirmed Bot reply' });
  const cursor = store.sceneCursor(SPACE, B);
  const input = { id: 'legacy-guest', spaceId: SPACE, epoch: binding.epoch, revision: binding.revision,
    principalId: P, receiverBotId: A, source: { botId: A, messageId: 'legacy-guest-message', userId: 'guest',
      channelId: 'native-' + A, authorType: 'user', mentionedUserIds: [] }, text: 'Legacy bystander text', attachments: [], canAuthorize: false };
  store.appendContext(input);
  const db = new DatabaseSync(store.path);
  db.prepare('INSERT INTO host_scene_log(id,space_id,epoch,kind,source_bot_id,text,source_json) VALUES(?,?,?,?,?,?,?)')
    .run('context:' + input.id, SPACE, binding.epoch, 'context', null, input.text, JSON.stringify({ type: 'group-evidence' }));
  db.prepare('INSERT INTO host_scene_log(id,space_id,epoch,kind,source_bot_id,text,source_json) VALUES(?,?,?,?,?,?,?)')
    .run('context:missing-record', SPACE, binding.epoch, 'context', null, 'Unprovable old source', JSON.stringify({ type: 'group-evidence' }));
  db.close(); store.close(); const reopened = open();
  assert.equal(reopened.sceneCursor(SPACE, B), cursor);
  assert.deepEqual(reopened.readSceneUpdates(SPACE, B, cursor), { cursor, updates: [], total: 0, truncated: false });
  assert.deepEqual(reopened.readSceneUpdates(SPACE, B, 0, 1).updates.map(value => value.text), ['Confirmed Bot reply']);
  assert.equal(reopened.readContext(SPACE, B).recent[0]!.text, input.text);
  const retained = new DatabaseSync(reopened.path);
  assert.equal(retained.prepare("SELECT COUNT(*) n FROM host_scene_log WHERE kind='context'").get()!.n, 2); retained.close();
});

test('scene refresh is once per original owner request and Bot, persists across restart and shares derived roots', async t => {
  const { store, open } = await setup(t);
  store.acceptRoot({ id: 'derived', sourceEventId: 'derived-public', spaceId: SPACE, principalId: P, targetBotIds: [B],
    replyTo: { collaborationMode: 'public', initiatorBotId: A, collaborationBudgetKey: 'root', channelId: 'native-' + A } });
  assert.equal(store.consumeSceneRefresh('root', A), true);
  assert.equal(store.consumeSceneRefresh('derived', A), false);
  assert.equal(store.consumeSceneRefresh('derived', B), true);
  store.close(); const restored = open();
  assert.equal(restored.consumeSceneRefresh('root', B), false);
  restored.acceptRoot({ id: 'new-owner-request', sourceEventId: 'new-owner-message', spaceId: SPACE, principalId: P,
    targetBotIds: [A, B], replyTo: { channelId: 'native-' + A } });
  assert.equal(restored.consumeSceneRefresh('new-owner-request', A), true);
  assert.equal(restored.consumeSceneRefresh('new-owner-request', A), false);
});

test('separate SQLite clients share the same durable refresh budget', async t => {
  const { store, open } = await setup(t), other = open();
  assert.equal(store.consumeSceneRefresh('root', B), true);
  assert.equal(other.consumeSceneRefresh('root', B), false);
});

test('bounded deltas return the latest changes, preserve chronology and disclose text and count truncation', async t => {
  const { store } = await setup(t);
  for (let i = 0; i < 4; i++) store.appendSceneProgress({ ...progress(store, 'dispatch-' + i), text: i === 3 ? 'x'.repeat(1700) : String(i) });
  const result = store.readSceneUpdates(SPACE, B, 0, 2);
  assert.equal(result.total, 4); assert.equal(result.truncated, true);
  assert.deepEqual(result.updates.map(value => value.id), ['progress:dispatch-2', 'progress:dispatch-3']);
  assert.equal(result.updates[1]!.text.length, 1600); assert.equal(result.updates[1]!.textTruncated, true);
  assert.equal(result.cursor, result.updates[1]!.sequence);
  assert.equal(store.readSceneUpdates(SPACE, B, result.cursor).total, 0);
  for (const limit of [0, 101, 1.1]) assert.throws(() => store.readSceneUpdates(SPACE, B, 0, limit), /limit/);
  for (const cursor of [-1, NaN, 0.1]) assert.throws(() => store.readSceneUpdates(SPACE, B, cursor), /cursor/);
});

test('scene read, progress and refresh respect membership and owner revocation', async t => {
  const { store } = await setup(t);
  store.appendSceneProgress(progress(store, 'dispatch'));
  assert.throws(() => store.sceneCursor(SPACE, C), /member/);
  assert.throws(() => store.readSceneUpdates(SPACE, C, 0), /member/);
  assert.throws(() => store.appendSceneProgress(progress(store, 'not-member', C)), /member/);
  assert.throws(() => store.consumeSceneRefresh('root', C), /member/);
  store.startGroup({ spaceId: SPACE, principalId: P, receiverBotId: A, memberBotIds: [A] });
  assert.throws(() => store.readSceneUpdates(SPACE, B, 0), /member/);
  store.setPrincipalEnabled(P, false);
  assert.throws(() => store.sceneCursor(SPACE, A), /revoked/);
  assert.throws(() => store.consumeSceneRefresh('root', A), /revoked/);
});

test('group epochs isolate old facts and do not reopen completed or stopped authorization', async t => {
  const { store } = await setup(t), old = progress(store, 'dispatch');
  store.appendSceneProgress(old); store.stopGroup(SPACE, P);
  assert.throws(() => store.readSceneUpdates(SPACE, A, 0), /disabled/);
  store.startGroup({ spaceId: SPACE, principalId: P, receiverBotId: A, memberBotIds: [A, B] });
  assert.equal(store.sceneCursor(SPACE, B), 0);
  assert.deepEqual(store.readSceneUpdates(SPACE, B, 0).updates, []);
  assert.throws(() => store.appendSceneProgress({ ...old, id: 'late-completion', kind: 'completion' }), /epoch/);
  assert.throws(() => store.consumeSceneRefresh('root', A), /epoch/);
});

test('verified cross-group public collaboration shares the original refresh cap without sharing scene facts', async t => {
  const { store } = await setup(t), other = 'other-group';
  for (const id of [A, B]) store.mapSpace({ botId: id, platformSpaceId: 'other-native-' + id, spaceId: other, proof: 'verified different group' });
  store.startGroup({ spaceId: other, principalId: P, receiverBotId: A, memberBotIds: [A, B] });
  store.appendSceneProgress(progress(store, 'first-group-only'));
  assert.deepEqual(store.readSceneUpdates(other, B, 0).updates, []);
  store.acceptRoot({ id: 'cross-group', sourceEventId: 'other-message', spaceId: other, principalId: P, targetBotIds: [B],
    replyTo: { channelId: 'other-native-' + A, collaborationMode: 'public', initiatorBotId: A, collaborationBudgetKey: 'root' } });
  assert.equal(store.consumeSceneRefresh('root', A), true);
  assert.equal(store.consumeSceneRefresh('cross-group', A), false);
  assert.equal(store.consumeSceneRefresh('cross-group', B), true);
  assert.equal(store.consumeSceneRefresh('root', B), false);
  store.stopGroup(other, P);
  assert.throws(() => store.consumeSceneRefresh('cross-group', B), /disabled/);
});

test('a refresh causal key cannot reuse another principal original authorization', async t => {
  const { store } = await setup(t);
  store.acceptRoot({ id: 'derived', sourceEventId: 'derived', spaceId: SPACE, principalId: P, targetBotIds: [B],
    replyTo: { collaborationMode: 'public', initiatorBotId: A, collaborationBudgetKey: 'root', channelId: 'native-' + A } });
  const db = new DatabaseSync(store.path);
  try { db.prepare('UPDATE host_roots SET principal_id=? WHERE id=?').run('another-owner', 'root'); } finally { db.close(); }
  assert.throws(() => store.consumeSceneRefresh('derived', B), /another authorization/);
});

test('dispatch facts require task ownership and reject internal task content', async t => {
  const { store } = await setup(t);
  store.claimTask({ id: 'task', rootId: 'root', botId: A, generation: 1, title: 'public inspection' });
  assert.throws(() => store.appendSceneProgress({ ...progress(store, 'wrong-owner', B), taskId: 'task' }), /another task owner/);
  store.acceptRoot({ id: 'internal', sourceEventId: 'private-request', spaceId: SPACE, principalId: P, targetBotIds: [B],
    replyTo: { collaborationMode: 'internal', initiatorBotId: A, channelId: 'private-owner-channel' } });
  store.claimTask({ id: 'private-task', rootId: 'internal', botId: B, generation: 1, title: 'private task' });
  assert.throws(() => store.appendSceneProgress({ ...progress(store, 'private-task-start', B), taskId: 'private-task' }), /Private task/);
  assert.deepEqual(store.readSceneUpdates(SPACE, A, 0).updates, []);
  const result = store.appendSceneProgress({ ...progress(store, 'public-task-start'), taskId: 'task' });
  assert.equal(result.taskId, 'task'); assert.equal(result.source.type, 'bridge-execution');
});

test('only ACKed outboxes add public scene changes and a late old-epoch ACK stays in its old group epoch', async t => {
  const { store } = await setup(t);
  store.enqueueEvent({ id: 'event', rootId: 'root', botId: A, generation: 1, kind: 'human', payload: {} });
  store.claimNextEvent(A); store.startEvent('event');
  store.registerOutbox({ id: 'send', eventId: 'event', audience: 'group', payload: { text: 'actual public result' } });
  assert.throws(() => store.appendDeliveredPublic('send', 'platform-id', 'actual public result'), /delivered/);
  assert.equal(store.sceneCursor(SPACE, B), 0);
  assert(store.beginOutboxSend('send')); store.finishOutbox('send', 'delivered', 'ACK');
  store.stopGroup(SPACE, P); store.startGroup({ spaceId: SPACE, principalId: P, receiverBotId: A, memberBotIds: [A, B] });
  const message = store.appendDeliveredPublic('send', 'platform-id', 'actual public result');
  assert.equal(message.epoch, 1); assert.equal(store.sceneCursor(SPACE, B), 0);
  assert.deepEqual(store.readSceneUpdates(SPACE, B, 0).updates, []);
});

test('an explicitly routed public result exposes only the published text, not its private source envelope', async t => {
  const { store } = await setup(t), group = store.getGroup(SPACE)!;
  const source = { botId: A, principalId: P, conversationId: controller(A).conversationId, generation: 1,
    messageId: 'private-secret-source', userId: A + '|user-' + A, channelId: A + '|private-owner' };
  const target = { id: 'group-target', kind: 'group' as const, botId: A, principalId: P, channelId: A + '|native-' + A,
    spaceId: SPACE, epoch: group.epoch, revision: group.revision };
  store.registerRoutedDelivery({ id: 'routed', source, target, payload: { text: 'Authorized group result', paths: [] } });
  assert(store.beginRoutedDelivery('routed')); store.finishRoutedDelivery('routed', 'delivered', 'platform ACK');
  store.appendRoutedPublic('routed'); const cursor = store.sceneCursor(SPACE, B);
  store.appendRoutedPublic('routed'); assert.equal(store.sceneCursor(SPACE, B), cursor);
  const result = store.readSceneUpdates(SPACE, B, 0);
  assert.equal(result.updates.length, 1); assert.equal(result.updates[0]!.text, 'Authorized group result');
  assert(!JSON.stringify(result).includes('private-secret-source')); assert(!JSON.stringify(result).includes('private-owner'));
});

test('continuation reuses the original task and assistant mapping, reacquires resources and keeps original authority', async t => {
  const { store } = await setup(t);
  const initial = store.claimTask({ id: 'task', rootId: 'root', botId: A, generation: 1, title: 'inspect', resources: ['browser'] }).task;
  store.registerTaskWorker('task', A, 'worker'); store.finishTask('task', A, 'completed', 'program-verified terminal assistant');
  store.acceptRoot({ id: 'next-root', sourceEventId: 'next-human', spaceId: SPACE, principalId: P, targetBotIds: [A],
    replyTo: { channelId: 'new-owner-request-channel' } });
  const reopened = store.reopenTaskForContinuation('task', A, 1, 'next-root');
  assert.equal(reopened.state, 'active'); assert.equal(reopened.executionStoppedProof, null);
  assert.equal(reopened.rootId, initial.rootId); assert.deepEqual(reopened.replyTo, initial.replyTo);
  assert.deepEqual(store.taskWorkers('task'), [{ botId: A, workerId: 'worker' }]);
  assert.deepEqual(store.getTaskForWorker(A, 'worker'), reopened);
  assert.deepEqual(store.reopenTaskForContinuation('task', A, 1, 'next-root'), reopened);
  assert.throws(() => store.claimTask({ id: 'conflicting', rootId: 'next-root', botId: B, generation: 1, title: 'other', resources: ['browser'] }), /Resource/);
});

test('continuation refuses conflicting resources atomically and cannot revive an unproved stopped execution', async t => {
  const { store } = await setup(t);
  store.claimTask({ id: 'task', rootId: 'root', botId: A, generation: 1, title: 'inspect', resources: ['browser', 'shell'] });
  store.finishTask('task', A, 'cancelled', 'program-verified stopped');
  store.claimTask({ id: 'other', rootId: 'root', botId: B, generation: 1, title: 'other', resources: ['shell'] });
  assert.throws(() => store.reopenTaskForContinuation('task', A, 1, 'root'), /Resource shell/);
  assert.equal(store.getTask('task')!.state, 'cancelled');
  store.claimTask({ id: 'browser-free', rootId: 'root', botId: B, generation: 1, title: 'browser', resources: ['browser'] });
  store.finishTask('other', B, 'completed', 'program-verified terminal'); store.finishTask('browser-free', B, 'completed', 'program-verified terminal');
  const db = new DatabaseSync(store.path);
  try { db.prepare('UPDATE host_tasks SET stopped_proof=NULL WHERE id=?').run('task'); } finally { db.close(); }
  assert.throws(() => store.reopenTaskForContinuation('task', A, 1, 'root'), /confirmed stopped/);
  assert.equal(store.getTask('task')!.state, 'cancelled');
});

test('continuation needs fresh root generation, same owner and group epoch, and a resolved handoff', async t => {
  const { store } = await setup(t);
  store.claimTask({ id: 'task', rootId: 'root', botId: A, generation: 1, title: 'inspect' });
  assert.throws(() => store.reopenTaskForContinuation('task', B, 1, 'root'), /another bot/);
  store.proposeHandoff({ id: 'handoff', taskId: 'task', fromBotId: A, toBotId: B, summary: 'pending' });
  assert.throws(() => store.reopenTaskForContinuation('task', A, 1, 'root'), /pending handoff/);
  store.closeHandoff('handoff', A, 'cancelled', 'cancel proposal');
  store.finishTask('task', A, 'completed', 'program-verified terminal');
  store.setController(A, P, { ...controller(A), generation: 2 }, 1);
  assert.throws(() => store.reopenTaskForContinuation('task', A, 2, 'root'), /root has another controller generation/);
  store.acceptRoot({ id: 'new-generation', sourceEventId: 'new-gen-human', spaceId: SPACE, principalId: P,
    targetBotIds: [A], replyTo: { channelId: 'native-' + A } });
  assert.equal(store.reopenTaskForContinuation('task', A, 2, 'new-generation').generation, 2);
  store.finishTask('task', A, 'completed', 'program-verified terminal');
  store.stopGroup(SPACE, P); store.startGroup({ spaceId: SPACE, principalId: P, receiverBotId: A, memberBotIds: [A, B] });
  store.acceptRoot({ id: 'new-epoch', sourceEventId: 'new-epoch-human', spaceId: SPACE, principalId: P,
    targetBotIds: [A], replyTo: { channelId: 'native-' + A } });
  assert.throws(() => store.reopenTaskForContinuation('task', A, 2, 'new-epoch'), /activation epochs/);
});

test('automatic dispatch recovery journal survives reopen and retains stable start and later continuation identities', async t => {
  const { store, open } = await setup(t);
  store.claimTask({ id: 'auto-work:task', rootId: 'root', botId: A, generation: 1, title: 'inspect' });
  const start = { taskId: 'auto-work:task', botId: A, conversationId: controller(A).conversationId,
    callId: 'start-call', toolName: 'bridge_start_worker' as const };
  assert.deepEqual(store.registerAutomaticDispatch(start), start);
  assert.deepEqual(store.registerAutomaticDispatch(start), start);
  assert.throws(() => store.registerAutomaticDispatch({ ...start, toolName: 'bridge_schedule_worker' }), /identity reused/);
  store.close(); const restored = open();
  assert.deepEqual(restored.getAutomaticDispatch(start.taskId), start);
  const continuation = { ...start, callId: 'continue-call', toolName: 'bridge_continue_worker' as const };
  restored.registerAutomaticDispatch(continuation);
  restored.registerAutomaticDispatch(start);
  assert.deepEqual(restored.getAutomaticDispatch(start.taskId), continuation);
  assert.deepEqual(restored.listAutomaticDispatches(start.taskId), [start, continuation]);
  assert.deepEqual(restored.listAutomaticDispatches('unknown-task'), []);
  restored.finishTask(start.taskId, A, 'completed', 'program-verified terminal');
  assert.deepEqual(restored.registerAutomaticDispatch(continuation), continuation);
  assert.throws(() => restored.registerAutomaticDispatch({ ...continuation, callId: 'new-closed-dispatch' }), /not active/);
});

test('automatic dispatch journal rejects another owner, missing tasks, stale conversations and unknown tool names', async t => {
  const { store } = await setup(t);
  store.claimTask({ id: 'auto-work:task', rootId: 'root', botId: A, generation: 1, title: 'inspect' });
  store.claimTask({ id: 'manual-task', rootId: 'root', botId: A, generation: 1, title: 'manual' });
  const input = { taskId: 'auto-work:task', botId: A, conversationId: controller(A).conversationId,
    callId: 'call', toolName: 'bridge_start_worker' as const };
  assert.throws(() => store.registerAutomaticDispatch({ ...input, botId: B }), /does not belong/);
  assert.throws(() => store.registerAutomaticDispatch({ ...input, taskId: 'missing-task' }), /does not belong/);
  assert.throws(() => store.registerAutomaticDispatch({ ...input, conversationId: 'stale-conversation' }), /conversation changed/);
  assert.throws(() => store.registerAutomaticDispatch({ ...input, toolName: 'bridge_list_workers' as any }), /Unknown automatic/);
  assert.throws(() => store.registerAutomaticDispatch({ ...input, callId: '' }), /must not be empty/);
  assert.equal(store.getAutomaticDispatch(input.taskId), null);
  store.stopGroup(SPACE, P);
  assert.throws(() => store.registerAutomaticDispatch(input), /disabled/);
});

test('automatic task and dispatch journal commit atomically, including migrated legacy task names', async t => {
  const { store, open } = await setup(t);
  const automaticDispatch = { conversationId: controller(A).conversationId, callId: 'atomic-call', toolName: 'bridge_start_worker' as const };
  const input = { id: 'legacy-business-task-name', rootId: 'root', botId: A, generation: 1, title: 'inspect', resources: ['browser'], automaticDispatch };
  assert.equal(store.claimTask(input).claimed, true);
  assert.deepEqual(store.getAutomaticDispatch(input.id), { ...automaticDispatch, taskId: input.id, botId: A });
  assert.equal(store.claimTask(input).claimed, false);
  assert.throws(() => store.claimTask({ ...input, id: 'failed-atomic', resources: ['shell'],
    automaticDispatch: { ...automaticDispatch, conversationId: 'stale' } }), /conversation changed/);
  assert.equal(store.getTask('failed-atomic'), null); assert.equal(store.getAutomaticDispatch('failed-atomic'), null);
  store.claimTask({ id: 'shell-free', rootId: 'root', botId: B, generation: 1, title: 'shell', resources: ['shell'] });
  store.claimTask({ id: 'legacy-without-prefix', rootId: 'root', botId: A, generation: 1, title: 'old task' });
  assert.throws(() => store.registerAutomaticDispatch({ ...automaticDispatch, taskId: 'legacy-without-prefix', botId: A }), /another task/);
  store.registerAutomaticDispatch({ ...automaticDispatch, callId: 'legacy-call', taskId: 'legacy-without-prefix', botId: A });
  store.close(); const restored = open();
  assert.equal(restored.getAutomaticDispatch(input.id)!.callId, automaticDispatch.callId);
  assert.equal(restored.getAutomaticDispatch('legacy-without-prefix')!.botId, A);
});
