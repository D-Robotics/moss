

import type { EventStream } from '../../provider/pi-ai-types.js';
import { getRootLogger } from '../../logger.js';
import { errorMessage } from '../../errors.js';

const log = getRootLogger().child('agent:loop');
import type { Message } from '../session/session-jsonl.js';
import { describeError } from '../../provider/errors.js';
import { classifyLlmError } from '../llm/llm-error-classifier.js';
import {
  ensureKeepAliveDispatcherInstalled,
  wasConnectionReused,
} from '../../provider/keep-alive-dispatcher.js';
import { resolveToolFollowupBypassCap } from '../../utils/max-agent-turns.js';
import { resolveContextCharsPerTokenUnit, estimatePromptUnitsForContextWindow } from '../../context/tokens.js';
import {
  createMiniAgentStream,
  type MiniAgentEvent,
  type MiniAgentResult,
} from '../subagent/agent-events.js';
import { bumpAgentLoopRunEpoch, guardMiniAgentStreamPush } from './agent-loop-push-guard.js';
import { PendingToolAbortStore } from './pending-tool-aborts.js';
import { getEffectiveContextWindowTokens } from '../../context/window-economics.js';
import { logLLMUsage } from '../../observability/llm-usage.js';
import { readEnv, readEnvFlag } from '../../utils/env-compat.js';
import {
  assessPromptCacheEligibility,
  isPromptPrefixDebugEnabled,
} from '../llm/prompt-prefix-cache.js';
import { createToolLoopGuardState } from '../tools/tool-loop-guard.js';
import type { AgentLoopHardCaps, AgentLoopParams } from './agent-loop-types.js';
import { createInitialLoopState, resetIterationState } from './agent-loop-state.js';
import type { SteeringContext } from './steering.js';
import { prepareTurnContext, shouldIncludeThinkingInBudget } from './agent-loop-context-prep.js';
import { executeLlmTurn } from './agent-loop-llm-call.js';
import { startSpan, turnAttributes } from '../../observability/tracing.js';
import { processLlmResponse } from './agent-loop-response.js';
import {
  buildBackgroundCompletionSystemText,
  ensureBackgroundCompletionTracker,
} from '../../tools/background-completion-reminder.js';
import { evaluateTodoNudge } from './todo-nudge.js';
import { evaluateVerifyNudge } from './verify-nudge.js';
import { evaluateSkillDiscoveryNudge } from './skill-discovery-nudge.js';
import { getActiveSkillPlan } from '../../skills/active-skill-plan.js';
import { evaluateRedVerifyNudge } from './red-verify-nudge.js';
import { evaluateFanOutNudge } from './fan-out-nudge.js';
import { evaluateAmbiguityNudge } from './ambiguity-nudge.js';
import { evaluateSkillLoadNudge } from './skill-load-nudge.js';
import { evaluateSubagentRunningNudge } from './subagent-running-nudge.js';
import { evaluateSubagentStoppedNudge } from './subagent-stopped-nudge.js';
import { evaluateMemoryWriteNudge } from './memory-write-nudge.js';
import { evaluateDeviceToolsNudge } from './device-tools-nudge.js';
import { evaluateBrowserVisionToolsNudge } from './browser-vision-tools-nudge.js';
import { evaluateWebToolsNudge } from './web-tools-nudge.js';
import { evaluatePlanToolsNudge } from './plan-tools-nudge.js';
import { evaluateGitToolsNudge } from './git-tools-nudge.js';
import { evaluateInstallToolsNudge } from './install-tools-nudge.js';
import { evaluateEvalToolsNudge } from './eval-tools-nudge.js';
import { evaluateCodegraphToolsNudge } from './codegraph-tools-nudge.js';
import { evaluateRunTestsToolsNudge } from './run-tests-tools-nudge.js';
import { evaluateBuildToolsNudge } from './build-tools-nudge.js';
import { evaluateBackgroundServerNudge } from './background-server-nudge.js';
import { evaluateDockerToolsNudge } from './docker-tools-nudge.js';
import { evaluatePublishDeployToolsNudge } from './publish-deploy-tools-nudge.js';
import { evaluateFormatToolsNudge } from './format-tools-nudge.js';
import { evaluateMigrateToolsNudge } from './migrate-tools-nudge.js';
import { evaluateCodegenToolsNudge } from './codegen-tools-nudge.js';
import { evaluateSeedToolsNudge } from './seed-tools-nudge.js';
import { evaluateE2eToolsNudge } from './e2e-tools-nudge.js';
import { evaluateCoverageToolsNudge } from './coverage-tools-nudge.js';
import { evaluateSnapshotToolsNudge } from './snapshot-tools-nudge.js';
import { evaluateAuditToolsNudge } from './audit-tools-nudge.js';
import { evaluateSmokeLoadToolsNudge } from './smoke-load-tools-nudge.js';
import { evaluateContractVisualToolsNudge } from './contract-visual-tools-nudge.js';
import { evaluateMutationFuzzToolsNudge } from './mutation-fuzz-tools-nudge.js';
import { evaluateLighthouseA11yToolsNudge } from './lighthouse-a11y-tools-nudge.js';
import { evaluateStorybookToolsNudge } from './storybook-tools-nudge.js';

const defaultPendingToolAborts = new PendingToolAbortStore();
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
} from './agent-loop-types.js';




const DEFAULT_TOOL_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_TOOL_HEARTBEAT_INTERVAL_MS = 30_000;


const HARD_CAP_MESSAGE_COUNT = 200;





const MAX_CONSECUTIVE_TURN_ERRORS = 2;

const MAX_OUTPUT_CONTINUATIONS = 3;

export function resolveEffectiveCaps(hardCaps?: AgentLoopHardCaps) {
  return {
    maxMessageCount:
      hardCaps?.maxMessageCount && hardCaps.maxMessageCount > 0
        ? hardCaps.maxMessageCount
        : HARD_CAP_MESSAGE_COUNT,
    maxTotalTokens:
      hardCaps?.maxTotalTokens && hardCaps.maxTotalTokens > 0
        ? hardCaps.maxTotalTokens
        : 0, 
    maxConsecutiveTurnErrors:
      hardCaps?.maxConsecutiveTurnErrors && hardCaps.maxConsecutiveTurnErrors > 0
        ? hardCaps.maxConsecutiveTurnErrors
        : MAX_CONSECUTIVE_TURN_ERRORS,
    maxOutputContinuations:
      hardCaps?.maxOutputContinuations && hardCaps.maxOutputContinuations > 0
        ? hardCaps.maxOutputContinuations
        : MAX_OUTPUT_CONTINUATIONS,
  };
}


export function lastMessageNeedsToolFollowUpLlm(messages: Message[]): boolean {
  const last = messages[messages.length - 1];
  if (!last || last.role !== 'user') return false;
  const c = last.content;
  if (!Array.isArray(c)) return false;
  return c.some(
    (b) => b && typeof b === 'object' && (b as { type?: string }).type === 'tool_result'
  );
}


function buildCorrectionMessage(systemText: string): Message {
  return {
    role: 'user',
    content: [{ type: 'text', text: systemText }],
    timestamp: Date.now(),
  };
}








export function correctionTextForTurnError(err: unknown): string {
  const message = errorMessage(err);
  if (
    /malformed tool call arguments|Unterminated string in JSON|Unexpected end of (?:JSON|input)/i.test(
      message
    )
  ) {
    return [
      '[System] Your last tool call was cut off mid-argument — its JSON was truncated,',
      'usually because the content (e.g. a whole file in one write_file) was too large for a',
      'single response. Do NOT repeat the same large call. Instead do it in smaller pieces:',
      'write a large file with an initial write_file holding only the first portion, then',
      'append the remainder with several smaller apply_patch calls.',
    ].join(' ');
  }
  return '[System] An internal error occurred processing the last response. Please re-state your last action concisely.';
}



export function runAgentLoop(
  params: AgentLoopParams
): EventStream<MiniAgentEvent, MiniAgentResult> {
  const stream = createMiniAgentStream();
  const pendingToolAborts = params.pendingToolAborts ?? defaultPendingToolAborts;

  
  
  void ensureKeepAliveDispatcherInstalled();

  (async () => {
    const {
      runId,
      sessionKey,
      currentMessages,
      systemPrompt,
      systemPromptParts,
      getToolsForRun,
      toolCtx,
      modelDef,
      streamFn,
      apiKey,
      temperature,
      topP,
      reasoning,
      maxLLMRetries,
      maxTurns,
      maxToolCalls,
      contextTokens,
      getSteeringMessages,
      getFollowUpMessages,
      appendMessage,
      prepareCompaction,
      abortSignal,
      maxOutputTokens: maxOutputTokensParam,
      pruningSettings,
      compactHooks,
      systemPromptMeta,
      platform,
      hardCaps,
      steeringEngine,
    } = params;

    const persistCurrentMessages = async (messages?: Message[]): Promise<void> => {
      if (params.replaceMessages) {
        await params.replaceMessages(sessionKey, messages ?? currentMessages);
      }
    };

    const runEpoch = bumpAgentLoopRunEpoch(sessionKey, params.runEpochStore);
    guardMiniAgentStreamPush(stream, sessionKey, runEpoch, params.runEpochStore);

    const parallelSafeTools = platform?.parallelSafeTools ?? new Set<string>();
    const toolTimeoutMs = platform?.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
    const toolHeartbeatIntervalMs =
      platform?.toolHeartbeatIntervalMs ?? DEFAULT_TOOL_HEARTBEAT_INTERVAL_MS;
    const skipHeartbeatToolNames = platform?.skipHeartbeatToolNames ?? new Set<string>();
    const loadToolsMetaName = platform?.loadToolsMetaName;

    const effectiveCaps = resolveEffectiveCaps(hardCaps);

    const state = createInitialLoopState();
    state.compactionSummary = params.compactionSummary;
    const toolFollowupBypassCap = resolveToolFollowupBypassCap(maxTurns);
    const prefixDebugEnabled = platform?.promptPrefixDebug ?? isPromptPrefixDebugEnabled();
    
    
    let previousPrefixSnapshot: Message[] | null = null;
    let previousToolNames: string[] | null = null;
    const promptCacheTelemetry = {
      prefixChecks: 0,
      prefixChanges: 0,
      toolOrderChecks: 0,
      toolOrderChanges: 0,
    };

    const runStartMs = Date.now();
    const INTER_TURN_SILENCE_WINDOW = 50;
    const toolLoopGuard = createToolLoopGuardState();

    
    
    const flushAssistantBuffer = async (buffer: Message[]): Promise<void> => {
      while (buffer.length > 0) {
        const msg = buffer[0]!;
        try {
          await appendMessage(sessionKey, msg);
        } catch (err) {
          // Persistence failed for this message. Log and skip it — don't
          // block the entire turn. Previously this threw out of the loop,
          // losing ALL remaining buffered messages (msg2+msg3 if msg1 failed).
          // The caller's finally-block catch logs the error but the messages
          // were already lost from the buffer. Now we skip the failed message
          // and continue flushing the rest, so a single I/O failure doesn't
          // lose the entire turn's assistant output.
          // (Found by moss self-iteration — glm-5.2 reviewed this function.)
          log.error('flush_assistant_message_failed', {
            error: describeError(err),
            remainingBuffer: buffer.length,
            sessionKey,
            messageRole: msg.role,
          });
          buffer.shift();
          continue;
        }
        currentMessages.push(msg);
        buffer.shift();
      }
    };
    
    const shouldRecordLlmUsage =
      platform?.recordLlmUsage ??
      (Boolean(readEnv('MOSS_LLM_USAGE_LOG')) || readEnvFlag('MOSS_LLM_USAGE'));
    
    const isQuiet = platform?.quiet ?? readEnvFlag('MOSS_QUIET');

    const recordLlmUsage = async (record: {
      runId: string;
      providerId: string;
      model: string;
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens?: number;
      cacheCreationTokens?: number;
      durationMs: number;
      success: boolean;
      error?: string;
    }): Promise<void> => {
      if (!shouldRecordLlmUsage) return;
      try {
        await logLLMUsage(record, { logPath: platform?.llmUsageLogPath });
      } catch (err) {
        log.warn('failed to record llm usage', {
          runId: record.runId,
          providerId: record.providerId,
          model: record.model,
          error: errorMessage(err),
        });
      }
    };

    const resolveToolsForRun = () => (getToolsForRun ? getToolsForRun() : params.toolsForRun);

    const evaluateSteering = (): Message[] => {
      if (!steeringEngine) return [];
      const maxOut = maxOutputTokensParam ?? modelDef.maxTokens ?? 8192;
      const effCtx = getEffectiveContextWindowTokens(contextTokens, maxOut);
      const charsPerUnit = resolveContextCharsPerTokenUnit();
      const steerCtx: SteeringContext = {
        
        messages: currentMessages as unknown as import('../llm/llm-provider.js').LLMMessage[],
        turn: state.turns,
        consecutiveToolErrors: state.toolExecutionMetrics.consecutiveToolErrors,
        totalToolCalls: state.toolExecutionMetrics.totalToolCalls,
        contextUsageRatio:
          effCtx > 0
            ? (() => {
                const estimated = estimatePromptUnitsForContextWindow({
                  messages: currentMessages,
                  systemPrompt,
                  charsPerTokenUnit: charsPerUnit,
                  effectiveContextWindowTokens: effCtx,
                  includeThinking: shouldIncludeThinkingInBudget(currentMessages, modelDef),
                });
                
                const floor = state.lastReportedPromptTokens > 0
                  ? Math.max(estimated, state.lastReportedPromptTokens)
                  : estimated;
                return floor / effCtx;
              })()
            : 0,
        sessionKey,
      };
      const result = steeringEngine.evaluate(steerCtx);
      if (!result.triggered) return [];
      return result.guidances.map((g) => ({
        role: 'user' as const,
        content: [{ type: 'text' as const, text: g }],
        timestamp: Date.now(),
      }));
    };

    try {
      // Grok TaskCompletionReminder parity: ensure lifecycle events queue
      // model-visible completions for background exec (coding UX).
      ensureBackgroundCompletionTracker();

      for (const syn of pendingToolAborts.consumeSyntheticMessages(sessionKey)) {
        await appendMessage(sessionKey, syn);
        currentMessages.push(syn);
      }

      const charsPerUnit = resolveContextCharsPerTokenUnit();
      // Do not evaluate steering before the first turn. At run start the model
      // has done no work yet, so any steering guidance (e.g. "context is X%
      // full, be concise") would fire on baseline system-prompt size and force
      // an extra turn before the model even answers — the mirror image of the
      // post-end_turn steering we removed in processLlmResponse. Steering is
      // evaluated on the tool-execution path, where in-progress patterns
      // (consecutive errors, tool loops, repeated searches) are detectable.
      state.pendingMessages = [];

      const injectBackgroundCompletions = (): Message | null => {
        const text = buildBackgroundCompletionSystemText();
        if (!text) return null;
        return buildCorrectionMessage(text);
      };

      const lastUserTextForNudge = (): string => {
        for (let i = currentMessages.length - 1; i >= 0; i--) {
          const m = currentMessages[i];
          if (!m || m.role !== 'user') continue;
          if (typeof m.content === 'string') {
            if (m.content.startsWith('[System]')) continue;
            return m.content;
          }
          if (Array.isArray(m.content)) {
            const text = m.content
              .filter(
                (b): b is { type: 'text'; text: string } =>
                  !!b && typeof b === 'object' && (b as { type?: string }).type === 'text' &&
                  typeof (b as { text?: string }).text === 'string',
              )
              .map((b) => b.text)
              .join('\n');
            if (text.startsWith('[System]')) continue;
            if (!text.trim()) continue;
            return text;
          }
        }
        return '';
      };

      const injectTodoNudge = (): Message | null => {
        const decision = evaluateTodoNudge({
          turns: state.turns,
          totalToolCalls: state.toolExecutionMetrics.totalToolCalls,
          toolCallsByName: state.toolExecutionMetrics.toolCallsByName,
          userText: lastUserTextForNudge(),
          attempts: state.todoNudgeAttempts,
        });
        if (!decision.fire) return null;
        state.todoNudgeAttempts += 1;
        return buildCorrectionMessage(decision.correction);
      };

      const injectVerifyNudge = (): Message | null => {
        const decision = evaluateVerifyNudge({
          turns: state.turns,
          totalToolCalls: state.toolExecutionMetrics.totalToolCalls,
          toolCallsByName: state.toolExecutionMetrics.toolCallsByName,
          userText: lastUserTextForNudge(),
          attempts: state.verifyNudgeAttempts,
        });
        if (!decision.fire) return null;
        state.verifyNudgeAttempts += 1;
        return buildCorrectionMessage(decision.correction);
      };

      const injectSkillDiscoveryNudge = (): Message | null => {
        const activeSkillNames = new Set(
          (getActiveSkillPlan(toolCtx.sessionKey)?.skills ?? []).flatMap((skill) => [
            skill.name.toLowerCase(),
            skill.stableId.toLowerCase(),
          ]),
        );
        const decision = evaluateSkillDiscoveryNudge({
          messages: currentMessages,
          workspaceDir: toolCtx.workspaceDir,
          attempts: state.skillDiscoveryNudgeAttempts,
          reportedNames: state.skillDiscoveryReportedNames,
          activeSkillNames,
        });
        if (!decision.fire) return null;
        state.skillDiscoveryNudgeAttempts += 1;
        for (const name of decision.names) {
          state.skillDiscoveryReportedNames.add(name);
        }
        return buildCorrectionMessage(decision.correction);
      };

      const injectRedVerifyNudge = (): Message | null => {
        const decision = evaluateRedVerifyNudge({
          messages: currentMessages,
          attempts: state.redVerifyNudgeAttempts,
        });
        if (decision.resetAttempts) {
          state.redVerifyNudgeAttempts = 0;
        }
        if (!decision.fire) return null;
        state.redVerifyNudgeAttempts += 1;
        return buildCorrectionMessage(decision.correction);
      };

      const injectFanOutNudge = (): Message | null => {
        const decision = evaluateFanOutNudge({
          messages: currentMessages,
          attempts: state.fanOutNudgeAttempts,
          userText: lastUserTextForNudge(),
          toolCallsByName: state.toolExecutionMetrics.toolCallsByName,
        });
        if (!decision.fire) return null;
        state.fanOutNudgeAttempts += 1;
        return buildCorrectionMessage(decision.correction);
      };

      const injectAmbiguityNudge = (): Message | null => {
        const decision = evaluateAmbiguityNudge({
          toolCallsByName: state.toolExecutionMetrics.toolCallsByName,
          userText: lastUserTextForNudge(),
          attempts: state.ambiguityNudgeAttempts,
        });
        if (!decision.fire) return null;
        state.ambiguityNudgeAttempts += 1;
        return buildCorrectionMessage(decision.correction);
      };

      const injectSkillLoadNudge = (): Message | null => {
        const decision = evaluateSkillLoadNudge({
          toolCallsByName: state.toolExecutionMetrics.toolCallsByName,
          attempts: state.skillLoadNudgeAttempts,
        });
        if (!decision.fire) return null;
        state.skillLoadNudgeAttempts += 1;
        return buildCorrectionMessage(decision.correction);
      };

      const injectSubagentRunningNudge = (): Message | null => {
        const decision = evaluateSubagentRunningNudge({
          messages: currentMessages,
          attempts: state.subagentRunningNudgeAttempts,
        });
        if (!decision.fire) return null;
        state.subagentRunningNudgeAttempts += 1;
        return buildCorrectionMessage(decision.correction);
      };

      const injectSubagentStoppedNudge = (): Message | null => {
        const decision = evaluateSubagentStoppedNudge({
          messages: currentMessages,
          toolCallsByName: state.toolExecutionMetrics.toolCallsByName,
          attempts: state.subagentStoppedNudgeAttempts,
        });
        if (!decision.fire) return null;
        state.subagentStoppedNudgeAttempts += 1;
        return buildCorrectionMessage(decision.correction);
      };

      const injectMemoryWriteNudge = (): Message | null => {
        const decision = evaluateMemoryWriteNudge({
          userText: lastUserTextForNudge(),
          toolCallsByName: state.toolExecutionMetrics.toolCallsByName,
          totalToolCalls: state.toolExecutionMetrics.totalToolCalls,
          attempts: state.memoryWriteNudgeAttempts,
        });
        if (!decision.fire) return null;
        state.memoryWriteNudgeAttempts += 1;
        return buildCorrectionMessage(decision.correction);
      };

      const injectDeviceToolsNudge = (): Message | null => {
        const decision = evaluateDeviceToolsNudge({
          userText: lastUserTextForNudge(),
          toolCallsByName: state.toolExecutionMetrics.toolCallsByName,
          totalToolCalls: state.toolExecutionMetrics.totalToolCalls,
          attempts: state.deviceToolsNudgeAttempts,
        });
        if (!decision.fire) return null;
        state.deviceToolsNudgeAttempts += 1;
        return buildCorrectionMessage(decision.correction);
      };

      const injectBrowserVisionToolsNudge = (): Message | null => {
        const decision = evaluateBrowserVisionToolsNudge({
          userText: lastUserTextForNudge(),
          toolCallsByName: state.toolExecutionMetrics.toolCallsByName,
          totalToolCalls: state.toolExecutionMetrics.totalToolCalls,
          attempts: state.browserVisionToolsNudgeAttempts,
        });
        if (!decision.fire) return null;
        state.browserVisionToolsNudgeAttempts += 1;
        return buildCorrectionMessage(decision.correction);
      };

      const injectWebToolsNudge = (): Message | null => {
        const decision = evaluateWebToolsNudge({
          userText: lastUserTextForNudge(),
          toolCallsByName: state.toolExecutionMetrics.toolCallsByName,
          totalToolCalls: state.toolExecutionMetrics.totalToolCalls,
          attempts: state.webToolsNudgeAttempts,
        });
        if (!decision.fire) return null;
        state.webToolsNudgeAttempts += 1;
        return buildCorrectionMessage(decision.correction);
      };

      const injectPlanToolsNudge = (): Message | null => {
        const decision = evaluatePlanToolsNudge({
          userText: lastUserTextForNudge(),
          toolCallsByName: state.toolExecutionMetrics.toolCallsByName,
          totalToolCalls: state.toolExecutionMetrics.totalToolCalls,
          attempts: state.planToolsNudgeAttempts,
        });
        if (!decision.fire) return null;
        state.planToolsNudgeAttempts += 1;
        return buildCorrectionMessage(decision.correction);
      };

      const injectGitToolsNudge = (): Message | null => {
        const decision = evaluateGitToolsNudge({
          userText: lastUserTextForNudge(),
          toolCallsByName: state.toolExecutionMetrics.toolCallsByName,
          messages: currentMessages,
          totalToolCalls: state.toolExecutionMetrics.totalToolCalls,
          attempts: state.gitToolsNudgeAttempts,
        });
        if (!decision.fire) return null;
        state.gitToolsNudgeAttempts += 1;
        return buildCorrectionMessage(decision.correction);
      };

      const injectInstallToolsNudge = (): Message | null => {
        const decision = evaluateInstallToolsNudge({
          userText: lastUserTextForNudge(),
          toolCallsByName: state.toolExecutionMetrics.toolCallsByName,
          messages: currentMessages,
          totalToolCalls: state.toolExecutionMetrics.totalToolCalls,
          attempts: state.installToolsNudgeAttempts,
        });
        if (!decision.fire) return null;
        state.installToolsNudgeAttempts += 1;
        return buildCorrectionMessage(decision.correction);
      };

      const injectEvalToolsNudge = (): Message | null => {
        const decision = evaluateEvalToolsNudge({
          userText: lastUserTextForNudge(),
          toolCallsByName: state.toolExecutionMetrics.toolCallsByName,
          totalToolCalls: state.toolExecutionMetrics.totalToolCalls,
          attempts: state.evalToolsNudgeAttempts,
        });
        if (!decision.fire) return null;
        state.evalToolsNudgeAttempts += 1;
        return buildCorrectionMessage(decision.correction);
      };

      const injectCodegraphToolsNudge = (): Message | null => {
        const decision = evaluateCodegraphToolsNudge({
          userText: lastUserTextForNudge(),
          toolCallsByName: state.toolExecutionMetrics.toolCallsByName,
          totalToolCalls: state.toolExecutionMetrics.totalToolCalls,
          attempts: state.codegraphToolsNudgeAttempts,
        });
        if (!decision.fire) return null;
        state.codegraphToolsNudgeAttempts += 1;
        return buildCorrectionMessage(decision.correction);
      };

      const injectRunTestsToolsNudge = (): Message | null => {
        const decision = evaluateRunTestsToolsNudge({
          userText: lastUserTextForNudge(),
          toolCallsByName: state.toolExecutionMetrics.toolCallsByName,
          messages: currentMessages,
          totalToolCalls: state.toolExecutionMetrics.totalToolCalls,
          attempts: state.runTestsToolsNudgeAttempts,
        });
        if (!decision.fire) return null;
        state.runTestsToolsNudgeAttempts += 1;
        return buildCorrectionMessage(decision.correction);
      };

      const injectBuildToolsNudge = (): Message | null => {
        const decision = evaluateBuildToolsNudge({
          userText: lastUserTextForNudge(),
          toolCallsByName: state.toolExecutionMetrics.toolCallsByName,
          messages: currentMessages,
          totalToolCalls: state.toolExecutionMetrics.totalToolCalls,
          attempts: state.buildToolsNudgeAttempts,
        });
        if (!decision.fire) return null;
        state.buildToolsNudgeAttempts += 1;
        return buildCorrectionMessage(decision.correction);
      };

      const injectBackgroundServerNudge = (): Message | null => {
        const decision = evaluateBackgroundServerNudge({
          userText: lastUserTextForNudge(),
          toolCallsByName: state.toolExecutionMetrics.toolCallsByName,
          messages: currentMessages,
          totalToolCalls: state.toolExecutionMetrics.totalToolCalls,
          attempts: state.backgroundServerNudgeAttempts,
        });
        if (!decision.fire) return null;
        state.backgroundServerNudgeAttempts += 1;
        return buildCorrectionMessage(decision.correction);
      };

      const injectDockerToolsNudge = (): Message | null => {
        const decision = evaluateDockerToolsNudge({
          userText: lastUserTextForNudge(),
          toolCallsByName: state.toolExecutionMetrics.toolCallsByName,
          messages: currentMessages,
          totalToolCalls: state.toolExecutionMetrics.totalToolCalls,
          attempts: state.dockerToolsNudgeAttempts,
        });
        if (!decision.fire) return null;
        state.dockerToolsNudgeAttempts += 1;
        return buildCorrectionMessage(decision.correction);
      };

      const injectPublishDeployToolsNudge = (): Message | null => {
        const decision = evaluatePublishDeployToolsNudge({
          userText: lastUserTextForNudge(),
          toolCallsByName: state.toolExecutionMetrics.toolCallsByName,
          messages: currentMessages,
          totalToolCalls: state.toolExecutionMetrics.totalToolCalls,
          attempts: state.publishDeployToolsNudgeAttempts,
        });
        if (!decision.fire) return null;
        state.publishDeployToolsNudgeAttempts += 1;
        return buildCorrectionMessage(decision.correction);
      };

      const injectFormatToolsNudge = (): Message | null => {
        const decision = evaluateFormatToolsNudge({
          userText: lastUserTextForNudge(),
          toolCallsByName: state.toolExecutionMetrics.toolCallsByName,
          messages: currentMessages,
          totalToolCalls: state.toolExecutionMetrics.totalToolCalls,
          attempts: state.formatToolsNudgeAttempts,
        });
        if (!decision.fire) return null;
        state.formatToolsNudgeAttempts += 1;
        return buildCorrectionMessage(decision.correction);
      };

      const injectMigrateToolsNudge = (): Message | null => {
        const decision = evaluateMigrateToolsNudge({
          userText: lastUserTextForNudge(),
          toolCallsByName: state.toolExecutionMetrics.toolCallsByName,
          messages: currentMessages,
          totalToolCalls: state.toolExecutionMetrics.totalToolCalls,
          attempts: state.migrateToolsNudgeAttempts,
        });
        if (!decision.fire) return null;
        state.migrateToolsNudgeAttempts += 1;
        return buildCorrectionMessage(decision.correction);
      };

      const injectCodegenToolsNudge = (): Message | null => {
        const decision = evaluateCodegenToolsNudge({
          userText: lastUserTextForNudge(),
          toolCallsByName: state.toolExecutionMetrics.toolCallsByName,
          messages: currentMessages,
          totalToolCalls: state.toolExecutionMetrics.totalToolCalls,
          attempts: state.codegenToolsNudgeAttempts,
        });
        if (!decision.fire) return null;
        state.codegenToolsNudgeAttempts += 1;
        return buildCorrectionMessage(decision.correction);
      };

      const injectSeedToolsNudge = (): Message | null => {
        const decision = evaluateSeedToolsNudge({
          userText: lastUserTextForNudge(),
          toolCallsByName: state.toolExecutionMetrics.toolCallsByName,
          messages: currentMessages,
          totalToolCalls: state.toolExecutionMetrics.totalToolCalls,
          attempts: state.seedToolsNudgeAttempts,
        });
        if (!decision.fire) return null;
        state.seedToolsNudgeAttempts += 1;
        return buildCorrectionMessage(decision.correction);
      };

      const injectE2eToolsNudge = (): Message | null => {
        const decision = evaluateE2eToolsNudge({
          userText: lastUserTextForNudge(),
          toolCallsByName: state.toolExecutionMetrics.toolCallsByName,
          messages: currentMessages,
          totalToolCalls: state.toolExecutionMetrics.totalToolCalls,
          attempts: state.e2eToolsNudgeAttempts,
        });
        if (!decision.fire) return null;
        state.e2eToolsNudgeAttempts += 1;
        return buildCorrectionMessage(decision.correction);
      };

      const injectCoverageToolsNudge = (): Message | null => {
        const decision = evaluateCoverageToolsNudge({
          userText: lastUserTextForNudge(),
          toolCallsByName: state.toolExecutionMetrics.toolCallsByName,
          messages: currentMessages,
          totalToolCalls: state.toolExecutionMetrics.totalToolCalls,
          attempts: state.coverageToolsNudgeAttempts,
        });
        if (!decision.fire) return null;
        state.coverageToolsNudgeAttempts += 1;
        return buildCorrectionMessage(decision.correction);
      };

      const injectSnapshotToolsNudge = (): Message | null => {
        const decision = evaluateSnapshotToolsNudge({
          userText: lastUserTextForNudge(),
          toolCallsByName: state.toolExecutionMetrics.toolCallsByName,
          messages: currentMessages,
          totalToolCalls: state.toolExecutionMetrics.totalToolCalls,
          attempts: state.snapshotToolsNudgeAttempts,
        });
        if (!decision.fire) return null;
        state.snapshotToolsNudgeAttempts += 1;
        return buildCorrectionMessage(decision.correction);
      };

      const injectAuditToolsNudge = (): Message | null => {
        const decision = evaluateAuditToolsNudge({
          userText: lastUserTextForNudge(),
          toolCallsByName: state.toolExecutionMetrics.toolCallsByName,
          messages: currentMessages,
          totalToolCalls: state.toolExecutionMetrics.totalToolCalls,
          attempts: state.auditToolsNudgeAttempts,
        });
        if (!decision.fire) return null;
        state.auditToolsNudgeAttempts += 1;
        return buildCorrectionMessage(decision.correction);
      };

      const injectSmokeLoadToolsNudge = (): Message | null => {
        const decision = evaluateSmokeLoadToolsNudge({
          userText: lastUserTextForNudge(),
          toolCallsByName: state.toolExecutionMetrics.toolCallsByName,
          messages: currentMessages,
          totalToolCalls: state.toolExecutionMetrics.totalToolCalls,
          attempts: state.smokeLoadToolsNudgeAttempts,
        });
        if (!decision.fire) return null;
        state.smokeLoadToolsNudgeAttempts += 1;
        return buildCorrectionMessage(decision.correction);
      };

      const injectContractVisualToolsNudge = (): Message | null => {
        const decision = evaluateContractVisualToolsNudge({
          userText: lastUserTextForNudge(),
          toolCallsByName: state.toolExecutionMetrics.toolCallsByName,
          messages: currentMessages,
          totalToolCalls: state.toolExecutionMetrics.totalToolCalls,
          attempts: state.contractVisualToolsNudgeAttempts,
        });
        if (!decision.fire) return null;
        state.contractVisualToolsNudgeAttempts += 1;
        return buildCorrectionMessage(decision.correction);
      };

      const injectMutationFuzzToolsNudge = (): Message | null => {
        const decision = evaluateMutationFuzzToolsNudge({
          userText: lastUserTextForNudge(),
          toolCallsByName: state.toolExecutionMetrics.toolCallsByName,
          messages: currentMessages,
          totalToolCalls: state.toolExecutionMetrics.totalToolCalls,
          attempts: state.mutationFuzzToolsNudgeAttempts,
        });
        if (!decision.fire) return null;
        state.mutationFuzzToolsNudgeAttempts += 1;
        return buildCorrectionMessage(decision.correction);
      };

      const injectLighthouseA11yToolsNudge = (): Message | null => {
        const decision = evaluateLighthouseA11yToolsNudge({
          userText: lastUserTextForNudge(),
          toolCallsByName: state.toolExecutionMetrics.toolCallsByName,
          messages: currentMessages,
          totalToolCalls: state.toolExecutionMetrics.totalToolCalls,
          attempts: state.lighthouseA11yToolsNudgeAttempts,
        });
        if (!decision.fire) return null;
        state.lighthouseA11yToolsNudgeAttempts += 1;
        return buildCorrectionMessage(decision.correction);
      };

      const injectStorybookToolsNudge = (): Message | null => {
        const decision = evaluateStorybookToolsNudge({
          userText: lastUserTextForNudge(),
          toolCallsByName: state.toolExecutionMetrics.toolCallsByName,
          messages: currentMessages,
          totalToolCalls: state.toolExecutionMetrics.totalToolCalls,
          attempts: state.storybookToolsNudgeAttempts,
        });
        if (!decision.fire) return null;
        state.storybookToolsNudgeAttempts += 1;
        return buildCorrectionMessage(decision.correction);
      };

      outerLoop: while (true) {
        resetIterationState(state);




        const turnAssistantBuffer: Message[] = [];
        while (state.hasMoreToolCalls || state.pendingMessages.length > 0) {
          // Drain finished background processes before the next LLM call so
          // the model sees exit codes / output without polling exec_logs.
          const bgDone = injectBackgroundCompletions();
          if (bgDone) state.pendingMessages.push(bgDone);

          // Soft multi-step plan reminder (Grok TodoNudge light) — after tools
          // have already run so we only fire on real multi-tool coding work.
          const todoNudge = injectTodoNudge();
          if (todoNudge) state.pendingMessages.push(todoNudge);

          // Soft mid-run verification reminder after several edits with no tests.
          const verifyNudge = injectVerifyNudge();
          if (verifyNudge) state.pendingMessages.push(verifyNudge);

          // After a red verification result, force fix-then-rerun (VerifyNudge
          // alone is silenced once any verify tool has been called).
          const redVerify = injectRedVerifyNudge();
          if (redVerify) state.pendingMessages.push(redVerify);

          // After failed fan_out / create_subagent children, merge or re-run
          // before more unrelated work (pairs with end-of-turn FanOutMergeGate).
          const fanOutNudge = injectFanOutNudge();
          if (fanOutNudge) state.pendingMessages.push(fanOutNudge);

          // Multi-interpretation coding + edits without clarify/assumption.
          const ambiguityNudge = injectAmbiguityNudge();
          if (ambiguityNudge) state.pendingMessages.push(ambiguityNudge);

          // Installed a skill but have not load_skill yet this turn.
          const skillLoadNudge = injectSkillLoadNudge();
          if (skillLoadNudge) state.pendingMessages.push(skillLoadNudge);

          // Background create_subagent still STARTED without terminal status.
          const subagentRunningNudge = injectSubagentRunningNudge();
          if (subagentRunningNudge) state.pendingMessages.push(subagentRunningNudge);

          // subagent_stop is not a successful fix — remind before claiming done.
          const subagentStoppedNudge = injectSubagentStoppedNudge();
          if (subagentStoppedNudge) state.pendingMessages.push(subagentStoppedNudge);

          // User asked to remember but memory_write not called yet.
          const memoryWriteNudge = injectMemoryWriteNudge();
          if (memoryWriteNudge) state.pendingMessages.push(memoryWriteNudge);

          // Board/ROS asked but no device_* tools yet.
          const deviceToolsNudge = injectDeviceToolsNudge();
          if (deviceToolsNudge) state.pendingMessages.push(deviceToolsNudge);

          // Browser/vision asked but matching tools not used yet.
          const browserVisionToolsNudge = injectBrowserVisionToolsNudge();
          if (browserVisionToolsNudge) state.pendingMessages.push(browserVisionToolsNudge);

          // Online research asked but no web_search/web_fetch yet.
          const webToolsNudge = injectWebToolsNudge();
          if (webToolsNudge) state.pendingMessages.push(webToolsNudge);

          // Multi-step plan asked but no plan/plan_step yet (todo_write skips).
          const planToolsNudge = injectPlanToolsNudge();
          if (planToolsNudge) state.pendingMessages.push(planToolsNudge);

          // Commit/push asked but no git/gh exec yet.
          const gitToolsNudge = injectGitToolsNudge();
          if (gitToolsNudge) state.pendingMessages.push(gitToolsNudge);

          // Install deps asked but no package-manager install exec yet.
          const installToolsNudge = injectInstallToolsNudge();
          if (installToolsNudge) state.pendingMessages.push(installToolsNudge);

          // Eval/benchmark suite asked but eval tool not used yet.
          const evalToolsNudge = injectEvalToolsNudge();
          if (evalToolsNudge) state.pendingMessages.push(evalToolsNudge);

          // Callers/callees/call graph asked but no codegraph_* yet.
          const codegraphToolsNudge = injectCodegraphToolsNudge();
          if (codegraphToolsNudge) state.pendingMessages.push(codegraphToolsNudge);

          // User explicitly asked to run tests but no verify tools yet.
          const runTestsToolsNudge = injectRunTestsToolsNudge();
          if (runTestsToolsNudge) state.pendingMessages.push(runTestsToolsNudge);

          // User asked to build/compile but no build-shaped exec yet.
          const buildToolsNudge = injectBuildToolsNudge();
          if (buildToolsNudge) state.pendingMessages.push(buildToolsNudge);

          // Dev server/watcher start asked but no exec_background yet.
          const backgroundServerNudge = injectBackgroundServerNudge();
          if (backgroundServerNudge) state.pendingMessages.push(backgroundServerNudge);

          // Docker/container work asked but no docker exec yet.
          const dockerToolsNudge = injectDockerToolsNudge();
          if (dockerToolsNudge) state.pendingMessages.push(dockerToolsNudge);

          // Publish/deploy asked but no matching exec yet.
          const publishDeployToolsNudge = injectPublishDeployToolsNudge();
          if (publishDeployToolsNudge) state.pendingMessages.push(publishDeployToolsNudge);

          // Format asked but no prettier/eslint --fix yet.
          const formatToolsNudge = injectFormatToolsNudge();
          if (formatToolsNudge) state.pendingMessages.push(formatToolsNudge);

          // Migrate asked but no migrate-shaped exec yet.
          const migrateToolsNudge = injectMigrateToolsNudge();
          if (migrateToolsNudge) state.pendingMessages.push(migrateToolsNudge);

          // Codegen asked but no generate-shaped exec yet.
          const codegenToolsNudge = injectCodegenToolsNudge();
          if (codegenToolsNudge) state.pendingMessages.push(codegenToolsNudge);

          // Seed asked but no seed-shaped exec yet.
          const seedToolsNudge = injectSeedToolsNudge();
          if (seedToolsNudge) state.pendingMessages.push(seedToolsNudge);

          // E2E/playwright/cypress asked but no matching suite yet.
          const e2eToolsNudge = injectE2eToolsNudge();
          if (e2eToolsNudge) state.pendingMessages.push(e2eToolsNudge);

          // Coverage asked but no coverage-shaped exec yet.
          const coverageToolsNudge = injectCoverageToolsNudge();
          if (coverageToolsNudge) state.pendingMessages.push(coverageToolsNudge);

          // Snapshot update asked but no -u / --updateSnapshot yet.
          const snapshotToolsNudge = injectSnapshotToolsNudge();
          if (snapshotToolsNudge) state.pendingMessages.push(snapshotToolsNudge);

          // Security audit asked but no audit-shaped exec yet.
          const auditToolsNudge = injectAuditToolsNudge();
          if (auditToolsNudge) state.pendingMessages.push(auditToolsNudge);

          // Smoke/load/perf asked but no matching suite yet.
          const smokeLoadToolsNudge = injectSmokeLoadToolsNudge();
          if (smokeLoadToolsNudge) state.pendingMessages.push(smokeLoadToolsNudge);

          // Contract/visual regression asked but no matching suite yet.
          const contractVisualToolsNudge = injectContractVisualToolsNudge();
          if (contractVisualToolsNudge) state.pendingMessages.push(contractVisualToolsNudge);

          // Mutation/fuzz asked but no matching suite yet.
          const mutationFuzzToolsNudge = injectMutationFuzzToolsNudge();
          if (mutationFuzzToolsNudge) state.pendingMessages.push(mutationFuzzToolsNudge);

          // Lighthouse/a11y asked but no matching audit yet.
          const lighthouseA11yToolsNudge = injectLighthouseA11yToolsNudge();
          if (lighthouseA11yToolsNudge) state.pendingMessages.push(lighthouseA11yToolsNudge);

          // Storybook asked but no storybook-shaped exec yet.
          const storybookToolsNudge = injectStorybookToolsNudge();
          if (storybookToolsNudge) state.pendingMessages.push(storybookToolsNudge);

          // Grok-style path skill discovery after exploring files/dirs.
          const skillDiscovery = injectSkillDiscoveryNudge();
          if (skillDiscovery) state.pendingMessages.push(skillDiscovery);

          if (getSteeringMessages) {
            const steeringMessages = await getSteeringMessages();
            if (steeringMessages.length > 0) state.pendingMessages.push(...steeringMessages);
          }
          if (state.turns >= maxTurns) {
            const needsToolFollow = lastMessageNeedsToolFollowUpLlm(currentMessages);
            if (needsToolFollow && state.postLimitToolFollowUpsUsed < toolFollowupBypassCap) {
              state.postLimitToolFollowUpsUsed += 1;
            } else {
              stream.push({
                type: 'turn_transition',
                turn: state.turns,
                reason: needsToolFollow ? 'tool_followup_cap_reached' : 'max_turns_reached',
              });
              break outerLoop;
            }
          }
          if (abortSignal.aborted) {
            stream.push({ type: 'turn_transition', turn: state.turns, reason: 'aborted_by_user' });
            break outerLoop;
          }

          state.turns++;
          
          if (state.lastTurnEndMs !== null) {
            const silence = Date.now() - state.lastTurnEndMs;
            state.interTurnSilenceMs.push(silence);
            if (state.interTurnSilenceMs.length > INTER_TURN_SILENCE_WINDOW) {
              state.interTurnSilenceMs.shift(); 
            }
          }
          stream.push({ type: 'turn_start', turn: state.turns });

          if (state.pendingMessages.length > 0) {
            for (const msg of state.pendingMessages) {
              await appendMessage(sessionKey, msg);
              currentMessages.push(msg);
            }
            state.pendingMessages = [];
          }

          const maxOut = maxOutputTokensParam ?? modelDef.maxTokens ?? 8192;
          const effectiveContextTokens = getEffectiveContextWindowTokens(contextTokens, maxOut);

          
          
          
          
          let turnToolCalls: { id: string; name: string; input: Record<string, unknown> }[] = [];
          // Open a turn span covering this iteration's LLM + tool work.
          // runInSpanContext() activates it around executeLlmTurn/processLlmResponse
          // so child spans (moss.llm.request, moss.tool.invoke) nest under it.
          // The finally ends the span on every exit: continue, break, throw.
          const turnSpan = startSpan('moss.agent.turn', turnAttributes(runId, state.turns, String(modelDef.id)));
          try {
            
            const ctxResult = await prepareTurnContext({
              state,
              currentMessages,
              systemPrompt,
              systemPromptParts,
              effectiveContextTokens,
              charsPerUnit,
              modelDef,
              getToolsForRun: resolveToolsForRun,
              sessionKey,
              runId,
              prepareCompaction,
              compactHooks,
              persistCurrentMessages,
              push: (e) => stream.push(e),
              abortSignal,
              pruningSettings,
              hardCapMessageCount: effectiveCaps.maxMessageCount,
              hardCapTotalTokens: effectiveCaps.maxTotalTokens,
              previousPrefixSnapshot,
              previousToolNames,
              prefixDebugEnabled,
            });

            
            previousPrefixSnapshot = ctxResult.updatedSnapshots.previousPrefixSnapshot;
            previousToolNames = ctxResult.updatedSnapshots.previousToolNames;
            promptCacheTelemetry.prefixChecks += ctxResult.promptCacheTelemetry.prefixChecks;
            promptCacheTelemetry.prefixChanges += ctxResult.promptCacheTelemetry.prefixChanges;
            promptCacheTelemetry.toolOrderChecks += ctxResult.promptCacheTelemetry.toolOrderChecks;
            promptCacheTelemetry.toolOrderChanges +=
              ctxResult.promptCacheTelemetry.toolOrderChanges;

            if (ctxResult.control === 'break') break;
            if (ctxResult.control === 'retry') {
              state.compactionRetries++;
              state.turns--;
              continue;
            }

            
            const llmResult = await turnSpan.runInSpanContext(() => executeLlmTurn({
              state,
              modelDef,
              piContext: ctxResult.piContext,
              streamFn,
              apiKey,
              temperature,
              reasoning,
              maxLLMRetries,
              topP,
              abortSignal,
              messagesForModel: ctxResult.messagesForModel,
              toolsForRun: ctxResult.toolsForRun,
              sessionKey,
              runId,
              runStartMs,
              push: (e) => stream.push(e),
              currentMessages,
              prepareCompaction,
              replaceMessages: params.replaceMessages,
              compactHooks,
              recordLlmUsage,
              lastMessageNeedsToolFollowUpLlm,
              // Buffer only when a guardrail must rewrite/discard text, or the
              // host says this turn needs buffering (e.g. pending structured
              // schema). A always-installed completionGate alone must NOT
              // suppress streaming — that made every coding turn non-streamed.
              suppressVisibleDeltas: Boolean(
                params.guardAssistantOutput || params.shouldBufferAssistantOutput?.()
              ),
            }));

            if (llmResult.control === 'retry') {
              state.turns--;
              continue;
            }

            
            turnToolCalls = llmResult.toolCalls;

            
            const responseResult = await turnSpan.runInSpanContext(() => processLlmResponse({
              state,
              runId,
              assistantContent: llmResult.assistantContent,
              messageThinkingChunks: llmResult.messageThinkingChunks,
              toolCalls: llmResult.toolCalls,
              turnTextParts: llmResult.turnTextParts,
              streamStopReason: llmResult.streamStopReason,
              maxTurns,
              maxOutputContinuations: effectiveCaps.maxOutputContinuations,
              abortSignal,
              isQuiet,
              sessionKey,
              currentMessages,
              assistantBuffer: turnAssistantBuffer,
              resolveToolsForRun,
              toolCtx,
              toolHooks: params.toolHooks,
              toolTimeoutMs,
              toolHeartbeatIntervalMs,
              skipHeartbeatToolNames,
              parallelSafeTools,
              loadToolsMetaName,
              toolLoopGuard,
              maxToolCalls,
              checkToolApproval: params.checkToolApproval,
              guardAssistantOutput: params.guardAssistantOutput,
              completionGate: params.completionGate,
              delayedVisibleDeltas: Boolean(
                params.guardAssistantOutput || params.shouldBufferAssistantOutput?.()
              ),
              toolAbortSignalFor: params.toolAbortSignalFor,
              enrichToolContext: params.enrichToolContext,
              evaluateSteering,
              appendMessage,
              push: (e) => stream.push(e),
              buildCorrectionMessage,
              pendingToolAborts,
            }));

            
            state.consecutiveTurnErrors = 0;

            
            
            await flushAssistantBuffer(turnAssistantBuffer);

            if (getSteeringMessages) {
              const steeringMessages = await getSteeringMessages();
              if (steeringMessages.length > 0) state.pendingMessages.push(...steeringMessages);
            }

            if (responseResult.control === 'continue') {
              continue;
            }
            if (responseResult.control === 'break') {
              // Final text may have been generated while a background build/test
              // finished — inject completion before yielding to the user.
              const bgAtEnd = injectBackgroundCompletions();
              if (bgAtEnd) state.pendingMessages.push(bgAtEnd);
              if (state.pendingMessages.length > 0) {
                state.hasMoreToolCalls = true;
                continue;
              }
              break;
            }
          } catch (turnErr) {
            
            if (abortSignal.aborted) {
              stream.push({
                type: 'turn_transition',
                turn: state.turns,
                reason: 'aborted_by_user',
              });
              throw turnErr;
            }

            
            const classification = classifyLlmError(turnErr);
            state.consecutiveTurnErrors++;
            if (
              classification.retryable === false ||
              state.consecutiveTurnErrors > effectiveCaps.maxConsecutiveTurnErrors
            ) {
              
              
              
              
              log.debug('fatal or exhausted per-turn error, propagating', {
                error: describeError(turnErr),
                retryable: classification.retryable,
                category: classification.category,
                consecutiveTurnErrors: state.consecutiveTurnErrors,
                turn: state.turns,
                sessionKey,
              });
              throw turnErr;
            }

            
            log.warn('per-turn error, injecting recovery message', {
              error: describeError(turnErr),
              retryable: classification.retryable,
              category: classification.category,
              attempt: state.consecutiveTurnErrors,
              turn: state.turns,
              sessionKey,
            });
            stream.push({
              type: 'turn_end',
              turn: state.turns,
              stopReason: 'error',
              totalToolCalls: state.toolExecutionMetrics.totalToolCalls,
            });
            state.lastTurnEndMs = Date.now();

            
            
            state.hasMoreToolCalls = false;
            const resolvedToolResultIds = new Set<string>();
            for (const m of currentMessages) {
              if (m.role === 'user' && Array.isArray(m.content)) {
                for (const b of m.content) {
                  if (
                    b &&
                    typeof b === 'object' &&
                    (b as { type?: string }).type === 'tool_result'
                  ) {
                    resolvedToolResultIds.add((b as { tool_use_id?: string }).tool_use_id ?? '');
                  }
                }
              }
            }
            const pendingToolUses = turnToolCalls.filter((tc) => !resolvedToolResultIds.has(tc.id));
            const correctionMessages: Message[] = [];
            if (pendingToolUses.length > 0) {
              correctionMessages.push({
                role: 'user',
                content: pendingToolUses.map((tc) => ({
                  type: 'tool_result',
                  tool_use_id: tc.id,
                  is_error: true,
                  content: `Tool execution interrupted: ${describeError(turnErr)}`,
                })),
                timestamp: Date.now(),
              });
            }
            correctionMessages.push(buildCorrectionMessage(correctionTextForTurnError(turnErr)));
            state.pendingMessages = correctionMessages;
            continue;
          } finally {
            
            
            
            try {
              await flushAssistantBuffer(turnAssistantBuffer);
            } catch (flushErr) {
              log.error('flush_failed_in_finally', {
                error: describeError(flushErr),
                remainingBuffer: turnAssistantBuffer.length,
                sessionKey,
              });



            }
            // Ends the turn span on every exit path: continue, break, throw.
            turnSpan.end(state.consecutiveTurnErrors === 0);
          }
        }
        

        // Abort window: the inner tool loop just exited, but follow-up
        // messages may restart a new LLM turn. If the user aborted in this
        // window, break before fetching follow-ups — otherwise we burn one
        // LLM call that the user already cancelled.
        if (abortSignal.aborted) break outerLoop;

        if (getSteeringMessages) {
          const steeringMessages = await getSteeringMessages();
          if (steeringMessages.length > 0) {
            state.pendingMessages = steeringMessages;
            state.hasMoreToolCalls = true;
            continue;
          }
        }

        if (getFollowUpMessages) {
          const followUp = await getFollowUpMessages();
          if (followUp.length > 0) {
            state.pendingMessages = followUp;
            continue;
          }
        }
        break;
      }
      

      const maxOutMetrics = maxOutputTokensParam ?? modelDef.maxTokens ?? 8192;
      const effMetrics = getEffectiveContextWindowTokens(contextTokens, maxOutMetrics);
      const promptCacheEligibility = assessPromptCacheEligibility(systemPromptParts, {
        enabled: Boolean(systemPromptParts?.stable),
      });
      stream.push({
        type: 'run_metrics',
        metrics: {
          runId,
          sessionKey,
          totalTurns: state.turns,
          totalToolCalls: state.toolExecutionMetrics.totalToolCalls,
          toolCallsByName: state.toolExecutionMetrics.toolCallsByName,
          toolErrors: state.toolExecutionMetrics.toolErrors,
          microcompactSavedChars: state.overflowState.microcompactTotalSavedChars,
          overflowRecoveries: state.overflowState.overflowRecoveries,
          totalDurationMs: Date.now() - runStartMs,
          firstTokenMs: state.firstTokenMs,
          contextCompactions: state.overflowState.contextCompactions,
          systemPromptChars: systemPrompt.length,
          systemPromptHashShort: systemPromptMeta?.hashShort ?? '',
          effectiveContextTokens: effMetrics,
          llmCompactionFailureStreak: state.overflowState.llmCompactionFailureStreak,
          systemPromptLayerCount: systemPromptMeta?.layerCount ?? 0,
          promptCacheEnabled: Boolean(systemPromptParts?.stable),
          promptCacheDebug: prefixDebugEnabled,
          promptCacheStableChars: systemPromptParts?.stable.length ?? 0,
          promptCacheDynamicChars: systemPromptParts?.dynamic.length ?? 0,
          promptCacheEligible: promptCacheEligibility.eligible,
          promptCacheEligibilityReason: promptCacheEligibility.reason,
          promptCacheMinStableChars: promptCacheEligibility.minStableChars,
          promptCacheMaxDynamicCharsRatio: promptCacheEligibility.maxDynamicCharsRatio,
          promptPrefixChecks: promptCacheTelemetry.prefixChecks,
          promptPrefixChanges: promptCacheTelemetry.prefixChanges,
          promptToolOrderChecks: promptCacheTelemetry.toolOrderChecks,
          promptToolOrderChanges: promptCacheTelemetry.toolOrderChanges,
          
          interTurnSilenceMs: state.interTurnSilenceMs,
          llmConnectionReused: wasConnectionReused(),
          prepNextTurnParallelMs: state.toolExecutionMetrics.prepNextTurnParallelMs,
        },
      });

      stream.push({ type: 'agent_end', runId, messages: currentMessages });
      stream.end({
        finalText: state.finalText,
        turns: state.turns,
        totalToolCalls: state.toolExecutionMetrics.totalToolCalls,
        messages: currentMessages,
      });
    } catch (err) {
      
      
      
      
      const errSurface =
        err &&
        typeof err === 'object' &&
        'surface' in err &&
        (err as { surface?: { category?: unknown } }).surface?.category
          ? (err as { surface: import('../../provider/error-classify.js').ProviderErrorSurface })
              .surface
          : undefined;
      stream.push({
        type: 'agent_error',
        runId,
        error: describeError(err),
        ...(errSurface ? { surface: errSurface } : {}),
      });
      stream.end({
        finalText: state.finalText,
        turns: state.turns,
        totalToolCalls: state.toolExecutionMetrics.totalToolCalls,
        messages: currentMessages,
      });
    }
  })().catch((err) => {
    
    
    
    try {
      process.stderr.write(`[agent-loop] fatal unhandled error: ${errorMessage(err)}\n`);
    } catch {
      
    }
    try {
      stream.push({
        type: 'agent_error',
        runId: params.runId ?? 'unknown',
        error: errorMessage(err),
      });
      stream.end({ finalText: '', turns: 0, totalToolCalls: 0, messages: [] });
    } catch {
      
    }
  });

  return stream;
}
