import { selectedEffort, validateEffort } from '../effort.js';
import { readFile } from 'node:fs/promises';
import type { AgentAdapter, AgentCommand, AgentModelInfo, AgentResult, AgentTurn, AgentSupplement, SteerResult } from '../types.js';
import { abortError, deferred, isObject, JsonLineProcess, safeError, type JsonObject } from './process.js';

function imageMediaType(bytes: Buffer): string {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'))) return 'image/gif';
  if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  throw new Error('Claude 支持 PNG、JPEG、GIF 和 WebP 图片；该附件格式无法识别。');
}

type ClaudeTransport = Pick<JsonLineProcess, 'onMessage' | 'onFailure' | 'write' | 'stop' | 'endInput'>;

/** Claude CLI structured streaming input; prompts never pass through a shell. */
export class ClaudeAdapter implements AgentAdapter {
  private readonly active = new Map<string, () => Promise<void>>();
  private readonly supplements = new Map<string, (message: AgentSupplement) => Promise<SteerResult>>();
  private closed = false;
  private readonly metadataProcesses = new Set<JsonLineProcess>();

  constructor(private readonly command: AgentCommand, private readonly env: NodeJS.ProcessEnv,
    private readonly createTransport: (command: AgentCommand, args: string[], cwd: string, env: NodeJS.ProcessEnv) => ClaudeTransport =
      (command, args, cwd, env) => new JsonLineProcess(command, args, cwd, env)) {}

  async getModelInfo(cwd: string): Promise<AgentModelInfo> {
    if (this.closed) throw new Error('Claude 适配器已关闭。');
    // Same initialize control envelope used by Anthropic's Agent SDK.
    // No user message is sent, so this cannot start a model generation.
    const transport = new JsonLineProcess(this.command, ['--print', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions'], cwd, this.env);
    this.metadataProcesses.add(transport);
    const completed = deferred<AgentModelInfo>();
    const timer = setTimeout(() => completed.reject(new Error('Claude 模型元数据等待超时。')), 10_000);
    const removeFailure = transport.onFailure(error => completed.reject(error));
    const removeMessage = transport.onMessage(message => {
      if (message.type !== 'control_response' || !isObject(message.response) || message.response.request_id !== 'bridge-models') return;
      const response = message.response;
      if (response.subtype === 'error') { completed.reject(new Error(`Claude 元数据请求失败：${safeError(response.error, '控制协议错误')}`)); return; }
      const payload = isObject(response.response) ? response.response : {};
      const models: AgentModelInfo['models'] = [];
      if (Array.isArray(payload.models)) for (const item of payload.models) {
        if (!isObject(item)) continue;
        const id = typeof item.value === 'string' ? item.value : item.id;
        if (typeof id !== 'string' || !id || id === 'default') continue;
        models.push({ id, displayName: typeof item.displayName === 'string' ? item.displayName : id,
          description: typeof item.description === 'string' ? item.description : '',
          ...(item.supportsEffort === false ? { supportedEfforts: [] } : Array.isArray(item.supportedEffortLevels) ? { supportedEfforts: item.supportedEffortLevels.filter((value): value is string => typeof value === 'string') } : {}) });
      }
      const defaultModel = typeof payload.model === 'string' ? payload.model : typeof payload.defaultModel === 'string' ? payload.defaultModel : this.env.ANTHROPIC_MODEL ?? null;
      completed.resolve({ models, defaultModel: defaultModel === 'default' ? null : defaultModel });
    });
    let success = false;
    try {
      transport.write({ type: 'control_request', request_id: 'bridge-models', request: { subtype: 'initialize', hooks: null } });
      const result = await completed.promise; success = true; return result;
    } finally {
      clearTimeout(timer); await transport.stop(success); removeMessage(); removeFailure(); this.metadataProcesses.delete(transport);
    }
  }

  async run(turn: AgentTurn): Promise<AgentResult> {
    if (this.closed) throw new Error('Claude 适配器已关闭。');
    if (turn.signal.aborted) throw abortError();
    const effort = selectedEffort(turn);
    if (effort) await validateEffort(this, turn.conversation, effort);
    turn.onReasoningEffort?.(null);
    const conversationId = turn.conversation.id;
    if (this.active.has(conversationId)) throw new Error('该 Claude 会话仍在执行任务。');
    const content: JsonObject[] = [];
    for (const value of turn.input ?? [
      ...(turn.text ? [{ type: 'text' as const, text: turn.text }] : []),
      ...turn.imagePaths.map(path => ({ type: 'localImage' as const, path })),
    ]) {
      if (value.type === 'text') content.push(value);
      else {
        const bytes = await readFile(value.path);
        content.push({ type: 'image', source: { type: 'base64', media_type: imageMediaType(bytes), data: bytes.toString('base64') } });
      }
    }
    if (!content.length) throw new Error('消息没有文字或图片。');
    if (turn.signal.aborted) throw abortError();
    if (this.closed) throw new Error('Claude 适配器已关闭。');
    if (this.active.has(conversationId)) throw new Error('该 Claude 会话仍在执行任务。');

    const args = ['--print', '--input-format', 'stream-json', '--output-format', 'stream-json',
      '--verbose', '--include-partial-messages', '--dangerously-skip-permissions',
      ...(turn.acceptSupplements ? ['--replay-user-messages'] : [])];
    if (effort) args.push('--effort', effort);
    if (turn.conversation.nativeId) args.push('--resume', turn.conversation.nativeId);
    if (turn.conversation.model) args.push('--model', turn.conversation.model);
    const transport = this.createTransport(this.command, args, turn.conversation.cwd,
      { ...this.env, ...(turn.taskContextPath ? { BRIDGE_TASK_CONTEXT: turn.taskContextPath } : {}) });
    const completed = deferred<AgentResult>();
    let nativeId = turn.conversation.nativeId;
    let cancelled = false;
    let cancelling: Promise<void> | null = null;
    let inputSent = false;
    let initialized = false;
    let liveSupported = false;
    let resultSeen = false;
    const observedTools = new Map<string, string>();
    const completedTools = new Set<string>();
    const observedBlocks = new Set<string>();
    const observeContent = (message: JsonObject) => {
      if (message.parent_tool_use_id || !isObject(message.message) || !Array.isArray(message.message.content)) return;
      for (const block of message.message.content) {
        if (!isObject(block)) continue;
        if (message.type === 'assistant' && block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string'
          && !observedTools.has(block.id)) {
          observedTools.set(block.id, block.name);
          turn.onActivity?.({ at: new Date().toISOString(), type: 'tool-started', itemId: block.id, toolName: block.name });
        } else if (message.type === 'user' && block.type === 'tool_result' && typeof block.tool_use_id === 'string'
          && observedTools.has(block.tool_use_id) && !completedTools.has(block.tool_use_id)) {
          completedTools.add(block.tool_use_id);
          turn.onActivity?.({ at: new Date().toISOString(), type: 'tool-completed', itemId: block.tool_use_id,
            toolName: observedTools.get(block.tool_use_id)!, status: block.is_error === true ? 'failed' : 'completed' });
        }
      }
    };
    const pendingInputs = new Map<string, { done: ReturnType<typeof deferred<SteerResult>>; content: JsonObject[] }>();
    const cancellations = new Map<string, ReturnType<typeof deferred<JsonObject>>>();
    const withdrawing = new Map<string, Promise<SteerResult>>();
    const cancelInputOnce = async (id: string): Promise<SteerResult> => {
      const requestId = `cancel-${id}`;
      const response = deferred<JsonObject>(); cancellations.set(requestId, response);
      const timer = setTimeout(() => response.reject(new Error('取消补充确认超时。')), 1000);
      try {
        transport.write({ type: 'control_request', request_id: requestId, request: { subtype: 'cancel_async_message', message_uuid: id } });
        const value = await response.promise;
        return value.cancelled === true ? { status: 'queued', reason: '原生接收点尚未消费；已确认撤回，未自动排队。' }
          : { status: 'uncertain', reason: 'Claude 补充可能已消费；未确认归属当前轮，不能重发。' };
      } catch { return { status: 'uncertain', reason: 'Claude 补充确认失败；可能已接收，不能重发。' }; }
      finally { clearTimeout(timer); cancellations.delete(requestId); }
    };
    const cancelInput = (id: string): Promise<SteerResult> => {
      let pending = withdrawing.get(id);
      if (!pending) { pending = cancelInputOnce(id); withdrawing.set(id, pending); }
      return pending;
    };
    const recordNativeId = (value: unknown) => {
      if (typeof value === 'string' && value && value !== nativeId) {
        nativeId = value;
        turn.onNativeId?.(value);
      }
    };
    const removeFailure = transport.onFailure((error) => {
      completed.reject(error);
      for (const value of pendingInputs.values()) value.done.resolve({ status: 'uncertain', reason: 'Claude 连接断开，补充可能已消费；未重发。' });
      for (const value of cancellations.values()) value.reject(error);
    });
    const removeMessage = transport.onMessage((message) => {
      observeContent(message);
      if (message.type === 'system' && message.subtype === 'init') {
        // Persist the session before the first potentially long model/tool call.
        initialized = true;
        const prior = nativeId;
        recordNativeId(message.session_id);
        if (nativeId && prior === nativeId) turn.onNativeId?.(nativeId);
        if (typeof message.model === 'string' && message.model) turn.onModel?.(message.model);
        // 2.1.76 verified: stdin prompts enter the current SDK loop at tool boundaries,
        // replay UUID is emitted when consumed; cancel_async_message removes unconsumed input.
        const version = typeof message.claude_code_version === 'string' ? message.claude_code_version.match(/^2\.(\d+)\.(\d+)/) : null;
        liveSupported = !!version && (Number(version[1]) > 1 || Number(version[1]) === 1 && Number(version[2]) >= 76);
        if (inputSent && turn.acceptSupplements) turn.onReady?.();
      } else if (message.type === 'control_response' && isObject(message.response)) {
        const response = message.response;
        const request = typeof response.request_id === 'string' ? cancellations.get(response.request_id) : undefined;
        if (response.subtype === 'success' && isObject(response.response)) request?.resolve(response.response);
        else request?.reject(new Error('Claude 未确认撤回补充。'));
      } else if (message.type === 'user' && message.isReplay === true && typeof message.uuid === 'string') {
        const pending = pendingInputs.get(message.uuid);
        if (pending) pending.done.resolve(!resultSeen && message.session_id === nativeId && message.parent_tool_use_id == null
          && isObject(message.message) && message.message.role === 'user' && JSON.stringify(message.message.content) === JSON.stringify(pending.content)
          ? { status: 'accepted' } : { status: 'uncertain', reason: 'Claude 回显未确认同一当前轮和输入；不能重发。' });
      } else if (message.type === 'assistant' && !message.parent_tool_use_id && isObject(message.message)) {
        // The assistant envelope can resolve an init alias to the provider's actual model ID.
        if (typeof message.message.model === 'string' && message.message.model) turn.onModel?.(message.message.model);
      } else if (message.type === 'stream_event' && !message.parent_tool_use_id && isObject(message.event)) {
        const event = message.event;
        if (event.type === 'content_block_start' && isObject(event.content_block)
          && (event.content_block.type === 'thinking' || event.content_block.type === 'text')) {
          const key = `${event.index}:${event.content_block.type}`;
          // Block indexes are local to an assistant message, reset by message_start.
          if (!observedBlocks.has(key)) {
            observedBlocks.add(key);
            turn.onActivity?.({ at: new Date().toISOString(), type: event.content_block.type === 'thinking' ? 'reasoning' : 'message' });
          }
        } else if (event.type === 'message_start') observedBlocks.clear();
        if (event.type === 'content_block_delta' && isObject(event.delta) && event.delta.type === 'text_delta' && typeof event.delta.text === 'string') {
          turn.onProgress(event.delta.text);
        }
      } else if (message.type === 'result') {
        resultSeen = true;
        for (const [id, pending] of pendingInputs) if (!pending.done.settled) void cancelInput(id).then(value => pending.done.resolve(value));
        recordNativeId(message.session_id);
        if (cancelled) { completed.reject(abortError()); return; }
        if (message.is_error === true || message.subtype !== 'success') {
          const errors = Array.isArray(message.errors) ? message.errors.filter((value): value is string => typeof value === 'string').join('; ') : null;
          completed.reject(new Error(`Claude 执行失败：${safeError(errors || message.result, typeof message.subtype === 'string' ? message.subtype : 'Agent 错误')}`));
        } else if (!nativeId) completed.reject(new Error('Claude 没有返回会话标识。'));
        else completed.resolve({ nativeId, text: typeof message.result === 'string' && message.result.trim() ? message.result : '任务已完成。' });
      }
    });
    const cancel = (): Promise<void> => {
      if (cancelling) return cancelling;
      cancelled = true;
      completed.reject(abortError());
      cancelling = transport.stop(false);
      return cancelling;
    };
    if (turn.acceptSupplements) this.supplements.set(conversationId, async message => {
      if (cancelled || resultSeen || completed.settled || !nativeId) return { status: 'queued' };
      if (!liveSupported) return { status: 'queued', unsupported: true, reason: '此 Claude CLI 未确认运行中输入协议；未发送，可明确使用 delivery=next。' };
      const content: JsonObject[] = [];
      try {
        for (const value of message.input) {
          if (value.type === 'text') content.push(value);
          else { const bytes = await readFile(value.path); content.push({ type: 'image', source: { type: 'base64', media_type: imageMediaType(bytes), data: bytes.toString('base64') } }); }
        }
      } catch { return { status: 'queued', reason: '补充图片读取或格式检查失败；未发送。' }; }
      if (cancelled || resultSeen || completed.settled) return { status: 'queued' };
      const done = deferred<SteerResult>(); pendingInputs.set(message.id, { done, content });
      try {
        transport.write({ type: 'user', session_id: nativeId, parent_tool_use_id: null, uuid: message.id, priority: 'next', message: { role: 'user', content } });
        return await done.promise;
      } catch { return { status: 'uncertain', reason: 'Claude 补充写入失败；不能确认是否已接收。' }; }
      finally { pendingInputs.delete(message.id); }
    });
    this.active.set(conversationId, cancel);
    const onAbort = () => { void cancel().catch(() => {}); };
    turn.signal.addEventListener('abort', onAbort, { once: true });
    let success = false;
    try {
      if (turn.signal.aborted) { await cancel(); throw abortError(); }
      transport.write({ type: 'user', session_id: nativeId ?? '', parent_tool_use_id: null, message: { role: 'user', content } });
      inputSent = true;
      if (initialized && turn.acceptSupplements) turn.onReady?.();
      if (!turn.acceptSupplements) transport.endInput();
      const result = await completed.promise;
      success = true;
      return result;
    } catch (error) {
      if (cancelled) throw abortError();
      throw error;
    } finally {
      turn.signal.removeEventListener('abort', onAbort);
      if (success) await Promise.all([...pendingInputs.values()].map(value => value.done.promise));
      if (cancelling) await cancelling;
      else await transport.stop(success);
      removeMessage(); removeFailure();
      for (const value of pendingInputs.values()) value.done.resolve({ status: 'uncertain', reason: 'Claude 轮次已关闭，补充接收未确认；不能重发。' });
      this.supplements.delete(conversationId);
      this.active.delete(conversationId);
    }
  }

  async steer(conversationId: string, message: AgentSupplement): Promise<SteerResult> {
    return this.supplements.get(conversationId)?.(message) ?? { status: 'queued', unsupported: true, reason: '此 Claude 会话未启用运行中输入。' };
  }
  async interrupt(conversationId: string): Promise<void> { await this.active.get(conversationId)?.(); }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.all([...this.active.values()].map((cancel) => cancel()).concat([...this.metadataProcesses].map(process => process.stop(false))));
  }
}
