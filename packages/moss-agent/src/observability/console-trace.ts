/**
 * ConsoleSpanProcessor — emits a human-readable span lifecycle to stderr.
 *
 * For local debugging: MOSS_TRACE=console attaches this processor so you can
 * watch the trace tree stream by as the agent runs (start/end per span,
 * indented by parent depth, with duration + status). Zero network, zero disk.
 *
 * Uses SDK span lifecycle: onStart opens the line, onEnd completes it with
 * duration + status. Because spans end out of order (children end before
 * parents), we print on END (when duration/status are known) with a depth
 * derived from the span's nesting via a parent stack — approximated by
 * tracking open spans and their parent ids.
 */
import type { SpanProcessor, ReadableSpan } from '@opentelemetry/sdk-trace-base';
import type { Context } from '@opentelemetry/api';
import { SpanStatusCode } from '@opentelemetry/api';

interface OpenSpan {
  name: string;
  spanId: string;
  parentSpanId?: string;
  depth: number;
}

export class ConsoleSpanProcessor implements SpanProcessor {
  private open = new Map<string, OpenSpan>();

  onStart(span: ReadableSpan, _parentContext: Context): void {
    const spanId = span.spanContext().spanId;
    const parentSpanId = span.parentSpanContext?.spanId;
    // Depth: parent's depth + 1, or 0 for a root.
    const parentDepth = parentSpanId ? (this.open.get(parentSpanId)?.depth ?? 0) : -1;
    const depth = parentDepth + 1;
    this.open.set(spanId, { name: span.name, spanId, parentSpanId, depth });
    const indent = '  '.repeat(depth);
    process.stderr.write(`[trace] ${indent}▶ ${span.name}\n`);
  }

  onEnd(span: ReadableSpan): void {
    const spanId = span.spanContext().spanId;
    const info = this.open.get(spanId);
    const depth = info?.depth ?? 0;
    const indent = '  '.repeat(depth);
    const durMs =
      Number(span.duration[0]) * 1000 + Math.trunc(Number(span.duration[1]) / 1_000_000);
    const status = span.status.code === SpanStatusCode.ERROR ? 'ERROR' : 'ok';
    const msg = span.status.message ? ` (${span.status.message.slice(0, 100)})` : '';
    const attrs = this.formatAttrs(span);
    process.stderr.write(`[trace] ${indent}◀ ${span.name} (${durMs}ms, ${status})${attrs}${msg}\n`);
    this.open.delete(spanId);
  }

  private formatAttrs(span: ReadableSpan): string {
    const entries = Object.entries(span.attributes ?? {});
    if (entries.length === 0) return '';
    const shown = entries
      .filter(([k]) => !['runId', 'sessionKey'].includes(k))
      .slice(0, 4)
      .map(([k, v]) => `${k}=${typeof v === 'string' ? v : String(v)}`)
      .join(' ');
    return shown ? ` {${shown}}` : '';
  }

  async forceFlush(): Promise<void> {}

  async shutdown(): Promise<void> {
    this.open.clear();
  }
}
