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

/** Compact token count: 16849 → "16.8k", 569012 → "569k". */
export function formatCompactTokenCount(n: number): string {
  return n >= 1000 ? `${Math.round(n / 100) / 10}k` : String(n);
}

/** One turn's spend for the status row and the REPL task line. */
export function formatTurnUsage(inputTokens: number, outputTokens: number): string {
  return `${formatCompactTokenCount(inputTokens)} in / ${formatCompactTokenCount(outputTokens)} out`;
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
