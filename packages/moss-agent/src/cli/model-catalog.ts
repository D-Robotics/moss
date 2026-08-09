import fs from 'node:fs';
import { buildApiV1Url, isHttpUrl, stripEndpointSuffix } from '../provider/api-v1-url.js';
import { readCachedRealModel } from './model-resolution.js';
import { readPreferredModel } from './preferred-model-store.js';
import {
  normalizeProvider,
  PROVIDER_PRESETS,
  CONSERVATIVE_DEFAULT_UNPROBED,
  type CliProviderPreset,
  type ResolvedCliConfig,
} from './config.js';

export interface ModelChoice {
  provider: CliProviderPreset;
  model: string;
  label?: string;
  source: 'live' | 'built-in' | 'common' | 'current';
}

export interface ModelChoiceList {
  provider: CliProviderPreset;
  providerLabel: string;
  currentModel: string;
  choices: ModelChoice[];
  source: 'live' | 'built-in' | 'common';
  configPath?: string;

  configPathExists?: boolean;

  usingBundledDefault?: boolean;

  realModel?: string;
  warning?: string;
}

export function describeModelListSource(list: ModelChoiceList): string {
  const origin =
    list.source === 'live'
      ? list.usingBundledDefault
        ? 'live from the built-in Moss gateway'
        : 'live from the provider /v1/models'
      : list.source === 'built-in'
        ? 'built-in Moss gateway defaults'
        : 'your configured model only (no live list available)';
  if (list.usingBundledDefault) {
    return `models: ${origin} · no user model config (run moss setup to use your own)`;
  }
  if (list.configPath && list.configPathExists === false) {
    return `models: ${origin} · config file deleted (${list.configPath}) — provider fell back to defaults`;
  }
  return `models: ${origin}${list.configPath ? ` · config ${list.configPath}` : ''}`;
}

export interface CustomModelConfig {
  provider: CliProviderPreset;
  model: string;
  baseUrl: string;
  apiKey: string;
}

export type CustomModelConfigParseResult =
  | { ok: true; config: CustomModelConfig }
  | { ok: false; message: string };

function uniqueModels(models: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of models) {
    const model = raw.trim();
    if (!model || seen.has(model)) continue;
    seen.add(model);
    out.push(model);
  }
  return out;
}

function sanitizeModelBaseUrl(value: string): string {
  const trimmed = value.trim();
  try {
    const url = new URL(trimmed);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/+$/, '').replace(/\/v1$/, '');
  } catch {
    return trimmed.replace(/\/+$/, '').replace(/\/v1$/, '');
  }
}

function tokenizeConfigInput(input: string): string[] {
  const tokens: string[] = [];
  const pattern = /"((?:\\"|[^"])*)"|'((?:\\'|[^'])*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(input)) !== null) {
    const value = match[1] ?? match[2] ?? match[3] ?? '';
    tokens.push(value.replace(/\\(["'])/g, '$1'));
  }
  return tokens;
}

function normalizeConfigInputKey(raw: string): 'provider' | 'model' | 'baseUrl' | 'apiKey' | null {
  const key = raw.trim().replace(/[-_]/g, '').toLowerCase();
  if (key === 'provider') return 'provider';
  if (key === 'model' || key === 'modelname' || key === 'name') return 'model';
  if (key === 'baseurl' || key === 'url' || key === 'endpoint') return 'baseUrl';
  if (key === 'key' || key === 'apikey' || key === 'token') return 'apiKey';
  return null;
}

export function parseCustomModelConfigInput(input: string): CustomModelConfigParseResult {
  const values: Partial<Record<keyof CustomModelConfig, string>> = {};
  const tokens = tokenizeConfigInput(input);
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i] ?? '';
    const eqIdx = token.indexOf('=');
    if (eqIdx !== -1) {
      const key = normalizeConfigInputKey(token.slice(0, eqIdx));
      if (key) values[key] = token.slice(eqIdx + 1);
      continue;
    }
    const key = normalizeConfigInputKey(token);
    if (key && tokens[i + 1] && !tokens[i + 1]!.includes('=')) {
      values[key] = tokens[i + 1];
      i += 1;
    }
  }

  const missing: string[] = [];
  if (!values.baseUrl) missing.push('base_url');
  if (!values.apiKey) missing.push('api key');
  if (!values.model) missing.push('model_name');
  if (missing.length > 0) {
    return {
      ok: false,
      message: `Missing ${missing.join(', ')}. Provide: base_url=<url> key=<api-key> model_name=<model>.`,
    };
  }
  const baseUrl = values.baseUrl;
  const apiKey = values.apiKey;
  const model = values.model;
  if (!baseUrl || !apiKey || !model) {
    return { ok: false, message: 'Missing base_url, api key, or model_name.' };
  }
  if (!isHttpUrl(baseUrl)) {
    return {
      ok: false,
      message: `Invalid base_url: ${baseUrl}. Use a full http(s) URL, e.g. https://your-gateway.example/v1.`,
    };
  }

  return {
    ok: true,
    config: {
      provider: normalizeProvider(values.provider || 'openai-compatible'),
      baseUrl: sanitizeModelBaseUrl(baseUrl),
      apiKey,
      model,
    },
  };
}

export function formatCustomModelConfigInstructions(configPath?: string): string {
  const presetLine = (p: CliProviderPreset): string => {
    const preset = PROVIDER_PRESETS[p];
    return `  ${preset.displayName.padEnd(10)} /model config provider=${p} base_url=${preset.defaultBaseUrl} model_name=${preset.defaultModel} key=<paste-your-key>`;
  };
  return [
    'Add your own model & key',
    `  config file  ${configPath || '(default user config)'}`,
    '',
    'Pick your provider, paste your key after key=, and press Enter:',
    presetLine('deepseek'),
    presetLine('qwen'),
    presetLine('openai'),
    '  Custom     /model config base_url=<url> model_name=<model> key=<api-key>',
    '',
    'Or run `moss setup` for a guided prompt with a hidden key field.',
  ].join('\n');
}

function providerFromRuntime(
  config?: Partial<ResolvedCliConfig>,
  fallbackProvider?: string
): CliProviderPreset {
  return normalizeProvider(config?.provider || fallbackProvider || 'openai-compatible');
}

export function commonModelChoices(
  provider: CliProviderPreset,
  currentModel = '',
  options: { usingBundledDefault?: boolean; configModel?: string } = {}
): ModelChoice[] {
  const models = uniqueModels([
    currentModel,
    options.configModel || '',
    options.usingBundledDefault ? 'Moss' : '',
    PROVIDER_PRESETS[provider].defaultModel,
  ]);
  return models.map((model) => ({
    provider,
    model,
    label:
      model === 'Moss' && options.usingBundledDefault ? 'built-in D-Robotics model' : undefined,
    source:
      model === currentModel
        ? 'current'
        : model === 'Moss' && options.usingBundledDefault
          ? 'built-in'
          : model === options.configModel
            ? 'common'
            : 'common',
  }));
}

function parseModelIds(payload: unknown): string[] {
  if (!payload || typeof payload !== 'object') return [];
  const data = (payload as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];
  const models: string[] = [];
  for (const item of data) {
    if (!item || typeof item !== 'object') continue;
    const id = (item as { id?: unknown; name?: unknown }).id;
    const name = (item as { id?: unknown; name?: unknown }).name;
    if (typeof id === 'string' && id.trim()) models.push(id.trim());
    else if (typeof name === 'string' && name.trim()) models.push(name.trim());
  }
  return uniqueModels(models);
}

async function fetchOpenAiCompatibleModels(
  config: Partial<ResolvedCliConfig>,
  options: { timeoutMs?: number; fetchImpl?: typeof fetch } = {}
): Promise<string[]> {
  if (!config.baseUrl || !config.apiKey) return [];
  const timeoutMs = options.timeoutMs ?? 2500;
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(buildApiV1Url(config.baseUrl, 'models'), {
      headers: { Authorization: `Bearer ${config.apiKey}` },
      signal: controller.signal,
    });
    if (!res.ok) return [];
    return parseModelIds(await res.json());
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

export async function loadModelChoicesForRuntime(
  config?: Partial<ResolvedCliConfig>,
  currentModel = '',
  options: { fallbackProvider?: string; timeoutMs?: number; fetchImpl?: typeof fetch } = {}
): Promise<ModelChoiceList> {
  const provider = providerFromRuntime(config, options.fallbackProvider);
  const providerLabel = PROVIDER_PRESETS[provider].displayName;
  const canFetchLive = provider !== 'anthropic' && Boolean(config?.baseUrl && config?.apiKey);
  const liveModels = canFetchLive
    ? await fetchOpenAiCompatibleModels(config ?? {}, {
        timeoutMs: options.timeoutMs,
        fetchImpl: options.fetchImpl,
      })
    : [];
  const configPathExists = config?.configPath ? fs.existsSync(config.configPath) : undefined;

  const realModel = config?.usingBundledDefault
    ? (readCachedRealModel({
        baseUrl: config.baseUrl,
        model: config.model,
        usingBundledDefault: true,
      }) ?? undefined)
    : undefined;
  if (liveModels.length > 0) {
    const configuredModel = currentModel || config?.model || '';
    const configuredModelAvailable = !configuredModel || liveModels.includes(configuredModel);
    const candidates = configuredModelAvailable ? [currentModel, config?.model ?? ''] : [];
    const choices = uniqueModels([...candidates, ...liveModels])
      .slice(0, 50)
      .map(
        (model): ModelChoice => ({
          provider,
          model,
          source: model === currentModel ? 'current' : model === config?.model ? 'common' : 'live',
        })
      );
    return {
      provider,
      providerLabel,
      currentModel,
      choices,
      source: 'live',
      configPath: config?.configPath,
      configPathExists,
      usingBundledDefault: config?.usingBundledDefault,
      realModel,
      warning: !configuredModelAvailable
        ? `"${configuredModel}" is not available from this gateway — select a model below to continue`
        : undefined,
    };
  }
  return {
    provider,
    providerLabel,
    currentModel,
    choices: commonModelChoices(provider, currentModel, {
      usingBundledDefault: config?.usingBundledDefault,
      configModel: config?.model,
    }),
    source: config?.usingBundledDefault ? 'built-in' : 'common',
    configPath: config?.configPath,
    configPathExists,
    usingBundledDefault: config?.usingBundledDefault,
    realModel,
    warning: canFetchLive
      ? 'Live model list was unavailable; showing only your configured model. Add models with `moss setup` or /model config.'
      : undefined,
  };
}

export async function autoSelectGatewayModel(
  config: Partial<ResolvedCliConfig>,
  options: { timeoutMs?: number; fetchImpl?: typeof fetch; env?: NodeJS.ProcessEnv } = {}
): Promise<string> {
  if (config.usingBundledDefault || !config.baseUrl || !config.apiKey) return '';
  const list = await loadModelChoicesForRuntime(config, '', {
    timeoutMs: options.timeoutMs,
    fetchImpl: options.fetchImpl,
  });
  if (list.source !== 'live') return '';
  const liveModels = list.choices.map((choice) => choice.model).filter(Boolean);
  if (liveModels.length === 0) return '';

  const preferred = readPreferredModel(config.baseUrl, options.env);
  if (preferred && liveModels.includes(preferred)) return preferred;
  return liveModels[0]!;
}

export function resolveModelSelection(
  input: string,
  choices: readonly ModelChoice[]
): ModelChoice | null {
  const raw = input.trim();
  if (!raw) return null;
  const numeric = Number.parseInt(raw, 10);
  if (/^\d+$/.test(raw) && numeric >= 1 && numeric <= choices.length)
    return choices[numeric - 1] ?? null;
  const normalized = raw.toLowerCase();
  const providerQualified = normalized.includes('/') ? normalized : '';
  return (
    choices.find((choice) => {
      if (choice.model.toLowerCase() === normalized) return true;
      return providerQualified === `${choice.provider}/${choice.model}`.toLowerCase();
    }) ?? null
  );
}

export function formatModelChoices(list: ModelChoiceList): string {
  const configFileLine = list.configPath
    ? `${list.configPath}${list.configPathExists === false ? ' (not present — using defaults)' : ''}`
    : '(default user config)';
  const lines = [
    'Models',
    `  active provider  ${list.providerLabel} (${list.provider})${list.usingBundledDefault ? ' · built-in Moss gateway' : ''}`,
    `  current model    ${list.currentModel || '(not set)'}${list.usingBundledDefault && list.realModel ? ` (real backing model: ${list.realModel})` : ''}`,
    `  config file      ${configFileLine}`,
    `  ${describeModelListSource(list)}`,
  ];
  if (list.warning) lines.push(`  note             ${list.warning}`);
  lines.push('', 'Choose for this session:');
  list.choices.forEach((choice, index) => {
    const current = choice.model === list.currentModel ? ' current' : '';
    const label = choice.label ? ` - ${choice.label}` : '';
    lines.push(`  ${String(index + 1).padStart(2, ' ')}. ${choice.model}${label}${current}`);
  });
  lines.push(
    '',
    'Use:',
    '  /model <number>        choose one of the models above',
    '  /model <model-name>    use a custom model name for this session',
    '  /model config base_url=<url> key=<api-key> model_name=<model>',
    '  moss setup             change provider, base URL, or API key'
  );
  return lines.join('\n');
}

function isOllamaBaseUrl(baseUrl: string | undefined): boolean {
  const raw = (baseUrl ?? '').toLowerCase();
  return raw.includes(':11434') || raw.includes('/ollama');
}

function parseOllamaContextLength(body: unknown): number | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const info = (body as Record<string, unknown>).model_info;
  if (!info || typeof info !== 'object') return undefined;
  for (const [key, value] of Object.entries(info as Record<string, unknown>)) {
    if (key.endsWith('.context_length') && typeof value === 'number' && value > 0) {
      return value;
    }
  }
  return undefined;
}

function parseOpenAiCompatibleContextLength(body: unknown, modelId: string): number | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const data = (body as Record<string, unknown>).data;
  if (!Array.isArray(data)) return undefined;
  const lower = modelId.toLowerCase();
  for (const entry of data) {
    if (!entry || typeof entry !== 'object') continue;
    const id = (entry as Record<string, unknown>).id;
    if (typeof id !== 'string' || id.toLowerCase() !== lower) continue;

    const maxLen = (entry as Record<string, unknown>).max_model_len;
    if (typeof maxLen === 'number' && maxLen > 0) return maxLen;
    const ctxLen = (entry as Record<string, unknown>).context_length;
    if (typeof ctxLen === 'number' && ctxLen > 0) return ctxLen;
    const ctxWin = (entry as Record<string, unknown>).context_window;
    if (typeof ctxWin === 'number' && ctxWin > 0) return ctxWin;
  }
  return undefined;
}

export async function resolveModelContextWindowFromApi(params: {
  baseUrl?: string;
  apiKey?: string;
  model: string;
  provider?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<number | undefined> {
  const { baseUrl, apiKey, model } = params;
  if (!baseUrl || !model) return undefined;

  const timeoutMs = params.timeoutMs ?? 3000;
  const fetchImpl = params.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    if (isOllamaBaseUrl(baseUrl)) {
      const ollamaBase = stripEndpointSuffix(baseUrl).replace(/\/v1$/i, '');
      const res = await fetchImpl(`${ollamaBase}/api/show`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: model }),
        signal: controller.signal,
      });
      if (!res.ok) return undefined;
      return parseOllamaContextLength(await res.json());
    }

    if (apiKey) {
      const res = await fetchImpl(buildApiV1Url(baseUrl, 'models'), {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: controller.signal,
      });
      if (!res.ok) return undefined;
      return parseOpenAiCompatibleContextLength(await res.json(), model);
    }
  } catch {
  } finally {
    clearTimeout(timer);
  }
  return undefined;
}

export async function resolveContextTokensForModel(params: {
  model: string;
  baseUrl?: string;
  apiKey?: string;
  provider?: string;

  explicitOverride?: number;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<{ contextTokens: number; source: string }> {
  if (params.explicitOverride && params.explicitOverride > 0) {
    return { contextTokens: params.explicitOverride, source: 'user-override' };
  }

  const fromApi = await resolveModelContextWindowFromApi(params);
  if (fromApi && fromApi > 0) {
    return { contextTokens: fromApi, source: 'provider-api' };
  }

  // Do NOT fall back to the static name-matching table. It goes stale as
  // provider models change (e.g. deepseek-v4-flash is 1M, not 64k). Be
  // honest: we couldn't probe, so return the conservative unprobed default.
  // The caller (doctor, TUI /model switch) will surface this to the user.
  return { contextTokens: CONSERVATIVE_DEFAULT_UNPROBED, source: 'unprobed' };
}
