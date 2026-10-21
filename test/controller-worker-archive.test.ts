import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { ControllerRuntime } from '../src/controller/runtime.js';
import { ControllerStore } from '../src/controller/store.js';
import type { ControllerJob, ControllerWorker } from '../src/controller/runtime-types.js';
import { TaskRegistry, type TaskOrigin } from '../src/tasks.js';
import type { AgentAdapter, AgentTurn, BridgeConfig } from '../src/types.js';
import type { ExecutionTargetBinding } from '../src/remote/types.js';
import { ownTemporaryDirectory } from './temp-directory.js';

function fixture(t: TestContext) {
  const dir = ownTemporaryDirectory(mkdtempSync(join(tmpdir(), 'bridge-worker-archive-')), 'bridge-worker-archive-');
  const registry = new TaskRegistry(dir), confirmations: Array<{ workerId: string; dispatchId?: string }> = [], proof = new Map<string, boolean>();
  let runs = 0, interrupts = 0;
  const adapter: AgentAdapter = {
    async run() { runs++; throw new Error('must not generate a turn'); },
    async interrupt() { interrupts++; throw new Error('legacy evidence recovery must only read'); },
    async confirmStopped(workerId, dispatchId) { confirmations.push({ workerId, dispatchId }); return !!dispatchId && proof.get(dispatchId) === true; },
    async close() {},
  };
  const command = { command: 'not-executed', args: [] };
  const config: BridgeConfig = { token: 'unused', allowedUserIds: ['owner'], defaultAgent: 'codex', workspace: dir,
    proxyUrl: null, commands: { codex: command, claude: command }, dataDir: dir, attachmentsDir: dir, logsDir: dir, maxImageBytes: 100 };
  const origin: TaskOrigin = { conversationId: 'parent', userId: 'owner', channelId: 'dm', originMessageId: 'message', nativeId: 'parent-native', agent: 'codex', cwd: dir };
  const context = registry.createContext(origin);
  const turn: AgentTurn = { conversation: { id: origin.conversationId, userId: origin.userId, agent: origin.agent, nativeId: origin.nativeId,
    title: 'parent', cwd: dir, createdAt: 'now', updatedAt: 'now' }, text: 'stop', imagePaths: [], taskContextPath: context.contextPath,
    signal: new AbortController().signal, onProgress: () => {} };
  const target: ExecutionTargetBinding = { id: 'remote', label: 'Remote', transport: 'ssh', agent: 'codex', agentCommand: command, cwd: dir };
  const runtime = new ControllerRuntime(config, { codex: adapter, claude: adapter }, registry, { pollIntervalMs: 60_000,
    targetCatalog: { async listTargets() { return []; }, async resolveTarget() { return target; }, adapterFor() { return adapter; }, async handoff() { throw new Error('no handoff'); } } });
  const worker: ControllerWorker = { id: randomUUID(), origin, agent: 'codex', model: null, actualModel: null, effort: null,
    cwd: dir, title: 'old uncertain worker', nativeId: 'child-native', imagePaths: [], target, wakeAllowed: true, blocked: true, createdAt: 'now', updatedAt: 'now' };
  const report = { nativeId: worker.nativeId!, text: 'Report saved; business acceptance still incomplete.' };
  const job: ControllerJob = { id: randomUUID(), workerId: worker.id, origin, prompt: 'old task', imagePaths: [], status: 'uncertain',
    taskId: null, result: 'Exit not confirmed', cancelReason: null, nativeResult: report, createdAt: 'now', updatedAt: 'now' };
  runtime.store.addWorker(worker); runtime.store.addJob(job);
  t.after(async () => { await runtime.close(); registry.close(); });
  return { dir, runtime, turn, worker, job, report, proof, confirmations, get runs() { return runs; }, get interrupts() { return interrupts; } };
}

test('explicit cancellation archives a legacy uncertain worker only after read-only stop proof; report and resume lock survive restart', async t => {
  const f = fixture(t); f.proof.set(f.job.id, true);
  const receipt = await f.runtime.invoke(f.turn, 'bridge_cancel_worker', { workerId: f.worker.id, reason: 'User stopped this old worker' }) as { stopped: boolean; archivedAt?: string };
  assert.equal(receipt.stopped, true); assert.ok(receipt.archivedAt);
  assert.deepEqual(f.confirmations, [{ workerId: f.worker.id, dispatchId: f.job.id }]); assert.equal(f.runs, 0); assert.equal(f.interrupts, 0);
  const worker = f.runtime.store.getWorker(f.worker.id)!, job = f.runtime.store.getJob(f.job.id)!;
  assert.equal(worker.blocked, true); assert.equal(worker.archiveReason, 'User stopped this old worker');
  assert.equal(job.status, 'uncertain'); assert.equal(job.result, f.job.result); assert.deepEqual(job.nativeResult, f.report); assert.equal(job.processStopped, true);
  await assert.rejects(f.runtime.invoke(f.turn, 'bridge_continue_worker', { workerId: worker.id, prompt: 'do not replay' }), /报告已保存/);
  assert.equal(f.runtime.queryWorkerOverview(f.turn.conversation)[0]!.archivedAt, receipt.archivedAt);
  const list = await f.runtime.invoke(f.turn, 'bridge_list_workers', {}) as { workers: Array<{ archivedAt?: string; archiveReason?: string }> };
  assert.equal(list.workers[0]!.archivedAt, receipt.archivedAt); assert.equal(list.workers[0]!.archiveReason, worker.archiveReason);
  const reopened = new ControllerStore(f.dir);
  try { assert.deepEqual(reopened.getWorker(worker.id), worker); assert.deepEqual(reopened.getJob(job.id)!.nativeResult, f.report); }
  finally { reopened.close(); }
});

test('unknown stop evidence neither archives nor claims stopped, and a later explicit cancellation can reconcile it', async t => {
  const f = fixture(t);
  const missing = await f.runtime.invoke(f.turn, 'bridge_cancel_worker', { workerId: f.worker.id }) as { stopped: boolean; status: string };
  assert.equal(missing.stopped, false); assert.equal(missing.status, 'uncertain'); assert.equal(f.runtime.store.getWorker(f.worker.id)!.archivedAt, undefined);
  assert.equal(f.runtime.store.getJob(f.job.id)!.processStopped, undefined); assert.equal(f.interrupts, 0); assert.equal(f.runs, 0);
  f.proof.set(f.job.id, true);
  const checked = await f.runtime.invoke(f.turn, 'bridge_cancel_worker', { workerId: f.worker.id }) as { stopped: boolean; archivedAt?: string };
  assert.equal(checked.stopped, true); assert.ok(checked.archivedAt);
});

test('startup and listing never infer cancellation or archive a stopped uncertain worker', async t => {
  const f = fixture(t); f.runtime.store.setJob(f.job.id, 'uncertain', { processStopped: true });
  await f.runtime.start(); await f.runtime.invoke(f.turn, 'bridge_list_workers', {});
  assert.equal(f.runtime.store.getWorker(f.worker.id)!.archivedAt, undefined); assert.equal(f.confirmations.length, 0);
  assert.equal(f.runs, 0); assert.equal(f.interrupts, 0);
});

test('archival requires stop proof for every uncertain job and preserves the first audit reason', async t => {
  const f = fixture(t), other = { ...f.job, id: randomUUID() }; f.runtime.store.addJob(other);
  f.proof.set(f.job.id, true);
  const partial = await f.runtime.invoke(f.turn, 'bridge_cancel_worker', { workerId: f.worker.id, reason: 'first attempt' }) as { stopped: boolean };
  assert.equal(partial.stopped, false); assert.equal(f.runtime.store.getWorker(f.worker.id)!.archivedAt, undefined);
  assert.equal(f.runtime.store.archiveStoppedWorker(f.worker.id, 'unsafe'), null);
  f.proof.set(other.id, true);
  await f.runtime.invoke(f.turn, 'bridge_cancel_worker', { workerId: f.worker.id, reason: 'confirmed cancellation' });
  const first = f.runtime.store.getWorker(f.worker.id)!;
  assert.ok(first.archivedAt); assert.equal(first.archiveReason, 'confirmed cancellation');
  const repeated = f.runtime.store.archiveStoppedWorker(f.worker.id, 'must preserve audit')!;
  assert.equal(repeated.archivedAt, first.archivedAt); assert.equal(repeated.archiveReason, first.archiveReason);
  assert.deepEqual(f.runtime.store.jobs(f.worker.id).map(job => job.status), ['uncertain', 'uncertain']);
});

for (const status of ['queued', 'running'] as const) test(`store refuses archival while a ${status} job exists`, async t => {
  const f = fixture(t); f.runtime.store.setJob(f.job.id, 'uncertain', { processStopped: true });
  f.runtime.store.addJob({ ...f.job, id: randomUUID(), status });
  assert.equal(f.runtime.store.archiveStoppedWorker(f.worker.id, 'not stopped'), null);
  assert.equal(f.runtime.store.getWorker(f.worker.id)!.archivedAt, undefined);
});

for (const extra of [{ ownership: 'user' as const }, { handoffPending: true }, { supersededBy: 'replacement' }, {
  adoption: { id: 'adoption', ref: { agent: 'codex' as const, profile: 'default' as const, nativeId: 'child-native' }, expectedRevision: 'v1', status: 'pending' as const, previousWorkers: [] },
}]) test(`store refuses archival during ownership or adoption transition ${JSON.stringify(extra)}`, async t => {
  const f = fixture(t); f.runtime.store.setJob(f.job.id, 'uncertain', { processStopped: true });
  f.runtime.store.saveWorker({ ...f.worker, ...extra });
  assert.equal(f.runtime.store.archiveStoppedWorker(f.worker.id, 'not eligible'), null);
  assert.equal(f.runtime.store.getWorker(f.worker.id)!.archivedAt, undefined);
});