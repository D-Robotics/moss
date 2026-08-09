import type { MossAgentEvent } from '../core/index.js';
import { totalPromptTokens } from '../core/llm/usage.js';

export interface ContextUsageSnapshot {
  used: number;
  total: number;
  source: 'provider' | 'estimated';
  inputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}

export function contextUsageFromAgentEvent(event: MossAgentEvent): ContextUsageSnapshot | null {
  if (event.type !== 'llm_usage' || !event.contextTokens || event.contextTokens <= 0) return null;
  const cacheReadTokens = event.cacheReadTokens ?? 0;
  const cacheCreationTokens = event.cacheCreationTokens ?? 0;
  return {
    used: totalPromptTokens(event),
    total: event.contextTokens,
    source: 'provider',
    inputTokens: event.inputTokens,
    cacheReadTokens,
    cacheCreationTokens,
  };
}
