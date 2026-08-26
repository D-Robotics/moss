/**
 * FileSpanProcessor — serializes SDK ReadableSpans to a local JSONL file.
 *
 * Attached to the TracerProvider alongside the OTLP exporter, so the same
 * spans ship to the receiver AND land on disk. Best-effort: flush failures
 * never block the agent.
 *
 * Path: `<workspaceDir>/.moss/analytics/traces.jsonl`
 */
import type { SpanProcessor, ReadableSpan } from '@opentelemetry/sdk-trace-base';
import type { Context } from '@opentelemetry/api';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  MOSS_LEGACY_ATTRIBUTE_ALIASES,
  MOSS_OBSERVABILITY_ATTRIBUTES,
  type MossOutcome,
} from './contract.js';
import { normalizeEndedSpan } from './normalized-span.js';

const FLUSH_INTERVAL_MS = 30_000;

export interface SerializedSpan {
  name: string;
  trace_id: string;
  span_id: string;
  parent_span_id?: string;
  startTime: number;
  endTime: number;
  attributes: Record<string, string | number | boolean>;
  events: Array<{ name: string; time: number; attrs?: Record<string, unknown> }>;
  outcome: MossOutcome;
  status: 'unset' | 'ok' | 'error';
  statusMessage?: string;
}

export interface TraceStats {
  totalSpans: number;
  totalErrors: number;
  errorRate: number;
  byName: Record<string, { count: number; errors: number; avgDurationMs: number }>;
  toolSpans: Array<{ toolName: string; count: number; errors: number; avgDurationMs: number }>;
}

/** Convert an SDK ReadableSpan into the JSONL-friendly SerializedSpan shape. */
export function serializeSpan(span: ReadableSpan): SerializedSpan {
  const normalized = normalizeEndedSpan(span);
  return {
    name: normalized.name,
    trace_id: normalized.trace_id,
    span_id: normalized.span_id,
    ...(normalized.parent_span_id ? { parent_span_id: normalized.parent_span_id } : {}),
    startTime: normalized.start_time_unix_ms,
    endTime: normalized.end_time_unix_ms,
    attributes: { ...normalized.attributes },
    events: normalized.events.map((event) => ({
      name: event.name,
      time: event.time_unix_ms,
      ...(Object.keys(event.attributes).length > 0 ? { attrs: { ...event.attributes } } : {}),
    })),
    outcome: normalized.outcome,
    status: normalized.status === 'ERROR' ? 'error' : normalized.status === 'OK' ? 'ok' : 'unset',
    ...(normalized.status_message ? { statusMessage: normalized.status_message } : {}),
  };
}

export class FileSpanProcessor implements SpanProcessor {
  private buffer: ReadableSpan[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly file: string;

  constructor(workspaceDir: string) {
    this.file = path.join(workspaceDir, '.moss', 'analytics', 'traces.jsonl');
    this.timer = setInterval(() => {
      void this.flush();
    }, FLUSH_INTERVAL_MS);
  }

  onStart(_span: ReadableSpan, _parentContext: Context): void {
    /* nothing — we serialize on end */
  }

  onEnd(span: ReadableSpan): void {
    this.buffer.push(span);
  }

  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;
    const snapshot = this.buffer.splice(0);
    const serialized: SerializedSpan[] = [];
    for (const span of snapshot) {
      try {
        serialized.push(serializeSpan(span));
      } catch {
        // Invalid native trace structure is rejected rather than repaired with
        // a run/session identifier. Other spans in the batch still flush.
      }
    }
    if (serialized.length === 0) return;
    const lines = serialized.map((span) => JSON.stringify(span)).join('\n') + '\n';
    try {
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      await fs.appendFile(this.file, lines, 'utf-8');
    } catch {
      // Silently ignore — never block the agent.
    }
  }

  async forceFlush(): Promise<void> {
    await this.flush();
  }

  async shutdown(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.flush();
  }
}

function emptyStats(): TraceStats {
  return { totalSpans: 0, totalErrors: 0, errorRate: 0, byName: {}, toolSpans: [] };
}

/** Read aggregated stats from a traces.jsonl file (for CLI reporting). */
export async function readTraceStats(file: string): Promise<TraceStats> {
  let lines: string[];
  try {
    lines = (await fs.readFile(file, 'utf-8')).split('\n').filter(Boolean);
  } catch {
    return emptyStats();
  }
  const stats = emptyStats();
  for (const line of lines) {
    let span: SerializedSpan;
    try {
      span = JSON.parse(line);
    } catch {
      continue;
    }
    stats.totalSpans++;
    if (span.status === 'error') stats.totalErrors++;
    const entry = (stats.byName[span.name] ??= { count: 0, errors: 0, avgDurationMs: 0 });
    entry.count++;
    if (span.status === 'error') entry.errors++;
    const duration = span.endTime - span.startTime;
    entry.avgDurationMs = (entry.avgDurationMs * (entry.count - 1) + duration) / entry.count;
    if (span.name === 'moss.tool.invoke') {
      const toolName = String(
        span.attributes[MOSS_OBSERVABILITY_ATTRIBUTES.toolName] ??
          span.attributes[MOSS_LEGACY_ATTRIBUTE_ALIASES.toolName] ??
          'unknown'
      );
      let tool = stats.toolSpans.find((t) => t.toolName === toolName);
      if (!tool) {
        tool = { toolName, count: 0, errors: 0, avgDurationMs: 0 };
        stats.toolSpans.push(tool);
      }
      tool.count++;
      if (span.status === 'error') tool.errors++;
      tool.avgDurationMs = (tool.avgDurationMs * (tool.count - 1) + duration) / tool.count;
    }
  }
  stats.errorRate = stats.totalSpans > 0 ? stats.totalErrors / stats.totalSpans : 0;
  stats.toolSpans.sort((a, b) => b.count - a.count);
  return stats;
}
