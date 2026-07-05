import { DEFAULT_MODEL } from '@rdk-moss/core';

/**
 * Provider preset definitions — embedded without CLI dependencies.
 *
 * Embedders can import PROVIDER_PRESETS, parseProviderPreset, normalizeProvider,
 * or inferProviderFromBaseUrl directly from `@rdk-moss/agent` without pulling
 * in the CLI config layer.
 */

export type CliProviderPreset =
  | 'deepseek'
  | 'qwen'
  | 'openai'
  | 'anthropic'
  | 'openai-compatible';

export interface ProviderPreset {
  id: CliProviderPreset;
  displayName: string;
  defaultModel: string;
  defaultBaseUrl: string;
}

export const PROVIDER_PRESETS: Record<CliProviderPreset, ProviderPreset> = {
  deepseek: {
    id: 'deepseek',
    displayName: 'DeepSeek',
    defaultModel: 'deepseek-v4-flash',
    defaultBaseUrl: 'https://api.deepseek.com',
  },
  qwen: {
    id: 'qwen',
    displayName: 'Aliyun / Qwen',
    defaultModel: 'qwen3.6-plus',
    defaultBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode',
  },
  openai: {
    id: 'openai',
    displayName: 'OpenAI',
    defaultModel: 'gpt-4o-mini',
    defaultBaseUrl: 'https://api.openai.com',
  },
  anthropic: {
    id: 'anthropic',
    displayName: 'Anthropic',
    defaultModel: DEFAULT_MODEL,
    defaultBaseUrl: 'https://api.anthropic.com',
  },
  'openai-compatible': {
    id: 'openai-compatible',
    displayName: 'OpenAI-compatible',

    defaultModel: '',
    defaultBaseUrl: '',
  },
};

/**
 * Parse a user-supplied provider string into a CliProviderPreset, or null if
 * the value is unrecognised.
 */
export function parseProviderPreset(value: string | undefined): CliProviderPreset | null {
  const raw = (value || '').toLowerCase().trim();
  if (raw === 'deepseek' || raw === 'ds') return 'deepseek';
  if (raw === 'qwen' || raw === 'aliyun' || raw === 'dashscope') return 'qwen';
  if (raw === 'openai') return 'openai';
  if (raw === 'anthropic' || raw === 'claude') return 'anthropic';
  if (raw === 'openai-compatible' || raw === 'compatible' || raw === 'custom') {
    return 'openai-compatible';
  }
  return null;
}

/**
 * Normalise a user-supplied provider string, falling back to 'anthropic' when
 * the value is missing or unrecognised.
 */
export function normalizeProvider(value: string | undefined): CliProviderPreset {
  return parseProviderPreset(value) ?? 'anthropic';
}

/**
 * Try to infer the provider id from a base-url string.  Returns null when the
 * url is empty or doesn't match any known pattern.
 */
export function inferProviderFromBaseUrl(baseUrl: string | undefined): CliProviderPreset | null {
  const raw = (baseUrl || '').toLowerCase();
  if (!raw) return null;
  if (raw.includes('deepseek.com')) return 'deepseek';
  if (raw.includes('aliyuncs.com') || raw.includes('dashscope') || raw.includes('token-plan')) {
    return 'qwen';
  }
  if (raw.includes('api.openai.com')) return 'openai';
  if (raw.includes('anthropic.com')) return 'anthropic';
  return 'openai-compatible';
}