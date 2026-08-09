import { MossError, ErrorCode } from '../../errors.js';
import type { ChatOptions, InternalContentBlock } from './moss-agent-types.js';

export function buildUserMessageContent(
  text: string,
  attachments: ChatOptions['attachments'] | undefined
): string | InternalContentBlock[] {
  if (!attachments || attachments.length === 0) return text;
  return [
    { type: 'text', text },
    ...attachments.map((block): InternalContentBlock => ({ ...block })),
  ];
}

export function formatAgentError(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object') {
    const record = error as Record<string, unknown>;
    if (typeof record.errorMessage === 'string') return record.errorMessage;
    if (typeof record.message === 'string') return record.message;
    try {
      return JSON.stringify(record);
    } catch {
      return String(error);
    }
  }
  return String(error);
}

export function createPreAbortedRunError(sessionKey: string, reason: unknown): MossError {
  const reasonText = reason === undefined ? '' : `: ${formatAgentError(reason)}`;
  return new MossError({
    code: ErrorCode.USER_ABORTED,
    message: `agent run aborted before start${reasonText}`,
    recoverable: true,
    cause: reason,
    context: { sessionKey },
  });
}

export function createInputGuardrailDeniedError(
  sessionKey: string,
  runId: string,
  reason: string
): MossError {
  return new MossError({
    code: ErrorCode.TOOL_NOT_ALLOWED,
    message: `input guardrail rejected the user message: ${reason || 'no reason provided'}`,
    hint: 'Review the request or host input policy before retrying.',
    recoverable: false,
    context: { sessionKey, runId, guardrail: 'input' },
  });
}
