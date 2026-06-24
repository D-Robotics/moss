/**
 * Session event recorder — maps a live agent stream onto the durable event log.
 *
 * This is the bridge that turns real turns into event-sourced history: it observes
 * the `MossAgentEvent` stream a turn already emits and appends the corresponding
 * durable {@link SessionEvent}s to a log, then yields each stream event through
 * unchanged. Wrapping `streamChat` with it records a faithful, replayable log
 * without altering streaming behaviour.
 */
import type { SessionEventLog } from './session-event.js';

/** Structural view of the `MossAgentEvent` fields the recorder reads. */
interface AgentStreamEventLike {
  readonly type: string;
  readonly delta?: string;
  readonly toolName?: string;
  readonly toolCallId?: string;
  readonly isError?: boolean;
  readonly stopReason?: string;
}

/** Append the durable event(s) implied by one agent stream event, if any. */
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
      log.append({ type: 'tool.called', data: { callId: event.toolCallId ?? '', name: event.toolName ?? '' } });
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
      log.append({ type: 'step.failed', data: {} });
      break;
    case 'compaction':
      log.append({ type: 'compaction.ended', data: {} });
      break;
    default:
      // done / microcompact / cache_metrics / working_context_checkpoint are not
      // durable thread facts; the projector ignores them anyway.
      break;
  }
}

/**
 * Transparent middleware: record the promoted prompt, then forward every agent
 * stream event unchanged while recording its durable counterpart.
 */
export async function* recordAgentStream<E extends AgentStreamEventLike>(
  log: SessionEventLog,
  prompt: string,
  stream: AsyncIterable<E>,
): AsyncGenerator<E> {
  log.append({ type: 'prompt.promoted', data: { prompt } });
  for await (const event of stream) {
    recordAgentEvent(log, event);
    yield event;
  }
}
