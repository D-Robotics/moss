import { EventStream } from '../../provider/pi-ai-types.js';
import type { Message } from '../session/session-jsonl.js';
import type {
  ContextBudgetActionKind,
  ContextBudgetActionReason,
} from '../loop/context-budget-planner.js';
import type { LlmErrorCategory } from '../llm/llm-error-classifier.js';
import type { ToolContentBlock, ToolResult, ToolResultOutcome } from '../tools/tool-types.js';
import type { MossErrorOutcome } from '../../errors.js';

export const MINI_AGENT_EVENT_VERSION = 1 as const;

type MiniAgentEventPayload =
  | { type: 'agent_end'; runId: string; messages: Message[] }
  | {
      type: 'agent_error';
      runId: string;
      error: string;
      errorDetails?: MossErrorOutcome;

      surface?: import('../../provider/error-classify.js').ProviderErrorSurface;
    }
  | { type: 'turn_start'; turn: number }
  | { type: 'turn_end'; turn: number; stopReason?: string; totalToolCalls?: number }
  | { type: 'message_start'; message: Message }
  | { type: 'message_delta'; delta: string }
  | { type: 'message_end'; message: Message; text: string }
  | { type: 'thinking_delta'; delta: string }
  | { type: 'tool_execution_start'; toolCallId: string; toolName: string; args: unknown }
  | {
      type: 'tool_execution_end';
      toolCallId: string;
      toolName: string;
      result: string;
      isError: boolean;
      content?: string;
      args?: unknown;
      outcome?: ToolResultOutcome;
      durationMs?: number;
      aborted?: { by: 'user' | 'timeout' };
      structuredContent?: ToolContentBlock[];
      error?: ToolResult['error'];
    }
  | { type: 'tool_execution_progress'; toolCallId: string; toolName: string; elapsed_sec: number }
  | { type: 'tool_skipped'; toolCallId: string; toolName: string }
  | { type: 'tool_approval_request'; toolCallId: string; toolName: string; args: unknown }
  | {
      type: 'tool_approval_resolved';
      toolCallId: string;
      toolName: string;
      decision: 'allow-once' | 'allow-always' | 'deny';
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
  | { type: 'context_overflow_compact'; error: string; recoveryLevel?: number }
  | { type: 'retry'; attempt: number; delay: number; error: string; category?: LlmErrorCategory }
  | { type: 'turn_transition'; turn: number; reason: string }
  | {
      type: 'llm_usage';
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens?: number;
      cacheCreationTokens?: number;
    }
  | { type: 'output_continuation'; attempt: number; maxAttempts: number }
  | {
      type: 'context_action';
      reason: ContextBudgetActionReason;
      actions: ContextActionSummary[];
      savedChars: number;
      savedTokens: number;
    }
  | { type: 'run_metrics'; metrics: RunMetrics };

export type MiniAgentEvent = MiniAgentEventPayload & {
  version?: typeof MINI_AGENT_EVENT_VERSION;
};

export interface ContextActionSummary {
  kind: ContextBudgetActionKind;
  reason: ContextBudgetActionReason;
  count: number;
  savedChars: number;
  savedTokens: number;
}

export interface RunMetrics {
  runId: string;
  sessionKey: string;
  totalTurns: number;
  totalToolCalls: number;
  toolCallsByName: Record<string, number>;
  toolErrors: number;
  microcompactSavedChars: number;
  overflowRecoveries: number;
  totalDurationMs: number;
  firstTokenMs: number | null;
  contextCompactions: number;
  systemPromptChars: number;
  systemPromptHashShort: string;
  effectiveContextTokens: number;
  llmCompactionFailureStreak: number;
  systemPromptLayerCount: number;
  promptCacheEnabled?: boolean;
  promptCacheDebug?: boolean;
  promptCacheStableChars?: number;
  promptCacheDynamicChars?: number;
  promptCacheEligible?: boolean;
  promptCacheEligibilityReason?: string;
  promptCacheMinStableChars?: number;
  promptCacheMaxDynamicCharsRatio?: number;
  promptPrefixChecks?: number;
  promptPrefixChanges?: number;
  promptToolOrderChecks?: number;
  promptToolOrderChanges?: number;

  interTurnSilenceMs?: number[];
  llmConnectionReused?: boolean;
  prepNextTurnParallelMs?: number;
}

export interface MiniAgentResult {
  finalText: string;
  turns: number;
  totalToolCalls: number;
  messages: Message[];
}

export function createMiniAgentStream(): EventStream<MiniAgentEvent, MiniAgentResult> {
  const stream = new EventStream<MiniAgentEvent, MiniAgentResult>(
    () => false,
    () => ({ finalText: '', turns: 0, totalToolCalls: 0, messages: [] })
  );
  const push = stream.push.bind(stream) as (event: MiniAgentEvent) => void;

  (stream as unknown as { push: (event: MiniAgentEvent) => void }).push = (event) => {
    push({ ...event, version: event.version ?? MINI_AGENT_EVENT_VERSION });
  };
  return stream;
}
