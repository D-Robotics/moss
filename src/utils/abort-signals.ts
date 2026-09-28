export function combineAbortSignals(a?: AbortSignal, b?: AbortSignal): AbortSignal | undefined {
  if (!a && !b) return undefined;
  if (a && !b) return a;
  if (b && !a) return b;
  if (a?.aborted) return a;
  if (b?.aborted) return b;

  if (typeof AbortSignal.any === 'function') {
    return AbortSignal.any([a as AbortSignal, b as AbortSignal]);
  }

  const controller = new AbortController();
  const onAbortA = () => {
    b?.removeEventListener('abort', onAbortB);
    controller.abort();
  };
  const onAbortB = () => {
    a?.removeEventListener('abort', onAbortA);
    controller.abort();
  };
  a?.addEventListener('abort', onAbortA, { once: true });
  b?.addEventListener('abort', onAbortB, { once: true });
  return controller.signal;
}
