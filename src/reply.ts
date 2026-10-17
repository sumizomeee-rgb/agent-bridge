import type { DeliveredReply } from './store.js';
import type { AgentName, EffortMetadata } from './types.js';
import { formatEffortEvidence } from './effort.js';

export const agentDisplayName = (agent: AgentName): string => agent === 'codex' ? 'Codex CLI' : 'Claude Code';

function headerValue(value: string): string {
  // Metadata must stay on one short line, even if a provider returns malformed text.
  return value.replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/@/g, '＠').trim().slice(0, 120);
}

/** Discord display only; the raw reply header and persisted identity remain unchanged. */
export function discordReplyHeader(header: string): string {
  const displayHeader = header.startsWith('[') && header.endsWith(']') ? header.slice(1, -1) : header;
  const singleLine = displayHeader.replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/`/g, 'ˋ');
  return ['```ansi', `\u001b[32m${singleLine}\u001b[0m`, '```'].join('\n');
}

/** Reply headers show actual metadata; delivery identities are persisted separately. */
export function replyHeader(identity: DeliveredReply, _previous: DeliveredReply | null,
  model: string | null, effort: string | null, metadata?: EffortMetadata | null): string {
  const name = identity.agent === 'codex' ? 'Codex' : 'Claude';
  const actualModel = model ? headerValue(model).replace(/^gpt-/i, '') || '模型未知' : '模型未知';
  const shortEffort = formatEffortEvidence(metadata ?? { actual: effort });
  const suffix = headerValue(identity.nativeId.slice(-4));
  return `[${name} · ${actualModel} · ${shortEffort} · ${suffix}]`;
}
