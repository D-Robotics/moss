/**
 * Provider keys already in the environment. The offer the user sees names the
 * variable, never the value. Saving an accepted offer stores `apiKeyEnv`, not
 * a copy of the value.
 */
import { cleanGatewayUrl } from '../provider/api-v1-url.js';
import {
  PROVIDER_PRESETS,
  inferProviderFromBaseUrl,
  isOfficialPresetBaseUrl,
  type CliProviderPreset,
} from '../provider/provider-presets.js';
import { envBeforeDotenv } from '../utils/startup-env.js';

export interface DetectedCredential {
  id: string;
  provider: CliProviderPreset;
  /** Shown to the user. Must not contain the key. */
  label: string;
  keyVar: string;
  baseUrl: string;
  baseUrlVar?: string;
  model: string;
  /** Gateway-style keys have no preset model; the user picks from /v1/models. */
  needsModelList: boolean;
  apiKey: string;
}

/** Same fields, with the secret removed so a view model cannot print it. */
export type PublicOffer = Omit<DetectedCredential, 'apiKey'>;

/** Offer order. Qwen-family vars share one preset and stay one row. */
const OFFER_ORDER: readonly CliProviderPreset[] = ['deepseek', 'openai', 'anthropic', 'qwen'];

function normalizeBase(value: string): string {
  return cleanGatewayUrl(value);
}

function providerFor(presetId: CliProviderPreset, baseUrl: string): CliProviderPreset {
  if (!baseUrl) return presetId;
  if (presetId === 'openai') return inferProviderFromBaseUrl(baseUrl) ?? 'openai-compatible';
  return inferProviderFromBaseUrl(baseUrl) ?? presetId;
}

export function toPublicOffer(item: DetectedCredential): PublicOffer {
  const { apiKey: _apiKey, ...rest } = item;
  return rest;
}

export function offerUsesOfficialHost(offer: {
  provider: CliProviderPreset;
  baseUrl: string;
}): boolean {
  return isOfficialPresetBaseUrl(offer.provider, offer.baseUrl);
}

/**
 * Keys Moss can offer on first run. One row per provider: DASHSCOPE, ALIYUN,
 * and QWEN are the same gateway, so a later Qwen-family key is not a second
 * offer. The apiKey field is for the probe — the saved config stores keyVar.
 *
 * The default environment is the snapshot from before a project `.env` was
 * loaded. A file in the workspace must not choose the host for a key the
 * user already had. Official hosts are listed first.
 */
export function detectEnvCredentials(
  env: NodeJS.ProcessEnv = envBeforeDotenv
): DetectedCredential[] {
  const found: DetectedCredential[] = [];
  const seenProviders = new Set<string>();
  for (const presetId of OFFER_ORDER) {
    const preset = PROVIDER_PRESETS[presetId];
    for (const keyVar of preset.envKeys ?? []) {
      const apiKey = (env[keyVar] ?? '').trim();
      if (!apiKey) continue;
      const baseRaw = preset.envBaseUrl ? (env[preset.envBaseUrl] ?? '').trim() : '';
      const provider = providerFor(presetId, baseRaw ? normalizeBase(baseRaw) : '');
      if (seenProviders.has(provider)) continue;
      const resolved = PROVIDER_PRESETS[provider];
      const baseUrl = normalizeBase(baseRaw) || resolved.defaultBaseUrl;
      const customGateway = provider === 'openai-compatible';
      const model = customGateway ? '' : resolved.defaultModel;
      const label = `${keyVar} → ${baseUrl} (${resolved.displayName})`;
      found.push({
        id: presetId,
        provider,
        label,
        keyVar,
        baseUrl,
        ...(preset.envBaseUrl && baseRaw ? { baseUrlVar: preset.envBaseUrl } : {}),
        model,
        needsModelList: customGateway || !model,
        apiKey,
      });
      seenProviders.add(provider);
    }
  }
  found.sort((a, b) => Number(offerUsesOfficialHost(b)) - Number(offerUsesOfficialHost(a)));
  return found;
}

/** Official-host offers only. A custom base URL is not an auto-select candidate. */
export function officialEnvOffers(env: NodeJS.ProcessEnv = envBeforeDotenv): DetectedCredential[] {
  return detectEnvCredentials(env).filter(offerUsesOfficialHost);
}

export function credentialById(
  id: string,
  env: NodeJS.ProcessEnv = envBeforeDotenv
): DetectedCredential | undefined {
  return detectEnvCredentials(env).find((item) => item.id === id);
}

/** Replace any detected key value. Used before a probe error is shown. */
export function redactSecrets(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length >= 4) out = out.split(secret).join('[redacted]');
  }
  return out
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]{6,}\b/g, '[redacted]')
    .replace(/\/\/[^/\s:@]+:[^/\s@]+@/g, '//[redacted]@');
}
