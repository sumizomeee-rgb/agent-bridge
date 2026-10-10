export interface ShutdownStep { name: string; close: () => void | Promise<void> }

/** Finish every cleanup step, but never mistake a failed process close for success. */
export async function closeResources(steps: readonly ShutdownStep[]): Promise<void> {
  const failures: Error[] = [];
  for (const step of steps) {
    try { await step.close(); }
    catch (cause) { failures.push(new Error(`${step.name}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause })); }
  }
  if (failures.length) throw new AggregateError(failures, failures.map(error => error.message).join('\n'));
}
