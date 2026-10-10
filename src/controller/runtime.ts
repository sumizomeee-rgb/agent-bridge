import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import type { AgentAdapter, AgentName, AgentTurn, BridgeConfig, Conversation } from '../types.js';
import type { TaskContextFile, TaskOrigin, TaskRegistry, TaskTerminalStatus } from '../tasks.js';
import { ControllerStore } from './store.js';
import type { ControllerJob, ControllerRuntimeCallbacks, ControllerSupplement, ControllerWake, ControllerWorker } from './runtime-types.js';
import type { ExecutionTargetBinding } from '../remote/types.js';

const workerInstruction = '你是桥已登记并管理的执行子 Agent。执行下面的任务，使用你需要的电脑工具或 SSH 技能；等待你启动的远端任务结束并核对结果后再返回。不要自行登记桥后台任务、发 Discord 消息或伪造完成回执。若涉及截图或文件，返回文件绝对路径供主控决定发送。\n\n';
const workspaceWorkerInstruction = '你是桥已登记并管理的工作区上下文调查子 Agent。只完成下面的只读调查，不执行新的工程或生活任务，不自行登记桥后台任务、发 Discord 消息或伪造完成回执。\n\n';
const workspacePrompt = '这是当前父会话的一次性工作区初始化。以当前工作目录中的 AGENTS.md、README.md 为用户入口，遵循其中定义的初始化入口、只读范围和回传要求；仅在它们明确要求初始化读取时，沿导航读取指定的本机上下文文件。初始化读取范围和回传内容由用户文件维护，不预设业务栏目；没有额外定义时，仅返回这两个文件中与后续会话有关的必要指导。不要扫描未指定的目录或技能目录，不连接远程电脑、联网检查、修改文件或启动新工作。缺失文件、读取失败或不明确的范围如实报告，不猜测环境；区分文件声明与实际核实的事实。仅将结果作为本任务回执返回。';
const tools = new Set(['bridge_start_worker', 'bridge_continue_worker', 'bridge_cancel_worker', 'bridge_schedule_wake', 'bridge_list_workers', 'bridge_list_targets', 'bridge_handoff_worker', 'bridge_request_restart']);
function pathKey(value: string): string { const result = resolve(value); return process.platform === 'win32' ? result.toLowerCase() : result; }
function text(value: unknown, label: string, limit: number): string {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value, 'utf8') > limit || value.includes('\0')) throw new Error(`${label}为空或超过限制`);
  return value.trim();
}
function listText(value: string, characters: number, bytes = Number.MAX_SAFE_INTEGER): string {
  const candidate = value.slice(0, characters).replace(/[\uD800-\uDBFF]$/, '');
  const buffer = Buffer.from(candidate, 'utf8');
  return buffer.length <= bytes ? candidate : buffer.subarray(0, bytes).toString('utf8').replace(/\uFFFD$/, '');
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
interface ActiveWorker { job: ControllerJob; abort: AbortController; done: Promise<void>; supplements: Promise<void>; ready: boolean; executing: boolean; closing: boolean; recovering?: boolean; cancelReason?: string }
function stopUnconfirmed(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AgentProcessStopError'
    || error.name === 'RemoteDispatchUncertain'
    || (error as Error & { processStillRunning?: boolean }).processStillRunning === true);
}

/** The controller only dispatches; this service owns child processes and their durable routing. */
export class ControllerRuntime {
  readonly store: ControllerStore;
  private readonly active = new Map<string, ActiveWorker>();
  private readonly dispatches = new Map<string, { fingerprint: string; promise: Promise<unknown> }>();
  private readonly unconfirmedStops = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private polling: Promise<void> | undefined;
  private started = false;
  private closed = false;
  private stopping = false;
  private draining = false;
  private isDraining(): boolean { return this.draining || this.callbacks.isDraining?.() === true; }
  beginDrain(): void { this.draining = true; }
  isIdle(): boolean { return this.active.size === 0 && this.dispatches.size === 0 && this.unconfirmedStops.size === 0 && !this.polling; }

  constructor(private readonly config: BridgeConfig, private readonly adapters: Record<AgentName, AgentAdapter>,
    private readonly registry: TaskRegistry, private readonly callbacks: ControllerRuntimeCallbacks = {}) {
    this.store = new ControllerStore(config.dataDir);
  }
  private adapter(worker: ControllerWorker): AgentAdapter {
    if (worker.target?.transport === 'ssh') {
      if (!this.callbacks.targetCatalog) throw new Error('远端执行目标服务未配置，拒绝改为本机执行');
      return this.callbacks.targetCatalog.adapterFor(worker.target);
    }
    return this.adapters[worker.agent];
  }
  private assertBridgeOwnership(worker: ControllerWorker): void {
    if (worker.ownership === 'user') throw new Error('此子 Agent 已交接给用户，桥不能再续接、派发或取消');
    if (worker.handoffPending) throw new Error('此子 Agent 的交接状态尚未确认，拒绝自动续接或再次交接');
  }
  private async resolveTarget(workspace: string, targetId: string, agent: AgentName, cwd?: string): Promise<ExecutionTargetBinding> {
    if (this.callbacks.targetCatalog) return this.callbacks.targetCatalog.resolveTarget(workspace, targetId, agent, cwd);
    if (targetId !== 'local') throw new Error('远端执行目标服务未配置');
    const directory = cwd ?? workspace;
    if (!isAbsolute(directory) || /[\r\n]/.test(directory) || !statSync(directory).isDirectory()) throw new Error('工作目录必须是本机已有目录的绝对路径');
    return { id: 'local', label: '本机', transport: 'local', agent, agentCommand: this.config.commands[agent], cwd: directory };
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
    for (const supplement of this.store.supplements()) {
      if (supplement.status === 'pending' || supplement.status === 'steering') this.setSupplement(supplement,
        supplement.status === 'steering' ? 'uncertain' : 'not_delivered', '桥在补充期间重启；未自动重发。');
    }
    // Local interrupted work stays uncertain. A remote daemon follows the original dispatch only.
    for (const job of this.store.jobs().filter(job => job.status === 'running')) {
      const worker = this.store.getWorker(job.workerId)!;
      if (worker.target?.transport === 'ssh' && worker.ownership !== 'user' && !worker.handoffPending) this.launchJob(worker.id, job, true);
      else await this.finish(worker, job, 'uncertain', '桥在执行期间重启；该轮结果未知，未自动重做。请检查已发生的操作。');
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
  /** One trusted, silent workspace-reading child per parent, including parents created before this feature. */
  async initializeWorkspace(turn: AgentTurn): Promise<unknown> {
    return this.coalescedDispatch(turn, 'bridge_start_worker', { title: '工作区上下文', prompt: workspacePrompt, imagePaths: [] }, undefined, true);
  }
  async invoke(turn: AgentTurn, name: string, input: unknown, callId?: string): Promise<unknown> {
    return this.coalescedDispatch(turn, name, input, callId);
  }
  private coalescedDispatch(turn: AgentTurn, name: string, input: unknown, callId?: string, workspaceInitialization = false): Promise<unknown> {
    const origin = this.origin(turn);
    const key = workspaceInitialization ? `workspace-context:${origin.conversationId}` : callId ? `${origin.conversationId}:${callId}` : null;
    if (!key) return this.dispatch(turn, name, input, callId, workspaceInitialization);
    const fingerprint = createHash('sha256').update(canonical({ name, input })).digest('hex');
    const previous = this.dispatches.get(key);
    if (previous) {
      if (previous.fingerprint !== fingerprint) return Promise.reject(new Error('重复工具调用的参数发生变化，拒绝再次派发'));
      return previous.promise;
    }
    const promise = this.dispatch(turn, name, input, callId, workspaceInitialization).finally(() => {
      if (this.dispatches.get(key)?.promise === promise) this.dispatches.delete(key);
    });
    this.dispatches.set(key, { fingerprint, promise });
    return promise;
  }
  private async dispatch(turn: AgentTurn, name: string, input: unknown, callId?: string, workspaceInitialization = false): Promise<unknown> {
    if (this.closed || this.stopping) throw new Error('主控执行服务正在关闭');
    if (!tools.has(name)) throw new Error('未知桥调度工具');
    if (this.isDraining() && ['bridge_start_worker', 'bridge_continue_worker', 'bridge_schedule_wake'].includes(name)) throw new Error('桥正在安全重启，已暂停新派发；请在恢复后继续。');
    const contextOrigin = this.origin(turn);
    const origin: TaskOrigin = workspaceInitialization ? { ...contextOrigin, purpose: 'workspace-context' } : contextOrigin;
    const key = workspaceInitialization || callId === undefined ? null : `${origin.conversationId}:${text(callId, '工具调用编号', 512)}`;
    const fingerprint = createHash('sha256').update(canonical({ name, input })).digest('hex');
    if (workspaceInitialization) {
      const previous = this.store.getWorkspaceInitialization(origin.conversationId);
      if (previous !== undefined) { if (!this.started) await this.start(); return previous; }
      if (this.callbacks.targetCatalog) {
        try { await this.callbacks.targetCatalog.listTargets(turn.conversation.cwd, true); }
        catch (error) { this.error(new Error(`工作区执行目标登记刷新失败，未改变执行目标或回退本机：${error instanceof Error ? error.message : String(error)}`, { cause: error })); }
      }
    } else if (key) {
      const previous = this.store.getCall(key, fingerprint);
      if (previous !== undefined) return previous;
    }
    if (name === 'bridge_list_targets') {
      const args = object(input, ['refresh']);
      if (args.refresh !== undefined && typeof args.refresh !== 'boolean') throw new Error('refresh 必须是布尔值');
      const result = { targets: this.callbacks.targetCatalog ? await this.callbacks.targetCatalog.listTargets(turn.conversation.cwd, args.refresh !== false)
        : [{ id: 'local', label: '本机', transport: 'local', engines: ['codex', 'claude'], availability: 'local' }] };
      if (key) this.store.saveCall(key, fingerprint, result);
      return result;
    }
    if (name === 'bridge_handoff_worker') {
      const args = object(input, ['workerId']);
      const worker = this.ownedWorker(origin, args.workerId);
      this.assertBridgeOwnership(worker);
      if (worker.blocked || this.active.has(worker.id) || this.store.jobs(worker.id).some(job => ['queued', 'running', 'uncertain'].includes(job.status))
        || this.store.supplements().some(value => value.workerId === worker.id && ['pending', 'steering'].includes(value.status))) {
        throw new Error('只能交接已确认空闲的子 Agent；活动、排队或未知任务需要先处理');
      }
      if (!worker.nativeId) throw new Error('子 Agent 尚未建立真实原生会话，不能交接');
      if (!this.callbacks.targetCatalog) throw new Error('桥尚未配置会话交接服务');
      const binding = worker.target ?? await this.resolveTarget(worker.cwd, 'local', worker.agent, worker.cwd);
      const initial = { workerId: worker.id, target: binding, nativeId: worker.nativeId, status: 'handing-off' };
      this.store.transaction(() => {
        const current = this.store.getWorker(worker.id)!;
        this.assertBridgeOwnership(current);
        if (current.blocked || this.active.has(worker.id) || this.store.jobs(worker.id).some(job => ['queued', 'running', 'uncertain'].includes(job.status))
          || current.nativeId !== worker.nativeId) throw new Error('子 Agent 状态在交接准备期间发生变化，未执行交接');
        Object.assign(worker, current); worker.handoffPending = true;
        this.store.saveWorker(worker); if (key) this.store.saveCall(key, fingerprint, initial);
      });
      try {
        const proof = await this.callbacks.targetCatalog.handoff(binding, worker.nativeId, worker.cwd, worker.agent);
        if (proof.stopped !== true || proof.targetId !== binding.id || proof.nativeId !== worker.nativeId
          || proof.cwd !== worker.cwd || proof.agent !== worker.agent || !proof.resumeCommand) throw new Error('交接服务没有返回匹配的真实目标与原生会话证明');
        const result = { workerId: worker.id, ownership: 'user', status: 'handed-off', target: binding, ...proof };
        this.store.transaction(() => { worker.target = binding; worker.ownership = 'user'; worker.handoffPending = false; worker.updatedAt = this.timestamp(); this.store.saveWorker(worker); if (key) this.store.updateCall(key, result); });
        return result;
      } catch (error) {
        worker.blocked = true; this.store.saveWorker(worker);
        if (key) this.store.updateCall(key, { ...initial, status: 'uncertain', reason: '交接状态未确认；未自动重试，也不能继续旧子 Agent。' });
        throw error;
      }
    }
    if (name === 'bridge_request_restart') {
      object(input, []);
      if (!this.callbacks.onRequestRestart) throw new Error('桥尚未配置安全重启服务');
      if (key) this.store.saveCall(key, fingerprint, { accepted: false, status: 'registering' });
      try {
        const result = await this.callbacks.onRequestRestart(origin);
        if (key) this.store.updateCall(key, result);
        return result;
      } catch (error) {
        if (key) this.store.updateCall(key, { accepted: false, status: 'uncertain', reason: '重启登记结果未确认；请查询状态，不自动重复登记。' });
        throw error;
      }
    }
    if (name === 'bridge_cancel_worker') {
      const args = object(input, ['workerId', 'reason']);
      const worker = this.ownedWorker(origin, args.workerId);
      this.assertBridgeOwnership(worker);
      const reason = args.reason === undefined ? '主控取消了此子 Agent 的任务' : text(args.reason, '取消原因', 4096);
      const scope = worker.target?.transport === 'ssh' ? 'remote-agent-process' : 'local-agent-process';
      const initial = { workerId: worker.id, status: 'cancelling', stopped: false, scope, target: worker.target ?? null, nativeId: worker.nativeId };
      this.store.transaction(() => { this.requestCancellation(worker.id, reason); if (key) this.store.saveCall(key, fingerprint, initial); });
      const stopped = await this.stopWorker(worker.id, reason);
      const result = { workerId: worker.id, status: stopped ? 'cancelled' : 'uncertain', stopped, scope, target: worker.target ?? null, nativeId: worker.nativeId,
        remoteEffects: '远端自行启动的后台进程或已发生的改动需要另行核对' };
      if (key) this.store.updateCall(key, result);
      return result;
    }
    if (name === 'bridge_continue_worker') {
      const args = object(input, ['workerId', 'prompt', 'imagePaths', 'delivery']);
      if (args.delivery !== undefined && args.delivery !== 'current' && args.delivery !== 'next') throw new Error('delivery 必须是 current 或 next');
      const worker = this.ownedWorker(origin, args.workerId);
      this.assertBridgeOwnership(worker);
      if (worker.blocked) throw new Error('此子 Agent 上一轮结果未知，已暂停；不能自动续接旧原生会话。请新起核查子 Agent，确认进程及已发生的操作。旧任务不会自动重做。');
      const images = this.images(turn, args.imagePaths, worker);
      const prompt = text(args.prompt, '任务内容', 128 * 1024);
      const active = this.active.get(worker.id);
      if (active && args.delivery !== 'next') {
        const supplement: ControllerSupplement = { id: randomUUID(), workerId: worker.id, jobId: active.job.id, origin, prompt, imagePaths: images,
          status: !this.adapter(worker).steer ? 'unsupported' : active.abort.signal.aborted ? 'cancelled' : !active.executing ? 'not_delivered' : 'pending',
          ...(key ? { callKey: key } : {}), createdAt: this.timestamp(), updatedAt: this.timestamp() };
        supplement.reason = supplement.status === 'unsupported' ? '此后端未支持工作中输入；未发送。可明确使用 delivery=next。'
          : supplement.status === 'cancelled' ? '该任务正在停止；未发送。'
          : supplement.status === 'not_delivered' ? '当前轮已经结束；未发送。可明确使用 delivery=next。' : '等待当前原生轮次接收点；尚未确认送达。';
        const result = this.supplementResult(supplement);
        this.store.transaction(() => { this.store.saveSupplement(supplement); if (key) this.store.saveCall(key, fingerprint, result); });
        if (supplement.status === 'pending') this.pumpSupplements(worker.id, active);
        return result;
      }
      const job = this.makeJob(worker, origin, prompt, images);
      const result = { workerId: worker.id, jobId: job.id, status: 'queued', delivery: 'next', nativeId: worker.nativeId,
        agent: worker.agent, model: worker.model, effort: worker.effort, target: worker.target ?? null, ownership: worker.ownership ?? 'bridge' };
      this.store.transaction(() => {
        worker.imagePaths = [...new Set([...worker.imagePaths, ...images])]; worker.updatedAt = this.timestamp();
        this.store.saveWorker(worker); this.store.addJob(job); if (key) this.store.saveCall(key, fingerprint, result);
      });
      if (!this.started) await this.start();
      this.kick(worker.id);
      return result;
    }
    let target: ExecutionTargetBinding | undefined;
    if (name === 'bridge_start_worker') {
      const args = object(input, ['title', 'prompt', 'cwd', 'agent', 'model', 'imagePaths', 'targetId']);
      const agent = args.agent === undefined ? turn.conversation.agent : args.agent;
      if (agent !== 'codex' && agent !== 'claude') throw new Error('agent 必须是 codex 或 claude');
      target = await this.resolveTarget(turn.conversation.cwd, args.targetId === undefined ? 'local' : text(args.targetId, '执行目标', 256), agent,
        args.cwd === undefined ? undefined : text(args.cwd, '工作目录', 8192));
      if (target.agent !== agent || target.id !== (args.targetId ?? 'local')) throw new Error('执行目标服务返回的电脑或引擎与请求不一致');
      if (target.transport === 'local' && (!isAbsolute(target.cwd) || /[\r\n]/.test(target.cwd) || !statSync(target.cwd).isDirectory())) throw new Error('工作目录必须是本机已有目录的绝对路径');
      if (this.isDraining()) throw new Error('桥正在安全重启，已暂停新派发');
    }
    let workerToStart: string | undefined;
    const result = this.store.transaction(() => {
      let result: unknown;
      if (name === 'bridge_start_worker') {
        const args = object(input, ['title', 'prompt', 'cwd', 'agent', 'model', 'imagePaths', 'targetId']);
        const agent = args.agent === undefined ? turn.conversation.agent : args.agent;
        if (agent !== 'codex' && agent !== 'claude') throw new Error('agent 必须是 codex 或 claude');
        const cwd = target!.cwd;
        const model = args.model === undefined ? agent === turn.conversation.agent ? turn.conversation.model ?? null : null
          : text(args.model, '模型', 256);
        const images = this.images(turn, args.imagePaths);
        const worker: ControllerWorker = { id: randomUUID(), origin, agent, model, actualModel: null, target: target!, ownership: 'bridge',
          effort: agent === turn.conversation.agent ? turn.effort ?? turn.conversation.effort ?? turn.conversation.actualEffort ?? null : null, cwd, title: text(args.title, '任务名称', 1024), nativeId: null,
          imagePaths: images, wakeAllowed: true, blocked: false, createdAt: this.timestamp(), updatedAt: this.timestamp() };
        const job = this.makeJob(worker, origin, text(args.prompt, '任务内容', 128 * 1024), images);
        this.store.addWorker(worker); this.store.addJob(job); workerToStart = worker.id;
        result = { workerId: worker.id, jobId: job.id, status: 'queued', agent: worker.agent, model: worker.model, effort: worker.effort, nativeId: worker.nativeId, target: worker.target, ownership: worker.ownership };
      } else if (name === 'bridge_schedule_wake') {
        const args = object(input, ['afterSeconds', 'text']);
        if (typeof args.afterSeconds !== 'number' || !Number.isFinite(args.afterSeconds) || args.afterSeconds < 1 || args.afterSeconds > 30 * 86400) {
          throw new Error('唤醒间隔必须在 1 秒至 30 天之间');
        }
        const wake: ControllerWake = { id: randomUUID(), origin, dueAt: new Date(this.now() + args.afterSeconds * 1000).toISOString(),
          text: text(args.text, '唤醒提示', 16 * 1024), status: 'pending', taskId: null, createdAt: this.timestamp() };
        this.store.addWake(wake); result = { wakeId: wake.id, dueAt: wake.dueAt, status: 'scheduled' };
      } else {
        const args = object(input, ['workerId']);
        const details = args.workerId !== undefined;
        const workers = details ? [this.ownedWorker(origin, args.workerId)] : this.store.workers(origin.conversationId)
          .filter(worker => worker.origin.userId === origin.userId && worker.origin.channelId === origin.channelId);
        let previewBytes = 8 * 1024;
        const preview = (value: string): string => {
          const result = listText(value, 256, previewBytes); previewBytes -= Buffer.byteLength(result, 'utf8'); return result;
        };
        result = { workers: workers.map(worker => {
          const jobs = this.store.jobs(worker.id); const latest = jobs.at(-1);
          const supplements = jobs.flatMap(job => this.store.supplements(job.id));
          const supplementCounts: Record<string, number> = {};
          for (const value of supplements) supplementCounts[value.status] = (supplementCounts[value.status] ?? 0) + 1;
          const active = supplements.filter(value => ['pending', 'steering', 'uncertain'].includes(value.status));
          const history = supplements.filter(value => !['pending', 'steering', 'uncertain'].includes(value.status));
          const receipt = (value: ControllerSupplement) => ({ ...this.supplementResult(value) as Record<string, unknown>,
            reason: value.reason ? listText(value.reason, 256) : null, reasonTruncated: (value.reason?.length ?? 0) > 256 });
          const lastResultPreview = latest?.result == null ? null : preview(latest.result);
          return { workerId: worker.id, title: worker.title, agent: worker.agent, model: worker.model, actualModel: worker.actualModel,
            target: worker.target ?? null, ownership: worker.ownership ?? 'bridge', handoffPending: worker.handoffPending === true,
            effort: worker.effort, actualEffort: worker.actualEffort ?? null, nativeId: worker.nativeId, cwd: worker.cwd, running: jobs.some(job => job.status === 'running'),
            queued: jobs.filter(job => job.status === 'queued').length, blocked: worker.blocked === true,
            lastStatus: worker.blocked ? 'uncertain' : latest?.status ?? 'idle', lastJobId: latest?.id ?? null,
            hasResult: latest?.result != null, lastResultPreview,
            lastResultPreviewTruncated: latest?.result != null && lastResultPreview !== latest.result, supplementCounts,
            ...(details ? { lastResult: latest?.result == null ? null : listText(latest.result, 4096),
              lastResultTruncated: (latest?.result?.length ?? 0) > 4096, activeSupplements: active.map(receipt),
              supplements: history.slice(-20).map(receipt), supplementsTotal: supplements.length,
              supplementsTruncated: history.length > 20 } : {}) };
        }), wakes: details ? [] : this.store.wakes(origin.conversationId).filter(wake => wake.origin.userId === origin.userId && wake.status === 'pending')
          .map(wake => { const textPreview = preview(wake.text); return { wakeId: wake.id, dueAt: wake.dueAt, textPreview, textPreviewTruncated: textPreview !== wake.text }; }) };
      }
      if (workspaceInitialization) this.store.saveWorkspaceInitialization(origin.conversationId, result);
      else if (key) this.store.saveCall(key, fingerprint, result);
      return result;
    });
    if (!this.started) await this.start();
    if (workerToStart) this.kick(workerToStart);
    return result;
  }
  private supplementResult(value: ControllerSupplement): unknown {
    return { workerId: value.workerId, jobId: value.jobId, supplementId: value.id, status: value.status, delivery: 'current',
      delivered: value.status === 'accepted', reason: value.reason ?? null, queueAvailable: ['unsupported', 'not_delivered'].includes(value.status) };
  }
  private setSupplement(value: ControllerSupplement, status: ControllerSupplement['status'], reason: string): void {
    value.status = status; value.reason = reason; value.updatedAt = this.timestamp();
    this.store.transaction(() => {
      this.store.saveSupplement(value);
      if (value.callKey) this.store.updateCall(value.callKey, this.supplementResult(value));
      if (status === 'accepted') {
        const worker = this.store.getWorker(value.workerId)!;
        worker.imagePaths = [...new Set([...worker.imagePaths, ...value.imagePaths])]; this.store.saveWorker(worker);
      }
    });
  }
  private pumpSupplements(workerId: string, state: ActiveWorker): void {
    state.supplements = state.supplements.then(async () => {
      if (!state.ready || !state.executing || state.abort.signal.aborted) return;
      const adapter = this.adapter(this.store.getWorker(workerId)!);
      for (const value of this.store.supplements(state.job.id).filter(value => value.status === 'pending')) {
        if (!state.executing || state.abort.signal.aborted) return;
        this.setSupplement(value, 'steering', '已提交当前原生会话，等待确认；不可重复发送。');
        let result;
        try { result = await adapter.steer!(workerId, { id: value.id, input: [
          { type: 'text', text: value.prompt }, ...value.imagePaths.map(path => ({ type: 'localImage' as const, path })),
        ] }); }
        catch { result = { status: 'uncertain' as const, reason: '补充请求异常；可能已接收，未自动重发。' }; }
        this.setSupplement(value, result.status === 'accepted' ? 'accepted' : result.status === 'uncertain' ? 'uncertain'
          : result.unsupported ? 'unsupported' : 'not_delivered', result.status === 'accepted' ? '原生会话已确认接收；归属当前任务，消费时机由 CLI 决定。'
            : result.status === 'uncertain' ? result.reason : result.reason ?? '原生当前轮未接收；未自动排队，可明确使用 delivery=next。');
      }
    }).catch(error => this.error(error));
  }
  private async settleSupplements(state: ActiveWorker): Promise<void> {
    state.executing = false;
    await state.supplements;
    for (const value of this.store.supplements(state.job.id)) if (value.status === 'pending') this.setSupplement(value,
      state.abort.signal.aborted ? 'cancelled' : 'not_delivered', '当前轮结束或停止前未发送；未自动排队。');
  }
  private makeJob(worker: ControllerWorker, origin: TaskOrigin, prompt: string, imagePaths: string[]): ControllerJob {
    return { id: randomUUID(), workerId: worker.id, origin, prompt, imagePaths, status: 'queued', taskId: null, result: null,
      cancelReason: null, wakeAllowed: true, createdAt: this.timestamp(), updatedAt: this.timestamp() };
  }
  private kick(workerId: string): void {
    if (!this.started || this.stopping || this.closed || this.isDraining() || this.active.has(workerId) || this.store.getWorker(workerId)?.blocked || !this.store.nextJob(workerId)) return;
    const worker = this.store.getWorker(workerId)!;
    if (worker.ownership === 'user' || worker.handoffPending) return;
    this.launchJob(workerId, this.store.nextJob(workerId)!);
  }
  private launchJob(workerId: string, job: ControllerJob, recovering = false): void {
    if (this.active.has(workerId)) return;
    const state: ActiveWorker = { job, abort: new AbortController(), done: Promise.resolve(), supplements: Promise.resolve(), ready: false, executing: true, closing: false, recovering };
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
    if (this.store.workers().some(other => other.id !== worker.id && other.agent === worker.agent && (other.target?.id ?? 'local') === (worker.target?.id ?? 'local') && other.nativeId === value)) throw new Error('不同子 Agent 返回了相同原生会话编号');
    stored.nativeId = value; stored.updatedAt = this.timestamp(); this.store.saveWorker(stored);
    worker.nativeId = value;
  }
  private async execute(workerId: string, state: ActiveWorker): Promise<void> {
    const worker = this.store.getWorker(workerId)!;
    let job = this.store.getJob(state.job.id)!;
    if (job.status !== (state.recovering ? 'running' : 'queued') || this.stopping) { await this.settleSupplements(state); return; }
    if (!state.recovering) this.store.setJob(job.id, 'running');
    try {
      this.assertBridgeOwnership(worker);
      if (!job.taskId) this.register(worker, job);
      job = this.store.getJob(job.id)!; state.job = job;
      const conversation: Conversation = { id: worker.id, userId: worker.origin.userId, agent: worker.agent, nativeId: worker.nativeId,
        model: worker.model, actualModel: worker.actualModel, effort: worker.effort, actualEffort: worker.actualEffort ?? null, title: worker.title, cwd: worker.cwd,
        createdAt: worker.createdAt, updatedAt: this.timestamp() };
      const turn: AgentTurn = { conversation, text: (job.origin.purpose === 'workspace-context' ? workspaceWorkerInstruction : workerInstruction) + job.prompt, imagePaths: job.imagePaths,
        ...(worker.effort ? { effort: worker.effort } : {}), signal: state.abort.signal, onProgress: () => {}, acceptSupplements: true, dispatchId: job.id, recovering: state.recovering === true,
        onReady: () => { state.ready = true; this.pumpSupplements(workerId, state); },
        onNativeId: nativeId => this.nativeId(worker, nativeId),
        onModel: actualModel => { const current = this.store.getWorker(worker.id)!; current.actualModel = actualModel; this.store.saveWorker(current); },
        onReasoningEffort: effort => { const current = this.store.getWorker(worker.id)!; current.actualEffort = effort; this.store.saveWorker(current); } };
      // No taskContextPath: the worker is already registered by this service.
      const running = this.adapter(worker).run(turn);
      void this.count(job.origin.conversationId);
      const result = await running;
      await this.settleSupplements(state);
      this.nativeId(worker, result.nativeId);
      const current = this.store.getJob(job.id)!;
      if (state.closing) await this.finish(worker, current, 'uncertain', '桥关闭时停止了执行子 Agent；本轮结果未知，未自动重做。');
      else if (state.cancelReason || current.cancelReason) await this.finish(worker, current, 'cancelled', `${state.cancelReason ?? current.cancelReason}\n本桥管理的 CLI 进程已结束；远端自行启动的后台进程及已发生的改动需另行核对。`);
      else await this.finish(worker, current, 'completed', result.text);
    } catch (error) {
      await this.settleSupplements(state);
      const current = this.store.getJob(job.id)!;
      if (stopUnconfirmed(error)) {
        this.unconfirmedStops.add(worker.id);
        await this.finish(worker, current, 'uncertain',
          '执行子 Agent 的进程退出尚未确认，可能仍在运行。请核对进程和已发生的操作；本轮未自动重做，也不能宣称已停止。');
      }
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
    const supplements = this.store.supplements(job.id);
    if (supplements.length) result += '\n\n当前轮补充接收记录：\n' + supplements.map(value => `${value.id}: ${value.status}${value.reason ? ` · ${value.reason}` : ''}`).join('\n');
    this.store.setJob(job.id, status, { taskId, result });
    const terminal: TaskTerminalStatus = status === 'uncertain' || status === 'failed' ? 'failed' : status === 'cancelled' ? 'cancelled' : 'completed';
    const current = this.store.getWorker(worker.id)!;
    if (status === 'uncertain') { current.blocked = true; this.store.saveWorker(current); }
    const changed = this.registry.acceptObservedResult(taskId, terminal,
      `workerId: ${worker.id}\njobId: ${job.id}\n子 Agent: ${worker.agent}\n原生会话: ${current.nativeId ?? '尚未建立'}\n\n${result}`, result);
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
    const active = this.active.get(workerId), worker = this.store.getWorker(workerId)!;
    if (!active) {
      if (worker.target?.transport === 'ssh' && this.unconfirmedStops.has(workerId)) {
        try {
          await this.adapter(worker).interrupt(workerId);
          this.unconfirmedStops.delete(workerId);
          return true;
        } catch (error) { this.error(error); return false; }
      }
      return worker.blocked !== true;
    }
    active.cancelReason = reason; active.abort.abort(reason);
    // interrupt may finish before run's finally; wait for both before claiming the process is stopped.
    const results = await Promise.allSettled([this.adapter(worker).interrupt(workerId), active.done]);
    const failed = results.find(result => result.status === 'rejected');
    if (failed?.status === 'rejected') { this.error(failed.reason); return false; }
    if (worker.target?.transport === 'ssh') this.unconfirmedStops.delete(workerId);
    return !this.active.has(workerId) && !this.unconfirmedStops.has(workerId);
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
    for (const worker of workers) if (worker.ownership !== 'user') this.requestCancellation(worker.id, '用户停止了父会话');
    const stopped = await Promise.all(workers.filter(worker => worker.ownership !== 'user').map(worker => this.stopWorker(worker.id, '用户停止了父会话')));
    if (stopped.some(result => result === false)) {
      throw Object.assign(new Error('部分执行子 Agent 的进程停止尚未确认，不能宣称全部停止；请核对未知任务。'),
        { name: 'AgentProcessStopError', processStillRunning: true });
    }
  }
  private async confirmUncertainStops(): Promise<void> {
    const workers = [...this.unconfirmedStops].map(id => this.store.getWorker(id))
      .filter(worker => worker?.target?.transport === 'ssh').slice(0, 4);
    for (const worker of workers) {
      if (this.closed || this.stopping) return;
      try {
        if (await this.adapter(worker!).confirmStopped?.(worker!.id)) this.unconfirmedStops.delete(worker!.id);
      } catch (error) { this.error(error); }
      // Rotate unresolved guards so a persistently unreachable machine cannot starve later ones.
      if (this.unconfirmedStops.has(worker!.id)) { this.unconfirmedStops.delete(worker!.id); this.unconfirmedStops.add(worker!.id); }
    }
  }
  async poll(): Promise<void> {
    if (this.closed || this.stopping) return;
    await this.confirmUncertainStops();
    if (this.closed || this.stopping || this.isDraining()) return;
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
      const changed = this.registry.acceptObservedResult(taskId, 'completed', `这是主控此前登记的预约触发。\nwakeId: ${wake.id}\n预约时间: ${wake.dueAt}\n提示: ${wake.text}`, wake.text);
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
      const results = await Promise.allSettled([this.adapter(this.store.getWorker(id)!).interrupt(id), state.done]);
      for (const result of results) if (result.status === 'rejected') errors.push(result.reason);
    }));
    await this.polling;
    this.closed = true; this.store.close();
    if (errors.length) throw new AggregateError(errors, '部分执行子 Agent 的进程停止尚未确认');
  }
}
