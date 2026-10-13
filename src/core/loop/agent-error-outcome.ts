import {
  ErrorCode,
  errorMessage,
  isMossError,
  mossErrorToOutcome,
  type MossErrorOutcome,
} from '../../errors.js';
import {
  classifyLlmError,
  LlmRetriesExhaustedError,
  type LlmErrorCategory,
} from '../../provider/llm-error-classifier.js';

function codeForCategory(category: LlmErrorCategory): ErrorCode {
  if (category === 'auth') return ErrorCode.PROVIDER_AUTH_FAILED;
  if (category === 'rate_limit') return ErrorCode.PROVIDER_RATE_LIMITED;
  if (category === 'context_overflow') return ErrorCode.PROVIDER_CONTEXT_OVERFLOW;
  if (category === 'user_abort') return ErrorCode.USER_ABORTED;
  if (category === 'unknown') return ErrorCode.UNKNOWN;
  return ErrorCode.PROVIDER_UPSTREAM_ERROR;
}

/** Preserve stable error identity while excluding causes, stacks, and raw context. */
export function toMossErrorOutcome(error: unknown): MossErrorOutcome {
  if (isMossError(error)) {
    return mossErrorToOutcome(error);
  }
  const originalError =
    error && typeof error === 'object' && 'originalError' in error
      ? (error as { originalError?: unknown }).originalError
      : undefined;
  if (originalError !== undefined && originalError !== error) {
    const inner = toMossErrorOutcome(originalError);
    // O114: a mid-stream stall that already exhausted its retries is no longer
    // recoverable. Scoped to that case only — other wrapped errors keep their
    // own recoverable semantics (e.g. a recoverable rate-limit MossError).
    if (
      error instanceof LlmRetriesExhaustedError &&
      originalError instanceof Error &&
      originalError.name === 'PiAiFirstEventTimeoutError' &&
      (originalError as { phase?: unknown }).phase === 'inter'
    ) {
      return { ...inner, recoverable: false };
    }
    return inner;
  }
  const classified = classifyLlmError(error);
  return {
    code: codeForCategory(classified.category),
    message: errorMessage(error),
    recoverable: classified.category === 'user_abort' || classified.retryable,
  };
}
