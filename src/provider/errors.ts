import { MossError, ErrorCode, isMossError } from '../errors.js';
import { isOverflowMessage } from './overflow-patterns.js';

export type FailoverReason =
  | 'rate_limit'
  | 'auth'
  | 'timeout'
  | 'connection'
  | 'billing'
  | 'format'
  | 'unknown';

/**
 * Unified error response from providers.
 * Providers return this instead of throwing, enabling centralized error handling.
 */
export interface ProviderErrorResponse {
  /** HTTP status code if available (e.g., 401, 429, 500) */
  status?: number;

  /** Machine-readable error code (e.g., 'invalid_api_key', 'context_length_exceeded') */
  code?: string;

  /** Human-readable error message */
  message: string;

  /** Which provider generated this error */
  provider: 'anthropic' | 'openai' | 'pi-ai';

  /** Original error object for debugging */
  originalError?: unknown;

  /** Whether this error is transient and worth retrying */
  retryable: boolean;

  /** Optional retry-after hint in milliseconds */
  retryAfterMs?: number;
}

export class FailoverError extends Error {
  readonly reason: FailoverReason;
  readonly provider?: string;
  readonly model?: string;
  readonly status?: number;

  constructor(
    message: string,
    params: {
      reason: FailoverReason;
      provider?: string;
      model?: string;
      status?: number;
      cause?: unknown;
    }
  ) {
    super(message, { cause: params.cause });
    this.name = 'FailoverError';
    this.reason = params.reason;
    this.provider = params.provider;
    this.model = params.model;
    this.status = params.status;
  }
}

export function isFailoverError(err: unknown): err is FailoverError {
  return err instanceof FailoverError;
}

// ---- HTTP status → 判定 的唯一映射（T5.1 谓词去重）-----------------------
// error-classify（ProviderErrorCategory 视图）与 llm-error-classifier
// （LlmErrorCategory 视图）共享这些判定；三套公开词汇表保持不变。

export function isAuthStatus(status?: number): boolean {
  return status === 401 || status === 403;
}

export function isRateLimitStatus(status?: number): boolean {
  return status === 429;
}

export function isTimeoutStatus(status?: number): boolean {
  return status === 504;
}

export function isServerErrorStatus(status?: number): boolean {
  return status === 500 || status === 502 || status === 503 || status === 529;
}

/**
 * Helper to create a provider error response from HTTP response metadata.
 * Used by providers to classify HTTP errors before throwing.
 */
export function createProviderErrorResponse(
  provider: 'anthropic' | 'openai' | 'pi-ai',
  message: string,
  {
    status,
    code,
    originalError,
    retryAfterMs,
  }: {
    status?: number;
    code?: string;
    originalError?: unknown;
    retryAfterMs?: number;
  } = {}
): ProviderErrorResponse {
  // Determine retryability based on status code and message patterns
  const isRetryable =
    isRateLimitStatus(status) ||
    isServerErrorStatus(status) ||
    isRateLimitError(message) ||
    isTimeoutError(message) ||
    isConnectionError(message) ||
    isServerError(message);

  return {
    message,
    provider,
    status,
    code,
    originalError,
    retryable: isRetryable,
    retryAfterMs,
  };
}

/**
 * Convert a provider error response into a throwable MossError.
 * This bridges the new error response system with legacy error handling.
 */
export function throwProviderErrorResponse(response: ProviderErrorResponse): never {
  const retryHint = response.retryAfterMs ? ` (Retry-After: ${response.retryAfterMs}ms)` : '';
  throw new MossError({
    code: ErrorCode.PROVIDER_UPSTREAM_ERROR,
    message: `${response.provider} API error ${response.status || 'unknown'}${retryHint}: ${response.message}`,
    hint: `The upstream ${response.provider} API returned an error during streaming.`,
    recoverable: response.retryable,
    cause: response.originalError,
    context: {
      provider: response.provider,
      ...(response.status ? { status: response.status } : {}),
      ...(response.code ? { code: response.code } : {}),
    },
  });
}

const RATE_LIMIT_PATTERNS = [
  'rate_limit',
  'rate limit',
  'rate-limit',
  'ratelimit',
  'too many requests',
  '429',
  'exceeded quota',
  'quota',
  'resource exhausted',
  'quota exceeded',
  'resource_exhausted',
  'usage limit',
  'limit exceeded',
];

const TIMEOUT_PATTERNS = [
  'timeout',
  'timed out',
  'deadline exceeded',
  'context deadline exceeded',
  'etimedout',
  'first chunk',
  'first-chunk',
  'first event',
  'first-event',
  'no streaming output',
];

const CONNECTION_PATTERNS = [
  'econnreset',
  'connection reset',
  'econnrefused',
  'socket hang up',
  'network error',
  'networkerror',
  'fetch failed',
  'enotfound',
  'eai_again',
  'epipe',
  'ehostunreach',
  'enetunreach',
  'unreachable',
];

const AUTH_PATTERNS = [
  'invalid_api_key',
  'invalid api key',
  'incorrect api key',
  'bad api key',
  'invalid token',
  'authentication',
  'unauthorized',
  'forbidden',
  'access denied',
  'expired',
  '401',
  '403',
];

const BILLING_PATTERNS = ['402', 'payment required', 'insufficient credits', 'credit balance'];

const FORMAT_PATTERNS = ['string should match pattern', 'invalid request format'];

// Context-overflow patterns moved to overflow-patterns.ts (merged Pi v0.80.3
// per-provider regex patterns + moss Chinese patterns). See isOverflowMessage.

function matchesAny(message: string, patterns: string[]): boolean {
  const lower = message.toLowerCase();
  return patterns.some((p) => lower.includes(p));
}

export function isContextOverflowError(message?: string): boolean {
  if (!message) return false;
  // Delegates to overflow-patterns.ts — merged Pi v0.80.3 per-provider regex
  // patterns (25+) + moss Chinese patterns. The previous inline checks
  // (413+too large, 400+maximum length, etc.) are subsumed by the regex set.
  return isOverflowMessage(message);
}

export function isRateLimitError(message?: string): boolean {
  return !!message && matchesAny(message, RATE_LIMIT_PATTERNS);
}

const QUOTA_EXHAUSTED_PATTERNS = [
  '402',
  'payment required',
  'insufficient credits',
  'credit balance',
  'insufficient_quota',
  'out of credits',
  'plan quota',
  'plan limit',
];

export function isQuotaExceededError(message?: string): boolean {
  if (!message) return false;
  const lower = message.toLowerCase();
  if (matchesAny(lower, QUOTA_EXHAUSTED_PATTERNS)) return true;
  return /exceeded (?:the |your )?(?:monthly |daily |current )?(?:usage )?quota|monthly usage (?:quota|limit)|usage limit (?:exceeded|reached)/.test(
    lower
  );
}

export function isTimeoutError(message?: string): boolean {
  if (!message) return false;
  if (matchesAny(message, TIMEOUT_PATTERNS)) return true;
  // "timedout"/"timed-out" (no space) variants — same judgment as 'timed out'.
  return /\btimed?[ _-]?out\b/i.test(message);
}

export function isConnectionError(message?: string): boolean {
  return !!message && matchesAny(message, CONNECTION_PATTERNS);
}

export function isServerError(message?: string): boolean {
  if (!message) return false;
  return (
    /\b(5\d{2})\b/.test(message) ||
    /overloaded|internal.server.error|bad gateway|service unavailable|gateway timeout|temporarily unavailable|upstream (?:server|gateway) (?:error|busy)|upstream connect error|server is busy|codex\s+stream\s+error/i.test(
      message
    )
  );
}

export function isTransientError(message?: string): boolean {
  if (!message) return false;
  return (
    isRateLimitError(message) ||
    isTimeoutError(message) ||
    isConnectionError(message) ||
    isServerError(message)
  );
}

export function isAuthError(message?: string): boolean {
  if (!message) return false;
  if (matchesAny(message, AUTH_PATTERNS)) return true;
  // "API key is invalid" / "API key not found" word orders (from the
  // error-classify auth vocabulary merged in T5.1).
  return /api key.{0,24}(?:invalid|incorrect|not valid|expired|missing)/i.test(message);
}

// ---- 共享判定谓词（单一来源，T5.1）---------------------------------------
// 组合 status 判定与消息判定；error-classify 与 llm-error-classifier 都以这些
// 谓词为判定来源，仅保留各自的类别词汇表与优先级顺序（视图）。

/** Authentication/authorization failure (401/403 or auth-key message patterns). */
export function isAuthFailure(message?: string, status?: number): boolean {
  return isAuthStatus(status) || isAuthError(message);
}

/** Rate limiting (429 or rate-limit message patterns). */
export function isRateLimitFailure(message?: string, status?: number): boolean {
  return isRateLimitStatus(status) || isRateLimitError(message);
}

/** Timeout (504 or timeout message patterns). */
export function isTimeoutFailure(message?: string, status?: number): boolean {
  return isTimeoutStatus(status) || isTimeoutError(message);
}

/** Server-side failure (5xx family or unavailable/overloaded message patterns). */
export function isServerErrorFailure(message?: string, status?: number): boolean {
  return isServerErrorStatus(status) || isServerError(message);
}

/** User/server abort of an in-flight request ("aborted", "AbortError", …). */
export function isAbortFailure(message?: string): boolean {
  if (!message) return false;
  const lower = message.toLowerCase();
  return (
    lower === 'aborted' ||
    lower.includes('aborterror') ||
    lower.includes('request was aborted') ||
    lower.includes('operation aborted')
  );
}

/**
 * Opaque/truncated stream termination — stream ended without a terminal
 * marker ([DONE]/finish_reason), premature close, or a bare "terminated" /
 * "connection error" drop. llm-error-classifier maps it to 'premature_close';
 * error-classify groups it with service_unavailable.
 */
export function isPrematureStreamClose(message?: string): boolean {
  if (!message) return false;
  return /err_stream_premature_close|premature close|stream closed prematurely|other side closed|stream.*terminated|stream (?:ended|terminated) without (?:\[done\]\s*(?:or\s*)?)?finish_reason|^(?:llm\s+stream\s+error:\s*)?(?:terminated|connection error)\.?$/i.test(
    message
  );
}

/** Thinking-mode history missing reasoning_content (context corruption flavor). */
export function isThinkingHistoryCorruption(message?: string): boolean {
  if (!message) return false;
  const lower = message.toLowerCase();
  return lower.includes('reasoning_content') && lower.includes('thinking mode');
}

export function classifyFailoverReason(message: string): FailoverReason | null {
  if (matchesAny(message, BILLING_PATTERNS)) return 'billing';
  if (matchesAny(message, AUTH_PATTERNS)) return 'auth';
  if (matchesAny(message, RATE_LIMIT_PATTERNS)) return 'rate_limit';
  if (matchesAny(message, TIMEOUT_PATTERNS)) return 'timeout';
  if (matchesAny(message, CONNECTION_PATTERNS)) return 'connection';
  if (matchesAny(message, FORMAT_PATTERNS)) return 'format';
  return null;
}

export function isFailoverErrorMessage(message?: string): boolean {
  if (!message) return false;
  const reason = classifyFailoverReason(message);

  return reason !== null && reason !== 'timeout' && reason !== 'connection';
}

export interface RetryOptions {
  attempts?: number;

  minDelayMs?: number;

  maxDelayMs?: number;

  jitter?: number;

  label?: string;

  shouldRetry?: (err: unknown, attempt: number) => boolean;

  retryDelayMs?: (err: unknown, attempt: number, computedDelayMs: number) => number | undefined;

  onRetry?: (info: { attempt: number; delay: number; error: unknown }) => void;
}

export async function retryAsync<T>(fn: () => Promise<T>, options?: RetryOptions): Promise<T> {
  const attempts = options?.attempts ?? 3;
  const minDelayMs = options?.minDelayMs ?? 300;
  const maxDelayMs = options?.maxDelayMs ?? 30_000;
  const jitter = options?.jitter ?? 0.25;

  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;

      if (attempt === attempts) break;
      if (options?.shouldRetry && !options.shouldRetry(err, attempt)) break;

      let delay = minDelayMs * 2 ** (attempt - 1);

      const errMsg = describeError(err);
      const retryAfterMatch = errMsg.match(/retry.after[:\s]*(\d+)/i);
      if (retryAfterMatch) {
        const retryAfterMs = parseInt(retryAfterMatch[1], 10) * 1000;
        if (retryAfterMs > 0 && retryAfterMs < maxDelayMs * 2) {
          delay = retryAfterMs;
        }
      }

      if (jitter > 0) {
        const offset = (Math.random() * 2 - 1) * jitter;
        delay *= 1 + offset;
      }

      delay = Math.max(Math.min(delay, maxDelayMs), minDelayMs);
      const overrideDelay = options?.retryDelayMs?.(err, attempt, delay);
      if (overrideDelay !== undefined && Number.isFinite(overrideDelay)) {
        delay = Math.max(0, overrideDelay);
      }

      options?.onRetry?.({ attempt, delay, error: err });

      await sleep(delay);
    }
  }

  throw lastError;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function describeError(err: unknown): string {
  // Surface the actionable `.hint` carried by a MossError (e.g. connection
  // hints: DNS / refused / timeout / TLS / proxy). This is the function the
  // agent loop uses to build agent_error / turn-error event payloads that the
  // TUI and headless printer display verbatim, so the hint must be included
  // here for users to ever see it. Matches errorMessage() in errors.ts.
  if (err instanceof Error) {
    if (isMossError(err) && err.hint) return `${err.message}\n→ ${err.hint}`;
    return err.message;
  }
  return String(err);
}
