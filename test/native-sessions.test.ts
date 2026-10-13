import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, realpathSync, rmSync, openSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep, win32 } from 'node:path';
import { hostname } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { NativeAdoptionRejectedError, NativeSessionService, probeNativeFileHolders, windowsPath, type NativeSessionRef } from '../src/native-sessions.js';
import { RemoteStore } from '../src/remote/store.js';
import { RemoteDaemon } from '../src/remote/daemon.js';
import { RemoteAgentAdapter } from '../src/remote/adapter.js';
import { TargetCatalogService } from '../src/remote/catalog.js';
import type { AgentAdapter, BridgeConfig } from '../src/types.js';

const nativeId = '11111111-2222-3333-4444-555555555555';
const ref: NativeSessionRef = { agent: 'codex', profile: 'default', nativeId };
function fixture(t: TestContext, terminal = true) {
  const root = mkdtempSync(join(tmpdir(), 'bridge-native-session-'));
  const home = join(root, 'user'), cwd = join(root, 'workspace'), data = join(root, 'data'), codex = join(home, '.codex');
  mkdirSync(join(codex, 'sessions'), { recursive: true }); mkdirSync(cwd); mkdirSync(data);
  writeFileSync(join(codex, 'config.toml'), 'model_provider="openai"\n');
  const path = join(codex, 'sessions', `rollout-${nativeId}.jsonl`);
  const records = [{ type: 'session_meta', payload: { id: nativeId, cwd, cli_version: '0.162.1' } },
    { type: 'turn_context', payload: { cwd, model: 'gpt-6-astra', effort: 'medium' } },
    { type: 'event_msg', payload: { type: 'task_started' } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ text: 'existing user instruction' }] } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ text: 'existing native result' }] } },
    ...(terminal ? [{ type: 'event_msg', payload: { type: 'task_complete' } }] : [])];
  writeFileSync(path, records.map(row => JSON.stringify(row)).join('\n') + '\n');
  const db = new DatabaseSync(join(codex, 'state_5.sqlite'));
  db.exec('CREATE TABLE threads(id TEXT,rollout_path TEXT,cwd TEXT,model_provider TEXT,title TEXT,archived INTEGER,updated_at INTEGER,model TEXT,reasoning_effort TEXT,cli_version TEXT)');
  db.prepare('INSERT INTO threads VALUES(?,?,?,?,?,0,1,?,?,?)').run(nativeId, path, cwd, 'openai', 'existing native session', 'gpt-6-astra', 'medium', '0.162.1'); db.close();
  const services: NativeSessionService[] = [], resources: Array<() => void | Promise<void>> = [];
  const make = (busy: 'clear' | 'busy' | 'unknown' = 'clear') => {
    const service = new NativeSessionService(data, { codex: { agentCommand: { command: process.execPath, args: [] }, defaultCwd: cwd }, claude: { agentCommand: { command: process.execPath, args: [] }, defaultCwd: cwd } },
      { userHome: home, env: {}, busyProbe: async checked => { assert.equal(checked, realpathSync(path)); return { status: busy, evidence: busy === 'clear' ? [] : ['exact file holder evidence'] }; } });
    services.push(service); return service;
  };
  t.after(async () => { for (const resource of resources) await resource(); for (const service of services) service.close(); const absolute = realpathSync(root); assert.ok(absolute.startsWith(realpathSync(tmpdir()) + sep)); rmSync(absolute, { recursive: true }); });
  return { root, home, cwd, data, path, make, services, resources };
}

test('native discovery is metadata only and read preserves the real ID, model and effort without starting a model', async t => {
  const f = fixture(t), service = f.make();
  const page = await service.list({ agent: 'codex', userId: 'owner', limit: 12 });
  assert.equal(page.sessions.length, 1); assert.equal('messages' in page.sessions[0]!, false);
  assert.equal(page.sessions[0]!.health, 'unknown');
  const read = await service.read('owner', ref);
  assert.equal(read.nativeId, nativeId); assert.equal(read.model, 'gpt-6-astra'); assert.equal(read.effort, 'medium');
  assert.equal(read.cwd, f.cwd); assert.equal(read.health, 'healthy');
  assert.deepEqual(read.messages.map(item => item.text), ['existing user instruction', 'existing native result']);
});

test('Windows extended rollout paths discover, read and adopt the original ID without changing the index', { skip: process.platform !== 'win32' }, async t => {
  const f = fixture(t), service = f.make(), extendedPath = '\\\\?\\' + f.path;
  const db = new DatabaseSync(join(f.home, '.codex', 'state_5.sqlite'));
  db.prepare('UPDATE threads SET rollout_path=? WHERE id=?').run(extendedPath, nativeId); db.close();
  const page = await service.list({ agent: 'codex', userId: 'owner' });
  assert.equal(page.sessions.length, 1); assert.equal(page.sessions[0]!.nativeId, nativeId);
  const read = await service.read('owner', ref); assert.equal(read.health, 'healthy');
  const adopted = await service.adopt('owner', { ref, workerId: 'extended-path-worker', adoptionId: 'extended-path-adoption', expectedRevision: read.revision });
  assert.equal(adopted.nativeId, nativeId);
  const index = new DatabaseSync(join(f.home, '.codex', 'state_5.sqlite'), { readOnly: true });
  try { assert.equal(index.prepare('SELECT rollout_path FROM threads WHERE id=?').get(nativeId)!.rollout_path, extendedPath); } finally { index.close(); }
});

test('Windows extended UNC normalization retains an absolute network path and leaves device paths unchanged', { skip: process.platform !== 'win32' }, () => {
  const unc = '\\\\server\\share\\workspace', extendedUnc = '\\\\?\\UNC\\server\\share\\workspace';
  assert.equal(windowsPath(extendedUnc), unc); assert.equal(win32.isAbsolute(windowsPath(extendedUnc)), true);
  assert.equal(windowsPath('\\\\?\\unc\\server\\share\\workspace'), unc);
  assert.equal(windowsPath('\\\\?\\C:\\workspace'), 'C:\\workspace');
  assert.equal(windowsPath('\\\\?\\GLOBALROOT\\Device\\HarddiskVolume1'), '\\\\?\\GLOBALROOT\\Device\\HarddiskVolume1');
});

test('adoption only claims an idle worker and is durable and idempotent while its exact lease is current', async t => {
  const f = fixture(t), service = f.make(), read = await service.read('owner', ref);
  const args = { ref, workerId: 'worker-one', adoptionId: 'adoption-one', expectedRevision: read.revision };
  const [first, again] = await Promise.all([service.adopt('owner', args), service.adopt('owner', args)]);
  assert.deepEqual(first, again); assert.equal(first.leaseRevision, 1); assert.equal(first.nativeId, nativeId);
  const restarted = f.make(); assert.deepEqual(await restarted.adopt('owner', args), first);
  restarted.leases.release(ref);
  await assert.rejects(restarted.adopt('owner', args), error => error instanceof NativeAdoptionRejectedError && /取代/.test(error.message));
});

test('an active holder, unknown holder state, incomplete native turn, provider mismatch and changed transcript cannot be adopted', async t => {
  for (const busy of ['busy', 'unknown'] as const) {
    const f = fixture(t), service = f.make(busy), info = await service.read('owner', ref);
    await assert.rejects(service.adopt('owner', { ref, workerId: 'worker', adoptionId: busy, expectedRevision: info.revision }), error => error instanceof NativeAdoptionRejectedError);
    assert.equal(service.leases.get(ref), null);
  }
  const incomplete = fixture(t, false), service = incomplete.make(), pending = await service.read('owner', ref);
  assert.equal(pending.health, 'unknown');
  await assert.rejects(service.adopt('owner', { ref, workerId: 'worker', adoptionId: 'incomplete', expectedRevision: pending.revision }), /不能接管/);
  const f = fixture(t), routed = f.make(), original = await routed.read('owner', ref);
  writeFileSync(join(f.home, '.codex', 'config.toml'), 'model_provider="intentional-gateway"\n');
  await assert.rejects(routed.adopt('owner', { ref, workerId: 'worker', adoptionId: 'provider', expectedRevision: original.revision }), /供应商/);
  writeFileSync(join(f.home, '.codex', 'config.toml'), 'model_provider="openai"\n');
  appendFileSync(f.path, JSON.stringify({ type: 'event_msg', payload: { type: 'token_count' } }) + '\n');
  await assert.rejects(routed.adopt('owner', { ref, workerId: 'worker', adoptionId: 'changed', expectedRevision: original.revision }), /发生变化/);
});

test('users cannot read or claim another user lease, and two workers cannot simultaneously acquire the same revision', async t => {
  const f = fixture(t), service = f.make(), info = await service.read('owner', ref);
  const attempts = await Promise.allSettled(['one', 'two'].map(workerId => service.adopt('owner', { ref, workerId, adoptionId: workerId, expectedRevision: info.revision })));
  assert.equal(attempts.filter(item => item.status === 'fulfilled').length, 1);
  await assert.rejects(service.read('other', ref), /其他用户/);
  assert.deepEqual((await service.list({ agent: 'codex', userId: 'other' })).sessions, []);
  await assert.rejects(service.assertRunOwnership(ref, 'other', 'one'), /持有/);
});

test('handoff can be reversed for the same user without deleting history or allowing the old holder to run', async t => {
  const f = fixture(t), service = f.make(), info = await service.read('owner', ref);
  await service.adopt('owner', { ref, workerId: 'old-worker', adoptionId: 'first', expectedRevision: info.revision }); service.leases.release(ref);
  const updated = await service.read('owner', ref);
  const next = await service.adopt('owner', { ref, workerId: 'new-worker', adoptionId: 'reverse', expectedRevision: updated.revision });
  assert.equal(next.nativeId, nativeId); assert.equal(next.leaseRevision, 3);
  await assert.rejects(service.assertRunOwnership(ref, 'owner', 'old-worker'), /另一 worker/);
  await service.assertRunOwnership(ref, 'owner', 'new-worker');
});

test('the current adoption placeholder is skipped precisely but genuine blocked bridge work is never cleared', async t => {
  const f = fixture(t), service = f.make(), before = await service.read('owner', ref);
  const db = new DatabaseSync(join(f.data, 'controller.sqlite'));
  db.exec('CREATE TABLE controller_workers(value_json TEXT); CREATE TABLE controller_jobs(worker_id TEXT,status TEXT)');
  db.prepare('INSERT INTO controller_workers VALUES(?)').run(JSON.stringify({ id: 'placeholder', agent: 'codex', nativeId, origin: { userId: 'owner' }, cwd: f.cwd, blocked: true, adoption: { id: 'claim', status: 'pending' } }));
  const adopted = await service.adopt('owner', { ref, workerId: 'placeholder', adoptionId: 'claim', expectedRevision: before.revision });
  assert.equal(adopted.workerId, 'placeholder');
  db.prepare('UPDATE controller_workers SET value_json=?').run(JSON.stringify({ id: 'actual-blocked-worker', agent: 'codex', nativeId, origin: { userId: 'owner' }, cwd: f.cwd, blocked: true })); db.close();
  assert.equal((await service.read('owner', ref)).health, 'incompatible');
});

test('bounded history does not spill transcripts into list output or exceed 32 KiB', async t => {
  const f = fixture(t), service = f.make();
  for (let i = 0; i < 30; i++) appendFileSync(f.path, JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ text: '中文'.repeat(4000) }] } }) + '\n');
  appendFileSync(f.path, JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } }) + '\n');
  const read = await service.read('owner', ref, { limit: 20 });
  assert.ok(read.truncated); assert.ok(read.messages.length <= 20); assert.ok(read.messages.every(message => message.text.length <= 3000));
  assert.ok(Buffer.byteLength(read.messages.map(message => message.text).join('')) <= 32 * 1024);
  assert.equal('messages' in (await service.list({ agent: 'codex', userId: 'owner' })).sessions[0]!, false);
});

test('single-message clipping and an incomplete transcript are reported without splitting Unicode characters', async t => {
  const f = fixture(t), service = f.make();
  const longText = 'x'.repeat(2999) + '😀' + 'rest'.repeat(800);
  appendFileSync(f.path, JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ text: longText }] } }) + '\n');
  appendFileSync(f.path, JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } }) + '\n');
  const clipped = await service.read('owner', ref);
  assert.equal(clipped.truncated, true); assert.equal(clipped.messages.at(-1)!.text, 'x'.repeat(2999));
  assert.equal(/[\uD800-\uDFFF]/u.test(clipped.messages.at(-1)!.text), false);
  const short = fixture(t), shortService = short.make();
  assert.equal((await shortService.read('owner', ref)).truncated, false);
  appendFileSync(short.path, '{"type":"unfinished');
  assert.equal((await shortService.read('owner', ref)).truncated, true);
});

test('the UTF-8 preview budget does not introduce replacement or split surrogate characters', async t => {
  const f = fixture(t), service = f.make();
  for (let i = 0; i < 8; i++) appendFileSync(f.path, JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ text: '😀'.repeat(1400) }] } }) + '\n');
  appendFileSync(f.path, JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } }) + '\n');
  const read = await service.read('owner', ref, { limit: 20 });
  assert.equal(read.truncated, true); assert.ok(read.messages.every(message => !/[\uD800-\uDFFF]/u.test(message.text) && !message.text.includes('\uFFFD')));
  assert.ok(Buffer.byteLength(read.messages.map(message => message.text).join('')) <= 32 * 1024);
});

test('Claude exact project index reads an existing native session without spawning a CLI or losing profile scope', async t => {
  const f = fixture(t), directory = join(f.home, '.claude', 'projects', 'known-project'); mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, `${nativeId}.jsonl`), [
    { type: 'user', sessionId: nativeId, cwd: f.cwd, version: '2.1.283', message: { content: 'existing Claude task' } },
    { type: 'assistant', sessionId: nativeId, cwd: f.cwd, message: { model: 'configured-alias-route', stop_reason: 'end_turn', content: [{ type: 'text', text: 'result' }] } },
  ].map(row => JSON.stringify(row)).join('\n'));
  const service = new NativeSessionService(f.data, { claude: { agentCommand: { command: process.execPath, args: [] }, defaultCwd: f.cwd } }, { userHome: f.home, env: {}, busyProbe: async () => ({ status: 'clear', evidence: [] }) });
  f.services.push(service);
  const info = await service.read('owner', { agent: 'claude', profile: 'default', nativeId });
  assert.equal(info.health, 'healthy'); assert.equal(info.model, null); assert.equal(info.actualModel, 'configured-alias-route'); assert.equal(info.effort, null);
  await assert.rejects(service.read('owner', { agent: 'claude', profile: 'arbitrary-path' as 'default', nativeId }), /引用/);
});

test('remote reverse adoption changes the legacy session binding atomically and preserves dispatch history', async t => {
  const f = fixture(t), store = new RemoteStore(join(f.root, 'remote-store')); f.resources.push(() => store.close());
  store.create({ dispatchId: 'old-dispatch', workerId: 'old-worker', userId: 'owner', agent: 'codex', agentCommand: { command: process.execPath, args: [] }, nativeId, cwd: f.cwd, text: 'old', imagePaths: [], model: null, acceptSupplements: true });
  store.update('old-dispatch', { status: 'completed', stopped: true }); store.bindSession(nativeId, 'old-worker', 'codex', f.cwd, 'owner'); store.handoff(nativeId);
  const service = new NativeSessionService(join(f.root, 'remote-store'), { codex: { agentCommand: { command: process.execPath, args: [] }, defaultCwd: f.cwd } }, { userHome: f.home, env: {}, leaseStore: store.nativeLeases, busyProbe: async () => ({ status: 'clear', evidence: [] }), legacyOwnership: r => store.nativeOwnership(r), rebind: (r, user, worker, cwd) => store.adoptSession(r, user, worker, cwd) });
  const info = await service.read('owner', ref); await service.adopt('owner', { ref, workerId: 'new-worker', adoptionId: 'reverse', expectedRevision: info.revision });
  assert.equal(store.session(nativeId)!.worker, 'new-worker'); assert.equal(store.session(nativeId)!.ownership, 'bridge');
  assert.ok(store.job('old-dispatch')); assert.throws(() => store.bindSession(nativeId, 'old-worker', 'codex', f.cwd, 'owner'), /归属/);
  assert.throws(() => store.bindSession(nativeId, 'new-worker', 'codex', f.cwd, 'other'), /归属/);
});

test('Windows exact-file holder probe distinguishes an unrelated Node process from a held transcript', { skip: process.platform !== 'win32' }, async t => {
  const f = fixture(t);
  assert.equal((await probeNativeFileHolders(f.path)).status, 'clear');
  const fd = openSync(f.path, 'r+');
  try { const result = await probeNativeFileHolders(f.path); assert.equal(result.status, 'busy'); assert.ok(result.evidence.length); }
  finally { closeSync(fd); }
});

test('local catalog uses the same adoption API and lease wrapper, keeps adopted native ID and refuses the old holder', async t => {
  const f = fixture(t), service = f.make(), runs: string[] = [];
  const adapter: AgentAdapter = { async run(turn) { runs.push(turn.conversation.id); turn.onNativeId?.(nativeId); return { nativeId, text: 'mock result' }; }, async interrupt() {}, async close() {} };
  const config: BridgeConfig = { token: '', allowedUserIds: ['owner', 'other'], defaultAgent: 'codex', controllerMode: true, workspace: f.cwd,
    proxyUrl: null, commands: { codex: { command: process.execPath, args: [] }, claude: { command: process.execPath, args: [] } }, dataDir: f.data, attachmentsDir: f.data, logsDir: f.data, maxImageBytes: 100 };
  const catalog = new TargetCatalogService(config, { codex: adapter, claude: adapter }, { nativeSessions: service });
  const binding = await catalog.resolveTarget(f.cwd, 'local', 'codex');
  await catalog.authorizeNativeAccess(f.cwd, 'owner', 'local'); await assert.rejects(catalog.authorizeNativeAccess(f.cwd, 'other', 'local'), /权限/);
  const before = await catalog.readNativeSession(binding, 'owner', ref);
  const adopted = await catalog.adoptNativeSession(binding, 'owner', { ref, workerId: 'adopted-worker', adoptionId: 'catalogue-claim', expectedRevision: before.revision });
  const conversation = { id: 'adopted-worker', userId: 'owner', agent: 'codex' as const, nativeId: adopted.nativeId, model: adopted.model, effort: adopted.effort, title: adopted.title, cwd: adopted.cwd, createdAt: '', updatedAt: '' };
  const turn = { conversation, text: 'new authorized instruction', imagePaths: [], signal: new AbortController().signal, onProgress() {} };
  await catalog.adapterFor(binding).run(turn); assert.deepEqual(runs, ['adopted-worker']);
  await catalog.handoff(binding, nativeId, f.cwd, 'codex');
  await assert.rejects(catalog.adapterFor(binding).run(turn), /交给用户/); assert.equal(runs.length, 1);
  const overview = await catalog.computerOverview(f.cwd, true); assert.equal(overview[0]!.connection, 'connected'); assert.equal(overview[0]!.agents[0]!.cli, 'ready');
  await catalog.close();
});

test('catalog explicitly registered native-history access is distinct from the general bot whitelist', async t => {
  const f = fixture(t), service = f.make();
  const config: BridgeConfig = { token: '', allowedUserIds: ['owner', 'friend'], defaultAgent: 'codex', workspace: f.cwd,
    proxyUrl: null, commands: { codex: { command: process.execPath, args: [] }, claude: { command: process.execPath, args: [] } }, dataDir: f.data, attachmentsDir: f.data, logsDir: f.data, maxImageBytes: 100 };
  const adapter: AgentAdapter = { async run() { throw new Error('No model is allowed in this test.'); }, async interrupt() {}, async close() {} };
  writeFileSync(join(f.cwd, 'agents.json'), JSON.stringify({ version: 1, targets: [{ id: 'workstation', label: 'test', expectedHostname: 'TEST', sshConfig: join(f.root, 'ssh_config'), alias: 'test', remoteRoot: f.root, nodePath: process.execPath, engines: { codex: { agentCommand: { command: process.execPath, args: [] }, defaultCwd: f.cwd } }, allowedUserIds: ['friend'] }] }));
  const catalog = new TargetCatalogService(config, { codex: adapter, claude: adapter }, { nativeSessions: service });
  await catalog.authorizeNativeAccess(f.cwd, 'friend', 'workstation');
  await assert.rejects(catalog.authorizeNativeAccess(f.cwd, 'owner', 'workstation'), /权限/);
  await assert.rejects(catalog.authorizeNativeAccess(f.cwd, 'friend', 'local'), /权限/);
  await catalog.close();
});

test('remote catalog forwards native list/read/adopt over the existing authenticated executor and resumes the exact original ID', async t => {
  const f = fixture(t), runs: string[] = [];
  const command = { command: process.execPath, args: [] };
  const daemon = new RemoteDaemon(f.root, { version: 1, expectedHostname: hostname(), engines: { codex: { agentCommand: command, defaultCwd: f.cwd } } }, {
    nativeSessionOptions: { userHome: f.home, busyProbe: async () => ({ status: 'clear', evidence: [] }) },
    adapterFactory: () => ({ async run(turn) { assert.equal(turn.conversation.nativeId, nativeId); runs.push(turn.text); turn.onNativeId?.(nativeId); return { nativeId, text: 'synthetic completion' }; }, async interrupt() {}, async close() {} }),
  });
  f.resources.push(() => daemon.close());
  const config: BridgeConfig = { token: '', allowedUserIds: ['owner'], defaultAgent: 'codex', workspace: f.cwd, proxyUrl: null,
    commands: { codex: command, claude: command }, dataDir: f.data, attachmentsDir: f.data, logsDir: f.data, maxImageBytes: 100 };
  writeFileSync(join(f.cwd, 'agents.json'), JSON.stringify({ version: 1, targets: [{ id: 'workstation', label: 'test', expectedHostname: hostname(), sshConfig: join(f.root, 'ssh_config'), alias: 'test', remoteRoot: f.root, nodePath: process.execPath, engines: { codex: { agentCommand: command, defaultCwd: f.cwd } } }] }));
  const noop: AgentAdapter = { async run() { throw new Error('Local model execution is forbidden in this test.'); }, async interrupt() {}, async close() {} };
  const service = f.make();
  const catalog = new TargetCatalogService(config, { codex: noop, claude: noop }, { nativeSessions: service, clientFactory: () => ({ request: (method, args) => daemon.handle(method, args) as Promise<any>, async close() {} }), pollMs: 1 });
  f.resources.unshift(() => catalog.close());
  const binding = await catalog.resolveTarget(f.cwd, 'workstation', 'codex');
  await catalog.authorizeNativeAccess(f.cwd, 'owner', 'workstation');
  const listed = await catalog.listNativeSessions(binding, 'owner', {}); assert.equal(listed.sessions.length, 1);
  const info = await catalog.readNativeSession(binding, 'owner', ref);
  const adopted = await catalog.adoptNativeSession(binding, 'owner', { ref, workerId: 'remote-worker', adoptionId: 'remote-adopt', expectedRevision: info.revision });
  assert.equal(adopted.nativeId, nativeId); assert.deepEqual(runs, []);
  const adapter = catalog.adapterFor(binding) as RemoteAgentAdapter;
  await adapter.run({ conversation: { id: 'remote-worker', userId: 'owner', agent: 'codex', nativeId, model: null, cwd: f.cwd, title: 'synthetic', createdAt: '', updatedAt: '' },
    text: 'synthetic follow-up', imagePaths: [], signal: new AbortController().signal, dispatchId: 'new-dispatch', onProgress() {} });
  assert.deepEqual(runs, ['synthetic follow-up']);
  const overview = await catalog.computerOverview(f.cwd, true); assert.equal(overview[1]!.connection, 'connected'); assert.equal(overview[1]!.agents[0]!.cli, 'ready');
  await assert.rejects(daemon.handle('sessions/read', { userId: 'other', ref }), /其他用户/);
  await assert.rejects(daemon.handle('sessions/list', { userId: 'other', agent: 'codex', query: { userId: 'owner' } }).then(value => { assert.equal((value as any).sessions.length, 0); throw new Error('checked-empty'); }), /checked-empty/);
});
