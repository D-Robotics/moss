/**
 * O86: tell the read_file reuse cache that earlier read bodies left the
 * model's context (compaction, prune, elision). After that the cache must not
 * answer "unchanged — refer to the earlier read", because there is no earlier
 * read to refer to.
 *
 * `pathHint` is the read tool's `path`/`file_path` input; `null` means every
 * earlier read may be gone (compaction summary, pruned history).
 */
type ReadContextDroppedListener = (pathHint: string | null) => void;

const listeners = new Set<ReadContextDroppedListener>();

export function onReadContextDropped(listener: ReadContextDroppedListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function notifyReadContextDropped(pathHint: string | null): void {
  for (const listener of listeners) {
    try {
      listener(pathHint);
    } catch {
      // A cache listener must not break context management.
    }
  }
}
