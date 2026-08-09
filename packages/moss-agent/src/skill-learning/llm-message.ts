export type LLMContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id?: string; name?: string; input?: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id?: string; content?: string; is_error?: boolean }
  | Record<string, unknown>;

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | LLMContentBlock[];
}

export function isCompactionSummaryText(text: string): boolean {
  return text.trimStart().startsWith('The conversation history before this point was compacted');
}

export function isSyntheticUserText(text: string): boolean {
  const t = text.trimStart();
  return (
    isCompactionSummaryText(t) ||
    t.startsWith('[Steering]') ||
    t.startsWith('[System]') ||
    t.startsWith('<moss_')
  );
}
