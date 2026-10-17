import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { HostStore, type HostController } from '../src/host-store.js';

const A = 'feishu:a', B = 'feishu:b', P = 'owner', SPACE = 'group';
const controller = (id: string, generation = 1): HostController => ({ conversationId: `${id}-${generation}`, generation, agent: 'codex', nativeId: null });
async function setup(t: TestContext, mode: 'public' | 'internal' = 'internal', budgetKey?: string) {
  const path = await mkdtemp(join(tmpdir(), 'bridge-collaboration-test-'));
  const stores: HostStore[] = [];
  const open = () => { const store = new HostStore(path); stores.push(store); return store; };
  t.after(async () => { for (const store of stores) store.close(); await rm(path, { recursive: true, force: true }); });
  const store = open();
  for (const id of [A, B]) {
    store.registerBot({ botId: id, platform: 'feishu', applicationId: id.slice(7) });
    store.mapPrincipal({ botId: id, principalId: P, platformUserId: 'user-' + id, proof: 'verified owner' });
    store.mapSpace({ botId: id, platformSpaceId: 'space-' + id, spaceId: SPACE, proof: 'verified group' });
    store.claimOwner(id, P); store.setController(id, P, controller(id), 0);
  }
  store.startGroup({ spaceId: SPACE, principalId: P, receiverBotId: A, memberBotIds: [A, B] });
  store.acceptRoot({ id: 'root', sourceEventId: 'private-human', spaceId: SPACE, principalId: P, targetBotIds: [B],
    replyTo: { collaborationMode: mode, initiatorBotId: A, channelId: 'group-channel', ...(budgetKey ? { collaborationBudgetKey: budgetKey } : {}) } });
  const input = { id: 'request', rootId: 'root', sourceBotId: A, targetBotId: B, text: 'Discuss the authorized task', mode };
  return { store, open, input };
}

test('collaboration registration and queue are durable, atomic and idempotent', async t => {
  const { store, open, input } = await setup(t);
  const registered = store.registerCollaborationRequest(input);
  assert.equal(registered.state, 'registered'); assert.deepEqual(store.registerCollaborationRequest(input), registered);
  assert.throws(() => store.registerCollaborationRequest({ ...input, text: 'changed' }), /reused/);
  assert.deepEqual(store.listEvents(), []);
  const queued = store.queueCollaborationRequest(input.id);
  assert.equal(queued.request.state, 'queued'); assert.equal(queued.event.kind, 'consultation');
  assert.equal(queued.event.automatic, true); assert.equal(queued.event.sourceBotId, A);
  assert.equal(queued.event.causeEventId, 'private-human'); assert.deepEqual(queued.event.payload, { text: input.text, audience: 'internal' });
  assert.deepEqual(store.queueCollaborationRequest(input.id), queued);
  store.close(); const restored = open(); restored.recoverInFlight();
  assert.deepEqual(restored.queueCollaborationRequest(input.id), queued); assert.equal(restored.listEvents().length, 1);
  assert.equal(restored.listCollaborationRequests('root').length, 1); assert.deepEqual(restored.listCollaborationRequests('other'), []);
});

test('public registration does not queue or replay anything when reopened', async t => {
  const { store, open, input } = await setup(t, 'public');
  store.registerCollaborationRequest(input); store.close(); const restored = open(); restored.recoverInFlight();
  assert.equal(restored.getCollaborationRequest(input.id)?.state, 'registered'); assert.deepEqual(restored.listEvents(), []);
  assert.equal(restored.queueCollaborationRequest(input.id).event.state, 'queued');
});

for (const changed of [A, B]) test(`generation replacement of ${changed} blocks registered collaboration atomically`, async t => {
  const { store, input } = await setup(t); store.registerCollaborationRequest(input);
  store.setController(changed, P, controller(changed, 2), 1);
  assert.throws(() => store.queueCollaborationRequest(input.id), /generation changed/);
  assert.equal(store.getCollaborationRequest(input.id)?.state, 'registered'); assert.deepEqual(store.listEvents(), []);
  assert.throws(() => store.registerCollaborationRequest({ ...input, id: 'next' }), /generation changed/);
});

test('revision change blocks registering, queueing and effects from a started collaboration', async t => {
  const { store, input } = await setup(t); store.registerCollaborationRequest(input);
  const event = store.queueCollaborationRequest(input.id).event;
  assert.equal(store.claimNextEvent(B)?.id, event.id); store.startEvent(event.id); assert.equal(store.canProduceEffects(event.id), true);
  store.startGroup({ spaceId: SPACE, principalId: P, receiverBotId: B, memberBotIds: [A, B] });
  assert.equal(store.canProduceEffects(event.id), false);
  assert.throws(() => store.registerCollaborationRequest({ ...input, id: 'new-request' }), /revision changed/);
  assert.throws(() => store.enqueueEvent({ id: 'followup', rootId: 'root', botId: A, generation: 1, kind: 'consultation', sourceBotId: B, payload: {} }), /revision changed/);
});

test('initiator replacement cancels queued collaboration before it reaches the target controller', async t => {
  const { store, input } = await setup(t); store.registerCollaborationRequest(input);
  const queued = store.queueCollaborationRequest(input.id).event;
  store.setController(A, P, controller(A, 2), 1);
  assert.equal(store.claimNextEvent(B), null); assert.equal(store.getEvent(queued.id)?.state, 'cancelled');
});

test('initiator replacement revokes effects from an already running target', async t => {
  const { store, input } = await setup(t); store.registerCollaborationRequest(input);
  const event = store.queueCollaborationRequest(input.id).event;
  store.claimNextEvent(B); store.startEvent(event.id);
  store.setController(A, P, controller(A, 2), 1);
  assert.equal(store.canProduceEffects(event.id), false);
  assert.throws(() => store.registerOutbox({ id: 'late-send', eventId: event.id, audience: 'group', payload: {} }), /closed, stale/);
});

test('revision change leaves a public request registered without creating a target event', async t => {
  const { store, input } = await setup(t, 'public'); store.registerCollaborationRequest(input);
  store.startGroup({ spaceId: SPACE, principalId: P, receiverBotId: B, memberBotIds: [A, B] });
  assert.throws(() => store.queueCollaborationRequest(input.id), /revision changed/);
  assert.equal(store.getCollaborationRequest(input.id)?.state, 'registered'); assert.deepEqual(store.listEvents(), []);
});

test('metadata, self-targets, readiness and root membership are enforced', async t => {
  const { store, input } = await setup(t);
  assert.throws(() => store.registerCollaborationRequest({ ...input, mode: 'public' }), /metadata/);
  assert.throws(() => store.registerCollaborationRequest({ ...input, targetBotId: A }), /themselves/);
  assert.throws(() => store.registerCollaborationRequest({ ...input, sourceBotId: B, targetBotId: A }), /metadata/);
  store.setControllerReady(B, 1, false);
  assert.throws(() => store.registerCollaborationRequest(input), /initialization/);
  assert.deepEqual(store.listCollaborationRequests(), []);
});

test('event insertion failure leaves the collaboration registered', async t => {
  const { store, input } = await setup(t); const registered = store.registerCollaborationRequest(input);
  store.enqueueEvent({ id: registered.eventId, logicalId: 'other-delivery', rootId: 'root', botId: B, generation: 1, kind: 'observation', payload: {} });
  assert.throws(() => store.queueCollaborationRequest(input.id), /Event ID reused/);
  assert.equal(store.getCollaborationRequest(input.id)?.state, 'registered'); assert.equal(store.listEvents().length, 1);
});

test('request update failure rolls back the inserted event and its logical delivery', async t => {
  const { store, input } = await setup(t); store.registerCollaborationRequest(input);
  const database = new DatabaseSync(store.path);
  try {
    database.exec("CREATE TRIGGER fail_collaboration_queue BEFORE UPDATE ON host_collaboration_requests BEGIN SELECT RAISE(ABORT,'injected failure'); END");
    assert.throws(() => store.queueCollaborationRequest(input.id), /injected failure/);
    assert.equal(store.getCollaborationRequest(input.id)?.state, 'registered'); assert.deepEqual(store.listEvents(), []);
    database.exec('DROP TRIGGER fail_collaboration_queue');
    assert.equal(store.queueCollaborationRequest(input.id).event.state, 'queued'); assert.equal(store.listEvents().length, 1);
  } finally { database.close(); }
});

test('internal coordination keeps its shared budget while public replies use their independent Bot group counter', async t => {
  const { store, open, input } = await setup(t, 'internal', 'real-owner-input-hash');
  const addRoot = (id: string, limit = 64) => store.acceptRoot({ id, sourceEventId: 'source-' + id, spaceId: SPACE,
    principalId: P, targetBotIds: [B], automaticLimit: limit,
    replyTo: { collaborationMode: 'public', initiatorBotId: A, collaborationBudgetKey: 'real-owner-input-hash', channelId: 'group-channel' } });
  addRoot('public');
  assert.deepEqual(store.budgetSnapshot('public'), { limit: 8, used: 0, reserved: 0 });
  assert.equal(store.claimBudgetExhaustionNotice('root'), false);
  for (let index = 0; index < 16; index++) {
    const publicMode = index % 2 === 1, rootId = publicMode ? 'public' : 'root';
    const request = store.registerCollaborationRequest({ ...input, id: 'request-' + index, rootId, mode: publicMode ? 'public' : 'internal' });
    store.queueCollaborationRequest(request.id);
    const next = store.claimNextEvent(B); assert(next);
    assert.deepEqual(store.budgetSnapshot(rootId), { limit: 8, used: Math.floor((index + 1) / 2), reserved: publicMode ? 0 : 1 });
    store.startEvent(next.id);
    if (publicMode) { const permit = store.reservePublicReply(next.id, SPACE); store.finishPublicReply(permit.reservationId!, 'confirmed'); }
    store.finishEvent(next.id, 'completed');
  }
  assert.deepEqual(store.budgetSnapshot('root'), { limit: 8, used: 8, reserved: 0 });
  assert.equal(store.publicReplySnapshot(B, SPACE).count, 8);
  addRoot('late-public');
  const late = store.registerCollaborationRequest({ ...input, id: 'late-request', rootId: 'late-public', mode: 'public' });
  store.queueCollaborationRequest(late.id);
  const next = store.claimNextEvent(B); assert(next); store.startEvent(next.id);
  assert.throws(() => store.reservePublicReply(next.id, SPACE), /limit reached/);
  store.finishEvent(next.id, 'silent');
  const internal = store.registerCollaborationRequest({ ...input, id: 'late-internal', rootId: 'root', mode: 'internal' });
  store.queueCollaborationRequest(internal.id);
  assert.equal(store.claimNextEvent(B), null); assert.equal(store.getEvent(internal.eventId)?.state, 'cancelled');
  assert.equal(store.claimBudgetExhaustionNotice('public'), true);
  assert.equal(store.claimBudgetExhaustionNotice('root'), false);
  addRoot('after-notice');
  store.close(); const restored = open();
  assert.deepEqual(restored.budgetSnapshot('after-notice'), { limit: 8, used: 8, reserved: 0 });
  assert.equal(restored.publicReplySnapshot(B, SPACE).count, 8);
  assert.equal(restored.claimBudgetExhaustionNotice('after-notice'), false);
});

test('a reservation on one collaboration root consumes the last slot of the shared bucket', async t => {
  const { store } = await setup(t, 'internal', 'shared-key');
  store.acceptRoot({ id: 'public', sourceEventId: 'public-input', spaceId: SPACE, principalId: P, targetBotIds: [A], automaticLimit: 1,
    replyTo: { collaborationMode: 'public', initiatorBotId: A, collaborationBudgetKey: 'shared-key' } });
  store.enqueueEvent({ id: 'first', rootId: 'root', botId: B, generation: 1, kind: 'consultation', sourceBotId: A, payload: {} });
  store.enqueueEvent({ id: 'second', rootId: 'public', botId: A, generation: 1, kind: 'consultation', sourceBotId: B, payload: {} });
  assert.equal(store.claimNextEvent(B)?.id, 'first');
  assert.deepEqual(store.budgetSnapshot('public'), { limit: 1, used: 0, reserved: 1 });
  assert.equal(store.claimNextEvent(A), null);
  store.cancelEvent('first', 'cancel-unstarted');
  assert.deepEqual(store.budgetSnapshot('root'), { limit: 1, used: 0, reserved: 0 });
});
