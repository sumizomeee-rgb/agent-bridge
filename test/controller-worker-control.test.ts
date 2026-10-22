import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { ControllerRuntime } from '../src/controller/runtime.js';
import type { ControllerTargetCatalog } from '../src/controller/runtime-types.js';
import { TaskRegistry } from '../src/tasks.js';
import type { AgentAdapter, AgentName, AgentResult, AgentTurn, BridgeConfig } from '../src/types.js';
import type { NativeSessionAdoptArgs, NativeSessionAdoption, NativeSessionRead } from '../src/native-sessions.js';
import type { WorkCounts } from '../src/overview.js';

class Child implements AgentAdapter {
  async getModelInfo() { return { defaultModel: 'gpt-6.1-sol', models: [
    { id: 'gpt-6.1-sol', displayName: 'Sol', supportedEfforts: ['low', 'medium', 'high', 'xhigh'] },
    { id: 'gpt-6-astra', displayName: 'Astra', supportedEfforts: ['low', 'medium', 'high', 'xhigh'] },
    { id: 'sonnet', displayName: 'Sonnet', supportedEfforts: ['low', 'medium', 'high'] },
    { id: 'haiku', displayName: 'Custom fixture', supportedEfforts: ['low', 'medium', 'high'] },
    { id: 'user-alias', displayName: 'Fixture', supportedEfforts: ['medium'] },
    { id: 'model-A', displayName: 'Fixture', supportedEfforts: ['medium'] },
    { id: 'unsupported', displayName: 'No effort', supportedEfforts: [] },
    { id: 'unknown', displayName: 'Unknown' },
  ] }; }

  turns: AgentTurn[] = [];
  pending = new Map<string, { resolve: (value: AgentResult) => void; reject: (error: Error) => void; nativeId: string }>();
  async run(turn: AgentTurn): Promise<AgentResult> {
    this.turns.push(turn);
    const nativeId = turn.conversation.nativeId ?? randomUUID();
    turn.onNativeId?.(nativeId); turn.onReady?.();
    return new Promise((resolve, reject) => this.pending.set(turn.conversation.id, { resolve, reject, nativeId }));
  }
  finish(workerId: string, nativeId?: string): void {
    const job = this.pending.get(workerId); assert.ok(job); this.pending.delete(workerId);
    job.resolve({ nativeId: nativeId ?? job.nativeId, text: 'original transcript continued' });
  }
  async interrupt(workerId: string): Promise<void> {
    const job = this.pending.get(workerId); this.pending.delete(workerId); job?.reject(new Error('stopped'));
  }
  async close(): Promise<void> {}
}
type Handle = { workerId: string; jobId?: string; nativeId: string; model: string | null; effort: string | null; status: string };
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-worker-control-'));
  const registry = new TaskRegistry(dir), codex = new Child(), claude = new Child();
  const config: BridgeConfig = { token: 'unused', allowedUserIds: ['owner'], defaultAgent: 'codex', workspace: dir, proxyUrl: null,
    commands: { codex: { command: 'codex', args: [] }, claude: { command: 'claude', args: [] } }, dataDir: dir,
    attachmentsDir: dir, logsDir: dir, maxImageBytes: 100 };
  const context = registry.createContext({ conversationId: 'parent', userId: 'owner', channelId: 'dm', originMessageId: 'first',
    nativeId: 'controller-session', agent: 'codex', cwd: dir });
  const turn: AgentTurn = { conversation: { id: 'parent', userId: 'owner', agent: 'codex', nativeId: 'controller-session',
    model: 'gpt-6.1-sol', effort: 'xhigh', actualEffort: 'xhigh', title: 'parent', cwd: dir,
    createdAt: '2026-10-13T00:00:00Z', updatedAt: '2026-10-13T00:00:00Z' }, text: 'dispatch', imagePaths: [],
    taskContextPath: context.contextPath, signal: new AbortController().signal, onProgress: () => {} };
  const candidate: NativeSessionRead = { ref: { agent: 'codex', profile: 'default', nativeId: randomUUID() }, nativeId: '',
    profile: 'default', cwd: dir, title: 'human native history', model: 'gpt-6-astra', effort: 'medium', provider: 'company',
    revision: 'checked-v1', health: 'healthy', busyEvidence: [], messages: [{ role: 'user', text: 'earlier work' }], truncated: false };
  candidate.nativeId = candidate.ref.nativeId;
  const attempts: NativeSessionAdoptArgs[] = [];
  let receipt: NativeSessionAdoption | undefined, loseFirstReceipt = false, now = Date.parse('2026-10-13T10:00:00Z');
  const counts: WorkCounts[] = [], errors: unknown[] = [];
  const catalog: ControllerTargetCatalog = {
    async listTargets() { return []; },
    async resolveTarget(_workspace, targetId, agent, cwd) { return { id: targetId, label: targetId === 'local' ? 'laptop' : 'workstation',
      transport: targetId === 'local' ? 'local' : 'ssh', agent, agentCommand: config.commands[agent], cwd: cwd ?? dir }; },
    adapterFor(binding) { return binding.agent === 'codex' ? codex : claude; },
    async handoff(binding, nativeId, cwd, agent) { return { targetId: binding.id, nativeId, cwd, agent, stopped: true,
      resumeCommand: `${agent} resume ${nativeId}` }; },
    async authorizeNativeAccess(_workspace, userId) { if (userId !== 'owner') throw new Error('not authorized'); },
    async listNativeSessions() { return { sessions: [candidate], nextCursor: null }; },
    async readNativeSession() { return { ...candidate }; },
    async adoptNativeSession(_binding, userId, args) {
      attempts.push(args);
      if (!receipt || receipt.adoptionId !== args.adoptionId) receipt = { ...candidate, workerId: args.workerId, userId,
        adoptionId: args.adoptionId, status: 'adopted', leaseRevision: 1 };
      if (loseFirstReceipt) { loseFirstReceipt = false; candidate.revision = 'lease-v2'; candidate.health = 'unknown'; throw new Error('lost transport reply'); }
      return receipt;
    },
  };
  const callbacks = { targetCatalog: catalog, now: () => now, onWorkCountsChanged: (value: WorkCounts) => { counts.push(value); },
    onError: (error: unknown) => { errors.push(error); }, pollIntervalMs: 60000 };
  const runtime = new ControllerRuntime(config, { codex, claude }, registry, callbacks);
  return { dir, turn, registry, codex, claude, candidate, config, catalog, callbacks, runtime, attempts, counts, errors,
    loseReply: () => { loseFirstReceipt = true; }, advance: (ms: number) => { now += ms; },
    async cleanup() { await runtime.close(); registry.close(); } };
}
async function flush(): Promise<void> { for (let i = 0; i < 3; i++) await new Promise<void>(resolve => setImmediate(resolve)); }
async function launch(f: ReturnType<typeof setup>, args: Record<string, unknown> = {}): Promise<Handle> {
  return await f.runtime.invoke(f.turn, 'bridge_start_worker', { title: 'task', prompt: 'read-only task', ...args }) as Handle;
}
async function adopt(f: ReturnType<typeof setup>, callId?: string): Promise<Handle> {
  return await f.runtime.invoke(f.turn, 'bridge_adopt_native_session', { ...f.candidate.ref, expectedRevision: 'checked-v1' }, callId) as Handle;
}

function anotherRegion(f: ReturnType<typeof setup>, channelId: string, group = true): AgentTurn {
  const conversation = f.turn.conversation;
  const groupContext: AgentTurn['groupContext'] = group ? { eventId: 'event-' + channelId, rootId: 'root-' + channelId,
    botId: f.config.platform + ':bot', spaceId: channelId, generation: 1, bindingEpoch: 1, originChannelId: channelId,
    principalId: 'owner', scene: '{}' } : undefined;
  const context = f.registry.createContext({ conversationId: conversation.id, userId: conversation.userId, channelId,
    originMessageId: 'message-' + channelId, nativeId: conversation.nativeId, agent: conversation.agent, cwd: conversation.cwd,
    ...(groupContext ? { groupContext } : {}) });
  return { ...f.turn, taskContextPath: context.contextPath, groupContext };
}

for (const platform of ['feishu', 'discord'] as const) {
  test(`${platform} one controller can find and stop its private worker from a group without changing existing job delivery`, async () => {
    const f = setup(); f.config.platform = platform;
    try {
      const handle = await launch(f); assert.ok(handle.jobId); await flush();
      const worker = f.runtime.store.getWorker(handle.workerId)!, original = structuredClone(worker.origin);
      const group = anotherRegion(f, platform + '-group');
      f.runtime.store.addWorker({ ...worker, id: 'another-parent', nativeId: null, origin: { ...original, conversationId: 'old-parent' } });
      f.runtime.store.addWorker({ ...worker, id: 'another-owner', nativeId: null, origin: { ...original, userId: 'someone-else' } });
      const list = await f.runtime.invoke(group, 'bridge_list_workers', {}) as { workers: Array<{ workerId: string; running: boolean; source: { kind: string; channelId: string } }> };
      assert.deepEqual(list.workers.map(w => w.workerId), [handle.workerId]);
      assert.equal(list.workers[0]!.running, true); assert.deepEqual(list.workers[0]!.source, { kind: 'private', channelId: 'dm' });
      for (const workerId of ['another-parent', 'another-owner']) {
        await assert.rejects(f.runtime.invoke(group, 'bridge_list_workers', { workerId }), /不属于/);
        await assert.rejects(f.runtime.invoke(group, 'bridge_cancel_worker', { workerId }), /不属于/);
        await assert.rejects(f.runtime.invoke(group, 'bridge_continue_worker', { workerId, prompt: 'forbidden' }), /不属于/);
      }
      await f.runtime.invoke(group, 'bridge_continue_worker', { workerId: handle.workerId, prompt: 'queued instruction', delivery: 'next' });
      assert.deepEqual(f.runtime.store.getJob(handle.jobId)!.origin, original);
      const result = await f.runtime.invoke(group, 'bridge_cancel_worker', { workerId: handle.workerId }) as { stopped: boolean };
      assert.equal(result.stopped, true); await flush();
      assert.deepEqual(f.runtime.getGlobalWorkCounts(), { running: 0, queued: 0 });
      assert.equal(f.codex.turns.length, 1, 'queued work never started after cancellation');
      assert.equal(f.runtime.store.jobs(handle.workerId).every(j => j.status === 'cancelled'), true);
      assert.deepEqual(f.runtime.store.getWorker(handle.workerId)!.origin, original);
      const task = f.registry.getTask(handle.jobId)!; assert.equal(task.status, 'cancelled');
      const details = await f.runtime.invoke(f.turn, 'bridge_list_workers', { workerId: handle.workerId }) as { workers: Array<{ running: boolean; queued: number }> };
      assert.equal(details.workers[0]!.running, false); assert.equal(details.workers[0]!.queued, 0);
    } finally { await f.cleanup(); }
  });

  test(`${platform} group workers remain manageable from another group and private chat with native ownership enforced`, async () => {
    const f = setup(); f.config.platform = platform;
    try {
      const groupA = anotherRegion(f, 'group-A'), groupB = anotherRegion(f, 'group-B');
      const handle = await f.runtime.invoke(groupA, 'bridge_start_worker', { title: 'group task', prompt: 'read only', sessionVisibility: 'visible' }) as Handle;
      assert.ok(handle.jobId); await flush(); const original = structuredClone(f.runtime.store.getJob(handle.jobId)!.origin);
      f.codex.finish(handle.workerId); await flush();
      const next = await f.runtime.invoke(groupB, 'bridge_continue_worker', { workerId: handle.workerId, prompt: 'new round' }) as Handle;
      assert.ok(next.jobId); await flush(); assert.equal(f.codex.turns.length, 2);
      assert.equal(f.runtime.store.getJob(next.jobId)!.origin.channelId, 'group-B', 'new round keeps its actual instruction source');
      assert.deepEqual(f.runtime.store.getJob(handle.jobId)!.origin, original, 'historical round remains on its original route');
      const privateView = await f.runtime.invoke(f.turn, 'bridge_list_workers', {}) as { workers: Array<{ workerId: string; source: { kind: string; spaceId: string } }> };
      assert.equal(privateView.workers[0]!.source.kind, 'group'); assert.equal(privateView.workers[0]!.source.spaceId, 'group-A');
      f.codex.finish(handle.workerId); await flush();
      const handed = await f.runtime.invoke(f.turn, 'bridge_handoff_worker', { workerId: handle.workerId }) as { ownership: string };
      assert.equal(handed.ownership, 'user');
      await assert.rejects(f.runtime.invoke(groupB, 'bridge_cancel_worker', { workerId: handle.workerId }), /已交接给用户/);
      await assert.rejects(f.runtime.invoke(groupA, 'bridge_continue_worker', { workerId: handle.workerId, prompt: 'cannot reclaim' }), /已交接给用户/);
      const adopted = await adopt(f);
      const same = await f.runtime.invoke(groupB, 'bridge_adopt_native_session', { ...f.candidate.ref, expectedRevision: 'checked-v1' }) as Handle;
      assert.equal(same.workerId, adopted.workerId, 'changing chat region must not create a duplicate native owner');
    } finally { await f.cleanup(); }
  });
}

test('conversational non-default dispatch independently selects child model and effort for both engines', async () => {
  const f = setup(); const original = structuredClone(f.turn.conversation);
  try {
    const c = await launch(f, { model: 'gpt-6-astra', effort: 'low' });
    const h = await launch(f, { agent: 'claude', model: 'haiku', effort: 'medium' }); await flush();
    assert.equal(f.codex.turns[0]!.conversation.model, 'gpt-6-astra'); assert.equal(f.codex.turns[0]!.effort, 'low');
    assert.equal(f.claude.turns[0]!.conversation.model, 'haiku'); assert.equal(f.claude.turns[0]!.effort, 'medium');
    assert.deepEqual(f.turn.conversation, original); assert.deepEqual(f.runtime.getGlobalWorkCounts(), { running: 2, queued: 0 });
    f.codex.finish(c.workerId); f.claude.finish(h.workerId); await flush();
    assert.deepEqual(f.runtime.getGlobalWorkCounts(), { running: 0, queued: 0 });
  } finally { await f.cleanup(); }
});

test('invalid worker selections reject before enqueuing while explicit defaults remain child-scoped', async () => {
  const f = setup();
  try {
    await assert.rejects(launch(f, { effort: 'invented' }), /不支持/);
    await assert.rejects(launch(f, { model: '--bad model' }), /模型/);
    await assert.rejects(launch(f, { agent: 'claude', effort: 'ultra' }), /不支持/);
    assert.equal(f.runtime.store.jobs().length, 0);
    const h = await launch(f, { model: 'default', effort: 'default' }); await flush();
    assert.equal(f.codex.turns[0]!.conversation.model, 'gpt-6.1-sol'); assert.equal(f.codex.turns[0]!.effort, undefined);
    assert.equal(f.turn.conversation.effort, 'xhigh'); f.codex.finish(h.workerId); await flush();
  } finally { await f.cleanup(); }
});

test('busy worker queues model/effort snapshots and subsequent rounds inherit the queued selection', async () => {
  const f = setup();
  try {
    const h = await launch(f); await flush();
    await assert.rejects(f.runtime.invoke(f.turn, 'bridge_continue_worker', { workerId: h.workerId, prompt: 'change current', effort: 'low' }), /delivery=next/);
    const a = await f.runtime.invoke(f.turn, 'bridge_continue_worker', { workerId: h.workerId, prompt: 'next low', delivery: 'next', model: 'gpt-6-astra', effort: 'low' }) as Handle;
    const b = await f.runtime.invoke(f.turn, 'bridge_continue_worker', { workerId: h.workerId, prompt: 'same selection', delivery: 'next' }) as Handle;
    assert.equal(f.runtime.store.getWorker(h.workerId)!.effort, 'xhigh'); assert.equal(f.codex.turns.length, 1);
    assert.deepEqual(f.runtime.store.getJob(a.jobId!)!.execution, { model: 'gpt-6-astra', effort: 'low' });
    assert.deepEqual(f.runtime.store.getJob(b.jobId!)!.execution, { model: 'gpt-6-astra', effort: 'low' });
    assert.deepEqual(f.counts.at(-1), { running: 1, queued: 2 });
    f.advance(60000); f.codex.finish(h.workerId); await flush();
    assert.equal(f.codex.turns[1]!.effort, 'low'); assert.equal(f.codex.turns[1]!.conversation.nativeId, f.codex.turns[0]!.conversation.nativeId ?? f.runtime.store.getWorker(h.workerId)!.nativeId);
    assert.equal(f.runtime.store.getJob(a.jobId!)!.startedAt, '2026-10-13T10:01:00.000Z');
    f.advance(20000); f.codex.finish(h.workerId); await flush();
    assert.equal(f.runtime.store.getJob(b.jobId!)!.startedAt, '2026-10-13T10:01:20.000Z');
    assert.equal(f.codex.turns[2]!.effort, 'low'); f.codex.finish(h.workerId); await flush();
    assert.equal(f.turn.conversation.model, 'gpt-6.1-sol'); assert.equal(f.turn.conversation.effort, 'xhigh');
  } finally { await f.cleanup(); }
});

test('native list and read do not generate, register jobs, or permanently cache readiness', async () => {
  const f = setup();
  try {
    await f.runtime.invoke(f.turn, 'bridge_list_native_sessions', { agent: 'codex' }, 'same-read');
    f.candidate.health = 'busy';
    const again = await f.runtime.invoke(f.turn, 'bridge_list_native_sessions', { agent: 'codex' }, 'same-read') as { sessions: NativeSessionRead[] };
    assert.equal(again.sessions[0]!.health, 'busy');
    await f.runtime.invoke(f.turn, 'bridge_read_native_session', f.candidate.ref);
    assert.equal(f.runtime.store.jobs().length, 0); assert.equal(f.runtime.store.workers().length, 0);
    assert.equal(f.codex.turns.length, 0);
    await assert.rejects(f.runtime.invoke(f.turn, 'bridge_list_native_sessions', { agent: 'codex', limit: 100 }), /limit/);
  } finally { await f.cleanup(); }
});

test('healthy adoption retains the original native identity, cwd and selections and executes only on continue', async () => {
  const f = setup();
  try {
    const h = await adopt(f); assert.equal(h.status, 'idle'); assert.equal(h.nativeId, f.candidate.nativeId);
    assert.equal(f.runtime.store.jobs().length, 0); assert.equal(f.codex.turns.length, 0);
    assert.deepEqual(f.runtime.getGlobalWorkCounts(), { running: 0, queued: 0 });
    await f.runtime.invoke(f.turn, 'bridge_continue_worker', { workerId: h.workerId, prompt: 'continue earlier human work', effort: 'low' }); await flush();
    assert.equal(f.codex.turns[0]!.conversation.nativeId, f.candidate.nativeId);
    assert.equal(f.codex.turns[0]!.conversation.cwd, f.candidate.cwd); assert.equal(f.codex.turns[0]!.conversation.model, 'gpt-6-astra');
    assert.equal(f.codex.turns[0]!.effort, 'low'); f.codex.finish(h.workerId); await flush();
    assert.equal(f.runtime.store.getWorker(h.workerId)!.nativeId, f.candidate.nativeId);
  } finally { await f.cleanup(); }
});

test('busy, unknown, incompatible, changed and mismatched histories cannot masquerade as adopted sessions', async () => {
  for (const health of ['busy', 'unknown', 'incompatible'] as const) {
    const f = setup();
    try { f.candidate.health = health; await assert.rejects(adopt(f), /不能接管/); assert.equal(f.runtime.store.workers().length, 0); }
    finally { await f.cleanup(); }
  }
  const f = setup();
  try {
    f.candidate.revision = 'changed'; await assert.rejects(adopt(f), /发生变化/);
    f.candidate.revision = 'checked-v1'; f.candidate.nativeId = 'different'; await assert.rejects(adopt(f), /身份/);
    assert.equal(f.codex.turns.length, 0); assert.equal(f.runtime.store.workers().length, 0);
  } finally { await f.cleanup(); }
});

test('lost adoption receipt recovers the same worker and adoption ID even after the native revision changes', async () => {
  const f = setup();
  try {
    f.loseReply(); await assert.rejects(adopt(f, 'adopt-original'), /lost transport/);
    const before = f.runtime.store.workers()[0]!; assert.equal(before.adoption!.status, 'pending');
    const recovered = await adopt(f, 'adopt-new-call');
    assert.equal(recovered.workerId, before.id); assert.equal(f.attempts[0]!.adoptionId, f.attempts[1]!.adoptionId);
    const replay = await adopt(f, 'adopt-original'); assert.equal(replay.workerId, before.id);
    assert.equal(f.runtime.store.workers().length, 1); assert.equal(f.runtime.store.jobs().length, 0);
    assert.equal(f.codex.turns.length, 0);
  } finally { await f.cleanup(); }
});

test('restart reconciles pending adoption without replaying a model turn', async () => {
  const f = setup(); let restarted: ControllerRuntime | undefined;
  try {
    f.loseReply(); await assert.rejects(adopt(f), /lost transport/); const id = f.runtime.store.workers()[0]!.id;
    await f.runtime.close();
    restarted = new ControllerRuntime(f.config, { codex: f.codex, claude: f.claude }, f.registry, f.callbacks);
    await restarted.start(); assert.equal(restarted.store.getWorker(id)!.adoption!.status, 'adopted');
    assert.equal(restarted.store.getWorker(id)!.blocked, false); assert.equal(f.codex.turns.length, 0);
  } finally { await restarted?.close(); f.registry.close(); }
});

test('definitively rejected adoption removes only the unclaimed placeholder and unfreezes the original idle worker', async () => {
  const f = setup();
  try {
    const old = await adopt(f); await f.runtime.invoke(f.turn, 'bridge_handoff_worker', { workerId: old.workerId });
    const success = f.catalog.adoptNativeSession!;
    f.catalog.adoptNativeSession = async () => { throw Object.assign(new Error('revision changed before claim'), { adoptionRejected: true }); };
    await assert.rejects(adopt(f, 'reject-before-claim'), /before claim/);
    assert.equal(f.runtime.store.workers().length, 1);
    assert.equal(f.runtime.store.getWorker(old.workerId)!.handoffPending, false);
    assert.equal(f.runtime.store.getWorker(old.workerId)!.ownership, 'user');
    f.catalog.adoptNativeSession = success;
    const retry = await adopt(f, 'retry-after-refresh'); assert.notEqual(retry.workerId, old.workerId);
    assert.equal(f.codex.turns.length, 0);
  } finally { await f.cleanup(); }
});

test('a cached successful adoption cannot resurrect ownership after the session was handed to a human', async () => {
  const f = setup();
  try {
    const original = await adopt(f, 'claim');
    await f.runtime.invoke(f.turn, 'bridge_handoff_worker', { workerId: original.workerId });
    await assert.rejects(adopt(f, 'claim'), /交接给用户/);
    assert.equal(f.codex.turns.length, 0); assert.equal(f.runtime.store.getWorker(original.workerId)!.ownership, 'user');
  } finally { await f.cleanup(); }
});

test('handoff to a human and reverse adoption retains history and revokes the old worker handle', async () => {
  const f = setup();
  try {
    const old = await adopt(f); await f.runtime.invoke(f.turn, 'bridge_continue_worker', { workerId: old.workerId, prompt: 'bridge work' }); await flush();
    f.codex.finish(old.workerId); await flush();
    await f.runtime.invoke(f.turn, 'bridge_handoff_worker', { workerId: old.workerId });
    const taken = await adopt(f); assert.notEqual(taken.workerId, old.workerId); assert.equal(taken.nativeId, old.nativeId);
    assert.equal(f.runtime.store.getWorker(old.workerId)!.supersededBy, taken.workerId);
    await assert.rejects(f.runtime.invoke(f.turn, 'bridge_continue_worker', { workerId: old.workerId, prompt: 'stale request' }), /已转交/);
    await f.runtime.invoke(f.turn, 'bridge_continue_worker', { workerId: taken.workerId, prompt: 'after human work' }); await flush();
    assert.equal(f.codex.turns[1]!.conversation.nativeId, old.nativeId); f.codex.finish(taken.workerId); await flush();
    assert.equal(f.runtime.store.jobs(old.workerId).length, 1); assert.equal(f.runtime.store.getWorker(taken.workerId)!.blocked, false);
  } finally { await f.cleanup(); }
});

test('adopted continuation rejects a backend that silently returns a new native session', async () => {
  const f = setup();
  try {
    const h = await adopt(f); await f.runtime.invoke(f.turn, 'bridge_continue_worker', { workerId: h.workerId, prompt: 'resume' }); await flush();
    f.codex.finish(h.workerId, randomUUID()); await flush();
    assert.equal(f.runtime.store.jobs(h.workerId)[0]!.status, 'failed');
    assert.match(f.runtime.store.jobs(h.workerId)[0]!.result!, /不同会话/);
    assert.equal(f.runtime.store.getWorker(h.workerId)!.nativeId, h.nativeId);
  } finally { await f.cleanup(); }
});

test('worker overview excludes other users and shows actual running-round start, with no fabricated legacy start', async () => {
  const f = setup();
  try {
    const h = await launch(f); await flush(); const worker = f.runtime.store.getWorker(h.workerId)!;
    f.runtime.store.addWorker({ ...worker, id: 'foreign', origin: { ...worker.origin, userId: 'someone-else' } });
    const sameUser = { ...worker, id: 'other-parent', origin: { ...worker.origin, conversationId: 'older-chat' }, nativeId: 'older-native' };
    f.runtime.store.addWorker(sameUser);
    assert.equal(f.runtime.queryWorkerOverview(f.turn.conversation).length, 1);
    assert.equal(f.runtime.queryWorkerOverview(f.turn.conversation, 'all').length, 2);
    assert.equal(f.runtime.queryWorkerOverview(f.turn.conversation)[0]!.startedAt, '2026-10-13T10:00:00.000Z');
    const job = f.runtime.store.getJob(h.jobId!)!;
    f.runtime.store.addJob({ ...job, id: 'legacy', workerId: 'other-parent', startedAt: undefined });
    f.runtime.store.setJob('legacy', 'running', { startedAt: '2026-10-13T11:00:00Z' });
    assert.equal(f.runtime.store.getJob('legacy')!.startedAt, undefined);
    f.codex.finish(h.workerId); await flush();
  } finally { await f.cleanup(); }
});


test('model/effort incompatibility rejects before start/next persistence and never changes active work', async () => {
  const f = setup();
  try {
    for (const model of ['unsupported', 'unknown']) {
      await assert.rejects(launch(f, { model, effort: 'high' }), /不支持|不能确认/);
      assert.equal(f.runtime.store.workers().length, 0); assert.equal(f.runtime.store.jobs().length, 0);
    }
    const h = await launch(f); await flush();
    const before = structuredClone(f.runtime.store.getWorker(h.workerId)!);
    for (const model of ['unsupported', 'unknown']) {
      await assert.rejects(f.runtime.invoke(f.turn, 'bridge_continue_worker', { workerId: h.workerId, prompt: 'invalid next', delivery: 'next', model }), /不支持|不能确认/);
      assert.deepEqual(f.runtime.store.getWorker(h.workerId), before); assert.equal(f.runtime.store.jobs().length, 1);
    }
    await assert.rejects(f.runtime.invoke(f.turn, 'bridge_continue_worker', { workerId: h.workerId, prompt: 'current change', model: 'gpt-6-astra' }), /delivery=next/);
    const next = await f.runtime.invoke(f.turn, 'bridge_continue_worker', { workerId: h.workerId, prompt: 'default next', delivery: 'next', model: 'default', effort: 'default' }) as Handle;
    assert.deepEqual(f.runtime.store.getJob(next.jobId!)!.execution, { model: 'gpt-6.1-sol', effort: null });
    assert.deepEqual(f.runtime.store.getWorker(h.workerId), { ...before, updatedAt: f.runtime.store.getWorker(h.workerId)!.updatedAt });
    f.codex.finish(h.workerId); await flush(); await flush();
    assert.equal(f.runtime.store.getWorker(h.workerId)!.model, 'gpt-6.1-sol');
    assert.equal(f.runtime.store.getWorker(h.workerId)!.modelPolicy, undefined);
    assert.equal(f.codex.turns[1]!.conversation.nativeId, before.nativeId);
    f.codex.finish(h.workerId); await flush();
  } finally { await f.cleanup(); }
});

test('queued capability changes fail before applying the snapshot or launching another turn', async () => {
  const f = setup();
  try {
    const h = await launch(f); await flush();
    const next = await f.runtime.invoke(f.turn, 'bridge_continue_worker', {
      workerId: h.workerId, prompt: 'next with changed model', delivery: 'next', model: 'gpt-6-astra', effort: 'high',
    }) as Handle;
    const before = structuredClone(f.runtime.store.getWorker(h.workerId)!);
    f.codex.getModelInfo = async () => ({ defaultModel: 'gpt-6.1-sol', models: [
      { id: 'gpt-6-astra', displayName: 'Changed capability', supportedEfforts: [] },
    ] });
    f.codex.finish(h.workerId); await flush(); await flush();
    assert.equal(f.runtime.store.getJob(next.jobId!)!.status, 'failed');
    assert.match(f.runtime.store.getJob(next.jobId!)!.result!, /不支持可调/);
    assert.deepEqual(f.runtime.store.getWorker(h.workerId), before);
    assert.equal(f.codex.turns.length, 1);
  } finally { await f.cleanup(); }
});

test('capability lookup racing worker handoff does not enqueue or overwrite ownership', async () => {
  const f = setup();
  try {
    const h = await launch(f); await flush();
    let release!: () => void; const query = new Promise<void>(resolve => { release = resolve; });
    const metadata = f.codex.getModelInfo.bind(f.codex);
    f.codex.getModelInfo = async () => { await query; return metadata(); };
    const next = f.runtime.invoke(f.turn, 'bridge_continue_worker', { workerId: h.workerId, prompt: 'next', delivery: 'next' });
    await flush(); const worker = f.runtime.store.getWorker(h.workerId)!; worker.ownership = 'user'; f.runtime.store.saveWorker(worker);
    release(); await assert.rejects(next, /交接给用户/); assert.equal(f.runtime.store.jobs().length, 1);
    assert.equal(f.runtime.store.getWorker(h.workerId)!.ownership, 'user');
    f.codex.finish(h.workerId); await flush();
  } finally { await f.cleanup(); }
});

test('异步补充失败持久待交付，重启只补交错误记录，不重发输入或重跑助手', async t => {
  const f = setup(); t.after(() => f.cleanup());
  Object.assign(f.codex, { steer: async () => ({ status: 'uncertain', reason: 'native input receipt missing' }) });
  const received: string[] = []; let accept = false;
  Object.assign(f.callbacks, { onSupplementFailure: (value: { id: string }) => { received.push(value.id); return accept; } });
  const handle = await launch(f); await flush();
  const receipt = await f.runtime.invoke(f.turn, 'bridge_continue_worker', { workerId: handle.workerId, prompt: '补充约束' }, 'failed-supplement') as { supplementId: string };
  await flush(); assert.deepEqual(received, [receipt.supplementId]);
  assert.equal(f.runtime.store.supplements()[0]!.status, 'uncertain');
  assert.equal(f.runtime.store.supplements()[0]!.feedbackPending, true);
  assert.equal(f.codex.turns.length, 1);
  await f.runtime.close(); accept = true;
  f.runtime = new ControllerRuntime(f.config, { codex: f.codex, claude: f.claude }, f.registry, f.callbacks);
  await f.runtime.start(); await flush();
  assert.deepEqual(received, [receipt.supplementId, receipt.supplementId]);
  assert.equal(f.runtime.store.supplements()[0]!.feedbackPending, false);
  assert.equal(f.codex.turns.length, 1);
  await f.runtime.poll(); await flush(); assert.equal(received.length, 2);
});
