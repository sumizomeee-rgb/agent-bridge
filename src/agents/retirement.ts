import type { AgentResult } from '../types.js';
import { isObject, type AgentStopEvidence } from './process.js';

/** 只接受原生成功回执及唯一的正常收尾错误；不依据正文推断业务成功。 */
export function completedRetirementFailure(value: {
  result?: AgentResult; stopEvidence?: AgentStopEvidence; executionError?: string; cleanupError?: string; cancelled?: boolean;
}): boolean {
  if (!value.result || value.cancelled || value.stopEvidence?.graceful !== true || !value.executionError) return false;
  const onlyStop = (error: unknown): boolean => isObject(error) && error.message === '【桥】CLI 退出待核对。'
    && (error.cause === undefined || Array.isArray(error.cause) && error.cause.length > 0 && error.cause.every(onlyStop));
  try { return onlyStop(JSON.parse(value.executionError)) && (!value.cleanupError || onlyStop(JSON.parse(value.cleanupError))); }
  catch { return false; }
}
