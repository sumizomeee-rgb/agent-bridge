import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NativeControllerAdapter } from '../src/controller/native.js';
import { formatEffortEvidence } from '../src/effort.js';
import type { AgentName, AgentTurn, EffortMetadata } from '../src/types.js';
import type { JsonObject, RpcTransport } from '../src/agents/process.js';

class MetadataTransport implements RpcTransport {
  listeners = new Set<(message: JsonObject) => void>(); failures = new Set<(error: Error) => void>(); written: JsonObject[] = [];
  actual: string | undefined; unsupported = false; stopped = false; counter = 0;
  onMessage(callback: (message: JsonObject) => void) { this.listeners.add(callback); return () => this.listeners.delete(callback); }
  onFailure(callback: (error: Error) => void) { this.failures.add(callback); return () => this.failures.delete(callback); }
  emit(message: JsonObject) { queueMicrotask(() => this.listeners.forEach(callback => callback(message))); }
  write(message: JsonObject) {
    this.written.push(message);
    if (message.method === 'initialize') this.emit({ id: message.id, result: {} });
    if (message.method === 'config/read') this.emit({ id: message.id, result: { config: { model_provider: 'fixture', model_reasoning_effort: 'high' } } });
    if (message.method === 'thread/start' || message.method === 'thread/resume') this.emit({ id: message.id, result: { thread: { id: 'native' }, modelProvider: 'fixture', model: 'provider-model', reasoningEffort: 'low' } });
    if (message.method === 'turn/start') { this.counter++; this.emit({ id: message.id, result: { turn: { id: 'turn-' + this.counter } } }); this.emit({ method: 'turn/completed', params: { threadId: 'native', turn: { id: 'turn-' + this.counter, status: 'completed', items: [] } } }); }
    if (message.type === 'user') {
      this.emit({ type: 'system', subtype: 'init', session_id: 'native', model: 'provider-model', tools: [], ...(this.unsupported ? { supportsEffort: false } : {}) });
      this.emit({ type: 'assistant', session_id: 'native', message: { model: 'provider-model', content: [{ type: 'text', text: 'DONE' }], ...(this.actual ? { output_config: { effort: this.actual } } : {}) } });
      this.emit({ type: 'result', subtype: 'success', session_id: 'native', result: 'DONE' });
    }
  }
  async stop() { this.stopped = true; }
}
function setup(agent: AgentName, settings: Record<string, unknown>, env: NodeJS.ProcessEnv = {}, initialActual?: string) {
  const root = mkdtempSync(join(tmpdir(), 'controller-effort-evidence-')), userHome = join(root, 'user'); mkdirSync(join(userHome, '.claude'), { recursive: true }); mkdirSync(join(userHome, '.codex'));
  const source = join(userHome, '.claude', 'settings.json'); writeFileSync(source, JSON.stringify(settings)); writeFileSync(join(userHome, '.codex', 'config.toml'), 'model_provider="fixture"\n');
  const launches: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = [], transports: MetadataTransport[] = [];
  const adapter = new NativeControllerAdapter({ command: 'fake', args: [] }, env, { agent, userHome, dataDir: join(root, 'data'), invokeTool: async () => { throw Error('no tools permitted'); }, createTransport: (_command, args, _cwd, effectiveEnv) => { launches.push({ args, env: effectiveEnv }); const transport = new MetadataTransport(); transport.actual = initialActual; transports.push(transport); return transport; } });
  const snapshots: EffortMetadata[] = [], observations: Array<string | null> = [];
  const turn = (): AgentTurn => ({ conversation: { id: 'controller', userId: 'owner', agent, model: null, nativeId: null, cwd: root, title: '', createdAt: '', updatedAt: '' }, text: '', imagePaths: [], preparing: true, event: { kind: 'workspace-context', text: 'test initialization' }, signal: new AbortController().signal, onProgress() {}, onEffortMetadata: value => snapshots.push(value), onReasoningEffort: value => observations.push(value) });
  return { root, source, adapter, launches, transports, snapshots, observations, turn, async close() { await adapter.close(); rmSync(root, { recursive: true, force: true }); } };
}

test('Claude controller records filtered ultra as unadopted configuration and never as actual effort', async () => {
  const s = setup('claude', { model: 'haiku', effortLevel: 'ultra' }); const original = readFileSync(s.source);
  try {
    await s.adapter.run(s.turn()); const metadata = s.snapshots.at(-1)!; assert.equal(metadata.actual, null); assert.equal(metadata.requested, null); assert.equal(metadata.capability.status, 'unknown');
    assert.deepEqual(metadata.configuration, { value: 'ultra', source: 'user-settings', applied: false, reason: '当前适配器未将此设置传入主控 CLI' }); assert.equal(formatEffortEvidence(metadata), 'CLI 默认 · 配置未采用');
    const args = s.launches[0]!.args, settings = JSON.parse(args[args.indexOf('--settings') + 1]!); assert.equal(settings.effortLevel, undefined); assert.equal(args.includes('--effort'), false); assert.deepEqual(readFileSync(s.source), original);
  } finally { await s.close(); }
});

test('Claude 主控传入持久化 xhigh，配置证据不冒充实际强度', async () => {
  const s = setup('claude', { effortLevel: 'xhigh' });
  try {
    await s.adapter.run(s.turn());
    const args = s.launches[0]!.args, settings = JSON.parse(args[args.indexOf('--settings') + 1]!);
    assert.equal(settings.effortLevel, 'xhigh'); assert.equal(args.includes('--effort'), false);
    assert.deepEqual(s.snapshots.at(-1)?.configuration, { value: 'xhigh', source: 'session-settings' });
    assert.equal(s.snapshots.at(-1)?.actual, null);
  } finally { await s.close(); }
});

test('Claude controller prefers its effective environment configuration over a file value', async () => {
  const s = setup('claude', { model: 'haiku', effortLevel: 'xhigh' }, { CLAUDE_CODE_EFFORT_LEVEL: 'medium' });
  try { await s.adapter.run(s.turn()); const metadata = s.snapshots.at(-1)!; assert.deepEqual(metadata.configuration, { value: 'medium', source: 'environment' }); assert.equal(metadata.actual, null); assert.equal(formatEffortEvidence(metadata), '中〔环境配置〕'); } finally { await s.close(); }
});

test('Claude controller separates explicit response metadata from launch settings and clears observation on the next turn', async () => {
  const s = setup('claude', { model: 'haiku', effortLevel: 'high' }, {}, 'low');
  try {
    await s.adapter.run(s.turn());

 assert.equal(s.snapshots.at(-1)?.actual, 'low'); assert.equal(s.snapshots.at(-1)?.configuration?.value, 'high');
    s.transports[0]!.actual = undefined; const next = s.turn(); next.conversation.nativeId = 'native'; await s.adapter.run(next); assert.equal(s.snapshots.at(-1)?.actual, null); assert.equal(s.snapshots.at(-1)?.configuration?.value, 'high');
  } finally { await s.close(); }
});

test('Codex controller exposes effective config source separately from native observed effort', async () => {
  const s = setup('codex', {});
  try { await s.adapter.run(s.turn()); const metadata = s.snapshots.at(-1)!; assert.deepEqual(metadata.configuration, { value: 'high', source: 'session-settings' }); assert.equal(metadata.actual, 'low'); assert.equal(formatEffortEvidence(metadata), '低'); } finally { await s.close(); }
});

test('Claude 主控为未知网关模型传入 CLI 强度并续接会话，不伪造实际回报', async () => {
  const s = setup('claude', { effortLevel: 'xhigh' });
  s.adapter.getModelInfo = async () => ({ models: [], defaultModel: null });
  try {
    for (const effort of ['low', 'medium', 'high', 'xhigh', 'max']) {
      const turn = s.turn(); turn.conversation.model = 'deepseek-v4.1-flash';
      turn.conversation.nativeId = 'native'; turn.conversation.effort = effort;
      await s.adapter.run(turn);
      const args = s.launches.at(-1)!.args;
      assert.equal(args[args.indexOf('--effort') + 1], effort);
      assert.equal(args[args.indexOf('--resume') + 1], 'native');
      const metadata = s.snapshots.at(-1)!;
      assert.equal(metadata.requested, effort); assert.equal(metadata.actual, null);
      assert.equal(metadata.capability.status, 'unknown');
      assert.deepEqual(metadata.configuration, { value: effort, source: 'argument' });
    }
    const next = s.turn(); next.conversation.nativeId = 'native'; next.conversation.model = 'deepseek-v4.1-flash';
    await s.adapter.run(next); assert.equal(s.launches.at(-1)!.args.includes('--effort'), false);
    assert.equal(s.snapshots.at(-1)?.actual, null);
  } finally { await s.close(); }
});

