import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { HostRuntime } from '../src/host-runtime.js';
import { ControllerStore } from '../src/controller/store.js';
import type { ControllerJob, ControllerJobStatus, ControllerWorker, ControllerSchedule } from '../src/controller/runtime-types.js';
import type { BotRuntime } from '../src/bot-runtime.js';
import type { HostConfig } from '../src/config.js';
import type { AgentTurn, BridgeConfig } from '../src/types.js';

const A = 'feishu:scene-runtime-a', B = 'feishu:scene-runtime-b', P = 'owner', SPACE = 'group';
async function fixture(t: TestContext) {
  const path = await mkdtemp(join(tmpdir(), 'bridge-scene-runtime-test-'));
  const configs = [A, B].map((id, index): BridgeConfig => ({ botId: id, platform: 'feishu', applicationId: id.slice(7),
    scopePrefix: id + '|', ownerPrincipalId: P, ownerUserId: id + '|owner-' + index, token: '', allowedUserIds: [id + '|owner-' + index],
    defaultAgent: 'codex', workspace: path, dataDir: join(path, 'bot-' + index), attachmentsDir: join(path, 'images-' + index),
    logsDir: join(path, 'logs-' + index), proxyUrl: null, maxImageBytes: 1024, maxFileBytes: 1024,
    controllerMode: true, groupMode: true, internalBotCommunicationEnabled: false,
    commands: { codex: { command: 'fake', args: [] }, claude: { command: 'fake', args: [] } } }));
  const config: HostConfig = { version: 3, rootDataDir: join(path, 'host'), configs, internalBotCommunicationEnabled: false,
    principals: [{ id: P, accounts: { [A]: 'owner-0', [B]: 'owner-1' } }],
    spaces: [{ id: SPACE, accounts: { [A]: 'group-a', [B]: 'group-b' } }] };
  const reports: string[] = [], host = new HostRuntime(config,
    { version: 3, status: 'complete', migrationId: 'test', migratedAt: '2026-10-18T00:00:00.000Z', bots: [] },
    async () => ({ accepted: true }), line => reports.push(line));
  const hooks = new Map(configs.map(c => [c.botId!, host.hooks(c)]));
  const stores = new Map<string, ControllerStore>();
  const beforeCommit = new Map<string, () => Promise<void>>();
  const stopped = new Set<string>();
  const jobKey = (botId: string, workerId: string) => botId + '/' + workerId;
  for (const c of configs) {
    const botId = c.botId!;
    const store = new ControllerStore(c.dataDir); stores.set(botId, store);
    const controller = { store, isWorkerStopped: (workerId: string) => stopped.has(jobKey(botId, workerId))
      && !store.jobs(workerId).some(job => ['queued', 'running', 'uncertain'].includes(job.status))
      && !store.schedules().some(plan => plan.worker?.id === workerId && ['pending', 'dispatching', 'running', 'uncertain'].includes(plan.status)) };
    host.attach({ config: c, controller, manager: { isIdle: () => true },
      transport: { async getGroupInfo() { return { botIsMember: true }; }, async getGroupMember() { return { id: 'owner' }; } },
      isReady: () => true, isIdle: () => true, async close() { store.close(); },
    } as unknown as BotRuntime);
    host.store.claimOwner(botId, P);
    host.store.setController(botId, P, { conversationId: botId + '-conversation', generation: 1, agent: 'codex', nativeId: null }, 0);
  }
  host.store.startGroup({ spaceId: SPACE, principalId: P, receiverBotId: A, memberBotIds: [A, B] });
  let rootCount = 0, registrations = 0;
  async function turn(botId: string, rootId = 'root'): Promise<AgentTurn> {
    if (!host.store.getRoot(rootId)) host.store.acceptRoot({ id: rootId, spaceId: SPACE, principalId: P,
      sourceEventId: 'owner-' + ++rootCount, targetBotIds: [A, B], replyTo: { platform: 'feishu', channelId: 'group-a', spaceId: SPACE } });
    const eventId = rootId + '/' + botId;
    host.store.enqueueEvent({ id: eventId, rootId, botId, generation: 1, kind: 'human', payload: { text: 'Please inspect' } });
    assert.equal(host.store.claimNextEvent(botId)?.id, eventId);
    const groupContext = { eventId, rootId, botId, spaceId: SPACE, generation: 1, bindingEpoch: host.store.getGroup(SPACE)!.epoch,
      originChannelId: botId + '|group-' + (botId === A ? 'a' : 'b'), principalId: P, scene: '' };
    groupContext.scene = await hooks.get(botId)!.manager!.onGroupTurnStart!(groupContext);
    const now = new Date().toISOString();
    return { conversation: { id: botId + '-conversation', userId: configs.find(c => c.botId === botId)!.ownerUserId!,
      agent: 'codex', nativeId: null, cwd: path, title: 'Controller', createdAt: now, updatedAt: now },
      text: 'Please inspect', imagePaths: [], signal: new AbortController().signal, groupContext, onProgress: async () => {} };
  }
  async function invoke(botId: string, input: AgentTurn, name: string, args: Record<string, unknown>, callId: string): Promise<any> {
    return host.invoke(botId, input, name, args, callId, async delegated => {
      const store = stores.get(botId)!, cacheKey = input.conversation.id + ':' + callId, fingerprint = JSON.stringify(delegated);
      const previous = store.getCall(cacheKey, fingerprint); if (previous) return previous;
      await beforeCommit.get(callId)?.();
      registrations++;
      const workerId = name === 'bridge_continue_worker' ? String(args.workerId) : 'worker-' + callId;
      const receipt = { workerId, jobId: 'job-' + callId, status: name === 'bridge_schedule_worker' ? 'pending' : 'queued' };
      const now = new Date().toISOString(), origin = { conversationId: input.conversation.id, userId: input.conversation.userId,
        channelId: input.groupContext!.originChannelId, originMessageId: input.groupContext!.eventId, nativeId: input.conversation.nativeId,
        agent: input.conversation.agent, cwd: input.conversation.cwd, groupContext: input.groupContext };
      const worker: ControllerWorker = store.getWorker(workerId) ?? { id: workerId, origin, agent: 'codex', model: null, actualModel: null,
        effort: null, cwd: input.conversation.cwd, title: String(args.title ?? 'Continue'), nativeId: null,
        imagePaths: [], wakeAllowed: true, ownership: 'bridge', createdAt: now, updatedAt: now };
      const job: ControllerJob = { id: receipt.jobId, workerId, origin, prompt: String(args.prompt), imagePaths: [],
        status: 'queued', taskId: null, result: null, cancelReason: null, createdAt: now, updatedAt: now };
      store.transaction(() => {
        if (name === 'bridge_schedule_worker') {
          const plan: ControllerSchedule = { id: 'plan-' + callId, kind: 'worker', origin, title: worker.title, text: job.prompt,
            dueAt: new Date(Date.now() + 60_000).toISOString(), status: 'pending', taskId: null, worker, job, createdAt: now, updatedAt: now };
          store.addSchedule(plan);
        } else { if (!store.getWorker(workerId)) store.addWorker(worker); store.addJob(job); }
        store.saveCall(cacheKey, fingerprint, receipt);
      });
      stopped.delete(jobKey(botId, workerId));
      return receipt;
    });
  }
  const settle = (botId: string, workerId: string, status: ControllerJobStatus) => {
    const store = stores.get(botId)!, list = store.jobs(workerId); if (list.length) store.setJob(list.at(-1)!.id, status);
    stopped.add(jobKey(botId, workerId)); hooks.get(botId)!.onExecutionSettled!();
  };
  t.after(async () => { await host.close(); await rm(path, { recursive: true, force: true }); });
  return { host, hooks, turn, invoke, settle, stores, beforeCommit, stopped, jobKey, reports, registrations: () => registrations };
}

test('group dispatch needs no explicit claim, keeps one task and one execution for a stable repeated call', async t => {
  const f = await fixture(t), input = await f.turn(A);
  const args = { title: 'Inspect conversation', prompt: 'Read only', resources: ['browser'] };
  const first = await f.invoke(A, input, 'bridge_start_worker', args, 'start');
  const second = await f.invoke(A, input, 'bridge_start_worker', args, 'start');
  assert.deepEqual(second, first); assert.equal(f.registrations(), 1);
  const [task] = f.host.store.listTasks(); assert(task); assert.equal(task.ownerBotId, A); assert.equal(task.state, 'active');
  assert.deepEqual(task.resources, ['browser']); assert.deepEqual(f.host.store.taskWorkers(task.id), [{ botId: A, workerId: first.workerId }]);
  assert.equal(f.host.store.getAutomaticDispatch(task.id)!.callId, 'start');
  assert(f.host.store.readSceneUpdates(SPACE, B, 0).updates.some(value => value.kind === 'dispatch'));
});

test('a stale Bot is paused once, then the ordinary resource conflict still blocks duplicate execution', async t => {
  const f = await fixture(t), a = await f.turn(A), b = await f.turn(B);
  await f.invoke(A, a, 'bridge_start_worker', { title: 'Read private conversation', prompt: 'Read', resources: ['browser'] }, 'first');
  const stale = await f.invoke(B, b, 'bridge_start_worker', { title: 'Another useful idea', prompt: 'Inspect', resources: ['browser'] }, 'second');
  assert.equal(stale.performed, false); assert.equal(stale.sceneRefreshRequired, true);
  const scene = JSON.parse(stale.scene); assert.equal(scene.newAuthorization, false);
  assert(scene.updates.every((update: any) => update.canAuthorize === false));
  assert.equal(f.registrations(), 1);
  await assert.rejects(f.invoke(B, b, 'bridge_start_worker', { title: 'Another useful idea', prompt: 'Inspect', resources: ['browser'] }, 'second'), /Resource browser/);
  const different = await f.invoke(B, b, 'bridge_start_worker', { title: 'Independent review', prompt: 'Review', resources: ['source-read'] }, 'different');
  assert.equal(different.status, 'queued'); assert.equal(f.registrations(), 2);
  f.host.store.appendPublic({ id: 'new-public-progress', rootId: 'root', authorBotId: A, principalId: P, text: 'More progress' });
  const afterCap = await f.invoke(B, b, 'bridge_start_worker', { title: 'One further check', prompt: 'Check', resources: [] }, 'after-cap');
  assert.equal(afterCap.status, 'queued');
});

test('completion advances scene and releases resources; a new owner request can continue the same closed task', async t => {
  const f = await fixture(t), input = await f.turn(A);
  const first = await f.invoke(A, input, 'bridge_start_worker', { title: 'Inspect', prompt: 'Read', resources: ['browser'] }, 'start');
  const original = f.host.store.listTasks()[0]!;
  f.settle(A, first.workerId, 'completed');
  assert.equal(f.host.store.getTask(original.id)!.state, 'completed');
  assert(f.host.store.readSceneUpdates(SPACE, A, 0).updates.some(value => value.kind === 'completion'));
  f.host.store.finishEvent(input.groupContext!.eventId, 'completed');
  const next = await f.turn(A, 'next-owner-request');
  const result = await f.invoke(A, next, 'bridge_continue_worker', { workerId: first.workerId, prompt: 'Inspect another angle' }, 'continue');
  assert.equal(result.workerId, first.workerId); assert.equal(f.host.store.listTasks().length, 1);
  const reopened = f.host.store.getTask(original.id)!;
  assert.equal(reopened.state, 'active'); assert.equal(reopened.rootId, original.rootId); assert.deepEqual(reopened.replyTo, original.replyTo);
  f.settle(A, first.workerId, 'completed'); assert.equal(f.host.store.getTask(original.id)!.state, 'completed');
});

test('uncertain execution and pending scheduled work remain active; confirmed cancellation closes the task', async t => {
  const f = await fixture(t), input = await f.turn(A);
  const first = await f.invoke(A, input, 'bridge_start_worker', { title: 'Inspect', prompt: 'Read' }, 'uncertain');
  const work = f.host.store.getTaskForWorker(A, first.workerId)!;
  f.settle(A, first.workerId, 'uncertain'); assert.equal(f.host.store.getTask(work.id)!.state, 'active');
  f.settle(A, first.workerId, 'cancelled'); assert.equal(f.host.store.getTask(work.id)!.state, 'cancelled');
  // The own completion is new information; the next old decision is paused once before it can schedule.
  let planned = await f.invoke(A, input, 'bridge_schedule_worker', { title: 'Later review', prompt: 'Review', afterSeconds: 60 }, 'scheduled');
  if (planned.sceneRefreshRequired) planned = await f.invoke(A, input, 'bridge_schedule_worker', { title: 'Later review', prompt: 'Review', afterSeconds: 60 }, 'scheduled');
  const scheduled = f.host.store.getTaskForWorker(A, planned.workerId)!;
  f.stopped.add(f.jobKey(A, planned.workerId)); f.hooks.get(A)!.onExecutionSettled!();
  assert.equal(f.host.store.getTask(scheduled.id)!.state, 'active');
  const store = f.stores.get(A)!, plan = store.schedules().find(value => value.worker?.id === planned.workerId)!;
  store.saveSchedule({ ...plan, status: 'cancelled' });
  f.hooks.get(A)!.onExecutionSettled!(); assert.equal(f.host.store.getTask(scheduled.id)!.state, 'cancelled');
});

test('owner revocation before dispatch prevents execution and leaves no automatic task', async t => {
  const f = await fixture(t), input = await f.turn(A);
  f.host.config.configs.find(value => value.botId === A)!.allowedUserIds.length = 0;
  await assert.rejects(f.invoke(A, input, 'bridge_start_worker', { title: 'Should not start', prompt: 'Read' }, 'revoked'), /权限|上下文/);
  assert.equal(f.registrations(), 0); assert.equal(f.host.store.listTasks().length, 0);
});

test('replaying a completed call returns its original receipt without reviving work or adding another completion', async t => {
  const f = await fixture(t), input = await f.turn(A), args = { title: 'Inspect', prompt: 'Read' };
  const first = await f.invoke(A, input, 'bridge_start_worker', args, 'finished-call');
  const task = f.host.store.getTaskForWorker(A, first.workerId)!;
  f.settle(A, first.workerId, 'completed');
  let replay = await f.invoke(A, input, 'bridge_start_worker', args, 'finished-call');
  if (replay.sceneRefreshRequired) replay = await f.invoke(A, input, 'bridge_start_worker', args, 'finished-call');
  assert.deepEqual(replay, first); assert.equal(f.registrations(), 1);
  assert.equal(f.host.store.getTask(task.id)!.state, 'completed');
  assert.equal(f.stores.get(A)!.jobs(first.workerId).length, 1);
  assert.equal(f.host.store.readSceneUpdates(SPACE, B, 0).updates.filter(value => value.kind === 'completion').length, 1);
});

test('an existing legacy work id is journaled and automatically closes without a separate finish call', async t => {
  const f = await fixture(t), input = await f.turn(A);
  f.host.store.claimTask({ id: 'legacy-browser-inspection', rootId: 'root', botId: A, generation: 1, title: 'Legacy inspection', resources: ['browser'] });
  const result = await f.invoke(A, input, 'bridge_start_worker', { workId: 'legacy-browser-inspection', title: 'Legacy inspection', prompt: 'Read' }, 'legacy-start');
  assert.equal(f.host.store.getAutomaticDispatch('legacy-browser-inspection')!.callId, 'legacy-start');
  assert.equal(f.host.store.getTaskForWorker(A, result.workerId)!.id, 'legacy-browser-inspection');
  f.settle(A, result.workerId, 'completed');
  assert.equal(f.host.store.getTask('legacy-browser-inspection')!.state, 'completed');
});

test('a journaled dispatch without an atomic execution receipt is cancelled and releases reserved resources', async t => {
  const f = await fixture(t), input = await f.turn(A);
  f.host.store.claimTask({ id: 'auto-work:interrupted-before-commit', rootId: 'root', botId: A, generation: 1,
    title: 'Interrupted preparation', resources: ['browser'], automaticDispatch: { conversationId: input.conversation.id,
      callId: 'no-execution-receipt', toolName: 'bridge_start_worker' } });
  f.hooks.get(A)!.onExecutionSettled!();
  assert.equal(f.host.store.getTask('auto-work:interrupted-before-commit')!.state, 'cancelled');
  f.host.store.claimTask({ id: 'resource-free-again', rootId: 'root', botId: B, generation: 1, title: 'Another inspection', resources: ['browser'] });
  assert.equal(f.host.store.getTask('resource-free-again')!.state, 'active');
  assert.equal(f.registrations(), 0);
});

test('recovery restores a missing host worker link from the durable execution receipt without redispatching', async t => {
  const f = await fixture(t), input = await f.turn(A);
  const result = await f.invoke(A, input, 'bridge_start_worker', { title: 'Inspect', prompt: 'Read' }, 'crash-gap');
  const task = f.host.store.getTaskForWorker(A, result.workerId)!;
  // Recreate the crash boundary after the execution transaction committed but before the Host link committed.
  const db = new DatabaseSync(f.host.store.path);
  try { db.prepare('DELETE FROM host_task_workers WHERE task_id=?').run(task.id); } finally { db.close(); }
  assert.equal(f.host.store.taskWorkers(task.id).length, 0);
  f.hooks.get(A)!.onExecutionSettled!();
  assert.deepEqual(f.host.store.taskWorkers(task.id), [{ botId: A, workerId: result.workerId }]);
  assert.equal(f.registrations(), 1); assert.equal(f.host.store.getTask(task.id)!.state, 'active');
  f.settle(A, result.workerId, 'completed'); assert.equal(f.host.store.getTask(task.id)!.state, 'completed');
});

test('an in-flight dispatch preparation is not cancelled merely because its atomic receipt has not committed yet', async t => {
  const f = await fixture(t), input = await f.turn(A);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }); f.beforeCommit.set('slow-commit', () => gate);
  const pending = f.invoke(A, input, 'bridge_start_worker', { title: 'Slow validation', prompt: 'Read', resources: ['browser'] }, 'slow-commit');
  try {
    const task = f.host.store.listTasks()[0]!; assert(task); assert.equal(f.host.store.taskWorkers(task.id).length, 0);
    f.hooks.get(A)!.onExecutionSettled!(); assert.equal(f.host.store.getTask(task.id)!.state, 'active');
    release(); const result = await pending;
    assert.equal(f.host.store.getTaskForWorker(A, result.workerId)!.id, task.id);
    assert.equal(f.host.store.getTask(task.id)!.state, 'active'); assert.equal(f.registrations(), 1);
  } finally { release(); await pending; }
});

test('an unknown durable dispatch receipt remains unresolved and is never treated as an unsubmitted execution', async t => {
  const f = await fixture(t), input = await f.turn(A), taskId = 'auto-work:unknown-receipt';
  f.host.store.claimTask({ id: taskId, rootId: 'root', botId: A, generation: 1, title: 'Unknown', resources: ['browser'],
    automaticDispatch: { conversationId: input.conversation.id, callId: 'unknown-call', toolName: 'bridge_start_worker' } });
  f.stores.get(A)!.transaction(() => f.stores.get(A)!.saveCall(input.conversation.id + ':unknown-call', 'unknown', { status: 'uncertain' }));
  f.hooks.get(A)!.onExecutionSettled!();
  assert.equal(f.host.store.getTask(taskId)!.state, 'active');
  assert.throws(() => f.host.store.claimTask({ id: 'other-browser', rootId: 'root', botId: B, generation: 1,
    title: 'Other', resources: ['browser'] }), /Resource browser/);
  assert.equal(f.registrations(), 0);
});

test('recovery links the latest committed worker even when stopped historical workers are already attached', async t => {
  const f = await fixture(t), input = await f.turn(A);
  const first = await f.invoke(A, input, 'bridge_start_worker', { title: 'First inspection', prompt: 'Read', resources: ['browser'] }, 'old-worker');
  const task = f.host.store.getTaskForWorker(A, first.workerId)!;
  const second = await f.invoke(A, input, 'bridge_start_worker', { workId: task.id, title: 'Additional inspection', prompt: 'Read another part' }, 'latest-worker');
  // Crash after the second execution transaction, before its Host link; the historical link remains.
  const db = new DatabaseSync(f.host.store.path);
  try { db.prepare('DELETE FROM host_task_workers WHERE task_id=? AND worker_id=?').run(task.id, second.workerId); } finally { db.close(); }
  const execution = f.stores.get(A)!;
  execution.setJob(first.jobId, 'completed'); f.stopped.add(f.jobKey(A, first.workerId));
  assert.deepEqual(f.host.store.taskWorkers(task.id), [{ botId: A, workerId: first.workerId }]);
  f.hooks.get(A)!.onExecutionSettled!();
  assert.equal(f.host.store.getTask(task.id)!.state, 'active');
  assert.deepEqual(f.host.store.taskWorkers(task.id).map(value => value.workerId).sort(), [first.workerId, second.workerId].sort());
  assert.equal(execution.getJob(second.jobId)!.status, 'queued'); assert.equal(f.registrations(), 2);
  assert.throws(() => f.host.store.claimTask({ id: 'resource-still-occupied', rootId: 'root', botId: B,
    generation: 1, title: 'Another browser task', resources: ['browser'] }), /Resource browser/);
  f.settle(A, second.workerId, 'completed'); assert.equal(f.host.store.getTask(task.id)!.state, 'completed');
});

test('an unknown latest receipt cannot be closed using only stopped historical workers', async t => {
  const f = await fixture(t), input = await f.turn(A);
  const first = await f.invoke(A, input, 'bridge_start_worker', { title: 'Initial inspection', prompt: 'Read', resources: ['browser'] }, 'historical-worker');
  const task = f.host.store.getTaskForWorker(A, first.workerId)!;
  f.host.store.registerAutomaticDispatch({ taskId: task.id, botId: A, conversationId: input.conversation.id,
    callId: 'unknown-latest', toolName: 'bridge_start_worker' });
  const execution = f.stores.get(A)!;
  execution.transaction(() => execution.saveCall(input.conversation.id + ':unknown-latest', 'unknown-latest', { status: 'uncertain' }));
  execution.setJob(first.jobId, 'completed'); f.stopped.add(f.jobKey(A, first.workerId));
  f.hooks.get(A)!.onExecutionSettled!();
  assert.equal(f.host.store.getTask(task.id)!.state, 'active');
  assert.equal(f.host.store.getTask(task.id)!.executionStoppedProof, null);
  assert.equal(f.host.store.taskWorkers(task.id).length, 1); assert.equal(f.registrations(), 1);
  assert.throws(() => f.host.store.claimTask({ id: 'unknown-resource-not-free', rootId: 'root', botId: B,
    generation: 1, title: 'Another browser task', resources: ['browser'] }), /Resource browser/);
});

test('recovery restores an intermediate committed dispatch even when the latest concurrent preparation never committed', async t => {
  const f = await fixture(t), input = await f.turn(A);
  const first = await f.invoke(A, input, 'bridge_start_worker', { title: 'Historical inspection', prompt: 'Read', resources: ['browser'] }, 'history-before-concurrent');
  const task = f.host.store.getTaskForWorker(A, first.workerId)!;
  const middle = await f.invoke(A, input, 'bridge_start_worker', { workId: task.id, title: 'Committed intermediate inspection', prompt: 'Inspect' }, 'middle-committed');
  f.host.store.registerAutomaticDispatch({ taskId: task.id, botId: A, conversationId: input.conversation.id,
    callId: 'latest-never-committed', toolName: 'bridge_start_worker' });
  const db = new DatabaseSync(f.host.store.path);
  try { db.prepare('DELETE FROM host_task_workers WHERE task_id=? AND worker_id=?').run(task.id, middle.workerId); } finally { db.close(); }
  const execution = f.stores.get(A)!;
  execution.setJob(first.jobId, 'completed'); f.stopped.add(f.jobKey(A, first.workerId));
  assert.equal(f.host.store.getAutomaticDispatch(task.id)!.callId, 'latest-never-committed');
  f.hooks.get(A)!.onExecutionSettled!();
  assert.equal(f.host.store.getTask(task.id)!.state, 'active');
  assert.deepEqual(f.host.store.taskWorkers(task.id).map(value => value.workerId).sort(), [first.workerId, middle.workerId].sort());
  assert.equal(execution.getJob(middle.jobId)!.status, 'queued'); assert.equal(f.registrations(), 2);
  assert.throws(() => f.host.store.claimTask({ id: 'intermediate-resource-busy', rootId: 'root', botId: B,
    generation: 1, title: 'Another browser task', resources: ['browser'] }), /Resource browser/);
  f.settle(A, middle.workerId, 'completed'); assert.notEqual(f.host.store.getTask(task.id)!.state, 'active');
  f.host.store.claimTask({ id: 'intermediate-resource-free', rootId: 'root', botId: B,
    generation: 1, title: 'Another browser task', resources: ['browser'] });
});

test('an unknown intermediate receipt remains unresolved even after a newer committed dispatch has stopped', async t => {
  const f = await fixture(t), input = await f.turn(A);
  const first = await f.invoke(A, input, 'bridge_start_worker', { title: 'Historical inspection', prompt: 'Read', resources: ['browser'] }, 'history-before-unknown');
  const task = f.host.store.getTaskForWorker(A, first.workerId)!;
  f.host.store.registerAutomaticDispatch({ taskId: task.id, botId: A, conversationId: input.conversation.id,
    callId: 'middle-unknown', toolName: 'bridge_start_worker' });
  const execution = f.stores.get(A)!;
  execution.transaction(() => execution.saveCall(input.conversation.id + ':middle-unknown', 'unknown', { status: 'uncertain' }));
  const latest = await f.invoke(A, input, 'bridge_start_worker', { workId: task.id, title: 'Latest inspection', prompt: 'Inspect' }, 'latest-known');
  f.settle(A, first.workerId, 'completed'); f.settle(A, latest.workerId, 'completed');
  assert.equal(f.host.store.getAutomaticDispatch(task.id)!.callId, 'latest-known');
  assert.equal(f.host.store.getTask(task.id)!.state, 'active'); assert.equal(f.host.store.getTask(task.id)!.executionStoppedProof, null);
  assert.throws(() => f.host.store.claimTask({ id: 'unknown-intermediate-resource-busy', rootId: 'root', botId: B,
    generation: 1, title: 'Another browser task', resources: ['browser'] }), /Resource browser/);
});
