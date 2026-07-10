/**
 * OpenTelemetry bridge for Moss tracing.
 *
 * Sends Moss spans directly to an OTLP-compatible backend (Jaeger, Grafana)
 * via HTTP. No OTel SDK dependency — just standard fetch + JSON.
 *
 * Usage:
 *   import { enableOtelTracing } from '@rdk-moss/agent/observability';
 *   enableOtelTracing({ serviceName: 'moss' });
 */
import { setTracer, getTracer } from './tracing.js';
import type { Tracer } from './tracing.js';
import type { SerializedSpan } from './trace-exporter.js';

export interface OtelTracingOptions {
  /** Service name shown in Jaeger/Grafana (default: 'moss') */
  serviceName?: string;
  /** OTLP HTTP endpoint (default: 'http://localhost:4318/v1/traces') */
  url?: string;
}

let enabled = false;
let otlpUrl = '';
let serviceName = '';

function sendSpan(span: SerializedSpan): void {
  if (!enabled) return;

  // Convert Moss span to OTLP JSON format
  const otlpSpan = {
    traceId: generateTraceId(),
    spanId: generateSpanId(),
    name: span.name,
    kind: 1, // INTERNAL
    startTimeUnixNano: String(BigInt(span.startTime) * 1_000_000n),
    endTimeUnixNano: String(BigInt(span.endTime) * 1_000_000n),
    attributes: Object.entries(span.attributes).map(([key, value]) => ({
      key,
      value: typeof value === 'number' ? { intValue: value }
           : typeof value === 'boolean' ? { boolValue: value }
           : { stringValue: String(value) },
    })),
    status: span.status === 'error'
      ? { code: 2, message: span.statusMessage ?? '' }
      : { code: 1 },
    events: span.events.map((e) => ({
      name: e.name,
      timeUnixNano: String(BigInt(e.time) * 1_000_000n),
    })),
  };

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
      const events: SerializedSpan['events'] = [];
      let status: SerializedSpan['status'] = 'ok';
      let statusMessage: string | undefined;

      return {
        setAttribute() {},
        addEvent(eventName, eventAttrs) {
          events.push({ name: eventName, time: Date.now(), attrs: eventAttrs });
        },
        setStatus(ok, message) {
          status = ok ? 'ok' : 'error';
          statusMessage = message;
        },
        end() {
          sendSpan({
            name,
            startTime,
            endTime: Date.now(),
            attributes: attributes ?? {},
            events,
            status,
            ...(statusMessage ? { statusMessage } : {}),
          });

          // Also forward to the base tracer (e.g. local file exporter)
          const baseSpan = baseTracer.startSpan(name, attributes, _parent);
          baseSpan.setStatus(status === 'ok', statusMessage);
          for (const e of events) {
            baseSpan.addEvent(e.name, e.attrs as Record<string, string | number | boolean>);
          }
          baseSpan.end();
        },
      };
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