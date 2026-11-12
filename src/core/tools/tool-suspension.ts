import type { Message } from '../../contracts/messages.js';

export interface SuspendedToolCall {
  continuationId: string;
  toolCallId: string;
  toolName: string;
  payload?: Record<string, unknown>;
}

export class ToolSuspension extends Error {
  constructor(readonly continuation: Pick<SuspendedToolCall, 'continuationId' | 'payload'>) {
    super('Tool execution suspended');
    this.name = 'ToolSuspension';
  }
}

/** Yield a declared suspendable tool; the host owns the wakeup condition. */
export function suspendToolCall(
  continuation: Pick<SuspendedToolCall, 'continuationId' | 'payload'>
): never {
  if (!continuation.continuationId.trim()) throw new Error('A continuation id is required');
  JSON.stringify(continuation);
  throw new ToolSuspension(continuation);
}

export function pendingToolInMessages(messages: readonly Message[]): SuspendedToolCall | undefined {
  const completed = new Set<string>();
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block.type === 'tool_result' && block.tool_use_id) completed.add(block.tool_use_id);
    }
  }
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (
        block.type === 'tool_use' &&
        block.id &&
        block.name &&
        block.continuation &&
        !completed.has(block.id)
      )
        return { ...block.continuation, toolCallId: block.id, toolName: block.name };
    }
  }
  return undefined;
}
