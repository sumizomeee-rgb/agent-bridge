/** Keep attachment preparation and command handling in arrival order per user. */
export class OrderedInbox<T> {
  private readonly chains = new Map<string, Promise<void>>();

  constructor(
    private readonly key: (message: T) => string,
    private readonly handler: (message: T) => Promise<void>,
  ) {}

  async handle(message: T, immediate = false): Promise<void> {
    const key = this.key(message);
    const previous = this.chains.get(key) ?? Promise.resolve();
    // 控制命令越过慢附件准备；后续普通消息仍等待准备链和命令处理。
    const job = (immediate ? Promise.resolve() : previous.catch(() => undefined)).then(() => this.handler(message));
    const barrier = immediate ? Promise.allSettled([previous, job]).then(() => undefined) : job;
    this.chains.set(key, barrier);
    void barrier.finally(() => { if (this.chains.get(key) === barrier) this.chains.delete(key); }).catch(() => undefined);
    try { await job; }
    finally {
      if (!immediate && this.chains.get(key) === barrier) this.chains.delete(key);
    }
  }
}
