import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { loadHostConfig } from '../src/config.js';
import { ControllerRuntime } from '../src/controller/runtime.js';
import { ControllerStore } from '../src/controller/store.js';
import { inspectHostStoppedExecution, migrateHostConfig } from '../src/host-migration.js';
import { type HostMigrationProofTestHooks, type MigrationMachineObservation, type StoppedExecutionProof } from '../src/host-migration-proof.js';
import { SessionStore } from '../src/store.js';
import { TaskRegistry } from '../src/tasks.js';
import type { AgentAdapter } from '../src/types.js';

const botId = 'feishu:cli_proof', owner = botId + '|ou_owner';
const createdAt = '2020-01-01T00:00:00.000Z', startedAt = '2020-01-01T00:00:01.000Z', completedAt = '2020-01-01T00:00:02.000Z', endedAt = '2020-01-01T00:00:03.000Z';
const digest = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
function observation(updates: Partial<MigrationMachineObservation> = {}): MigrationMachineObservation {
  return { machineIdSha256: 'a'.repeat(64), lastBootAt: '2020-02-01T00:00:00.000Z', observedAt: new Date().toISOString(), matchingPids: [], unreadableAgentPids: [], ...updates };
}
const hooks: HostMigrationProofTestHooks = { machineProbe: () => observation() };
function sql(data: string, database: string, statement: string, ...values: string[]) {
  const db = new DatabaseSync(join(data, database)); try { db.prepare(statement).run(...values); } finally { db.close(); }
}
function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'bridge-migration-proof-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const local = join(root, '.local'), data = join(local, 'data'), config = join(local, 'config.json'); mkdirSync(join(local, 'bots', 'feishu'), { recursive: true }); mkdirSync(data);
  writeFileSync(join(local, 'bots', 'feishu', 'proof.json'), JSON.stringify({ applicationId: 'cli_proof', appSecret: 'private-fixture-secret', allowedUserIds: ['ou_owner'], network: { proxyPort: null } }));
  writeFileSync(config, JSON.stringify({ version: 2, startupProfile: 'feishu/proof', workspace: root, dataDir: data, controllerMode: true, commands: { codex: { command: process.execPath, args: [] }, claude: { command: process.execPath, args: [] } } }));
  const sessions = new SessionStore(data), conversation = sessions.createConversation(owner, 'codex', root, { controllerMode: true }); sessions.setActive(owner, conversation.id); sessions.close();
  const jobId = randomUUID(), workerId = randomUUID(), nativeId = randomUUID(), turnId = randomUUID();
  const origin = { conversationId: conversation.id, userId: owner, agent: 'codex' as const, nativeId: 'parent-native', cwd: root, channelId: botId + '|oc_private', originMessageId: botId + '|om_origin' };
  const tasks = new TaskRegistry(data), context = tasks.createContext(origin); tasks.register(JSON.parse(readFileSync(context.contextPath, 'utf8')), 'old work', jobId); tasks.acceptObservedResult(jobId, 'failed', 'Original uncertainty warning.'); tasks.cancelConversation(conversation.id); tasks.close();
  sql(data, 'tasks.sqlite', "UPDATE task_events SET state='delivered' WHERE task_id=?", jobId);
  const store = new ControllerStore(data);
  store.addWorker({ id: workerId, origin, agent: 'codex', model: null, actualModel: null, effort: null, cwd: root, title: 'old worker', nativeId, imagePaths: [], wakeAllowed: true, blocked: true, createdAt, updatedAt: startedAt });
  store.addJob({ id: jobId, workerId, origin, prompt: 'private old prompt', imagePaths: [], status: 'uncertain', taskId: jobId, result: 'Original uncertainty warning.', cancelReason: null, wakeAllowed: true, createdAt, updatedAt: endedAt }); store.close();
  const nativePath = join(root, 'rollout-2020-01-01T00-00-01-' + nativeId + '.jsonl');
  const entries = [
    { type: 'session_meta', timestamp: createdAt, payload: { id: nativeId, cwd: root } },
    { type: 'event_msg', timestamp: startedAt, payload: { type: 'task_started', turn_id: turnId } },
    { type: 'event_msg', timestamp: completedAt, payload: { type: 'task_complete', turn_id: turnId, last_agent_message: 'Private native content never emitted.' } },
  ]; writeFileSync(nativePath, entries.map(entry => JSON.stringify(entry)).join('\n') + '\n'); writeFileSync(join(data, 'disabled'), '');
  const proofPath = join(root, 'stopped.proof.json');
  const proof = inspectHostStoppedExecution(config, jobId, nativePath, {}, hooks); writeFileSync(proofPath, JSON.stringify(proof, null, 2));
  return { root, local, data, config, jobId, workerId, nativeId, turnId, nativePath, proofPath, proof, entries, conversation };
}
function rewriteProof(f: ReturnType<typeof fixture>, modify: (proof: StoppedExecutionProof) => void) {
  const proof = structuredClone(f.proof); modify(proof); writeFileSync(f.proofPath, JSON.stringify(proof));
}
function options(f: ReturnType<typeof fixture>) { return { stoppedExecutionProofs: [f.proofPath] }; }

test('a precise local reboot proof leaves source untouched and preserves unknown execution through migration and runtime recovery', async t => {
  const f = fixture(t), before = readFileSync(join(f.data, 'controller.sqlite')), sourceConfig = readFileSync(f.config);
  const baseline = await migrateHostConfig(f.config); assert.equal(baseline.blockers.length, 1);
  const preview = await migrateHostConfig(f.config, options(f), hooks); assert.deepEqual(preview.blockers, []); assert.deepEqual(preview.stoppedExecutions, [{ jobId: f.jobId, botId, proofSha256: digest(readFileSync(f.proofPath)) }]);
  assert.deepEqual(readFileSync(join(f.data, 'controller.sqlite')), before); assert.deepEqual(readFileSync(f.config), sourceConfig); assert.equal(existsSync(join(f.local, 'backups')), false);
  const proofBytes = Buffer.concat([Buffer.from([239, 187, 191]), readFileSync(f.proofPath)]); writeFileSync(f.proofPath, proofBytes);
  const result = await migrateHostConfig(f.config, { ...options(f), dryRun: false }, hooks), manifest = JSON.parse(readFileSync(join(result.backupDir!, 'manifest.json'), 'utf8'));
  assert.equal(manifest.stoppedExecutions.length, 1); const saved = manifest.stoppedExecutions[0];
  assert.equal(saved.preservedStatus, 'uncertain'); assert.equal(saved.workerBlocked, true); assert.equal(saved.proofSha256, digest(proofBytes)); assert.deepEqual(readFileSync(join(result.backupDir!, saved.proofFile)), proofBytes);
  assert.equal(saved.verification.machineIdSha256, f.proof.host.machineIdSha256); assert.deepEqual(saved.verification.matchingPids, []);
  const config = loadHostConfig(['--config', f.config], false).configs[0]!, tasks = new TaskRegistry(config.dataDir);
  let runs = 0; const adapter: AgentAdapter = { async run() { runs++; throw new Error('must never execute uncertain history'); }, async interrupt() {}, async close() {} };
  const runtime = new ControllerRuntime(config, { codex: adapter, claude: adapter }, tasks);
  try {
    await runtime.start(); await runtime.poll();
    assert.equal(runs, 0); assert.equal(runtime.store.getJob(f.jobId)?.status, 'uncertain'); assert.equal(runtime.store.getJob(f.jobId)?.result, 'Original uncertainty warning.');
    assert.equal(runtime.store.getWorker(f.workerId)?.blocked, true); assert.equal(tasks.getTask(f.jobId)?.status, 'failed'); assert.equal(tasks.getTask(f.jobId)?.wakeAllowed, false); assert.deepEqual(tasks.queuedEvents(), []);
  } finally { await runtime.close(); tasks.close(); }
  const source = new ControllerStore(f.data); try { assert.equal(source.getJob(f.jobId)?.status, 'uncertain'); assert.equal(source.getJob(f.jobId)?.updatedAt, endedAt); } finally { source.close(); }
  assert.ok(!JSON.stringify(preview).includes('private-fixture-secret')); assert.ok(!JSON.stringify(f.proof).includes('Private native content'));
});

test('proof times never replace a fresh OS observation and same-machine reboot must be later than execution', async t => {
  const f = fixture(t); rewriteProof(f, proof => { proof.host.lastBootAt = '2099-01-01T00:00:00Z'; });
  await assert.rejects(migrateHostConfig(f.config, options(f), hooks), /不匹配/);
  for (const updates of [{ lastBootAt: createdAt }, { matchingPids: [42] }, { unreadableAgentPids: [43] }, { observedAt: createdAt }]) {
    writeFileSync(f.proofPath, JSON.stringify(f.proof)); await assert.rejects(migrateHostConfig(f.config, options(f), { machineProbe: () => observation(updates) }), /Agent 进程|重启/);
  }
  await assert.rejects(migrateHostConfig(f.config, options(f), { machineProbe: () => observation({ machineIdSha256: 'b'.repeat(64) }) }), /不匹配/);
});

test('running, foreign, duplicate, unused and remote proofs fail rather than clearing unrelated blockers', async t => {
  const f = fixture(t);
  await assert.rejects(migrateHostConfig(f.config, { stoppedExecutionProofs: [f.proofPath, f.proofPath] }, hooks), /重复/);
  rewriteProof(f, proof => { proof.jobId = randomUUID(); }); await assert.rejects(migrateHostConfig(f.config, options(f), hooks), /不存在/);
  rewriteProof(f, proof => { proof.botId = 'discord:123456789012345678'; }); await assert.rejects(migrateHostConfig(f.config, options(f), hooks), /不匹配/);
  writeFileSync(f.proofPath, JSON.stringify({ ...f.proof, stopped: true })); await assert.rejects(migrateHostConfig(f.config, options(f), hooks), /未知字段/);
  writeFileSync(f.proofPath, JSON.stringify(f.proof)); sql(f.data, 'controller.sqlite', "UPDATE controller_jobs SET status='running' WHERE id=?", f.jobId); await assert.rejects(migrateHostConfig(f.config, options(f), hooks), /running/);
  sql(f.data, 'controller.sqlite', "UPDATE controller_jobs SET status='uncertain' WHERE id=?", f.jobId);
  const store = new ControllerStore(f.data), worker = store.getWorker(f.workerId)!; worker.target = { id: 'remote', label: 'remote', transport: 'ssh', agent: 'codex', agentCommand: { command: 'codex', args: [] }, cwd: f.root }; store.saveWorker(worker); store.close();
  await assert.rejects(migrateHostConfig(f.config, options(f), hooks), /本机 Codex/);
});

test('proof binds exact source bytes, task failure, closed context and consumed completion without repairing them', async t => {
  const cases: Array<[string, string, string[]]> = [
    ['controller.sqlite', 'UPDATE controller_jobs SET result=? WHERE id=?', ['changed', 'job']],
    ['tasks.sqlite', "UPDATE tasks SET status='completed' WHERE id=?", ['job']],
    ['tasks.sqlite', 'UPDATE tasks SET wake_allowed=1 WHERE id=?', ['job']],
    ['tasks.sqlite', 'UPDATE task_contexts SET open=1', []],
    ['tasks.sqlite', 'UPDATE task_contexts SET wake_allowed=1', []],
    ['tasks.sqlite', "UPDATE task_events SET state='queued' WHERE task_id=?", ['job']],
    ['controller.sqlite', "UPDATE controller_jobs SET cancel_reason='metadata changed' WHERE id=?", ['job']],
  ];
  for (const [database, statement, args] of cases) {
    const f = fixture(t); sql(f.data, database, statement, ...args.map(value => value === 'job' ? f.jobId : value));
    await assert.rejects(migrateHostConfig(f.config, options(f), hooks), /停止证明拒绝/); assert.equal(JSON.parse(readFileSync(f.config, 'utf8')).version, 2);
  }
});

test('native proof checks identity, actual hash, matched final completion and absence of a newer unfinished turn', async t => {
  const cases = [
    (f: ReturnType<typeof fixture>) => { rewriteProof(f, proof => { proof.native.sha256 = 'c'.repeat(64); }); },
    (f: ReturnType<typeof fixture>) => { f.entries[0]!.payload = { ...f.entries[0]!.payload, id: randomUUID() } as typeof f.entries[0]['payload']; writeFileSync(f.nativePath, f.entries.map(entry => JSON.stringify(entry)).join('\n')); },
    (f: ReturnType<typeof fixture>) => { writeFileSync(f.nativePath, f.entries.slice(0, 2).map(entry => JSON.stringify(entry)).join('\n')); },
    (f: ReturnType<typeof fixture>) => { writeFileSync(f.nativePath, [...f.entries, { type: 'event_msg', timestamp: endedAt, payload: { type: 'task_started', turn_id: randomUUID() } }].map(entry => JSON.stringify(entry)).join('\n')); },
    (f: ReturnType<typeof fixture>) => { f.entries[2]!.timestamp = '2020-01-02T00:00:00Z'; writeFileSync(f.nativePath, f.entries.map(entry => JSON.stringify(entry)).join('\n')); },
  ];
  for (const change of cases) { const f = fixture(t); change(f); await assert.rejects(migrateHostConfig(f.config, options(f), hooks), /停止证明拒绝/); }
});

test('a stopped job proof never waives uncertain inbox or associated queued work, schedules, supplements and leases', async t => {
  const f = fixture(t), sessions = new SessionStore(f.data); sessions.addMessage({ id: botId + '|om_unknown', userId: owner, channelId: botId + '|oc_private', text: 'unknown', imagePaths: [] }, f.conversation.id, 'uncertain'); sessions.close();
  // 无关收件状态不改变此 job 的指纹，仍须作为独立阻断项保留。
  const result = await migrateHostConfig(f.config, options(f), hooks); assert.equal(result.stoppedExecutions.length, 1); assert.equal(result.blockers.length, 1); assert.match(result.blockers[0]!, /inbox/);
  await assert.rejects(migrateHostConfig(f.config, { ...options(f), dryRun: false }, hooks), /执行中或结果未知/);
  for (const kind of ['job', 'schedule', 'supplement', 'lease']) {
    const other = fixture(t), store = new ControllerStore(other.data), old = store.getJob(other.jobId)!;
    if (kind === 'job') store.addJob({ ...old, id: randomUUID(), status: 'queued', taskId: null });
    if (kind === 'schedule') store.addSchedule({ id: randomUUID(), origin: old.origin, title: 'next', text: 'next', kind: 'worker', worker: store.getWorker(other.workerId)!, dueAt: '2099-01-01T00:00:00Z', status: 'pending', taskId: null, createdAt, updatedAt: createdAt });
    if (kind === 'supplement') store.saveSupplement({ id: randomUUID(), workerId: other.workerId, jobId: other.jobId, origin: old.origin, prompt: 'next', imagePaths: [], status: 'pending', createdAt, updatedAt: createdAt });
    store.close();
    if (kind === 'lease') { const db = new DatabaseSync(join(other.data, 'native-session-leases.sqlite')); db.exec('CREATE TABLE native_session_leases(ref TEXT,worker_id TEXT)'); db.prepare('INSERT INTO native_session_leases VALUES(?,?)').run('codex:default:' + other.nativeId, other.workerId); db.close(); }
    await assert.rejects(migrateHostConfig(other.config, options(other), hooks), /停止证明拒绝/);
  }
});

test('apply revalidates source under offline lock and rejects changes after preview without installing v3', async t => {
  const f = fixture(t); let calls = 0;
  await assert.rejects(migrateHostConfig(f.config, { ...options(f), dryRun: false }, { machineProbe: () => {
    if (++calls === 2) sql(f.data, 'tasks.sqlite', 'UPDATE tasks SET wake_allowed=1 WHERE id=?', f.jobId);
    return observation();
  } }), /停止证明拒绝/);
  // 第二次现场核验期间发生变化，必须在安装前检出。
  assert.equal(JSON.parse(readFileSync(f.config, 'utf8')).version, 2); assert.equal(existsSync(join(f.data, 'host-semantic-version.json')), false);
});

test('apply rejects a manual config byte change immediately after taking its lock and preserves the edit', async t => {
  const f = fixture(t), edited = Buffer.concat([readFileSync(f.config), Buffer.from('\n  \n')]); let calls = 0;
  await assert.rejects(migrateHostConfig(f.config, { ...options(f), dryRun: false }, { machineProbe: () => {
    if (++calls === 1) writeFileSync(f.config, edited);
    return observation();
  } }), /配置变化/);
  assert.deepEqual(readFileSync(f.config), edited); assert.equal(existsSync(join(f.local, 'backups')), false); assert.equal(existsSync(join(f.data, 'host-semantic-version.json')), false);
});

test('the CLI rejects test probes, self-reported stopped flags and mixed generation/apply actions', t => {
  const f = fixture(t), cli = join(import.meta.dirname, '..', 'src', 'host-migration-cli.js'), before = readFileSync(f.config);
  for (const args of [
    ['--machine-probe', 'always-stopped'],
    ['--stopped', f.jobId],
    ['--inspect-stopped-job', f.jobId, '--native-session', f.nativePath, '--apply'],
    ['--inspect-stopped-job', f.jobId, '--native-session', f.nativePath, '--stopped-proof', f.proofPath],
  ]) {
    const result = spawnSync(process.execPath, [cli, '--config', f.config, ...args], { encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 1); assert.match(result.stderr, /未知参数|不能与/); assert.equal(result.stdout, '');
  }
  assert.deepEqual(readFileSync(f.config), before); assert.equal(existsSync(join(f.local, 'backups')), false);
});

test('the production machine probe uses the actual Windows host and fails closed when agent processes are unreadable', { skip: process.platform !== 'win32' }, t => {
  const f = fixture(t);
  let proof: StoppedExecutionProof;
  try { proof = inspectHostStoppedExecution(f.config, f.jobId, f.nativePath); }
  catch (error) { assert.match(String(error), /停止证明拒绝：Agent 进程命令行不可读，需具备只读核验权限，PID: \d/); return; }
  assert.match(proof.host.machineIdSha256, /^[a-f0-9]{64}$/); assert.ok(Date.parse(proof.host.lastBootAt) > Date.parse(endedAt)); assert.notEqual(proof.host.machineIdSha256, hooks.machineProbe!([]).machineIdSha256);
});
