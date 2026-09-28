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

export {
  PROVIDER_PRESETS,
  parseProviderPreset,
  normalizeProvider,
  inferProviderFromBaseUrl,
} from './provider-presets.js';
export type { CliProviderPreset, ProviderPreset } from './provider-presets.js';

export { PiAiLLMProvider } from './pi-ai-adapter.js';
export type {
  PiAiModelInfo,
  PiAiStreamFunction,
  PiAiStreamEvent,
  PiAiLLMProviderConfig,
} from './pi-ai-adapter.js';

export {
  createHttpStreamFunction,
  providerError,
  providerErrorHint,
} from './pi-ai-http-transport.js';
export type { HttpTransportConfig } from './pi-ai-http-transport.js';

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
