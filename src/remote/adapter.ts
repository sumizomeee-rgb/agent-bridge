import { normalizeEffortCapability, selectedEffort } from '../effort.js';
import { stopEvidenceFromError } from '../agents/process.js';
import { readFile, lstat, mkdir, writeFile } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { createHash } from 'node:crypto';
import type { Conversation, AgentAdapter, AgentInput, AgentModelInfo, AgentResult, AgentSupplement, AgentTurn, AgentName, BridgeConfig, SteerResult } from '../types.js';
import type { ExecutionTargetBinding, RemoteClient, RemoteDispatch, RemoteJob } from './types.js';
import { RemoteDispatchUncertain, RemoteArtifactTransferError, RemoteResultUncertain } from './types.js';
import { PresetResultUnknown } from '../presets/runtime.js';
import type { PresetBinding } from '../presets/types.js';
import { SshRemoteClient } from './client.js';
import type { NativeSessionAdoption, NativeSessionAdoptArgs, NativeSessionPage, NativeSessionQuery, NativeSessionRead, NativeSessionReadOptions, NativeSessionRef } from '../native-sessions.js';

export interface RemoteAdapterOptions { clientFactory?: (binding: ExecutionTargetBinding) => RemoteClient; pollMs?: number; reconnectDeadlineMs?: number; reconnectDelayMs?: number }
export class RemoteAgentAdapter implements AgentAdapter {
  private client: RemoteClient | null = null;
  private reconnecting: Promise<void> | null = null;
  private readonly jobs = new Map<string, { dispatchId: string; submitted: boolean; cancelled: boolean }>();
  private readonly lastDispatch = new Map<string, string>();
  private readonly imageMappings = new Map<string, string>();
  private closed = false;
  constructor(readonly binding: ExecutionTargetBinding, private readonly config: BridgeConfig, private readonly options: RemoteAdapterOptions = {}) {}
  private connection(): RemoteClient {
    if (this.closed) throw new Error('远端适配器已关闭。');
    return this.client ??= this.options.clientFactory?.(this.binding) ?? new SshRemoteClient(this.binding, this.config.contextWorkspace ?? this.config.workspace);
  }
  private async validate(allowPreparingRecovery = false, retry = true): Promise<void> {
    if (retry && this.reconnecting) await this.reconnecting;
    const client = this.connection();
    let hello: { hostname: string; version: number; engines: string[]; presetDispatch?: number; sessionVisibility?: number };
    try { hello = await client.request('hello', {}); }
    catch (error) {
      const idle = this.jobs.size === 0 || (allowPreparingRecovery && this.jobs.size === 1 && [...this.jobs.values()].every(job => !job.submitted));
      // Only a failed handshake may be retried before dispatch; probes cannot detach busy work.
      if (!retry || !idle || this.knownRejection(error)) throw error;
      await this.reconnect(client); return;
    }
    if (this.binding.sessionVisibility !== undefined && hello.sessionVisibility !== 1) throw Object.assign(new Error('目标执行器未支持会话可见性协议，未忽略参数或回退。'), { code: 'REMOTE_REJECTED' });
    if (this.binding.preset && hello.presetDispatch !== 1) throw Object.assign(new Error('目标执行器不支持预设协议，未忽略预设或回退。'), { code: 'REMOTE_REJECTED' });
    if (hello.version !== 1 || typeof hello.hostname !== 'string' || hello.hostname.toLowerCase() !== this.binding.expectedHostname!.toLowerCase()
      || !Array.isArray(hello.engines) || !hello.engines.includes(this.binding.agent)) throw Object.assign(new Error('目标电脑名称、协议版本或引擎与登记不一致。'), { code: 'REMOTE_REJECTED' });
  }
  async describePreset(profileId: string, revision: number, agent: AgentName, model: string): Promise<Pick<PresetBinding, 'profileId' | 'revision' | 'agent' | 'model' | 'fingerprint'>> {
    await this.validate(); return this.connection().request('preset/describe', { profileId, revision, agent, model });
  }
  async probeEntries(): Promise<{ cliEntries?: Record<string, 'ready' | 'unavailable'> }> {
    await this.validate(); return this.connection().request('hello', {});
  }
  async listNativeSessions(userId: string, query: Omit<NativeSessionQuery, 'userId' | 'agent'>): Promise<NativeSessionPage> {
    await this.validate(); return this.connection().request('sessions/list', { userId, agent: this.binding.agent, query });
  }
  async readNativeSession(userId: string, ref: NativeSessionRef, options?: NativeSessionReadOptions): Promise<NativeSessionRead> {
    if (ref.agent !== this.binding.agent) throw new Error('原生会话引擎与目标登记不一致。');
    await this.validate(); return this.connection().request('sessions/read', { userId, ref, options });
  }
  async adoptNativeSession(userId: string, adoption: NativeSessionAdoptArgs): Promise<NativeSessionAdoption> {
    if (adoption.ref.agent !== this.binding.agent) throw new Error('原生会话引擎与目标登记不一致。');
    await this.validate(); return this.connection().request('sessions/adopt', { userId, adoption });
  }
  private knownRejection(error: unknown): boolean {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
    return ['REMOTE_REJECTED', 'DISPATCH_NOT_FOUND', 'REMOTE_JOB_FAILED'].includes(code);
  }
  private async reconnect(failedClient = this.client): Promise<void> {
    if (this.reconnecting) return this.reconnecting;
    if (this.client !== failedClient) return this.validate(false, false);
    const work = (async () => {
      const previous = this.client; this.client = null;
      try { await previous?.close(); } catch {}
      await this.validate(false, false);
    })();
    this.reconnecting = work;
    try { await work; } finally { if (this.reconnecting === work) this.reconnecting = null; }
  }
  /** Reattachment never resubmits dispatch, even when its initial acknowledgement was lost. */
  async inspectDispatch(dispatchId: string): Promise<RemoteJob> {
    const deadline = Date.now() + (this.options.reconnectDeadlineMs ?? 300_000);
    for (;;) {
      try { return await this.connection().request<RemoteJob>('query', { dispatchId }); }
      catch (error) {
        if (this.knownRejection(error)) throw error;
        if (this.closed || Date.now() >= deadline) throw new RemoteDispatchUncertain(error instanceof Error ? error.message : undefined);
        await new Promise<void>(resolveValue => setTimeout(resolveValue, this.options.reconnectDelayMs ?? 1000));
        try { await this.reconnect(); } catch (next) { if (this.knownRejection(next)) throw next; }
      }
    }
  }
  private async retryRead<T>(method: string, args: unknown): Promise<T> {
    const deadline = Date.now() + (this.options.reconnectDeadlineMs ?? 300_000);
    for (;;) {
      try { return await this.connection().request<T>(method, args); }
      catch (error) {
        if (this.knownRejection(error) || this.closed || Date.now() >= deadline) throw error;
        await new Promise<void>(resolveValue => setTimeout(resolveValue, this.options.reconnectDelayMs ?? 1000));
        try { await this.reconnect(); } catch (next) { if (this.knownRejection(next)) throw next; }
      }
    }
  }
  private async image(path: string): Promise<string> {
    const mapped = this.imageMappings.get(path); if (mapped) return mapped;
    const info = await lstat(path); if (info.isSymbolicLink() || !info.isFile() || info.size > this.config.maxImageBytes || info.size < 1) throw new Error('当前图片不是普通文件或超过大小限制。');
    const data = await readFile(path); if (data.length !== info.size) throw new Error('读取图片时文件发生变化。');
    const sha256 = createHash('sha256').update(data).digest('hex'); let remotePath = '';
    for (let offset = 0; offset < data.length;) {
      const part = data.subarray(offset, offset + 192 * 1024);
      const result = await this.connection().request<{ path: string; offset: number; complete: boolean }>('upload', { sha256, size: data.length, filename: basename(path), offset, data: part.toString('base64') });
      if (result.offset < offset + part.length || result.offset > data.length) throw new Error('远端图片接收位置无效。');
      offset = result.offset; remotePath = result.path;
    }
    this.imageMappings.set(path, remotePath); return remotePath;
  }
  private async inputs(input: AgentInput[]): Promise<AgentInput[]> {
    const output: AgentInput[] = [];
    for (const item of input) output.push(item.type === 'text' ? item : { type: 'localImage', path: await this.image(item.path) });
    return output;
  }
  async run(turn: AgentTurn): Promise<AgentResult> {
    if (!turn.dispatchId) throw new Error('远端任务必须带持久派发编号。');
    if (this.jobs.has(turn.conversation.id)) throw new Error('此远端子会话已有执行连接。');
    const execution = { dispatchId: turn.dispatchId, submitted: turn.recovering === true, cancelled: false };
    this.jobs.set(turn.conversation.id, execution); this.lastDispatch.set(turn.conversation.id, turn.dispatchId);
    let nativeId: string | null = null; let ready = false; let model: string | undefined; let effort: string | null | undefined;
    let activitySequence = 0; let configurationKey: string | undefined;
    try {
      try { await this.validate(true); }
      catch (error) { if (!turn.recovering || this.knownRejection(error)) throw error; await this.inspectDispatch(turn.dispatchId); }
      if (!turn.recovering) {
        if (turn.signal.aborted || execution.cancelled) throw Object.assign(new Error('远端任务尚未派发，已取消。'), { name: 'AbortError' });
        const imagePaths: string[] = []; for (const path of turn.imagePaths) imagePaths.push(await this.image(path));
        const request: RemoteDispatch = { dispatchId: turn.dispatchId, workerId: turn.conversation.id, userId: turn.conversation.userId,
          ...(this.binding.preset ? { preset: this.binding.preset } : {}),
          ...(this.binding.sessionVisibility ? { sessionVisibility: this.binding.sessionVisibility } : {}),
          agent: this.binding.agent, agentCommand: this.binding.agentCommand, nativeId: turn.conversation.nativeId, cwd: this.binding.cwd,
          text: turn.text, imagePaths, model: turn.conversation.model ?? null, acceptSupplements: turn.acceptSupplements === true,
          ...(turn.effort ? { effort: turn.effort } : {}), ...(turn.input ? { input: await this.inputs(turn.input) } : {}) };
        // Once submitted, losing the response is ambiguous. Never dispatch a second prompt.
        if (turn.signal.aborted || execution.cancelled) throw Object.assign(new Error('远端任务尚未派发，已取消。'), { name: 'AbortError' });
        execution.submitted = true;
        try { await this.connection().request<RemoteJob>('dispatch', request); }
        catch (error) { if (this.knownRejection(error)) throw error; await this.inspectDispatch(turn.dispatchId); }
      }
      let effortMetadataKey: string | undefined;
      for (;;) {
        if (turn.signal.aborted) { await this.interrupt(turn.conversation.id); throw Object.assign(new Error('远端任务已停止。'), { name: 'AbortError' }); }
        const job = await this.inspectDispatch(turn.dispatchId);
        if (job.dispatchId !== turn.dispatchId || job.workerId !== turn.conversation.id) throw new RemoteDispatchUncertain('远端回执的任务归属不一致。');
        if (job.nativeId && nativeId !== job.nativeId) { nativeId = job.nativeId; turn.onNativeId?.(job.nativeId); }
        if (job.actualModel && model !== job.actualModel) { model = job.actualModel; turn.onModel?.(model); }
        if (job.actualEffort !== undefined && effort !== job.actualEffort) { effort = job.actualEffort; turn.onReasoningEffort?.(effort); }
        if (job.effortConfiguration !== undefined && configurationKey !== JSON.stringify(job.effortConfiguration)) {
          configurationKey = JSON.stringify(job.effortConfiguration); turn.onEffortConfiguration?.(job.effortConfiguration);
        }
        const effortMetadata = job.effortMetadata ?? { requested: selectedEffort(turn), actual: job.actualEffort ?? null, configuration: job.effortConfiguration ?? null,
          capability: normalizeEffortCapability(this.binding.agent, undefined, { source: 'remote-legacy', modelId: job.actualModel ?? turn.conversation.model ?? null }) };
        if (effortMetadataKey !== JSON.stringify(effortMetadata)) { effortMetadataKey = JSON.stringify(effortMetadata); turn.onEffortMetadata?.(effortMetadata); }
        if (job.ready && !ready) { ready = true; turn.onReady?.(); }
        if (job.progress && job.progress.sequence > activitySequence) {
          activitySequence = job.progress.sequence;
          turn.onActivity?.({ ...job.progress.lastActivity, snapshot: job.progress });
        }
        if (job.status === 'completed' && job.result) {
          try { return { ...await this.download(job), processStopped: job.stopped === true,
            ...(job.stopEvidence ? { stopEvidence: job.stopEvidence } : {}), ...(job.cleanupError ? { cleanupError: job.cleanupError } : {}) }; }
          catch (error) { throw new RemoteArtifactTransferError({ ...job.result, processStopped: job.stopped === true }, error instanceof Error ? error.message : '产物传输错误'); }
        }
        if (job.status === 'uncertain') {
          if (job.stopped === true) {
            if (this.binding.preset) throw new PresetResultUnknown(job.result, stopEvidenceFromError(job), job.executionError, job.cleanupError);
            throw new RemoteResultUncertain(job.error, job.result, stopEvidenceFromError(job), job.executionError, job.cleanupError);
          }
          throw new RemoteDispatchUncertain(job.error, job.result, stopEvidenceFromError(job), job.executionError, job.cleanupError);
        }
        if (job.status === 'cancelled') { if (job.stopped !== true) throw new RemoteDispatchUncertain('远端取消已登记，CLI 退出尚未确认。'); throw Object.assign(new Error('目标电脑上的 CLI 已停止。'), { name: 'AbortError' }); }
        if (job.status === 'failed') { if (job.result && job.stopped !== true) throw new RemoteArtifactTransferError({ ...job.result, processStopped: false }, job.error ?? '产物整理失败'); if (job.stopped !== true) throw new RemoteDispatchUncertain('远端任务失败，CLI 退出尚未确认。'); throw Object.assign(new Error(job.error ?? '远端任务失败。'), { code: 'REMOTE_JOB_FAILED' }); }
        await new Promise<void>(resolveValue => setTimeout(resolveValue, this.options.pollMs ?? 750));
      }
    } catch (error) {
      if (error instanceof RemoteDispatchUncertain || error instanceof RemoteArtifactTransferError || error instanceof RemoteResultUncertain || error instanceof PresetResultUnknown) throw error;
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
      const name = error instanceof Error ? error.name : '';
      if (execution.submitted && name !== 'AbortError' && !['REMOTE_REJECTED', 'DISPATCH_NOT_FOUND', 'REMOTE_JOB_FAILED'].includes(code)) throw new RemoteDispatchUncertain(error instanceof Error ? error.message : undefined);
      throw error;
    } finally { this.jobs.delete(turn.conversation.id); }
  }
  private async download(job: RemoteJob): Promise<AgentResult> {
    const directory = join(this.config.dataDir, 'outgoing', 'remote', this.binding.id, job.dispatchId); await mkdir(directory, { recursive: true });
    const declarations: string[] = [];
    const artifacts = job.artifacts ?? [];
    if (artifacts.length > 10 || artifacts.reduce((total, artifact) => total + artifact.size, 0) > 100 * 1024 * 1024) throw new Error('远端产物数量或总大小超过限制。');
    for (const artifact of artifacts) {
      if (!Number.isSafeInteger(artifact.size) || artifact.size < 0 || artifact.size > (this.config.maxFileBytes ?? 20 * 1024 * 1024) || !/^[a-f0-9]{64}$/.test(artifact.sha256)
        || artifact.filename !== basename(artifact.filename) || /[\x00-\x1f<>:"/\\|?*]/.test(artifact.filename) || !/^[A-Za-z0-9_-]{1,100}$/.test(artifact.id)) throw new Error('远端声明的产物无效。');
      const chunks: Buffer[] = []; let offset = 0;
      while (offset < artifact.size) {
        const result = await this.retryRead<{ data: string; offset: number; complete: boolean }>('artifact', { dispatchId: job.dispatchId, artifactId: artifact.id, offset });
        const data = Buffer.from(result.data, 'base64'); if (result.offset !== offset + data.length || !data.length || result.offset > artifact.size) throw new Error('远端产物下载位置无效。');
        chunks.push(data); offset = result.offset;
      }
      const data = Buffer.concat(chunks); if (createHash('sha256').update(data).digest('hex') !== artifact.sha256) throw new Error('远端产物校验失败。');
      const path = join(directory, `${artifact.id}-${artifact.filename}`); await writeFile(path, data, { mode: 0o600 });
      const label = (artifact.description ?? artifact.filename).replace(/[\[\]\\\r\n]/g, ''); declarations.push(`${artifact.image ? '!' : ''}[${label}](<${path}>)`);
    }
    return { ...job.result!, text: [job.result!.text, ...declarations].filter(Boolean).join('\n\n') };
  }
  async steer(conversationId: string, supplement: AgentSupplement): Promise<SteerResult> {
    const execution = this.jobs.get(conversationId); const dispatchId = execution?.dispatchId;
    if (!dispatchId || !execution.submitted) return { status: 'queued', reason: '远端执行连接尚未就绪，补充未发送。' };
    try {
      const input = await this.inputs(supplement.input);
      // Repeating this receipt query is safe: daemon journals the exact supplement ID before native delivery.
      return await this.retryRead<SteerResult>('steer', { dispatchId, id: supplement.id, input });
    } catch (error) { return { status: 'uncertain', reason: error instanceof Error ? error.message : '远端補充回执未知。' }; }
  }
  async interrupt(conversationId: string, knownDispatchId?: string): Promise<void> {
    const execution = this.jobs.get(conversationId);
    if (execution && !execution.submitted) { execution.cancelled = true; return; }
    const dispatchId = knownDispatchId ?? execution?.dispatchId ?? this.lastDispatch.get(conversationId); if (!dispatchId) throw new RemoteDispatchUncertain('没有活动远端派发编号，无法确认停止。');
    try {
      try { const result = await this.connection().request<{ stopped: boolean }>('interrupt', { dispatchId }); if (!result.stopped) throw new Error('停止未确认'); }
      catch (error) {
        if (this.knownRejection(error)) throw error;
        const state = await this.inspectDispatch(dispatchId);
        if (state.stopped === true && state.status !== 'running') return;
        const result = await this.connection().request<{ stopped: boolean }>('interrupt', { dispatchId }); if (!result.stopped) throw new Error('停止未确认');
      }
    }
    catch (error) { throw new RemoteDispatchUncertain(error instanceof Error ? error.message : '远端停止未确认。'); }
  }
  async preparePreset(workerId: string, nativeId: string | null): Promise<void> {
    if (!this.binding.preset) return;
    await this.validate(); await this.connection().request('preset/pin', { preset: this.binding.preset, workerId, nativeId, ...(this.binding.sessionVisibility ? { sessionVisibility: this.binding.sessionVisibility } : {}) });
  }
  async getModelInfo(cwd: string, context?: Pick<Conversation, 'id' | 'nativeId'>): Promise<AgentModelInfo> { await this.validate(); return this.connection().request<AgentModelInfo>('models', { agent: this.binding.agent, cwd, ...(this.binding.preset ? { preset: this.binding.preset } : {}), ...(this.binding.sessionVisibility ? { sessionVisibility: this.binding.sessionVisibility } : {}), ...(context ? { context } : {}) }); }
  async confirmStopped(conversationId: string, dispatchId = this.lastDispatch.get(conversationId)): Promise<boolean> {
    if (!dispatchId || this.closed) return false;
    try {
      // A single read, no dispatch, cancellation or long reconnect loop.
      const job = await this.connection().request<RemoteJob>('query', { dispatchId });
      return job.dispatchId === dispatchId && job.workerId === conversationId && job.stopped === true && ['completed', 'failed', 'cancelled', 'uncertain'].includes(job.status);
    } catch {
      // A later scheduled check gets a fresh SSH connection; do not poison it forever.
      const previous = this.client; this.client = null; void previous?.close().catch(() => {}); return false;
    }
  }
  async handoff(nativeId: string, cwd: string): Promise<void> { await this.validate(); await this.connection().request('handoff', { nativeId, cwd, agent: this.binding.agent }); }
  /** Closing an SSH transport detaches only; the independently hosted native task survives. */
  async close(): Promise<void> { this.closed = true; await this.client?.close(); this.client = null; }
}
