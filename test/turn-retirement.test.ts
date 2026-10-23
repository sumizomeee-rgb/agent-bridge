import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ClaudeAdapter } from '../src/agents/claude.js';
import { CodexAdapter } from '../src/agents/codex.js';
import { deferred, type JsonObject, type AgentStopEvidence } from '../src/agents/process.js';
import { completedRetirementFailure } from '../src/agents/retirement.js';
import { ControllerRuntime } from '../src/controller/runtime.js';
import { RemoteDaemon } from '../src/remote/daemon.js';
import { RemoteAgentAdapter } from '../src/remote/adapter.js';
import { TaskRegistry, type TaskCompletionEvent } from '../src/tasks.js';
import { formatWorkerOverview } from '../src/overview.js';
import type { AgentAdapter, AgentName, AgentResult, AgentTurn, BridgeConfig } from '../src/types.js';
import type { RemoteClient, RemoteDispatch, RemoteJob } from '../src/remote/types.js';
import { ownTemporaryDirectory } from './temp-directory.js';

const pause = () => new Promise<void>(resolve => setTimeout(resolve, 10));
async function until(check: () => boolean) { const end = Date.now() + 3000; while (!check()) { assert(Date.now() < end, '等待可观察状态超时'); await pause(); } }
const evidence = (): AgentStopEvidence => ({ pid: process.pid, graceful: true, exitObserved: false, exitCode: null,
  signalCode: null, closeObserved: false, taskkillAttempted: false, taskkillExitCode: null, durationMs: 1, phaseMs: {}, completion: 'pending' });
const directory = () => ownTemporaryDirectory(mkdtempSync(join(tmpdir(), 'bridge-turn-retirement-')), 'bridge-turn-retirement-');

class NativeTransport {
  readonly messages = new Set<(message: JsonObject) => void>();
  readonly failures = new Set<(error: Error) => void>();
  readonly writes: JsonObject[] = [];
  readonly modes: boolean[] = [];
  readonly gate = deferred<void>();
  stopped = false;
  onMessage(fn: (message: JsonObject) => void) { this.messages.add(fn); return () => { this.messages.delete(fn); }; }
  onFailure(fn: (error: Error) => void) { this.failures.add(fn); return () => { this.failures.delete(fn); }; }
  emit(message: JsonObject) { queueMicrotask(() => this.messages.forEach(fn => fn(message))); }
  endInput() {}
  write(message: JsonObject) {
    this.writes.push(message);
    if (message.method === 'initialize') this.emit({ id: message.id, result: {} });
    if (message.method === 'config/read') this.emit({ id: message.id, result: { config: { model_provider: 'fixture' } } });
    if (message.method === 'thread/start' || message.method === 'thread/resume') this.emit({ id: message.id, result: { thread: { id: 'native-fixture' }, modelProvider: 'fixture' } });
    if (message.method === 'turn/start') {
      this.emit({ id: message.id, result: { turn: { id: 'turn-fixture' } } });
      this.emit({ method: 'turn/completed', params: { threadId: 'native-fixture', turn: { id: 'turn-fixture', status: 'completed', items: [{ type: 'agentMessage', id: 'final', phase: 'final_answer', text: '报告完成；业务验收另核' }] } } });
    }
    if (message.type === 'user') {
      this.emit({ type: 'system', subtype: 'init', session_id: 'native-fixture' });
      this.emit({ type: 'result', subtype: 'success', session_id: 'native-fixture', result: '报告完成；业务验收另核' });
    }
  }
  release() { this.stopped = true; this.gate.resolve(); }
  async stop(graceful = false) { this.modes.push(graceful); if (!graceful) this.release(); await this.gate.promise; }
  confirmStopped() { return this.stopped; }
}
function turn(root: string, agent: AgentName = 'codex'): AgentTurn {
  return { conversation: { id: 'worker-fixture', userId: 'owner', agent, model: 'fixture', nativeId: null, title: '', cwd: root, createdAt: '', updatedAt: '' },
    text: '只执行已授权任务', imagePaths: [], signal: new AbortController().signal, onProgress() {} };
}
for (const backend of ['codex', 'claude'] as const) test(`${backend} 原生结束即返回报告；CLI 未退前不并发新轮，也不把清理当成任务失败`, async () => {
  const root = directory(), transports: NativeTransport[] = [];
  const make = () => { const transport = new NativeTransport(); transports.push(transport); if (transports.length > 1) transport.release(); return transport; };
  const adapter = backend === 'codex' ? new CodexAdapter({ command: 'never-spawn', args: [] }, {}, make)
    : new ClaudeAdapter({ command: 'never-spawn', args: [] }, {}, make);
  try {
    let result: AgentResult | undefined;
    const running = adapter.run(turn(root, backend)).then(value => { result = value; });
    await until(() => !!result); await running;
    assert.equal(result!.text, '报告完成；业务验收另核'); assert.equal(result!.processStopped, false);
    assert.equal(await adapter.confirmStopped('worker-fixture'), false); assert.deepEqual(transports[0]!.modes, [true]);
    const next = adapter.run({ ...turn(root, backend), conversation: { ...turn(root, backend).conversation, nativeId: 'native-fixture' } });
    await pause(); assert.equal(transports.length, 1);
    transports[0]!.release(); const resumed = await next;
    assert.equal(resumed.nativeId, 'native-fixture'); assert.equal(transports.length, 2);
    const oldInputs = transports[0]!.writes.filter(m => backend === 'codex' ? m.method === 'turn/start' : m.type === 'user');
    assert.equal(oldInputs.length, 1);
  } finally { transports.forEach(t => t.release()); await adapter.close(); }
});

function runtimeFixture() {
  const root = directory(), command = { command: 'never-spawn', args: [] };
  const config: BridgeConfig = { token: '', allowedUserIds: ['owner'], defaultAgent: 'codex', workspace: root, proxyUrl: null,
    commands: { codex: command, claude: command }, defaultModels: { codex: 'fixture' }, dataDir: root, attachmentsDir: root, logsDir: root, maxImageBytes: 100 };
  const registry = new TaskRegistry(root), events: TaskCompletionEvent[] = [], calls: AgentTurn[] = [];
  let stopped = false;
  const adapter: AgentAdapter = { async run(value) { calls.push(value); return { nativeId: 'native-runtime', text: '原生报告已完成', processStopped: calls.length > 1 || stopped, stopEvidence: evidence() }; },
    async interrupt() {}, async close() {}, async confirmStopped() { return stopped; } };
  const callbacks = { pollIntervalMs: 10, onCompletion(event: TaskCompletionEvent) { events.push(event); } };
  const runtime = new ControllerRuntime(config, { codex: adapter, claude: adapter }, registry, callbacks);
  const parent = turn(root); parent.conversation.id = 'parent'; parent.conversation.nativeId = 'parent-native';
  parent.source = { messageId: 'owner-message', userId: 'owner', channelId: 'owner-dm' };
  parent.taskContextPath = registry.createContext({ conversationId: 'parent', userId: 'owner', channelId: 'owner-dm',
    originMessageId: 'owner-message', nativeId: 'parent-native', agent: 'codex', cwd: root }).contextPath;
  return { root, config, registry, runtime, callbacks, adapter, events, calls, parent, release: () => { stopped = true; } };
}
test('桥先交付完成报告并显示收尾；同一 worker 后续排队，退出后只执行一次', async () => {
  const f = runtimeFixture();
  try {
    const first = await f.runtime.invoke(f.parent, 'bridge_start_worker', { title: '独立任务', prompt: '已授权任务' }) as { workerId: string; jobId: string };
    await until(() => f.events.length === 1);
    assert.equal(f.events[0]!.status, 'completed'); assert.equal(f.runtime.store.getJob(first.jobId)!.status, 'completed');
    assert.equal(f.runtime.store.getWorker(first.workerId)!.blocked, false);
    const overview = f.runtime.queryWorkerOverview(f.parent.conversation);
    assert.equal(overview[0]!.status, 'retiring'); assert.match(formatWorkerOverview(overview, 'current'), /本轮完成 · CLI 收尾中/);
    const next = await f.runtime.invoke(f.parent, 'bridge_continue_worker', { workerId: first.workerId, prompt: '明确的新任务' }) as { jobId: string };
    await pause(); assert.equal(f.calls.length, 1); assert.equal(f.runtime.store.getJob(next.jobId)!.status, 'queued');
    f.release(); await until(() => f.events.length === 2);
    assert.equal(f.calls.length, 2); assert.equal(f.runtime.store.getJob(first.jobId)!.status, 'completed');
    assert.equal(f.runtime.store.getJob(first.jobId)!.processStopped, true);
    assert.equal(f.calls[1]!.conversation.nativeId, 'native-runtime');
  } finally { f.release(); await f.runtime.close(); f.registry.close(); }
});
test('桥重启保留完成报告；新适配器的空 interrupt 不构成停止证明，也不重放旧任务', async () => {
  const f = runtimeFixture(); let recovered: ControllerRuntime | undefined;
  try {
    const first = await f.runtime.invoke(f.parent, 'bridge_start_worker', { title: '持久结果', prompt: '已授权任务' }) as { workerId: string; jobId: string };
    await until(() => f.events.length === 1); await f.runtime.close();
    recovered = new ControllerRuntime(f.config, { codex: f.adapter, claude: f.adapter }, f.registry, f.callbacks);
    await recovered.start();
    assert.equal(recovered.store.getJob(first.jobId)!.status, 'completed'); assert.equal(recovered.queryWorkerOverview(f.parent.conversation)[0]!.status, 'retiring');
    const cancel = await recovered.invoke(f.parent, 'bridge_cancel_worker', { workerId: first.workerId }) as { stopped: boolean };
    assert.equal(cancel.stopped, false); assert.equal(f.calls.length, 1); assert.equal(f.events.length, 1);
    f.release(); await until(() => recovered!.store.getJob(first.jobId)!.processStopped === true);
    assert.equal(recovered.store.getJob(first.jobId)!.status, 'completed');
  } finally { f.release(); await recovered?.close(); await f.runtime.close(); f.registry.close(); }
});

test('远端成功报告在收尾期间可传回；原会话仍禁止并发，正常关闭不会强杀', async () => {
  const root = directory(), command = { command: process.execPath, args: [] }; let stopped = false, closed = 0, killed = 0;
  const native: AgentAdapter = { async run() { return { nativeId: 'native-remote', text: '远端成功报告', processStopped: false }; },
    async close() { closed++; if (!stopped) throw new Error('仍在正常收尾'); }, async interrupt() { killed++; stopped = true; }, async confirmStopped() { return stopped; } };
  const daemon = new RemoteDaemon(root, { version: 1, expectedHostname: hostname(), engines: { codex: { agentCommand: command, defaultCwd: root } } }, { adapterFactory: () => native });
  const client: RemoteClient = { async request<T>(method: string, args: unknown) { return await daemon.handle(method, args) as T; }, async close() {} };
  const config: BridgeConfig = { token: '', allowedUserIds: ['owner'], defaultAgent: 'codex', workspace: root, proxyUrl: null, commands: { codex: command, claude: command }, dataDir: join(root, 'bridge-data'), attachmentsDir: root, logsDir: root, maxImageBytes: 100 };
  const adapter = new RemoteAgentAdapter({ id: 'station', label: '电脑', transport: 'ssh', expectedHostname: hostname(), agent: 'codex', cwd: root, agentCommand: command }, config, { clientFactory: () => client, pollMs: 1 });
  try {
    const current = { ...turn(root), dispatchId: 'dispatch-original' };
    const report = await adapter.run(current);
    assert.equal(report.text, '远端成功报告'); assert.equal(report.processStopped, false); assert.equal(closed, 0);
    assert.equal(daemon.store.job(current.dispatchId)!.status, 'completed');
    const request: RemoteDispatch = { dispatchId: 'dispatch-next', workerId: current.conversation.id, userId: 'owner', agent: 'codex', agentCommand: command, nativeId: report.nativeId, cwd: root, text: '下一个任务', imagePaths: [], model: 'fixture', acceptSupplements: true };
    await assert.rejects(daemon.handle('dispatch', request), /收尾/);
    await assert.rejects(daemon.close(), /正常收尾/); assert.equal(killed, 0);
    stopped = true; assert.equal(await adapter.confirmStopped(current.conversation.id), true);
    assert.equal(daemon.store.job(current.dispatchId)!.status, 'completed'); assert.equal(closed, 2);
  } finally { stopped = true; await adapter.close(); await daemon.close(); }
});
test('重启后附件失败的有效报告仍能凭持久化进程退出证明完成显式停止', async () => {
  const root = directory(), command = { command: process.execPath, args: [] };
  const config = { version: 1 as const, expectedHostname: hostname(), engines: { codex: { agentCommand: command, defaultCwd: root } } };
  const daemon = new RemoteDaemon(root, config);
  const request: RemoteDispatch = { dispatchId: 'saved-artifact-failure', workerId: 'saved-worker', userId: 'owner', agent: 'codex', agentCommand: command,
    nativeId: 'saved-native', cwd: root, text: '原授权任务', imagePaths: [], model: 'fixture', acceptSupplements: true };
  daemon.store.create(request);
  daemon.store.update(request.dispatchId, { status: 'failed', result: { nativeId: 'saved-native', text: '报告已完成' }, stopped: false });
  // 已持久化的关闭记录代表退出证明；不向任何进程发信号。
  daemon.store.process({ dispatchId: request.dispatchId, pid: process.pid, identity: null, closed: true });
  try {
    assert.deepEqual(await daemon.handle('interrupt', { dispatchId: request.dispatchId }), { stopped: true });
    assert.equal(daemon.store.job(request.dispatchId)!.status, 'failed');
    assert.equal(daemon.store.job(request.dispatchId)!.result!.text, '报告已完成');
    assert.equal(daemon.store.job(request.dispatchId)!.stopped, true);
  } finally { await daemon.close(); }
});

test('远端历史收尾纠正只由取得监听权的执行器运行，重复启动不改活跃服务记录', async () => {
  const root = directory(), command = { command: process.execPath, args: [] };
  const config = { version: 1 as const, expectedHostname: hostname(), engines: { codex: { agentCommand: command, defaultCwd: root } } };
  const daemon = new RemoteDaemon(root, config);
  const request: RemoteDispatch = { dispatchId: 'legacy-cleanup', workerId: 'legacy-worker', userId: 'owner', agent: 'codex', agentCommand: command,
    nativeId: 'legacy-native', cwd: root, text: '原授权任务', imagePaths: [], model: 'fixture', acceptSupplements: true };
  const put = () => daemon.store.update(request.dispatchId, { status: 'uncertain', stopped: true,
    result: { nativeId: 'legacy-native', text: '业务待验收' }, stopEvidence: evidence(),
    executionError: JSON.stringify({ message: '【桥】CLI 退出待核对。' }) });
  daemon.store.create(request); put();
  try {
    await daemon.listen(); assert.equal(daemon.store.job(request.dispatchId)!.status, 'completed');
    put(); const duplicate = new RemoteDaemon(root, config);
    try {
      assert.equal(daemon.store.job(request.dispatchId)!.status, 'uncertain');
      await assert.rejects(duplicate.listen());
      assert.equal(daemon.store.job(request.dispatchId)!.status, 'uncertain');
    } finally { duplicate.store.close(); }
  } finally { await daemon.close(); }
});

test('旧退出超时只凭成功回执及纯收尾错误恢复；模型错误、取消和证据缺失不恢复', () => {
  const base = { result: { nativeId: 'native', text: '业务仍待验收' }, stopEvidence: evidence(), executionError: JSON.stringify({ name: 'Error', message: '【桥】CLI 退出待核对。' }) };
  assert.equal(completedRetirementFailure(base), true);
  for (const bad of [{ ...base, cancelled: true }, { ...base, stopEvidence: undefined }, { ...base, result: undefined },
    { ...base, executionError: JSON.stringify({ message: '【桥】CLI 退出待核对。', cause: [{ message: 'model at capacity' }] }) }]) assert.equal(completedRetirementFailure(bad), false);
});

test('启动对账仅修正纯收尾误分类；原生业务报告、模型错误和取消历史均保留且不重派', async () => {
  const f = runtimeFixture(), now = new Date().toISOString();
  try {
    for (const [id, cause] of [['old-cleanup', '【桥】CLI 退出待核对。'], ['model-error', 'Selected model is at capacity.']] as const) {
      const origin = { conversationId: 'parent', userId: 'owner', channelId: 'owner-dm', originMessageId: 'owner-message', nativeId: 'parent-native', agent: 'codex' as const, cwd: f.root };
      const report = { nativeId: 'native-' + id, text: '原生轮次已结束，业务验收尚未完成' };
      f.runtime.store.addWorker({ id, origin, agent: 'codex', model: 'fixture', actualModel: 'fixture', effort: null, cwd: f.root, title: id, nativeId: report.nativeId, imagePaths: [], wakeAllowed: true, blocked: true, createdAt: now, updatedAt: now });
      f.runtime.store.addJob({ id: 'job-' + id, workerId: id, origin, prompt: '旧授权任务', imagePaths: [], status: 'uncertain', taskId: null, result: report.text,
        cancelReason: null, nativeResult: report, processStopped: true, stopEvidence: { ...evidence(), exitObserved: true, closeObserved: true, completion: 'graceful-exit' },
        executionError: JSON.stringify({ message: '【桥】CLI 退出待核对。', cause: [{ message: cause }] }), createdAt: now, updatedAt: now });
    }
    await f.runtime.start();
    assert.equal(f.runtime.store.getJob('job-old-cleanup')!.status, 'completed');
    assert.equal(f.runtime.store.getWorker('old-cleanup')!.blocked, false);
    assert.equal(f.runtime.store.getJob('job-old-cleanup')!.result, '原生轮次已结束，业务验收尚未完成');
    assert.equal(f.runtime.store.getJob('job-model-error')!.status, 'uncertain');
    assert.equal(f.runtime.store.getWorker('model-error')!.blocked, true);
    assert.equal(f.calls.length, 0); assert.equal(f.events.length, 0);
  } finally { await f.runtime.close(); f.registry.close(); }
});

const slowCli = String.raw`
const fs=require('node:fs'),path=require('node:path'),readline=require('node:readline');
const root=process.cwd(),codex=process.argv.includes('app-server');let eof=false;
fs.writeFileSync(path.join(root,'native-pid.json'),JSON.stringify({pid:process.pid}));
const send=x=>process.stdout.write(JSON.stringify(x)+'\n');
const input=readline.createInterface({input:process.stdin});
input.on('line',line=>{const m=JSON.parse(line);
 if(m.method==='initialize')send({id:m.id,result:{}});
 if(m.method==='config/read')send({id:m.id,result:{config:{model_provider:'fixture'}}});
 if(m.method==='thread/start')send({id:m.id,result:{thread:{id:'native-fixture'},modelProvider:'fixture'}});
 if(m.method==='turn/start'){
  send({id:m.id,result:{turn:{id:'turn-fixture'}}});
  send({method:'turn/completed',params:{threadId:'native-fixture',turn:{id:'turn-fixture',status:'completed',items:[{type:'agentMessage',id:'final',phase:'final_answer',text:'真实回执已完成'}]}}});
 }
 if(m.type==='user'){send({type:'system',subtype:'init',session_id:'native-fixture'});send({type:'result',subtype:'success',session_id:'native-fixture',result:'真实回执已完成'});}
});
input.on('close',()=>{eof=true;});
setInterval(()=>{if(eof&&fs.existsSync(path.join(root,'allow-exit')))process.exit(0);},10);
setTimeout(()=>process.exit(1),15000).unref();
`;
for (const backend of ['codex', 'claude'] as const) test(`${backend} 真实 stdio 回执先交付，CLI 延迟退出不会误报失败或被强杀`, async () => {
  const root = directory(), script = join(root, 'native.cjs'); writeFileSync(script, slowCli);
  const command = { command: process.execPath, args: [script] };
  const adapter = backend === 'codex' ? new CodexAdapter(command, {}) : new ClaudeAdapter(command, {});
  try {
    const result = await adapter.run(turn(root, backend));
    const pid = (JSON.parse(readFileSync(join(root, 'native-pid.json'), 'utf8')) as { pid: number }).pid;
    assert.equal(result.text, '真实回执已完成'); assert.equal(result.processStopped, false); process.kill(pid, 0);
    assert.equal(await adapter.confirmStopped('worker-fixture'), false);
    assert.equal(result.stopEvidence!.taskkillAttempted, false);
    writeFileSync(join(root, 'allow-exit'), '1');
    let stopped = false; const deadline = Date.now() + 3000;
    while (!stopped) { assert(Date.now() < deadline); stopped = await adapter.confirmStopped('worker-fixture'); await pause(); }
    assert.throws(() => process.kill(pid, 0)); assert.equal(result.text, '真实回执已完成'); assert.equal(result.processStopped, true);
  } finally { writeFileSync(join(root, 'allow-exit'), '1'); await adapter.close(); }
});
