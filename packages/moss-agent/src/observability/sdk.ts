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
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import fs from 'node:fs';
import path from 'node:path';
import { FileSpanProcessor } from './file-trace.js';
import type { SpanProcessor } from '@opentelemetry/sdk-trace-base';

export interface ObservabilityConfig {
  serviceName: string;
  otlpUrl: string;
  enabled: boolean;
  metricsEnabled: boolean;
  fileTraceEnabled: boolean;
  workspaceDir: string;
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
  if (!cfg.enabled || sdk) return;
  try {
    const resource = resourceFromAttributes({
      [ATTR_SERVICE_NAME]: cfg.serviceName,
      [ATTR_SERVICE_VERSION]: readPackageVersion(),
    });

    const spanProcessors: SpanProcessor[] = [
      new BatchSpanProcessor(new OTLPTraceExporter({ url: `${cfg.otlpUrl}/v1/traces` })),
    ];
    if (cfg.fileTraceEnabled) {
      spanProcessors.push(new FileSpanProcessor(cfg.workspaceDir));
    }

    const metricReaders = cfg.metricsEnabled
      ? [new PeriodicExportingMetricReader({
          exporter: new OTLPMetricExporter({ url: `${cfg.otlpUrl}/v1/metrics` }),
          exportIntervalMillis: 10_000,
        })]
      : [];

    sdk = new NodeSDK({
      resource,
      spanProcessors,
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
