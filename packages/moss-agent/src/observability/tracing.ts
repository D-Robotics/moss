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
import { ErrorCode, errorMessage, isMossError } from '../errors.js';
import { redactSensitiveData } from './redact.js';
import {
  commonMossAttributes,
  MOSS_LEGACY_ATTRIBUTE_ALIASES,
  MOSS_OBSERVABILITY_ATTRIBUTES,
  mossOutcomeToSpanStatusCode,
  type MossErrorCategory,
  type MossOutcome,
  type MossToolOutcomeKind,
} from './contract.js';

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
      try {
        span.end();
      } catch {
        /* processor failures never escape into the Agent path */
      }
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
  /** End with the exact MOC outcome/status mapping. Idempotent. */
  endOutcome(outcome: MossOutcome, errorCategory?: MossErrorCategory, message?: string): void;
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
      // A generator can be advanced with next(), return(), or throw(). Bind
      // every advance, not just next(), so early closure also executes the
      // underlying finally blocks inside the initiating span context.
      const ctx = spanContext;
      const driven: AsyncGenerator<T> = {
        next(value?: unknown) {
          return context.with(ctx, () => gen.next(value as never));
        },
        return(value?: unknown) {
          return context.with(ctx, () => gen.return(value as never));
        },
        throw(error?: unknown) {
          return context.with(ctx, () => gen.throw(error));
        },
        [Symbol.asyncIterator]() {
          return this;
        },
      };
      return driven;
    },
    endOutcome(outcome, errorCategory, message) {
      if (ended) return;
      ended = true;
      try {
        span.setAttribute(MOSS_OBSERVABILITY_ATTRIBUTES.outcome, outcome);
        if (errorCategory) {
          span.setAttribute(MOSS_OBSERVABILITY_ATTRIBUTES.errorCategory, errorCategory);
        }
        const code = mossOutcomeToSpanStatusCode(outcome);
        span.setStatus({
          code,
          ...(code === SpanStatusCode.ERROR && message ? { message } : {}),
        });
      } catch {
        /* noop */
      }
      try {
        span.end();
      } catch {
        /* processor failures never escape into the Agent path */
      }
    },
    end(ok = true, message) {
      this.endOutcome(ok ? 'ok' : 'error', ok ? undefined : 'unknown', message);
    },
  };
}

// ── Attributes constructors (span dimensions, centralized) ──────────────

export function turnAttributes(
  runId: string,
  turn: number,
  model: string,
  sessionId = runId
): Record<string, string | number | boolean> {
  const normalizedTurn = Math.max(0, Math.trunc(turn));
  return {
    ...commonMossAttributes(runId, sessionId),
    [MOSS_OBSERVABILITY_ATTRIBUTES.turnIndex]: normalizedTurn,
    [MOSS_OBSERVABILITY_ATTRIBUTES.genAiRequestModel]: model,
    [MOSS_LEGACY_ATTRIBUTE_ALIASES.turnIndex]: normalizedTurn,
    [MOSS_LEGACY_ATTRIBUTE_ALIASES.requestModel]: model,
  };
}

export function toolAttributes(
  runId: string,
  toolName: string,
  toolCallId: string,
  sessionId = runId,
  turn?: number,
  outcomeKind?: MossToolOutcomeKind
): Record<string, string | number | boolean> {
  return {
    ...commonMossAttributes(runId, sessionId),
    [MOSS_OBSERVABILITY_ATTRIBUTES.toolName]: toolName,
    [MOSS_OBSERVABILITY_ATTRIBUTES.toolCallId]: toolCallId,
    [MOSS_LEGACY_ATTRIBUTE_ALIASES.toolName]: toolName,
    [MOSS_LEGACY_ATTRIBUTE_ALIASES.toolCallId]: toolCallId,
    ...(turn !== undefined
      ? {
          [MOSS_OBSERVABILITY_ATTRIBUTES.turnIndex]: Math.max(0, Math.trunc(turn)),
          [MOSS_LEGACY_ATTRIBUTE_ALIASES.turnIndex]: Math.max(0, Math.trunc(turn)),
        }
      : {}),
    ...(outcomeKind ? { [MOSS_OBSERVABILITY_ATTRIBUTES.toolOutcomeKind]: outcomeKind } : {}),
  };
}

export function llmRequestAttributes(
  runId: string,
  model: string,
  inputTokens: number | undefined,
  sessionId = runId,
  turn?: number,
  provider?: string
): Record<string, string | number | boolean> {
  const normalizedInputTokens =
    inputTokens === undefined ? undefined : Math.max(0, Math.trunc(inputTokens));
  return {
    ...commonMossAttributes(runId, sessionId),
    [MOSS_OBSERVABILITY_ATTRIBUTES.genAiOperationName]: 'chat',
    [MOSS_OBSERVABILITY_ATTRIBUTES.genAiRequestModel]: model,
    [MOSS_LEGACY_ATTRIBUTE_ALIASES.requestModel]: model,
    ...(normalizedInputTokens !== undefined
      ? {
          [MOSS_OBSERVABILITY_ATTRIBUTES.genAiUsageInputTokens]: normalizedInputTokens,
          [MOSS_LEGACY_ATTRIBUTE_ALIASES.inputTokens]: normalizedInputTokens,
        }
      : {}),
    ...(turn !== undefined
      ? {
          [MOSS_OBSERVABILITY_ATTRIBUTES.turnIndex]: Math.max(0, Math.trunc(turn)),
          [MOSS_LEGACY_ATTRIBUTE_ALIASES.turnIndex]: Math.max(0, Math.trunc(turn)),
        }
      : {}),
    ...(provider ? { [MOSS_OBSERVABILITY_ATTRIBUTES.genAiProviderName]: provider } : {}),
  };
}

export function sessionAttributes(
  runId: string,
  model: string,
  sessionKey: string
): Record<string, string | number | boolean> {
  return {
    ...commonMossAttributes(runId, sessionKey),
    [MOSS_OBSERVABILITY_ATTRIBUTES.genAiRequestModel]: model,
    [MOSS_LEGACY_ATTRIBUTE_ALIASES.requestModel]: model,
  };
}

/** Map an arbitrary runtime error into the bounded MOC category catalog. @public */
export function classifyMossErrorCategory(error: unknown): MossErrorCategory {
  if (isMossError(error)) {
    switch (error.code) {
      case ErrorCode.USER_ABORTED:
      case ErrorCode.AGENT_DISPOSED:
        return 'aborted';
      case ErrorCode.TOOL_EXECUTION_TIMEOUT:
        return 'timeout';
      case ErrorCode.TOOL_NOT_ALLOWED:
      case ErrorCode.MESH_QUERY_REJECTED:
        return 'policy';
      case ErrorCode.USER_INPUT_INVALID:
      case ErrorCode.TOOL_NOT_FOUND:
        return 'validation';
      case ErrorCode.PROVIDER_AUTH_FAILED:
      case ErrorCode.PROVIDER_CONFIG_MISSING:
      case ErrorCode.PROVIDER_CONTEXT_OVERFLOW:
      case ErrorCode.PROVIDER_RATE_LIMITED:
      case ErrorCode.PROVIDER_UPSTREAM_ERROR:
        return 'provider';
      case ErrorCode.TOOL_EXECUTION_FAILED:
        return 'tool';
      case ErrorCode.SESSION_PERSIST_FAILED:
      case ErrorCode.EXECUTION_STORE_FAILED:
      case ErrorCode.CONFIG_IO_FAILED:
        return 'storage';
      case ErrorCode.INTERNAL_INVARIANT_VIOLATED:
        return 'internal';
      default:
        return 'unknown';
    }
  }
  if (error && typeof error === 'object' && 'originalError' in error) {
    const originalError = (error as { originalError?: unknown }).originalError;
    if (originalError !== undefined && originalError !== error) {
      return classifyMossErrorCategory(originalError);
    }
  }
  if (error instanceof Error && error.name === 'AbortError') return 'aborted';
  if (error instanceof Error && error.name === 'LlmFirstChunkTimeoutError') return 'timeout';
  const message = errorMessage(error);
  if (/timed?\s*out|timeout/i.test(message)) return 'timeout';
  if (/\babort(?:ed)?\b|\bcancelled by user\b/i.test(message)) return 'aborted';
  return 'unknown';
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
