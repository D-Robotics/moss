/**
 * OpenTelemetry SDK assembly — single NodeSDK for trace + metric, shared Resource.
 * Local file trace attaches as a FileSpanProcessor alongside the OTLP exporter.
 *
 * initObservabilitySdk reads env to decide what to start. When disabled it
 * does nothing (no SDK, no timers). shutdownObservabilitySdk flushes all
 * exporters/processors (fire-and-forget send errors never crash the agent).
 */
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { BatchSpanProcessor, TraceIdRatioBasedSampler } from '@opentelemetry/sdk-trace-base';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import fs from 'node:fs';
import path from 'node:path';
import { FileSpanProcessor } from './file-trace.js';
import { ConsoleSpanProcessor } from './console-trace.js';
import type { SpanProcessor } from '@opentelemetry/sdk-trace-base';

export interface ObservabilityConfig {
  serviceName: string;
  otlpUrl: string;
  enabled: boolean;
  metricsEnabled: boolean;
  fileTraceEnabled: boolean;
  consoleTraceEnabled: boolean;
  workspaceDir: string;
  /** Head-sampling ratio for OTLP export (0..1]; unset = keep everything. */
  sampleRatio?: number;
  /**
   * Host-supplied processors attached regardless of OTLP/file/console flags —
   * lets an embedding host collect spans in-process
   * without standing up its own OTel SDK or receiver.
   */
  extraSpanProcessors?: SpanProcessor[];
}

let sdk: NodeSDK | null = null;

/** Read package version from packages/moss-agent/package.json (not hardcoded). */
function readPackageVersion(): string {
  try {
    const pkgPath = path.join(import.meta.dirname, '..', '..', 'package.json');
    return String(JSON.parse(fs.readFileSync(pkgPath, 'utf-8')).version ?? '0.0.0');
  } catch {
    return '0.0.0';
  }
}

export function initObservabilitySdk(cfg: ObservabilityConfig): void {
  // Start the SDK if anything is enabled: OTel tracing/metrics, local file
  // trace, console trace (MOSS_TRACE=console runs standalone), or a host
  // collector attached via extraSpanProcessors. Guarded against double-init
  // via the `sdk` singleton below.
  const extraProcessors = cfg.extraSpanProcessors ?? [];
  const wantsStart = cfg.enabled || cfg.consoleTraceEnabled || extraProcessors.length > 0;
  if (!wantsStart || sdk) return;
  try {
    const resource = resourceFromAttributes({
      [ATTR_SERVICE_NAME]: cfg.serviceName,
      [ATTR_SERVICE_VERSION]: readPackageVersion(),
    });

    const spanProcessors: SpanProcessor[] = [...extraProcessors];
    if (cfg.consoleTraceEnabled) {
      spanProcessors.push(new ConsoleSpanProcessor());
    }
    if (cfg.enabled) {
      spanProcessors.push(new BatchSpanProcessor(new OTLPTraceExporter({ url: `${cfg.otlpUrl}/v1/traces` })));
    }
    if (cfg.enabled && cfg.fileTraceEnabled) {
      spanProcessors.push(new FileSpanProcessor(cfg.workspaceDir));
    }

    // If nothing is enabled (no console, no OTel, no host collector), don't
    // start the SDK at all.
    if (spanProcessors.length === 0 && !cfg.metricsEnabled) return;

    const sampleRatio = cfg.sampleRatio;
    const sampler =
      typeof sampleRatio === 'number' && sampleRatio > 0 && sampleRatio < 1
        ? new TraceIdRatioBasedSampler(sampleRatio)
        : undefined;

    const metricReaders = (cfg.enabled && cfg.metricsEnabled)
      ? [new PeriodicExportingMetricReader({
          exporter: new OTLPMetricExporter({ url: `${cfg.otlpUrl}/v1/metrics` }),
          exportIntervalMillis: 10_000,
        })]
      : [];

    sdk = new NodeSDK({
      resource,
      spanProcessors,
      ...(sampler ? { sampler } : {}),
      ...(metricReaders.length > 0 ? { metricReaders } : {}),
    });
    sdk.start();
  } catch {
    // Best-effort — never block the agent. Failure means no telemetry, not a crash.
  }
}

export async function shutdownObservabilitySdk(): Promise<void> {
  if (!sdk) return;
  try { await sdk.shutdown(); } catch { /* ignore */ }
  sdk = null;
}
