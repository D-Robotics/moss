/**
 * FileSpanProcessor — serializes SDK ReadableSpans to a local JSONL file.
 *
 * Attached to the TracerProvider alongside the OTLP exporter, so the same
 * spans ship to the receiver AND land on disk. Best-effort: flush failures
 * never block the agent.
 *
 * Path: {workspaceDir}/.moss/analytics/traces.jsonl
 */
import type { SpanProcessor, ReadableSpan } from '@opentelemetry/sdk-trace-base';
import type { Context, HrTime } from '@opentelemetry/api';
import { SpanStatusCode } from '@opentelemetry/api';
import fs from 'node:fs/promises';
import path from 'node:path';

const FLUSH_INTERVAL_MS = 30_000;

export interface SerializedSpan {
  name: string;
  startTime: number;
  endTime: number;
  attributes: Record<string, string | number | boolean>;
  events: Array<{ name: string; time: number; attrs?: Record<string, unknown> }>;
  status: 'ok' | 'error';
  statusMessage?: string;
}

export interface TraceStats {
  totalSpans: number;
  totalErrors: number;
  errorRate: number;
  byName: Record<string, { count: number; errors: number; avgDurationMs: number }>;
  toolSpans: Array<{ toolName: string; count: number; errors: number; avgDurationMs: number }>;
}

/** HrTime is [seconds, nanoseconds]; reduce to epoch-ms number for the file. */
function hrToMs(hr: HrTime): number {
  return hr[0] * 1000 + Math.trunc(hr[1] / 1_000_000);
}

/** Convert an SDK ReadableSpan into the JSONL-friendly SerializedSpan shape. */
export function serializeSpan(span: ReadableSpan): SerializedSpan {
  const attrs: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(span.attributes ?? {})) {
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') attrs[k] = v;
  }
  return {
    name: span.name,
    startTime: hrToMs(span.startTime),
    endTime: hrToMs(span.endTime),
    attributes: attrs,
    events: (span.events ?? []).map((e) => ({
      name: e.name,
      time: hrToMs(e.time),
      ...(e.attributes ? { attrs: e.attributes as Record<string, unknown> } : {}),
    })),
    status: span.status.code === SpanStatusCode.ERROR ? 'error' : 'ok',
    ...(span.status.code === SpanStatusCode.ERROR && span.status.message
      ? { statusMessage: span.status.message }
      : {}),
  };
}

export class FileSpanProcessor implements SpanProcessor {
  private buffer: ReadableSpan[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly file: string;

  constructor(workspaceDir: string) {
    this.file = path.join(workspaceDir, '.moss', 'analytics', 'traces.jsonl');
    this.timer = setInterval(() => { void this.flush(); }, FLUSH_INTERVAL_MS);
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
    const lines = snapshot.map(serializeSpan).map((s) => JSON.stringify(s)).join('\n') + '\n';
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
    try { span = JSON.parse(line); } catch { continue; }
    stats.totalSpans++;
    if (span.status === 'error') stats.totalErrors++;
    const entry = stats.byName[span.name] ??= { count: 0, errors: 0, avgDurationMs: 0 };
    entry.count++;
    if (span.status === 'error') entry.errors++;
    const duration = span.endTime - span.startTime;
    entry.avgDurationMs = (entry.avgDurationMs * (entry.count - 1) + duration) / entry.count;
    if (span.name === 'moss.tool.invoke') {
      const toolName = String(span.attributes.toolName ?? 'unknown');
      let tool = stats.toolSpans.find((t) => t.toolName === toolName);
      if (!tool) { tool = { toolName, count: 0, errors: 0, avgDurationMs: 0 }; stats.toolSpans.push(tool); }
      tool.count++;
      if (span.status === 'error') tool.errors++;
      tool.avgDurationMs = (tool.avgDurationMs * (tool.count - 1) + duration) / tool.count;
    }
  }
  stats.errorRate = stats.totalSpans > 0 ? stats.totalErrors / stats.totalSpans : 0;
  stats.toolSpans.sort((a, b) => b.count - a.count);
  return stats;
}
