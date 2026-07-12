/**
 * OpenTelemetry metrics for Moss.
 *
 * Records LLM token/call, tool duration/success, session metrics via the
 * official OTel SDK Meter. Sent periodically (10s) to an OTLP/HTTP backend
 * (the local receiver's /v1/metrics). Independent of tracing.
 *
 * When not enabled, all record calls are noop — zero overhead.
 *
 * Usage:
 *   import { enableOtelMetrics } from '@rdk-moss/agent/observability';
 *   enableOtelMetrics({ serviceName: 'moss' });
 */
import { metrics } from '@opentelemetry/api';
import { MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';

export interface OtelMetricsOptions {
  /** Service name shown in backend (default: 'moss') */
  serviceName?: string;
  /** OTLP metrics endpoint (default: 'http://localhost:4318/v1/metrics') */
  url?: string;
  /** Export interval in ms (default: 10000) */
  exportIntervalMs?: number;
}

let enabled = false;
let provider: MeterProvider | null = null;

/** Noop instruments — used when metrics disabled so business sites stay zero-cost. */
type AnyCounter = { add(_v: number, _a?: Record<string, string>): void };
type AnyHistogram = { record(_v: number, _a?: Record<string, string>): void };

/**
 * Singleton metrics handle. Initially noop; replaced with real instruments by
 * enableOtelMetrics(). Business code imports this and calls .add()/.record()
 * unconditionally — noop when disabled.
 */
export const mossMetrics = {
  llmTokens: { add: () => {} } as AnyCounter,
  llmCalls: { add: () => {} } as AnyCounter,
  llmDuration: { record: () => {} } as AnyHistogram,
  toolCalls: { add: () => {} } as AnyCounter,
  toolDuration: { record: () => {} } as AnyHistogram,
  sessionCount: { add: () => {} } as AnyCounter,
  sessionDuration: { record: () => {} } as AnyHistogram,
  sessionTurns: { record: () => {} } as AnyHistogram,
};

export function enableOtelMetrics(options: OtelMetricsOptions = {}): void {
  if (enabled) return;
  enabled = true;
  const serviceName = options.serviceName ?? 'moss';
  const url = options.url ?? 'http://localhost:4318/v1/metrics';
  const interval = options.exportIntervalMs ?? 10000;

  const resource = resourceFromAttributes({ 'service.name': serviceName });
  const exporter = new OTLPMetricExporter({ url });
  const reader = new PeriodicExportingMetricReader({
    exporter,
    exportIntervalMillis: interval,
  });
  provider = new MeterProvider({ resource, readers: [reader] });
  metrics.setGlobalMeterProvider(provider);

  const meter = provider.getMeter('moss-agent');
  // Replace noop instances with real instruments.
  mossMetrics.llmTokens = meter.createCounter('moss.llm.tokens');
  mossMetrics.llmCalls = meter.createCounter('moss.llm.calls');
  mossMetrics.llmDuration = meter.createHistogram('moss.llm.duration_ms');
  mossMetrics.toolCalls = meter.createCounter('moss.tool.calls');
  mossMetrics.toolDuration = meter.createHistogram('moss.tool.duration_ms');
  mossMetrics.sessionCount = meter.createCounter('moss.session.count');
  mossMetrics.sessionDuration = meter.createHistogram('moss.session.duration_ms');
  mossMetrics.sessionTurns = meter.createHistogram('moss.session.turns');

  // Runtime process metrics (ObservableGauge — auto-collected by SDK each export).
  // Uses node built-in process.memoryUsage(); zero external dependency.
  const rssGauge = meter.createObservableGauge('moss.process.rss_bytes');
  const heapGauge = meter.createObservableGauge('moss.process.heap_bytes');
  rssGauge.addCallback((observableResult) => {
    observableResult.observe(process.memoryUsage().rss, {});
  });
  heapGauge.addCallback((observableResult) => {
    observableResult.observe(process.memoryUsage().heapUsed, {});
  });
}

export function disableOtelMetrics(): void {
  if (!enabled) return;
  try { provider?.shutdown(); } catch {
    // Silently ignore — monitoring is best-effort
  }
  enabled = false;
}
