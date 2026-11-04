import { createStreamingTextRedactor } from '../safety/redact-stream.js';

export type ExecEventStream = 'stdout' | 'stderr';

export interface ExecLineEvent {
  /** 1-based, monotonic across both streams, in arrival order. */
  seq: number;
  stream: ExecEventStream;
  line: string;
}

/** Hard ceilings so a chatty server cannot flood the model or the transcript. */
export const EXEC_EVENT_MAX_EVENTS = 500;
export const EXEC_EVENT_MAX_CHARS = 20_000;

export interface ExecEventCollector {
  push(chunk: string, stream: ExecEventStream): void;
  /** Emit any held trailing partial line. Call once per stream at exit. */
  flush(): void;
  readonly events: readonly ExecLineEvent[];
  /** Lines seen, including lines dropped after the ceiling was reached. */
  readonly total: number;
  readonly truncated: boolean;
}

/**
 * Whole-line event collector for `exec({ event: true })`.
 *
 * Redaction is per stream and streaming: a secret split across two chunks is
 * held until its line completes, so an emitted event never carries a raw key.
 */
export function createExecEventCollector(
  onEvent?: (event: ExecLineEvent) => void
): ExecEventCollector {
  const pending: Record<ExecEventStream, string> = { stdout: '', stderr: '' };
  const redactors: Record<ExecEventStream, ReturnType<typeof createStreamingTextRedactor>> = {
    stdout: createStreamingTextRedactor(),
    stderr: createStreamingTextRedactor(),
  };
  const events: ExecLineEvent[] = [];
  let seq = 0;
  let total = 0;
  let chars = 0;
  let truncated = false;

  const emit = (stream: ExecEventStream, line: string): void => {
    total += 1;
    if (events.length >= EXEC_EVENT_MAX_EVENTS || chars + line.length > EXEC_EVENT_MAX_CHARS) {
      truncated = true;
      return;
    }
    seq += 1;
    chars += line.length;
    const event: ExecLineEvent = { seq, stream, line };
    events.push(event);
    onEvent?.(event);
  };

  const drain = (stream: ExecEventStream, text: string): void => {
    if (!text) return;
    pending[stream] += text;
    let at = pending[stream].indexOf('\n');
    while (at !== -1) {
      emit(stream, pending[stream].slice(0, at).replace(/\r$/, ''));
      pending[stream] = pending[stream].slice(at + 1);
      at = pending[stream].indexOf('\n');
    }
  };

  return {
    push(chunk, stream) {
      drain(stream, redactors[stream].push(chunk));
    },
    flush() {
      for (const stream of ['stdout', 'stderr'] as const) {
        drain(stream, redactors[stream].flush());
        if (pending[stream].length > 0) {
          emit(stream, pending[stream].replace(/\r$/, ''));
          pending[stream] = '';
        }
      }
    },
    get events() {
      return events;
    },
    get total() {
      return total;
    },
    get truncated() {
      return truncated;
    },
  };
}

/** Model-facing rendering: one numbered event per line, in arrival order. */
export function formatExecEventResult(collector: ExecEventCollector): string {
  if (collector.total === 0) return '';
  const header =
    `events: ${collector.total}` +
    (collector.truncated
      ? ` (showing ${collector.events.length}; the rest were dropped — narrow the command or use run_in_background + exec_logs)`
      : '');
  const body = collector.events
    .map((e) => `[${e.seq}]${e.stream === 'stderr' ? ' (stderr)' : ''} ${e.line}`)
    .join('\n');
  const text = `${header}\n${body}`;
  return text.length > EXEC_EVENT_MAX_CHARS
    ? `${text.slice(0, EXEC_EVENT_MAX_CHARS)}\n… (event list cut at ${EXEC_EVENT_MAX_CHARS} chars)`
    : text;
}
