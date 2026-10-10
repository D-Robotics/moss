import { DEFAULT_MODEL } from '../contracts/index.js';
import { cleanGatewayUrl } from './api-v1-url.js';

/**
 * Provider preset definitions — embedded without CLI dependencies.
 *
 * Embedders can import PROVIDER_PRESETS, parseProviderPreset, normalizeProvider,
 * or inferProviderFromBaseUrl directly from the package root without pulling
 * in the CLI config layer.
 */

export type CliProviderPreset =
  | 'deepseek'
  | 'qwen'
  | 'openai'
  | 'anthropic'
  | 'openai-compatible'
  | 'd-robotics';

export interface ProviderPreset {
  id: CliProviderPreset;
  displayName: string;
  defaultModel: string;
  defaultBaseUrl: string;
  /**
   * Environment variables that hold this provider's own key, in offer order.
   * A custom base URL does not read these unless the user config names one
   * with `apiKeyEnv`.
   */
  envKeys?: readonly string[];
  /** Optional env var that overrides the preset base URL for first-run offers. */
  envBaseUrl?: string;
}

export const PROVIDER_PRESETS: Record<CliProviderPreset, ProviderPreset> = {
  deepseek: {
    id: 'deepseek',
    displayName: 'DeepSeek',
    defaultModel: 'deepseek-v4-flash',
    defaultBaseUrl: 'https://api.deepseek.com',
    envKeys: ['DEEPSEEK_API_KEY'],
    envBaseUrl: 'DEEPSEEK_BASE_URL',
  },
  qwen: {
    id: 'qwen',
    displayName: 'Aliyun / Qwen',
    defaultModel: 'qwen3.6-plus',
    defaultBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode',
    envKeys: ['DASHSCOPE_API_KEY', 'ALIYUN_API_KEY', 'QWEN_API_KEY'],
    envBaseUrl: 'DASHSCOPE_BASE_URL',
  },
  openai: {
    id: 'openai',
    displayName: 'OpenAI',
    defaultModel: 'gpt-4o-mini',
    defaultBaseUrl: 'https://api.openai.com',
    envKeys: ['OPENAI_API_KEY'],
    envBaseUrl: 'OPENAI_BASE_URL',
  },
  anthropic: {
    id: 'anthropic',
    displayName: 'Anthropic',
    defaultModel: DEFAULT_MODEL,
    defaultBaseUrl: 'https://api.anthropic.com',
    envKeys: ['ANTHROPIC_API_KEY'],
    envBaseUrl: 'ANTHROPIC_BASE_URL',
  },
  'openai-compatible': {
    id: 'openai-compatible',
    displayName: 'OpenAI-compatible',

    defaultModel: '',
    defaultBaseUrl: '',
  },
  'd-robotics': {
    id: 'd-robotics',
    displayName: 'D-Robotics 地瓜网关',
    defaultModel: 'deepseek-flash',
    defaultBaseUrl: 'https://ai-api.d-robotics.cc/v1',
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
  if (raw === 'd-robotics' || raw === 'drobotics' || raw === 'digua' || raw === '地瓜') {
    return 'd-robotics';
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
function canonicalBase(value: string): string {
  return cleanGatewayUrl(value).toLowerCase();
}

/** True when `baseUrl` is that preset's published endpoint, not a custom host. */
export function isOfficialPresetBaseUrl(provider: CliProviderPreset, baseUrl: string): boolean {
  const official = PROVIDER_PRESETS[provider]?.defaultBaseUrl ?? '';
  if (!official || !baseUrl.trim()) return false;
  return canonicalBase(baseUrl) === canonicalBase(official);
}

export function inferProviderFromBaseUrl(baseUrl: string | undefined): CliProviderPreset | null {
  const raw = (baseUrl || '').toLowerCase();
  if (!raw) return null;
  if (raw.includes('deepseek.com')) return 'deepseek';
  if (raw.includes('aliyuncs.com') || raw.includes('dashscope') || raw.includes('token-plan')) {
    return 'qwen';
  }
  if (raw.includes('d-robotics.cc')) return 'd-robotics';
  if (raw.includes('api.openai.com')) return 'openai';
  if (raw.includes('anthropic.com')) return 'anthropic';
  return 'openai-compatible';
}
