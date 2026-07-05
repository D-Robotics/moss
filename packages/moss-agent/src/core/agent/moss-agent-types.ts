import type {
  LLMProvider,
  LLMMessage,
  LLMContentBlock,
  LLMStreamEvent,
} from '../llm/llm-provider.js';
import type { Message, ContentBlock } from '../session/session-jsonl.js';
import type { SessionStore } from '../session/session.js';
import type { Tool, ToolCall, ToolResult, ToolContentBlock } from '../tools/tool-types.js';
import type { ContextPruningSettings } from '../../context/pruning.js';
import type { CompactionSettings } from '../../context/compaction.js';
import type { MicroCompactConfig } from '../../context/microcompact.js';
import type { TailToolSnipConfig } from '../../context/tail-tool-snip.js';
import type { FollowUpGuardConfig } from '../loop/follow-up-guard.js';
import type { CompactHookRegistry } from '../loop/compact-hooks.js';
import type { SkillLearner } from '../memory/skill-learner.js';
import type { SkillPipeline } from '../../skill-learning/index.js';
import type { AgentHooks } from './agent-hooks.js';
import type { ThinkingLevel } from '../../provider/pi-ai-types.js';
import type { SteeringRule } from '../loop/steering.js';
import type { CapabilityPack } from '../packs/capability-pack.js';
import type { AgentLoopExtensions } from '../loop/agent-loop-types.js';

export interface ProviderConfig {
  llmProvider: LLMProvider;
  model?: string;
  maxTokens?: number;
  
  maxLLMRetries?: number;
  
  temperature?: number;
  
  topP?: number;
  




  reasoning?: ThinkingLevel | null;
  




  roundTripAssistantThinking?: boolean;
  
  api?: string;
  





  llmExtraBody?: Record<string, unknown>;
}

export interface ContextManagementConfig {
  
  contextTokens?: number;
  
  enableContextPruning?: boolean;
  
  pruningSettings?: Partial<ContextPruningSettings>;
  
  enableCompaction?: boolean;
  
  compactionSettings?: Partial<CompactionSettings>;
  
  enableMicrocompact?: boolean;
  
  microcompactConfig?: Partial<MicroCompactConfig>;
  
  enableTailToolSnip?: boolean;
  
  tailToolSnipConfig?: Partial<TailToolSnipConfig>;
  
  enableStaleReadInvalidation?: boolean;
}

export interface ToolExecutionConfig {
  
  toolTimeoutMs?: number;
  
  enableToolOutputTruncation?: boolean;
}

export interface PromptConfig {
  
  baseSystemPrompt?: string;
  




  domainPrompt?: (() => string) | false;
  
  extraPromptLayers?: string[];
  



  includeRegisteredKnowledgePrompts?: boolean;
  




  includeAgentBehaviorPrompt?: boolean;
  





  includeLanguagePolicyPrompt?: boolean;
  







  memoryContextProvider?: () => string | undefined | Promise<string | undefined>;
}

export interface PromptCacheConfig {
  



  enabled?: boolean;
  



  debug?: boolean;
}

export interface MossAgentConfig
  extends ProviderConfig, ContextManagementConfig, ToolExecutionConfig, PromptConfig {
  sessionStore: SessionStore;

  workspaceDir?: string;
  maxAgentTurns?: number;

  hooks?: AgentHooks;

  /** Inject a custom async task registry (for background subagents, etc.).
   * Defaults to an in-memory implementation. Hosts that want persistent or
   * UI-visible task tracking should inject their own. */
  asyncTaskRegistry?: import('@rdk-moss/core/contracts/async-task').MossAsyncTaskRegistry;

  /** Inject a custom memory manager. Defaults to none (memory features are
   * disabled unless the host creates and injects one). */
  memoryManager?: import('../../memory/memory-manager.js').MemoryManager;

  /** Inject a custom knowledge registry. Defaults to a fresh in-memory one.
   * Hosts that pre-load knowledge modules should inject their registry. */
  knowledgeRegistry?: import('../../knowledge/registry.js').KnowledgeRegistry;
  






  capabilityPacks?: CapabilityPack[];
  
  promptCache?: PromptCacheConfig;

  
  
  enableThinkingStream?: boolean;

  
  
  enableFollowUpGuard?: boolean;
  
  followUpGuardConfig?: Partial<FollowUpGuardConfig>;

  
  
  compactHooks?: CompactHookRegistry;
  




  skillLearner?: SkillLearner;
  




  skillPipeline?: SkillPipeline;

  






  onSelfLearningExtract?: (params: {
    sessionKey: string;
    lastUserMessage: string;
  }) => Promise<void>;

  
  
  enableSteering?: boolean;
  
  replaceDefaultSteeringRules?: boolean;
  
  steeringRules?: SteeringRule[];
  
  completionGate?: AgentLoopExtensions['completionGate'];
}

export interface ChatOptions {
  platform?: string;
  abortSignal?: AbortSignal;
  



  toolAbortSignalFor?: (toolCallId: string) => AbortSignal | undefined;
  onStream?: (event: LLMStreamEvent) => void;
  
  ephemeralTools?: Tool[];
  
  extraContext?: string;
  




  attachments?: Array<
    | { type: 'text'; text: string }
    | { type: 'image'; data: string; mimeType: string; filename?: string }
  >;
  
  temperature?: number;
  
  topP?: number;
  
  maxTurns?: number;
  
  maxToolCalls?: number;
  
  runId?: string;
}

export interface ChatResult {
  response: string;
  toolCalls: ToolCall[];
  toolResults: ToolResult[];
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
  };
  
  thinking?: string[];
  
  compactions?: number;
  
  stopReason?: string;
}

export type MossAgentEvent =
  | { type: 'text_delta'; delta: string }
  | { type: 'thinking_delta'; delta: string }
  | { type: 'tool_start'; toolName: string; toolCallId: string; input: Record<string, unknown> }
  | {
      type: 'tool_end';
      toolName: string;
      toolCallId: string;
      result: string;
      isError: boolean;
      outcome?: ToolResult['outcome'];
      durationMs?: number;
      aborted?: { by: 'user' | 'timeout' };
      structuredContent?: ToolContentBlock[];
    }
  | { type: 'turn_start'; turn: number }
  | { type: 'turn_end'; turn: number; stopReason: string; totalToolCalls?: number }
  | {
      type: 'error';
      error: string;
      retriable: boolean;
      





      errorSurface?: import('../../provider/error-classify.js').ProviderErrorSurface;
    }
  | {
      type: 'compaction';
      summaryChars: number;
      droppedMessages: number;
      checkpointOutline?: string[];
    }
  | {
      type: 'working_context_checkpoint';
      status: string;
      reason: string;
      goal: string;
      nextAction: string;
    }
  | { type: 'microcompact'; compressedCount: number; savedChars: number; savedTokens: number }
  | {
      











      type: 'llm_usage';
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens?: number;
      cacheCreationTokens?: number;
      
      contextTokens?: number;
    }
  | {
      type: 'cache_metrics';
      promptCacheEnabled: boolean;
      promptCacheDebug: boolean;
      stableChars: number;
      dynamicChars: number;
      eligible: boolean;
      eligibilityReason: string;
      minStableChars: number;
      maxDynamicCharsRatio: number;
      prefixChecks: number;
      prefixChanges: number;
      toolOrderChecks: number;
      toolOrderChanges: number;
      
      cacheReadTokens: number;
      cacheCreationTokens: number;
    }
  | { type: 'done'; result: ChatResult };

export type InternalContentBlock = Pick<
  ContentBlock,
  | 'type'
  | 'text'
  | 'data'
  | 'mimeType'
  | 'filename'
  | 'id'
  | 'name'
  | 'input'
  | 'tool_use_id'
  | 'content'
  | 'is_error'
  | '_synthetic'
  | 'structuredContent'
>;

export type InternalMessage = {
  role: 'user' | 'assistant';
  content: string | InternalContentBlock[];
  timestamp: number;
  thinking?: string[];
};

export function toSessionMessages(msgs: InternalMessage[]): Message[] {
  return msgs.map((m) => ({
    role: m.role,
    content: typeof m.content === 'string' ? m.content : m.content.map((b) => ({ ...b })),
    timestamp: m.timestamp,
    ...(m.thinking ? { thinking: m.thinking } : {}),
  }));
}

export function fromSessionMessages(msgs: Message[]): InternalMessage[] {
  return msgs.map((m) => ({
    role: m.role,
    content:
      typeof m.content === 'string'
        ? m.content
        : m.content.map((b) => ({
            type: b.type,
            ...(b.text !== undefined ? { text: b.text } : {}),
            ...(b.data !== undefined ? { data: b.data } : {}),
            ...(b.mimeType !== undefined ? { mimeType: b.mimeType } : {}),
            ...(b.filename !== undefined ? { filename: b.filename } : {}),
            ...(b.id !== undefined ? { id: b.id } : {}),
            ...(b.name !== undefined ? { name: b.name } : {}),
            ...(b.input !== undefined ? { input: b.input } : {}),
            ...(b.tool_use_id !== undefined ? { tool_use_id: b.tool_use_id } : {}),
            ...(b.content !== undefined ? { content: b.content } : {}),
            ...(b.is_error !== undefined ? { is_error: b.is_error } : {}),
            ...(b._synthetic !== undefined ? { _synthetic: b._synthetic } : {}),
            ...(b.structuredContent !== undefined
              ? { structuredContent: b.structuredContent }
              : {}),
          })),
    timestamp: m.timestamp,
    ...(m.thinking ? { thinking: m.thinking } : {}),
  }));
}

export function toLLMMessages(msgs: InternalMessage[]): LLMMessage[] {
  return msgs.map((m) => ({
    role: m.role,
    content:
      typeof m.content === 'string'
        ? m.content
        : m.content.map((b): LLMContentBlock => {
            if (b.type === 'text') return { type: 'text', text: b.text ?? '' };
            if (b.type === 'image')
              return {
                type: 'image',
                data: b.data ?? '',
                mimeType: b.mimeType ?? 'application/octet-stream',
                ...(b.filename !== undefined ? { filename: b.filename } : {}),
              };
            if (b.type === 'tool_use')
              return { type: 'tool_use', id: b.id ?? '', name: b.name ?? '', input: b.input ?? {} };
            return {
              type: 'tool_result',
              tool_use_id: b.tool_use_id ?? '',
              content: b.content ?? '',
              ...(b.is_error !== undefined ? { is_error: b.is_error } : {}),
              ...(b.structuredContent !== undefined
                ? { structuredContent: b.structuredContent }
                : {}),
            };
          }),
    ...(m.thinking ? { thinking: m.thinking } : {}),
  }));
}
