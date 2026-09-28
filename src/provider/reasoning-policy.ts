/**
 * Provider-level pure reasoning/wire-format predicates.
 *
 * Moved verbatim from core (loop/follow-up-guard.ts, tools/message-convert.ts)
 * so the provider layer no longer reaches into core internals. These functions
 * are stateless message-shape predicates with no session or loop state.
 */
import type { LLMContentBlock } from '../core/llm/llm-provider.js';

type MessageLike = { role: string; content: unknown };

export function lastMessageNeedsToolFollowUp(messages: readonly MessageLike[]): boolean {
  if (messages.length === 0) return false;
  const last = messages[messages.length - 1];
  if (last.role !== 'user') return false;
  if (typeof last.content === 'string') return false;
  return (last.content as LLMContentBlock[]).some((b) => b && b.type === 'tool_result');
}

export function hasToolResultAfterLastAssistant(messages: readonly MessageLike[]): boolean {
  return lastMessageNeedsToolFollowUp(messages);
}

export function shouldSuppressReasoningForToolFollowUpRound(
  messages: readonly MessageLike[]
): boolean {
  return hasToolResultAfterLastAssistant(messages);
}

type RoundTripContentBlock = {
  type?: string;
  id?: string;
  tool_use_id?: string;
};

type ThinkingRoundTripMessage = {
  role: string;
  content: string | RoundTripContentBlock[];
  thinking?: string[];
};

function toolUseIds(message: ThinkingRoundTripMessage): Set<string> {
  const out = new Set<string>();
  if (typeof message.content === 'string') return out;
  for (const block of message.content) {
    if (block?.type === 'tool_use' && typeof block.id === 'string' && block.id.trim()) {
      out.add(block.id);
    }
  }
  return out;
}

function collectToolResultIds(message: ThinkingRoundTripMessage, out: Set<string>): void {
  if (message.role !== 'user' || typeof message.content === 'string') return;
  for (const block of message.content) {
    if (
      block?.type === 'tool_result' &&
      typeof block.tool_use_id === 'string' &&
      block.tool_use_id.trim()
    ) {
      out.add(block.tool_use_id);
    }
  }
}

function toolResultIdsAfterAssistant(
  messages: readonly ThinkingRoundTripMessage[],
  index: number
): Set<string> {
  const out = new Set<string>();
  for (let i = index + 1; i < messages.length; i += 1) {
    const msg = messages[i];
    if (msg.role === 'assistant') break;
    collectToolResultIds(msg, out);
  }
  return out;
}

export function shouldRoundTripAssistantThinking(
  messages: readonly ThinkingRoundTripMessage[],
  index: number,
  options: { thinkingMode?: boolean } = {}
): boolean {
  const current = messages[index];
  const next = messages[index + 1];
  if (!current || !next) return false;
  if (current.role !== 'assistant') return false;
  if (!Array.isArray(current.thinking) || current.thinking.length === 0) return false;
  if (options.thinkingMode) return true;
  for (let i = index + 1; i < messages.length; i += 1) {
    if (messages[i]?.role === 'assistant') return false;
  }

  const callIds = toolUseIds(current);
  if (callIds.size === 0) return false;

  const resultIds = toolResultIdsAfterAssistant(messages, index);
  if (resultIds.size === 0) return false;
  return [...resultIds].some((id) => callIds.has(id));
}
