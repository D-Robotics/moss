














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
  
  readonly id: string;
  
  readonly aggregateId: string;
  
  readonly seq: number;
  
  readonly type: SessionEventType;
  
  readonly version: number;
  
  readonly data: T;
  
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
  
  readonly time?: number;
}





export class SessionEventLog {
  private readonly events: SessionEvent[] = [];

  constructor(readonly aggregateId: string) {}

  
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

  
  all(after = 0): readonly SessionEvent[] {
    return after <= 0 ? [...this.events] : this.events.filter((e) => e.seq > after);
  }

  
  latestSeq(): number {
    return this.events.length;
  }

  
  toEvents(): SessionEvent[] {
    return this.events.map((e) => ({ ...e }));
  }

  



  static fromEvents(aggregateId: string, events: readonly SessionEvent[]): SessionEventLog {
    const log = new SessionEventLog(aggregateId);
    let expected = 1;
    for (const event of events) {
      if (event.aggregateId !== aggregateId) {
        throw new SessionEventSequenceError(aggregateId, expected, event.seq);
      }
      if (event.seq !== expected)
        throw new SessionEventSequenceError(aggregateId, expected, event.seq);
      log.events.push({ ...event });
      expected++;
    }
    return log;
  }
}
