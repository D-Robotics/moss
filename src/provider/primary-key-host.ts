/**
 * Where the user's primary API key may be sent.
 *
 * A project may name a base URL, but the key from the user's own config is
 * only attached to a host the user configured or to a provider's official
 * URL. Any other host needs a key of its own.
 */
import { PROVIDER_PRESETS, parseProviderPreset } from './provider-presets.js';

export function endpointHost(raw: string | undefined): string | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`);
    const name = url.hostname.toLowerCase();
    if (!name) return null;
    const port = url.port;
    const implicit = url.protocol === 'https:' ? '443' : url.protocol === 'http:' ? '80' : '';
    if (port && port !== implicit) return `${name}:${port}`;
    return name;
  } catch {
    return null;
  }
}

export function officialBaseUrl(provider: string | undefined): string {
  const preset = parseProviderPreset(provider);
  if (!preset) return '';
  return PROVIDER_PRESETS[preset].defaultBaseUrl;
}

/** Hosts of the built-in provider presets (empty custom preset excluded). */
export function officialProviderHosts(): ReadonlySet<string> {
  const hosts = new Set<string>();
  for (const preset of Object.values(PROVIDER_PRESETS)) {
    const host = endpointHost(preset.defaultBaseUrl);
    if (host) hosts.add(host);
  }
  return hosts;
}

/**
 * True when `host` is the user's configured base URL or an official provider
 * URL. The primary key may be sent there. A project-chosen host returns false.
 */
export function primaryKeyAllowedForHost(
  host: string,
  user: { baseUrl?: string; provider?: string }
): boolean {
  const normalized = host.trim().toLowerCase();
  if (!normalized) return false;
  const userHost = endpointHost(user.baseUrl);
  if (userHost && userHost === normalized) return true;
  const providerHost = endpointHost(officialBaseUrl(user.provider));
  if (providerHost && providerHost === normalized) return true;
  return officialProviderHosts().has(normalized);
}
