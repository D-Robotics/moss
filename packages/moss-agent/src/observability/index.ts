/**
 * Observability public entrypoint.
 *
 * initObservability() wires up the OTel SDK (trace + metric + local file
 * trace) based on env vars; when disabled it is a no-op and withSpan /
 * mossMetrics.* run as no-ops. Call once at CLI startup (before agent
 * creation); call shutdownObservability() on exit to flush.
 */
export { redactSensitiveData, parseTelemetryAllow } from './redact.js';
export type { RedactOptions } from './redact.js';
export {
  TraceRegistry,
  setTracer,
  setTraceRedactor,
  getTracer,
  withSpan,
  turnAttributes,
  toolAttributes,
  llmRequestAttributes,
  sessionAttributes,
} from './tracing.js';
export type { Tracer, TraceSpan } from './tracing.js';
export { mossMetrics } from './metrics.js';
export { FileSpanProcessor, readTraceStats } from './file-trace.js';
export type { SerializedSpan, TraceStats } from './file-trace.js';
export {
  logLLMUsage,
  readUsageLog,
  summarizeUsage,
  formatUsageSummary,
  estimateLLMCost,
  registerModelPricing,
} from './llm-usage.js';
export type { LLMUsageRecord, LLMUsageSummary } from './llm-usage.js';

import { initObservabilitySdk } from './sdk.js';
import { propagation, context as otelContext, defaultTextMapSetter } from '@opentelemetry/api';

export interface InitOptions {
  workspaceDir: string;
  serviceName?: string;
  otlpUrl?: string;
}

export function initObservability(opts: InitOptions): void {
  const enabled = process.env.MOSS_OTEL_ENABLED === '1' || !!process.env.MOSS_OTEL_URL;
  if (!enabled) return;
  initObservabilitySdk({
    serviceName: process.env.MOSS_OTEL_SERVICE_NAME ?? opts.serviceName ?? 'moss',
    otlpUrl: process.env.MOSS_OTEL_URL ?? opts.otlpUrl ?? 'http://localhost:4318',
    enabled: true,
    // tracing 开则 metrics 默认开（纠正 from-remote 两开关易漏配）
    metricsEnabled: process.env.MOSS_METRICS_ENABLED !== '0',
    // 本地文件 trace 默认开，MOSS_FILE_TRACE=0 关
    fileTraceEnabled: process.env.MOSS_FILE_TRACE !== '0',
    workspaceDir: opts.workspaceDir,
  });
}

export { shutdownObservabilitySdk as shutdownObservability } from './sdk.js';

/**
 * Inject W3C traceparent into outbound fetch headers for the current span.
 * Returns headers unchanged when no active span (graceful degradation).
 */
export function propagateHeaders(
  headers: Record<string, string> = {},
): Record<string, string> {
  try {
    const injected: Record<string, string> = { ...headers };
    propagation.inject(otelContext.active(), injected, defaultTextMapSetter);
    return injected;
  } catch {
    return headers;
  }
}
