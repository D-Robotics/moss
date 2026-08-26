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
 * Import `mossMetrics` from the observability entry point and record tokens
 * with the relevant direction and model attributes.
 */
import { metrics } from '@opentelemetry/api';
import {
  MOSS_METRIC_CATALOG,
  normalizeMetricModelFamily,
  normalizeMetricToolCategory,
  type MossOutcome,
} from './contract.js';

/** Public counter handle used by the stable `mossMetrics` catalog. @public */
export type Counter = {
  add(value: number, attributes?: Record<string, string | number | boolean>): void;
};

/** Public histogram handle used by the stable `mossMetrics` catalog. @public */
export type Histogram = {
  record(value: number, attributes?: Record<string, string | number | boolean>): void;
};

const VALID_OUTCOMES = new Set<MossOutcome>([
  'ok',
  'error',
  'cancelled',
  'denied',
  'blocked',
  'incomplete',
  'replayed',
  'suppressed',
]);

/**
 * Enforce the MOC low-cardinality metric dimension allowlist. Unknown and
 * identifier-shaped dimensions are dropped rather than forwarded.
 * @public
 */
export function sanitizeMetricAttributes(
  metricName: string,
  attributes: Record<string, string | number | boolean> | undefined
): Record<string, string> {
  const source = attributes ?? {};
  const normalized: Record<string, string> = {};
  const rawOutcome = source['moss.outcome'] ?? source.outcome ?? source.status;
  if (typeof rawOutcome === 'string' && VALID_OUTCOMES.has(rawOutcome as MossOutcome)) {
    normalized['moss.outcome'] = rawOutcome;
  }

  if (metricName === MOSS_METRIC_CATALOG.llmTokens.name) {
    const direction = source.direction;
    if (direction === 'input' || direction === 'output') normalized.direction = direction;
  }

  if (
    metricName === MOSS_METRIC_CATALOG.llmTokens.name ||
    metricName === MOSS_METRIC_CATALOG.llmRequestDuration.name
  ) {
    const model = source['model.family'] ?? source.model;
    normalized['model.family'] = normalizeMetricModelFamily(
      typeof model === 'string' ? model : undefined
    );
  }

  if (
    metricName === MOSS_METRIC_CATALOG.toolInvocations.name ||
    metricName === MOSS_METRIC_CATALOG.toolInvokeDuration.name
  ) {
    const tool = source['tool.category'] ?? source.tool ?? source.toolName;
    normalized['tool.category'] = normalizeMetricToolCategory(
      typeof tool === 'string' ? tool : undefined
    );
  }
  return normalized;
}

function counter(name: string, opts?: { unit?: string }): () => Counter {
  let cached: Counter | undefined;
  let cachedProvider: ReturnType<typeof metrics.getMeterProvider> | undefined;
  return () => {
    const provider = metrics.getMeterProvider();
    if (!cached || provider !== cachedProvider) {
      cachedProvider = provider;
      cached = provider.getMeter('moss-agent').createCounter(name, opts);
    }
    return cached;
  };
}
function histogram(name: string, opts?: { unit?: string }): () => Histogram {
  let cached: Histogram | undefined;
  let cachedProvider: ReturnType<typeof metrics.getMeterProvider> | undefined;
  return () => {
    const provider = metrics.getMeterProvider();
    if (!cached || provider !== cachedProvider) {
      cachedProvider = provider;
      cached = provider.getMeter('moss-agent').createHistogram(name, opts);
    }
    return cached;
  };
}

// Wrap a lazily-resolved instrument in a stable object exposing .add/.record
// so call-sites write `mossMetrics.x.add(...)` unchanged.
function counterHandle(name: string, opts?: { unit?: string }): Counter {
  const get = counter(name, opts);
  return {
    add(value, attributes) {
      try {
        if (!Number.isFinite(value) || value < 0) return;
        get().add(value, sanitizeMetricAttributes(name, attributes));
      } catch {
        /* noop */
      }
    },
  };
}
function histogramHandle(name: string, opts?: { unit?: string }): Histogram {
  const get = histogram(name, opts);
  return {
    record(value, attributes) {
      try {
        if (!Number.isFinite(value) || value < 0) return;
        get().record(value, sanitizeMetricAttributes(name, attributes));
      } catch {
        /* noop */
      }
    },
  };
}

export const mossMetrics = {
  // LLM
  llmTokens: counterHandle(MOSS_METRIC_CATALOG.llmTokens.name, {
    unit: MOSS_METRIC_CATALOG.llmTokens.unit,
  }),
  llmDuration: histogramHandle(MOSS_METRIC_CATALOG.llmRequestDuration.name, {
    unit: MOSS_METRIC_CATALOG.llmRequestDuration.unit,
  }),
  // tool
  toolInvocations: counterHandle(MOSS_METRIC_CATALOG.toolInvocations.name, {
    unit: MOSS_METRIC_CATALOG.toolInvocations.unit,
  }),
  toolDuration: histogramHandle(MOSS_METRIC_CATALOG.toolInvokeDuration.name, {
    unit: MOSS_METRIC_CATALOG.toolInvokeDuration.unit,
  }),
  // session
  sessionCount: counterHandle(MOSS_METRIC_CATALOG.sessionCount.name, {
    unit: MOSS_METRIC_CATALOG.sessionCount.unit,
  }),
  sessionDuration: histogramHandle(MOSS_METRIC_CATALOG.sessionDuration.name, {
    unit: MOSS_METRIC_CATALOG.sessionDuration.unit,
  }),
  // 每轮工具数（纠正 from-remote 把它误命名为 session.turns 的错位）
  sessionToolCount: histogramHandle(MOSS_METRIC_CATALOG.sessionToolCount.name, {
    unit: MOSS_METRIC_CATALOG.sessionToolCount.unit,
  }),
};
