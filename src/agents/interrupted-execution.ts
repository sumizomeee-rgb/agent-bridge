import type { AgentResult } from '../types.js';
import type { AgentStopEvidence } from './process.js';

/** A failed turn may accept new instructions only after positive exit proof; it is never replayed. */
export function stoppedExecutionFailure(value: {
  processStopped?: boolean; stopEvidence?: AgentStopEvidence; executionError?: string;
  nativeResult?: AgentResult; cleanupError?: string;
}): boolean {
  return value.processStopped === true && value.stopEvidence?.exitObserved === true && !!value.executionError
    && !value.nativeResult && !value.cleanupError;
}
