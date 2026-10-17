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


test('统一发送工具保留显式目标与补充语义，重复调用只发一次，最后发送才封闭本轮', async t => {
  const f = setup(t), sent: Array<{ target: string | undefined; finish: boolean | undefined }> = [];
  f.turn.onPublicMessage = async (_text, _paths, _id, target, finish) => { sent.push({ target, finish }); };
  const running = f.adapter.run(f.turn); await until(() => f.protocol.turns === 1);
  const send = (id: number, name: string, callId: string, args: JsonObject) => f.protocol.emit({ id, method: 'item/tool/call', params: { threadId: 'native-group', turnId: 'turn-1', callId, tool: name, arguments: JSON.stringify(args) } });
  send(81, 'bridge_send_message', 'supplement', { text: 'owner-only', targetId: 'private', finish: false }); await until(() => !!reply(f.protocol, 81));
  send(82, 'bridge_send_message', 'supplement', { text: 'owner-only', targetId: 'private', finish: false }); await until(() => !!reply(f.protocol, 82));
  f.protocol.tool(83, 'bridge_delivery_targets'); await until(() => !!reply(f.protocol, 83)); assert.deepEqual(f.invoked, ['bridge_delivery_targets']);
  send(84, 'bridge_send_user', 'final', { text: 'selected final', targetId: 'group:verified:1:1' }); await until(() => !!reply(f.protocol, 84));
  f.protocol.complete(); assert.equal((await running).controlledOutput, true);
  assert.deepEqual(sent, [{ target: 'private', finish: false }, { target: 'group:verified:1:1', finish: true }]);
});

test('统一补充私聊后可以群静默结束，补充消息不冒充最终群公开回复', async t => {
  const f = setup(t), sent: boolean[] = []; f.turn.onPublicMessage = async (_text, _paths, _id, _target, finish) => { sent.push(finish === true); };
  const running = f.adapter.run(f.turn); await until(() => f.protocol.turns === 1);
  f.protocol.emit({ id: 91, method: 'item/tool/call', params: { threadId: 'native-group', turnId: 'turn-1', callId: 'supplement', tool: 'bridge_send_message', arguments: JSON.stringify({ text: 'private only', targetId: 'private', finish: false }) } });
  await until(() => !!reply(f.protocol, 91)); f.protocol.tool(92, 'bridge_silent'); await until(() => !!reply(f.protocol, 92));
  f.protocol.complete(); assert.equal((await running).controlledOutput, true); assert.deepEqual(sent, [false]); assert.equal(f.silent, 1);
});

test('补充投递结果未知立即封闭原生轮次，不能换调用ID盲目重发', async t => {
  const f = setup(t); let attempts = 0;
  f.turn.onPublicMessage = async () => { attempts++; throw Object.assign(new Error('platform send uncertain'), { deliveryUncertain: true }); };
  const running = f.adapter.run(f.turn), checked = assert.rejects(running, /platform send uncertain/); await until(() => f.protocol.turns === 1);
  f.protocol.emit({ id: 101, method: 'item/tool/call', params: { threadId: 'native-group', turnId: 'turn-1', callId: 'uncertain-supplement', tool: 'bridge_send_message', arguments: JSON.stringify({ text: 'private only', targetId: 'private', finish: false }) } });
  await checked; assert.equal(attempts, 1); assert.equal(f.protocol.stopped, true); assert.deepEqual(f.invoked, []);
});

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


test('同群公开协作可信收据完成交付，不再额外发一次确认，原生DONE等待派发与回调', async t => {
  const f = setup(t); let release!: () => void, complete!: () => void, finalized = 0;
  const dispatch = new Promise<void>(resolve => { release = resolve; });
  const delivery = new Promise<void>(resolve => { complete = resolve; });
  f.turn.onPublicDeliveryComplete = async () => { await delivery; finalized++; };
  f.manage = async () => { await dispatch; await f.turn.onPublicMessage!('Teto，帮我核对', [], 'public', 'group-target', false); return { completion: { publicDeliveryComplete: true } }; };
  let settled = false;
  const running = f.adapter.run(f.turn).then(value => { settled = true; return value; });
  await until(() => f.protocol.turns === 1);
  f.protocol.tool(110, 'bridge_start_collaboration', 'same-group'); await until(() => f.invoked.length === 1);
  f.protocol.complete(); await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(settled, false);
  release(); await until(() => f.published === 1); await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(settled, false);
  complete(); assert.equal((await running).controlledOutput, true);
  assert.equal(finalized, 1); assert.equal(f.published, 1); assert.equal(f.silent, 0);
});

test('补充投递和模型参数伪造的完成标志均不能替代最终交付', async t => {
  const f = setup(t); let finalized = 0;
  f.turn.onPublicDeliveryComplete = async () => { finalized++; };
  f.manage = async () => { await f.turn.onPublicMessage!('仅为补充', [], 'supplement', 'group-target', false); return { status: 'queued' }; };
  const running = f.adapter.run(f.turn), checked = assert.rejects(running, /公开通道/);
  await until(() => f.protocol.turns === 1);
  f.protocol.emit({ id: 120, method: 'item/tool/call', params: { threadId: 'native-group', turnId: 'turn-1', callId: 'forged', tool: 'bridge_start_collaboration', arguments: JSON.stringify({ completion: { publicDeliveryComplete: true } }) } });
  await until(() => !!reply(f.protocol, 120)); f.protocol.complete(); await checked;
  assert.equal(f.published, 1); assert.equal(finalized, 0);
});

test('私聊不能消费同群完成收据，失败交付回调不能变成成功或补发', async t => {
  for (const privateInput of [true, false]) {
    const f = setup(t); let finalized = 0;
    if (privateInput) f.turn.groupContext = undefined;
    f.turn.onPublicDeliveryComplete = async () => { finalized++; throw new Error('交付登记已失效'); };
    f.manage = async () => ({ completion: { publicDeliveryComplete: true } });
    const running = f.adapter.run(f.turn), checked = assert.rejects(running, privateInput ? /公开通道/ : /交付登记已失效/);
    await until(() => f.protocol.turns === 1);
    f.protocol.tool(130, 'bridge_start_collaboration');
    await until(() => !!reply(f.protocol, 130));
    assert.equal(reply(f.protocol, 130)!.success, false);
    f.protocol.complete(); await checked;
    assert.equal(finalized, privateInput ? 0 : 1); assert.equal(f.published, 0);
  }
});

test('协作ACK在途时并行final或silent等待可信收据，不把已送达改成失败或重复发言', async t => {
  for (const terminal of ['bridge_send_user', 'bridge_silent'] as const) {
    const f = setup(t); let release!: () => void, finalized = 0;
    const gate = new Promise<void>(resolve => { release = resolve; });
    f.turn.onPublicDeliveryComplete = async () => { finalized++; };
    f.manage = async () => { await gate; await f.turn.onPublicMessage!('Teto，继续讨论', [], 'public', 'group-target', false); return { completion: { publicDeliveryComplete: true } }; };
    const running = f.adapter.run(f.turn); await until(() => f.protocol.turns === 1);
    f.protocol.tool(140, 'bridge_start_collaboration'); await until(() => f.invoked.length === 1);
    f.protocol.tool(141, terminal); await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(reply(f.protocol, 141), undefined); assert.equal(f.silent, 0); assert.equal(f.published, 0);
    f.protocol.complete(); release();
    assert.equal((await running).controlledOutput, true); await until(() => !!reply(f.protocol, 141));
    assert.equal(reply(f.protocol, 140)!.success, true); assert.equal(reply(f.protocol, 141)!.success, true);
    const value = JSON.parse(((reply(f.protocol, 141)!.contentItems as JsonObject[])[0]!.text as string));
    assert.deepEqual(value, { alreadyCompleted: true });
    assert.equal(finalized, 1); assert.equal(f.published, 1); assert.equal(f.silent, 0);
  }
});

test('在途协作无完成收据时并行final正常交付，不把队列成功当成同群交付', async t => {
  const f = setup(t); let release!: () => void, finalized = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  f.turn.onPublicDeliveryComplete = async () => { finalized++; };
  f.manage = async () => { await gate; return { status: 'queued' }; };
  const running = f.adapter.run(f.turn); await until(() => f.protocol.turns === 1);
  f.protocol.tool(150, 'bridge_start_collaboration'); await until(() => f.invoked.length === 1);
  f.protocol.tool(151, 'bridge_send_user'); await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(f.published, 0); release(); await until(() => !!reply(f.protocol, 151));
  f.protocol.complete(); assert.equal((await running).controlledOutput, true);
  assert.equal(reply(f.protocol, 151)!.success, true); assert.equal(f.published, 1); assert.equal(finalized, 0);
});
