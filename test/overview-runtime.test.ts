import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { ControllerRuntime } from '../src/controller/runtime.js';
import type { ControllerJob, ControllerWorker } from '../src/controller/runtime-types.js';
import { TaskRegistry, type TaskOrigin } from '../src/tasks.js';
import type { AgentAdapter, BridgeConfig, Conversation } from '../src/types.js';

test('只读总览使用实际 metadata 与本轮 job 时间，计数排除空闲主控及预约且保持拥有权和回执', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bridge-overview-runtime-'));
  const registry = new TaskRegistry(root);
  const adapter: AgentAdapter = { run: async () => { throw new Error('禁止运行模型'); }, interrupt: async () => {}, close: async () => {} };
  const config: BridgeConfig = { token: 'unused', allowedUserIds: ['owner'], defaultAgent: 'codex', workspace: root, proxyUrl: null,
    commands: { codex: { command: 'unused', args: [] }, claude: { command: 'unused', args: [] } }, dataDir: root, attachmentsDir: root, logsDir: root, maxImageBytes: 100 };
  const runtime = new ControllerRuntime(config, { codex: adapter, claude: adapter }, registry);
  const origin: TaskOrigin = { conversationId: 'parent', userId: 'owner', channelId: 'dm', originMessageId: 'first', nativeId: 'parent-native', agent: 'codex', cwd: root };
  const conversation: Conversation = { id: 'parent', userId: 'owner', agent: 'codex', nativeId: 'parent-native', title: '主控', cwd: root, createdAt: '', updatedAt: '' };
  const worker = (id: string, changes: Partial<ControllerWorker> = {}): ControllerWorker => ({
    id, origin, agent: 'codex', model: 'requested-alias', actualModel: null, effort: 'xhigh', actualEffort: null, cwd: root, title: id,
    nativeId: 'native-' + id, imagePaths: [], wakeAllowed: true, createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-13T08:00:00Z', ...changes,
  });
  const job = (id: string, workerId: string, changes: Partial<ControllerJob> = {}): ControllerJob => ({
    id, workerId, origin, prompt: '未执行', imagePaths: [], status: 'queued', taskId: null, result: null, cancelReason: null,
    createdAt: '2026-10-13T08:00:00Z', updatedAt: '2026-10-13T08:00:00Z', ...changes,
  });
  try {
    assert.deepEqual(runtime.getGlobalWorkCounts(), { running: 0, queued: 0 });
    runtime.store.addWorker(worker('running'));
    runtime.store.addWorker(worker('idle', { actualModel: 'gpt-6.1-sol', actualEffort: 'medium' }));
    runtime.store.addWorker(worker('blocked', { blocked: true }));
    runtime.store.addWorker(worker('handoff', { ownership: 'user', handoffPending: true }));
    runtime.store.addWorker(worker('foreign', { origin: { ...origin, userId: 'someone-else' } }));
    runtime.store.addWorker(worker('other-parent', { origin: { ...origin, conversationId: 'other-parent' } }));
    runtime.store.addJob(job('previous', 'running', { status: 'completed', startedAt: '2026-10-12T00:00:00Z', result: '旧回执' }));
    runtime.store.addJob(job('current', 'running', { status: 'running', startedAt: '2026-10-13T08:00:00Z' }));
    runtime.store.addJob(job('next-1', 'running'));
    runtime.store.addJob(job('next-2', 'running'));
    runtime.store.addJob(job('failed', 'blocked', { status: 'uncertain', result: '退出未确认', cancelReason: '禁止自动续接' }));
    runtime.store.addWake({ id: 'wake', origin, dueAt: '2026-10-13T09:00:00Z', text: '预约', status: 'pending', taskId: null, createdAt: '' });
    runtime.store.saveSupplement({ id: 'supplement', workerId: 'blocked', jobId: 'failed', origin, prompt: '补充', imagePaths: [], status: 'uncertain', createdAt: '', updatedAt: '' });
    assert.deepEqual(runtime.getGlobalWorkCounts(), { running: 1, queued: 2 });
    const overview = runtime.queryWorkerOverview(conversation);
    assert.equal(overview.length, 4); assert.equal(runtime.queryWorkerOverview(conversation, 'all').length, 5);
    const active = overview.find(value => value.workerId === 'running')!;
    assert.equal(active.startedAt, '2026-10-13T08:00:00Z');
    assert.equal(active.model, null); assert.equal(active.effort, null);
    assert.equal(active.requestedEffort, 'xhigh'); assert.equal(active.effortConfiguration, null);
    const configured = runtime.store.getWorker('running')!; configured.effortConfiguration = { value: 'high', source: 'environment' }; runtime.store.saveWorker(configured);
    assert.deepEqual(runtime.queryWorkerOverview(conversation).find(value => value.workerId === 'running')!.effortConfiguration, { value: 'high', source: 'environment' });
    const actual = runtime.store.getWorker('running')!; actual.actualModel = 'gpt-6.1-sol'; actual.actualEffort = 'medium'; runtime.store.saveWorker(actual);
    const observed = runtime.queryWorkerOverview(conversation).find(value => value.workerId === 'running')!;
    assert.equal(observed.model, 'gpt-6.1-sol'); assert.equal(observed.effort, 'medium');
    assert.equal(runtime.store.getWorker('running')!.model, 'requested-alias'); assert.equal(runtime.store.getWorker('running')!.effort, 'xhigh');
    const blocked = overview.find(value => value.workerId === 'blocked')!;
    assert.equal(blocked.status, 'uncertain'); assert.equal(blocked.blocked, true); assert.equal(blocked.statusReason, '禁止自动续接');
    assert.equal(blocked.lastResultPreview, '退出未确认'); assert.equal(blocked.unresolvedSupplements, 1);
    assert.equal(overview.find(value => value.workerId === 'handoff')!.status, 'handoff-pending');
    assert.equal(overview.find(value => value.workerId === 'handoff')!.ownership, 'user');
    assert.equal(overview.find(value => value.workerId === 'idle')!.status, 'idle');
    runtime.store.addJob(job('done', 'idle', { status: 'completed', startedAt: '2026-10-13T08:00:00Z', updatedAt: '2026-10-13T08:00:20Z' }));
    assert.equal(runtime.queryWorkerOverview(conversation).find(value => value.workerId === 'idle')!.endedAt, '2026-10-13T08:00:20Z');
    assert.deepEqual(runtime.getGlobalWorkCounts(), { running: 1, queued: 2 });
  } finally {
    await runtime.close(); registry.close();
    const path = resolve(root); assert.equal(dirname(path), resolve(tmpdir())); assert(basename(path).startsWith('bridge-overview-runtime-'));
    rmSync(path, { recursive: true, force: true });
  }
});
