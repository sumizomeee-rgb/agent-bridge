import type { AgentAdapter, AgentModelInfo, AgentName, AgentTurn, Conversation, EffortCapability } from './types.js';

export const effortValues: Record<AgentName, string[]> = {
  codex: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  claude: ['low', 'medium', 'high', 'max'],
};

export function selectedEffort(turn: AgentTurn): string | null {
  return turn.effort ?? turn.conversation.effort ?? null;
}

/** A malformed or absent capability is unknown, never a guessed level. */
export function normalizeEffortCapability(agent: AgentName, levels: unknown, evidence: {
  source: string; modelId: string | null; resolvedModel?: string; cliVersion?: string;
}, explicitlyUnsupported = false): EffortCapability {
  if (explicitlyUnsupported) return { ...evidence, status: 'unsupported', levels: [] };
  if (!Array.isArray(levels) || levels.some(level => typeof level !== 'string' || !effortValues[agent].includes(level))) {
    return { ...evidence, status: 'unknown', levels: [] };
  }
  const values = [...new Set(levels)] as string[];
  return values.length ? { ...evidence, status: 'supported', levels: values as [string, ...string[]] }
    : { ...evidence, status: 'unsupported', levels: [] };
}

export function modelEffortCapability(info: AgentModelInfo, target: Conversation): EffortCapability {
  const id = target.model ?? info.defaultModel;
  const model = id == null ? undefined : info.models.find(model => model.id === id)
    ?? info.models.find(model => model.resolvedModel === id);
  const evidence = { source: model?.effortCapability?.source ?? info.source ?? 'cli-metadata', modelId: id ?? null,
    ...(model?.resolvedModel ? { resolvedModel: model.resolvedModel } : {}),
    ...((model?.effortCapability?.cliVersion ?? info.cliVersion) ? { cliVersion: model?.effortCapability?.cliVersion ?? info.cliVersion } : {}) };
  const capability = model?.effortCapability;
  return normalizeEffortCapability(target.agent,
    capability?.status === 'unknown' ? undefined : capability?.levels ?? model?.supportedEfforts,
    evidence, capability?.status === 'unsupported');
}

export function modelEfforts(info: AgentModelInfo, target: Conversation): string[] | null {
  const capability = modelEffortCapability(info, target);
  return capability.status === 'unknown' ? null : capability.levels;
}

export function effortCapabilityText(capability: EffortCapability): string {
  const value = capability.status === 'supported' ? capability.levels.join('、')
    : capability.status === 'unsupported' ? '不支持可调 effort' : '未知（CLI 尚未提供有效能力证据）';
  return `${value}；来源：${capability.source}${capability.modelId ? `；模型：${capability.modelId}` : ''}
${capability.resolvedModel ? `别名解析：${capability.resolvedModel}；` : ''}能力信息不代表网关实际执行已验证。`;
}

export async function validateEffort(adapter: AgentAdapter, target: Conversation, effort: string): Promise<void> {
  if (!effortValues[target.agent].includes(effort)) throw new Error(`${target.agent} 不支持强度 ${effort}。`);
  const info = await adapter.getModelInfo?.(target.cwd);
  const capability = modelEffortCapability(info ?? { models: [], defaultModel: null }, target);
  if (capability.status === 'unknown') throw new Error('CLI 未提供该模型的有效强度元数据，不能确认兼容性；请使用 effort=default 或选择有元数据的模型。');
  if (capability.status !== 'supported') throw new Error('该模型不支持可调 effort；请使用 effort=default。');
  if (!capability.levels.includes(effort)) throw new Error(`该模型不支持 ${effort}；支持值：${capability.levels.join('、')}。`);
}

/** Explicit default is resolved per launch, never persisted as a model ID. */
export async function resolveDefaultModel(adapter: AgentAdapter, turn: AgentTurn): Promise<AgentTurn> {
  if (turn.conversation.modelPolicy !== 'cli-default' || turn.conversation.model || !turn.conversation.nativeId) return turn;
  const info = await adapter.getModelInfo?.(turn.conversation.cwd);
  if (!info?.defaultModel || info.defaultModel === 'default') throw new Error('无法确认目标 CLI 当前默认模型，本轮未提交；显式默认策略已保留。');
  return { ...turn, conversation: { ...turn.conversation, model: info.defaultModel } };
}

/** Claude 2.1.x persists low/medium/high; max is a session-only flag. */
export function claudeModelSettings(settings: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(['model', 'effortLevel', 'alwaysThinkingEnabled'].filter(key => key in settings
    && (key !== 'effortLevel' || ['low', 'medium', 'high'].includes(String(settings[key])))).map(key => [key, settings[key]]));
}
