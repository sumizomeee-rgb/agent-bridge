import { modelEfforts, validateEffort } from './effort.js';
import { createHash, randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { SessionStore, type WorkspaceNoticeOutcome } from './store.js';
import { isModelId } from './config.js';
import { agentDisplayName, replyHeader } from './reply.js';
import { formatComputerOverview, formatWorkerOverview, type ComputerOverview, type WorkerOverview } from './overview.js';
import { collectOutgoingAttachments } from './artifacts.js';
import type { TaskCompletionEvent, TaskRegistry } from './tasks.js';
import type { AgentAdapter, AgentModelInfo, AgentName, AgentTurn, BridgeConfig, BridgeMessage, Conversation, ReplySink } from './types.js';

interface RunningTurn {
  messageId: string;
  conversationId: string;
  controller: AbortController;
  messageIds: string[];
  ready: boolean;
  executing: boolean;
  supplements: Promise<void>;
  completionEventId?: string;
}
const HELP = `直接发送文字或图片即可继续当前会话。
/new [codex|claude] 或 new chat：新会话
/agent：查看 Agent 选项；/agent codex 或 /agent claude：切换并续接会话
/chats：只读查看自己的历史会话
/cwd 路径：在指定目录新建会话
/model：查看当前模型；/model list 或 /models：列出模型
/model 模型名：切换当前会话模型，保留上下文
/model default：恢复 CLI 当前默认；/model custom 模型名：指定网关自定义模型
/effort [level|default]：查询或设置当前会话推理强度
/status：查看当前会话和排队情况
/computers [refresh|cached]：查看已登记电脑及 Agent 的连接和 CLI 入口
/workers [all]：查看当前对话或本用户全部对话的运行中直属 Agent
/stop：停止当前任务、清空队列和取消后台自动汇总；不会停止远端子任务
/help：查看帮助`;

function command(text: string): { name: string; argument: string } | null {
  const trimmed = text.trim();
  if (/^(?:new\s+chat|新会话|新聊天)$/i.test(trimmed)) return { name: 'new', argument: '' };
  const match = /^\/([a-z]+)(?:\s+([\s\S]*))?$/i.exec(trimmed);
  return match ? { name: match[1]!.toLowerCase(), argument: (match[2] ?? '').trim() } : null;
}

export interface SessionManagerOptions {
  mergeDelayMs?: number; receiptIntervalMs?: number; taskRegistry?: TaskRegistry;
  onStop?: (conversationId: string) => Promise<void>; onDetach?: (conversationId: string) => void;
  controllerSeed?: (previous: Conversation) => string; onInitializeWorkspace?: (turn: AgentTurn) => Promise<unknown>;
  onInitializationError?: (conversation: Conversation, error: unknown) => void;
  onListComputers?: (conversation: Conversation, refresh: boolean) => Promise<ComputerOverview[]>;
  onListWorkers?: (conversation: Conversation, scope: 'current' | 'all') => Promise<WorkerOverview[]>;
}

export class SessionManager {
  private readonly store: SessionStore;
  private readonly workers = new Map<string, Promise<void>>();
  private readonly userWorkers = new Map<string, Promise<void>>();
  private readonly latestMessages = new Map<string, { id: string; channelId: string; conversationId: string }>();
  private readonly running = new Map<string, RunningTurn>();
  private readonly interruptPromises = new Set<Promise<void>>();
  private readonly modelChanges = new Set<string>();
  private readonly initializationAttempts = new Set<string>();
  private readonly initializations = new Map<string, { controller: AbortController; promise: Promise<void> }>();
  private readonly noticeSends = new Map<string, { controller: AbortController; promise: Promise<void> }>();
  private closed = false;
  private closePromise?: Promise<void>;
  private draining = false;
  private activeCommands = 0;
  private recovered = false;
  private recovering = false;
  private readonly receipts = new Map<string, number>();
  private readonly revisions = new Map<string, number>();

  constructor(
    private readonly config: BridgeConfig,
    private readonly adapters: Record<AgentName, AgentAdapter>,
    private readonly sink: ReplySink,
    private readonly options: SessionManagerOptions = {},
  ) { this.store = new SessionStore(config.dataDir); }

  revision(userId: string): number { return this.revisions.get(userId) ?? 0; }

  /** Pause new turns without aborting a CLI, supplement or reply already executing. */
  beginDrain(): void { this.draining = true; }
  isIdle(): boolean {
    return this.workers.size === 0 && this.userWorkers.size === 0 && this.running.size === 0
      && this.initializations.size === 0 && this.noticeSends.size === 0 && this.interruptPromises.size === 0 && this.modelChanges.size === 0 && this.activeCommands === 0;
  }

  discard(message: BridgeMessage): void {
    if (!this.closed && this.config.allowedUserIds.includes(message.userId)) this.store.addMessage(message, null, 'cancelled');
  }

  hasMessage(id: string): boolean { return this.store.hasMessage(id); }

  knownChannels(): Array<{ userId: string; channelId: string; cursor: string }> { return this.store.knownChannels(); }

  async handle(message: BridgeMessage, commandReply?: (text: string) => Promise<void>): Promise<void> {
    if (this.closed) throw new Error('桥已关闭');
    if (!this.config.allowedUserIds.includes(message.userId) || this.hasMessage(message.id)) return;
    const parsed = command(message.text);
    if (parsed) {
      // Raw command receipt stays in DurableIngress until the next process can execute it.
      if (this.draining) return;
      if (!this.store.addMessage(message, null, 'command')) return;
      // An interaction reply belongs to this command invocation, never to a channel or queued turn.
      const reply = commandReply ?? ((text: string) => this.sink.sendText(message.channelId, text));
      this.activeCommands++;
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
        await reply(`命令失败：${error instanceof Error ? error.message : String(error)}`);
      } finally { this.activeCommands--; }
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
    const active = this.ensureActive(message.userId);
    if (!this.store.addMessage(message, active.id, 'queued')) return;
    this.store.nameConversation(active.id, message.text);
    this.setLatestMessage(message, active.id);
    if (this.draining) return;
    this.initializeWorkspace(active, message);
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
      this.options.taskRegistry?.recoverContexts();
      const notices = new Set<string>();
      for (const item of [...this.store.interruptRunning(), ...this.store.unfinishedReplies()]) {
        if (this.closed) return;
        if (!this.config.allowedUserIds.includes(item.userId)) continue;
        const key = `${item.channelId}:${item.conversationId}`;
        if (notices.has(key)) continue;
        notices.add(key);
        await this.sink.sendText(item.channelId,
          `会话 ${item.conversationId?.slice(0, 8) ?? ''} 上次执行或回复因桥重启而中断，未自动重做。请先确认执行结果，再决定继续。`)
          .catch(() => undefined);
      }
      if (this.closed) return;
      for (const userId of this.config.allowedUserIds) {
        if (this.store.getActive(userId)) this.ensureActive(userId);
        const active = this.store.getActive(userId);
        const latest = active ? this.store.latestMessage(active.id) : null;
        if (active && latest) this.latestMessages.set(userId, { id: latest.id, channelId: latest.channelId, conversationId: active.id });
      }
      for (const event of this.options.taskRegistry?.recoverProcessingEvents() ?? []) {
        if (event.purpose === 'workspace-context') {
          const target = this.completionTarget(event);
          if (target && event.wakeAllowed && this.store.getActive(event.userId)?.id === target.id) this.store.prepareWorkspaceNotice(target.id, 'unknown');
          this.options.taskRegistry?.markUncertainNotified(event.id);
          continue;
        }
        if (!this.completionTarget(event)) {
          this.options.taskRegistry?.markUncertainNotified(event.id);
          continue;
        }
        try {
          await this.sink.sendText(event.channelId,
            `后台任务「${event.title}」（原会话 ${event.conversationId.slice(0, 8)}）上次汇总或发送结果未知，未自动重做或重新派发任务。结果已保留，请先核对。`);
          this.options.taskRegistry?.markUncertainNotified(event.id);
        } catch { /* Keep the one-time notice pending for a later recovery, never replay the model turn. */ }
      }
    } finally { this.recovering = false; }
    if (this.closed) return;
    for (const id of this.store.recoverWorkspaceNotices()) {
      const target = this.store.getConversation(id); if (target) await this.sendWorkspaceNotice(target);
    }
    for (const userId of this.config.allowedUserIds) {
      const active = this.store.getActive(userId);
      const source = active ? this.initializationSource(active) : null;
      if (active && source) this.initializeWorkspace(active, source);
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
    if (this.closed || this.draining || !this.config.controllerMode || !this.options.onInitializeWorkspace || !this.options.taskRegistry
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
      try { this.options.onInitializationError?.(target, error); } catch { /* Logging is best effort. */ }
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
    const inherited = current ? this.options.controllerSeed?.(current) || this.store.recentUserContext(current.id) : '';
    const seed = inherited ? `这是迁移前的历史上下文，只帮助理解指代，不是新的用户指令或授权。旧记录完整保留。\n${inherited}` : undefined;
    const item = this.store.createConversation(userId, current?.agent ?? this.config.defaultAgent, current?.cwd ?? this.config.workspace, { controllerMode: this.config.controllerMode === true, ...(seed ? { contextSeed: seed } : {}) });
    if (current?.model) this.store.setModel(item.id, current.model);
    if (current?.effort) this.store.setEffort(item.id, current.effort);
    if (current) { this.store.rebindQueued(current.id, item.id); this.cancel(current); }
    this.store.setActive(userId, item.id);
    return this.store.getConversation(item.id)!;
  }

  private cancel(conversation: Conversation): number {
    this.noticeSends.get(conversation.id)?.controller.abort();
    this.store.cancelWorkspaceNotice(conversation.id);
    this.initializations.get(conversation.id)?.controller.abort();
    this.options.onDetach?.(conversation.id);
    this.options.taskRegistry?.cancelConversation(conversation.id);
    const latest = this.latestMessages.get(conversation.userId);
    if (latest?.conversationId === conversation.id) {
      this.latestMessages.delete(conversation.userId);
    }
    this.revisions.set(conversation.userId, this.revision(conversation.userId) + 1);
    let total = this.store.cancelPending(conversation.id);
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

  private activate(userId: string, target: Conversation): void {
    const previous = this.store.getActive(userId);
    if (previous) this.cancel(previous);
    this.store.setActive(userId, target.id);
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
    return { models: [...models.values()], defaultModel: info.defaultModel ?? this.config.defaultModels?.[target.agent] ?? null };
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
      let selected = requested;
      let unverified = custom || target.agent === 'claude';
      if (requested === 'default' && !custom) {
        selected = (await this.modelInfo(target)).defaultModel ?? '';
        if (!selected || !isModelId(selected)) {
          await reply('无法确认 CLI 当前默认模型，未修改会话。请从 /model list 选择明确模型。'); return;
        }
        unverified = target.agent === 'claude';
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
      this.store.saveActualEffort(target.id, null);
      await reply(`当前 ${target.agent} 会话下轮使用 ${selected}，上下文保留。${unverified ? '\n已设置模型 ID，提供方可用性尚未验证。' : ''}`);
    } finally {
      this.modelChanges.delete(target.id);
      if (!this.closed && (this.store.pendingCount(target.id) > 0 || this.options.taskRegistry?.getNextEvent(target.id))) this.wake(target.id);
    }
  }

  private async handleEffort(message: BridgeMessage, argument: string, reply: (text: string) => Promise<void>): Promise<void> {
    const target = this.ensureActive(message.userId);
    if (!argument || argument === 'list') {
      const info = await this.modelInfo(target);
      await reply(`${target.agent}\n${this.modelStatus(target)}\n当前模型支持强度：${modelEfforts(info, target)?.join('、') || 'CLI 尚未提供'}\n/effort level 设置；/effort default 使用 CLI 默认。`);
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
      await reply(`已设置当前 ${target.agent} 会话强度为 ${effort ?? 'CLI 默认'}，下轮提交；实际生效尚未由 CLI 确认。上下文保留，现有子任务不变。`);
    } finally {
      this.modelChanges.delete(target.id);
      if (!this.closed && (this.store.pendingCount(target.id) > 0 || this.options.taskRegistry?.getNextEvent(target.id))) this.wake(target.id);
    }
  }

  private async handleCommand(message: BridgeMessage, name: string, argument: string,
    reply: (text: string) => Promise<void>): Promise<void> {
    const current = this.store.getActive(message.userId);
    if (!current && ['stop', 'new', 'cwd', 'agent'].includes(name)) {
      this.revisions.set(message.userId, this.revision(message.userId) + 1);
    }
    switch (name) {
      case 'help': await reply(this.config.controllerMode
        ? HELP.replace('/stop：停止当前任务、清空队列和取消后台自动汇总；不会停止远端子任务', '/stop：停止桥管理的执行子 Agent、清空队列并取消预约；独立远端进程需要另行核对')
        : HELP); return;
      case 'model': await this.handleModel(message, argument, reply); return;
      case 'effort': await this.handleEffort(message, argument, reply); return;
      case 'models': await this.handleModel(message, '', reply, true); return;
      case 'new':
      case 'agent': {
        if (name === 'agent' && !argument) {
          await reply(`当前 Agent：${agentDisplayName(current?.agent ?? this.config.defaultAgent)}\n/agent codex → Codex CLI\n/agent claude → Claude Code\n切换自动续接当前目录下的上次会话；/new 明确新建，/chats 只读查看历史。`); return;
        }
        if (argument && argument !== 'codex' && argument !== 'claude') {
          await reply(`用法：/${name} ${name === 'new' ? '[codex|claude]' : 'codex|claude'}`); return;
        }
        const agent = (argument || current?.agent || this.config.defaultAgent) as AgentName;
        if (name === 'agent' && current?.agent === agent) {
          await reply(`当前已是 ${agentDisplayName(agent)}，继续原会话 ${current.id.slice(0, 8)}。\n原生会话：${current.nativeId ? `…${current.nativeId.slice(-6)}` : '尚未创建'}\n需要清空上下文请用 /new。`); return;
        }
        if (name === 'agent') {
          const previous = this.store.latestAgentConversation(message.userId, agent, current?.cwd ?? this.config.workspace, this.config.controllerMode === true);
          if (previous) {
            this.activate(message.userId, previous);
            this.initializeWorkspace(previous, message);
            await reply(`已切换到 ${agentDisplayName(agent)}，恢复会话 ${previous.id.slice(0, 8)}：${previous.title}\n原生会话：${previous.nativeId ? `…${previous.nativeId.slice(-6)}` : '尚未创建'}\n目录：${previous.cwd}`);
            this.wake(previous.id);
            return;
          }
        }
        const target = this.store.createConversation(message.userId, agent, current?.cwd ?? this.config.workspace, { controllerMode: this.config.controllerMode === true });
        if (current?.agent === agent && current.model) this.store.setModel(target.id, current.model);
        if (current?.agent === agent && current.effort) this.store.setEffort(target.id, current.effort);
        this.activate(message.userId, target);
        if (this.config.controllerMode && name === 'new') this.store.requestWorkspaceNotice(target.id, message);
        this.initializeWorkspace(this.store.getConversation(target.id)!, message);
        await reply(`已新建 ${agentDisplayName(agent)} 会话 ${target.id.slice(0, 8)}。${this.config.controllerMode ? '旧会话待处理消息已取消；已启动后台上下文初始化，完成后会通知。' : '旧会话待处理任务已取消。'}\n原生会话：尚未创建\n目录：${target.cwd}`);
        return;
      }
      case 'cwd': {
        if (!argument) { await reply('用法：/cwd 目录路径'); return; }
        const value = argument.replace(/^(["'])([\s\S]*)\1$/, '$2');
        const cwd = isAbsolute(value) ? value : resolve(current?.cwd ?? this.config.workspace, value);
        if (!statSync(cwd).isDirectory()) { await reply('指定路径不是目录。'); return; }
        const target = this.store.createConversation(message.userId, current?.agent ?? this.config.defaultAgent, cwd, { controllerMode: this.config.controllerMode === true });
        if (current?.model) this.store.setModel(target.id, current.model);
        if (current?.effort) this.store.setEffort(target.id, current.effort);
        this.activate(message.userId, target);
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
      case 'resume': {
        await reply('/resume 已停用，不会切换会话。请用 /agent codex 或 /agent claude 自动续接当前目录的会话；/new 新建，/chats 只读查看历史。'); return;
      }
      case 'computers': {
        if (argument && argument !== 'refresh' && argument !== 'cached') {
          await reply('用法：/computers [refresh|cached]；默认重新检查，cached 查看已有检查。'); return;
        }
        if (!this.options.onListComputers) { await reply('桥尚未配置电脑清单查询。'); return; }
        const target = current ?? this.ensureActive(message.userId);
        let items: ComputerOverview[];
        try { items = await this.options.onListComputers(target, argument !== 'cached'); }
        catch { throw new Error('电脑清单检查失败，请稍后重试。'); }
        await reply(formatComputerOverview(items)); return;
      }
      case 'workers': {
        if (argument && argument !== 'current' && argument !== 'all') {
          await reply('用法：/workers [all]；默认查看当前对话，all 查看你的全部对话。'); return;
        }
        if (!this.options.onListWorkers) { await reply('桥尚未配置直属 Agent 查询。'); return; }
        const target = current ?? this.ensureActive(message.userId);
        const scope = argument === 'all' ? 'all' : 'current';
        let items: WorkerOverview[];
        try { items = await this.options.onListWorkers(target, scope); }
        catch { throw new Error('直属 Agent 状态读取失败，请稍后重试。'); }
        await reply(formatWorkerOverview(items, scope)); return;
      }
      case 'status':
        await reply(current
          ? `${agentDisplayName(current.agent)} · ${current.id.slice(0, 8)} · ${current.title}\n${this.modelStatus(current)}\n原生会话：${current.nativeId ? `…${current.nativeId.slice(-6)}` : '尚未创建'}\n目录：${current.cwd}\n${this.running.get(message.userId)?.conversationId === current.id ? '正在执行' : '空闲'}；排队 ${this.store.pendingCount(current.id)} 条；${current.nativeId ? '已有可续接的 Agent 会话' : '尚未创建 Agent 会话'}${this.options.taskRegistry ? `\n已登记未结束的子 Agent：${this.options.taskRegistry.activeCount(current.id)}` : ''}`
          : '还没有会话，发送文字或图片即可开始。');
        return;
      case 'stop': {
        const count = current ? this.cancel(current) : 0;
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
        return message ? [{ id: message.id, channelId: message.channelId }] : [];
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
    if (this.config.controllerMode) return;
    turn.supplements = turn.supplements.then(async () => {
      const adapter = this.adapters[target.agent];
      if (!adapter.steer || !turn.ready || !turn.executing || turn.controller.signal.aborted || this.closed || this.draining) return;
      for (const item of this.store.queuedBatch(target.id)) {
        if (!turn.executing || turn.controller.signal.aborted || this.closed || this.draining
          || this.store.getActive(item.userId)?.id !== target.id) return;
        // 在 RPC 写入前持久化；崩溃后 steering 不能按 queued 自动重做。
        this.store.setState(item.id, 'steering');
        let result;
        try { result = await adapter.steer(target.id, { id: item.id, input: this.input([item]) }); }
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

  private input(items: BridgeMessage[]) {
    return items.flatMap(item => [
      ...(item.text ? [{ type: 'text' as const, text: item.text }] : []),
      ...item.imagePaths.map(path => ({ type: 'localImage' as const, path })),
    ]);
  }

  private wake(conversationId: string): void {
    if (this.closed || this.draining || this.recovering || this.workers.has(conversationId) || this.modelChanges.has(conversationId)) return;
    const target = this.store.getConversation(conversationId);
    if (!target || this.userWorkers.has(target.userId)) return;
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

  /** Explicit coordinating output never treats prose file citations as upload requests. */
  private async publishControlled(target: Conversation, route: { userId: string; channelId: string },
    text: string, paths: string[], messageKey: string | undefined, signal: AbortSignal,
    current: () => boolean, model: string | null, effort: string | null): Promise<void> {
    if (!current()) throw new Error('当前主控轮次已经停止');
    if (typeof text !== 'string' || text.length > 64 * 1024 || !Array.isArray(paths)
      || paths.length > 10 || paths.some(path => typeof path !== 'string' || !isAbsolute(path)
        || path.length > 4096 || /[\r\n\0<>]/.test(path))) throw new Error('公开回复或附件声明无效');
    const nativeId = this.store.getConversation(target.id)?.nativeId;
    if (!nativeId) throw new Error('主控会话尚未绑定，不能发送回复');
    const key = `${target.agent}:${target.id}:${nativeId}:${messageKey ?? randomUUID()}`;
    const hash = createHash('sha256').update(JSON.stringify([text, paths])).digest('hex');
    const claim = this.store.claimPublicMessage(key, target.id, nativeId, route.channelId, hash);
    if (claim === 'delivered') return;
    if (claim === 'uncertain') throw new Error('这条回复的投递状态未知，已保留，未重复发送');
    try {
      const outgoing = await collectOutgoingAttachments(paths.map(path => `[附件](<${path}>)`).join('\n'),
        [target.cwd, join(this.config.dataDir, 'outgoing')], this.config.maxImageBytes, this.config.maxFileBytes, signal);
      if (!current()) throw new Error('主控轮次在附件准备期间停止');
      const identity = { conversationId: target.id, agent: target.agent, nativeId };
      const header = replyHeader(identity, this.store.getLastDelivery(route.userId, route.channelId), model, effort);
      const fallback = outgoing.files.length ? '文件已附上。' : outgoing.images.length ? '图片已附上。' : '';
      if (!text.trim() && !fallback) throw new Error('公开回复不能为空');
      await this.sink.sendText(route.channelId, `${header}\n\n${text || fallback}`, {
        repeatHeader: header, signal, ...(outgoing.images.length ? { images: outgoing.images } : {}),
        ...(outgoing.files.length ? { files: outgoing.files } : {}),
      });
      if (!current()) throw new Error('主控轮次在投递期间停止');
      this.store.finishPublicMessage(key, 'delivered');
      this.store.saveDelivery(route.userId, route.channelId, identity);
    } catch (error) { this.store.finishPublicMessage(key, 'uncertain'); throw error; }
  }

  private async processQueue(conversationId: string): Promise<void> {
    // 首条消息后固定短窗口，避免连续输入无限延长启动时间。
    if (!this.config.controllerMode && this.options.mergeDelayMs !== 0) await new Promise<void>(resolve => setTimeout(resolve, this.options.mergeDelayMs ?? 1000));
    while (!this.closed && !this.draining && !this.modelChanges.has(conversationId)) {
      const owner = this.store.getConversation(conversationId);
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
      if (!target || !this.config.allowedUserIds.includes(item.userId)
        || this.store.getActive(item.userId)?.id !== conversationId) {
        this.store.setState(item.id, 'cancelled'); continue;
      }
      const controller = new AbortController();
      const batch = this.config.controllerMode || this.options.mergeDelayMs === 0 ? [item] : this.store.queuedBatch(conversationId);
      const turn: RunningTurn = { messageId: item.id, messageIds: batch.map(value => value.id),
        conversationId, controller, ready: false, executing: true, supplements: Promise.resolve() };
      this.running.set(item.userId, turn);
      for (const value of batch) this.store.setState(value.id, 'running');
      const current = () => !this.closed && !controller.signal.aborted
        && this.running.get(item.userId) === turn
        && this.store.getActive(item.userId)?.id === conversationId
        && this.store.getMessage(item.id)?.state === 'running';
      let actualModel: string | null = null;
      let actualEffort: string | null = null;
      let contextId: string | undefined;
      try {
        const context = this.options.taskRegistry?.createContext({
          conversationId, userId: item.userId, channelId: item.channelId, originMessageId: item.id,
          cwd: target.cwd, agent: target.agent, nativeId: target.nativeId,
        });
        contextId = context?.contextId;
        const result = await this.adapters[target.agent].run({
          ...(context ? { taskContextPath: context.contextPath } : {}),
          conversation: target, text: `${!target.nativeId && target.contextSeed ? target.contextSeed + '\n\n当前用户消息：\n' : ''}${batch.map(value => value.text).filter(Boolean).join('\n\n')}`,
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
          // Adapters emit deltas and protocol/tool events through this callback.
          // Only the completed reply is user-facing; no asynchronous sends can linger after cancellation.
          onProgress: () => {},
          onPublicMessage: async (text, paths = [], key) => {
            if (!current()) throw new Error('当前主控轮次已经停止');
            this.store.setReplyState(turn.messageIds, 'pending');
            await this.publishControlled(target, item, text, paths, key, controller.signal, current, actualModel, actualEffort);
            if (current()) { this.store.setReplyState(turn.messageIds, 'delivered'); this.markReplyDelivered(turn.messageIds); }
          },
        });
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
        const header = replyHeader(identity, this.store.getLastDelivery(item.userId, item.channelId), actualModel, actualEffort);
        const attachmentText = outgoing.files.length ? '文件已附上。' : outgoing.images.length ? '图片已附上。' : '本轮完成（没有文本输出）。';
        await this.sink.sendText(item.channelId, `${header}\n\n${outgoing.text || attachmentText}`,
          { repeatHeader: header, signal: controller.signal, ...(outgoing.images.length ? { images: outgoing.images } : {}),
            ...(outgoing.files.length ? { files: outgoing.files } : {}) });
        if (!delivering()) continue;
        // Failed or partially delivered replies never establish successful continuity.
        this.store.saveDelivery(item.userId, item.channelId, identity);
        this.store.setReplyState(turn.messageIds, 'delivered');
        this.markReplyDelivered(turn.messageIds);
      } catch (error) {
        turn.executing = false;
        await turn.supplements;
        if (controller.signal.aborted || this.closed || this.store.getMessage(item.id)?.state === 'cancelled') {
          for (const id of turn.messageIds) if (this.store.getMessage(id)?.state === 'running') this.store.setState(id, 'cancelled');
          this.store.setReplyState(turn.messageIds, 'cancelled');
        } else {
          // A completed model turn is never retried merely because reply delivery failed.
          for (const id of turn.messageIds) if (this.store.getMessage(id)?.state === 'running') this.store.setState(id, 'failed', String(error));
          this.store.setReplyState(turn.messageIds, 'failed');
          await this.sink.sendText(item.channelId,
            `执行或回复失败：${error instanceof Error ? error.message : String(error)}`)
            .catch(() => undefined);
        }
      } finally {
        turn.executing = false;
        await turn.supplements;
        if (contextId) this.options.taskRegistry?.closeContext(contextId);
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
    const nativeId = this.store.getConversation(target.id)?.nativeId;
    if (notice.outcome === 'ready' && !nativeId) return;
    const bodies: Record<WorkspaceNoticeOutcome, string> = {
      ready: '✅ 工作区上下文已载入。',
      'read-failed': '⚠️ 工作区上下文读取失败，结果已交给主控。',
      'read-cancelled': '⚠️ 工作区上下文读取已取消，结果已交给主控。',
      'load-failed': '⚠️ 初始化结果未能载入主控，结果已保存。',
      'request-failed': '⚠️ 工作区初始化请求未确认完成，请核对状态。',
      unknown: '⚠️ 初次上下文载入结果无法确认；未自动重做。',
    };
    if (!this.store.claimWorkspaceNotice(notice)) return;
    const controller = new AbortController();
    const current = () => !this.closed && !controller.signal.aborted && this.store.getActive(notice.userId)?.id === target.id
      && this.store.workspaceNotice(target.id)?.state === 'sending'
      && (notice.outcome !== 'ready' || this.store.getConversation(target.id)?.nativeId === nativeId);
    const promise = Promise.resolve().then(async () => {
      if (!current()) throw new Error('初次上下文回执发送已取消');
      await this.sink.sendText(notice.channelId, `${bodies[notice.outcome!]}（会话 ${target.id.slice(0, 8)}）`, { signal: controller.signal });
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
      || (origin.conversationId !== target.id && !(workspaceContext && origin.conversationId === null && command(origin.text)))
      || target.userId !== event.userId || origin.userId !== event.userId || origin.channelId !== event.channelId
      || target.agent !== event.agent || target.cwd !== event.cwd || !this.config.allowedUserIds.includes(event.userId)) return null;
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
    const observation = event.kind === 'worker-progress';
    const workspaceContext = event.purpose === 'workspace-context';
    if (observation && (!this.config.controllerMode || !target.controllerMode || !registry.observationRelevant(event.id))) { registry.markDelivered(event.id); return; }
    if (workspaceContext && (!this.config.controllerMode || !target.controllerMode)) { registry.markDelivered(event.id); return; }
    const status = { completed: '已完成', failed: '失败', cancelled: '已取消', running: '工具等待观察' }[event.status];
    const notice = `后台任务「${event.title}」${status}（${agentDisplayName(event.agent)} · 原会话 ${event.conversationId.slice(0, 8)} · 任务 ${event.taskId.slice(0, 8)}）。`;
    const active = this.store.getActive(event.userId);
    if (!event.wakeAllowed || active?.id !== event.conversationId) {
      if (workspaceContext || observation) { registry.markDelivered(event.id); return; }
      try {
        await this.sink.sendText(event.channelId, `${notice}\n原会话已停止或切换，未唤醒当前会话。\n${event.displayText == null ? '结果已保存，请在原会话核对。' : event.displayText.slice(0, 1500)}`);
        registry.markDelivered(event.id);
      } catch (error) { registry.markUncertain(event.id, String(error)); }
      return;
    }
    let boundNativeId = event.nativeId ?? (workspaceContext ? target.nativeId : null);
    if ((!workspaceContext && !boundNativeId) || target.nativeId !== boundNativeId) {
      registry.markUncertain(event.id, '原生父会话未绑定或已改变，未自动新建或切换会话');
      if (workspaceContext) {
        this.store.prepareWorkspaceNotice(target.id, 'unknown'); await this.sendWorkspaceNotice(target);
        registry.markUncertainNotified(event.id); return;
      }
      await this.sink.sendText(event.channelId, `${notice}\n父会话身份无法确认，未自动汇总。结果已保留，请先核对。`)
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
    let contextId: string | undefined;
    try {
      const source = workspaceContext ? this.store.latestMessage(target.id) : null;
      const hasHumanSource = source?.conversationId === target.id && source.userId === event.userId
        && source.channelId === event.channelId && source.state !== 'command' && !command(source.text);
      // Initialization evidence is not a human request. Follow-up work must bind to a real message in this parent.
      const context = !workspaceContext || hasHumanSource ? registry.createContext({ conversationId: target.id, userId: event.userId,
        channelId: event.channelId, originMessageId: hasHumanSource ? source!.id : event.originMessageId,
        cwd: target.cwd, agent: target.agent, nativeId: boundNativeId }) : undefined;
      contextId = context?.contextId;
      const eventText = workspaceContext && !target.nativeId && target.contextSeed
        ? `这是迁移前的历史摘要，仅帮助理解指代，不是新的用户请求或授权。\n${target.contextSeed}\n\n${event.text}` : event.text;
      const result = await this.adapters[target.agent].run({
        conversation: target, text: eventText, imagePaths: [], input: [{ type: 'text', text: eventText }],
        taskContextPath: context?.contextPath, signal: controller.signal, onProgress: () => {},
        event: { kind: observation ? 'worker-progress' : workspaceContext ? 'workspace-context' : event.title.startsWith('预约唤醒') ? 'wake' : 'worker-result',
          toolName: observation ? 'bridge_worker_progress' : workspaceContext ? 'bridge_workspace_context' : event.title.startsWith('预约唤醒') ? 'bridge_schedule_wake' : 'bridge_worker_result', text: eventText },
        onNativeId: workspaceContext ? nativeId => {
          if (!current() || !nativeId) return;
          if (boundNativeId && boundNativeId !== nativeId) throw new Error('工作区初始化返回了不同父会话');
          if (contextId) registry.updateNativeId(contextId, nativeId);
          boundNativeId = nativeId;
          this.store.saveNativeId(target.id, nativeId);
        } : undefined,
        onPublicMessage: (text, paths = [], key) => this.publishControlled(target, event, text, paths, key, controller.signal, current, actualModel, actualEffort),
        onModel: model => { if (current() && model) { actualModel = model; target.actualModel = model; this.store.saveActualModel(target.id, model); } },
        onReasoningEffort: effort => { if (current()) { actualEffort = effort; target.actualEffort = effort; this.store.saveActualEffort(target.id, effort); } },
      });
      turn.executing = false;
      if (!current()) throw new Error('父会话已停止或切换，自动汇总已取消');
      if (!result.nativeId || (boundNativeId && result.nativeId !== boundNativeId)) throw new Error('CLI 返回了不同父会话，未投递结果');
      if (workspaceContext) {
        if (contextId) registry.updateNativeId(contextId, result.nativeId);
        this.store.saveNativeId(target.id, result.nativeId);
        this.store.prepareWorkspaceNotice(target.id, event.status === 'completed' ? 'ready' : event.status === 'cancelled' ? 'read-cancelled' : 'read-failed');
        registry.markDelivered(event.id);
        await this.sendWorkspaceNotice(target);
        return;
      }
      if (result.controlledOutput || observation) { registry.markDelivered(event.id); return; }
      const outgoing = await collectOutgoingAttachments(result.text, [target.cwd, join(this.config.dataDir, 'outgoing')],
        this.config.maxImageBytes, this.config.maxFileBytes, controller.signal);
      if (!current()) throw new Error('父会话已停止或切换，自动汇总已取消');
      const identity = { conversationId: target.id, agent: target.agent, nativeId: result.nativeId };
      const header = replyHeader(identity, this.store.getLastDelivery(event.userId, event.channelId), actualModel, actualEffort);
      const attachmentText = outgoing.files.length ? '文件已附上。' : outgoing.images.length ? '图片已附上。' : notice;
      await this.sink.sendText(event.channelId, `${header}\n\n${outgoing.text || attachmentText}`,
        { repeatHeader: header, signal: controller.signal, ...(outgoing.images.length ? { images: outgoing.images } : {}),
          ...(outgoing.files.length ? { files: outgoing.files } : {}) });
      if (!current()) throw new Error('汇总投递期间父会话已停止或切换');
      this.store.saveDelivery(event.userId, event.channelId, identity);
      registry.markDelivered(event.id);
    } catch (error) {
      registry.markUncertain(event.id, String(error));
      if (workspaceContext) {
        if (current()) { this.store.prepareWorkspaceNotice(target.id, 'load-failed'); await this.sendWorkspaceNotice(target); }
        registry.markUncertainNotified(event.id);
      } else if (observation) registry.markUncertainNotified(event.id);
      else if (!this.closed) await this.sink.sendText(event.channelId,
        `${notice}\n自动汇总或投递${controller.signal.aborted ? '已停止' : '失败'}，未自动重做或重新派发任务。结果已保留。`)
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
    await Promise.allSettled([...this.workers.values(), ...this.interruptPromises, ...[...this.noticeSends.values()].map(notice => notice.promise)]);
    const failures = adapterResults.flatMap(result => result.status === 'rejected' ? [result.reason as Error] : []);
    try { this.store.close(); }
    catch (cause) { failures.push(new Error(`会话数据库关闭失败: ${String(cause)}`, { cause })); }
    if (failures.length) throw new AggregateError(failures, failures.map(error => error.message).join('\n'));
  }
}
