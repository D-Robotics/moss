












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
          (assistant.tools ??= []).push({
            callId: data.callId,
            name: data.name ?? '',
            status: 'called',
          });
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
      
      default:
        break;
    }
  }

  return messages;
}
