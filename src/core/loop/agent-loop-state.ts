import type { Message } from '../session/session-jsonl.js';
import type { OverflowRecoveryState } from './overflow-recovery.js';
import { createOverflowRecoveryState } from './overflow-recovery.js';
import type { AgentLoopToolExecutionMetrics } from './agent-loop-tool-execution.js';

export interface AgentLoopMutableState {
  taskIntentHalted?: boolean;
  suspendedTool?: import('../tools/tool-suspension.js').SuspendedToolCall;
  taskWaitTimeout?: import('../tools/task-observation.js').ToolWaitTimeout;
  turns: number;
  compactionRetries: number;
  outputContinuationCount: number;
  /** Visible text kept across output-limit continuations so the answer stitches. */
  carriedAssistantText: string;
  /** Active per-call output cap. Raised on truncation up to outputTokenCeiling. */
  outputTokenBudget: number;
  /** Model or user ceiling. Recovery does not request more than this. */
  outputTokenCeiling: number;
  /** Set when automatic output-limit recovery is exhausted. The run stops. */
  outputLimitHalted: boolean;
  postToolThinkingOnlyRetryAttempts: number;
  /** O13: one-shot reasoning level for the request after a thinking-only turn. */
  reasoningOverrideNextTurn?: 'low' | 'off';
  emptyResponseRetryAttempts: number;
  completionGateAttempts: number;
  postLimitToolFollowUpsUsed: number;
  proactiveCompactionAttempted: boolean;
  promptPruneCompactionAttempted: boolean;
  promptPruneCompactionSucceeded: boolean;
  hasMoreToolCalls: boolean;
  taskAcceptanceCommitted: boolean;
  compactionSummary: Message | undefined;
  pendingMessages: Message[];
  finalText: string;
  firstTokenMs: number | null;
  /** B75: run-relative time when the first provider request of the run started. */
  promptReadyMs: number | null;
  lastTurnEndMs: number | null;
  overflowState: OverflowRecoveryState;
  toolExecutionMetrics: AgentLoopToolExecutionMetrics;
  interTurnSilenceMs: number[];
  consecutiveTurnErrors: number;

  lastReportedPromptTokens: number;

  lastReportedMessageCount: number;

  /** Cumulative tokens (in+out+cache) for the run-budget guardrail. */
  budgetTokensUsed: number;

  /** Consecutive failures of the SAME verification command (W2 best-of-n trigger). */
  failingVerifyStreak: { command: string; outputTail: string; count: number } | undefined;

  /** One best-of-n escalation per run. */
  bestOfNEscalated: boolean;

  /** Timestamp of the previous LLM turn's end / last tool activity (turn-gap telemetry). */
  lastLlmActivityMs: number | undefined;
}

export function createInitialLoopState(): AgentLoopMutableState {
  return {
    turns: 0,
    compactionRetries: 0,
    outputContinuationCount: 0,
    carriedAssistantText: '',
    outputTokenBudget: 0,
    outputTokenCeiling: 0,
    outputLimitHalted: false,
    postToolThinkingOnlyRetryAttempts: 0,
    emptyResponseRetryAttempts: 0,
    completionGateAttempts: 0,
    postLimitToolFollowUpsUsed: 0,
    proactiveCompactionAttempted: false,
    promptPruneCompactionAttempted: false,
    promptPruneCompactionSucceeded: false,
    hasMoreToolCalls: true,
    taskAcceptanceCommitted: false,
    compactionSummary: undefined,
    pendingMessages: [],
    finalText: '',
    firstTokenMs: null,
    promptReadyMs: null,
    lastTurnEndMs: null,
    overflowState: createOverflowRecoveryState(),
    toolExecutionMetrics: {
      totalToolCalls: 0,
      toolErrors: 0,
      consecutiveToolErrors: 0,
      toolCallsByName: {},
      prepNextTurnParallelMs: 0,
    },
    interTurnSilenceMs: [],
    consecutiveTurnErrors: 0,
    lastReportedPromptTokens: 0,
    lastReportedMessageCount: 0,
    budgetTokensUsed: 0,
    failingVerifyStreak: undefined,
    bestOfNEscalated: false,
    lastLlmActivityMs: undefined,
  };
}

export function resetIterationState(state: AgentLoopMutableState): void {
  state.proactiveCompactionAttempted = false;
  state.promptPruneCompactionAttempted = false;
  state.promptPruneCompactionSucceeded = false;
  state.compactionRetries = 0;
  state.hasMoreToolCalls = true;
  state.lastReportedPromptTokens = 0;
  state.lastReportedMessageCount = 0;
}
