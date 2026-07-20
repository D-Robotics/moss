/**
 * OpenTelemetry metrics for Moss — instrument handles.
 *
 * Instruments are resolved LAZILY from the global MeterProvider on first use,
 * so they pick up the real MeterProvider once the SDK is started
 * (sdk.ts → setGlobalMeterProvider). When observability is disabled (no
 * provider registered), metrics.getMeter() returns a noop meter whose
 * instruments are no-ops — business code calls .add()/.record()
 * unconditionally at zero cost.
 *
 * Resolving eagerly at module load would bind to the noop meter before the SDK
 * starts; the cached noop instruments would never switch to real ones.
 *
 * Usage:
 *   import { mossMetrics } from './observability/index.js';
 *   mossMetrics.llmTokens.add(inputTokens, { direction: 'input', model });
 */
import { metrics } from '@opentelemetry/api';

const meter = () => metrics.getMeter('moss-agent');

type Counter = { add(value: number, attributes?: Record<string, string | number | boolean>): void };
type Histogram = { record(value: number, attributes?: Record<string, string | number | boolean>): void };

function counter(name: string, opts?: { unit?: string }): () => Counter {
  let cached: Counter | undefined;
  return () => (cached ??= meter().createCounter(name, opts));
}
function histogram(name: string, opts?: { unit?: string }): () => Histogram {
  let cached: Histogram | undefined;
  return () => (cached ??= meter().createHistogram(name, opts));
}

// Wrap a lazily-resolved instrument in a stable object exposing .add/.record
// so call-sites write `mossMetrics.x.add(...)` unchanged.
function counterHandle(name: string, opts?: { unit?: string }): Counter {
  const get = counter(name, opts);
  return {
    add(value, attributes) {
      try { get().add(value, attributes ?? {}); } catch { /* noop */ }
    },
  };
}
function histogramHandle(name: string, opts?: { unit?: string }): Histogram {
  const get = histogram(name, opts);
  return {
    record(value, attributes) {
      try { get().record(value, attributes ?? {}); } catch { /* noop */ }
    },
  };
}

export const mossMetrics = {
  // LLM
  llmTokens: counterHandle('moss.llm.tokens', { unit: '{token}' }),
  llmDuration: histogramHandle('moss.llm.request.duration', { unit: 'ms' }),
  // tool
  toolInvocations: counterHandle('moss.tool.invocations'),
  toolDuration: histogramHandle('moss.tool.invoke.duration', { unit: 'ms' }),
  // session
  sessionCount: counterHandle('moss.session.count'),
  sessionDuration: histogramHandle('moss.session.duration', { unit: 'ms' }),
  // 每轮工具数（纠正 from-remote 把它误命名为 session.turns 的错位）
  sessionToolCount: histogramHandle('moss.session.tool_count'),
};
