import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { connect } from 'node:net';
import type { AgentAdapter, AgentResult, AgentSupplement, AgentTurn, BridgeConfig, SteerResult } from '../src/types.js';
import { RemoteDaemon, remoteEndpoint } from '../src/remote/daemon.js';
import { RemoteAgentAdapter } from '../src/remote/adapter.js';
import { RemoteDispatchUncertain, RemoteArtifactTransferError, type ExecutionTargetBinding, type RemoteClient, type RemoteDaemonConfig, type RemoteDispatch, type RemoteJob } from '../src/remote/types.js';
import { AgentProcessStopError, completedResultFromError } from '../src/agents/process.js';
import { RemoteStore } from '../src/remote/store.js';
import { PresetRuntime, PresetResultUnknown } from '../src/presets/runtime.js';
import { collectOutgoingAttachments } from '../src/artifacts.js';

const tick = async () => { await new Promise<void>(resolve => setImmediate(resolve)); };
class FakeNative implements AgentAdapter {
  turn: AgentTurn | null = null;
  resolve!: (result: AgentResult) => void;
  reject!: (error: Error) => void;
  supplements: AgentSupplement[] = [];
  interrupts = 0;
  refuseStop = false;
  nativeId: string = randomUUID();
  async run(turn: AgentTurn): Promise<AgentResult> {
    this.turn = turn; this.nativeId = turn.conversation.nativeId ?? this.nativeId;
    turn.onNativeId?.(this.nativeId); turn.onModel?.('actual-model'); turn.onReasoningEffort?.('medium');
    turn.onEffortConfiguration?.({ value: 'high', source: 'user-settings' });
    turn.onEffortMetadata?.({ requested: null, actual: 'medium', configuration: { value: 'high', source: 'user-settings' }, capability: { status: 'supported', levels: ['low', 'medium', 'high'], source: 'remote-native-fixture', modelId: 'actual-model' } }); turn.onReady?.();
    return new Promise((resolve, reject) => { this.resolve = resolve; this.reject = reject; });
  }
  async steer(_id: string, input: AgentSupplement): Promise<SteerResult> { this.supplements.push(input); return { status: 'accepted' }; }
  finish(text = '完成') { this.resolve({ nativeId: this.nativeId, text }); }
  async interrupt(): Promise<void> { this.interrupts++; if (this.refuseStop) throw new Error('stop unconfirmed'); this.reject(new Error('native terminated')); }
  async close(): Promise<void> {}
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'bridge-remote-test-')); const natives: FakeNative[] = [];
  const command = { command: process.execPath, args: [] };
  const daemonConfig: RemoteDaemonConfig = { version: 1, expectedHostname: hostname(), engines: { codex: { agentCommand: command, defaultCwd: root }, claude: { agentCommand: command, defaultCwd: root } } };
  const daemon = new RemoteDaemon(root, daemonConfig, { adapterFactory: () => { const native = new FakeNative(); natives.push(native); return native; } });
  const config: BridgeConfig = { token: 'unused', allowedUserIds: ['user'], defaultAgent: 'codex', workspace: root, proxyUrl: null, commands: { codex: command, claude: command },
    dataDir: join(root, 'local-data'), attachmentsDir: root, logsDir: root, maxImageBytes: 20 * 1024 * 1024, maxFileBytes: 24 * 1024 * 1024 };
  const binding: ExecutionTargetBinding = { id: 'station', label: '工位', transport: 'ssh', expectedHostname: hostname(), sshConfig: join(root, 'ssh-config'), alias: 'station', remoteRoot: root, nodePath: process.execPath, agent: 'codex', agentCommand: command, cwd: root };
  let disconnect = false; const calls: string[] = [];
  const client: RemoteClient = { request: async <T>(method: string, args: unknown) => { calls.push(method); if (disconnect) throw new Error('SSH connection lost'); return await daemon.handle(method, args) as T; }, close: async () => {} };
  const adapter = new RemoteAgentAdapter(binding, config, { clientFactory: () => client, pollMs: 2, reconnectDeadlineMs: 25, reconnectDelayMs: 1 });
  const request = (patch: Partial<RemoteDispatch> = {}): RemoteDispatch => ({ dispatchId: randomUUID(), workerId: randomUUID(), userId: 'owner', agent: 'codex', agentCommand: command,
    nativeId: null, cwd: root, text: '检查隔离目录', imagePaths: [], model: null, acceptSupplements: true, ...patch });
  const turn = (dispatchId = randomUUID()): AgentTurn => ({ dispatchId, conversation: { id: randomUUID(), userId: 'owner', agent: 'codex', nativeId: null,
    cwd: root, title: 'remote', createdAt: 'now', updatedAt: 'now' }, text: '检查隔离目录', imagePaths: [], acceptSupplements: true, signal: new AbortController().signal, onProgress: () => {} });
  return { root, daemon, natives, config, binding, adapter, request, turn, calls, disconnect: () => { disconnect = true; } };
}

test('remote dispatch is durable, deduplicated and serial per worker while other workers run concurrently', async () => {
  const f = fixture();
  try {
    const a = f.request(); const first = await f.daemon.handle('dispatch', a) as RemoteJob; await tick();
    assert.equal(first.status, 'running'); assert.equal(f.natives.length, 1);
    const repeated = await f.daemon.handle('dispatch', a) as RemoteJob;
    assert.equal(repeated.dispatchId, a.dispatchId); assert.equal(f.natives.length, 1);
    await assert.rejects(f.daemon.handle('dispatch', { ...a, text: 'changed' }), /冲突/);
    await assert.rejects(f.daemon.handle('dispatch', f.request({ workerId: a.workerId })), /并发续接/);
    const b = f.request(); await f.daemon.handle('dispatch', b); await tick(); assert.equal(f.natives.length, 2);
    f.natives[0]!.finish('第一轮'); f.natives[1]!.finish('另一个任务'); await tick(); await tick();
    const result = f.daemon.store.job(a.dispatchId)!; assert.equal(result.status, 'completed'); assert.equal(result.result?.text, '第一轮');
    const next = f.request({ workerId: a.workerId, nativeId: result.nativeId }); await f.daemon.handle('dispatch', next); await tick();
    assert.equal(f.natives[2]!.turn!.conversation.nativeId, result.nativeId); f.natives[2]!.finish('续接'); await tick(); await tick();
    assert.equal(f.daemon.store.job(next.dispatchId)!.nativeId, result.nativeId);
  } finally { await f.daemon.close(); }
});

test('supplements have idempotent native receipts and conflicting content is rejected', async () => {
  const f = fixture();
  try {
    const a = f.request(); await f.daemon.handle('dispatch', a); await tick();
    const supplement = { dispatchId: a.dispatchId, id: randomUUID(), input: [{ type: 'text', text: '补充 CPU' }] };
    const [one, two] = await Promise.all([f.daemon.handle('steer', supplement), f.daemon.handle('steer', supplement)]);
    assert.deepEqual(one, { status: 'accepted' }); assert.deepEqual(two, { status: 'accepted' }); assert.equal(f.natives[0]!.supplements.length, 1);
    assert.deepEqual(await f.daemon.handle('steer', supplement), { status: 'accepted' });
    await assert.rejects(f.daemon.handle('steer', { ...supplement, input: [{ type: 'text', text: 'other' }] }), /冲突/);
    f.natives[0]!.finish(); await tick(); await tick();
    assert.equal((await f.daemon.handle('steer', { ...supplement, id: randomUUID() }) as SteerResult).status, 'queued');
  } finally { await f.daemon.close(); }
});

test('remote cancellation waits for the native process and a refused stop never returns stopped', async () => {
  const f = fixture();
  try {
    const a = f.request(); await f.daemon.handle('dispatch', a); await tick(); f.natives[0]!.refuseStop = true;
    await assert.rejects(f.daemon.handle('interrupt', { dispatchId: a.dispatchId }), /unconfirmed/);
    assert.equal(f.daemon.store.job(a.dispatchId)!.status, 'running');
    f.natives[0]!.refuseStop = false; assert.deepEqual(await f.daemon.handle('interrupt', { dispatchId: a.dispatchId }), { stopped: true });
    assert.equal(f.daemon.store.job(a.dispatchId)!.status, 'cancelled'); assert.equal(f.daemon.store.job(a.dispatchId)!.stopped, true);
  } finally { await f.daemon.close(); }
});

test('handoff confirms owned CLI termination and prevents bridge resuming the user-owned native session', async () => {
  const f = fixture();
  try {
    const a = f.request(); await f.daemon.handle('dispatch', a); await tick(); const nativeId = f.natives[0]!.nativeId;
    assert.deepEqual(await f.daemon.handle('handoff', { nativeId, cwd: f.root, agent: 'codex' }), { nativeId, stopped: true });
    assert.equal(f.natives[0]!.interrupts, 1); assert.equal(f.daemon.store.session(nativeId)!.ownership, 'user');
    await assert.rejects(f.daemon.handle('dispatch', f.request({ workerId: a.workerId, nativeId })), /交给用户/);
  } finally { await f.daemon.close(); }
});

test('client connection loss does not cancel the hosted CLI, and recovering follows only the existing dispatch', async () => {
  const f = fixture();
  try {
    const turn = f.turn(); const run = f.adapter.run(turn); await tick(); await tick();
    assert.equal(f.natives.length, 1); f.disconnect(); await assert.rejects(run, RemoteDispatchUncertain);
    assert.equal(f.daemon.store.job(turn.dispatchId!)!.status, 'running'); assert.equal(f.natives[0]!.interrupts, 0);
    f.natives[0]!.finish('断线后完成'); await tick(); await tick();
    const calls: string[] = []; const reconnected = new RemoteAgentAdapter(f.binding, f.config, { pollMs: 2, clientFactory: () => ({ request: async <T>(method: string, args: unknown) => { calls.push(method); return await f.daemon.handle(method, args) as T; }, close: async () => {} }) });
    assert.equal((await reconnected.run({ ...turn, recovering: true })).text, '断线后完成'); assert.ok(!calls.includes('dispatch')); assert.ok(!calls.includes('upload')); assert.equal(f.natives.length, 1);
    await assert.rejects(reconnected.run({ ...f.turn(), recovering: true }), /未在目标电脑登记/); assert.equal(f.natives.length, 1); await reconnected.close();
  } finally { await f.adapter.close(); await f.daemon.close(); }
});

test('image upload keeps input order; declared remote files are downloaded and usable by the ordinary bridge collector', async () => {
  const f = fixture();
  try {
    const image = join(f.root, 'incoming.png'); writeFileSync(image, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2]));
    const turn = f.turn(); turn.imagePaths = [image]; turn.input = [{ type: 'text', text: '先看' }, { type: 'localImage', path: image }, { type: 'text', text: '然后回答' }];
    let nativeReady = false; turn.onReady = () => { nativeReady = true; };
    const pending = f.adapter.run(turn), readyDeadline = Date.now() + 5000;
    while (!nativeReady) { assert.ok(Date.now() < readyDeadline, '远端原生适配器未在期限内就绪'); await tick(); }
    const native = f.natives[0]!; assert.ok(native); assert.deepEqual(native.turn!.input!.map(item => item.type), ['text', 'localImage', 'text']);
    const remotePath = native.turn!.imagePaths[0]!; assert.notEqual(remotePath, image); assert.deepEqual(readFileSync(remotePath), readFileSync(image));
    const report = join(f.root, 'report.csv'); writeFileSync(report, 'item,count\nCPU,2\n');
    native.finish(`查到了。\n[报告](<${report}>)\n![图片](<${remotePath}>)`);
    const result = await pending;
    assert.ok(result.text.includes(join(f.config.dataDir, 'outgoing', 'remote'))); assert.ok(!result.text.includes(`<${report}>`));
    const collected = await collectOutgoingAttachments(result.text, f.config.dataDir, f.config.maxImageBytes, f.config.maxFileBytes);
    assert.equal(collected.files.length, 1); assert.equal(collected.images.length, 1); assert.equal(Buffer.from(collected.files[0]!.data).toString(), 'item,count\nCPU,2\n');
  } finally { await f.adapter.close(); await f.daemon.close(); }
});

test('daemon recovery marks unknown work without replay; a duplicate live daemon cannot mutate running status', async () => {
  const f = fixture();
  try {
    await f.daemon.listen(); const a = f.request(); await f.daemon.handle('dispatch', a); await tick();
    const second = new RemoteDaemon(f.root, f.daemon.config); await assert.rejects(second.listen());
    assert.equal(f.daemon.store.job(a.dispatchId)!.status, 'running'); second.store.close();
    f.natives[0]!.finish(); await tick(); await tick();
  } finally { await f.daemon.close(); }
  const dir = mkdtempSync(join(tmpdir(), 'bridge-remote-recovery-')); const store = new RemoteStore(join(dir, '.local', 'remote'));
  const request = { ...f.request(), cwd: dir }; store.create(request); store.close();
  const recovered = new RemoteDaemon(dir, f.daemon.config, { adapterFactory: () => { throw new Error('must not execute'); } });
  try { await recovered.listen(); assert.equal(recovered.store.job(request.dispatchId)!.status, 'uncertain'); await assert.rejects(recovered.handle('dispatch', { ...request, dispatchId: randomUUID() }), /未知/); }
  finally { await recovered.close(); }
});

test('IPC disconnect leaves task running and unauthorized local requests cannot dispatch', async () => {
  const f = fixture();
  try {
    await f.daemon.listen(); const token = readFileSync(join(f.daemon.dataDirectory, 'ipc-token'), 'utf8').trim(); const a = f.request();
    const socket = connect(remoteEndpoint(f.root)); socket.setEncoding('utf8');
    await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
    const reply = new Promise<string>(resolve => socket.once('data', resolve)); socket.write(`${JSON.stringify({ id: '1', method: 'dispatch', args: a, token })}\n`);
    assert.equal(JSON.parse(await reply).result.dispatchId, a.dispatchId); socket.destroy(); await tick(); assert.equal(f.daemon.store.job(a.dispatchId)!.status, 'running');
    const intruder = connect(remoteEndpoint(f.root)); await new Promise<void>(resolve => intruder.once('connect', resolve));
    const closed = new Promise<void>(resolve => intruder.once('close', () => resolve())); intruder.write(`${JSON.stringify({ id: '2', method: 'dispatch', args: f.request(), token: 'wrong' })}\n`); await closed;
    assert.equal(f.natives.length, 1); f.natives[0]!.finish(); await tick(); await tick();
  } finally { await f.daemon.close(); }
});

test('upload chunks are validated and safe duplicate chunks do not append or accept changed bytes', async () => {
  const f = fixture();
  try {
    const bytes = Buffer.from('fixture-image'); const request = { sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length, filename: 'a.png', offset: 0, data: bytes.toString('base64') };
    const one = await f.daemon.handle('upload', request); assert.deepEqual(await f.daemon.handle('upload', request), one);
    await assert.rejects(f.daemon.handle('upload', { ...request, data: Buffer.from('changed').toString('base64') }), /冲突/);
    await assert.rejects(f.daemon.handle('upload', { ...request, filename: 'a.exe' }), /图片/);
    await assert.rejects(f.daemon.handle('artifact', { dispatchId: randomUUID(), artifactId: randomUUID(), offset: 0 }), /没有/);
  } finally { await f.daemon.close(); }
});

test('lost dispatch acknowledgement reconnects to the same job and never submits again', { timeout: 10_000 }, async () => {
  const f = fixture(); let connections = 0; const methods: string[] = [];
  let reattached!: (job: RemoteJob) => void;
  const reattachment = new Promise<RemoteJob>(resolve => { reattached = resolve; });
  const adapter = new RemoteAgentAdapter(f.binding, f.config, { pollMs: 2, reconnectDeadlineMs: 5000, reconnectDelayMs: 1, clientFactory: () => {
    const number = ++connections;
    return { request: async <T>(method: string, args: unknown) => {
      methods.push(`${number}:${method}`);
      if (number === 1 && method === 'dispatch') { await f.daemon.handle(method, args); throw new Error('lost ack'); }
      if (number === 1 && method === 'query') throw new Error('disconnected');
      const result = await f.daemon.handle(method, args);
      if (number === 2 && method === 'query') reattached(result as RemoteJob);
      return result as T;
    }, close: async () => {} };
  } });
  try {
    const turn = f.turn(); const pending = adapter.run(turn);
    const observed = await Promise.race([reattachment, pending.then(() => { throw new Error('completed without reattachment'); })]);
    assert.equal(observed.dispatchId, turn.dispatchId); assert.equal(observed.workerId, turn.conversation.id); assert.equal(observed.status, 'running'); await tick();
    assert.equal(f.natives.length, 1); assert.equal(connections, 2); f.natives[0]!.finish('已跟回原派发');
    assert.equal((await pending).text, '已跟回原派发'); assert.equal(methods.filter(value => value.endsWith(':dispatch')).length, 1);
    assert.ok(methods.some(value => value === '2:query'));
  } finally { await adapter.close(); await f.daemon.close(); }
});

test('cancel during prepare performs no dispatch and cannot start a cancelled task', async () => {
  const f = fixture(); let release!: () => void; const wait = new Promise<void>(resolve => { release = resolve; }); let dispatches = 0;
  const adapter = new RemoteAgentAdapter(f.binding, f.config, { clientFactory: () => ({ request: async <T>(method: string, args: unknown) => {
    if (method === 'hello') await wait; if (method === 'dispatch') dispatches++;
    return await f.daemon.handle(method, args) as T;
  }, close: async () => {} }) });
  try {
    const turn = f.turn(); const pending = adapter.run(turn); await tick(); await adapter.interrupt(turn.conversation.id); release();
    await assert.rejects(pending, /尚未派发/); assert.equal(dispatches, 0); assert.equal(f.natives.length, 0);
  } finally { release(); await adapter.close(); await f.daemon.close(); }
});

test('terminal completion is not visible until native close confirms exit', async () => {
  const f = fixture(); let release!: () => void; const closed = new Promise<void>(resolve => { release = resolve; });
  try {
    const request = f.request(); await f.daemon.handle('dispatch', request); await tick(); f.natives[0]!.close = async () => closed;
    f.natives[0]!.finish('生成完成'); await tick(); await tick();
    assert.equal(f.daemon.store.job(request.dispatchId)!.status, 'running'); assert.notEqual(f.daemon.store.job(request.dispatchId)!.stopped, true);
    assert.equal(f.daemon.store.job(request.dispatchId)!.result?.text, '生成完成', 'save report before waiting for close');
    release(); await tick(); await tick(); assert.equal(f.daemon.store.job(request.dispatchId)!.status, 'completed'); assert.equal(f.daemon.store.job(request.dispatchId)!.stopped, true);
  } finally { release(); await f.daemon.close(); }
});

test('a native close failure preserves uncertain result and blocks further continuation', async () => {
  const f = fixture();
  try {
    const request = f.request(); await f.daemon.handle('dispatch', request); await tick(); f.natives[0]!.close = async () => { throw new Error('CLI still alive'); };
    f.natives[0]!.finish(); await tick(); await tick(); const old = f.daemon.store.job(request.dispatchId)!;
    assert.equal(old.status, 'uncertain'); assert.equal(old.stopped, false);
    assert.equal(old.result?.text, '完成'); assert.equal(old.result?.nativeId, f.natives[0]!.nativeId);
    await assert.rejects(f.daemon.handle('dispatch', f.request({ workerId: request.workerId, nativeId: old.nativeId })), /结果未知/);
  } finally { await f.daemon.close(); }
});

test('query waits for a received dispatch still doing async validation instead of claiming it does not exist', async () => {
  const f = fixture();
  try {
    const request = f.request(); const dispatch = f.daemon.handle('dispatch', request);
    const follow = f.daemon.handle('query', { dispatchId: request.dispatchId });
    const [one, two] = await Promise.all([dispatch, follow]) as RemoteJob[];
    assert.equal(one!.dispatchId, request.dispatchId); assert.equal(two!.dispatchId, request.dispatchId); assert.equal(f.natives.length, 1);
    f.natives[0]!.finish(); await tick(); await tick();
  } finally { await f.daemon.close(); }
});

test('repeated in-flight supplement waits for its original native receipt', async () => {
  const f = fixture(); let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  try {
    const request = f.request(); await f.daemon.handle('dispatch', request); await tick(); let delivered = 0;
    f.natives[0]!.steer = async () => { delivered++; await gate; return { status: 'accepted' }; };
    const input = { dispatchId: request.dispatchId, id: randomUUID(), input: [{ type: 'text', text: '补充' }] };
    const first = f.daemon.handle('steer', input); await tick(); let secondSettled = false;
    const second = f.daemon.handle('steer', input).then(value => { secondSettled = true; return value; }); await tick();
    assert.equal(secondSettled, false); assert.equal(delivered, 1); release();
    assert.deepEqual(await first, { status: 'accepted' }); assert.deepEqual(await second, { status: 'accepted' });
    f.natives[0]!.finish(); await tick(); await tick();
  } finally { release(); await f.daemon.close(); }
});

test('artifact checksum failure retains confirmed native completion instead of claiming a process may still run', async () => {
  const f = fixture(); const adapter = new RemoteAgentAdapter(f.binding, f.config, { pollMs: 2, clientFactory: () => ({ request: async <T>(method: string, args: unknown) => {
    const value = await f.daemon.handle(method, args);
    if (method === 'artifact') return { ...(value as object), data: Buffer.from('wrong data').toString('base64') } as T;
    return value as T;
  }, close: async () => {} }) });
  try {
    const pending = adapter.run(f.turn()); await tick(); await tick(); const path = join(f.root, 'report.txt'); writeFileSync(path, 'correct data');
    f.natives[0]!.finish(`报告\n[文件](<${path}>)`);
    await assert.rejects(pending, error => error instanceof RemoteArtifactTransferError && error.nativeStopped === true && !('processStillRunning' in error));
    assert.equal(f.daemon.store.jobs()[0]!.status, 'completed'); assert.equal(f.daemon.store.jobs()[0]!.stopped, true);
  } finally { await adapter.close(); await f.daemon.close(); }
});

test('confirmStopped only reads the last dispatch and releases no unknown or mismatched task', async () => {
  const f = fixture();
  try {
    const turn = f.turn(); const pending = f.adapter.run(turn); await tick(); await tick();
    const before = f.calls.length; assert.equal(await f.adapter.confirmStopped(turn.conversation.id), false);
    assert.deepEqual(f.calls.slice(before), ['query']); assert.equal(f.natives[0]!.interrupts, 0);
    f.natives[0]!.finish(); await pending; assert.equal(await f.adapter.confirmStopped(turn.conversation.id), true);
    f.daemon.store.update(turn.dispatchId!, { status: 'uncertain', stopped: true });
    const proofStart = f.calls.length; assert.equal(await f.adapter.confirmStopped(turn.conversation.id), true);
    assert.deepEqual(f.calls.slice(proofStart), ['query']); assert.equal(f.daemon.store.job(turn.dispatchId!)!.status, 'uncertain');
    assert.equal(await f.adapter.confirmStopped('someone-else'), false);
    f.disconnect(); assert.equal(await f.adapter.confirmStopped(turn.conversation.id), false); assert.equal(f.natives[0]!.interrupts, 0);
  } finally { await f.adapter.close(); await f.daemon.close(); }
});

test('daemon shutdown closes pending metadata adapters and propagates unconfirmed query CLI exit', async () => {
  const root = mkdtempSync(join(tmpdir(), 'remote-metadata-'));
  let rejectQuery!: (error: Error) => void; const query = new Promise<never>((_resolve, reject) => { rejectQuery = reject; });
  let refuse = true; let closed = 0;
  const adapter: AgentAdapter = { run: async () => { throw new Error('no model generation'); }, interrupt: async () => {},
    getModelInfo: async () => query, close: async () => { closed++; if (refuse) throw new Error('metadata process still running'); rejectQuery(new Error('metadata CLI stopped')); } };
  const daemon = new RemoteDaemon(root, { version: 1, expectedHostname: hostname(), engines: { codex: { agentCommand: { command: process.execPath, args: [] }, defaultCwd: root } } }, { adapterFactory: () => adapter });
  const pending = daemon.handle('models', { agent: 'codex', cwd: root }); const outcome = pending.catch(error => error);
  await tick(); await assert.rejects(daemon.close(), /still running/); assert.equal(closed, 1);
  refuse = false; await daemon.close(); assert.match(String(await outcome), /stopped/); assert.ok(closed >= 2);
});


test('remote native progress is durable and repeated polling never fabricates a fresh activity', async () => {
  const f = fixture();
  try {
    const turn = f.turn(); const activities: unknown[] = []; turn.onActivity = value => activities.push(value);
    const run = f.adapter.run(turn); await tick(); await tick();
    const native = f.natives[0]!;
    native.turn!.onActivity?.({ at: '2026-10-12T10:00:00Z', type: 'tool-started', itemId: 'upload', toolName: 'upload' });
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(activities.length, 1); assert.equal(f.daemon.store.job(turn.dispatchId!)!.progress!.sequence, 1);
    const before = f.daemon.store.job(turn.dispatchId!)!.progress!;
    await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(activities.length, 1);
    assert.deepEqual(f.daemon.store.job(turn.dispatchId!)!.progress, before);
    native.turn!.onActivity?.({ at: '2026-10-12T10:02:00Z', type: 'tool-completed', itemId: 'upload', toolName: 'upload', status: 'completed' });
    await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(activities.length, 2);
    assert.equal((activities[1] as { snapshot: { activeTools: unknown[] } }).snapshot.activeTools.length, 0);
    native.finish(); await run; assert.equal(f.daemon.store.job(turn.dispatchId!)!.progress!.sequence, 2);
    assert.equal(f.calls.filter(value => value === 'dispatch').length, 1); assert.equal(native.interrupts, 0);
  } finally { await f.adapter.close(); await f.daemon.close(); }
});

test('remote launch configuration survives storage and polling separately from native confirmation', async () => {
  const f = fixture();
  try {
    const turn = f.turn(); const configurations: unknown[] = [], actual: unknown[] = [], metadata: unknown[] = [];
    turn.onEffortMetadata = value => metadata.push(value);
    turn.onEffortConfiguration = value => configurations.push(value);
    turn.onReasoningEffort = value => actual.push(value);
    const running = f.adapter.run(turn);
    while (!f.natives.length || !configurations.length) await tick();
    const stored = f.daemon.store.job(turn.dispatchId!)!;
    assert.deepEqual(stored.effortConfiguration, { value: 'high', source: 'user-settings' });
    assert.equal(stored.actualEffort, 'medium');
    assert.deepEqual(stored.effortMetadata, { requested: null, actual: 'medium', configuration: { value: 'high', source: 'user-settings' }, capability: { status: 'supported', levels: ['low', 'medium', 'high'], source: 'remote-native-fixture', modelId: 'actual-model' } });
    assert.deepEqual(metadata.at(-1), stored.effortMetadata);
    f.natives[0]!.finish(); await running;
    assert.deepEqual(configurations, [{ value: 'high', source: 'user-settings' }]);
    assert.deepEqual(actual, ['medium']);
  } finally { await f.daemon.close(); }
});


test('remote preset binding is durable, cannot be removed or moved, and rejects default-home handoff before interruption', async () => {
  const f = fixture();
  try {
    const privateRoot = join(f.root, '.local', 'agent-presets'); mkdirSync(privateRoot, { recursive: true });
    const profile = { id: 'gateway-sol', revision: 1, agent: 'codex' as const, model: 'gpt-6.1-sol', baseUrl: 'https://gateway.example', credentialId: 'gateway', transport: { kind: 'direct' } };
    writeFileSync(join(privateRoot, 'profiles.json'), JSON.stringify({ version: 1, profiles: [profile] }));
    writeFileSync(join(privateRoot, 'credentials.json'), JSON.stringify({ version: 1, credentials: { gateway: { apiKey: 'fixture-secret' } } }));
    const descriptor = await f.daemon.handle('preset/describe', { profileId: profile.id, revision: 1, agent: profile.agent, model: profile.model }) as { fingerprint: string };
    const preset = { id: 'office-sol', targetId: 'station', profileId: profile.id, revision: 1, agent: profile.agent, model: profile.model, fingerprint: descriptor.fingerprint };
    const a = f.request({ preset, model: preset.model });
    // The native test seam skips launching; create the persistent home as the real wrapper does.
    const runtime = new PresetRuntime(privateRoot, f.daemon.dataDirectory, join(f.root, 'isolated-user'));
    await (await runtime.prepare(preset, a.workerId, null, a.agentCommand, {})).close();
    await f.daemon.handle('dispatch', a); await tick();
    assert.deepEqual(f.daemon.store.request(a.dispatchId)!.preset, preset);
    const nativeId = f.natives[0]!.nativeId;
    await assert.rejects(f.daemon.handle('handoff', { nativeId, agent: a.agent, cwd: a.cwd }), /预设/);
    assert.equal(f.natives[0]!.interrupts, 0); f.natives[0]!.finish(); await tick(); await tick();
    await assert.rejects(f.daemon.handle('dispatch', f.request({ workerId: a.workerId, nativeId, model: preset.model })), /预设线路/);
    await assert.rejects(f.daemon.handle('dispatch', f.request({ workerId: a.workerId, nativeId, model: preset.model, preset: { ...preset, id: 'other' } })), /预设线路/);
    profile.baseUrl = 'https://new.example'; writeFileSync(join(privateRoot, 'profiles.json'), JSON.stringify({ version: 1, profiles: [profile] }));
    const next = f.request({ workerId: a.workerId, nativeId, preset, model: preset.model });
    await f.daemon.handle('dispatch', next); await tick(); assert.equal(f.natives[1]!.turn!.conversation.nativeId, nativeId);
    f.natives[1]!.finish(); await tick(); await tick();
    await assert.rejects(f.daemon.handle('dispatch', f.request({ preset, model: preset.model })), /配置已改变/);
  } finally { await f.daemon.close(); }
});
test('old executors reject preset discovery and dispatch instead of silently running a default model', async () => {
  const f = fixture(), calls: string[] = [];
  const binding = { ...f.binding, preset: { id: 'sol', targetId: 'station', profileId: 'sol', revision: 1, agent: 'codex' as const, model: 'gpt-6.1-sol', fingerprint: 'a'.repeat(64) } };
  const adapter = new RemoteAgentAdapter(binding, f.config, { clientFactory: () => ({ request: async <T>(method: string) => { calls.push(method); return { version: 1, hostname: hostname(), engines: ['codex'] } as T; }, close: async () => {} }) });
  try { await assert.rejects(adapter.getModelInfo(f.root), /不支持预设协议/); assert.deepEqual(calls, ['hello']); }
  finally { await adapter.close(); await f.daemon.close(); }
});


test('remote visibility is transported and frozen; malformed input and old executors cannot silently ignore it', async () => {
  const f = fixture();
  try {
    assert.equal((await f.daemon.handle('hello', {}) as { sessionVisibility: number }).sessionVisibility, 1);
    await assert.rejects(f.daemon.handle('dispatch', { ...f.request(), sessionVisibility: false }), /sessionVisibility/);
    const a = f.request({ sessionVisibility: 'hidden' }); await f.daemon.handle('dispatch', a); await tick(); f.natives[0]!.finish(); await tick(); await tick();
    assert.equal(f.daemon.store.request(a.dispatchId)!.sessionVisibility, 'hidden');
    await assert.rejects(f.daemon.handle('dispatch', f.request({ workerId: a.workerId, nativeId: f.daemon.store.job(a.dispatchId)!.nativeId, sessionVisibility: 'visible' })), /不能更换会话可见性/);
    await assert.rejects(f.daemon.handle('handoff', { nativeId: f.daemon.store.job(a.dispatchId)!.nativeId, agent: a.agent, cwd: a.cwd }), /隐藏/);
    const calls: string[] = [];
    const old: RemoteClient = { request: async <T>(method: string) => { calls.push(method); return { version: 1, hostname: hostname(), engines: ['codex'], presetDispatch: 1 } as T; }, close: async () => {} };
    const adapter = new RemoteAgentAdapter({ ...f.binding, sessionVisibility: 'hidden' }, f.config, { clientFactory: () => old });
    try { await assert.rejects(adapter.run(f.turn()), /未支持会话可见性协议/); assert.deepEqual(calls, ['hello']); } finally { await adapter.close(); }
    const turn = f.turn(); f.binding.sessionVisibility = 'visible'; const run = f.adapter.run(turn);
    while (f.natives.length < 2) await tick();
    assert.equal(f.daemon.store.request(turn.dispatchId!)!.sessionVisibility, 'visible'); f.natives[1]!.finish(); await run;
  } finally { await f.daemon.close(); }
});


test('remote shutdown errors retain completed reports in durable storage and the controller-side error', async () => {
  const f = fixture(), turn = f.turn(); let refuse = true;
  const pending = f.adapter.run(turn); const outcome = pending.catch(error => error);
  try {
    await tick(); await tick();
    const native = f.natives[0]!; native.close = async () => { if (refuse) throw new Error('second shutdown failure'); };
    Object.assign(native, { confirmStopped: async () => !refuse });
    const report = { nativeId: native.nativeId, text: '代码已落盘；业务验收未完成' };
    native.reject(new AgentProcessStopError(123, report));
    const error = await outcome;
    assert(error instanceof RemoteDispatchUncertain); assert.deepEqual(completedResultFromError(error), report);
    const saved = f.daemon.store.job(turn.dispatchId!)!;
    assert.equal(saved.status, 'uncertain'); assert.equal(saved.stopped, false); assert.deepEqual(saved.result, report);
    assert.equal(f.calls.filter(method => method === 'dispatch').length, 1);
    await assert.rejects(f.daemon.handle('dispatch', f.request({ workerId: turn.conversation.id, nativeId: report.nativeId })), /结果未知/);
    const reread = new RemoteStore(f.daemon.dataDirectory);
    try { assert.deepEqual(reread.job(turn.dispatchId!)?.result, report); } finally { reread.close(); }
  } finally { refuse = false; await f.adapter.close(); await f.daemon.close(); }
});


test('recovered uncertain jobs reconcile complete closed process history without discarding the report or unlocking the session', async () => {
  const f = fixture(); const request = f.request();
  const report = { nativeId: 'native-history-proof', text: '旧报告已保存，业务效果仍待核对' };
  f.daemon.store.create(request);
  f.daemon.store.update(request.dispatchId, { nativeId: report.nativeId, result: report, stopped: false });
  f.daemon.store.process({ dispatchId: request.dispatchId, pid: 123456789, identity: null, closed: true });
  f.daemon.store.process({ dispatchId: request.dispatchId, pid: 123456790, identity: null, closed: true });
  await f.daemon.close();
  const recovered = new RemoteDaemon(f.root, f.daemon.config, { adapterFactory: () => { throw new Error('must not restart native work'); } });
  try {
    await recovered.listen(); assert.equal(recovered.store.job(request.dispatchId)!.status, 'uncertain');
    assert.deepEqual(recovered.store.processes(request.dispatchId), []);
    assert.equal(recovered.store.processRecords(request.dispatchId).length, 2);
    assert.deepEqual(await recovered.handle('interrupt', { dispatchId: request.dispatchId }), { stopped: true });
    assert.deepEqual(await recovered.handle('interrupt', { dispatchId: request.dispatchId }), { stopped: true });
    const saved = recovered.store.job(request.dispatchId)!;
    assert.equal(saved.stopped, true); assert.equal(saved.status, 'uncertain'); assert.deepEqual(saved.result, report);
    await assert.rejects(recovered.handle('dispatch', { ...request, dispatchId: randomUUID(), nativeId: report.nativeId }), /结果未知/);
  } finally { await recovered.close(); }
});

test('closed history reconciliation never interrupts another live dispatch and missing history still refuses stop proof', async () => {
  const f = fixture(); const liveTurn = f.turn(); const pending = f.adapter.run(liveTurn);
  try {
    await tick(); await tick(); const old = f.request(); f.daemon.store.create(old);
    f.daemon.store.update(old.dispatchId, { status: 'uncertain', stopped: false });
    await assert.rejects(f.daemon.handle('interrupt', { dispatchId: old.dispatchId }), /没有可靠的远端进程记录/);
    assert.equal(f.daemon.store.job(old.dispatchId)!.stopped, false);
    f.daemon.store.process({ dispatchId: old.dispatchId, pid: 123456789, identity: null, closed: true });
    assert.deepEqual(await f.daemon.handle('interrupt', { dispatchId: old.dispatchId }), { stopped: true });
    assert.equal(f.natives[0]!.interrupts, 0); assert.equal(f.daemon.store.job(liveTurn.dispatchId!)!.status, 'running');
    f.natives[0]!.finish('仍由原任务完成'); assert.equal((await pending).text, '仍由原任务完成');
    assert.equal(f.calls.filter(method => method === 'dispatch').length, 1);
  } finally { await f.adapter.close(); await f.daemon.close(); }
});


test('a stopped uncertain preset dispatch retains its report without dispatching or resuming native work', async () => {
  const f = fixture(), turn = f.turn(); turn.recovering = true;
  const report = { nativeId: 'preset-completed-native', text: '预设报告已交，现场仍待核对' };
  const preset = { id: 'preset-report', targetId: f.binding.id, profileId: 'profile-report', revision: 1,
    agent: 'codex' as const, model: 'gpt-6.1-sol', fingerprint: 'a'.repeat(64) };
  const methods: string[] = [];
  const job: RemoteJob = { dispatchId: turn.dispatchId!, workerId: turn.conversation.id, status: 'uncertain', stopped: true,
    nativeId: report.nativeId, result: report, ready: false, createdAt: 'now', updatedAt: 'now' };
  const adapter = new RemoteAgentAdapter({ ...f.binding, preset }, f.config, { clientFactory: () => ({
    request: async <T>(method: string) => {
      methods.push(method);
      if (method === 'hello') return { hostname: hostname(), version: 1, engines: ['codex'], presetDispatch: 1 } as T;
      if (method === 'query') return job as T;
      throw new Error('must only inspect an existing dispatch');
    }, close: async () => {},
  }) });
  try {
    await assert.rejects(adapter.run(turn), error => {
      assert(error instanceof PresetResultUnknown); assert.equal(error.resultUncertain, true);
      assert.deepEqual(completedResultFromError(error), report); assert.equal('processStillRunning' in error, false); return true;
    });
    assert.equal(await adapter.confirmStopped(turn.conversation.id), true);
    assert.deepEqual(methods, ['hello', 'query', 'query']); assert.equal(f.natives.length, 0);
  } finally { await adapter.close(); await f.daemon.close(); }
});

test('query reconciles complete exit history without interrupting or completing an uncertain task; missing or partial records remain unknown', async () => {
  const f = fixture();
  try {
    for (const records of [[], [false], [true, false], [true, true]]) {
      const request = f.request(), report = { nativeId: randomUUID(), text: 'Saved report, original failure category unknown' };
      f.daemon.store.create(request); f.daemon.store.update(request.dispatchId, { status: 'uncertain', stopped: false, result: report });
      for (const [index, closed] of records.entries()) f.daemon.store.process({ dispatchId: request.dispatchId, pid: 123456789 + index, identity: null, closed });
      const observed = await f.daemon.handle('query', { dispatchId: request.dispatchId }) as RemoteJob;
      assert.equal(observed.stopped, records.length > 0 && records.every(Boolean)); assert.equal(observed.status, 'uncertain'); assert.deepEqual(observed.result, report);
    }
    const request = f.request(); await f.daemon.handle('dispatch', request); await tick();
    f.daemon.store.process({ dispatchId: request.dispatchId, pid: 123456791, identity: null, closed: true });
    const active = await f.daemon.handle('query', { dispatchId: request.dispatchId }) as RemoteJob;
    assert.equal(active.status, 'running'); assert.notEqual(active.stopped, true); assert.equal(f.natives[0]!.interrupts, 0);
    f.natives[0]!.finish(); await tick(); await tick();
  } finally { await f.daemon.close(); }
});

for (const confirmed of [false, true]) test(`shutdown-only failure with a full report recovers completion only with positive close proof (${confirmed})`, async () => {
  const f = fixture(), request = f.request();
  try {
    await f.daemon.handle('dispatch', request); await tick();
    let proof = confirmed; Object.assign(f.natives[0]!, { confirmStopped: async () => proof });
    f.natives[0]!.close = async () => { if (confirmed) proof = true; };
    const artifact = join(f.root, 'recovered-report.txt'); writeFileSync(artifact, 'the actual attachment');
    const report = { nativeId: f.natives[0]!.nativeId, text: `Feature still needs acceptance.\n[Report](<${artifact}>)` };
    f.natives[0]!.reject(new AgentProcessStopError(123, report)); await tick(); await tick(); await tick();
    const deadline = Date.now() + 2000;
    while (f.daemon.store.job(request.dispatchId)!.status === 'running') { assert.ok(Date.now() < deadline); await tick(); }
    const saved = f.daemon.store.job(request.dispatchId)!;
    assert.equal(saved.stopped, confirmed); assert.equal(saved.status, confirmed ? 'completed' : 'uncertain');
    assert.equal(saved.result!.nativeId, report.nativeId); assert.match(saved.result!.text, /Feature still needs acceptance/);
    assert.equal(saved.artifacts?.length ?? 0, confirmed ? 1 : 0); assert.equal(f.natives[0]!.interrupts, 0);
    if (confirmed) {
      const item = saved.artifacts![0]!;
      const bytes = await f.daemon.handle('artifact', { dispatchId: request.dispatchId, artifactId: item.id, offset: 0 }) as { data: string };
      assert.equal(Buffer.from(bytes.data, 'base64').toString(), 'the actual attachment');
    }
    proof = true; // teardown has explicit exit proof; the assertions above retain the unknown case.
  } finally { await f.daemon.close(); }
});

test('a real result-uncertain exception stays uncertain even after reliable exit proof', async () => {
  const f = fixture(), request = f.request();
  try {
    await f.daemon.handle('dispatch', request); await tick();
    Object.assign(f.natives[0]!, { confirmStopped: async () => true });
    f.natives[0]!.reject(Object.assign(new Error('effects uncertain'), { resultUncertain: true, processStillRunning: true,
      nativeResult: { nativeId: f.natives[0]!.nativeId, text: 'Available report must not erase a real uncertainty' } }));
    await tick(); await tick();
    const saved = f.daemon.store.job(request.dispatchId)!;
    assert.equal(saved.stopped, true); assert.equal(saved.status, 'uncertain'); assert.match(saved.result!.text, /real uncertainty/);
  } finally { await f.daemon.close(); }
});
test('explicit cancellation wins over a shutdown-only completed report even when exit later confirms', async () => {
  const f = fixture(), request = f.request();
  try {
    await f.daemon.handle('dispatch', request); await tick(); const native = f.natives[0]!;
    Object.assign(native, { confirmStopped: async () => true });
    native.interrupt = async () => { native.interrupts++; native.reject(new AgentProcessStopError(123, { nativeId: native.nativeId, text: 'Report completed just before cancellation' })); };
    assert.deepEqual(await f.daemon.handle('interrupt', { dispatchId: request.dispatchId }), { stopped: true });
    const saved = f.daemon.store.job(request.dispatchId)!;
    assert.equal(saved.status, 'cancelled'); assert.equal(saved.stopped, true); assert.match(saved.result!.text, /before cancellation/);
  } finally { await f.daemon.close(); }
});
test('proof arriving between close eligibility checks retires the pending handle and shutdown preserves completion', async () => {
  const f = fixture(), request = f.request();
  try {
    await f.daemon.handle('dispatch', request); await tick(); const native = f.natives[0]!;
    let checks = 0, closes = 0; Object.assign(native, { confirmStopped: async () => ++checks >= 2 });
    native.close = async () => { closes++; };
    native.reject(new AgentProcessStopError(123, { nativeId: native.nativeId, text: 'Final native report' }));
    const deadline = Date.now() + 2000;
    while (f.daemon.store.job(request.dispatchId)!.status === 'running') { assert.ok(Date.now() < deadline); await tick(); }
    assert.equal(f.daemon.store.job(request.dispatchId)!.status, 'completed'); assert.equal(closes, 1);
    await f.daemon.close(); assert.equal(native.interrupts, 0);
    const reopened = new RemoteStore(f.daemon.dataDirectory);
    try { assert.equal(reopened.job(request.dispatchId)!.status, 'completed'); } finally { reopened.close(); }
  } finally { await f.daemon.close(); }
});