








import type { SessionEventLog } from './session-event.js';


interface AgentStreamEventLike {
  readonly type: string;
  readonly delta?: string;
  readonly toolName?: string;
  readonly toolCallId?: string;
  readonly isError?: boolean;
  readonly stopReason?: string;
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
      log.append({ type: 'step.failed', data: {} });
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
