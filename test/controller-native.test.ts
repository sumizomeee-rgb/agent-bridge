import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentTurn } from '../src/types.js';
import type { JsonObject, RpcTransport } from '../src/agents/process.js';
import { NativeControllerAdapter, codexControllerOverrides, isolatedCodexConfig } from '../src/controller/native.js';
import { parse as parseTOML } from 'smol-toml';

class FakeTransport implements RpcTransport {
  readonly messages = new Set<(message: JsonObject) => void>();
  readonly failures = new Set<(error: Error) => void>();
  readonly written: JsonObject[] = [];
  stopped = false;
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
  const adapter = new NativeControllerAdapter({ command: 'fake', args: [] }, { HTTP_PROXY: 'http://127.0.0.1:7898' }, { agent: 'codex', dataDir: join(dir, 'data'), userHome,
    invokeTool: async (_turn, name) => { invokes.push(name); return {}; },
    createTransport: (_command, args, _cwd, env) => { const t = new FakeTransport(); t.mode = mode; transports.push(t); launches.push({ args, env }); return t; },
  });
  const makeTurn = (): AgentTurn => ({ conversation: { id: 'conversation-1', userId: 'u', agent: 'codex', nativeId: null, title: '', cwd: dir, createdAt: '', updatedAt: '' }, text: '请调查', imagePaths: [], signal: new AbortController().signal, onProgress: () => {}, onPublicMessage: async (text, _paths, key) => { published.push({ text, key }); } });
  return { dir, userHome, adapter, transports, launches, invokes, published, makeTurn, setMode: (value: FakeTransport['mode']) => { mode = value; }, cleanup: async () => { await adapter.close(); rmSync(dir, { recursive: true, force: true }); } };
}
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
    assert.deepEqual(start.input, []); assert.deepEqual(start.toolOutput, { name: 'bridge_worker_result', namespace: null, output: 'confirmed evidence' });
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
    assert.ok(receivedContent.some(item => (item as JsonObject).type === 'text' && String((item as JsonObject).text).includes(JSON.stringify(image))));
    transport.stop = async () => { throw new Error('process exit unconfirmed'); };
    await assert.rejects(adapter.close(), /process exit unconfirmed/);
    await assert.rejects(fetch(mcpUrl, { signal: AbortSignal.timeout(1000) }));
  } finally { await adapter.close().catch(() => {}); rmSync(dir, { recursive: true, force: true }); }
});
