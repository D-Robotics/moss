import {
  ErrorCode,
  errorMessage,
  isMossError,
  mossErrorToOutcome,
  type MossErrorOutcome,
} from '../../errors.js';
import { classifyLlmError, type LlmErrorCategory } from '../llm/llm-error-classifier.js';

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
    return toMossErrorOutcome(originalError);
  }
  const classified = classifyLlmError(error);
  return {
    code: codeForCategory(classified.category),
    message: errorMessage(error),
    recoverable: classified.category === 'user_abort' || classified.retryable,
  };
}
