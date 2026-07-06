import type { MossAgentConfig } from '../core/index.js';
import type { ResolvedCliConfig } from './config.js';

/**
 * Derive a reasonable max output tokens from the context window when the user
 * hasn't pinned one. ~1/4 of the context window, capped at 32k so we don't
 * request absurdly long outputs on 1M-window models (slow + costly). This
 * replaces the old hardcoded 4096 default, which truncated long answers on
 * every modern model.
 *
 * @public
 */
export function deriveMaxOutputTokens(contextTokens: number | undefined): number | undefined {
  if (!contextTokens || contextTokens <= 0) return undefined;
  const derived = Math.floor(contextTokens / 4);
  return Math.max(4096, Math.min(derived, 32_000));
}

export function resolveCliAgentRuntimeOptions(
  config: ResolvedCliConfig
): Pick<MossAgentConfig, 'maxAgentTurns' | 'contextTokens' | 'maxTokens' | 'compactionSettings' | 'promptCache'> {
  return {
    maxAgentTurns: config.maxAgentTurns,
    contextTokens: config.contextTokens,
    maxTokens: config.maxOutputTokens ?? deriveMaxOutputTokens(config.contextTokens),
    compactionSettings: config.compactionSettings,
    promptCache: {
      enabled: config.promptCacheEnabled,
      debug: config.promptCacheDebug,
    },
  };
}
