import type { AgentAdapter, AgentCommand, AgentModelInfo, AgentResult, AgentTurn } from '../types.js';
import { abortError, deferred, isObject, JsonLineProcess, JsonRpcClient, safeError, type JsonObject } from './process.js';

/** App-server v2 stdio protocol, verified against Codex rust-v0.160.0. */
export class CodexAdapter implements AgentAdapter {
  private readonly active = new Map<string, () => Promise<void>>();
  private closed = false;
  private readonly metadataProcesses = new Set<JsonLineProcess>();

  constructor(private readonly command: AgentCommand, private readonly env: NodeJS.ProcessEnv) {}

  async getModelInfo(cwd: string): Promise<AgentModelInfo> {
    if (this.closed) throw new Error('Codex 适配器已关闭。');
    const transport = new JsonLineProcess(this.command, ['app-server', '--listen', 'stdio://'], cwd, this.env);
    this.metadataProcesses.add(transport);
    const rpc = new JsonRpcClient(transport);
    let success = false;
    try {
      await rpc.request('initialize', { clientInfo: { name: 'discord_agent_bridge', version: '0.1.0' }, capabilities: { experimentalApi: false } }, 15_000);
      rpc.notify('initialized');
      const configured = await rpc.request('config/read', { includeLayers: false, cwd }, 15_000);
      const config = isObject(configured.config) ? configured.config : {};
      const models: AgentModelInfo['models'] = [];
      const cursors = new Set<string>();
      let cursor: string | null = null;
      do {
        const page = await rpc.request('model/list', { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) }, 15_000);
        if (!Array.isArray(page.data)) throw new Error('Codex 模型目录格式不正确。');
        for (const value of page.data) {
          if (!isObject(value) || typeof value.model !== 'string' || !value.model || value.hidden === true) continue;
          if (!models.some(model => model.id === value.model)) models.push({
            id: value.model, displayName: typeof value.displayName === 'string' ? value.displayName : value.model,
            description: typeof value.description === 'string' ? value.description : '', isDefault: value.isDefault === true,
          });
        }
        cursor = typeof page.nextCursor === 'string' && page.nextCursor ? page.nextCursor : null;
        if (cursor && (cursors.has(cursor) || cursors.size >= 20)) throw new Error('Codex 模型目录分页异常。');
        if (cursor) cursors.add(cursor);
      } while (cursor);
      success = true;
      return { models, defaultModel: typeof config.model === 'string' && config.model ? config.model : models.find(model => model.isDefault)?.id ?? null };
    } finally {
      await transport.stop(success); rpc.close(); this.metadataProcesses.delete(transport);
    }
  }

  async run(turn: AgentTurn): Promise<AgentResult> {
    if (this.closed) throw new Error('Codex 适配器已关闭。');
    if (turn.signal.aborted) throw abortError();
    const conversationId = turn.conversation.id;
    if (this.active.has(conversationId)) throw new Error('该 Codex 会话仍在执行任务。');

    const transport = new JsonLineProcess(this.command, ['app-server', '--listen', 'stdio://'], turn.conversation.cwd, this.env);
    const rpc = new JsonRpcClient(transport);
    const completed = deferred<AgentResult>();
    const replies = new Map<string, { text: string; phase: unknown }>();
    let nativeId = turn.conversation.nativeId;
    let turnId: string | null = null;
    let cancelled = false;
    let cancelling: Promise<void> | null = null;

    const collect = (value: unknown) => {
      if (isObject(value) && value.type === 'agentMessage' && typeof value.text === 'string') {
        const key = typeof value.id === 'string' ? value.id : String(replies.size);
        replies.set(key, { text: value.text, phase: value.phase });
      }
    };
    const removeFailure = transport.onFailure((error) => completed.reject(error));
    const removeMessage = transport.onMessage((message: JsonObject) => {
      if (typeof message.method !== 'string') return;
      if ('id' in message) {
        // Never leave an unsupported server request waiting indefinitely.
        transport.write({ id: message.id, error: { code: -32601, message: 'This bridge does not support interactive server requests.' } });
        completed.reject(new Error(`Codex 请求交互操作，桥暂不支持：${message.method}`));
        return;
      }
      const params = isObject(message.params) ? message.params : {};
      if (typeof params.threadId === 'string' && nativeId && params.threadId !== nativeId) return;
      if (typeof params.turnId === 'string' && turnId && params.turnId !== turnId) return;
      if (message.method === 'turn/started' && isObject(params.turn) && typeof params.turn.id === 'string') {
        turnId = params.turn.id;
      } else if (message.method === 'item/agentMessage/delta' && typeof params.delta === 'string') {
        turn.onProgress(params.delta);
      } else if (message.method === 'model/rerouted' && typeof params.toModel === 'string' && params.toModel) {
        turn.onModel?.(params.toModel);
      } else if (message.method === 'item/completed') {
        collect(params.item);
      } else if (message.method === 'error' && params.willRetry === false) {
        const error = isObject(params.error) ? params.error : params;
        completed.reject(new Error(`Codex 请求失败：${safeError(error.message, 'Agent 错误')}`));
      } else if (message.method === 'turn/completed' && isObject(params.turn)) {
        const result = params.turn;
        if (turnId && typeof result.id === 'string' && result.id !== turnId) return;
        if (cancelled || result.status === 'interrupted') { completed.reject(abortError()); return; }
        if (result.status !== 'completed') {
          const error = isObject(result.error) ? result.error : {};
          completed.reject(new Error(`Codex 执行失败：${safeError(error.message, '未正常完成')}`));
          return;
        }
        if (Array.isArray(result.items)) result.items.forEach(collect);
        const messages = [...replies.values()];
        const final = messages.filter((item) => item.phase === 'final_answer');
        const fallback = messages.filter((item) => item.phase !== 'commentary');
        const text = (final.length ? final : fallback).map((item) => item.text).join('\n\n').trim();
        if (!nativeId) completed.reject(new Error('Codex 没有返回会话标识。'));
        else completed.resolve({ nativeId, text: text || '任务已完成。' });
      }
    });

    const cancel = (): Promise<void> => {
      if (cancelling) return cancelling;
      cancelled = true;
      completed.reject(abortError());
      cancelling = (async () => {
        if (nativeId && turnId) {
          try { await rpc.request('turn/interrupt', { threadId: nativeId, turnId }, 1000); }
          catch { /* Always stop the process tree even if the RPC channel failed. */ }
        }
        await transport.stop(false);
      })();
      return cancelling;
    };
    this.active.set(conversationId, cancel);
    const onAbort = () => { void cancel().catch(() => {}); };
    turn.signal.addEventListener('abort', onAbort, { once: true });

    let success = false;
    try {
      if (turn.signal.aborted) { await cancel(); throw abortError(); }
      await rpc.request('initialize', {
        clientInfo: { name: 'discord_agent_bridge', title: 'Discord Agent Bridge', version: '0.1.0' },
        capabilities: { experimentalApi: false },
      });
      rpc.notify('initialized');
      if (cancelled) throw abortError();
      // Read the effective configuration for every turn, including after a CC Switch change.
      // Resume directly by native ID rather than relying on the CLI's provider-filtered list.
      const configured = await rpc.request('config/read', { includeLayers: false, cwd: turn.conversation.cwd }, 15_000);
      if (cancelled) throw abortError();
      if (!isObject(configured.config)) throw new Error('Codex 未返回有效供应商配置，本轮任务尚未提交。');
      const configuredProvider = configured.config.model_provider;
      if (configuredProvider != null && (typeof configuredProvider !== 'string' || !configuredProvider.trim())) {
        throw new Error('Codex 当前供应商配置无效，本轮任务尚未提交。');
      }
      const modelProvider = typeof configuredProvider === 'string' ? configuredProvider : 'openai';
      const resumeId = nativeId;
      let thread: JsonObject;
      try {
        thread = await rpc.request(resumeId ? 'thread/resume' : 'thread/start', {
          ...(resumeId ? { threadId: resumeId } : {}), modelProvider,
          cwd: turn.conversation.cwd, approvalPolicy: 'never', sandbox: 'danger-full-access',
          ...(turn.conversation.model ? { model: turn.conversation.model } : {}),
        });
      } catch (error) {
        if (cancelled) throw abortError();
        if (!resumeId) throw error;
        throw new Error(`Codex 无法在当前供应商下续接；原会话已保留，本轮任务尚未提交。检查 CC Switch 配置后直接继续对话即可。原因：${safeError(error instanceof Error ? error.message : error, '续接失败')}`);
      }
      if (cancelled) throw abortError();
      if (!isObject(thread.thread) || typeof thread.thread.id !== 'string' || !thread.thread.id) {
        throw new Error('Codex 没有返回有效会话标识。');
      }
      if (typeof thread.modelProvider !== 'string' || thread.modelProvider !== modelProvider) {
        throw new Error('Codex 回报的供应商与当前配置不一致；原会话已保留，本轮任务尚未提交。');
      }
      if (resumeId && thread.thread.id !== resumeId) {
        throw new Error('Codex 续接返回了不同会话；原会话已保留，本轮任务尚未提交。');
      }
      nativeId = thread.thread.id;
      turn.onNativeId?.(nativeId);
      if (typeof thread.model === 'string' && thread.model) turn.onModel?.(thread.model);
      if (typeof thread.reasoningEffort === 'string' || thread.reasoningEffort === null) {
        turn.onReasoningEffort?.(thread.reasoningEffort);
      }
      if (cancelled) throw abortError();
      const input: JsonObject[] = [];
      if (turn.text) input.push({ type: 'text', text: turn.text, text_elements: [] });
      for (const path of turn.imagePaths) input.push({ type: 'localImage', path });
      if (!input.length) throw new Error('消息没有文字或图片。');
      if (turn.deliveryInstructions?.trim()) {
        input.push({ type: 'text', text: turn.deliveryInstructions, text_elements: [] });
      }
      const started = await rpc.request('turn/start', {
        threadId: nativeId, input, cwd: turn.conversation.cwd,
        approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' },
        ...(turn.conversation.model ? { model: turn.conversation.model } : {}),
      });
      if (!isObject(started.turn) || typeof started.turn.id !== 'string') throw new Error('Codex 没有返回任务标识。');
      turnId = started.turn.id;
      if (cancelled) throw abortError();
      const result = await completed.promise;
      success = true;
      return result;
    } catch (error) {
      if (cancelled) throw abortError();
      throw error;
    } finally {
      turn.signal.removeEventListener('abort', onAbort);
      if (cancelling) await cancelling;
      else await transport.stop(success);
      removeMessage(); removeFailure(); rpc.close();
      this.active.delete(conversationId);
    }
  }

  async interrupt(conversationId: string): Promise<void> { await this.active.get(conversationId)?.(); }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.all([...this.active.values()].map((cancel) => cancel()).concat([...this.metadataProcesses].map(process => process.stop(false))));
  }
}
