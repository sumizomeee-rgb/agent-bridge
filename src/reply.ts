import type { DeliveredReply } from './store.js';
import type { AgentName } from './types.js';

export const agentDisplayName = (agent: AgentName): string => agent === 'codex' ? 'Codex CLI' : 'Claude Code';

function headerValue(value: string): string {
  // Metadata must stay on one short line, even if a provider returns malformed text.
  return value.replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/@/g, '＠').trim().slice(0, 120);
}

/** Only full identities from successfully delivered replies establish continuity. */
export function replyHeader(identity: DeliveredReply, previous: DeliveredReply | null,
  model: string | null, effort: string | null): string {
  const continuous = previous?.conversationId === identity.conversationId
    && previous.agent === identity.agent && previous.nativeId === identity.nativeId;
  const name = identity.agent === 'codex' ? 'Codex' : 'Claude Code';
  const actualModel = model ? headerValue(model) || '模型未知' : '模型未知';
  const actualEffort = effort ? headerValue(effort) || '强度未知' : '强度未知';
  const suffix = headerValue(identity.nativeId.slice(-6));
  return `[${name} · ${actualModel} · ${actualEffort} · …${suffix}${continuous ? ' ✅' : ''}]`;
}
