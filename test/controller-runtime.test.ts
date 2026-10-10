import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { ControllerRuntime } from '../src/controller/runtime.js';
import { ControllerStore } from '../src/controller/store.js';
import { TaskRegistry, type TaskCompletionEvent, type TaskContextFile } from '../src/tasks.js';
import type { AgentAdapter, AgentResult, AgentTurn, AgentSupplement, SteerResult, BridgeConfig } from '../src/types.js';

class FakeAdapter implements AgentAdapter {
  turns: AgentTurn[] = [];
  interrupts: string[] = [];
  pending = new Map<string, { resolve: (value: AgentResult) => void; reject: (error: Error) => void }>();
  automaticClose = true;
  steer?: (workerId: string, supplement: AgentSupplement) => Promise<SteerResult>;
  ready = true;
  async run(turn: AgentTurn): Promise<AgentResult> {
    this.turns.push(turn);
    turn.onNativeId?.(turn.conversation.nativeId ?? `native-${turn.conversation.id}`);
    if (this.ready) turn.onReady?.();
    return new Promise((resolve, reject) => { this.pending.set(turn.conversation.id, { resolve, reject }); });
  }
  finish(workerId: string, text = 'done'): void {
    const pending = this.pending.get(workerId); assert.ok(pending, 'worker is executing');
    this.pending.delete(workerId); pending.resolve({ nativeId: `native-${workerId}`, text });
  }
  terminate(workerId: string): void {
    const pending = this.pending.get(workerId); if (!pending) return;
    this.pending.delete(workerId); pending.reject(new Error('process closed'));
  }
  async interrupt(workerId: string): Promise<void> {
    this.interrupts.push(workerId);
    if (this.automaticClose) this.terminate(workerId);
  }
  async close(): Promise<void> {}
}
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-controller-test-'));
  const registry = new TaskRegistry(dir);
  const codex = new FakeAdapter(); const claude = new FakeAdapter();
  const config: BridgeConfig = { token: 'test', allowedUserIds: ['user-A'], defaultAgent: 'codex', workspace: dir,
    proxyUrl: null, commands: { codex: { command: 'codex', args: [] }, claude: { command: 'claude', args: [] } },
    dataDir: dir, attachmentsDir: dir, logsDir: dir, maxImageBytes: 100, defaultModels: { claude: 'haiku' } };
  const created = registry.createContext({ conversationId: 'parent-A', userId: 'user-A', channelId: 'dm-A', originMessageId: 'message-A',
    nativeId: 'native-parent', agent: 'codex', cwd: dir });
  const turn: AgentTurn = { conversation: { id: 'parent-A', userId: 'user-A', agent: 'codex', nativeId: 'native-parent', model: 'gpt-6.1-sol',
    actualEffort: 'medium', title: 'parent', cwd: dir, createdAt: '2026-01-01', updatedAt: '2026-01-01' }, text: 'parent', imagePaths: [],
    taskContextPath: created.contextPath, signal: new AbortController().signal, onProgress: () => {} };
  const counts: number[] = []; const events: TaskCompletionEvent[] = []; const errors: unknown[] = [];
  let now = Date.parse('2026-10-09T10:00:00Z');
  const callbacks = { now: () => now, onCountChanged: (_id: string, count: number) => { counts.push(count); },
    onCompletion: (event: TaskCompletionEvent) => { events.push(event); }, onError: (error: unknown) => { errors.push(error); }, pollIntervalMs: 60000 };
  const runtime = new ControllerRuntime(config, { codex, claude }, registry, callbacks);
  return { dir, registry, codex, claude, config, callbacks, turn, counts, events, errors, runtime, advance: (ms: number) => { now += ms; } };
}
async function flush(): Promise<void> { await new Promise<void>(resolve => setImmediate(resolve)); }
type Handle = { workerId: string; jobId: string; status: string };
async function launch(runtime: ControllerRuntime, turn: AgentTurn, args: Record<string, unknown> = {}, callId?: string): Promise<Handle> {
  return await runtime.invoke(turn, 'bridge_start_worker', { title: '温度调查', prompt: '检查温度', ...args }, callId) as Handle;
}


test('busy continue sends current input once, persists receipt and retains original job/count/result origin', async () => {
  const f = fixture(); const received: AgentSupplement[] = [];
  f.codex.steer = async (_id, value) => { received.push(value); return { status: 'accepted' }; };
  try {
    const a = await launch(f.runtime, f.turn); await flush();
    const input = { workerId: a.workerId, prompt: '改为检查内存' };
    const first = await f.runtime.invoke(f.turn, 'bridge_continue_worker', input, 'current-1') as Handle & { supplementId: string; delivered: boolean; delivery: string };
    assert.equal(first.jobId, a.jobId); assert.equal(first.delivery, 'current');
    assert.equal(first.delivered, false); await flush();
    const receipt = await f.runtime.invoke(f.turn, 'bridge_continue_worker', input, 'current-1') as { status: string; delivered: boolean };
    assert.equal(receipt.status, 'accepted'); assert.equal(receipt.delivered, true); assert.equal(received.length, 1);
    assert.equal(received[0]!.input[0]!.type, 'text'); assert.equal(f.runtime.store.jobs().length, 1);
    assert.equal(f.codex.turns.length, 1); assert.equal(f.registry.activeCount('parent-A'), 1);
    f.codex.finish(a.workerId, '内存已检查'); await flush();
    assert.equal(f.events.length, 1); assert.match(f.events[0]!.text, /accepted/); assert.equal(f.events[0]!.originMessageId, 'message-A');
    assert.equal(f.codex.turns.length, 1); assert.equal(f.runtime.store.supplements(a.jobId)[0]!.status, 'accepted');
  } finally { await f.runtime.close(); f.registry.close(); }
});

test('busy preparation stores pending input until native readiness; cancellation never sends it', async () => {
  const f = fixture(); f.codex.ready = false; let sent = 0;
  f.codex.steer = async () => { sent++; return { status: 'accepted' }; };
  try {
    const a = await launch(f.runtime, f.turn); await flush();
    await f.runtime.invoke(f.turn, 'bridge_continue_worker', { workerId: a.workerId, prompt: '补充1' }); await flush();
    assert.equal(sent, 0); f.codex.turns[0]!.onReady?.(); await flush(); assert.equal(sent, 1);
    f.codex.finish(a.workerId); await flush();
    const b = await launch(f.runtime, f.turn); await flush();
    await f.runtime.invoke(f.turn, 'bridge_continue_worker', { workerId: b.workerId, prompt: '不要发' });
    await f.runtime.invoke(f.turn, 'bridge_cancel_worker', { workerId: b.workerId });
    assert.equal(sent, 1); assert.equal(f.runtime.store.supplements(b.jobId)[0]!.status, 'cancelled');
  } finally { await f.runtime.close(); f.registry.close(); }
});

test('unsupported busy backend reports undelivered; explicit next remains serial and idle resume works', async () => {
  const f = fixture();
  try {
    const a = await launch(f.runtime, f.turn, { agent: 'claude' }); await flush();
    const result = await f.runtime.invoke(f.turn, 'bridge_continue_worker', { workerId: a.workerId, prompt: '当前补充' }) as { status: string; delivered: boolean; queueAvailable: boolean };
    assert.equal(result.status, 'unsupported'); assert.equal(result.delivered, false); assert.equal(result.queueAvailable, true);
    assert.equal(f.runtime.store.jobs().length, 1);
    await f.runtime.invoke(f.turn, 'bridge_continue_worker', { workerId: a.workerId, prompt: '下一轮做', delivery: 'next' });
    assert.equal(f.runtime.store.jobs().length, 2); assert.equal(f.claude.turns.length, 1);
    f.claude.finish(a.workerId); await flush(); assert.equal(f.claude.turns.length, 2);
    assert.equal(f.claude.turns[1]!.conversation.nativeId, `native-${a.workerId}`); f.claude.finish(a.workerId); await flush();
    await f.runtime.invoke(f.turn, 'bridge_continue_worker', { workerId: a.workerId, prompt: '空闲继续' }); await flush();
    assert.equal(f.claude.turns.length, 3); f.claude.finish(a.workerId); await flush();
    await assert.rejects(f.runtime.invoke(f.turn, 'bridge_continue_worker', { workerId: a.workerId, prompt: '非法', delivery: 'invented' }), /delivery/);
  } finally { await f.runtime.close(); f.registry.close(); }
});

test('completion waits for in-flight receipt; accepted input is never replayed as a queued job', async () => {
  const f = fixture(); let confirm!: (value: SteerResult) => void;
  f.codex.steer = () => new Promise(resolve => { confirm = resolve; });
  try {
    const a = await launch(f.runtime, f.turn); await flush();
    await f.runtime.invoke(f.turn, 'bridge_continue_worker', { workerId: a.workerId, prompt: '在途补充' }); await flush();
    f.codex.finish(a.workerId); await flush(); assert.equal(f.events.length, 0);
    const late = await f.runtime.invoke(f.turn, 'bridge_continue_worker', { workerId: a.workerId, prompt: '轮次已结束' }) as { status: string };
    assert.equal(late.status, 'not_delivered'); confirm({ status: 'accepted' }); await flush();
    assert.equal(f.events.length, 1); assert.equal(f.runtime.store.jobs().length, 1); assert.equal(f.codex.turns.length, 1);
    assert.deepEqual(f.runtime.store.supplements(a.jobId).map(value => value.status), ['accepted', 'not_delivered']);
  } finally { await f.runtime.close(); f.registry.close(); }
});

for (const outcome of ['queued', 'unsupported', 'uncertain'] as const) test(`current input ${outcome} never auto-queues or retries`, async () => {
  const f = fixture(); let sent = 0;
  f.codex.steer = async () => { sent++; return outcome === 'uncertain' ? { status: 'uncertain', reason: '响应丢失' }
    : { status: 'queued', ...(outcome === 'unsupported' ? { unsupported: true } : {}) }; };
  try {
    const a = await launch(f.runtime, f.turn); await flush();
    const input = { workerId: a.workerId, prompt: '只发一次' };
    await f.runtime.invoke(f.turn, 'bridge_continue_worker', input, 'uncertain-once'); await flush();
    const response = await f.runtime.invoke(f.turn, 'bridge_continue_worker', input, 'uncertain-once') as { status: string; delivered: boolean };
    assert.equal(response.status, outcome === 'queued' ? 'not_delivered' : outcome); assert.equal(response.delivered, false);
    f.codex.finish(a.workerId); await flush(); assert.equal(sent, 1); assert.equal(f.runtime.store.jobs().length, 1);
  } finally { await f.runtime.close(); f.registry.close(); }
});

test('cancel during an in-flight confirmation stops original work without replaying the supplement', async () => {
  const f = fixture(); let confirm!: (value: SteerResult) => void;
  f.codex.steer = () => new Promise(resolve => { confirm = resolve; });
  try {
    const a = await launch(f.runtime, f.turn); await flush();
    await f.runtime.invoke(f.turn, 'bridge_continue_worker', { workerId: a.workerId, prompt: '取消竞态' }); await flush();
    const cancellation = f.runtime.invoke(f.turn, 'bridge_cancel_worker', { workerId: a.workerId }); await flush();
    confirm({ status: 'uncertain', reason: '取消前投递未确认' });
    await cancellation; assert.equal(f.runtime.store.getJob(a.jobId)!.status, 'cancelled');
    assert.equal(f.runtime.store.supplements(a.jobId)[0]!.status, 'uncertain'); assert.equal(f.runtime.store.jobs().length, 1);
  } finally { await f.runtime.close(); f.registry.close(); }
});

test('restart preserves accepted receipts and marks interrupted in-flight input uncertain without replay', async () => {
  const f = fixture();
  try {
    const a = await launch(f.runtime, f.turn); await flush(); f.codex.finish(a.workerId); await flush();
    const timestamp = new Date().toISOString();
    for (const status of ['accepted', 'steering', 'pending'] as const) f.runtime.store.saveSupplement({ id: status, workerId: a.workerId,
      jobId: a.jobId, origin: f.runtime.store.getJob(a.jobId)!.origin, prompt: '不重放', imagePaths: [], status, createdAt: timestamp, updatedAt: timestamp });
    await f.runtime.close();
    const next = new ControllerRuntime(f.config, { codex: f.codex, claude: f.claude }, f.registry, f.callbacks);
    try { await next.start(); assert.deepEqual(next.store.supplements(a.jobId).map(value => value.status), ['accepted', 'uncertain', 'not_delivered']);
      assert.equal(f.codex.turns.length, 1); } finally { await next.close(); }
  } finally { f.registry.close(); }
});

test('workspace initialization uses one durable child with the parent backend/model/effort and ordinary counts/receipts', async () => {
  const f = fixture(); f.turn.imagePaths = [join(f.dir, 'unrelated-user-picture.png')]; f.turn.text = 'USER_TASK_MUST_NOT_BE_EXECUTED'; f.turn.effort = 'high';
  try {
    const [first, duplicate] = await Promise.all([f.runtime.initializeWorkspace(f.turn), f.runtime.initializeWorkspace(f.turn)]) as Handle[];
    assert.deepEqual(duplicate, first); await flush();
    assert.equal(f.runtime.store.workers().length, 1); assert.equal(f.runtime.store.jobs().length, 1); assert.equal(f.codex.turns.length, 1);
    const worker = f.runtime.store.getWorker(first!.workerId)!; const job = f.runtime.store.getJob(first!.jobId)!;
    assert.equal(worker.origin.purpose, 'workspace-context'); assert.equal(job.origin.conversationId, 'parent-A');
    assert.equal(job.origin.nativeId, 'native-parent'); assert.equal(job.origin.channelId, 'dm-A');
    const child = f.codex.turns[0]!;
    assert.equal(child.conversation.model, 'gpt-6.1-sol'); assert.equal(child.effort, 'high'); assert.deepEqual(child.imagePaths, []);
    assert.match(child.text, /AGENTS\.md、README\.md/); assert.match(child.text, /遵循其中定义的初始化入口、只读范围和回传要求/);
    assert.match(child.text, /不要扫描未指定的目录或技能目录/); assert.match(child.text, /不连接远程电脑/);
    assert(!child.text.includes('用户职责和偏好、当前电脑用途'));
    assert.match(child.text, /不自行登记桥后台任务、发 Discord 消息/); assert(!child.text.includes('USER_TASK_MUST_NOT_BE_EXECUTED'));
    assert.equal(child.taskContextPath, undefined); assert.equal(child.onPublicMessage, undefined); assert.equal(f.registry.activeCount('parent-A'), 1);
    f.codex.finish(first!.workerId, '主机和导航已阅读；Chrome 登录状态仅依据 README 声明。'); await flush();
    assert.equal(f.registry.activeCount('parent-A'), 0); assert.equal(f.events.length, 1); assert.equal(f.events[0]!.purpose, 'workspace-context');
    assert.equal(f.events[0]!.displayText, '主机和导航已阅读；Chrome 登录状态仅依据 README 声明。'); assert.deepEqual(f.errors, []);
  } finally { await f.runtime.close(); f.registry.close(); }
});

test('completed workspace initialization survives restart and later model/effort changes without rereading', async () => {
  const f = fixture(); let second: ControllerRuntime | undefined;
  try {
    const first = await f.runtime.initializeWorkspace(f.turn) as Handle; await flush(); f.codex.finish(first.workerId, '已整理工作区'); await flush();
    await f.runtime.close(); f.turn.conversation.model = 'another-model'; f.turn.effort = 'low';
    const adapter = new FakeAdapter(); second = new ControllerRuntime(f.config, { codex: adapter, claude: new FakeAdapter() }, f.registry, f.callbacks);
    assert.deepEqual(await second.initializeWorkspace(f.turn), first); await flush();
    assert.equal(adapter.turns.length, 0); assert.equal(second.store.workers().length, 1); assert.equal(second.store.getJob(first.jobId)?.status, 'completed');
    assert.equal(f.events.length, 1); assert.equal(f.registry.activeCount('parent-A'), 0);
  } finally { await second?.close(); await f.runtime.close(); f.registry.close(); }
});

test('unknown workspace initialization remains uncertain after restart instead of starting another child', async () => {
  const f = fixture(); let second: ControllerRuntime | undefined;
  try {
    const first = await f.runtime.initializeWorkspace(f.turn) as Handle; await flush(); await f.runtime.close();
    const adapter = new FakeAdapter(); second = new ControllerRuntime(f.config, { codex: adapter, claude: new FakeAdapter() }, f.registry, f.callbacks);
    await second.start(); assert.deepEqual(await second.initializeWorkspace(f.turn), first); await flush();
    assert.equal(adapter.turns.length, 0); assert.equal(second.store.getJob(first.jobId)?.status, 'uncertain'); assert.equal(second.store.workers().length, 1);
    assert.equal(f.events.length, 1); assert.equal(f.events[0]!.purpose, 'workspace-context'); assert.equal(f.events[0]!.status, 'failed');
  } finally { await second?.close(); await f.runtime.close(); f.registry.close(); }
});

test('failed workspace initialization is not retried by later human messages', async () => {
  const f = fixture();
  try {
    const first = await f.runtime.initializeWorkspace(f.turn) as Handle; await flush(); f.codex.terminate(first.workerId); await flush();
    assert.equal(f.runtime.store.getJob(first.jobId)?.status, 'failed'); assert.equal(f.events[0]!.purpose, 'workspace-context');
    assert.deepEqual(await f.runtime.initializeWorkspace(f.turn), first); await flush();
    assert.equal(f.codex.turns.length, 1); assert.equal(f.runtime.store.jobs().length, 1); assert.equal(f.registry.activeCount('parent-A'), 0);
  } finally { await f.runtime.close(); f.registry.close(); }
});

test('a persisted initialization queued before process startup resumes its single saved dispatch', async () => {
  const f = fixture(); let second: ControllerRuntime | undefined;
  try {
    await f.runtime.close(); const store = new ControllerStore(f.dir);
    const origin = { ...f.registry.getContextOrigin(JSON.parse(readFileSync(f.turn.taskContextPath!, 'utf8')) as TaskContextFile), purpose: 'workspace-context' as const };
    const handle: Handle = { workerId: 'workspace-queued', jobId: randomUUID(), status: 'queued' };
    store.transaction(() => {
      store.addWorker({ id: handle.workerId, origin, agent: 'codex', model: 'gpt-6.1-sol', actualModel: null, effort: 'medium', cwd: f.dir,
        title: '工作区上下文', nativeId: null, imagePaths: [], wakeAllowed: true, createdAt: '2026-10-09', updatedAt: '2026-10-09' });
      store.addJob({ id: handle.jobId, workerId: handle.workerId, origin, prompt: '只读 AGENTS.md 与 README.md', imagePaths: [], status: 'queued',
        taskId: null, result: null, cancelReason: null, createdAt: '2026-10-09', updatedAt: '2026-10-09' });
      store.saveWorkspaceInitialization('parent-A', handle);
    }); store.close();
    const adapter = new FakeAdapter(); second = new ControllerRuntime(f.config, { codex: adapter, claude: new FakeAdapter() }, f.registry, f.callbacks);
    assert.deepEqual(await second.initializeWorkspace(f.turn), handle); await flush();
    assert.equal(adapter.turns.length, 1); assert.equal(adapter.turns[0]!.conversation.id, handle.workerId); assert.equal(second.store.workers().length, 1);
    assert.equal(f.registry.activeCount('parent-A'), 1); adapter.finish(handle.workerId, '恢复了唯一调查任务'); await flush();
    assert.equal(f.events.length, 1); assert.equal(f.events[0]!.purpose, 'workspace-context'); assert.equal(f.registry.activeCount('parent-A'), 0);
  } finally { await second?.close(); await f.runtime.close(); f.registry.close(); }
});

test('a new parent initializes independently using its selected Claude alias and origin while an old parent stays deduplicated', async () => {
  const f = fixture();
  try {
    const first = await f.runtime.initializeWorkspace(f.turn) as Handle; await flush(); f.codex.finish(first.workerId); await flush();
    const context = f.registry.createContext({ conversationId: 'parent-new', userId: 'user-A', channelId: 'dm-A', originMessageId: 'new-message',
      nativeId: null, agent: 'claude', cwd: f.dir });
    const next: AgentTurn = { ...f.turn, taskContextPath: context.contextPath, effort: 'low', conversation: {
      ...f.turn.conversation, id: 'parent-new', nativeId: null, agent: 'claude', model: 'haiku' } };
    const second = await f.runtime.initializeWorkspace(next) as Handle; await flush();
    assert.notEqual(second.workerId, first.workerId); assert.equal(f.claude.turns.length, 1); assert.equal(f.claude.turns[0]!.conversation.model, 'haiku');
    assert.equal(f.claude.turns[0]!.effort, 'low'); assert.equal(f.runtime.store.getJob(second.jobId)!.origin.conversationId, 'parent-new');
    assert.equal(f.runtime.store.getJob(second.jobId)!.origin.nativeId, null); assert.equal(f.registry.activeCount('parent-new'), 1);
    f.claude.finish(second.workerId); await flush(); assert.deepEqual(await f.runtime.initializeWorkspace(f.turn), first);
    assert.equal(f.runtime.store.workers().length, 2); assert.equal(f.events[1]!.purpose, 'workspace-context');
  } finally { await f.runtime.close(); f.registry.close(); }
});

test('workspace initialization requires a matching trusted context before writing its once marker', async () => {
  const f = fixture();
  try {
    await assert.rejects(f.runtime.initializeWorkspace({ ...f.turn, taskContextPath: undefined }), /可信任务上下文/);
    await assert.rejects(f.runtime.initializeWorkspace({ ...f.turn, conversation: { ...f.turn.conversation, id: 'untrusted-parent' } }), /不匹配/);
    assert.equal(f.runtime.store.getWorkspaceInitialization('parent-A'), undefined); assert.equal(f.runtime.store.workers().length, 0);
  } finally { await f.runtime.close(); f.registry.close(); }
});

test('workspace once markers use a separate persistent key and roll back together with the dispatch transaction', async () => {
  const f = fixture(); let store: ControllerStore | undefined;
  try {
    const handle = { workerId: 'saved-worker', jobId: 'saved-job', status: 'queued' };
    f.runtime.store.saveCall('parent-A:workspace-context', 'native-call', { native: true });
    assert.throws(() => f.runtime.store.transaction(() => { f.runtime.store.saveWorkspaceInitialization('parent-A', handle); throw new Error('simulate-crash'); }), /simulate-crash/);
    assert.equal(f.runtime.store.getWorkspaceInitialization('parent-A'), undefined);
    f.runtime.store.saveWorkspaceInitialization('parent-A', handle); await f.runtime.close(); store = new ControllerStore(f.dir);
    assert.deepEqual(store.getWorkspaceInitialization('parent-A'), handle); assert.deepEqual(store.getCall('parent-A:workspace-context', 'native-call'), { native: true });
    assert.equal(store.getWorkspaceInitialization('parent-B'), undefined);
  } finally { store?.close(); await f.runtime.close(); f.registry.close(); }
});

test('dispatch returns before child completion; one child serializes turns and preserves session/model/effort', async () => {
  const f = fixture();
  try {
    const handle = await launch(f.runtime, f.turn);
    await flush(); assert.equal(f.codex.turns.length, 1); assert.equal(f.registry.activeCount('parent-A'), 1);
    const next = await f.runtime.invoke(f.turn, 'bridge_continue_worker', { workerId: handle.workerId, prompt: '检查 CPU 和内存', delivery: 'next' }) as Handle;
    assert.notEqual(next.jobId, handle.jobId); await flush(); assert.equal(f.codex.turns.length, 1);
    assert.equal(f.runtime.store.getJob(next.jobId)?.status, 'queued'); assert.equal(f.registry.activeCount('parent-A'), 1);
    f.codex.finish(handle.workerId, '温度正常'); await flush();
    assert.equal(f.codex.turns.length, 2); assert.equal(f.codex.turns[1]?.conversation.nativeId, `native-${handle.workerId}`);
    assert.equal(f.codex.turns[1]?.conversation.model, 'gpt-6.1-sol'); assert.equal(f.codex.turns[1]?.effort, 'medium');
    assert.equal(f.codex.turns[0]?.taskContextPath, undefined); assert.match(f.codex.turns[0]!.text, /不要自行登记/);
    assert.equal(f.registry.activeCount('parent-A'), 1); f.codex.finish(handle.workerId, 'CPU 20%'); await flush();
    assert.equal(f.registry.activeCount('parent-A'), 0); assert.equal(f.events.length, 2); assert.deepEqual(f.errors, []);
    assert.ok(f.events.every(event => event.nativeId === 'native-parent')); assert.match(f.events[1]!.text, /CPU 20%/);
    assert.equal(f.events[1]!.displayText, 'CPU 20%'); assert.match(f.events[1]!.text, /workerId:/);
  } finally { await f.runtime.close(); f.registry.close(); }
});

test('independent children run concurrently and the counter only includes started jobs', async () => {
  const f = fixture();
  try {
    const a = await launch(f.runtime, f.turn); const b = await launch(f.runtime, f.turn, { title: '另一个任务', agent: 'claude', model: 'haiku' });
    await flush(); assert.equal(f.codex.turns.length, 1); assert.equal(f.claude.turns.length, 1); assert.equal(f.registry.activeCount('parent-A'), 2);
    assert.equal(f.claude.turns[0]?.conversation.model, 'haiku');
    f.codex.finish(a.workerId); await flush(); assert.equal(f.registry.activeCount('parent-A'), 1);
    f.claude.finish(b.workerId); await flush(); assert.equal(f.registry.activeCount('parent-A'), 0); assert.ok(f.counts.includes(2));
  } finally { await f.runtime.close(); f.registry.close(); }
});

test('changing agent without an explicit model preserves CLI defaults and recorded actual model never overwrites an alias', async () => {
  const f = fixture();
  try {
    const defaultChild = await launch(f.runtime, f.turn, { agent: 'claude' }); await flush();
    assert.equal(f.claude.turns[0]?.conversation.model, null); f.claude.finish(defaultChild.workerId); await flush();
    const aliasChild = await launch(f.runtime, f.turn, { agent: 'claude', model: 'haiku' }); await flush();
    f.claude.turns[1]?.onModel?.('DeepSeek'); f.claude.finish(aliasChild.workerId); await flush();
    await f.runtime.invoke(f.turn, 'bridge_continue_worker', { workerId: aliasChild.workerId, prompt: '保留路由继续' }); await flush();
    assert.equal(f.claude.turns[2]?.conversation.model, 'haiku'); assert.equal(f.claude.turns[2]?.conversation.actualModel, 'DeepSeek');
    assert.equal(f.runtime.store.getWorker(aliasChild.workerId)?.model, 'haiku');
  } finally { await f.runtime.close(); f.registry.close(); }
});

test('native tool call ids deduplicate dispatch, continuation, alarms, and reject changed arguments', async () => {
  const f = fixture();
  try {
    const a = await launch(f.runtime, f.turn, {}, 'call-start');
    const duplicate = await launch(f.runtime, f.turn, {}, 'call-start'); assert.deepEqual(duplicate, a);
    await assert.rejects(launch(f.runtime, f.turn, { prompt: '改参数' }, 'call-start'), /参数发生变化/);
    const input = { workerId: a.workerId, prompt: '下一轮', delivery: 'next' };
    const b = await f.runtime.invoke(f.turn, 'bridge_continue_worker', input, 'call-continue');
    assert.deepEqual(await f.runtime.invoke(f.turn, 'bridge_continue_worker', input, 'call-continue'), b);
    const wake = await f.runtime.invoke(f.turn, 'bridge_schedule_wake', { afterSeconds: 30, text: '查看下载' }, 'call-wake');
    assert.deepEqual(await f.runtime.invoke(f.turn, 'bridge_schedule_wake', { text: '查看下载', afterSeconds: 30 }, 'call-wake'), wake);
    assert.equal(f.runtime.store.jobs().length, 2); assert.equal(f.runtime.store.wakes().length, 1);
  } finally { await f.runtime.close(); f.registry.close(); }
});

test('children reject other parents and user identities; only known picture references are delegated', async () => {
  const f = fixture();
  try {
    const image = join(f.dir, 'visible.png'); f.turn.imagePaths = [image];
    const a = await launch(f.runtime, f.turn); await flush(); assert.deepEqual(f.codex.turns[0]?.imagePaths, [image]);
    await assert.rejects(launch(f.runtime, f.turn, { imagePaths: [join(f.dir, 'secret.png')] }), /当前附件/);
    f.turn.imagePaths = [];
    await f.runtime.invoke(f.turn, 'bridge_continue_worker', { workerId: a.workerId, prompt: '继续看同一图', delivery: 'next', imagePaths: [image] });
    const otherContext = f.registry.createContext({ conversationId: 'parent-B', userId: 'user-B', channelId: 'dm-B', originMessageId: 'message-B',
      nativeId: 'native-B', agent: 'codex', cwd: f.dir });
    const other: AgentTurn = { ...f.turn, taskContextPath: otherContext.contextPath, conversation: { ...f.turn.conversation, id: 'parent-B', userId: 'user-B', nativeId: 'native-B' } };
    await assert.rejects(f.runtime.invoke(other, 'bridge_continue_worker', { workerId: a.workerId, prompt: '越权' }), /不属于/);
    await assert.rejects(f.runtime.invoke({ ...f.turn, conversation: { ...f.turn.conversation, userId: 'wrong' } }, 'bridge_list_workers', {}), /不匹配/);
    await assert.rejects(f.runtime.invoke(f.turn, 'bridge_list_workers', { extra: true }), /未知字段/);
  } finally { await f.runtime.close(); f.registry.close(); }
});

test('cancellation waits for the actual run to close and cancels queued work without starting it', async () => {
  const f = fixture(); f.codex.automaticClose = false;
  try {
    const a = await launch(f.runtime, f.turn); await flush();
    await f.runtime.invoke(f.turn, 'bridge_continue_worker', { workerId: a.workerId, prompt: '不能启动', delivery: 'next' });
    let returned = false;
    const cancellation = f.runtime.invoke(f.turn, 'bridge_cancel_worker', { workerId: a.workerId, reason: '用户改变要求' }, 'cancel-1').then(result => { returned = true; return result; });
    await flush(); assert.equal(returned, false); assert.equal(f.codex.turns[0]?.signal.aborted, true); assert.equal(f.registry.activeCount('parent-A'), 1);
    f.codex.terminate(a.workerId); const result = await cancellation as { stopped: boolean; remoteEffects: string };
    assert.equal(result.stopped, true); assert.match(result.remoteEffects, /另行核对/); assert.equal(f.registry.activeCount('parent-A'), 0);
    assert.equal(f.codex.turns.length, 1); assert.ok(f.runtime.store.jobs(a.workerId).every(job => job.status === 'cancelled'));
    assert.deepEqual(await f.runtime.invoke(f.turn, 'bridge_cancel_worker', { workerId: a.workerId, reason: '用户改变要求' }, 'cancel-1'), result);
    assert.equal(f.codex.interrupts.length, 1);
  } finally { f.codex.automaticClose = true; await f.runtime.close(); f.registry.close(); }
});

test('an unconfirmed process stop never reports stopped=true or a successful cancellation receipt', async () => {
  const f = fixture();
  f.codex.interrupt = async workerId => {
    const error = Object.assign(new Error('process close deadline exceeded'), { name: 'AgentProcessStopError', processStillRunning: true });
    f.codex.pending.get(workerId)?.reject(error); f.codex.pending.delete(workerId); throw error;
  };
  try {
    const handle = await launch(f.runtime, f.turn); await flush();
    const result = await f.runtime.invoke(f.turn, 'bridge_cancel_worker', { workerId: handle.workerId }) as { stopped: boolean };
    assert.equal(result.stopped, false); assert.equal(f.runtime.store.getJob(handle.jobId)?.status, 'uncertain');
    assert.equal(f.events[0]?.status, 'failed'); assert.match(f.events[0]!.text, /不能宣称已停止/);
    assert.doesNotMatch(f.events[0]!.text, /CLI 进程已结束/);
  } finally { await f.runtime.close(); f.registry.close(); }
});

test('shutdown stops a running CLI, persists uncertainty, and retains queued work and alarms for restart', async () => {
  const f = fixture(); let second: ControllerRuntime | undefined;
  try {
    const a = await launch(f.runtime, f.turn); await flush();
    await f.runtime.invoke(f.turn, 'bridge_continue_worker', { workerId: a.workerId, prompt: '独立的下一轮', delivery: 'next' });
    await f.runtime.invoke(f.turn, 'bridge_schedule_wake', { afterSeconds: 60, text: '恢复下载检查' });
    await f.runtime.close(); assert.equal(f.codex.pending.size, 0); assert.equal(f.registry.activeCount('parent-A'), 0);
    const inspect = new ControllerStore(f.dir);
    assert.deepEqual(inspect.jobs(a.workerId).map(job => job.status), ['uncertain', 'queued']); assert.equal(inspect.wakes()[0]?.status, 'pending'); inspect.close();
    const adapter = new FakeAdapter(); second = new ControllerRuntime(f.config, { codex: adapter, claude: new FakeAdapter() }, f.registry, f.callbacks);
    await second.start(); await flush(); assert.equal(adapter.turns.length, 0);
    assert.equal(second.store.getWorker(a.workerId)?.blocked, true);
    assert.equal(second.store.jobs(a.workerId)[1]?.status, 'queued');
    await assert.rejects(second.invoke(f.turn, 'bridge_continue_worker', { workerId: a.workerId, prompt: '自动继续不行' }), /不能自动续接/);
    const listed = await second.invoke(f.turn, 'bridge_list_workers', {}) as { workers: { blocked: boolean; lastStatus: string }[] };
    assert.equal(listed.workers[0]?.blocked, true); assert.equal(listed.workers[0]?.lastStatus, 'uncertain');
    assert.equal(second.store.jobs(a.workerId)[0]?.status, 'uncertain');
    await second.invoke(f.turn, 'bridge_cancel_worker', { workerId: a.workerId, reason: '取消未知任务的排队后续' });
    assert.equal(second.store.jobs(a.workerId)[1]?.status, 'cancelled');
    await assert.rejects(second.invoke(f.turn, 'bridge_continue_worker', { workerId: a.workerId, prompt: '取消后仅查状态' }), error => {
      assert.ok(error instanceof Error); assert.match(error.message, /旧任务不会自动重做/); assert.doesNotMatch(error.message, /保留/); return true;
    });
    assert.equal(adapter.turns.length, 0);
  } finally { await second?.close(); await f.runtime.close(); f.registry.close(); }
});

test('overdue alarms survive restart, fire exactly once, and never count as running agents', async () => {
  const f = fixture(); let second: ControllerRuntime | undefined;
  try {
    await f.runtime.invoke(f.turn, 'bridge_schedule_wake', { afterSeconds: 30, text: '查看温度' });
    assert.equal(f.registry.activeCount('parent-A'), 0); assert.equal(f.runtime.store.jobs().length, 0);
    await f.runtime.close(); f.advance(31000);
    second = new ControllerRuntime(f.config, { codex: new FakeAdapter(), claude: new FakeAdapter() }, f.registry, f.callbacks);
    await second.start(); await second.poll(); await second.poll();
    assert.equal(f.events.length, 1); assert.match(f.events[0]!.text, /查看温度/); assert.equal(f.events[0]!.displayText, '查看温度'); assert.match(f.events[0]!.text, /wakeId:/); assert.equal(f.registry.activeCount('parent-A'), 0);
    assert.deepEqual(f.counts, []); assert.equal(second.store.wakes()[0]?.status, 'fired');
  } finally { await second?.close(); await f.runtime.close(); f.registry.close(); }
});

test('detaching a parent keeps engineering jobs running but suppresses future automatic resume and alarms', async () => {
  const f = fixture();
  try {
    const a = await launch(f.runtime, f.turn); await flush();
    await f.runtime.invoke(f.turn, 'bridge_continue_worker', { workerId: a.workerId, prompt: '继续工程', delivery: 'next' });
    await f.runtime.invoke(f.turn, 'bridge_schedule_wake', { afterSeconds: 30, text: '旧会话预约' });
    f.runtime.detachConversation('parent-A'); assert.equal(f.codex.pending.size, 1);
    f.codex.finish(a.workerId); await flush(); f.codex.finish(a.workerId); await flush();
    assert.equal(f.events.length, 2); assert.ok(f.events.every(event => event.wakeAllowed === false));
    f.advance(60000); await f.runtime.poll(); assert.equal(f.events.length, 2); assert.equal(f.runtime.store.wakes()[0]?.status, 'cancelled');
  } finally { await f.runtime.close(); f.registry.close(); }
});

test('returning to a detached parent can continue the idle child without reviving old jobs or cancelling new work', async () => {
  const f = fixture();
  try {
    const a = await launch(f.runtime, f.turn); await flush();
    const oldQueued = await f.runtime.invoke(f.turn, 'bridge_continue_worker', { workerId: a.workerId, prompt: '切走前排队任务', delivery: 'next' }) as Handle;
    f.runtime.detachConversation('parent-A');
    const currentContext = f.registry.createContext({ conversationId: 'parent-A', userId: 'user-A', channelId: 'dm-A', originMessageId: 'message-return',
      nativeId: 'native-parent', agent: 'codex', cwd: f.dir });
    const returned = { ...f.turn, taskContextPath: currentContext.contextPath };
    const newQueued = await f.runtime.invoke(returned, 'bridge_continue_worker', { workerId: a.workerId, prompt: '回来后明确续接', delivery: 'next' }) as Handle;
    const other = await launch(f.runtime, returned, { title: '回来后独立新任务' }); await flush();
    f.codex.finish(a.workerId); await flush();
    // Starting the old disabled queue item must not cancel this fresh parent context or other worker.
    const capability = JSON.parse(readFileSync(currentContext.contextPath, 'utf8')) as TaskContextFile;
    assert.doesNotThrow(() => f.registry.getContextOrigin(capability));
    assert.equal(f.registry.getTask(other.jobId)?.wakeAllowed, true);
    f.codex.finish(a.workerId); await flush(); f.codex.finish(other.workerId); await flush(); f.codex.finish(a.workerId); await flush();
    const byTask = new Map(f.events.map(event => [event.taskId, event]));
    assert.equal(byTask.get(a.jobId)?.wakeAllowed, false); assert.equal(byTask.get(oldQueued.jobId)?.wakeAllowed, false);
    assert.equal(byTask.get(newQueued.jobId)?.wakeAllowed, true); assert.equal(byTask.get(other.jobId)?.wakeAllowed, true);
    assert.equal(f.runtime.store.getJob(newQueued.jobId)?.wakeAllowed, true);
    assert.equal(f.codex.turns.filter(turn => turn.conversation.id === a.workerId).length, 3);
  } finally { await f.runtime.close(); f.registry.close(); }
});

test('stopping a parent rejects when any local child process termination remains unconfirmed', async () => {
  const f = fixture();
  f.codex.interrupt = async workerId => {
    const error = Object.assign(new Error('close unconfirmed'), { name: 'AgentProcessStopError', processStillRunning: true });
    f.codex.pending.get(workerId)?.reject(error); f.codex.pending.delete(workerId); throw error;
  };
  try {
    const handle = await launch(f.runtime, f.turn); await flush();
    await assert.rejects(f.runtime.cancelConversation('parent-A'), /不能宣称全部停止/);
    assert.equal(f.runtime.store.getJob(handle.jobId)?.status, 'uncertain'); assert.equal(f.runtime.store.getWorker(handle.workerId)?.blocked, true);
  } finally { await f.runtime.close(); f.registry.close(); }
});

test('abrupt previous execution is reported once after recovery and never rerun', async () => {
  const f = fixture(); let second: ControllerRuntime | undefined;
  try {
    await f.runtime.close();
    const store = new ControllerStore(f.dir);
    const context = JSON.parse(readFileSync(f.turn.taskContextPath!, 'utf8')) as TaskContextFile;
    const origin = f.registry.getContextOrigin(context);
    const taskId = f.registry.register(context, '旧进程').taskId;
    store.addWorker({ id: 'worker-old', origin, agent: 'codex', model: 'gpt-6.1-sol', actualModel: null, effort: 'medium', cwd: f.dir,
      title: '旧进程', nativeId: 'native-old', imagePaths: [], wakeAllowed: true, createdAt: '2026-10-09', updatedAt: '2026-10-09' });
    store.addJob({ id: 'job-old', workerId: 'worker-old', origin, prompt: '不能重跑', imagePaths: [], status: 'running', taskId,
      result: null, cancelReason: null, createdAt: '2026-10-09', updatedAt: '2026-10-09' }); store.close();
    const adapter = new FakeAdapter(); second = new ControllerRuntime(f.config, { codex: adapter, claude: new FakeAdapter() }, f.registry, f.callbacks);
    await second.start(); await second.start(); await flush();
    assert.equal(adapter.turns.length, 0); assert.equal(second.store.getJob('job-old')?.status, 'uncertain');
    assert.equal(f.events.length, 1); assert.match(f.events[0]!.text, /未自动重做/); assert.equal(f.registry.activeCount('parent-A'), 0);
  } finally { await second?.close(); await f.runtime.close(); f.registry.close(); }
});

test('crash between wake registration and saving its task id reuses the same registry row', async () => {
  const f = fixture(); let second: ControllerRuntime | undefined;
  try {
    const handle = await f.runtime.invoke(f.turn, 'bridge_schedule_wake', { afterSeconds: 30, text: '跨库恢复' }) as { wakeId: string };
    const wake = f.runtime.store.getWake(handle.wakeId)!;
    const context = JSON.parse(readFileSync(f.turn.taskContextPath!, 'utf8')) as TaskContextFile;
    f.registry.register(context, '预约唤醒 · 主控', wake.id);
    assert.equal(f.registry.activeCount('parent-A'), 1);
    await f.runtime.close(); f.advance(31000);
    second = new ControllerRuntime(f.config, { codex: new FakeAdapter(), claude: new FakeAdapter() }, f.registry, f.callbacks);
    await second.start(); await second.poll();
    assert.equal(f.registry.activeCount('parent-A'), 0); assert.equal(f.registry.queuedEvents().length, 1);
    assert.equal(second.store.getWake(wake.id)?.taskId, wake.id); assert.equal(f.events.length, 1);
  } finally { await second?.close(); await f.runtime.close(); f.registry.close(); }
});

test('crash between saving a child result and registry completion repairs counts without executing again', async () => {
  const f = fixture(); let second: ControllerRuntime | undefined;
  try {
    await f.runtime.close(); const store = new ControllerStore(f.dir);
    const context = JSON.parse(readFileSync(f.turn.taskContextPath!, 'utf8')) as TaskContextFile;
    const origin = f.registry.getContextOrigin(context); const jobId = randomUUID();
    const taskId = f.registry.register(context, '已完成的子任务', jobId).taskId;
    store.addWorker({ id: 'worker-saved', origin, agent: 'codex', model: 'gpt-6.1-sol', actualModel: null, effort: 'medium', cwd: f.dir,
      title: '已完成的子任务', nativeId: 'native-saved', imagePaths: [], wakeAllowed: true, createdAt: '2026-10-09', updatedAt: '2026-10-09' });
    store.addJob({ id: jobId, workerId: 'worker-saved', origin, prompt: '不能重做已完成操作', imagePaths: [], status: 'completed', taskId,
      result: '已经写好了 diff', cancelReason: null, createdAt: '2026-10-09', updatedAt: '2026-10-09' }); store.close();
    const adapter = new FakeAdapter(); second = new ControllerRuntime(f.config, { codex: adapter, claude: new FakeAdapter() }, f.registry, f.callbacks);
    await second.start(); await flush(); assert.equal(adapter.turns.length, 0);
    assert.equal(f.registry.activeCount('parent-A'), 0); assert.equal(f.events.length, 1); assert.match(f.events[0]!.text, /已经写好了 diff/);
    assert.equal(second.store.getJob(jobId)?.status, 'completed');
  } finally { await second?.close(); await f.runtime.close(); f.registry.close(); }
});

for (const parentAgent of ['codex', 'claude'] as const) test(`跨后端子任务使用目标原生默认且保留${parentAgent}父强度`, async () => {
  const f = fixture();
  try {
    if (parentAgent === 'claude') {
      const created = f.registry.createContext({ conversationId: 'parent-A', userId: 'user-A', channelId: 'dm-A', originMessageId: 'message-A',
        nativeId: 'native-parent', agent: 'claude', cwd: f.dir });
      f.turn.taskContextPath = created.contextPath; f.turn.conversation.agent = 'claude'; f.turn.conversation.model = 'sonnet';
    }
    const ownEffort = parentAgent === 'codex' ? 'xhigh' : 'high';
    f.turn.effort = ownEffort; f.turn.conversation.effort = ownEffort; f.turn.conversation.actualEffort = ownEffort;
    const otherAgent = parentAgent === 'codex' ? 'claude' : 'codex';
    const model = otherAgent === 'claude' ? 'haiku' : 'gpt-6.1-sol';
    const handle = await launch(f.runtime, f.turn, { agent: otherAgent, model }); await flush();
    const child = f[otherAgent].turns[0]!;
    assert.equal(child.effort, undefined); assert.equal(child.conversation.effort, null); assert.equal(child.conversation.model, model);
    assert.equal(f.runtime.store.getWorker(handle.workerId)!.effort, null);
    assert.equal(f.turn.effort, ownEffort); assert.equal(f.turn.conversation.effort, ownEffort); assert.equal(f.turn.conversation.actualEffort, ownEffort);
    child.onReasoningEffort?.('medium'); f[otherAgent].finish(handle.workerId); await flush();
    await f.runtime.invoke(f.turn, 'bridge_continue_worker', { workerId: handle.workerId, prompt: '续接已有子会话' }); await flush();
    assert.equal(f[otherAgent].turns[1]!.conversation.nativeId, `native-${handle.workerId}`);
    assert.equal(f[otherAgent].turns[1]!.effort, undefined); assert.equal(f[otherAgent].turns[1]!.conversation.effort, null);
    f[otherAgent].finish(handle.workerId); await flush();
    const same = await launch(f.runtime, f.turn); await flush();
    assert.equal(f[parentAgent].turns[0]!.effort, ownEffort); f[parentAgent].finish(same.workerId); await flush();
  } finally { await f.runtime.close(); f.registry.close(); }
});
test('Codex 仅实际回报 xhigh 时，Claude 新任务仍使用原生默认', async () => {
  const f = fixture();
  try {
    f.turn.conversation.effort = null; f.turn.conversation.actualEffort = 'xhigh';
    const handle = await launch(f.runtime, f.turn, { agent: 'claude', model: 'haiku' }); await flush();
    assert.equal(f.runtime.store.getWorker(handle.workerId)!.effort, null); assert.equal(f.claude.turns[0]!.effort, undefined);
    assert.equal(f.turn.conversation.effort, null); assert.equal(f.turn.conversation.actualEffort, 'xhigh');
    f.claude.finish(handle.workerId); await flush();
  } finally { await f.runtime.close(); f.registry.close(); }
});
test('worker continuation preserves requested effort even when actual CLI metadata differs; new workers inherit current actual', async () => {
  const f = fixture(); try {
    f.turn.conversation.actualEffort = 'xhigh';
    const handle = await launch(f.runtime, f.turn); await flush();
    assert.equal(f.codex.turns[0]!.effort, 'xhigh');
    f.codex.turns[0]!.onReasoningEffort?.('medium');
    assert.equal(f.runtime.store.getWorker(handle.workerId)!.effort, 'xhigh');
    assert.equal(f.runtime.store.getWorker(handle.workerId)!.actualEffort, 'medium');
    f.codex.finish(handle.workerId); await flush();
    f.turn.conversation.actualEffort = 'high';
    await f.runtime.invoke(f.turn, 'bridge_continue_worker', { workerId: handle.workerId, prompt: 'continue' }); await flush();
    assert.equal(f.codex.turns[1]!.effort, 'xhigh');
    const fresh = await launch(f.runtime, f.turn); await flush();
    assert.equal(f.codex.turns[2]!.effort, 'high');
    f.codex.finish(handle.workerId); f.codex.finish(fresh.workerId); await flush();
  } finally { await f.runtime.close(); f.registry.close(); }
});

for (const selection of [
  { saved: 'xhigh', actual: 'medium', explicit: undefined, expected: 'xhigh' },
  { saved: 'high', actual: null, explicit: undefined, expected: 'high' },
  { saved: 'xhigh', actual: 'medium', explicit: 'high', expected: 'high' },
] as const) test(`子任务继承父会话显式选择，轮次覆盖优先：${JSON.stringify(selection)}`, async () => {
  const f = fixture();
  try {
    f.turn.conversation.effort = selection.saved;
    f.turn.conversation.actualEffort = selection.actual;
    if (selection.explicit) f.turn.effort = selection.explicit;
    const handle = await launch(f.runtime, f.turn); await flush();
    assert.equal(f.runtime.store.getWorker(handle.workerId)!.effort, selection.expected);
    assert.equal(f.codex.turns[0]!.effort, selection.expected);
    f.codex.finish(handle.workerId); await flush();
  } finally { await f.runtime.close(); f.registry.close(); }
});
