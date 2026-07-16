/**
 * Tracing — SDK-backed withSpan + attributes.
 *
 * Uses the global TracerProvider. When none is registered (observability
 * disabled), trace.getTracer() returns a noop tracer and withSpan runs fn
 * directly with zero tracing overhead.
 *
 * Legacy setTracer/setTraceRedactor/TraceRegistry/getTracer are kept as noop
 * shims so existing imports (cli-main.ts, moss-agent.ts, agent-loop-llm-call.ts)
 * do not break until callers are migrated to initObservability.
 */
import { trace, context, SpanStatusCode } from '@opentelemetry/api';
import type { Span } from '@opentelemetry/api';
import { errorMessage } from '../errors.js';
import { redactSensitiveData } from './redact.js';

const tracer = trace.getTracer('moss-agent');

/** Public span handle passed to withSpan's fn (mirrors the OTel Span API). */
export interface TraceSpan {
  setAttribute(key: string, value: string | number | boolean): void;
  addEvent(name: string, attributes?: Record<string, string | number | boolean>): void;
  setStatus(ok: boolean, message?: string): void;
  end(): void;
}

/** Legacy Tracer interface — kept for typing compatibility. */
export interface Tracer {
  startSpan(
    name: string,
    attributes?: Record<string, string | number | boolean>,
    parent?: TraceSpan,
  ): TraceSpan;
}

/**
 * Run fn inside a span. On success sets OK; on throw records the exception
 * (type/message/stack as a span event), sets ERROR with a redacted message,
 * and rethrows. Never swallows errors.
 */
export async function withSpan<T>(
  name: string,
  attributes: Record<string, string | number | boolean> | undefined,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  const span = tracer.startSpan(name, attributes ? { attributes } : undefined);
  return context.with(trace.setSpan(context.active(), span), async () => {
    try {
      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: String(redactSensitiveData(errorMessage(err))),
      });
      throw err;
    } finally {
      span.end();
    }
  });
}

// ── Attributes constructors (span dimensions, centralized) ──────────────

export function turnAttributes(
  runId: string,
  turn: number,
  model: string,
): Record<string, string | number | boolean> {
  return { runId, turn, model };
}

export function toolAttributes(
  runId: string,
  toolName: string,
  toolCallId: string,
): Record<string, string | number | boolean> {
  return { runId, toolName, toolCallId };
}

export function llmRequestAttributes(
  runId: string,
  model: string,
  inputTokens: number,
): Record<string, string | number | boolean> {
  return { runId, model, inputTokens };
}

export function sessionAttributes(
  runId: string,
  model: string,
  sessionKey: string,
): Record<string, string | number | boolean> {
  return { runId, model, sessionKey };
}

// ── Legacy noop shims (do not remove — existing imports depend on them) ──

const noopSpan: TraceSpan = {
  setAttribute() {},
  addEvent() {},
  setStatus() {},
  end() {},
};

const noopTracer: Tracer = {
  startSpan() { return noopSpan; },
};

export class TraceRegistry {
  setTracer(_tracer: Tracer | 'console'): void {
    /* no-op under the SDK model */
  }
  setTraceRedactor(_fn: (text: string) => string): void {
    /* no-op — redaction handled by redactSensitiveData in withSpan */
  }
  getTracer(): Tracer { return noopTracer; }
  redactMessage(text: string): string { return text; }
}

export function setTracer(_tracer: Tracer | 'console'): void {
  // No-op under the SDK model. Tracer/MeterProvider is configured via
  // initObservability() in observability/index.ts.
}

export function setTraceRedactor(_fn: (text: string) => string): void {
  /* no-op under the SDK model */
}

export function getTracer(): Tracer {
  return noopTracer;
}
