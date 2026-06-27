/**
 * Multi-provider failover routing.
 *
 * Wraps a primary `LLMProvider` with a configurable fallback chain: when the
 * primary returns a retryable error (rate_limit / server_error / connection /
 * timeout), the router transparently retries on each fallback provider in order.
 *
 * Health state: providers that return non-retryable errors (auth, quota, etc.)
 * are marked unhealthy for a cooldown period (default 60s) to avoid hammering
 * a broken endpoint on every LLM call.
 *
 * Environment variables:
 *  - `MOSS_FALLBACK_PROVIDERS` — JSON array of fallback provider configs, e.g.:
 *    `[{"provider":"deepseek","model":"deepseek-v4-flash","apiKey":"sk-..."}]`
 *  - `MOSS_FALLBACK_MAX_RETRIES` — max fallback providers to try (default 3)
 *  - `MOSS_FALLBACK_COOLDOWN_MS` — unhealthy cooldown in ms (default 60000)
 *
 * @public
 */
import type { LLMProvider, LLMRequestOptions, LLMResponse, LLMStreamEvent } from '../core/llm/llm-provider.js';
import { classifyLlmError, type LlmErrorClassification } from '../core/llm/llm-error-classifier.js';

export interface FallbackProviderConfig {
  /** Provider preset name (deepseek, qwen, openai, anthropic, openai-compatible). */
  provider: string;
  /** Model name override for this fallback. Uses the provider default if unset. */
  model?: string;
  /** Base URL override. Uses the provider default if unset. */
  baseUrl?: string;
  /** API key for this fallback. Required unless using built-in defaults. */
  apiKey?: string;
}

export interface MultiProviderRouterOptions {
  /** Primary LLM provider (always tried first). */
  primary: LLMProvider;
  /**
   * Factory that creates an LLMProvider from a FallbackProviderConfig.
   * Caller provides this so the router stays host-neutral (no CLI import).
   */
  createProvider: (config: FallbackProviderConfig) => LLMProvider;
  /** Ordered fallback chain. Empty = no fallbacks. */
  fallbacks: FallbackProviderConfig[];
  /** Max fallback providers to try before giving up. Default 3. */
  maxFallbacks?: number;
  /** How long (ms) a unhealthy provider stays in cooldown. Default 60000. */
  cooldownMs?: number;
}

interface ProviderHealth {
  provider: LLMProvider;
  config: FallbackProviderConfig;
  unhealthyUntil: number; // epoch ms, 0 = healthy
}

/**
 * Wraps a primary provider with a fallback chain.
 *
 * On any LLM call, the router:
 * 1. Tries the primary provider.
 * 2. If the error is retryable, tries each healthy fallback in order.
 * 3. If a fallback also fails with a non-retryable error, marks it unhealthy.
 * 4. If all fail, throws the last error.
 *
 * Provider health state is per-instance (not global) — each `createMultiProviderRouter()`
 * call gets its own health tracking.
 *
 * @public
 */
export class MultiProviderRouter implements LLMProvider {
  readonly id = 'multi-provider-router';
  readonly displayName = 'Multi-Provider Router';
  readonly capabilities: LLMProvider['capabilities'];

  private primary: LLMProvider;
  private createProvider: (config: FallbackProviderConfig) => LLMProvider;
  private fallbackHealth: ProviderHealth[];
  private maxFallbacks: number;
  private cooldownMs: number;

  constructor(options: MultiProviderRouterOptions) {
    this.primary = options.primary;
    this.createProvider = options.createProvider;
    this.maxFallbacks = options.maxFallbacks ?? 3;
    this.cooldownMs = options.cooldownMs ?? 60_000;
    this.capabilities = { ...options.primary.capabilities };

    // Pre-build fallback providers (lazy would be cleaner but health state
    // needs stable instances for cooldown tracking).
    this.fallbackHealth = options.fallbacks.slice(0, this.maxFallbacks).map((config) => ({
      provider: this.createProvider(config),
      config,
      unhealthyUntil: 0,
    }));
  }

  /** Check and update health: mark unhealthy on non-retryable errors, clear expired cooldowns. */
  private checkHealth(health: ProviderHealth, classification: LlmErrorClassification): boolean {
    const now = Date.now();
    // Clear expired cooldowns
    if (health.unhealthyUntil > 0 && now >= health.unhealthyUntil) {
      health.unhealthyUntil = 0;
    }
    // Currently in cooldown → skip
    if (health.unhealthyUntil > 0) return false;

    // Non-retryable errors → mark unhealthy for cooldown
    if (!classification.retryable && classification.category !== 'unknown') {
      health.unhealthyUntil = now + this.cooldownMs;
      return false;
    }

    return true; // healthy, can be tried
  }

  async complete(opts: LLMRequestOptions): Promise<LLMResponse> {
    return this.stream(opts, () => {});
  }

  async stream(
    opts: LLMRequestOptions,
    onEvent: (e: LLMStreamEvent) => void,
  ): Promise<LLMResponse> {
    // 1. Try primary
    try {
      return await this.primary.stream(opts, onEvent);
    } catch (primaryErr) {
      const classification = classifyLlmError(primaryErr);
      if (!classification.retryable) throw primaryErr;
      // Primary failed with retryable error → try fallbacks
    }

    // 2. Try each healthy fallback in order
    let lastError: unknown = new Error('All providers exhausted');
    for (const health of this.fallbackHealth) {
      if (!this.checkHealth(health, classifyLlmError(lastError))) continue;

      try {
        const result = await health.provider.stream(opts, onEvent);
        return result;
      } catch (fallbackErr) {
        lastError = fallbackErr;
        const classification = classifyLlmError(fallbackErr);
        if (!classification.retryable) {
          // Non-retryable — mark unhealthy and try next
          health.unhealthyUntil = Date.now() + this.cooldownMs;
        }
        // Retryable but failed — try next fallback
      }
    }

    // 3. All exhausted — throw the last error
    throw lastError;
  }
}

/**
 * Parse fallback provider configs from MOSS_FALLBACK_PROVIDERS env var.
 * Returns empty array if not set or invalid.
 *
 * @public
 */
export function parseFallbackProvidersEnv(
  env: NodeJS.ProcessEnv = process.env,
): FallbackProviderConfig[] {
  const raw = env.MOSS_FALLBACK_PROVIDERS;
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is FallbackProviderConfig =>
        typeof item === 'object' && item !== null && typeof item.provider === 'string',
    );
  } catch {
    return [];
  }
}

/**
 * Parse MOSS_FALLBACK_MAX_RETRIES env var. Default 3.
 */
export function parseFallbackMaxRetriesEnv(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env.MOSS_FALLBACK_MAX_RETRIES;
  if (!raw) return 3;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isInteger(parsed) && parsed >= 0 && parsed <= 10) return parsed;
  return 3;
}

/**
 * Parse MOSS_FALLBACK_COOLDOWN_MS env var. Default 60000.
 */
export function parseFallbackCooldownEnv(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env.MOSS_FALLBACK_COOLDOWN_MS;
  if (!raw) return 60_000;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isInteger(parsed) && parsed >= 5000 && parsed <= 600_000) return parsed;
  return 60_000;
}
