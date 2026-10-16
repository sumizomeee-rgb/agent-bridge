import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve, basename } from 'node:path';
import test, { type TestContext } from 'node:test';
import { Worker } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { HostStore, HostStateError, type HostController } from '../src/host-store.js';

const A = 'feishu:app-a';
const B = 'feishu:app-b';
const C = 'feishu:app-c';
const P = 'principal-person';
const Q = 'principal-other';
const SPACE = 'feishu/canonical-group';
const ADDRESS = { platform: 'feishu', channelId: 'application-a-group', spaceId: SPACE };
const controller = (botId: string, generation = 1): HostController => ({ conversationId: `${botId}-conversation-${generation}`, generation, agent: 'codex', nativeId: `${botId}-native-${generation}` });
const opened = new Map<string, HostStore[]>();

async function directory(t: TestContext): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'bridge-host-store-test-'));
  opened.set(path, []);
  t.after(async () => {
    for (const store of opened.get(path) ?? []) store.close();
    opened.delete(path);
    assert.equal(dirname(resolve(path)), resolve(tmpdir()));
    assert(basename(path).startsWith('bridge-host-store-test-'));
    await rm(path, { recursive: true, force: true });
  });
  return path;
}
function open(t: TestContext, path: string): HostStore {
  const store = new HostStore(path); opened.get(path)!.push(store); return store;
}
function addBot(store: HostStore, botId: string, ready = true): void {
  store.registerBot({ botId, platform: 'feishu', applicationId: botId.slice('feishu:'.length) });
  store.mapPrincipal({ principalId: P, botId, platformUserId: `open-${botId}`, proof: 'explicit verified deployment mapping' });
  store.mapSpace({ botId, platformSpaceId: `native-${botId}-${SPACE}`, spaceId: SPACE, proof: 'explicit cross-application group verification' });
  if (ready) { store.claimOwner(botId, P); store.setController(botId, P, controller(botId), 0); }
}
function seed(store: HostStore, ids = [A, B]): void {
  for (const id of ids) addBot(store, id);
  store.startGroup({ spaceId: SPACE, principalId: P, receiverBotId: A, memberBotIds: ids });
}
function root(store: HostStore, id = 'root-1', targets = [A, B], limit = 8): void {
  store.acceptRoot({ id, spaceId: SPACE, principalId: P, sourceEventId: `human-${id}`, targetBotIds: targets, replyTo: ADDRESS, automaticLimit: limit });
}
function enqueue(store: HostStore, id: string, botId = A, kind: 'human' | 'observation' | 'consultation' | 'assistant-result' = 'human', rootId = 'root-1'): void {
  store.enqueueEvent({ id, rootId, botId, generation: store.getController(botId)!.generation, kind, payload: { text: id } });
}
function start(store: HostStore, botId = A): string {
  const reserved = store.claimNextEvent(botId); assert(reserved); assert.equal(reserved.state, 'reserved');
  store.startEvent(reserved.id); return reserved.id;
}

test('bot identity, explicit principal/space proofs, and a claimed owner survive reopening', async t => {
  const path = await directory(t);
  const first = new HostStore(path);
  addBot(first, A);
  first.mapPrincipal({ principalId: Q, botId: A, platformUserId: 'other-open-id', proof: 'second verified person' });
  assert.equal(first.resolvePrincipal(A, `open-${A}`), P);
  assert.equal(first.resolvePrincipal(A, 'Person Display Name'), null);
  assert.throws(() => first.claimOwner(A, Q), /already owned/);
  assert.throws(() => first.mapPrincipal({ principalId: P, botId: A, platformUserId: 'renamed-open-id', proof: 'same display name' }), /immutable/);
  assert.throws(() => first.mapSpace({ botId: A, platformSpaceId: 'unrelated-room', spaceId: SPACE, proof: 'same group title' }), /immutable/);
  assert.throws(() => first.registerBot({ botId: 'some-alias', platform: 'feishu', applicationId: 'app-a' }), /verified/);
  first.close();
  const next = open(t, path);
  assert.equal(next.getBot(A)?.ownerPrincipalId, P);
  assert.deepEqual(next.getController(A), controller(A));
  assert.equal(next.resolveSpace(A, `native-${A}-${SPACE}`), SPACE);
  assert.throws(() => next.registerBot({ botId: A, platform: 'feishu', applicationId: 'app-a', ownerPrincipalId: Q }), /cannot be transferred/);
});

test('two independently running SQLite clients race for owner; exactly one durable claim wins', async t => {
  const path = await directory(t);
  const setup = new HostStore(path); addBot(setup, A, false);
  setup.mapPrincipal({ principalId: Q, botId: A, platformUserId: 'other-open-id', proof: 'second verified person' });
  setup.close();
  const barrier = new SharedArrayBuffer(4);
  const gate = new Int32Array(barrier);
  const workers: Worker[] = [];
  let ready = 0;
  const results = [P, Q].map(principalId => new Promise<{ won: boolean; owner?: string; code?: string }>((resolveResult, reject) => {
    const worker = new Worker(`const {parentPort,workerData}=require('node:worker_threads');
      (async()=>{const {HostStore}=await import(workerData.url);const store=new HostStore(workerData.path);
      const gate=new Int32Array(workerData.barrier);parentPort.postMessage({ready:true});Atomics.wait(gate,0,0);
      try { const bot=store.claimOwner(workerData.botId,workerData.principalId);parentPort.postMessage({won:true,owner:bot.ownerPrincipalId}); }
      catch(error) {parentPort.postMessage({won:false,code:error.code});}finally{store.close();}})().catch(error=>{throw error});`,
    { eval: true, workerData: { path, barrier, botId: A, principalId, url: new URL('../src/host-store.js', import.meta.url).href } });
    workers.push(worker);
    worker.on('error', reject);
    worker.on('message', message => {
      if (message.ready) { ready++; if (ready === 2) { Atomics.store(gate, 0, 1); Atomics.notify(gate, 0, 2); } }
      else resolveResult(message);
    });
    worker.on('exit', code => { if (code !== 0) reject(new Error(`claim worker exited ${code}`)); });
  }));
  let claims: Array<{ won: boolean; owner?: string; code?: string }>;
  try { claims = await Promise.all(results); }
  finally { Atomics.store(gate, 0, 1); Atomics.notify(gate, 0, 2); await Promise.all(workers.map(worker => worker.terminate())); }
  assert.equal(claims.filter(item => item.won).length, 1);
  assert.equal(claims.find(item => !item.won)?.code, 'forbidden');
  const check = open(t, path);
  assert.equal(check.getBot(A)?.ownerPrincipalId, claims.find(item => item.won)?.owner);
});

test('group claim is immutable, repeated start is stable, receiver/member revision differs from epoch', async t => {
  const store = open(t, await directory(t)); seed(store, [A, B, C]);
  const first = store.getGroup(SPACE)!;
  assert.deepEqual(store.startGroup({ spaceId: SPACE, principalId: P, receiverBotId: A, memberBotIds: [C, A, B] }), first);
  const changed = store.startGroup({ spaceId: SPACE, principalId: P, receiverBotId: B, memberBotIds: [A, B, C] });
  assert.equal(changed.epoch, first.epoch); assert.equal(changed.revision, first.revision + 1);
  store.stopGroup(SPACE, P);
  const restarted = store.startGroup({ spaceId: SPACE, principalId: P, receiverBotId: A, memberBotIds: [A, B] });
  assert.equal(restarted.epoch, first.epoch + 1); assert.equal(restarted.revision, 1);
  for (const id of [A, B]) store.mapPrincipal({ principalId: Q, botId: id, platformUserId: `q-${id}`, proof: 'explicit other principal' });
  assert.throws(() => store.startGroup({ spaceId: SPACE, principalId: Q, receiverBotId: A, memberBotIds: [A, B] }), /another principal|cannot be transferred/);
});

test('group start leaves an uninitialized member untouched and rejects unmapped identity/space', async t => {
  const store = open(t, await directory(t)); addBot(store, A); addBot(store, B, false);
  store.startGroup({ spaceId: SPACE, principalId: P, receiverBotId: A, memberBotIds: [A, B] });
  assert.equal(store.getBot(B)?.controller, null); assert.equal(store.getBot(B)?.ownerPrincipalId, null);
  assert.throws(() => root(store), /owned and ready/);
  assert.throws(() => store.startGroup({ spaceId: 'same display name', principalId: P, receiverBotId: A, memberBotIds: [A] }), /verified mapping/);
  assert.throws(() => store.startGroup({ spaceId: SPACE, principalId: P, receiverBotId: B, memberBotIds: [A, B] }), /not initialized/);
});

test('only the current receiver accepts canonical ingress and one root fans out without duplicate execution', async t => {
  const store = open(t, await directory(t)); seed(store);
  assert.throws(() => store.claimIngress({ id: 'message-1', spaceId: SPACE, receiverBotId: B, payload: { text: 'hello' } }), /current receiver/);
  assert.equal(store.claimIngress({ id: 'message-1', spaceId: SPACE, receiverBotId: A, payload: { text: 'hello' } }), true);
  assert.equal(store.claimIngress({ id: 'message-1', spaceId: SPACE, receiverBotId: A, payload: { text: 'hello' } }), false);
  assert.throws(() => store.claimIngress({ id: 'message-1', spaceId: SPACE, receiverBotId: A, payload: { text: 'different' } }), /reused/);
  root(store); root(store);
  assert.throws(() => store.acceptRoot({ id: 'duplicate-root', spaceId: SPACE, principalId: P, sourceEventId: 'human-root-1', targetBotIds: [A, B], replyTo: ADDRESS }), /identity/);
  enqueue(store, 'first-a', A); enqueue(store, 'first-b', B);
  const duplicate = store.enqueueEvent({ id: 'platform-echo', logicalId: 'first-a', rootId: 'root-1', botId: A, generation: 1, kind: 'human', payload: { text: 'echo' } });
  assert.equal(duplicate.id, 'first-a');
  start(store, A); start(store, B);
  assert.equal(store.claimNextEvent(A), null);
  assert.equal(store.listEvents().length, 2);
  assert.deepEqual(store.getRoot('root-1')?.replyTo, ADDRESS);
});

test('first human turns are free; automatic reservations share an exact finite budget across bots', async t => {
  const store = open(t, await directory(t)); seed(store); root(store, 'root-1', [A, B], 2);
  enqueue(store, 'human-a'); enqueue(store, 'human-b', B);
  store.finishEvent(start(store), 'silent'); store.finishEvent(start(store, B), 'completed');
  assert.equal(store.getRoot('root-1')?.automaticUsed, 0);
  enqueue(store, 'auto-a', A, 'consultation'); enqueue(store, 'auto-b', B, 'consultation');
  const a = store.claimNextEvent(A)!; const b = store.claimNextEvent(B)!;
  assert.equal(store.getRoot('root-1')?.automaticReserved, 2);
  store.startEvent(a.id); store.startEvent(b.id);
  store.finishEvent(a.id, 'silent'); store.finishEvent(b.id, 'completed');
  assert.equal(store.getRoot('root-1')?.automaticUsed, 2);
  assert.equal(store.getRoot('root-1')?.automaticReserved, 0);
  enqueue(store, 'auto-over-budget', A, 'consultation');
  assert.equal(store.claimNextEvent(A), null);
  assert.equal(store.getEvent('auto-over-budget')?.state, 'cancelled');
  assert.equal(store.claimBudgetExhaustionNotice('root-1'), true);
  assert.equal(store.claimBudgetExhaustionNotice('root-1'), false);
  enqueue(store, 'managed-worker-result', A, 'assistant-result');
  store.finishEvent(start(store), 'completed');
  assert.equal(store.getRoot('root-1')?.automaticUsed, 2);
});

test('same-root observations coalesce while independent human roots take priority and retain addresses', async t => {
  const store = open(t, await directory(t)); seed(store); root(store);
  enqueue(store, 'observer-1', B, 'observation'); enqueue(store, 'observer-2', B, 'observation');
  assert.equal(store.listEvents(B).length, 1);
  assert.deepEqual(store.getEvent('observer-1')?.payload, { updates: [{ text: 'observer-1' }, { text: 'observer-2' }] });
  store.enqueueEvent({ id: 'echo-2', logicalId: 'observer-2', rootId: 'root-1', botId: B, generation: 1, kind: 'observation', payload: {} });
  assert.equal(store.listEvents(B).length, 1);
  root(store, 'root-human-next'); enqueue(store, 'new-human', B, 'human', 'root-human-next');
  const id = start(store, B); assert.equal(id, 'new-human'); store.finishEvent(id, 'completed');
  assert.equal(start(store, B), 'observer-1');
});

test('silent decision closes effects but retains the native turn slot; restart never reruns silent completion', async t => {
  const path = await directory(t); const first = new HostStore(path); seed(first); root(first); enqueue(first, 'quiet');
  start(first); assert.equal(first.canProduceEffects('quiet'), true);
  first.markEventDecision('quiet', 'silent'); assert.equal(first.canProduceEffects('quiet'), false);
  assert.equal(first.claimNextEvent(A), null);
  assert.throws(() => first.registerOutbox({ id: 'bad-late-send', eventId: 'quiet', audience: 'group', payload: 'late' }), /closed/);
  first.finishEvent('quiet', 'completed'); assert.equal(first.getEvent('quiet')?.state, 'silent'); first.close();
  const next = open(t, path); assert.equal(next.recoverInFlight().uncertainEvents, 0);
  assert.equal(next.claimNextEvent(A), null); assert.equal(next.getEvent('quiet')?.nativeEnded, true);
});

test('restart releases unstarted budget reservations, marks running native turns uncertain and blocks overlap', async t => {
  const path = await directory(t); const first = new HostStore(path); seed(first); root(first);
  enqueue(first, 'running-a', A, 'consultation'); enqueue(first, 'reserved-b', B, 'consultation');
  start(first); first.claimNextEvent(B);
  assert.equal(first.getRoot('root-1')?.automaticReserved, 1); first.close();
  const next = open(t, path);
  assert.deepEqual(next.recoverInFlight(), { uncertainEvents: 1, requeuedReservations: 1, uncertainSends: 0, blockedBatches: 0 });
  assert.equal(next.getRoot('root-1')?.automaticReserved, 0); assert.equal(next.getRoot('root-1')?.automaticUsed, 1);
  assert.equal(next.claimNextEvent(A), null); assert.equal(next.getEvent('running-a')?.state, 'uncertain');
  assert.equal(next.claimNextEvent(B)?.id, 'reserved-b');
  next.finishEvent('running-a', 'failed', 'verified process no longer exists; outcome was not replayed');
  assert.equal(next.getEvent('running-a')?.nativeEnded, true);
});

test('public cursor is consumed only after native end and ordinary receiver revision preserves old task validity', async t => {
  const path = await directory(t); const first = new HostStore(path); seed(first); root(first);
  const input = first.appendPublic({ id: 'public-input', rootId: 'root-1', principalId: P, text: 'authorized input' });
  const output = first.appendPublic({ id: 'public-response', rootId: 'root-1', principalId: P, authorBotId: B, text: 'published reply' });
  assert(output.sequence > input.sequence);
  first.enqueueEvent({ id: 'read-public', rootId: 'root-1', botId: A, generation: 1, kind: 'human', payload: { text: 'read' }, publicCursor: output.sequence });
  start(first); assert.equal(first.getPublicCursor(A, SPACE), 0);
  first.startGroup({ spaceId: SPACE, principalId: P, receiverBotId: B, memberBotIds: [A, B] });
  assert.equal(first.canProduceEffects('read-public'), true);
  first.finishEvent('read-public', 'silent'); first.close();
  const next = open(t, path);
  assert.equal(next.getPublicCursor(A, SPACE), output.sequence);
  assert.deepEqual(next.readPublic(SPACE, A, input.sequence, 1).map(item => item.id), ['public-response']);
  assert.deepEqual(next.readPublic(SPACE, A, output.sequence), []);
});

test('outbox never retries an uncertain send, validates audience, and rechecks permissions before sending', async t => {
  const path = await directory(t); const first = new HostStore(path); seed(first); root(first); enqueue(first, 'send-turn'); start(first);
  const box = first.registerOutbox({ id: 'send-1', eventId: 'send-turn', audience: 'group', payload: { text: 'a reply' } });
  assert.deepEqual(box.replyTo, ADDRESS);
  assert.throws(() => first.registerOutbox({ id: 'invalid-dm', eventId: 'send-turn', audience: 'private', replyTo: { botId: A, userId: 'some-other-account' }, payload: 'secret' }), /verified owner/);
  assert.throws(() => first.registerOutbox({ id: 'invalid-group', eventId: 'send-turn', audience: 'group', replyTo: { channelId: 'last-contact' }, payload: 'wrong destination' }), /original address/);
  assert.equal(first.beginOutboxSend('send-1')?.state, 'sending'); first.close();
  const next = open(t, path); next.recoverInFlight();
  assert.equal(next.getOutbox('send-1')?.state, 'uncertain'); assert.equal(next.beginOutboxSend('send-1'), null);
  assert.throws(() => next.finishOutbox('send-1', 'delivered'), /verified uncertain/);
  next.finishOutbox('send-1', 'delivered', 'platform message id observed through exact receipt');
  assert.equal(next.getOutbox('send-1')?.state, 'delivered');
  next.finishEvent('send-turn', 'completed');
  root(next, 'root-2'); enqueue(next, 'send-turn-2', A, 'human', 'root-2'); start(next);
  next.registerOutbox({ id: 'send-2', eventId: 'send-turn-2', audience: 'group', payload: 'held' });
  next.stopGroup(SPACE, P);
  assert.equal(next.beginOutboxSend('send-2'), null); assert.equal(next.getOutbox('send-2')?.state, 'rejected');
});

test('atomic task/resource claim keeps one owner and handoff cannot transfer until original execution stopped', async t => {
  const path = await directory(t); const first = new HostStore(path); seed(first); root(first);
  assert.equal(first.claimTask({ id: 'task-1', rootId: 'root-1', botId: A, generation: 1, title: 'investigate', resources: ['repo/write'] }).claimed, true);
  const peer = new HostStore(path);
  assert.equal(peer.claimTask({ id: 'task-1', rootId: 'root-1', botId: B, generation: 1, title: 'investigate' }).task.ownerBotId, A);
  assert.throws(() => peer.claimTask({ id: 'conflict-task', rootId: 'root-1', botId: B, generation: 1, title: 'conflict', resources: ['repo/write'] }), /Resource .* owned/);
  assert.equal(peer.getTask('conflict-task'), null); peer.close();
  first.registerTaskWorker('task-1', A, 'old-worker');
  first.proposeHandoff({ id: 'handoff-1', taskId: 'task-1', fromBotId: A, toBotId: B, summary: 'evidence and acceptance criteria' });
  assert.throws(() => first.acceptHandoff('handoff-1', B), /confirmed stopped/);
  assert.equal(first.getTask('task-1')?.ownerBotId, A);
  first.confirmTaskExecutionStopped('task-1', A, 'worker/process identities verified stopped'); first.close();
  const next = open(t, path);
  const transferred = next.acceptHandoff('handoff-1', B);
  assert.equal(transferred.ownerBotId, B); assert.deepEqual(transferred.replyTo, ADDRESS);
  assert.equal(next.getHandoff('handoff-1')?.state, 'accepted');
  assert.deepEqual(next.taskWorkers('task-1'), [{ botId: A, workerId: 'old-worker' }]);
  assert.equal(next.getTaskForWorker(A, 'old-worker')?.ownerBotId, B);
  assert.throws(() => next.registerTaskWorker('task-1', A, 'another-old-worker'), /does not own/);
  next.registerTaskWorker('task-1', B, 'new-worker');
  assert.equal(next.taskWorkers('task-1').length, 2);
  assert.throws(() => next.markTaskExecutionActive('task-1', A), /does not own/);
  next.finishTask('task-1', B, 'completed', 'execution finished and output saved');
  assert.equal(next.claimTask({ id: 'task-2', rootId: 'root-1', botId: A, generation: 1, title: 'different task', resources: ['repo/write'] }).claimed, true);
});

test('group stop cancels queued collaboration and pending handoff but retains tasks/results with original address', async t => {
  const store = open(t, await directory(t)); seed(store); root(store);
  store.claimTask({ id: 'retained-task', rootId: 'root-1', botId: A, generation: 1, title: 'already authorized' });
  store.proposeHandoff({ id: 'pending', taskId: 'retained-task', fromBotId: A, toBotId: B, summary: 'pending transfer' });
  enqueue(store, 'held', B, 'consultation'); store.claimNextEvent(B);
  store.stopGroup(SPACE, P);
  assert.equal(store.getRoot('root-1')?.automaticReserved, 0);
  assert.equal(store.getEvent('held')?.state, 'cancelled');
  assert.equal(store.getHandoff('pending')?.state, 'cancelled');
  assert.equal(store.getTask('retained-task')?.state, 'active');
  assert.deepEqual(store.getTask('retained-task')?.replyTo, ADDRESS);
  store.startGroup({ spaceId: SPACE, principalId: P, receiverBotId: A, memberBotIds: [A, B] });
  assert.throws(() => enqueue(store, 'old-epoch', B, 'consultation'), /epoch/);
});

test('revocation immediately stops new ingress and preserves claimed owners after permission is restored', async t => {
  const store = open(t, await directory(t)); seed(store); root(store); enqueue(store, 'queued');
  store.setPrincipalEnabled(P, false);
  assert.equal(store.resolvePrincipal(A, `open-${A}`), null);
  assert.equal(store.getGroup(SPACE)?.enabled, false); assert.equal(store.getEvent('queued')?.state, 'cancelled');
  assert.equal(store.getBot(A)?.ownerPrincipalId, P);
  assert.throws(() => store.claimOwner(A, P), /revoked/);
  store.setPrincipalEnabled(P, true);
  assert.equal(store.getGroup(SPACE)?.enabled, false);
  assert.equal(store.getBot(A)?.ownerPrincipalId, P);
});

test('batch reset freezes overlapping controls, commits all pointers together and reports independent initialization failures', async t => {
  const store = open(t, await directory(t)); seed(store, [A, B, C]); root(store, 'root-1', [A, B, C]);
  enqueue(store, 'old-a'); enqueue(store, 'old-b', B); enqueue(store, 'unrelated-c', C);
  const otherSpace = 'feishu/other-group';
  for (const id of [A, B]) store.mapSpace({ botId: id, platformSpaceId: `other-${id}`, spaceId: otherSpace, proof: 'verified other membership' });
  store.startGroup({ spaceId: otherSpace, principalId: P, receiverBotId: A, memberBotIds: [A, B] });
  store.beginBatchReset({ id: 'batch-1', principalId: P, spaceId: otherSpace, botIds: [B, A] });
  assert.equal(store.claimNextEvent(A), null); assert.equal(store.getEvent('old-a')?.state, 'cancelled');
  assert.equal(store.claimNextEvent(C)?.id, 'unrelated-c');
  assert.throws(() => store.beginBatchReset({ id: 'batch-overlap', principalId: P, botIds: [B, C] }), /Overlapping/);
  assert.equal(store.getBatchReset('batch-overlap'), null);
  store.recordBatchCancellation('batch-1', A, { confirmed: true, detail: 'A scheduled execution stopped' });
  store.prepareBatchController('batch-1', A, controller(A, 2));
  assert.throws(() => store.commitBatchReset('batch-1'), /every member/);
  assert.equal(store.getController(A)?.generation, 1); assert.equal(store.getController(B)?.generation, 1);
  store.recordBatchCancellation('batch-1', B, { confirmed: true, detail: 'B scheduled execution stopped' });
  store.prepareBatchController('batch-1', B, controller(B, 2));
  const committed = store.commitBatchReset('batch-1'); assert.equal(committed.state, 'committed');
  assert.equal(store.getController(A)?.generation, 2); assert.equal(store.getController(B)?.generation, 2);
  assert.equal(store.getController(C)?.generation, 1); assert.equal(store.getBot(A)?.ready, false);
  store.recordBatchInitialization('batch-1', A, { ready: true, detail: 'tools loaded' });
  const done = store.recordBatchInitialization('batch-1', B, { ready: false, detail: 'gateway unavailable' });
  assert.equal(done.state, 'completed'); assert.equal(store.getBot(A)?.ready, true); assert.equal(store.getBot(B)?.ready, false);
  assert.equal(store.getController(B)?.generation, 2); // Failed init never silently restores the old pointer.
});

test('crash after partial cancellation keeps journal/locks and never fakes rollback or reruns initialization', async t => {
  const path = await directory(t); const first = new HostStore(path); seed(first);
  first.beginBatchReset({ id: 'crashed-batch', principalId: P, botIds: [A, B], spaceId: SPACE });
  first.recordBatchCancellation('crashed-batch', A, { confirmed: true, detail: 'A actual schedules cancelled' });
  first.recordBatchCancellation('crashed-batch', B, { confirmed: false, detail: 'B process stop not confirmed' });
  first.close();
  const next = open(t, path); next.recoverInFlight();
  assert.equal(next.getBatchReset('crashed-batch')?.state, 'blocked');
  assert.equal(next.getBatchReset('crashed-batch')?.members[0]?.cancellation, 'confirmed');
  assert.equal(next.getBatchReset('crashed-batch')?.members[1]?.cancellation, 'blocked');
  assert.equal(next.getController(A)?.generation, 1); assert.equal(next.getController(B)?.generation, 1);
  assert.throws(() => next.beginBatchReset({ id: 'not-a-new-operation', principalId: P, botIds: [A] }), /Overlapping/);
  next.cancelBatchReset('crashed-batch', 'Operator inspected surviving execution; retain old pointers, A schedules remain cancelled');
  assert.equal(next.getBatchReset('crashed-batch')?.state, 'cancelled');
  assert.equal(next.beginBatchReset({ id: 'new-operation', principalId: P, botIds: [A] }).state, 'frozen');
});

test('CAS private reset rejects a live turn, invalidates old queued events/handoffs and preserves task ownership', async t => {
  const store = open(t, await directory(t)); seed(store); root(store);
  enqueue(store, 'active-a'); enqueue(store, 'queued-b', B);
  store.claimTask({ id: 'old-task', rootId: 'root-1', botId: A, generation: 1, title: 'old ordinary assistant may finish' });
  store.proposeHandoff({ id: 'old-handoff', taskId: 'old-task', fromBotId: A, toBotId: B, summary: 'not yet accepted' });
  start(store);
  assert.throws(() => store.setController(A, P, controller(A, 2), 1), /safely ended/);
  store.finishEvent('active-a', 'completed');
  store.setController(B, P, controller(B, 2), 1);
  assert.equal(store.getEvent('queued-b')?.state, 'cancelled');
  assert.equal(store.getHandoff('old-handoff')?.state, 'cancelled');
  assert.equal(store.getTask('old-task')?.ownerBotId, A);
  assert.throws(() => store.setController(B, P, controller(B, 2), 1), HostStateError);
  assert.throws(() => enqueue(store, 'late-old-root', B, 'consultation'), /new controller/);
});

test('a root freezes generations for later collaborators who were not original targets', async t => {
  const store = open(t, await directory(t)); seed(store); root(store, 'root-1', [A]);
  assert.equal(store.getRoot('root-1')?.generations[B], 1);
  store.setController(B, P, controller(B, 2), 1);
  assert.throws(() => enqueue(store, 'late-observer', B, 'observation'), /new controller/);
  assert.throws(() => store.claimTask({ id: 'late-task', rootId: 'root-1', botId: B, generation: 2, title: 'stale authorization' }), /Old root/);
  addBot(store, C);
  store.startGroup({ spaceId: SPACE, principalId: P, receiverBotId: A, memberBotIds: [A, B, C] });
  assert.throws(() => enqueue(store, 'newly-added-observer', C, 'observation'), /newly added member/);
});

test('failure in the middle of SQL batch pointer updates rolls back every pointer and retains the prepared journal', async t => {
  const path = await directory(t); const store = open(t, path); seed(store);
  store.beginBatchReset({ id: 'atomic-batch', principalId: P, spaceId: SPACE, botIds: [A, B] });
  for (const botId of [A, B]) {
    store.recordBatchCancellation('atomic-batch', botId, { confirmed: true, detail: 'verified external execution stopped' });
    store.prepareBatchController('atomic-batch', botId, controller(botId, 2));
  }
  const fault = new DatabaseSync(store.path);
  try {
    fault.exec(`CREATE TRIGGER reject_second_pointer BEFORE UPDATE OF controller_json ON host_bots
      WHEN NEW.bot_id='${B}' BEGIN SELECT RAISE(ABORT,'injected second pointer failure'); END;`);
    assert.throws(() => store.commitBatchReset('atomic-batch'), /injected second pointer failure/);
    assert.equal(store.getController(A)?.generation, 1); assert.equal(store.getController(B)?.generation, 1);
    assert.equal(store.getBatchReset('atomic-batch')?.state, 'prepared');
    fault.exec('DROP TRIGGER reject_second_pointer');
  } finally { fault.close(); }
  assert.equal(store.commitBatchReset('atomic-batch').state, 'committed');
  assert.equal(store.getController(A)?.generation, 2); assert.equal(store.getController(B)?.generation, 2);
});

test('a delivery already in flight is recorded after group stop, without permitting a subsequent send', async t => {
  const store = open(t, await directory(t)); seed(store); root(store); enqueue(store, 'in-flight'); start(store);
  store.registerOutbox({ id: 'out-flight', eventId: 'in-flight', audience: 'group', payload: 'actual response' });
  store.registerOutbox({ id: 'out-never-started', eventId: 'in-flight', audience: 'group', payload: 'must not send' });
  store.beginOutboxSend('out-flight'); store.stopGroup(SPACE, P);
  store.finishOutbox('out-flight', 'delivered', 'platform returned actual-message-id');
  const recorded = store.appendDeliveredPublic('out-flight', 'actual-message-id', 'actual response');
  assert.equal(recorded.epoch, 1); assert.equal(recorded.authorBotId, A);
  assert.equal(store.beginOutboxSend('out-never-started'), null);
  assert.equal(store.getOutbox('out-never-started')?.state, 'rejected');
  assert.throws(() => store.appendDeliveredPublic('out-never-started', 'fake', 'not sent'), /delivered public/);
});

test('membership revocation rechecks an already registered direct audience and cancels related waiting handoff', async t => {
  const store = open(t, await directory(t)); seed(store, [A, B, C]); root(store, 'root-1', [A, B, C]);
  enqueue(store, 'direct-turn'); start(store);
  store.registerOutbox({ id: 'direct-b', eventId: 'direct-turn', audience: 'direct', targetBotIds: [B], payload: 'consultation' });
  store.claimTask({ id: 'member-task', rootId: 'root-1', botId: A, generation: 1, title: 'retained owner' });
  store.proposeHandoff({ id: 'to-departing', taskId: 'member-task', fromBotId: A, toBotId: B, summary: 'pending' });
  store.startGroup({ spaceId: SPACE, principalId: P, receiverBotId: A, memberBotIds: [A, C] });
  assert.equal(store.getHandoff('to-departing')?.state, 'cancelled');
  assert.equal(store.beginOutboxSend('direct-b'), null);
  assert.equal(store.getOutbox('direct-b')?.state, 'rejected');
  assert.equal(store.getTask('member-task')?.ownerBotId, A);
});

test('backend switches preserve pending work forward through Codex to Claude to Codex, with durable operation evidence', async t => {
  const path = await directory(t); const first = new HostStore(path); seed(first); root(first);
  enqueue(first, 'old-native'); start(first);
  first.registerOutbox({ id: 'not-started-delivery', eventId: 'old-native', audience: 'group', payload: 'committed public intent' });
  first.claimTask({ id: 'switch-task', rootId: 'root-1', botId: A, generation: 1, title: 'keep working' });
  first.registerTaskWorker('switch-task', A, 'preserved-worker');
  first.proposeHandoff({ id: 'preserved-handoff', taskId: 'switch-task', fromBotId: A, toBotId: B, summary: 'already requested' });
  first.finishEvent('old-native', 'completed');
  enqueue(first, 'pending-observation', A, 'observation');
  const claude: HostController = { ...controller(A, 2), agent: 'claude', nativeId: 'new-claude-from-current-summary' };
  first.replaceControllerForAgentSwitch(A, P, claude, 1, 'switch-to-claude');
  assert.equal(first.getEvent('pending-observation')?.generation, 2);
  assert.equal(first.getEvent('old-native')?.generation, 1); // Historical native evidence is not rewritten.
  assert.equal(first.getRoot('root-1')?.generations[A], 2);
  assert.equal(first.getTask('switch-task')?.generation, 2);
  assert.equal(first.getHandoff('preserved-handoff')?.fromGeneration, 2);
  assert.equal(first.getOutbox('not-started-delivery')?.generation, 2);
  assert.deepEqual(first.taskWorkers('switch-task'), [{ botId: A, workerId: 'preserved-worker' }]);
  const codex: HostController = { ...controller(A, 3), nativeId: 'new-codex-from-latest-claude' };
  first.replaceControllerForAgentSwitch(A, P, codex, 2, 'switch-back-to-codex');
  first.close();
  const next = open(t, path);
  next.replaceControllerForAgentSwitch(A, P, codex, 2, 'switch-back-to-codex'); // Exact replay does not create another generation.
  assert.equal(next.getController(A)?.generation, 3);
  assert.equal(next.getController(A)?.nativeId, 'new-codex-from-latest-claude');
  assert.equal(next.getHandoff('preserved-handoff')?.state, 'proposed');
  const duplicate = next.enqueueEvent({ id: 'echo-pending', logicalId: 'pending-observation', rootId: 'root-1', botId: A, generation: 3, kind: 'observation', payload: {} });
  assert.equal(duplicate.id, 'pending-observation');
  assert.equal(next.listControllerSwitches(A).length, 2);
  assert.equal(next.beginOutboxSend('not-started-delivery')?.generation, 3);
  assert.equal(start(next), 'pending-observation');
  next.finishEvent('pending-observation', 'silent');
  assert.throws(() => next.replaceControllerForAgentSwitch(A, P, controller(A, 4), 3), /current backend/);
});

test('backend switch cannot proceed with uncertain native execution and atomically rolls back failed rebinding', async t => {
  const path = await directory(t); const first = new HostStore(path); seed(first); root(first); enqueue(first, 'unknown-native'); start(first); first.close();
  const store = open(t, path); store.recoverInFlight();
  const claude: HostController = { ...controller(A, 2), agent: 'claude' };
  assert.throws(() => store.replaceControllerForAgentSwitch(A, P, claude, 1, 'blocked-switch'), /safely ended/);
  assert.equal(store.listControllerSwitches().length, 0);
  store.finishEvent('unknown-native', 'failed', 'actual process verified ended');
  store.claimTask({ id: 'rebind-fault', rootId: 'root-1', botId: A, generation: 1, title: 'ordinary work' });
  enqueue(store, 'preserved-queue', A, 'observation');
  const fault = new DatabaseSync(store.path);
  try {
    fault.exec("CREATE TRIGGER fail_task_rebind BEFORE UPDATE OF generation ON host_tasks BEGIN SELECT RAISE(ABORT,'rebind failure'); END;");
    assert.throws(() => store.replaceControllerForAgentSwitch(A, P, claude, 1, 'failed-switch'), /rebind failure/);
    assert.equal(store.getController(A)?.generation, 1);
    assert.equal(store.getEvent('preserved-queue')?.generation, 1);
    assert.equal(store.getTask('rebind-fault')?.generation, 1);
    assert.equal(store.getRoot('root-1')?.generations[A], 1);
    assert.equal(store.listControllerSwitches().length, 0);
  } finally { fault.exec('DROP TRIGGER fail_task_rebind'); fault.close(); }
  store.replaceControllerForAgentSwitch(A, P, claude, 1, 'successful-switch');
  assert.equal(store.getTask('rebind-fault')?.generation, 2);
});

test('a proposed handoff prevents new workers from invalidating a trusted execution-stop proof', async t => {
  const store = open(t, await directory(t)); seed(store); root(store);
  store.claimTask({ id: 'stop-proof', rootId: 'root-1', botId: A, generation: 1, title: 'handoff safely' });
  store.registerTaskWorker('stop-proof', A, 'existing-worker');
  store.proposeHandoff({ id: 'stop-proof-handoff', taskId: 'stop-proof', fromBotId: A, toBotId: B, summary: 'stopped old execution' });
  store.confirmTaskExecutionStopped('stop-proof', A, 'runtime verified no linked workers are active');
  assert.throws(() => store.registerTaskWorker('stop-proof', A, 'new-old-worker'), /pending handoff/);
  assert.throws(() => store.markTaskExecutionActive('stop-proof', A), /pending handoff/);
  assert.equal(store.acceptHandoff('stop-proof-handoff', B).ownerBotId, B);
});
