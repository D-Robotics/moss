import type { ContentBlock, Message } from '../core/session/session-jsonl.js';

export const CHARS_PER_TOKEN_ESTIMATE = 4;

export type TokenEstimateOptions = {
  includeThinking?: boolean;
};

function isCJK(code: number): boolean {
  return (
    (code >= 0x3000 && code <= 0x9fff) ||
    (code >= 0xac00 && code <= 0xd7af) ||
    (code >= 0xff00 && code <= 0xffef)
  );
}

export function estimateTokensForText(text: string): number {
  if (!text) return 0;
  let cjkChars = 0;
  let otherChars = 0;
  for (let i = 0; i < text.length; i++) {
    if (isCJK(text.charCodeAt(i))) {
      cjkChars++;
    } else {
      otherChars++;
    }
  }
  return Math.ceil(cjkChars / 1.5) + Math.ceil(otherChars / 4);
}

function estimateBlockChars(block: ContentBlock): number {
  if (block.type === 'text') {
    return block.text?.length ?? 0;
  }
  if (block.type === 'tool_use') {
    const base = block.name?.length ?? 0;
    try {
      const input = block.input ? JSON.stringify(block.input) : '';
      return base + input.length + 16;
    } catch {
      return base + 128;
    }
  }
  if (block.type === 'tool_result') {
    return block.content?.length ?? 0;
  }
  if (block.type === 'image') {
    return block.filename?.length ?? 0;
  }
  return 0;
}

function estimateBlockTokens(block: ContentBlock): number {
  if (block.type === 'text') {
    return estimateTokensForText(block.text ?? '');
  }
  if (block.type === 'tool_result') {
    return estimateTokensForText(block.content ?? '');
  }
  if (block.type === 'image') {
    return 1024;
  }

  return Math.max(1, Math.ceil(estimateBlockChars(block) / CHARS_PER_TOKEN_ESTIMATE));
}

function joinedAssistantThinking(message: Message, options?: TokenEstimateOptions): string {
  if (!options?.includeThinking || message.role !== 'assistant') return '';
  if (!Array.isArray(message.thinking) || message.thinking.length === 0) return '';
  return message.thinking
    .filter((chunk) => typeof chunk === 'string' && chunk.length > 0)
    .join('\n\n')
    .trim();
}

export function estimateMessageChars(message: Message, options?: TokenEstimateOptions): number {
  const thinkingChars = joinedAssistantThinking(message, options).length;
  if (typeof message.content === 'string') {
    return message.content.length + thinkingChars;
  }
  let total = 0;
  for (const block of message.content) {
    total += estimateBlockChars(block);
  }
  return total + thinkingChars;
}

export function estimateMessagesChars(messages: Message[], options?: TokenEstimateOptions): number {
  return messages.reduce((sum, msg) => sum + estimateMessageChars(msg, options), 0);
}

export function estimateMessageTokens(message: Message, options?: TokenEstimateOptions): number {
  const thinkingTokens = estimateTokensForText(joinedAssistantThinking(message, options));
  if (typeof message.content === 'string') {
    return Math.max(1, estimateTokensForText(message.content) + thinkingTokens);
  }
  let total = 0;
  for (const block of message.content) {
    total += estimateBlockTokens(block);
  }
  return Math.max(1, total + thinkingTokens);
}

export function estimateMessagesTokens(
  messages: Message[],
  options?: TokenEstimateOptions
): number {
  return messages.reduce((sum, msg) => sum + estimateMessageTokens(msg, options), 0);
}

export function resolveContextCharsPerTokenUnit(): number {
  const raw = process.env.MOSS_CONTEXT_CHARS_PER_TOKEN_UNIT?.trim();
  if (!raw || !String(raw).trim()) return CHARS_PER_TOKEN_ESTIMATE;
  const n = Number.parseFloat(String(raw).trim());
  if (!Number.isFinite(n)) return CHARS_PER_TOKEN_ESTIMATE;
  return Math.min(8, Math.max(1, n));
}

export function estimatePromptUnitsForContextWindow(params: {
  messages: Message[];
  systemPrompt: string;
  charsPerTokenUnit: number;
  effectiveContextWindowTokens?: number;
  includeThinking?: boolean;
}): number {
  const estTokens =
    estimateMessagesTokens(params.messages, { includeThinking: params.includeThinking }) +
    estimateTokensForText(params.systemPrompt);
  const rawChars =
    estimateMessagesChars(params.messages, { includeThinking: params.includeThinking }) +
    (params.systemPrompt?.length ?? 0);
  const unit = Math.max(1, params.charsPerTokenUnit);
  const fromChars = rawChars / unit;
  let score = Math.max(estTokens, fromChars);
  const cap = params.effectiveContextWindowTokens;

  if (unit <= 1.5 && cap !== undefined && cap > 0 && rawChars / cap >= 0.85) {
    score = Math.max(score, rawChars);
  }
  return score;
}
