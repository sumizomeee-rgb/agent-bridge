import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { agentEnvironment, prepareConfigPaths, safeError } from '../config.js';
import { CodexAdapter } from '../agents/codex.js';
import { ClaudeAdapter } from '../agents/claude.js';
import { SessionManager, type SessionManagerOptions } from '../manager.js';
import { createControllerAdapter } from './launch.js';
import { ExternalControllerAdapter } from './external.js';
import { PresetRuntime } from '../presets/runtime.js';
import { workspaceFile } from '../workspace-layout.js';
import { ControllerRuntime } from './runtime.js';
import { TaskRegistry, TaskService, type TaskCompletionEvent, type TaskContextFile } from '../tasks.js';
import { TargetCatalogService } from '../remote/catalog.js';
import { CapabilityHealthService } from '../capabilities.js';
import { closeResources } from '../shutdown.js';
import type { ControllerSchedule, ControllerTargetCatalog } from './runtime-types.js';
import { knowledgeToolNames } from '../controller-knowledge.js';
import { controllerFileToolNames } from './files.js';
import type { AgentAdapter, AgentName, ControllerAgentName, AgentTurn, BridgeConfig, ReplySink } from '../types.js';
import type { RestartOrigin } from '../restart.js';
import type { WorkCounts } from '../overview.js';
import { HousekeeperService } from '../housekeeper/service.js';

export interface ControllerCoreHooks {
  executorDirectory?: () => { id: string; recipients: import('../executor-messages.js').ExecutorRecipient[] };
  authorize(userId: string, text: string): boolean;
  manager: Pick<SessionManagerOptions, 'binding' | 'onGroupTurnStart' | 'onSceneCheck' | 'onGroupTurnError' | 'onGroupTurnFinished' | 'onGroupSilent' | 'onControllerPublish' | 'onGroupPublish' | 'onGroupCompletion' | 'onInitializationState'> & { binding: NonNullable<SessionManagerOptions['binding']> };
  invoke(turn: AgentTurn, name: string, input: Record<string, unknown>, callId: string | undefined, delegate: (input: Record<string, unknown>) => Promise<unknown>): Promise<unknown>;
  prepareScheduledMessage?: (turn: AgentTurn, targetId: string) => Promise<NonNullable<ControllerSchedule['message']>>;
  sendScheduledMessage?: (plan: ControllerSchedule) => Promise<void>;
  scheduledMessageDelivered?: (id: string) => boolean;
  canSendScheduledMessage?: () => boolean;
  pauseGroup(): void;
  resumeGroup(): void;
  requestRestart(origin: RestartOrigin): Promise<unknown>;
  isDraining(): boolean;
  onExecutionSettled?(): void;
  log?(message: string): void;
}
export interface ControllerCoreDelivery extends ReplySink {
  isReady?(): boolean;
  setWorkCounts?(counts: WorkCounts): void;
}
type ExecutionAdapters = Record<AgentName, AgentAdapter>;
type ToolInvoker = (turn: AgentTurn, name: string, args: Record<string, unknown>, id?: string) => Promise<unknown>;
export type CoreTargetCatalog = ControllerTargetCatalog & Pick<TargetCatalogService, 'computerOverview' | 'close'>;
export interface ControllerCoreDependencies {
  createExecutorMessages?: () => import('../executor-messages.js').ExecutorMessages;
  createExecutionAdapters?: (config: BridgeConfig, env: NodeJS.ProcessEnv) => ExecutionAdapters;
  createControllerAdapters?: (config: BridgeConfig, env: NodeJS.ProcessEnv, execution: ExecutionAdapters, invoke: ToolInvoker) => ExecutionAdapters;
  createExternalAdapter?: (config: BridgeConfig, invoke: ToolInvoker) => AgentAdapter;
  createTargetCatalog?: (config: BridgeConfig, execution: ExecutionAdapters) => CoreTargetCatalog;
  createHealth?: (config: BridgeConfig) => Pick<CapabilityHealthService, 'refresh' | 'query' | 'startupSummary'>;
}

/** Owns controller execution and durable work independently of any chat channel. */
export class ControllerCore {
  readonly manager: SessionManager;
  readonly controller?: ControllerRuntime;
  readonly tasks: TaskRegistry;
  readonly housekeeper?: HousekeeperService;
  private readonly targetCatalog: CoreTargetCatalog;
  private readonly execution: ExecutionAdapters;
  private readonly controllerAdapters: Record<ControllerAgentName, AgentAdapter>;
  private readonly taskService: TaskService;
  private readonly health: Pick<CapabilityHealthService, 'refresh' | 'query' | 'startupSummary'>;
  private readonly secrets: string[] = [];
  private ready = false;
  private closed = false;
  private recoveryPromise?: Promise<void>;
  private startPromise?: Promise<void>;
  private closePromise?: Promise<void>;
  constructor(readonly config: BridgeConfig, private readonly hooks: ControllerCoreHooks,
    private readonly delivery?: ControllerCoreDelivery, dependencies: ControllerCoreDependencies = {}) {
    if(!hooks.manager.binding)throw new Error('ControllerCore 必须使用已登记主控的会话绑定。');
    if(config.controllerUserId){config={...config,allowedUserIds:[config.controllerUserId]};this.config=config;}
    prepareConfigPaths(config);
    const env=agentEnvironment(config);
    this.tasks=new TaskRegistry(config.dataDir);
    this.execution=dependencies.createExecutionAdapters?.(config,env) ?? {codex:new CodexAdapter(config.commands.codex,env),claude:new ClaudeAdapter(config.commands.claude,env)};
    this.targetCatalog=dependencies.createTargetCatalog?.(config,this.execution) ?? new TargetCatalogService(config,this.execution);
    this.health=dependencies.createHealth?.(config) ?? new CapabilityHealthService(config);
    this.controller = config.controllerMode ? new ControllerRuntime(config, this.execution, this.tasks, {
      createExecutorMessages: dependencies.createExecutorMessages,
      targetCatalog: this.targetCatalog,
      prepareScheduledMessage: hooks.prepareScheduledMessage,
      sendScheduledMessage: hooks.sendScheduledMessage,
      scheduledMessageDelivered: hooks.scheduledMessageDelivered,
      currentScheduleConversation: userId => this.manager?.currentConversation(userId) ?? null,
      canSendScheduledMessage: () => this.ready && !this.closed && this.delivery !== undefined && this.delivery.isReady?.() !== false && hooks.canSendScheduledMessage?.() !== false,
      onCheckCapabilities: (_workspace, args) => this.health.query(config.contextWorkspace ?? config.workspace, args),
      onExecutionSettled: () => this.hooks.onExecutionSettled?.(),
      onCompletion: event => this.backgroundCompletion(event),
      onExecutorMessage: (worker, message, userId) => this.manager.acceptExecutorMessage(worker, message, userId),
      executorDirectory: hooks.executorDirectory,
      onSupplementFailure: value => this.manager.workerInputFailed(value),
      onPolicyReport: value => this.manager.workerPolicyReport(value),
      onCountChanged: id => this.manager.refreshTaskCounts(id),
      onWorkCountsChanged: counts => this.delivery?.setWorkCounts?.(counts),
      onError: error => this.log('WORKER ' + safeError(error, this.secrets)),
      isDraining: () => hooks.isDraining(),
      onRequestRestart: origin => hooks.requestRestart(origin),
      onStall: event => {
        if (event.taskId && this.tasks.observeTask(event.taskId, event.observationKey,
          `观察时间：${event.observedAt}；workerId：${event.workerId}；jobId：${event.jobId}；任务仍在执行，未自动重做。`)) this.manager.completionAvailable();
      },
    }) : undefined;
    const invoke = async (turn: AgentTurn, name: string, args: Record<string, unknown>, id?: string): Promise<unknown> => {
      try {
        return await hooks.invoke(turn, name, args, id, input => knowledgeToolNames.has(name)
          ? Promise.resolve(this.manager.invokeKnowledge(turn, name, input, id)) : controllerFileToolNames.has(name)
            ? this.manager.invokeFileTool(turn, name, input) : ['bridge_list_dispatch_failures', 'bridge_ack_dispatch_failure'].includes(name)
              ? Promise.resolve(this.manager.invokeDispatchFailureTool(turn, name, input, id)) : this.controller!.invoke(turn, name, input, id));
      } catch (error) {
        if (['bridge_start_worker', 'bridge_continue_worker', 'bridge_schedule_worker'].includes(name) && !turn.signal.aborted && !hooks.isDraining()) {
          let message: string | undefined;
          try { message = this.manager.recordDispatchFailure(turn, name, args, id, error); }
          catch (recordError) { this.log('DISPATCH_FAILURE_JOURNAL ' + safeError(recordError, this.secrets)); }
          if (message) {
            // Preserve native uncertainty/exit properties and the original error type.
            if (error instanceof Error) { try { error.message = message; } catch { /* The durable record still survives a frozen error. */ } }
            else throw new Error(message, { cause: error });
          }
        }
        throw error;
      }
    };
    const presetRuntime = new PresetRuntime(workspaceFile(config.contextWorkspace ?? config.workspace, 'agent-presets', 'private'), config.dataDir);
    const nativeAdapters = this.controller ? dependencies.createControllerAdapters?.(config, env, this.execution, invoke)
      ?? { codex: createControllerAdapter(config, env, 'codex', this.execution.codex, invoke), claude: createControllerAdapter(config, env, 'claude', this.execution.claude, invoke) } : this.execution;
    const adapters: Record<ControllerAgentName, AgentAdapter> = { ...nativeAdapters, external: dependencies.createExternalAdapter?.(config, invoke) ?? new ExternalControllerAdapter(config, invoke) };
    this.controllerAdapters = adapters;
    this.manager = new SessionManager(config, adapters, {
      sendText: (channel, text, options) => this.send(channel, text, options),
      markReplyDelivered: messages => this.delivery?.markReplyDelivered?.(messages) ?? Promise.resolve(),
      setTaskCount: (message, count) => this.delivery?.setTaskCount?.(message, count) ?? Promise.resolve(),
    }, {
      ...hooks.manager, taskRegistry: this.tasks, botName: () => config.aliases?.[0] ?? config.controllerId,
      resolveControllerPreset: async selector => {
        const workspace = config.contextWorkspace ?? config.workspace;
        const entries = (await this.targetCatalog.listPresets!(workspace, { targetId: 'local' })).filter(item => item.enabled);
        const exact = entries.find(item => item.id.toLowerCase() === selector.toLowerCase());
        const matches = exact ? [exact] : entries.filter(item => item.aliases.some(alias => alias.toLowerCase() === selector.toLowerCase()));
        if (matches.length !== 1) throw new Error(matches.length ? '预设名称不唯一，请使用预设 ID。' : '没有找到已启用的桥电脑预设；/model preset 查看清单。');
        const binding = (await this.targetCatalog.resolvePreset!(workspace, matches[0]!.id)).preset!;
        await presetRuntime.validate(binding);
        return binding;
      },
      authorizeUser: user => hooks.authorize(user, ''),
      onListComputers: (_conversation, refresh) => this.targetCatalog.computerOverview(config.contextWorkspace ?? config.workspace, refresh),
      onDiagnostic: message => this.log(message),
      onListWorkers: (conversation, scope) => Promise.resolve(this.controller?.queryWorkerOverview(conversation, scope) ?? []),
      onRequestRestart: origin => hooks.requestRestart(origin) as ReturnType<NonNullable<SessionManagerOptions['onRequestRestart']>>,
      onCommitExternalHandoff: id => (adapters.external as ExternalControllerAdapter).commitHandoff(id),
      onCompleteExternalHandoff: (id,conversationId) => (adapters.external as ExternalControllerAdapter).completeHandoff(id,conversationId),
      ...(config.controllerMode ? { mergeDelayMs: 0 } : {}),
      ...(this.controller ? {
        onWorkerDefaults: argument => this.controller!.workerDefaultCommand(argument),
        onHousekeeper: (message, argument) => this.housekeeper!.command(message, argument),
        isHousekeeperEvent: event => this.housekeeper?.validEvent(event) === true,
        housekeeperEventText: event => this.housekeeper!.eventText(event),
        onStop: (id: string) => this.controller!.cancelConversation(id),
        onDetach: (id: string) => this.controller!.detachConversation(id),
        onInitializeWorkspace: (turn: AgentTurn) => this.controller!.initializeWorkspace(turn),
        onInitializationError: (_conversation: unknown, error: unknown) => this.log('WORKSPACE ' + safeError(error, this.secrets)),
        onPrepareSwitch: (source, target, channelId, prompt, signal) => this.controller!.prepareAgentSwitch(source, target, channelId, prompt, signal),
        onRebindSwitch: (source, target) => this.controller!.rebindConversation(source, target),
        onPauseSwitch: async source => { hooks.pauseGroup(); await this.controller!.pauseConversation(source.id); },
        onResumeSwitch: async source => { await this.controller!.resumeConversation(source.id); hooks.resumeGroup(); },
      } : {}),
    });
    this.housekeeper = this.controller ? new HousekeeperService(config, {
      active: userId => this.manager.housekeeperActive(userId),
      dispatch: (runId, state, prompt) => this.manager.housekeeperContext(state, turn => this.controller!.invoke(turn, 'bridge_start_worker',
        { targetId: 'local', assistant: { kind: 'default' }, title: '事务同步摘要', prompt }, 'housekeeper:' + runId) as Promise<{ workerId: string; jobId: string }>).catch(error => {
          const saved = state.run ? this.recoverHousekeeperRun(state.run.inputPath) : null;
          if (saved) return saved; throw error;
        }),
      job: id => this.controller!.store.getJob(id),
      recoverRun: run => this.recoverHousekeeperRun(run.inputPath),
      eventForJob: id => this.tasks.queuedEvents().find(event => event.taskId === id) ?? null,
      cancel: async (id, reason) => { const value = this.housekeeper?.store.read(); if (value) await this.controller!.cancelHousekeeperWorker(id, value.userId, reason); },
      event: id => this.manager.housekeeperEventReceipt(id),
      reroute: (run, state) => this.manager.housekeeperContext(state, async turn => {
        const context = JSON.parse(readFileSync(turn.taskContextPath!, 'utf8')) as TaskContextFile;
        const task = this.tasks.register(context, '事务同步摘要', randomUUID());
        const summary = run.summary ?? (run.jobId ? this.controller!.store.getJob(run.jobId)?.result : null);
        if (!summary) throw new Error('已保存的事务摘要缺失。');
        this.tasks.acceptObservedResult(task.taskId, 'completed', summary);
        const event = this.tasks.queuedEvents().find(event => event.taskId === task.taskId)!;
        return { taskId: task.taskId, eventId: event.id, conversationId: turn.conversation.id };
      }),
      retireEvent: id => { if (this.tasks.claimEvent(id)) this.tasks.markDelivered(id); },
      wake: () => this.manager.completionAvailable(),
      notify: (state, text, key) => this.send(state.channelId, text, { deliveryKey: key }),
      onError: error => this.log('HOUSEKEEPER ' + safeError(error, this.secrets)),
      isPaused: () => !this.ready || this.closed || this.hooks.isDraining(),
    }) : undefined;
    this.taskService = new TaskService(this.tasks, { onCompletion: event => this.backgroundCompletion(event),
      onCountChanged: id => this.manager.refreshTaskCounts(id), onError: error => this.log('TASK ' + safeError(error, this.secrets)) });
  }
  private recoverHousekeeperRun(inputPath: string): { workerId: string; jobId: string } | null {
    const jobs = this.controller!.store.jobs().filter(job => job.origin.purpose === 'housekeeper' && job.prompt.includes(inputPath));
    if (jobs.length > 1) throw new Error('同一事务批次有多个执行登记，未重复派工。');
    const job = jobs[0]; return job ? { workerId: job.workerId, jobId: job.id } : null;
  }
  private backgroundCompletion(event: TaskCompletionEvent): void {
    if (this.closed) return;
    if (event.purpose === 'housekeeper') { this.housekeeper?.acceptCompletion(event); return; }
    this.manager.completionAvailable();
  }
  log(message: string): void {
    if(this.hooks.log) this.hooks.log(message);
    else appendFileSync(join(this.config.logsDir, 'bridge.log'), `${new Date().toISOString()} ${safeError(message, this.secrets)}\n`);
  }
  isReady(): boolean { return this.ready && !this.closed; }
  controllerAdapter(agent:ControllerAgentName):AgentAdapter {return this.controllerAdapters[agent];}
  async confirmControllerStopped(conversationId: string): Promise<boolean> {
    if (this.closed) return false;
    const conversation = this.manager.conversationById(conversationId);
    if (!conversation) return false;
    try { return await this.controllerAdapters[conversation.agent].confirmStopped?.(conversationId) === true; }
    catch (error) { this.log('CONTROLLER_STOP_UNCONFIRMED ' + safeError(error, this.secrets)); return false; }
  }
  recover(): Promise<void> {
    if(this.closed)return Promise.reject(new Error('主控已关闭。'));
    return this.recoveryPromise ??= this.recoverOnce();
  }
  private async recoverOnce(): Promise<void> {
    await this.manager.recover();
    await this.controller?.start();
    try {
      const cleanup=this.controller?.pruneWorkerCaches();
      if(cleanup?.files)this.log(`WORKER_PLUGIN_CACHE_PRUNED files=${cleanup.files} bytes=${cleanup.bytes} workers=${cleanup.workers}`);
      for(const error of cleanup?.errors ?? [])this.log('WORKER_PLUGIN_CACHE_CLEANUP_FAILED '+error);
    }catch(error){this.log('WORKER_PLUGIN_CACHE_CLEANUP_FAILED '+safeError(error,this.secrets));}
  }
  start(): Promise<void> {
    if(this.closed)return Promise.reject(new Error('主控已关闭。'));
    return this.startPromise ??= this.startOnce();
  }
  private async startOnce(): Promise<void> {
    await this.recover();
    if(this.closed)throw new Error('主控启动期间已关闭。');
    this.ready=true;
    this.taskService.start();this.manager.completionAvailable();this.housekeeper?.start();
    try{this.log(this.health.startupSummary(await this.health.refresh(this.config.contextWorkspace ?? this.config.workspace)));}
    catch(error){this.log('HEALTH '+safeError(error,this.secrets));}
  }
  private send(channel:string,text:string,options?:Parameters<ReplySink['sendText']>[2]):Promise<void> {
    if(this.closed)throw new Error('主控已关闭。');
    if(!this.delivery)throw new Error('当前主控未绑定交付渠道；结果保留在主控事件记录中。');
    return this.delivery.sendText(channel,text,options);
  }
  beginDrain():void {this.housekeeper?.beginDrain();this.manager.beginDrain();this.controller?.beginDrain();}
  isIdle():boolean {return this.manager.isIdle() && (this.housekeeper?.isIdle() ?? true) && (this.controller?.isIdle() ?? true);}
  close():Promise<void> {
    if(this.closePromise)return this.closePromise;
    this.closed=true;this.ready=false;this.housekeeper?.beginDrain();
    this.closePromise=closeResources([
      {name:'任务回执',close:()=>this.taskService.close()},
      {name:'主控',close:()=>this.manager.close()},
      {name:'执行任务',close:async()=>{await this.controller?.close();}},
      {name:'管家巡视',close:async()=>{await this.housekeeper?.close();}},
      {name:'远程目录',close:()=>this.targetCatalog.close()},
      ...(this.controller?Object.entries(this.execution).map(([name,adapter])=>({name,close:()=>adapter.close()})):[]),
      {name:'任务数据库',close:()=>this.tasks.close()},
    ]);
    return this.closePromise;
  }
}
