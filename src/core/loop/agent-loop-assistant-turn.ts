import type { ContentBlock, Message } from '../session/session-jsonl.js';
import type { Tool } from '../tools/tool-types.js';
import { splitThinkingTagsFromAssistantText } from '../llm/inline-thinking-stream.js';
import { normalizeToolCallInput, syncAssistantToolUseInput } from './agent-loop-tool-helpers.js';

function extractVisibleTextFromThinkingBlocks(content: ContentBlock[]): string {
  const parts: string[] = [];
  for (const block of content) {
    if (block.type !== 'text' || typeof block.text !== 'string') continue;
    const { thinkingBodies } = splitThinkingTagsFromAssistantText(block.text);
    for (const b of thinkingBodies) {
      const t = b.trim();
      if (t) parts.push(t);
    }
  }
  return parts.join('\n\n');
}

/**
 * Read reasoning text from an in-progress assistant message.
 *
 * Prefers the new `Message.thinking` array (provider-native reasoning channel,
 * industry-standard one-shot per-turn reasoning). Falls back to extracting
 * `<thinking>...</thinking>` tag bodies from text content blocks for legacy
 * sessions and for upstream models that emit inline tags inside `text_delta`
 * (rather than via a dedicated `thinking_delta` event).
 */
export function extractThinkingTextFromMessage(
  thinkingChunks: ReadonlyArray<string> | undefined,
  content: ContentBlock[]
): string {
  if (Array.isArray(thinkingChunks) && thinkingChunks.length > 0) {
    return thinkingChunks.join('\n\n').trim();
  }
  return extractVisibleTextFromThinkingBlocks(content);
}

export function hasAssistantThinkingHistory(messages: readonly Message[]): boolean {
  return messages.some(
    (msg) =>
      msg.role === 'assistant' &&
      Array.isArray(msg.thinking) &&
      msg.thinking.some((chunk) => String(chunk ?? '').trim())
  );
}

export function isThinkingOnlyAssistantTurn(params: {
  visibleText: string;
  toolCallCount: number;
  thinkingChunks: ReadonlyArray<string>;
  assistantContent: ContentBlock[];
}): boolean {
  if (params.visibleText.trim() || params.toolCallCount > 0) return false;
  if (params.thinkingChunks.length > 0) return true;
  return params.assistantContent.some((block) => {
    if (block.type !== 'text' || typeof block.text !== 'string') return false;
    const head = block.text.trimStart();
    return head.startsWith('<thinking>') || head.startsWith('<think>');
  });
}

export function buildVisibleAssistantText(params: {
  textParts: ReadonlyArray<string>;
  /**
   * Keep leading and trailing whitespace. Output-limit recovery concatenates
   * fragments directly, so trimming a cutoff such as "Hello " drops the join.
   */
  trim?: boolean;
}): string {
  const visible = params.textParts
    .join('')
    .replace(/<\|FunctionCallBegin\|>[\s\S]*?<\|FunctionCallEnd\|>/g, '')
    .replace(/<\|FunctionCallBegin\|>[\s\S]*$/, '');
  // Tool calls do not make private thinking eligible for the visible channel.
  return params.trim === false ? visible : visible.trim();
}

export type AgentLoopToolCallDraft = {
  id: string;
  name: string;
  input: Record<string, unknown>;
};

export function normalizeAssistantToolCalls(params: {
  toolCalls: AgentLoopToolCallDraft[];
  assistantContent: ContentBlock[];
  toolsForRun: Tool[];
  sessionKey: string;
}): void {
  for (const call of params.toolCalls) {
    call.input = normalizeToolCallInput(call, params.toolsForRun, {
      sessionKey: params.sessionKey,
    });
    syncAssistantToolUseInput(params.assistantContent, call);
  }
}
