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
export async function retireMetadata(transport: ProbeTransport, success: boolean, primary?: unknown): Promise<void> {
  if (metadataStopped(transport)) return;
  try { await transport.stop(success); }
  catch (cleanup) {
    if (metadataStopped(transport)) return;
    throw new MetadataProbeError(primary ?? cleanup, false, cleanup);
  }
}
