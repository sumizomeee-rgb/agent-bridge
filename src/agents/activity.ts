import type { AgentActivity, AgentActivityMetadata, AgentExecutionProgress, AgentToolActivity } from '../types.js';

const activityTypes = new Set(['reasoning', 'message', 'tool-started', 'tool-completed']);
const toolStatuses = new Set(['completed', 'failed', 'cancelled', 'unknown']);
function identifier(value: unknown, max: number): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !/[\x00-\x1f]/.test(value) ? value : undefined;
}
function timestamp(value: unknown): string | undefined {
  return typeof value === 'string' && value.length <= 64 && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : undefined;
}
/** Whitelist native metadata; prompts, arguments, command text and tool outputs never enter progress. */
function metadata(value: AgentActivityMetadata): AgentActivityMetadata | null {
  if (!value || typeof value !== 'object') return null;
  const at = timestamp(value.at); if (!at || !activityTypes.has(value.type)) return null;
  const itemId = identifier(value.itemId, 512); const toolName = identifier(value.toolName, 160);
  if (value.type.startsWith('tool-') && (!itemId || !toolName)) return null;
  return { at, type: value.type, ...(itemId ? { itemId } : {}), ...(toolName ? { toolName } : {}),
    ...(value.status && toolStatuses.has(value.status) ? { status: value.status } : {}) };
}
function snapshot(value: AgentExecutionProgress): AgentExecutionProgress | null {
  if (!value || value.observed !== true || !Number.isSafeInteger(value.sequence) || value.sequence < 1
    || !Array.isArray(value.activeTools) || value.activeTools.length > 128) return null;
  const lastActivity = metadata(value.lastActivity); if (!lastActivity) return null;
  const activeTools: AgentToolActivity[] = [];
  for (const tool of value.activeTools) {
    if (!tool || typeof tool !== 'object') return null;
    const itemId = identifier(tool.itemId, 512); const toolName = identifier(tool.toolName, 160); const startedAt = timestamp(tool.startedAt);
    if (!itemId || !toolName || !startedAt || activeTools.some(old => old.itemId === itemId)) return null;
    activeTools.push({ itemId, toolName, startedAt });
  }
  const lastTool = value.lastTool ? metadata(value.lastTool) : null;
  return { observed: true, sequence: value.sequence, stage: activeTools.length ? 'tool' : lastActivity.type === 'tool-completed' ? 'between-tools' : lastActivity.type === 'reasoning' ? 'reasoning' : 'message',
    lastActivity, activeTools, ...(lastTool ? { lastTool } : {}) };
}
/** Duplicate polling snapshots leave every native timestamp and sequence unchanged. */
export function observeActivity(current: AgentExecutionProgress | undefined, activity: AgentActivity): AgentExecutionProgress | undefined {
  if (activity.snapshot) {
    const next = snapshot(activity.snapshot);
    return next && (!current || next.sequence > current.sequence) ? next : current;
  }
  const event = metadata(activity); if (!event) return current;
  const activeTools = [...(current?.activeTools ?? [])];
  const index = activeTools.findIndex(tool => tool.itemId === event.itemId);
  if (event.type === 'tool-started') {
    if (index >= 0) return current;
    activeTools.push({ itemId: event.itemId!, toolName: event.toolName!, startedAt: event.at });
  } else if (event.type === 'tool-completed') {
    if (index >= 0) activeTools.splice(index, 1);
    else if (current?.lastTool?.itemId === event.itemId && current?.lastTool?.type === 'tool-completed') return current;
  }
  return { observed: true, sequence: (current?.sequence ?? 0) + 1,
    stage: activeTools.length ? 'tool' : event.type === 'tool-completed' ? 'between-tools' : event.type === 'reasoning' ? 'reasoning' : 'message',
    lastActivity: event, activeTools, ...(event.type.startsWith('tool-') ? { lastTool: event } : current?.lastTool ? { lastTool: current.lastTool } : {}) };
}
