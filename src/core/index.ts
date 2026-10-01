export { combineAbortSignals, wrapToolWithAbortSignal, abortable } from './agent/index.js';
export type {
  AgentHooks,
  InputGuardrailRequest,
  InputGuardrailDecision,
  OutputGuardrailRequest,
  OutputGuardrailDecision,
  ToolApprovalRequest,
  ToolApprovalDecision,
} from './agent/index.js';
export { CommandQueueRegistry } from './agent/index.js';
export type { EnqueueOpts } from './agent/index.js';
export { MossAgent } from './agent/index.js';
export type { MossAgentConfig, ChatOptions, ChatResult, MossAgentEvent } from './agent/index.js';
export { createMossAgentLoopEventAdapter, createModelDefFromMossConfig } from './agent/index.js';
export type { MossAgentLoopEventAdapter, MossAgentLoopEventAdapterOptions } from './agent/index.js';

export type {
  LLMProvider,
  LLMProviderCapabilities,
  LLMMessage,
  LLMContentBlock,
  LLMStreamEvent,
  LLMRequestOptions,
  LLMResponse,
  LLMSystemPromptParts,
  LLMToolDeclaration,
} from './llm/index.js';
export { createInlineThinkingRouter, splitThinkingTagsFromAssistantText } from './llm/index.js';
export type { InlineThinkingRouter } from './llm/index.js';
export { classifyLlmError, retryDelayForLlmError } from './llm/index.js';
export type { LlmErrorCategory, LlmErrorClassification } from './llm/index.js';
export { createStreamFunctionFromLlmProvider } from './llm/index.js';
export type { LlmProviderStreamAdapterOptions } from './llm/index.js';
export { totalPromptTokens } from './llm/index.js';
export type { NormalizedPromptUsage } from './llm/index.js';
export {
  createClientLlmSummarizationStrategy,
  createProviderServerCompactionStrategy,
  createSummarizeFnFromLlmProvider,
} from './llm/index.js';
export type {
  ProviderServerCompactionFn,
  ProviderServerCompactionPayload,
  SummarizationStrategy,
  SummarizationStrategyInput,
  SummarizationStrategyKind,
  SummarizationStrategyResult,
} from './llm/index.js';

export {
  runAgentLoop,
  lastMessageNeedsToolFollowUpLlm,
  resolveEffectiveCaps,
  PendingToolAbortStore,
  resolveRoutedModel,
} from './loop/index.js';
export type {
  AgentLoopDeps,
  AgentLoopExtensions,
  AgentLoopHardCaps,
  AgentLoopIdentity,
  AgentLoopParams,
  AgentLoopPlatformConfig,
  AgentLoopPolicy,
  AgentLoopPromptInput,
  AgentLoopProviderInput,
  AgentLoopToolInput,
  ModelTiers,
} from './loop/index.js';
export { CompactHookRegistry, buildCompactionCheckpointOutline } from './loop/index.js';
export type {
  CompactReason,
  PreCompactContext,
  PostCompactContext,
  PreCompactHook,
  PostCompactHook,
} from './loop/index.js';
export { planContextBudgetActions } from './loop/index.js';
export type {
  ContextBudgetAction,
  ContextBudgetActionKind,
  ContextBudgetActionReason,
  ContextBudgetPlan,
  ContextBudgetPlannerInput,
} from './loop/index.js';
export {
  lastMessageNeedsToolFollowUp,
  hasToolResultAfterLastAssistant,
  shouldSuppressReasoningForToolFollowUpRound,
  detectUnexecutedToolIntents,
  extractThinkingTagBodies,
  DEFAULT_FOLLOW_UP_GUARD_CONFIG,
} from './loop/index.js';
export type { FollowUpGuardConfig, FollowUpPattern, TextActionFollowUp } from './loop/index.js';
export {
  SteeringEngine,
  DEFAULT_STEERING_RULES,
  BUILTIN_ERROR_RECOVERY_RULE,
  BUILTIN_WEB_SEARCH_VARIATION_RULE,
  BUILTIN_TOOL_LOOP_RULE,
  BUILTIN_CONTEXT_PRESSURE_RULE,
} from './loop/index.js';
export type { SteeringRule, SteeringContext, SteeringResult } from './loop/index.js';

export { InMemorySessionStore } from './session/index.js';
export type { SessionStore, SessionMeta } from './session/index.js';
export { JsonlSessionStore } from './session/index.js';
export type { JsonlSessionStoreConfig } from './session/index.js';
export {
  CURRENT_SESSION_VERSION,
  COMPACTION_SUMMARY_PREFIX,
  COMPACTION_SUMMARY_SUFFIX,
  createCompactionSummaryMessage,
} from './session/index.js';
export type {
  Message,
  ContentBlock,
  SessionHeaderEntry,
  SessionEntryBase,
  MessageEntry,
  CompactionEntry,
  SessionEntry,
  SessionFileEntry,
} from './session/index.js';
export {
  DEFAULT_AGENT_ID,
  DEFAULT_MAIN_KEY,
  normalizeAgentId,
  normalizeMainKey,
  buildAgentMainSessionKey,
  parseAgentSessionKey,
  isSubagentSessionKey,
  resolveAgentIdFromSessionKey,
  toAgentStoreSessionKey,
  resolveSessionKey,
} from './session/index.js';
export { acquireSessionWriteLock } from './session/index.js';

export { MINI_AGENT_EVENT_VERSION, createMiniAgentStream } from './subagent/index.js';
export type {
  ContextActionSummary,
  MiniAgentEvent,
  MiniAgentResult,
  RunMetrics,
} from './subagent/index.js';
export type {
  ProviderErrorAction,
  ProviderErrorCategory,
  ProviderErrorSurface,
} from '../provider/index.js';
export type { SpawnToolScope } from './subagent/index.js';
export {
  SpawnProfileRegistry,
  SPAWN_TOOL_SCOPE_SETS,
  createSpawnProfileRegistryFromDefaults,
  getDefaultSpawnProfileRegistry,
  resolveSpawnToolSet,
  buildSubagentPromptAddon,
  registerSpawnToolExtensions,
} from './subagent/index.js';
export {
  SubagentExpertRegistry,
  type SubagentExpertContributor,
  type SubagentExpertDefinition,
} from './subagent/index.js';

export type {
  ToolContext,
  Tool,
  ToolCall,
  ToolResult,
  ToolResultOutcome,
  ToolContentBlock,
  StructuredToolResult,
} from './tools/index.js';
export { canHostInjectToolWithEmptyInput } from './tools/index.js';
export { filterToolsForRun } from './tools/index.js';
export type { ToolFilter } from './tools/index.js';
export { ToolRegistry } from './tools/index.js';
export type { ToolGroup, ToolRegistryOptions } from './tools/index.js';
export { convertMessagesToPi } from './tools/index.js';
export {
  validateToolInputObject,
  runPreToolHookChain,
  registerPreToolHook,
} from './tools/index.js';
export type { PreToolHookContext, PreToolHookResult, PreToolHook } from './tools/index.js';
export {
  ToolHookRegistry,
  createSecretSanitizerHook,
  createTimingHook,
  createReadOnlyHook,
  createExecLikeFailureHintHook,
} from './tools/index.js';
export type {
  PreToolUseDecision,
  PreToolUseHook,
  PostToolUseHook,
  PostToolUseFailureHook,
} from './tools/index.js';
export { isToolAssumedMutating, findReplayableToolResultContent } from './tools/index.js';
export {
  setOpenUrlMarkers,
  parseUrlsFromOpenUrlToolResult,
  maybeSuppressRedundantWebFetchAfterOpenUrl,
} from './tools/index.js';
export { extractToolInvocationFromPlanText } from './tools/index.js';
export type { ExtractedToolInvocation } from './tools/index.js';

export { ErrorCode } from '../errors.js';
export type { MossErrorOutcome } from '../errors.js';

// Shared task-artifact IO + CLI-shell projection layer.
export { appendAcceptanceVerdict, loadTaskArtifacts } from './task-runtime/artifacts.js';
export type { TaskArtifacts } from './task-runtime/artifacts.js';
export { TaskRuntime, classifyTaskKind, describeToolCall } from './task-runtime/runtime.js';
export type {
  MissionState,
  MissionResult,
  TaskKind,
  TaskSummary,
  TaskDetail,
  FailureItem,
  RepairCycle,
  TaskHistoryEntry,
  DeviceObservation,
  TaskDeviceContext,
  RuntimeLiveState,
  TaskRuntimeOptions,
} from './task-runtime/runtime.js';

// Unified task runtime (Task OS M5): one model, four interfaces.
export { runTask, resumeTask, summarizeTaskRun } from './task/task-engine.js';
export type { TaskEngineDeps, TaskEngineProgress, TaskRunResult } from './task/task-engine.js';
export { createAgentTurnRunner } from './task/agent-turn.js';
export type { AgentTurnRunner, AgentTurnRunnerOptions } from './task/agent-turn.js';
export {
  appendTaskEvent,
  tryAppendTaskEvent,
  createDraftTask,
  emitAcceptanceLifecycle,
  getTaskStateSnapshot,
  listTaskStateSnapshots,
  listTaskEvents,
  listAcceptanceVerdicts,
  recordFailure,
  listFailures,
  recordRepair,
  listRepairs,
  replayTaskPhase,
  findLatestLiveTaskSnapshot,
  buildTaskTimeline,
  formatTaskTimeline,
  isTaskSettled,
} from './task/task-store.js';
export type { TaskTimelineEntry } from './task/task-store.js';
export {
  createCommandVerdictProvider,
  createContractVerdictProvider,
  createTaskVerdictProvider,
  evaluateContractAcceptance,
} from './task/verdict.js';
export type { VerdictProvider, VerdictSource, TaskVerdict } from './task/verdict.js';
export { matchTaskCapabilities, buildCapabilityPromptLayer } from './task/capability.js';
export type {
  CapabilityCandidate,
  CapabilityInventory,
  TaskCapabilityMatch,
} from './task/capability.js';
