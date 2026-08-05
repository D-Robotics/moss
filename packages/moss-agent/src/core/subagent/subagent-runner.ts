import fs from 'node:fs/promises';
import path from 'node:path';
import type { Tool } from '../tools/tool-types.js';
import type { SubagentRunProgress } from '../tools/tool-types.js';
import type { Model, StreamFunction, ThinkingLevel } from '../../provider/pi-ai-types.js';
import type { AgentLoopPlatformConfig } from '../loop/agent-loop-types.js';
import type { Message } from '../session/session-jsonl.js';
import type { LLMSystemPromptParts } from '../llm/llm-provider.js';
import type { SubAgentConfig, SubAgentResult, SubAgentRunner } from './subagent-orchestrator.js';
import { resolveSpawnToolSet, buildSubagentPromptAddon } from './spawn-profile.js';
import type { SpawnProfileRegistry, SpawnToolScope } from './spawn-profile.js';
import { runAgentLoop } from '../loop/agent-loop.js';
import { getRootLogger } from '../../logger.js';
import { getMossWorkspacePaths } from '../../utils/workspace-paths.js';
import { errorMessage } from '../../errors.js';

const log = getRootLogger().child('subagent-runner');

const FORCED_FINALIZATION_PROMPT = [
  '[System recovery] The investigation phase is over and no tools are available.',
  'Using only the evidence already present in this conversation, return a concise visible final summary now.',
  'Follow the output schema from the original SUBTASK_CONTRACT exactly, including its final verdict line when required.',
  'State clearly when a conclusion is partial or uncertain. Do not request or call tools.',
].join(' ');

const READONLY_SCOPES: ReadonlySet<SpawnToolScope> = new Set([
  'critic',
  'read-only',
  'device-read',
  'explore',
  'plan',
]);

function scopeNeedsIsolation(scope: SpawnToolScope): boolean {
  return !READONLY_SCOPES.has(scope);
}

function subtaskSummaryNeedsContractRepair(task: string, summary: string): boolean {
  if (!/SUBTASK_CONTRACT\s+v1/i.test(task)) return false;
  const normalized = summary.replace(/\*\*/g, '');
  if (/VERDICT:\s*PASS\|FAIL\|PARTIAL/i.test(task)) {
    return (
      !/(?:^|\n)\s*#{0,6}\s*CHECKS\s*:/i.test(normalized) ||
      !/(?:^|\n)\s*#{0,6}\s*EVIDENCE\s*:/i.test(normalized) ||
      !/\bVERDICT\s*[:=]\s*(?:PASS|FAIL|PARTIAL)\b/i.test(normalized)
    );
  }
  if (/CONCLUSION:/i.test(task) && /CONFIDENCE:\s*high\|medium\|low/i.test(task)) {
    return (
      !/(?:^|\n)\s*#{0,6}\s*EVIDENCE\s*:/i.test(normalized) ||
      !/(?:^|\n)\s*#{0,6}\s*(?:CONCLUSION\s*:|.*\bVERDICT\s*[:=]\s*PASS\b)/i.test(normalized)
    );
  }
  return false;
}

async function prepareWorkspaceDir(
  parentWorkspaceDir: string,
  scope: SpawnToolScope,
  runId: string
): Promise<{ workspaceDir: string; isolated: boolean }> {
  const workspaceDir = path.resolve(parentWorkspaceDir);
  if (!scopeNeedsIsolation(scope)) {
    return { workspaceDir, isolated: false };
  }
  const isolatedDir = path.join(getMossWorkspacePaths(workspaceDir).runtimeDir, 'subagent', runId);
  await fs.mkdir(isolatedDir, { recursive: true });
  log.info('created isolated workspace for child agent', {
    runId,
    scope,
    workspaceDir: isolatedDir,
  });
  return { workspaceDir: isolatedDir, isolated: true };
}

async function cleanupIsolatedWorkspace(workspaceDir: string): Promise<void> {
  try {
    await fs.rm(workspaceDir, { recursive: true, force: true });
  } catch (err) {
    log.warn('failed to clean up isolated workspace', {
      workspaceDir,
      error: errorMessage(err),
    });
  }
}

export interface SubAgentRunnerDeps {
  parentTools: Tool[];

  streamFn: StreamFunction;

  modelDef: Model<any>;

  systemPrompt: string;

  systemPromptParts?: LLMSystemPromptParts;

  maxOutputTokens: number;

  contextTokens: number;

  temperature?: number;

  reasoning?: ThinkingLevel;

  platform?: AgentLoopPlatformConfig;

  maxSpawnDepth?: number;

  toolHooks?: import('../tools/tool-hooks.js').ToolHookRegistry;

  spawnRegistry?: SpawnProfileRegistry;

  workspaceDir?: string;

  /**
   * Optional host completion gate (e.g. CLI coding gates). When set, child
   * agent loops inherit the same end-of-turn honesty checks as the parent
   * so fan_out_subagents / create_subagent cannot false-complete coding work.
   */
  completionGate?: import('../loop/agent-loop-types.js').AgentLoopExtensions['completionGate'];
}

/**
 * Resolve the model definition a sub-agent run will use. If `config.model` is
 * set, clone the parent's modelDef with the overridden id/name — the provider's
 * stream function routes by `model.id` (see llm-provider-stream-adapter.ts:
 * `request.model = model.id`), so the sub-agent actually runs on the
 * overridden model. Without an override, the parent's modelDef is used as-is.
 *
 * Context-window re-detection for the override is a known follow-up — the
 * parent's contextTokens is used as a fallback, which is wrong if the
 * overridden model has a different window, but the model swap itself works.
 * @internal
 */
export function resolveSubagentModelDef(
  deps: SubAgentRunnerDeps,
  config: SubAgentConfig
): Model<any> {
  return config.model ? { ...deps.modelDef, id: config.model, name: config.model } : deps.modelDef;
}

/** Apply both the spawn-profile boundary and the host's exact per-assignment allowlist. */
export function selectSubagentTools(
  parentTools: readonly Tool[],
  config: Pick<SubAgentConfig, 'scope' | 'allowedTools'>,
  spawnRegistry?: SpawnProfileRegistry
): Tool[] {
  const scopeTools = resolveSpawnToolSet(config.scope, spawnRegistry);
  const exactTools = config.allowedTools?.length ? new Set(config.allowedTools) : null;
  return parentTools.filter(
    (tool) =>
      tool.name !== 'create_subagent' &&
      (!scopeTools || scopeTools.has(tool.name)) &&
      (!exactTools || exactTools.has(tool.name))
  );
}

export function createSubAgentRunner(deps: SubAgentRunnerDeps): SubAgentRunner {
  return async (config: SubAgentConfig, signal: AbortSignal): Promise<SubAgentResult> => {
    const startedAt = Date.now();
    const childRunId = config.runId;
    const childSessionKey = `subagent:${childRunId}`;

    const filteredTools = selectSubagentTools(deps.parentTools, config, deps.spawnRegistry);

    const promptAddon = buildSubagentPromptAddon(config.scope);
    const prevStepAddon = config.previousStepResult
      ? `[Previous pipeline step result]\nrunId: ${config.previousStepResult.runId}\nsuccess: ${config.previousStepResult.success}\nsummary:\n${config.previousStepResult.summary}`
      : undefined;
    // systemPromptOverride: per-call replacement of the parent's system prompt
    // (e.g. plan-critic injecting its critique prompt). When set, the override
    // replaces the base prompt as a single block — childSystemPromptParts is
    // undefined so prefix-cache does not try to split it into stable/dynamic.
    const childDynamicSystemPrompt = deps.systemPromptParts
      ? [deps.systemPromptParts.dynamic, promptAddon, prevStepAddon].filter(Boolean).join('\n\n')
      : undefined;
    const childSystemPrompt = config.systemPromptOverride
      ? [config.systemPromptOverride, promptAddon, prevStepAddon].filter(Boolean).join('\n\n')
      : deps.systemPromptParts
        ? [deps.systemPromptParts.stable, childDynamicSystemPrompt].filter(Boolean).join('\n\n')
        : [deps.systemPrompt, promptAddon, prevStepAddon].filter(Boolean).join('\n\n');
    const childSystemPromptParts = config.systemPromptOverride
      ? undefined
      : deps.systemPromptParts
        ? { stable: deps.systemPromptParts.stable, dynamic: childDynamicSystemPrompt ?? '' }
        : undefined;

    const childMessages: Message[] = [
      { role: 'user', content: config.task, timestamp: Date.now() },
    ];

    const inMemoryMessages: Message[] = [...childMessages];
    let toolResultCount = 0;
    let turnCount = 0;
    let lastTool: string | undefined;
    let partialText = '';
    const emitProgress = (partial: Partial<SubagentRunProgress>): void => {
      config.onProgress?.({
        runId: childRunId,
        scope: config.scope,
        task: config.task,
        status: 'running',
        maxTurns: config.maxTurns ?? 10,
        turn: turnCount || undefined,
        toolResults: toolResultCount,
        ...(lastTool ? { lastTool } : {}),
        elapsedMs: Date.now() - startedAt,
        ...partial,
      });
    };

    const { workspaceDir, isolated } = await prepareWorkspaceDir(
      deps.workspaceDir ?? process.cwd(),
      config.scope,
      childRunId
    );
    // Reserve the tail of every bounded child run for tool-free synthesis.
    // Without this, a diligent verifier can consume the entire wall-clock
    // budget on tool follow-ups and be aborted while streaming an otherwise
    // valid final report. The parent then sees useful evidence but no contract
    // verdict and must reject the node.
    const configuredTimeoutMs = Math.max(10_000, config.timeoutMs ?? 120_000);
    const synthesisReserveMs = Math.min(
      45_000,
      Math.max(5_000, Math.floor(configuredTimeoutMs * 0.3)),
      configuredTimeoutMs - Math.min(10_000, Math.floor(configuredTimeoutMs * 0.5))
    );
    const workPhaseTimeoutMs = Math.max(10_000, configuredTimeoutMs - synthesisReserveMs);
    const workPhaseController = new AbortController();
    let workPhaseTimedOut = false;
    const abortWorkPhase = () => workPhaseController.abort(signal.reason);
    signal.addEventListener('abort', abortWorkPhase, { once: true });
    const workPhaseTimer = setTimeout(() => {
      workPhaseTimedOut = true;
      workPhaseController.abort(
        new Error(
          `sub-agent work phase ended; ${synthesisReserveMs}ms reserved for final synthesis`
        )
      );
    }, workPhaseTimeoutMs);
    workPhaseTimer.unref?.();

    log.info('starting child agent', {
      runId: childRunId,
      scope: config.scope,
      maxTurns: config.maxTurns ?? 10,
      toolCount: filteredTools.length,
      parentRunId: config.parentRunId,
      isolatedWorkspace: isolated,
    });
    emitProgress({ status: 'started', phase: 'starting' });

    try {
      const childStream = runAgentLoop({
        runId: childRunId,
        sessionKey: childSessionKey,
        agentId: `subagent:${config.scope}`,
        currentMessages: childMessages,
        compactionSummary: undefined,
        systemPrompt: childSystemPrompt,
        systemPromptParts: childSystemPromptParts,
        toolsForRun: filteredTools,
        getToolsForRun: () => filteredTools,
        toolCtx: {
          workspaceDir,
          sessionKey: childSessionKey,
          abortSignal: workPhaseController.signal,
          maxSpawnDepth: deps.maxSpawnDepth ?? 1,
          currentSpawnDepth: 1,
        },
        modelDef: resolveSubagentModelDef(deps, config),
        streamFn: deps.streamFn,
        temperature: deps.temperature,
        reasoning: deps.reasoning,
        maxTurns: config.maxTurns ?? 10,
        contextTokens: config.contextTokens ?? deps.contextTokens,
        appendMessage: async (_key, msg) => {
          inMemoryMessages.push(msg);
        },
        replaceMessages: async (_key, msgs) => {
          inMemoryMessages.splice(0, inMemoryMessages.length, ...msgs);
        },
        prepareCompaction: async () => ({}),
        abortSignal: workPhaseController.signal,
        maxOutputTokens: deps.maxOutputTokens,
        platform: deps.platform,
        toolHooks: deps.toolHooks,
        // Inherit parent coding completion gates (verify / todo / false-complete).
        ...(deps.completionGate ? { completionGate: deps.completionGate } : {}),
      });

      let miniResult: { turns: number; finalText: string } | undefined;
      try {
        for await (const event of childStream) {
          if (event.type === 'message_delta') {
            partialText = `${partialText}${event.delta}`.slice(-400);
          }
          if (event.type === 'turn_start') {
            turnCount = event.turn;
            emitProgress({ phase: 'turn', turn: event.turn });
          }
          if (event.type === 'tool_execution_start') {
            lastTool = event.toolName;
            emitProgress({ phase: 'tool', lastTool });
          }
          if (event.type === 'tool_execution_end') {
            toolResultCount++;
            lastTool = event.toolName;
            emitProgress({ phase: 'tool', lastTool, toolResults: toolResultCount });
          }
          if (event.type === 'turn_end') {
            turnCount = event.turn;
            emitProgress({ phase: 'turn', turn: event.turn });
          }
        }
        miniResult = await childStream.result();
        turnCount = Math.max(turnCount, miniResult.turns);
      } catch (err) {
        if (!workPhaseTimedOut || signal.aborted) throw err;
        log.info('child work phase stopped to preserve final synthesis budget', {
          runId: childRunId,
          turns: turnCount,
          toolResults: toolResultCount,
          synthesisReserveMs,
        });
      }
      let finalSummary = miniResult?.finalText.trim() ?? '';
      const needsContractRepair = subtaskSummaryNeedsContractRepair(config.task, finalSummary);

      // A child can legitimately spend its last allowed turn executing tools.
      // The main loop then stops at the bounded post-limit follow-up cap with
      // useful evidence in the message history but no visible finalText. Give
      // that evidence exactly one tool-free synthesis pass. This is deliberately
      // outside the child completion gate: it may report partial work, but it
      // cannot claim verified coding completion or perform additional changes.
      if ((!finalSummary || needsContractRepair) && !signal.aborted) {
        const finalizationMessages: Message[] = [
          ...inMemoryMessages,
          { role: 'user', content: FORCED_FINALIZATION_PROMPT, timestamp: Date.now() },
        ];
        const finalizationMaxTurns = (config.maxTurns ?? 10) + 1;
        emitProgress({
          phase: 'finalizing',
          turn: turnCount + 1,
          maxTurns: finalizationMaxTurns,
        });
        log.info('forcing tool-free child finalization', {
          runId: childRunId,
          turns: turnCount,
          toolResults: toolResultCount,
          reason: finalSummary ? 'output_contract_repair' : 'missing_final_text',
        });

        const finalizationStream = runAgentLoop({
          runId: `${childRunId}/finalize`,
          sessionKey: childSessionKey,
          agentId: `subagent:${config.scope}:finalize`,
          currentMessages: finalizationMessages,
          compactionSummary: undefined,
          systemPrompt: childSystemPrompt,
          systemPromptParts: childSystemPromptParts,
          toolsForRun: [],
          getToolsForRun: () => [],
          toolCtx: {
            workspaceDir,
            sessionKey: childSessionKey,
            abortSignal: signal,
            maxSpawnDepth: 0,
            currentSpawnDepth: 0,
          },
          modelDef: resolveSubagentModelDef(deps, config),
          streamFn: deps.streamFn,
          temperature: deps.temperature,
          // This pass has one job: turn already-collected evidence into a
          // visible report before the hard child deadline. Extended thinking
          // can consume the entire reserved synthesis window and leave the
          // parent with no expert output.
          reasoning: 'off',
          maxTurns: 1,
          contextTokens: config.contextTokens ?? deps.contextTokens,
          appendMessage: async (_key, msg) => {
            finalizationMessages.push(msg);
          },
          replaceMessages: async (_key, msgs) => {
            finalizationMessages.splice(0, finalizationMessages.length, ...msgs);
          },
          prepareCompaction: async () => ({}),
          abortSignal: signal,
          maxOutputTokens: deps.maxOutputTokens,
          platform: deps.platform,
          toolHooks: deps.toolHooks,
        });

        for await (const event of finalizationStream) {
          if (event.type === 'message_delta') {
            partialText = `${partialText}${event.delta}`.slice(-400);
          }
        }
        const finalizationResult = await finalizationStream.result();
        turnCount += finalizationResult.turns;
        finalSummary = finalizationResult.finalText.trim();
      }

      if (!finalSummary) {
        const message = `Sub-agent completed without a final response (${turnCount} turn${turnCount === 1 ? '' : 's'}, ${toolResultCount} tool result${toolResultCount === 1 ? '' : 's'}).`;
        log.warn('child agent completed without final text', {
          runId: childRunId,
          turns: turnCount,
          toolResults: toolResultCount,
          durationMs: Date.now() - startedAt,
        });
        emitProgress({
          status: 'failed',
          phase: 'failed',
          error: message,
          ...(partialText ? { summaryPreview: partialText.trim().slice(0, 240) } : {}),
        });
        return {
          runId: childRunId,
          summary: message,
          toolResults: toolResultCount,
          turns: turnCount,
          durationMs: Date.now() - startedAt,
          success: false,
          error: message,
        };
      }

      log.info('child agent completed', {
        runId: childRunId,
        turns: turnCount,
        toolResults: toolResultCount,
        durationMs: Date.now() - startedAt,
        finalTextLength: finalSummary.length,
      });
      emitProgress({
        status: 'completed',
        phase: 'completed',
        summaryPreview: finalSummary.slice(0, 240),
      });

      return {
        runId: childRunId,
        summary: finalSummary,
        toolResults: toolResultCount,
        turns: turnCount,
        durationMs: Date.now() - startedAt,
        success: true,
      };
    } catch (err) {
      const errorMsg = errorMessage(err);
      const summary = `Sub-agent failed: ${errorMsg}`;
      log.warn('child agent failed', {
        runId: childRunId,
        error: errorMsg,
        durationMs: Date.now() - startedAt,
      });
      emitProgress({
        status: 'failed',
        phase: 'failed',
        error: errorMsg,
        ...(partialText ? { summaryPreview: partialText.trim().slice(0, 240) } : {}),
      });

      return {
        runId: childRunId,
        summary,
        toolResults: toolResultCount,
        turns: turnCount,
        durationMs: Date.now() - startedAt,
        success: false,
        error: errorMsg,
      };
    } finally {
      clearTimeout(workPhaseTimer);
      signal.removeEventListener('abort', abortWorkPhase);
      if (isolated) {
        await cleanupIsolatedWorkspace(workspaceDir);
      }
    }
  };
}
