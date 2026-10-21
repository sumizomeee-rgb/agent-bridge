import { safeError } from './config.js';

export interface DeliveryDiagnostic {
  platform: 'feishu'; stage: 'auth' | 'request' | 'response' | 'outbox';
  method: string; path: string; name: string;
  code?: string; httpStatus?: number; requestId?: string;
  cause?: Array<{ name: string; code?: string }>;
}
const atom = (value: unknown): string | undefined => typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,128}$/.test(value) ? value : undefined;
const errorName = (value: unknown): string => typeof value === 'string' && /^(?:Error|TypeError|RangeError|SyntaxError|AbortError|TimeoutError|AggregateError|DOMException|FeishuRequestError)$/.test(value) ? value : 'Error';
const errorCode = (value: unknown): string | undefined => typeof value === 'number' ? String(value) : typeof value === 'string' && /^(?:E[A-Z0-9_]+|UND_ERR_[A-Z0-9_]+|ABORT_ERR|ERR_[A-Z0-9_]+|-?\d{1,12}|INVALID_JSON)$/.test(value) ? value : undefined;
/** Never include arbitrary error messages, URLs, headers or request/response bodies. */
export function errorCauses(error: unknown): Array<{ name: string; code?: string }> {
  const result: Array<{ name: string; code?: string }> = [], seen = new Set<unknown>();
  while (error && typeof error === 'object' && !seen.has(error) && result.length < 5) {
    seen.add(error); const value = error as { name?: unknown; code?: unknown; cause?: unknown };
    const code = errorCode(value.code);
    result.push({ name: errorName(value.name), ...(code ? { code } : {}) }); error = value.cause;
  }
  return result;
}
export function deliveryDiagnostic(stage: DeliveryDiagnostic['stage'], method: string, path: string, error: unknown,
  details: { code?: unknown; httpStatus?: number; requestId?: unknown } = {}): DeliveryDiagnostic {
  const chain = errorCauses(error), code = errorCode(details.code);
  return { platform: 'feishu', stage, method: /^(GET|POST|PUT|PATCH|DELETE|HEAD)$/.test(method) ? method : 'UNKNOWN',
    path: path.split('?')[0]!.replace(/\/(?:om_|oc_|ou_)[a-zA-Z0-9_-]+/g, '/:id').slice(0, 200),
    name: chain[0]?.name ?? 'Error', ...(code ? { code } : {}),
    ...(Number.isInteger(details.httpStatus) ? { httpStatus: details.httpStatus } : {}),
    ...(atom(details.requestId) ? { requestId: atom(details.requestId) } : {}), ...(chain.length ? { cause: chain } : {}) };
}
export class FeishuRequestError extends Error {
  constructor(message: string, readonly diagnostic: DeliveryDiagnostic, readonly retryable = false) { super(message); this.name = 'FeishuRequestError'; }
}
/** Durable evidence remains useful even after String(error) has discarded a fetch cause. */
export function errorEvidence(error: unknown): string {
  if (error instanceof FeishuRequestError) return JSON.stringify(error.diagnostic);
  return JSON.stringify({ name: errorCauses(error)[0]?.name ?? 'Error', cause: errorCauses(error) });
}
function executionMessage(error: unknown, secrets: string[]): string {
  let text: string;
  try { text = error instanceof Error ? error.message : typeof error === 'object' && error !== null && typeof (error as { message?: unknown }).message === 'string'
    ? (error as { message: string }).message : String(error); } catch { text = 'Unreadable error'; }
  // Redact before truncation so cutting a long credential cannot leave a useful prefix.
  text = text.replace(/\b[a-z][a-z0-9+.-]{1,31}:\/\/[^\s<>"'`]+/gi, '[url]')
    .replace(/\b(?:sk-(?:proj-|ant-)?[a-zA-Z0-9_-]{8,}|gh[pousr]_[a-zA-Z0-9_]{16,}|github_pat_[a-zA-Z0-9_]{16,}|xox[baprs]-[a-zA-Z0-9-]{10,}|AKIA[A-Z0-9]{16})\b/g, '[redacted]')
    .replace(/\beyJ[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,}\b/g, '[redacted]')
    .replace(/(["']?(?:api[ _-]?key|access[ _-]?token|refresh[ _-]?token|id[ _-]?token|app[ _-]?secret|client[ _-]?secret|password|passwd|pwd|token|secret)["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}\]]+)/gi, '$1[redacted]')
    .replace(/(\bauthorization\s*[:=]\s*)[^\r\n,;}]+/gi, '$1[redacted]');
  return safeError(new Error(text), secrets).slice(0, 600);
}
/** Local execution diagnostics preserve the failure reason; never use this as chat copy. */
export function executionErrorEvidence(error: unknown, secrets: string[] = []): string {
  if (error instanceof FeishuRequestError) return errorEvidence(error);
  const entries: Array<{ name: string; message: string; code?: string }> = [], seen = new Set<unknown>();
  let current = error;
  do {
    if (seen.has(current)) break; seen.add(current);
    const value = current && typeof current === 'object' ? current as { name?: unknown; code?: unknown; cause?: unknown } : {};
    const code = errorCode(value.code);
    entries.push({ name: errorName(value.name), message: executionMessage(current, secrets), ...(code ? { code } : {}) });
    current = value.cause;
  } while (current !== undefined && current !== null && entries.length < 5);
  return JSON.stringify({ ...entries[0], ...(entries.length > 1 ? { cause: entries.slice(1) } : {}) });
}
