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
import { uiText } from './cli-locale.js';
import type { LLMProvider } from '../core/llm/llm-provider.js';
import { PiAiLLMProvider } from '../provider/pi-ai-adapter.js';
import { endpointHost, primaryKeyAllowedForHost } from '../provider/primary-key-host.js';
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
  if (lower === 'd-robotics' || lower === 'drobotics' || lower === 'digua' || lower === '地瓜') {
    return 'd-robotics';
  }
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
  'd-robotics': 'D-Robotics',
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

  const requested = config.fallbackProviders ?? parseFallbackProvidersEnv();
  const fallbacks: FallbackProviderConfig[] = [];
  for (const fb of requested) {
    const apiKey = fallbackApiKey(fb, config);
    if (apiKey === undefined) {
      const where = fb.baseUrl ?? config.baseUrl;
      console.error(
        uiText(
          `[moss] Dropped fallback provider ${fb.provider} at ${where}: it needs its own apiKey. The primary key is not sent to that host.`,
          `[moss] 已去掉回退服务商 ${fb.provider}（${where}）：它需要自己的 apiKey。主密钥不会发往该主机。`
        )
      );
      continue;
    }
    fallbacks.push({ ...fb, apiKey });
  }
  if (fallbacks.length > 0) {
    return new MultiProviderRouter({
      primary: baseProvider,
      createProvider: (fbConfig) =>
        createCliProvider({
          provider: normalizeProviderForRuntime(fbConfig.provider),
          apiKey: fbConfig.apiKey ?? '',
          model: fbConfig.model ?? config.model,
          baseUrl: fbConfig.baseUrl ?? config.baseUrl,
          // The fallback must not read MOSS_FALLBACK_PROVIDERS again.
          fallbackProviders: [],
        }),
      fallbacks,
      maxFallbacks: config.fallbackMaxRetries ?? parseFallbackMaxRetriesEnv(),
      cooldownMs: config.fallbackCooldownMs ?? parseFallbackCooldownEnv(),
    });
  }

  return baseProvider;
}

/**
 * A fallback on another host must carry its own key. Reusing the primary key
 * would send it to a host the user did not configure.
 */
export function fallbackApiKey(
  fallback: FallbackProviderConfig,
  primary: Pick<CliProviderRuntimeConfig, 'apiKey' | 'baseUrl' | 'provider'>
): string | undefined {
  const baseUrl = fallback.baseUrl ?? primary.baseUrl;
  const host = endpointHost(baseUrl);
  const allowed =
    !host ||
    primaryKeyAllowedForHost(host, {
      baseUrl: primary.baseUrl,
      provider: primary.provider,
    });
  if (allowed) return fallback.apiKey ?? primary.apiKey;
  if (!fallback.apiKey || fallback.apiKey === primary.apiKey) return undefined;
  return fallback.apiKey;
}
