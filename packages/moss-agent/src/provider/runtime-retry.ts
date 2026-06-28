



































import type { ProviderErrorCategory, ProviderErrorSurface } from './error-classify.js';
import { classifyProviderError } from './error-classify.js';
import type { ProviderErrorResponse } from './errors.js';

/**
 * Helper to classify a provider error response directly.
 * Wraps the error classification logic to work with ProviderErrorResponse.
 */
export function classifyProviderErrorResponse(response: ProviderErrorResponse): ProviderErrorSurface {
  return classifyProviderError({
    errorMessage: response.message,
    status: response.status,
    code: response.code,
    provider: response.provider,
    providerErrorResponse: response,
  });
}

export interface RuntimeRetryInfo {
  
  attempt: number;
  
  category: ProviderErrorCategory;
  
  backoffMs: number;
  

  willRetry: boolean;
}

export interface RuntimeRetryOptions {
  



  classify: (err: unknown) => ProviderErrorSurface;
  



  onRetry?: (info: RuntimeRetryInfo) => void;
  



  backoffMs?: [number, number];
  




  shouldRetry?: (surface: ProviderErrorSurface) => boolean;
  


  signal?: AbortSignal;
  



  maxAttempts?: 1;
}

const DEFAULT_BACKOFF: [number, number] = [800, 2000];

function jitteredBackoff(range: [number, number]): number {
  const [min, max] = range;
  if (max <= min) return min;
  
  const jitter = Math.random() * (max - min);
  return Math.floor(min + jitter);
}

function delayWithSignal(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error('aborted'));
      return;
    }
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      cleanup();
      reject(signal?.reason ?? new Error('aborted'));
    };
    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}







export async function runWithProviderRetry<T>(
  fn: () => Promise<T>,
  opts: RuntimeRetryOptions
): Promise<T> {
  if (opts.signal?.aborted) {
    throw opts.signal.reason ?? new Error('aborted');
  }

  let lastError: unknown;
  try {
    return await fn();
  } catch (err) {
    lastError = err;
  }

  
  if (opts.signal?.aborted) {
    throw opts.signal.reason ?? lastError;
  }

  const surface = opts.classify(lastError);

  const allowed = surface.retryable && (opts.shouldRetry ? opts.shouldRetry(surface) : true);

  const backoffMs = jitteredBackoff(opts.backoffMs ?? DEFAULT_BACKOFF);

  if (!allowed) {
    
    opts.onRetry?.({
      attempt: 1,
      category: surface.category,
      backoffMs: 0,
      willRetry: false,
    });
    throw lastError;
  }

  
  opts.onRetry?.({
    attempt: 1,
    category: surface.category,
    backoffMs,
    willRetry: true,
  });

  try {
    await delayWithSignal(backoffMs, opts.signal);
  } catch (waitErr) {
    
    throw lastError;
  }

  if (opts.signal?.aborted) {
    throw opts.signal.reason ?? lastError;
  }

  
  try {
    return await fn();
  } catch (retryErr) {
    
    const retrySurface = opts.classify(retryErr);
    opts.onRetry?.({
      attempt: 1,
      category: retrySurface.category,
      backoffMs: 0,
      willRetry: false,
    });
    throw retryErr;
  }
}
