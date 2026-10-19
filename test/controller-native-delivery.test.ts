import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NativeControllerAdapter } from '../src/controller/native.js';
import { AttachmentPreparationError, collectOutgoingPaths } from '../src/artifacts.js';
import type { AgentName, AgentTurn } from '../src/types.js';
import type { JsonObject, RpcTransport } from '../src/agents/process.js';

const TARGET = 'group:verified-test-group:1:1';
async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!check()) { assert.ok(Date.now() < deadline, '原生投递协议没有达到预期状态'); await new Promise<void>(resolve => setImmediate(resolve)); }
}
function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
class DeliveryProtocol implements RpcTransport {
  listeners = new Set<(message: JsonObject) => void>(); failures = new Set<(error: Error) => void>(); written: JsonObject[] = [];
  started = false; stopped = false; mcpUrl = ''; private sequence = 100;
  constructor(readonly agent: AgentName) {}
  onMessage(callback: (message: JsonObject) => void) { this.listeners.add(callback); return () => this.listeners.delete(callback); }
  onFailure(callback: (error: Error) => void) { this.failures.add(callback); return () => this.failures.delete(callback); }
  emit(message: JsonObject) { queueMicrotask(() => this.listeners.forEach(callback => callback(message))); }
  write(message: JsonObject) {
    this.written.push(message);
    if (message.method === 'initialize') this.emit({ id: message.id, result: {} });
    if (message.method === 'config/read') this.emit({ id: message.id, result: { config: { model_provider: 'fixture' } } });
    if (message.method === 'thread/start' || message.method === 'thread/resume') this.emit({ id: message.id, result: { thread: { id: 'continued-native' }, modelProvider: 'fixture', model: 'fixture-model', reasoningEffort: null } });
    if (message.method === 'turn/start') { this.started = true; this.emit({ id: message.id, result: { turn: { id: 'delivery-turn' } } }); this.emit({ method: 'turn/started', params: { threadId: 'continued-native', turn: { id: 'delivery-turn' } } }); }
    if (message.type === 'user') { this.started = true; this.emit({ type: 'system', subtype: 'init', session_id: 'continued-native', tools: ['mcp__bridge_controller__bridge_delivery_targets', 'mcp__bridge_controller__bridge_send_message', 'mcp__bridge_controller__bridge_send_private', 'mcp__bridge_controller__bridge_list_workers'] }); }
  }
  async call(name: string, args: JsonObject): Promise<{ ok: boolean; value: unknown }> {
    const id = ++this.sequence, callId = 'delivery-call-' + id;
    if (this.agent === 'codex') {
      this.emit({ id, method: 'item/tool/call', params: { threadId: 'continued-native', turnId: 'delivery-turn', callId, tool: name, arguments: JSON.stringify(args) } });
      await until(() => this.written.some(message => message.id === id && !message.method));
      const result = this.written.find(message => message.id === id && !message.method)!.result as { success: boolean; contentItems: Array<{ text: string }> };
      return { ok: result.success, value: result.contentItems[0]?.text };
    }
    this.emit({ type: 'assistant', session_id: 'continued-native', message: { content: [{ type: 'tool_use', id: callId, name: 'mcp__bridge_controller__' + name, input: args }] } });
    try {
      const response = await fetch(this.mcpUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(5000),
        body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }) });
      const value = await response.json() as { error?: unknown; result?: { isError?: boolean } };
      return { ok: response.status === 200 && !value.error && value.result?.isError !== true, value };
    } catch (error) { if (this.stopped) return { ok: false, value: String(error) }; throw error; }
  }
  complete() {
    if (this.agent === 'codex') this.emit({ method: 'turn/completed', params: { threadId: 'continued-native', turn: { id: 'delivery-turn', status: 'completed', items: [{ type: 'agentMessage', phase: 'final_answer', text: 'DONE' }] } } });
    else this.emit({ type: 'result', subtype: 'success', session_id: 'continued-native', result: 'DONE' });
  }
  async stop() { this.stopped = true; }
}
function fixture(t: TestContext, agent: AgentName) {
  const root = mkdtempSync(join(tmpdir(), 'controller-native-delivery-')); mkdirSync(join(root, '.codex')); mkdirSync(join(root, '.claude')); writeFileSync(join(root, '.codex', 'config.toml'), 'model_provider="fixture"\n'); writeFileSync(join(root, '.claude', 'settings.json'), '{}');
  const protocol = new DeliveryProtocol(agent), invoked: string[] = [], sends: Array<{ target: string | undefined; finish: boolean | undefined; text: string }> = [];
  const adapter = new NativeControllerAdapter({ command: 'offline-fixture', args: [] }, {}, { agent, dataDir: join(root, 'data'), userHome: root,
    invokeTool: async (_turn, name) => { invoked.push(name); return { defaultTargetId: 'private', targets: [{ targetId: TARGET, audience: 'all group members' }] }; },
    createTransport: (_command, args) => { if (agent === 'claude') protocol.mcpUrl = JSON.parse(args[args.indexOf('--mcp-config') + 1]!).mcpServers.bridge_controller.url; return protocol; } });
  const turn: AgentTurn = { conversation: { id: 'existing-controller', userId: 'owner', agent, nativeId: 'continued-native', title: '', cwd: root, createdAt: '', updatedAt: '' },
    source: { messageId: 'real-private-request', userId: 'owner', channelId: 'original-private-channel' }, text: '查询区域后只向测试群发一句，不在本私聊重复', imagePaths: [], signal: new AbortController().signal, onProgress() {},
    onPublicMessage: async (text, _paths, _id, target, finish) => { sends.push({ text, target, finish }); } };
  t.after(async () => { await adapter.close(); rmSync(root, { recursive: true, force: true }); });
  return { adapter, protocol, turn, invoked, sends };
}

function groupFixture(t: TestContext, agent: AgentName) {
  const f = fixture(t, agent);
  f.turn.source = { messageId: 'real-group-request', userId: 'owner', channelId: 'original-group-channel' };
  f.turn.groupContext = { eventId: 'group-private-event', rootId: 'group-private-root', botId: 'feishu:cli_fixture', spaceId: 'verified-test-group',
    generation: 1, bindingEpoch: 1, originChannelId: 'original-group-channel', principalId: 'verified-owner-principal', scene: 'verified group owner' };
  return f;
}


for (const agent of ['codex', 'claude'] as const) {
  test(`${agent} 旧私聊工具省略finish等待真实DM确认后DONE成功，群来源无需重复回复`, { timeout: 10000 }, async t => {
    const f = groupFixture(t, agent), entered = gate(), acknowledged = gate(); let settled = false;
    f.turn.onPublicMessage = async (text, _paths, _id, target, finish) => { f.sends.push({ text, target, finish }); entered.release(); await acknowledged.promise; };
    const running = f.adapter.run(f.turn); void running.then(() => { settled = true; }, () => { settled = true; }); await until(() => f.protocol.started);
    const publication = f.protocol.call('bridge_send_private', { principalId: 'verified-owner-principal', text: '仅私聊负责人' }); await entered.promise;
    f.protocol.complete(); await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(settled, false);
    acknowledged.release(); assert.equal((await publication).ok, true); const result = await running;
    assert.equal(result.controlledOutput, true); assert.equal(result.nativeId, 'continued-native'); assert.deepEqual(f.invoked, []);
    assert.deepEqual(f.sends, [{ text: '仅私聊负责人', target: 'private', finish: true }]);
    assert.equal(f.turn.source!.channelId, 'original-group-channel'); assert.equal(f.turn.groupContext!.eventId, 'group-private-event');
  });

  test(`${agent} 旧私聊显式false补充后仍可管理，再用同工具最终发送`, { timeout: 10000 }, async t => {
    const f = groupFixture(t, agent), running = f.adapter.run(f.turn); await until(() => f.protocol.started);
    assert.equal((await f.protocol.call('bridge_send_private', { principalId: 'verified-owner-principal', text: '私聊进度', finish: false })).ok, true);
    assert.equal((await f.protocol.call('bridge_list_workers', {})).ok, true);
    assert.equal((await f.protocol.call('bridge_send_private', { principalId: 'verified-owner-principal', text: '私聊结果' })).ok, true);
    f.protocol.complete(); assert.equal((await running).controlledOutput, true); assert.deepEqual(f.invoked, ['bridge_list_workers']);
    assert.deepEqual(f.sends, [{ text: '私聊进度', target: 'private', finish: false }, { text: '私聊结果', target: 'private', finish: true }]);
  });

  test(`${agent} 旧私聊前置owner或参数拒绝不封闭本轮，也不绕过统一投递验权`, { timeout: 10000 }, async t => {
    const f = groupFixture(t, agent), context = f.turn.groupContext!, running = f.adapter.run(f.turn); await until(() => f.protocol.started);
    assert.equal((await f.protocol.call('bridge_send_private', { principalId: 'another-owner', text: '禁止越权' })).ok, false);
    f.turn.groupContext = undefined;
    assert.equal((await f.protocol.call('bridge_send_private', { principalId: 'verified-owner-principal', text: '缺少群来源' })).ok, false);
    f.turn.groupContext = context;
    assert.equal((await f.protocol.call('bridge_send_private', { principalId: 'verified-owner-principal', text: '无效收尾', finish: 'false' })).ok, false);
    assert.equal((await f.protocol.call('bridge_send_private', { principalId: 'verified-owner-principal', text: 'x'.repeat(12001) })).ok, false);
    assert.equal((await f.protocol.call('bridge_send_private', { principalId: 'verified-owner-principal', text: '禁止\0空字符' })).ok, false);
    assert.deepEqual(f.sends, []); assert.deepEqual(f.invoked, []);
    assert.equal((await f.protocol.call('bridge_list_workers', {})).ok, true);
    assert.equal((await f.protocol.call('bridge_send_private', { principalId: 'verified-owner-principal', text: '合法回复', finish: true })).ok, true);
    f.protocol.complete(); assert.equal((await running).controlledOutput, true);
    assert.deepEqual(f.sends, [{ text: '合法回复', target: 'private', finish: true }]);
  });

  for (const finish of [undefined, false]) test(`${agent} 旧私聊${finish === false ? '补充' : '默认最终'}投递结果未知立即封闭且不盲重发`, { timeout: 10000 }, async t => {
    const f = groupFixture(t, agent); let attempts = 0;
    f.turn.onPublicMessage = async () => { attempts++; throw Object.assign(new Error('private delivery uncertain'), { deliveryUncertain: true }); };
    const running = f.adapter.run(f.turn), rejected = assert.rejects(running, /private delivery uncertain/); await until(() => f.protocol.started);
    assert.equal((await f.protocol.call('bridge_send_private', { principalId: 'verified-owner-principal', text: '真实私聊', ...(finish === false ? { finish } : {}) })).ok, false);
    await rejected; assert.equal(f.protocol.stopped, true); assert.equal(attempts, 1); assert.deepEqual(f.invoked, []);
  });

  test(`${agent} 原私聊查询后省略finish只投递测试群，DONE成功且无需补发私聊`, { timeout: 10000 }, async t => {
    const f = fixture(t, agent), entered = gate(), acknowledged = gate(); let settled = false;
    f.turn.onPublicMessage = async (text, _paths, _id, target, finish) => { f.sends.push({ text, target, finish }); entered.release(); await acknowledged.promise; };
    const running = f.adapter.run(f.turn); void running.then(() => { settled = true; }, () => { settled = true; }); await until(() => f.protocol.started);
    assert.equal((await f.protocol.call('bridge_delivery_targets', {})).ok, true);
    const publication = f.protocol.call('bridge_send_message', { targetId: TARGET, text: '只发给测试群的一句话' }); await entered.promise;
    f.protocol.complete(); await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(settled, false);
    acknowledged.release(); assert.equal((await publication).ok, true); const result = await running;
    assert.equal(result.controlledOutput, true); assert.equal(result.nativeId, 'continued-native'); assert.deepEqual(f.invoked, ['bridge_delivery_targets']);
    assert.deepEqual(f.sends, [{ text: '只发给测试群的一句话', target: TARGET, finish: true }]);
  });

  test(`${agent} 统一发送默认final后拒绝新管理调用并保留已确认的一次投递`, { timeout: 10000 }, async t => {
    const f = fixture(t, agent), running = f.adapter.run(f.turn); await until(() => f.protocol.started);
    assert.equal((await f.protocol.call('bridge_send_message', { targetId: TARGET, text: '最终发送' })).ok, true);
    assert.equal((await f.protocol.call('bridge_list_workers', {})).ok, false);
    const result = await running; assert.equal(result.controlledOutput, true); assert.equal(f.protocol.stopped, true); assert.deepEqual(f.invoked, []); assert.equal(f.sends.length, 1);
  });

  test(`${agent} 显式finish:false保留后续管理能力，再由统一发送最终结束`, { timeout: 10000 }, async t => {
    const f = fixture(t, agent), running = f.adapter.run(f.turn); await until(() => f.protocol.started);
    assert.equal((await f.protocol.call('bridge_send_message', { targetId: TARGET, text: '补充进度', finish: false })).ok, true);
    assert.equal((await f.protocol.call('bridge_list_workers', {})).ok, true);
    assert.equal((await f.protocol.call('bridge_send_message', { targetId: TARGET, text: '最终结果' })).ok, true);
    f.protocol.complete(); assert.equal((await running).controlledOutput, true); assert.deepEqual(f.invoked, ['bridge_list_workers']);
    assert.deepEqual(f.sends, [{ text: '补充进度', target: TARGET, finish: false }, { text: '最终结果', target: TARGET, finish: true }]);
  });

  test(`${agent} 统一发送拒绝无效finish类型或目标，不产生投递，显式true仍正常结束`, { timeout: 10000 }, async t => {
    const f = fixture(t, agent), running = f.adapter.run(f.turn); await until(() => f.protocol.started);
    for (const finish of ['false', 0, null, {}]) assert.equal((await f.protocol.call('bridge_send_message', { targetId: TARGET, text: 'invalid finish', finish })).ok, false);
    for (const targetId of ['', null, 1]) assert.equal((await f.protocol.call('bridge_send_message', { targetId, text: 'invalid target' })).ok, false);
    assert.deepEqual(f.sends, []);
    assert.equal((await f.protocol.call('bridge_send_message', { targetId: TARGET, text: '有效最终发送', finish: true })).ok, true);
    f.protocol.complete(); assert.equal((await running).controlledOutput, true); assert.deepEqual(f.sends, [{ text: '有效最终发送', target: TARGET, finish: true }]);
  });
}


for (const agent of ['codex', 'claude'] as const) {
  for (const name of ['bridge_send_user', 'bridge_send_message', 'bridge_send_private']) {
    test(`${agent} ${name}缺失附件只拒绝本次发送，允许同轮修正且不重派任务`, { timeout: 10000 }, async t => {
      const f = groupFixture(t, agent); let prepared = 0;
      f.turn.onPublicMessage = async (text, paths = [], _id, target, finish) => {
        prepared++;
        await collectOutgoingPaths(paths, f.turn.conversation.cwd, 1024);
        f.sends.push({ text, target, finish });
      };
      const running = f.adapter.run(f.turn); await until(() => f.protocol.started);
      const args = name === 'bridge_send_private' ? { principalId: 'verified-owner-principal' } : name === 'bridge_send_message' ? { targetId: 'private' } : {};
      assert.equal((await f.protocol.call(name, { ...args, text: '附上图片', attachmentPaths: [join(f.turn.conversation.cwd, 'missing-directory', 'missing.png')] })).ok, false);
      assert.equal(f.protocol.stopped, false); assert.deepEqual(f.sends, []);
      assert.equal((await f.protocol.call('bridge_list_workers', {})).ok, true);
      assert.equal((await f.protocol.call(name, { ...args, text: '图片文件缺失，本次只发送已核实的文字结果。' })).ok, true);
      f.protocol.complete(); assert.equal((await running).controlledOutput, true);
      assert.equal(prepared, 2); assert.equal(f.sends.length, 1); assert.deepEqual(f.invoked, ['bridge_list_workers']);
    });
  }
  for (const marked of [false, true]) {
    test(`${agent} 最终发送${marked ? '带未知标记的准备错误' : '普通网络错误'}仍停止本轮且不重发`, { timeout: 10000 }, async t => {
      const f = fixture(t, agent); let attempts = 0;
      f.turn.onPublicMessage = async () => {
        attempts++;
        throw marked ? Object.assign(new AttachmentPreparationError('delivery uncertain'), { deliveryUncertain: true }) : new Error('delivery uncertain');
      };
      const running = f.adapter.run(f.turn), rejected = assert.rejects(running, /delivery uncertain/); await until(() => f.protocol.started);
      assert.equal((await f.protocol.call('bridge_send_user', { text: '结果' })).ok, false);
      await rejected; assert.equal(f.protocol.stopped, true); assert.equal(attempts, 1); assert.deepEqual(f.invoked, []);
    });
  }
}
