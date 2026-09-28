import type { Message } from '../session/session-jsonl.js';
import type {
  Message as PiMessage,
  TextContent as PiTextContent,
  ThinkingContent,
  ImageContent as PiImageContent,
  ToolCall as PiToolCall,
} from '../../provider/pi-ai-types.js';
import { shouldRoundTripAssistantThinking } from '../../provider/reasoning-policy.js';

// Moved verbatim to provider/reasoning-policy.ts (T3.2); re-exported to keep
// this module's public surface stable for core consumers.
export { shouldRoundTripAssistantThinking };

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
          let textContent = typeof block.content === 'string' ? block.content : '';
          if (block.structuredContent && block.structuredContent.length > 0) {
            const extraText = block.structuredContent
              .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
              .map((b) => b.text)
              .filter((text) => !textContent.includes(text))
              .join('\n');
            if (extraText) {
              textContent = textContent ? `${textContent}\n${extraText}` : extraText;
            }
          }
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
