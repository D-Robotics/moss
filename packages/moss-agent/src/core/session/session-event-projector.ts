/**
 * Session event projector — folds a durable event log into conversation state.
 *
 * In event sourcing the log is the source of truth and visible state is a pure
 * function of it. This projector replays {@link SessionEvent}s into an ordered list
 * of projected messages (user prompts, assistant turns with streamed text /
 * reasoning / tool calls). Because projection is pure and deterministic, the same
 * events always yield the same state — the property that makes replay, reconnect,
 * and crash recovery correct.
 *
 * The projected shape is intentionally a small, stable view (not moss's full
 * internal Message), so callers can map it onto whatever they render.
 */
import type { SessionEvent } from './session-event.js';

export type ProjectedToolStatus = 'called' | 'succeeded' | 'failed';

export interface ProjectedToolCall {
  readonly callId: string;
  readonly name: string;
  status: ProjectedToolStatus;
}

export interface ProjectedMessage {
  readonly role: 'user' | 'assistant';
  text: string;
  thinking?: string;
  tools?: ProjectedToolCall[];
}

interface EventData {
  prompt?: string;
  text?: string;
  name?: string;
  callId?: string;
}

/** Replay events into ordered conversation messages. */
export function projectSessionMessages(events: readonly SessionEvent[]): ProjectedMessage[] {
  const messages: ProjectedMessage[] = [];
  let assistant: ProjectedMessage | null = null;

  for (const event of events) {
    const data = (event.data ?? {}) as EventData;
    switch (event.type) {
      case 'prompt.promoted': {
        messages.push({ role: 'user', text: data.prompt ?? '' });
        assistant = null;
        break;
      }
      case 'step.started': {
        assistant = { role: 'assistant', text: '' };
        messages.push(assistant);
        break;
      }
      case 'text.delta': {
        if (assistant) assistant.text += data.text ?? '';
        break;
      }
      case 'reasoning.delta': {
        if (assistant) assistant.thinking = (assistant.thinking ?? '') + (data.text ?? '');
        break;
      }
      case 'tool.called': {
        if (assistant && data.callId) {
          (assistant.tools ??= []).push({ callId: data.callId, name: data.name ?? '', status: 'called' });
        }
        break;
      }
      case 'tool.succeeded':
      case 'tool.failed': {
        const tool = assistant?.tools?.find((t) => t.callId === data.callId);
        if (tool) tool.status = event.type === 'tool.succeeded' ? 'succeeded' : 'failed';
        break;
      }
      case 'step.ended':
      case 'step.failed': {
        assistant = null;
        break;
      }
      // prompt.admitted / compaction.ended do not contribute to the visible thread here.
      default:
        break;
    }
  }

  return messages;
}
