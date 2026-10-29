import test from 'node:test';
import assert from 'node:assert/strict';
import { Agent as HttpAgent, request as httpRequest } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentTurn } from '../src/types.js';
import { AgentProcessStopError, type JsonObject, type RpcTransport } from '../src/agents/process.js';
import { NativeControllerAdapter, codexControllerOverrides, isolatedCodexConfig } from '../src/controller/native.js';
import { parse as parseTOML } from 'smol-toml';

test('accepted restart can end internally without a public DM; unavailable restart still needs an honest ordinary answer', async () => {
  for (const accepted of [true, false]) {
    const s = setup(); s.setMode('hold'); s.holdManagement(Promise.resolve({ accepted, status: accepted ? 'draining' : 'supervisor_required' }));
    try {
      const running = s.adapter.run(s.makeTurn()); await until(() => !!s.transports[0]?.turns);
      const transport = s.transports[0]!;
      tool(transport, 8001, 'restart', 'bridge_request_restart', {});
      await until(() => transport.written.some(message => message.id === 8001 && !message.method)); transport.complete();
      if (accepted) { const result = await running; assert.equal(result.controlledOutput, true); }
      else await assert.rejects(running, /没有通过公开通道/);
      assert.equal(s.published.length, 0); assert.deepEqual(s.invokes, ['bridge_request_restart']);
    } finally { await s.cleanup(); }
  }
});

test('accepted restart does not forbid another genuine ordinary answer from the same request', async () => {
  const s = setup(); s.setMode('hold'); s.holdManagement(Promise.resolve({ accepted: true, status: 'draining' }));
  try {
    const running = s.adapter.run(s.makeTurn()); await until(() => !!s.transports[0]?.turns);
    const transport = s.transports[0]!;
    tool(transport, 8001, 'restart', 'bridge_request_restart', {});
    await until(() => transport.written.some(message => message.id === 8001 && !message.method));
    tool(transport, 900 + transport.turns, 'ordinary-answer', 'bridge_send_user', { text: '刚才那个问题的答案是三台电脑。' });
    await running; assert.equal(s.published.length, 1); assert.equal(s.published[0]!.text, '刚才那个问题的答案是三台电脑。');
  } finally { await s.cleanup(); }
});

test('native controller exposes target, handoff and restart management through its bounded protocol before one public reply', async () => {
  const s = setup(); s.setMode('hold');
  try {
    const running = s.adapter.run(s.makeTurn()); await until(() => !!s.transports[0]?.turns);
    const transport = s.transports[0]!;
    const start = transport.written.find(message => message.method === 'thread/start')?.params as JsonObject;
    const names = (start.dynamicTools as { name: string }[]).map(value => value.name);
    assert.ok(names.includes('bridge_list_targets')); assert.ok(names.includes('bridge_handoff_worker')); assert.ok(names.includes('bridge_request_restart'));
    for (const [index, name, args] of [
      [0, 'bridge_list_targets', {}],
      [1, 'bridge_start_worker', { title: '工位任务', prompt: '授权任务', targetId: 'office', cwd: 'Z:\\remote-only' }],
      [2, 'bridge_handoff_worker', { workerId: 'idle-native-child' }],
      [3, 'bridge_request_restart', {}],
    ] as const) {
      tool(transport, 3000 + index, `management-${index}`, name, args);
      await until(() => transport.written.some(message => message.id === 3000 + index && !message.method));
    }
    assert.deepEqual(s.invokes, ['bridge_list_targets', 'bridge_start_worker', 'bridge_handoff_worker', 'bridge_request_restart']);
    tool(transport, 900 + transport.turns, 'public', 'bridge_send_user', { text: '已经登记。' });
    await running; assert.equal(s.published.length, 1); assert.equal(s.published[0]!.text, '已经登记。');
  } finally { await s.cleanup(); }
});


class FakeTransport implements RpcTransport {
  readonly messages = new Set<(message: JsonObject) => void>();
  readonly failures = new Set<(error: Error) => void>();
  readonly written: JsonObject[] = [];
  stopped = false;
  confirmStopped?: () => boolean;
  mode: 'public' | 'silent' | 'unknown' | 'duplicate' | 'hold' = 'public';
  nativeId = 'native-controller';
  turns = 0;
  onMessage(listener: (message: JsonObject) => void): () => void { this.messages.add(listener); return () => this.messages.delete(listener); }
  onFailure(listener: (error: Error) => void): () => void { this.failures.add(listener); return () => this.failures.delete(listener); }
  emit(message: JsonObject): void { queueMicrotask(() => this.messages.forEach(listener => listener(message))); }
  write(message: JsonObject): void {
    if (this.stopped) throw new Error('closed');
    this.written.push(message);
    const params = message.params as JsonObject;
    if (message.method === 'initialize') this.emit({ id: message.id, result: {} });
    else if (message.method === 'thread/read') this.emit({ id: message.id, result: { thread: { reasoningEffort: (this.written.findLast(m => m.method === 'turn/start')?.params as JsonObject)?.effort ?? null } } });
    else if (message.method === 'model/list') this.emit({ id: message.id, result: { data: [{ model: 'gpt-6.1-sol', supportedReasoningEfforts: [{ reasoningEffort: 'medium' }, { reasoningEffort: 'xhigh' }] }] } });
    else if (message.method === 'config/read') this.emit({ id: message.id, result: { config: { model_provider: 'current-provider', model: 'gpt-6.1-sol' } } });
    else if (message.method === 'thread/start' || message.method === 'thread/resume') this.emit({ id: message.id, result: { thread: { id: this.nativeId }, modelProvider: 'current-provider', model: 'gpt-6.1-sol', reasoningEffort: 'medium' } });
    else if (message.method === 'turn/start') {
      this.turns++; this.emit({ id: message.id, result: { turn: { id: `turn-${this.turns}` } } });
      this.emit({ method: 'turn/started', params: { threadId: this.nativeId, turn: { id: `turn-${this.turns}` } } });
      if (this.mode === 'hold') return;
      if (this.mode === 'silent') this.complete();
      else { const params = { threadId: this.nativeId, turnId: `turn-${this.turns}`, callId: `call-${this.turns}`, tool: this.mode === 'unknown' ? 'exec_command' : 'bridge_send_user', arguments: JSON.stringify({ text: '已派发，继续聊。', command: 'must never run' }) }; this.emit({ id: 900 + this.turns, method: 'item/tool/call', params }); if (this.mode === 'duplicate') this.emit({ id: 1900 + this.turns, method: 'item/tool/call', params }); }
    } else if (message.id === 900 + this.turns && !message.method) this.complete();
  }
  complete(): void { this.emit({ method: 'turn/completed', params: { threadId: this.nativeId, turn: { id: `turn-${this.turns}`, status: 'completed', items: [{ type: 'agentMessage', text: 'PRIVATE INTERNAL REPLY MUST BE HIDDEN', phase: 'final_answer' }] } } }); }
  async stop(): Promise<void> { this.stopped = true; }
}
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-native-'));
  const userHome = join(dir, 'user'); mkdirSync(join(userHome, '.codex'), { recursive: true });
  writeFileSync(join(userHome, '.codex', 'config.toml'), 'model_provider="a"\n');
  const transports: FakeTransport[] = [], launches: { args: string[]; env: NodeJS.ProcessEnv }[] = [];
  let mode: FakeTransport['mode'] = 'public';
  const invokes: string[] = [], published: { text: string; key?: string }[] = [];
  let managementHold: Promise<unknown> | undefined;
  let metadataReads = 0, metadataUnavailable = false;
  const adapter = new NativeControllerAdapter({ command: 'fake', args: [] }, { HTTP_PROXY: 'http://127.0.0.1:7898' }, { agent: 'codex', dataDir: join(dir, 'data'), userHome, contextWorkspace: dir,
    metadataAdapter: { run: async () => { throw new Error('metadata only'); }, interrupt: async () => {}, close: async () => {}, getModelInfo: async () => { metadataReads++; if (metadataUnavailable) throw new Error('独立探测不可用'); return { defaultModel: 'gpt-6.1-sol', models: [{ id: 'gpt-6.1-sol', displayName: 'Sol', supportedEfforts: ['medium', 'xhigh'] }] }; } },
    invokeTool: async (_turn, name) => { invokes.push(name); return managementHold ?? {}; },
    createTransport: (_command, args, _cwd, env) => { const t = new FakeTransport(); t.mode = mode; transports.push(t); launches.push({ args, env }); return t; },
  });
  const makeTurn = (): AgentTurn => ({ conversation: { id: 'conversation-1', userId: 'u', agent: 'codex', nativeId: null, title: '', cwd: dir, createdAt: '', updatedAt: '' }, text: '请调查', imagePaths: [], signal: new AbortController().signal, onProgress: () => {}, onPublicMessage: async (text, _paths, key) => { published.push({ text, key }); } });
  return { dir, userHome, adapter, transports, launches, invokes, published, makeTurn, get metadataReads() { return metadataReads; }, disableMetadata: () => { metadataUnavailable = true; }, setMode: (value: FakeTransport['mode']) => { mode = value; }, holdManagement: (promise: Promise<unknown>) => { managementHold = promise; }, cleanup: async () => { await adapter.close(); rmSync(dir, { recursive: true, force: true }); } };
}
function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!check()) { if (Date.now() > deadline) throw new Error('condition timeout'); await new Promise(resolve => setTimeout(resolve, 5)); }
}
function tool(transport: FakeTransport, id: number, callId: string, name: string, args: JsonObject): void {
  transport.emit({ id, method: 'item/tool/call', params: { threadId: transport.nativeId,
    turnId: `turn-${transport.turns}`, callId, tool: name, arguments: JSON.stringify(args) } });
}
for (const failure of ['error', 'failed'] as const) test(`confirmed final delivery survives native ${failure} while retaining its diagnostic and original session`, async () => {
  const s = setup(); s.setMode('hold');
  try {
    const turn = s.makeTurn(); turn.event = { kind: 'worker-result', text: 'A saved worker report' };
    const running = s.adapter.run(turn); await until(() => s.transports[0]?.turns === 1); const transport = s.transports[0]!;
    tool(transport, 5101, 'final-before-capacity', 'bridge_send_user', { text: '最终汇总正文' });
    await until(() => transport.written.some(value => value.id === 5101 && !value.method));
    const error = { message: 'Selected model is at capacity. Bearer private-fixture-secret' };
    if (failure === 'error') transport.emit({ method: 'error', params: { threadId: transport.nativeId, turnId: 'turn-1', willRetry: false, error } });
    else transport.emit({ method: 'turn/completed', params: { threadId: transport.nativeId, turn: { id: 'turn-1', status: 'failed', error } } });
    const result = await running;
    assert.equal(result.controlledOutput, true); assert.equal(result.nativeId, transport.nativeId); assert.equal(s.published.length, 1);
    assert.match(result.postDeliveryError!, /at capacity/); assert(!result.postDeliveryError!.includes('private-fixture-secret'));
    assert.equal(transport.stopped, true); assert.deepEqual(s.invokes, []);
    s.setMode('public'); const next = s.makeTurn(); next.conversation.nativeId = result.nativeId;
    const resumed = await s.adapter.run(next);
    assert.equal(resumed.nativeId, result.nativeId); assert.equal(resumed.postDeliveryError, undefined);
    assert.equal(s.transports.length, 2); assert.equal(s.published.length, 2);
    assert.equal((s.transports[1]!.written.find(value => value.method === 'thread/resume')!.params as JsonObject).threadId, result.nativeId);
  } finally { await s.cleanup(); }
});

for (const supplement of [false, true]) test(`native model failure without a confirmed final stays failed (supplement=${supplement})`, async () => {
  const s = setup(); s.setMode('hold');
  try {
    const running = s.adapter.run(s.makeTurn()), rejected = assert.rejects(running, /at capacity/);
    await until(() => s.transports[0]?.turns === 1); const transport = s.transports[0]!;
    if (supplement) {
      tool(transport, 5201, 'supplement-before-capacity', 'bridge_send_message', { targetId: 'private', text: '进度', finish: false });
      await until(() => transport.written.some(value => value.id === 5201 && !value.method));
    }
    transport.emit({ method: 'error', params: { threadId: transport.nativeId, turnId: 'turn-1', willRetry: false, error: { message: 'Selected model is at capacity.' } } });
    await rejected; assert.equal(s.published.length, supplement ? 1 : 0); assert.deepEqual(s.invokes, []);
  } finally { await s.cleanup(); }
});

test('native model failure during final publication cannot hide an actual delivery failure or resend it', async () => {
  const s = setup(); s.setMode('hold'); const hold = gate(); let attempts = 0;
  try {
    const turn = s.makeTurn(); turn.onPublicMessage = async () => { attempts++; await hold.promise; throw new Error('delivery remained unknown'); };
    const running = s.adapter.run(turn), rejected = assert.rejects(running, /delivery remained unknown/);
    await until(() => s.transports[0]?.turns === 1); const transport = s.transports[0]!;
    tool(transport, 5301, 'pending-before-capacity', 'bridge_send_user', { text: '正文' }); await until(() => attempts === 1);
    transport.emit({ method: 'error', params: { threadId: transport.nativeId, turnId: 'turn-1', willRetry: false, error: { message: 'Selected model is at capacity.' } } });
    await until(() => transport.stopped); hold.release(); await rejected;
    assert.equal(attempts, 1); assert.deepEqual(s.invokes, []);
  } finally { hold.release(); await s.cleanup(); }
});

test('controller removes computer capabilities and native collaboration while retaining the bounded management host', () => {
  const overrides = codexControllerOverrides();
  assert.ok(overrides.includes('agents.enabled=false'));
  assert.ok(overrides.includes('features.shell_tool=false'));
  assert.ok(overrides.includes('features.browser_use=false'));
  assert.ok(overrides.includes('mcp_servers={}'));
  assert.ok(overrides.includes('features.code_mode_host=true'));
});
test('isolated Codex config preserves provider routing but excludes hooks, MCP, plugins, and custom agent roles', () => {
  const filtered = parseTOML(isolatedCodexConfig('model="gpt-6.1-sol"\nmodel_provider="gateway"\n[model_providers.gateway]\nbase_url="https://example.invalid"\nwire_api="responses"\n[model_providers.gateway.http_headers]\nX-Test="keep-route"\n[mcp_servers.canary]\ncommand="never-launch"\n[hooks]\ncanary="never-launch"\n[plugins.canary]\nenabled=true\n[agents.worker]\nconfig_file="never-read"\n'));
  assert.equal(filtered.model_provider, 'gateway');
  assert.deepEqual(filtered.model_providers, parseTOML('[gateway]\nbase_url="https://example.invalid"\nwire_api="responses"\n[gateway.http_headers]\nX-Test="keep-route"\n'));
  assert.equal(filtered.mcp_servers, undefined); assert.equal(filtered.hooks, undefined); assert.equal(filtered.plugins, undefined);
  assert.equal((filtered.agents as JsonObject).enabled, false); assert.equal((filtered.agents as JsonObject).worker, undefined);
});
test('persistent controller publishes only explicit messages with native IDs and hides final text', async () => {
  const s = setup(); try {
    const first = await s.adapter.run(s.makeTurn()), second = await s.adapter.run(s.makeTurn());
    assert.equal(first.nativeId, second.nativeId); assert.equal(s.transports.length, 1);
    assert.equal(first.text, ''); assert.equal(first.controlledOutput, true);
    assert.deepEqual(s.published.map(p => p.key), ['call-1', 'call-2']); assert.deepEqual(s.invokes, []);
    assert.notEqual(s.launches[0]?.env.CODEX_HOME, join(s.userHome, '.codex'));
    const input = (s.transports[0]!.written.find(message => message.method === 'turn/start')!.params as JsonObject).input as { text: string }[];
    const runtime = input.find(item => item.text?.includes('[Bridge runtime;'))!.text;
    assert.match(runtime, /"observedModel":"gpt-6.1-sol"/); assert.match(runtime, /"observedEffort":"medium"/);
    assert.match(runtime, /before dispatch/);
  } finally { await s.cleanup(); }
});
test('unsupported tool execution is rejected and never dispatched', async () => {
  const s = setup(); s.setMode('unknown'); try {
    await assert.rejects(s.adapter.run(s.makeTurn()), /没有通过公开通道/);
    assert.deepEqual(s.invokes, []); assert.deepEqual(s.published, []);
    const result = s.transports[0]?.written.find(m => m.id === 901 && !m.method)?.result as JsonObject;
    assert.equal(result.success, false);
  } finally { await s.cleanup(); }
});
test('a silent final answer never falsely completes an ordinary human request', async () => {
  const s = setup(); s.setMode('silent'); try { await assert.rejects(s.adapter.run(s.makeTurn()), /没有通过公开通道/); }
  finally { await s.cleanup(); }
});
test('background evidence uses standalone tool output and may quietly continue', async () => {
  const s = setup(); s.setMode('silent'); try {
    const turn = s.makeTurn(); turn.event = { kind: 'worker-result', toolName: 'bridge_worker_result', text: 'confirmed evidence' };
    const result = await s.adapter.run(turn); assert.equal(result.controlledOutput, true);
    const start = s.transports[0]?.written.find(m => m.method === 'turn/start')?.params as JsonObject;
    assert.deepEqual(start.input, []); assert.deepEqual({ ...start.toolOutput as object, output: 'confirmed evidence' }, { name: 'bridge_worker_result', namespace: null, output: 'confirmed evidence' });
    assert.match((start.toolOutput as { output: string }).output, /^\[Bridge chat input;.*"kind":"background-evidence".*\n\[Bridge Bot identity;.*\n\[Bridge clock.*UTC: .*timezone: .*/);
    assert.match((start.toolOutput as { output: string }).output, /\[Bridge runtime;.*"observedModel":"gpt-6.1-sol"/);
    assert.match((start.toolOutput as { output: string }).output, /\n\nconfirmed evidence$/);
  } finally { await s.cleanup(); }
});

test('workspace bootstrap can finish quietly and feeds evidence into the same native conversation', async () => {
  const s = setup(); s.setMode('silent'); try {
    const turn = s.makeTurn();
    turn.event = { kind: 'workspace-context', toolName: 'bridge_workspace_context', text: '工位 11032022110008；工作习惯读取 MyHaruSkills README。' };
    const initialized = await s.adapter.run(turn);
    assert.equal(s.published.length, 0);
    const params = s.transports[0]!.written.find(message => message.method === 'turn/start')!.params as JsonObject;
    assert.deepEqual(params.input, []);
    assert.deepEqual({ ...params.toolOutput as object, output: turn.event.text }, { name: 'bridge_workspace_context', namespace: null, output: turn.event.text });
    assert.ok((params.toolOutput as { output: string }).output.endsWith(turn.event.text));
    const created = s.transports[0]!.written.find(message => message.method === 'thread/start')!.params as JsonObject;
    const bridgePrompt = `${created.baseInstructions} ${created.developerInstructions}`;
    assert(!bridgePrompt.includes(turn.event.text));
    assert(!/Chinese|Haru|MyHaruSkills|SuchProject/.test(bridgePrompt));
    assert.match(bridgePrompt, /user-maintained workspace-context input/);
    assert.match(bridgePrompt, /need no initialization worker/);
    s.transports[0]!.mode = 'public';
    const next = s.makeTurn(); next.conversation.nativeId = initialized.nativeId;
    const result = await s.adapter.run(next);
    assert.equal(result.nativeId, initialized.nativeId);
    assert.equal(s.transports.length, 1);
    assert.equal(s.published.length, 1);
  } finally { await s.cleanup(); }
});

test('workspace evidence may explicitly answer an existing question and obeys normal publication sealing', async () => {
  const s = setup(); s.setMode('hold'); try {
    const turn = s.makeTurn(); turn.event = { kind: 'workspace-context', toolName: 'bridge_workspace_context', text: 'Verified workstation navigation.' };
    const pending = s.adapter.run(turn);
    await until(() => s.transports[0]?.turns === 1);
    const transport = s.transports[0]!;
    tool(transport, 3000, 'status', 'bridge_list_workers', {});
    await until(() => s.invokes.length === 1);
    tool(transport, 3001, 'answer', 'bridge_send_user', { text: '已收到导航，工位是 11032022110008。' });
    await until(() => s.published.length === 1);
    assert.deepEqual(s.invokes, ['bridge_list_workers']);
    assert.equal(s.published[0]!.text, '已收到导航，工位是 11032022110008。');
    tool(transport, 3002, 'late-work', 'bridge_start_worker', { title: 'not admitted', prompt: 'not admitted' });
    const result = await pending;
    assert.equal(result.controlledOutput, true);
    assert.deepEqual(s.invokes, ['bridge_list_workers']);
    assert.equal(s.published.length, 1);
  } finally { await s.cleanup(); }
});

test('CC Switch changes rebuild the process while retaining the original native session', async () => {
  const s = setup(); try {
    const turn = s.makeTurn(), first = await s.adapter.run(turn); turn.conversation.nativeId = first.nativeId;
    writeFileSync(join(s.userHome, '.codex', 'config.toml'), 'model_provider="b"\n');
    await s.adapter.run(turn); assert.equal(s.transports.length, 2); assert.equal(s.transports[0]?.stopped, true);
    const resumed = s.transports[1]?.written.find(m => m.method === 'thread/resume')?.params as JsonObject;
    assert.equal(resumed.threadId, first.nativeId); assert.equal(resumed.modelProvider, 'current-provider');
  } finally { await s.cleanup(); }
});
test('source auth deletion clears the isolated credential instead of retaining a stale login', async () => {
  const s = setup(); const auth = join(s.userHome, '.codex', 'auth.json'); writeFileSync(auth, '{"OPENAI_API_KEY":"isolated-test-placeholder"}');
  try {
    const turn = s.makeTurn(); const first = await s.adapter.run(turn); turn.conversation.nativeId = first.nativeId;
    const copied = join(s.launches[0]!.env.CODEX_HOME!, 'auth.json'); assert.equal(existsSync(copied), true);
    unlinkSync(auth); await s.adapter.run(turn); assert.equal(existsSync(copied), false);
  } finally { await s.cleanup(); }
});
test('duplicate native requests share an in-flight publication promise', async () => {
  const s = setup(); s.setMode('duplicate'); try {
    let attempts = 0; const turn = s.makeTurn();
    turn.onPublicMessage = async () => { attempts++; await new Promise(resolve => setTimeout(resolve, 10)); };
    await s.adapter.run(turn); assert.equal(attempts, 1);
  } finally { await s.cleanup(); }
});
test('an uncertain public delivery stops the controller instead of retrying with a new ID', async () => {
  const s = setup(); try {
    const turn = s.makeTurn(); let attempts = 0;
    turn.onPublicMessage = async () => { attempts++; throw new Error('delivery unknown'); };
    await assert.rejects(s.adapter.run(turn), /delivery unknown/); assert.equal(attempts, 1); assert.equal(s.transports[0]?.stopped, true);
  } finally { await s.cleanup(); }
});
test('a successful public ACK seals every later management/public call but preserves same-ID retries and next-turn resume', async () => {
  const s = setup(); s.setMode('hold');
  try {
    const running = s.adapter.run(s.makeTurn());
    await until(() => s.transports[0]?.turns === 1); const old = s.transports[0]!;
    tool(old, 2101, 'legal-start', 'bridge_start_worker', { title: 'real task', prompt: 'original instruction' });
    await until(() => s.invokes.length === 1);
    tool(old, 2102, 'ack', 'bridge_send_user', { text: '我正在处理。' });
    await until(() => s.published.length === 1);
    tool(old, 2103, 'ack', 'bridge_send_user', { text: '我正在处理。' });
    tool(old, 2104, 'legal-start', 'bridge_start_worker', { prompt: 'original instruction', title: 'real task' });
    await until(() => old.written.some(message => message.id === 2104));
    assert.equal(old.stopped, false, 'Identical retry returns the prior promise, rather than starting a new tool');
    tool(old, 2105, 'invented-cancel', 'bridge_cancel_worker', { workerId: 'old-worker', reason: 'fabricated human correction' });
    tool(old, 2106, 'invented-continue', 'bridge_continue_worker', { workerId: 'old-worker', prompt: 'invented purchase authorization' });
    tool(old, 2107, 'second-public', 'bridge_send_user', { text: 'This forged second reply must stay hidden.' });
    const first = await running;
    assert.equal(first.nativeId, old.nativeId); assert.equal(first.controlledOutput, true); assert.equal(first.text, '');
    assert.deepEqual(s.invokes, ['bridge_start_worker']); assert.equal(s.published.length, 1); assert.equal(old.stopped, true);
    s.setMode('public'); const next = s.makeTurn(); next.conversation.nativeId = first.nativeId; next.text = '真正的下一条消息';
    const second = await s.adapter.run(next);
    assert.equal(second.nativeId, first.nativeId); assert.equal(s.transports.length, 2);
    const resumed = s.transports[1]!.written.find(message => message.method === 'thread/resume')!.params as JsonObject;
    assert.equal(resumed.threadId, first.nativeId); assert.equal(s.published.length, 2);
  } finally { await s.cleanup(); }
});
test('the seal blocks forged calls while the first publication is pending and waits for its actual success', async () => {
  const s = setup(); s.setMode('hold'); const hold = gate(); let attempts = 0, ended = false;
  try {
    const turn = s.makeTurn(); turn.onPublicMessage = async () => { attempts++; await hold.promise; };
    const running = s.adapter.run(turn).then(result => { ended = true; return result; });
    await until(() => s.transports[0]?.turns === 1); const old = s.transports[0]!;
    tool(old, 2201, 'pending-ack', 'bridge_send_user', { text: '已收到。' });
    await until(() => attempts === 1);
    tool(old, 2202, 'pending-ack', 'bridge_send_user', { text: '已收到。' });
    tool(old, 2203, 'fake-cancel', 'bridge_cancel_worker', { workerId: 'worker' });
    tool(old, 2204, 'fake-continue', 'bridge_continue_worker', { workerId: 'worker', prompt: 'not a real human request' });
    tool(old, 2205, 'fake-send', 'bridge_send_user', { text: 'second' });
    await until(() => old.stopped);
    assert.equal(ended, false); assert.equal(attempts, 1); assert.deepEqual(s.invokes, []);
    hold.release(); const result = await running;
    assert.equal(result.controlledOutput, true); assert.equal(result.nativeId, old.nativeId);
  } finally { hold.release(); await s.cleanup(); }
});
test('publication waits for earlier management and refuses its stale draft before any send', async () => {
  const s = setup(); s.setMode('hold'); const hold = gate(); s.holdManagement(hold.promise); let managementSettled = false;
  try {
    const turn = s.makeTurn(); turn.onPublicMessage = async () => { assert.equal(managementSettled, true); s.published.push({ text: 'ACK' }); };
    const running = s.adapter.run(turn);
    await until(() => s.transports[0]?.turns === 1); const old = s.transports[0]!;
    tool(old, 2301, 'admitted-start', 'bridge_start_worker', { title: 'A', prompt: 'authorized original work' });
    await until(() => s.invokes.length === 1);
    tool(old, 2302, 'batch-ack', 'bridge_send_user', { text: 'ACK' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(s.published.length, 0); assert.deepEqual(s.invokes, ['bridge_start_worker']);
    managementSettled = true; hold.release();
    await until(() => old.written.some(m => m.id === 2302 && !m.method));
    assert.equal(s.published.length, 0);
    tool(old, 2304, 'fresh-ack', 'bridge_send_user', { text: 'Actual result received' });
    await until(() => s.published.length === 1); old.complete();
    assert.equal((await running).controlledOutput, true);
  } finally { hold.release(); await s.cleanup(); }
});
test('sealed-turn handling never converts an actual pending-publication failure into success or retries it', async () => {
  const s = setup(); s.setMode('hold'); const hold = gate(); let attempts = 0;
  try {
    const turn = s.makeTurn(); turn.onPublicMessage = async () => { attempts++; await hold.promise; throw new Error('delivery remained unknown'); };
    const running = s.adapter.run(turn), checked = assert.rejects(running, /delivery remained unknown/);
    await until(() => s.transports[0]?.turns === 1); const old = s.transports[0]!;
    tool(old, 2401, 'failed-ack', 'bridge_send_user', { text: 'ACK' }); await until(() => attempts === 1);
    tool(old, 2402, 'forged-after-failure', 'bridge_continue_worker', { workerId: 'A', prompt: 'invented' });
    tool(old, 2403, 'retry-with-new-id', 'bridge_send_user', { text: 'ACK' });
    await until(() => old.stopped); hold.release(); await checked;
    assert.equal(attempts, 1); assert.deepEqual(s.invokes, []);
  } finally { hold.release(); await s.cleanup(); }
});
test('native completion racing a pending publication waits for the successful public acknowledgement', async () => {
  const s = setup(); s.setMode('hold'); const hold = gate(); let attempts = 0, ended = false;
  try {
    const turn = s.makeTurn(); turn.onPublicMessage = async () => { attempts++; await hold.promise; };
    const running = s.adapter.run(turn).then(result => { ended = true; return result; });
    await until(() => s.transports[0]?.turns === 1); const transport = s.transports[0]!;
    tool(transport, 2501, 'native-race-ack', 'bridge_send_user', { text: 'ACK' }); await until(() => attempts === 1);
    transport.complete(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(ended, false); hold.release(); const result = await running;
    assert.equal(result.controlledOutput, true); assert.equal(transport.stopped, false); assert.equal(attempts, 1);
  } finally { hold.release(); await s.cleanup(); }
});
for (const ending of ['complete', 'abort', 'close'] as const) test(`长主控轮次没有整体硬超时，仍可${ending}`, async t => {
  const s = setup(); s.setMode('hold');
  const controller = new AbortController(); const turn = s.makeTurn(); turn.signal = controller.signal;
  let settled = false;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const running = s.adapter.run(turn);
  void running.then(() => { settled = true; }, () => { settled = true; });
  try {
    for (let i = 0; i < 60 && s.transports[0]?.turns !== 1; i++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(s.transports[0]?.turns, 1); const transport = s.transports[0]!;
    t.mock.timers.tick(600_000); await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false); assert.equal(transport.stopped, false);
    t.mock.timers.reset();
    if (ending === 'complete') {
      tool(transport, 6001, 'late-public', 'bridge_send_user', { text: '长轮次正常完成。' });
      await until(() => s.published.length === 1); transport.complete();
      const result = await running; assert.equal(result.nativeId, transport.nativeId);
      transport.mode = 'public'; const next = s.makeTurn(); next.conversation.nativeId = result.nativeId;
      assert.equal((await s.adapter.run(next)).nativeId, result.nativeId); assert.equal(s.transports.length, 1);
    } else {
      const rejected = assert.rejects(running, error => error instanceof Error && error.name === 'AbortError');
      if (ending === 'abort') controller.abort(); else await s.adapter.close();
      await rejected; assert.equal(transport.stopped, true);
    }
  } finally { t.mock.timers.reset(); await s.cleanup(); }
});

test('公开回复已送达的长轮次不因墙钟经过而失败或重发', async t => {
  const s = setup(); s.setMode('hold'); let settled = false;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const running = s.adapter.run(s.makeTurn()); void running.then(() => { settled = true; }, () => { settled = true; });
  try {
    for (let i = 0; i < 60 && s.transports[0]?.turns !== 1; i++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(s.transports[0]?.turns, 1); const transport = s.transports[0]!;
    tool(transport, 6002, 'delivered-before-wait', 'bridge_send_user', { text: '已派发。' });
    for (let i = 0; i < 60 && s.published.length !== 1; i++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(s.published.length, 1); t.mock.timers.tick(600_000);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false); assert.equal(transport.stopped, false); assert.equal(s.published.length, 1);
    transport.complete(); assert.equal((await running).controlledOutput, true); assert.equal(s.published.length, 1);
  } finally { t.mock.timers.reset(); await s.cleanup(); }
});

test('Claude 主控长轮次等待真实完成，不设整体墙钟硬超时', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-claude-long-turn-')); const transport = new FakeTransport();
  transport.write = message => {
    transport.written.push(message);
    if (message.type === 'user') transport.emit({ type: 'system', subtype: 'init', session_id: 'claude-long-native', tools: [] });
  };
  const adapter = new NativeControllerAdapter({ command: 'fake', args: [] }, {}, { agent: 'claude', dataDir: dir, userHome: dir,
    invokeTool: async () => ({}), createTransport: () => transport });
  const turn: AgentTurn = { conversation: { id: 'c', userId: 'u', agent: 'claude', nativeId: 'claude-long-native', cwd: dir, title: '', createdAt: '', updatedAt: '' },
    text: '', imagePaths: [], event: { kind: 'wake', text: 'existing evidence' }, signal: new AbortController().signal, onProgress: () => {} };
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let settled = false, failure: unknown; const running = adapter.run(turn); void running.then(() => { settled = true; }, error => { settled = true; failure = error; });
  try {
    for (let i = 0; i < 60 && !transport.written.some(message => message.type === 'user'); i++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(transport.written.some(message => message.type === 'user'), true); t.mock.timers.tick(600_000);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false, String(failure)); assert.equal(transport.stopped, false);
    transport.emit({ type: 'result', subtype: 'success', session_id: 'claude-long-native', result: 'DONE' });
    assert.equal((await running).nativeId, 'claude-long-native');
  } finally { t.mock.timers.reset(); await adapter.close(); rmSync(dir, { recursive: true, force: true }); }
});
test('主控保留单条 turn/start RPC 的响应超时', async t => {
  const s = setup(); s.setMode('hold'); t.mock.timers.enable({ apis: ['setTimeout'] });
  const originalFactory = (s.adapter as unknown as { options: { createTransport: (...args: unknown[]) => RpcTransport } }).options.createTransport;
  (s.adapter as unknown as { options: { createTransport: (...args: unknown[]) => RpcTransport } }).options.createTransport = (...args) => {
    const transport = originalFactory(...args) as FakeTransport; const originalWrite = transport.write.bind(transport);
    transport.write = message => { if (message.method === 'turn/start') transport.written.push(message); else originalWrite(message); };
    return transport;
  };
  const running = s.adapter.run(s.makeTurn()); const rejected = assert.rejects(running, /Codex turn\/start 等待响应超时/);
  try {
    for (let i = 0; i < 60 && !s.transports[0]?.written.some(message => message.method === 'turn/start'); i++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(s.transports[0]?.written.some(message => message.method === 'turn/start'), true);
    t.mock.timers.tick(20_001); await rejected; assert.equal(s.transports[0]!.stopped, true);
  } finally { t.mock.timers.reset(); await s.cleanup(); }
});
test('abort, interrupt, and the following turn await one physical process shutdown', async () => {
  const s = setup(); s.setMode('hold');
  try {
    const controller = new AbortController(), turn = s.makeTurn(); turn.signal = controller.signal;
    let ended = false, interrupted = false, stopCalls = 0, releaseStop!: () => void;
    const running = s.adapter.run(turn).then(() => { throw new Error('aborted turn completed'); }, error => { ended = true; assert.equal(error.name, 'AbortError'); });
    for (let index = 0; s.transports[0]?.turns !== 1 && index < 20; index++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(s.transports[0]?.turns, 1);
    const old = s.transports[0]!;
    old.stop = async () => { stopCalls++; await new Promise<void>(resolve => { releaseStop = resolve; }); old.stopped = true; };
    controller.abort();
    const interruption = s.adapter.interrupt(turn.conversation.id).then(() => { interrupted = true; });
    s.setMode('public'); const nextTurn = s.makeTurn(); nextTurn.conversation.nativeId = old.nativeId;
    const next = s.adapter.run(nextTurn);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(stopCalls, 1); assert.equal(ended, false); assert.equal(interrupted, false); assert.equal(s.transports.length, 1);
    releaseStop(); await Promise.all([running, interruption]);
    const result = await next; assert.equal(result.nativeId, old.nativeId); assert.equal(s.transports.length, 2); assert.equal(old.stopped, true);
  } finally { await s.cleanup(); }
});
test('unconfirmed process shutdown rejects abort, interrupt, restart, and close without launching another CLI', async () => {
  const s = setup(); s.setMode('hold');
  try {
    const controller = new AbortController(), turn = s.makeTurn(); turn.signal = controller.signal;
    const running = s.adapter.run(turn); const checked = assert.rejects(running, error => error instanceof Error && error.name === 'AgentProcessStopError');
    for (let index = 0; s.transports[0]?.turns !== 1 && index < 20; index++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(s.transports[0]?.turns, 1);
    const stopError = new Error('process exit unconfirmed'); stopError.name = 'AgentProcessStopError';
    let stopCalls = 0; s.transports[0]!.stop = async () => { stopCalls++; throw stopError; };
    controller.abort(); await checked;
    await assert.rejects(s.adapter.interrupt(turn.conversation.id), error => error === stopError);
    await assert.rejects(s.adapter.run(s.makeTurn()), error => error === stopError);
    await assert.rejects(s.adapter.close(), error => error === stopError);
    assert.equal(stopCalls, 1); assert.equal(s.transports.length, 1);
  } finally { await s.adapter.close().catch(() => {}); rmSync(s.dir, { recursive: true, force: true }); }
});
test('controller initialization retains its rejection when CLI retirement also fails, without submitting a turn', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-open-cause-')); let confirmed = false; const transport = new FakeTransport();
  transport.confirmStopped = () => confirmed;
  transport.write = m => transport.emit({ id: m.id, error: { code: -1, message: 'initialization rejected fixture' } });
  transport.stop = async () => { throw new AgentProcessStopError(29); };
  const adapter = new NativeControllerAdapter({ command: 'fake', args: [] }, {}, { agent: 'codex', dataDir: dir,
    invokeTool: async () => { throw new Error('must not run'); }, createTransport: () => transport });
  try {
    await assert.rejects(adapter.run({ conversation: { id: 'opening', userId: 'u', agent: 'codex', nativeId: 'same-native',
      title: '', cwd: dir, createdAt: '', updatedAt: '' }, text: 'continue', imagePaths: [], signal: new AbortController().signal, onProgress: () => {} }), error => {
      assert(error instanceof AgentProcessStopError); assert(error.cause instanceof Error);
      assert.match(error.cause.message, /initialization rejected/); return true;
    });
    assert.equal(transport.turns, 0);
  } finally { confirmed = true; await adapter.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('late confirmed controller exit clears only the retired failed session and resumes the same native ID', async () => {
  const s = setup(); s.setMode('hold'); let confirmed = false;
  try {
    const abort = new AbortController(), turn = s.makeTurn(); turn.signal = abort.signal;
    const running = s.adapter.run(turn), rejected = assert.rejects(running, /退出待核对/);
    await until(() => s.transports[0]?.turns === 1); const old = s.transports[0]!;
    let stops = 0; const error = new AgentProcessStopError(17);
    old.stop = async () => { stops++; throw error; }; old.confirmStopped = () => confirmed;
    abort.abort(); await rejected;
    await assert.rejects(s.adapter.run(s.makeTurn()), e => e === error);
    assert.equal(stops, 1); assert.equal(s.transports.length, 1);
    confirmed = true; s.setMode('public'); const next = s.makeTurn(); next.conversation.nativeId = old.nativeId;
    const result = await s.adapter.run(next);
    assert.equal(result.nativeId, old.nativeId); assert.equal(s.transports.length, 2); assert.equal(stops, 1);
    assert.equal((s.transports[1]!.written.find(m => m.method === 'thread/resume')!.params as JsonObject).threadId, old.nativeId);
  } finally { confirmed = true; await s.cleanup(); }
});

test('主控在未授权 tree kill 的收尾失败后可重试退出，保持原生会话且不重放旧轮', async () => {
  const s = setup(); s.setMode('hold'); let confirmed = false;
  try {
    const abort = new AbortController(), turn = s.makeTurn(); turn.signal = abort.signal;
    const running = s.adapter.run(turn), rejected = assert.rejects(running, /退出待核对/);
    await until(() => s.transports[0]?.turns === 1); const old: FakeTransport & { canRetryStop?: () => boolean } = s.transports[0]!;
    let stops = 0;
    old.stop = async () => { if (++stops === 1) throw new AgentProcessStopError(17); confirmed = true; };
    old.confirmStopped = () => confirmed; old.canRetryStop = () => !confirmed;
    abort.abort(); await rejected; assert.equal(stops, 1);
    s.setMode('public'); const next = s.makeTurn(); next.conversation.nativeId = old.nativeId;
    const result = await s.adapter.run(next);
    assert.equal(result.nativeId, old.nativeId); assert.equal(stops, 2); assert.equal(old.turns, 1);
    assert.equal(s.transports.length, 2); assert.equal(s.published.length, 1);
    assert.equal((s.transports[1]!.written.find(m => m.method === 'thread/resume')!.params as JsonObject).threadId, old.nativeId);
  } finally { confirmed = true; await s.cleanup(); }
});

test('native execution error remains the cause when subsequent process shutdown also fails', async () => {
  const s = setup(); s.setMode('hold'); let confirmed = false;
  try {
    const running = s.adapter.run(s.makeTurn());
    const rejected = assert.rejects(running, error => {
      assert(error instanceof AgentProcessStopError);
      assert(error.cause instanceof Error); assert.match(error.cause.message, /at capacity/);
      assert.match((error as unknown as { cleanupError: string }).cleanupError, /退出待核对/); return true;
    });
    await until(() => s.transports[0]?.turns === 1); const old = s.transports[0]!;
    old.stop = async () => { throw new AgentProcessStopError(18); }; old.confirmStopped = () => confirmed;
    old.emit({ method: 'error', params: { threadId: old.nativeId, turnId: 'turn-1', willRetry: false, error: { message: 'Selected model is at capacity.' } } });
    await rejected; assert.equal(old.turns, 1); assert.equal(s.transports.length, 1); assert.deepEqual(s.invokes, []);
  } finally { confirmed = true; await s.cleanup(); }
});

test('Claude MCP seals a real ACK before forged human corrections and resumes the same native session on real input', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-native-claude-seal-'));
  const invokes: string[] = [], published: string[] = [], launches: string[][] = [], transports: FakeTransport[] = [];
  const scripts: Promise<void>[] = [];
  let launch = 0, legitimateSettled = false;
  const adapter = new NativeControllerAdapter({ command: 'fake', args: [] }, {}, {
    agent: 'claude', dataDir: join(dir, 'data'), userHome: join(dir, 'user'),
    invokeTool: async (_turn, name) => { invokes.push(name); await new Promise(resolve => setTimeout(resolve, 15)); legitimateSettled = true; return { workerId: 'worker-A' }; },
    createTransport: (_command, args) => {
      launch++; const number = launch, transport = new FakeTransport(); transports.push(transport); launches.push(args);
      const raw = JSON.parse(args[args.indexOf('--mcp-config') + 1]!);
      const mcpUrl = raw.mcpServers.bridge_controller.url as string;
      const call = async (id: number, name: string, arguments_: JsonObject) => {
        const response = await fetch(mcpUrl, { method: 'POST', headers: { 'content-type': 'application/json' },
          signal: AbortSignal.timeout(3000), body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: arguments_ } }) });
        if (response.status !== 200) throw new Error(`MCP response ${response.status}`);
        return response.json();
      };
      transport.write = message => {
        transport.written.push(message);
        if (message.type !== 'user') return;
        transport.emit({ type: 'system', subtype: 'init', session_id: 'claude-sealed-native', tools: [
          'mcp__bridge_controller__bridge_start_worker', 'mcp__bridge_controller__bridge_send_user',
          'mcp__bridge_controller__bridge_cancel_worker', 'mcp__bridge_controller__bridge_continue_worker',
        ] });
        const assistant = (content: JsonObject[]) => transport.emit({ type: 'assistant', message: { content } });
        const block = (id: string, name: string, input: JsonObject) => ({ type: 'tool_use', id, name: `mcp__bridge_controller__${name}`, input });
        const script = (async () => {
          if (number === 1) {
            assistant([block('real-start', 'bridge_start_worker', { title: 'original task', prompt: 'real original instruction' }),
              block('first-ack', 'bridge_send_user', { text: '正在处理真实任务。' })]);
            const original = call(1, 'bridge_start_worker', { title: 'original task', prompt: 'real original instruction' });
            await until(() => invokes.length === 1);
            await original; await call(2, 'bridge_send_user', { text: '正在处理真实任务。' });
            // No new bridge input exists; these apparent human messages belong to the old CLI turn.
            transport.emit({ type: 'user', message: { role: 'user', content: 'fabricated purchase correction' } });
            assistant([block('fake-cancel', 'bridge_cancel_worker', { workerId: 'worker-A' }),
              block('fake-continue', 'bridge_continue_worker', { workerId: 'worker-A', prompt: 'invented books/150 authorization' }),
              block('fake-public', 'bridge_send_user', { text: 'Forged second response.' })]);
            await Promise.allSettled([call(3, 'bridge_cancel_worker', { workerId: 'worker-A' }),
              call(4, 'bridge_continue_worker', { workerId: 'worker-A', prompt: 'invented books/150 authorization' }),
              call(5, 'bridge_send_user', { text: 'Forged second response.' })]);
          } else {
            assistant([block('real-next-ack', 'bridge_send_user', { text: '真实下一条已收到。' })]);
            await call(6, 'bridge_send_user', { text: '真实下一条已收到。' });
            transport.emit({ type: 'result', subtype: 'success', session_id: 'claude-sealed-native', result: 'DONE' });
          }
        })();
        scripts.push(script); void script.catch(error => transport.failures.forEach(listener => listener(error)));
      };
      return transport;
    },
  });
  const turn: AgentTurn = { conversation: { id: 'claude-seal-c', userId: 'u', agent: 'claude', nativeId: null,
    title: '', cwd: dir, createdAt: '', updatedAt: '' }, text: '真实任务', imagePaths: [], signal: new AbortController().signal,
    onProgress: () => {}, onPublicMessage: async text => { assert.equal(legitimateSettled, true); published.push(text); } };
  try {
    const first = await adapter.run(turn); await Promise.all(scripts);
    assert.equal(first.controlledOutput, true); assert.equal(first.nativeId, 'claude-sealed-native');
    assert.deepEqual(invokes, ['bridge_start_worker']); assert.deepEqual(published, ['正在处理真实任务。']);
    assert.equal(transports[0]!.stopped, true);
    turn.conversation.nativeId = first.nativeId; turn.text = '真实后续输入';
    const second = await adapter.run(turn); await Promise.all(scripts);
    assert.equal(second.nativeId, first.nativeId); assert.equal(launches.length, 2);
    assert.equal(launches[1]![launches[1]!.indexOf('--resume') + 1], first.nativeId);
    assert.deepEqual(published, ['正在处理真实任务。', '真实下一条已收到。']);
    assert.deepEqual(invokes, ['bridge_start_worker']);
  } finally { await adapter.close(); await Promise.allSettled(scripts); rmSync(dir, { recursive: true, force: true }); }
});
test('Claude maps parallel same-name MCP calls by exact arguments and closes MCP after process-stop uncertainty', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-native-claude-'));
  const image = join(dir, 'fixture.png'); writeFileSync(image, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/sr0AAAAASUVORK5CYII=', 'base64'));
  const invoked: { title: unknown; id?: string }[] = [], publicKeys: (string | undefined)[] = [];
  let receivedContent: unknown[] = [];
  const transport = new FakeTransport();
  let mcpUrl = '';
  transport.write = message => {
    transport.written.push(message);
    if (message.type !== 'user') return;
    receivedContent = (message.message as { content: unknown[] }).content;
    transport.emit({ type: 'system', subtype: 'init', session_id: 'claude-native', tools: ['mcp__bridge_controller__bridge_start_worker', 'mcp__bridge_controller__bridge_send_user'] });
    transport.emit({ type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'tool_use', id: 'id-A', name: 'mcp__bridge_controller__bridge_start_worker', input: {} } } });
    transport.emit({ type: 'assistant', message: { content: [
      { type: 'tool_use', id: 'id-A', name: 'mcp__bridge_controller__bridge_start_worker', input: { title: 'A', prompt: 'first task' } },
      { type: 'tool_use', id: 'id-B', name: 'mcp__bridge_controller__bridge_start_worker', input: { title: 'B', prompt: 'second task' } },
    ] } });
    void (async () => {
      const call = async (id: number, name: string, args: JsonObject) => { const response = await fetch(mcpUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }) }); assert.equal(response.status, 200); await response.json(); };
      // Reverse delivery order and object key order while preserving the native calls.
      await Promise.all([call(1, 'bridge_start_worker', { prompt: 'second task', title: 'B' }), call(2, 'bridge_start_worker', { prompt: 'first task', title: 'A' })]);
      transport.emit({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'id-public', name: 'mcp__bridge_controller__bridge_send_user', input: { text: '已安排两个任务。' } }] } });
      await call(3, 'bridge_send_user', { text: '已安排两个任务。' });
      transport.emit({ type: 'result', subtype: 'success', session_id: 'claude-native', result: 'private DONE' });
    })().catch(error => transport.failures.forEach(listener => listener(error)));
  };
  const adapter = new NativeControllerAdapter({ command: 'fake', args: [] }, {}, { agent: 'claude', dataDir: join(dir, 'data'), userHome: join(dir, 'user'), invokeTool: async (_turn, _name, args, id) => { invoked.push({ title: args.title, id }); return {}; }, createTransport: (_command, args) => { const raw = JSON.parse(args[args.indexOf('--mcp-config') + 1]!); mcpUrl = raw.mcpServers.bridge_controller.url; assert.equal(args[args.indexOf('--tools') + 1], ''); return transport; } });
  const turn: AgentTurn = { conversation: { id: 'claude-c', userId: 'u', agent: 'claude', nativeId: null, title: '', cwd: dir, createdAt: '', updatedAt: '' }, text: '请看看图', imagePaths: [image], signal: new AbortController().signal, onProgress: () => {}, onPublicMessage: async (_text, _paths, key) => { publicKeys.push(key); } };
  try {
    await adapter.run(turn);
    assert.deepEqual(invoked.sort((a,b) => String(a.title).localeCompare(String(b.title))), [{ title: 'A', id: 'id-A' }, { title: 'B', id: 'id-B' }]);
    assert.deepEqual(publicKeys, ['id-public']);
    assert.ok(receivedContent.some(item => (item as JsonObject).type === 'image'));
    assert.ok(receivedContent.some(item => String((item as JsonObject).text).includes('[Bridge runtime;')));
    assert.ok(receivedContent.some(item => String((item as JsonObject).text).includes('Preserve user aliases and gateway mappings')));
    assert.ok(receivedContent.some(item => (item as JsonObject).type === 'text' && String((item as JsonObject).text).includes(JSON.stringify(image))));
    transport.stop = async () => { throw new Error('process exit unconfirmed'); };
    await assert.rejects(adapter.close(), /process exit unconfirmed/);
    await assert.rejects(fetch(mcpUrl, { signal: AbortSignal.timeout(1000) }));
  } finally { await adapter.close().catch(() => {}); rmSync(dir, { recursive: true, force: true }); }
});

test('Claude MCP uses fresh connections for every response without replaying failed tools', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-mcp-error-'));
  const transport = new FakeTransport(); let url = ''; let invoked = 0;
  const agent = new HttpAgent({ keepAlive: true, maxSockets: 1 });
  const sockets = new Set<unknown>(); let requests = 0;
  const adapter = new NativeControllerAdapter({ command: 'fake', args: [] }, {}, {
    agent: 'claude', dataDir: dir, userHome: dir,
    invokeTool: async () => { invoked++; if (invoked === 1) throw new Error('测试工具执行失败'); return { recovered: true }; },
    createTransport: (_command, args) => { url = JSON.parse(args[args.indexOf('--mcp-config') + 1]!).mcpServers.bridge_controller.url; return transport; },
  });
  transport.write = message => { transport.written.push(message); if (message.type === 'user') transport.emit({ type: 'system', subtype: 'init', session_id: 'mcp-error-native', tools: [] }); };
  const turn: AgentTurn = { conversation: { id: 'mcp-error-c', userId: 'u', agent: 'claude', nativeId: null, title: '', cwd: dir, createdAt: '', updatedAt: '' },
    text: '', imagePaths: [], event: { kind: 'wake', text: '测试' }, signal: new AbortController().signal, onProgress() {} };
  const running = adapter.run(turn); void running.catch(() => {});
  try {
    await until(() => transport.written.some(message => message.type === 'user'));
    const request = (body: unknown, method = 'POST'): Promise<{ status: number; body: string }> => new Promise((resolve, reject) => {
      const pending = httpRequest(url, { method, agent, headers: { 'content-type': 'application/json' } }, response => {
        const chunks: Buffer[] = []; response.on('data', chunk => chunks.push(chunk)); response.once('error', reject);
        response.once('end', () => {
          try { assert.equal(response.headers.connection, 'close'); resolve({ status: response.statusCode!, body: Buffer.concat(chunks).toString('utf8') }); }
          catch (error) { reject(error); }
        });
      });
      requests++; pending.on('socket', socket => sockets.add(socket)); pending.once('error', reject);
      pending.setTimeout(3000, () => pending.destroy(new Error('MCP test request timed out')));
      pending.end(typeof body === 'string' ? body : JSON.stringify(body));
    });
    assert.equal((await request({ jsonrpc: '2.0', id: 1, method: 'initialize' })).status, 200);
    assert.equal((await request({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).status, 200);
    assert.equal((await request({ jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202);
    assert.equal((await request('', 'GET')).status, 404);
    const call = async (id: number) => {
      const args = { title: '测试任务', prompt: '仅在测试中执行' };
      transport.emit({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'native-' + id, name: 'mcp__bridge_controller__bridge_start_worker', input: args }] } });
      const response = await request({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'bridge_start_worker', arguments: args } });
      assert.equal(response.status, 200); return JSON.parse(response.body) as JsonObject;
    };
    const failed = await call(41);
    assert.equal(failed.jsonrpc, '2.0'); assert.equal(failed.id, 41); assert.equal(failed.error, undefined);
    const result = failed.result as { isError: boolean; content: Array<{ text: string }> };
    assert.equal(result.isError, true); assert.match(result.content[0]!.text, /测试工具执行失败/);
    const recovered = await call(42); assert.equal(recovered.id, 42);
    assert.equal((recovered.result as JsonObject).isError, undefined); assert.equal(invoked, 2);
    const malformed = await request('{');
    assert.equal(malformed.status, 400); const invalid = JSON.parse(malformed.body) as JsonObject;
    assert.equal(invalid.jsonrpc, '2.0'); assert.equal(invalid.id, null); assert.equal((invalid.error as JsonObject).code, -32700);
    assert.equal(requests, 7); assert.equal(sockets.size, requests); assert.equal(invoked, 2);
    transport.emit({ type: 'result', subtype: 'success', session_id: 'mcp-error-native', result: 'DONE' }); await running;
  } finally { agent.destroy(); await adapter.close(); await running.catch(() => {}); rmSync(dir, { recursive: true, force: true }); }
});
test('Codex controller validates on its own initialized connection and reuses unchanged capability without another CLI probe', async () => {
  const s = setup(); s.disableMetadata();
  try {
    const turn = s.makeTurn(); turn.conversation.model = 'gpt-6.1-sol'; turn.conversation.effort = 'xhigh';
    const first = await s.adapter.run(turn); turn.conversation.nativeId = first.nativeId;
    const transport = s.transports[0]!;
    const methods = transport.written.map(m => m.method);
    assert(methods.indexOf('initialize') < methods.indexOf('model/list'));
    assert(methods.indexOf('model/list') < methods.indexOf('thread/start'));
    assert(methods.indexOf('thread/start') < methods.indexOf('turn/start'));
    const reads = methods.filter(m => m === 'model/list').length;
    await s.adapter.run(turn);
    assert.equal(s.transports.length, 1); assert.equal(transport.turns, 2); assert.equal(s.metadataReads, 0);
    assert.equal(transport.written.filter(m => m.method === 'model/list').length, reads);
    assert.equal((await s.adapter.getModelInfo(turn.conversation.cwd, turn.conversation)).defaultModel, 'gpt-6.1-sol');
    assert.equal(s.transports.length, 1); assert.equal(s.metadataReads, 0);
    writeFileSync(join(s.userHome, '.codex', 'config.toml'), 'model_provider="changed"\n');
    await assert.rejects(s.adapter.getModelInfo(turn.conversation.cwd, turn.conversation), /独立探测不可用/);
    assert.equal(s.metadataReads, 1);
    await s.adapter.run(turn);
    assert.equal(s.transports.length, 2); assert.equal(transport.stopped, true); assert.equal(s.metadataReads, 1);
    assert(s.transports[1]!.written.some(m => m.method === 'model/list'));
    assert.equal((s.transports[1]!.written.find(m => m.method === 'thread/resume')!.params as JsonObject).threadId, first.nativeId);
  } finally { await s.cleanup(); }
});

test('Codex controller keeps unsupported effort out of thread and turn submission', async () => {
  const s = setup(); s.disableMetadata();
  try {
    const turn = s.makeTurn(); turn.conversation.model = 'gpt-6.1-sol'; turn.conversation.effort = 'ultra';
    await assert.rejects(s.adapter.run(turn), /不支持/);
    assert.equal(s.metadataReads, 0); assert.equal(s.transports.length, 1);
    assert(s.transports[0]!.stopped);
    assert(!s.transports[0]!.written.some(m => ['thread/start', 'thread/resume', 'turn/start'].includes(String(m.method))));
  } finally { await s.cleanup(); }
});

test('Codex CLI-default continuation reads its live connection and never starts an independent metadata probe', async () => {
  const s = setup(); s.disableMetadata();
  try {
    const turn = s.makeTurn(); turn.conversation.modelPolicy = 'cli-default'; turn.conversation.effort = 'xhigh';
    const first = await s.adapter.run(turn); turn.conversation.nativeId = first.nativeId;
    await s.adapter.run(turn);
    assert.equal(s.metadataReads, 0); assert.equal(s.transports.reduce((n, t) => n + t.turns, 0), 2);
    assert(s.transports.at(-1)!.written.some(m => m.method === 'thread/resume' && (m.params as JsonObject).threadId === first.nativeId));
  } finally { await s.cleanup(); }
});

test('controller effort changes resume original native thread and read CLI settings without guessing', async () => {
  const s = setup(); try {
    const turn = s.makeTurn(); const first = await s.adapter.run(turn); turn.conversation.nativeId = first.nativeId;
    turn.conversation.effort = 'xhigh'; const reports: (string | null)[] = []; turn.onReasoningEffort = e => reports.push(e);
    await s.adapter.run(turn);
    assert.equal(s.transports.length, 2);
    assert.equal((s.transports[1]!.written.find(m => m.method === 'thread/resume')!.params as JsonObject).threadId, first.nativeId);
    assert.equal((s.transports[1]!.written.find(m => m.method === 'turn/start')!.params as JsonObject).effort, 'xhigh');
    assert.deepEqual(reports, [null, 'xhigh']);
    turn.conversation.effort = null; await s.adapter.run(turn);
    const resumed = s.transports[2]!.written.find(m => m.method === 'thread/resume')!.params as JsonObject;
    assert.equal(resumed.config, undefined);
    const start = s.transports[2]!.written.find(m => m.method === 'turn/start')!.params as JsonObject;
    assert.equal(start.effort, undefined);
    turn.conversation.effort = 'ultra'; await assert.rejects(s.adapter.run(turn), /不支持/);
  } finally { await s.cleanup(); }
});

test('Claude controller filters invalid external effort in settings and preserves valid source bytes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-claude-settings-effort-'));
  const sourceDir = join(dir, '.claude'); mkdirSync(sourceDir);
  const source = join(sourceDir, 'settings.json');
  const launches: string[][] = [];
  const adapter = new NativeControllerAdapter({ command: 'fake', args: [] }, {}, {
    agent: 'claude', dataDir: join(dir, 'data'), userHome: dir, invokeTool: async () => ({}),
    createTransport: (_command, args) => {
      launches.push(args); const transport = new FakeTransport();
      transport.write = message => { if (message.type === 'user') {
        transport.emit({ type: 'system', subtype: 'init', session_id: 'same-claude', model: 'sonnet', tools: [] });
        transport.emit({ type: 'result', subtype: 'success', session_id: 'same-claude', result: 'DONE' });
      } }; return transport;
    },
  });
  const turn: AgentTurn = { conversation: { id: 'c', userId: 'u', agent: 'claude', nativeId: 'same-claude',
    title: '', cwd: dir, createdAt: '', updatedAt: '' }, text: '', imagePaths: [],
    event: { kind: 'wake', text: 'fixture' }, signal: new AbortController().signal, onProgress: () => {} };
  try {
    for (const effortLevel of ['ultra', 'xhigh', 'high']) {
      const bytes = Buffer.from(JSON.stringify({ model: 'sonnet', effortLevel, alwaysThinkingEnabled: true }) + '\r\n');
      writeFileSync(source, bytes); await adapter.run(turn);
      const args = launches.at(-1)!;
      const settings = JSON.parse(args[args.indexOf('--settings') + 1]!);
      assert.equal(settings.effortLevel, effortLevel === 'ultra' ? undefined : effortLevel);
      assert.equal(settings.model, 'sonnet'); assert.equal(settings.alwaysThinkingEnabled, true);
      assert.equal(args.includes('--effort'), false);
      assert.deepEqual(readFileSync(source), bytes);
    }
    assert.equal(launches.length, 3);
  } finally { await adapter.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('Claude controller passes its own effort with same native resume and leaves actual effort unknown', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-claude-effort-')); const launches: string[][] = []; let metadataReads = 0;
  const adapter = new NativeControllerAdapter({ command: 'fake', args: [] }, {}, { agent: 'claude', dataDir: dir, userHome: dir,
    invokeTool: async () => ({}),
    metadataAdapter: { run: async () => { throw new Error('metadata only'); }, interrupt: async () => {}, close: async () => {}, getModelInfo: async () => { metadataReads++; return { defaultModel: 'sonnet', models: [{ id: 'sonnet', displayName: 'Sonnet', supportedEfforts: ['high'] }] }; } },
    createTransport: (_command, args) => { launches.push(args); const transport = new FakeTransport();
      transport.write = message => { if (message.type === 'user') {
        transport.emit({ type: 'system', subtype: 'init', session_id: 'claude-original', model: 'sonnet', tools: [] });
        transport.emit({ type: 'result', subtype: 'success', session_id: 'claude-original', result: 'DONE' });
      } }; return transport; },
  });
  const reports: (string | null)[] = [];
  const turn: AgentTurn = { conversation: { id: 'c', userId: 'u', agent: 'claude', nativeId: 'claude-original', effort: 'high', cwd: dir, title: '', createdAt: '', updatedAt: '' }, text: '', imagePaths: [], event: { kind: 'wake', text: 'evidence' }, signal: new AbortController().signal, onProgress: () => {}, onReasoningEffort: e => reports.push(e) };
  try {
    assert.equal((await adapter.run(turn)).nativeId, 'claude-original');
    assert.equal(launches[0]![launches[0]!.indexOf('--effort') + 1], 'high');
    assert.equal(launches[0]![launches[0]!.indexOf('--resume') + 1], 'claude-original');
    assert.deepEqual(reports, [null]);
    assert.equal(metadataReads, 1);
    assert.equal((await adapter.run(turn)).nativeId, 'claude-original');
    assert.equal(metadataReads, 1); assert.equal(launches.length, 1);
    turn.conversation.effort = 'xhigh'; await assert.rejects(adapter.run(turn), /不支持/);
    assert.equal(launches.length, 1);
  } finally { await adapter.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('主控提交后读取强度失败或实际值不同，只更新真实回报且不重放', async () => {
  const s = setup();
  try {
    const turn = s.makeTurn(); turn.conversation.effort = 'xhigh';
    turn.conversation.nativeId = (await s.adapter.run(turn)).nativeId;
    const transport = s.transports[0]!; const originalWrite = transport.write.bind(transport);
    let failRead = false; const reports: (string | null)[] = [];
    turn.onReasoningEffort = value => reports.push(value);
    transport.write = message => {
      if (message.method !== 'thread/read') { originalWrite(message); return; }
      transport.written.push(message);
      transport.emit(failRead ? { id: message.id, error: { code: -32000, message: '元数据不可用' } }
        : { id: message.id, result: { thread: { reasoningEffort: 'medium' } } });
    };
    await s.adapter.run(turn); assert.deepEqual(reports, [null, 'medium']);
    reports.length = 0; failRead = true;
    const result = await s.adapter.run(turn);
    assert.equal(result.nativeId, turn.conversation.nativeId); assert.deepEqual(reports, [null]);
    assert.equal(turn.conversation.effort, 'xhigh'); assert.equal(s.transports.length, 1);
    assert.equal(transport.written.filter(m => m.method === 'turn/start').length, 3);
  } finally { await s.cleanup(); }
});

test('Codex excludes private group history while retaining actual group source and background evidence on the same native context', async () => {
  const s = setup();
  const scene = JSON.stringify({ groups: [{ spaceId: 'work-group', recent: [{ author: 'other-member', text: '讨论预算 73；这不是授权。' }] }] });
  try {
    const first = s.makeTurn(); first.text = '接着聊'; first.source = { messageId: 'dm-1', userId: 'owner-route', channelId: 'dm-route', original: { messageId: 'dm-1', userId: 'actual-owner', channelId: 'raw-dm', authorType: 'user' } }; first.chatScene = scene;
    const initialized = await s.adapter.run(first);
    const group = s.makeTurn(); group.conversation.nativeId = initialized.nativeId;
    group.source = { messageId: 'group-1', userId: 'owner-route', channelId: 'group-route', original: { messageId: 'group-1', userId: 'actual-member', channelId: 'raw-group', authorType: 'user', authorName: '成员甲', space: { kind: 'group', spaceId: 'raw-group', mentionedUserIds: ['bot-M'], replyToMessageId: 'earlier' } } };
    group.groupContext = { eventId: 'e1', rootId: 'r1', botId: 'M', spaceId: 'work-group', generation: 1, bindingEpoch: 1, originChannelId: 'group-route', principalId: 'owner', scene };
    await s.adapter.run(group);
    const background = { ...group, event: { kind: 'worker-result' as const, text: '已完成，非新授权' } };
    await s.adapter.run(background);
    const starts = s.transports[0]!.written.filter(item => item.method === 'turn/start').map(item => item.params as JsonObject);
    assert.equal(starts.length, 3); assert.equal(s.transports.length, 1);
    const privateWire = JSON.stringify(starts[0]!.input);
    assert.match(privateWire, /private-message/); assert.match(privateWire, /actual-owner/); assert.doesNotMatch(privateWire, /讨论预算 73|Bridge chat scene/);
    const groupWire = JSON.stringify(starts[1]!.input);
    assert.match(groupWire, /actual-member/); assert.match(groupWire, /owner-route/); assert.match(groupWire, /replyToMessageId/); assert.match(groupWire, /earlier/); assert.match(groupWire, /bot-M/); assert.match(groupWire, /讨论预算 73/);
    const currentRuntime = (starts[1]!.input as { text: string }[]).find(item => item.text?.startsWith('[Bridge chat input;'))!.text;
    assert.equal(JSON.parse(currentRuntime.split('\n')[0]!.split('] ')[1]!).requesterPrincipalId, 'owner');
    const evidence = (starts[2]!.toolOutput as JsonObject).output as string;
    assert.equal(JSON.parse(evidence.split('\n')[0]!.split('] ')[1]!).requesterPrincipalId, null);
    assert.deepEqual(starts[2]!.input, []); assert.match(evidence, /background-evidence/); assert.match(evidence, /讨论预算 73/); assert.match(evidence, /not fresh authorization/);
    const thread = s.transports[0]!.written.find(item => item.method === 'thread/start')!.params as JsonObject;
    const tools = thread.dynamicTools as JsonObject[];
    assert.ok(tools.some(item => item.name === 'bridge_read_group_history'));
  } finally { await s.cleanup(); }
});

test('native group scene bounds data structurally and preserves unknown author instead of inventing owner identity', async () => {
  const s = setup();
  try {
    const turn = s.makeTurn(); turn.source = { messageId: 'm', userId: 'routing-owner', channelId: 'g' };
    turn.groupContext = { eventId: 'e', rootId: 'r', botId: 'M', spaceId: 'g', generation: 1, bindingEpoch: 1, originChannelId: 'g', principalId: 'owner', scene: JSON.stringify({ records: Array.from({ length: 200 }, (_, id) => ({ id, text: '长'.repeat(6000) })) }) };
    await s.adapter.run(turn);
    const start = s.transports[0]!.written.find(item => item.method === 'turn/start')!.params as JsonObject;
    const runtime = (start.input as { text: string }[]).find(item => item.text?.startsWith('[Bridge chat input;'))!.text;
    const chat = JSON.parse(runtime.split('\n')[0]!.split('] ')[1]!);
    assert.equal(chat.original, null); assert.equal(chat.route.userId, 'routing-owner');
    const sceneLine = runtime.split('\n').find(line => line.startsWith('[Bridge chat scene;'))!;
    const bounded = JSON.parse(sceneLine.slice(sceneLine.indexOf('] ') + 2));
    assert.equal(bounded.truncated, true); assert.ok(sceneLine.length < 32768); assert.ok(Array.isArray(bounded.content.records));
    assert.ok(bounded.content.records.length < 40);
    assert.equal(bounded.content.records.at(-1).id, 199);
    assert.ok(bounded.content.records[0].id > 159);
  } finally { await s.cleanup(); }
});

test('Claude wire excludes private group history and retains group and background scene without resetting its native ID', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-native-chat-scene-'));
  const transports: FakeTransport[] = [], scripts: Promise<void>[] = [];
  const adapter = new NativeControllerAdapter({ command: 'fake', args: [] }, {}, { agent: 'claude', dataDir: join(dir, 'data'), userHome: join(dir, 'user'), invokeTool: async () => ({}),
    createTransport: (_command, args) => {
      const transport = new FakeTransport(); transports.push(transport);
      const url = JSON.parse(args[args.indexOf('--mcp-config') + 1]!).mcpServers.bridge_controller.url as string;
      transport.write = message => {
        transport.written.push(message); if (message.type !== 'user') return;
        transport.emit({ type: 'system', subtype: 'init', session_id: 'claude-chat-native', tools: ['mcp__bridge_controller__bridge_send_user'] });
        const script = (async () => {
          const content = (message.message as JsonObject).content as JsonObject[];
          if (!content.some(item => String(item.text).startsWith('[Background '))) {
            transport.emit({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'reply', name: 'mcp__bridge_controller__bridge_send_user', input: { text: '已了解' } }] } });
            await new Promise(resolve => setImmediate(resolve));
            const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(3000), body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'bridge_send_user', arguments: { text: '已了解' } } }) });
            assert.equal(response.status, 200); assert.equal((await response.json() as JsonObject).error, undefined);
          }
          transport.emit({ type: 'result', subtype: 'success', session_id: 'claude-chat-native', result: 'DONE' });
        })(); scripts.push(script); void script.catch(error => transport.failures.forEach(listener => listener(error)));
      }; return transport;
    },
  });
  const conversation: AgentTurn['conversation'] = { id: 'claude-chat-c', userId: 'owner', agent: 'claude', nativeId: null, title: '', cwd: dir, createdAt: '', updatedAt: '' };
  const base: AgentTurn = { conversation, source: { messageId: 'dm', userId: 'owner', channelId: 'dm' }, chatScene: JSON.stringify({ groups: [{ spaceId: 'g', recent: [{ author: 'other-member', text: '项目代号青鸟' }] }] }), text: '了解情况', imagePaths: [], signal: new AbortController().signal, onProgress: () => {}, onPublicMessage: async () => {} };
  try {
    const first = await adapter.run(base); conversation.nativeId = first.nativeId; await adapter.interrupt(conversation.id);
    const group = { ...base, chatScene: undefined, source: { messageId: 'gm', userId: 'owner', channelId: 'g', original: { messageId: 'gm', userId: 'actual-author', channelId: 'raw-g', space: { kind: 'group' as const, spaceId: 'raw-g', mentionedUserIds: ['M'], replyToMessageId: 'previous' } } }, groupContext: { eventId: 'e', rootId: 'r', botId: 'M', spaceId: 'g', generation: 1, bindingEpoch: 1, originChannelId: 'g', principalId: 'owner', scene: JSON.stringify({ recent: [{ text: '项目代号青鸟', author: 'other-member' }] }) } };
    assert.equal((await adapter.run(group)).nativeId, first.nativeId); await adapter.interrupt(conversation.id);
    const internalMessage = { eventId: 'consult', rootId: 'r', eventKind: 'consultation', speaker: { type: 'bot', botId: 'T', aliases: ['Teto'] }, visibility: 'internal', authorization: { freshOwnerInput: false, principalId: 'owner' }, defaultDelivery: { area: 'internal', targetBotId: 'T' } };
    assert.equal((await adapter.run({ ...group, chatScene: JSON.stringify({ currentMessage: internalMessage, recent: [] }), event: { kind: 'group-event', text: '证据完成' } })).nativeId, first.nativeId);
    await Promise.all(scripts);
    assert.equal(transports.length, 3);
    const wires = transports.map(transport => JSON.stringify(transport.written.find(item => item.type === 'user')));
    assert.match(wires[0]!, /private-message/); assert.doesNotMatch(wires[0]!, /项目代号青鸟|Bridge chat scene/);
    assert.match(wires[1]!, /actual-author/); assert.match(wires[1]!, /previous/); assert.match(wires[1]!, /项目代号青鸟/);
    assert.match(wires[2]!, /background-evidence/); assert.match(wires[2]!, /not fresh authorization/);
    const content = (transports[2]!.written.find(item => item.type === 'user')!.message as JsonObject).content as { text: string }[];
    const runtime = content.find(item => item.text?.startsWith('[Bridge chat input;'))!.text;
    const chat = JSON.parse(runtime.split('\n')[0]!.split('] ')[1]!);
    assert.deepEqual(chat.currentMessage, internalMessage); assert.deepEqual(chat.defaultDelivery, internalMessage.defaultDelivery);
    const scene = JSON.parse(runtime.split('\n').find(line => line.startsWith('[Bridge chat scene;'))!.split('] ')[1]!);
    assert.equal(scene.content.currentMessage, undefined);
  } finally { await adapter.close(); await Promise.allSettled(scripts); rmSync(dir, { recursive: true, force: true }); }
});


test('native current message separates author, original owner and internal delivery, without repeating its envelope in scene evidence', async () => {
  const s = setup();
  try {
    const turn = s.makeTurn();
    turn.source = { messageId: 'root-message', userId: 'owner-route', channelId: 'original-group' };
    const currentMessage = { eventId: 'consult-1', rootId: 'root', causeEventId: 'owner-1', eventKind: 'consultation',
      speaker: { type: 'bot', botId: 'M', aliases: ['Miku'] }, visibility: 'internal',
      authorization: { freshOwnerInput: false, principalId: 'owner' }, defaultDelivery: { area: 'internal', targetBotId: 'M' } };
    turn.chatScene = JSON.stringify({ currentMessage, recent: [{ text: '有界共同现场' }] });
    turn.groupContext = { eventId: 'consult-1', rootId: 'root', botId: 'T', spaceId: 'shared-group', generation: 1, bindingEpoch: 1, originChannelId: 'original-group', principalId: 'owner', scene: '旧现场' };
    turn.event = { kind: 'group-event', text: '请核对证据' };
    await s.adapter.run(turn);
    const start = s.transports[0]!.written.find(item => item.method === 'turn/start')!.params as JsonObject;
    const wire = (start.toolOutput as JsonObject).output as string;
    const lines = wire.split('\n');
    const chat = JSON.parse(lines[0]!.split('] ')[1]!);
    assert.equal(chat.kind, 'background-evidence');
    assert.deepEqual(chat.currentMessage, currentMessage);
    assert.deepEqual(chat.defaultDelivery, { area: 'internal', targetBotId: 'M' });
    assert.equal(chat.route.channelId, 'original-group');
    const scene = JSON.parse(lines.find(line => line.startsWith('[Bridge chat scene;'))!.split('] ')[1]!);
    assert.equal(scene.content.currentMessage, undefined);
    assert.deepEqual(scene.content.recent, [{ text: '有界共同现场' }]);
    assert.equal(wire.split('"eventId":"consult-1"').length - 1, 2); // chat.currentMessage and chat.group, never a second scene envelope.
  } finally { await s.cleanup(); }
});

test('native preserves direct-recipient facts for ordinary owner group messages and falls back for legacy scenes', async () => {
  const s = setup();
  try {
    const turn = s.makeTurn();
    turn.source = { messageId: 'owner-1', userId: 'owner', channelId: 'shared-group' };
    const currentMessage = { eventId: 'owner-1', rootId: 'root', eventKind: 'human', speaker: { type: 'user', userId: 'actual-owner' }, visibility: 'group',
      authorization: { freshOwnerInput: true, principalId: 'owner' }, defaultDelivery: { area: 'group', targetId: 'group:shared-group:1:1' },
      directRecipients: { botIds: ['M', 'T'], meaning: 'registered delivery only; not read or accepted' } };
    turn.groupContext = { eventId: 'owner-1', rootId: 'root', botId: 'M', spaceId: 'shared-group', generation: 1, bindingEpoch: 1, originChannelId: 'shared-group', principalId: 'owner', scene: JSON.stringify({ currentMessage, recent: [] }) };
    await s.adapter.run(turn);
    const first = s.transports[0]!.written.find(item => item.method === 'turn/start')!.params as JsonObject;
    const runtime = (first.input as { text: string }[]).find(item => item.text?.startsWith('[Bridge chat input;'))!.text;
    const chat = JSON.parse(runtime.split('\n')[0]!.split('] ')[1]!);
    assert.deepEqual(chat.currentMessage.directRecipients.botIds, ['M', 'T']);
    assert.equal(chat.currentMessage.speaker.userId, 'actual-owner');
    assert.equal(chat.requesterPrincipalId, 'owner');
    assert.deepEqual(chat.defaultDelivery, currentMessage.defaultDelivery);
    turn.chatScene = 'legacy scene';
    await s.adapter.run(turn);
    const second = s.transports[0]!.written.filter(item => item.method === 'turn/start')[1]!.params as JsonObject;
    const legacyRuntime = (second.input as { text: string }[]).find(item => item.text?.startsWith('[Bridge chat input;'))!.text;
    const legacy = JSON.parse(legacyRuntime.split('\n')[0]!.split('] ')[1]!);
    assert.equal(legacy.currentMessage, undefined);
    assert.deepEqual(legacy.defaultDelivery, { area: 'group', channelId: 'shared-group' });
  } finally { await s.cleanup(); }
});


test('Memory change refreshes the same Codex native controller without new chat, model change or initializer', async () => {
  const s = setup();
  try {
    writeFileSync(join(s.dir, 'README.md'), '# Shared rules'); writeFileSync(join(s.dir, 'MEMORY.md'), 'ORIGINAL_OWNER_RULE');
    const turn = s.makeTurn(); const first = await s.adapter.run(turn); turn.conversation.nativeId = first.nativeId;
    writeFileSync(join(s.dir, 'MEMORY.md'), 'UPDATED_OWNER_RULE: Client/Lua and MyHaruSkills');
    await s.adapter.run(turn);
    assert.equal(s.transports.length, 2); assert.equal(s.transports[0]!.stopped, true);
    const resumed = s.transports[1]!.written.find(message => message.method === 'thread/resume')!.params as JsonObject;
    assert.equal(resumed.threadId, first.nativeId); assert.match(resumed.baseInstructions as string, /UPDATED_OWNER_RULE/);
    assert.doesNotMatch(resumed.baseInstructions as string, /ORIGINAL_OWNER_RULE/);
  } finally { await s.cleanup(); }
});
