import type { Message } from '../session/session-jsonl.js';
import type { OverflowRecoveryState } from './overflow-recovery.js';
import { createOverflowRecoveryState } from './overflow-recovery.js';
import type { AgentLoopToolExecutionMetrics } from './agent-loop-tool-execution.js';

export interface AgentLoopMutableState {
  turns: number;
  compactionRetries: number;
  outputContinuationCount: number;
  /** One-shot counter for the missing-tool-invocation nudge (planned a tool call in text but never executed it). */
  missingToolNudgeAttempts: number;
  /** Soft mid-run reminders to open todo_write on multi-step coding (Grok TodoNudge). */
  todoNudgeAttempts: number;
  /** Soft mid-run reminders to run tests after several edits without verification. */
  verifyNudgeAttempts: number;
  /** Soft mid-run recovery after a red verification result. */
  redVerifyNudgeAttempts: number;
  /** Soft mid-run recovery after fan_out/create_subagent child failures. */
  fanOutNudgeAttempts: number;
  /** Soft mid-run ask when multi-interpretation coding + edits without clarify. */
  ambiguityNudgeAttempts: number;
  /** Soft mid-run reminder while background create_subagent is still STARTED. */
  subagentRunningNudgeAttempts: number;
  /** Soft mid-run reminder after subagent_stop without suite evidence. */
  subagentStoppedNudgeAttempts: number;
  /** Soft mid-run reminder when web research asked without web tools. */
  webToolsNudgeAttempts: number;
  /** Soft mid-run reminder when commit/push asked without git exec. */
  gitToolsNudgeAttempts: number;
  /** Soft mid-run reminder when install-deps asked without install exec. */
  installToolsNudgeAttempts: number;
  /** Soft mid-run reminder when user asked to run tests without verify tools. */
  runTestsToolsNudgeAttempts: number;
  /** Soft mid-run reminder when user asked to build without build exec. */
  buildToolsNudgeAttempts: number;
  /** Soft mid-run reminder when dev server start asked without bg exec. */
  backgroundServerNudgeAttempts: number;
  /** Soft mid-run recovery after a red task_acceptance verdict (repair-loop discipline). */
  taskRepairNudgeAttempts: number;
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
    missingToolNudgeAttempts: 0,
    todoNudgeAttempts: 0,
    verifyNudgeAttempts: 0,
    redVerifyNudgeAttempts: 0,
    fanOutNudgeAttempts: 0,
    ambiguityNudgeAttempts: 0,
    subagentRunningNudgeAttempts: 0,
    subagentStoppedNudgeAttempts: 0,
    webToolsNudgeAttempts: 0,
    gitToolsNudgeAttempts: 0,
    installToolsNudgeAttempts: 0,
    runTestsToolsNudgeAttempts: 0,
    buildToolsNudgeAttempts: 0,
    backgroundServerNudgeAttempts: 0,
    taskRepairNudgeAttempts: 0,
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
