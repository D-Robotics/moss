/**
 * Durable session events — the event-sourcing foundation.
 *
 * Instead of overwriting mutable session state, every meaningful fact is recorded
 * as an append-only event belonging to an aggregate (the session) with a monotonic
 * sequence number and a schema version. Session state is then a *projection* of the
 * event log (see session-event-projector). This is what enables faithful replay,
 * audit, reconnect-safe streaming, and crash recovery — none of which a
 * last-write-wins JSONL snapshot supports.
 *
 * The log here is in-memory but serializable; durable persistence lives in
 * session-event-store (append-only JSONL, one event per line). Mirrors the opencode
 * V2 EventV2 contract (aggregate + seq + versioned type), adapted to moss.
 */

export type SessionEventType =
  | 'prompt.admitted'
  | 'prompt.promoted'
  | 'step.started'
  | 'step.ended'
  | 'step.failed'
  | 'text.delta'
  | 'reasoning.delta'
  | 'tool.called'
  | 'tool.succeeded'
  | 'tool.failed'
  | 'compaction.ended';

export interface SessionEvent<T = unknown> {
  /** Globally-unique event id. */
  readonly id: string;
  /** Aggregate this event belongs to (the session key). */
  readonly aggregateId: string;
  /** Monotonic sequence within the aggregate (1-based, gap-free). */
  readonly seq: number;
  /** Event type. */
  readonly type: SessionEventType;
  /** Schema version for `data`, so old events can be upgraded on replay. */
  readonly version: number;
  /** Event payload. */
  readonly data: T;
  /** Wall-clock time the event was recorded (epoch ms). */
  readonly time: number;
}

export class SessionEventSequenceError extends Error {
  constructor(aggregateId: string, expected: number, got: number) {
    super(`Session event sequence gap for "${aggregateId}": expected ${expected}, got ${got}`);
    this.name = 'SessionEventSequenceError';
  }
}

let autoId = 0;
function makeEventId(): string {
  return `evt_${Date.now().toString(36)}_${(autoId++).toString(36)}`;
}

export interface AppendSessionEventInput<T> {
  readonly type: SessionEventType;
  readonly data: T;
  readonly version?: number;
  /** Override the recorded time (epoch ms); defaults to now. */
  readonly time?: number;
}

/**
 * An append-only, in-memory event log for one aggregate. Sequence numbers are
 * assigned on append and are gap-free; replaying serialized events validates this.
 */
export class SessionEventLog {
  private readonly events: SessionEvent[] = [];

  constructor(readonly aggregateId: string) {}

  /** Append one event, assigning the next sequence number. */
  append<T>(input: AppendSessionEventInput<T>): SessionEvent<T> {
    const event: SessionEvent<T> = {
      id: makeEventId(),
      aggregateId: this.aggregateId,
      seq: this.events.length + 1,
      type: input.type,
      version: input.version ?? 1,
      data: input.data,
      time: input.time ?? Date.now(),
    };
    this.events.push(event);
    return event;
  }

  /** Events after a sequence cursor (default 0 = all), in order. */
  all(after = 0): readonly SessionEvent[] {
    return after <= 0 ? [...this.events] : this.events.filter((e) => e.seq > after);
  }

  /** Highest assigned sequence (0 if empty). */
  latestSeq(): number {
    return this.events.length;
  }

  /** Serializable snapshot of the log. */
  toEvents(): SessionEvent[] {
    return this.events.map((e) => ({ ...e }));
  }

  /**
   * Rebuild a log from persisted events, validating gap-free 1-based sequencing
   * for the aggregate. Foreign-aggregate events are rejected.
   */
  static fromEvents(aggregateId: string, events: readonly SessionEvent[]): SessionEventLog {
    const log = new SessionEventLog(aggregateId);
    let expected = 1;
    for (const event of events) {
      if (event.aggregateId !== aggregateId) {
        throw new SessionEventSequenceError(aggregateId, expected, event.seq);
      }
      if (event.seq !== expected) throw new SessionEventSequenceError(aggregateId, expected, event.seq);
      log.events.push({ ...event });
      expected++;
    }
    return log;
  }
}
