import { isModelId } from '../config.js';
import { isEffortLevel } from '../effort.js';
import type { AgentName } from '../types.js';

/** Per Bot and per machine. A follow policy is dynamic, never a model snapshot. */
export type WorkerChoice = { kind: 'follow' }
  | { kind: 'ordinary'; agent: AgentName; model: string; effort: string | null }
  | { kind: 'preset'; presetId: string; effort: string | null };

export function workerTargetId(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value)) throw new Error('电脑 ID 无效，请使用清单中的 targetId。');
  return value;
}
export function workerChoice(value: unknown, allowFollow = false): WorkerChoice {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('助手选择必须是对象。');
  const args = value as Record<string, unknown>;
  const fields = args.kind === 'ordinary' ? ['kind', 'agent', 'model', 'effort'] : args.kind === 'preset' ? ['kind', 'presetId', 'effort'] : ['kind'];
  if (Object.keys(args).some(key => !fields.includes(key))) throw new Error('助手选择包含冲突或未知字段。');
  if (args.kind === 'follow' && allowFollow) return { kind: 'follow' };
  let effort: string | null = null;
  if (args.effort != null && args.effort !== 'default') {
    if (typeof args.effort !== 'string' || !isEffortLevel(args.effort)) throw new Error('助手强度无效；可指定支持的强度或 default。');
    effort = args.effort;
  }
  if (args.kind === 'ordinary') {
    if (args.agent !== 'codex' && args.agent !== 'claude') throw new Error('普通助手须明确指定 codex 或 claude。');
    if (typeof args.model !== 'string' || args.model === 'default' || !isModelId(args.model)) throw new Error('普通助手须明确指定模型，不能用 model=default 代替助手选择。');
    return { kind: 'ordinary', agent: args.agent, model: args.model, effort };
  }
  if (args.kind === 'preset') {
    if (typeof args.presetId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,95}$/.test(args.presetId)) throw new Error('预设 ID 无效。');
    return { kind: 'preset', presetId: args.presetId, effort };
  }
  throw new Error('助手 kind 必须为 default、ordinary 或 preset；follow 仅用于设置桥电脑默认。');
}
export function workerChoiceText(choice: WorkerChoice | null): string {
  if (!choice) return '未设置（default 派工会拒绝）';
  if (choice.kind === 'follow') return '跟随当前主控的后端、模型和强度';
  return (choice.kind === 'preset' ? `预设 ${choice.presetId}` : `${choice.agent} · ${choice.model}`) + ` · ${choice.effort ?? 'CLI 默认强度'}`;
}
export const workerDefaultUsage = '/default agentworker [电脑ID]：查看默认与候选；/default agentworker <电脑ID> follow|clear；/default agentworker <电脑ID> preset <预设ID> [强度]；/default agentworker <电脑ID> codex|claude <模型> [强度]。follow 仅用于 local。';
export function parseWorkerDefaultCommand(argument: string): { targetId?: string; choice?: WorkerChoice | null } {
  const [scope, target, mode, ...rest] = argument.trim().split(/\s+/);
  if (scope !== 'agentworker') throw new Error(workerDefaultUsage);
  if (!target) return {};
  const targetId = workerTargetId(target);
  if (!mode) return { targetId };
  if (mode === 'clear' && !rest.length) return { targetId, choice: null };
  if (mode === 'follow' && !rest.length) {
    if (targetId !== 'local') throw new Error('跟随主控仅用于桥电脑 local；请为远端选择该电脑的普通助手或预设。');
    return { targetId, choice: { kind: 'follow' } };
  }
  if (mode === 'preset' && rest.length >= 1 && rest.length <= 2)
    return { targetId, choice: workerChoice({ kind: 'preset', presetId: rest[0], effort: rest[1] }) };
  if ((mode === 'codex' || mode === 'claude') && rest.length >= 1 && rest.length <= 2)
    return { targetId, choice: workerChoice({ kind: 'ordinary', agent: mode, model: rest[0], effort: rest[1] }) };
  throw new Error(workerDefaultUsage);
}
