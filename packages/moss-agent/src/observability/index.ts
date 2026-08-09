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
  startSpan,
  turnAttributes,
  toolAttributes,
  llmRequestAttributes,
  sessionAttributes,
} from './tracing.js';
export type { Tracer, TraceSpan, ActiveSpan } from './tracing.js';
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
  resolveLLMUsageLogPath,
} from './llm-usage.js';
export type { LLMUsageRecord, LLMUsageSummary } from './llm-usage.js';

import { initObservabilitySdk } from './sdk.js';
import type { SpanProcessor } from '@opentelemetry/sdk-trace-base';
import { propagation, context as otelContext, defaultTextMapSetter } from '@opentelemetry/api';

export interface InitOptions {
  workspaceDir: string;
  serviceName?: string;
  otlpUrl?: string;
  /**
   * Host-supplied span processors collected in-process by the embedding host
   * (e.g. a host server persisting per-run span trees). Their presence
   * alone starts the SDK even with OTLP/file/console tracing disabled.
   */
  extraSpanProcessors?: SpanProcessor[];
}

export function initObservability(opts: InitOptions): void {
  const otelEnabled = process.env.MOSS_OTEL_ENABLED === '1' || !!process.env.MOSS_OTEL_URL;
  // MOSS_TRACE=console streams spans to stderr for local debugging, and can
  // run on its own (no OTLP receiver needed).
  const consoleTrace =
    process.env.MOSS_TRACE === 'console' ||
    process.env.MOSS_TRACE === '1' ||
    process.env.MOSS_TRACE === 'true';
  const extraSpanProcessors = opts.extraSpanProcessors ?? [];
  if (!otelEnabled && !consoleTrace && extraSpanProcessors.length === 0) return;
  // MOSS_OTEL_SAMPLE_RATIO head-samples SDK spans when no host collector is
  // attached. Host collectors do their own tail sampling and must see every
  // span, so sdk.ts keeps the SDK-wide sampler AlwaysOn in that mode.
  const sampleRatioRaw = Number(process.env.MOSS_OTEL_SAMPLE_RATIO);
  const sampleRatio =
    Number.isFinite(sampleRatioRaw) && sampleRatioRaw > 0 && sampleRatioRaw < 1
      ? sampleRatioRaw
      : undefined;
  initObservabilitySdk({
    serviceName: process.env.MOSS_OTEL_SERVICE_NAME ?? opts.serviceName ?? 'moss',
    otlpUrl: process.env.MOSS_OTEL_URL ?? opts.otlpUrl ?? 'http://localhost:4318',
    enabled: otelEnabled,
    // tracing 开则 metrics 默认开（纠正 from-remote 两开关易漏配）
    metricsEnabled: otelEnabled && process.env.MOSS_METRICS_ENABLED !== '0',
    // 本地文件 trace 默认开（仅 OTel 启用时），MOSS_FILE_TRACE=0 关
    fileTraceEnabled: otelEnabled && process.env.MOSS_FILE_TRACE !== '0',
    consoleTraceEnabled: consoleTrace,
    workspaceDir: opts.workspaceDir,
    ...(sampleRatio ? { sampleRatio } : {}),
    ...(extraSpanProcessors.length > 0 ? { extraSpanProcessors } : {}),
  });
}

export { shutdownObservabilitySdk as shutdownObservability } from './sdk.js';

/**
 * Inject W3C traceparent into outbound fetch headers for the current span.
 * Returns headers unchanged when no active span (graceful degradation).
 */
export function propagateHeaders(headers: Record<string, string> = {}): Record<string, string> {
  try {
    const injected: Record<string, string> = { ...headers };
    propagation.inject(otelContext.active(), injected, defaultTextMapSetter);
    return injected;
  } catch {
    return headers;
  }
}
