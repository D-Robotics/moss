export { KnowledgeRegistry } from './knowledge/index.js';




export {
  registerKnowledgeModule,
  unregisterKnowledgeModule,
  getKnowledgeModule,
  getAllKnowledgeModules,
  findModuleForPlatform,
  findModuleForFamily,
  getAllDeviceProfiles,
  getAllDocEntries,
  getAllPromptFragments,
  getAllCommandPatterns,
  getAllFailureHints,
  getAggregatedEcosystemPrompt,
} from './knowledge/index.js';


export {
  PlatformExtensionRegistry,
  getDefaultExtensionsRegistry,
  syncPlatformExtensionsAtStartup,
  setVendorPluginCallbacks,
  setKnowledgeRegistryForExtensions,
  applyPlatformExtension,
  applyPlatformExtensionForce,
  getRegisteredPlatformExtensions,
  setRegisteredPlatformExtensionsSnapshot,
  resetPlatformExtensionRegistryForTests,
  listAppliedPlatformExtensionState,
} from './extensions/index.js';
export type { VendorPluginCallbacks } from './extensions/index.js';


export {
  sanitizeSecrets,
  containsSecrets,
  isCommandDangerous,
  isPathProtected,
  registerProtectedPaths,
  matchTextApproval,
  classifyFileKind,
  stripShellPrefixBeforeHeredoc,
} from './safety/index.js';
export type { ChannelSource, ChannelSafetyResult, TextApprovalResult } from './safety/index.js';


export {
  BUILTIN_SKILLS,
  SkillRegistry,
  listBuiltinSkills,
  type SkillRegistryOptions,
} from './skills/index.js';
export type { SkillMeta, SkillPermission, SkillRuntimePolicy } from './skills/types.js';


export {
  buildRoboticsEngineeringPrompt,
  buildRoboticsEngineeringPromptQuick,
  hashSystemPromptForTelemetry,
  hashSystemPromptLayers,
  hashStableDynamicSystemPrompt,
} from './prompts/index.js';
export {
  buildMossDefaultWorkflowPrompt,
  buildRuntimeCapabilitiesPrompt,
  isCodeGraphToolName,
} from './context/index.js';
export type { RuntimeCapabilitiesPromptOptions, RuntimeCapabilityTool } from './context/index.js';


export { MossAgent } from './core/index.js';
export type { MossAgentConfig, ChatOptions, ChatResult, MossAgentEvent } from './core/index.js';
// Soul / identity — embeddable (moved from cli/ to core/agent/ for clean embedding)
export { resolveSoulIdentity, resolveSoul } from './core/agent/soul.js';
export { buildMossCliIdentity, buildModelHonestyFooter, MOSS_CLI_IDENTITY } from './core/agent/identity.js';
export type {
  AgentHooks,
  InputGuardrailRequest,
  InputGuardrailDecision,
  OutputGuardrailRequest,
  OutputGuardrailDecision,
  ToolApprovalRequest,
  ToolApprovalDecision,
} from './core/index.js';
export {
  DeviceConnectionHealth,
  DeviceConnectionLostError,
} from './tools/device-connection-health.js';
export type {
  DeviceConnectionHealthOptions,
  DeviceConnectionSnapshot,
} from './tools/device-connection-health.js';
export { DeviceSshSession } from './tools/device-ssh-session.js';
export type {
  DeviceSshExecutor,
  DeviceSshRunOptions,
} from './tools/device-ssh-session.js';
export { buildDeviceCamerasCommand, buildDeviceRoboticsStatusCommand } from './tools/device-diagnostics.js';
export { buildRosEnvironmentCommand as buildRos1EnvironmentCommand, createRos1Tools } from './tools/device-ros1.js';
export { createRos2Tools } from './tools/device-ros2.js';
export { PendingToolAbortStore } from './core/index.js';
export type { AgentLoopHardCaps } from './core/index.js';

export { resolveEffectiveCaps } from './core/index.js';
export {
  executeGoalCommand,
  formatGoalCommandResult,
  handleGoalCommand,
  isGoalCommand,
  parseGoalCommand,
} from './goal.js';
export type {
  GoalCommandAction,
  GoalCommandAgent,
  GoalCommandEvent,
  GoalCommandOptions,
  GoalCommandResult,
  GoalState,
  GoalStatus,
  HandleGoalCommandParams,
  ParsedGoalCommand,
} from './goal.js';

export { createInlineThinkingRouter, splitThinkingTagsFromAssistantText } from './core/index.js';
export type { InlineThinkingRouter } from './core/index.js';
export { totalPromptTokens } from './core/index.js';
export type { NormalizedPromptUsage } from './core/index.js';
export { ToolRegistry } from './core/index.js';
export { filterToolsForRun } from './core/index.js';
export type { ToolFilter, ToolGroup, ToolRegistryOptions } from './core/index.js';
export type {
  ToolContext,
  Tool,
  ToolCall,
  ToolResult,
  ToolResultOutcome,
  ToolContentBlock,
  StructuredToolResult,
} from './core/index.js';
export { collectCapabilityPacks } from './core/index.js';
export type { CapabilityPack, CapabilityPackContributions } from './core/index.js';
export {
  createBrowserTools,
  createBrowserFetchTool,
  createBrowserControlTool,
} from './tools/browser-tools.js';
export type { BrowserToolOptions } from './tools/browser-tools.js';

export { canHostInjectToolWithEmptyInput } from './core/index.js';
export type {
  LLMProvider,
  LLMProviderCapabilities,
  LLMMessage,
  LLMContentBlock,
  LLMStreamEvent,
  LLMRequestOptions,
  LLMResponse,
  LLMToolDeclaration,
} from './core/index.js';
export { InMemorySessionStore, JsonlSessionStore } from './core/index.js';
export type { JsonlSessionStoreConfig } from './core/index.js';
export type { SessionStore, SessionMeta } from './core/index.js';











export {
  isTaskFrameCheckpointMessage,
  stripTaskFrameCheckpointsFromLlmMessages,
} from './core/index.js';
export { CommandQueueRegistry } from './core/index.js';
export type { EnqueueOpts } from './core/index.js';


export { auditResolvedCliConfig, isBroadTrustedToolPattern } from './cli/config.js';
export type { CliConfigAuditWarning, CliConfigAuditSeverity } from './cli/config.js';
export { ConfigManager } from './cli/config-manager.js';
export { ModelCatalog } from './cli/model-catalog-manager.js';
export { CliServices } from './cli/cli-services.js';
export {
  clearMossCommunityAuthSession,
  MossCommunityAuthRequiredError,
  ensureMossCommunityAuth,
  formatCommunityAuthStatus,
  getMossCommunityAuthStatus,
  readMossCommunityAuthSession,
  renderCommunityAuthRequiredMessage,
  resolveCommunityAuthSessionPath,
  resolveCommunityUserFromToken,
  runMossCommunityAuthLogin,
  writeMossCommunityAuthSession,
} from './cli/community-auth.js';
export type {
  MossCommunityAuthContext,
  MossCommunityAuthRuntime,
  MossCommunityAuthSession,
  MossCommunityAuthStatus,
  MossCommunityUser,
} from './cli/community-auth.js';


export { TextDeltaSmoother } from './utils/index.js';
export { parseAtRefs, hasAtRefs } from './utils/index.js';
export {
  MOSS_DEFAULT_MAX_AGENT_TURNS,
  resolveMossMaxAgentTurns,
  resolveToolFollowupBypassCap,
} from './utils/index.js';
export {
  envPreferMoss,
  parseEnvNumberPreferMoss,
  envTruthyUnlessZeroPreferMoss,
} from './utils/index.js';


export { compactSubagentSummaryForParent } from './context/index.js';
export { truncateToolOutput, registerToolOutputLimits } from './context/index.js';
export {
  CONTEXT_WINDOW_HARD_MIN_TOKENS,
  CONTEXT_WINDOW_WARN_BELOW_TOKENS,
  resolveContextWindowInfo,
  evaluateContextWindowGuard,
} from './context/index.js';
export type {
  ContextWindowSource,
  ContextWindowInfo,
  ContextWindowGuardResult,
} from './context/index.js';


export { bridgeAgentToChannel } from './channels/index.js';
export type {
  BridgeAgentToChannelOptions,
  ChannelMessage,
  ChannelResponse,
  MessageChannel,
} from './channels/index.js';


export { PiAiLLMProvider } from './provider/index.js';
export type { PiAiModelInfo, PiAiStreamFunction, PiAiLLMProviderConfig } from './provider/index.js';


export { AnthropicLLMProvider } from './provider/anthropic.js';
export type { AnthropicLLMProviderConfig } from './provider/anthropic.js';
export { OpenAILLMProvider } from './provider/openai.js';
export type { OpenAILLMProviderConfig } from './provider/openai.js';


export {
  PROVIDER_PRESETS,
  parseProviderPreset,
  normalizeProvider,
  inferProviderFromBaseUrl,
} from './provider/index.js';
export type { CliProviderPreset, ProviderPreset } from './provider/index.js';


export {
  loadMcpConfig,
  loadMcpConfigWithDiagnostics,
  connectMcpServers,
  connectMcpServersWithFailures,
} from './mcp/index.js';
export type {
  McpServerConfig,
  McpConfig,
  McpConfigDiagnostic,
  McpConfigLoadResult,
  McpTool,
  McpConnection,
  McpConnectionResult,
} from './mcp/index.js';


export {
  FailoverError,
  isFailoverError,
  isContextOverflowError,
  isRateLimitError,
  isTimeoutError,
  isServerError,
  isTransientError,
  isAuthError,
  classifyFailoverReason,
  isFailoverErrorMessage,
  retryAsync,
  describeError,
} from './provider/index.js';
export type { FailoverReason, RetryOptions } from './provider/index.js';


export { convertMessagesToPi } from './core/index.js';


export type { SpawnToolScope } from './core/index.js';
export {
  SpawnProfileRegistry,
  SPAWN_TOOL_SCOPE_SETS,
  createSpawnProfileRegistryFromDefaults,
  getDefaultSpawnProfileRegistry,
  resolveSpawnToolSet,
  buildSubagentPromptAddon,
  registerSpawnToolExtensions,
} from './core/index.js';


export {
  builtinTools,
  registerBuiltinTools,
  readFileTool,
  writeFileTool,
  moveFileTool,
  listDirectoryTool,
  execTool,
  searchFilesTool,
  searchCodeTool,
  webFetchTool,
  webSearchTool,
  applyPatchTool,
  installSkillTool,
} from './tools/builtin.js';


export { codeDiagnosticsTool } from './tools/code-diagnostics.js';


export {
  backgroundExecTools,
  execBackgroundTool,
  execLogsTool,
  execStopTool,
  subscribeBackgroundOutput,
  subscribeBackgroundLifecycle,
  getBackgroundProcessSnapshot,
  listBackgroundProcessSnapshots,
  stopBackgroundProcess,
  type BackgroundProcSnapshot,
  type BackgroundOutputChunk,
  type BackgroundOutputListener,
  type BackgroundLifecycleListener,
} from './tools/background-exec.js';


export { createWebFetchTool, type WebFetchOptions } from './tools/web-fetch.js';
export {
  createWebSearchTool,
  bingSearch,
  duckDuckGoSearch,
  duckDuckGoLiteSearch,
  createBraveSearch,
  type WebSearchOptions,
  type WebSearchRetryOptions,
  type WebSearchBackend,
  type WebSearchBackendOptions,
  type WebSearchResult,
} from './tools/web-search.js';


export {
  createLogger,
  configureRootLogger,
  getRootLogger,
  redactSensitive,
  type LogLevel,
  type LogEntry,
  type Logger,
  type LoggerOptions,
} from './logger.js';


export {
  ErrorCode,
  MossError,
  isMossError,
  throwMoss,
  wrapAsMoss,
  formatMossError,
  isMossErrorRecoverable,
  errorMessage,
  type MossErrorDetails,
} from './errors.js';


export {
  redactSensitiveData,
  parseTelemetryAllow,
  TraceRegistry,
  setTracer,
  getTracer,
  withSpan,
  turnAttributes,
  toolAttributes,
  llmRequestAttributes,
  logLLMUsage,
  readUsageLog,
  summarizeUsage,
  formatUsageSummary,
  estimateLLMCost,
  registerModelPricing,
} from './observability/index.js';
export type {
  RedactOptions,
  Tracer,
  TraceSpan,
  LLMUsageRecord,
  LLMUsageSummary,
} from './observability/index.js';


export { ToolHookRegistry } from './core/index.js';
export type {
  PreToolUseHook,
  PostToolUseHook,
  PostToolUseFailureHook,
  PreToolUseDecision,
} from './core/index.js';


export {
  createVisionAnalyzeTool,
  visionAnalyzeTool,
  VisionRegistry,
  createDefaultVisionRegistry,
  buildVisionSystemPrompt,
} from './vision/index.js';
export type {
  VisionAnalyzeInput,
  VisionAnalyzeResult,
  VisionToolOptions,
  VisionCapability,
  VisionCapabilityProvider,
  VisionRegistryOptions,
  VisionPromptOptions,
} from './vision/index.js';


export {
  WebBrowserAgent,
  createWebBrowserAgentTool,
  webBrowserAgentTool,
  buildWebBrowserSystemPrompt,
} from './web-browser/index.js';
export type {
  WebBrowserAgentConfig,
  WebBrowserTask,
  WebBrowserStep,
  WebBrowserResult,
  BrowserAction,
  WebBrowserAgentInput,
  WebBrowserPromptOptions,
} from './web-browser/index.js';


export {
  createStructuredOutputTool,
  structuredOutputTool,
  validateJsonSchema,
  validateJsonSchemaDefinition,
  generateSchemaDescription,
  mergeSchemas,
  StructuredOutputEnforcer,
  buildStructuredOutputSystemPrompt,
} from './structured-output/index.js';
export type {
  StructuredOutputInput,
  StructuredOutputResult,
  StructuredOutputToolOptions,
  SchemaDefinitionValidationResult,
  SchemaValidationResult,
  JsonSchema,
  StructuredOutputPromptOptions,
  EnforcerConfig,
  EnforceResult,
} from './structured-output/index.js';


export {
  EvalSuite,
  EvalRunner,
  createEvalTool,
  evalTool,
  exactMatchMetric,
  containsAllMetric,
  containsAnyMetric,
  tokenOverlapMetric,
  toolUsageMetric,
  jsonSchemaMetric,
} from './eval/index.js';
export type {
  EvalSuiteConfig,
  EvalCase,
  EvalMetric,
  EvalResult,
  EvalReport,
  EvalRunnerOptions,
  EvalToolInput,
  MetricFn,
  MetricConfig,
} from './eval/index.js';


export {
  PlanExecuteController,
  createPlanTool,
  planTool,
  createPlanStepTool,
  planStepTool,
  buildPlanExecuteSystemPrompt,
} from './plan-execute/index.js';
export type {
  PlanExecuteConfig,
  Plan,
  PlanStep,
  PlanStatus,
  StepStatus,
  ExecutionState,
  PlanReviewResult,
  PlanToolInput,
  PlanStepToolInput,
  PlanExecutePromptOptions,
} from './plan-execute/index.js';

// Re-export subpath modules for barrel discoverability.
// These subpaths are also available as direct imports (e.g. '@rdk-moss/agent/memory').
export { MemoryManager, selectMemoriesForContext } from './memory/index.js';
export type { MemoryEntry, MemorySearchResult } from './memory/index.js';
export { AgentMesh, createMeshTools, isMeshVerboseEnabled } from './mesh/index.js';
export type { MeshConfig, MeshPeer, MeshMessage } from './mesh/index.js';
export { createTeachingHooks, normalizeTeachingDepth } from './teaching/index.js';
export type { TeachingLayerParams, TeachingMetaV1 } from './teaching/index.js';
export { SkillLearner } from './skill-learning/index.js';
export type { LearnedSkill, SkillLearnerConfig } from './skill-learning/index.js';
