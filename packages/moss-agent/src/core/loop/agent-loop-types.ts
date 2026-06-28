import type { Model, StreamFunction, ThinkingLevel } from '../../provider/pi-ai-types.js';
import type { ContextPruningSettings } from '../../context/pruning.js';
import type { CompactHookRegistry } from './compact-hooks.js';
import type { Message } from '../session/session-jsonl.js';
import type { ToolHookRegistry } from '../tools/tool-hooks.js';
import type { Tool, ToolContext } from '../tools/tool-types.js';
import type { SteeringEngine } from './steering.js';




export interface AgentLoopPlatformConfig {
  
  parallelSafeTools?: Set<string>;
  
  toolTimeoutMs?: number;
  
  toolHeartbeatIntervalMs?: number;
  
  skipHeartbeatToolNames?: Set<string>;
  
  loadToolsMetaName?: string;
  
  recordLlmUsage?: boolean;
  
  quiet?: boolean;
  
  promptPrefixDebug?: boolean;
}

export interface AgentLoopIdentity {
  runId: string;
  sessionKey: string;
  agentId: string;
}

export interface AgentLoopPromptInput {
  currentMessages: Message[];
  compactionSummary: Message | undefined;
  systemPrompt: string;
  systemPromptParts?: { stable: string; dynamic: string };
  systemPromptMeta?: { hashShort: string; layerCount: number };
}

export interface AgentLoopToolInput {
  toolsForRun: Tool[];
  getToolsForRun?: () => Tool[];
  toolCtx: ToolContext;
  checkToolApproval?: (call: {
    id: string;
    name: string;
    input: unknown;
  }) => Promise<{ approved: boolean; decision: string; reason?: string } | null>;
  toolAbortSignalFor?: (toolCallId: string) => AbortSignal | undefined;
  enrichToolContext?: (baseCtx: ToolContext, sessionKey: string) => ToolContext;
  toolHooks?: ToolHookRegistry;
}

export interface AgentLoopProviderInput {
  modelDef: Model<any>;
  streamFn: StreamFunction;
  apiKey?: string;
  temperature?: number;
  topP?: number;
  reasoning?: ThinkingLevel;
  maxOutputTokens?: number;
}

export interface AgentLoopHardCaps {
  maxMessageCount?: number;
  maxTotalTokens?: number;
  maxConsecutiveTurnErrors?: number;
  maxOutputContinuations?: number;
}

export interface AgentLoopPolicy {
  maxTurns: number;
  maxToolCalls?: number;
  contextTokens: number;
  pruningSettings?: Partial<ContextPruningSettings>;
  platform?: AgentLoopPlatformConfig;
  hardCaps?: AgentLoopHardCaps;
}

export interface AgentLoopExtensions {
  getSteeringMessages?: () => Promise<Message[]>;
  getFollowUpMessages?: () => Promise<Message[]>;
  guardAssistantOutput?: (request: {
    sessionKey: string;
    runId: string;
    turn: number;
    response: string;
    stopReason?: string;
  }) => Promise<
    { approved: true; response?: string } | { approved: false; reason: string; response?: string }
  >;
  compactHooks?: CompactHookRegistry;
  steeringEngine?: SteeringEngine;
  completionGate?: (request: {
    sessionKey: string;
    runId: string;
    turn: number;
    response: string;
    stopReason?: string;
    messages: Message[];
    totalToolCalls: number;
    toolCallsByName: Record<string, number>;
  }) => Promise<{ ok: true } | { ok: false; reason: string; correction?: string }>;
}

export interface AgentLoopDeps {
  appendMessage: (sessionKey: string, msg: Message) => Promise<void>;
  replaceMessages?: (sessionKey: string, messages: Message[]) => Promise<void>;
  prepareCompaction: (params: {
    messages: Message[];
    sessionKey: string;
    runId: string;
    forceCompaction?: boolean;
    includeThinking?: boolean;
    abortSignal?: AbortSignal;
  }) => Promise<{
    summary?: string;
    summaryMessage?: Message;
    messages?: Message[];
    droppedMessages?: number;
    checkpointOutline?: string[];
  }>;
  abortSignal: AbortSignal;
}

export interface AgentLoopParams
  extends
    AgentLoopIdentity,
    AgentLoopPromptInput,
    AgentLoopToolInput,
    AgentLoopProviderInput,
    AgentLoopPolicy,
    AgentLoopExtensions,
    AgentLoopDeps {}
