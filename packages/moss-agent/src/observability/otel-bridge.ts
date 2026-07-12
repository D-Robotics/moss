/**
 * OpenTelemetry bridge for Moss tracing.
 *
 * Sends Moss spans directly to an OTLP-compatible backend (Jaeger, Grafana)
 * via HTTP. No OTel SDK dependency — just standard fetch + JSON.
 *
 * 这是刻意为之：bridge 用 fetch 直接发 OTLP/JSON，避免引入 @opentelemetry/* SDK 包。
 * 未经具体需求（如 metrics、跨进程 context propagation）不要在此引入 SDK 依赖，
 * 详见 docs/superpowers/specs/ 下的可观测性加固 spec。
 *
 * Usage:
 *   import { enableOtelTracing } from '@rdk-moss/agent/observability';
 *   enableOtelTracing({ serviceName: 'moss' });
 */
import { setTracer, getTracer } from './tracing.js';
import type { Tracer } from './tracing.js';

export interface OtelTracingOptions {
  /** Service name shown in Jaeger/Grafana (default: 'moss') */
  serviceName?: string;
  /** OTLP HTTP endpoint (default: 'http://localhost:4318/v1/traces') */
  url?: string;
}

let enabled = false;
let otlpUrl = '';
let serviceName = '';

// ── Internal span state (carries traceId / spanId for parent-child linking) ───

interface OtelSpanState {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  mutableAttributes: Record<string, string | number | boolean>;
  events: Array<{ name: string; time: number; attrs?: Record<string, unknown> }>;
  status: 'ok' | 'error';
  statusMessage?: string;
  startTime: number;
  name: string;
  initialAttributes: Record<string, string | number | boolean>;
  /** Sampling decision — false spans are built (parent chain intact) but not sent. */
  sampled: boolean;
}

/** Symbol key to store OtelSpanState on the TraceSpan object without polluting the public interface. */
const OTEL_STATE = Symbol('otel-state');

/** Trace sampling ratio (0..1). Default 1.0 = full sampling = current behavior. */
const TRACE_SAMPLE_RATIO = Number(process.env.MOSS_TRACE_SAMPLE_RATIO ?? 1.0);

/**
 * Decide whether a root span's trace is sampled, deterministically by traceId.
 * Child spans inherit their parent's decision (handled at startSpan).
 */
function sampleByTraceId(traceId: string, ratio: number): boolean {
  if (ratio >= 1) return true;
  if (ratio <= 0) return false;
  const hex = (traceId.slice(0, 8) || '0').padStart(8, '0');
  const v = Number.parseInt(hex, 16) / 0xffffffff;
  return v < ratio;
}

function sendSpan(state: OtelSpanState): void {
  if (!enabled) return;
  if (!state.sampled) return;

  // Merge initial attributes (passed at startSpan) with mutable attributes
  // (set via span.setAttribute during the span's lifetime).
  const mergedAttributes = { ...state.initialAttributes, ...state.mutableAttributes };

  const otlpSpan: Record<string, unknown> = {
    traceId: state.traceId,
    spanId: state.spanId,
    name: state.name,
    kind: 1, // INTERNAL
    startTimeUnixNano: String(BigInt(state.startTime) * 1_000_000n),
    endTimeUnixNano: String(BigInt(Date.now()) * 1_000_000n),
    attributes: Object.entries(mergedAttributes).map(([key, value]) => ({
      key,
      value: typeof value === 'number' ? { intValue: value }
           : typeof value === 'boolean' ? { boolValue: value }
           : { stringValue: String(value) },
    })),
    status: state.status === 'error'
      ? { code: 2, message: state.statusMessage ?? '' }
      : { code: 1 },
    events: state.events.map((e) => ({
      name: e.name,
      timeUnixNano: String(BigInt(e.time) * 1_000_000n),
    })),
  };

  // Link to parent span when available
  if (state.parentSpanId) {
    otlpSpan.parentSpanId = state.parentSpanId;
  }

  const payload = {
    resourceSpans: [{
      resource: {
        attributes: [{
          key: 'service.name',
          value: { stringValue: serviceName },
        }],
      },
      scopeSpans: [{
        scope: { name: 'moss-agent' },
        spans: [otlpSpan],
      }],
    }],
  };

  // Fire-and-forget — never block the agent
  fetch(otlpUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }).catch(() => {
    // Silently ignore send errors
  });
}

function generateHex(len: number): string {
  return Array.from({ length: len }, () =>
    Math.floor(Math.random() * 16).toString(16),
  ).join('');
}

function generateTraceId(): string {
  return generateHex(32);
}

function generateSpanId(): string {
  return generateHex(16);
}

/**
 * Enable OpenTelemetry tracing. Spans are sent directly to the configured
 * OTLP HTTP endpoint. No Collector required — works with Jaeger all-in-one
 * or any OTLP-compatible backend.
 */
export function enableOtelTracing(options: OtelTracingOptions = {}): void {
  enabled = true;
  serviceName = options.serviceName ?? 'moss';
  otlpUrl = options.url ?? 'http://localhost:4318/v1/traces';

  const baseTracer = getTracer();

  const otelTracer: Tracer = {
    startSpan(name, attributes, _parent) {
      const startTime = Date.now();

      // Inherit traceId from parent span, or generate a new one for root spans
      const parentState = _parent
        ? ((_parent as unknown as Record<string | symbol, unknown>)[OTEL_STATE] as OtelSpanState | undefined)
        : undefined;
      const traceId = parentState?.traceId ?? generateTraceId();
      const spanId = generateSpanId();
      const parentSpanId = parentState?.spanId;
      // Child spans inherit sampling decision from parent; root spans decide by traceId hash.
      const sampled = parentState ? parentState.sampled : sampleByTraceId(traceId, TRACE_SAMPLE_RATIO);

      const state: OtelSpanState = {
        traceId,
        spanId,
        parentSpanId,
        mutableAttributes: {},
        events: [],
        status: 'ok',
        statusMessage: undefined,
        startTime,
        name,
        initialAttributes: attributes ?? {},
        sampled,
      };

      const span = {
        setAttribute(key: string, value: string | number | boolean) {
          state.mutableAttributes[key] = value;
        },
        addEvent(eventName: string, eventAttrs?: Record<string, string | number | boolean>) {
          state.events.push({ name: eventName, time: Date.now(), attrs: eventAttrs });
        },
        setStatus(ok: boolean, message?: string) {
          state.status = ok ? 'ok' : 'error';
          state.statusMessage = message;
        },
        end() {
          sendSpan(state);

          // Also forward to the base tracer (e.g. local file exporter)
          const baseSpan = baseTracer.startSpan(name, attributes, _parent);
          baseSpan.setStatus(state.status === 'ok', state.statusMessage);
          for (const e of state.events) {
            baseSpan.addEvent(e.name, e.attrs as Record<string, string | number | boolean>);
          }
          baseSpan.end();
        },
        [OTEL_STATE]: state,
      };

      return span;
    },
  };

  setTracer(otelTracer);
}

/**
 * Disable OTel tracing and revert to the default tracer.
 */
export function disableOtelTracing(): void {
  enabled = false;
  setTracer(getTracer());
}