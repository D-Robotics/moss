









import { combineAbortSignals } from '../core/agent/abort.js';
import { envPreferMoss } from '../utils/env-compat.js';

const FIRST_EVENT_TIMEOUT_MS_DEFAULT = 45_000;
const FIRST_EVENT_TIMEOUT_MS_MIN = 5_000;
const FIRST_EVENT_TIMEOUT_MS_MAX = 600_000;










export class PiAiFirstEventTimeoutError extends Error {
  readonly timeoutMs: number;
  readonly provider: string;
  readonly model: string;
  constructor(params: { timeoutMs: number; provider: string; model: string }) {
    super(
      `pi-ai (${params.provider} / ${params.model}) 在 ${Math.round(params.timeoutMs / 1000)}s 内未吐出任何流事件，` +
        `大半是上游网关在 429/超载/超时后内部反复重试。已主动中止本次调用，建议稍后再试或换一个模型/供应商。`
    );
    this.name = 'PiAiFirstEventTimeoutError';
    this.timeoutMs = params.timeoutMs;
    this.provider = params.provider;
    this.model = params.model;
  }
}

export function resolveFirstEventTimeoutMs(): number {
  const raw = envPreferMoss('MOSS_PI_AI_FIRST_EVENT_TIMEOUT_MS', 'PI_AI_FIRST_EVENT_TIMEOUT_MS');
  if (raw == null) return FIRST_EVENT_TIMEOUT_MS_DEFAULT;
  const s = String(raw).trim();
  if (!s) return FIRST_EVENT_TIMEOUT_MS_DEFAULT;
  const n = Number.parseInt(s, 10);
  if (!Number.isFinite(n)) return FIRST_EVENT_TIMEOUT_MS_DEFAULT;
  if (n <= 0) return 0; 
  return Math.min(FIRST_EVENT_TIMEOUT_MS_MAX, Math.max(FIRST_EVENT_TIMEOUT_MS_MIN, n));
}







export function startFirstEventWatchdog(
  callerSignal?: AbortSignal,
  modelInfo?: { provider?: string; id?: string }
): {
  signal: AbortSignal | undefined;
  onActivity: () => void;
  dispose: () => void;
  translateError: (err: unknown) => unknown;
} {
  const timeoutMs = resolveFirstEventTimeoutMs();
  if (timeoutMs <= 0) {
    return {
      signal: callerSignal,
      onActivity: () => {},
      dispose: () => {},
      translateError: (err) => err,
    };
  }

  const ctrl = new AbortController();
  let firedByTimeout = false;
  let timer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
    firedByTimeout = true;
    try {
      ctrl.abort();
    } catch {
      
    }
  }, timeoutMs);

  const combined = combineAbortSignals(callerSignal, ctrl.signal) ?? ctrl.signal;

  const clear = () => {
    if (timer != null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  return {
    signal: combined,
    onActivity: () => {
      clear();
      
      if (!firedByTimeout) {
        const interEventMs = Math.min(timeoutMs, 30_000);
        timer = setTimeout(() => {
          firedByTimeout = true;
          try {
            ctrl.abort();
          } catch {
            
          }
        }, interEventMs);
      }
    },
    dispose: () => {
      clear();
    },
    translateError: (err: unknown) => {
      if (!firedByTimeout) return err;
      if (callerSignal?.aborted) return err;
      return new PiAiFirstEventTimeoutError({
        timeoutMs,
        provider: modelInfo?.provider ?? 'unknown',
        model: modelInfo?.id ?? 'unknown',
      });
    },
  };
}
