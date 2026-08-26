import { SpanStatusCode } from '@opentelemetry/api';
import type { Attributes, HrTime } from '@opentelemetry/api';
import type { ReadableSpan, SpanProcessor } from '@opentelemetry/sdk-trace-base';
import type { Context } from '@opentelemetry/api';

import {
  isValidMossSpanId,
  isValidMossTraceId,
  MOSS_OBSERVABILITY_ATTRIBUTES,
  type MossOutcome,
} from './contract.js';

/** Scalar attributes retained by the normalized MOC representation. @public */
export type NormalizedSpanAttributeValue = string | number | boolean;

/** Immutable event on a normalized ended span. @public */
export interface NormalizedSpanEvent {
  readonly name: string;
  readonly time_unix_ms: number;
  readonly attributes: Readonly<Record<string, NormalizedSpanAttributeValue>>;
}

/** Immutable, vendor-neutral representation of one ended span. @public */
export interface NormalizedEndedSpan {
  readonly name: string;
  readonly trace_id: string;
  readonly span_id: string;
  readonly parent_span_id?: string;
  readonly start_time_unix_ms: number;
  readonly end_time_unix_ms: number;
  readonly duration_ms: number;
  readonly attributes: Readonly<Record<string, NormalizedSpanAttributeValue>>;
  readonly events: readonly NormalizedSpanEvent[];
  readonly outcome: MossOutcome;
  readonly status: 'UNSET' | 'OK' | 'ERROR';
  readonly status_message?: string;
}

/** Host/export destination that receives immutable normalized ended spans. @public */
export interface MossSpanConsumer {
  readonly id: string;
  onSpan(span: NormalizedEndedSpan): void | Promise<void>;
  forceFlush?(): void | Promise<void>;
  shutdown?(): void | Promise<void>;
}

/** Delivery/flush health for a normalized span fan-out processor. @public */
export interface MossSpanConsumerHealth {
  readonly deliveredSpans: number;
  readonly deliveryFailures: number;
  readonly flushFailures: number;
  readonly pendingDeliveries: number;
}

function hrToMs(hr: HrTime): number {
  return hr[0] * 1000 + Math.trunc(hr[1] / 1_000_000);
}

function scalarAttributes(
  attributes: Attributes | undefined
): Record<string, NormalizedSpanAttributeValue> {
  const normalized: Record<string, NormalizedSpanAttributeValue> = {};
  for (const [key, value] of Object.entries(attributes ?? {})) {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      normalized[key] = value;
    }
  }
  return normalized;
}

function statusName(code: SpanStatusCode): 'UNSET' | 'OK' | 'ERROR' {
  if (code === SpanStatusCode.OK) return 'OK';
  if (code === SpanStatusCode.ERROR) return 'ERROR';
  return 'UNSET';
}

function outcomeFromSpan(span: ReadableSpan): MossOutcome {
  const value = span.attributes[MOSS_OBSERVABILITY_ATTRIBUTES.outcome];
  if (
    value === 'ok' ||
    value === 'error' ||
    value === 'cancelled' ||
    value === 'denied' ||
    value === 'blocked' ||
    value === 'incomplete' ||
    value === 'replayed' ||
    value === 'suppressed'
  ) {
    return value;
  }
  if (span.status.code === SpanStatusCode.ERROR) return 'error';
  if (span.status.code === SpanStatusCode.OK) return 'ok';
  return 'incomplete';
}

function freezeNormalizedSpan(span: NormalizedEndedSpan): NormalizedEndedSpan {
  for (const event of span.events) {
    Object.freeze(event.attributes);
    Object.freeze(event);
  }
  Object.freeze(span.events);
  Object.freeze(span.attributes);
  return Object.freeze(span);
}

/** Normalize and deeply freeze one SDK ended span. @public */
export function normalizeEndedSpan(span: ReadableSpan): NormalizedEndedSpan {
  const spanContext = span.spanContext();
  if (!isValidMossTraceId(spanContext.traceId)) {
    throw new TypeError('ReadableSpan has an invalid native trace_id');
  }
  if (!isValidMossSpanId(spanContext.spanId)) {
    throw new TypeError('ReadableSpan has an invalid native span_id');
  }
  const parentSpanId = span.parentSpanContext?.spanId;
  const parentTraceId = span.parentSpanContext?.traceId;
  if (parentTraceId !== undefined && parentTraceId !== spanContext.traceId) {
    throw new TypeError('ReadableSpan parent belongs to a different native trace_id');
  }
  if (parentSpanId !== undefined && !isValidMossSpanId(parentSpanId)) {
    throw new TypeError('ReadableSpan has an invalid native parent_span_id');
  }
  const startTime = hrToMs(span.startTime);
  const endTime = Math.max(startTime, hrToMs(span.endTime));
  const normalized: NormalizedEndedSpan = {
    name: span.name,
    trace_id: spanContext.traceId,
    span_id: spanContext.spanId,
    ...(parentSpanId ? { parent_span_id: parentSpanId } : {}),
    start_time_unix_ms: startTime,
    end_time_unix_ms: endTime,
    duration_ms: endTime - startTime,
    attributes: scalarAttributes(span.attributes),
    events: (span.events ?? []).map((event) => ({
      name: event.name,
      time_unix_ms: hrToMs(event.time),
      attributes: scalarAttributes(event.attributes),
    })),
    outcome: outcomeFromSpan(span),
    status: statusName(span.status.code),
    ...(span.status.message ? { status_message: span.status.message } : {}),
  };
  return freezeNormalizedSpan(normalized);
}

function cloneForConsumer(span: NormalizedEndedSpan): NormalizedEndedSpan {
  return freezeNormalizedSpan({
    ...span,
    attributes: { ...span.attributes },
    events: span.events.map((event) => ({
      ...event,
      attributes: { ...event.attributes },
    })),
  });
}

async function settleWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(
        () => true,
        () => false
      ),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Fan out one normalized snapshot to isolated immutable consumer views.
 * Consumer failures never escape the telemetry boundary.
 * @public
 */
export class NormalizedSpanProcessor implements SpanProcessor {
  private readonly pending = new Set<Promise<void>>();
  private deliveredSpans = 0;
  private deliveryFailures = 0;
  private flushFailures = 0;

  constructor(
    private readonly consumers: readonly MossSpanConsumer[],
    private readonly flushTimeoutMs = 2_000
  ) {}

  /** SDK start callback; normalized consumers receive ended spans only. */
  onStart(_span: ReadableSpan, _parentContext: Context): void {}

  /** Normalize one ended SDK span and fan it out to registered consumers. */
  onEnd(span: ReadableSpan): void {
    let normalized: NormalizedEndedSpan;
    try {
      normalized = normalizeEndedSpan(span);
    } catch {
      this.deliveryFailures += this.consumers.length || 1;
      return;
    }
    for (const consumer of this.consumers) {
      let delivery: Promise<void>;
      try {
        delivery = Promise.resolve(consumer.onSpan(cloneForConsumer(normalized))).then(() => {
          this.deliveredSpans++;
        });
      } catch {
        this.deliveryFailures++;
        continue;
      }
      const observed = delivery.catch(() => {
        this.deliveryFailures++;
      });
      this.pending.add(observed);
      void observed.finally(() => this.pending.delete(observed));
    }
  }

  /** Return a point-in-time, immutable health snapshot. @public */
  health(): MossSpanConsumerHealth {
    return Object.freeze({
      deliveredSpans: this.deliveredSpans,
      deliveryFailures: this.deliveryFailures,
      flushFailures: this.flushFailures,
      pendingDeliveries: this.pending.size,
    });
  }

  async forceFlush(): Promise<void> {
    const pendingOk = await settleWithin(
      Promise.allSettled([...this.pending]),
      this.flushTimeoutMs
    );
    if (!pendingOk) this.flushFailures++;
    for (const consumer of this.consumers) {
      if (!consumer.forceFlush) continue;
      const ok = await settleWithin(
        Promise.resolve().then(() => consumer.forceFlush?.()),
        this.flushTimeoutMs
      );
      if (!ok) this.flushFailures++;
    }
  }

  async shutdown(): Promise<void> {
    await this.forceFlush();
    for (const consumer of this.consumers) {
      if (!consumer.shutdown) continue;
      const ok = await settleWithin(
        Promise.resolve().then(() => consumer.shutdown?.()),
        this.flushTimeoutMs
      );
      if (!ok) this.flushFailures++;
    }
  }
}
