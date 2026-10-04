import type { AgentAdapter, AgentCommand, AgentResult, AgentTurn } from '../types.js';
import { abortError, deferred, isObject, JsonLineProcess, JsonRpcClient, safeError, type JsonObject } from './process.js';

/** App-server v2 stdio protocol, verified against Codex rust-v0.160.0. */
export class CodexAdapter implements AgentAdapter {
  private readonly active = new Map<string, () => Promise<void>>();
  private closed = false;

  constructor(private readonly command: AgentCommand, private readonly env: NodeJS.ProcessEnv) {}

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
      const thread = await rpc.request(nativeId ? 'thread/resume' : 'thread/start', {
        ...(nativeId ? { threadId: nativeId } : {}),
        cwd: turn.conversation.cwd, approvalPolicy: 'never', sandbox: 'danger-full-access',
      });
      if (!isObject(thread.thread) || typeof thread.thread.id !== 'string' || !thread.thread.id) {
        throw new Error('Codex 没有返回有效会话标识。');
      }
      nativeId = thread.thread.id;
      turn.onNativeId?.(nativeId);
      if (cancelled) throw abortError();
      const input: JsonObject[] = [];
      if (turn.text) input.push({ type: 'text', text: turn.text, text_elements: [] });
      for (const path of turn.imagePaths) input.push({ type: 'localImage', path });
      if (!input.length) throw new Error('消息没有文字或图片。');
      const started = await rpc.request('turn/start', {
        threadId: nativeId, input, cwd: turn.conversation.cwd,
        approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' },
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
    await Promise.all([...this.active.values()].map((cancel) => cancel()));
  }
}
