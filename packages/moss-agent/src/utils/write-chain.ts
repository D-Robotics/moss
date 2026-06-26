/**
 * Write chain — serialize async writes to prevent race conditions.
 *
 * PROBLEM: concurrent writes to the same resource (file, in-memory index)
 * can interleave and produce torn state. On Windows, concurrent renames to
 * the same file path can return EPERM.
 *
 * SOLUTION: a per-key promise chain. Each write enqueues after the previous
 * one; unrelated keys are independent. A failed write does not poison later
 * queued writes (`.catch(() => undefined)` unlinks the chain).
 *
 * DESIGN INTENT — deliberate process-wide singleton for per-target
 * serialization. This is a known architectural choice documented in
 * AGENTS.md "No new module-level mutable state in library packages" —
 * the write-chain Map is the exception because it serializes I/O, not
 * business logic state.
 */

/** A write chain per key — each key's writes are serialized independently. */
export class WriteChain {
  private readonly chains = new Map<string, Promise<void>>();

  /**
   * Enqueue an async operation on the write chain for `key`.
   * Returns a promise that resolves when the operation completes.
   * If the operation throws, the chain is unlinked so subsequent
   * writes can proceed.
   */
  enqueue(key: string, fn: () => Promise<void>): Promise<void> {
    const prev = this.chains.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn); // `.then(fn, fn)` unlinks on rejection
    this.chains.set(key, next);
    // Clean up the chain entry once the write settles (success or failure).
    // We use a detached promise to avoid holding a reference.
    const cleanup = () => {
      if (this.chains.get(key) === next) this.chains.delete(key);
    };
    next.then(cleanup, cleanup);
    return next;
  }
}

/**
 * Default process-wide write chain singleton.
 * For per-instance isolation, create a new `WriteChain()`.
 */
export const defaultWriteChain = new WriteChain();
