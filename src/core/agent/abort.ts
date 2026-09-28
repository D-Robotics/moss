import type { Tool, ToolContext } from '../tools/tool-types.js';
import { MossError, ErrorCode } from '../../errors.js';
import { combineAbortSignals } from '../../utils/abort-signals.js';

export { combineAbortSignals };

export function wrapToolWithAbortSignal<T>(tool: Tool<T>, runSignal: AbortSignal): Tool<T> {
  const original = tool.execute;
  return {
    ...tool,
    async execute(input: T, ctx: ToolContext): Promise<string> {
      const combined = combineAbortSignals(ctx.abortSignal, runSignal);
      if (combined?.aborted) {
        throw new MossError({ code: ErrorCode.USER_ABORTED, message: 'Operation aborted' });
      }
      return original(input, { ...ctx, abortSignal: combined });
    },
  };
}

export function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted)
    return Promise.reject(
      new MossError({ code: ErrorCode.USER_ABORTED, message: 'Operation aborted' })
    );
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort);
      reject(new MossError({ code: ErrorCode.USER_ABORTED, message: 'Operation aborted' }));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      }
    );
  });
}
