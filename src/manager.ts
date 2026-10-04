import { statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { SessionStore } from './store.js';
import { isModelId } from './config.js';
import { agentDisplayName, replyHeader } from './reply.js';
import type { AgentAdapter, AgentModelInfo, AgentName, BridgeConfig, BridgeMessage, Conversation, ReplySink } from './types.js';

interface RunningTurn {
  messageId: string;
  conversationId: string;
  controller: AbortController;
}
const HELP = `直接发送文字或图片即可继续当前会话。
/new [codex|claude] 或 new chat：新会话
/agent：查看 Agent 选项；/agent codex 或 /agent claude：切换并续接会话
/chats：只读查看自己的历史会话
/cwd 路径：在指定目录新建会话
/model：查看当前模型；/model list 或 /models：列出模型
/model 模型名：切换当前会话模型，保留上下文
/model default：恢复 CLI 当前默认；/model custom 模型名：指定网关自定义模型
/status：查看当前会话和排队情况
/stop：停止当前任务并清空其队列
/help：查看帮助`;

function command(text: string): { name: string; argument: string } | null {
  const trimmed = text.trim();
  if (/^(?:new\s+chat|新会话|新聊天)$/i.test(trimmed)) return { name: 'new', argument: '' };
  const match = /^\/([a-z]+)(?:\s+([\s\S]*))?$/i.exec(trimmed);
  return match ? { name: match[1]!.toLowerCase(), argument: (match[2] ?? '').trim() } : null;
}

export class SessionManager {
  private readonly store: SessionStore;
  private readonly workers = new Map<string, Promise<void>>();
  private readonly running = new Map<string, RunningTurn>();
  private readonly interruptPromises = new Set<Promise<void>>();
  private readonly modelChanges = new Set<string>();
  private closed = false;
  private recovered = false;

  constructor(
    private readonly config: BridgeConfig,
    private readonly adapters: Record<AgentName, AgentAdapter>,
    private readonly sink: ReplySink,
  ) { this.store = new SessionStore(config.dataDir); }

  hasMessage(id: string): boolean { return this.store.hasMessage(id); }

  async handle(message: BridgeMessage, commandReply?: (text: string) => Promise<void>): Promise<void> {
    if (this.closed) throw new Error('桥已关闭');
    if (!this.config.allowedUserIds.includes(message.userId) || this.hasMessage(message.id)) return;
    const parsed = command(message.text);
    if (parsed) {
      if (!this.store.addMessage(message, null, 'command')) return;
      // An interaction reply belongs to this command invocation, never to a channel or queued turn.
      const reply = commandReply ?? ((text: string) => this.sink.sendText(message.channelId, text));
      try {
        await this.handleCommand(message, parsed.name, parsed.argument, reply);
        if (this.closed) return;
        this.store.setState(message.id, 'completed');
      } catch (error) {
        if (this.closed) return;
        this.store.setState(message.id, 'failed', String(error));
        await reply(`命令失败：${error instanceof Error ? error.message : String(error)}`);
      }
      return;
    }
    if (!message.text.trim() && message.imagePaths.length === 0) {
      if (this.store.addMessage(message, null, 'command')) {
        this.store.setState(message.id, 'completed');
        await this.sink.sendText(message.channelId, '请发送文字或图片；/help 查看帮助。');
      }
      return;
    }
    const active = this.ensureActive(message.userId);
    if (!this.store.addMessage(message, active.id, 'queued')) return;
    this.store.nameConversation(active.id, message.text);
    this.wake(active.id);
  }

  async recover(): Promise<void> {
    if (this.closed || this.recovered) return;
    this.recovered = true;
    for (const item of this.store.interruptRunning()) {
      if (this.closed) return;
      if (!this.config.allowedUserIds.includes(item.userId)) continue;
      await this.sink.sendText(item.channelId,
        `会话 ${item.conversationId?.slice(0, 8) ?? ''} 上次执行因桥重启而中断，未自动重做。请先确认执行结果，再决定继续。`)
        .catch(() => undefined);
    }
    if (this.closed) return;
    for (const id of this.store.queuedConversations()) this.wake(id);
  }

  private ensureActive(userId: string): Conversation {
    const current = this.store.getActive(userId);
    if (current) return current;
    const item = this.store.createConversation(userId, this.config.defaultAgent, this.config.workspace);
    this.store.setActive(userId, item.id);
    return item;
  }

  private cancel(conversation: Conversation): number {
    const total = this.store.cancelPending(conversation.id);
    const current = this.running.get(conversation.userId);
    if (current?.conversationId === conversation.id) {
      current.controller.abort();
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
  }

  private modelStatus(target: Conversation): string {
    const actual = target.actualModel ?? '尚未由 CLI 回报';
    return `实际模型：${actual}\n会话选择：${target.model ?? 'CLI 默认'}\n推理强度：${target.actualEffort ?? '尚未由 CLI 回报（沿用 CLI 设置）'}`;
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
      this.store.setModel(target.id, selected);
      await reply(`当前 ${target.agent} 会话下轮使用 ${selected}，上下文保留。${unverified ? '\n已设置模型 ID，提供方可用性尚未验证。' : ''}`);
    } finally {
      this.modelChanges.delete(target.id);
      if (!this.closed && this.store.pendingCount(target.id) > 0) this.wake(target.id);
    }
  }

  private async handleCommand(message: BridgeMessage, name: string, argument: string,
    reply: (text: string) => Promise<void>): Promise<void> {
    const current = this.store.getActive(message.userId);
    switch (name) {
      case 'help': await reply(HELP); return;
      case 'model': await this.handleModel(message, argument, reply); return;
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
          const previous = this.store.latestAgentConversation(message.userId, agent, current?.cwd ?? this.config.workspace);
          if (previous) {
            this.activate(message.userId, previous);
            await reply(`已切换到 ${agentDisplayName(agent)}，恢复会话 ${previous.id.slice(0, 8)}：${previous.title}\n原生会话：${previous.nativeId ? `…${previous.nativeId.slice(-6)}` : '尚未创建'}\n目录：${previous.cwd}`);
            this.wake(previous.id);
            return;
          }
        }
        const target = this.store.createConversation(message.userId, agent, current?.cwd ?? this.config.workspace);
        if (current?.agent === agent && current.model) this.store.setModel(target.id, current.model);
        this.activate(message.userId, target);
        await reply(`已新建 ${agentDisplayName(agent)} 会话 ${target.id.slice(0, 8)}。旧会话待处理任务已取消。\n原生会话：尚未创建\n目录：${target.cwd}`);
        return;
      }
      case 'cwd': {
        if (!argument) { await reply('用法：/cwd 目录路径'); return; }
        const value = argument.replace(/^(["'])([\s\S]*)\1$/, '$2');
        const cwd = isAbsolute(value) ? value : resolve(current?.cwd ?? this.config.workspace, value);
        if (!statSync(cwd).isDirectory()) { await reply('指定路径不是目录。'); return; }
        const target = this.store.createConversation(message.userId, current?.agent ?? this.config.defaultAgent, cwd);
        if (current?.model) this.store.setModel(target.id, current.model);
        this.activate(message.userId, target);
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
      case 'status':
        await reply(current
          ? `${agentDisplayName(current.agent)} · ${current.id.slice(0, 8)} · ${current.title}\n${this.modelStatus(current)}\n原生会话：${current.nativeId ? `…${current.nativeId.slice(-6)}` : '尚未创建'}\n目录：${current.cwd}\n${this.running.get(message.userId)?.conversationId === current.id ? '正在执行' : '空闲'}；排队 ${this.store.pendingCount(current.id)} 条；${current.nativeId ? '已有可续接的 Agent 会话' : '尚未创建 Agent 会话'}`
          : '还没有会话，发送文字或图片即可开始。');
        return;
      case 'stop': {
        const count = current ? this.cancel(current) : 0;
        await reply(count ? `已停止当前任务，取消 ${count} 条待处理任务。会话保留，可继续发送消息。` : '当前没有待处理任务。');
        return;
      }
      default: await reply('未知命令；/help 查看可用命令。');
    }
  }

  private wake(conversationId: string): void {
    if (this.closed || this.workers.has(conversationId) || this.modelChanges.has(conversationId)) return;
    const worker = Promise.resolve().then(() => this.processQueue(conversationId)).finally(() => {
      this.workers.delete(conversationId);
      if (!this.closed && this.store.nextQueued(conversationId)) this.wake(conversationId);
    });
    this.workers.set(conversationId, worker);
    // Errors from Discord delivery must not become unhandled rejections.
    void worker.catch(() => undefined);
  }

  private async processQueue(conversationId: string): Promise<void> {
    while (!this.closed && !this.modelChanges.has(conversationId)) {
      const item = this.store.nextQueued(conversationId);
      if (!item) return;
      const target = this.store.getConversation(conversationId);
      if (!target || !this.config.allowedUserIds.includes(item.userId)
        || this.store.getActive(item.userId)?.id !== conversationId) {
        this.store.setState(item.id, 'cancelled'); continue;
      }
      const controller = new AbortController();
      const turn: RunningTurn = { messageId: item.id, conversationId, controller };
      this.running.set(item.userId, turn);
      this.store.setState(item.id, 'running');
      const current = () => !this.closed && !controller.signal.aborted
        && this.running.get(item.userId) === turn
        && this.store.getActive(item.userId)?.id === conversationId
        && this.store.getMessage(item.id)?.state === 'running';
      let actualModel: string | null = null;
      let actualEffort: string | null = null;
      try {
        const result = await this.adapters[target.agent].run({
          conversation: target, text: item.text, imagePaths: item.imagePaths,
          signal: controller.signal,
          onNativeId: nativeId => { if (current() && nativeId) this.store.saveNativeId(conversationId, nativeId); },
          onModel: model => {
            if (current() && model) { actualModel = model; this.store.saveActualModel(conversationId, model); }
          },
          onReasoningEffort: effort => {
            if (current()) { actualEffort = effort; this.store.saveActualEffort(conversationId, effort); }
          },
          // Adapters emit deltas and protocol/tool events through this callback.
          // Only the completed reply is user-facing; no asynchronous sends can linger after cancellation.
          onProgress: () => {},
        });
        if (!current()) continue;
        if (!result.nativeId) throw new Error('Agent 未返回会话 ID，无法保证连续会话');
        this.store.saveNativeId(conversationId, result.nativeId);
        this.store.setState(item.id, 'completed');
        const identity = { conversationId, agent: target.agent, nativeId: result.nativeId };
        const header = replyHeader(identity, this.store.getLastDelivery(item.userId, item.channelId), actualModel, actualEffort);
        await this.sink.sendText(item.channelId, `${header}\n\n${result.text || '本轮完成（没有文本输出）。'}`, { repeatHeader: header });
        // Failed or partially delivered replies never establish successful continuity.
        this.store.saveDelivery(item.userId, item.channelId, identity);
      } catch (error) {
        if (controller.signal.aborted || this.closed || this.store.getMessage(item.id)?.state === 'cancelled') {
          if (this.store.getMessage(item.id)?.state === 'running') this.store.setState(item.id, 'cancelled');
        } else {
          // A completed model turn is never retried merely because reply delivery failed.
          if (this.store.getMessage(item.id)?.state === 'running') this.store.setState(item.id, 'failed', String(error));
          await this.sink.sendText(item.channelId,
            `执行或回复失败：${error instanceof Error ? error.message : String(error)}`)
            .catch(() => undefined);
        }
      } finally {
        if (this.running.get(item.userId) === turn) this.running.delete(item.userId);
      }
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const turn of this.running.values()) turn.controller.abort();
    await Promise.allSettled(Object.values(this.adapters).map(adapter => adapter.close()));
    await Promise.allSettled([...this.workers.values(), ...this.interruptPromises]);
    this.store.close();
  }
}
