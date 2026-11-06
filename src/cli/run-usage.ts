/**
 * Token/cost summary for the unified run ledger (B155).
 *
 * Every engine already collects usage somewhere (headless `-p` keeps usage
 * slices, task runs tap `llm_usage` events); the ledger needs one shape so
 * `moss runs show/export --json` can answer "what did this run cost?" without
 * the reader knowing which engine wrote it.
 */
import type { RunRecordUsage } from '../core/run-ledger.js';
import {
  formatCostEstimate,
  quoteUsage,
  type ModelPrice,
  type UsageSlice,
} from './model-pricing.js';

export function runUsageFromSlices(
  slices: readonly UsageSlice[],
  options: { overrides?: Readonly<Record<string, ModelPrice>>; baseUrl?: string } = {}
): RunRecordUsage | undefined {
  if (slices.length === 0) return undefined;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheCreationTokens = 0;
  for (const slice of slices) {
    inputTokens += slice.inputTokens;
    outputTokens += slice.outputTokens;
    cacheReadTokens += slice.cacheReadTokens ?? 0;
    cacheCreationTokens += slice.cacheCreationTokens ?? 0;
  }
  if (inputTokens === 0 && outputTokens === 0) return undefined;
  const quote = quoteUsage(slices, { ...options });
  return {
    inputTokens,
    outputTokens,
    ...(cacheReadTokens > 0 ? { cacheReadTokens } : {}),
    ...(cacheCreationTokens > 0 ? { cacheCreationTokens } : {}),
    ...(typeof quote.totalUsd === 'number' ? { costUsd: Number(quote.totalUsd.toFixed(6)) } : {}),
  };
}

/** Human line for `moss runs show`; `null` when the record has no usage. */
export function formatRunUsage(usage: RunRecordUsage | undefined, zh = false): string | null {
  if (!usage) return null;
  const tokens = `${formatTokens(usage.inputTokens)} ${zh ? '入' : 'in'} / ${formatTokens(usage.outputTokens)} ${zh ? '出' : 'out'}`;
  const cache = usage.cacheReadTokens
    ? ` · ${zh ? '缓存读' : 'cache read'} ${formatTokens(usage.cacheReadTokens)}`
    : '';
  const cost =
    typeof usage.costUsd === 'number' ? ` · ${formatCostEstimate(usage.costUsd, 'USD', zh)}` : '';
  return `${zh ? '用量' : 'usage'}: ${tokens}${cache}${cost}`;
}

function formatTokens(value: number): string {
  return value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value);
}
