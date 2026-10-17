import type { AgentAdapter, AgentModelInfo, AgentName, AgentTurn, Conversation, EffortCapability, EffortConfiguration, EffortMetadata } from './types.js';

export function selectedEffort(turn: AgentTurn): string | null {
  return turn.effort ?? turn.conversation.effort ?? null;
}

/** A malformed or absent capability is unknown, never a guessed level. */
export function normalizeEffortCapability(agent: AgentName, levels: unknown, evidence: {
  source: string; modelId: string | null; resolvedModel?: string; cliVersion?: string;
}, explicitlyUnsupported = false): EffortCapability {
  if (explicitlyUnsupported) return { ...evidence, status: 'unsupported', levels: [] };
  if (!Array.isArray(levels) || levels.some(level => typeof level !== 'string' || !isEffortLevel(level))) {
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

export async function validateEffort(adapter: AgentAdapter, target: Conversation, effort: string): Promise<EffortCapability> {
  if (!isEffortLevel(effort)) throw new Error(`${target.agent} 不支持强度 ${effort}。`);
  const info = await adapter.getModelInfo?.(target.cwd);
  const capability = modelEffortCapability(info ?? { models: [], defaultModel: null }, target);
  if (capability.status === 'unknown') throw new Error('CLI 未提供该模型的有效强度元数据，不能确认兼容性；请使用 effort=default 或选择有元数据的模型。');
  if (capability.status !== 'supported') throw new Error('该模型不支持可调 effort；请使用 effort=default。');
  if (!capability.levels.includes(effort)) throw new Error(`该模型不支持 ${effort}；支持值：${capability.levels.join('、')}。`);
  return capability;
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

/** Values are protocol tokens. Which values a model supports is supplied by its own adapter. */
export const isEffortLevel = (value: unknown): value is string => typeof value === 'string' && /^[a-z][a-z0-9_-]{0,31}$/.test(value);
const effortLabels: Record<string, string> = { none: '无', minimal: '最少', low: '低', medium: '中', high: '高', xhigh: '极高', max: '最高', ultra: '超高', auto: '自动' };
const effortLabel = (value: string): string => {
  const clean = value.replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/@/g, '＠').replace(/`/g, 'ˋ').trim().slice(0, 32);
  return effortLabels[clean.toLowerCase()] ?? clean;
};
/** Shared by reply headers and worker summaries. Configuration never becomes observed execution. */
export function formatEffortEvidence(metadata: Partial<EffortMetadata>): string {
  if (typeof metadata.actual === 'string' && effortLabel(metadata.actual)) return effortLabel(metadata.actual);
  if (metadata.capability?.status === 'unsupported') return '不适用';
  if (metadata.requested && effortLabel(metadata.requested)) return `${effortLabel(metadata.requested)}〔指定〕`;
  const configuration = metadata.configuration;
  if (configuration?.applied === false) return 'CLI 默认 · 配置未采用';
  if (configuration && effortLabel(configuration.value)) {
    const source = configuration.source === 'argument' ? '启动参数' : configuration.source === 'environment' ? '环境配置' : 'CLI 配置';
    return `${effortLabel(configuration.value)}〔${source}〕`;
  }
  return 'CLI 默认 · 未回报';
}
/** A fresh reporter belongs to one submitted turn. It never inherits a previous actual value. */
export function createEffortReporter(turn: AgentTurn, agent: AgentName, initial: Partial<EffortMetadata> = {}): (patch?: Partial<EffortMetadata>) => EffortMetadata {
  let state: EffortMetadata = { requested: selectedEffort(turn), configuration: null,
    capability: normalizeEffortCapability(agent, undefined, { source: `${agent}-native`, modelId: turn.conversation.model ?? null }), actual: null, ...initial };
  let first = true;
  return (patch = {}) => {
    const previous = state;
    state = { ...state, ...patch };
    if (first || Object.hasOwn(patch, 'actual') && previous.actual !== state.actual) turn.onReasoningEffort?.(state.actual);
    if (first || Object.hasOwn(patch, 'configuration') && JSON.stringify(previous.configuration) !== JSON.stringify(state.configuration)) turn.onEffortConfiguration?.(state.configuration);
    first = false;
    const snapshot: EffortMetadata = { ...state, configuration: state.configuration ? { ...state.configuration } : null,
      capability: { ...state.capability, levels: [...state.capability.levels] } as EffortCapability };
    turn.onEffortMetadata?.(snapshot); return snapshot;
  };
}
/** Only explicit response metadata is an observation; model names and thinking blocks are not levels. */
export function observedClaudeEffort(message: Record<string, unknown>): string | null | undefined {
  const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
  const response = message.type === 'assistant' && !message.parent_tool_use_id && object(message.message) ? message.message
    : message.type === 'stream_event' && !message.parent_tool_use_id && object(message.event) && message.event.type === 'message_start' && object(message.event.message) ? message.event.message : null;
  if (!response || !object(response.output_config) || !Object.hasOwn(response.output_config, 'effort')) return undefined;
  const value = response.output_config.effort;
  return value === null ? null : isEffortLevel(value) ? value : undefined;
}

/** A capability describes its exact model or a CLI-resolved alias, never another gateway model. */
export function effortCapabilityForModel(capability: EffortCapability, model: string): EffortCapability {
  if (capability.modelId === model || capability.resolvedModel === model) return capability;
  return { status: 'unknown', levels: [], source: capability.source, modelId: model,
    ...(capability.cliVersion ? { cliVersion: capability.cliVersion } : {}) };
}
