import { executionErrorEvidence } from '../delivery-errors.js';
import { stopEvidenceFromError, type JsonLineProcess, type AgentStopEvidence } from './process.js';

type ProbeTransport = Pick<JsonLineProcess, 'stop'> & Partial<Pick<JsonLineProcess, 'confirmStopped' | 'stopEvidence'>>;
/** Only an initialize/model-list probe, with no user input or model turn, may use this evidence. */
export class MetadataProbeError extends Error {
  readonly beforeSubmission = true;
  readonly processStillRunning?: true;
  readonly cleanupError?: string;
  readonly stopEvidence?: AgentStopEvidence;
  constructor(cause: unknown, readonly processStopped: boolean, cleanup?: unknown) {
    super('模型信息前置检查失败。', { cause }); this.name = 'MetadataProbeError';
    if (!processStopped) this.processStillRunning = true;
    if (cleanup !== undefined) { this.cleanupError = executionErrorEvidence(cleanup); this.stopEvidence = stopEvidenceFromError(cleanup); }
  }
}
export function metadataStopped(transport: ProbeTransport): boolean {
  // This is retirement of a no-generation probe, never proof of cancelling an execution tree.
  const evidence = transport.stopEvidence;
  return transport.confirmStopped?.() === true || evidence?.exitObserved === true && evidence.closeObserved === true;
}
/** 只管理没有用户输入、线程或生成请求的隔离元数据探测。 */
export class MetadataProbes {
  private readonly processes = new Map<ProbeTransport, { cleanup?: () => void; retirement?: Promise<void> }>();
  private readonly unconfirmed = new Set<ProbeTransport>();
  track(transport: ProbeTransport, cleanup?: () => void): void { this.processes.set(transport, { cleanup }); }
  private release(transport: ProbeTransport): void {
    const entry = this.processes.get(transport); if (!entry) return;
    this.processes.delete(transport); this.unconfirmed.delete(transport);
    try { entry.cleanup?.(); } catch { process.emitWarning('模型探测临时目录清理失败；探测进程已退出。'); }
  }
  /** 已返回的数据有效，退出在后台核验；探测没有业务子任务，可升级停止它自己的进程树。 */
  complete(transport: ProbeTransport): void {
    const entry = this.processes.get(transport); if (!entry) throw new Error('模型探测未登记。');
    entry.retirement = (async () => {
      try { await retireMetadata(transport, true); }
      catch { await retireMetadata(transport, false); }
      this.release(transport);
    })().catch(() => { if (this.processes.has(transport)) this.unconfirmed.add(transport); });
  }
  async failed(transport: ProbeTransport, primary: unknown): Promise<void> {
    try { await retireMetadata(transport, false, primary); this.release(transport); }
    catch (error) { this.unconfirmed.add(transport); throw error; }
  }
  /** 正常待收尾不阻挡下一次查询；真正无法回收的探测仍需证明，防止遗留进程累积。 */
  prepare(): Promise<void> | undefined {
    if (!this.unconfirmed.size) return;
    return (async () => { for (const transport of this.unconfirmed) { await retireMetadata(transport, false); this.release(transport); } })();
  }
  async close(): Promise<void> {
    const entries = [...this.processes];
    const outcomes = await Promise.allSettled(entries.map(async ([transport]) => {
      await retireMetadata(transport, false); this.release(transport);
    }));
    await Promise.allSettled(entries.flatMap(([, entry]) => entry.retirement ? [entry.retirement] : []));
    for (const [transport] of entries) if (metadataStopped(transport)) this.release(transport);
    const failures = outcomes.filter((outcome, index): outcome is PromiseRejectedResult => outcome.status === 'rejected' && this.processes.has(entries[index]![0]));
    if (failures.length) throw failures.length === 1 ? failures[0]!.reason : new AggregateError(failures.map(failure => failure.reason), '模型探测进程退出尚未确认。');
  }
}

export async function retireMetadata(transport: ProbeTransport, success: boolean, primary?: unknown): Promise<void> {
  if (metadataStopped(transport)) return;
  try { await transport.stop(success); }
  catch (cleanup) {
    if (metadataStopped(transport)) return;
    throw new MetadataProbeError(primary ?? cleanup, false, cleanup);
  }
}
