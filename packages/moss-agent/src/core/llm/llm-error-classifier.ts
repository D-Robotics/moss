import {
  describeError,
  isContextOverflowError,
  isQuotaExceededError,
  isRateLimitError,
  isTimeoutError,
  isConnectionError,
  isServerError,
  isAuthError,
} from '../../provider/errors.js';

export type LlmErrorCategory =
  | 'context_overflow'
  | 'timeout'
  | 'server_error'
  | 'connection'
  | 'rate_limit'
  | 'auth'
  | 'max_tokens'
  | 'client_error'
  | 'premature_close'
  | 'thinking_history_corrupted'
  | 'user_abort'
  | 'unknown';

export interface LlmErrorClassification {
  category: LlmErrorCategory;
  retryable: boolean;
  message: string;
}

export class LlmRetriesExhaustedError extends Error {
  readonly originalError: unknown;
  readonly attempts: number;

  constructor(originalError: unknown, attempts: number) {
    super(describeError(originalError));
    this.name = 'LlmRetriesExhaustedError';
    this.originalError = originalError;
    this.attempts = attempts;
  }
}

function isAbortLike(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower === 'aborted' || lower.includes('aborterror') || lower.includes('request was aborted')
  );
}

function isPrematureClose(message: string): boolean {
  return /err_stream_premature_close|premature close|stream closed prematurely|other side closed|stream.*terminated|stream (?:ended|terminated) without (?:\[done\]\s*(?:or\s*)?)?finish_reason|^(?:llm\s+stream\s+error:\s*)?terminated\.?$/i.test(
    message
  );
}

function isMaxTokens(message: string): boolean {
  const lower = message.toLowerCase();
  if (!lower.includes('max')) return false;
  return /max[_ -]?(?:output[_ -]?)?tokens?.{0,80}(?:too large|exceeds?|must be|greater than|less than or equal|<=|maximum)|(?:too large|exceeds?|greater than).{0,80}max[_ -]?(?:output[_ -]?)?tokens?/i.test(
    message
  );
}

function isThinkingHistoryCorruption(message: string): boolean {
  const lower = message.toLowerCase();
  return lower.includes('reasoning_content') && lower.includes('thinking mode');
}

function isClientError(message: string): boolean {
  if (isContextOverflowError(message)) return false;
  if (isRateLimitError(message)) return false;
  const lower = message.toLowerCase();
  return (
    /\b4\d{2}\b/.test(lower) ||
    /invalid request|bad request|unsupported|not supported|malformed|schema|tool.*not found|tool result.*not found/i.test(
      message
    )
  );
}

export function classifyLlmError(error: unknown): LlmErrorClassification {
  if (error instanceof LlmRetriesExhaustedError) {
    const original = classifyLlmError(error.originalError);
    return { ...original, retryable: false, message: error.message };
  }
  const message = describeError(error);

  // Avoid relying on provider message text: first-chunk timeout guidance can
  // mention API keys and otherwise look like a non-retryable auth failure.
  // Checking the name avoids a dependency cycle with the stream helper.
  if (error instanceof Error && error.name === 'LlmFirstChunkTimeoutError') {
    return { category: 'timeout', retryable: true, message };
  }
  if (isAbortLike(message)) {
    return { category: 'user_abort', retryable: false, message };
  }
  if (isContextOverflowError(message)) {
    return { category: 'context_overflow', retryable: false, message };
  }
  if (isMaxTokens(message)) {
    return { category: 'max_tokens', retryable: false, message };
  }
  if (isPrematureClose(message)) {
    return { category: 'premature_close', retryable: true, message };
  }
  if (isThinkingHistoryCorruption(message)) {
    return { category: 'thinking_history_corrupted', retryable: true, message };
  }
  if (isQuotaExceededError(message)) {
    return { category: 'client_error', retryable: false, message };
  }
  if (isAuthError(message)) {
    return { category: 'auth', retryable: false, message };
  }
  if (isRateLimitError(message)) {
    return { category: 'rate_limit', retryable: true, message };
  }
  if (isTimeoutError(message)) {
    return { category: 'timeout', retryable: true, message };
  }
  if (isConnectionError(message)) {
    return { category: 'connection', retryable: true, message };
  }
  if (isServerError(message)) {
    return { category: 'server_error', retryable: true, message };
  }
  if (isClientError(message)) {
    return { category: 'client_error', retryable: false, message };
  }

  return { category: 'unknown', retryable: false, message };
}

const RATE_LIMIT_BASE_DELAY_MS = 2_500;
const RATE_LIMIT_MAX_DELAY_MS = 60_000;
const TRANSIENT_BASE_DELAY_MS = 1_000;
const TRANSIENT_MAX_DELAY_MS = 30_000;

function parseServerSuggestedRetryMs(message: string): number | null {
  const m = /(?:retry|try)\s+again\s+in\s+([\d.]+)\s*s/i.exec(message);
  if (m?.[1]) {
    const suggested = parseFloat(m[1]) * 1000;
    if (!Number.isNaN(suggested) && suggested > 0) return suggested;
  }
  const retryAfterHeader = /retry[- ]after:\s*([\d.]+)/i.exec(message);
  if (retryAfterHeader?.[1]) {
    const secs = parseFloat(retryAfterHeader[1]) * 1000;
    if (!Number.isNaN(secs) && secs > 0) return secs;
  }
  return null;
}

export function retryDelayForLlmError(
  classification: LlmErrorClassification,
  attempt: number = 1
): number | undefined {
  if (classification.category === 'rate_limit') {
    const serverHint = parseServerSuggestedRetryMs(classification.message);
    if (serverHint !== null) return Math.min(serverHint, RATE_LIMIT_MAX_DELAY_MS);
    return Math.min(RATE_LIMIT_BASE_DELAY_MS * 2 ** (attempt - 1), RATE_LIMIT_MAX_DELAY_MS);
  }
  if (
    classification.category === 'server_error' ||
    classification.category === 'connection' ||
    classification.category === 'premature_close'
  ) {
    return Math.min(TRANSIENT_BASE_DELAY_MS * 2 ** (attempt - 1), TRANSIENT_MAX_DELAY_MS);
  }
  return undefined;
}
