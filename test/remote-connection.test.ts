import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SshRemoteClient, requestRemoteHttp } from '../src/remote/client.js';
import { RemoteAgentAdapter } from '../src/remote/adapter.js';
import { TargetCatalogService } from '../src/remote/catalog.js';
import type { JsonLineProcess } from '../src/agents/process.js';
import type { AgentAdapter, AgentCommand, AgentTurn, BridgeConfig } from '../src/types.js';
import type { ExecutionTargetBinding, RemoteClient, RemoteJob } from '../src/remote/types.js';

function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), 'remote-connection-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const command = { command: process.execPath, args: [] };
  const config: BridgeConfig = { token: 'offline', allowedUserIds: ['owner'], defaultAgent: 'codex', workspace: root,
    proxyUrl: null, commands: { codex: command, claude: command }, dataDir: join(root, 'data'), attachmentsDir: root,
    logsDir: root, maxImageBytes: 1024, maxFileBytes: 1024 };
  const binding: ExecutionTargetBinding = { id: 'station', label: 'station', transport: 'ssh', expectedHostname: 'station-host',
    sshConfig: join(root, 'ssh-config'), alias: 'station', remoteRoot: root, nodePath: process.execPath,
    agent: 'codex', agentCommand: command, cwd: root };
  const hello = { hostname: 'station-host', version: 1, engines: ['codex', 'claude'], cliEntries: { codex: 'ready', claude: 'ready' } };
  const turn: AgentTurn = { conversation: { id: 'worker', userId: 'owner', agent: 'codex', nativeId: null,
    cwd: root, title: 'offline', createdAt: '', updatedAt: '', model: null }, dispatchId: 'dispatch', text: 'offline',
    imagePaths: [], signal: new AbortController().signal, onProgress: () => {} };
  return { root, config, binding, hello, turn };
}

test('failed SSH startup is shared, cleaned up, and rereads endpoint port and credentials on the next call', async t => {
  const f = fixture(t); let endpoint = { version: 1, hostname: 'station-host', port: 13476, token: 'a'.repeat(64) };
  let activePort = 5166, copies = 0, stops = 0, failMutation = false;
  const routes = new Map<number, number>(); const copiedPorts: number[] = [];
  const createProcess = (command: AgentCommand): JsonLineProcess => {
    const child = new EventEmitter(); let stopped = false;
    if (command.command === 'scp') {
      copies++; copiedPorts.push(endpoint.port);
      writeFileSync(command.args.at(-1)!, JSON.stringify(endpoint));
      setImmediate(() => child.emit('close', 0));
    } else {
      const forward = command.args[command.args.indexOf('-L') + 1]!;
      const [, local, remote] = /^127\.0\.0\.1:(\d+):127\.0\.0\.1:(\d+)$/.exec(forward)!;
      routes.set(Number(local), Number(remote));
    }
    return { child, onFailure: () => () => {}, stop: async () => {
      if (!stopped) { stopped = true; if (command.command === 'ssh') stops++; }
    } } as unknown as JsonLineProcess;
  };
  let mutations = 0;
  const http: typeof requestRemoteHttp = async <T>(port: number, token: string, method: string): Promise<T> => {
    if (routes.get(port) !== activePort) throw Object.assign(new Error('fixture disconnected'), { code: 'ECONNRESET' });
    assert.equal(token, endpoint.token);
    if (method !== 'hello') { mutations++; if (failMutation) throw new Error('lost response'); }
    return f.hello as T;
  };
  const client = new SshRemoteClient(f.binding, f.root, 80, { createProcess, requestHttp: http });
  try {
    const failed = await Promise.allSettled([client.request('hello', {}), client.request('hello', {})]);
    assert.ok(failed.every(r => r.status === 'rejected'));
    assert.equal(copies, 1); assert.equal(stops, 1);
    endpoint = { ...endpoint, port: activePort, token: 'b'.repeat(64) };
    assert.deepEqual(await client.request('hello', {}), f.hello);
    assert.deepEqual(copiedPorts, [13476, 5166]); assert.equal(stops, 1);
    await client.request('hello', {}); assert.equal(copies, 2);
    failMutation = true;
    await assert.rejects(client.request('dispatch', {}), /lost response/);
    assert.equal(mutations, 1); assert.equal(copies, 2);
  } finally { await client.close(); }
  assert.equal(stops, 2);
});

test('concurrent idle probes replace one failed connection and reuse the healthy replacement', async t => {
  const f = fixture(t); let connections = 0, closed = 0;
  const adapter = new RemoteAgentAdapter(f.binding, f.config, { clientFactory: () => {
    const number = ++connections;
    return { request: async <T>() => { if (number === 1) throw new Error('old tunnel'); return f.hello as T; },
      close: async () => { closed++; } };
  } });
  try {
    const results = await Promise.all([adapter.probeEntries(), adapter.probeEntries()]);
    assert.ok(results.every(r => r.cliEntries?.codex === 'ready'));
    assert.equal(connections, 2); assert.equal(closed, 1);
    await adapter.probeEntries(); assert.equal(connections, 2);
  } finally { await adapter.close(); }
});

test('dispatch recovers only the pre-dispatch handshake and submits the original prompt once', async t => {
  const f = fixture(t); let connections = 0, dispatches = 0;
  const completed: RemoteJob = { dispatchId: 'dispatch', workerId: 'worker', status: 'completed', nativeId: 'native',
    ready: false, stopped: true, result: { nativeId: 'native', text: 'done' }, createdAt: '', updatedAt: '' };
  const adapter = new RemoteAgentAdapter(f.binding, f.config, { clientFactory: () => {
    const number = ++connections;
    return { request: async <T>(method: string) => {
      if (number === 1) throw new Error('expired tunnel');
      if (method === 'dispatch') dispatches++;
      return (method === 'hello' ? f.hello : completed) as T;
    }, close: async () => {} };
  } });
  try { assert.equal((await adapter.run(f.turn)).text, 'done'); assert.equal(connections, 2); assert.equal(dispatches, 1); }
  finally { await adapter.close(); }
});

test('a probe during a hosted task never detaches its connection or replays dispatch', async t => {
  const f = fixture(t); let failProbe = false, closed = 0, dispatches = 0;
  let release!: (job: RemoteJob) => void;
  const query = new Promise<RemoteJob>(resolve => { release = resolve; });
  const completed: RemoteJob = { dispatchId: 'dispatch', workerId: 'worker', status: 'completed', nativeId: 'native',
    ready: false, stopped: true, result: { nativeId: 'native', text: 'done' }, createdAt: '', updatedAt: '' };
  const client: RemoteClient = { request: async <T>(method: string) => {
    if (method === 'hello') { if (failProbe) throw new Error('probe unavailable'); return f.hello as T; }
    if (method === 'dispatch') { dispatches++; return completed as T; }
    return await query as T;
  }, close: async () => { closed++; } };
  const adapter = new RemoteAgentAdapter(f.binding, f.config, { clientFactory: () => client });
  try {
    const pending = adapter.run(f.turn);
    while (!dispatches) await new Promise<void>(resolve => setImmediate(resolve));
    failProbe = true; await assert.rejects(adapter.probeEntries(), /probe unavailable/);
    assert.equal(closed, 0); assert.equal(dispatches, 1);
    failProbe = false; release(completed); assert.equal((await pending).text, 'done'); assert.equal(closed, 0);
  } finally { release(completed); await adapter.close(); }
});

test('identity rejection is preserved without reconnecting or dispatching', async t => {
  const f = fixture(t); let connections = 0;
  const adapter = new RemoteAgentAdapter(f.binding, f.config, { clientFactory: () => {
    connections++; return { request: async <T>() => ({ ...f.hello, hostname: 'another-host' }) as T, close: async () => {} };
  } });
  try { await assert.rejects(adapter.run(f.turn), /登记不一致/); assert.equal(connections, 1); }
  finally { await adapter.close(); }
});

test('computer refresh recovers a stale idle connection while cached reads perform no probe', async t => {
  const f = fixture(t); let stale = false, connections = 0, probes = 0;
  writeFileSync(join(f.root, 'agents.json'), JSON.stringify({ version: 1, targets: [{ id: 'station', label: 'station',
    expectedHostname: f.binding.expectedHostname, sshConfig: f.binding.sshConfig, alias: f.binding.alias,
    remoteRoot: f.root, nodePath: process.execPath, engines: { codex: { agentCommand: f.binding.agentCommand, defaultCwd: f.root } } }] }));
  const unused: AgentAdapter = { run: async () => { throw new Error('no native calls permitted'); }, interrupt: async () => {}, close: async () => {} };
  const catalog = new TargetCatalogService(f.config, { codex: unused, claude: unused }, { clientFactory: () => {
    const number = ++connections;
    return { request: async <T>() => { probes++; if (stale && number === 1) throw new Error('stale port'); return f.hello as T; }, close: async () => {} };
  } });
  try {
    assert.equal((await catalog.computerOverview(f.root, true))[1]!.connection, 'connected');
    stale = true; const before = probes; await catalog.computerOverview(f.root, false); assert.equal(probes, before);
    assert.equal((await catalog.computerOverview(f.root, true))[1]!.connection, 'connected'); assert.equal(connections, 2);
  } finally { await catalog.close(); }
});
