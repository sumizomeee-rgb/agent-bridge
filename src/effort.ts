import type { AgentAdapter, AgentModelInfo, AgentName, AgentTurn, Conversation } from './types.js';

export const effortValues: Record<AgentName, string[]> = {
  codex: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  claude: ['low', 'medium', 'high', 'max'],
};

export function selectedEffort(turn: AgentTurn): string | null {
  return turn.effort ?? turn.conversation.effort ?? null;
}

export function modelEfforts(info: AgentModelInfo, target: Conversation): string[] | null {
  const id = target.model ?? info.defaultModel ?? target.actualModel;
  return info.models.find(model => model.id === id)?.supportedEfforts ?? null;
}

export async function validateEffort(adapter: AgentAdapter, target: Conversation, effort: string): Promise<void> {
  if (!effortValues[target.agent].includes(effort)) throw new Error(`${target.agent} 不支持强度 ${effort}。`);
  const info = await adapter.getModelInfo?.(target.cwd);
  const supported = info ? modelEfforts(info, target) : null;
  if (!supported) throw new Error('CLI 未提供该模型的强度元数据，不能确认兼容性；请先 /effort default 或选择有元数据的模型。');
  if (!supported.includes(effort)) throw new Error(`该模型不支持 ${effort}；支持值：${supported.join('、') || '无'}。`);
}
