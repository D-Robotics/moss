import type { ToolContentBlock } from './messages.js';

export interface LLMMessage {
  role: 'user' | 'assistant' | 'system';
  content: string | LLMContentBlock[];

  thinking?: string[];
}

export type LLMContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string; filename?: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | {
      type: 'tool_result';
      tool_use_id: string;
      name?: string;
      content: string;
      is_error?: boolean;
      structuredContent?: ToolContentBlock[];
    };
