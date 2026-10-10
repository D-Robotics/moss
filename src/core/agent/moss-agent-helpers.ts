import { MossError, ErrorCode } from '../../errors.js';
import type { ChatOptions, InternalContentBlock, InternalMessage } from './moss-agent-types.js';

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

/** Same bytes the OpenAI wire uses when it folds a dynamic suffix onto a user message. */
export function turnContextBlock(body: string): string {
  return `<turn-context>\n${body}\n</turn-context>`;
}

export function messagePlainText(content: string | InternalContentBlock[]): string {
  if (typeof content === 'string') return content;
  return content
    .map((block) => (block.type === 'text' && typeof block.text === 'string' ? block.text : ''))
    .join('\n');
}

/** Body of the last `<turn-context>` block in `text`, if one was already sent. */
export function lastTurnContextBody(text: string): string | undefined {
  const pattern = /<turn-context>\n([\s\S]*?)\n<\/turn-context>/g;
  let last: string | undefined;
  for (const match of text.matchAll(pattern)) last = match[1];
  return last;
}

/**
 * The dynamic suffix most recently stored on a user message. Undefined when
 * this session has not sent one yet.
 */
export function lastSentTurnContextBody(messages: readonly InternalMessage[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!message) continue;
    const body = lastTurnContextBody(messagePlainText(message.content));
    if (body !== undefined) return body;
  }
  return undefined;
}

/**
 * Attach per-turn volatile context (git snapshot, focus notes) to the current
 * user message for the LLM only. Never persisted — the stored message keeps
 * the clean form so history stays append-stable for prefix caching.
 */
export function appendTurnExtraContext(
  content: string | InternalContentBlock[],
  extraContext: string
): string | InternalContentBlock[] {
  const tagged = turnContextBlock(extraContext);
  if (typeof content === 'string') return `${content}\n\n${tagged}`;
  return [...content, { type: 'text', text: tagged }];
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
