#!/usr/bin/env node
/**
 * SDK contract (v0.13 P1) — the public surface of dist/index.js is a
 * semver-protected contract. This snapshot makes any addition/removal a
 * deliberate decision: updating the list here is part of the change, not an
 * accident discovered downstream. Behavior locks cover the core embed entry
 * points. Breaking-change detector: remove an export from src/index.ts and
 * this spec goes red.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as sdk from '../dist/index.js';

const SNAPSHOT = [
  'BUILTIN_CONTEXT_PRESSURE_RULE',
  'BUILTIN_ERROR_RECOVERY_RULE',
  'BUILTIN_TOOL_LOOP_RULE',
  'BUILTIN_WEB_SEARCH_VARIATION_RULE',
  'COMPACTION_SUMMARY_PREFIX',
  'COMPACTION_SUMMARY_SUFFIX',
  'CONTEXT_WINDOW_HARD_MIN_TOKENS',
  'CONTEXT_WINDOW_WARN_BELOW_TOKENS',
  'CURRENT_SESSION_VERSION',
  'CommandQueueRegistry',
  'CompactHookRegistry',
  'DEFAULT_AGENT_ID',
  'DEFAULT_FOLLOW_UP_GUARD_CONFIG',
  'DEFAULT_MAIN_KEY',
  'DEFAULT_MODEL',
  'DEFAULT_STEERING_RULES',
  'ErrorCode',
  'FailoverError',
  'InMemoryMossAsyncTaskRegistry',
  'InMemorySessionStore',
  'JsonlSessionStore',
  'MINI_AGENT_EVENT_VERSION',
  'MOSS_DEFAULT_MAX_AGENT_TURNS',
  'MossAgent',
  'MossError',
  'PROVIDER_PRESETS',
  'PendingToolAbortStore',
  'PiAiLLMProvider',
  'SPAWN_TOOL_SCOPE_SETS',
  'SpawnProfileRegistry',
  'SshDeviceConnection',
  'SteeringEngine',
  'SubagentExpertRegistry',
  'TaskRuntime',
  'TextDeltaSmoother',
  'ToolHookRegistry',
  'ToolRegistry',
  'abortable',
  'acquireSessionWriteLock',
  'appendAcceptanceVerdict',
  'appendDeploymentRecord',
  'appendEvidenceRecord',
  'appendTaskEvent',
  'appendTaskRecord',
  'applyPatchTool',
  'backgroundExecTools',
  'bingSearch',
  'buildAgentBehaviorPrompt',
  'buildAgentBehaviorPromptQuick',
  'buildAgentMainSessionKey',
  'buildBackgroundCompletionSystemText',
  'buildCapabilityPromptLayer',
  'buildCompactionCheckpointOutline',
  'buildLanguagePolicyPrompt',
  'buildLanguagePolicyPromptQuick',
  'buildMossDefaultWorkflowPrompt',
  'buildRuntimeCapabilitiesPrompt',
  'buildSoftwareEngineeringPrompt',
  'buildSoftwareEngineeringPromptQuick',
  'buildSubagentPromptAddon',
  'buildTaskTimeline',
  'builtinTools',
  'canHostInjectToolWithEmptyInput',
  'classifyFailoverReason',
  'classifyFileKind',
  'classifyLlmError',
  'classifyProviderError',
  'classifyTaskKind',
  'codeDiagnosticsTool',
  'combineAbortSignals',
  'compactSubagentSummaryForParent',
  'configureDefaultDeviceTarget',
  'configureRootLogger',
  'containsSecrets',
  'convertMessagesToPi',
  'createAgentTurnRunner',
  'createBraveSearch',
  'createClientLlmSummarizationStrategy',
  'createCommandVerdictProvider',
  'createCompactionSummaryMessage',
  'createContractVerdictProvider',
  'createDraftTask',
  'createExecLikeFailureHintHook',
  'createHttpStreamFunction',
  'createInMemoryMossAsyncTaskRegistry',
  'createInlineThinkingRouter',
  'createLogger',
  'createMiniAgentStream',
  'createModelDefFromMossConfig',
  'createMossAgentLoopEventAdapter',
  'createProviderServerCompactionStrategy',
  'createReadOnlyHook',
  'createSecretSanitizerHook',
  'createSpawnProfileRegistryFromDefaults',
  'createStreamFunctionFromLlmProvider',
  'createSummarizeFnFromLlmProvider',
  'createTaskVerdictProvider',
  'createTimingHook',
  'createWebFetchTool',
  'createWebSearchTool',
  'describeError',
  'describeToolCall',
  'detectUnexecutedToolIntents',
  'deviceCamerasTool',
  'deviceDeployTool',
  'deviceExecTool',
  'deviceFileListTool',
  'deviceFileReadTool',
  'deviceFileWriteTool',
  'deviceInfoTool',
  'deviceNetworkTool',
  'deviceProcessesTool',
  'deviceResourcesTool',
  'deviceRoboticsStatusTool',
  'deviceTemperatureTool',
  'deviceTools',
  'disconnectAllDevices',
  'drainBackgroundCompletionReminders',
  'duckDuckGoLiteSearch',
  'duckDuckGoSearch',
  'emitAcceptanceLifecycle',
  'ensureBackgroundCompletionTracker',
  'ensureKeepAliveDispatcherInstalled',
  'envPreferMoss',
  'envTruthyUnlessZeroPreferMoss',
  'errorMessage',
  'evaluateAcceptance',
  'evaluateContextWindowGuard',
  'evaluateContractAcceptance',
  'evaluateExpectation',
  'evidenceTools',
  'execBackgroundTool',
  'execLogsTool',
  'execStopTool',
  'execTool',
  'extractThinkingTagBodies',
  'extractToolInvocationFromPlanText',
  'filterToolsForRun',
  'findLatestLiveTaskSnapshot',
  'findReplayableToolResultContent',
  'formatAcceptanceVerdict',
  'formatDeploymentRecord',
  'formatDeviceTarget',
  'formatMossError',
  'formatTaskTimeline',
  'getBackgroundProcessOutputTail',
  'getBackgroundProcessSnapshot',
  'getDefaultSpawnProfileRegistry',
  'getDeviceConnection',
  'getRootLogger',
  'getTaskStateSnapshot',
  'hasAtRefs',
  'hasPendingBackgroundCompletions',
  'hasToolResultAfterLastAssistant',
  'hashStableDynamicSystemPrompt',
  'hashSystemPromptForTelemetry',
  'hashSystemPromptLayers',
  'inferProviderFromBaseUrl',
  'isAuthError',
  'isCommandDangerous',
  'isConnectionError',
  'isContextOverflowError',
  'isFailoverError',
  'isFailoverErrorMessage',
  'isMossError',
  'isMossErrorRecoverable',
  'isPathProtected',
  'isRateLimitError',
  'isServerError',
  'isSubagentSessionKey',
  'isTaskSettled',
  'isTimeoutError',
  'isToolAssumedMutating',
  'isTransientError',
  'lastMessageNeedsToolFollowUp',
  'lastMessageNeedsToolFollowUpLlm',
  'listAcceptanceVerdicts',
  'listBackgroundProcessSnapshots',
  'listDeploymentRecords',
  'listDeviceConnections',
  'listDirectoryTool',
  'listEvidenceRecords',
  'listFailures',
  'listRepairs',
  'listTaskEvents',
  'listTaskRecords',
  'listTaskStateSnapshots',
  'loadTaskArtifacts',
  'markBackgroundCompletionReported',
  'matchTaskCapabilities',
  'matchTextApproval',
  'maybeSuppressRedundantWebFetchAfterOpenUrl',
  'moveFileTool',
  'normalizeAgentId',
  'normalizeMainKey',
  'normalizeProvider',
  'parseAgentSessionKey',
  'parseAtRefs',
  'parseEnvNumberPreferMoss',
  'parseProviderPreset',
  'parseUrlsFromOpenUrlToolResult',
  'planContextBudgetActions',
  'providerError',
  'providerErrorHint',
  'readFileTool',
  'recordEvidenceTool',
  'recordFailure',
  'recordRepair',
  'redactSensitive',
  'registerBuiltinTools',
  'registerPreToolHook',
  'registerProtectedPaths',
  'registerSpawnToolExtensions',
  'registerToolOutputLimits',
  'renderProviderErrorSurface',
  'replayTaskPhase',
  'resolveAgentIdFromSessionKey',
  'resolveContextWindowInfo',
  'resolveDefaultDeviceTarget',
  'resolveEffectiveCaps',
  'resolveMossMaxAgentTurns',
  'resolveRoutedModel',
  'resolveSessionKey',
  'resolveSpawnToolSet',
  'resolveToolFollowupBypassCap',
  'resumeTask',
  'retryAsync',
  'retryDelayForLlmError',
  'runAgentLoop',
  'runDeployment',
  'runPreToolHookChain',
  'runTask',
  'runWithProviderRetry',
  'sanitizeRawErrorForDetail',
  'sanitizeSecrets',
  'searchCodeTool',
  'searchFilesTool',
  'setOpenUrlMarkers',
  'shouldSuppressReasoningForToolFollowUpRound',
  'splitThinkingTagsFromAssistantText',
  'stopBackgroundProcess',
  'stripShellPrefixBeforeHeredoc',
  'subscribeBackgroundLifecycle',
  'subscribeBackgroundOutput',
  'summarizeEvidence',
  'summarizeTaskRun',
  'taskAcceptanceTool',
  'taskDefineTool',
  'taskTools',
  'throwMoss',
  'toAgentStoreSessionKey',
  'todoWriteTool',
  'totalPromptTokens',
  'truncateToolOutput',
  'tryAppendTaskEvent',
  'validateToolInputObject',
  'waitForBackgroundProcessesIdle',
  'wasConnectionReused',
  'webFetchTool',
  'webSearchTool',
  'wrapAsMoss',
  'wrapToolWithAbortSignal',
  'writeFileTool',
];

test('public surface matches the contract snapshot exactly', () => {
  const actual = Object.keys(sdk).sort();
  const added = actual.filter((n) => !SNAPSHOT.includes(n));
  const removed = SNAPSHOT.filter((n) => !actual.includes(n));
  assert.deepEqual(
    { added, removed },
    { added: [], removed: [] },
    'surface drifted — added: ' +
      added.join(',') +
      ' removed: ' +
      removed.join(',') +
      '. Adding an export is a minor bump; removing/renaming is a major bump. ' +
      'Update this snapshot deliberately as part of that change.'
  );
});

test('core embed entry points exist with expected kinds', () => {
  assert.equal(typeof sdk.MossAgent, 'function', 'MossAgent class');
  assert.equal(typeof sdk.runAgentLoop, 'function');
  assert.equal(typeof sdk.InMemorySessionStore, 'function');
  assert.equal(typeof sdk.createStreamFunctionFromLlmProvider, 'function');
  assert.equal(typeof sdk.resolveRoutedModel, 'function', 'v0.12 routing resolver');
});

test('builtinTools carries the core workspace tools with side-effect metadata', () => {
  const names = new Set(sdk.builtinTools.map((t) => t.name));
  for (const core of ['exec', 'read_file', 'write_file', 'apply_patch', 'todo_write'])
    assert.ok(names.has(core), core + ' in builtinTools');
  for (const tool of sdk.builtinTools)
    assert.ok(tool.metadata?.sideEffectClass, tool.name + ' declares sideEffectClass');
});

test('MossError surface behaves as the error contract', () => {
  const err = new sdk.MossError({ code: sdk.ErrorCode.TOOL_NOT_ALLOWED, message: 'nope' });
  assert.equal(sdk.isMossError(err), true);
  assert.equal(sdk.isMossError(new Error('plain')), false);
  assert.equal(typeof sdk.formatMossError(err), 'string');
});

test('typed API surface resolves through dist/index.d.ts', async () => {
  const ts = (await import('typescript')).default;
  const path = await import('node:path');
  const dtsPath = path.resolve('dist/index.d.ts');
  const program = ts.createProgram([dtsPath], { allowJs: false });
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(dtsPath);
  const moduleSymbol = checker.getSymbolAtLocation(source);
  const exported = new Set(checker.getExportsOfModule(moduleSymbol).map((s) => s.getName()));
  for (const symbol of [
    'MossAgent',
    'MossAgentConfig',
    'runAgentLoop',
    'MossError',
    'builtinTools',
    'ModelTiers',
    'resolveRoutedModel',
    'AgentHooks',
    'ChatOptions',
    'ChatResult',
  ])
    assert.ok(exported.has(symbol), symbol + ' exported from the typed API surface');
});

console.log('[PASS] SDK contract');
