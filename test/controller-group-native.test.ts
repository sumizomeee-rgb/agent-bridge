import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NativeControllerAdapter } from '../src/controller/native.js';
import type { AgentTurn } from '../src/types.js';
import type { JsonObject, RpcTransport } from '../src/agents/process.js';

class GroupProtocol implements RpcTransport {
  messages = new Set<(message: JsonObject) => void>(); failures = new Set<(error: Error) => void>(); written: JsonObject[] = []; turns = 0; stopped = false;
  onMessage(fn: (message: JsonObject) => void) { this.messages.add(fn); return () => this.messages.delete(fn); }
  onFailure(fn: (error: Error) => void) { this.failures.add(fn); return () => this.failures.delete(fn); }
  emit(message: JsonObject) { queueMicrotask(() => this.messages.forEach(fn => fn(message))); }
  write(message: JsonObject) {
    this.written.push(message);
    const params = message.params as JsonObject;
    if (message.method === 'initialize') this.emit({ id: message.id, result: {} });
    if (message.method === 'config/read') this.emit({ id: message.id, result: { config: { model_provider: 'fixture' } } });
    if (message.method === 'thread/start' || message.method === 'thread/resume') this.emit({ id: message.id, result: { thread: { id: 'native-group' }, modelProvider: 'fixture', model: 'fixture-model', reasoningEffort: null } });
    if (message.method === 'turn/start') { this.turns++; this.emit({ id: message.id, result: { turn: { id: 'turn-' + this.turns } } }); this.emit({ method: 'turn/started', params: { threadId: 'native-group', turn: { id: 'turn-' + this.turns } } }); }
  }
  tool(id: number, name: string, callId = String(id)) { this.emit({ id, method: 'item/tool/call', params: { threadId: 'native-group', turnId: 'turn-' + this.turns, callId, tool: name,
    arguments: JSON.stringify(name === 'bridge_send_user' ? { text: '不应公开' } : {}) } }); }
  complete() { this.emit({ method: 'turn/completed', params: { threadId: 'native-group', turn: { id: 'turn-' + this.turns, status: 'completed', items: [{ type: 'agentMessage', phase: 'final_answer', text: 'DONE' }] } } }); }
  async stop() { this.stopped = true; }
}
async function until(check: () => boolean) { for (let n = 0; n < 2000; n++) { if (check()) return; await new Promise<void>(resolve => setImmediate(resolve)); } assert.fail('原生群协议没有达到预期'); }
function setup(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'bridge-group-native-')); mkdirSync(join(root, '.codex')); writeFileSync(join(root, '.codex', 'config.toml'), 'model_provider="fixture"\n');
  const protocol = new GroupProtocol(), invoked: string[] = []; let silent = 0, published = 0;
  let manage: () => Promise<unknown> = async () => ({});
  const adapter = new NativeControllerAdapter({ command: 'offline', args: [] }, {}, { agent: 'codex', dataDir: join(root, 'data'), userHome: root,
    createTransport: () => protocol, invokeTool: async (_turn, name) => { invoked.push(name); return manage(); } });
  t.after(() => adapter.close());
  const turn: AgentTurn = { conversation: { id: 'group-parent', userId: 'owner', agent: 'codex', nativeId: null, title: '', cwd: root, createdAt: '', updatedAt: '' },
    text: '已授权群参与', imagePaths: [], signal: new AbortController().signal, onProgress() {}, onPublicMessage: async () => { published++; }, onSilent: async () => { silent++; },
    groupContext: { eventId: 'event', rootId: 'root', botId: 'bot', spaceId: 'space', generation: 1, bindingEpoch: 1, originChannelId: 'channel', principalId: 'principal', scene: '现场' } };
  return { adapter, protocol, turn, invoked, get silent() { return silent; }, get published() { return published; }, set manage(value: () => Promise<unknown>) { manage = value; } };
}
const reply = (protocol: GroupProtocol, id: number) => protocol.written.find(item => item.id === id && !item.method)?.result as JsonObject | undefined;

test('实际RPC群静默只登记一次并封闭终态，同一callId重放不重复决定', async t => {
  const f = setup(t); const running = f.adapter.run(f.turn); await until(() => f.protocol.turns === 1);
  f.protocol.tool(41, 'bridge_silent', 'silent-once'); await until(() => !!reply(f.protocol, 41));
  f.protocol.tool(42, 'bridge_silent', 'silent-once'); await until(() => !!reply(f.protocol, 42));
  f.protocol.complete(); const result = await running;
  assert.equal(result.controlledOutput, true); assert.equal(f.silent, 1); assert.equal(f.published, 0); assert.deepEqual(f.invoked, []);
});

test('实际RPC私聊不能借bridge_silent跳过人类请求，准备轮次拒绝一切管理和公开副作用', async t => {
  const f = setup(t); f.turn.groupContext = undefined;
  const ordinary = f.adapter.run(f.turn); await until(() => f.protocol.turns === 1);
  f.protocol.tool(51, 'bridge_silent'); await until(() => !!reply(f.protocol, 51)); assert.equal(reply(f.protocol, 51)!.success, false);
  f.protocol.complete(); await assert.rejects(ordinary, /公开通道/); assert.equal(f.silent, 0);
  const g = setup(t); g.turn.preparing = true; g.turn.event = { kind: 'workspace-context', text: '只装载摘要，不执行动作' };
  const preparing = g.adapter.run(g.turn); await until(() => g.protocol.turns === 1);
  for (const [id, name] of [[61, 'bridge_send_user'], [62, 'bridge_start_worker'], [63, 'bridge_silent']] as const) {
    g.protocol.tool(id, name); await until(() => !!reply(g.protocol, id)); assert.equal(reply(g.protocol, id)!.success, false);
  }
  g.protocol.complete(); assert.equal((await preparing).controlledOutput, true); assert.equal(g.silent, 0); assert.equal(g.published, 0); assert.deepEqual(g.invoked, []);
});

test('静默等待已接纳管理动作，后来的并行越界调用不能派工或推翻成功静默', async t => {
  const f = setup(t); let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }); f.manage = async () => { await gate; return {}; };
  const running = f.adapter.run(f.turn); await until(() => f.protocol.turns === 1);
  f.protocol.tool(71, 'bridge_list_workers'); await until(() => f.invoked.length === 1);
  f.protocol.tool(72, 'bridge_silent'); f.protocol.tool(73, 'bridge_start_worker');
  await until(() => !!reply(f.protocol, 73)); assert.equal(reply(f.protocol, 73)!.success, false); assert.equal(f.silent, 0);
  release(); const result = await running; assert.equal(result.controlledOutput, true); assert.equal(f.silent, 1);
  assert.deepEqual(f.invoked, ['bridge_list_workers']); assert.equal(f.published, 0);
});
