import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { connect } from 'node:net';
import type { AgentAdapter, AgentResult, AgentSupplement, AgentTurn, BridgeConfig, SteerResult } from '../src/types.js';
import { RemoteDaemon, remoteEndpoint } from '../src/remote/daemon.js';
import { RemoteAgentAdapter } from '../src/remote/adapter.js';
import { RemoteDispatchUncertain, RemoteArtifactTransferError, type ExecutionTargetBinding, type RemoteClient, type RemoteDaemonConfig, type RemoteDispatch, type RemoteJob } from '../src/remote/types.js';
import { RemoteStore } from '../src/remote/store.js';
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
    turn.onNativeId?.(this.nativeId); turn.onModel?.('actual-model'); turn.onReasoningEffort?.('medium'); turn.onReady?.();
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
    const pending = f.adapter.run(turn); await tick(); await new Promise<void>(resolve => setTimeout(resolve, 30));
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
    release(); await tick(); await tick(); assert.equal(f.daemon.store.job(request.dispatchId)!.status, 'completed'); assert.equal(f.daemon.store.job(request.dispatchId)!.stopped, true);
  } finally { release(); await f.daemon.close(); }
});

test('a native close failure preserves uncertain result and blocks further continuation', async () => {
  const f = fixture();
  try {
    const request = f.request(); await f.daemon.handle('dispatch', request); await tick(); f.natives[0]!.close = async () => { throw new Error('CLI still alive'); };
    f.natives[0]!.finish(); await tick(); await tick(); const old = f.daemon.store.job(request.dispatchId)!;
    assert.equal(old.status, 'uncertain'); assert.equal(old.stopped, false);
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
