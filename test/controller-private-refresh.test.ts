import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NativeControllerAdapter } from '../src/controller/native.js';
import { RestartService } from '../src/restart.js';
import { SessionStore } from '../src/store.js';
import { invokeControllerFileTool } from '../src/controller/files.js';
import type { AgentName, AgentTurn, PrivateInputBatch } from '../src/types.js';
import type { JsonObject, RpcTransport } from '../src/agents/process.js';

async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!check()) { assert.ok(Date.now() < deadline, '私聊续决策协议没有达到预期'); await new Promise<void>(resolve => setImmediate(resolve)); }
}
function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
class PrivateProtocol implements RpcTransport {
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
    if (message.method === 'thread/start' || message.method === 'thread/resume') this.emit({ id: message.id, result: { thread: { id: 'same-private-native' }, modelProvider: 'fixture', model: 'fixture-model', reasoningEffort: null } });
    if (message.method === 'turn/start') { this.turns++; this.emit({ id: message.id, result: { turn: { id: 'private-turn-' + this.turns } } }); this.emit({ method: 'turn/started', params: { threadId: 'same-private-native', turn: { id: 'private-turn-' + this.turns } } }); }
    if (message.type === 'user') { this.turns++; this.emit({ type: 'system', subtype: 'init', session_id: 'same-private-native', tools: ['mcp__bridge_controller__bridge_start_worker', 'mcp__bridge_controller__bridge_send_message', 'mcp__bridge_controller__bridge_send_user'] }); }
  }
  async call(name: string, args: JsonObject, callId?: string, nativeTurn = this.turns): Promise<{ ok: boolean; value: JsonObject }> {
    const id = ++this.sequence, toolId = callId ?? 'private-call-' + id;
    if (this.agent === 'codex') {
      this.emit({ id, method: 'item/tool/call', params: { threadId: 'same-private-native', turnId: 'private-turn-' + nativeTurn, callId: toolId, tool: name, arguments: JSON.stringify(args) } });
      await until(() => this.written.some(message => message.id === id && !message.method));
      const result = this.written.find(message => message.id === id && !message.method)!.result as { success: boolean; contentItems: Array<{ text: string }> };
      return { ok: result.success, value: result.success ? JSON.parse(result.contentItems[0]!.text) : { error: result.contentItems[0]!.text } };
    }
    this.emit({ type: 'assistant', session_id: 'same-private-native', message: { content: [{ type: 'tool_use', id: toolId, name: 'mcp__bridge_controller__' + name, input: args }] } });
    const response = await fetch(this.mcpUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(5000),
      body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }) });
    const body = await response.json() as { result?: { isError?: boolean; content: Array<{ text: string }> }; error?: unknown };
    return { ok: response.status === 200 && !body.result?.isError && !body.error, value: body.result
      ? body.result.isError ? { error: body.result.content[0]!.text } : JSON.parse(body.result.content[0]!.text) : { error: body.error } };
  }
  complete() {
    if (this.agent === 'codex') this.emit({ method: 'turn/completed', params: { threadId: 'same-private-native', turn: { id: 'private-turn-' + this.turns, status: 'completed', items: [{ type: 'agentMessage', phase: 'final_answer', text: 'DONE' }] } } });
    else this.emit({ type: 'result', subtype: 'success', session_id: 'same-private-native', result: 'DONE' });
  }
  async stop() { this.stopped = true; }
}
function fixture(t: TestContext, agent: AgentName) {
  const path = mkdtempSync(join(tmpdir(), 'controller-private-refresh-')); mkdirSync(join(path, '.codex')); mkdirSync(join(path, '.claude'));
  writeFileSync(join(path, '.codex', 'config.toml'), 'model_provider="fixture"\n'); writeFileSync(join(path, '.claude', 'settings.json'), '{}');
  const protocol = new PrivateProtocol(agent), invoked: Array<{ name: string; source: AgentTurn['source']; images: string[] }> = [], sends: Array<{ text: string; target: string | undefined; finish: boolean | undefined }> = [];
  const beforeCleanup: Array<() => void> = [];
  let manage: (turn: AgentTurn, name: string, args: JsonObject, id?: string) => Promise<unknown> = async () => ({ workerId: 'private-worker', status: 'started' });
  const adapter = new NativeControllerAdapter({ command: 'offline-fixture', args: [] }, {}, { agent, dataDir: join(path, 'data'), userHome: path,
    invokeTool: async (turn, name, args, id) => { invoked.push({ name, source: turn.source, images: turn.imagePaths }); return manage(turn, name, args, id); },
    createTransport: (_command, args) => { if (agent === 'claude') protocol.mcpUrl = JSON.parse(args[args.indexOf('--mcp-config') + 1]!).mcpServers.bridge_controller.url; return protocol; } });
  const turn: AgentTurn = { conversation: { id: 'private-controller', userId: 'owner', agent, nativeId: 'same-private-native', title: '', cwd: path, createdAt: '', updatedAt: '' },
    source: { messageId: 'original-private-input', userId: 'owner', channelId: 'private-channel' }, text: '先看旧要求', imagePaths: [], signal: new AbortController().signal, onProgress() {},
    onPublicMessage: async (text, _paths, _id, target, finish) => { sends.push({ text, target, finish }); } };
  const batch = (version = 2): PrivateInputBatch => ({ version, messages: [{ id: 'new-private-input', userId: 'owner', channelId: 'private-channel', text: '主人新要求：改看新的点', imagePaths: [],
    source: { messageId: 'raw-new-message', userId: 'actual-platform-owner', channelId: 'actual-private-chat', authorType: 'user', time: '2026-10-18T12:00:00.000Z' } }] });
  t.after(async () => { await adapter.close(); for (const close of beforeCleanup) close(); rmSync(path, { recursive: true, force: true }); });
  return { adapter, protocol, turn, invoked, sends, batch, path, beforeCleanup: (close: () => void) => beforeCleanup.push(close), set manage(value: typeof manage) { manage = value; } };
}

for (const agent of ['codex', 'claude'] as const) test(`${agent} 主控实际协议暴露并调用历史/清单工具，注入紧凑索引，修改先检查新输入`, async t => {
  const f = fixture(t, agent), store = new SessionStore(join(f.path, 'knowledge'));
  f.beforeCleanup(() => store.close());
  const scope = { userId: 'owner', channelId: 'private-channel' };
  const conversation = store.createConversation('owner', agent, f.path);
  store.addMessage({ id: 'remember', userId: 'owner', channelId: scope.channelId, text: '先排除免打扰再取最近 N 个', imagePaths: [] }, conversation.id, 'completed');
  f.manage = async (_turn, name, args, id) => store.knowledge.invoke(scope, name, args, id ?? 'none');
  f.turn.conversation.nativeId = null;
  f.turn.taskChecklist = store.knowledge.summary(scope);
  let checks = 0; f.turn.onPrivateInputCheck = async () => { checks++; return { refreshRequired: false }; };
  const running = f.adapter.run(f.turn); await until(() => f.protocol.turns === 1);
  const names = ['bridge_search_chat_history', 'bridge_read_chat_history', 'bridge_list_tasks', 'bridge_update_tasks'];
  if (agent === 'codex') {
    const started = f.protocol.written.find(message => message.method === 'thread/start')!.params as JsonObject;
    assert(names.every(name => (started.dynamicTools as JsonObject[]).some(tool => tool.name === name)));
  } else {
    const response = await fetch(f.protocol.mcpUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 999, method: 'tools/list' }) });
    const body = await response.json() as { result: { tools: { name: string }[] } };
    assert(names.every(name => body.result.tools.some(tool => tool.name === name)));
  }
  assert.match(JSON.stringify(f.protocol.written), /Bridge task checklist/);
  const found = await f.protocol.call(names[0]!, { query: '免打扰' });
  assert.equal(found.ok, true); assert.match(JSON.stringify(found.value), /先排除免打扰/);
  const read = await f.protocol.call(names[1]!, { messageId: 'input:remember' }); assert.equal(read.ok, true);
  assert.equal(checks, 0);
  const updated = await f.protocol.call(names[3]!, { changes: [{ id: 'current-goal', expectedVersion: 0, title: '交付筛选结果', requirements: '先排除免打扰', evidenceIds: ['input:remember'] }] });
  assert.equal(updated.ok, true); assert.equal(checks, 1);
  const listed = await f.protocol.call(names[2]!, { id: 'current-goal' }); assert.match(JSON.stringify(listed.value), /先排除免打扰/);
  await f.protocol.call('bridge_send_user', { text: '已记住并核对原文。' }); f.protocol.complete();
  assert.equal((await running).controlledOutput, true);
  assert.deepEqual(f.invoked.map(item => item.name), [names[0], names[1], names[3], names[2]]);
});

for (const agent of ['codex', 'claude'] as const) test(`${agent} 主控真实协议提供文件快读与单层目录工具，按需读取不触发执行重判`, async t => {
  const f = fixture(t, agent), path = join(f.path, 'lookup.txt'); writeFileSync(path, '只在工具调用后返回的资料');
  f.turn.conversation.nativeId = null;
  f.manage = (turn, name, args) => invokeControllerFileTool(name, args, turn.signal);
  let checks = 0; f.turn.onPrivateInputCheck = async () => { checks++; return { refreshRequired: false }; };
  const running = f.adapter.run(f.turn); await until(() => f.protocol.turns === 1);
  const names = ['bridge_read_file', 'bridge_list_directory'];
  if (agent === 'codex') {
    const started = f.protocol.written.find(message => message.method === 'thread/start')!.params as JsonObject;
    assert(names.every(name => (started.dynamicTools as JsonObject[]).some(tool => tool.name === name)));
  } else {
    const response = await fetch(f.protocol.mcpUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 999, method: 'tools/list' }) });
    const body = await response.json() as { result: { tools: { name: string }[] } };
    assert(names.every(name => body.result.tools.some(tool => tool.name === name)));
  }
  assert.doesNotMatch(JSON.stringify(f.protocol.written), /只在工具调用后返回的资料/);
  const read = await f.protocol.call(names[0]!, { path }); assert.equal(read.ok, true); assert.match(JSON.stringify(read.value), /只在工具调用后返回的资料/);
  const list = await f.protocol.call(names[1]!, { path: f.path }); assert.equal(list.ok, true); assert.match(JSON.stringify(list.value), /lookup.txt/);
  assert.equal(checks, 0);
  await f.protocol.call('bridge_send_user', { text: '已核对资料。' }); f.protocol.complete(); await running;
  assert.equal(checks, 1); assert.deepEqual(f.invoked.map(item => item.name), names);
});

for (const agent of ['codex', 'claude'] as const) {
  test(`${agent} 新私聊输入暂停整个旧并行批次，同一原生会话只续判一次且保持真实新授权及图片顺序`, { timeout: 15000 }, async t => {
    const f = fixture(t, agent), checked = gate(); let checks = 0, settled = false;
    const firstImage = join(f.path, 'first.png'), secondImage = join(f.path, 'second.png');
    const imageBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aT5sAAAAASUVORK5CYII=', 'base64');
    writeFileSync(firstImage, imageBytes); writeFileSync(secondImage, Buffer.concat([imageBytes, Buffer.from([1])]));
    const input = f.batch(); input.messages[0]!.imagePaths = [firstImage];
    input.messages.push({ id: 'new-private-input-2', userId: 'owner', channelId: 'private-channel', text: '第二条新要求：再加这张图', imagePaths: [secondImage],
      source: { messageId: 'raw-new-message-2', userId: 'actual-platform-owner', channelId: 'actual-private-chat', authorType: 'user' } });
    f.turn.onPrivateInputCheck = async () => { checks++; await checked.promise; return { refreshRequired: true, input }; };
    const running = f.adapter.run(f.turn); void running.then(() => { settled = true; }, () => { settled = true; }); await until(() => f.protocol.turns === 1);
    const first = f.protocol.call('bridge_start_worker', { title: '旧执行', prompt: '旧要求' }); await until(() => checks === 1);
    const old = [first, f.protocol.call('bridge_continue_worker', { workerId: 'old-worker', prompt: '旧续接' }),
      f.protocol.call('bridge_schedule_worker', { title: '旧计划', prompt: '旧要求', afterSeconds: 60 }),
      f.protocol.call('bridge_send_user', { text: '过时回答' })];
    checked.release();
    for (const result of await Promise.all(old)) { assert.equal(result.ok, true); assert.equal(result.value.performed, false); assert.ok(result.value.privateInputChanged === true || result.value.privateFinalPending === true); }
    for (let n = 0; n < 14; n++) assert.equal((await f.protocol.call('bridge_start_worker', { title: '旧批迟到调用', prompt: '不能执行' })).value.performed, false);
    assert.equal(f.invoked.length, 0); assert.equal(f.sends.length, 0); assert.equal(checks, 1); assert.equal(f.protocol.turns, 1); assert.equal(settled, false);
    f.protocol.complete(); await until(() => f.protocol.turns === 2); assert.equal(settled, false);
    const refresh = f.protocol.written.filter(message => agent === 'codex' ? message.method === 'turn/start' : message.type === 'user')[1]!;
    const body = agent === 'codex' ? refresh.params as JsonObject : refresh;
    assert.equal('toolOutput' in body, false, 'private owner inputs are normal user input, never group tool evidence');
    const values = (agent === 'codex' ? body.input : (body.message as JsonObject).content) as JsonObject[];
    assert.match(String(values[0]!.text), /主人新要求/); assert.match(String(values[0]!.text), /raw-new-message/); assert.match(String(values[0]!.text), /actual-platform-owner/);
    assert.match(String(values[2]!.text), /第二条新要求/); assert.match(String(values[2]!.text), /raw-new-message-2/);
    if (agent === 'codex') { assert.deepEqual(values[1], { type: 'localImage', path: firstImage }); assert.deepEqual(values[3], { type: 'localImage', path: secondImage }); }
    else { assert.equal(values[1]!.type, 'image'); assert.equal(values[3]!.type, 'image'); assert.notEqual((values[1]!.source as JsonObject).data, (values[3]!.source as JsonObject).data); }
    assert.doesNotMatch(JSON.stringify(refresh), /newAuthorization|not a new human request|read-only group evidence/);
    assert.equal((await f.protocol.call('bridge_start_worker', { title: '按新要求执行', prompt: '新任务' })).value.workerId, 'private-worker');
    assert.equal(f.invoked[0]!.source!.messageId, 'new-private-input-2'); assert.equal(f.invoked[0]!.source!.original!.messageId, 'raw-new-message-2'); assert.deepEqual(f.invoked[0]!.images, [firstImage, secondImage]);
    assert.equal((await f.protocol.call('bridge_send_user', { text: '已按新要求处理' })).ok, true); f.protocol.complete();
    assert.equal((await running).nativeId, 'same-private-native'); assert.equal(f.protocol.turns, 2); assert.equal(checks, 1); assert.deepEqual(f.sends.map(value => value.text), ['已按新要求处理']);
  });

  test(`${agent} 私聊向群只能补充发送，拒绝外群FINAL不查询新输入不消耗重判且仍须私聊FINAL`, { timeout: 10000 }, async t => {
    const f = fixture(t, agent); let checks = 0, settled = false;
    f.turn.onPrivateInputCheck = async () => { checks++; return { refreshRequired: false }; };
    const running = f.adapter.run(f.turn); void running.then(() => { settled = true; }, () => { settled = true; }); await until(() => f.protocol.turns === 1);
    const rejected = await f.protocol.call('bridge_send_message', { targetId: 'group:authorized', text: '群内结果' });
    assert.equal(rejected.ok, true); assert.equal(rejected.value.performed, false); assert.equal(rejected.value.privateResponseRequired, true); assert.equal(checks, 0); assert.equal(f.sends.length, 0);
    assert.equal((await f.protocol.call('bridge_send_message', { targetId: 'group:authorized', text: '群内结果', finish: false })).value.delivered, true);
    assert.equal(settled, false); assert.equal(f.sends[0]!.finish, false);
    assert.equal((await f.protocol.call('bridge_silent', {})).ok, false, 'private input cannot end in group silence');
    await f.protocol.call('bridge_send_message', { targetId: 'private', text: '已经把结果发进指定群' }); f.protocol.complete(); await running;
    assert.deepEqual(f.sends, [{ text: '群内结果', target: 'group:authorized', finish: false }, { text: '已经把结果发进指定群', target: 'private', finish: true }]);
  });

  test(`${agent} 已有私聊FINAL准备或发送时，并行晚到final不得领取新输入或把旧回答扩成新消息回执`, { timeout: 10000 }, async t => {
    const f = fixture(t, agent), admitted = gate(), publication = gate(); let checks = 0, pendingNewInput = false, claimed = 0;
    f.turn.onPrivateInputCheck = async () => {
      checks++; if (pendingNewInput) { claimed++; return { refreshRequired: true, input: f.batch() }; }
      await admitted.promise; return { refreshRequired: false };
    };
    f.turn.onPublicMessage = async (text, _paths, _id, target, finish) => { f.sends.push({ text, target, finish }); await publication.promise; };
    const running = f.adapter.run(f.turn); await until(() => f.protocol.turns === 1);
    const first = f.protocol.call('bridge_send_user', { text: '只回答最初的 A' }); await until(() => checks === 1);
    pendingNewInput = true;
    const parallel = await f.protocol.call('bridge_send_user', { text: '同一个旧批次的第二final' });
    assert.equal(parallel.value.performed, false); assert.equal(parallel.value.privateFinalPending, true); assert.equal(claimed, 0); assert.equal(checks, 1);
    admitted.release(); await until(() => f.sends.length === 1);
    const late = await f.protocol.call('bridge_send_user', { text: '投递中的晚到final' });
    assert.equal(late.value.performed, false); assert.equal(claimed, 0); assert.equal(checks, 1);
    publication.release(); assert.equal((await first).value.delivered, true); f.protocol.complete(); await running;
    assert.equal(f.protocol.turns, 1); assert.deepEqual(f.sends.map(value => value.text), ['只回答最初的 A']); assert.equal(pendingNewInput, true, 'B stays in manager queue for its actual next response');
  });

  test(`${agent} 普通私聊接受重启后仍一次原DM FINAL，真实排空服务等待该回复完成`, { timeout: 10000 }, async t => {
    const f = fixture(t, agent), acknowledged = gate(); let nativeFinished = false, drains = 0, stops = 0;
    const exits: number[] = [];
    const restart = new RestartService(join(f.path, 'restart'), { supervised: true, beginDrain: () => { drains++; },
      isIdle: () => nativeFinished, shutdown: async () => { stops++; }, onShutdownComplete: code => { exits.push(code); }, onPhase() {}, pollMs: 60000 });
    try {
      f.turn.onPrivateInputCheck = async () => ({ refreshRequired: false });
      f.manage = async () => restart.request({ conversationId: f.turn.conversation.id, userId: f.turn.source!.userId,
        channelId: f.turn.source!.channelId, originMessageId: f.turn.source!.messageId, nativeId: 'same-private-native' });
      f.turn.onPublicMessage = async (text, _paths, _id, target, finish) => { f.sends.push({ text, target, finish }); await acknowledged.promise; };
      const running = f.adapter.run(f.turn); void running.then(() => { nativeFinished = true; }, () => { nativeFinished = true; });
      await until(() => f.protocol.turns === 1);
      const registered = await f.protocol.call('bridge_request_restart', {});
      assert.equal(registered.ok, true); assert.equal(registered.value.accepted, true); assert.equal(registered.value.privateResponseRequired, true);
      assert.match(String(registered.value.message), /has not completed/); assert.equal(drains, 1); assert.equal(restart.isDraining(), true);
      await restart.check(); assert.equal(stops, 0);
      const final = f.protocol.call('bridge_send_user', { text: '已安排重启，当前回复结束后执行。' });
      await until(() => f.sends.length === 1); f.protocol.complete();
      await restart.check(); assert.equal(stops, 0); assert.equal(nativeFinished, false);
      acknowledged.release(); assert.equal((await final).value.delivered, true); assert.equal((await running).controlledOutput, true);
      await restart.check(); assert.equal(stops, 1); assert.deepEqual(exits, [75]);
      assert.deepEqual(f.sends, [{ text: '已安排重启，当前回复结束后执行。', target: undefined, finish: true }]); assert.equal(f.protocol.turns, 1);
    } finally { acknowledged.release(); restart.close(); }
  });

  test(`${agent} 普通私聊已接受重启也不能用无回复DONE伪装原DM最终交付`, { timeout: 10000 }, async t => {
    const f = fixture(t, agent); f.turn.onPrivateInputCheck = async () => ({ refreshRequired: false });
    f.manage = async () => ({ accepted: true, status: 'draining' });
    const running = f.adapter.run(f.turn), rejected = assert.rejects(running, /没有通过公开通道回复/);
    await until(() => f.protocol.turns === 1);
    assert.equal((await f.protocol.call('bridge_request_restart', {})).value.privateResponseRequired, true);
    f.protocol.complete(); await rejected; assert.equal(f.sends.length, 0);
  });

  test(`${agent} 没有私聊输入回调的兼容及背景重启仍保留原生命周期结束方式`, { timeout: 10000 }, async t => {
    const f = fixture(t, agent); f.manage = async () => ({ accepted: true, status: 'draining' });
    const ordinary = f.adapter.run(f.turn); await until(() => f.protocol.turns === 1);
    const receipt = await f.protocol.call('bridge_request_restart', {}); assert.equal(receipt.value.privateResponseRequired, undefined);
    f.protocol.complete(); assert.equal((await ordinary).controlledOutput, true);
    f.turn.event = { kind: 'wake', text: '已授权的后台重启任务' };
    const background = f.adapter.run(f.turn); await until(() => f.protocol.turns === 2);
    assert.equal((await f.protocol.call('bridge_request_restart', {})).value.privateResponseRequired, undefined);
    f.protocol.complete(); assert.equal((await background).controlledOutput, true); assert.equal(f.sends.length, 0);
  });

  test(`${agent} 只读工具不触发私聊合并，已经派出的助手保持一次且新输入到来只暂停旧最终回复`, { timeout: 10000 }, async t => {
    const f = fixture(t, agent); let checks = 0;
    f.turn.onPrivateInputCheck = async () => ({ refreshRequired: ++checks === 2, input: f.batch() });
    const running = f.adapter.run(f.turn); await until(() => f.protocol.turns === 1);
    await f.protocol.call('bridge_list_workers', {}); assert.equal(checks, 0);
    await f.protocol.call('bridge_start_worker', { title: '已经派出', prompt: '有效任务' });
    assert.equal((await f.protocol.call('bridge_send_user', { text: '旧最终回复' })).value.performed, false);
    f.protocol.complete(); await until(() => f.protocol.turns === 2);
    await f.protocol.call('bridge_send_user', { text: '保留原助手，按新要求回复' }); f.protocol.complete(); await running;
    assert.deepEqual(f.invoked.map(value => value.name), ['bridge_list_workers', 'bridge_start_worker']); assert.deepEqual(f.sends.map(value => value.text), ['保留原助手，按新要求回复']);
  });
}
