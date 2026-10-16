import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ControllerRuntime } from '../src/controller/runtime.js';
import { ControllerStore } from '../src/controller/store.js';
import { SessionHandoffs } from '../src/controller/handoff.js';
import { TaskRegistry, type TaskCompletionEvent, type TaskContextFile } from '../src/tasks.js';
import type { AgentAdapter, AgentResult, AgentTurn, AgentSupplement, SteerResult, BridgeConfig, Conversation } from '../src/types.js';

class SwitchAdapter implements AgentAdapter {
  turns: AgentTurn[] = []; interrupts: string[] = [];
  pending = new Map<string, { resolve: (result: AgentResult) => void; reject: (error: Error) => void }>();
  steer?: (id: string, input: AgentSupplement) => Promise<SteerResult>;
  mode: 'worker' | 'summary' | 'invalid' | 'failed' = 'worker';
  async getModelInfo() { return { defaultModel: 'backend-default', models: [{ id: 'backend-default', displayName: 'Default' }, { id: 'target-model', displayName: 'Target' }] }; }
  async run(turn: AgentTurn): Promise<AgentResult> {
    this.turns.push(turn); turn.onNativeId?.(`native-${turn.conversation.id}`); turn.onReady?.();
    if (this.mode === 'failed') throw new Error('目标网关离线');
    if (this.mode === 'summary') return { nativeId: 'summary-native-must-not-be-controller', text: JSON.stringify({ workspaceContext: '固定工作区约定', continuation: '继续最新目标；保留原任务与定时。' }) };
    if (this.mode === 'invalid') return { nativeId: 'summary-invalid', text: 'DONE' };
    return new Promise((resolve, reject) => this.pending.set(turn.conversation.id, { resolve, reject }));
  }
  finish(id: string, text = '已核实'): void { const item = this.pending.get(id); assert(item); this.pending.delete(id); item.resolve({ nativeId: `native-${id}`, text }); }
  async interrupt(id: string): Promise<void> { this.interrupts.push(id); const item = this.pending.get(id); this.pending.delete(id); item?.reject(new Error('进程已结束')); }
  async close(): Promise<void> {}
}
const flush = async () => { await new Promise<void>(resolve => setImmediate(resolve)); };

function setup(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'bridge-controller-switch-'));
  const contextWorkspace = join(root, 'context'), work = join(root, 'engineering'); mkdirSync(contextWorkspace); mkdirSync(work);
  const registry = new TaskRegistry(root), codex = new SwitchAdapter(), claude = new SwitchAdapter();
  const config: BridgeConfig = { token: 'fake', allowedUserIds: ['owner'], defaultAgent: 'codex', workspace: root, contextWorkspace,
    proxyUrl: null, commands: { codex: { command: 'fake', args: [] }, claude: { command: 'fake', args: [] } },
    dataDir: root, logsDir: root, attachmentsDir: root, maxImageBytes: 100, defaultModels: { claude: 'target-model' } };
  const source: Conversation = { id: 'source-parent', userId: 'owner', agent: 'codex', nativeId: 'source-native', cwd: work,
    model: 'source-only-model', title: '主控', createdAt: '2026-10-01', updatedAt: '2026-10-01' };
  const target: Conversation = { ...source, id: 'target-parent', agent: 'claude', nativeId: null, model: null };
  const created = registry.createContext({ conversationId: source.id, userId: source.userId, channelId: 'dm-original', originMessageId: 'original-input',
    nativeId: source.nativeId, agent: source.agent, cwd: source.cwd });
  const turn: AgentTurn = { conversation: source, text: '目标', imagePaths: [], taskContextPath: created.contextPath, signal: new AbortController().signal, onProgress: () => {} };
  const events: TaskCompletionEvent[] = []; let now = Date.parse('2026-10-01T00:00:00Z');
  const runtime = new ControllerRuntime(config, { codex, claude }, registry, { onCompletion: event => { events.push(event); }, pollIntervalMs: 60_000, now: () => now });
  t.after(async () => { await runtime.close(); registry.close(); });
  return { root, contextWorkspace, registry, runtime, source, target, turn, codex, claude, events, config, advance: (ms: number) => { now += ms; } };
}
const launch = (runtime: ControllerRuntime, turn: AgentTurn) => runtime.invoke(turn, 'bridge_start_worker', { title: '普通调查', prompt: '执行已授权目标', model: 'backend-default' }) as Promise<{ workerId: string; jobId: string }>;

test('Agent切换只读摘要使用目标后端模型与独立上下文目录，独立native不会冒充主控', async t => {
  const f = setup(t); f.claude.mode = 'summary';
  const handoffs = new SessionHandoffs(f.root);
  handoffs.prepare(f.source, f.target, 'dm-original', [{ role: 'user', text: '最新目标', at: '2026-10-01' }], [], 'agent-switch');
  const before = structuredClone(f.source);
  const result = await f.runtime.prepareAgentSwitch(f.source, f.target, 'dm-original', '切换并继续', new AbortController().signal);
  assert.match(result.contextSeed, /继续最新目标/); assert.match(result.contextSeed, /普通助手与定时计划保持原样/);
  assert.equal(f.codex.turns.length, 0); assert.equal(f.claude.turns.length, 1);
  const summary = f.claude.turns[0]!;
  assert.equal(summary.conversation.model, 'target-model'); assert.equal(summary.conversation.cwd, f.contextWorkspace);
  assert.notEqual(summary.conversation.id, f.target.id); assert.equal(summary.conversation.nativeId, null);
  assert.equal(summary.taskContextPath, undefined); assert.equal(summary.onPublicMessage, undefined);
  assert.equal(f.target.nativeId, null); assert.deepEqual(f.source, before);
  assert.equal(f.runtime.store.isConversationPaused(f.source.id), true);
  assert.deepEqual(await f.runtime.prepareAgentSwitch(f.source, f.target, 'dm-original', '切换并继续', new AbortController().signal), result);
  assert.equal(f.claude.turns.length, 1, '缓存已校验摘要不重复调用网关');
  f.runtime.resumeConversation(f.source.id);
});

for (const mode of ['failed', 'invalid'] as const) test(`摘要${mode}不改变旧主控或停止普通助手，并恢复计划入口`, async t => {
  const f = setup(t); f.claude.mode = mode;
  const ordinary = await launch(f.runtime, f.turn); await flush();
  new SessionHandoffs(f.root).prepare(f.source, f.target, 'dm-original', [], [], 'agent-switch');
  await assert.rejects(f.runtime.prepareAgentSwitch(f.source, f.target, 'dm-original', '切换', new AbortController().signal));
  assert.equal(f.runtime.store.isConversationPaused(f.source.id), false);
  assert.equal(f.source.nativeId, 'source-native'); assert.equal(f.source.agent, 'codex');
  assert.equal(f.runtime.store.getWorker(ordinary.workerId)!.origin.conversationId, f.source.id);
  assert.equal(f.runtime.isWorkerStopped(ordinary.workerId), false); assert.deepEqual(f.codex.interrupts, []);
  f.codex.finish(ordinary.workerId); await flush(); await flush(); assert.equal(f.runtime.isWorkerStopped(ordinary.workerId), true);
});

test('取消摘要等待目标CLI退出，旧模型不被复用，缺失快照与未知owner均不提交', async t => {
  const f = setup(t); const signal = new AbortController();
  await assert.rejects(f.runtime.prepareAgentSwitch(f.source, f.target, 'dm-original', '切换', signal.signal), /冻结/);
  new SessionHandoffs(f.root).prepare(f.source, f.target, 'dm-original', [], [], 'agent-switch');
  const preparing = f.runtime.prepareAgentSwitch(f.source, f.target, 'dm-original', '切换', signal.signal);
  await flush(); assert.equal(f.claude.pending.size, 1);
  signal.abort(); await assert.rejects(preparing);
  assert.equal(f.claude.pending.size, 0); assert.equal(f.claude.interrupts.length, 1);
  assert.equal(f.runtime.store.isConversationPaused(f.source.id), false); assert.equal(f.target.nativeId, null);
});

test('切换暂停持久阻挡两类到期计划，普通助手继续；重绑后原渠道与冻结群来源保持', async t => {
  const f = setup(t);
  f.turn.groupContext = { eventId: 'event-original', rootId: 'root-original', botId: 'bot-original', spaceId: 'space-original', generation: 4,
    bindingEpoch: 2, originChannelId: 'group-original', principalId: 'principal-original', scene: '真实群现场' };
  const worker = await launch(f.runtime, f.turn); await flush();
  await f.runtime.invoke(f.turn, 'bridge_continue_worker', { workerId: worker.workerId, prompt: '排队第二轮', delivery: 'next' });
  const schedule = await f.runtime.invoke(f.turn, 'bridge_schedule_worker', { title: '定时检查', prompt: '原检查', afterSeconds: 1, model: 'backend-default' }) as { scheduleId: string };
  const wake = await f.runtime.invoke(f.turn, 'bridge_schedule_controller', { text: '原计划', afterSeconds: 1 }) as { scheduleId: string };
  await f.runtime.pauseConversation(f.source.id); f.advance(2000); await f.runtime.poll();
  assert.equal(f.runtime.store.getSchedule(schedule.scheduleId)!.status, 'pending'); assert.equal(f.runtime.store.getSchedule(wake.scheduleId)!.status, 'pending');
  assert.equal(f.codex.turns.length, 1); assert.equal(f.runtime.isWorkerStopped(worker.workerId), false);
  const target = { ...f.target, nativeId: 'target-native' };
  const originalGroup = structuredClone(f.turn.groupContext);
  await f.runtime.rebindConversation(f.source, target); await f.runtime.rebindConversation(f.source, target);
  assert.equal(f.runtime.store.workers(f.source.id).length, 0); assert.equal(f.runtime.store.workers(target.id).length, 1);
  assert.equal(f.runtime.store.isConversationPaused(target.id), true, '提交主控之前新父计划仍需冻结');
  const rebound = f.runtime.store.getWorker(worker.workerId)!;
  assert.equal(rebound.agent, 'codex', '执行助手后端不随父主控改变');
  assert.equal(rebound.origin.agent, 'claude'); assert.equal(rebound.origin.nativeId, 'target-native');
  assert.equal(rebound.origin.cwd, f.source.cwd); assert.equal(rebound.origin.channelId, 'dm-original');
  assert.deepEqual(rebound.origin.groupContext, originalGroup);
  assert.deepEqual(rebound.origin.reboundFrom, [{ conversationId: f.source.id, agent: 'codex', nativeId: 'source-native' }]);
  assert.equal(f.runtime.store.getSchedule(schedule.scheduleId)!.worker!.origin.conversationId, target.id);
  assert.equal(f.runtime.store.getSchedule(schedule.scheduleId)!.job!.origin.conversationId, target.id);
  const originalContext = JSON.parse(readFileSync(f.turn.taskContextPath!, 'utf8')) as TaskContextFile;
  assert.equal(f.registry.getContextOrigin(originalContext).conversationId, target.id);
  f.codex.finish(worker.workerId); await flush(); await flush();
  assert.equal(f.events[0]!.conversationId, target.id); assert.equal(f.events[0]!.channelId, 'dm-original'); assert.deepEqual(f.events[0]!.groupContext, originalGroup);
  assert.equal(f.codex.turns.length, 2, '普通已授权助手队列继续工作，不受计划冻结影响');
  f.codex.finish(worker.workerId); await flush(); await flush();
  f.runtime.resumeConversation(f.source.id); f.runtime.resumeConversation(target.id); await f.runtime.poll(); await flush();
  assert.equal(f.runtime.store.getSchedule(schedule.scheduleId)!.status, 'running'); assert.equal(f.runtime.store.getSchedule(wake.scheduleId)!.status, 'triggered');
  const scheduledWorker = f.runtime.store.getSchedule(schedule.scheduleId)!.worker!;
  f.codex.finish(scheduledWorker.id); await flush(); await flush();
  await assert.rejects(f.runtime.rebindConversation(f.source, { ...target, id: 'conflicting-target' }), /其他目标/);
});

test('跨库提交中断可重入修复TaskRegistry，历史事件和进度重绑但签名票据不变', async t => {
  const f = setup(t); const worker = await launch(f.runtime, f.turn); await flush();
  const job = f.runtime.store.getJob(worker.jobId)!; assert(job.taskId);
  f.registry.observeTask(job.taskId, 'progress', '进行中');
  const ticketPath = f.registry.getTask(job.taskId)!.ticketPath, ticket = readFileSync(ticketPath, 'utf8');
  const target = { ...f.target, nativeId: 'target-native' };
  f.runtime.store.rebindConversation(f.source, target); // Simulate exit between the two SQLite commits.
  assert.equal(f.registry.getTask(job.taskId)!.conversationId, f.source.id);
  await f.runtime.rebindConversation(f.source, target);
  assert.equal(f.registry.getTask(job.taskId)!.conversationId, target.id);
  assert.equal(f.registry.queuedEvents()[0]!.conversationId, target.id); assert.equal(readFileSync(ticketPath, 'utf8'), ticket);
  assert.equal(f.registry.activeCount(f.source.id), 0); assert.equal(f.registry.activeCount(target.id), 1);
  f.codex.finish(worker.workerId); await flush(); await flush();
});

test('程序静止证明拒绝未知、运行、排队和uncertain，不能凭结果正文自报停止', async t => {
  const f = setup(t); assert.equal(f.runtime.isWorkerStopped('unknown'), false);
  const worker = await launch(f.runtime, f.turn); await flush();
  assert.equal(f.runtime.isWorkerStopped(worker.workerId), false);
  f.codex.finish(worker.workerId, '我已经停止了'); await flush(); await flush();
  assert.equal(f.runtime.isWorkerStopped(worker.workerId), true);
  f.runtime.store.setJob(worker.jobId, 'uncertain'); assert.equal(f.runtime.isWorkerStopped(worker.workerId), false);
});

test('工作区初始化和执行目标登记读contextWorkspace，工程执行cwd保留父会话目录', async t => {
  const f = setup(t); const lookups: string[] = [];
  const runtime = new ControllerRuntime(f.config, { codex: f.codex, claude: f.claude }, f.registry, {
    targetCatalog: {
      async listTargets(workspace) { lookups.push(workspace); return []; },
      async resolveTarget(workspace, id, agent, cwd) { lookups.push(workspace); return { id, label: id, transport: 'local', agent, agentCommand: f.config.commands[agent], cwd: cwd ?? f.source.cwd }; },
      adapterFor: binding => binding.agent === 'codex' ? f.codex : f.claude,
      async handoff() { throw new Error('unused'); },
    }, pollIntervalMs: 60_000,
  });
  t.after(() => runtime.close());
  const initialized = await runtime.initializeWorkspace(f.turn) as { workerId: string }; await flush();
  assert.equal(f.codex.turns[0]!.conversation.cwd, f.contextWorkspace);
  f.codex.finish(initialized.workerId, '工作区规则'); await flush(); await flush();
  const engineering = await launch(runtime, f.turn); await flush();
  assert.equal(f.codex.turns[1]!.conversation.cwd, f.source.cwd); assert(lookups.every(path => path === f.contextWorkspace));
  f.codex.finish(engineering.workerId); await flush(); await flush();
});


test('原生补充确认晚于父会话重绑时，不把内存旧origin覆盖回存储', async t => {
  const f = setup(t); let confirm!: (result: SteerResult) => void;
  f.codex.steer = async () => new Promise(resolve => { confirm = resolve; });
  const worker = await launch(f.runtime, f.turn); await flush();
  await f.runtime.invoke(f.turn, 'bridge_continue_worker', { workerId: worker.workerId, prompt: '当前轮补充' }); await flush();
  assert.equal(f.runtime.store.supplements(worker.jobId)[0]!.status, 'steering');
  await f.runtime.rebindConversation(f.source, { ...f.target, nativeId: 'target-native' });
  confirm({ status: 'accepted' }); await flush(); await flush();
  const receipt = f.runtime.store.supplements(worker.jobId)[0]!;
  assert.equal(receipt.status, 'accepted'); assert.equal(receipt.origin.conversationId, f.target.id); assert.equal(receipt.origin.reboundFrom?.length, 1);
  f.codex.finish(worker.workerId); await flush(); await flush();
  assert.equal(f.events[0]!.conversationId, f.target.id);
});

test('Agent切换准备期间重启不会放行过期计划，明确resume后只执行一次', async t => {
  const f = setup(t);
  const plan = await f.runtime.invoke(f.turn, 'bridge_schedule_worker', { title: '延后检查', prompt: '只检查一次', afterSeconds: 1, model: 'backend-default' }) as { scheduleId: string };
  await f.runtime.pauseConversation(f.source.id); await f.runtime.close(); f.advance(2000);
  const recovered = new ControllerRuntime(f.config, { codex: f.codex, claude: f.claude }, f.registry, { pollIntervalMs: 60_000, now: () => Date.parse('2026-10-01T00:00:02Z') });
  t.after(() => recovered.close()); await recovered.start();
  assert.equal(f.codex.turns.length, 0); assert.equal(recovered.store.getSchedule(plan.scheduleId)!.status, 'pending');
  recovered.resumeConversation(f.source.id); await recovered.poll(); await flush();
  assert.equal(f.codex.turns.length, 1); const worker = recovered.store.getSchedule(plan.scheduleId)!.worker!;
  f.codex.finish(worker.id); await flush(); await flush(); await recovered.poll(); assert.equal(f.codex.turns.length, 1);
});


test('未触发的定时助手计为未停止，取消后没有CLI或排队任务时可给出程序停止证明', async t => {
  const f = setup(t);
  const plan = await f.runtime.invoke(f.turn, 'bridge_schedule_worker', { title: '未来检查', prompt: '尚未执行', afterSeconds: 100, model: 'backend-default' }) as { scheduleId: string; workerId: string };
  assert.equal(f.runtime.store.getWorker(plan.workerId), null); assert.equal(f.runtime.isWorkerStopped(plan.workerId), false);
  await f.runtime.invoke(f.turn, 'bridge_cancel_schedule', { scheduleId: plan.scheduleId });
  assert.equal(f.runtime.isWorkerStopped(plan.workerId), true); assert.equal(f.codex.turns.length, 0);
});
