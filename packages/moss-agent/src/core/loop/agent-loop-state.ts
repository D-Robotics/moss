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
  /** Soft mid-run recovery after a red verification result. */
  redVerifyNudgeAttempts: number;
  /** Soft mid-run recovery after fan_out/create_subagent child failures. */
  fanOutNudgeAttempts: number;
  /** Soft mid-run ask when multi-interpretation coding + edits without clarify. */
  ambiguityNudgeAttempts: number;
  /** Soft mid-run reminder after skill install without load_skill. */
  skillLoadNudgeAttempts: number;
  /** Soft mid-run reminder while background create_subagent is still STARTED. */
  subagentRunningNudgeAttempts: number;
  /** Soft mid-run reminder after subagent_stop without suite evidence. */
  subagentStoppedNudgeAttempts: number;
  /** Soft mid-run reminder when user asked to remember without memory_write. */
  memoryWriteNudgeAttempts: number;
  /** Soft mid-run reminder when board/ops asked without device tools. */
  deviceToolsNudgeAttempts: number;
  /** Soft mid-run reminder when browser/vision asked without those tools. */
  browserVisionToolsNudgeAttempts: number;
  /** Soft mid-run reminder when web research asked without web tools. */
  webToolsNudgeAttempts: number;
  /** Soft mid-run reminder when plan work asked without plan tools. */
  planToolsNudgeAttempts: number;
  /** Soft mid-run reminder when commit/push asked without git exec. */
  gitToolsNudgeAttempts: number;
  /** Soft mid-run reminder when install-deps asked without install exec. */
  installToolsNudgeAttempts: number;
  /** Soft mid-run reminder when eval suite asked without eval tool. */
  evalToolsNudgeAttempts: number;
  /** Soft mid-run reminder when call-graph asked without codegraph tools. */
  codegraphToolsNudgeAttempts: number;
  /** Soft mid-run reminder when user asked to run tests without verify tools. */
  runTestsToolsNudgeAttempts: number;
  /** Soft mid-run reminder when user asked to build without build exec. */
  buildToolsNudgeAttempts: number;
  /** Soft mid-run reminder when dev server start asked without bg exec. */
  backgroundServerNudgeAttempts: number;
  /** Soft mid-run reminder when docker work asked without docker exec. */
  dockerToolsNudgeAttempts: number;
  /** Soft mid-run reminder when publish/deploy asked without matching exec. */
  publishDeployToolsNudgeAttempts: number;
  /** Soft mid-run reminder when format asked without format exec. */
  formatToolsNudgeAttempts: number;
  /** Soft mid-run reminder when migrate asked without migrate exec. */
  migrateToolsNudgeAttempts: number;
  /** Soft mid-run reminder when codegen asked without generate exec. */
  codegenToolsNudgeAttempts: number;
  /** Soft mid-run reminder when seed asked without seed exec. */
  seedToolsNudgeAttempts: number;
  /** Soft mid-run reminder when e2e asked without e2e/verify tools. */
  e2eToolsNudgeAttempts: number;
  /** Soft mid-run reminder when coverage asked without coverage exec. */
  coverageToolsNudgeAttempts: number;
  /** Soft mid-run reminder when snapshot update asked without -u exec. */
  snapshotToolsNudgeAttempts: number;
  /** Soft mid-run reminder when security audit asked without audit exec. */
  auditToolsNudgeAttempts: number;
  /** Soft mid-run reminder when smoke/load/perf asked without matching exec. */
  smokeLoadToolsNudgeAttempts: number;
  /** Soft mid-run reminder when contract/visual tests asked without matching exec. */
  contractVisualToolsNudgeAttempts: number;
  /** Soft mid-run reminder when mutation/fuzz tests asked without matching exec. */
  mutationFuzzToolsNudgeAttempts: number;
  /** Soft mid-run reminder when lighthouse/a11y asked without matching exec. */
  lighthouseA11yToolsNudgeAttempts: number;
  /** Soft mid-run reminder when Storybook asked without storybook exec. */
  storybookToolsNudgeAttempts: number;
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
    redVerifyNudgeAttempts: 0,
    fanOutNudgeAttempts: 0,
    ambiguityNudgeAttempts: 0,
    skillLoadNudgeAttempts: 0,
    subagentRunningNudgeAttempts: 0,
    subagentStoppedNudgeAttempts: 0,
    memoryWriteNudgeAttempts: 0,
    deviceToolsNudgeAttempts: 0,
    browserVisionToolsNudgeAttempts: 0,
    webToolsNudgeAttempts: 0,
    planToolsNudgeAttempts: 0,
    gitToolsNudgeAttempts: 0,
    installToolsNudgeAttempts: 0,
    evalToolsNudgeAttempts: 0,
    codegraphToolsNudgeAttempts: 0,
    runTestsToolsNudgeAttempts: 0,
    buildToolsNudgeAttempts: 0,
    backgroundServerNudgeAttempts: 0,
    dockerToolsNudgeAttempts: 0,
    publishDeployToolsNudgeAttempts: 0,
    formatToolsNudgeAttempts: 0,
    migrateToolsNudgeAttempts: 0,
    codegenToolsNudgeAttempts: 0,
    seedToolsNudgeAttempts: 0,
    e2eToolsNudgeAttempts: 0,
    coverageToolsNudgeAttempts: 0,
    snapshotToolsNudgeAttempts: 0,
    auditToolsNudgeAttempts: 0,
    smokeLoadToolsNudgeAttempts: 0,
    contractVisualToolsNudgeAttempts: 0,
    mutationFuzzToolsNudgeAttempts: 0,
    lighthouseA11yToolsNudgeAttempts: 0,
    storybookToolsNudgeAttempts: 0,
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
