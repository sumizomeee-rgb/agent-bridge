import { appendFileSync, existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createServer, type Server } from 'node:net';
import { createHash } from 'node:crypto';
import { agentEnvironment, prepareConfigPaths, safeError, redactText } from './config.js';
import { CodexAdapter } from './agents/codex.js';
import { ClaudeAdapter } from './agents/claude.js';
import { SessionManager, type SessionManagerOptions } from './manager.js';
import { prepareIncomingMessage } from './forwarded.js';
import { PlatformTransport } from './platform.js';
import { NativeControllerAdapter } from './controller/native.js';
import { ControllerRuntime } from './controller/runtime.js';
import { TaskRegistry, TaskService } from './tasks.js';
import { DurableIngress } from './ingress.js';
import { TargetCatalogService } from './remote/catalog.js';
import { CapabilityHealthService } from './capabilities.js';
import { closeResources } from './shutdown.js';
import { BridgeLifecycle } from './lifecycle.js';
import type { ControllerTargetCatalog } from './controller/runtime-types.js';
import { mapPresentation } from './presentation.js';
import { knowledgeToolNames } from './controller-knowledge.js';
import { controllerFileToolNames } from './controller/files.js';
import type { AgentAdapter, AgentTurn, BridgeConfig, IncomingDM, ReplyOptions } from './types.js';
import type { RestartOrigin } from './restart.js';
import type { DMHistoryOptions, DMHistoryPage } from './ingress.js';
import { HousekeeperService } from './housekeeper/service.js';
import type { TaskCompletionEvent, TaskContextFile } from './tasks.js';
import { randomUUID } from 'node:crypto';

export interface BotRuntimeHooks {
  authorize(userId: string, text: string): boolean;
  receiveGroup(message: IncomingDM): Promise<void>;
  manager: Pick<SessionManagerOptions, 'binding' | 'onGroupTurnStart' | 'onSceneCheck' | 'onGroupTurnError' | 'onGroupTurnFinished' | 'onGroupSilent' | 'onControllerPublish' | 'onGroupPublish' | 'onGroupCompletion' | 'onInitializationState'> & { binding: NonNullable<SessionManagerOptions['binding']> };
  invoke(turn: AgentTurn, name: string, input: Record<string, unknown>, callId: string | undefined, delegate: (input: Record<string, unknown>) => Promise<unknown>): Promise<unknown>;
  pauseGroup(): void;
  resumeGroup(): void;
  requestRestart(origin: RestartOrigin): Promise<unknown>;
  isDraining(): boolean;
  allowDelivery(channelId: string): boolean;
  isGroupChannel?(channelId: string): boolean;
  onReady(): void;
  onExecutionSettled?(): void;
  /** Reconnect group recovery stays in the host; the DM journal never reads group history. */
  onReconnect?(): Promise<void>;
}

export type BotTransport = Pick<PlatformTransport, keyof PlatformTransport>;
type Adapters = Record<'codex' | 'claude', AgentAdapter>;
type ToolInvoker = (turn: AgentTurn, name: string, args: Record<string, unknown>, id?: string) => Promise<unknown>;
type BotTargetCatalog = ControllerTargetCatalog & Pick<TargetCatalogService, 'computerOverview' | 'close'>;
export interface BotRuntimeDependencies {
  createTransport?: (config: BridgeConfig, receive: (message: IncomingDM) => Promise<void>, hooks: ConstructorParameters<typeof PlatformTransport>[2]) => BotTransport;
  createExecutionAdapters?: (config: BridgeConfig, env: NodeJS.ProcessEnv) => Adapters;
  createControllerAdapters?: (config: BridgeConfig, env: NodeJS.ProcessEnv, execution: Adapters, invoke: ToolInvoker) => Adapters;
  createTargetCatalog?: (config: BridgeConfig, execution: Adapters) => BotTargetCatalog;
  createHealth?: (config: BridgeConfig) => Pick<CapabilityHealthService, 'refresh' | 'query' | 'startupSummary'>;
}

/** Owns one verified Bot. It never creates a project lock, process PID, or a second supervisor. */
export class BotRuntime {
  readonly manager: SessionManager;
  readonly transport: BotTransport;
  readonly controller?: ControllerRuntime;
  readonly tasks: TaskRegistry;
  readonly housekeeper?: HousekeeperService;
  readonly ingress: DurableIngress;
  private readonly targetCatalog: BotTargetCatalog;
  private readonly execution: Adapters;
  private readonly controllerAdapters: Adapters;
  private readonly lifecycle: BridgeLifecycle;
  private readonly taskService: TaskService;
  private guard?: Server;
  private closed = false;
  private ready = false;
  private verified = false;
  private verifyPromise?: Promise<void>;
  private startPromise?: Promise<void>;
  private closePromise?: Promise<void>;
  private reconnecting?: Promise<void>;
  private lagTimer?: ReturnType<typeof setInterval>;
  private readonly revisions = new Map<string, number>();
  private readonly stamps = new Map<string, number>();
  private readonly secrets: string[];
  private readonly health: Pick<CapabilityHealthService, 'refresh' | 'query' | 'startupSummary'>;

  constructor(readonly config: BridgeConfig, private readonly hooks: BotRuntimeHooks, dependencies: BotRuntimeDependencies = {}) {
    if (!hooks.manager.binding) throw new Error('BotRuntime 必须使用宿主的当前主控绑定，不能退回按用户选择多个主控。');
    prepareConfigPaths(config);
    this.secrets = [config.token, config.appSecret ?? ''];
    const env = agentEnvironment(config);
    this.tasks = new TaskRegistry(config.dataDir);
    this.execution = dependencies.createExecutionAdapters?.(config, env) ?? { codex: new CodexAdapter(config.commands.codex, env), claude: new ClaudeAdapter(config.commands.claude, env) };
    this.targetCatalog = dependencies.createTargetCatalog?.(config, this.execution) ?? new TargetCatalogService(config, this.execution);
    this.health = dependencies.createHealth?.(config) ?? new CapabilityHealthService(config);
    this.transport = (dependencies.createTransport ?? ((selected, receive, events) => new PlatformTransport(selected, receive, events)))(config, async message => {
      if (this.closed || hooks.isDraining()) return;
      if (message.space) { await hooks.receiveGroup(message); return; }
      if (!hooks.isGroupChannel?.(message.channelId) && hooks.authorize(message.userId, message.text)) await this.ingress.receive(message);
    }, {
      logger: message => this.log(message),
      onReceive: message => !this.closed && !message.space && !hooks.isGroupChannel?.(message.channelId) && hooks.authorize(message.userId, message.text) ? this.ingress.capture(message) : false,
      onReady: async () => {
        if (this.ready && !this.closed && !hooks.isDraining()) await this.recoverTransport();
      },
    });
    this.controller = config.controllerMode ? new ControllerRuntime(config, this.execution, this.tasks, {
      targetCatalog: this.targetCatalog,
      onCheckCapabilities: (_workspace, args) => this.health.query(config.contextWorkspace ?? config.workspace, args),
      onExecutionSettled: () => this.hooks.onExecutionSettled?.(),
      onCompletion: event => this.backgroundCompletion(event),
      onSupplementFailure: value => this.manager.workerInputFailed(value),
      onPolicyReport: value => this.manager.workerPolicyReport(value),
      onCountChanged: id => this.manager.refreshTaskCounts(id),
      onWorkCountsChanged: counts => this.transport.setWorkCounts(counts),
      onError: error => this.log('WORKER ' + safeError(error, this.secrets)),
      isDraining: () => hooks.isDraining(),
      onRequestRestart: origin => hooks.requestRestart(origin),
      onStall: event => {
        if (event.taskId && this.tasks.observeTask(event.taskId, event.observationKey,
          `观察时间：${event.observedAt}；workerId：${event.workerId}；jobId：${event.jobId}；任务仍在执行，未自动重做。`)) this.manager.completionAvailable();
      },
    }) : undefined;
    const invoke = (turn: AgentTurn, name: string, args: Record<string, unknown>, id?: string): Promise<unknown> =>
      hooks.invoke(turn, name, args, id, input => knowledgeToolNames.has(name)
        ? Promise.resolve(this.manager.invokeKnowledge(turn, name, input, id)) : controllerFileToolNames.has(name)
          ? this.manager.invokeFileTool(turn, name, input) : this.controller!.invoke(turn, name, input, id));
    const adapters = this.controller ? dependencies.createControllerAdapters?.(config, env, this.execution, invoke) ?? {
      codex: new NativeControllerAdapter(config.commands.codex, env, { agent: 'codex', dataDir: config.dataDir, contextWorkspace: config.contextWorkspace ?? config.workspace,
        internalBotCommunicationEnabled: config.internalBotCommunicationEnabled, metadataAdapter: this.execution.codex, defaultModels: config.defaultModels, identity: { botId: config.botId, aliases: config.aliases ?? [] }, invokeTool: invoke }),
      claude: new NativeControllerAdapter(config.commands.claude, { ...env, CLAUDE_CODE_EFFORT_LEVEL: 'xhigh' }, { agent: 'claude', dataDir: config.dataDir, contextWorkspace: config.contextWorkspace ?? config.workspace,
        internalBotCommunicationEnabled: config.internalBotCommunicationEnabled, metadataAdapter: this.execution.claude, defaultModels: config.defaultModels, identity: { botId: config.botId, aliases: config.aliases ?? [] }, invokeTool: invoke }),
    } : this.execution;
    this.controllerAdapters = adapters;
    this.manager = new SessionManager(config, adapters, {
      sendText: (channel, text, options) => this.send(channel, text, options),
      markReplyDelivered: messages => this.transport.markReplyDelivered(messages),
      setTaskCount: (message, count) => this.transport.setTaskCount(message, count),
    }, {
      ...hooks.manager, taskRegistry: this.tasks, botName: () => this.transport.botUser?.username,
      authorizeUser: user => hooks.authorize(user, ''),
      onListComputers: (_conversation, refresh) => this.targetCatalog.computerOverview(config.contextWorkspace ?? config.workspace, refresh),
      onDiagnostic: message => this.log(message),
      onListWorkers: (conversation, scope) => Promise.resolve(this.controller?.queryWorkerOverview(conversation, scope) ?? []),
      onRequestRestart: origin => hooks.requestRestart(origin) as ReturnType<NonNullable<SessionManagerOptions['onRequestRestart']>>,
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
      cancel: async id => { const value = this.housekeeper?.store.read(); if (value) await this.controller!.cancelHousekeeperWorker(id, value.userId); },
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
    const control = (message: IncomingDM) => /^(?:\/(?:stop|new|cwd)(?:\s|$)|\/agent\s+\S|new\s+chat$|新会话$|新聊天$)/i.test(message.text.trim());
    this.ingress = new DurableIngress(config.dataDir, {
      allowedUserIds: config.allowedUserIds, hasMessage: id => this.manager.hasMessage(id), isImmediate: control,
      onQueued: (message, replayOnly) => { const n = (this.revisions.get(message.userId) ?? 0) + (control(message) ? 1 : 0);
        this.manager.privateInputQueued(message);
        this.revisions.set(message.userId, n); if (!replayOnly) this.stamps.set(message.id, n); },
      handle: async message => {
        const workersCommand = /^\/workers(?:\s|$)/i.test(message.text.trim());
        const began = performance.now();
        if (workersCommand) this.log('WORKERS_INPUT stage=handler');
        try {
          if (!this.ready || this.closed || hooks.isDraining() || hooks.isGroupChannel?.(message.channelId) || !hooks.authorize(message.userId, message.text)) return;
          const current = () => control(message) || this.stamps.get(message.id) === (this.revisions.get(message.userId) ?? 0);
          const content = current() && !control(message) ? await prepareIncomingMessage(this.transport, message) : { text: message.text, imagePaths: [] };
          const prepared = { id: message.id, userId: message.userId, channelId: message.channelId, text: content.text,
            source: { messageId: message.id, userId: message.userId, channelId: message.channelId, authorType: 'user' as const, ...message.source },
            imagePaths: content.imagePaths };
          if (!current()) { this.manager.discard(prepared); return; }
          if (workersCommand) this.log(`WORKERS_INPUT stage=prepared ms=${Math.round(performance.now() - began)}`);
          await this.manager.handle(prepared, message.interaction ? (text, options) => this.transport.sendInteractionText(message.interaction!, text, options) : undefined);
        } finally { this.stamps.delete(message.id); }
      },
      onError: (message, error) => { this.log('INGRESS ' + safeError(error, this.secrets));
        if (!this.closed) void this.manager.reportInputFailure({ ...message, imagePaths: [] }, error, true, () => this.send(message.channelId, this.transport.failureText(error))).catch(() => undefined); },
    });
    this.lifecycle = new BridgeLifecycle(config, event => this.transport.onBridgeLifecycle(event), () => {
      const contact = this.ingress.lastAuthorizedContact();
      return contact && !hooks.isGroupChannel?.(contact.channelId) && hooks.authorize(contact.userId, '') ? contact : undefined;
    }, error => this.log('LIFECYCLE_NOTICE_FAILED ' + safeError(error, this.secrets)));
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
    appendFileSync(join(this.config.logsDir, 'bridge.log'), `${new Date().toISOString()} ${safeError(message, this.secrets)}\n`);
  }
  isReady(): boolean { return this.ready && !this.closed; }
  async confirmControllerStopped(conversationId: string): Promise<boolean> {
    if (this.closed) return false;
    const conversation = this.manager.conversationById(conversationId);
    if (!conversation) return false;
    try { return await this.controllerAdapters[conversation.agent].confirmStopped?.(conversationId) === true; }
    catch (error) { this.log('CONTROLLER_STOP_UNCONFIRMED ' + safeError(error, this.secrets)); return false; }
  }
  private readDMHistory(channel: string, options: DMHistoryOptions): Promise<DMHistoryPage> {
    if (this.hooks.isGroupChannel?.(channel)) {
      this.log('IGNORED_LEGACY_GROUP_DM_CURSOR');
      return Promise.resolve({ messages: [], oldestId: null, newestId: null, hasMore: false });
    }
    return this.transport.readDMHistory(channel, options);
  }
  private async recoverTransport(): Promise<void> {
    if (this.reconnecting) return this.reconnecting;
    const work = (async () => {
      await this.ingress.recover((channel, options) => this.readDMHistory(channel, options));
      if (this.isReady() && !this.hooks.isDraining()) await this.hooks.onReconnect?.();
    })();
    this.reconnecting = work;
    try { await work; } finally { if (this.reconnecting === work) this.reconnecting = undefined; }
  }
  private async failed(error: unknown): Promise<never> {
    await this.transport.onBridgeLifecycle({ phase: 'failed' }).catch(failure => this.log('LIFECYCLE_FAILED ' + safeError(failure, this.secrets)));
    try { await this.close(); } catch (cleanup) { throw new AggregateError([error, cleanup], 'Bot 启动失败，部分资源停止尚未确认。'); }
    throw error;
  }
  verify(): Promise<void> {
    if (this.closed) return Promise.reject(new Error('Bot 已关闭，不能重新验证。'));
    return this.verifyPromise ??= this.verifyOnce().catch(error => this.failed(error));
  }
  private async verifyOnce(): Promise<void> {
    const identity = await this.transport.verifyIdentity();
    if (identity !== this.config.applicationId) throw new Error('平台凭据与登记的 Bot 应用身份不一致。');
    if (this.closed) throw new Error('Bot 验证期间已关闭。');
    const guard = this.guard = createServer(socket => socket.destroy());
    const key = createHash('sha256').update(this.config.botId!).digest('hex').slice(0, 24);
    const address = process.platform === 'win32' ? `\\\\.\\pipe\\agent-bridge-bot-${key}` : join(this.config.dataDir, `bridge-${key}.sock`);
    await new Promise<void>((resolve, reject) => { guard.once('error', reject); guard.listen(address, resolve); });
    this.verified = true;
  }
  start(): Promise<void> {
    if (this.closed) return Promise.reject(new Error('Bot 已关闭，不能重新启动。'));
    return this.startPromise ??= this.startOnce().catch(error => this.failed(error));
  }
  private async startOnce(): Promise<void> {
    if (!this.verified) throw new Error('Bot 必须先验证真实身份并取得独占锁。');
    // Seed before opening the socket: an early live message must not advance over the outage gap.
    this.seedDMChannels();
    await this.transport.onBridgeLifecycle({ phase: 'recovering' });
    await this.transport.start();
    if (this.closed) throw new Error('Bot 启动期间已关闭。');
    await this.manager.recover();
    await this.controller?.start();
    this.seedDMChannels();
    await this.ingress.recover((channel, options) => this.readDMHistory(channel, options));
    if (this.closed) throw new Error('Bot 恢复期间已关闭。');
    this.ready = true;
    let lastTick = performance.now();
    this.lagTimer = setInterval(() => { const now = performance.now(), lag = now - lastTick - 1000; lastTick = now;
      if (lag >= 1000) this.log(`EVENT_LOOP_LAG ms=${Math.round(lag)}`); }, 1000);
    this.lagTimer.unref();
    this.taskService.start(); this.ingress.start(); this.manager.completionAvailable(); this.housekeeper?.start();
    if (this.config.features?.nativeCommands !== false) {
      try { await this.transport.syncSlashCommands(); this.log('SLASH_COMMANDS_SYNCED'); }
      catch (error) { this.log('SLASH_COMMANDS_FAILED ' + safeError(error, this.secrets)); }
    }
    try { this.log(this.health.startupSummary(await this.health.refresh(this.config.contextWorkspace ?? this.config.workspace))); }
    catch (error) { this.log('HEALTH ' + safeError(error, this.secrets)); }
    this.log(`READY bot=${this.transport.botUser?.username ?? this.config.botId} agent=${this.config.defaultAgent}`);
    this.hooks.onReady();
  }
  private seedDMChannels(): void {
    for (const channel of this.manager.knownDMChannels()) if (!this.hooks.isGroupChannel?.(channel.channelId) && this.hooks.authorize(channel.userId, '')) this.ingress.seedChannel(channel);
  }
  /** Called once after the shared host recovery; reconnects never publish startup notices. */
  publishReadyLifecycle(): Promise<void> { return this.isReady() ? this.lifecycle.ready() : Promise.resolve(); }
  async send(channel: string, text: string, options?: ReplyOptions): Promise<void> {
    if (this.closed) throw new Error('Bot 已关闭，回复保留在原入口。');
    if (!this.hooks.allowDelivery(channel)) throw new Error('原投递目的地当前不可用；结果保留，不改投其他入口。');
    await this.transport.sendText(channel, redactText(text, this.secrets), options ? { ...options,
      ...(options.presentation ? { presentation: mapPresentation(options.presentation, s => redactText(s, this.secrets)) } : {}) } : undefined);
  }
  beginDrain(): void { this.housekeeper?.beginDrain(); this.ingress.pause(); this.manager.beginDrain(); this.controller?.beginDrain(); }
  isIdle(): boolean { return this.manager.isIdle() && (this.housekeeper?.isIdle() ?? true) && (this.controller?.isIdle() ?? true) && this.transport.isIdle(); }
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true; this.ready = false; clearInterval(this.lagTimer); this.housekeeper?.beginDrain();
    this.closePromise = closeResources([
      { name: '通信平台', close: () => this.transport.close() }, { name: '收件', close: () => this.ingress.close() },
      { name: '任务回执', close: () => this.taskService.close() }, { name: '主控', close: () => this.manager.close() },
      { name: '执行任务', close: async () => { await this.controller?.close(); } },
      { name: '管家巡视', close: async () => { await this.housekeeper?.close(); } },
      { name: '远程目录', close: () => this.targetCatalog.close() },
      ...(this.controller ? Object.entries(this.execution).map(([name, adapter]) => ({ name, close: () => adapter.close() })) : []),
      { name: '生命周期', close: () => this.lifecycle.close() },
      { name: '任务数据库', close: () => this.tasks.close() }, { name: 'Bot独占锁', close: () => new Promise<void>((resolve, reject) => {
        if (!this.guard?.listening) { resolve(); return; }
        this.guard.close(error => error ? reject(error) : resolve());
      }) },
    ]);
    return this.closePromise;
  }
}
