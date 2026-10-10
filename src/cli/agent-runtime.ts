import type { MossAgentConfig } from '../core/index.js';
import { resolveModelOutputBudget } from '../core/loop/output-limit.js';
import type { ResolvedCliConfig } from './config.js';

/**
 * Default per-turn output cap for a model Moss does not have in the known
 * table, before the context window clamps it. Truncation recovery may raise
 * the live cap further, up to the model's ceiling.
 *
 * @public
 */
export const DEFAULT_MAX_OUTPUT_TOKENS_CAP = 16_384;

/**
 * Derive a per-turn output cap from the context window and, when known, the
 * model. Unknown gateway models start at {@link DEFAULT_MAX_OUTPUT_TOKENS_CAP}
 * rather than 8k, which cut reasoning models off mid-thought. Pin
 * `agent.maxOutputTokens` (or `agent.models.<id>.maxOutputTokens`) to override.
 */
export function deriveMaxOutputTokens(
  contextTokens: number | undefined,
  modelId?: string
): number | undefined {
  if (!contextTokens || contextTokens <= 0) return undefined;
  return resolveModelOutputBudget({
    modelId,
    contextTokens,
    pinned: false,
  }).initial;
}

export function resolveCliAgentRuntimeOptions(
  config: ResolvedCliConfig
): Pick<
  MossAgentConfig,
  | 'maxAgentTurns'
  | 'contextTokens'
  | 'maxTokens'
  | 'maxOutputTokensPinned'
  | 'modelMaxOutputTokens'
  | 'compactionSettings'
  | 'promptCache'
> {
  return {
    maxAgentTurns: config.maxAgentTurns,
    contextTokens: config.contextTokens,
    maxTokens: config.maxOutputTokens ?? deriveMaxOutputTokens(config.contextTokens, config.model),
    maxOutputTokensPinned: config.maxOutputTokens !== undefined,
    ...(config.modelMaxOutputTokens ? { modelMaxOutputTokens: config.modelMaxOutputTokens } : {}),
    compactionSettings: config.compactionSettings,
    promptCache: {
      enabled: config.promptCacheEnabled,
      debug: config.promptCacheDebug,
    },
  };
}
