












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

const READONLY_SCOPES: ReadonlySet<SpawnToolScope> = new Set([
  'read-only',
  'device-read',
  'explore',
  'plan',
]);

function scopeNeedsIsolation(scope: SpawnToolScope): boolean {
  return !READONLY_SCOPES.has(scope);
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
  config: SubAgentConfig,
): Model<any> {
  return config.model
    ? { ...deps.modelDef, id: config.model, name: config.model }
    : deps.modelDef;
}

export function createSubAgentRunner(deps: SubAgentRunnerDeps): SubAgentRunner {
  return async (config: SubAgentConfig, signal: AbortSignal): Promise<SubAgentResult> => {
    const startedAt = Date.now();
    const childRunId = config.runId;
    const childSessionKey = `subagent:${childRunId}`;

    
    const allowedTools = resolveSpawnToolSet(config.scope, deps.spawnRegistry);
    const scopedTools = allowedTools
      ? deps.parentTools.filter((t) => allowedTools.has(t.name))
      : [...deps.parentTools];
    const filteredTools = scopedTools.filter((t) => t.name !== 'create_subagent');

    
    const promptAddon = buildSubagentPromptAddon(config.scope);
    const prevStepAddon = config.previousStepResult
      ? `[Previous pipeline step result]\nrunId: ${config.previousStepResult.runId}\nsuccess: ${config.previousStepResult.success}\nsummary:\n${config.previousStepResult.summary}`
      : undefined;
    const childDynamicSystemPrompt = deps.systemPromptParts
      ? [deps.systemPromptParts.dynamic, promptAddon, prevStepAddon].filter(Boolean).join('\n\n')
      : undefined;
    const childSystemPrompt = deps.systemPromptParts
      ? [deps.systemPromptParts.stable, childDynamicSystemPrompt].filter(Boolean).join('\n\n')
      : [deps.systemPrompt, promptAddon, prevStepAddon].filter(Boolean).join('\n\n');
    const childSystemPromptParts = deps.systemPromptParts
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
          abortSignal: signal,
          maxSpawnDepth: deps.maxSpawnDepth ?? 1,
          currentSpawnDepth: 1,
        },
        modelDef: resolveSubagentModelDef(deps, config),
        streamFn: deps.streamFn,
        temperature: deps.temperature,
        reasoning: deps.reasoning,
        maxTurns: config.maxTurns ?? 10,
        contextTokens: deps.contextTokens,
        appendMessage: async (_key, msg) => {
          inMemoryMessages.push(msg);
        },
        replaceMessages: async (_key, msgs) => {
          inMemoryMessages.splice(0, inMemoryMessages.length, ...msgs);
        },
        prepareCompaction: async () => ({}),
        abortSignal: signal,
        maxOutputTokens: deps.maxOutputTokens,
        platform: deps.platform,
        toolHooks: deps.toolHooks,
      });

      
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

      const miniResult = await childStream.result();
      const finalSummary = miniResult.finalText.trim();
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
      if (isolated) {
        await cleanupIsolatedWorkspace(workspaceDir);
      }
    }
  };
}
