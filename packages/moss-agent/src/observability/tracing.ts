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

// Resolve the tracer lazily so it picks up the real TracerProvider once the
// SDK is started (sdk.ts → setGlobalTracerProvider). Binding eagerly at module
// load would capture the noop tracer before the SDK starts — same failure mode
// as the metrics instruments (which are also lazy). Returns a noop tracer when
// no provider is registered, so withSpan/startSpan are zero-cost when disabled.
const resolveTracer = () => trace.getTracer('moss-agent');

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
    parent?: TraceSpan
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
  fn: (span: Span) => Promise<T>
): Promise<T> {
  const span = resolveTracer().startSpan(name, attributes ? { attributes } : undefined);
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

/**
 * Imperative span lifecycle, for call-sites that cannot use the callback-based
 * withSpan (e.g. a loop body whose control flow uses continue/break/throw).
 *
 * startSpan() creates and activates a span; runInSpanContext() runs a fn within
 * that span's context (so child withSpan calls nest under it); endSpan() ends
 * it. Always call endSpan in a finally that covers every exit path.
 */
export interface ActiveSpan {
  /** The underlying OTel Span. Set attributes / add events on it. */
  readonly span: Span;
  /** Run fn within this span's active context (for child-span nesting). */
  runInSpanContext<T>(fn: () => Promise<T>): Promise<T>;
  /**
   * Drive an async generator within this span's active context. For
   * async-generator call-sites (e.g. streamChat) that must yield to the
   * caller while keeping the span context active across awaits, so child
   * spans created inside the generator nest under this span.
   */
  runInSpanContextGen<T>(gen: AsyncGenerator<T>): AsyncGenerator<T>;
  /** End the span. ok=false records ERROR. Idempotent. */
  end(ok?: boolean, message?: string): void;
}

export function startSpan(
  name: string,
  attributes?: Record<string, string | number | boolean>
): ActiveSpan {
  const span = resolveTracer().startSpan(name, attributes ? { attributes } : undefined);
  const active = context.active();
  const spanContext = trace.setSpan(active, span);
  let ended = false;
  return {
    span,
    runInSpanContext(fn) {
      return context.with(spanContext, fn);
    },
    runInSpanContextGen<T>(gen: AsyncGenerator<T>): AsyncGenerator<T> {
      // Generators suspend at yield and lose the stack-local active context on
      // the next .next(). Drive the generator through a thin wrapper that
      // re-activates the span context on each resume, so child spans created
      // inside the generator nest under this span.
      const ctx = spanContext;
      return (async function* delegate() {
        while (true) {
          const res = await context.with(ctx, async () => gen.next());
          if (res.done) return res.value as T;
          yield res.value as T;
        }
      })();
    },
    end(ok = true, message) {
      if (ended) return;
      ended = true;
      try {
        span.setStatus(
          ok
            ? { code: SpanStatusCode.OK }
            : { code: SpanStatusCode.ERROR, ...(message ? { message } : {}) }
        );
      } catch {
        /* noop */
      }
      span.end();
    },
  };
}

// ── Attributes constructors (span dimensions, centralized) ──────────────

export function turnAttributes(
  runId: string,
  turn: number,
  model: string
): Record<string, string | number | boolean> {
  return { runId, turn, model };
}

export function toolAttributes(
  runId: string,
  toolName: string,
  toolCallId: string
): Record<string, string | number | boolean> {
  return { runId, toolName, toolCallId };
}

export function llmRequestAttributes(
  runId: string,
  model: string,
  inputTokens: number
): Record<string, string | number | boolean> {
  return { runId, model, inputTokens };
}

export function sessionAttributes(
  runId: string,
  model: string,
  sessionKey: string
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
  startSpan() {
    return noopSpan;
  },
};

export class TraceRegistry {
  setTracer(_tracer: Tracer | 'console'): void {
    /* no-op under the SDK model */
  }
  setTraceRedactor(_fn: (text: string) => string): void {
    /* no-op — redaction handled by redactSensitiveData in withSpan */
  }
  getTracer(): Tracer {
    return noopTracer;
  }
  redactMessage(text: string): string {
    return text;
  }
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
