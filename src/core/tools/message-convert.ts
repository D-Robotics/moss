import type { Message } from '../session/session-jsonl.js';
import type {
  Message as PiMessage,
  TextContent as PiTextContent,
  ThinkingContent,
  ImageContent as PiImageContent,
  ToolCall as PiToolCall,
} from '../../provider/pi-ai-types.js';
import { shouldRoundTripAssistantThinking } from '../../provider/reasoning-policy.js';
import type { ToolContentBlock } from '../../contracts/messages.js';

// Moved verbatim to provider/reasoning-policy.ts (T3.2); re-exported to keep
// this module's public surface stable for core consumers.
export { shouldRoundTripAssistantThinking };

export const MAX_STRUCTURED_SIZE = 12_000;

export function structuredContentTruncationNotice(size: number): string {
  return `[structured content truncated: ${size} chars exceeded ${MAX_STRUCTURED_SIZE} limit]`;
}

/** Stored text is authoritative; only legacy structured-only results need a fallback. */
export function modelToolResultText(
  content: string | undefined,
  structuredContent?: ToolContentBlock[],
  structuredContentTruncated?: number
): string {
  if (content !== undefined) {
    if (
      structuredContentTruncated !== undefined &&
      Number.isSafeInteger(structuredContentTruncated) &&
      structuredContentTruncated > MAX_STRUCTURED_SIZE
    ) {
      const notice = structuredContentTruncationNotice(structuredContentTruncated);
      return content ? `${content}\n${notice}` : notice;
    }
    return content;
  }
  return (structuredContent ?? [])
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

function createEmptyUsage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function pushThinkingIfNeeded(
  out: (PiTextContent | ThinkingContent | PiToolCall)[],
  msg: Message,
  includeThinking: boolean
): void {
  if (!includeThinking) return;
  const joined = msg.thinking?.filter(Boolean).join('\n\n').trim();
  if (!joined) return;
  out.push({
    type: 'thinking',
    thinking: joined,
    thinkingSignature: 'reasoning_content',
  });
}

export function convertMessagesToPi(
  messages: Message[],
  modelInfo: { api: string; provider: string; id: string; reasoning?: unknown }
): PiMessage[] {
  const result: PiMessage[] = [];
  const thinkingMode =
    modelInfo.reasoning !== undefined &&
    modelInfo.reasoning !== null &&
    modelInfo.reasoning !== false &&
    modelInfo.reasoning !== '';

  for (let index = 0; index < messages.length; index += 1) {
    const msg = messages[index];
    if (msg.role === 'user') {
      if (typeof msg.content === 'string') {
        result.push({
          role: 'user',
          content: msg.content,
          timestamp: msg.timestamp,
        });
        continue;
      }

      const userContent: (PiTextContent | PiImageContent)[] = [];
      const flushUserContent = (): void => {
        if (userContent.length === 0) return;
        result.push({
          role: 'user',
          content: [...userContent],
          timestamp: msg.timestamp,
        });
        userContent.length = 0;
      };

      for (const block of msg.content) {
        if (block.type === 'text' && block.text) {
          userContent.push({ type: 'text', text: block.text });
        } else if (block.type === 'image' && block.data && block.mimeType) {
          userContent.push({ type: 'image', data: block.data, mimeType: block.mimeType });
        } else if (block.type === 'tool_result') {
          flushUserContent();
          const textContent = modelToolResultText(
            block.content === undefined
              ? undefined
              : typeof block.content === 'string'
                ? block.content
                : '',
            block.structuredContent,
            block._structuredContentTruncated
          );
          result.push({
            role: 'toolResult',
            toolCallId: block.tool_use_id ?? '',
            toolName: block.name ?? '',
            content: [{ type: 'text', text: textContent }],
            isError: block.is_error ?? false,
            timestamp: msg.timestamp,
          });
        }
      }
      flushUserContent();
    } else {
      const includeThinking = shouldRoundTripAssistantThinking(messages, index, { thinkingMode });
      if (typeof msg.content === 'string') {
        const parts: (PiTextContent | ThinkingContent)[] = [];
        pushThinkingIfNeeded(parts, msg, includeThinking);
        parts.push({ type: 'text', text: msg.content });
        result.push({
          role: 'assistant',
          content: parts,
          api: modelInfo.api,
          provider: modelInfo.provider,
          model: modelInfo.id,
          usage: createEmptyUsage(),
          stopReason: 'stop',
          timestamp: msg.timestamp,
        });
        continue;
      }

      const piContent: (PiTextContent | ThinkingContent | PiToolCall)[] = [];
      pushThinkingIfNeeded(piContent, msg, includeThinking);
      for (const block of msg.content) {
        if (block.type === 'text' && block.text) {
          piContent.push({ type: 'text', text: block.text });
        } else if (block.type === 'tool_use') {
          piContent.push({
            type: 'toolCall',
            id: block.id ?? '',
            name: block.name ?? '',
            arguments: block.input ?? {},
          });
        }
      }

      result.push({
        role: 'assistant',
        content: piContent,
        api: modelInfo.api,
        provider: modelInfo.provider,
        model: modelInfo.id,
        usage: createEmptyUsage(),
        stopReason: 'stop',
        timestamp: msg.timestamp,
      });
    }
  }

  return result;
}
