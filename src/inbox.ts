/** Keep attachment preparation and command handling in arrival order per user. */
export class OrderedInbox<T> {
  private readonly chains = new Map<string, Promise<void>>();

  constructor(
    private readonly key: (message: T) => string,
    private readonly handler: (message: T) => Promise<void>,
  ) {}

  async handle(message: T): Promise<void> {
    const key = this.key(message);
    const previous = this.chains.get(key) ?? Promise.resolve();
    const job = previous.catch(() => undefined).then(() => this.handler(message));
    this.chains.set(key, job);
    try { await job; }
    finally {
      if (this.chains.get(key) === job) this.chains.delete(key);
    }
  }
}
