






import type { ToolContentBlock } from '../tools/tool-types.js';

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
      content: string;
      is_error?: boolean;
      structuredContent?: ToolContentBlock[];
    };

export interface LLMToolDeclaration {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export interface LLMSystemPromptParts {
  




  stable: string;
  
  dynamic: string;
}

export interface LLMStreamEvent {
  type:
    | 'message_start'
    | 'content_block_start'
    | 'content_block_delta'
    | 'content_block_stop'
    | 'message_delta'
    | 'message_stop';
  
  text?: string;
  



  deltaRole?: 'thinking' | 'visible';
  
  toolUse?: { id: string; name: string };
  
  partialJson?: string;
  
  stopReason?: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence';
}

export interface LLMRequestOptions {
  model: string;
  systemPrompt: string;
  




  systemPromptParts?: LLMSystemPromptParts;
  messages: LLMMessage[];
  tools?: LLMToolDeclaration[];
  maxTokens?: number;
  temperature?: number;
  abortSignal?: AbortSignal;
  




  reasoning?: string | null;
  













  extraBody?: Record<string, unknown>;
}

export interface LLMResponse {
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence';
  content: LLMContentBlock[];
  usage?: {
    /** Uncached input tokens. Cache reads/writes are reported separately. */
    inputTokens: number;
    outputTokens: number;
    /** Input tokens served from prompt cache; excluded from inputTokens. */
    cacheReadTokens?: number;
    /** Input tokens written to prompt cache; excluded from inputTokens. */
    cacheCreationTokens?: number;
  };
  






  incomplete?: { reason: string };
  







  model?: string;
  
















  thinking?: string[];
}






export interface LLMProviderCapabilities {
  
  streaming?: boolean;
}









export interface LLMProvider {
  readonly id: string;
  readonly displayName: string;

  
  readonly capabilities?: LLMProviderCapabilities;

  
  complete(options: LLMRequestOptions): Promise<LLMResponse>;

  
  stream(
    options: LLMRequestOptions,
    onEvent: (event: LLMStreamEvent) => void
  ): Promise<LLMResponse>;

  
  countTokens?(text: string): Promise<number>;
}
