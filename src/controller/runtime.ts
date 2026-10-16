import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import type { AgentAdapter, AgentName, AgentTurn, BridgeConfig, Conversation } from '../types.js';
import type { TaskContextFile, TaskOrigin, TaskRegistry, TaskTerminalStatus } from '../tasks.js';
import { ControllerStore } from './store.js';
import { isModelId } from '../config.js';
import { effortValues, resolveDefaultModel, validateEffort } from '../effort.js';
import type { NativeSessionRef } from '../native-sessions.js';
import type { WorkCounts, WorkerOverview } from '../overview.js';
import { observeActivity } from '../agents/activity.js';
import type { ControllerJob, ControllerRuntimeCallbacks, ControllerSchedule, ControllerSupplement, ControllerWorker } from './runtime-types.js';
import { SessionHandoffs } from './handoff.js';
import type { ExecutionTargetBinding } from '../remote/types.js';

const workerInstruction = '你是桥已登记并管理的执行子 Agent。执行下面的任务，使用你需要的电脑工具或 SSH 技能；等待你启动的远端任务结束并核对结果后再返回。不要自行登记桥后台任务、发 Discord 消息或伪造完成回执。若涉及截图或文件，返回文件绝对路径供主控决定发送。\n\n';
const workspaceWorkerInstruction = '你是桥已登记并管理的工作区上下文调查子 Agent。只完成下面的只读调查，不执行新的工程或生活任务，不自行登记桥后台任务、向聊天平台发消息或伪造完成回执。\n\n';
const workspacePrompt = '这是当前父会话的一次性工作区初始化。以当前工作目录中的 README.md 为用户入口，遵循其中定义的初始化入口、只读范围和回传要求；仅在 README 明确要求初始化读取时，沿导航读取指定的本机上下文文件。初始化读取范围和回传内容由用户文件维护，不预设业务栏目；没有额外定义时，仅返回 README 中与后续会话有关的必要指导。不要扫描未指定的目录或技能目录，不连接远程电脑、联网检查、修改文件或启动新工作。缺失文件、读取失败或不明确的范围如实报告，不猜测环境；区分文件声明与实际核实的事实。仅将结果作为本任务回执返回。';
const tools = new Set(['bridge_start_worker', 'bridge_continue_worker', 'bridge_cancel_worker', 'bridge_schedule_worker', 'bridge_schedule_controller', 'bridge_list_schedules', 'bridge_cancel_schedule', 'bridge_update_schedule', 'bridge_list_workers', 'bridge_list_targets', 'bridge_handoff_worker', 'bridge_request_restart', 'bridge_check_capabilities', 'bridge_list_native_sessions', 'bridge_read_native_session', 'bridge_adopt_native_session']);
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
  private starting: Promise<void> | undefined;
  private closed = false;
  private stopping = false;
  private draining = false;
  private lastWorkCounts: string | undefined;
  private isDraining(): boolean { return this.draining || this.callbacks.isDraining?.() === true; }
  beginDrain(): void { this.draining = true; }
  isIdle(): boolean { return this.active.size === 0 && this.dispatches.size === 0 && this.unconfirmedStops.size === 0 && !this.polling && !this.starting; }

  constructor(private readonly config: BridgeConfig, private readonly adapters: Record<AgentName, AgentAdapter>,
    private readonly registry: TaskRegistry, private readonly callbacks: ControllerRuntimeCallbacks = {}) {
    this.store = new ControllerStore(config.dataDir);
  }
  private adapter(worker: ControllerWorker): AgentAdapter {
    if (worker.target && this.callbacks.targetCatalog) return this.callbacks.targetCatalog.adapterFor(worker.target);
    if (worker.target?.transport === 'ssh') throw new Error('远端执行目标服务未配置，拒绝改为本机执行');
    return this.adapters[worker.agent];
  }
  private async validateWorkerSelection(worker: ControllerWorker, execution: NonNullable<ControllerJob['execution']> = { model: worker.model, effort: worker.effort, ...(worker.modelPolicy ? { modelPolicy: worker.modelPolicy } : {}) }): Promise<void> {
    if (!execution.effort) return;
    const target: Conversation = { id: worker.id, userId: worker.origin.userId, agent: worker.agent,
      nativeId: worker.nativeId, model: execution.model, effort: execution.effort, cwd: worker.cwd,
      title: worker.title, createdAt: worker.createdAt, updatedAt: worker.updatedAt };
    await validateEffort(this.adapter(worker), target, execution.effort);
  }
  private assertBridgeOwnership(worker: ControllerWorker): void {
    if (worker.supersededBy) throw new Error('此原生会话已转交其他直属 Agent，旧登记仅保留历史');
    if (worker.adoption?.status === 'pending') throw new Error('此原生会话接管状态尚未确认');
    if (worker.ownership === 'user') throw new Error('此子 Agent 已交接给用户，桥不能再续接、派发或取消');
    if (worker.handoffPending) throw new Error('此子 Agent 的交接状态尚未确认，拒绝自动续接或再次交接');
  }
  private nativeAgent(value: unknown): AgentName {
    if (value !== 'codex' && value !== 'claude') throw new Error('agent 必须是 codex 或 claude'); return value;
  }
  private nativeRef(args: Record<string, unknown>): NativeSessionRef {
    if (args.profile !== undefined && args.profile !== 'default') throw new Error('未登记的原生 profile');
    return { agent: this.nativeAgent(args.agent), profile: 'default', nativeId: text(args.nativeId, 'nativeId', 256) };
  }
  private async authorizeNativeAccess(origin: TaskOrigin, targetId: string): Promise<void> {
    if (this.callbacks.targetCatalog?.authorizeNativeAccess) await this.callbacks.targetCatalog.authorizeNativeAccess(origin.cwd, origin.userId, targetId);
    else if (origin.userId !== this.config.allowedUserIds[0]) throw new Error('当前用户未获此电脑原生历史访问权限');
  }
  private selectedWorkerModel(value: unknown, inherited: string | null): string | null {
    if (value === undefined || value === 'default') return inherited;
    const model = text(value, '模型', 200); if (!isModelId(model)) throw new Error('模型标识无效'); return model;
  }
  private async defaultWorkerModel(turn: AgentTurn, agent: AgentName): Promise<string> {
    const inherited = agent === turn.conversation.agent ? turn.conversation.model ?? turn.conversation.actualModel : null;
    const model = inherited ?? this.config.defaultModels?.[agent]
      ?? (await this.adapters[agent].getModelInfo?.(turn.conversation.cwd))?.defaultModel;
    if (!model || model === 'default' || !isModelId(model)) throw new Error('无法确定桥的助手默认模型，本次未派发；请明确 model 或配置 defaultModels。');
    return model;
  }
  private selectedWorkerEffort(value: unknown, agent: AgentName, inherited: string | null): string | null {
    if (value === undefined) return inherited;
    if (value === 'default') return null;
    const effort = text(value, '思考强度', 32);
    if (!effortValues[agent].includes(effort)) throw new Error(`${agent} 不支持强度 ${effort}。`); return effort;
  }
  private adoptionResult(worker: ControllerWorker): Record<string, unknown> {
    return { workerId: worker.id, status: 'idle', ownership: 'bridge', adopted: true, nativeId: worker.nativeId,
      target: worker.target ?? null, agent: worker.agent, cwd: worker.cwd, model: worker.model, effort: worker.effort, title: worker.title };
  }
  private async completeAdoption(workerId: string): Promise<unknown> {
    const worker = this.store.getWorker(workerId); if (!worker?.adoption || !worker.target) throw new Error('会话接管登记不存在');
    if (worker.adoption.status === 'adopted') this.assertBridgeOwnership(worker);
    const catalog = this.callbacks.targetCatalog;
    if (!catalog?.adoptNativeSession) throw new Error('原生会话接管服务未配置');
    await this.authorizeNativeAccess(worker.origin, worker.target.id);
    const currentBinding = await this.resolveTarget(worker.origin.cwd, worker.target.id, worker.agent);
    const route = (binding: ExecutionTargetBinding) => canonical({ ...binding, cwd: undefined });
    if (route(currentBinding) !== route(worker.target)) throw new Error('接管期间电脑登记已改变，不能使用旧连接自动恢复；需先核对原接管结果');
    let receipt;
    try {
      receipt = await catalog.adoptNativeSession(worker.target, worker.origin.userId, {
        ref: worker.adoption.ref, workerId, adoptionId: worker.adoption.id, expectedRevision: worker.adoption.expectedRevision,
      });
    } catch (error) {
      if (error instanceof Error && (error as Error & { adoptionRejected?: boolean }).adoptionRejected === true) {
        this.store.transaction(() => {
          const current = this.store.getWorker(workerId); if (!current || current.adoption?.status !== 'pending') return;
          for (const id of current.adoption.previousWorkers) {
            const prior = this.store.getWorker(id); if (!prior || prior.supersededBy) continue;
            prior.handoffPending = false; prior.updatedAt = this.timestamp(); this.store.saveWorker(prior);
          }
          this.store.removeUnclaimedWorker(workerId);
          if (current.adoption.callKey) this.store.updateCall(current.adoption.callKey, { workerId, status: 'rejected', adopted: false, reason: error.message });
        });
      }
      throw error;
    }
    if (receipt.status !== 'adopted' || receipt.workerId !== workerId || receipt.userId !== worker.origin.userId
      || receipt.adoptionId !== worker.adoption.id || receipt.nativeId !== worker.nativeId || receipt.ref.agent !== worker.agent
      || receipt.ref.profile !== worker.adoption.ref.profile || pathKey(receipt.cwd) !== pathKey(worker.cwd)) throw new Error('原生接管回执与已登记身份不一致');
    return this.store.transaction(() => {
      const current = this.store.getWorker(workerId)!; if (!current.adoption) throw new Error('接管登记发生变化');
      if (current.adoption.status === 'adopted') return this.adoptionResult(current);
      for (const id of current.adoption.previousWorkers) {
        const prior = this.store.getWorker(id); if (!prior) continue;
        if (this.active.has(id) || this.store.jobs(id).some(job => ['queued', 'running', 'uncertain'].includes(job.status))) throw new Error('原持有者静止状态变化，接管结果需要核对');
        prior.supersededBy = current.id; prior.ownership = 'user'; prior.handoffPending = false; prior.wakeAllowed = false;
        prior.updatedAt = this.timestamp(); this.store.saveWorker(prior);
      }
      current.blocked = false; current.adoption.status = 'adopted'; current.updatedAt = this.timestamp(); this.store.saveWorker(current);
      const result = this.adoptionResult(current); if (current.adoption.callKey) this.store.updateCall(current.adoption.callKey, result);
      return result;
    });
  }
  getGlobalWorkCounts(): WorkCounts {
    const jobs = this.store.jobs().filter(job => this.config.allowedUserIds.includes(job.origin.userId));
    return { running: new Set(jobs.filter(job => job.status === 'running').map(job => job.workerId)).size,
      queued: jobs.filter(job => job.status === 'queued').length };
  }
  queryWorkerOverview(conversation: Conversation, scope: 'current' | 'all' = 'current'): WorkerOverview[] {
    return this.store.workers().filter(worker => worker.origin.userId === conversation.userId
      && worker.origin.channelId && (scope === 'all' || worker.origin.conversationId === conversation.id)).map(worker => {
      const jobs = this.store.jobs(worker.id); const active = jobs.find(job => job.status === 'running'); const latest = jobs.at(-1);
      const currentJob = active ?? latest;
      const queued = jobs.filter(job => job.status === 'queued').length;
      const status = worker.handoffPending || worker.adoption?.status === 'pending' ? 'handoff-pending'
        : worker.ownership === 'user' || worker.supersededBy ? 'handed-off' : worker.blocked ? 'uncertain'
        : active ? 'running' : queued ? 'queued' : latest?.status ?? 'idle';
      return { workerId: worker.id, conversationId: worker.origin.conversationId,
        ...(worker.origin.conversationId === conversation.id ? { conversationTitle: conversation.title } : {}),
        targetId: worker.target?.id ?? 'local', targetLabel: worker.target?.label ?? '本机', agent: worker.agent, title: worker.title,
        model: worker.actualModel, effort: worker.actualEffort ?? null, requestedEffort: worker.effort,
        effortConfiguration: worker.effortConfiguration ?? null, nativeId: worker.nativeId,
        blocked: worker.blocked === true, ownership: worker.ownership ?? 'bridge',
        ...(worker.handoffPending || worker.adoption?.status === 'pending' ? { statusReason: '交接或接管回执尚未确认' }
          : worker.supersededBy ? { statusReason: `已转交直属助手 ${worker.supersededBy}` }
          : latest?.cancelReason ? { statusReason: latest.cancelReason } : {}),
        lastResultPreview: latest?.result == null ? null : listText(latest.result, 180),
        unresolvedSupplements: this.store.supplements().filter(value => value.workerId === worker.id && ['pending', 'steering', 'uncertain'].includes(value.status)).length,
        status, running: !!active, queued, startedAt: currentJob?.startedAt ?? null,
        endedAt: currentJob && ['completed', 'failed', 'cancelled'].includes(currentJob.status) ? currentJob.updatedAt : null };
    });
  }
  private async workCountsChanged(): Promise<void> {
    const counts = this.getGlobalWorkCounts(); const signature = JSON.stringify(counts);
    if (signature === this.lastWorkCounts) return;
    this.lastWorkCounts = signature;
    try { await this.callbacks.onWorkCountsChanged?.(counts); } catch (error) { this.lastWorkCounts = undefined; this.error(error); }
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
  private scheduleScope(value: ControllerSchedule, origin: TaskOrigin): boolean {
    return value.origin.conversationId === origin.conversationId && value.origin.userId === origin.userId && value.origin.channelId === origin.channelId && pathKey(value.origin.cwd) === pathKey(origin.cwd);
  }
  private dueAt(args: Record<string, unknown>): string {
    if ((args.afterSeconds === undefined) === (args.dueAt === undefined)) throw new Error('必须且只能指定 afterSeconds 或带时区的 dueAt');
    const now = this.now(); let due: number;
    if (args.dueAt !== undefined) {
      const value = text(args.dueAt, '预约时间', 128);
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) throw new Error('dueAt 必须是带明确时区的 ISO 时间');
      due = Date.parse(value);
    } else {
      if (typeof args.afterSeconds !== 'number' || !Number.isFinite(args.afterSeconds)) throw new Error('afterSeconds 必须是有限数字');
      due = now + args.afterSeconds * 1000;
    }
    if (!Number.isFinite(due) || due - now < 1000 || due - now > 30 * 86400_000) throw new Error('预约时间必须在 1 秒至 30 天内');
    return new Date(due).toISOString();
  }
  private scheduleView(value: ControllerSchedule, details = false): unknown {
    const job = value.job ? this.store.getJob(value.job.id) : null;
    return { scheduleId: value.id, kind: value.kind, title: value.title, dueAt: value.dueAt, status: value.status,
      createdAt: value.createdAt, updatedAt: value.updatedAt, error: value.error ?? null,
      ...(value.worker ? { workerId: value.worker.id, jobId: value.job!.id, agent: value.worker.agent, model: value.worker.model,
        effort: value.worker.effort, targetId: value.worker.target?.id ?? 'local', cwd: value.worker.cwd, executionStatus: job?.status ?? 'not-started' } : {}),
      textPreview: listText(value.text, details ? 4096 : 256), textPreviewTruncated: value.text.length > (details ? 4096 : 256) };
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
    if (this.starting) return this.starting;
    if (this.started) return;
    const recovery = this.recoverStartup(); this.starting = recovery;
    try { await recovery; } finally { this.starting = undefined; }
  }
  private async recoverStartup(): Promise<void> {
    for (const value of this.store.schedules()) if (value.taskId) this.registry.migrateScheduleTask(value.taskId, value.kind);
    for (const worker of this.store.workers().filter(value => value.adoption?.status === 'pending' && this.config.allowedUserIds.includes(value.origin.userId))) {
      try { await this.completeAdoption(worker.id); } catch (error) { this.error(error); }
    }
    if (this.stopping || this.closed) return;
    await this.workCountsChanged();
    for (const supplement of this.store.supplements()) {
      if (!this.config.allowedUserIds.includes(supplement.origin.userId)) continue;
      if (supplement.status === 'pending' || supplement.status === 'steering') this.setSupplement(supplement,
        supplement.status === 'steering' ? 'uncertain' : 'not_delivered', '桥在补充期间重启；未自动重发。');
    }
    // Local interrupted work stays uncertain. A remote daemon follows the original dispatch only.
    for (const job of this.store.jobs().filter(job => job.status === 'running')) {
      if (!this.config.allowedUserIds.includes(job.origin.userId)) continue;
      const worker = this.store.getWorker(job.workerId)!;
      if (worker.target?.transport === 'ssh' && worker.ownership !== 'user' && !worker.handoffPending) this.launchJob(worker.id, job, true);
      else await this.finish(worker, job, 'uncertain', '桥在执行期间重启；该轮结果未知，未自动重做。请检查已发生的操作。');
    }
    // Completing the two SQLite journals cannot share a transaction. Reconcile a saved terminal
    // result before pumping queues so a crash between commits cannot leave a permanent count.
    for (const job of this.store.jobs().filter(job => !['queued', 'running'].includes(job.status) && job.taskId)) {
      if (!this.config.allowedUserIds.includes(job.origin.userId)) continue;
      const task = this.registry.getTask(job.taskId!);
      if (task && ['registered', 'running'].includes(task.status)) {
        await this.finish(this.store.getWorker(job.workerId)!, job, job.status, job.result ?? '子任务已结束，但没有保存结果正文。');
      }
    }
    for (const worker of this.store.workers()) {
      if (!this.config.allowedUserIds.includes(worker.origin.userId)) continue;
      if (!worker.blocked && this.store.jobs(worker.id).some(job => job.status === 'uncertain')) {
        worker.blocked = true; this.store.saveWorker(worker);
      }
    }
    if (this.stopping || this.closed) return;
    this.started = true;
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
    const platform = this.config.platform ?? null;
    const platformDocument = platform === 'feishu' ? '聊天平台/飞书.md' : platform === 'discord' ? '聊天平台/Discord.md' : null;
    const platformContext = '\n\n当前聊天平台（仅桥配置事实，不是新增授权）：' + JSON.stringify({
      platform, applicationId: this.config.applicationId ?? null, profile: this.config.profile ?? null, platformDocument,
    }) + '。按工作区入口明确的初始化范围读取对应平台文档，只提炼相关能力入口和边界；不要读取其他平台，不读取凭据，不联网检查。平台未知则如实报告，不从用户正文、显示名或历史记忆猜测。';
    return this.coalescedDispatch(turn, 'bridge_start_worker', { title: '工作区上下文', prompt: workspacePrompt + platformContext + new SessionHandoffs(this.config.dataDir).prompt(turn.conversation, this.origin(turn).channelId), imagePaths: [] }, undefined, true);
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
    if (this.isDraining() && ['bridge_start_worker', 'bridge_continue_worker', 'bridge_schedule_worker', 'bridge_schedule_controller', 'bridge_update_schedule', 'bridge_adopt_native_session'].includes(name)) throw new Error('桥正在安全重启，已暂停新派发；请在恢复后继续。');
    const contextOrigin = this.origin(turn);
    await this.start();
    this.origin(turn);
    if (turn.signal.aborted || this.closed || this.stopping) throw new Error('主控会话已停止或执行服务正在关闭');
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
      if (previous !== undefined) {
        if (name === 'bridge_adopt_native_session' && previous && typeof previous === 'object'
          && 'status' in previous && (previous.status === 'adopting' || previous.status === 'idle') && 'workerId' in previous && typeof previous.workerId === 'string') {
          const worker = this.store.getWorker(previous.workerId);
          if (!worker?.adoption) throw new Error('此前接管登记已失效，需重新查询会话');
          if (worker.origin.userId !== origin.userId || worker.origin.conversationId !== origin.conversationId || worker.origin.channelId !== origin.channelId) throw new Error('此前接管不属于当前父会话');
          return this.completeAdoption(previous.workerId);
        }
        return previous;
      }
    }
    if (name === 'bridge_list_native_sessions' || name === 'bridge_read_native_session') {
      const args = object(input, name === 'bridge_list_native_sessions'
        ? ['targetId', 'agent', 'cwd', 'cursor', 'limit', 'query'] : ['targetId', 'agent', 'nativeId', 'profile', 'limit']);
      const agent = this.nativeAgent(args.agent); const targetId = args.targetId === undefined ? 'local' : text(args.targetId, 'targetId', 256);
      const catalog = this.callbacks.targetCatalog;
      if (!catalog?.listNativeSessions || !catalog.readNativeSession) throw new Error('桥尚未配置原生会话管理服务');
      await this.authorizeNativeAccess(origin, targetId);
      const binding = await this.resolveTarget(origin.cwd, targetId, agent);
      const limit = args.limit === undefined ? name === 'bridge_list_native_sessions' ? 12 : 4 : args.limit;
      if (!Number.isSafeInteger(limit) || Number(limit) < 1 || Number(limit) > 20) throw new Error('limit 必须是 1–20 的整数');
      if (name === 'bridge_list_native_sessions') return { targetId, ...(await catalog.listNativeSessions(binding, origin.userId, {
        limit: Number(limit), ...(args.cwd === undefined ? {} : { cwd: text(args.cwd, 'cwd', 8192) }),
        ...(args.cursor === undefined ? {} : { cursor: text(args.cursor, 'cursor', 2048) }),
        ...(args.query === undefined ? {} : { query: text(args.query, 'query', 256) }),
      })) };
      return { targetId, ...(await catalog.readNativeSession(binding, origin.userId, this.nativeRef(args), { limit: Number(limit) })) };
    }
    if (name === 'bridge_adopt_native_session') {
      const args = object(input, ['targetId', 'agent', 'nativeId', 'profile', 'expectedRevision', 'title']);
      const ref = this.nativeRef(args); const targetId = args.targetId === undefined ? 'local' : text(args.targetId, 'targetId', 256);
      const expectedRevision = text(args.expectedRevision, 'expectedRevision', 256);
      const catalog = this.callbacks.targetCatalog;
      if (!catalog?.readNativeSession || !catalog.adoptNativeSession) throw new Error('桥尚未配置原生会话管理服务');
      await this.authorizeNativeAccess(origin, targetId);
      const binding = await this.resolveTarget(origin.cwd, targetId, ref.agent);
      if (targetId === 'local' && ref.agent === origin.agent && ref.nativeId === origin.nativeId) throw new Error('主控不能把自己登记为执行子 Agent');
      const pending = this.store.workers().find(worker => worker.agent === ref.agent && (worker.target?.id ?? 'local') === targetId
        && worker.nativeId === ref.nativeId && worker.origin.userId === origin.userId && worker.adoption?.status === 'pending');
      if (pending) {
        if (pending.origin.conversationId !== origin.conversationId || pending.origin.channelId !== origin.channelId) throw new Error('此会话正在其他父会话中接管，请先核对该次接管结果');
        if (pending.adoption!.expectedRevision !== expectedRevision) throw new Error('待确认接管的版本与请求不一致，请先查询原接管结果');
        const result = await this.completeAdoption(pending.id); if (key) this.store.saveCall(key, fingerprint, result); return result;
      }
      const candidate = await catalog.readNativeSession(binding, origin.userId, ref, { limit: 1 });
      if (candidate.nativeId !== ref.nativeId || candidate.ref.agent !== ref.agent || candidate.ref.profile !== ref.profile) throw new Error('原生会话身份与请求不一致');
      if (candidate.revision !== expectedRevision) throw new Error('会话在检查后发生变化，请重新核实状态');
      if (candidate.health !== 'healthy') throw new Error(`原生会话尚不能接管：${candidate.reason ?? candidate.health}`);
      const previous = this.store.workers().filter(worker => worker.agent === ref.agent && (worker.target?.id ?? 'local') === targetId
        && worker.nativeId === ref.nativeId && !worker.supersededBy);
      for (const worker of previous) {
        if (worker.origin.userId !== origin.userId) throw new Error('此会话由其他用户持有，不能接管');
        if (worker.blocked || worker.handoffPending || worker.adoption?.status === 'pending' || this.active.has(worker.id)
          || this.store.jobs(worker.id).some(job => ['queued', 'running', 'uncertain'].includes(job.status))) throw new Error('原会话仍忙碌或停止状态未确认，不能接管');
      }
      const existing = previous.find(worker => worker.origin.conversationId === origin.conversationId && worker.origin.channelId === origin.channelId && worker.ownership !== 'user');
      if (existing) {
        const result = this.adoptionResult(existing); if (key) this.store.saveCall(key, fingerprint, result); return result;
      }
      const worker: ControllerWorker = { id: randomUUID(), origin, agent: ref.agent, nativeId: ref.nativeId,
        cwd: candidate.cwd, title: args.title === undefined ? candidate.title : text(args.title, 'title', 1024),
        model: candidate.model, actualModel: candidate.actualModel ?? candidate.model, effort: candidate.effort, actualEffort: candidate.effort,
        target: { ...binding, cwd: candidate.cwd }, ownership: 'bridge', imagePaths: [], wakeAllowed: true, blocked: true,
        createdAt: this.timestamp(), updatedAt: this.timestamp(), adoption: { id: randomUUID(), ref, expectedRevision,
          status: 'pending', previousWorkers: previous.map(value => value.id), ...(key ? { callKey: key } : {}) } };
      this.store.transaction(() => {
        for (const prior of previous) {
          const current = this.store.getWorker(prior.id)!;
          if (current.handoffPending || current.blocked || this.active.has(prior.id) || this.store.jobs(prior.id).some(job => ['queued', 'running', 'uncertain'].includes(job.status))) throw new Error('原持有者在交接准备期间开始了工作');
          current.handoffPending = true; this.store.saveWorker(current);
        }
        this.store.addWorker(worker);
        if (key) this.store.saveCall(key, fingerprint, { workerId: worker.id, status: 'adopting', nativeId: ref.nativeId, targetId });
      });
      return this.completeAdoption(worker.id);
    }
    if (name === 'bridge_check_capabilities') {
      const args = object(input, ['targetId', 'agent', 'capabilityId', 'refresh']);
      if (args.agent !== undefined && args.agent !== 'codex' && args.agent !== 'claude') throw new Error('agent 必须是 codex 或 claude');
      if (args.refresh !== undefined && typeof args.refresh !== 'boolean') throw new Error('refresh 必须是布尔值');
      if (!this.callbacks.onCheckCapabilities) throw new Error('桥尚未配置能力体检服务');
      // Read-only probes must reflect current readiness, never a historical call journal.
      return this.callbacks.onCheckCapabilities(turn.conversation.cwd, {
        ...(args.targetId === undefined ? {} : { targetId: text(args.targetId, 'targetId', 256) }),
        ...(args.agent === undefined ? {} : { agent: args.agent }),
        ...(args.capabilityId === undefined ? {} : { capabilityId: text(args.capabilityId, 'capabilityId', 256) }),
        ...(args.refresh === undefined ? {} : { refresh: args.refresh }),
      });
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
      await this.workCountsChanged();
      const result = { workerId: worker.id, status: stopped ? 'cancelled' : 'uncertain', stopped, scope, target: worker.target ?? null, nativeId: worker.nativeId,
        remoteEffects: '远端自行启动的后台进程或已发生的改动需要另行核对' };
      if (key) this.store.updateCall(key, result);
      return result;
    }
    if (name === 'bridge_continue_worker') {
      const args = object(input, ['workerId', 'prompt', 'imagePaths', 'delivery', 'model', 'effort']);
      if (args.delivery !== undefined && args.delivery !== 'current' && args.delivery !== 'next') throw new Error('delivery 必须是 current 或 next');
      const worker = this.ownedWorker(origin, args.workerId);
      this.assertBridgeOwnership(worker);
      if (worker.blocked) throw new Error('此子 Agent 上一轮结果未知，已暂停；不能自动续接旧原生会话。请新起核查子 Agent，确认进程及已发生的操作。旧任务不会自动重做。');
      const images = this.images(turn, args.imagePaths, worker);
      const prompt = text(args.prompt, '任务内容', 128 * 1024);
      const active = this.active.get(worker.id);
      const unsettled = active && this.store.getJob(active.job.id)?.status === 'running';
      // A subsequent queued round inherits the latest queued selection; a current-round supplement uses the active selection.
      const inherited = args.delivery === 'next' || !unsettled ? this.store.jobs(worker.id).filter(job => job.status === 'queued').at(-1)?.execution : undefined;
      const execution = { model: args.model === 'default' ? await this.defaultWorkerModel(turn, worker.agent)
          : this.selectedWorkerModel(args.model, inherited?.model === undefined ? worker.model : inherited.model),
        effort: this.selectedWorkerEffort(args.effort, worker.agent, inherited?.effort === undefined ? worker.effort : inherited.effort),
        ...((args.model === undefined && (inherited ? inherited.modelPolicy : worker.modelPolicy) === 'cli-default') ? { modelPolicy: 'cli-default' as const } : {}) };
      // Resolving an unconfigured bridge default may await local metadata. Do not act on an obsolete worker/turn.
      this.origin(turn);
      const afterSelection = this.ownedWorker(origin, worker.id);
      this.assertBridgeOwnership(afterSelection);
      if (afterSelection.blocked || afterSelection.model !== worker.model || afterSelection.effort !== worker.effort
        || afterSelection.modelPolicy !== worker.modelPolicy || this.active.get(worker.id) !== active
        || Boolean(active && this.store.getJob(active.job.id)?.status === 'running') !== Boolean(unsettled)) {
        throw new Error('确定默认模型期间子 Agent 状态已改变，本次未发送或排队；请核对后重试。');
      }
      if (unsettled && args.delivery !== 'next' && (execution.model !== worker.model || execution.effort !== worker.effort || execution.modelPolicy !== worker.modelPolicy)) throw new Error('运行中的 Agent 不能在当前轮切换模型或强度；请用 delivery=next 为下一轮设置参数。');
      if (unsettled && args.delivery !== 'next') {
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
      const queueBefore = this.store.jobs(worker.id).filter(job => job.status === 'queued').map(job => [job.id, job.execution]);
      await this.validateWorkerSelection(worker, execution);
      this.origin(turn);
      const latest = this.ownedWorker(origin, worker.id);
      this.assertBridgeOwnership(latest);
      const currentActive = this.active.get(worker.id);
      if (this.closed || this.stopping || this.isDraining() || latest.blocked || (currentActive !== active && !(active && !unsettled && !currentActive))
        || latest.model !== worker.model || latest.effort !== worker.effort || latest.modelPolicy !== worker.modelPolicy
        || canonical(this.store.jobs(worker.id).filter(job => job.status === 'queued').map(job => [job.id, job.execution])) !== canonical(queueBefore)) {
        throw new Error('校验期间子会话或队列状态已改变，未排队；请按当前状态重试。');
      }
      const job = this.makeJob(latest, origin, prompt, images, execution);
      const result = { workerId: worker.id, jobId: job.id, status: 'queued', delivery: 'next', nativeId: worker.nativeId,
        agent: worker.agent, model: execution.model, effort: execution.effort, target: worker.target ?? null, ownership: worker.ownership ?? 'bridge' };
      this.store.transaction(() => {
        latest.imagePaths = [...new Set([...latest.imagePaths, ...images])]; latest.updatedAt = this.timestamp();
        this.store.saveWorker(latest); this.store.addJob(job); if (key) this.store.saveCall(key, fingerprint, result);
      });
      if (!this.started) await this.start();
      this.kick(worker.id);
      await this.workCountsChanged();
      return result;
    }
    if (['bridge_list_schedules', 'bridge_cancel_schedule', 'bridge_update_schedule'].includes(name)) {
      const args = object(input, name === 'bridge_list_schedules' ? ['scheduleId', 'includeFinished', 'limit', 'offset']
        : name === 'bridge_cancel_schedule' ? ['scheduleId'] : ['scheduleId', 'afterSeconds', 'dueAt']);
      if (args.includeFinished !== undefined && typeof args.includeFinished !== 'boolean') throw new Error('includeFinished 必须是布尔值');
      const id = args.scheduleId === undefined ? undefined : text(args.scheduleId, 'scheduleId', 256);
      const value = id ? this.store.getSchedule(id) : null;
      if (id && (!value || !this.scheduleScope(value, origin))) throw new Error('计划不属于当前用户、父会话、聊天入口和工作区');
      const limit = args.limit ?? 20, offset = args.offset ?? 0;
      if (!Number.isSafeInteger(limit) || Number(limit) < 1 || Number(limit) > 100 || !Number.isSafeInteger(offset) || Number(offset) < 0) throw new Error('计划分页参数无效');
      let result: unknown;
      this.store.transaction(() => {
        if (name === 'bridge_list_schedules') {
          const all = this.store.schedules().filter(value => this.scheduleScope(value, origin)
            && (args.includeFinished || ['pending', 'dispatching', 'running'].includes(value.status)));
          result = { schedules: value ? [this.scheduleView(value, true)] : all.slice(Number(offset), Number(offset) + Number(limit)).map(value => this.scheduleView(value)),
            total: value ? 1 : all.length, nextOffset: !value && all.length > Number(offset) + Number(limit) ? Number(offset) + Number(limit) : null };
        }
        else {
          if (!value) throw new Error('必须指定 scheduleId');
          if (name === 'bridge_cancel_schedule' && value.status === 'cancelled') result = this.scheduleView(value);
          else {
            if (value.status !== 'pending') throw new Error(`计划已${value.status}，不能取消或改期；运行中的助手请使用 bridge_cancel_worker`);
            if (name === 'bridge_cancel_schedule') value.status = 'cancelled'; else value.dueAt = this.dueAt(args);
            value.updatedAt = this.timestamp(); this.store.saveSchedule(value); result = this.scheduleView(value);
          }
        }
        if (key) this.store.saveCall(key, fingerprint, result);
      });
      return result;
    }
    let target: ExecutionTargetBinding | undefined;
    let preparedWorker: ControllerWorker | undefined;
    if (name === 'bridge_start_worker' || name === 'bridge_schedule_worker') {
      const args = object(input, ['title', 'prompt', 'cwd', 'agent', 'model', 'effort', 'imagePaths', 'targetId', ...(name === 'bridge_schedule_worker' ? ['afterSeconds', 'dueAt'] : [])]);
      const agent = args.agent === undefined ? turn.conversation.agent : args.agent;
      if (agent !== 'codex' && agent !== 'claude') throw new Error('agent 必须是 codex 或 claude');
      target = await this.resolveTarget(turn.conversation.cwd, args.targetId === undefined ? 'local' : text(args.targetId, '执行目标', 256), agent,
        args.cwd === undefined ? undefined : text(args.cwd, '工作目录', 8192));
      if (target.agent !== agent || target.id !== (args.targetId ?? 'local')) throw new Error('执行目标服务返回的电脑或引擎与请求不一致');
      if (target.transport === 'local' && (!isAbsolute(target.cwd) || /[\r\n]/.test(target.cwd) || !statSync(target.cwd).isDirectory())) throw new Error('工作目录必须是本机已有目录的绝对路径');
      const model = args.model === undefined || args.model === 'default' ? await this.defaultWorkerModel(turn, agent) : this.selectedWorkerModel(args.model, null);
      const effort = this.selectedWorkerEffort(args.effort, agent, agent === turn.conversation.agent
        ? turn.effort ?? turn.conversation.effort ?? turn.conversation.actualEffort ?? null : null);
      preparedWorker = { id: randomUUID(), origin, agent, model, actualModel: null, target, ownership: 'bridge',
        effort, cwd: target.cwd, title: text(args.title, '任务名称', 1024), nativeId: null,
        imagePaths: this.images(turn, args.imagePaths), wakeAllowed: true, blocked: false,
        createdAt: this.timestamp(), updatedAt: this.timestamp() };
      text(args.prompt, '任务内容', 128 * 1024);
      await this.validateWorkerSelection(preparedWorker);
      this.origin(turn);
      if (turn.signal.aborted || this.closed || this.stopping || this.isDraining()) throw new Error('桥正在关闭或会话已停止，已暂停派发');
    }
    let workerToStart: string | undefined;
    const result = this.store.transaction(() => {
      let result: unknown;
      if (name === 'bridge_start_worker' || name === 'bridge_schedule_worker') {
        const args = object(input, ['title', 'prompt', 'cwd', 'agent', 'model', 'effort', 'imagePaths', 'targetId', ...(name === 'bridge_schedule_worker' ? ['afterSeconds', 'dueAt'] : [])]);
        const worker = preparedWorker!;
        const job = this.makeJob(worker, origin, text(args.prompt, '任务内容', 128 * 1024), worker.imagePaths);
        if (name === 'bridge_schedule_worker') {
          const scheduledOrigin: TaskOrigin = { ...origin, purpose: 'schedule', scheduleKind: 'worker' };
          worker.origin = scheduledOrigin; job.origin = scheduledOrigin;
          const value: ControllerSchedule = { id: randomUUID(), kind: 'worker', origin: scheduledOrigin, title: worker.title,
            text: job.prompt, dueAt: this.dueAt(args), status: 'pending', taskId: null, worker, job,
            createdAt: this.timestamp(), updatedAt: this.timestamp() };
          job.scheduleId = value.id; this.store.addSchedule(value); result = this.scheduleView(value, true);
        } else {
          this.store.addWorker(worker); this.store.addJob(job); workerToStart = worker.id;
          result = { workerId: worker.id, jobId: job.id, status: 'queued', agent: worker.agent, model: worker.model, effort: worker.effort, nativeId: worker.nativeId, target: worker.target, ownership: worker.ownership };
        }
      } else if (name === 'bridge_schedule_controller') {
        const args = object(input, ['afterSeconds', 'dueAt', 'title', 'text']);
        const value: ControllerSchedule = { id: randomUUID(), kind: 'controller', origin: { ...origin, purpose: 'schedule', scheduleKind: 'controller' },
          title: args.title === undefined ? '主控自唤醒' : text(args.title, '计划名称', 1024), text: text(args.text, '唤醒提示', 16 * 1024),
          dueAt: this.dueAt(args), status: 'pending', taskId: null, createdAt: this.timestamp(), updatedAt: this.timestamp() };
        this.store.addSchedule(value); result = this.scheduleView(value, true);
      } else {
        const args = object(input, ['workerId']);
        const details = args.workerId !== undefined;
        const workers = details ? [this.ownedWorker(origin, args.workerId)] : this.store.workers()
          .filter(worker => worker.origin.userId === origin.userId && worker.origin.channelId === origin.channelId
            && worker.origin.conversationId === origin.conversationId);
        let previewBytes = 8 * 1024;
        const preview = (value: string): string => {
          const result = listText(value, 256, previewBytes); previewBytes -= Buffer.byteLength(result, 'utf8'); return result;
        };
        result = { workers: workers.map(worker => {
          const jobs = this.store.jobs(worker.id); const latest = jobs.at(-1);
          const currentJob = jobs.find(job => job.status === 'running') ?? latest;
          const progress = currentJob?.progress;
          const progressSummary = { observed: !!progress, stage: progress?.stage ?? 'unobserved', jobId: currentJob?.id ?? null,
            lastActivityAt: progress?.lastActivity.at ?? null, activeToolCount: progress?.activeTools.length ?? null,
            oldestToolStartedAt: progress?.activeTools.map(tool => tool.startedAt).sort()[0] ?? null,
            stallNotices: currentJob?.stallNotices?.length ?? 0 };
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
            effort: worker.effort, actualEffort: worker.actualEffort ?? null, effortConfiguration: worker.effortConfiguration ?? null, nativeId: worker.nativeId, cwd: worker.cwd, running: jobs.some(job => job.status === 'running'),
            queued: jobs.filter(job => job.status === 'queued').length, blocked: worker.blocked === true,
            lastStatus: worker.blocked ? 'uncertain' : latest?.status ?? 'idle', lastJobId: latest?.id ?? null,
            startedAt: currentJob?.startedAt ?? null,
            progress: details ? { ...progressSummary, lastActivity: progress?.lastActivity ?? null, lastTool: progress?.lastTool ?? null, activeTools: progress?.activeTools ?? [] } : progressSummary,
            hasResult: latest?.result != null, lastResultPreview,
            lastResultPreviewTruncated: latest?.result != null && lastResultPreview !== latest.result, supplementCounts,
            ...(details ? { lastResult: latest?.result == null ? null : listText(latest.result, 4096),
              lastResultTruncated: (latest?.result?.length ?? 0) > 4096, activeSupplements: active.map(receipt),
              supplements: history.slice(-20).map(receipt), supplementsTotal: supplements.length,
              supplementsTruncated: history.length > 20 } : {}) };
        }), schedules: details ? [] : this.store.schedules().filter(value => this.scheduleScope(value, origin) && value.status === 'pending')
          .map(value => { const textPreview = preview(value.text); return { scheduleId: value.id, kind: value.kind, dueAt: value.dueAt, textPreview, textPreviewTruncated: textPreview !== value.text }; }) };
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
  private makeJob(worker: ControllerWorker, origin: TaskOrigin, prompt: string, imagePaths: string[], execution: ControllerJob['execution'] = { model: worker.model, effort: worker.effort, ...worker.modelPolicy ? { modelPolicy: worker.modelPolicy } : {} }): ControllerJob {
    return { id: randomUUID(), workerId: worker.id, origin, prompt, imagePaths, status: 'queued', taskId: null, result: null,
      cancelReason: null, wakeAllowed: true, execution, createdAt: this.timestamp(), updatedAt: this.timestamp() };
  }
  private kick(workerId: string): void {
    if (!this.started || this.stopping || this.closed || this.isDraining() || this.active.has(workerId) || this.store.getWorker(workerId)?.blocked || !this.store.nextJob(workerId)) return;
    const worker = this.store.getWorker(workerId)!;
    if (!this.config.allowedUserIds.includes(worker.origin.userId)) return;
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
    if (this.store.workers().some(other => other.id !== worker.id && other.agent === worker.agent && (other.target?.id ?? 'local') === (worker.target?.id ?? 'local') && other.nativeId === value && (!(worker.adoption?.status === 'adopted') || (other.ownership !== 'user' && !other.supersededBy)))) throw new Error('不同子 Agent 返回了相同原生会话编号');
    stored.nativeId = value; stored.updatedAt = this.timestamp(); this.store.saveWorker(stored);
    worker.nativeId = value;
  }
  private async execute(workerId: string, state: ActiveWorker): Promise<void> {
    let worker = this.store.getWorker(workerId)!;
    let job = this.store.getJob(state.job.id)!;
    if (job.status !== (state.recovering ? 'running' : 'queued') || this.stopping) { await this.settleSupplements(state); return; }
    if (!state.recovering) this.store.setJob(job.id, 'running', { startedAt: this.timestamp() });
    await this.workCountsChanged();
    try {
      this.assertBridgeOwnership(worker);
      if (!state.recovering) {
        // Recheck dynamic metadata before applying the queued selection to the worker.
        await this.validateWorkerSelection(worker, job.execution);
        worker = this.store.getWorker(workerId)!;
        this.assertBridgeOwnership(worker);
        if (worker.blocked || state.abort.signal.aborted) throw new Error('子 Agent 已暂停或正在停止，本轮未提交。');
        if (job.execution) {
          if (worker.model !== job.execution.model) worker.actualModel = null;
          if (worker.effort !== job.execution.effort || worker.model !== job.execution.model) worker.actualEffort = null;
          worker.model = job.execution.model; worker.effort = job.execution.effort;
          if (job.execution.modelPolicy) worker.modelPolicy = job.execution.modelPolicy; else delete worker.modelPolicy;
          this.store.saveWorker(worker);
        }
      }
      if (!state.recovering) { worker.actualEffort = null; worker.effortConfiguration = null; this.store.saveWorker(worker); }
      if (!job.taskId) this.register(worker, job);
      job = this.store.getJob(job.id)!; state.job = job;
      const conversation: Conversation = { id: worker.id, userId: worker.origin.userId, agent: worker.agent, nativeId: worker.nativeId,
        model: worker.model, ...worker.modelPolicy ? { modelPolicy: worker.modelPolicy } : {}, actualModel: worker.actualModel, effort: worker.effort, actualEffort: worker.actualEffort ?? null, title: worker.title, cwd: worker.cwd,
        createdAt: worker.createdAt, updatedAt: this.timestamp() };
      const turn: AgentTurn = { conversation, text: (job.origin.purpose === 'workspace-context' ? workspaceWorkerInstruction : workerInstruction) + job.prompt, imagePaths: job.imagePaths,
        ...(worker.effort ? { effort: worker.effort } : {}), signal: state.abort.signal, onProgress: () => {}, acceptSupplements: true, dispatchId: job.id, recovering: state.recovering === true,
        onReady: () => { state.ready = true; this.pumpSupplements(workerId, state); },
        onActivity: activity => {
          if (!state.executing || state.abort.signal.aborted) return;
          const current = this.store.getJob(job.id); if (!current || current.status !== 'running') return;
          const progress = observeActivity(current.progress, activity);
          if (progress && progress !== current.progress) this.store.saveJobProgress(job.id, progress);
        },
        onNativeId: nativeId => this.nativeId(worker, nativeId),
        onModel: actualModel => { const current = this.store.getWorker(worker.id)!; current.actualModel = actualModel; this.store.saveWorker(current); },
        onReasoningEffort: effort => { const current = this.store.getWorker(worker.id)!; current.actualEffort = effort; this.store.saveWorker(current); },
        onEffortConfiguration: configuration => { const current = this.store.getWorker(worker.id)!; current.effortConfiguration = configuration; this.store.saveWorker(current); } };
      // No taskContextPath: the worker is already registered by this service.
      const adapter = this.adapter(worker);
      const prepared = await resolveDefaultModel(adapter, turn);
      const running = adapter.run(prepared);
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
    await this.workCountsChanged();
  }
  private async notify(taskId: string): Promise<void> {
    const event = this.registry.queuedEvents().find(event => event.taskId === taskId);
    if (event) try { await this.callbacks.onCompletion?.(event); } catch (error) { this.error(error); }
  }
  private async finish(worker: ControllerWorker, job: ControllerJob, status: ControllerJob['status'], result: string): Promise<void> {
    let taskId = job.taskId;
    // A crash before task registration still needs one durable failure routed to the original parent.
    if (!taskId) taskId = this.register(worker, job);
    if (job.origin.purpose === 'workspace-context') {
      const handoffs = new SessionHandoffs(this.config.dataDir);
      const owner = { id: job.origin.conversationId, userId: job.origin.userId, cwd: job.origin.cwd };
      try {
        if (status === 'completed') result = handoffs.finish(owner, job.origin.channelId, result);
        else handoffs.fail(owner, job.origin.channelId, result);
      } catch (error) {
        status = 'failed'; result = `会话交接未完成：${error instanceof Error ? error.message : String(error)}`;
        try { handoffs.fail(owner, job.origin.channelId, result); } catch (failure) { this.error(failure); }
      }
    }
    const supplements = this.store.supplements(job.id);
    if (supplements.length) result += '\n\n当前轮补充接收记录：\n' + supplements.map(value => `${value.id}: ${value.status}${value.reason ? ` · ${value.reason}` : ''}`).join('\n');
    this.store.transaction(() => {
      this.store.setJob(job.id, status, { taskId, result });
      const plan = job.scheduleId ? this.store.getSchedule(job.scheduleId) : null;
      if (plan) { plan.status = status as ControllerSchedule['status']; plan.taskId = taskId;
        plan.updatedAt = this.timestamp(); if (status === 'failed' || status === 'uncertain') plan.error = listText(result, 1024);
        this.store.saveSchedule(plan); }
    });
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
      if (job.status === 'queued') {
        this.store.setJob(job.id, 'cancelled', { result: reason, cancelReason: reason });
        const plan = job.scheduleId ? this.store.getSchedule(job.scheduleId) : null;
        if (plan) { plan.status = 'cancelled'; plan.updatedAt = this.timestamp(); this.store.saveSchedule(plan); }
      }
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
  private detachJobs(conversationId: string): ControllerWorker[] {
    const workers = this.store.workers(conversationId);
    // All reset effects are durable before the first await, including a due-but-unclaimed plan.
    for (const plan of this.store.schedules()) if (plan.origin.conversationId === conversationId && ['pending', 'dispatching'].includes(plan.status)) {
      plan.status = 'cancelled'; plan.updatedAt = this.timestamp(); this.store.saveSchedule(plan);
      if (plan.taskId) this.registry.disableTaskWake(plan.taskId);
    }
    for (const worker of workers) for (const job of this.store.jobs(worker.id)) if (['queued', 'running'].includes(job.status)) {
      this.store.setJob(job.id, job.status, { wakeAllowed: false });
      if (job.taskId) this.registry.disableTaskWake(job.taskId);
    }
    this.registry.cancelConversation(conversationId);
    return workers;
  }
  private async terminateWorkers(workers: ControllerWorker[], reason: string): Promise<void> {
    const owned = workers.filter(worker => worker.ownership !== 'user');
    for (const worker of owned) this.requestCancellation(worker.id, reason);
    const stopped = await Promise.all(owned.map(worker => this.stopWorker(worker.id, reason)));
    if (stopped.some(result => result === false)) {
      throw Object.assign(new Error('部分执行子 Agent 的进程停止尚未确认，不能宣称全部停止；请核对未知任务。'),
        { name: 'AgentProcessStopError', processStillRunning: true });
    }
  }
  /** Reset cancels every plan and stops scheduled workers; ordinary engineering jobs retain their original result route. */
  async detachConversation(conversationId: string): Promise<void> {
    const workers = this.detachJobs(conversationId);
    await this.terminateWorkers(workers.filter(worker => worker.origin.purpose === 'schedule'), '新会话或切换会话已取消定时任务');
  }
  /** /stop also terminates ordinary bridge-owned engineering workers. */
  async cancelConversation(conversationId: string): Promise<void> {
    const workers = this.detachJobs(conversationId);
    await this.terminateWorkers(workers, '用户停止了父会话');
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
  private async observeStalls(): Promise<void> {
    if (!this.callbacks.onStall) return;
    const threshold = this.callbacks.stallAfterMs ?? 10 * 60_000;
    for (const [workerId, state] of this.active) {
      if (!state.executing || state.abort.signal.aborted || state.cancelReason || state.closing) continue;
      const worker = this.store.getWorker(workerId); const job = this.store.getJob(state.job.id);
      if (!worker || !job || job.status !== 'running' || job.cancelReason || (job.wakeAllowed ?? worker.wakeAllowed) === false
        || worker.ownership === 'user' || worker.handoffPending) continue;
      for (const tool of job.progress?.activeTools ?? []) {
        const waitingMs = this.now() - Date.parse(tool.startedAt); const key = `${tool.itemId}:${tool.startedAt}`;
        if (!Number.isFinite(waitingMs) || waitingMs < threshold || job.stallNotices?.includes(key)) continue;
        try {
          const observationKey = `worker-stall:${job.id}:${key}`;
          await this.callbacks.onStall({ id: observationKey, observationKey, taskId: job.taskId, origin: job.origin, workerId, jobId: job.id,
            targetId: worker.target?.id ?? 'local', tool, observedAt: this.timestamp(), waitingMs });
          this.store.markToolStall(job.id, key);
        }
        catch (error) { this.error(error); }
      }
    }
  }
  async poll(): Promise<void> {
    if (this.closed || this.stopping) return;
    await this.confirmUncertainStops();
    if (this.closed || this.stopping || this.isDraining()) return;
    await this.observeStalls();
    for (const candidate of this.store.schedules()) {
      const plan = this.store.getSchedule(candidate.id)!;
      if (!this.config.allowedUserIds.includes(plan.origin.userId)
        || !['pending', 'dispatching'].includes(plan.status) || Date.parse(plan.dueAt) > this.now()) continue;
      if (plan.kind === 'worker') {
        // Worker creation and enqueue share the same durable transaction as the due claim.
        // A crash before kick is resumed from the queue, never by creating a second worker.
        this.store.transaction(() => {
          const worker = plan.worker!, job = plan.job!;
          this.store.addWorker(worker); this.store.addJob(job);
          plan.status = 'running'; plan.updatedAt = this.timestamp(); this.store.saveSchedule(plan);
        });
        this.kick(plan.worker!.id);
        continue;
      }
      let taskId = plan.taskId;
      if (!taskId) {
        const created = this.registry.createContext(plan.origin);
        try {
          const context = JSON.parse(readFileSync(created.contextPath, 'utf8')) as TaskContextFile;
          taskId = this.registry.register(context, `定时自唤醒 · ${plan.title}`, plan.id).taskId;
          plan.status = 'dispatching'; plan.taskId = taskId; plan.updatedAt = this.timestamp(); this.store.saveSchedule(plan);
        } finally { this.registry.closeContext(created.contextId); }
      }
      const changed = this.registry.acceptObservedResult(taskId, 'completed', `这是主控此前登记的自唤醒计划。\nscheduleId: ${plan.id}\n计划时间: ${plan.dueAt}\n原用户消息: ${plan.origin.originMessageId}\n唤醒提示: ${plan.text}`, plan.text);
      plan.status = 'triggered'; plan.updatedAt = this.timestamp(); this.store.saveSchedule(plan);
      // register + complete are synchronous: a sleeping alarm never appears as a running agent.
      if (changed) await this.notify(taskId);
    }
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.stopping = true; clearTimeout(this.timer);
    await this.starting;
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
