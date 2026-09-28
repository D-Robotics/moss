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
  /** Per-call speed telemetry (B1/B2). */
  ttftMsAvg: number | undefined;
  turnGapMsAvg: number | undefined;
  tokensPerSecond: number | undefined;
}

/** One observed compaction (O2 metrics). */
export interface CompactionRecord {
  ts: number;
  summaryChars: number;
  droppedMessages: number;
  tokensBefore?: number;
  tokensAfter?: number;
  keptToolNames?: number;
}

export interface SessionUsageAccumulator {
  record(event: MossAgentEvent): void;
  summary(): SessionUsageSummary;
  /** Latest single-call context snapshot (also feeds /context). */
  latestContextUsage(): ContextUsageSnapshot | undefined;
  compactionHistory(): readonly CompactionRecord[];
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
  const compactions: CompactionRecord[] = [];
  const ttfts: number[] = [];
  const turnGaps: number[] = [];
  let generationMsTotal = 0;

  return {
    record(event) {
      if (event.type === 'compaction') {
        compactions.push({
          ts: Date.now(),
          summaryChars: event.summaryChars,
          droppedMessages: event.droppedMessages,
          ...(event.tokensBefore !== undefined ? { tokensBefore: event.tokensBefore } : {}),
          ...(event.tokensAfter !== undefined ? { tokensAfter: event.tokensAfter } : {}),
          ...(event.keptToolNames !== undefined ? { keptToolNames: event.keptToolNames } : {}),
        });
        return;
      }
      if (event.type !== 'llm_usage') return;
      calls += 1;
      inputTokens += event.inputTokens ?? 0;
      outputTokens += event.outputTokens ?? 0;
      cacheReadTokens += event.cacheReadTokens ?? 0;
      cacheCreationTokens += event.cacheCreationTokens ?? 0;
      const now = Date.now();
      if (firstAt === undefined) firstAt = now;
      lastAt = now;
      if (event.ttftMs !== undefined) ttfts.push(event.ttftMs);
      if (event.turnGapMs !== undefined) turnGaps.push(event.turnGapMs);
      if (event.generationMs !== undefined) generationMsTotal += event.generationMs;
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
        ttftMsAvg:
          ttfts.length > 0
            ? Math.round(ttfts.reduce((n, v) => n + v, 0) / ttfts.length)
            : undefined,
        turnGapMsAvg:
          turnGaps.length > 0
            ? Math.round(turnGaps.reduce((n, v) => n + v, 0) / turnGaps.length)
            : undefined,
        tokensPerSecond:
          generationMsTotal > 0 ? Math.round((outputTokens / generationMsTotal) * 1000) : undefined,
      };
    },
    latestContextUsage() {
      return latest;
    },
    compactionHistory() {
      return compactions;
    },
  };
}
