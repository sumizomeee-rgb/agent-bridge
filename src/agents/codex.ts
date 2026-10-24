import { readOnlyRuntime } from './readonly.js';
import { MetadataProbeError, MetadataProbes } from './metadata.js';
import { createEffortReporter, effortCapabilityForModel, isEffortLevel, normalizeEffortCapability, resolveDefaultModel, selectedEffort, validateEffort } from '../effort.js';
import type { AgentAdapter, AgentCommand, AgentModelInfo, AgentResult, AgentTurn, AgentSupplement, SteerResult } from '../types.js';
import { abortError, deferred, isObject, JsonLineProcess, JsonRpcClient, JsonRpcError, processStopFailure, retireCompletedTurn, safeError, type JsonObject, type RpcTransport } from './process.js';

/** App-server v2 stdio protocol, verified against Codex rust-v0.160.0. */
export class CodexAdapter implements AgentAdapter {
  private readonly active = new Map<string, () => Promise<void>>();
  private readonly executions = new Map<string, RpcTransport>();
  private readonly retirements = new Set<string>();
  private readonly retirementCleanups = new Map<string, () => void>();
  private readonly stopped = new Set<string>();
  private readonly supplements = new Map<string, (message: AgentSupplement) => Promise<SteerResult>>();
  private closed = false;
  private readonly metadata = new MetadataProbes();

  constructor(private readonly command: AgentCommand, private readonly env: NodeJS.ProcessEnv,
    private readonly createTransport: (command: AgentCommand, args: string[], cwd: string, env: NodeJS.ProcessEnv) => RpcTransport =
      (command, args, cwd, env) => new JsonLineProcess(command, args, cwd, env)) {}

  async getModelInfo(cwd: string): Promise<AgentModelInfo> {
    if (this.closed) throw new Error('Codex 适配器已关闭。');
    const priorRetirement = this.metadata.prepare(); if (priorRetirement) await priorRetirement;
    // 元数据查询不需要用户 MCP、hooks 或其他工具；认证与模型路由保留在独立临时 home。
    const readonly = readOnlyRuntime('codex', this.env);
    let transport: RpcTransport;
    try { transport = this.createTransport(this.command, ['app-server', '--listen', 'stdio://', ...readonly.args], cwd, readonly.env); }
    catch (error) { readonly.cleanup(); throw error; }
    this.metadata.track(transport, readonly.cleanup);
    const rpc = new JsonRpcClient(transport);
    let success = false, primary: unknown;
    try {
      await rpc.request('initialize', { clientInfo: { name: 'agent_bridge', version: '0.1.0' }, capabilities: { experimentalApi: false } }, 15_000);
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
            effortCapability: normalizeEffortCapability('codex', Array.isArray(value.supportedReasoningEfforts) ? value.supportedReasoningEfforts.map(item => isObject(item) ? item.reasoningEffort : null) : undefined, { source: 'codex-model-list', modelId: value.model }),
            ...(Array.isArray(value.supportedReasoningEfforts) ? { supportedEfforts: value.supportedReasoningEfforts.filter(isObject).map(item => item.reasoningEffort).filter((item): item is string => typeof item === 'string') } : {}),
          });
        }
        cursor = typeof page.nextCursor === 'string' && page.nextCursor ? page.nextCursor : null;
        if (cursor && (cursors.has(cursor) || cursors.size >= 20)) throw new Error('Codex 模型目录分页异常。');
        if (cursor) cursors.add(cursor);
      } while (cursor);
      success = true;
      return { models, source: 'codex-model-list', defaultModel: typeof config.model === 'string' && config.model ? config.model : models.find(model => model.isDefault)?.id ?? null };
    } catch (error) { primary = error; throw new MetadataProbeError(error, true); }
    finally {
      rpc.close();
      if (success) this.metadata.complete(transport);
      else await this.metadata.failed(transport, primary);
    }
  }

  async run(turn: AgentTurn): Promise<AgentResult> {
    if (this.closed) throw new Error('Codex 适配器已关闭。');
    if (turn.signal.aborted) throw abortError();
    turn = await resolveDefaultModel(this, turn);
    const effort = selectedEffort(turn);
    const capability = effort ? await validateEffort(this, turn.conversation, effort)
      : normalizeEffortCapability('codex', undefined, { source: 'codex-model-list', modelId: turn.conversation.model ?? null });
    const reportEffort = createEffortReporter(turn, 'codex', { capability, configuration: effort ? { value: effort, source: 'argument' } : null });
    reportEffort();
    let currentCapability = capability;
    const reportModel = (model: string) => {
      currentCapability = effortCapabilityForModel(currentCapability, model);
      reportEffort({ capability: currentCapability }); turn.onModel?.(model);
    };
    if (turn.signal.aborted) throw abortError();
    if (this.closed) throw new Error('Codex 适配器已关闭。');
    const conversationId = turn.conversation.id;
    if (this.retirements.has(conversationId)) {
      try { await this.executions.get(conversationId)?.stop(true); }
      catch (error) { throw new Error('上一轮已完成，CLI 仍在收尾；本轮尚未提交。', { cause: error }); }
    }
    if (this.active.has(conversationId)) throw new Error('该 Codex 会话仍在执行任务。');

    if (turn.readOnly && (turn.conversation.nativeId || turn.taskContextPath)) throw new Error('只读摘要必须使用独立的新会话且不能持有任务登记权限。');
    const readonly = turn.readOnly ? readOnlyRuntime('codex', this.env) : undefined;
    let transport: RpcTransport;
    try { transport = this.createTransport(this.command, ['app-server', '--listen', 'stdio://', ...(readonly?.args ?? [])], turn.conversation.cwd,
      readonly?.env ?? { ...this.env, ...(turn.taskContextPath ? { BRIDGE_TASK_CONTEXT: turn.taskContextPath } : {}) }); }
    catch (error) { readonly?.cleanup(); throw error; }
    const rpc = new JsonRpcClient(transport);
    this.executions.set(conversationId, transport); this.stopped.delete(conversationId);
    if (readonly) this.retirementCleanups.set(conversationId, readonly.cleanup);
    const completed = deferred<AgentResult>();
    const replies = new Map<string, { text: string; phase: unknown }>();
    const observedItems = new Set<string>();
    const toolTypes = new Set(['commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall', 'webSearch', 'imageView', 'collabAgentToolCall']);
    const activity = (item: unknown, completed: boolean) => {
      if (!isObject(item) || typeof item.type !== 'string' || typeof item.id !== 'string') return;
      const key = `${completed ? 'completed' : 'started'}:${item.id}`; if (observedItems.has(key)) return;
      observedItems.add(key);
      const at = new Date().toISOString();
      if (toolTypes.has(item.type)) {
        const toolName = item.type === 'mcpToolCall' && typeof item.tool === 'string' ? item.tool
          : item.type === 'dynamicToolCall' && typeof item.tool === 'string' ? item.tool : item.type;
        turn.onActivity?.({ at, type: completed ? 'tool-completed' : 'tool-started', itemId: item.id, toolName,
          ...(completed ? { status: item.status === 'failed' ? 'failed' : item.status === 'completed' ? 'completed' : 'unknown' } : {}) });
      } else if (!completed && (item.type === 'reasoning' || item.type === 'agentMessage')) {
        turn.onActivity?.({ at, type: item.type === 'reasoning' ? 'reasoning' : 'message', itemId: item.id });
      }
    };
    let nativeId = turn.conversation.nativeId;
    let turnId: string | null = null;
    let cancelled = false;
    let terminalReceipt = false;
    let runFinished = false;
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
        reportModel(params.toModel);
      } else if (message.method === 'item/started') {
        activity(params.item, false);
      } else if (message.method === 'item/completed') {
        activity(params.item, true); collect(params.item);
      } else if (message.method === 'error' && params.willRetry === false) {
        const error = isObject(params.error) ? params.error : params;
        completed.reject(new Error(`Codex 请求失败：${safeError(error.message, 'Agent 错误')}`));
      } else if (message.method === 'turn/completed' && isObject(params.turn)) {
        const result = params.turn;
        if (turnId && typeof result.id === 'string' && result.id !== turnId) return;
        terminalReceipt = true; this.retirements.add(conversationId);
        if (cancelled || result.status === 'interrupted') { completed.reject(abortError()); return; }
        if (result.status !== 'completed') {
          const error = isObject(result.error) ? result.error : {};
          completed.reject(new Error(`Codex 执行失败：${safeError(error.message, '未正常完成')}`));
          return;
        }
        if (Array.isArray(result.items)) result.items.forEach(item => { activity(item, true); collect(item); });
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
      const operation = (async () => {
        if (nativeId && turnId) {
          try { await rpc.request('turn/interrupt', { threadId: nativeId, turnId }, 1000); }
          catch { /* Always stop the process tree even if the RPC channel failed. */ }
        }
        await transport.stop(false);
      })();
      cancelling = operation;
      void operation.then(() => { this.stopped.add(conversationId); if (runFinished) { this.active.delete(conversationId); this.executions.delete(conversationId); this.retirements.delete(conversationId); this.retirementCleanups.get(conversationId)?.(); this.retirementCleanups.delete(conversationId); } }, () => { if (cancelling === operation) cancelling = null; }).catch(() => { process.emitWarning('只读临时目录清理未完成。', { code: 'BRIDGE_READONLY_CLEANUP' }); });
      return operation;
    };
    // 0.160.0 generate-ts：TurnSteerParams / TurnSteerResponse，非实验协议。
    this.supplements.set(conversationId, async message => {
      if (cancelled || completed.settled || !nativeId || !turnId) return { status: 'queued' };
      const expectedTurnId = turnId;
      try {
        const response = await rpc.request('turn/steer', {
          threadId: nativeId, expectedTurnId,
          input: message.input.map(value => value.type === 'text' ? { ...value, text_elements: [] } : value),
        }, 10_000);
        if (response.turnId !== expectedTurnId) return { status: 'uncertain', reason: 'Codex 补充响应未确认目标 turn。' };
        return { status: 'accepted' };
      } catch (error) {
        // 仅服务端的明确拒绝可以安全接下一轮；断线/超时可能已执行。
        if (error instanceof JsonRpcError && [-32600, -32601, -32602].includes(error.code ?? 0)) return { status: 'queued', ...(error.code === -32601 ? { unsupported: true, reason: '此 Codex CLI 不支持 turn/steer；未发送，可明确排队下一轮。' } : {}) };
        return { status: 'uncertain', reason: safeError(error instanceof Error ? error.message : error, '补充结果未知') };
      }
    });
    this.active.set(conversationId, cancel);
    const onAbort = () => { void cancel().catch(() => {}); };
    turn.signal.addEventListener('abort', onAbort, { once: true });

    let success = false;
    let nativeResult: AgentResult | undefined;
    try {
      if (turn.signal.aborted) { await cancel(); throw abortError(); }
      await rpc.request('initialize', {
        clientInfo: { name: 'agent_bridge', title: 'Agent Bridge', version: '0.1.0' },
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
      if (!effort && isEffortLevel(configured.config.model_reasoning_effort)) reportEffort({ configuration: { value: configured.config.model_reasoning_effort, source: 'session-settings' } });
      // Resume full server-side context, without copying its image/tool history back into stdio.
      const resumeId = nativeId;
      let thread: JsonObject;
      try {
        thread = await rpc.request(resumeId ? 'thread/resume' : 'thread/start', {
          ...(resumeId ? { threadId: resumeId, excludeTurns: true } : {}), modelProvider,
          cwd: turn.conversation.cwd, approvalPolicy: 'never', sandbox: turn.readOnly ? 'read-only' : 'danger-full-access',
          ...((effort ?? configured.config.model_reasoning_effort) ? { config: { model_reasoning_effort: effort ?? configured.config.model_reasoning_effort } } : {}),
          ...(turn.conversation.model ? { model: turn.conversation.model } : {}),
        });
      } catch (error) {
        if (cancelled) throw abortError();
        if (!resumeId) throw error;
        throw new Error(`Codex 续接失败；原会话已保留，本轮任务尚未提交。原因：${safeError(error instanceof Error ? error.message : error, '续接失败')}`);
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
      if (effort && typeof thread.model === 'string' && thread.model !== turn.conversation.model) currentCapability = await validateEffort(this, { ...turn.conversation, model: thread.model }, effort);
      nativeId = thread.thread.id;
      turn.onNativeId?.(nativeId);
      if (typeof thread.model === 'string' && thread.model) reportModel(thread.model);
      if (!effort && (typeof thread.reasoningEffort === 'string' || thread.reasoningEffort === null)) {
        reportEffort({ actual: thread.reasoningEffort });
      }
      if (effort) reportEffort({ actual: null });
      if (cancelled) throw abortError();
      const input: JsonObject[] = [];
      for (const value of turn.input ?? [
        ...(turn.text ? [{ type: 'text' as const, text: turn.text }] : []),
        ...turn.imagePaths.map(path => ({ type: 'localImage' as const, path })),
      ]) input.push(value.type === 'text' ? { ...value, text_elements: [] } : value);
      if (!input.length) throw new Error('消息没有文字或图片。');
      const started = await rpc.request('turn/start', {
        threadId: nativeId, input, cwd: turn.conversation.cwd,
        approvalPolicy: 'never', sandboxPolicy: { type: turn.readOnly ? 'readOnly' : 'dangerFullAccess' },
        ...(turn.conversation.model ? { model: turn.conversation.model } : {}),
        ...(effort ? { effort } : {}),
      });
      if (effort) {
        try {
          const configured = await rpc.request('thread/read', { includeTurns: false, threadId: nativeId });
          const actual = isObject(configured.thread) ? configured.thread.reasoningEffort : null;
          reportEffort({ actual: typeof actual === 'string' ? actual : null });
        } catch { reportEffort({ actual: null }); } // Metadata failure must not replay an already submitted turn.
      }
      if (!isObject(started.turn) || typeof started.turn.id !== 'string') throw new Error('Codex 没有返回任务标识。');
      turnId = started.turn.id;
      if (cancelled) throw abortError();
      if (!completed.settled) turn.onReady?.();
      nativeResult = await completed.promise;
      this.retirements.add(conversationId);
      success = true;
      return nativeResult;
    } catch (error) {
      if (cancelled) throw abortError();
      throw error;
    } finally {
      turn.signal.removeEventListener('abort', onAbort);
      try {
        const released = () => {
          this.active.delete(conversationId); this.stopped.add(conversationId);
          this.executions.delete(conversationId); this.retirements.delete(conversationId);
          this.retirementCleanups.get(conversationId)?.(); this.retirementCleanups.delete(conversationId);
        };
        if (success && nativeResult && !cancelled) retireCompletedTurn(transport, nativeResult, released);
        else { if (cancelling) await cancelling; else await transport.stop(terminalReceipt); released(); }
      } catch (error) { throw processStopFailure(error, nativeResult); }
      finally {
        removeMessage(); removeFailure(); rpc.close();
        this.supplements.delete(conversationId);
        runFinished = true;
        if (!success) readonly?.cleanup();
      }
    }
  }

  async steer(conversationId: string, message: AgentSupplement): Promise<SteerResult> {
    return this.supplements.get(conversationId)?.(message) ?? { status: 'queued' };
  }

  async confirmStopped(conversationId: string): Promise<boolean> {
    if (this.executions.get(conversationId)?.confirmStopped?.()) {
      this.stopped.add(conversationId); this.active.delete(conversationId); this.executions.delete(conversationId); this.retirements.delete(conversationId);
      this.retirementCleanups.get(conversationId)?.(); this.retirementCleanups.delete(conversationId);
    }
    return this.stopped.has(conversationId);
  }

  async interrupt(conversationId: string): Promise<void> { await this.active.get(conversationId)?.(); }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.all([...this.active.entries()].map(([id, cancel]) => this.retirements.has(id) ? this.executions.get(id)!.stop(true) : cancel()).concat([this.metadata.close()]));
  }
}
