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

export interface AgentStopEvidence {
  pid?: number;
  graceful: boolean;
  exitObserved: boolean;
  exitCode: number | null;
  signalCode: string | null;
  closeObserved: boolean;
  taskkillAttempted: boolean;
  taskkillExitCode: number | null;
  durationMs: number;
  phaseMs: Partial<Record<'gracefulWait' | 'treeKill' | 'exitWait' | 'stdioDrain', number>>;
  completion: 'pending' | 'graceful-exit' | 'tree-stop' | 'transport-closed' | 'not-started' | 'unconfirmed';
}

/** Copy only diagnostic metadata, never commands, environment or output. */
export function stopEvidenceFromError(error: unknown): AgentStopEvidence | undefined {
  if (!isObject(error) || !isObject(error.stopEvidence)) return undefined;
  const value = error.stopEvidence;
  const number = (candidate: unknown) => typeof candidate === 'number' && Number.isFinite(candidate) && candidate >= 0;
  const code = (candidate: unknown) => candidate === null || typeof candidate === 'number' && Number.isInteger(candidate);
  if (typeof value.graceful !== 'boolean' || typeof value.exitObserved !== 'boolean' || typeof value.closeObserved !== 'boolean'
    || typeof value.taskkillAttempted !== 'boolean' || !number(value.durationMs)
    || !code(value.exitCode) || !code(value.taskkillExitCode)
    || !(value.signalCode === null || typeof value.signalCode === 'string')
    || !['pending', 'graceful-exit', 'tree-stop', 'transport-closed', 'not-started', 'unconfirmed'].includes(String(value.completion))) return undefined;
  const phaseMs: AgentStopEvidence['phaseMs'] = {};
  for (const key of ['gracefulWait', 'treeKill', 'exitWait', 'stdioDrain'] as const) {
    if (isObject(value.phaseMs) && number(value.phaseMs[key])) phaseMs[key] = value.phaseMs[key] as number;
  }
  return { ...(number(value.pid) && Number.isInteger(value.pid) && Number(value.pid) > 0 ? { pid: value.pid as number } : {}),
    graceful: value.graceful, exitObserved: value.exitObserved, exitCode: value.exitCode as number | null,
    signalCode: value.signalCode as string | null, closeObserved: value.closeObserved, taskkillAttempted: value.taskkillAttempted,
    taskkillExitCode: value.taskkillExitCode as number | null, durationMs: value.durationMs as number, phaseMs,
    completion: value.completion as AgentStopEvidence['completion'] };
}

export class AgentProcessStopError extends Error {
  readonly processStillRunning = true;
  constructor(readonly pid: number | undefined, readonly nativeResult?: AgentResult, options?: ErrorOptions, readonly stopEvidence?: AgentStopEvidence) {
    super('【桥】CLI 退出待核对。', options);
    this.name = 'AgentProcessStopError';
  }
}

/** A completed native turn stays available even when transport shutdown fails. */
export function completedResultFromError(error: unknown): AgentResult | undefined {
  if (!isObject(error) || !isObject(error.nativeResult)) return undefined;
  const result = error.nativeResult;
  return typeof result.nativeId === 'string' && result.nativeId.length > 0 && typeof result.text === 'string'
    ? { nativeId: result.nativeId, text: result.text, ...(result.controlledOutput === true ? { controlledOutput: true } : {}),
      ...(typeof result.processStopped === 'boolean' ? { processStopped: result.processStopped } : {}),
      ...(stopEvidenceFromError(result) ? { stopEvidence: stopEvidenceFromError(result) } : {}) } : undefined;
}

export function processStopFailure(error: unknown, result = completedResultFromError(error)): AgentProcessStopError {
  return new AgentProcessStopError(isObject(error) && typeof error.pid === 'number' ? error.pid : undefined, result, { cause: error }, stopEvidenceFromError(error));
}

/** 原生成功回执与 CLI 收尾独立；失败只保留诊断，退出证明前仍由适配器持有会话。 */
export function retireCompletedTurn(transport: Pick<JsonLineProcess, 'stop'> & Partial<Pick<JsonLineProcess, 'stopEvidence'>>,
  result: AgentResult, stopped: () => void): void {
  result.processStopped = false;
  void (async () => {
    try { await transport.stop(true); result.processStopped = true; stopped(); }
    catch (error) { result.cleanupError = safeError(error instanceof Error ? error.message : error, 'CLI 收尾未确认'); }
    finally { if (transport.stopEvidence) result.stopEvidence = transport.stopEvidence; }
  })();
  if (transport.stopEvidence) result.stopEvidence = transport.stopEvidence;
}

/** Newline-delimited JSON transport. Never log raw stdout or stderr. */
export class JsonLineProcess {
  readonly child: ChildProcessWithoutNullStreams;
  private readonly messages = new Set<(message: JsonObject) => void>();
  private readonly failures = new Set<(error: Error) => void>();
  private readonly closed = deferred<void>();
  private failure: Error | null = null;
  private buffer = '';
  private gracefulStop: Promise<void> | null = null;
  private forcedStop: Promise<void> | null = null;
  private readonly exited = deferred<void>();
  private readonly escalation = deferred<void>();
  private readonly stoppedListeners = new Set<() => void>();
  private forceRequested = false;
  private retryableStop = false;
  private gracefulRetirement = false;
  private protocolRetired = false;
  private treeKillSucceeded = false;
  private stopStarted: number | null = null;
  private lastGraceful = false;
  private taskkillAttempted = false;
  private taskkillExitCode: number | null = null;
  private readonly phaseMs: AgentStopEvidence['phaseMs'] = {};
  private completion: AgentStopEvidence['completion'] = 'pending';
  private stopConfirmed = false;

  constructor(command: AgentCommand, extraArgs: string[], cwd: string, env: NodeJS.ProcessEnv,
    private readonly stopHelper?: (script: string) => ChildProcessWithoutNullStreams) {
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
    this.child.on('exit', (code, signal) => {
      this.exited.resolve();
      // A descendant may still own stdout/stderr after the actual CLI exits.
      const timer = setTimeout(() => {
        if (this.gracefulRetirement && !this.forceRequested) this.establishStop('graceful-exit');
        else if (!this.closed.settled) this.fail(new Error(`Agent 进程已断开（退出码 ${code ?? '无'}，信号 ${signal ?? '无'}）。`));
      }, 100);
      timer.unref();
    });
    this.child.on('close', (code, signal) => {
      this.closed.resolve();
      this.confirmStopped();
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
    if (this.protocolRetired) return;
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

  get stopEvidence(): AgentStopEvidence {
    return { ...(this.child.pid ? { pid: this.child.pid } : {}), graceful: this.lastGraceful,
      exitObserved: this.exited.settled, exitCode: this.child.exitCode, signalCode: this.child.signalCode,
      closeObserved: this.closed.settled, taskkillAttempted: this.taskkillAttempted, taskkillExitCode: this.taskkillExitCode,
      durationMs: this.stopStarted === null ? 0 : Math.round(performance.now() - this.stopStarted),
      phaseMs: { ...this.phaseMs }, completion: this.completion };
  }

  /** CLI transport retirement is distinct from a successful explicit tree cancellation. */
  confirmStopped(): boolean {
    if (!this.stopConfirmed) {
      if (this.exited.settled && this.treeKillSucceeded) this.establishStop('tree-stop');
      else if (this.exited.settled && this.gracefulRetirement && !this.forceRequested) this.establishStop('graceful-exit');
      else if (this.closed.settled && !this.child.pid) this.establishStop('not-started');
    }
    return this.stopConfirmed;
  }

  onStopped(listener: () => void): () => void {
    const stopped = this.confirmStopped(); this.stoppedListeners.add(listener);
    if (stopped) queueMicrotask(() => { if (this.stoppedListeners.has(listener)) listener(); });
    return () => { this.stoppedListeners.delete(listener); };
  }

  private retireStdio(): void {
    this.protocolRetired = true; this.buffer = '';
    // Keep draining inherited writers: destroying the readers can crash a business
    // background process with EPIPE. Unref only the bridge's handles.
    for (const stream of [this.child.stdout, this.child.stderr, this.child.stdin]) {
      (stream as typeof stream & { unref?: () => void }).unref?.();
    }
  }

  private establishStop(completion: AgentStopEvidence['completion']): void {
    if (this.stopConfirmed) return;
    this.completion = completion; this.stopConfirmed = true; this.retireStdio();
    for (const listener of this.stoppedListeners) listener();
    this.stoppedListeners.clear();
  }

  /** 只允许重试尚未授权 taskkill 的失败；已尝试的取消仍需真实停止凭据。 */
  canRetryStop(): boolean { return this.retryableStop && !this.exited.settled && !this.stopConfirmed; }

  private requestForcedStop(): Promise<void> {
    if (this.canRetryStop()) { this.forcedStop = null; this.retryableStop = false; }
    if (!this.forcedStop) {
      const operation = this.stopForced(); this.forcedStop = operation;
      void operation.catch(() => {
        // stopWindowsTree 返回前已关闭授权窗口，迟到的旧 helper 只能收到 SKIP。
        this.retryableStop = process.platform === 'win32' && !this.taskkillAttempted && !this.exited.settled;
      });
    }
    return this.forcedStop;
  }

  /** Only completed turns use graceful retirement; explicit cancellation may escalate it once. */
  stop(graceful = false): Promise<void> {
    if (this.confirmStopped()) return Promise.resolve();
    this.stopStarted ??= performance.now();
    if (!graceful) {
      this.lastGraceful = false; this.forceRequested = true; this.gracefulRetirement = false; this.escalation.resolve();
      return this.requestForcedStop();
    }
    if (this.forceRequested) return this.requestForcedStop();
    this.lastGraceful = true; this.gracefulRetirement = true;
    return this.gracefulStop ??= this.stopGraceful();
  }

  private unknownStop(): AgentProcessStopError {
    this.completion = 'unconfirmed';
    return new AgentProcessStopError(this.child.pid, undefined, undefined, this.stopEvidence);
  }

  private async drainAfterExit(completion: 'graceful-exit' | 'tree-stop'): Promise<void> {
    const started = performance.now(); await within(this.closed.promise, 100);
    this.phaseMs.stdioDrain = Math.round(performance.now() - started);
    if (completion === 'graceful-exit' && this.forceRequested) { await this.forcedStop; return; }
    this.establishStop(completion);
  }

  private async stopGraceful(): Promise<void> {
    if (!this.exited.settled && !this.child.stdin.destroyed) this.endInput();
    const started = performance.now();
    await within(Promise.race([this.exited.promise, this.escalation.promise]), 5000);
    this.phaseMs.gracefulWait = Math.round(performance.now() - started);
    if (this.forceRequested) { await this.forcedStop; return; }
    if (!this.exited.settled) throw this.unknownStop();
    await this.drainAfterExit('graceful-exit');
  }

  private async stopWindowsTree(pid: number): Promise<void> {
    // READY/STOP pins the original process object before authorizing a PID-based
    // operation. Our original ChildProcess handle is still alive until exit, so
    // a READY accepted before that event cannot refer to a reused PID. The helper
    // holds its own handle until taskkill has finished, keeping that PID reserved.
    const script = `$ErrorActionPreference='Stop';$targetProcess=$null;$treeKiller=$null
try {
  $targetProcess=[Diagnostics.Process]::GetProcessById(${pid});$null=$targetProcess.Handle
  [Console]::Out.WriteLine('READY')
  if([Console]::ReadLine() -ne 'STOP' -or $targetProcess.HasExited){[Console]::Out.WriteLine('SKIP');exit}
  $info=New-Object Diagnostics.ProcessStartInfo
  $info.FileName=[IO.Path]::Combine([Environment]::GetFolderPath('System'),'taskkill.exe')
  $info.Arguments='/PID ${pid} /T /F';$info.UseShellExecute=$false;$info.CreateNoWindow=$true
  $info.RedirectStandardOutput=$true;$info.RedirectStandardError=$true
  [Console]::Out.WriteLine('ATTEMPT')
  $treeKiller=[Diagnostics.Process]::Start($info)
  $treeKiller.BeginOutputReadLine();$treeKiller.BeginErrorReadLine()
  if(-not $treeKiller.WaitForExit(10000)){$treeKiller.Kill();$treeKiller.WaitForExit()}
  [Console]::Out.WriteLine('EXIT:'+[string]$treeKiller.ExitCode)
} catch {[Console]::Out.WriteLine('FAILED')}
finally {if($treeKiller){$treeKiller.Dispose()};if($targetProcess){$targetProcess.Dispose()}}`;
    const helper = this.stopHelper?.(script) ?? spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const finished = deferred<void>(); let buffer = '', permissionOpen = true, authorized = false;
    helper.stdin.on('error', () => {}); helper.stderr.on('data', () => {});
    helper.stdout.setEncoding('utf8');
    helper.stdout.on('data', (part: string) => {
      buffer += part;
      let at: number;
      while ((at = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, at).trim(); buffer = buffer.slice(at + 1);
        if (line === 'READY') {
          authorized = permissionOpen && !this.exited.settled;
          helper.stdin.end(authorized ? 'STOP\n' : 'SKIP\n');
        } else if (line === 'ATTEMPT' && authorized) this.taskkillAttempted = true;
        else if (authorized && /^EXIT:-?\d+$/.test(line)) {
          this.taskkillExitCode = Number(line.slice(5)); this.treeKillSucceeded = this.taskkillAttempted && this.taskkillExitCode === 0;
          this.confirmStopped();
        }
      }
      if (buffer.length > 128) buffer = '';
    });
    helper.once('error', () => finished.resolve()); helper.once('close', () => finished.resolve());
    if (!(await within(finished.promise, 30_000))) {
      permissionOpen = false; helper.stdin.end();
      // Do not kill the holder while its taskkill might still be running: that
      // would release the PID reservation. Its own taskkill wait is bounded.
      helper.unref();
      for (const stream of [helper.stdin, helper.stdout, helper.stderr]) (stream as typeof helper.stdout & { unref?: () => void }).unref?.();
    }
    permissionOpen = false;
  }

  private async stopForced(): Promise<void> {
    const pid = this.child.pid;
    if (!pid) {
      if (await within(this.closed.promise, 1000)) { this.establishStop('not-started'); return; }
      throw this.unknownStop();
    }
    // Never issue a new PID-based tree kill after the original root has exited.
    if (this.exited.settled) throw this.unknownStop();
    const started = performance.now();
    if (process.platform === 'win32') await this.stopWindowsTree(pid);
    else {
      try { process.kill(-pid, 'SIGTERM'); } catch {}
      await within(this.exited.promise, 1000);
      const groupGone = () => {
        try { process.kill(-pid, 0); return false; }
        catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
      };
      this.treeKillSucceeded = groupGone();
      if (!this.treeKillSucceeded && !this.exited.settled) {
        try { process.kill(-pid, 'SIGKILL'); } catch {}
        for (let check = 0; check < 20 && !this.treeKillSucceeded; check++) {
          await new Promise<void>(resolve => setTimeout(resolve, 50)); this.treeKillSucceeded = groupGone();
        }
      }
      // If the root disappeared but a group still exists, do not signal a
      // potentially reused group ID or call a root-only exit a successful stop.
    }
    this.phaseMs.treeKill = Math.round(performance.now() - started);
    const exitStarted = performance.now(); await within(this.exited.promise, 1000);
    this.phaseMs.exitWait = Math.round(performance.now() - exitStarted);
    if (!this.treeKillSucceeded || !this.exited.settled) throw this.unknownStop();
    await this.drainAfterExit('tree-stop');
  }
}

/** 保留明确的 RPC 拒绝，与超时、断线及损坏响应区分。 */
export class JsonRpcError extends Error {
  constructor(readonly code: number | null, message: string) { super(message); }
}

export type RpcTransport = Pick<JsonLineProcess, 'onMessage' | 'onFailure' | 'write' | 'stop'> & Partial<Pick<JsonLineProcess, 'confirmStopped' | 'canRetryStop'>>;

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
