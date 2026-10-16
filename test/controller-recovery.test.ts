import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { setTimeout } from 'node:timers/promises';
import { NativeControllerAdapter } from '../src/controller/native.js';
import { JsonLineProcess } from '../src/agents/process.js';
import type { AgentTurn, AgentName } from '../src/types.js';

const childProgram = `
const readline = require('node:readline');
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
readline.createInterface({input:process.stdin}).on('line', line => {
 const request = JSON.parse(line);
 const result = request.method === 'config/read' ? {config:{model_provider:'test-provider'}} :
   request.method === 'thread/start' || request.method === 'thread/resume' ? {thread:{id:'proof-native'},modelProvider:'test-provider',model:'fixture-model'} :
   request.method === 'turn/start' ? {turn:{id:'proof-turn'}} : {};
 if (request.id != null) send({id:request.id,result});
 if (request.method === 'turn/start') send({method:'test/turn-started'});
});
setInterval(()=>{},1000);
`;
function fixture(t: TestContext, agent: AgentName = 'codex') {
  const root = mkdtempSync(join(tmpdir(), 'bridge-controller-recovery-')), userHome = join(root, 'user'), data = join(root, 'data'); mkdirSync(userHome); mkdirSync(data);
  const script = join(root, 'child.cjs'); writeFileSync(script, childProgram);
  const id = randomUUID(), home = join(data, 'controller-homes', agent, id), proofPath = join(home, 'process-proof.json'); const transports: JsonLineProcess[] = [], adapters: NativeControllerAdapter[] = [];
  let started = false;
  const make = (capture = false) => {
    const adapter = new NativeControllerAdapter({ command: process.execPath, args: [script] }, {}, { agent, dataDir: data, userHome,
      invokeTool: async () => { throw new Error('recovery never invokes tools'); },
      ...(capture ? { createTransport: (command, args, cwd, env) => { const transport = new JsonLineProcess(command, args, cwd, env); transports.push(transport); transport.onMessage(message => { if (message.method === 'test/turn-started') started = true; }); return transport; } } : {}) });
    adapters.push(adapter); return adapter;
  };
  const turn: AgentTurn = { conversation: { id, userId: 'owner', agent, nativeId: null, title: 'recovery', cwd: root, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }, text: 'hold', imagePaths: [], signal: new AbortController().signal, onProgress: () => {} };
  const writeProof = (updates: Record<string, unknown> = {}) => { mkdirSync(home, { recursive: true }); writeFileSync(proofPath, JSON.stringify({ version: 1, agent, conversationId: id, pid: process.pid, nonce: randomUUID(), stopped: false, startedAt: new Date().toISOString(), ...updates })); };
  t.after(async () => { for (const adapter of adapters) await adapter.close(); for (const transport of transports) await transport.stop(false); rmSync(root, { recursive: true, force: true }); });
  return { root, data, id, home, proofPath, turn, transports, make, writeProof, get started() { return started; } };
}
async function eventually(check: () => boolean) { const end = Date.now() + 3000; while (!check()) { if (Date.now() > end) throw new Error('controller proof test timeout'); await setTimeout(5); } }

test('new adapter requires valid evidence and never equates an empty sessions map with stopped', async t => {
  const f = fixture(t), adapter = f.make(); assert.equal(await adapter.confirmStopped(f.id), false); assert.equal(await adapter.confirmStopped('../escape'), false);
  mkdirSync(f.home, { recursive: true }); writeFileSync(f.proofPath, '{broken'); assert.equal(await adapter.confirmStopped(f.id), false);
  f.writeProof({ nonce: 'not-a-bridge-nonce' }); assert.equal(await adapter.confirmStopped(f.id), false);
  f.writeProof({ conversationId: randomUUID() }); assert.equal(await adapter.confirmStopped(f.id), false);
  f.writeProof({ agent: 'claude' }); assert.equal(await adapter.confirmStopped(f.id), false);
});

test('a live recorded PID remains unknown even when a previous record claims stopped', async t => {
  const f = fixture(t), adapter = f.make(); f.writeProof(); assert.equal(await adapter.confirmStopped(f.id), false);
  f.writeProof({ stopped: true, stoppedAt: new Date().toISOString() }); assert.equal(await adapter.confirmStopped(f.id), false);
  assert.doesNotThrow(() => process.kill(process.pid, 0));
});

test('real native child writes a nonce proof, active controller stays unconfirmed, and confirmed exit recovers across adapters', async t => {
  const f = fixture(t), adapter = f.make(true); const running = adapter.run(f.turn).catch(error => error as Error);
  await eventually(() => existsSync(f.proofPath) && f.started);
  const before = JSON.parse(readFileSync(f.proofPath, 'utf8')); assert.equal(before.pid, f.transports[0]!.child.pid); assert.equal(before.stopped, false); assert.equal(before.conversationId, f.id);
  assert.equal(await adapter.confirmStopped(f.id), false); assert.equal(await f.make().confirmStopped(f.id), false);
  await adapter.interrupt(f.id); await running;
  const after = JSON.parse(readFileSync(f.proofPath, 'utf8')); assert.equal(after.nonce, before.nonce); assert.equal(after.stopped, true); assert.ok(after.stoppedAt);
  assert.equal(await adapter.confirmStopped(f.id), true); assert.equal(await f.make().confirmStopped(f.id), true);
});

test('a dead recorded child PID is positive exit evidence even if host crashed before writing stopped', async t => {
  const f = fixture(t), transport = new JsonLineProcess({ command: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'] }, [], f.root, {}); f.transports.push(transport);
  assert.ok(transport.child.pid); f.writeProof({ pid: transport.child.pid, stopped: false }); const adapter = f.make(); assert.equal(await adapter.confirmStopped(f.id), false);
  const closed = once(transport.child, 'close'); await transport.stop(false); await closed;
  assert.equal(JSON.parse(readFileSync(f.proofPath, 'utf8')).stopped, false); assert.equal(await adapter.confirmStopped(f.id), true);
});

test('late old-child close cannot overwrite a newer nonce or authorize stopping its PID', async t => {
  const f = fixture(t), adapter = f.make(true); const running = adapter.run(f.turn).catch(error => error as Error); await eventually(() => existsSync(f.proofPath));
  const old = JSON.parse(readFileSync(f.proofPath, 'utf8')); const newerNonce = randomUUID(); f.writeProof({ nonce: newerNonce, pid: process.pid });
  await adapter.interrupt(f.id); await running; const current = JSON.parse(readFileSync(f.proofPath, 'utf8')); assert.notEqual(current.nonce, old.nonce); assert.equal(current.nonce, newerNonce); assert.equal(current.pid, process.pid); assert.equal(current.stopped, false);
  assert.equal(await adapter.confirmStopped(f.id), false); assert.equal(await f.make().confirmStopped(f.id), false); assert.doesNotThrow(() => process.kill(process.pid, 0));
});

test('EPERM and unexpected PID probing errors remain unknown and reconciliation never sends a terminating signal', async t => {
  const f = fixture(t), adapter = f.make(); f.writeProof(); const original = process.kill.bind(process), signals: unknown[] = [];
  t.mock.method(process, 'kill', (pid: number, signal?: number | NodeJS.Signals) => { signals.push(signal); if (pid === process.pid && signal === 0) throw Object.assign(new Error('permission denied'), { code: 'EPERM' }); return original(pid, signal); });
  assert.equal(await adapter.confirmStopped(f.id), false); assert.deepEqual(signals, [0]);
});
test('Claude uses its isolated config home for the same real-child proof lifecycle', async t => {
  const f = fixture(t, 'claude'), adapter = f.make(true); const running = adapter.run(f.turn).catch(error => error as Error); await eventually(() => existsSync(f.proofPath));
  const proof = JSON.parse(readFileSync(f.proofPath, 'utf8')); assert.equal(proof.agent, 'claude'); assert.equal(proof.pid, f.transports[0]!.child.pid); assert.equal(await adapter.confirmStopped(f.id), false);
  await adapter.interrupt(f.id); await running; assert.equal(JSON.parse(readFileSync(f.proofPath, 'utf8')).stopped, true); assert.equal(await f.make().confirmStopped(f.id), true);
});