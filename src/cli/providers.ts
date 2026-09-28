/**
 * CLI provider assembly (D1 convergence): a single transport stack.
 *
 * Every protocol call goes through PiAiLLMProvider over the HTTP transport
 * (`provider/pi-ai-http-transport.ts`), which gives the CLI the pi-ai
 * pipeline for free: first-event watchdog, thinking round-trip policy and
 * anthropic prompt cache-control. Fallback chains still run through
 * MultiProviderRouter around per-config PiAiLLMProvider instances.
 */
import type { CliProviderPreset } from './config.js';
import type { LLMProvider } from '../core/llm/llm-provider.js';
import { PiAiLLMProvider } from '../provider/pi-ai-adapter.js';
import type { PiAiModelInfo } from '../provider/pi-ai-wire-format.js';
import { createHttpStreamFunction } from '../provider/pi-ai-http-transport.js';
import {
  MultiProviderRouter,
  parseFallbackProvidersEnv,
  parseFallbackMaxRetriesEnv,
  parseFallbackCooldownEnv,
  type FallbackProviderConfig,
} from '../provider/multi-provider-router.js';

export { providerError, providerErrorHint } from '../provider/pi-ai-http-transport.js';

export interface CliProviderRuntimeConfig {
  provider: CliProviderPreset;
  apiKey: string;
  model: string;
  baseUrl: string;
  usingBundledDefault?: boolean;

  fallbackProviders?: FallbackProviderConfig[];

  fallbackMaxRetries?: number;

  fallbackCooldownMs?: number;
}

export function normalizeProviderForRuntime(raw: string): CliProviderPreset {
  const lower = raw.trim().toLowerCase();
  if (lower === 'deepseek' || lower === 'ds') return 'deepseek';
  if (lower === 'qwen' || lower === 'aliyun' || lower === 'dashscope') return 'qwen';
  if (lower === 'openai') return 'openai';
  if (lower === 'anthropic' || lower === 'claude') return 'anthropic';
  if (lower === 'openai-compatible' || lower === 'compatible' || lower === 'custom')
    return 'openai-compatible';
  return 'deepseek';
}

function presetToPiModel(preset: CliProviderPreset, model: string): PiAiModelInfo {
  return {
    api: preset === 'anthropic' ? 'anthropic-messages' : 'openai-chat',
    provider: preset,
    id: model,
  };
}

const PROVIDER_ERROR_LABELS: Record<CliProviderPreset, string> = {
  deepseek: 'DeepSeek',
  qwen: 'Qwen',
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  'openai-compatible': 'OpenAI-compatible',
};

export function createCliProvider(config: CliProviderRuntimeConfig): LLMProvider {
  const baseProvider = new PiAiLLMProvider({
    streamFn: createHttpStreamFunction({
      providerLabel: PROVIDER_ERROR_LABELS[config.provider] ?? config.provider,
      apiKey: config.apiKey,
      model: config.model,
      baseUrl: config.baseUrl,
      ...(config.usingBundledDefault ? { usingBundledDefault: true } : {}),
    }),
    model: presetToPiModel(config.provider, config.model),
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    displayName: 'CLI LLM Provider',
  });

  const fallbacks = config.fallbackProviders ?? parseFallbackProvidersEnv();
  if (fallbacks.length > 0) {
    return new MultiProviderRouter({
      primary: baseProvider,
      createProvider: (fbConfig) =>
        createCliProvider({
          provider: normalizeProviderForRuntime(fbConfig.provider),
          apiKey: fbConfig.apiKey ?? config.apiKey,
          model: fbConfig.model ?? config.model,
          baseUrl: fbConfig.baseUrl ?? config.baseUrl,
        }),
      fallbacks,
      maxFallbacks: config.fallbackMaxRetries ?? parseFallbackMaxRetriesEnv(),
      cooldownMs: config.fallbackCooldownMs ?? parseFallbackCooldownEnv(),
    });
  }

  return baseProvider;
}
