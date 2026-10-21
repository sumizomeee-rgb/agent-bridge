import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { AgentCommand, AgentResult } from '../types.js';

export type JsonObject = Record<string, unknown>;
export const isObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export function abortError(): Error {
  const error = new Error('任务已取消。');
  error.name = 'AbortError';
  return error;
}

export function safeError(value: unknown, fallback: string): string {
  const message = typeof value === 'string' ? value : fallback;
  return message
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\b(?:sk|sk-ant)-[A-Za-z0-9_-]+/g, '[redacted]')
    .replace(/((?:api[_-]?key|access[_-]?token|authorization)\s*[=:]\s*)\S+/gi, '$1[redacted]')
    .slice(0, 1500);
}

export function deferred<T>() {
  let settled = false;
  let accept!: (value: T) => void;
  let decline!: (reason: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => { accept = resolve; decline = reject; });
  // A process may fail while the adapter is still awaiting initialization.
  // Mark it handled now; callers still receive the original rejection.
  void promise.catch(() => {});
  return {
    promise,
    get settled() { return settled; },
    resolve(value: T) { if (!settled) { settled = true; accept(value); } },
    reject(reason: unknown) { if (!settled) { settled = true; decline(reason); } },
  };
}

async function within(promise: Promise<unknown>, milliseconds: number): Promise<boolean> {
  let timeout!: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise<boolean>((resolve) => { timeout = setTimeout(() => resolve(false), milliseconds); }),
    ]);
  } finally { clearTimeout(timeout); }
}

export class AgentProcessStopError extends Error {
  readonly processStillRunning = true;
  constructor(readonly pid: number | undefined, readonly nativeResult?: AgentResult, options?: ErrorOptions) {
    super('【桥】CLI 退出待核对。', options);
    this.name = 'AgentProcessStopError';
  }
}

/** A completed native turn stays available even when transport shutdown fails. */
export function completedResultFromError(error: unknown): AgentResult | undefined {
  if (!isObject(error) || !isObject(error.nativeResult)) return undefined;
  const result = error.nativeResult;
  return typeof result.nativeId === 'string' && result.nativeId.length > 0 && typeof result.text === 'string'
    ? { nativeId: result.nativeId, text: result.text, ...(result.controlledOutput === true ? { controlledOutput: true } : {}) } : undefined;
}

export function processStopFailure(error: unknown, result = completedResultFromError(error)): AgentProcessStopError {
  return new AgentProcessStopError(isObject(error) && typeof error.pid === 'number' ? error.pid : undefined, result, { cause: error });
}

/** Newline-delimited JSON transport. Never log raw stdout or stderr. */
export class JsonLineProcess {
  readonly child: ChildProcessWithoutNullStreams;
  private readonly messages = new Set<(message: JsonObject) => void>();
  private readonly failures = new Set<(error: Error) => void>();
  private readonly closed = deferred<void>();
  private failure: Error | null = null;
  private buffer = '';
  private stopping: Promise<void> | null = null;

  constructor(command: AgentCommand, extraArgs: string[], cwd: string, env: NodeJS.ProcessEnv) {
    this.child = spawn(command.command, [...command.args, ...extraArgs], {
      cwd, env: { ...process.env, ...env }, shell: false, windowsHide: true,
      detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => this.consume(chunk));
    this.child.stdout.on('end', () => {
      if (this.buffer.trim()) this.parse(this.buffer);
      this.buffer = '';
    });
    // Drain diagnostic output without retaining prompts, secrets, or tool output.
    this.child.stderr.on('data', () => {});
    this.child.on('error', (error) => this.fail(new Error(`无法启动 Agent 进程：${safeError(error.message, '启动失败')}`)));
    this.child.stdin.on('error', () => this.fail(new Error('Agent 输入连接已断开。')));
    this.child.stdout.on('error', () => this.fail(new Error('Agent 输出连接已断开。')));
    this.child.on('close', (code, signal) => {
      this.closed.resolve();
      this.fail(new Error(`Agent 进程已断开（退出码 ${code ?? '无'}，信号 ${signal ?? '无'}）。`));
    });
  }

  onMessage(listener: (message: JsonObject) => void): () => void {
    this.messages.add(listener);
    return () => this.messages.delete(listener);
  }

  onFailure(listener: (error: Error) => void): () => void {
    this.failures.add(listener);
    if (this.failure) {
      const error = this.failure;
      queueMicrotask(() => { if (this.failures.has(listener)) listener(error); });
    }
    return () => this.failures.delete(listener);
  }

  write(message: JsonObject): void {
    if (this.failure) throw this.failure;
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  endInput(): void { this.child.stdin.end(); }

  private consume(chunk: string): void {
    this.buffer += chunk;
    // Bound a single message, not the duration of a legitimate long turn.
    if (this.buffer.length > 16 * 1024 * 1024 && !this.buffer.includes('\n')) {
      this.fail(new Error('Agent 单条输出超过限制。'));
      return;
    }
    let newline: number;
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (line.trim()) this.parse(line);
    }
  }

  private parse(line: string): void {
    if (line.length > 16 * 1024 * 1024) { this.fail(new Error('Agent 单条输出超过限制。')); return; }
    let message: unknown;
    try { message = JSON.parse(line); }
    catch { this.fail(new Error('Agent 输出不是有效 JSON。')); return; }
    if (!isObject(message)) { this.fail(new Error('Agent 输出格式不正确。')); return; }
    for (const listener of this.messages) {
      try { listener(message); }
      catch (error) { this.fail(error instanceof Error ? error : new Error('处理 Agent 输出失败。')); }
    }
  }

  private fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    for (const listener of this.failures) listener(error);
  }

  /** EOF is graceful after success; cancellation forcefully stops the process tree. */
  stop(graceful = false): Promise<void> {
    if (this.closed.settled) return Promise.resolve();
    this.stopping ??= this.stopOnce(graceful);
    return this.stopping;
  }

  private async stopOnce(graceful: boolean): Promise<void> {
    if (this.closed.settled) return;
    if (graceful) {
      this.endInput();
      if (await within(this.closed.promise, 1000)) return;
    }
    const pid = this.child.pid;
    if (pid && process.platform === 'win32') {
      const killer = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
        shell: false, windowsHide: true, stdio: 'ignore',
      });
      const killed = new Promise<void>((resolve) => {
        killer.once('close', () => resolve());
        killer.once('error', () => resolve());
      });
      if (!(await within(killed, 2000))) killer.kill();
      if (!this.closed.settled) this.child.kill('SIGKILL');
    } else if (pid) {
      try { process.kill(-pid, 'SIGTERM'); }
      catch { this.child.kill('SIGTERM'); }
      if (!(await within(this.closed.promise, 1000))) {
        try { process.kill(-pid, 'SIGKILL'); }
        catch { this.child.kill('SIGKILL'); }
      }
    } else this.child.kill();
    if (!(await within(this.closed.promise, 1000))) throw new AgentProcessStopError(pid);
  }
}

/** 保留明确的 RPC 拒绝，与超时、断线及损坏响应区分。 */
export class JsonRpcError extends Error {
  constructor(readonly code: number | null, message: string) { super(message); }
}

export type RpcTransport = Pick<JsonLineProcess, 'onMessage' | 'onFailure' | 'write' | 'stop'>;

export class JsonRpcClient {
  private nextId = 1;
  private readonly pending = new Map<number, {
    resolve: (value: JsonObject) => void; reject: (reason: unknown) => void;
    timeout: ReturnType<typeof setTimeout>;
  }>();
  private readonly removeMessage: () => void;
  private readonly removeFailure: () => void;

  constructor(readonly transport: RpcTransport) {
    this.removeMessage = transport.onMessage((message) => {
      if (typeof message.id !== 'number' || typeof message.method === 'string') return;
      const request = this.pending.get(message.id);
      if (!request) return;
      this.pending.delete(message.id);
      clearTimeout(request.timeout);
      if (isObject(message.error)) request.reject(new JsonRpcError(typeof message.error.code === 'number' ? message.error.code : null, `Codex 请求失败：${safeError(message.error.message, '协议错误')}`));
      else if (isObject(message.result)) request.resolve(message.result);
      else request.reject(new Error('Codex 返回了无效的请求结果。'));
    });
    this.removeFailure = transport.onFailure((error) => this.rejectAll(error));
  }

  request(method: string, params: JsonObject, timeoutMs = 60_000): Promise<JsonObject> {
    const id = this.nextId++;
    return new Promise<JsonObject>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex ${method} 等待响应超时。`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timeout });
      try { this.transport.write({ id, method, params }); }
      catch (error) { clearTimeout(timeout); this.pending.delete(id); reject(error); }
    });
  }

  notify(method: string, params: JsonObject = {}): void { this.transport.write({ method, params }); }

  close(): void {
    this.removeMessage(); this.removeFailure();
    this.rejectAll(new Error('Codex 连接已关闭。'));
  }

  private rejectAll(error: Error): void {
    for (const request of this.pending.values()) { clearTimeout(request.timeout); request.reject(error); }
    this.pending.clear();
  }
}
