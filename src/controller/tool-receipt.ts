import { isObject } from '../agents/process.js';
const mutations = new Set(['bridge_start_worker', 'bridge_continue_worker', 'bridge_cancel_worker', 'bridge_schedule_worker', 'bridge_handoff_worker']);
/** Model-facing receipt only; persistence and dispatch keep the complete binding. */
export function compactControllerReceipt(name: string, value: unknown): unknown {
  if (!mutations.has(name) || !isObject(value) || !isObject(value.target)) return value;
  const target = value.target;
  return { ...value, target: { id: target.id, label: target.label, transport: target.transport },
    details: 'bridge_list_workers({workerId}) 查看完整配置与回执。' };
}
