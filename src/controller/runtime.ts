import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import type { AgentAdapter, AgentName, AgentTurn, BridgeConfig, Conversation } from '../types.js';
import type { TaskContextFile, TaskOrigin, TaskRegistry, TaskTerminalStatus } from '../tasks.js';
import { ControllerStore } from './store.js';
import type { ControllerJob, ControllerRuntimeCallbacks, ControllerWake, ControllerWorker } from './runtime-types.js';

const workerInstruction = '你是桥已登记并管理的执行子 Agent。执行下面的任务，使用你需要的电脑工具或 SSH 技能；等待你启动的远端任务结束并核对结果后再返回。不要自行登记桥后台任务、发 Discord 消息或伪造完成回执。若涉及截图或文件，返回文件绝对路径供主控决定发送。\n\n';
const tools = new Set(['bridge_start_worker', 'bridge_continue_worker', 'bridge_cancel_worker', 'bridge_schedule_wake', 'bridge_list_workers']);
function pathKey(value: string): string { const result = resolve(value); return process.platform === 'win32' ? result.toLowerCase() : result; }
function text(value: unknown, label: string, limit: number): string {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value, 'utf8') > limit || value.includes('\0')) throw new Error(`${label}为空或超过限制`);
  return value.trim();
}
function object(value: unknown, allowed: string[]): Record<string, unknown> {
  if (value == null) value = {};
  if (typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new Error('工具参数必须是对象');
  const result = value as Record<string, unknown>;
  if (Object.keys(result).some(key => !allowed.includes(key))) throw new Error('工具参数包含未知字段');
  return result;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
interface ActiveWorker { job: ControllerJob; abort: AbortController; done: Promise<void>; closing: boolean; cancelReason?: string }
function stopUnconfirmed(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AgentProcessStopError'
    || (error as Error & { processStillRunning?: boolean }).processStillRunning === true);
}

/** The controller only dispatches; this service owns child processes and their durable routing. */
export class ControllerRuntime {
  readonly store: ControllerStore;
  private readonly active = new Map<string, ActiveWorker>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private polling: Promise<void> | undefined;
  private started = false;
  private closed = false;
  private stopping = false;
  constructor(private readonly config: BridgeConfig, private readonly adapters: Record<AgentName, AgentAdapter>,
    private readonly registry: TaskRegistry, private readonly callbacks: ControllerRuntimeCallbacks = {}) {
    this.store = new ControllerStore(config.dataDir);
  }
  private now(): number { return this.callbacks.now?.() ?? Date.now(); }
  private timestamp(): string { return new Date(this.now()).toISOString(); }
  private error(error: unknown): void { this.callbacks.onError?.(error); }
  private origin(turn: AgentTurn): TaskOrigin {
    if (!turn.taskContextPath || !isAbsolute(turn.taskContextPath)) throw new Error('主控缺少可信任务上下文');
    if (statSync(turn.taskContextPath).size > 96 * 1024) throw new Error('主控任务上下文过大');
    const context = JSON.parse(readFileSync(turn.taskContextPath, 'utf8').replace(/^\uFEFF/, '')) as TaskContextFile;
    const origin = this.registry.getContextOrigin(context);
    const conversation = turn.conversation;
    if (origin.conversationId !== conversation.id || origin.userId !== conversation.userId || origin.agent !== conversation.agent
      || pathKey(origin.cwd) !== pathKey(conversation.cwd) || (origin.nativeId && conversation.nativeId && origin.nativeId !== conversation.nativeId)) {
      throw new Error('主控任务上下文与会话不匹配');
    }
    return origin;
  }
  private ownedWorker(origin: TaskOrigin, workerId: unknown): ControllerWorker {
    const id = text(workerId, 'workerId', 256);
    const worker = this.store.getWorker(id);
    if (!worker || worker.origin.userId !== origin.userId || worker.origin.conversationId !== origin.conversationId
      || worker.origin.channelId !== origin.channelId) throw new Error('子 Agent 不属于当前用户和父会话');
    return worker;
  }
  private images(turn: AgentTurn, value: unknown, worker?: ControllerWorker): string[] {
    const current = [...turn.imagePaths, ...(turn.input ?? []).flatMap(input => input.type === 'localImage' ? [input.path] : [])];
    const candidates = value === undefined ? turn.imagePaths : value;
    if (!Array.isArray(candidates) || candidates.length > 32) throw new Error('图片路径必须是至多 32 项的数组');
    const allowed = new Set([...current, ...(worker?.imagePaths ?? [])].map(pathKey));
    return [...new Set(candidates.map(value => {
      const path = text(value, '图片路径', 8192);
      if (!isAbsolute(path) || /[\r\n]/.test(path) || !allowed.has(pathKey(path))) throw new Error('只能转交当前附件或此子 Agent 已收到的图片');
      return path;
    }))];
  }
  async start(): Promise<void> {
    if (this.closed || this.stopping) throw new Error('主控执行服务已关闭');
    if (this.started) return;
    this.started = true;
    // A previously running CLI may have performed side effects. Never start it again automatically.
    for (const job of this.store.jobs().filter(job => job.status === 'running')) {
      const worker = this.store.getWorker(job.workerId)!;
      await this.finish(worker, job, 'uncertain', '桥在执行期间重启；该轮结果未知，未自动重做。请检查已发生的操作。');
    }
    // Completing the two SQLite journals cannot share a transaction. Reconcile a saved terminal
    // result before pumping queues so a crash between commits cannot leave a permanent count.
    for (const job of this.store.jobs().filter(job => !['queued', 'running'].includes(job.status) && job.taskId)) {
      const task = this.registry.getTask(job.taskId!);
      if (task && ['registered', 'running'].includes(task.status)) {
        await this.finish(this.store.getWorker(job.workerId)!, job, job.status, job.result ?? '子任务已结束，但没有保存结果正文。');
      }
    }
    for (const worker of this.store.workers()) {
      if (!worker.blocked && this.store.jobs(worker.id).some(job => job.status === 'uncertain')) {
        worker.blocked = true; this.store.saveWorker(worker);
      }
    }
    await this.poll();
    for (const worker of this.store.workers()) this.kick(worker.id);
    this.schedule();
  }
  private schedule(): void {
    if (this.stopping || this.closed) return;
    this.timer = setTimeout(() => {
      this.polling = this.poll().catch(error => this.error(error)).finally(() => { this.polling = undefined; this.schedule(); });
    }, this.callbacks.pollIntervalMs ?? 1000);
    this.timer.unref();
  }
  async invoke(turn: AgentTurn, name: string, input: unknown, callId?: string): Promise<unknown> {
    if (this.closed || this.stopping) throw new Error('主控执行服务正在关闭');
    if (!tools.has(name)) throw new Error('未知桥调度工具');
    const origin = this.origin(turn);
    const key = callId === undefined ? null : `${origin.conversationId}:${text(callId, '工具调用编号', 512)}`;
    const fingerprint = createHash('sha256').update(canonical({ name, input })).digest('hex');
    if (key) {
      const previous = this.store.getCall(key, fingerprint);
      if (previous !== undefined) return previous;
    }
    if (name === 'bridge_cancel_worker') {
      const args = object(input, ['workerId', 'reason']);
      const worker = this.ownedWorker(origin, args.workerId);
      const reason = args.reason === undefined ? '主控取消了此子 Agent 的任务' : text(args.reason, '取消原因', 4096);
      const initial = { workerId: worker.id, status: 'cancelling', stopped: false, scope: 'local-agent-process' };
      this.store.transaction(() => { this.requestCancellation(worker.id, reason); if (key) this.store.saveCall(key, fingerprint, initial); });
      const stopped = await this.stopWorker(worker.id, reason);
      const result = { workerId: worker.id, status: stopped ? 'cancelled' : 'uncertain', stopped, scope: 'local-agent-process',
        remoteEffects: '远端自行启动的后台进程或已发生的改动需要另行核对' };
      if (key) this.store.updateCall(key, result);
      return result;
    }
    let workerToStart: string | undefined;
    const result = this.store.transaction(() => {
      let result: unknown;
      if (name === 'bridge_start_worker') {
        const args = object(input, ['title', 'prompt', 'cwd', 'agent', 'model', 'imagePaths']);
        const agent = args.agent === undefined ? turn.conversation.agent : args.agent;
        if (agent !== 'codex' && agent !== 'claude') throw new Error('agent 必须是 codex 或 claude');
        const cwd = args.cwd === undefined ? turn.conversation.cwd : text(args.cwd, '工作目录', 8192);
        if (!isAbsolute(cwd) || /[\r\n]/.test(cwd) || !statSync(cwd).isDirectory()) throw new Error('工作目录必须是本机已有目录的绝对路径');
        const model = args.model === undefined ? agent === turn.conversation.agent ? turn.conversation.model ?? null : null
          : text(args.model, '模型', 256);
        const images = this.images(turn, args.imagePaths);
        const worker: ControllerWorker = { id: randomUUID(), origin, agent, model, actualModel: null,
          effort: turn.effort ?? turn.conversation.actualEffort ?? null, cwd, title: text(args.title, '任务名称', 1024), nativeId: null,
          imagePaths: images, wakeAllowed: true, blocked: false, createdAt: this.timestamp(), updatedAt: this.timestamp() };
        const job = this.makeJob(worker, origin, text(args.prompt, '任务内容', 128 * 1024), images);
        this.store.addWorker(worker); this.store.addJob(job); workerToStart = worker.id;
        result = { workerId: worker.id, jobId: job.id, status: 'queued', agent: worker.agent, model: worker.model, effort: worker.effort };
      } else if (name === 'bridge_continue_worker') {
        const args = object(input, ['workerId', 'prompt', 'imagePaths']);
        const worker = this.ownedWorker(origin, args.workerId);
        if (worker.blocked) throw new Error('此子 Agent 上一轮结果未知，已暂停；不能自动续接旧原生会话。请新起核查子 Agent，确认进程及已发生的操作。旧排队任务保留但不重做。');
        const images = this.images(turn, args.imagePaths, worker);
        const job = this.makeJob(worker, origin, text(args.prompt, '任务内容', 128 * 1024), images);
        worker.imagePaths = [...new Set([...worker.imagePaths, ...images])]; worker.updatedAt = this.timestamp();
        this.store.saveWorker(worker); this.store.addJob(job); workerToStart = worker.id;
        result = { workerId: worker.id, jobId: job.id, status: 'queued', nativeId: worker.nativeId, agent: worker.agent, model: worker.model, effort: worker.effort };
      } else if (name === 'bridge_schedule_wake') {
        const args = object(input, ['afterSeconds', 'text']);
        if (typeof args.afterSeconds !== 'number' || !Number.isFinite(args.afterSeconds) || args.afterSeconds < 1 || args.afterSeconds > 30 * 86400) {
          throw new Error('唤醒间隔必须在 1 秒至 30 天之间');
        }
        const wake: ControllerWake = { id: randomUUID(), origin, dueAt: new Date(this.now() + args.afterSeconds * 1000).toISOString(),
          text: text(args.text, '唤醒提示', 16 * 1024), status: 'pending', taskId: null, createdAt: this.timestamp() };
        this.store.addWake(wake); result = { wakeId: wake.id, dueAt: wake.dueAt, status: 'scheduled' };
      } else {
        object(input, []);
        result = { workers: this.store.workers(origin.conversationId).filter(worker => worker.origin.userId === origin.userId
          && worker.origin.channelId === origin.channelId).map(worker => {
          const jobs = this.store.jobs(worker.id); const latest = jobs.at(-1);
          return { workerId: worker.id, title: worker.title, agent: worker.agent, model: worker.model, actualModel: worker.actualModel,
            effort: worker.effort, nativeId: worker.nativeId, cwd: worker.cwd, running: jobs.some(job => job.status === 'running'),
            queued: jobs.filter(job => job.status === 'queued').length, blocked: worker.blocked === true,
            lastStatus: worker.blocked ? 'uncertain' : latest?.status ?? 'idle', lastResult: latest?.result?.slice(0, 4096) ?? null };
        }), wakes: this.store.wakes(origin.conversationId).filter(wake => wake.origin.userId === origin.userId && wake.status === 'pending')
          .map(wake => ({ wakeId: wake.id, dueAt: wake.dueAt, text: wake.text })) };
      }
      if (key) this.store.saveCall(key, fingerprint, result);
      return result;
    });
    if (!this.started) await this.start();
    if (workerToStart) this.kick(workerToStart);
    return result;
  }
  private makeJob(worker: ControllerWorker, origin: TaskOrigin, prompt: string, imagePaths: string[]): ControllerJob {
    return { id: randomUUID(), workerId: worker.id, origin, prompt, imagePaths, status: 'queued', taskId: null, result: null,
      cancelReason: null, wakeAllowed: true, createdAt: this.timestamp(), updatedAt: this.timestamp() };
  }
  private kick(workerId: string): void {
    if (!this.started || this.stopping || this.closed || this.active.has(workerId) || this.store.getWorker(workerId)?.blocked || !this.store.nextJob(workerId)) return;
    const job = this.store.nextJob(workerId)!;
    const state: ActiveWorker = { job, abort: new AbortController(), done: Promise.resolve(), closing: false };
    this.active.set(workerId, state);
    state.done = Promise.resolve().then(() => this.execute(workerId, state)).catch(error => this.error(error)).finally(() => {
      this.active.delete(workerId); this.kick(workerId);
    });
  }
  private register(worker: ControllerWorker, job: ControllerJob): string {
    const created = this.registry.createContext(job.origin);
    try {
      const context = JSON.parse(readFileSync(created.contextPath, 'utf8')) as TaskContextFile;
      const registered = this.registry.register(context, worker.title, job.id);
      this.store.setJob(job.id, 'running', { taskId: registered.taskId });
      if (!(job.wakeAllowed ?? worker.wakeAllowed)) this.registry.disableTaskWake(registered.taskId);
      return registered.taskId;
    } finally { this.registry.closeContext(created.contextId); }
  }
  private nativeId(worker: ControllerWorker, value: string): void {
    text(value, '子会话编号', 512);
    if (/[\r\n\0]/.test(value) || value !== value.trim()) throw new Error('子会话编号格式无效');
    const stored = this.store.getWorker(worker.id)!;
    if (stored.nativeId && stored.nativeId !== value) throw new Error('子 Agent 续接返回了不同会话，拒绝静默换新会话');
    if (this.store.workers().some(other => other.id !== worker.id && other.agent === worker.agent && other.nativeId === value)) throw new Error('不同子 Agent 返回了相同原生会话编号');
    stored.nativeId = value; stored.updatedAt = this.timestamp(); this.store.saveWorker(stored);
    worker.nativeId = value;
  }
  private async execute(workerId: string, state: ActiveWorker): Promise<void> {
    const worker = this.store.getWorker(workerId)!;
    let job = this.store.getJob(state.job.id)!;
    if (job.status !== 'queued' || this.stopping) return;
    this.store.setJob(job.id, 'running');
    try {
      this.register(worker, job); job = this.store.getJob(job.id)!; state.job = job;
      const conversation: Conversation = { id: worker.id, userId: worker.origin.userId, agent: worker.agent, nativeId: worker.nativeId,
        model: worker.model, actualModel: worker.actualModel, actualEffort: worker.effort, title: worker.title, cwd: worker.cwd,
        createdAt: worker.createdAt, updatedAt: this.timestamp() };
      const turn: AgentTurn = { conversation, text: workerInstruction + job.prompt, imagePaths: job.imagePaths,
        ...(worker.effort ? { effort: worker.effort } : {}), signal: state.abort.signal, onProgress: () => {},
        onNativeId: nativeId => this.nativeId(worker, nativeId),
        onModel: actualModel => { const current = this.store.getWorker(worker.id)!; current.actualModel = actualModel; this.store.saveWorker(current); },
        onReasoningEffort: effort => { const current = this.store.getWorker(worker.id)!; current.effort = effort; this.store.saveWorker(current); } };
      // No taskContextPath: the worker is already registered by this service.
      const running = this.adapters[worker.agent].run(turn);
      void this.count(job.origin.conversationId);
      const result = await running;
      this.nativeId(worker, result.nativeId);
      const current = this.store.getJob(job.id)!;
      if (state.closing) await this.finish(worker, current, 'uncertain', '桥关闭时停止了执行子 Agent；本轮结果未知，未自动重做。');
      else if (state.cancelReason || current.cancelReason) await this.finish(worker, current, 'cancelled', `${state.cancelReason ?? current.cancelReason}\n本桥管理的 CLI 进程已结束；远端自行启动的后台进程及已发生的改动需另行核对。`);
      else await this.finish(worker, current, 'completed', result.text);
    } catch (error) {
      const current = this.store.getJob(job.id)!;
      if (stopUnconfirmed(error)) await this.finish(worker, current, 'uncertain',
        '执行子 Agent 的进程退出尚未确认，可能仍在运行。请核对进程和已发生的操作；本轮未自动重做，也不能宣称已停止。');
      else if (state.closing) await this.finish(worker, current, 'uncertain', '桥关闭时停止了执行子 Agent；本轮结果未知，未自动重做。');
      else if (state.cancelReason || current.cancelReason) await this.finish(worker, current, 'cancelled', `${state.cancelReason ?? current.cancelReason}\n本桥管理的 CLI 进程已结束；远端自行启动的后台进程及已发生的改动需另行核对。`);
      else await this.finish(worker, current, 'failed', error instanceof Error ? error.message : String(error));
    }
  }
  private async count(conversationId: string): Promise<void> {
    try { await this.callbacks.onCountChanged?.(conversationId, this.registry.activeCount(conversationId)); } catch (error) { this.error(error); }
  }
  private async notify(taskId: string): Promise<void> {
    const event = this.registry.queuedEvents().find(event => event.taskId === taskId);
    if (event) try { await this.callbacks.onCompletion?.(event); } catch (error) { this.error(error); }
  }
  private async finish(worker: ControllerWorker, job: ControllerJob, status: ControllerJob['status'], result: string): Promise<void> {
    let taskId = job.taskId;
    // A crash before task registration still needs one durable failure routed to the original parent.
    if (!taskId) taskId = this.register(worker, job);
    this.store.setJob(job.id, status, { taskId, result });
    const terminal: TaskTerminalStatus = status === 'uncertain' || status === 'failed' ? 'failed' : status === 'cancelled' ? 'cancelled' : 'completed';
    const current = this.store.getWorker(worker.id)!;
    if (status === 'uncertain') { current.blocked = true; this.store.saveWorker(current); }
    const changed = this.registry.acceptObservedResult(taskId, terminal,
      `workerId: ${worker.id}\njobId: ${job.id}\n子 Agent: ${worker.agent}\n原生会话: ${current.nativeId ?? '尚未建立'}\n\n${result}`);
    await this.count(job.origin.conversationId);
    if (changed) await this.notify(taskId);
  }
  private requestCancellation(workerId: string, reason: string): void {
    for (const job of this.store.jobs(workerId)) {
      if (job.status === 'queued') this.store.setJob(job.id, 'cancelled', { result: reason, cancelReason: reason });
      else if (job.status === 'running') this.store.setJob(job.id, 'running', { cancelReason: reason });
    }
  }
  private async stopWorker(workerId: string, reason: string): Promise<boolean> {
    const active = this.active.get(workerId);
    if (!active) return this.store.getWorker(workerId)?.blocked !== true;
    active.cancelReason = reason; active.abort.abort(reason);
    // interrupt may finish before run's finally; wait for both before claiming the process is stopped.
    const results = await Promise.allSettled([this.adapters[this.store.getWorker(workerId)!.agent].interrupt(workerId), active.done]);
    const failed = results.find(result => result.status === 'rejected');
    if (failed?.status === 'rejected') { this.error(failed.reason); return false; }
    return !this.active.has(workerId);
  }
  /** /new and agent switches retain engineering jobs, but disable their former automatic resume route. */
  detachConversation(conversationId: string): void {
    for (const worker of this.store.workers(conversationId)) {
      for (const job of this.store.jobs(worker.id)) if (job.status === 'queued' || job.status === 'running') {
        this.store.setJob(job.id, job.status, { wakeAllowed: false });
        if (job.taskId) this.registry.disableTaskWake(job.taskId);
      }
    }
    for (const wake of this.store.wakes(conversationId)) if (wake.status === 'pending') this.store.setWake(wake.id, 'cancelled');
    this.registry.cancelConversation(conversationId);
  }
  /** /stop explicitly terminates this service's child CLIs and cancels unstarted jobs and alarms. */
  async cancelConversation(conversationId: string): Promise<void> {
    this.detachConversation(conversationId);
    const workers = this.store.workers(conversationId);
    for (const worker of workers) this.requestCancellation(worker.id, '用户停止了父会话');
    const stopped = await Promise.all(workers.map(worker => this.stopWorker(worker.id, '用户停止了父会话')));
    if (stopped.some(result => result === false)) {
      throw Object.assign(new Error('部分执行子 Agent 的进程停止尚未确认，不能宣称全部停止；请核对未知任务。'),
        { name: 'AgentProcessStopError', processStillRunning: true });
    }
  }
  async poll(): Promise<void> {
    if (this.closed || this.stopping) return;
    for (const wake of this.store.wakes()) {
      if (wake.status === 'cancelled' || wake.status === 'fired' || Date.parse(wake.dueAt) > this.now()) continue;
      let taskId = wake.taskId;
      if (!taskId) {
        const created = this.registry.createContext(wake.origin);
        try {
          const context = JSON.parse(readFileSync(created.contextPath, 'utf8')) as TaskContextFile;
          taskId = this.registry.register(context, '预约唤醒 · 主控', wake.id).taskId;
          this.store.setWake(wake.id, 'firing', taskId);
        } finally { this.registry.closeContext(created.contextId); }
      }
      const changed = this.registry.acceptObservedResult(taskId, 'completed', `这是主控此前登记的预约触发。\nwakeId: ${wake.id}\n预约时间: ${wake.dueAt}\n提示: ${wake.text}`);
      this.store.setWake(wake.id, 'fired', taskId);
      // register + complete are synchronous: a sleeping alarm never appears as a running agent.
      if (changed) await this.notify(taskId);
    }
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.stopping = true; clearTimeout(this.timer);
    const active = [...this.active.entries()];
    for (const [, state] of active) { state.closing = true; state.abort.abort('桥正在关闭'); }
    const errors: unknown[] = [];
    await Promise.all(active.map(async ([id, state]) => {
      const results = await Promise.allSettled([this.adapters[this.store.getWorker(id)!.agent].interrupt(id), state.done]);
      for (const result of results) if (result.status === 'rejected') errors.push(result.reason);
    }));
    await this.polling;
    this.closed = true; this.store.close();
    if (errors.length) throw new AggregateError(errors, '部分执行子 Agent 的进程停止尚未确认');
  }
}
