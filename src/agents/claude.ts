import { readFile } from 'node:fs/promises';
import type { AgentAdapter, AgentCommand, AgentResult, AgentTurn } from '../types.js';
import { abortError, deferred, isObject, JsonLineProcess, safeError, type JsonObject } from './process.js';

function imageMediaType(bytes: Buffer): string {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'))) return 'image/gif';
  if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  throw new Error('Claude 支持 PNG、JPEG、GIF 和 WebP 图片；该附件格式无法识别。');
}

/** Claude CLI structured streaming input; prompts never pass through a shell. */
export class ClaudeAdapter implements AgentAdapter {
  private readonly active = new Map<string, () => Promise<void>>();
  private closed = false;

  constructor(private readonly command: AgentCommand, private readonly env: NodeJS.ProcessEnv) {}

  async run(turn: AgentTurn): Promise<AgentResult> {
    if (this.closed) throw new Error('Claude 适配器已关闭。');
    if (turn.signal.aborted) throw abortError();
    const conversationId = turn.conversation.id;
    if (this.active.has(conversationId)) throw new Error('该 Claude 会话仍在执行任务。');
    const content: JsonObject[] = [];
    if (turn.text) content.push({ type: 'text', text: turn.text });
    for (const path of turn.imagePaths) {
      const bytes = await readFile(path);
      content.push({ type: 'image', source: { type: 'base64', media_type: imageMediaType(bytes), data: bytes.toString('base64') } });
    }
    if (!content.length) throw new Error('消息没有文字或图片。');
    if (turn.signal.aborted) throw abortError();
    if (this.closed) throw new Error('Claude 适配器已关闭。');
    if (this.active.has(conversationId)) throw new Error('该 Claude 会话仍在执行任务。');

    const args = ['--print', '--input-format', 'stream-json', '--output-format', 'stream-json',
      '--verbose', '--include-partial-messages', '--dangerously-skip-permissions'];
    if (turn.conversation.nativeId) args.push('--resume', turn.conversation.nativeId);
    const transport = new JsonLineProcess(this.command, args, turn.conversation.cwd, this.env);
    const completed = deferred<AgentResult>();
    let nativeId = turn.conversation.nativeId;
    let cancelled = false;
    let cancelling: Promise<void> | null = null;
    const recordNativeId = (value: unknown) => {
      if (typeof value === 'string' && value && value !== nativeId) {
        nativeId = value;
        turn.onNativeId?.(value);
      }
    };
    const removeFailure = transport.onFailure((error) => completed.reject(error));
    const removeMessage = transport.onMessage((message) => {
      if (message.type === 'system' && message.subtype === 'init') {
        // Persist the session before the first potentially long model/tool call.
        const prior = nativeId;
        recordNativeId(message.session_id);
        if (nativeId && prior === nativeId) turn.onNativeId?.(nativeId);
      } else if (message.type === 'stream_event' && !message.parent_tool_use_id && isObject(message.event)) {
        const event = message.event;
        if (event.type === 'content_block_delta' && isObject(event.delta) && event.delta.type === 'text_delta' && typeof event.delta.text === 'string') {
          turn.onProgress(event.delta.text);
        }
      } else if (message.type === 'result') {
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
    this.active.set(conversationId, cancel);
    const onAbort = () => { void cancel().catch(() => {}); };
    turn.signal.addEventListener('abort', onAbort, { once: true });
    let success = false;
    try {
      if (turn.signal.aborted) { await cancel(); throw abortError(); }
      transport.write({ type: 'user', session_id: nativeId ?? '', parent_tool_use_id: null, message: { role: 'user', content } });
      transport.endInput();
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
      removeMessage(); removeFailure();
      this.active.delete(conversationId);
    }
  }

  async interrupt(conversationId: string): Promise<void> { await this.active.get(conversationId)?.(); }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.all([...this.active.values()].map((cancel) => cancel()));
  }
}
