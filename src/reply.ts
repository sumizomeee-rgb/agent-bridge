import type { DeliveredReply } from './store.js';
import type { AgentName } from './types.js';

export const agentDisplayName = (agent: AgentName): string => agent === 'codex' ? 'Codex CLI' : 'Claude Code';

function headerValue(value: string): string {
  // Metadata must stay on one short line, even if a provider returns malformed text.
  return value.replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/@/g, '＠').trim().slice(0, 120);
}

/** Reply headers show actual metadata; delivery identities are persisted separately. */
export function replyHeader(identity: DeliveredReply, _previous: DeliveredReply | null,
  model: string | null, effort: string | null): string {
  const name = identity.agent === 'codex' ? 'Codex' : 'Claude';
  const actualModel = model ? headerValue(model).replace(/^gpt-/i, '') || '模型未知' : '模型未知';
  const actualEffort = effort ? headerValue(effort) || '强度未知' : '强度未知';
  const effortLabels: Record<string, string> = { minimal: '最少', low: '低', medium: '中', high: '高', xhigh: '极高', max: '最高', ultra: '超高', none: '无' };
  const shortEffort = Object.hasOwn(effortLabels, actualEffort.toLowerCase()) ? effortLabels[actualEffort.toLowerCase()]! : actualEffort;
  const suffix = headerValue(identity.nativeId.slice(-4));
  return `[${name} · ${actualModel} · ${shortEffort} · ${suffix}]`;
}
