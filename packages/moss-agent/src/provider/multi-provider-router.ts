


















import type {
  LLMProvider,
  LLMRequestOptions,
  LLMResponse,
  LLMStreamEvent,
} from '../core/llm/llm-provider.js';
import { classifyLlmError, type LlmErrorClassification } from '../core/llm/llm-error-classifier.js';

export interface FallbackProviderConfig {
  
  provider: string;
  
  model?: string;
  
  baseUrl?: string;
  
  apiKey?: string;
}

export interface MultiProviderRouterOptions {
  
  primary: LLMProvider;
  



  createProvider: (config: FallbackProviderConfig) => LLMProvider;
  
  fallbacks: FallbackProviderConfig[];
  
  maxFallbacks?: number;
  
  cooldownMs?: number;
}

interface ProviderHealth {
  provider: LLMProvider;
  config: FallbackProviderConfig;
  unhealthyUntil: number; 
}















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

    
    
    this.fallbackHealth = options.fallbacks.slice(0, this.maxFallbacks).map((config) => ({
      provider: this.createProvider(config),
      config,
      unhealthyUntil: 0,
    }));
  }

  
  private checkHealth(health: ProviderHealth, classification: LlmErrorClassification): boolean {
    const now = Date.now();
    
    if (health.unhealthyUntil > 0 && now >= health.unhealthyUntil) {
      health.unhealthyUntil = 0;
    }
    
    if (health.unhealthyUntil > 0) return false;

    
    if (!classification.retryable && classification.category !== 'unknown') {
      health.unhealthyUntil = now + this.cooldownMs;
      return false;
    }

    return true; 
  }

  async complete(opts: LLMRequestOptions): Promise<LLMResponse> {
    return this.stream(opts, () => {});
  }

  async stream(
    opts: LLMRequestOptions,
    onEvent: (e: LLMStreamEvent) => void
  ): Promise<LLMResponse> {
    
    try {
      return await this.primary.stream(opts, onEvent);
    } catch (primaryErr) {
      const classification = classifyLlmError(primaryErr);
      if (!classification.retryable) throw primaryErr;
      
    }

    
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
          
          health.unhealthyUntil = Date.now() + this.cooldownMs;
        }
        
      }
    }

    
    throw lastError;
  }
}







export function parseFallbackProvidersEnv(
  env: NodeJS.ProcessEnv = process.env
): FallbackProviderConfig[] {
  const raw = env.MOSS_FALLBACK_PROVIDERS;
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is FallbackProviderConfig =>
        typeof item === 'object' && item !== null && typeof item.provider === 'string'
    );
  } catch {
    return [];
  }
}




export function parseFallbackMaxRetriesEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.MOSS_FALLBACK_MAX_RETRIES;
  if (!raw) return 3;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isInteger(parsed) && parsed >= 0 && parsed <= 10) return parsed;
  return 3;
}




export function parseFallbackCooldownEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.MOSS_FALLBACK_COOLDOWN_MS;
  if (!raw) return 60_000;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isInteger(parsed) && parsed >= 5000 && parsed <= 600_000) return parsed;
  return 60_000;
}
