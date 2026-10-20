import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { ControllerRuntime } from '../src/controller/runtime.js';
import { TaskRegistry, type TaskContextFile, type TaskOrigin } from '../src/tasks.js';
import type { AgentAdapter, AgentName, AgentResult, AgentTurn, AgentSupplement, BridgeConfig, SteerResult } from '../src/types.js';
import type { ControllerJob, ControllerTargetCatalog, ControllerWorker, ControllerRuntimeCallbacks } from '../src/controller/runtime-types.js';
import { RemoteDispatchUncertain, type ExecutionTargetBinding, type RemoteHandoff } from '../src/remote/types.js';

class ExecutionAdapter implements AgentAdapter {
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

  preparePreset?: (workerId: string, nativeId: string | null) => Promise<void>;
  turns: AgentTurn[] = [];
  interrupts: string[] = [];
  supplements: AgentSupplement[] = [];
  pending = new Map<string, { turn: AgentTurn; resolve: (result: AgentResult) => void; reject: (error: Error) => void }>();
  constructor(readonly prefix: string) {}
  run(turn: AgentTurn): Promise<AgentResult> {
    this.turns.push(turn);
    turn.onNativeId?.(turn.conversation.nativeId ?? `${this.prefix}-${turn.conversation.id}`);
    turn.onReady?.();
    return new Promise((resolve, reject) => this.pending.set(turn.conversation.id, { turn, resolve, reject }));
  }
  finish(id: string, text = '已核实'): void {
    const current = this.pending.get(id)!; assert.ok(current);
    this.pending.delete(id);
    current.resolve({ nativeId: current.turn.conversation.nativeId ?? `${this.prefix}-${id}`, text });
  }
  reject(id: string, error: Error): void { const current = this.pending.get(id)!; this.pending.delete(id); current.reject(error); }
  async steer(_id: string, supplement: AgentSupplement): Promise<SteerResult> { this.supplements.push(supplement); return { status: 'accepted' }; }
  async interrupt(id: string): Promise<void> { this.interrupts.push(id); if (this.pending.has(id)) this.reject(id, new Error('CLI 已退出')); }
  confirmations: string[] = [];
  confirmedStopped = false;
  async confirmStopped(id: string): Promise<boolean> { this.confirmations.push(id); return this.confirmedStopped; }
  async close(): Promise<void> {}
}
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-controller-target-'));
  const registry = new TaskRegistry(dir), local = new ExecutionAdapter('local'), remote = new ExecutionAdapter('remote');
  const config: BridgeConfig = { token: 'test', allowedUserIds: ['u'], defaultAgent: 'codex', workspace: dir, proxyUrl: null,
    commands: { codex: { command: 'codex', args: [] }, claude: { command: 'claude', args: [] } },
    dataDir: dir, attachmentsDir: dir, logsDir: dir, maxImageBytes: 100 };
  const origin: TaskOrigin = { conversationId: 'parent', userId: 'u', channelId: 'dm', originMessageId: 'real-human',
    nativeId: 'parent-native', agent: 'codex', cwd: dir };
  const context = registry.createContext(origin);
  const turn: AgentTurn = { conversation: { id: origin.conversationId, userId: 'u', agent: 'codex', nativeId: 'parent-native', model: 'user-alias',
    effort: 'medium', title: '', cwd: dir, createdAt: '', updatedAt: '' }, text: '请工作', imagePaths: [], taskContextPath: context.contextPath,
    signal: new AbortController().signal, onProgress: () => {} };
  const binding: ExecutionTargetBinding = { id: 'office', label: '工位', transport: 'ssh', expectedHostname: 'REAL-OFFICE',
    sshConfig: join(dir, 'ssh_config'), alias: 'office-alias', remoteRoot: 'Z:\\remote-daemon', nodePath: 'Z:\\node.exe',
    agent: 'codex', agentCommand: { command: 'remote-codex', args: [] }, cwd: 'Z:\\remote-only-workspace' };
  const resolved: { workspace: string; id: string; agent: AgentName; cwd?: string }[] = [], adapters: ExecutionTargetBinding[] = [];
  const handoffs: RemoteHandoff[] = [];
  let resolving: Promise<void> | undefined;
  let badProof = false;
  const catalog: ControllerTargetCatalog = {
    async listTargets() { return [{ id: 'office', label: '工位', transport: 'ssh', engines: ['codex', 'claude'], expectedHostname: 'REAL-OFFICE', availability: 'registered' }]; },
    async resolveTarget(workspace, id, agent, cwd) {
      resolved.push({ workspace, id, agent, cwd }); await resolving;
      if (id === 'local') return { id, label: '本机', transport: 'local', agent, agentCommand: config.commands[agent], cwd: cwd ?? dir };
      if (id !== 'office') throw new Error('未知目标');
      return { ...binding, agent, cwd: cwd ?? binding.cwd };
    },
    adapterFor(target) { adapters.push(target); return target.transport === 'ssh' ? remote : local; },
    async handoff(target, nativeId, cwd, agent) {
      const proof: RemoteHandoff = { targetId: badProof ? 'other-office' : target.id, nativeId, cwd, agent, resumeCommand: `codex resume "${nativeId}"`, stopped: true };
      handoffs.push(proof); return proof;
    },
  };
  const callbacks: ControllerRuntimeCallbacks = { targetCatalog: catalog, pollIntervalMs: 60000 };
  const runtime = new ControllerRuntime(config, { codex: local, claude: local }, registry, callbacks);
  return { dir, registry, local, remote, config, origin, turn, binding, catalog, callbacks, runtime, resolved, adapters, handoffs,
    setResolving: (value: Promise<void>) => { resolving = value; }, setBadProof: () => { badProof = true; } };
}
async function flush() { await new Promise<void>(resolve => setImmediate(resolve)); }
type Handle = { workerId: string; jobId: string; target: ExecutionTargetBinding; ownership: string };
async function launch(f: ReturnType<typeof fixture>, fields: Record<string, unknown> = {}, callId?: string): Promise<Handle> {
  return await f.runtime.invoke(f.turn, 'bridge_start_worker', { title: '工作', prompt: '只做授权的事情', targetId: 'office', ...fields }, callId) as Handle;
}


test('legacy worker handoff rechecks ownership after async target resolution and admits only one user takeover', async () => {
  const f = fixture(); let release!: () => void;
  try {
    const a = await launch(f); await flush(); f.remote.finish(a.workerId); await flush();
    const legacy = f.runtime.store.getWorker(a.workerId)!; delete legacy.target; f.runtime.store.saveWorker(legacy);
    f.setResolving(new Promise(resolve => { release = resolve; }));
    const first = f.runtime.invoke(f.turn, 'bridge_handoff_worker', { workerId: a.workerId }, 'handoff-1');
    const second = f.runtime.invoke(f.turn, 'bridge_handoff_worker', { workerId: a.workerId }, 'handoff-2');
    release(); const outcomes = await Promise.allSettled([first, second]);
    assert.equal(outcomes.filter(x => x.status === 'fulfilled').length, 1); assert.equal(f.handoffs.length, 1);
    assert.equal(f.runtime.store.getWorker(a.workerId)!.ownership, 'user');
  } finally { await f.runtime.close(); f.registry.close(); }
});

test('safe idle includes in-flight target validation and a drain rejects that dispatch without creating a saved worker', async () => {
  const f = fixture(); let release!: () => void; f.setResolving(new Promise(resolve => { release = resolve; }));
  try {
    const pending = launch(f, {}, 'validating');
    assert.equal(f.runtime.isIdle(), false);
    f.runtime.beginDrain(); release(); await assert.rejects(pending, /暂停/);
    assert.equal(f.runtime.store.workers().length, 0); assert.equal(f.runtime.isIdle(), true);
  } finally { await f.runtime.close(); f.registry.close(); }
});

test('confirmed remote stop after an unknown result clears only this restart guard and does not replay the original job', async () => {
  const f = fixture();
  try {
    const a = await launch(f); await flush();
    await f.runtime.invoke(f.turn, 'bridge_continue_worker', { workerId: a.workerId, prompt: '不得执行的下一轮', delivery: 'next' });
    f.remote.reject(a.workerId, new RemoteDispatchUncertain()); await flush(); assert.equal(f.runtime.isIdle(), false);
    const stopped = await f.runtime.invoke(f.turn, 'bridge_cancel_worker', { workerId: a.workerId }) as { stopped: boolean };
    assert.equal(stopped.stopped, true); assert.deepEqual(f.remote.interrupts, [a.workerId]); assert.equal(f.runtime.isIdle(), true);
    assert.equal(f.runtime.store.getJob(a.jobId)!.status, 'uncertain');
    assert.equal(f.runtime.store.getWorker(a.workerId)!.blocked, true);
    assert.equal(f.runtime.store.jobs(a.workerId).at(-1)!.status, 'cancelled'); assert.equal(f.remote.turns.length, 1);
    await assert.rejects(f.runtime.invoke(f.turn, 'bridge_continue_worker', { workerId: a.workerId, prompt: '不能重放' }), /结果未知/);
  } finally { await f.runtime.close(); f.registry.close(); }
});

test('unconfirmed explicit remote stop retains the safety guard even after run has already returned', async () => {
  const f = fixture();
  try {
    const a = await launch(f); await flush(); f.remote.reject(a.workerId, new RemoteDispatchUncertain()); await flush();
    f.remote.interrupt = async id => { f.remote.interrupts.push(id); throw new RemoteDispatchUncertain(); };
    const stopped = await f.runtime.invoke(f.turn, 'bridge_cancel_worker', { workerId: a.workerId }) as { stopped: boolean; status: string };
    assert.equal(stopped.stopped, false); assert.equal(stopped.status, 'uncertain'); assert.equal(f.runtime.isIdle(), false);
    assert.deepEqual(f.remote.interrupts, [a.workerId]); assert.equal(f.remote.turns.length, 1);
    await assert.rejects(f.runtime.cancelConversation('parent'), /停止尚未确认/);
  } finally { await f.runtime.close(); f.registry.close(); }
});

test('target queries refresh registration by default while allowing an explicit cached lookup', async () => {
  const f = fixture(); const refreshes: boolean[] = [];
  f.catalog.listTargets = async (workspace, refresh) => {
    assert.equal(workspace, f.dir); refreshes.push(refresh ?? false);
    return [{ id: refresh ? 'new-office' : 'cached-office', label: '工位', transport: 'ssh', engines: ['codex'], availability: 'registered' }];
  };
  try {
    const first = await f.runtime.invoke(f.turn, 'bridge_list_targets', {}) as { targets: { id: string }[] };
    const second = await f.runtime.invoke(f.turn, 'bridge_list_targets', { refresh: false }) as { targets: { id: string }[] };
    assert.equal(first.targets[0]!.id, 'new-office'); assert.equal(second.targets[0]!.id, 'cached-office');
    assert.deepEqual(refreshes, [true, false]); assert.equal(f.local.turns.length + f.remote.turns.length, 0);
  } finally { await f.runtime.close(); f.registry.close(); }
});

test('draining keeps querying original unknown remote dispatches and clears only a physically stopped guard after reconnection', async () => {
  const f = fixture();
  try {
    const a = await launch(f); await flush();
    await f.runtime.invoke(f.turn, 'bridge_continue_worker', { workerId: a.workerId, prompt: '保留下一轮', delivery: 'next' });
    await f.runtime.invoke(f.turn, 'bridge_schedule_controller', { afterSeconds: 1, text: '保留预约' });
    f.remote.reject(a.workerId, new RemoteDispatchUncertain()); await flush(); f.runtime.beginDrain();
    f.callbacks.now = () => Date.now() + 10000;
    await f.runtime.poll(); assert.equal(f.runtime.isIdle(), false);
    f.remote.confirmedStopped = true;
    await f.runtime.poll(); assert.equal(f.runtime.isIdle(), true);
    assert.deepEqual(f.remote.confirmations, [a.workerId, a.workerId]); assert.equal(f.remote.interrupts.length, 0);
    assert.equal(f.remote.turns.length, 1); assert.equal(f.runtime.store.getWorker(a.workerId)!.blocked, true);
    assert.equal(f.runtime.store.getJob(a.jobId)!.status, 'uncertain');
    assert.equal(f.runtime.store.jobs(a.workerId).at(-1)!.status, 'queued');
    assert.equal(f.runtime.store.schedules()[0]!.status, 'pending');
  } finally { await f.runtime.close(); f.registry.close(); }
});

test('stop confirmation cadence is bounded and rotates unresolved targets without concurrent checks or cancellation', async () => {
  const f = fixture();
  try {
    const workers: Handle[] = [];
    for (let i = 0; i < 5; i++) { const a = await launch(f); workers.push(a); await flush(); f.remote.reject(a.workerId, new RemoteDispatchUncertain()); await flush(); }
    f.runtime.beginDrain(); let inflight = 0, maximum = 0;
    f.remote.confirmStopped = async id => {
      f.remote.confirmations.push(id); maximum = Math.max(maximum, ++inflight); await flush(); inflight--; return false;
    };
    await f.runtime.poll(); assert.equal(f.remote.confirmations.length, 4);
    assert.deepEqual(f.remote.confirmations, workers.slice(0, 4).map(worker => worker.workerId));
    await f.runtime.poll(); assert.equal(f.remote.confirmations.length, 8);
    assert.equal(f.remote.confirmations[4], workers[4]!.workerId); assert.equal(maximum, 1);
    assert.equal(f.remote.turns.length, 5); assert.equal(f.remote.interrupts.length, 0); assert.equal(f.runtime.isIdle(), false);
  } finally { await f.runtime.close(); f.registry.close(); }
});

test('each new parent refreshes its local target registry once and never injects inventory into the initialization prompt or receipt', async () => {
  const f = fixture(); let reads = 0; let next: ControllerRuntime | undefined;
  f.catalog.listTargets = async (workspace, refresh) => {
    assert.equal(workspace, f.dir); assert.equal(refresh, true); reads++;
    return [{ id: 'SECRET-INVENTORY-CANARY', label: 'inventory-sentinel-not-context', transport: 'ssh', engines: ['codex'], availability: 'registered' }];
  };
  try {
    const [first, duplicate] = await Promise.all([f.runtime.initializeWorkspace(f.turn), f.runtime.initializeWorkspace(f.turn)]) as Handle[];
    assert.deepEqual(first, duplicate); await flush(); assert.equal(reads, 1);
    assert.equal(f.local.turns.length, 1); assert.equal(f.remote.turns.length, 0);
    assert.equal(f.resolved[0]!.id, 'local');
    assert.doesNotMatch(f.local.turns[0]!.text, /SECRET-INVENTORY-CANARY|inventory-sentinel-not-context/);
    assert.doesNotMatch(JSON.stringify(first), /SECRET-INVENTORY-CANARY|inventory-sentinel-not-context/);
    f.local.finish(first!.workerId); await flush();
    await f.runtime.initializeWorkspace(f.turn); assert.equal(reads, 1);
    await f.runtime.close();
    next = new ControllerRuntime(f.config, { codex: f.local, claude: f.local }, f.registry, f.callbacks);
    await next.start(); await next.initializeWorkspace(f.turn); assert.equal(reads, 1);
    const newOrigin = { ...f.origin, conversationId: 'genuine-new-parent' };
    const context = f.registry.createContext(newOrigin);
    const newTurn = { ...f.turn, conversation: { ...f.turn.conversation, id: newOrigin.conversationId }, taskContextPath: context.contextPath };
    const second = await next.initializeWorkspace(newTurn) as Handle; await flush();
    assert.equal(reads, 2); assert.equal(f.local.turns.length, 2); assert.equal(f.remote.turns.length, 0);
    f.local.finish(second.workerId); await flush();
  } finally { await next?.close(); await f.runtime.close(); f.registry.close(); }
});

test('registry refresh failures are reported locally without polluting context or falling back a requested remote task to local execution', async () => {
  const f = fixture(); const errors: unknown[] = []; f.callbacks.onError = error => errors.push(error);
  f.catalog.listTargets = async () => { throw new Error('invalid registry canary'); };
  const resolveTarget = f.catalog.resolveTarget.bind(f.catalog);
  f.catalog.resolveTarget = async (workspace, id, agent, cwd) => {
    if (id !== 'local') throw new Error('invalid remote registration');
    return resolveTarget(workspace, id, agent, cwd);
  };
  try {
    const handle = await f.runtime.initializeWorkspace(f.turn) as Handle; await flush();
    assert.equal(errors.length, 1); assert.match(String(errors[0]), /登记刷新失败.*invalid registry canary/);
    assert.doesNotMatch(f.local.turns[0]!.text, /invalid registry canary|登记刷新失败/);
    assert.equal(f.local.turns.length, 1); assert.equal(f.remote.turns.length, 0);
    await assert.rejects(launch(f), /invalid remote registration/);
    assert.equal(f.local.turns.length, 1); assert.equal(f.remote.turns.length, 0); assert.equal(f.runtime.store.workers().length, 1);
    f.local.finish(handle.workerId); await flush();
  } finally { await f.runtime.close(); f.registry.close(); }
});

test('historic uncertainty blocks only its worker and does not permanently veto a fresh process restart window', async () => {
  const f = fixture(); let next: ControllerRuntime | undefined;
  try {
    const a = await launch(f); await flush(); f.remote.reject(a.workerId, new RemoteDispatchUncertain()); await flush();
    assert.equal(f.runtime.isIdle(), false);
    await f.runtime.close();
    next = new ControllerRuntime(f.config, { codex: f.local, claude: f.local }, f.registry, f.callbacks);
    await next.start(); assert.equal(next.isIdle(), true);
    assert.equal(next.store.getWorker(a.workerId)!.blocked, true); assert.equal(f.remote.turns.length, 1);
  } finally { await next?.close(); await f.runtime.close(); f.registry.close(); }
});

test('registry target dispatch executes on selected machine and preserves binding/model/effort and stable dispatch ID', async () => {
  const f = fixture();
  try {
    const list = await f.runtime.invoke(f.turn, 'bridge_list_targets', {}) as { targets: { id: string }[] };
    assert.equal(list.targets[0]!.id, 'office'); assert.equal(f.local.turns.length + f.remote.turns.length, 0);
    const handle = await launch(f, { cwd: 'Z:\\remote-only-other', model: 'haiku' }); await flush();
    assert.equal(f.local.turns.length, 0); assert.equal(f.remote.turns.length, 1);
    const child = f.remote.turns[0]!, saved = f.runtime.store.getWorker(handle.workerId)!;
    assert.equal(child.dispatchId, handle.jobId); assert.equal(child.recovering, false);
    assert.equal(child.conversation.cwd, 'Z:\\remote-only-other'); assert.equal(child.conversation.model, 'haiku'); assert.equal(child.effort, 'medium');
    assert.equal(saved.target!.expectedHostname, 'REAL-OFFICE'); assert.equal(saved.ownership, 'bridge');
    assert.equal(f.resolved[0]!.workspace, f.dir); assert.equal(handle.target.alias, 'office-alias');
    f.remote.finish(handle.workerId); await flush();
    const workers = await f.runtime.invoke(f.turn, 'bridge_list_workers', {}) as { workers: { target: ExecutionTargetBinding; nativeId: string }[] };
    assert.equal(workers.workers[0]!.target.id, 'office'); assert.equal(workers.workers[0]!.nativeId, `remote-${handle.workerId}`);
  } finally { await f.runtime.close(); f.registry.close(); }
});

test('asynchronous target resolution coalesces stable call IDs and workspace initialization rather than duplicate dispatching', async () => {
  const f = fixture(); let release!: () => void; f.setResolving(new Promise(resolve => { release = resolve; }));
  try {
    const first = launch(f, {}, 'start-same'), duplicate = launch(f, {}, 'start-same');
    await assert.rejects(launch(f, { prompt: 'different' }, 'start-same'), /参数发生变化/);
    release(); const [a, b] = await Promise.all([first, duplicate]); assert.deepEqual(a, b); await flush();
    assert.equal(f.runtime.store.workers().length, 1); assert.equal(f.remote.turns.length, 1);
    f.remote.finish(a.workerId); await flush();
    const [c, d] = await Promise.all([f.runtime.initializeWorkspace(f.turn), f.runtime.initializeWorkspace(f.turn)]) as Handle[];
    assert.deepEqual(c, d); await flush(); assert.equal(f.local.turns.length, 1);
    f.local.finish(c!.workerId); await flush();
  } finally { await f.runtime.close(); f.registry.close(); }
});

test('remote current supplements, next-turn continuation and cancellation use the persisted target adapter', async () => {
  const f = fixture();
  try {
    const a = await launch(f); await flush();
    await f.runtime.invoke(f.turn, 'bridge_continue_worker', { workerId: a.workerId, prompt: '当前补充' }); await flush();
    assert.equal(f.remote.supplements.length, 1); assert.equal(f.local.supplements.length, 0);
    await f.runtime.invoke(f.turn, 'bridge_continue_worker', { workerId: a.workerId, prompt: '下一轮', delivery: 'next' });
    f.binding.alias = 'changed-registration';
    f.remote.finish(a.workerId); await flush();
    assert.equal(f.remote.turns.length, 2); assert.equal(f.remote.turns[1]!.conversation.nativeId, `remote-${a.workerId}`);
    assert.equal(f.adapters.at(-1)!.alias, 'office-alias');
    const cancelled = await f.runtime.invoke(f.turn, 'bridge_cancel_worker', { workerId: a.workerId }) as { stopped: boolean; scope: string; target: ExecutionTargetBinding };
    assert.equal(cancelled.stopped, true); assert.equal(cancelled.scope, 'remote-agent-process'); assert.equal(cancelled.target.id, 'office');
    assert.deepEqual(f.remote.interrupts, [a.workerId]); assert.equal(f.local.interrupts.length, 0); assert.equal(f.registry.activeCount('parent'), 0);
  } finally { await f.runtime.close(); f.registry.close(); }
});

test('restart reconnects the original remote dispatch only, retains native ID/task row/count and never submits another job', async () => {
  const f = fixture();
  try {
    const time = new Date().toISOString(), workerId = randomUUID(), jobId = randomUUID();
    const worker: ControllerWorker = { id: workerId, origin: f.origin, agent: 'codex', model: 'user-alias', actualModel: null, effort: 'medium',
      cwd: f.binding.cwd, title: '原远端任务', nativeId: 'remote-existing-native', imagePaths: [], target: { ...f.binding }, ownership: 'bridge', wakeAllowed: true, createdAt: time, updatedAt: time };
    const ctx = JSON.parse(readFileSync(f.turn.taskContextPath!, 'utf8')) as TaskContextFile;
    const taskId = f.registry.register(ctx, worker.title, jobId).taskId;
    const job: ControllerJob = { id: jobId, workerId, origin: f.origin, prompt: '已经提交过的操作', imagePaths: [], status: 'running', taskId,
      result: null, cancelReason: null, wakeAllowed: true, createdAt: time, updatedAt: time };
    f.runtime.store.addWorker(worker); f.runtime.store.addJob(job);
    await f.runtime.start(); await flush();
    assert.equal(f.remote.turns.length, 1); const child = f.remote.turns[0]!;
    assert.equal(child.dispatchId, jobId); assert.equal(child.recovering, true); assert.equal(child.conversation.nativeId, 'remote-existing-native');
    assert.equal(f.runtime.store.jobs().length, 1); assert.equal(f.runtime.store.getJob(jobId)!.taskId, taskId); assert.equal(f.registry.activeCount('parent'), 1);
    f.remote.finish(workerId, '原远端结果'); await flush();
    assert.equal(f.runtime.store.getJob(jobId)!.status, 'completed'); assert.equal(f.registry.activeCount('parent'), 0);
    await f.runtime.start(); assert.equal(f.remote.turns.length, 1);
  } finally { await f.runtime.close(); f.registry.close(); }
});

test('unconfirmed remote completion blocks follow-up and queued work rather than claiming success or replaying side effects', async () => {
  const f = fixture();
  try {
    const a = await launch(f); await flush();
    await f.runtime.invoke(f.turn, 'bridge_continue_worker', { workerId: a.workerId, prompt: '下一轮', delivery: 'next' });
    f.remote.reject(a.workerId, new RemoteDispatchUncertain()); await flush();
    assert.equal(f.runtime.store.getJob(a.jobId)!.status, 'uncertain'); assert.equal(f.runtime.store.getWorker(a.workerId)!.blocked, true);
    assert.equal(f.runtime.isIdle(), false, '本次进程的未确认停止不能进入安全重启窗口');
    assert.equal(f.remote.turns.length, 1); await assert.rejects(f.runtime.invoke(f.turn, 'bridge_continue_worker', { workerId: a.workerId, prompt: '续接' }), /结果未知/);
  } finally { await f.runtime.close(); f.registry.close(); }
});

test('only an idle real native session may hand off; durable user ownership rejects bridge continuation/cancellation after restart', async () => {
  const f = fixture();
  let next: ControllerRuntime | undefined;
  try {
    const a = await launch(f, { sessionVisibility: 'visible' }); await flush();
    await assert.rejects(f.runtime.invoke(f.turn, 'bridge_handoff_worker', { workerId: a.workerId }), /空闲/);
    assert.equal(f.handoffs.length, 0);
    f.remote.finish(a.workerId); await flush();
    const result = await f.runtime.invoke(f.turn, 'bridge_handoff_worker', { workerId: a.workerId }, 'handoff-once') as { ownership: string; nativeId: string; resumeCommand: string; target: ExecutionTargetBinding };
    assert.equal(result.ownership, 'user'); assert.equal(result.nativeId, `remote-${a.workerId}`); assert.equal(result.target.expectedHostname, 'REAL-OFFICE');
    assert.match(result.resumeCommand, /codex resume/);
    assert.deepEqual(await f.runtime.invoke(f.turn, 'bridge_handoff_worker', { workerId: a.workerId }, 'handoff-once'), result);
    assert.equal(f.handoffs.length, 1);
    await assert.rejects(f.runtime.invoke(f.turn, 'bridge_continue_worker', { workerId: a.workerId, prompt: '不许偷偷继续' }), /已交接/);
    await assert.rejects(f.runtime.invoke(f.turn, 'bridge_cancel_worker', { workerId: a.workerId }), /已交接/);
    await f.runtime.close();
    next = new ControllerRuntime(f.config, { codex: f.local, claude: f.local }, f.registry, f.callbacks);
    await next.start(); await assert.rejects(next.invoke(f.turn, 'bridge_continue_worker', { workerId: a.workerId, prompt: '重启后也不续接' }), /已交接/);
    await next.cancelConversation('parent'); assert.equal(f.remote.interrupts.length, 0);
  } finally { await next?.close(); await f.runtime.close(); f.registry.close(); }
});

test('a mismatched handoff proof stays uncertain and blocked rather than inventing a successful local takeover', async () => {
  const f = fixture(); f.setBadProof();
  try {
    const a = await launch(f, { sessionVisibility: 'visible' }); await flush(); f.remote.finish(a.workerId); await flush();
    await assert.rejects(f.runtime.invoke(f.turn, 'bridge_handoff_worker', { workerId: a.workerId }, 'handoff'), /证明/);
    const worker = f.runtime.store.getWorker(a.workerId)!;
    assert.equal(worker.ownership, 'bridge'); assert.equal(worker.handoffPending, true); assert.equal(worker.blocked, true);
    await assert.rejects(f.runtime.invoke(f.turn, 'bridge_continue_worker', { workerId: a.workerId, prompt: '继续' }), /交接状态/);
    const repeat = await f.runtime.invoke(f.turn, 'bridge_handoff_worker', { workerId: a.workerId }, 'handoff') as { status: string };
    assert.equal(repeat.status, 'uncertain'); assert.equal(f.handoffs.length, 1);
  } finally { await f.runtime.close(); f.registry.close(); }
});

test('safe restart registers immediately on genuine origin, drains running work but freezes saved queues and future wakes', async () => {
  const f = fixture(); let requests = 0; let received: TaskOrigin | undefined;
  f.callbacks.onRequestRestart = async origin => { requests++; received = origin; f.runtime.beginDrain(); return { accepted: true, status: 'draining', requestId: 'request-1' }; };
  let next: ControllerRuntime | undefined;
  try {
    const a = await launch(f); await flush();
    await f.runtime.invoke(f.turn, 'bridge_continue_worker', { workerId: a.workerId, prompt: '保留队列', delivery: 'next' });
    await f.runtime.invoke(f.turn, 'bridge_schedule_controller', { afterSeconds: 30, text: '未来预约' });
    const [first, duplicate] = await Promise.all([f.runtime.invoke(f.turn, 'bridge_request_restart', {}, 'restart'), f.runtime.invoke(f.turn, 'bridge_request_restart', {}, 'restart')]);
    assert.deepEqual(first, { accepted: true, status: 'draining', requestId: 'request-1' }); assert.deepEqual(first, duplicate); assert.equal(requests, 1);
    assert.equal(received!.originMessageId, 'real-human'); assert.equal(f.runtime.isIdle(), false);
    await assert.rejects(launch(f), /暂停/);
    f.remote.finish(a.workerId); await flush(); assert.equal(f.runtime.isIdle(), true); assert.equal(f.remote.turns.length, 1);
    assert.equal(f.runtime.store.jobs(a.workerId).at(-1)!.status, 'queued'); assert.equal(f.runtime.store.schedules()[0]!.status, 'pending');
    await f.runtime.close();
    next = new ControllerRuntime(f.config, { codex: f.local, claude: f.local }, f.registry, f.callbacks);
    await next.start(); await flush(); assert.equal(f.remote.turns.length, 2); f.remote.finish(a.workerId); await flush();
    assert.equal(next.store.schedules()[0]!.status, 'pending');
  } finally { await next?.close(); await f.runtime.close(); f.registry.close(); }
});


function installPreset(f: ReturnType<typeof fixture>) {
  const preset = { id: 'office-sol', aliases: ['工位 sol'], targetId: 'office', agent: 'codex' as const, model: 'gpt-6.1-sol', profileId: 'gateway-sol', revision: 1, enabled: true };
  let queries = 0, resolutions = 0;
  f.remote.preparePreset = async () => {};
  f.catalog.listPresets = async (_workspace, filter) => { queries++; return !filter?.query || preset.aliases.some(alias => alias.includes(filter.query!)) ? [preset] : []; };
  f.catalog.resolvePreset = async (_workspace, id) => {
    resolutions++; if (id !== preset.id || !preset.enabled) throw new Error('预设不可用');
    return { ...f.binding, preset: { id: preset.id, profileId: preset.profileId, targetId: preset.targetId, agent: preset.agent, model: preset.model, revision: preset.revision, fingerprint: 'a'.repeat(64) } };
  };
  return { preset, queries: () => queries, resolutions: () => resolutions };
}
test('presets are discovered only on request, fix the selected route/model, and reject conflicting fields before dispatch', async () => {
  const f = fixture(), p = installPreset(f);
  try {
    assert.equal(p.queries(), 0);
    const view = await f.runtime.invoke(f.turn, 'bridge_list_targets', { query: '工位 sol' }) as { presets: unknown[] };
    assert.equal(view.presets.length, 1); assert.equal(p.queries(), 1);
    for (const conflict of [{ targetId: 'local' }, { agent: 'claude' }, { model: 'default' }]) {
      await assert.rejects(launch(f, { presetId: p.preset.id, ...conflict }), /冲突/);
    }
    assert.equal(f.runtime.store.workers().length, 0);
    const a = await launch(f, { presetId: p.preset.id }); await flush();
    const worker = f.runtime.store.getWorker(a.workerId)!;
    assert.equal(worker.model, 'gpt-6.1-sol'); assert.equal(worker.effort, null, '不继承主控强度');
    assert.equal(worker.target!.preset!.id, p.preset.id); assert.equal(p.queries(), 1);
    f.remote.finish(a.workerId); await flush();
    await assert.rejects(f.runtime.invoke(f.turn, 'bridge_handoff_worker', { workerId: a.workerId }), /隐藏/);
    assert.equal(f.runtime.store.getWorker(a.workerId)!.blocked, false); assert.equal(f.handoffs.length, 0);
    await assert.rejects(f.runtime.invoke(f.turn, 'bridge_continue_worker', { workerId: a.workerId, prompt: '继续', model: 'default' }), /预设/);
    p.preset.enabled = false;
    await f.runtime.invoke(f.turn, 'bridge_continue_worker', { workerId: a.workerId, prompt: '仍用旧线路' }); await flush();
    assert.equal(f.adapters.at(-1)!.preset!.fingerprint, 'a'.repeat(64)); f.remote.finish(a.workerId); await flush();
  } finally { await f.runtime.close(); f.registry.close(); }
});
test('scheduled preset snapshot survives restart and registration edits without resolving again', async () => {
  const f = fixture(), p = installPreset(f); let now = Date.now(), next: ControllerRuntime | undefined;
  f.callbacks.now = () => now;
  try {
    await f.runtime.invoke(f.turn, 'bridge_schedule_worker', { title: '稍后核对', prompt: '授权任务', presetId: p.preset.id, afterSeconds: 30 });
    const schedule = f.runtime.store.schedules()[0]!; assert.equal(schedule.worker!.target!.preset!.revision, 1);
    p.preset.revision = 2; p.preset.enabled = false; await f.runtime.close();
    next = new ControllerRuntime(f.config, { codex: f.local, claude: f.local }, f.registry, f.callbacks);
    now += 31_000; await next.start(); await next.poll(); await flush();
    assert.equal(p.resolutions(), 1); assert.equal(f.remote.turns.length, 1); assert.equal(f.adapters.at(-1)!.preset!.revision, 1);
    f.remote.finish(schedule.worker!.id); await flush();
    await next.poll(); assert.equal(f.remote.turns.length, 1);
  } finally { await next?.close(); await f.runtime.close(); f.registry.close(); }
});
test('lost preset result blocks queued work but a confirmed stopped process allows a safe restart', async () => {
  const f = fixture(), p = installPreset(f);
  try {
    const a = await launch(f, { presetId: p.preset.id }); await flush();
    await f.runtime.invoke(f.turn, 'bridge_continue_worker', { workerId: a.workerId, prompt: '不能重放', delivery: 'next' });
    f.remote.reject(a.workerId, Object.assign(new Error('结果未知'), { resultUncertain: true })); await flush();
    assert.equal(f.runtime.store.getJob(a.jobId)!.status, 'uncertain'); assert.equal(f.runtime.store.getWorker(a.workerId)!.blocked, true);
    assert.equal(f.runtime.isIdle(), true); assert.equal(f.remote.turns.length, 1);
    await assert.rejects(f.runtime.invoke(f.turn, 'bridge_continue_worker', { workerId: a.workerId, prompt: '不能自动重做' }), /结果未知/);
  } finally { await f.runtime.close(); f.registry.close(); }
});

test('a restored preset never falls back to the ordinary local adapter if its catalog is unavailable', async () => {
  const f = fixture(), p = installPreset(f);
  try {
    const a = await launch(f, { presetId: p.preset.id }); await flush(); f.remote.finish(a.workerId); await flush();
    f.callbacks.targetCatalog = undefined;
    await assert.rejects(f.runtime.invoke(f.turn, 'bridge_continue_worker', { workerId: a.workerId, prompt: '续接' }), /预设执行目标服务未配置/);
    assert.equal(f.local.turns.length, 0); assert.equal(f.remote.turns.length, 1);
  } finally { await f.runtime.close(); f.registry.close(); }
});


test('new workers default hidden; visible selection survives continuation, invalid changes and scheduled restart', async () => {
  const f = fixture(); let next: ControllerRuntime | undefined; let now = Date.now(); f.callbacks.now = () => now;
  try {
    await assert.rejects(launch(f, { sessionVisibility: true }), /sessionVisibility/);
    assert.equal(f.runtime.store.workers().length, 0);
    const hidden = await launch(f); await flush();
    assert.equal(f.runtime.store.getWorker(hidden.workerId)!.target!.sessionVisibility, 'hidden');
    f.remote.finish(hidden.workerId); await flush();
    await assert.rejects(f.runtime.invoke(f.turn, 'bridge_handoff_worker', { workerId: hidden.workerId }), /隐藏/);
    assert.equal(f.runtime.store.getWorker(hidden.workerId)!.blocked, false);
    const visible = await launch(f, { sessionVisibility: 'visible' }); await flush(); f.remote.finish(visible.workerId); await flush();
    await assert.rejects(f.runtime.invoke(f.turn, 'bridge_continue_worker', { workerId: visible.workerId, prompt: 'switch', sessionVisibility: 'hidden' }), /未知字段/);
    await f.runtime.invoke(f.turn, 'bridge_continue_worker', { workerId: visible.workerId, prompt: 'continue' }); await flush();
    assert.equal(f.adapters.at(-1)!.sessionVisibility, 'visible'); f.remote.finish(visible.workerId); await flush();
    await f.runtime.invoke(f.turn, 'bridge_schedule_worker', { title: 'later', prompt: 'same setting', targetId: 'office', afterSeconds: 30, sessionVisibility: 'visible' });
    const plan = f.runtime.store.schedules()[0]!; assert.equal(plan.worker!.target!.sessionVisibility, 'visible');
    await f.runtime.close(); next = new ControllerRuntime(f.config, { codex: f.local, claude: f.local }, f.registry, f.callbacks);
    now += 31_000; await next.start(); await next.poll(); await flush();
    assert.equal(f.adapters.at(-1)!.sessionVisibility, 'visible'); f.remote.finish(plan.worker!.id); await flush();
  } finally { await next?.close(); await f.runtime.close(); f.registry.close(); }
});

test('a visible preset supports an idle user handoff without changing its preset binding', async () => {
  const f = fixture(), p = installPreset(f);
  try {
    const a = await launch(f, { presetId: p.preset.id, sessionVisibility: 'visible' }); await flush(); f.remote.finish(a.workerId); await flush();
    const result = await f.runtime.invoke(f.turn, 'bridge_handoff_worker', { workerId: a.workerId }) as { ownership: string };
    assert.equal(result.ownership, 'user'); assert.equal(f.runtime.store.getWorker(a.workerId)!.target!.preset!.id, p.preset.id);
    await assert.rejects(f.runtime.invoke(f.turn, 'bridge_continue_worker', { workerId: a.workerId, prompt: 'cannot race user' }), /已交接/);
  } finally { await f.runtime.close(); f.registry.close(); }
});
