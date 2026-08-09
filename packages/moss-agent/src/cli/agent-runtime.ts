import type { MossAgentConfig } from '../core/index.js';
import type { ResolvedCliConfig } from './config.js';

/**
 * Derive a reasonable max output tokens from the context window when the user
 * hasn't pinned one. ~1/4 of the context window, hard-capped at 8k so short
 * coding/chat turns don't pay for a 32k/128k reservation (many gateways
 * schedule slower when max_tokens is huge). Pin `agent.maxOutputTokens` when
 * a task truly needs longer single-shot answers.
 *
 * @public
 */
export const DEFAULT_MAX_OUTPUT_TOKENS_CAP = 8_192;

export function deriveMaxOutputTokens(contextTokens: number | undefined): number | undefined {
  if (!contextTokens || contextTokens <= 0) return undefined;
  const derived = Math.floor(contextTokens / 4);
  // Floor 2k for tiny windows; cap DEFAULT_MAX_OUTPUT_TOKENS_CAP for latency.
  return Math.max(2_048, Math.min(derived, DEFAULT_MAX_OUTPUT_TOKENS_CAP));
}

export function resolveCliAgentRuntimeOptions(
  config: ResolvedCliConfig
): Pick<
  MossAgentConfig,
  'maxAgentTurns' | 'contextTokens' | 'maxTokens' | 'compactionSettings' | 'promptCache'
> {
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
