/**
 * In-session cumulative usage tracking for the REPL.
 *
 * The persisted session event log does not record llm_usage, so cumulative
 * usage lives in memory for the lifetime of the interactive session: the REPL
 * taps agent stream events and accumulates per-call token reports.
 */
import type { MossAgentEvent } from '../core/index.js';
import { contextUsageFromAgentEvent, type ContextUsageSnapshot } from './usage-display.js';

export interface SessionUsageSummary {
  /** Number of completed model calls that reported usage. */
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** Wall-clock ms between the first and last recorded call. */
  spanMs: number;
  firstAt: number | undefined;
  lastAt: number | undefined;
}

export interface SessionUsageAccumulator {
  record(event: MossAgentEvent): void;
  summary(): SessionUsageSummary;
  /** Latest single-call context snapshot (also feeds /context). */
  latestContextUsage(): ContextUsageSnapshot | undefined;
}

export function createSessionUsageAccumulator(): SessionUsageAccumulator {
  let calls = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheCreationTokens = 0;
  let firstAt: number | undefined;
  let lastAt: number | undefined;
  let latest: ContextUsageSnapshot | undefined;

  return {
    record(event) {
      if (event.type !== 'llm_usage') return;
      calls += 1;
      inputTokens += event.inputTokens ?? 0;
      outputTokens += event.outputTokens ?? 0;
      cacheReadTokens += event.cacheReadTokens ?? 0;
      cacheCreationTokens += event.cacheCreationTokens ?? 0;
      const now = Date.now();
      if (firstAt === undefined) firstAt = now;
      lastAt = now;
      const snapshot = contextUsageFromAgentEvent(event);
      if (snapshot) latest = snapshot;
    },
    summary() {
      return {
        calls,
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheCreationTokens,
        spanMs: firstAt !== undefined && lastAt !== undefined ? Math.max(0, lastAt - firstAt) : 0,
        firstAt,
        lastAt,
      };
    },
    latestContextUsage() {
      return latest;
    },
  };
}
