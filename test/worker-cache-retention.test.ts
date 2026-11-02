import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { pruneWorkerPluginCatalogCaches, workerPluginCacheRetentionMs } from '../src/controller/cache-retention.js';
import { ControllerRuntime } from '../src/controller/runtime.js';
import type { ControllerJob, ControllerWorker } from '../src/controller/runtime-types.js';
import { TaskRegistry } from '../src/tasks.js';
import type { AgentAdapter, BridgeConfig } from '../src/types.js';
import { ownTemporaryDirectory } from './temp-directory.js';

const now = Date.parse('2026-11-02T12:00:00Z'), old = new Date(now - 4 * 86400000).toISOString();
function fixture() {
  const root = ownTemporaryDirectory(mkdtempSync(join(tmpdir(), 'bridge-worker-cache-')), 'bridge-worker-cache-');
  const origin = { conversationId: 'parent', userId: 'owner', channelId: 'dm', originMessageId: 'message', agent: 'codex' as const, nativeId: 'parent-native', cwd: root };
  const worker = (id: string): ControllerWorker => ({ id, origin, agent: 'codex', model: null, actualModel: null, effort: null,
    cwd: root, title: id, nativeId: id, imagePaths: [], ownership: 'bridge', wakeAllowed: true, createdAt: old, updatedAt: old });
  const job = (id: string): ControllerJob => ({ id: 'job-' + id, workerId: id, origin, prompt: 'task', imagePaths: [],
    status: 'completed', taskId: null, result: 'done', cancelReason: null, processStopped: true, createdAt: old, updatedAt: old });
  const catalog = (id: string, kind = 'worker-homes', modified = old) => {
    const home = join(root, kind, 'codex', id), directory = join(home, 'cache', 'remote_plugin_catalog');
    mkdirSync(directory, { recursive: true });
    const path = join(directory, 'catalog.json'); writeFileSync(path, '{"plugins":[]}'); utimesSync(path, new Date(modified), new Date(modified));
    return { home, directory, path };
  };
  return { root, origin, worker, job, catalog };
}

test('startup retention removes only old confirmed ordinary/preset plugin catalogs and is idempotent', () => {
  const f = fixture(), normal = f.worker('ordinary'), preset = f.worker('preset');
  preset.target = { id: 'local', label: 'local preset', transport: 'local', agent: 'codex', agentCommand: { command: 'fake', args: [] }, cwd: f.root,
    preset: { id: 'sol', profileId: 'private', revision: 1, fingerprint: 'test', targetId: 'local', agent: 'codex', model: 'gpt-6.1-sol' } };
  const homes = [f.catalog(normal.id), f.catalog(preset.id, 'preset-homes')];
  const preserved: string[] = [];
  for (const { home, directory } of homes) {
    for (const name of ['auth.json', 'config.toml', 'state_5.sqlite', 'sessions/turn.jsonl', 'cache/other.json', 'cache/remote_plugin_catalog/recent.json']) {
      const path = join(home, name); mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, 'keep'); preserved.push(path);
    }
    mkdirSync(join(directory, 'unrecognized-subdirectory')); writeFileSync(join(directory, 'unrecognized-subdirectory', 'keep.json'), 'keep');
  }
  const controller = f.catalog('controller', 'controller-homes'); preserved.push(controller.path);
  const jobs = [f.job(normal.id), f.job(preset.id)];
  const result = pruneWorkerPluginCatalogCaches(f.root, [normal, preset], jobs, () => true, now);
  assert.deepEqual(result, { files: 2, bytes: 28, workers: 2, errors: [] });
  for (const entry of homes) assert.equal(existsSync(entry.path), false);
  for (const path of preserved) assert.ok(existsSync(path));
  assert.equal(pruneWorkerPluginCatalogCaches(f.root, [normal, preset], jobs, () => true, now).files, 0);
});

for (const scenario of ['running', 'queued', 'uncertain', 'no-exit-proof', 'exit-unconfirmed', 'recent', 'boundary', 'invalid-time', 'user-owned', 'blocked', 'handoff', 'remote', 'invalid-id'] as const)
  test(`startup cache retention preserves ${scenario} workers`, () => {
    const f = fixture(), worker = f.worker('protected'), job = f.job(worker.id), entry = f.catalog(worker.id);
    if (['running', 'queued', 'uncertain'].includes(scenario)) job.status = scenario as ControllerJob['status'];
    if (scenario === 'no-exit-proof') delete job.processStopped;
    if (scenario === 'recent') worker.updatedAt = new Date(now - 1000).toISOString();
    if (scenario === 'boundary') worker.updatedAt = new Date(now - workerPluginCacheRetentionMs).toISOString();
    if (scenario === 'invalid-time') job.updatedAt = 'unknown';
    if (scenario === 'user-owned') worker.ownership = 'user';
    if (scenario === 'blocked') worker.blocked = true;
    if (scenario === 'handoff') worker.handoffPending = true;
    if (scenario === 'remote') worker.target = { id: 'remote', label: 'remote', transport: 'ssh', agent: 'codex', agentCommand: { command: 'fake', args: [] }, cwd: f.root };
    if (scenario === 'invalid-id') { worker.id = '../protected'; job.workerId = worker.id; }
    assert.equal(pruneWorkerPluginCatalogCaches(f.root, [worker], [job], () => scenario !== 'exit-unconfirmed', now).files, 0);
    assert.ok(existsSync(entry.path));
  });

test('retention does not follow directory junctions or symlinks into another profile', () => {
  const f = fixture(), worker = f.worker('linked'), entry = f.catalog('outside');
  const parent = join(f.root, 'worker-homes', 'codex');
  symlinkSync(entry.home, join(parent, worker.id), process.platform === 'win32' ? 'junction' : 'dir');
  const result = pruneWorkerPluginCatalogCaches(f.root, [worker], [f.job(worker.id)], () => true, now);
  assert.equal(result.files, 0); assert.equal(readFileSync(entry.path, 'utf8'), '{"plugins":[]}');
});

test('runtime retention honors pending schedules and supplements as well as persisted process exit', async () => {
  const f = fixture(), registry = new TaskRegistry(f.root);
  const config: BridgeConfig = { token: '', allowedUserIds: ['owner'], defaultAgent: 'codex', workspace: f.root, dataDir: f.root,
    logsDir: f.root, attachmentsDir: f.root, proxyUrl: null, maxImageBytes: 100, commands: { codex: { command: 'fake', args: [] }, claude: { command: 'fake', args: [] } } };
  const adapter: AgentAdapter = { async run() { throw new Error('cleanup must not execute a model'); }, async interrupt() {}, async close() {} };
  const runtime = new ControllerRuntime(config, { codex: adapter, claude: adapter }, registry, { now: () => now });
  try {
    for (const id of ['idle', 'scheduled', 'supplement']) { runtime.store.addWorker(f.worker(id)); runtime.store.addJob(f.job(id)); f.catalog(id); }
    const scheduled = f.worker('scheduled');
    runtime.store.addSchedule({ id: 'future', origin: f.origin, dueAt: new Date(now + 86400000).toISOString(), title: 'future', text: '', kind: 'worker',
      status: 'pending', taskId: null, worker: scheduled, createdAt: old, updatedAt: old });
    runtime.store.saveSupplement({ id: 'pending', workerId: 'supplement', jobId: 'job-supplement', origin: f.origin, prompt: 'continue', imagePaths: [], status: 'pending', createdAt: old, updatedAt: old });
    const result = runtime.pruneWorkerCaches(); assert.equal(result.workers, 1);
    assert.equal(existsSync(join(f.root, 'worker-homes/codex/idle/cache/remote_plugin_catalog/catalog.json')), false);
    for (const id of ['scheduled', 'supplement']) assert.ok(existsSync(join(f.root, 'worker-homes/codex', id, 'cache/remote_plugin_catalog/catalog.json')));
  } finally { await runtime.close(); registry.close(); }
});
