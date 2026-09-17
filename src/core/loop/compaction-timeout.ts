const DEFAULT_COMPACTION_PREPARE_TIMEOUT_MS = 30_000;

export function resolveCompactionPrepareTimeoutMs(): number {
  const raw = Number(process.env.MOSS_COMPACTION_PREPARE_TIMEOUT_MS);
  if (Number.isFinite(raw) && raw > 0) {
    return Math.max(1, Math.floor(raw));
  }
  return DEFAULT_COMPACTION_PREPARE_TIMEOUT_MS;
}

function toAbortError(label: string, reason?: unknown): Error {
  if (reason instanceof Error) {
    return reason;
  }
  const suffix = reason === undefined ? '' : `: ${String(reason)}`;
  return new Error(`${label} compaction prepare aborted${suffix}`);
}

export async function runWithCompactionPrepareTimeout<T>(
  task: (abortSignal?: AbortSignal) => Promise<T>,
  options: {
    abortSignal?: AbortSignal;
    timeoutMs?: number;
    label?: string;
  } = {}
): Promise<T> {
  const label = options.label ?? 'context';
  const timeoutMs = options.timeoutMs ?? resolveCompactionPrepareTimeoutMs();

  if (options.abortSignal?.aborted) {
    throw toAbortError(label, options.abortSignal.reason);
  }

  const timeoutController = new AbortController();
  const timeoutError = new Error(`${label} compaction prepare timed out after ${timeoutMs}ms`);
  const signal = options.abortSignal
    ? AbortSignal.any([options.abortSignal, timeoutController.signal])
    : timeoutController.signal;
  if (signal.aborted) {
    throw toAbortError(label, signal.reason);
  }

  let onAbort: (() => void) | undefined;
  const abortPromise = new Promise<never>((_, reject) => {
    onAbort = () => reject(toAbortError(label, signal.reason));
    signal.addEventListener('abort', onAbort, { once: true });
  });

  const timer = setTimeout(() => {
    timeoutController.abort(timeoutError);
  }, timeoutMs);

  try {
    return await Promise.race([task(signal), abortPromise]);
  } finally {
    clearTimeout(timer);
    if (onAbort) {
      signal.removeEventListener('abort', onAbort);
    }
  }
}
