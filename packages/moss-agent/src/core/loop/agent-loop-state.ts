import type { Message } from '../session/session-jsonl.js';
import type { OverflowRecoveryState } from './overflow-recovery.js';
import { createOverflowRecoveryState } from './overflow-recovery.js';
import type { AgentLoopToolExecutionMetrics } from './agent-loop-tool-execution.js';







export interface AgentLoopMutableState {
  turns: number;
  compactionRetries: number;
  outputContinuationCount: number;
  planToolNudgeAttempts: number;
  /** Soft mid-run reminders to open todo_write on multi-step coding (Grok TodoNudge). */
  todoNudgeAttempts: number;
  /** Soft mid-run reminders to run tests after several edits without verification. */
  verifyNudgeAttempts: number;
  /** Soft mid-run skill-discovery reminders after path exploration (Grok light). */
  skillDiscoveryNudgeAttempts: number;
  /** Skill names already surfaced by skill-discovery this run. */
  skillDiscoveryReportedNames: Set<string>;
  postToolThinkingOnlyRetryAttempts: number;
  emptyResponseRetryAttempts: number;
  completionGateAttempts: number;
  postLimitToolFollowUpsUsed: number;
  proactiveCompactionAttempted: boolean;
  promptPruneCompactionAttempted: boolean;
  promptPruneCompactionSucceeded: boolean;
  hasMoreToolCalls: boolean;
  compactionSummary: Message | undefined;
  pendingMessages: Message[];
  finalText: string;
  firstTokenMs: number | null;
  lastTurnEndMs: number | null;
  overflowState: OverflowRecoveryState;
  toolExecutionMetrics: AgentLoopToolExecutionMetrics;
  interTurnSilenceMs: number[];
  consecutiveTurnErrors: number;
  





  lastReportedPromptTokens: number;
  
  lastReportedMessageCount: number;
}

export function createInitialLoopState(): AgentLoopMutableState {
  return {
    turns: 0,
    compactionRetries: 0,
    outputContinuationCount: 0,
    planToolNudgeAttempts: 0,
    todoNudgeAttempts: 0,
    verifyNudgeAttempts: 0,
    skillDiscoveryNudgeAttempts: 0,
    skillDiscoveryReportedNames: new Set(),
    postToolThinkingOnlyRetryAttempts: 0,
    emptyResponseRetryAttempts: 0,
    completionGateAttempts: 0,
    postLimitToolFollowUpsUsed: 0,
    proactiveCompactionAttempted: false,
    promptPruneCompactionAttempted: false,
    promptPruneCompactionSucceeded: false,
    hasMoreToolCalls: true,
    compactionSummary: undefined,
    pendingMessages: [],
    finalText: '',
    firstTokenMs: null,
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
