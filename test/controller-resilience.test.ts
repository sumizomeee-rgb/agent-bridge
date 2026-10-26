import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NativeControllerAdapter } from '../src/controller/native.js';
import { AgentProcessStopError, type JsonObject, type RpcTransport } from '../src/agents/process.js';
import { DeliveryPreparationError } from '../src/delivery-errors.js';
import { MetadataProbeError } from '../src/agents/metadata.js';
import { SessionStore } from '../src/store.js';
import { SessionManager } from '../src/manager.js';
import type { AgentAdapter, AgentTurn, BridgeConfig } from '../src/types.js';
import type { ControllerTurnState } from '../src/controller-lifecycle.js';

class Transport implements RpcTransport {
  messages = new Set<(message: JsonObject) => void>();
  failures = new Set<(error: Error) => void>();
  written: JsonObject[] = [];
  turns = 0;
  stopped = false;
  failStop = false;
  nativeId = 'existing-controller';
  intercept?: (message: JsonObject) => boolean;
  onMessage(callback: (message: JsonObject) => void) { this.messages.add(callback); return () => this.messages.delete(callback); }
  onFailure(callback: (error: Error) => void) { this.failures.add(callback); return () => this.failures.delete(callback); }
  emit(message: JsonObject) { queueMicrotask(() => this.messages.forEach(callback => callback(message))); }
  fail() { this.failures.forEach(callback => callback(new Error('transport disconnected'))); }
  write(message: JsonObject) {
    if (this.stopped) throw new Error('transport closed');
    this.written.push(message);
    if (this.intercept?.(message)) return;
    let result: JsonObject | undefined;
    if (message.method === 'initialize') result = {};
    if (message.method === 'config/read') result = { config: { model_provider: 'fixture', model: 'fixture-model' } };
    if (message.method === 'model/list') result = { data: [{ model: 'fixture-model' }] };
    if (message.method === 'thread/start' || message.method === 'thread/resume') result = { thread: { id: this.nativeId }, modelProvider: 'fixture', model: 'fixture-model' };
    if (message.method === 'turn/start') { this.turns++; result = { turn: { id: `turn-${this.turns}` } }; }
    if (result) this.emit({ id: message.id, result });
  }
  tool(name: string, args: JsonObject, id = 100 + this.turns) {
    this.emit({ id, method: 'item/tool/call', params: { threadId: this.nativeId, turnId: `turn-${this.turns}`, callId: `call-${id}`, tool: name, arguments: JSON.stringify(args) } });
  }
  complete(status = 'completed') { this.emit({ method: 'turn/completed', params: { threadId: this.nativeId, turn: { id: `turn-${this.turns}`, status, error: { message: 'capacity unavailable' } } } }); }
  async stop() { if (this.failStop) throw new AgentProcessStopError(undefined); this.stopped = true; }
  canRetryStop() { return !this.failStop; }
  confirmStopped() { return this.stopped; }
}
async function until(check: () => boolean) {
  for (let i = 0; i < 200; i++) { if (check()) return; await new Promise(resolve => setImmediate(resolve)); }
  assert.fail('expected lifecycle transition');
}
function fixture(t: TestContext, prepare?: (transport: Transport, index: number) => void, agent: 'codex' | 'claude' = 'codex') {
  const root = mkdtempSync(join(tmpdir(), 'bridge-resilience-'));
  mkdirSync(join(root, '.codex')); writeFileSync(join(root, '.codex', 'config.toml'), 'model_provider="fixture"\n');
  const transports: Transport[] = [], states: ControllerTurnState[] = [], published: string[] = [], management: string[] = [];
  const adapter = new NativeControllerAdapter({ command: 'fake', args: [] }, {}, { agent, dataDir: join(root, 'native'), userHome: root,
    createTransport: () => { const transport = new Transport(); prepare?.(transport, transports.length); transports.push(transport); return transport; },
    invokeTool: async (_turn, name) => { management.push(name); return { workerId: 'already-running-worker' }; } });
  const controller = new AbortController();
  const turn: AgentTurn = { conversation: { id: 'c', userId: 'owner', nativeId: 'existing-controller', agent, cwd: root, title: '', createdAt: '', updatedAt: '' },
    text: 'original authorized task', imagePaths: [], signal: controller.signal, onProgress() {}, controllerRecovery: true,
    onControllerState: state => states.push(state), onPrivateInputCheck: async () => ({ refreshRequired: false }),
    onPublicMessage: async text => { published.push(text); } };
  const cleanups: Array<() => Promise<void>> = [];
  t.after(async () => { for (const transport of transports) transport.failStop = false; for (const cleanup of cleanups) await cleanup(); await adapter.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, adapter, turn, controller, transports, states, published, management, cleanups };
}
async function reply(transport: Transport) {
  transport.tool('bridge_send_user', { text: 'confirmed reply' });
  await until(() => transport.written.some(message => message.id === 100 + transport.turns));
  transport.complete();
}

test('startup failure: retry once before submission, preserve native session and persist before I/O', async t => {
  const s = fixture(t, (transport, index) => {
    transport.intercept = message => {
      if (message.method === 'initialize' && index === 0) { transport.emit({ id: message.id, error: { code: -1, message: 'startup unavailable' } }); return true; }
      if (message.method === 'turn/start') assert.equal(s.states.at(-1)?.submission, 'unknown');
      return false;
    };
  });
  const running = s.adapter.run(s.turn);
  await until(() => s.transports[1]?.turns === 1); await reply(s.transports[1]!); await running;
  assert.equal(s.transports.length, 2); assert.equal(s.transports[0]!.turns, 0); assert.equal(s.transports[0]!.stopped, true);
  assert.equal(s.states.filter(state => state.phase === 'retrying').length, 1);
  assert.equal(s.states.at(-1)?.attempt, 2); assert.equal(s.states.at(-1)?.phase, 'completed');
  assert.equal((s.transports[1]!.written.find(message => message.method === 'thread/resume')!.params as JsonObject).threadId, 'existing-controller');
});

test('initialize timeout before submission recovers once without replaying the user message', async t => {
  const s = fixture(t, (transport, index) => {
    transport.intercept = message => index === 0 && message.method === 'initialize';
  });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const running = s.adapter.run(s.turn);
  await until(() => s.transports[0]?.written.some(message => message.method === 'initialize') === true);
  assert.equal(s.states.at(-1)?.submission, 'not-submitted');
  t.mock.timers.tick(15001);
  await until(() => s.transports[1]?.turns === 1);
  await reply(s.transports[1]!); await running; t.mock.timers.reset();
  assert.equal(s.transports[0]!.stopped, true);
  assert.equal(s.transports[0]!.turns, 0);
  assert.equal(s.transports[1]!.turns, 1);
  assert.equal(s.states.filter(state => state.phase === 'retrying').length, 1);
  assert.match(s.states.find(state => state.phase === 'retrying')!.diagnostic!, /initialize/);
  assert.equal(s.states.at(-1)?.phase, 'completed');
});

test('startup recovery is bounded and an unconfirmed old process forbids another launch', async t => {
  for (const failStop of [false, true]) {
    const s = fixture(t, transport => {
      transport.failStop = failStop;
      transport.intercept = message => { if (message.method !== 'initialize') return false; transport.emit({ id: message.id, error: { code: -1, message: 'startup unavailable' } }); return true; };
    });
    await assert.rejects(s.adapter.run(s.turn));
    assert.equal(s.transports.length, failStop ? 1 : 2); assert(s.transports.every(transport => transport.turns === 0));
    assert.equal(s.states.at(-1)?.submission, 'not-submitted');
  }
});

test('lost turn acknowledgement: no replay even if startup transport can be restarted', async t => {
  const s = fixture(t, transport => { transport.intercept = message => message.method === 'turn/start'; });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const rejected = assert.rejects(s.adapter.run(s.turn), /turn\/start/);
  await until(() => s.states.some(state => state.phase === 'submitting'));
  t.mock.timers.tick(20001); await rejected; t.mock.timers.reset();
  assert.equal(s.transports.length, 1); assert.equal(s.states.at(-1)?.submission, 'unknown');
  assert.equal(s.transports[0]!.written.filter(message => message.method === 'turn/start').length, 1);
});

test('accepted native failure does not resubmit the original task', async t => {
  const s = fixture(t); const rejected = assert.rejects(s.adapter.run(s.turn), /capacity unavailable/);
  await until(() => s.states.at(-1)?.submission === 'accepted'); s.transports[0]!.complete('failed'); await rejected;
  assert.equal(s.transports.length, 1); assert.equal(s.transports[0]!.turns, 1); assert.equal(s.states.at(-1)?.submission, 'accepted');
});

test('turn started event survives a lost RPC response without retiring the working controller', async t => {
  const s = fixture(t, transport => {
    transport.intercept = message => {
      if (message.method !== 'turn/start') return false;
      transport.turns++;
      transport.emit({ method: 'turn/started', params: { threadId: transport.nativeId, turn: { id: `turn-${transport.turns}` } } });
      return true; // Real turn accepted; only the RPC response is absent.
    };
  });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const running = s.adapter.run(s.turn); void running.catch(() => {});
  await until(() => s.states.some(state => state.phase === 'accepted'));
  t.mock.timers.tick(20001);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(s.transports[0]!.stopped, false, 'accepted live turn must not be killed for a missing RPC response');
  // Optional thread metadata also has a bounded wait.
  t.mock.timers.tick(15001);
  await reply(s.transports[0]!); await running; t.mock.timers.reset();
  assert.equal(s.transports.length, 1); assert.equal(s.transports[0]!.turns, 1);
  assert.deepEqual(s.published, ['confirmed reply']);
});

test('an independent unconfirmed metadata probe never retires the healthy controller or starts another probe', async t => {
  for (const warm of [false, true]) {
    const s = fixture(t); let probes = 0;
    if (warm) {
      const running = s.adapter.run(s.turn); await until(() => s.transports[0]?.turns === 1); await reply(s.transports[0]!); await running;
      writeFileSync(join(s.root, '.codex', 'config.toml'), 'model_provider="changed"\n');
    }
    const options = (s.adapter as unknown as { options: { metadataAdapter: AgentAdapter } }).options;
    options.metadataAdapter = { run: async () => { throw new Error('metadata only'); }, interrupt: async () => {}, close: async () => {},
      getModelInfo: async () => { probes++; throw new MetadataProbeError(new Error('independent probe exit unconfirmed'), false); } };
    await assert.rejects(s.adapter.run({ ...s.turn, conversation: { ...s.turn.conversation, modelPolicy: 'cli-default' } }), MetadataProbeError);
    assert.equal(probes, 1); assert.equal(s.transports.length, warm ? 1 : 0);
    if (warm) assert.equal(s.transports[0]!.stopped, false);
  }
});

test('missing private final: one evidence continuation, existing worker is never dispatched again', async t => {
  const s = fixture(t); const running = s.adapter.run(s.turn);
  await until(() => s.transports[0]?.turns === 1); const transport = s.transports[0]!;
  transport.tool('bridge_start_worker', { title: 'task', prompt: 'authorized' }, 401);
  await until(() => transport.written.some(message => message.id === 401)); transport.complete();
  await until(() => transport.turns === 2);
  const continuation = transport.written.filter(message => message.method === 'turn/start')[1]!.params as JsonObject;
  assert.deepEqual(continuation.input, []); assert(!JSON.stringify(continuation).includes(s.turn.text));
  assert.equal((continuation.toolOutput as JsonObject).name, 'bridge_reply_recovery');
  transport.tool('bridge_start_worker', { title: 'duplicate', prompt: 'do again' }, 402);
  await until(() => transport.written.some(message => message.id === 402));
  assert.equal((transport.written.find(message => message.id === 402)!.result as JsonObject).success, false);
  await reply(transport); await running;
  assert.deepEqual(s.management, ['bridge_start_worker']); assert.equal(s.published.length, 1);
});

test('missing reply recovery has a one-decision bound', async t => {
  const s = fixture(t); const rejected = assert.rejects(s.adapter.run(s.turn), /没有通过公开通道/);
  await until(() => s.transports[0]?.turns === 1); const transport = s.transports[0]!; transport.complete();
  await until(() => transport.turns === 2); transport.complete(); await rejected;
  assert.equal(transport.turns, 2); assert.equal(s.transports.length, 1);
});

test('verified pre-send rejection can be corrected; uncertain platform delivery cannot be resent', async t => {
  for (const uncertain of [false, true]) {
    const s = fixture(t); let sends = 0;
    s.turn.onPublicMessage = async () => { if (++sends === 1) throw uncertain ? Object.assign(new Error('delivery unknown'), { deliveryUncertain: true }) : new DeliveryPreparationError('invalid attachment before send'); };
    const running = s.adapter.run(s.turn); const rejected = uncertain ? assert.rejects(running, /delivery unknown/) : undefined;
    await until(() => s.transports[0]?.turns === 1); const transport = s.transports[0]!;
    transport.tool('bridge_send_user', { text: 'reply' }); await until(() => sends === 1);
    if (uncertain) { await rejected; assert.equal(transport.turns, 1); }
    else { await until(() => transport.written.some(message => message.id === 101)); transport.complete(); await until(() => transport.turns === 2); await reply(transport); await running; assert.equal(sends, 2); }
  }
});

test('confirmed reply survives failed CLI retirement and blocks overlapping replacement until stop proof', async t => {
  const s = fixture(t); const running = s.adapter.run(s.turn);
  await until(() => s.transports[0]?.turns === 1); const transport = s.transports[0]!;
  transport.tool('bridge_send_user', { text: 'already delivered' }); await until(() => s.published.length === 1);
  transport.failStop = true; transport.complete('failed'); const result = await running;
  assert.equal(result.controlledOutput, true); assert.equal(result.processStopped, false); assert.ok(result.cleanupError);
  await assert.rejects(s.adapter.run(s.turn)); assert.equal(s.transports.length, 1); assert.equal(s.published.length, 1);
});

test('an idle disconnected controller is retired before the next original input', async t => {
  const s = fixture(t); let running = s.adapter.run(s.turn); await until(() => s.transports[0]?.turns === 1); await reply(s.transports[0]!); await running;
  s.transports[0]!.fail(); running = s.adapter.run(s.turn);
  await until(() => s.transports[1]?.turns === 1); await reply(s.transports[1]!); await running;
  assert.equal(s.transports[0]!.stopped, true); assert.equal(s.transports[0]!.turns, 1); assert.equal(s.published.length, 2);
});

test('a transport disconnect after confirmed private delivery preserves the completed reply', async t => {
  const s = fixture(t); const running = s.adapter.run(s.turn);
  await until(() => s.transports[0]?.turns === 1); const transport = s.transports[0]!;
  transport.tool('bridge_send_user', { text: 'already delivered' }); await until(() => s.published.length === 1);
  transport.fail(); const result = await running;
  assert.equal(result.controlledOutput, true); assert.match(result.postDeliveryError!, /transport disconnected/);
  assert.equal(s.transports.length, 1); assert.equal(s.published.length, 1);
});

test('lifecycle survives restart; an unknown submission is interrupted without automatic replay', async t => {
  const s = fixture(t); const f = managerFixture(t, s);
  await f.send(); await until(() => s.transports[0]?.turns === 1); await reply(s.transports[0]!);
  await until(() => f.store.getMessage('original-message')?.state === 'completed');
  f.store.controllerLifecycle.record('original-message', f.store.getActive('owner')!.id, { attempt: 1, phase: 'submitting', submission: 'unknown' });
  f.store.setState('original-message', 'running'); f.store.setReplyState(['original-message'], 'pending');
  await f.manager.close();
  const reopened = new SessionStore(f.config.dataDir);
  assert.equal(reopened.controllerLifecycle.latest('original-message')?.submission, 'unknown'); reopened.close();
  let executions = 0;
  const fake = { run: async () => { executions++; throw new Error('must not replay'); }, close: async () => {}, interrupt: async () => {} };
  const restarted = new SessionManager(f.config, { codex: fake, claude: fake }, { sendText: async () => {} }, { mergeDelayMs: 0 });
  try { await restarted.recover(); assert.equal(executions, 0); assert.equal(f.store.getMessage('original-message')?.state, 'interrupted'); }
  finally { await restarted.close(); }
});

test('Claude missing final uses one evidence continuation and never replays original text', async t => {
  const s = fixture(t, transport => { transport.intercept = message => {
    if (message.type !== 'user') return false;
    transport.turns++; transport.emit({ type: 'result', subtype: 'success', session_id: 'existing-controller', result: 'DONE' }); return true;
  }; }, 'claude');
  await assert.rejects(s.adapter.run(s.turn), /没有通过公开通道/);
  assert.equal(s.transports[0]!.turns, 2);
  assert(!JSON.stringify(s.transports[0]!.written[1]).includes(s.turn.text));
});

function managerFixture(t: TestContext, s: ReturnType<typeof fixture>) {
  const sent: string[] = [];
  const config: BridgeConfig = { token: 'fixture', allowedUserIds: ['owner'], defaultAgent: 'codex', controllerMode: true,
    workspace: s.root, dataDir: join(s.root, 'manager'), attachmentsDir: join(s.root, 'images'), logsDir: join(s.root, 'logs'), proxyUrl: null, maxImageBytes: 100,
    commands: { codex: { command: 'fake', args: [] }, claude: { command: 'fake', args: [] } } };
  const store = new SessionStore(config.dataDir);
  const conversation = store.createConversation('owner', 'codex', s.root, { controllerMode: true }); store.setActive('owner', conversation.id);
  const manager = new SessionManager(config, { codex: s.adapter, claude: s.adapter }, { async sendText(_channel, text) {
    sent.push(text);
  } }, { mergeDelayMs: 0 });
  s.cleanups.push(async () => { await manager.close(); store.close(); });
  return { sent, store, manager, config, send: () => manager.handle({ id: 'original-message', userId: 'owner', channelId: 'private', text: 'test', imagePaths: [] }) };
}

test('missing final recovery stays silent while persisting lifecycle and delivering the answer', async t => {
  const s = fixture(t); const f = managerFixture(t, s); await f.send();
  await until(() => s.transports[0]?.turns === 1); const transport = s.transports[0]!; transport.complete();
  await until(() => transport.turns === 2); assert.deepEqual(f.sent, []); await reply(transport);
  await until(() => f.store.getMessage('original-message')?.state === 'completed');
  assert.equal(f.store.getMessage('original-message')?.replyState, 'delivered');
  assert.equal(f.store.controllerLifecycle.latest('original-message')?.phase, 'completed');
  assert.equal(f.sent.length, 1); assert.match(f.sent[0]!, /confirmed reply/);
});

test('normal long-running turns never emit a time-based warning or get interrupted', async t => {
  const s = fixture(t); const f = managerFixture(t, s); await f.send();
  // The message enters processQueue through a real merge timer before clock mocking.
  await until(() => s.transports[0]?.turns === 1);
  // Start the next input with mocked time so every turn-local timeout is covered.
  await reply(s.transports[0]!); await until(() => f.store.getMessage('original-message')?.state === 'completed');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await f.manager.handle({ id: 'long-message', userId: 'owner', channelId: 'private', text: 'long', imagePaths: [] });
  t.mock.timers.tick(1); await until(() => s.transports[0]!.turns === 2);
  const sentBeforeWait = f.sent.length;
  t.mock.timers.tick(30001); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.sent.length, sentBeforeWait, '30 seconds of normal execution must not generate a notification');
  t.mock.timers.tick(600000); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.sent.length, sentBeforeWait, 'longer normal execution must remain free of time-based notifications');
  assert.equal(s.transports[0]!.stopped, false); assert.equal(f.store.getMessage('long-message')?.state, 'running');
  await reply(s.transports[0]!); await until(() => f.store.getMessage('long-message')?.state === 'completed'); t.mock.timers.reset();
});

test('pre-submission recovery stays silent and sends only the eventual final reply', async t => {
  const s = fixture(t, (transport, index) => {
    transport.intercept = message => {
      if (index !== 0 || message.method !== 'initialize') return false;
      transport.emit({ id: message.id, error: { code: -1, message: 'startup unavailable' } }); return true;
    };
  });
  const f = managerFixture(t, s); await f.send();
  await until(() => s.transports[1]?.turns === 1);
  assert.deepEqual(f.sent, []);
  await reply(s.transports[1]!);
  await until(() => f.store.getMessage('original-message')?.state === 'completed');
  assert.equal(f.sent.length, 1); assert.match(f.sent[0]!, /confirmed reply/);
  assert.equal(s.transports[0]!.turns, 0);
});

test('exhausted pre-submission recovery sends one final failure notification', async t => {
  const s = fixture(t, transport => {
    transport.intercept = message => {
      if (message.method !== 'initialize') return false;
      transport.emit({ id: message.id, error: { code: -1, message: 'startup unavailable' } }); return true;
    };
  });
  const f = managerFixture(t, s); await f.send();
  await until(() => f.store.getMessage('original-message')?.state === 'failed' && f.sent.length > 0);
  assert.equal(s.transports.length, 2); assert(s.transports.every(transport => transport.turns === 0));
  assert.equal(f.sent.length, 1); assert.match(f.sent[0]!, /主控准备失败/);
});


function workerReport(s: ReturnType<typeof fixture>) {
  s.turn.event = { kind: 'worker-result', text: 'Saved worker result: checksum verified; worker already completed.' };
  s.turn.onPrivateInputCheck = undefined;
  return s.turn;
}
test('completed worker report retries a verified pre-submission failure silently in the same parent', async t => {
  const s = fixture(t, (transport, index) => {
    transport.intercept = message => {
      if (index !== 0 || message.method !== 'initialize') return false;
      transport.emit({ id: message.id, error: { code: -1, message: 'metadata unavailable' } }); return true;
    };
  });
  const running = s.adapter.run(workerReport(s));
  await until(() => s.transports[1]?.turns === 1); await reply(s.transports[1]!); await running;
  assert.equal(s.transports[0]!.turns, 0); assert.equal(s.transports[1]!.nativeId, 'existing-controller');
  assert.deepEqual(s.published, ['confirmed reply']); assert.deepEqual(s.management, []);
  assert.equal(s.states.filter(state => state.phase === 'retrying').length, 1);
});

test('failed accepted worker report continues saved evidence once; execution tools are blocked', async t => {
  const s = fixture(t); const running = s.adapter.run(workerReport(s));
  await until(() => s.transports[0]?.turns === 1);
  s.transports[0]!.tool('bridge_list_workers', { details: true }, 150);
  await until(() => s.transports[0]!.written.some(message => message.id === 150));
  s.transports[0]!.complete('failed');
  await until(() => s.transports[1]?.turns === 1);
  assert.equal(s.transports[0]!.stopped, true);
  const next = s.transports[1]!;
  const params = next.written.find(message => message.method === 'turn/start')!.params as JsonObject;
  assert.deepEqual(params.input, []);
  assert.match(JSON.stringify(params.toolOutput), /Saved worker result/);
  assert.match(JSON.stringify(params.toolOutput), /only recovery attempt/);
  next.tool('bridge_start_worker', { title: 'must not replay', prompt: 'do it again' }, 151);
  await until(() => next.written.some(message => message.id === 151));
  assert.deepEqual(s.management, ['bridge_list_workers']);
  assert.match(JSON.stringify(next.written.find(message => message.id === 151)), /禁止重派/);
  await reply(next); await running;
  assert.deepEqual(s.published, ['confirmed reply']);
  assert.equal(s.states.filter(state => state.phase === 'reply-recovery').length, 1);
});

test('report recovery is bounded and a second failure is not converted to silent success', async t => {
  const s = fixture(t); const rejected = assert.rejects(s.adapter.run(workerReport(s)));
  await until(() => s.transports[0]?.turns === 1); s.transports[0]!.complete('failed');
  await until(() => s.transports[1]?.turns === 1); s.transports[1]!.complete();
  await rejected; assert.equal(s.transports.length, 2); assert.deepEqual(s.published, []);
});

for (const failure of ['lost-ack', 'stop-unknown', 'delivery-unknown', 'transport-lost'] as const) {
  test(`worker report ${failure} does not start another decision`, async t => {
    const s = fixture(t, transport => {
      if (failure === 'lost-ack') transport.intercept = message => message.method === 'turn/start';
      if (failure === 'stop-unknown') transport.failStop = true;
    });
    workerReport(s);
    if (failure === 'delivery-unknown') s.turn.onPublicMessage = async () => { throw Object.assign(new Error('send ACK lost'), { deliveryUncertain: true }); };
    if (failure === 'lost-ack') t.mock.timers.enable({ apis: ['setTimeout'] });
    const rejected = assert.rejects(s.adapter.run(s.turn));
    await until(() => s.transports[0]?.written.some(message => message.method === 'turn/start') === true);
    if (failure === 'lost-ack') t.mock.timers.tick(20001);
    else if (failure === 'delivery-unknown') s.transports[0]!.tool('bridge_send_user', { text: 'report' });
    else if (failure === 'transport-lost') s.transports[0]!.fail();
    else s.transports[0]!.complete('failed');
    await rejected; if (failure === 'lost-ack') t.mock.timers.reset();
    assert.equal(s.transports.length, 1);
  });
}

test('Claude explicit failed report resumes same history with saved evidence only once', async t => {
  const s = fixture(t, transport => { transport.intercept = message => {
    if (message.type !== 'user') return false;
    transport.turns++;
    transport.emit({ type: 'result', subtype: 'error_during_execution', is_error: true, session_id: 'existing-controller', result: 'capacity unavailable' });
    return true;
  }; }, 'claude');
  await assert.rejects(s.adapter.run(workerReport(s)));
  assert.equal(s.transports.length, 2); assert.equal(s.transports[0]!.stopped, true);
  assert.equal(s.transports[1]!.turns, 1);
  assert.match(JSON.stringify(s.transports[1]!.written), /Saved worker result/);
  assert.equal(s.states.filter(state => state.phase === 'reply-recovery').length, 1);
});
