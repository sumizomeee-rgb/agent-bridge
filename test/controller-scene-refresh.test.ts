import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NativeControllerAdapter } from '../src/controller/native.js';
import type { AgentName, AgentTurn } from '../src/types.js';
import type { JsonObject, RpcTransport } from '../src/agents/process.js';

async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!check()) { assert.ok(Date.now() < deadline, '现场重判协议没有达到预期'); await new Promise<void>(resolve => setImmediate(resolve)); }
}
function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
class SceneProtocol implements RpcTransport {
  listeners = new Set<(message: JsonObject) => void>(); failures = new Set<(error: Error) => void>(); written: JsonObject[] = [];
  turns = 0; stopped = false; mcpUrl = ''; private sequence = 100;
  constructor(readonly agent: AgentName) {}
  onMessage(callback: (message: JsonObject) => void) { this.listeners.add(callback); return () => this.listeners.delete(callback); }
  onFailure(callback: (error: Error) => void) { this.failures.add(callback); return () => this.failures.delete(callback); }
  emit(message: JsonObject) { queueMicrotask(() => this.listeners.forEach(callback => callback(message))); }
  write(message: JsonObject) {
    this.written.push(message);
    if (message.method === 'initialize') this.emit({ id: message.id, result: {} });
    if (message.method === 'config/read') this.emit({ id: message.id, result: { config: { model_provider: 'fixture' } } });
    if (message.method === 'thread/start' || message.method === 'thread/resume') this.emit({ id: message.id, result: { thread: { id: 'same-native-scene' }, modelProvider: 'fixture', model: 'fixture-model', reasoningEffort: null } });
    if (message.method === 'turn/start') { this.turns++; this.emit({ id: message.id, result: { turn: { id: 'scene-turn-' + this.turns } } }); this.emit({ method: 'turn/started', params: { threadId: 'same-native-scene', turn: { id: 'scene-turn-' + this.turns } } }); }
    if (message.type === 'user') { this.turns++; this.emit({ type: 'system', subtype: 'init', session_id: 'same-native-scene', tools: ['mcp__bridge_controller__bridge_start_worker', 'mcp__bridge_controller__bridge_send_message', 'mcp__bridge_controller__bridge_silent'] }); }
  }
  async call(name: string, args: JsonObject, callId?: string): Promise<JsonObject> {
    const id = ++this.sequence, nativeId = callId ?? 'scene-call-' + id;
    if (this.agent === 'codex') {
      this.emit({ id, method: 'item/tool/call', params: { threadId: 'same-native-scene', turnId: 'scene-turn-' + this.turns, callId: nativeId, tool: name, arguments: JSON.stringify(args) } });
      await until(() => this.written.some(message => message.id === id && !message.method));
      const result = this.written.find(message => message.id === id && !message.method)!.result as { success: boolean; contentItems: Array<{ text: string }> };
      assert.equal(result.success, true); return JSON.parse(result.contentItems[0]!.text) as JsonObject;
    }
    this.emit({ type: 'assistant', session_id: 'same-native-scene', message: { content: [{ type: 'tool_use', id: nativeId, name: 'mcp__bridge_controller__' + name, input: args }] } });
    const response = await fetch(this.mcpUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(5000),
      body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }) });
    assert.equal(response.status, 200); const body = await response.json() as { result: { content: Array<{ text: string }> } };
    return JSON.parse(body.result.content[0]!.text) as JsonObject;
  }
  complete() {
    if (this.agent === 'codex') this.emit({ method: 'turn/completed', params: { threadId: 'same-native-scene', turn: { id: 'scene-turn-' + this.turns, status: 'completed', items: [{ type: 'agentMessage', phase: 'final_answer', text: 'DONE' }] } } });
    else this.emit({ type: 'result', subtype: 'success', session_id: 'same-native-scene', result: 'DONE' });
  }
  async stop() { this.stopped = true; }
}
function fixture(t: TestContext, agent: AgentName) {
  const root = mkdtempSync(join(tmpdir(), 'controller-scene-refresh-')); mkdirSync(join(root, '.codex')); mkdirSync(join(root, '.claude')); writeFileSync(join(root, '.codex', 'config.toml'), 'model_provider="fixture"\n'); writeFileSync(join(root, '.claude', 'settings.json'), '{}');
  const protocol = new SceneProtocol(agent), invoked: string[] = [], sends: string[] = []; let silent = 0;
  let manage: (name: string) => Promise<unknown> = async () => ({ workerId: 'confirmed-worker', status: 'registered' });
  const adapter = new NativeControllerAdapter({ command: 'offline-fixture', args: [] }, {}, { agent, dataDir: join(root, 'data'), userHome: root,
    invokeTool: async (_turn, name) => { invoked.push(name); return manage(name); },
    createTransport: (_command, args) => { if (agent === 'claude') protocol.mcpUrl = JSON.parse(args[args.indexOf('--mcp-config') + 1]!).mcpServers.bridge_controller.url; return protocol; } });
  const turn: AgentTurn = { conversation: { id: 'scene-controller', userId: 'owner', agent, nativeId: 'same-native-scene', title: '', cwd: root, createdAt: '', updatedAt: '' },
    source: { messageId: 'original-owner-request', userId: 'owner', channelId: 'group-channel' }, text: '原始主人授权', imagePaths: [], signal: new AbortController().signal, onProgress() {},
    onPublicMessage: async text => { sends.push(text); }, onSilent: async () => { silent++; },
    groupContext: { eventId: 'same-event', rootId: 'same-root', botId: 'bot', spaceId: 'group', generation: 1, bindingEpoch: 1, originChannelId: 'group-channel', principalId: 'owner', scene: 'original scene' } };
  t.after(async () => { await adapter.close(); rmSync(root, { recursive: true, force: true }); });
  return { adapter, protocol, turn, invoked, sends, get silent() { return silent; }, set manage(value: (name: string) => Promise<unknown>) { manage = value; } };
}

for (const agent of ['codex', 'claude'] as const) {
  test(`${agent} 过时决策的并行派工发言静默全部未执行，明确原生完成后同会话只重判一次`, { timeout: 15000 }, async t => {
    const f = fixture(t, agent), checked = gate(); let checks = 0, settled = false;
    f.turn.onSceneCheck = async () => { checks++; await checked.promise; return { refreshRequired: true, scene: JSON.stringify({ recent: [{ text: 'Miku 已完成，公开结果可查' }] }) }; };
    const running = f.adapter.run(f.turn); void running.then(() => { settled = true; }, () => { settled = true; }); await until(() => f.protocol.turns === 1);
    const first = f.protocol.call('bridge_start_worker', { title: '旧任务', prompt: '重复读私聊' });
    await until(() => checks === 1);
    const old = [first, f.protocol.call('bridge_send_message', { targetId: 'group-target', text: '旧回复' }),
      f.protocol.call('bridge_schedule_worker', { title: '旧计划', prompt: '旧指令', afterSeconds: 60 }), f.protocol.call('bridge_silent', {})];
    await until(() => checks === 1); checked.release();
    for (const value of await Promise.all(old)) { assert.equal(value.performed, false); assert.equal(value.reassessmentPending, true); }
    // A late call from the same old decision remains blocked; consuming the durable
    // once-only budget must never accidentally let it through.
    for (let n = 0; n < 15; n++) assert.equal((await f.protocol.call('bridge_start_worker', { title: '旧批', prompt: '仍未重判' })).performed, false);
    assert.equal(checks, 1); assert.deepEqual(f.invoked, []); assert.deepEqual(f.sends, []); assert.equal(f.silent, 0); assert.equal(f.protocol.turns, 1); assert.equal(settled, false);
    f.protocol.complete(); await until(() => f.protocol.turns === 2); assert.equal(settled, false);
    const refresh = f.protocol.written.filter(message => agent === 'codex' ? message.method === 'turn/start' : message.type === 'user')[1]!;
    assert.match(JSON.stringify(refresh), /Miku 已完成/); assert.match(JSON.stringify(refresh), /not a new human request/);
    assert.equal((await f.protocol.call('bridge_start_worker', { title: '独立复核', prompt: '根据新结果另做复核' })).workerId, 'confirmed-worker');
    await f.protocol.call('bridge_send_message', { targetId: 'group-target', text: '已根据最新结果安排独立复核' });
    f.protocol.complete(); assert.equal((await running).nativeId, 'same-native-scene'); assert.equal(checks, 1); assert.equal(f.protocol.turns, 2);
    assert.deepEqual(f.invoked, ['bridge_start_worker']); assert.deepEqual(f.sends, ['已根据最新结果安排独立复核']); assert.equal(f.silent, 0);
  });

  test(`${agent} 原有已执行派工不重放，现场刷新只暂停后续旧动作并保留原授权`, { timeout: 10000 }, async t => {
    const f = fixture(t, agent); let checks = 0;
    f.turn.onSceneCheck = async () => ({ refreshRequired: ++checks === 2, scene: JSON.stringify({ tasks: [{ owner: 'other-bot', state: 'completed' }] }) });
    const running = f.adapter.run(f.turn); await until(() => f.protocol.turns === 1);
    assert.equal((await f.protocol.call('bridge_start_worker', { title: '已启动', prompt: '执行有效工作' })).workerId, 'confirmed-worker');
    assert.equal((await f.protocol.call('bridge_send_message', { targetId: 'group-target', text: '过时表述' })).performed, false);
    f.protocol.complete(); await until(() => f.protocol.turns === 2);
    await f.protocol.call('bridge_send_message', { targetId: 'group-target', text: '保留原助手，采用新进展' }); f.protocol.complete(); await running;
    assert.deepEqual(f.invoked, ['bridge_start_worker']); assert.deepEqual(f.sends, ['保留原助手，采用新进展']); assert.equal(f.turn.groupContext!.rootId, 'same-root'); assert.equal(f.turn.source!.messageId, 'original-owner-request');
  });

  test(`${agent} Host原子派工前发现过期也建立屏障，等待中的final不发布并在新决策重发`, { timeout: 10000 }, async t => {
    const f = fixture(t, agent), dispatched = gate();
    f.turn.onSceneCheck = async () => ({ refreshRequired: false });
    f.manage = async () => { await dispatched.promise; return { performed: false, sceneChanged: true, sceneRefreshRequired: true, scene: JSON.stringify({ recent: [{ text: '另一 Bot 刚刚启动助手' }] }) }; };
    const running = f.adapter.run(f.turn); await until(() => f.protocol.turns === 1);
    const worker = f.protocol.call('bridge_start_worker', { title: '尚未派发', prompt: '旧计划' });
    await until(() => f.invoked.length === 1);
    const oldFinal = f.protocol.call('bridge_send_message', { targetId: 'group-target', text: '旧确认' });
    await new Promise<void>(resolve => setImmediate(resolve)); dispatched.release();
    assert.equal((await worker).performed, false); assert.equal((await oldFinal).performed, false); assert.deepEqual(f.sends, []);
    f.protocol.complete(); await until(() => f.protocol.turns === 2);
    await f.protocol.call('bridge_send_message', { targetId: 'group-target', text: '采用最新分工' }); f.protocol.complete(); await running;
    assert.deepEqual(f.sends, ['采用最新分工']); assert.equal(f.silent, 0); assert.equal(f.protocol.turns, 2);
  });

  test(`${agent} 直接群静默不查询现场不强制重判，旧认领完成工具无副作用兼容`, { timeout: 10000 }, async t => {
    const f = fixture(t, agent); let checks = 0; f.turn.onSceneCheck = async () => { checks++; return { refreshRequired: true, scene: '{}' }; };
    const running = f.adapter.run(f.turn); await until(() => f.protocol.turns === 1);
    for (const name of ['bridge_claim_work', 'bridge_finish_work']) { const result = await f.protocol.call(name, { taskId: 'old-id', title: 'old' }); assert.equal(result.performed, false); assert.equal(result.legacyTool, true); }
    await f.protocol.call('bridge_list_workers', {}); await f.protocol.call('bridge_silent', {}); f.protocol.complete(); await running;
    assert.equal(checks, 0); assert.equal(f.protocol.turns, 1); assert.equal(f.silent, 1); assert.deepEqual(f.invoked, ['bridge_list_workers']);
  });
}
