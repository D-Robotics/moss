import type { SessionEventLog } from './session-event.js';

interface AgentStreamEventLike {
  readonly type: string;
  readonly delta?: string;
  readonly toolName?: string;
  readonly toolCallId?: string;
  readonly isError?: boolean;
  readonly stopReason?: string;
  readonly attempt?: number;
  /** `retry` carries a string; `tool_end` carries an error object — both fine. */
  readonly error?: unknown;
}

export function recordAgentEvent(log: SessionEventLog, event: AgentStreamEventLike): void {
  switch (event.type) {
    case 'turn_start':
      log.append({ type: 'step.started', data: {} });
      break;
    case 'text_delta':
      log.append({ type: 'text.delta', data: { text: event.delta ?? '' } });
      break;
    case 'thinking_delta':
      log.append({ type: 'reasoning.delta', data: { text: event.delta ?? '' } });
      break;
    case 'tool_start':
      log.append({
        type: 'tool.called',
        data: { callId: event.toolCallId ?? '', name: event.toolName ?? '' },
      });
      break;
    case 'tool_end':
      log.append({
        type: event.isError ? 'tool.failed' : 'tool.succeeded',
        data: { callId: event.toolCallId ?? '', name: event.toolName ?? '' },
      });
      break;
    case 'turn_end':
      log.append({ type: 'step.ended', data: { stopReason: event.stopReason } });
      break;
    case 'error':
      log.append({
        type: 'step.failed',
        data: { message: typeof event.error === 'string' ? event.error : undefined },
      });
      break;
    case 'retry':
      // A retried call is not a failure: the run continues. But it IS the
      // breadcrumb that explains a regenerated answer, so it goes to the log.
      log.append({
        type: 'step.retry',
        data: {
          attempt: event.attempt,
          error: typeof event.error === 'string' ? event.error : String(event.error ?? ''),
        },
      });
      break;
    case 'compaction':
      log.append({ type: 'compaction.ended', data: {} });
      break;
    default:
      break;
  }
}

export async function* recordAgentStream<E extends AgentStreamEventLike>(
  log: SessionEventLog,
  prompt: string,
  stream: AsyncIterable<E>
): AsyncGenerator<E> {
  log.append({ type: 'prompt.promoted', data: { prompt } });
  for await (const event of stream) {
    recordAgentEvent(log, event);
    yield event;
  }
}
