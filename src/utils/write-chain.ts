export class WriteChain {
  private readonly chains = new Map<string, Promise<void>>();

  enqueue(key: string, fn: () => Promise<void>): Promise<void> {
    const prev = this.chains.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.chains.set(key, next);

    const cleanup = () => {
      if (this.chains.get(key) === next) this.chains.delete(key);
    };
    next.then(cleanup, cleanup);
    return next;
  }
}

export const defaultWriteChain = new WriteChain();
