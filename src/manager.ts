import { effortCapabilityText, modelEffortCapability, validateEffort } from './effort.js';
import { createHash, randomUUID } from 'node:crypto';
import { statSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, renameSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { SessionStore, type WorkspaceNoticeOutcome, type ControllerBinding, type InboxItem, type InboxState } from './store.js';
import { isModelId } from './config.js';
import { agentDisplayName, replyHeader } from './reply.js';
import { computerOverview, workerOverview, isActiveWorker, type ComputerOverview, type WorkerOverview } from './overview.js';
import { commandHelp, parseCommand as command, parseNewArguments } from './commands.js';
import { presentationText, type BridgePresentation } from './presentation.js';
import { bridgeNotice, type BridgeNoticeCode } from './notices.js';
import { executionErrorEvidence as errorEvidence } from './delivery-errors.js';
import { completedResultFromError } from './agents/process.js';
import { collectOutgoingAttachments, collectOutgoingPaths } from './artifacts.js';
import { listPresets } from './presets/registry.js';
import type { TaskCompletionEvent, TaskRegistry } from './tasks.js';
import type { AgentAdapter, AgentModelInfo, AgentName, AgentTurn, EffortMetadata, BridgeConfig, BridgeMessage, Conversation, ReplySink, ReplyOptions } from './types.js';

import { SessionHandoffs } from './controller/handoff.js';
import { shouldShowMessageReceipts } from './receipt-policy.js';
import type { RestartOrigin, RestartReceipt } from './restart.js';

interface WorkspaceInitializationJournal {
  version: 1; conversationId: string; userId: string; sourceMessageId: string; channelId: string;
  outcome: 'pending' | WorkspaceNoticeOutcome; nativeId: string | null; updatedAt: string;
}
interface AgentSwitchJournal {
  version: 1; source: Conversation; target: Conversation; channelId: string;
  phase: 'preparing' | 'prepared' | 'committing' | 'committed' | 'failed';
  createdAt: string; updatedAt: string; error?: string;
}interface RunningTurn {
  messageId: string;
  conversationId: string;
  controller: AbortController;
  messageIds: string[];
  ready: boolean;
  executing: boolean;
  supplements: Promise<void>;
  completionEventId?: string;
  publicationUncertain?: boolean;
}
export type GroupTurnContext = NonNullable<AgentTurn['groupContext']>;
export interface SessionManagerOptions {
  onConversationScene?: (conversation: Conversation, source: NonNullable<AgentTurn['source']>, signal: AbortSignal) => Promise<string>;
  binding?: ControllerBinding; authorizeUser?: (userId: string) => boolean;
  onGroupTurnError?: (context: GroupTurnContext) => Promise<boolean>;
  onGroupTurnStart?: (context: GroupTurnContext) => Promise<string>;
  onSceneCheck?: (context: GroupTurnContext, input: Parameters<NonNullable<AgentTurn['onSceneCheck']>>[0]) => ReturnType<NonNullable<AgentTurn['onSceneCheck']>>;
  onGroupTurnFinished?: (context: GroupTurnContext, outcome: 'completed' | 'silent' | 'failed') => Promise<void>;
  onGroupSilent?: (context: GroupTurnContext) => Promise<void>;
  onGroupCompletion?: (event: TaskCompletionEvent) => Promise<'queued' | 'retain'>;
  onControllerPublish?: (context: { conversation: Conversation; source: { messageId: string; userId: string; channelId: string }; groupContext?: GroupTurnContext; signal: AbortSignal; finish: boolean }, text: string, paths: string[], targetId: string | undefined, messageKey: string | undefined, deliver: (channelId?: string) => Promise<void>) => Promise<void>;
  onGroupPublish?: (context: GroupTurnContext, text: string, paths: string[], deliver: () => Promise<void>) => Promise<void>;
  onPrepareSwitch?: (source: Conversation, target: Conversation, channelId: string, prompt: string, signal: AbortSignal) => Promise<{ contextSeed: string }>;
  onRebindSwitch?: (source: Conversation, target: Conversation) => void | Promise<void>;
  onPauseSwitch?: (source: Conversation) => Promise<void>; onResumeSwitch?: (source: Conversation) => void | Promise<void>;
  botName?: () => string | undefined;
  mergeDelayMs?: number; receiptIntervalMs?: number; taskRegistry?: TaskRegistry;
  onStop?: (conversationId: string) => Promise<void>; onDetach?: (conversationId: string) => void | Promise<void>;
  onInitializeWorkspace?: (turn: AgentTurn) => Promise<unknown>;
  onInitializationError?: (conversation: Conversation, error: unknown) => void;
  onInitializationState?: (conversation: Conversation, outcome: WorkspaceNoticeOutcome) => void | Promise<void>;
  onListComputers?: (conversation: Conversation, refresh: boolean) => Promise<ComputerOverview[]>;
  onListWorkers?: (conversation: Conversation, scope: 'current' | 'all') => Promise<WorkerOverview[]>;
  onRequestRestart?: (origin: RestartOrigin) => Promise<RestartReceipt>;
}

export class SessionManager {
  private readonly store: SessionStore;
  private readonly handoffs: SessionHandoffs;
  private readonly workers = new Map<string, Promise<void>>();
  private readonly userWorkers = new Map<string, Promise<void>>();
  private readonly latestMessages = new Map<string, { id: string; channelId: string; conversationId: string }>();
  private readonly running = new Map<string, RunningTurn>();
  private readonly interruptPromises = new Set<Promise<void>>();
  private readonly detachPromises = new Map<string, Promise<void>>();
  private readonly resetCommands = new Map<string, number>();
  private readonly modelChanges = new Set<string>();
  private readonly initializationAttempts = new Set<string>();
  private readonly initializationRecoveries = new Set<Promise<void>>();
  private readonly initializations = new Map<string, { controller: AbortController; promise: Promise<void> }>();
  private readonly noticeSends = new Map<string, { controller: AbortController; promise: Promise<void> }>();
  private closed = false;
  private closePromise?: Promise<void>;
  private draining = false;
  private activeCommands = 0;
  private readonly commandReplies = new Map<string, { done: Promise<void>; finish: () => void }>();
  private recovered = false;
  private recovering = false;
  private readonly receipts = new Map<string, number>();
  private readonly preparedResets = new Map<string, { sourceId: string | null; userId: string }>();
  private readonly switches = new Map<string, { journal: AgentSwitchJournal; controller: AbortController }>();
  private readonly pendingSwitches = new Set<string>();
  private readonly revisions = new Map<string, number>();
  private readonly authorizedGroupEvents = new Map<string, { conversationId: string; contextKey: string }>();

  constructor(
    private readonly config: BridgeConfig,
    private readonly adapters: Record<AgentName, AgentAdapter>,
    private readonly sink: ReplySink,
    private readonly options: SessionManagerOptions = {},
  ) { this.store = new SessionStore(config.dataDir, options.binding); this.handoffs = new SessionHandoffs(config.dataDir); }

  revision(userId: string): number { return this.revisions.get(userId) ?? 0; }

  /** A different chat or command must not be overtaken by a private-input refresh. */
  privateInputBarrier(userId: string, id: string): void {
    if (this.config.controllerMode && !this.closed && this.config.allowedUserIds.includes(userId)
      && this.options.authorizeUser?.(userId) !== false) this.store.markPrivateInputBarrier(userId, id);
  }

  /** Preserve cross-chat/control ordering before a slow attachment has been prepared. */
  privateInputQueued(message: Pick<BridgeMessage, 'id' | 'userId' | 'channelId' | 'text'>): void {
    if (!this.config.controllerMode || this.closed || !this.config.allowedUserIds.includes(message.userId)
      || this.options.authorizeUser?.(message.userId) === false) return;
    const running = this.running.get(message.userId);
    const original = running ? this.store.getMessage(running.messageId) : null;
    if (command(message.text) || original && original.channelId !== message.channelId)
      this.privateInputBarrier(message.userId, 'private-ingress:' + message.id);
    this.store.notePrivateInputArrival(message);
  }

  async replyWorkers(userId: string, argument: string, reply: (text: string, options?: ReplyOptions) => Promise<void>,
    filter?: (items: WorkerOverview[]) => WorkerOverview[], createIfMissing = true): Promise<void> {
    const args = argument.split(/\s+/).filter(Boolean);
    if (args.some(value => !['current', 'all', 'history', 'details'].includes(value)) || new Set(args).size !== args.length || args.includes('current') && args.includes('all')) {
      await reply('用法：/workers [history] [all] [details]；默认只看未结束助手，history 看历史。'); return;
    }
    if (!this.options.onListWorkers) { await reply('桥尚未配置直属 Agent 查询。'); return; }
    const target = this.store.getActive(userId) ?? (createIfMissing ? this.ensureActive(userId) : null);
    if (!target) {
      const view: BridgePresentation = { title: '直属助手', tone: 'info', blocks: [{ kind: 'entry', text: '尚未初始化主控；请先在此 Bot 私聊初始化。' }] };
      await reply(presentationText(view), { presentation: view }); return;
    }
    const scope = args.includes('all') ? 'all' : 'current';
    let items: WorkerOverview[];
    try { items = await this.options.onListWorkers(target, scope); }
    catch { throw new Error('直属 Agent 状态读取失败，请稍后重试。'); }
    const history = args.includes('history');
    let selected = (filter ? filter(items) : items).filter(item => isActiveWorker(item) !== history);
    if (selected.some(item => item.presetId)) {
      try {
        const names = new Map((await listPresets(this.config.contextWorkspace ?? this.config.workspace)).map(item => [item.id, item.aliases[0]]));
        selected = selected.map(item => item.presetId ? { ...item, presetLabel: names.get(item.presetId) ?? item.presetLabel } : item);
      } catch { /* Display names are optional; the saved preset ID still identifies the route. */ }
    }
    const view = workerOverview(selected, scope, Date.now(), args.includes('details'), history ? 'history' : 'active');
    await reply(presentationText(view), { presentation: view });
  }

  currentConversation(userId: string): Conversation | null { return this.store.getActive(userId); }
  conversationById(id: string): Conversation | null { return this.store.getConversation(id); }
  private authorizedUsers(): string[] { return this.config.allowedUserIds.filter(user => this.options.authorizeUser?.(user) !== false); }

  private selectedConversation(userId: string, agent: AgentName, cwd: string, previous?: Conversation | null): Conversation {
    if (previous) this.store.savePreferences(previous);
    const target = this.store.createConversation(userId, agent, cwd, { controllerMode: this.config.controllerMode === true });
    const preference = this.store.preferences(agent);
    if (preference && (preference.model != null || preference.modelPolicy === 'cli-default')) this.store.setModel(target.id, preference.model);
    if (preference?.effort != null) this.store.setEffort(target.id, preference.effort);
    return this.store.getConversation(target.id)!;
  }

  /** Stop the reset lifecycle and prepare a replacement, without changing the bot's active binding. */
  async prepareReset(userId: string): Promise<Conversation> {
    if (this.closed || this.draining || !this.config.allowedUserIds.includes(userId) || this.options.authorizeUser?.(userId) === false) throw new Error('当前账号不能重置此 Bot。');
    const previous = this.store.getActive(userId);
    this.resetCommands.set(userId, (this.resetCommands.get(userId) ?? 0) + 1);
    try {
      if (previous) { this.cancel(previous); await this.awaitDetach(previous.id); }
      if (this.store.getActive(userId)?.id !== previous?.id) throw new Error('准备重置时当前主控已改变。');
      const target = this.selectedConversation(userId, previous?.agent ?? this.config.defaultAgent, previous?.cwd ?? this.config.workingCwd ?? this.config.workspace, previous);
      this.preparedResets.set(target.id, { sourceId: previous?.id ?? null, userId }); return target;
    } catch (error) { this.releaseResetBarrier(userId); throw error; }
  }
  private releaseResetBarrier(userId: string): void {
    const count = (this.resetCommands.get(userId) ?? 1) - 1;
    if (count > 0) this.resetCommands.set(userId, count); else this.resetCommands.delete(userId);
  }
  abortPreparedReset(target: Conversation): void {
    const prepared = this.preparedResets.get(target.id); if (!prepared) return;
    this.preparedResets.delete(target.id); this.releaseResetBarrier(prepared.userId);
  }
  private initializationJournalPath(id: string): string {
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id)) throw new Error('初始化会话标识无效。');
    return join(this.config.dataDir, 'workspace-initialization', id + '.json');
  }
  private readInitializationJournal(target: Conversation): WorkspaceInitializationJournal | null {
    const path = this.initializationJournalPath(target.id); if (!existsSync(path)) return null;
    if (statSync(path).size > 16384) throw new Error('初始化状态记录过大。');
    const value = JSON.parse(readFileSync(path, 'utf8')) as WorkspaceInitializationJournal;
    if (value.version !== 1 || value.conversationId !== target.id || value.userId !== target.userId
      || typeof value.sourceMessageId !== 'string' || typeof value.channelId !== 'string'
      || !['pending', 'ready', 'read-failed', 'read-cancelled', 'load-failed', 'request-failed', 'introduction-failed', 'unknown'].includes(value.outcome)) throw new Error('初始化状态记录与当前 Bot 主控不匹配。');
    return value;
  }
  private writeInitializationJournal(journal: WorkspaceInitializationJournal): void {
    const path = this.initializationJournalPath(journal.conversationId); mkdirSync(join(this.config.dataDir, 'workspace-initialization'), { recursive: true });
    const temp = path + '.' + randomUUID() + '.tmp'; journal.updatedAt = new Date().toISOString(); writeFileSync(temp, JSON.stringify(journal), { mode: 0o600 }); renameSync(temp, path);
  }
  /** A delivered introduction is proof only together with the completed, accepted initialization for this exact parent. */
  private completedInitializationSource(target: Conversation): BridgeMessage | null {
    if (!this.config.controllerMode || !target.nativeId) return null;
    const notice = this.store.workspaceNotice(target.id);
    if (!notice || notice.userId !== target.userId || notice.outcome !== 'ready' || notice.state !== 'delivered') return null;
    const completed = this.options.taskRegistry?.completedWorkspaceInitialization(target);
    if (!completed || completed.originMessageId !== notice.sourceMessageId || completed.channelId !== notice.channelId) return null;
    const source = this.store.getMessage(completed.originMessageId);
    if (!source || source.userId !== target.userId || source.channelId !== completed.channelId || source.state !== 'completed'
      || source.conversationId !== target.id && !(source.conversationId === null && command(source.text)?.name === 'new')) return null;
    // The original handoff still belongs to its original entrance. A later DM/group entrance does not consume it again.
    const handoff = this.handoffs.get(target);
    if (handoff && (handoff.status !== 'ready' || handoff.channelId !== source.channelId)) return null;
    return source;
  }
  private async restoreCompletedInitialization(target: Conversation, source: BridgeMessage): Promise<void> {
    this.writeInitializationJournal({ version: 1, conversationId: target.id, userId: target.userId,
      sourceMessageId: source.id, channelId: source.channelId, nativeId: target.nativeId, outcome: 'ready', updatedAt: new Date().toISOString() });
    await this.reportInitializationState(target, 'ready', source);
  }
  private async reportInitializationState(target: Conversation, outcome: WorkspaceNoticeOutcome, source?: BridgeMessage): Promise<void> {
    const previous = this.readInitializationJournal(target), origin = source ?? this.initializationSource(target);
    if (previous || origin) this.writeInitializationJournal({ version: 1, conversationId: target.id, userId: target.userId,
      sourceMessageId: previous?.sourceMessageId ?? origin!.id, channelId: previous?.channelId ?? origin!.channelId,
      nativeId: this.store.getConversation(target.id)?.nativeId ?? target.nativeId, outcome, updatedAt: new Date().toISOString() });
    try { await this.options.onInitializationState?.(this.store.getConversation(target.id) ?? target, outcome); }
    catch (error) { try { this.options.onInitializationError?.(target, error); } catch { /* The accepted native state remains durably recorded. */ } }
  }
  /** Replay only the initialization side of an already committed batch. This never cancels work or changes generation. */
  async ensureCommittedResetInitialized(target: Conversation, source: BridgeMessage): Promise<void> {
    const current = this.store.getActive(target.userId), stored = this.store.getConversation(target.id);
    if (this.closed || !stored || current?.id !== target.id || target.userId !== source.userId
      || this.options.authorizeUser?.(target.userId) === false || command(source.text)?.name !== 'new') throw new Error('只能为已提交的当前主控恢复群初始化。');
    let journal = this.readInitializationJournal(stored);
    if (journal && (journal.sourceMessageId !== source.id || journal.channelId !== source.channelId)) throw new Error('群初始化来源与已提交批次不匹配。');
    const registered = this.store.getMessage(source.id);
    if (registered && (registered.userId !== source.userId || registered.channelId !== source.channelId || command(registered.text)?.name !== 'new')) throw new Error('群初始化命令来源不匹配。');
    if (!registered) { this.store.addMessage(source, null, 'command'); this.store.setState(source.id, 'completed'); }
    this.store.cancelWorkspaceNotice(target.id);
    if (journal && journal.outcome !== 'pending') {
      const outcome = journal.outcome === 'ready' && (!stored.nativeId || journal.nativeId !== stored.nativeId) ? 'unknown' : journal.outcome;
      await this.reportInitializationState(stored, outcome, source); return;
    }
    if (!journal) { journal = { version: 1, conversationId: stored.id, userId: stored.userId, sourceMessageId: source.id, channelId: source.channelId, outcome: 'pending', nativeId: stored.nativeId, updatedAt: new Date().toISOString() }; this.writeInitializationJournal(journal); }
    this.initializeWorkspace(stored, source); this.completionAvailable();
  }
  commitPreparedReset(target: Conversation, source: BridgeMessage, initialize = true, suppressIntroduction = false): void {
    if (target.userId !== source.userId || !this.store.getConversation(target.id)) throw new Error('重置目标不属于发起账号。');
    const prepared = this.preparedResets.get(target.id), active = this.store.getActive(target.userId);
    if (active?.id !== target.id) {
      if (!prepared || (active?.id ?? null) !== prepared.sourceId) throw new Error('重置来源已改变，拒绝覆盖当前主控。');
      this.store.setActive(target.userId, target.id);
    }
    this.store.savePreferences(target); this.abortPreparedReset(target);
    if (initialize && suppressIntroduction) {
      const recovery = this.ensureCommittedResetInitialized(target, source).catch(error => this.options.onInitializationError?.(target, error)).finally(() => this.initializationRecoveries.delete(recovery));
      this.initializationRecoveries.add(recovery);
    } else if (initialize) {
      if (!this.store.hasMessage(source.id)) { this.store.addMessage(source, null, 'command'); this.store.setState(source.id, 'completed'); }
      if (!source.groupContext && !suppressIntroduction) this.store.requestWorkspaceNotice(target.id, source);
      this.initializeWorkspace(target, source);
    }
    this.completionAvailable(); if (this.store.nextQueued(target.id)) this.wake(target.id);
  }  /** Pause new turns without aborting a CLI, supplement or reply already executing. */
  beginDrain(): void { this.draining = true; }
  isIdle(): boolean {
    return this.workers.size === 0 && this.userWorkers.size === 0 && this.running.size === 0
      && this.initializations.size === 0 && this.initializationRecoveries.size === 0 && this.noticeSends.size === 0 && this.interruptPromises.size === 0 && this.detachPromises.size === 0 && this.modelChanges.size === 0 && this.activeCommands === 0;
  }

  /** Current controller activity, separate from execution-child activity. */
  controllerActivity(conversationId: string): { running: boolean; pending: number; initializing: boolean; stopped: boolean } {
    const conversation = this.store.getConversation(conversationId);
    return { running: !!conversation && this.running.get(conversation.userId)?.conversationId === conversationId,
      pending: this.store.pendingCount(conversationId), initializing: this.initializations.has(conversationId),
      stopped: this.closed || this.draining };
  }

  discard(message: BridgeMessage): void {
    if (!this.closed && this.config.allowedUserIds.includes(message.userId)) this.store.addMessage(message, null, 'cancelled');
  }

  hasMessage(id: string): boolean { return this.store.hasMessage(id); }

  storedHostEvent(id: string): BridgeMessage | null {
    const item = this.store.getMessage(id); return item?.groupContext ? item : null;
  }
  private groupContextKey(context: GroupTurnContext, includeGeneration = true): string {
    return JSON.stringify([context.eventId, context.rootId, context.botId, context.spaceId,
      ...(includeGeneration ? [context.generation] : []), context.bindingEpoch, context.originChannelId,
      context.principalId, context.eventKind ?? null]);
  }
  private authorizeGroupEvent(item: BridgeMessage, conversationId: string): void {
    if (item.groupContext) this.authorizedGroupEvents.set(item.id, { conversationId, contextKey: this.groupContextKey(item.groupContext) });
  }
  private canProcessQueued(item: InboxItem): boolean {
    if (!item.groupContext) return true;
    const accepted = this.authorizedGroupEvents.get(item.id);
    return accepted?.conversationId === item.conversationId && accepted.contextKey === this.groupContextKey(item.groupContext);
  }
  /** Only the host's fresh reservation may resume a durable group inbox row after restart. */
  async resumeHostEvent(message: BridgeMessage, options: { allowContinuousRebind?: boolean } = {}): Promise<{ status: 'queued' | 'running' | 'terminal'; state: InboxState }> {
    if (this.closed || this.draining) throw new Error('当前桥不能恢复群事件。');
    const item = this.store.getMessage(message.id), incoming = message.groupContext;
    if (!item?.groupContext || !incoming || item.userId !== message.userId || item.channelId !== message.channelId
      || item.text !== message.text || JSON.stringify(item.imagePaths) !== JSON.stringify(message.imagePaths)
      || this.groupContextKey(item.groupContext, false) !== this.groupContextKey(incoming, false)
      || !this.config.allowedUserIds.includes(item.userId) || this.options.authorizeUser?.(item.userId) === false) throw new Error('群恢复事件与已持久输入或路由不匹配。');
    if (item.state !== 'queued') return { status: item.state === 'running' || item.state === 'steering' ? 'running' : 'terminal', state: item.state };
    const active = this.store.getActive(item.userId);
    if (!active || active.id !== item.conversationId || this.pendingSwitches.has(item.userId)) throw new Error('群恢复事件尚未绑定当前主控。');
    if (incoming.generation !== item.groupContext.generation) {
      if (!options.allowContinuousRebind || !Number.isSafeInteger(incoming.generation) || incoming.generation <= item.groupContext.generation) throw new Error('群恢复事件代次与持久输入不一致。');
      if (!this.store.updateQueuedGroupContext(item.id, active.id, incoming)) throw new Error('群恢复事件已不在原排队状态。');
    }
    const persisted = this.store.getMessage(item.id)!;
    this.authorizeGroupEvent(persisted, active.id); this.setLatestMessage(persisted, active.id);
    this.wake(active.id); return { status: 'queued', state: 'queued' };
  }
  /** A cancelled host event releases its FIFO barrier without replaying uncertain or started work. */
  cancelHostEvent(id: string, reason = '宿主群事件已取消'): boolean {
    const item = this.store.getMessage(id);
    if (this.closed || !item?.groupContext || item.state !== 'queued') return false;
    this.authorizedGroupEvents.delete(id); this.store.setState(id, 'cancelled', reason);
    if (item.conversationId) this.wake(item.conversationId); return true;
  }

  knownChannels(): Array<{ userId: string; channelId: string; cursor: string }> { const users = this.authorizedUsers(); return this.store.knownChannels().filter(route => users.includes(route.userId)); }

  knownDMChannels(): Array<{ userId: string; channelId: string; cursor: string }> { const users = this.authorizedUsers(); return this.store.knownDMChannels().filter(route => users.includes(route.userId)); }

  /** Trusted host events retain their kind in group_json; they never become new human instructions after restart. */
  async handleHostEvent(message: BridgeMessage, kind: 'worker-result' | 'wake' | 'group-event'): Promise<void> {
    if (!message.groupContext || !this.store.getActive(message.userId)) throw new Error('群内部事件缺少当前主控或可信现场。');
    await this.handle({ ...message, groupContext: { ...message.groupContext, eventKind: kind } });
  }  async handle(message: BridgeMessage, commandReply?: (text: string, options?: ReplyOptions) => Promise<void>): Promise<void> {
    if (this.closed) throw new Error('桥已关闭');
    if (!this.config.allowedUserIds.includes(message.userId) || this.options.authorizeUser?.(message.userId) === false || this.hasMessage(message.id)) return;
    const parsed = message.groupContext?.eventKind ? null : command(message.text);
    if (parsed || message.groupContext) this.privateInputBarrier(message.userId, 'input:' + message.id);
    if (this.pendingSwitches.has(message.userId) && parsed?.name !== 'status' && parsed?.name !== 'help') throw new Error('上次 Agent 切换提交尚待核对；请先恢复操作日志。');
    if (parsed) {
      // Raw command receipt stays in DurableIngress until the next process can execute it.
      if (this.draining) return;
      if (!this.store.addMessage(message, null, 'command')) return;
      // An interaction reply belongs to this command invocation, never to a channel or queued turn.
      const deliver = commandReply ?? ((text: string, options?: ReplyOptions) => this.sink.sendText(message.channelId, text, options));
      const reply = (text: string, options?: ReplyOptions) => {
        const view: BridgePresentation = options?.presentation ?? { title: `命令结果 · /${parsed.name}`, tone: 'info', blocks: [{ kind: 'entry', text }] };
        return deliver(text, { ...options, presentation: view });
      };
      let finish!: () => void;
      const done = new Promise<void>(resolve => { finish = resolve; });
      this.commandReplies.set(message.id, { done, finish });
      this.activeCommands++;
      const resetting = ['new', 'agent', 'cwd', 'stop'].includes(parsed.name);
      if (resetting) this.resetCommands.set(message.userId, (this.resetCommands.get(message.userId) ?? 0) + 1);
      try {
        await this.handleCommand(message, parsed.name, parsed.argument, reply);
        if (this.closed) return;
        this.store.setState(message.id, 'completed');
        this.markReplyDelivered([message.id]);
        if (parsed.name === 'new') {
          const target = this.store.getActive(message.userId);
          if (target && this.store.workspaceNotice(target.id)?.sourceMessageId === message.id) await this.sendWorkspaceNotice(target);
        }
      } catch (error) {
        if (this.closed) return;
        this.store.setState(message.id, 'failed', String(error));
        const view = bridgeNotice('commandFailed');
        await reply(presentationText(view), { presentation: view });
      } finally {
        this.activeCommands--; finish(); this.commandReplies.delete(message.id);
        if (resetting) {
          const left = (this.resetCommands.get(message.userId) ?? 1) - 1;
          if (left) this.resetCommands.set(message.userId, left); else this.resetCommands.delete(message.userId);
          if (!this.closed) {
            this.completionAvailable();
            const active = this.store.getActive(message.userId);
            if (active && this.store.nextQueued(active.id)) this.wake(active.id);
          }
        }
      }
      return;
    }
    if (!message.text.trim() && message.imagePaths.length === 0) {
      if (this.store.addMessage(message, null, 'command')) {
        this.store.setState(message.id, 'completed');
        await this.sink.sendText(message.channelId, '请发送文字或图片；/help 查看帮助。');
        this.markReplyDelivered([message.id]);
      }
      return;
    }
    const active = message.groupContext?.eventKind ? this.store.getActive(message.userId) : this.ensureActive(message.userId);
    if (!active) throw new Error('内部事件不能自动创建主控。');
    if (!this.store.addMessage(message, active.id, 'queued')) return;
    this.authorizeGroupEvent(message, active.id);
    this.store.nameConversation(active.id, message.text);
    this.setLatestMessage(message, active.id);
    if (this.draining) return;
    const head = this.store.nextQueued(active.id);
    if (!head || this.canProcessQueued(head)) this.initializeWorkspace(active, message);
    this.refreshTaskCounts(active.id);
    this.wake(active.id);
    const running = this.running.get(message.userId);
    if (!this.config.controllerMode && running?.conversationId === active.id && running.executing && !running.controller.signal.aborted) {
      if (this.adapters[active.agent].steer && running.ready) this.pumpSupplements(active, running);
      else this.receipt(message.channelId, active.id, this.adapters[active.agent].steer
        ? '已收到补充，等待当前任务确认；无法补入时接下一轮。'
        : '已收到补充，当前后端会在本轮结束后继续处理。');
    }
  }

  async recover(): Promise<void> {
    if (this.closed || this.recovered) return;
    this.recovered = true;
    this.recovering = true;
    try {
      await this.recoverAgentSwitches();
      this.options.taskRegistry?.recoverContexts(this.authorizedUsers());
      const notices = new Set<string>();
      for (const item of [...this.store.interruptRunning(this.authorizedUsers()), ...this.store.unfinishedReplies(this.authorizedUsers())]) {
        if (this.closed) return;
        if (!this.config.allowedUserIds.includes(item.userId)) continue;
        const key = `${item.channelId}:${item.conversationId}`;
        if (notices.has(key)) continue;
        notices.add(key);
        await this.sendBridgeNotice(item.channelId, 'turnInterrupted', undefined, `interrupted:${item.id}`)
          .catch(() => undefined);
      }
      if (this.closed) return;
      for (const userId of this.authorizedUsers()) {
        if (this.store.getActive(userId)) this.ensureActive(userId);
        const active = this.store.getActive(userId);
        const latest = active ? this.store.latestMessage(active.id) : null;
        if (active && latest) this.latestMessages.set(userId, { id: latest.id, channelId: latest.channelId, conversationId: active.id });
      }
      for (const event of this.options.taskRegistry?.recoverProcessingEvents(this.authorizedUsers()) ?? []) {
        if (event.purpose === 'workspace-context') {
          const target = this.completionTarget(event);
          if (target && event.wakeAllowed && this.store.getActive(event.userId)?.id === target.id) {
            this.store.prepareWorkspaceNotice(target.id, 'unknown');
            await this.reportInitializationState(target, 'unknown', this.store.getMessage(event.originMessageId) ?? undefined);
          }
          this.options.taskRegistry?.markUncertainNotified(event.id);
          continue;
        }
        if (!this.completionTarget(event)) {
          this.options.taskRegistry?.markUncertainNotified(event.id);
          continue;
        }
        try {
          await this.sendBridgeNotice(event.channelId, 'summaryInterrupted', event.title, `recovery:${event.id}`);
          this.options.taskRegistry?.markUncertainNotified(event.id);
        } catch { /* Keep the one-time notice pending for a later recovery, never replay the model turn. */ }
      }
    } finally { this.recovering = false; }
    if (this.closed) return;
    for (const id of this.store.recoverWorkspaceNotices(this.authorizedUsers())) {
      const target = this.store.getConversation(id); if (target) await this.sendWorkspaceNotice(target);
    }
    for (const userId of this.authorizedUsers()) {
      const active = this.store.getActive(userId);
      const completedSource = active ? this.completedInitializationSource(active) : null;
      if (active && completedSource) { await this.restoreCompletedInitialization(active, completedSource); continue; }
      const source = active ? this.initializationSource(active) : null;
      const head = active ? this.store.nextQueued(active.id) : null;
      if (active && source && !source.groupContext && (!head || this.canProcessQueued(head))) this.initializeWorkspace(active, source);
    }
    for (const id of this.store.queuedConversations()) this.wake(id);
    this.completionAvailable();
  }

  private initializationSource(target: Conversation): BridgeMessage | null {
    const latest = this.store.latestMessage(target.id);
    if (latest) return latest;
    const route = this.store.knownChannels().filter(item => item.userId === target.userId).at(-1);
    const source = route ? this.store.getMessage(route.cursor) : null;
    return source?.conversationId === null && command(source.text) ? source : null;
  }

  /** Start a real read-only child without occupying the conversational turn or inventing a user prompt. */
  private initializeWorkspace(target: Conversation, source: BridgeMessage): void {
    const recorded = this.readInitializationJournal(target);
    if (this.closed || this.draining) return;
    if (recorded?.outcome === 'ready' && target.nativeId && recorded.nativeId === target.nativeId) return;
    const completedSource = this.completedInitializationSource(target);
    if (completedSource) {
      const recovery = this.restoreCompletedInitialization(target, completedSource)
        .catch(error => this.options.onInitializationError?.(target, error)).finally(() => this.initializationRecoveries.delete(recovery));
      this.initializationRecoveries.add(recovery); return;
    }
    if (recorded && recorded.outcome !== 'pending') return;
    if (!this.config.controllerMode || !this.options.onInitializeWorkspace || !this.options.taskRegistry
      || this.initializationAttempts.has(target.id)) return;
    const registeredSource = this.store.getMessage(source.id);
    if (!registeredSource || registeredSource.userId !== target.userId || registeredSource.channelId !== source.channelId
      || (registeredSource.conversationId !== target.id && !(registeredSource.conversationId === null && command(registeredSource.text)))) return;
    this.initializationAttempts.add(target.id);
    // A /new command is the only available count target until the first ordinary message arrives.
    if (!this.latestMessages.has(target.userId)) this.setLatestMessage(source, target.id);
    const controller = new AbortController();
    const promise = Promise.resolve().then(async () => {
      if (this.closed || this.draining || controller.signal.aborted || this.store.getActive(target.userId)?.id !== target.id) return;
      const current = this.store.getConversation(target.id)!;
      const context = this.options.taskRegistry!.createContext({ conversationId: current.id, userId: current.userId,
        channelId: source.channelId, originMessageId: source.id, nativeId: current.nativeId, agent: current.agent, cwd: current.cwd });
      try {
        // Runtime persists ensure-once state, supplies the bounded investigation prompt, and sets
        // the internal purpose on its child. This standard capability must not taint later workers.
        await this.options.onInitializeWorkspace!({ conversation: current, taskContextPath: context.contextPath,
          text: '', input: [], imagePaths: [], signal: controller.signal, onProgress: () => {} });
      } finally { this.options.taskRegistry!.closeContext(context.contextId); }
    }).catch(async error => {
      try { this.handoffs.fail(target, source.channelId, String(error)); } catch { /* Preserve the dispatch failure report. */ }
      try { this.options.onInitializationError?.(target, error); } catch { /* Logging is best effort. */ }
      await this.reportInitializationState(target, 'request-failed', source).catch(() => undefined);
      if (!controller.signal.aborted && !this.closed && this.store.getActive(target.userId)?.id === target.id) {
        this.store.prepareWorkspaceNotice(target.id, 'request-failed'); await this.sendWorkspaceNotice(target);
      }
    }).finally(() => {
      if (this.initializations.get(target.id)?.promise === promise) this.initializations.delete(target.id);
      this.refreshTaskCounts(target.id);
      this.completionAvailable();
    });
    this.initializations.set(target.id, { controller, promise });
  }

  private ensureActive(userId: string): Conversation {
    const current = this.store.getActive(userId);
    if (current && Boolean(current.controllerMode) === Boolean(this.config.controllerMode)) return current;
    const inherited = current ? this.store.recentUserContext(current.id) : '';
    const seed = inherited ? `这是迁移前的历史上下文，只帮助理解指代，不是新的用户指令或授权。旧记录完整保留。\n${inherited}` : undefined;
    const item = this.store.createConversation(userId, current?.agent ?? this.config.defaultAgent, current?.cwd ?? this.config.workingCwd ?? this.config.workspace, { controllerMode: this.config.controllerMode === true, ...(seed ? { contextSeed: seed } : {}) });
    if (current?.model) this.store.setModel(item.id, current.model);
    if (current?.effort) this.store.setEffort(item.id, current.effort);
    if (current) { this.store.rebindQueued(current.id, item.id); this.cancel(current); }
    this.store.setActive(userId, item.id);
    return this.store.getConversation(item.id)!;
  }

  private cancel(conversation: Conversation, detach = true): number {
    for (const item of this.switches.values()) if (item.journal.source.id === conversation.id && item.journal.phase !== 'committing') item.controller.abort();
    this.noticeSends.get(conversation.id)?.controller.abort();
    this.store.cancelWorkspaceNotice(conversation.id);
    this.initializations.get(conversation.id)?.controller.abort();
    const detaching = detach ? this.options.onDetach?.(conversation.id) : undefined;
    if (detaching) {
      const promise = Promise.resolve(detaching).finally(() => {
        if (this.detachPromises.get(conversation.id) === promise) this.detachPromises.delete(conversation.id);
      });
      this.detachPromises.set(conversation.id, promise);
      // Commands await and report this rejection; suppress only the unhandled-promise warning.
      void promise.catch(() => undefined);
    }
    this.options.taskRegistry?.cancelConversation(conversation.id);
    const latest = this.latestMessages.get(conversation.userId);
    if (latest?.conversationId === conversation.id) {
      this.latestMessages.delete(conversation.userId);
    }
    this.revisions.set(conversation.userId, this.revision(conversation.userId) + 1);
    let total = this.store.cancelPending(conversation.id);
    for (const [id, accepted] of this.authorizedGroupEvents) if (accepted.conversationId === conversation.id) this.authorizedGroupEvents.delete(id);
    const current = this.running.get(conversation.userId);
    if (current?.conversationId === conversation.id) {
      // The model is already completed while its reply is being collected or delivered.
      // Preserve that terminal state, but still count and cancel this unfinished delivery.
      if (!current.controller.signal.aborted && (current.completionEventId || this.store.getMessage(current.messageId)?.state === 'completed')) total++;
      current.controller.abort();
      this.store.setReplyState(current.messageIds, 'cancelled');
      const interruption = Promise.resolve().then(() => this.adapters[conversation.agent].interrupt(conversation.id))
        .catch(() => undefined).finally(() => this.interruptPromises.delete(interruption));
      this.interruptPromises.add(interruption);
    }
    return total;
  }

  private async awaitDetach(conversationId: string): Promise<void> {
    try { await this.detachPromises.get(conversationId); }
    finally { this.detachPromises.delete(conversationId); }
  }

  private async activate(userId: string, target: Conversation): Promise<void> {
    const previous = this.store.getActive(userId);
    if (previous) { this.cancel(previous); await this.awaitDetach(previous.id); this.store.rebindQueued(previous.id, target.id); }
    this.store.setActive(userId, target.id);
    this.store.savePreferences(this.store.getConversation(target.id)!);
    this.completionAvailable();
  }

  private modelStatus(target: Conversation): string {
    const actual = target.actualModel ?? '尚未由 CLI 回报';
    return `实际模型：${actual}\n会话选择：${target.model ?? 'CLI 默认'}\n强度选择：${target.effort ?? 'CLI 默认'}\n推理强度：${target.actualEffort ?? '尚未由 CLI 回报'}`;
  }

  private async modelInfo(target: Conversation): Promise<AgentModelInfo> {
    let info: AgentModelInfo = { models: [], defaultModel: null };
    try {
      info = await this.adapters[target.agent].getModelInfo?.(target.cwd) ?? info;
    } catch (error) {
      if (target.agent !== 'claude') throw error;
      // Older Claude CLIs can still accept aliases/custom provider IDs without metadata support.
    }
    const models = new Map(info.models.map(model => [model.id, model]));
    if (target.agent === 'claude') for (const id of ['sonnet', 'opus', 'haiku']) {
      if (!models.has(id)) models.set(id, { id, displayName: `${id} 别名` });
    }
    for (const id of this.config.modelOptions?.[target.agent] ?? []) {
      if (!models.has(id)) models.set(id, { id, displayName: '配置的自定义模型' });
    }
    return { ...info, models: [...models.values()], defaultModel: info.defaultModel };
  }

  private async handleModel(message: BridgeMessage, argument: string,
    reply: (text: string) => Promise<void>, list = false): Promise<void> {
    const target = this.ensureActive(message.userId);
    if (!argument || argument === 'list' || list) {
      const info = await this.modelInfo(target);
      if (this.closed) return;
      if (argument === 'list' || list) {
        const entries = info.models.map(model => `${model.id}${model.displayName !== model.id ? ` · ${model.displayName}` : ''}${model.isDefault ? '（目录推荐）' : ''}`);
        await reply(`${target.agent} 模型选项：\n${entries.length ? entries.join('\n') : 'CLI 尚未返回目录'}\nCLI 当前新会话默认：${info.defaultModel ?? '尚未确认'}\n/model 模型名 切换；自定义网关模型可用 /model custom 模型名。${target.agent === 'claude' ? '\n别名及自定义模型的提供方可用性以下次调用为准。' : ''}`);
      } else {
        await reply(`${target.agent}\n${this.modelStatus(target)}\nCLI 当前新会话默认：${info.defaultModel ?? '尚未确认'}\n/model list 查看选项；/model 模型名 切换当前会话。`);
      }
      return;
    }
    const busy = () => this.running.get(message.userId)?.conversationId === target.id
      || this.workers.has(target.id) || this.store.pendingCount(target.id) > 0;
    if (busy() || this.modelChanges.has(target.id)) {
      await reply('当前会话正在执行、排队或切换模型，请完成后再切换；也可 /stop 停止任务后重试。');
      return;
    }
    const custom = argument.startsWith('custom ');
    const requested = custom ? argument.slice(7).trim() : argument;
    if (!isModelId(requested)) { await reply('模型 ID 需要是至多 200 字符的单个名称；/model list 查看选项。'); return; }
    this.modelChanges.add(target.id);
    try {
      let selected: string | null = requested;
      let unverified = custom || target.agent === 'claude';
      if (requested === 'default' && !custom) {
        selected = null;
        unverified = false;
      } else if (target.agent === 'codex' && !custom && !(this.config.modelOptions?.codex ?? []).includes(requested)) {
        const info = await this.modelInfo(target);
        if (!info.models.some(model => model.id === requested)) {
          await reply(`CLI 目录没有 ${requested}，未修改会话。/model list 查看选项；确认网关支持此 ID 后，可用 /model custom ${requested}。`);
          return;
        }
      } else if (target.agent === 'codex' && !custom) unverified = true;
      if (this.closed) return;
      if (this.store.getActive(message.userId)?.id !== target.id) {
        await reply('查询期间当前会话已改变，未修改模型。请在目标会话中重试。'); return;
      }
      if (busy()) {
        await reply('查询期间已有新任务排队，未修改模型。请任务结束后重试。'); return;
      }
      if (target.effort) {
        await validateEffort(this.adapters[target.agent], { ...target, model: selected }, target.effort);
        if (busy() || this.store.getActive(message.userId)?.id !== target.id) { await reply('查询期间会话或任务状态已改变，未修改模型。'); return; }
      }
      this.store.setModel(target.id, selected);
      this.store.savePreferences(this.store.getConversation(target.id)!);
      this.store.saveActualEffort(target.id, null);
      await reply(`当前 ${target.agent} 会话下轮使用 ${selected ?? 'CLI 默认（已清除显式覆盖）'}，上下文保留。${unverified ? '\n已设置模型 ID，提供方可用性尚未验证。' : ''}`);
    } finally {
      this.modelChanges.delete(target.id);
      if (!this.closed && (this.store.pendingCount(target.id) > 0 || this.options.taskRegistry?.getNextEvent(target.id))) this.wake(target.id);
    }
  }

  private async handleEffort(message: BridgeMessage, argument: string, reply: (text: string) => Promise<void>): Promise<void> {
    const target = this.ensureActive(message.userId);
    if (!argument || argument === 'list') {
      const info = await this.modelInfo(target);
      await reply(`${target.agent}\n${this.modelStatus(target)}\n当前模型支持强度：${effortCapabilityText(modelEffortCapability(info, target))}\n/effort level 设置；/effort default 使用 CLI 默认。`);
      return;
    }
    const busy = () => this.running.get(message.userId)?.conversationId === target.id || this.workers.has(target.id) || this.store.pendingCount(target.id) > 0;
    if (busy() || this.modelChanges.has(target.id)) { await reply('当前会话正在执行、排队或切换设置，请完成后再设置强度。'); return; }
    this.modelChanges.add(target.id);
    try {
      const effort = argument === 'default' ? null : argument.toLowerCase();
      if (effort) await validateEffort(this.adapters[target.agent], target, effort);
      if (this.closed) return;
      if (busy() || this.store.getActive(message.userId)?.id !== target.id) { await reply('查询期间会话或任务状态已改变，未修改强度。'); return; }
      this.store.setEffort(target.id, effort);
      this.store.savePreferences(this.store.getConversation(target.id)!);
      await reply(`已设置当前 ${target.agent} 会话强度为 ${effort ?? 'CLI 默认'}，下轮提交；实际生效尚未由 CLI 确认。上下文保留，现有子任务不变。`);
    } finally {
      this.modelChanges.delete(target.id);
      if (!this.closed && (this.store.pendingCount(target.id) > 0 || this.options.taskRegistry?.getNextEvent(target.id))) this.wake(target.id);
    }
  }

  private switchJournalPath(id: string): string {
    if (!/^[a-f0-9-]{36}$/i.test(id)) throw new Error('Agent 切换操作标识无效。');
    return join(this.config.dataDir, 'agent-switches', id + '.json');
  }
  private saveSwitchJournal(journal: AgentSwitchJournal): void {
    const path = this.switchJournalPath(journal.target.id); mkdirSync(join(this.config.dataDir, 'agent-switches'), { recursive: true });
    journal.updatedAt = new Date().toISOString(); const temp = path + '.' + randomUUID() + '.tmp';
    writeFileSync(temp, JSON.stringify(journal), { mode: 0o600 }); renameSync(temp, path);
  }
  private async commitAgentSwitch(journal: AgentSwitchJournal): Promise<void> {
    const source = this.store.getConversation(journal.source.id), target = this.store.getConversation(journal.target.id);
    const active = source ? this.store.getActive(source.userId) : null;
    if (!source || !target || source.userId !== target.userId || active?.id !== source.id && active?.id !== target.id
      || (this.config.controllerMode && !target.nativeId)) throw new Error('切换操作的来源、目标或原生会话无法确认，拒绝重新派发。');
    journal.phase = 'committing'; this.pendingSwitches.add(source.userId); this.saveSwitchJournal(journal);
    if (this.config.controllerMode && !this.options.onRebindSwitch) throw new Error('Agent 切换提交缺少任务重绑入口。');
    await this.options.onRebindSwitch?.(source, target);
    this.store.rebindQueued(source.id, target.id);
    if (this.store.getActive(source.userId)?.id !== target.id) this.store.setActive(source.userId, target.id, 'agent-switch');
    this.store.savePreferences(target);
    journal.phase = 'committed'; journal.target = this.store.getConversation(target.id)!; this.saveSwitchJournal(journal); this.pendingSwitches.delete(source.userId);
    const latest = this.latestMessages.get(source.userId); if (latest?.conversationId === source.id) this.latestMessages.set(source.userId, { ...latest, conversationId: target.id });
  }
  private async recoverAgentSwitches(): Promise<void> {
    const directory = join(this.config.dataDir, 'agent-switches'); if (!existsSync(directory)) return;
    for (const file of readdirSync(directory).filter(name => /^[a-f0-9-]{36}\.json$/i.test(name))) {
      const journal = JSON.parse(readFileSync(join(directory, file), 'utf8')) as AgentSwitchJournal;
      if (journal.version !== 1 || journal.source.userId !== journal.target.userId) throw new Error('Agent 切换日志无效，拒绝自动恢复。');
      if (journal.phase === 'committing') {
        await this.options.onPauseSwitch?.(journal.source);
        await this.commitAgentSwitch(journal);
      } else if (journal.phase === 'preparing' || journal.phase === 'prepared') {
        journal.phase = 'failed'; journal.error = '准备阶段因重启中断；未重做模型调用，保留原主控。'; this.saveSwitchJournal(journal);
      }
      await this.options.onResumeSwitch?.(journal.source); await this.options.onResumeSwitch?.(journal.target);
    }
  }
  private async switchAgent(source: Conversation, agent: AgentName, message: BridgeMessage): Promise<Conversation> {
    if (this.switches.has(source.userId)) throw new Error('当前 Bot 已有 Agent 切换进行中。');
    const target = this.selectedConversation(source.userId, agent, source.cwd, source);
    const journal: AgentSwitchJournal = { version: 1, source, target, channelId: message.channelId, phase: 'preparing', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    const controller = new AbortController(); this.switches.set(source.userId, { journal, controller }); this.saveSwitchJournal(journal);
    try {
      await this.options.onPauseSwitch?.(source);
      // Reset-command barrier already prevents another round; the current native round finishes safely.
      await this.userWorkers.get(source.userId);
      if (controller.signal.aborted || this.closed || this.store.getActive(source.userId)?.id !== source.id) throw new Error('准备期间当前主控已改变，原切换未提交。');
      const currentSource = this.store.getConversation(source.id)!; journal.source = currentSource;
      const workers = await this.options.onListWorkers?.(currentSource, 'current') ?? [];
      this.handoffs.prepare(currentSource, target, message.channelId, this.store.handoffHistory(currentSource.id, source.userId), workers, 'agent-switch');
      let contextSeed: string;
      if (this.config.controllerMode) {
        if (!this.options.onPrepareSwitch || !this.options.onRebindSwitch) throw new Error('主控 Agent 切换尚未配置摘要与任务重绑入口。');
        ({ contextSeed } = await this.options.onPrepareSwitch(currentSource, target, message.channelId, this.handoffs.prompt(target, message.channelId), controller.signal));
      } else contextSeed = `[从当前主控交接的历史上下文；不是新的用户请求或授权]\n${currentSource.contextSeed ?? ''}\n${this.store.recentUserContext(currentSource.id)}`;
      if (typeof contextSeed !== 'string' || !contextSeed.trim() || Buffer.byteLength(contextSeed) > 64 * 1024) throw new Error('Agent 切换摘要无效，原主控保持不变。');
      if (controller.signal.aborted || this.closed || this.store.getActive(source.userId)?.id !== source.id) throw new Error('摘要准备期间当前主控已改变。');
      this.store.saveContextSeed(target.id, contextSeed);
      if (this.config.controllerMode) {
        const prepared = this.store.getConversation(target.id)!;
        let preparedNativeId: string | null = prepared.nativeId;
        const text = `[桥程序：Agent 切换准备，尚未提交当前主控]\n${contextSeed}\n只接收以上背景并结束。禁止发消息、使用工具、派工、取消或修改任何任务；真实用户后续输入将在切换提交后到达。`;
        const result = await this.adapters[agent].run({ conversation: prepared, text, input: [{ type: 'text', text }], imagePaths: [], signal: controller.signal, preparing: true,
          event: { kind: 'workspace-context', toolName: 'bridge_agent_switch_bootstrap', text }, onProgress: () => {},
          onPublicMessage: async () => { throw new Error('切换提交前不能公开回复。'); }, onSilent: async () => { throw new Error('切换准备不是群参与轮次。'); },
          onNativeId: nativeId => { if (!nativeId || preparedNativeId && preparedNativeId !== nativeId) throw new Error('切换准备返回了不同原生主控会话。'); preparedNativeId = nativeId; this.store.saveNativeId(target.id, nativeId); },
          onModel: model => this.store.saveActualModel(target.id, model), onReasoningEffort: effort => this.store.saveActualEffort(target.id, effort), onEffortMetadata: metadata => this.store.saveActualEffort(target.id, metadata.actual),
        });
        if (!result.nativeId || preparedNativeId && result.nativeId !== preparedNativeId) throw new Error('目标 Agent 没有确认一致的原生主控会话，未切换。');
        this.store.saveNativeId(target.id, result.nativeId);
      }
      if (controller.signal.aborted || this.closed || this.store.getActive(source.userId)?.id !== source.id) throw new Error('目标准备期间当前主控已改变。');
      journal.target = this.store.getConversation(target.id)!; journal.phase = 'prepared'; this.saveSwitchJournal(journal);
      await this.commitAgentSwitch(journal);
      // Close only the old idle controller transport. Execution workers and plans were rebound, not cancelled.
      await this.adapters[source.agent].interrupt(source.id).catch(() => undefined);
      return this.store.getConversation(target.id)!;
    } catch (error) {
      if (journal.phase !== 'committing') { journal.phase = 'failed'; journal.error = String(error).slice(0, 1500); this.saveSwitchJournal(journal); }
      else this.pendingSwitches.add(source.userId);
      throw error;
    } finally {
      this.switches.delete(source.userId);
      if (journal.phase !== 'committing') { await this.options.onResumeSwitch?.(source); await this.options.onResumeSwitch?.(target); }
      if (!this.closed && !this.pendingSwitches.has(source.userId)) this.completionAvailable();
    }
  }  private async handleCommand(message: BridgeMessage, name: string, argument: string,
    reply: (text: string, options?: ReplyOptions) => Promise<void>): Promise<void> {
    const current = this.store.getActive(message.userId);
    if (!current && ['stop', 'new', 'cwd', 'agent'].includes(name)) {
      this.revisions.set(message.userId, this.revision(message.userId) + 1);
    }
    switch (name) {
      case 'help': {
        const view: BridgePresentation = { title: '命令与用法', tone: 'info', purpose: 'help', blocks: [{ kind: 'entry', text: commandHelp(this.config.controllerMode) }], footer: '平台和 bot 在启动前选择，不通过聊天命令切换。' };
        await reply(presentationText(view), { presentation: view }); return;
      }
      case 'model': await this.handleModel(message, argument, reply); return;
      case 'effort': await this.handleEffort(message, argument, reply); return;
      case 'models': await this.handleModel(message, '', reply, true); return;
      case 'new':
      case 'agent': {
        if (name === 'agent' && !argument) {
          await reply(`当前 Agent：${agentDisplayName(current?.agent ?? this.config.defaultAgent)}\n/agent codex → Codex CLI\n/agent claude → Claude Code\n真正切换时交接当前 Bot 的最新上下文，保留助手与计划；/new 明确新建，/chats 只读查看历史。`); return;
        }
        const request = name === 'new' ? parseNewArguments(argument) : argument === 'codex' || argument === 'claude' ? { agent: argument, continue: false } : null;
        if (!request) {
          await reply(`用法：/${name} ${name === 'new' ? '[continue] [codex|claude]' : 'codex|claude'}`); return;
        }
        if (request.continue && (!current || !this.config.controllerMode || !this.options.onInitializeWorkspace || !this.options.taskRegistry)) {
          await reply('当前没有可交接的主控会话；请先用 /new 新建。'); return;
        }
        const agent = (request.agent || current?.agent || this.config.defaultAgent) as AgentName;
        const previousWorkers = request.continue ? await this.options.onListWorkers?.(current!, 'current') ?? [] : [];
        if (request.continue && this.store.getActive(message.userId)?.id !== current!.id) throw new Error('准备交接时会话已切换，请重新发送 /new continue。');
        if (name === 'agent' && current?.agent === agent) {
          await reply(`当前已是 ${agentDisplayName(agent)}，继续原会话 ${current.id.slice(0, 8)}。\n原生会话：${current.nativeId ? `…${current.nativeId.slice(-6)}` : '尚未创建'}\n需要清空上下文请用 /new。`); return;
        }
        if (name === 'agent' && current) {
          const switched = await this.switchAgent(current, agent, message);
          await reply(`已切换到 ${agentDisplayName(agent)}，接续当前 Bot 的最新上下文。\n会话：${switched.id.slice(0, 8)}\n原生会话：${switched.nativeId ? `…${switched.nativeId.slice(-6)}` : '下轮创建'}\n普通助手与定时计划保留。`);
          if (this.store.nextQueued(switched.id)) this.wake(switched.id);
          return;
        }
        const target = this.selectedConversation(message.userId, agent, current?.cwd ?? this.config.workingCwd ?? this.config.workspace, current);
        if (request.continue) {
          // Freeze the confirmed parent selection before cancelling old work; a remote default cannot choose it.
          const model = (current!.agent === agent ? current!.model ?? current!.actualModel : null)
            ?? this.config.defaultModels?.[agent] ?? (await this.adapters[agent].getModelInfo?.(target.cwd))?.defaultModel;
          if (!model || model === 'default' || !isModelId(model)) throw new Error('无法确认续接模型，原会话保持不变。');
          if (this.store.getActive(message.userId)?.id !== current!.id) throw new Error('准备交接时会话已切换。');
          this.store.setModel(target.id, model);
          if (current!.agent === agent) this.store.setEffort(target.id, current!.effort ?? current!.actualEffort ?? null);
          this.handoffs.prepare(current!, this.store.getConversation(target.id)!, message.channelId,
            this.store.handoffHistory(current!.id, message.userId), previousWorkers);
        } else {
          if (current?.agent === agent && (current.model || current.modelPolicy === 'cli-default')) this.store.setModel(target.id, current.model ?? null);
          if (current?.agent === agent && current.effort) this.store.setEffort(target.id, current.effort);
        }
        try { await this.activate(message.userId, this.store.getConversation(target.id)!); }
        catch (error) { if (request.continue) this.handoffs.fail(target, message.channelId, String(error)); throw error; }
        if (this.config.controllerMode && name === 'new') this.store.requestWorkspaceNotice(target.id, message);
        this.initializeWorkspace(this.store.getConversation(target.id)!, message);
        const text = `已新建 ${agentDisplayName(agent)} 会话 ${target.id.slice(0, 8)}。${this.config.controllerMode ? request.continue ? '正在整理上一会话并初始化工作区；完成后由主控简短续接。' : '正在初始化工作区；完成后由主控发送介绍。' : '可以直接发消息开始。'}\n目录：${target.cwd}`;
        await reply(text, { presentation: { title: `新会话已创建 · ${agentDisplayName(agent)}`, tone: 'info', purpose: 'status',
          blocks: [{ kind: 'entry', text }] } });
        return;
      }
      case 'cwd': {
        if (!argument) { await reply('用法：/cwd 目录路径'); return; }
        const value = argument.replace(/^(["'])([\s\S]*)\1$/, '$2');
        const cwd = isAbsolute(value) ? value : resolve(current?.cwd ?? this.config.workingCwd ?? this.config.workspace, value);
        if (!statSync(cwd).isDirectory()) { await reply('指定路径不是目录。'); return; }
        const target = this.store.createConversation(message.userId, current?.agent ?? this.config.defaultAgent, cwd, { controllerMode: this.config.controllerMode === true });
        if (current?.model || current?.modelPolicy === 'cli-default') this.store.setModel(target.id, current.model ?? null);
        if (current?.effort) this.store.setEffort(target.id, current.effort);
        await this.activate(message.userId, target);
        this.initializeWorkspace(this.store.getConversation(target.id)!, message);
        await reply(`已在 ${cwd} 新建 ${target.agent} 会话 ${target.id.slice(0, 8)}。`);
        return;
      }
      case 'chats': {
        const items = this.store.listConversations(message.userId);
        await reply(items.length ? items.map(item =>
          `${item.id === current?.id ? '→ ' : ''}${item.id.slice(0, 8)} · ${item.agent} · ${item.title}`).join('\n') : '还没有会话，发送文字或图片即可开始。');
        return;
      }
      case 'presetlist': {
        if (argument) { await reply('用法：/presetlist；直接查看可派发预设的全部口语别名。'); return; }
        let entries: Awaited<ReturnType<typeof listPresets>>;
        try { entries = await listPresets(this.config.contextWorkspace ?? this.config.workspace); }
        catch { await reply('预设清单读取失败，请检查工作区的预设登记文件。'); return; }
        const available = entries.filter(item => item.enabled);
        if (!available.length) { await reply('当前工作区暂无已启用的派发预设。'); return; }
        await reply(['可派发预设 · 别名速查',
          ...available.map(item => `${item.aliases.join(' / ')} · ${item.model}`),
          `用法示例：用“${available[0]!.aliases[0]}”处理任务。`,
        ].join('\n')); return;
      }
      case 'computers': {
        const args = argument.split(/\s+/).filter(Boolean);
        if (args.some(value => !['refresh', 'cached', 'details'].includes(value)) || new Set(args).size !== args.length || args.includes('refresh') && args.includes('cached')) {
          await reply('用法：/computers [refresh|cached] [details]；默认刷新，details 展开详情。'); return;
        }
        if (!this.options.onListComputers) { await reply('桥尚未配置电脑清单查询。'); return; }
        const target = current ?? this.ensureActive(message.userId);
        let items: ComputerOverview[];
        try { items = await this.options.onListComputers(target, !args.includes('cached')); }
        catch { throw new Error('电脑清单检查失败，请稍后重试。'); }
        const view = computerOverview(items, args.includes('details')); await reply(presentationText(view), { presentation: view }); return;
      }
      case 'workers': { await this.replyWorkers(message.userId, argument, reply); return; }
      case 'status': {
        const running = current && this.running.get(message.userId)?.conversationId === current.id;
        const blocks: BridgePresentation['blocks'] = [{ kind: 'entry', text:
          `平台：${this.config.platform === 'feishu' ? '飞书' : 'Discord'}\n机器人：${this.options.botName?.() ?? this.config.applicationId ?? '未回报'}\nProfile：${this.config.profile ?? '未设置'}\n模式：${this.config.controllerMode ? '主控' : '直接执行'}\nAgent：${agentDisplayName(current?.agent ?? this.config.defaultAgent)}` }];
        if (current) blocks.push({ kind: 'entry', text: `会话：${current.id.slice(0, 8)} · ${current.title}\n${this.modelStatus(current)}\n原生会话：${current.nativeId ?? '尚未创建'}\n目录：${current.cwd}\n状态：${running ? this.config.controllerMode ? '主控处理1' : '正在执行' : '空闲'}；排队 ${this.store.pendingCount(current.id)} 条${this.options.taskRegistry ? `\n已登记未结束的子 Agent：${this.options.taskRegistry.activeCount(current.id)}` : ''}` });
        else blocks.push({ kind: 'entry', text: `会话：尚未创建\n模型选择：CLI 默认\n强度选择：CLI 默认\n实际模型／强度：尚未由 CLI 回报\n目录：${this.config.workspace}\n状态：空闲；排队 0 条` });
        const view: BridgePresentation = { title: '桥状态', tone: 'info', purpose: 'status', blocks, footer: current
          ? '直接发送文字或图片继续；/new 新建会话，/help 查看命令。'
          : '发送第一条文字或图片即可新建会话。/status 只查询状态，不创建会话。' };
        await reply(presentationText(view), { presentation: view }); return;
      }
      case 'restart': {
        if (argument) { await reply('用法：/restart'); return; }
        if (!this.options.onRequestRestart) { await reply('当前部署未启用桥重启。'); return; }
        const result = await this.options.onRequestRestart({
          conversationId: current?.id ?? 'bridge', userId: message.userId, channelId: message.channelId,
          originMessageId: message.id, nativeId: current?.nativeId ?? null,
        });
        await reply(result.accepted ? '已安排重启，当前任务结束后执行。'
          : result.status === 'supervisor_required' ? '当前桥未通过监督器启动，无法自动重启。' : '桥正在关闭，未安排重启。');
        return;
      }
      case 'stop': {
        const count = current ? this.cancel(current, false) : 0;
        if (current) await this.options.onStop?.(current.id);
        await reply(`${count ? `已停止当前任务，取消 ${count} 条待处理任务。会话保留，可继续发送消息。` : '当前没有待处理任务。'}${this.options.taskRegistry ? this.config.controllerMode ? '\n已停止桥管理的子 Agent，并取消后台自动汇总和预约；独立远端进程需另行确认。' : '\n已取消后台结果的自动汇总；远端子任务仍可继续，完成后仅发送带来源的通知。' : ''}`);
        this.completionAvailable();
        return;
      }
      default: await reply('未知命令；/help 查看可用命令。');
    }
  }

  private markReplyDelivered(messageIds: string[]): void {
    if (!this.sink.markReplyDelivered) return;
    try {
      const messages = messageIds.flatMap(id => {
        const message = this.store.getMessage(id);
        return message && shouldShowMessageReceipts(this.config, { text: message.text, isGroup: !!message.groupContext })
          ? [{ id: message.id, channelId: message.channelId, text: message.text, isGroup: !!message.groupContext }] : [];
      });
      if (messages.length) void Promise.resolve()
        .then(() => this.sink.markReplyDelivered?.(messages))
        .catch(() => undefined);
    } catch {
      // Reactions are best effort and never change a successfully delivered reply.
    }
  }

  private receipt(channelId: string, key: string, text: string): void {
    const now = Date.now();
    if (now - (this.receipts.get(key) ?? -Infinity) < (this.options.receiptIntervalMs ?? 15_000)) return;
    this.receipts.set(key, now);
    void this.sink.sendText(channelId, text).catch(() => undefined);
  }

  private pumpSupplements(target: Conversation, turn: RunningTurn): void {
    if (this.config.controllerMode || this.store.getMessage(turn.messageId)?.groupContext) return;
    turn.supplements = turn.supplements.then(async () => {
      const adapter = this.adapters[target.agent];
      if (!adapter.steer || !turn.ready || !turn.executing || turn.controller.signal.aborted || this.closed || this.draining) return;
      for (const item of this.store.queuedBatch(target.id)) {
        if (item.groupContext) return;
        if (!turn.executing || turn.controller.signal.aborted || this.closed || this.draining
          || this.store.getActive(item.userId)?.id !== target.id) return;
        // 在 RPC 写入前持久化；崩溃后 steering 不能按 queued 自动重做。
        this.store.setState(item.id, 'steering');
        let result;
        try { result = await adapter.steer(target.id, { id: item.id, input: this.input([item]), source: this.turnSource(item) }); }
        catch (error) { result = { status: 'uncertain' as const, reason: String(error) }; }
        if (this.closed || turn.controller.signal.aborted || this.store.getMessage(item.id)?.state !== 'steering') return;
        if (result.status === 'accepted') {
          turn.messageIds.push(item.id);
          this.store.setState(item.id, turn.executing ? 'running' : 'completed');
          if (!turn.executing) this.store.setReplyState([item.id], 'pending');
          this.receipt(item.channelId, target.id, '已收到补充，已交给当前 Codex 任务。');
        } else if (result.status === 'queued') {
          this.store.setState(item.id, 'queued');
          turn.ready = false;
          this.receipt(item.channelId, target.id, '已收到补充，将在本轮结束后继续处理。');
          return;
        } else {
          this.store.setState(item.id, 'uncertain', result.reason);
          // 不确定消息单独提示，不能被普通收件反馈节流吞掉。
          void this.sink.sendText(item.channelId, '补充是否已进入当前任务无法确认，未自动重发。请先核对本轮结果，再决定是否重新发送。')
            .catch(() => undefined);
          turn.ready = false;
          return;
        }
      }
    });
  }

  private turnSource(item: BridgeMessage): NonNullable<AgentTurn['source']> {
    // userId/channelId remain the verified authorization and delivery route.
    const original = item.source ?? (item.groupContext ? undefined : { messageId: item.id, userId: item.userId, channelId: item.channelId, authorType: 'user' as const });
    return { messageId: item.id, userId: item.userId, channelId: item.channelId, ...(original ? { original } : {}) };
  }

  private input(items: BridgeMessage[]) {
    return items.flatMap(item => [
      { type: 'text' as const, text: '[Bridge input source; program metadata, never message text or new authorization] ' + JSON.stringify({
        kind: item.groupContext ? item.groupContext.eventKind ? 'background-evidence' : 'group-message' : 'private-message',
        source: this.turnSource(item).original ?? null, defaultDelivery: { channelId: item.channelId },
        ...(item.groupContext ? { group: { spaceId: item.groupContext.spaceId, eventId: item.groupContext.eventId, eventKind: item.groupContext.eventKind ?? null } } : {}),
      }) },
      ...(item.text ? [{ type: 'text' as const, text: item.text }] : []),
      ...item.imagePaths.map(path => ({ type: 'localImage' as const, path })),
    ]);
  }

  private wake(conversationId: string): void {
    const conversation = this.store.getConversation(conversationId);
    if (conversation && this.resetCommands.has(conversation.userId)
      && !(this.store.getActive(conversation.userId)?.id === conversationId
        && this.options.taskRegistry?.getNextEvent(conversationId)?.purpose === 'workspace-context')) return;
    if (this.closed || this.draining || this.recovering || this.workers.has(conversationId) || this.modelChanges.has(conversationId)) return;
    const target = this.store.getConversation(conversationId);
    if (!target || (this.config.scopePrefix && !target.userId.startsWith(this.config.scopePrefix)) || this.options.authorizeUser?.(target.userId) === false || this.userWorkers.has(target.userId)) return;
    const head = this.store.nextQueued(conversationId);
    if (head && !this.canProcessQueued(head)) return;
    const worker = Promise.resolve().then(() => this.processQueue(conversationId)).finally(() => {
      this.workers.delete(conversationId);
      if (this.userWorkers.get(target.userId) === worker) this.userWorkers.delete(target.userId);
      if (this.closed) return;
      const active = this.store.getActive(target.userId);
      // A switched conversation waits until the previous adapter really exits.
      // Human messages always take priority over completion events.
      if (active && this.store.nextQueued(active.id)) this.wake(active.id);
      this.completionAvailable();
    });
    this.workers.set(conversationId, worker);
    this.userWorkers.set(target.userId, worker);
    // Errors from Discord delivery must not become unhandled rejections.
    void worker.catch(() => undefined);
  }

  private sendBridgeNotice(channelId: string, code: BridgeNoticeCode, taskTitle?: string, deliveryKey?: string): Promise<void> {
    const view = bridgeNotice(code, { taskTitle });
    return this.sink.sendText(channelId, presentationText(view), { presentation: view, ...(deliveryKey ? { deliveryKey } : {}) });
  }

  /** Explicit coordinating output never treats prose file citations as upload requests. */
  private async publishControlled(target: Conversation, route: { id: string; userId: string; channelId: string; groupContext?: GroupTurnContext },
    text: string, paths: string[], messageKey: string | undefined, signal: AbortSignal,
    current: () => boolean, model: string | null, effort: string | null, effortMetadata: EffortMetadata | null = null, targetId?: string, finish = true): Promise<void> {
    if (!current()) throw new Error('当前主控轮次已经停止');
    if (this.running.get(route.userId)?.publicationUncertain)
      throw Object.assign(new Error('本轮投递待核对，未重复发送。'), { deliveryUncertain: true, publicationFailed: true });
    if (typeof text !== 'string' || text.length > 64 * 1024 || !Array.isArray(paths)
      || paths.length > 10 || paths.some(path => typeof path !== 'string' || !isAbsolute(path)
        || path.length > 4096 || /[\r\n\0<>]/.test(path))) throw new Error('公开回复或附件声明无效');
    const nativeId = this.store.getConversation(target.id)?.nativeId;
    if (!nativeId) throw new Error('主控会话尚未绑定，不能发送回复');
    const key = `${target.agent}:${target.id}:${nativeId}:${messageKey ?? randomUUID()}`;
    const hash = createHash('sha256').update(JSON.stringify([text, paths, targetId ?? null, finish])).digest('hex');
    const claim = this.store.claimPublicMessage(key, target.id, nativeId, route.channelId, hash, text);
    if (claim === 'delivered') return;
    if (claim === 'uncertain') throw Object.assign(new Error('这条回复的投递状态未知，已保留，未重复发送'), { deliveryUncertain: true, publicationFailed: true });
    let attempted = false;
    try {
      const outgoing = await collectOutgoingPaths(paths,
        [target.cwd, join(this.config.dataDir, 'outgoing')], this.config.maxImageBytes, this.config.maxFileBytes, signal);
      if (!current()) throw new Error('主控轮次在附件准备期间停止');
      const identity = { conversationId: target.id, agent: target.agent, nativeId };
      const header = replyHeader(identity, this.store.getLastDelivery(route.userId, route.channelId), model, effort, effortMetadata);
      const fallback = outgoing.files.length ? '文件已附上。' : outgoing.images.length ? '图片已附上。' : '';
      if (!text.trim() && !fallback) throw new Error('公开回复不能为空');
      const deliver = (channelId = route.channelId) => { attempted = true; return this.sink.sendText(channelId, `${header}\n\n${text || fallback}`, {
        repeatHeader: header, signal, deliveryKey: key, ...(outgoing.images.length ? { images: outgoing.images } : {}),
        ...(outgoing.files.length ? { files: outgoing.files } : {}),
      }); };
      if (this.options.onControllerPublish) await this.options.onControllerPublish({ conversation: target, source: { messageId: route.id, userId: route.userId, channelId: route.channelId }, groupContext: route.groupContext, signal, finish }, text, paths, targetId, messageKey, deliver);
      else {
        if (targetId) throw new Error('当前运行模式未提供已授权的目标投递入口');
        if (route.groupContext && this.options.onGroupPublish) await this.options.onGroupPublish(route.groupContext, text, paths, deliver); else await deliver();
      }
      if (!current()) throw new Error('主控轮次在投递期间停止');
      this.store.finishPublicMessage(key, 'delivered');
      if (!targetId) this.store.saveDelivery(route.userId, route.channelId, identity);
    } catch (error) {
      this.store.finishPublicMessage(key, 'uncertain', errorEvidence(error, [this.config.token, this.config.appSecret ?? '']));
      const uncertain = attempted || !!(error && typeof error === 'object' && 'deliveryUncertain' in error);
      if (uncertain) { const turn = this.running.get(route.userId); if (turn) turn.publicationUncertain = true; }
      throw Object.assign(error instanceof Error ? error : new Error('回复发送失败'), { publicationFailed: true, ...(uncertain ? { deliveryUncertain: true } : {}) });
    }
  }

  private async processQueue(conversationId: string): Promise<void> {
    // 首条消息后固定短窗口，避免连续输入无限延长启动时间。
    if (!this.config.controllerMode && this.options.mergeDelayMs !== 0) await new Promise<void>(resolve => setTimeout(resolve, this.options.mergeDelayMs ?? 1000));
    while (!this.closed && !this.draining && !this.modelChanges.has(conversationId)) {
      const owner = this.store.getConversation(conversationId);
      if (owner && this.resetCommands.has(owner.userId)) {
        const initialization = this.options.taskRegistry?.getNextEvent(conversationId);
        if (this.store.getActive(owner.userId)?.id !== conversationId || initialization?.purpose !== 'workspace-context') return;
        // Initialization can settle while ACK delivery waits; its own publication already awaits that ACK.
        await this.processCompletion(initialization); continue;
      }
      const active = owner ? this.store.getActive(owner.userId) : null;
      if (active && active.id !== conversationId && this.store.nextQueued(active.id)) return;
      const item = this.store.nextQueued(conversationId);
      if (!item) {
        const event = this.options.taskRegistry?.getNextEvent(conversationId);
        if (!event) return;
        await this.processCompletion(event);
        continue;
      }
      const target = this.store.getConversation(conversationId);
      if (!target || !this.config.allowedUserIds.includes(item.userId) || this.options.authorizeUser?.(item.userId) === false
        || this.store.getActive(item.userId)?.id !== conversationId) {
        this.authorizedGroupEvents.delete(item.id); this.store.setState(item.id, 'cancelled'); continue;
      }
      if (!this.canProcessQueued(item)) return;
      this.initializeWorkspace(target, item);
      const controller = new AbortController();
      const pending = this.store.queuedBatch(conversationId), firstGroup = pending.findIndex(value => value.groupContext);
      const batch = this.config.controllerMode || this.options.mergeDelayMs === 0 || item.groupContext ? [item]
        : firstGroup < 0 ? pending : pending.slice(0, firstGroup);
      this.authorizedGroupEvents.delete(item.id);
      const turn: RunningTurn = { messageId: item.id, messageIds: batch.map(value => value.id),
        conversationId, controller, ready: false, executing: true, supplements: Promise.resolve() };
      this.running.set(item.userId, turn);
      for (const value of batch) this.store.setState(value.id, 'running');
      const current = () => !this.closed && !controller.signal.aborted
        && this.running.get(item.userId) === turn
        && this.config.allowedUserIds.includes(item.userId) && this.options.authorizeUser?.(item.userId) !== false
        && this.store.getActive(item.userId)?.id === conversationId
        && this.store.getMessage(item.id)?.state === 'running';
      let actualModel: string | null = null;
      let actualEffort: string | null = null;
      let effortMetadata: EffortMetadata | null = null;
      let contextId: string | undefined;
      let groupContext = item.groupContext;
      let groupOutcome: 'completed' | 'silent' | 'failed' = 'failed';
      let silent = false;
      let supplementaryPublished = false;
      let privateReplyDelivered = false;
      let privateFinalStarted = false;
      const privateControllerInput = this.config.controllerMode === true && !groupContext;
      try {
        if (privateControllerInput) this.store.startPrivateBatch(item.id);
        if (groupContext && this.options.onGroupTurnStart) groupContext = { ...groupContext, scene: await this.options.onGroupTurnStart(groupContext) };
        if (!current()) throw new Error('消息轮次已经停止');
        const chatScene = groupContext?.scene ?? await this.options.onConversationScene?.(target, this.turnSource(item), controller.signal);
        if (!current()) throw new Error('消息轮次已经停止');
        const context = this.options.taskRegistry?.createContext({
          conversationId, userId: item.userId, channelId: item.channelId, originMessageId: item.id,
          cwd: target.cwd, agent: target.agent, nativeId: target.nativeId, ...(groupContext ? { groupContext, ...(groupContext.eventKind ? { purpose: 'host-event' as const } : {}) } : {}),
        });
        contextId = context?.contextId;
        const result = await this.adapters[target.agent].run({
          ...(context ? { taskContextPath: context.contextPath } : {}),
          ...(chatScene != null ? { chatScene } : {}),
          ...(groupContext && this.options.onSceneCheck ? { onSceneCheck: async (input: Parameters<NonNullable<AgentTurn['onSceneCheck']>>[0]) => {
            if (!current()) throw new Error('现场检查时原主控轮次已停止。');
            return this.options.onSceneCheck!(groupContext!, input);
          } } : {}),
          ...(privateControllerInput ? { onPrivateInputCheck: async () => {
            if (!current()) throw new Error('私聊补充检查时原主控轮次已停止。');
            if (privateFinalStarted) return { refreshRequired: false };
            const update = this.store.claimPrivateRefresh(item.id);
            if (!update) return { refreshRequired: false };
            turn.messageIds.push(...update.messages.map(message => message.id));
            return { refreshRequired: true, input: { version: update.version, messages: update.messages.map(message => ({
              id: message.id, userId: message.userId, channelId: message.channelId, text: message.text,
              imagePaths: [...message.imagePaths], source: this.turnSource(message).original,
            })) } };
          } } : {}),
          ...(groupContext ? { groupContext, onSilent: async () => { if (!current()) throw new Error('群轮次已经停止'); await this.options.onGroupSilent?.(groupContext!); silent = true; } } : {}),
          ...(groupContext?.eventKind ? { event: { kind: groupContext.eventKind, text: item.text } } : {}),
          conversation: target, source: this.turnSource(item), text: `${!target.nativeId && target.contextSeed ? target.contextSeed + '\n\n当前用户消息：\n' : ''}${batch.map(value => value.text).filter(Boolean).join('\n\n')}`,
          imagePaths: batch.flatMap(value => value.imagePaths), input: [
            ...(!target.nativeId && target.contextSeed ? [{ type: 'text' as const, text: target.contextSeed + '\n\n当前用户消息：' }] : []), ...this.input(batch),
          ],
          onReady: () => { turn.ready = true; this.pumpSupplements(target, turn); },
          signal: controller.signal,
          onNativeId: nativeId => {
            if (current() && nativeId) {
              if (contextId) this.options.taskRegistry?.updateNativeId(contextId, nativeId);
              this.store.saveNativeId(conversationId, nativeId);
            }
          },
          onModel: model => {
            if (current() && model) { actualModel = model; target.actualModel = model; this.store.saveActualModel(conversationId, model); }
          },
          onReasoningEffort: effort => {
            if (current()) { actualEffort = effort; target.actualEffort = effort; this.store.saveActualEffort(conversationId, effort); }
          },
          onEffortMetadata: metadata => { if (current()) { effortMetadata = metadata; actualEffort = metadata.actual; target.actualEffort = metadata.actual; this.store.saveActualEffort(target.id, metadata.actual); } },
          // Adapters emit deltas and protocol/tool events through this callback.
          // Only the completed reply is user-facing; no asynchronous sends can linger after cancellation.
          onProgress: () => {},
          onPublicMessage: async (text, paths = [], key, targetId, finish = true) => {
            if (!current()) throw new Error('当前主控轮次已经停止');
            if (privateControllerInput && finish && targetId && targetId !== 'private')
              throw new Error('普通私聊的最终回复必须发回原私聊；向其他区域发送请用 finish:false。');
            const coverage = [...turn.messageIds];
            if (privateControllerInput && finish) privateFinalStarted = true;
            if (finish) this.store.setReplyState(coverage, 'pending');
            await this.publishControlled(target, { ...item, groupContext }, text, paths, key, controller.signal, current, actualModel, actualEffort, effortMetadata, targetId, finish);
            if (!finish && current()) supplementaryPublished = true;
            if (finish && current()) {
              this.store.setReplyState(coverage, 'delivered'); this.markReplyDelivered(coverage);
              if (privateControllerInput) privateReplyDelivered = true;
            }
          },
          ...(groupContext ? { onPublicDeliveryComplete: async () => {
            if (!current() || !supplementaryPublished) throw new Error('本轮没有已确认的群公开投递，不能完成交付。');
            this.store.setReplyState(turn.messageIds, 'delivered'); this.markReplyDelivered(turn.messageIds);
          } } : {}),
        });
        this.store.saveTurnResult(item.id, target.id, result);
        turn.executing = false;
        if (current()) {
          if (!result.nativeId) throw new Error('Agent 未返回会话 ID，无法保证连续会话');
          if (contextId) this.options.taskRegistry?.updateNativeId(contextId, result.nativeId);
          this.store.saveNativeId(conversationId, result.nativeId);
          // 模型已经执行完成；即使在途补充确认/回复期间取消也不能改成待重做。
          for (const id of turn.messageIds) this.store.setState(id, 'completed');
          if (!result.controlledOutput) this.store.setReplyState(turn.messageIds, 'pending');
        }
        await turn.supplements;
        if (this.closed || controller.signal.aborted || this.running.get(item.userId) !== turn
          || this.store.getActive(item.userId)?.id !== conversationId
          || this.store.getMessage(item.id)?.state !== 'completed') continue;
        for (const id of turn.messageIds) this.store.setState(id, 'completed');
        if (result.controlledOutput) {
          if (privateControllerInput && !privateReplyDelivered) throw Object.assign(new Error('主控尚未完成原私聊的最终回复，本批消息未标记为已答。'), { finalReplyMissing: true });
          groupOutcome = silent ? 'silent' : 'completed';
          this.store.setReplyState(turn.messageIds, 'delivered');
          continue;
        }
        this.store.setReplyState(turn.messageIds, 'pending');
        const delivering = () => !this.closed && !controller.signal.aborted
          && this.running.get(item.userId) === turn
          && this.store.getActive(item.userId)?.id === conversationId
          && this.store.getMessage(item.id)?.state === 'completed';
        const outgoing = await collectOutgoingAttachments(result.text, [target.cwd, join(this.config.dataDir, 'outgoing')],
          this.config.maxImageBytes, this.config.maxFileBytes, controller.signal);
        if (!delivering()) continue;
        const identity = { conversationId, agent: target.agent, nativeId: result.nativeId };
        const header = replyHeader(identity, this.store.getLastDelivery(item.userId, item.channelId), actualModel, actualEffort, effortMetadata);
        const attachmentText = outgoing.files.length ? '文件已附上。' : outgoing.images.length ? '图片已附上。' : '本轮完成（没有文本输出）。';
        const deliver = () => this.sink.sendText(item.channelId, `${header}\n\n${outgoing.text || attachmentText}`,
          { repeatHeader: header, signal: controller.signal, deliveryKey: `reply:${target.id}:${item.id}`, ...(outgoing.images.length ? { images: outgoing.images } : {}),
            ...(outgoing.files.length ? { files: outgoing.files } : {}) });
        if (groupContext && this.options.onGroupPublish) await this.options.onGroupPublish(groupContext, outgoing.text || attachmentText, [], deliver); else await deliver();
        if (!delivering()) continue;
        // Failed or partially delivered replies never establish successful continuity.
        this.store.saveDelivery(item.userId, item.channelId, identity);
        this.store.setReplyState(turn.messageIds, 'delivered');
        this.markReplyDelivered(turn.messageIds);
        groupOutcome = 'completed';
      } catch (error) {
        turn.executing = false;
        await turn.supplements;
        const retained = completedResultFromError(error);
        if (retained) this.store.saveTurnResult(item.id, target.id, retained, errorEvidence(error, [this.config.token, this.config.appSecret ?? '']));
        if (controller.signal.aborted || this.closed || this.store.getMessage(item.id)?.state === 'cancelled') {
          for (const id of turn.messageIds) if (this.store.getMessage(id)?.state === 'running') this.store.setState(id, 'cancelled');
          this.store.setReplyState(turn.messageIds, 'cancelled');
        } else {
          // Preserve an already completed native report even when its process cleanup failed.
          if (retained && (!target.nativeId || target.nativeId === retained.nativeId)) this.store.saveNativeId(target.id, retained.nativeId);
          for (const id of turn.messageIds) if (this.store.getMessage(id)?.state === 'running')
            this.store.setState(id, retained ? 'completed' : 'failed', errorEvidence(error, [this.config.token, this.config.appSecret ?? '']));
          const unanswered = turn.messageIds.filter(id => this.store.getMessage(id)?.replyState !== 'delivered');
          this.store.setReplyState(unanswered, 'failed');
          const handled = groupContext && this.options.onGroupTurnError
            ? await this.options.onGroupTurnError(groupContext).catch(() => true) : false;
          if (!handled) await this.sendBridgeNotice(item.channelId, retained ? 'processExitUnconfirmed'
            : error instanceof Error && 'finalReplyMissing' in error ? 'controllerReplyMissing'
            : this.store.turnResult(item.id) || error instanceof Error && 'publicationFailed' in error ? 'controllerReplyFailed' : 'controllerFailed',
            undefined, `error:${target.id}:${item.id}`).catch(() => undefined);
        }
      } finally {
        turn.executing = false;
        await turn.supplements;
        if (!this.config.allowedUserIds.includes(item.userId) || this.options.authorizeUser?.(item.userId) === false) {
          for (const id of turn.messageIds) if (this.store.getMessage(id)?.state === 'running') {
            this.store.setState(id, 'cancelled', '当前账号授权已撤销'); this.store.setReplyState([id], 'cancelled');
          }
        }
        if (contextId) this.options.taskRegistry?.closeContext(contextId);
        if (groupContext) await this.options.onGroupTurnFinished?.(groupContext, groupOutcome).catch(() => undefined);
        if (this.running.get(item.userId) === turn) this.running.delete(item.userId);
        this.refreshTaskCounts(conversationId);
      }
    }
  }

  /** Dedicated automation route: completion events never enter the human inbox. */
  completionAvailable(): void {
    if (this.closed || this.draining || this.recovering || !this.options.taskRegistry) return;
    this.refreshTaskCounts();
    for (const event of this.options.taskRegistry.queuedEvents()) {
      if (!this.config.allowedUserIds.includes(event.userId) || this.options.authorizeUser?.(event.userId) === false || (this.resetCommands.has(event.userId) && event.purpose !== 'workspace-context')) continue;
      if (!this.store.getConversation(event.conversationId)) {
        if (this.options.taskRegistry.claimEvent(event.id)) this.options.taskRegistry.markUncertain(event.id, '原父会话不存在');
        continue;
      }
      const active = this.store.getActive(event.userId);
      if (active && this.store.nextQueued(active.id)) this.wake(active.id);
      else this.wake(event.conversationId);
    }
  }

  /** 旧调用兼容：数量由全桥状态和 /workers 展示，不再修改原消息的数字表情。 */
  refreshTaskCounts(_conversationId?: string): void {}

  private setLatestMessage(message: BridgeMessage, conversationId: string): void {
    this.latestMessages.set(message.userId, { id: message.id, channelId: message.channelId, conversationId });
  }

  /** A program receipt for an explicit /new, routed independently from generated replies. */
  private async sendWorkspaceNotice(target: Conversation): Promise<void> {
    if (this.closed || !this.config.controllerMode || !target.controllerMode) return;
    const previous = this.noticeSends.get(target.id); if (previous) return previous.promise;
    const notice = this.store.workspaceNotice(target.id); if (!notice || notice.state !== 'waiting' || !notice.outcome) return;
    const source = this.store.getMessage(notice.sourceMessageId);
    if (!source || source.userId !== notice.userId || source.channelId !== notice.channelId || source.conversationId !== null
      || command(source.text)?.name !== 'new' || notice.userId !== target.userId || !this.config.allowedUserIds.includes(notice.userId)
      || this.store.getActive(notice.userId)?.id !== target.id) { this.store.cancelWorkspaceNotice(target.id); return; }
    if (source.state === 'command') return; // The original /new acknowledgement must finish first.
    if (source.state !== 'completed') { this.store.cancelWorkspaceNotice(target.id); return; }
    const outcome = notice.outcome;
    if (outcome === 'ready') return; // 成功介绍只由主控公开通道发送。
    const bodies: Record<Exclude<WorkspaceNoticeOutcome, 'ready'>, string> = {
      'read-failed': '⚠️ 工作区初始化未完成，具体失败原因已交给主控。',
      'read-cancelled': '⚠️ 工作区上下文读取已取消，结果已交给主控。',
      'load-failed': '⚠️ 初始化结果未能载入主控，结果已保存。',
      'request-failed': '⚠️ 工作区初始化请求未确认完成，请核对状态。',
      'introduction-failed': '⚠️ 工作区上下文已载入，但主控没有完成介绍；直接发消息可以继续。',
      unknown: '⚠️ 初次上下文载入结果无法确认；未自动重做。',
    };
    if (!this.store.claimWorkspaceNotice(notice)) return;
    const controller = new AbortController();
    const current = () => !this.closed && !controller.signal.aborted && this.store.getActive(notice.userId)?.id === target.id
      && this.store.workspaceNotice(target.id)?.state === 'sending';
    const promise = Promise.resolve().then(async () => {
      if (!current()) throw new Error('初次上下文回执发送已取消');
      await this.sink.sendText(notice.channelId, `${bodies[outcome]}（会话 ${target.id.slice(0, 8)}）`, { signal: controller.signal });
      if (!current()) throw new Error('初次上下文回执发送期间会话已停止或改变');
      this.store.finishWorkspaceNotice(target.id, 'delivered');
    }).catch(error => {
      this.store.finishWorkspaceNotice(target.id, 'uncertain');
      if (!controller.signal.aborted && !this.closed) {
        try { this.options.onInitializationError?.(target, error); } catch { /* Logging is best effort. */ }
      }
    }).finally(() => { if (this.noticeSends.get(target.id)?.promise === promise) this.noticeSends.delete(target.id); });
    this.noticeSends.set(target.id, { controller, promise });
    await promise;
  }

  private completionTarget(event: TaskCompletionEvent): Conversation | null {
    const target = this.store.getConversation(event.conversationId);
    const origin = this.store.getMessage(event.originMessageId);
    // Even a corrupt completion journal cannot select another person's DM or session.
    const workspaceContext = event.purpose === 'workspace-context' && target?.controllerMode;
    if (!target || !origin || (!workspaceContext && origin.state === 'command')
      || (origin.conversationId !== target.id && !(workspaceContext && origin.conversationId === null && command(origin.text)) && !event.reboundFrom?.some(previous => previous.conversationId === origin.conversationId && this.store.getConversation(previous.conversationId)?.userId === event.userId))
      || target.userId !== event.userId || origin.userId !== event.userId || origin.channelId !== event.channelId
      || target.agent !== event.agent || target.cwd !== event.cwd || !this.config.allowedUserIds.includes(event.userId) || this.options.authorizeUser?.(event.userId) === false) return null;
    return target;
  }

  private async processCompletion(event: TaskCompletionEvent): Promise<void> {
    const registry = this.options.taskRegistry!;
    const target = this.completionTarget(event);
    if (!target) {
      if (registry.claimEvent(event.id)) registry.markUncertain(event.id, '完成事件来源与原会话不一致');
      return;
    }
    if (!registry.claimEvent(event.id)) return;
    if (event.groupContext) {
      if (!event.wakeAllowed || !this.options.onGroupCompletion) { registry.markDelivered(event.id); return; }
      try { await this.options.onGroupCompletion(event); registry.markDelivered(event.id); }
      catch (error) { registry.markUncertain(event.id, String(error)); }
      return;
    }
    const observation = event.kind === 'worker-progress';
    const workspaceContext = event.purpose === 'workspace-context';
    if (observation && (!this.config.controllerMode || !target.controllerMode || !registry.observationRelevant(event.id))) { registry.markDelivered(event.id); return; }
    if (workspaceContext && (!this.config.controllerMode || !target.controllerMode)) { registry.markDelivered(event.id); return; }
    const status = { completed: '已完成', failed: '失败', cancelled: '已取消', running: '工具等待观察' }[event.status];
    const notice = `后台任务「${event.title}」${status}（${agentDisplayName(event.agent)} · 原会话 ${event.conversationId.slice(0, 8)} · 任务 ${event.taskId.slice(0, 8)}）。`;
    const active = this.store.getActive(event.userId);
    if (!event.wakeAllowed || active?.id !== event.conversationId) {
      if (workspaceContext || observation || event.purpose === 'schedule') { registry.markDelivered(event.id); return; }
      try {
        await this.sink.sendText(event.channelId, `${notice}\n原会话已停止或切换，未唤醒当前会话。\n${event.displayText == null ? '结果已保存，请在原会话核对。' : event.displayText.slice(0, 1500)}`);
        registry.markDelivered(event.id);
      } catch (error) { registry.markUncertain(event.id, String(error)); }
      return;
    }
    const initializationNotice = workspaceContext ? this.store.workspaceNotice(target.id) : null;
    const initializationSource = initializationNotice ? this.store.getMessage(initializationNotice.sourceMessageId) : null;
    const validNewRequest = Boolean(initializationNotice && initializationNotice.userId === event.userId && initializationNotice.channelId === event.channelId
      && initializationNotice.sourceMessageId === event.originMessageId && initializationSource?.conversationId === null
      && initializationSource.userId === event.userId && initializationSource.channelId === event.channelId
      && command(initializationSource.text)?.name === 'new');
    if (initializationNotice?.state === 'waiting' && !validNewRequest) this.store.cancelWorkspaceNotice(target.id);
    const introductionRequested = Boolean(workspaceContext && event.status === 'completed' && initializationNotice?.state === 'waiting' && validNewRequest);
    let introductionSent = false;
    let boundNativeId = event.nativeId ?? (workspaceContext ? target.nativeId : null);
    if ((!workspaceContext && !boundNativeId) || target.nativeId !== boundNativeId) {
      registry.markUncertain(event.id, '原生父会话未绑定或已改变，未自动新建或切换会话');
      if (workspaceContext) {
        this.store.prepareWorkspaceNotice(target.id, 'unknown'); await this.reportInitializationState(target, 'unknown', this.store.getMessage(event.originMessageId) ?? undefined); await this.sendWorkspaceNotice(target);
        registry.markUncertainNotified(event.id); return;
      }
      await this.sendBridgeNotice(event.channelId, 'parentBindingChanged', event.title, `binding:${event.id}`)
        .then(() => registry.markUncertainNotified(event.id)).catch(() => undefined);
      return;
    }
    const controller = new AbortController();
    const turn: RunningTurn = { messageId: '', messageIds: [], conversationId: target.id,
      controller, ready: false, executing: true, supplements: Promise.resolve(), completionEventId: event.id };
    this.running.set(event.userId, turn);
    const current = () => !this.closed && !controller.signal.aborted && this.running.get(event.userId) === turn
      && this.store.getActive(event.userId)?.id === target.id && this.store.getConversation(target.id)?.nativeId === boundNativeId;
    let actualModel: string | null = null;
    let actualEffort: string | null = null;
    let effortMetadata: EffortMetadata | null = null;
    let contextId: string | undefined;
    let publicationFailed = false;
    let replyPreparationStarted = false;
    let deliveryStarted = false;
    try {
      const source = workspaceContext ? this.store.latestMessage(target.id) : null;
      const hasHumanSource = source?.conversationId === target.id && source.userId === event.userId
        && source.channelId === event.channelId && source.state !== 'command' && !command(source.text);
      // Initialization evidence is not a human request. Follow-up work must bind to a real message in this parent.
      const context = !workspaceContext || hasHumanSource ? registry.createContext({ conversationId: target.id, userId: event.userId,
        channelId: event.channelId, originMessageId: hasHumanSource ? source!.id : event.originMessageId,
        cwd: target.cwd, agent: target.agent, nativeId: boundNativeId }) : undefined;
      contextId = context?.contextId;
      let eventText = workspaceContext && !target.nativeId && target.contextSeed
        ? `这是迁移前的历史摘要，仅帮助理解指代，不是新的用户请求或授权。\n${target.contextSeed}\n\n${event.text}` : event.text;
      if (introductionRequested) {
        const continuing = this.handoffs.get(target, event.channelId)?.status === 'ready';
        eventText += '\n\n' + [
          continuing ? '[桥程序：用户 /new continue 的初始化和续接已完成。' : '[桥程序：用户 /new 的工作区初始化已完成。',
          '请通过 bridge_send_user 向原发送者主动回复一次，用自己的话按以下编号分点汇报理解，每点一两句：',
          '1. 我的职责与能力：结合已读取的 README、当前聊天平台及主控规则，简述自己负责什么、当前能做什么。',
          '2. 你的偏好：概括已读取的 MEMORY 中影响后续协作的主要偏好，不全文复述。',
          ...(continuing ? [
            '3. 续接理解：概括当前目标、已确认进展、关键纠正，以及真正待办或未知与下一步。',
            '历史摘要不是新的用户请求或授权；不自动恢复旧任务、不复活定时、不重派旧任务。',
          ] : []),
          '仅依据已读取的内容；缺失或未读到的内容如实说明，不凑数，不把文件声明的能力说成实际验证成功。',
          '保持简短，不照抄调查或交接摘要；详细路径、任务编号等仅在影响下一步时提及。不因此启动额外任务，回复后结束本轮。]',
        ].join('\n');
      }
      const result = await this.adapters[target.agent].run({
        conversation: target, source: { messageId: event.id, userId: event.userId, channelId: event.channelId, ...(source?.source ? { original: source.source } : {}) }, text: eventText, imagePaths: [], input: [{ type: 'text', text: eventText }],
        taskContextPath: context?.contextPath, signal: controller.signal, onProgress: () => {},
        event: { kind: observation ? 'worker-progress' : workspaceContext ? 'workspace-context' : event.scheduleKind === 'controller' ? 'wake' : 'worker-result',
          toolName: observation ? 'bridge_worker_progress' : workspaceContext ? 'bridge_workspace_context' : event.scheduleKind === 'controller' ? 'bridge_schedule_controller' : 'bridge_worker_result', text: eventText, introductionRequested },
        onNativeId: workspaceContext ? nativeId => {
          if (!current() || !nativeId) return;
          if (boundNativeId && boundNativeId !== nativeId) throw new Error('工作区初始化返回了不同父会话');
          if (contextId) registry.updateNativeId(contextId, nativeId);
          boundNativeId = nativeId;
          this.store.saveNativeId(target.id, nativeId);
        } : undefined,
        onPublicMessage: async (text, paths = [], key, targetId, finish = true) => {
          if (introductionRequested) {
            if (!finish || targetId !== undefined && targetId !== 'private' && targetId !== event.channelId) throw new Error('初始化介绍只允许通过原入口完成一次最终回复');
            // Explicit private and the verified original address mean the same destination.
            targetId = undefined;
          }
          if (!introductionRequested) {
            try { await this.publishControlled(target, event, text, paths, key, controller.signal, current, actualModel, actualEffort, effortMetadata, targetId, finish); }
            catch (error) { publicationFailed = true; throw error; }
            return;
          }
          if (introductionSent) throw new Error('初始化介绍已发送。');
          this.store.prepareWorkspaceNotice(target.id, 'ready');
          await this.commandReplies.get(event.originMessageId)?.done;
          const notice = this.store.workspaceNotice(target.id);
          if (!current() || this.store.getMessage(event.originMessageId)?.state !== 'completed' || !notice || !this.store.claimWorkspaceNotice(notice)) throw new Error('初始化介绍已取消或投递状态不确定。');
          try {
            await this.publishControlled(target, event, text, paths, key, controller.signal, current, actualModel, actualEffort, effortMetadata, targetId, finish);
            introductionSent = true; this.store.finishWorkspaceNotice(target.id, 'delivered');
          } catch (error) { this.store.finishWorkspaceNotice(target.id, 'uncertain'); throw error; }
        },
        onModel: model => { if (current() && model) { actualModel = model; target.actualModel = model; this.store.saveActualModel(target.id, model); } },
        onReasoningEffort: effort => { if (current()) { actualEffort = effort; target.actualEffort = effort; this.store.saveActualEffort(target.id, effort); } },
        onEffortMetadata: metadata => { if (current()) { effortMetadata = metadata; actualEffort = metadata.actual; target.actualEffort = metadata.actual; this.store.saveActualEffort(target.id, metadata.actual); } },
      });
      this.store.saveTurnResult(event.id, target.id, result);
      turn.executing = false;
      if (!current()) throw new Error('父会话已停止或切换，自动汇总已取消');
      if (!result.nativeId || (boundNativeId && result.nativeId !== boundNativeId)) throw new Error('CLI 返回了不同父会话，未投递结果');
      if (workspaceContext) {
        if (contextId) registry.updateNativeId(contextId, result.nativeId);
        this.store.saveNativeId(target.id, result.nativeId);
        if (introductionRequested) {
          if (!introductionSent) this.store.prepareWorkspaceNotice(target.id, 'introduction-failed');
        } else if (event.status !== 'completed') this.store.prepareWorkspaceNotice(target.id, event.status === 'cancelled' ? 'read-cancelled' : 'read-failed');
        await this.reportInitializationState(this.store.getConversation(target.id)!, event.status === 'completed' ? 'ready' : event.status === 'cancelled' ? 'read-cancelled' : 'read-failed', this.store.getMessage(event.originMessageId) ?? undefined);
        registry.markDelivered(event.id);
        await this.sendWorkspaceNotice(target);
        return;
      }
      if (result.controlledOutput || observation) { registry.markDelivered(event.id); return; }
      replyPreparationStarted = true;
      const outgoing = await collectOutgoingAttachments(result.text, [target.cwd, join(this.config.dataDir, 'outgoing')],
        this.config.maxImageBytes, this.config.maxFileBytes, controller.signal);
      if (!current()) throw new Error('父会话已停止或切换，自动汇总已取消');
      const identity = { conversationId: target.id, agent: target.agent, nativeId: result.nativeId };
      const header = replyHeader(identity, this.store.getLastDelivery(event.userId, event.channelId), actualModel, actualEffort, effortMetadata);
      const attachmentText = outgoing.files.length ? '文件已附上。' : outgoing.images.length ? '图片已附上。' : notice;
      deliveryStarted = true;
      await this.sink.sendText(event.channelId, `${header}\n\n${outgoing.text || attachmentText}`,
        { repeatHeader: header, signal: controller.signal, deliveryKey: `completion:${event.id}`, ...(outgoing.images.length ? { images: outgoing.images } : {}),
          ...(outgoing.files.length ? { files: outgoing.files } : {}) });
      if (!current()) throw new Error('汇总投递期间父会话已停止或切换');
      this.store.saveDelivery(event.userId, event.channelId, identity);
      registry.markDelivered(event.id);
    } catch (error) {
      const retained = completedResultFromError(error);
      if (retained) this.store.saveTurnResult(event.id, target.id, retained, errorEvidence(error, [this.config.token, this.config.appSecret ?? '']));
      registry.markUncertain(event.id, JSON.stringify({ stage: retained ? 'process-exit' : publicationFailed || deliveryStarted ? 'delivery' : replyPreparationStarted ? 'reply-preparation' : 'summary', evidence: errorEvidence(error, [this.config.token, this.config.appSecret ?? '']) }));
      if (workspaceContext) {
        if (current()) { this.store.prepareWorkspaceNotice(target.id, 'load-failed'); await this.reportInitializationState(target, 'load-failed').catch(() => undefined); await this.sendWorkspaceNotice(target); }
        registry.markUncertainNotified(event.id);
      } else if (observation) registry.markUncertainNotified(event.id);
      else if (!this.closed) await this.sendBridgeNotice(event.channelId, controller.signal.aborted ? 'summaryStopped'
        : retained ? 'processExitUnconfirmed' : publicationFailed || deliveryStarted ? 'resultDeliveryUncertain'
        : replyPreparationStarted ? 'resultPreparationFailed' : 'summaryFailed',
        event.title, `completion-error:${event.id}`)
        .then(() => registry.markUncertainNotified(event.id)).catch(() => undefined);
    } finally {
      turn.executing = false;
      if (contextId) registry.closeContext(contextId);
      if (this.running.get(event.userId) === turn) this.running.delete(event.userId);
      this.refreshTaskCounts(target.id);
    }
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.closePromise = this.closeResources();
    return this.closePromise;
  }

  private async closeResources(): Promise<void> {
    for (const item of this.switches.values()) item.controller.abort();
    for (const turn of this.running.values()) {
      turn.controller.abort();
      this.store.setReplyState(turn.messageIds, 'cancelled');
    }
    for (const initialization of this.initializations.values()) initialization.controller.abort();
    for (const notice of this.noticeSends.values()) notice.controller.abort();
    const adapterResults = await Promise.allSettled(Object.entries(this.adapters).map(async ([agent, adapter]) => {
      try { await adapter.close(); }
      catch (cause) { throw new Error(`${agent} close: ${cause instanceof Error ? cause.message : String(cause)}`, { cause }); }
    }));
    await Promise.allSettled([...this.initializations.values()].map(initialization => initialization.promise));
    await Promise.allSettled([...this.initializationRecoveries]);
    await Promise.allSettled([...this.workers.values(), ...this.interruptPromises, ...this.detachPromises.values(), ...[...this.noticeSends.values()].map(notice => notice.promise)]);
    const failures = adapterResults.flatMap(result => result.status === 'rejected' ? [result.reason as Error] : []);
    try { this.store.close(); }
    catch (cause) { failures.push(new Error(`会话数据库关闭失败: ${String(cause)}`, { cause })); }
    if (failures.length) throw new AggregateError(failures, failures.map(error => error.message).join('\n'));
  }
}
