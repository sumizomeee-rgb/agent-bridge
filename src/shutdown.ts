/** Maintenance stop pauses intake first and retires the host only after live work drains.
 * No timeout may turn a pending report into permission to abort it. */
export class DrainStop {
  private draining = false;
  private stopping?: Promise<void>;
  constructor(private readonly options: { beginDrain: () => void; isIdle: () => boolean; shutdown: () => Promise<void> }) {}
  check(requested: boolean): Promise<void> {
    if (this.stopping) return this.stopping;
    if (!requested && !this.draining) return Promise.resolve();
    if (!this.draining) { this.options.beginDrain(); this.draining = true; }
    if (!this.options.isIdle()) return Promise.resolve();
    // Publish the guard before shutdown executes; concurrent ticks cannot close twice.
    this.stopping = Promise.resolve().then(() => this.options.shutdown());
    return this.stopping;
  }
}

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
