export {
  FailoverError,
  isFailoverError,
  isContextOverflowError,
  isRateLimitError,
  isTimeoutError,
  isConnectionError,
  isServerError,
  isTransientError,
  isAuthError,
  classifyFailoverReason,
  isFailoverErrorMessage,
  retryAsync,
  describeError,
} from './errors.js';

export type { FailoverReason, RetryOptions } from './errors.js';


export type {
  LLMProvider,
  LLMRequestOptions,
  LLMResponse,
  LLMStreamEvent,
  LLMMessage,
  LLMContentBlock,
  LLMToolDeclaration,
} from '../core/llm/llm-provider.js';


export { PiAiLLMProvider } from './pi-ai-adapter.js';
export type {
  PiAiModelInfo,
  PiAiStreamFunction,
  PiAiStreamEvent,
  PiAiLLMProviderConfig,
} from './pi-ai-adapter.js';


export { AnthropicLLMProvider } from './anthropic.js';
export type { AnthropicLLMProviderConfig } from './anthropic.js';
export { OpenAILLMProvider } from './openai.js';
export type { OpenAILLMProviderConfig } from './openai.js';


export {
  ensureKeepAliveDispatcherInstalled,
  wasConnectionReused,
} from './keep-alive-dispatcher.js';


export { runWithProviderRetry } from './runtime-retry.js';
export type { RuntimeRetryOptions, RuntimeRetryInfo } from './runtime-retry.js';


export {
  classifyProviderError,
  renderProviderErrorSurface,
  sanitizeRawErrorForDetail,
} from './error-classify.js';
export type {
  ProviderErrorCategory,
  ProviderErrorAction,
  ProviderErrorSurface,
  ProviderErrorInput,
} from './error-classify.js';
