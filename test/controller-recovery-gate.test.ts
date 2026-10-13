import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import { ControllerRuntime } from '../src/controller/runtime.js';
import type { ControllerTargetCatalog, ControllerWorker } from '../src/controller/runtime-types.js';
import { NativeAdoptionRejectedError, type NativeSessionAdoptArgs, type NativeSessionAdoption } from '../src/native-sessions.js';
import { TaskRegistry, type TaskOrigin } from '../src/tasks.js';
import type { AgentAdapter, AgentResult, AgentTurn, BridgeConfig } from '../src/types.js';
import type { ExecutionTargetBinding } from '../src/remote/types.js';

class Adapter implements AgentAdapter {
  readonly turns: AgentTurn[] = [];
  private readonly pending = new Map<string, { resolve: (result: AgentResult) => void; nativeId: string }>();
  run(turn: AgentTurn): Promise<AgentResult> {
    this.turns.push(turn);
    const nativeId = turn.conversation.nativeId ?? `native-${turn.conversation.id}`;
    turn.onNativeId?.(nativeId);
    return new Promise(resolve => { this.pending.set(turn.conversation.id, { resolve, nativeId }); });
  }
  async interrupt(id: string): Promise<void> {
    const entry = this.pending.get(id);
    if (entry) { this.pending.delete(id); entry.resolve({ nativeId: entry.nativeId, text: '隔离测试停止' }); }
  }
  async close(): Promise<void> { for (const id of this.pending.keys()) await this.interrupt(id); }
}

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!predicate()) { assert(Date.now() < deadline, '隔离恢复流程未达到预期状态'); await delay(5); }
}

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'bridge-recovery-gate-'));
  const registry = new TaskRegistry(root), adapter = new Adapter(), errors: unknown[] = [];
  const config: BridgeConfig = { token: '', allowedUserIds: ['user-A'], defaultAgent: 'codex', workspace: root, proxyUrl: null,
    commands: { codex: { command: 'fake', args: [] }, claude: { command: 'fake', args: [] } },
    dataDir: root, attachmentsDir: root, logsDir: root, maxImageBytes: 100 };
  const origin: TaskOrigin = { conversationId: 'parent-A', userId: 'user-A', channelId: 'dm-A', originMessageId: 'message-A', nativeId: 'native-parent', agent: 'codex', cwd: root };
  const context = registry.createContext(origin);
  const binding: ExecutionTargetBinding = { id: 'local', label: '本机', transport: 'local', agent: 'codex', agentCommand: config.commands.codex, cwd: root };
  const turn: AgentTurn = { conversation: { id: origin.conversationId, userId: origin.userId, agent: 'codex', nativeId: origin.nativeId, model: 'model-A', effort: 'medium',
    title: '父会话', cwd: root, createdAt: '', updatedAt: '' }, text: '', imagePaths: [], taskContextPath: context.contextPath,
    signal: new AbortController().signal, onProgress: () => {} };
  let resolveBinding = binding, allow = true, adoptCalls = 0, authorizationCalls = 0;
  const receipt = (userId: string, args: NativeSessionAdoptArgs): NativeSessionAdoption => ({
    ref: args.ref, nativeId: args.ref.nativeId, profile: 'default', cwd: root, title: '原有会话', model: 'model-A', effort: 'medium', provider: null,
    revision: 'revision-A', health: 'healthy', busyEvidence: [], workerId: args.workerId, userId, adoptionId: args.adoptionId, status: 'adopted', leaseRevision: 1,
  });
  let adopting = async (userId: string, args: NativeSessionAdoptArgs): Promise<NativeSessionAdoption> => receipt(userId, args);
  const catalog: ControllerTargetCatalog = {
    async listTargets() { return []; }, async resolveTarget() { return resolveBinding; }, adapterFor() { return adapter; },
    async handoff() { throw new Error('隔离测试不交接'); },
    async authorizeNativeAccess(_workspace, userId, targetId) {
      authorizationCalls++; assert.equal(userId, origin.userId); assert.equal(targetId, binding.id);
      if (!allow) throw new Error('原生历史访问权限已撤销');
    },
    async adoptNativeSession(_binding, userId, args) { adoptCalls++; return adopting(userId, args); },
  };
  const runtime = new ControllerRuntime(config, { codex: adapter, claude: adapter }, registry, { targetCatalog: catalog, pollIntervalMs: 60000, onError: error => { errors.push(error); } });
  const worker = (id: string, nativeId: string, changes: Partial<ControllerWorker> = {}): ControllerWorker => ({
    id, origin, agent: 'codex', model: 'model-A', actualModel: null, effort: 'medium', nativeId, cwd: root, title: '直属任务',
    imagePaths: [], target: binding, ownership: 'bridge', wakeAllowed: true, blocked: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...changes,
  });
  function seedPending(previousWorkers: string[] = []) {
    const id = randomUUID();
    runtime.store.addWorker(worker(id, 'native-adopt', { blocked: true, adoption: { id: randomUUID(),
      ref: { agent: 'codex', profile: 'default', nativeId: 'native-adopt' }, expectedRevision: 'revision-A', status: 'pending', previousWorkers } }));
    return id;
  }
  t.after(async () => {
    await runtime.close(); await adapter.close(); registry.close();
    const target = resolve(root); assert.equal(dirname(target), resolve(tmpdir())); assert(basename(target).startsWith('bridge-recovery-gate-'));
    rmSync(target, { recursive: true, force: true });
  });
  return { root, registry, runtime, adapter, turn, errors, binding, worker, seedPending, receipt,
    get adoptCalls() { return adoptCalls; }, get authorizationCalls() { return authorizationCalls; },
    set adopting(value: typeof adopting) { adopting = value; }, set resolveBinding(value: ExecutionTargetBinding) { resolveBinding = value; }, set allow(value: boolean) { allow = value; } };
}

test('并发 start 共享一次恢复，恢复完成前不启动跟进，旧本机 running 转为 uncertain', async t => {
  const f = fixture(t), adopted = f.seedPending(), oldWorker = randomUUID(), oldJob = randomUUID();
  f.runtime.store.addWorker(f.worker(oldWorker, 'native-old'));
  const startedAt = '2026-10-13T07:00:00.000Z';
  f.runtime.store.addJob({ id: oldJob, workerId: oldWorker, origin: f.worker(oldWorker, 'native-old').origin,
    prompt: '旧任务', imagePaths: [], status: 'running', taskId: null, result: null, cancelReason: null, startedAt,
    execution: { model: 'model-A', effort: 'medium' }, createdAt: startedAt, updatedAt: startedAt });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  f.adopting = async (userId, args) => { await gate; return f.receipt(userId, args); };
  let firstDone = false, secondDone = false;
  const first = f.runtime.start().then(() => { firstDone = true; });
  const second = f.runtime.start().then(() => { secondDone = true; });
  const continuation = f.runtime.invoke(f.turn, 'bridge_continue_worker', { workerId: oldWorker, prompt: '恢复后跟进', delivery: 'next' }, 'continue-after-restart')
    .then(value => ({ status: 'accepted' as const, value }), error => ({ status: 'rejected' as const, reason: String(error) }));
  try {
    await until(() => f.adoptCalls === 1); await delay(10);
    assert.equal(firstDone, false); assert.equal(secondDone, false); assert.equal(f.runtime.isIdle(), false);
    assert.equal(f.adoptCalls, 1); assert.equal(f.adapter.turns.length, 0);
    assert.equal(f.runtime.store.getJob(oldJob)!.status, 'running');
  } finally { release(); }
  await Promise.all([first, second]);
  const result = await continuation;
  assert.equal(result.status, 'rejected'); assert.match(result.status === 'rejected' ? result.reason : '', /上一轮结果未知/);
  assert.equal(f.runtime.store.getWorker(adopted)!.adoption!.status, 'adopted');
  assert.equal(f.runtime.store.getJob(oldJob)!.status, 'uncertain'); assert.equal(f.runtime.store.getJob(oldJob)!.startedAt, startedAt);
  assert.equal(f.runtime.store.getWorker(oldWorker)!.blocked, true);
  assert.equal(f.adapter.turns.length, 0); assert.equal(f.adoptCalls, 1); assert.deepEqual(f.runtime.getGlobalWorkCounts(), { running: 0, queued: 0 });
});

test('pending 接管恢复重新核实授权，撤销权限后不访问目标或解除冻结', async t => {
  const f = fixture(t), id = f.seedPending(); f.allow = false;
  await f.runtime.start();
  assert.equal(f.authorizationCalls, 1); assert.equal(f.adoptCalls, 0); assert.equal(f.adapter.turns.length, 0);
  assert.equal(f.runtime.store.getWorker(id)!.adoption!.status, 'pending'); assert.equal(f.runtime.store.getWorker(id)!.blocked, true);
  assert(f.errors.some(error => String(error).includes('权限已撤销')));
});

test('pending 接管恢复拒绝已改变的电脑登记，不改用新 CLI 路线', async t => {
  const f = fixture(t), id = f.seedPending();
  f.resolveBinding = { ...f.binding, agentCommand: { command: 'different-cli', args: [] } };
  await f.runtime.start();
  assert.equal(f.adoptCalls, 0); assert.equal(f.adapter.turns.length, 0);
  assert.equal(f.runtime.store.getWorker(id)!.adoption!.status, 'pending'); assert.equal(f.runtime.store.getWorker(id)!.blocked, true);
  assert(f.errors.some(error => String(error).includes('电脑登记已改变')));
});

test('目标明确拒绝接管时回滚未领取登记，解除旧 worker 冻结且不生成新轮', async t => {
  const f = fixture(t), priorId = randomUUID();
  f.runtime.store.addWorker(f.worker(priorId, 'native-adopt', { handoffPending: true }));
  const pendingId = f.seedPending([priorId]);
  f.adopting = async () => { throw new NativeAdoptionRejectedError('revision 已变化，明确未领取'); };
  await f.runtime.start();
  assert.equal(f.runtime.store.getWorker(pendingId), null);
  assert.equal(f.runtime.store.getWorker(priorId)!.handoffPending, false);
  assert.equal(f.runtime.store.getWorker(priorId)!.ownership, 'bridge'); assert.equal(f.runtime.store.getWorker(priorId)!.supersededBy, undefined);
  assert.equal(f.adapter.turns.length, 0); assert.equal(f.adoptCalls, 1);
});

test('未知接管错误保留 pending 和旧 worker 冻结，避免重启后强行双重续接', async t => {
  const f = fixture(t), priorId = randomUUID();
  f.runtime.store.addWorker(f.worker(priorId, 'native-adopt', { handoffPending: true }));
  const pendingId = f.seedPending([priorId]);
  f.adopting = async () => { throw new Error('目标响应连接中断，结果未知'); };
  await f.runtime.start();
  assert.equal(f.runtime.store.getWorker(pendingId)!.adoption!.status, 'pending'); assert.equal(f.runtime.store.getWorker(pendingId)!.blocked, true);
  assert.equal(f.runtime.store.getWorker(priorId)!.handoffPending, true); assert.equal(f.runtime.store.getWorker(priorId)!.supersededBy, undefined);
  assert.equal(f.adapter.turns.length, 0); assert.equal(f.adoptCalls, 1);
});
